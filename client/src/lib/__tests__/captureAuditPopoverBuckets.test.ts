/**
 * Task #997 — Pin the Conversations capture-audit popover bucketing
 * contract: which monitor_mode lands in which section, what the per-mode
 * counter values are, and which rows are eligible for the Retry button.
 *
 * Background: before this task the popover rendered every mailbox in a
 * single flat list, which meant the "5 mailboxes affected" count
 * conflated rows that genuinely needed admin action (subscription
 * expired, webhook silent) with rows that were intentionally excluded
 * (PTO/role-change reps) and Casey's known-broken row. Admins couldn't
 * tell at a glance how many of the 5 were real.
 *
 * The contract pinned here is what the Action Required / Config Issues /
 * Excluded sections actually compute from the wire payload. The popover
 * JSX consumes `bucketMailboxesForPopover` directly, so a passing test
 * here is what admins see in production.
 */

import { describe, expect, it } from "vitest";
import {
  bucketMailboxesForPopover,
  shouldShowRetry,
} from "@/components/conversations/capture-audit-status-pill";

type MonitorMode = "monitored_active" | "excluded_intentional" | "invalid_config" | "disabled";
type SentItemsHealth = "active" | "expired" | "missing" | "stale" | "unknown";

function mb(overrides: {
  id: string;
  monitorMode?: MonitorMode | undefined;
  sentItemsHealth: SentItemsHealth;
  email?: string;
}) {
  return {
    mailboxId: overrides.id,
    email: overrides.email ?? `${overrides.id}@valuetruck.com`,
    enabled: overrides.monitorMode === "monitored_active" || overrides.monitorMode === undefined,
    monitorMode: overrides.monitorMode,
    sentItemsHealth: overrides.sentItemsHealth,
    lastSentItemsNotificationAt: null,
    lastOutboundCapturedAt: null,
    syncStatus: "ok",
    syncError: null,
    reason: "",
  };
}

describe("bucketMailboxesForPopover — three-section split", () => {
  it("monitored_active + active lands in healthyActive only", () => {
    const buckets = bucketMailboxesForPopover([
      mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "active" }),
    ]);
    expect(buckets.healthyActive).toHaveLength(1);
    expect(buckets.actionRequired).toHaveLength(0);
    expect(buckets.configIssues).toHaveLength(0);
    expect(buckets.excluded).toHaveLength(0);
  });

  it("monitored_active + expired/missing/stale/unknown lands in actionRequired", () => {
    const buckets = bucketMailboxesForPopover([
      mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "expired" }),
      mb({ id: "b", monitorMode: "monitored_active", sentItemsHealth: "missing" }),
      mb({ id: "c", monitorMode: "monitored_active", sentItemsHealth: "stale" }),
      mb({ id: "d", monitorMode: "monitored_active", sentItemsHealth: "unknown" }),
    ]);
    expect(buckets.actionRequired).toHaveLength(4);
    expect(buckets.healthyActive).toHaveLength(0);
  });

  it("invalid_config lands in configIssues regardless of underlying sentItemsHealth", () => {
    // Casey's row: monitor_mode flipped to invalid_config, sub IDs cleared,
    // classifier returns sentItemsHealth=unknown — must NOT show up in
    // actionRequired (no Retry will help) and must NOT show up in excluded
    // (admins should still see it as a row that needs fixing).
    const buckets = bucketMailboxesForPopover([
      mb({ id: "casey", monitorMode: "invalid_config", sentItemsHealth: "unknown" }),
    ]);
    expect(buckets.configIssues).toHaveLength(1);
    expect(buckets.actionRequired).toHaveLength(0);
    expect(buckets.excluded).toHaveLength(0);
  });

  it("excluded_intentional lands in excluded", () => {
    const buckets = bucketMailboxesForPopover([
      mb({ id: "ben", monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
    ]);
    expect(buckets.excluded).toHaveLength(1);
    expect(buckets.actionRequired).toHaveLength(0);
    expect(buckets.configIssues).toHaveLength(0);
  });

  it("disabled lands in excluded (transparency-only)", () => {
    // Generic enabled=false rows that the migration backfilled to
    // monitor_mode='disabled' must surface under Excluded so admins know
    // they exist, but must not pollute Action Required or Config Issues.
    const buckets = bucketMailboxesForPopover([
      mb({ id: "paused", monitorMode: "disabled", sentItemsHealth: "unknown" }),
    ]);
    expect(buckets.excluded).toHaveLength(1);
    expect(buckets.actionRequired).toHaveLength(0);
    expect(buckets.configIssues).toHaveLength(0);
  });

  it("legacy null monitorMode defaults to monitored_active (backward compat)", () => {
    // Pre-migration snapshots that predate the column write should still
    // bucket sensibly — defaulting to monitored_active mirrors the server
    // classifier's defensive default.
    const buckets = bucketMailboxesForPopover([
      mb({ id: "legacy", monitorMode: undefined, sentItemsHealth: "active" }),
      mb({ id: "legacy-bad", monitorMode: undefined, sentItemsHealth: "expired" }),
    ]);
    expect(buckets.healthyActive).toHaveLength(1);
    expect(buckets.actionRequired).toHaveLength(1);
    expect(buckets.excluded).toHaveLength(0);
  });

  it("the Ben/Joe/Kylee/Josh/Jordan/Casey production reproduction — counters", () => {
    // The exact production case that motivated this task: 5 excluded reps
    // + 1 invalid Casey row + 2 genuinely-failing active mailboxes. Pre-
    // Task-997 the popover summary said "8 mailboxes affected"; the new
    // buckets MUST report 2 / 1 / 5 / N respectively so the on-call
    // admin's eye lands on the actual two failures.
    const ACTIVE_HEALTHY = 30;
    const buckets = bucketMailboxesForPopover([
      mb({ id: "ben",    monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
      mb({ id: "joe",    monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
      mb({ id: "kylee",  monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
      mb({ id: "josh",   monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
      mb({ id: "jordan", monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }),
      mb({ id: "casey",  monitorMode: "invalid_config",        sentItemsHealth: "unknown" }),
      mb({ id: "real-1", monitorMode: "monitored_active",      sentItemsHealth: "expired" }),
      mb({ id: "real-2", monitorMode: "monitored_active",      sentItemsHealth: "missing" }),
      ...Array.from({ length: ACTIVE_HEALTHY }, (_, i) =>
        mb({ id: `ok-${i}`, monitorMode: "monitored_active", sentItemsHealth: "active" }),
      ),
    ]);
    expect(buckets.actionRequired).toHaveLength(2);
    expect(buckets.configIssues).toHaveLength(1);
    expect(buckets.excluded).toHaveLength(5);
    expect(buckets.healthyActive).toHaveLength(ACTIVE_HEALTHY);
  });

  it("buckets partition the input list — sum equals total, no row in two buckets", () => {
    // Defensive invariant: a future bug that forgets one of the modes
    // (or double-counts a row) shows up here immediately.
    const rows = [
      mb({ id: "1", monitorMode: "monitored_active",      sentItemsHealth: "active" }),
      mb({ id: "2", monitorMode: "monitored_active",      sentItemsHealth: "expired" }),
      mb({ id: "3", monitorMode: "invalid_config",        sentItemsHealth: "unknown" }),
      mb({ id: "4", monitorMode: "excluded_intentional",  sentItemsHealth: "unknown" }),
      mb({ id: "5", monitorMode: "disabled",              sentItemsHealth: "unknown" }),
    ];
    const buckets = bucketMailboxesForPopover(rows);
    const sum =
      buckets.actionRequired.length +
      buckets.configIssues.length +
      buckets.excluded.length +
      buckets.healthyActive.length;
    expect(sum).toBe(rows.length);

    const seen = new Set<string>();
    for (const b of [buckets.actionRequired, buckets.configIssues, buckets.excluded, buckets.healthyActive]) {
      for (const m of b) {
        expect(seen.has(m.mailboxId)).toBe(false);
        seen.add(m.mailboxId);
      }
    }
    expect(seen.size).toBe(rows.length);
  });
});

describe("shouldShowRetry — Retry button visibility per monitor mode", () => {
  it("shows Retry only on monitored_active failing rows", () => {
    expect(shouldShowRetry(mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "expired" }))).toBe(true);
    expect(shouldShowRetry(mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "missing" }))).toBe(true);
    expect(shouldShowRetry(mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "stale" }))).toBe(true);
  });

  it("hides Retry on healthy active rows (nothing to retry)", () => {
    expect(shouldShowRetry(mb({ id: "a", monitorMode: "monitored_active", sentItemsHealth: "active" }))).toBe(false);
  });

  it("hides Retry on invalid_config rows — admin must fix the row, not click Retry", () => {
    // The whole point of invalid_config: the underlying address is
    // wrong. Re-registering the subscription would just fail the same
    // way. Surfacing a Retry button here would mislead the admin into
    // burning Graph quota on a guaranteed failure.
    expect(shouldShowRetry(mb({ id: "casey", monitorMode: "invalid_config", sentItemsHealth: "unknown" }))).toBe(false);
    expect(shouldShowRetry(mb({ id: "casey", monitorMode: "invalid_config", sentItemsHealth: "expired" }))).toBe(false);
  });

  it("hides Retry on excluded_intentional rows (no subscription to retry)", () => {
    expect(shouldShowRetry(mb({ id: "ben", monitorMode: "excluded_intentional", sentItemsHealth: "unknown" }))).toBe(false);
  });

  it("hides Retry on disabled rows (admin must re-enable first)", () => {
    expect(shouldShowRetry(mb({ id: "paused", monitorMode: "disabled", sentItemsHealth: "unknown" }))).toBe(false);
  });

  it("legacy null monitorMode behaves like monitored_active (Retry shown when broken)", () => {
    expect(shouldShowRetry(mb({ id: "a", monitorMode: undefined, sentItemsHealth: "expired" }))).toBe(true);
    expect(shouldShowRetry(mb({ id: "a", monitorMode: undefined, sentItemsHealth: "active" }))).toBe(false);
  });
});
