/**
 * Task #997 — Pin the canonical `monitor_mode` short-circuit contract on
 * the SentItems health classifier.
 *
 * The Conversations capture-audit pill, the watchdog alerter, and the
 * popover Action-Required / Config-Issues / Excluded sections all read
 * from `getMailboxSentItemsHealth`. Before this task that classifier
 * naively reported "Mailbox disabled — not subscribed" or
 * "No SentItems subscription registered" for any row that simply wasn't
 * being monitored on purpose (Ben/Joe/Kylee/Josh/Jordan PTO/role-change
 * exclusions) or had a known invalid mailbox config (Casey). Those
 * verdicts then fed `webhookFailureCount`, which rolled the pill red and
 * paged admins for a non-issue.
 *
 * The contract these tests pin:
 *
 *   monitorMode = "monitored_active"      → classifier runs as before
 *   monitorMode = "excluded_intentional"  → sentItemsHealth=unknown,
 *                                            reason mentions "Excluded"
 *   monitorMode = "invalid_config"        → sentItemsHealth=unknown,
 *                                            reason instructs admin to fix
 *                                            the row (no Retry)
 *   monitorMode = "disabled"              → sentItemsHealth=unknown,
 *                                            reason explains admin disable
 *
 * Critically: the classifier MUST short-circuit BEFORE the existing
 * "Mailbox disabled" / "No SentItems subscription" branches, so a Casey
 * row whose sub IDs were cleared by the migration still classifies as
 * `unknown` (not `missing`), which in turn keeps it out of
 * `webhookFailureCount`.
 */

import { describe, expect, it } from "vitest";
import { getMailboxSentItemsHealth } from "../services/conversationReplyCaptureService";
import { classifyMailboxHealth } from "../services/mailboxWatchdogService";
import { normalizeMonitorModeAndEnabled } from "../storage";
import { alertKeysToResolveOnModeTransition } from "../routes/monitoredMailboxes";
import type { MonitoredMailbox, MonitorMode } from "@shared/schema";

function mailbox(overrides: Partial<MonitoredMailbox>): MonitoredMailbox {
  // Reasonable "fully-healthy active mailbox" baseline. We only set the
  // fields `getMailboxSentItemsHealth` actually reads — every other column
  // on the table (delta tokens, watchdog cadence, alert ledger pointers,
  // etc.) is irrelevant to the classifier under test, so we cast through
  // `unknown` rather than build a 30-field fixture that will rot every
  // time someone adds a column to monitored_mailboxes.
  const now = new Date();
  const base = {
    id: "mb-test",
    orgId: "org-test",
    userId: "user-test",
    email: "test@example.com",
    enabled: true,
    monitorMode: "monitored_active",
    subscriptionId: "inbox-sub-1",
    sentItemsSubscriptionId: "sent-sub-1",
    subscriptionExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    lastSyncAt: now,
    lastSentItemsNotificationAt: now,
    lastOutboundCapturedAt: now,
    syncStatus: "ok",
    syncError: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides } as unknown as MonitoredMailbox;
}

describe("getMailboxSentItemsHealth — Task #997 monitor_mode short-circuit", () => {
  it("monitored_active + healthy subscription stays active", () => {
    const snap = getMailboxSentItemsHealth(mailbox({}));
    expect(snap.sentItemsHealth).toBe("active");
    expect(snap.monitorMode).toBe("monitored_active");
  });

  it("excluded_intentional reports unknown, not missing, even with no subscription", () => {
    // Mirrors Ben/Joe/Kylee/Josh/Jordan post-migration: enabled=false,
    // sub IDs intentionally cleared. Pre-Task-997 this would have been
    // classified as `missing` and inflated webhookFailureCount.
    const snap = getMailboxSentItemsHealth(
      mailbox({
        monitorMode: "excluded_intentional",
        enabled: false,
        sentItemsSubscriptionId: null,
        subscriptionId: null,
      }),
    );
    expect(snap.sentItemsHealth).toBe("unknown");
    expect(snap.monitorMode).toBe("excluded_intentional");
    expect(snap.reason.toLowerCase()).toContain("excluded");
  });

  it("invalid_config reports unknown and instructs admin to fix the row", () => {
    // Mirrors Casey post-migration: invalid mailbox address, sub IDs
    // cleared, monitorMode flipped to invalid_config. The popover
    // shouldn't render a Retry button — the row itself is the bug.
    const snap = getMailboxSentItemsHealth(
      mailbox({
        monitorMode: "invalid_config",
        enabled: false,
        sentItemsSubscriptionId: null,
        subscriptionId: null,
        subscriptionExpiresAt: null,
        syncError: "Mailbox not found in tenant",
      }),
    );
    expect(snap.sentItemsHealth).toBe("unknown");
    expect(snap.monitorMode).toBe("invalid_config");
    expect(snap.reason.toLowerCase()).toContain("invalid");
    expect(snap.reason.toLowerCase()).toContain("admin");
  });

  it("disabled reports unknown, not missing", () => {
    const snap = getMailboxSentItemsHealth(
      mailbox({ monitorMode: "disabled", enabled: false }),
    );
    expect(snap.sentItemsHealth).toBe("unknown");
    expect(snap.monitorMode).toBe("disabled");
    expect(snap.reason.toLowerCase()).toContain("disabled");
  });

  it("non-active monitor modes short-circuit BEFORE the expired-subscription branch", () => {
    // A Casey row whose subscription happens to have a stale
    // expires_at in the past should NOT report `expired` — that copy
    // would be misleading because the row isn't being subscribed in
    // the first place.
    const snap = getMailboxSentItemsHealth(
      mailbox({
        monitorMode: "invalid_config",
        enabled: true,
        sentItemsSubscriptionId: "stale-sub-id",
        subscriptionExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      }),
    );
    expect(snap.sentItemsHealth).toBe("unknown");
    expect(snap.sentItemsHealth).not.toBe("expired");
  });

  it("legacy null monitorMode defaults to monitored_active so existing rows still get classified", () => {
    // Defensive: pre-migration snapshots that predate the column write
    // shouldn't suddenly all become "unknown".
    const snap = getMailboxSentItemsHealth(
      mailbox({ monitorMode: null as unknown as MonitoredMailbox["monitorMode"] }),
    );
    expect(snap.monitorMode).toBe("monitored_active");
    expect(snap.sentItemsHealth).toBe("active");
  });

  it("monitored_active + cleared subscription still reports missing (not silenced by mode)", () => {
    // Inverse safety check: an active row that genuinely lost its
    // SentItems subscription must still surface as broken. Otherwise
    // we'd be hiding real failures behind the new short-circuit.
    const snap = getMailboxSentItemsHealth(
      mailbox({
        monitorMode: "monitored_active",
        enabled: true,
        sentItemsSubscriptionId: null,
      }),
    );
    expect(snap.sentItemsHealth).toBe("missing");
  });
});

describe("classifyMailboxHealth — Task #997 monitor_mode short-circuit (alerter gate)", () => {
  // The watchdog reconciler, the /api/admin/mailbox-health route, and any
  // future caller all share this classifier. The contract: a non-active
  // monitor_mode MUST return a synthetic `healthy` classification with
  // needsResubscribe=false, regardless of subscription state. Without this,
  // a Casey row whose subscription happens to be expired would still mark
  // the watchdog action queue as needing a resub (which would fail), and a
  // disabled row would still tip `mailbox-health` red.
  const now = new Date("2026-05-04T12:00:00Z");

  it("monitored_active with valid sub stays healthy (baseline)", () => {
    const cls = classifyMailboxHealth(mailbox({}), now);
    expect(cls.status).toBe("healthy");
    expect(cls.needsResubscribe).toBe(false);
  });

  it("monitored_active with expired sub still classifies unhealthy + needsResubscribe (inverse safety)", () => {
    // The whole reason classifyMailboxHealth exists. The short-circuit
    // must NOT silence active-mode failures.
    const cls = classifyMailboxHealth(
      mailbox({
        monitorMode: "monitored_active",
        subscriptionExpiresAt: new Date(now.getTime() - 60_000),
      }),
      now,
    );
    expect(cls.needsResubscribe).toBe(true);
    expect(cls.status).toBe("unhealthy");
  });

  it("excluded_intentional short-circuits to healthy regardless of sub state", () => {
    const cls = classifyMailboxHealth(
      mailbox({
        monitorMode: "excluded_intentional",
        enabled: false,
        subscriptionId: null,
        sentItemsSubscriptionId: null,
        subscriptionExpiresAt: new Date(now.getTime() - 86_400_000),
      }),
      now,
    );
    expect(cls.status).toBe("healthy");
    expect(cls.needsResubscribe).toBe(false);
    expect(cls.resubscribeReasons).toEqual([]);
    expect(cls.silenceOnly).toBe(false);
    expect(cls.reason.toLowerCase()).toContain("excluded");
  });

  it("invalid_config short-circuits to healthy and instructs admin to fix the row", () => {
    const cls = classifyMailboxHealth(
      mailbox({
        monitorMode: "invalid_config",
        enabled: false,
        subscriptionId: null,
        sentItemsSubscriptionId: null,
        // Sync error left over from before the row was reclassified.
        // The classifier must NOT escalate based on it.
        syncStatus: "error",
        syncError: "Mailbox not found in tenant",
      }),
      now,
    );
    expect(cls.status).toBe("healthy");
    expect(cls.needsResubscribe).toBe(false);
    expect(cls.reason.toLowerCase()).toContain("invalid");
    expect(cls.reason.toLowerCase()).toContain("admin");
  });

  it("disabled short-circuits to healthy (paused mailbox should not page)", () => {
    const cls = classifyMailboxHealth(
      mailbox({ monitorMode: "disabled", enabled: false }),
      now,
    );
    expect(cls.status).toBe("healthy");
    expect(cls.needsResubscribe).toBe(false);
  });

  it("legacy null monitorMode defaults to monitored_active in the classifier too", () => {
    const cls = classifyMailboxHealth(
      mailbox({ monitorMode: null as unknown as MonitoredMailbox["monitorMode"] }),
      now,
    );
    expect(cls.status).toBe("healthy");
    // baseline mailbox has all subs present and fresh, so no resub needed
    expect(cls.needsResubscribe).toBe(false);
  });
});

describe("normalizeMonitorModeAndEnabled — Task #997 storage-layer lockstep", () => {
  // The reviewer's #2 finding: pre-fix, the POST create route accepted
  // `enabled` only and writes went straight through `storage.create…`,
  // which meant `enabled=false` rows landed with the column default
  // `monitor_mode='monitored_active'` and immediately re-emerged as red
  // unhealthy popover entries. The fix moves derivation into the storage
  // layer so EVERY write path (POST, PATCH, enroll-all, future callers)
  // is forced into lockstep regardless of whether the caller remembered
  // to pass both fields. These tests pin that contract.

  it("monitorMode wins when both are supplied (canonical source of truth)", () => {
    // Even if a confused caller sends contradictory values, the canonical
    // mode wins so we never persist a contradiction to the DB.
    expect(
      normalizeMonitorModeAndEnabled({ enabled: true, monitorMode: "excluded_intentional" }),
    ).toEqual({ enabled: false, monitorMode: "excluded_intentional" });

    expect(
      normalizeMonitorModeAndEnabled({ enabled: false, monitorMode: "monitored_active" }),
    ).toEqual({ enabled: true, monitorMode: "monitored_active" });
  });

  it("only monitorMode supplied → enabled is derived (true iff monitored_active)", () => {
    expect(normalizeMonitorModeAndEnabled({ monitorMode: "monitored_active" }))
      .toEqual({ enabled: true, monitorMode: "monitored_active" });
    expect(normalizeMonitorModeAndEnabled({ monitorMode: "excluded_intentional" }))
      .toEqual({ enabled: false, monitorMode: "excluded_intentional" });
    expect(normalizeMonitorModeAndEnabled({ monitorMode: "invalid_config" }))
      .toEqual({ enabled: false, monitorMode: "invalid_config" });
    expect(normalizeMonitorModeAndEnabled({ monitorMode: "disabled" }))
      .toEqual({ enabled: false, monitorMode: "disabled" });
  });

  it("only enabled supplied → monitorMode is derived (legacy POST path)", () => {
    // The exact reviewer-reported regression: enabled=false alone used
    // to land monitor_mode='monitored_active' (the column default).
    // Now it deterministically becomes 'disabled' — the most
    // conservative non-active bucket. Admins who want
    // excluded_intentional / invalid_config must say so explicitly.
    expect(normalizeMonitorModeAndEnabled({ enabled: true }))
      .toEqual({ enabled: true, monitorMode: "monitored_active" });
    expect(normalizeMonitorModeAndEnabled({ enabled: false }))
      .toEqual({ enabled: false, monitorMode: "disabled" });
  });

  it("neither supplied → both untouched (let column defaults apply)", () => {
    // Defensive: a partial PATCH that only updates e.g. healthReason
    // must not flip enabled/mode behind the admin's back.
    const out = normalizeMonitorModeAndEnabled({ healthReason: "stale" } as Record<string, unknown>);
    expect(out).toEqual({ healthReason: "stale" });
    expect("enabled" in out).toBe(false);
    expect("monitorMode" in out).toBe(false);
  });

  it("preserves unrelated fields verbatim (does not strip or mutate)", () => {
    const input = {
      orgId: "org-1",
      userId: "user-1",
      email: "x@valuetruck.com",
      enabled: false,
      subscriptionId: null,
      healthReason: "test",
    };
    const out = normalizeMonitorModeAndEnabled(input);
    expect(out.orgId).toBe("org-1");
    expect(out.userId).toBe("user-1");
    expect(out.email).toBe("x@valuetruck.com");
    expect(out.subscriptionId).toBeNull();
    expect(out.healthReason).toBe("test");
    expect(out.monitorMode).toBe("disabled");
    expect(out.enabled).toBe(false);
  });

  it("does not mutate the input object (returns a copy)", () => {
    const input: { enabled: boolean; monitorMode?: string } = { enabled: false };
    const out = normalizeMonitorModeAndEnabled(input);
    expect(input.monitorMode).toBeUndefined();
    expect(out.monitorMode).toBe("disabled");
    expect(out).not.toBe(input);
  });

  it("treats null monitorMode the same as undefined (legacy DB rows)", () => {
    // Some pre-migration rows pulled out of the DB into a Partial may
    // carry monitorMode=null. The helper must treat null as "absent" so
    // we don't accidentally compare null === 'monitored_active' and
    // flip enabled to false on every legacy row update.
    const out = normalizeMonitorModeAndEnabled({ enabled: true, monitorMode: null });
    expect(out.enabled).toBe(true);
    expect(out.monitorMode).toBe("monitored_active");
  });
});

describe("alertKeysToResolveOnModeTransition — Task #997 PATCH alert clearance", () => {
  // The reviewer's #3 finding: runWatchdogCycle iterates
  // getEnabledMonitoredMailboxes(), which means a row whose `enabled`
  // just flipped to false is no longer in the watchdog's working set
  // and its open mailbox_health_alerts will never be auto-resolved.
  // The PATCH route must clear them at the transition point. These
  // tests pin which keys get cleared on which transitions.

  const ALERTS_TO_CLEAR = ["mailbox_unhealthy", "subscription_renewal_failed"] as const;

  it("monitored_active → excluded_intentional clears mailbox-scoped alerts", () => {
    expect(alertKeysToResolveOnModeTransition("monitored_active", "excluded_intentional"))
      .toEqual(ALERTS_TO_CLEAR);
  });

  it("monitored_active → invalid_config clears mailbox-scoped alerts", () => {
    expect(alertKeysToResolveOnModeTransition("monitored_active", "invalid_config"))
      .toEqual(ALERTS_TO_CLEAR);
  });

  it("monitored_active → disabled clears mailbox-scoped alerts", () => {
    expect(alertKeysToResolveOnModeTransition("monitored_active", "disabled"))
      .toEqual(ALERTS_TO_CLEAR);
  });

  it("legacy null prevMode is treated as monitored_active (clears on transition out)", () => {
    // A row that predates the column write pulled from the DB has
    // monitorMode=null in memory; our short-circuit treats it as
    // monitored_active for classification, so the same must hold here:
    // null → excluded must still clear the open alert.
    expect(alertKeysToResolveOnModeTransition(null, "excluded_intentional"))
      .toEqual(ALERTS_TO_CLEAR);
  });

  it("monitored_active → monitored_active (no-op) returns no keys", () => {
    expect(alertKeysToResolveOnModeTransition("monitored_active", "monitored_active"))
      .toEqual([]);
  });

  it("excluded_intentional → monitored_active (re-enabling) returns no keys", () => {
    // The watchdog will re-evaluate this row on its next tick now that
    // it's back in getEnabledMonitoredMailboxes(); we must NOT pre-clear
    // alerts that should remain open if the underlying problem persists.
    expect(alertKeysToResolveOnModeTransition("excluded_intentional", "monitored_active"))
      .toEqual([]);
  });

  it("non-active → non-active transitions are no-ops", () => {
    // Switching between excluded/invalid/disabled doesn't change the
    // alert state — the alert was already resolved when the row first
    // left monitored_active.
    const inactive: MonitorMode[] = ["excluded_intentional", "invalid_config", "disabled"];
    for (const from of inactive) {
      for (const to of inactive) {
        expect(alertKeysToResolveOnModeTransition(from, to)).toEqual([]);
      }
    }
  });

  it("returned key list contains only mailbox-scoped keys (not org-scoped)", () => {
    // Defensive: org-scoped watchdog alerts (classification_lag,
    // live_sync_*, quote_pipeline_*) are anchored to org's first mailbox
    // and must NOT be auto-resolved when a single row's mode flips,
    // otherwise an unrelated org-wide outage could be silently dismissed.
    const keys = alertKeysToResolveOnModeTransition("monitored_active", "disabled");
    for (const k of keys) {
      expect(k).not.toMatch(/^classification_/);
      expect(k).not.toMatch(/^live_sync_/);
      expect(k).not.toMatch(/^quote_pipeline_/);
      expect(k).not.toMatch(/^ingestion_silent_/);
      expect(k).not.toMatch(/^empty_content_/);
    }
  });
});
