/**
 * Live-sync watchdog probe — Task #951
 *
 * Pins the alarm behavior the user explicitly asked for: when the SSE
 * `/api/live-sync/stream` endpoint starts rejecting most/all connection
 * attempts (the exact prod regression that caused Conversations to stop
 * auto-updating), or when mailbox ingest happens but the matching
 * `mailbox_inbound`/`mailbox_outbound` publish doesn't fire, an admin
 * alert MUST be raised — not waited on rep complaints.
 *
 * Strategy: mock `storage` so we capture fire/resolve calls without
 * standing up Postgres, then exercise `runLiveSyncHealthCheck` directly
 * with synthetic mailbox state + synthetic auth-outcome ring contents.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fireCalls: Array<{ alertKey: string; orgId: string; mailboxId: string; reason: string }> = [];
const resolveCalls: Array<{ mailboxId: string; alertKey: string }> = [];
let fireIsNew = true;
let existingAlertKeys = new Set<string>();

vi.mock("../storage", () => ({
  storage: {
    fireMailboxHealthAlert: async (input: any) => {
      fireCalls.push({
        alertKey: input.alertKey,
        orgId: input.orgId,
        mailboxId: input.mailboxId,
        reason: input.reason,
      });
      return { isNew: fireIsNew, alert: { id: "alert-x" } };
    },
    resolveMailboxHealthAlert: async (mailboxId: string, alertKey: string) => {
      resolveCalls.push({ mailboxId, alertKey });
      // Mimic real storage: only return a row when an alert was open.
      return existingAlertKeys.has(alertKey)
        ? { id: "alert-x", mailboxId, alertKey }
        : undefined;
    },
    createNotification: async () => undefined,
  },
  // The watchdog also imports `db` for its admin-fan-out query; stub it as
  // an empty result so notifications are a silent no-op in this suite.
  db: {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  },
}));

// Cron + heartbeat infra is irrelevant to the unit under test.
vi.mock("../lib/cronHeartbeat", () => ({
  JOB_NAMES: { mailboxHealthWatchdog: "mailbox_health_watchdog" },
  withHeartbeat: async (_n: any, _i: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../graphSubscriptionService", () => ({
  renewSingleMailboxSubscription: async () => ({ ok: true }),
}));

import {
  runLiveSyncHealthCheck,
  _resetLiveSyncHealthTrackerForTests,
  _LIVE_SYNC_HEALTH_THRESHOLDS_FOR_TESTS as T,
} from "../services/mailboxWatchdogService";
import {
  recordLiveSyncAuthOutcome,
  publish,
  _resetLiveSyncMetricsForTests,
} from "../services/liveSync";

function makeMailbox(orgId: string, lastInboxNotificationAt: Date | null) {
  return {
    id: `mb-${orgId}`,
    orgId,
    email: `ops+${orgId}@example.com`,
    enabled: true,
    subscriptionId: "sub-x",
    sentItemsSubscriptionId: "sub-y",
    subscriptionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    lastInboxNotificationAt,
    // Only the fields the probe reads matter — the real type carries many
    // more, but the function signature accepts MonitoredMailbox[] and TS
    // does not run on the test fixtures (vi.mock typing is loose).
  } as any;
}

beforeEach(() => {
  fireCalls.length = 0;
  resolveCalls.length = 0;
  existingAlertKeys = new Set();
  fireIsNew = true;
  _resetLiveSyncHealthTrackerForTests();
  _resetLiveSyncMetricsForTests();
});

describe("runLiveSyncHealthCheck — auth-failure alert", () => {
  it("does NOT fire below the consecutive-tick threshold even with a 100% failure rate", async () => {
    const mb = makeMailbox("org-a", new Date());
    for (let i = 0; i < T.authMinAttempts; i++) recordLiveSyncAuthOutcome(false);
    const out = await runLiveSyncHealthCheck([mb], new Date());
    expect(out.authFailing).toBe(true);
    expect(fireCalls.find((c) => c.alertKey === T.alertKeyAuth)).toBeUndefined();
  });

  it("fires on the Nth consecutive failing tick, against the org anchor mailbox", async () => {
    const mb = makeMailbox("org-a", new Date());
    for (let tick = 0; tick < T.authConsecutiveTicks; tick++) {
      // Refill the rolling ring on every tick — getLiveSyncAuthStats prunes
      // entries older than 60s but our `Date.now()` advances trivially.
      for (let i = 0; i < T.authMinAttempts; i++) recordLiveSyncAuthOutcome(false);
      await runLiveSyncHealthCheck([mb], new Date());
    }
    const fired = fireCalls.filter((c) => c.alertKey === T.alertKeyAuth);
    expect(fired.length).toBe(1);
    expect(fired[0].orgId).toBe("org-a");
    expect(fired[0].mailboxId).toBe("mb-org-a");
    expect(fired[0].reason).toMatch(/rejecting/);
  });

  it("ignores low-traffic windows (under min-attempts) so dev/preview never pages", async () => {
    const mb = makeMailbox("org-a", new Date());
    // Below the floor: even 100% failure shouldn't set authFailing.
    for (let i = 0; i < T.authMinAttempts - 1; i++) recordLiveSyncAuthOutcome(false);
    const out = await runLiveSyncHealthCheck([mb], new Date());
    expect(out.authFailing).toBe(false);
    expect(fireCalls.find((c) => c.alertKey === T.alertKeyAuth)).toBeUndefined();
  });

  it("resolves the open alert once successes return", async () => {
    const mb = makeMailbox("org-a", new Date());
    existingAlertKeys.add(T.alertKeyAuth);
    // No failures recorded → authFailing=false → resolve path runs.
    for (let i = 0; i < T.authMinAttempts; i++) recordLiveSyncAuthOutcome(true);
    const out = await runLiveSyncHealthCheck([mb], new Date());
    expect(out.authFailing).toBe(false);
    expect(out.alertsResolved).toBeGreaterThanOrEqual(1);
    expect(resolveCalls.find((c) => c.alertKey === T.alertKeyAuth)).toBeDefined();
  });

  it("fans out the auth alert to every org's anchor (multi-tenant safety)", async () => {
    const mbA = makeMailbox("org-a", new Date());
    const mbB = makeMailbox("org-b", new Date());
    for (let tick = 0; tick < T.authConsecutiveTicks; tick++) {
      for (let i = 0; i < T.authMinAttempts; i++) recordLiveSyncAuthOutcome(false);
      await runLiveSyncHealthCheck([mbA, mbB], new Date());
    }
    const fired = fireCalls.filter((c) => c.alertKey === T.alertKeyAuth);
    const orgs = new Set(fired.map((f) => f.orgId));
    expect(orgs.has("org-a")).toBe(true);
    expect(orgs.has("org-b")).toBe(true);
  });
});

describe("runLiveSyncHealthCheck — silent-stream alert", () => {
  it("fires on the Nth consecutive tick when ingest is recent but no publish ever happened", async () => {
    const mb = makeMailbox("org-a", new Date(Date.now() - 60_000)); // 1m ago
    for (let tick = 0; tick < T.silentConsecutiveTicks; tick++) {
      await runLiveSyncHealthCheck([mb], new Date());
    }
    const fired = fireCalls.filter((c) => c.alertKey === T.alertKeySilent);
    expect(fired.length).toBe(1);
    expect(fired[0].orgId).toBe("org-a");
  });

  it("does NOT fire when publish() has fired recently for the same org", async () => {
    const mb = makeMailbox("org-a", new Date(Date.now() - 60_000));
    publish("org-a", "mailbox_inbound", "msg-1");
    for (let tick = 0; tick < T.silentConsecutiveTicks; tick++) {
      await runLiveSyncHealthCheck([mb], new Date());
    }
    expect(fireCalls.find((c) => c.alertKey === T.alertKeySilent)).toBeUndefined();
  });

  it("does NOT fire when no ingest has ever happened (nothing to be silent about)", async () => {
    const mb = makeMailbox("org-a", null);
    for (let tick = 0; tick < T.silentConsecutiveTicks; tick++) {
      await runLiveSyncHealthCheck([mb], new Date());
    }
    expect(fireCalls.find((c) => c.alertKey === T.alertKeySilent)).toBeUndefined();
  });

  it("resolves the silent-stream alert once publish() fires again", async () => {
    const mb = makeMailbox("org-a", new Date(Date.now() - 60_000));
    existingAlertKeys.add(T.alertKeySilent);
    publish("org-a", "mailbox_outbound", "msg-99");
    const out = await runLiveSyncHealthCheck([mb], new Date());
    expect(out.alertsResolved).toBeGreaterThanOrEqual(1);
    expect(resolveCalls.find((c) => c.alertKey === T.alertKeySilent)).toBeDefined();
  });
});
