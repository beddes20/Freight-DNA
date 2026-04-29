/**
 * Email observability + health-hardening regression tests.
 *
 * Locks in the three changes from the 2026-04-29 hardening pass:
 *
 *   A. Silent swallow sites in the email pipeline now emit
 *      `recordIntegrationEvent({ source: "graph", outcome: "error" })`
 *      so operationally-invisible failures show up on the Integrations
 *      Health console instead of only in raw logs.
 *
 *   B. The capture-audit health snapshot now exposes shared reply mailbox
 *      state, and folds a "configured but not enabled" shared mailbox into
 *      the overall pill status as `unhealthy` (so a silently re-init-failed
 *      shared subscription doesn't go unnoticed).
 *
 *   C. The SentItems stale threshold dropped from 24h to 4h AND the
 *      staleness verdict now ignores `lastSyncAt` (which the delta-sync
 *      poll keeps fresh every 5 minutes and was masking dropped subs).
 *      `lastSuccessfulSyncAt` still uses `lastSyncAt` for the "pill flips
 *      green right after a manual renew" behavior.
 *
 * Run with: npx tsx tests/email-health-instrumentation.test.ts
 */

import {
  _resetIntegrationEventsForTests,
  _getIntegrationEventForTests,
  recordIntegrationEvent,
} from "../server/integrations/probeRegistry";
import {
  getMailboxSentItemsHealth,
} from "../server/services/conversationReplyCaptureService";
import type { MonitoredMailbox } from "@shared/schema";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

function makeMailbox(overrides: Partial<MonitoredMailbox> = {}): MonitoredMailbox {
  const now = new Date();
  const inFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    id: "mb_test_1",
    orgId: "org_test_1",
    userId: "user_test_1",
    email: "rep@example.com",
    enabled: true,
    syncStatus: "active",
    syncError: null,
    subscriptionId: "sub_inbox_1",
    sentItemsSubscriptionId: "sub_sent_1",
    subscriptionExpiresAt: inFuture,
    lastSyncAt: now,
    lastSentItemsNotificationAt: now,
    lastOutboundCapturedAt: now,
    deltaToken: null,
    sentItemsDeltaToken: null,
    createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    updatedAt: now,
    ...overrides,
  } as MonitoredMailbox;
}

async function main(): Promise<void> {
  // ── Group A: instrumentation assertions ───────────────────────────────────
  section("Group A — silent swallow sites are surfaced as integration events");

  // A1. recordIntegrationEvent itself wires through to the in-process bus
  //     correctly (the wiring our scheduler/webhook edits depend on).
  _resetIntegrationEventsForTests();
  recordIntegrationEvent({
    source: "graph",
    outcome: "error",
    errorMessage: "quote_ingest:msg_test: simulated DB failure",
  });
  const ev1 = _getIntegrationEventForTests("graph");
  assert(
    "recordIntegrationEvent persists an error event under the correct source",
    !!ev1 && ev1.totalError === 1 && ev1.lastErrorMessage === "quote_ingest:msg_test: simulated DB failure",
    `event=${JSON.stringify(ev1)}`,
  );
  assert(
    "first error event leaves totalSuccess at 0",
    !!ev1 && ev1.totalSuccess === 0,
  );
  assert(
    "first error event populates lastErrorAt but not lastSuccessAt",
    !!ev1 && ev1.lastErrorAt instanceof Date && ev1.lastSuccessAt === null,
  );

  // A2. Multiple errors accumulate; latest message wins; success bumps the
  //     success counter without clearing the error trail.
  _resetIntegrationEventsForTests();
  recordIntegrationEvent({ source: "graph", outcome: "error", errorMessage: "play_outcome_classify:abc: boom" });
  recordIntegrationEvent({ source: "graph", outcome: "error", errorMessage: "pafoe_classify:xyz: boom2" });
  recordIntegrationEvent({ source: "graph", outcome: "success" });
  const ev2 = _getIntegrationEventForTests("graph");
  assert(
    "consecutive errors increment totalError and overwrite lastErrorMessage",
    !!ev2 && ev2.totalError === 2 && ev2.lastErrorMessage === "pafoe_classify:xyz: boom2",
    `event=${JSON.stringify(ev2)}`,
  );
  assert(
    "success after errors increments totalSuccess without clearing lastErrorAt",
    !!ev2 && ev2.totalSuccess === 1 && ev2.lastErrorAt instanceof Date,
  );

  // A3. Verify each instrumented swallow site uses a unique error tag
  //     prefix so admins can tell them apart when reading the console.
  //     (Static lock-in — guards against future edits accidentally
  //     collapsing the four scheduler tags or two webhook tags.)
  const { readFileSync } = await import("node:fs");
  const schedulerSrc = readFileSync("server/emailIntelligenceScheduler.ts", "utf8");
  const webhookSrc = readFileSync("server/routes/graphWebhook.ts", "utf8");
  const captureSrc = readFileSync("server/services/conversationReplyCaptureService.ts", "utf8");

  for (const tag of [
    "quote_ingest:",
    "closed_won_handling:",
    "closed_lost_handling:",
    "legacy_nba:",
  ]) {
    assert(
      `scheduler instrumentation tag "${tag}" is wired`,
      schedulerSrc.includes(tag) && schedulerSrc.includes("recordIntegrationEvent"),
    );
  }
  for (const tag of [
    "play_outcome_classify:",
    "pafoe_classify:",
    // user-mailbox classifier branch (parallel to the shared-mailbox
    // branch above) — added in the same hardening pass so an outage in
    // the rep-mailbox classifier path is equally visible.
    "play_outcome_classify_user_mailbox:",
    "pafoe_classify_user_mailbox:",
  ]) {
    assert(
      `graphWebhook instrumentation tag "${tag}" is wired`,
      webhookSrc.includes(tag) && webhookSrc.includes("recordIntegrationEvent"),
    );
  }
  assert(
    `self-heal per-message instrumentation tag "self_heal_message_ingest:" is wired`,
    captureSrc.includes("self_heal_message_ingest:") && captureSrc.includes("recordIntegrationEvent"),
  );

  // ── Group B: shared-mailbox health rollup ─────────────────────────────────
  section("Group B — shared reply mailbox health folds into the pill rollup");

  // We exercise getCaptureAuditHealthForUsers indirectly through its module
  // because it does live DB reads; instead of stubbing all of storage, we
  // verify the integration shape via the source file. The ROUTE-LEVEL
  // contract (snapshot includes `sharedReplyMailbox` and rolls degraded
  // shared mailbox into "unhealthy") is locked in by static assertion on
  // the source file — this catches accidental removal of the rollup.

  const sharedReplyHooks = [
    "getReplyTrackingStatus",         // import is wired
    "sharedReplyMailbox",              // field is on the snapshot
    "sharedReplyDegraded",             // rollup variable is computed
    "configured", "subscriptionActive", "missingPermissions", "warnings",
  ];
  for (const hook of sharedReplyHooks) {
    assert(
      `capture-audit snapshot integrates "${hook}"`,
      captureSrc.includes(hook),
    );
  }
  assert(
    "capture-audit rollup includes sharedReplyDegraded in the unhealthy condition",
    /unhealthy.*\n[^\n]*sharedReplyDegraded|sharedReplyDegraded[^\n]*\n[^\n]*unhealthy/s.test(captureSrc)
      || /webhookFailureCount > 0 \|\| cronCritical \|\| sharedReplyDegraded/.test(captureSrc),
  );
  assert(
    "capture-audit returns sharedReplyMailbox: null when Azure creds aren't configured",
    captureSrc.includes("hasAzureCreds")
      && /sharedReplyMailbox[^=]*=[^=]*hasAzureCreds[^?]*\?/s.test(captureSrc),
  );

  // Verify the pill component types this new field as optional+nullable so
  // older snapshots without the field don't crash the UI.
  const pillSrc = readFileSync(
    "client/src/components/conversations/capture-audit-status-pill.tsx",
    "utf8",
  );
  assert(
    "pill HealthPayload declares sharedReplyMailbox?: ... | null (back-compat)",
    /sharedReplyMailbox\?\:\s*SharedReplyMailboxHealth\s*\|\s*null/.test(pillSrc),
  );
  assert(
    "pill renders a degraded-shared-mailbox banner gated on configured && !enabled",
    pillSrc.includes("data.sharedReplyMailbox.configured")
      && pillSrc.includes("!data.sharedReplyMailbox.enabled")
      && pillSrc.includes("shared-reply-mailbox-degraded"),
  );

  // ── Group C: SentItems stale threshold ────────────────────────────────────
  section("Group C — SentItems stale threshold (4h, lastSyncAt excluded)");

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  // C1. Boundary: 3h59m ago → still active.
  const justUnder = new Date(Date.now() - (FOUR_HOURS_MS - 60_000));
  const h1 = getMailboxSentItemsHealth(makeMailbox({
    lastSentItemsNotificationAt: justUnder,
    lastOutboundCapturedAt: justUnder,
    lastSyncAt: new Date(),
  }));
  assert(
    "mailbox with SentItems traffic 3h59m ago is still 'active'",
    h1.sentItemsHealth === "active",
    `got ${h1.sentItemsHealth} reason=${h1.reason}`,
  );

  // C2. Boundary: 4h01m ago → stale.
  const justOver = new Date(Date.now() - (FOUR_HOURS_MS + 60_000));
  const h2 = getMailboxSentItemsHealth(makeMailbox({
    lastSentItemsNotificationAt: justOver,
    lastOutboundCapturedAt: justOver,
    lastSyncAt: new Date(),
  }));
  assert(
    "mailbox with SentItems traffic 4h01m ago is 'stale'",
    h2.sentItemsHealth === "stale",
    `got ${h2.sentItemsHealth} reason=${h2.reason}`,
  );

  // C3. The KEY behavior of Option B — lastSyncAt MUST NOT mask staleness.
  //     5h since last SentItems push, 1m since last delta poll → stale.
  //     (Under the OLD logic this would have been "active" because
  //      lastSyncAt was included in the staleness calculation.)
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const h3 = getMailboxSentItemsHealth(makeMailbox({
    lastSentItemsNotificationAt: fiveHoursAgo,
    lastOutboundCapturedAt: fiveHoursAgo,
    lastSyncAt: new Date(Date.now() - 60_000),  // delta poll 1m ago
  }));
  assert(
    "mailbox with 5h-old SentItems but fresh lastSyncAt is 'stale' (Option B: lastSyncAt excluded)",
    h3.sentItemsHealth === "stale",
    `got ${h3.sentItemsHealth} reason=${h3.reason}`,
  );

  // C4. Subscription-expired path still wins over staleness verdict.
  const expired = new Date(Date.now() - 60_000);
  const h4 = getMailboxSentItemsHealth(makeMailbox({
    subscriptionExpiresAt: expired,
    lastSentItemsNotificationAt: new Date(),
    lastOutboundCapturedAt: new Date(),
    lastSyncAt: new Date(),
  }));
  assert(
    "expired subscription is reported as 'expired' regardless of recent traffic",
    h4.sentItemsHealth === "expired",
    `got ${h4.sentItemsHealth}`,
  );

  // C5. Mailbox with NO SentItems traffic ever, but old enough → stale.
  const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const h5 = getMailboxSentItemsHealth(makeMailbox({
    lastSentItemsNotificationAt: null,
    lastOutboundCapturedAt: null,
    lastSyncAt: new Date(),
    createdAt: longAgo,
  }));
  assert(
    "mailbox with sub but no SentItems traffic ever (older than 4h) is 'stale'",
    h5.sentItemsHealth === "stale",
    `got ${h5.sentItemsHealth} reason=${h5.reason}`,
  );

  // C6. Lock in the 4h constant numerically.
  assert(
    "SENTITEMS_STALE_MS constant is 4h (not the legacy 24h)",
    captureSrc.includes("4 * 60 * 60 * 1000")
      && !/SENTITEMS_STALE_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(captureSrc),
  );

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(2);
});
