/**
 * Tests for the call-volume drop-off scheduler (Task #330).
 *
 * Run with: npx tsx server/callVolumeDropScheduler.test.ts
 *
 * Covers:
 *   - evaluateOrg threshold and baseline-floor behavior.
 *   - checkCallVolumeDropoffs transition behavior:
 *     - first-day flip alerts the manager,
 *     - prolonged slump does not re-alert the next day,
 *     - recovery + re-drop alerts again,
 *     - leadership fallback when the rep has no manager,
 *     - hasUnreadNotification dedupe blocks duplicate notifications.
 */

import { __testing__ } from "./callVolumeDropScheduler";

type Notification = {
  userId: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  relatedId?: string;
  read: boolean;
};

type Touchpoint = {
  id: string;
  type: string;
  notes: string;
  loggedById: string;
  createdAt: string;
  organizationId: string;
};

type User = {
  id: string;
  organizationId: string;
  username: string;
  name: string;
  role: string;
  managerId: string | null;
};

let passed = 0;
let failed = 0;

function assertEqual<T>(desc: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${desc}`); passed++; }
  else    { console.error(`  ✗ ${desc}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`); failed++; }
}

function assert(desc: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${desc}`); passed++; }
  else      { console.error(`  ✗ ${desc}`); failed++; }
}

// In-memory fake of the storage methods touched by the scheduler.
function makeFakeStorage(opts: {
  users: User[];
  touchpoints: Touchpoint[];
  organizations: { id: string }[];
  unreadNotifications?: Set<string>; // key = `${userId}|${type}|${relatedId}`
}) {
  const settings = new Map<string, string>();
  const created: Notification[] = [];
  const unread = opts.unreadNotifications ?? new Set<string>();

  const fake = {
    async getOrganizations() { return opts.organizations; },
    async getUsers(orgId: string) { return opts.users.filter(u => u.organizationId === orgId); },
    async getTouchpointsByOrg(orgId: string) {
      return opts.touchpoints.filter(t => t.organizationId === orgId);
    },
    async getSetting(k: string) { return settings.get(k); },
    async setSetting(k: string, v: string) { settings.set(k, v); },
    async hasUnreadNotification(userId: string, type: string, relatedId: string) {
      return unread.has(`${userId}|${type}|${relatedId}`);
    },
    async createNotification(n: Notification) {
      created.push(n);
      // Newly created notifications are unread by default — emulate that so
      // a second pass on the same day cannot duplicate alerts.
      if (n.relatedId) unread.add(`${n.userId}|${n.type}|${n.relatedId}`);
    },
  };

  return { fake, created, settings, unread };
}

import type { IStorage } from "./storage";

function asStorage(fake: object): IStorage {
  return fake as unknown as IStorage;
}

function tp(id: string, userId: string, daysAgo: number, orgId = "o1"): Touchpoint {
  const ts = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
  return {
    id, type: "call",
    notes: "[Webex CDR: 12345 Outbound]",
    loggedById: userId, createdAt: ts, organizationId: orgId,
  };
}

const baseUsers: User[] = [
  { id: "mgr1", organizationId: "o1", username: "mgr1@x.com", name: "Mary Manager", role: "sales_director", managerId: null },
  { id: "rep1", organizationId: "o1", username: "rep1@x.com", name: "Rita Rep",     role: "account_manager", managerId: "mgr1" },
  { id: "rep2", organizationId: "o1", username: "rep2@x.com", name: "Roy Rep",      role: "account_manager", managerId: "mgr1" },
  { id: "orphan", organizationId: "o1", username: "orphan@x.com", name: "Olive Orphan", role: "account_manager", managerId: null },
  { id: "admin1", organizationId: "o1", username: "admin@x.com", name: "Ada Admin", role: "admin", managerId: null },
];

// Build a baseline of N calls in the trailing 30 days (excluding the last 7).
function baselineCalls(userId: string, total: number, idPrefix: string): Touchpoint[] {
  const out: Touchpoint[] = [];
  for (let i = 0; i < total; i++) {
    // Spread across days 8..29 ago so none fall in the 7-day window.
    const daysAgo = 8 + (i % 22);
    out.push(tp(`${idPrefix}-b${i}`, userId, daysAgo));
  }
  return out;
}

// ── 1. evaluateOrg threshold + baseline floor ────────────────────────────────

console.log("\n1. evaluateOrg threshold + baseline floor");

await (async () => {
  // rep1: baseline 30 calls (~1/day, expected 7 in window), 1 call this week → big drop.
  // rep2: baseline 30 calls, 6 calls this week → only -14% vs expected → not flagged.
  // orphan: baseline 4 calls (below floor) → ignored regardless of activity.
  const touchpoints: Touchpoint[] = [
    ...baselineCalls("rep1", 30, "rep1"),
    tp("rep1-w0", "rep1", 1),
    ...baselineCalls("rep2", 30, "rep2"),
    tp("rep2-w0", "rep2", 1), tp("rep2-w1", "rep2", 2), tp("rep2-w2", "rep2", 3),
    tp("rep2-w3", "rep2", 4), tp("rep2-w4", "rep2", 5), tp("rep2-w5", "rep2", 6),
    ...baselineCalls("orphan", 4, "orphan"),
  ];
  const { fake } = makeFakeStorage({
    users: baseUsers, touchpoints, organizations: [{ id: "o1" }],
  });
  const dropoffs = await __testing__.evaluateOrg("o1", asStorage(fake));
  assertEqual("only rep1 is flagged", dropoffs.map(d => d.userId).sort(), ["rep1"]);
  const r1 = dropoffs.find(d => d.userId === "rep1")!;
  assert("rep1 deltaPct ≤ -50", r1.deltaPct <= -50);
  assertEqual("rep1 count = 1", r1.count, 1);
})();

// ── 2. First-day flip alerts manager ─────────────────────────────────────────

console.log("\n2. First-day flip alerts manager");

await (async () => {
  const touchpoints: Touchpoint[] = [
    ...baselineCalls("rep1", 30, "rep1"),
    tp("rep1-w0", "rep1", 1), // 1 call this week vs ~7 expected
  ];
  const { fake, created, settings } = makeFakeStorage({
    users: baseUsers, touchpoints, organizations: [{ id: "o1" }],
  });
  await __testing__.checkCallVolumeDropoffs(asStorage(fake));
  const mgrAlerts = created.filter(n => n.userId === "mgr1" && n.type === "call_volume_drop");
  assertEqual("manager got exactly 1 alert", mgrAlerts.length, 1);
  assertEqual("alert relatedId is the rep", mgrAlerts[0].relatedId, "rep1");
  assert("yesterday-state persisted", JSON.parse(settings.get("call_volume_dropoffs_yesterday")!).o1.includes("rep1"));
})();

// ── 3. Prolonged slump does NOT re-alert next day ───────────────────────────

console.log("\n3. Prolonged slump does not re-alert");

await (async () => {
  const touchpoints: Touchpoint[] = [
    ...baselineCalls("rep1", 30, "rep1"),
    tp("rep1-w0", "rep1", 1),
  ];
  const { fake, created } = makeFakeStorage({
    users: baseUsers, touchpoints, organizations: [{ id: "o1" }],
  });
  const s = asStorage(fake);
  await __testing__.checkCallVolumeDropoffs(s); // day 1: alert
  await __testing__.checkCallVolumeDropoffs(s); // day 2: should be silent
  const mgrAlerts = created.filter(n => n.userId === "mgr1" && n.type === "call_volume_drop");
  assertEqual("manager still has only 1 alert after 2 runs", mgrAlerts.length, 1);
})();

// ── 4. Recovery then re-drop alerts again ───────────────────────────────────

console.log("\n4. Recovery then re-drop alerts again");

await (async () => {
  const droppedTouchpoints: Touchpoint[] = [
    ...baselineCalls("rep1", 30, "rep1"),
    tp("rep1-w0", "rep1", 1),
  ];
  const { fake, created, unread } = makeFakeStorage({
    users: baseUsers, touchpoints: droppedTouchpoints, organizations: [{ id: "o1" }],
  });
  const s = asStorage(fake);
  await __testing__.checkCallVolumeDropoffs(s); // day 1: alert
  // Simulate recovery — give rep1 lots of recent calls so they exit drop-off.
  for (let i = 0; i < 14; i++) droppedTouchpoints.push(tp(`rep1-r${i}`, "rep1", 1));
  // Manager reads the previous notification.
  unread.delete(`mgr1|call_volume_drop|rep1`);
  await __testing__.checkCallVolumeDropoffs(s); // day 2: rep recovered, no alert
  // Now drop again — remove the recovery calls.
  for (let i = 0; i < 14; i++) droppedTouchpoints.pop();
  await __testing__.checkCallVolumeDropoffs(s); // day 3: re-flip should alert
  const mgrAlerts = created.filter(n => n.userId === "mgr1" && n.type === "call_volume_drop");
  assertEqual("manager has 2 alerts after flip → recover → flip", mgrAlerts.length, 2);
})();

// ── 5. Leadership fallback when rep has no manager ──────────────────────────

console.log("\n5. Leadership fallback when rep has no manager");

await (async () => {
  const touchpoints: Touchpoint[] = [
    ...baselineCalls("orphan", 30, "orphan"),
    tp("orphan-w0", "orphan", 1),
  ];
  const { fake, created } = makeFakeStorage({
    users: baseUsers, touchpoints, organizations: [{ id: "o1" }],
  });
  await __testing__.checkCallVolumeDropoffs(asStorage(fake));
  const adminAlerts = created.filter(n => n.userId === "admin1" && n.type === "call_volume_drop");
  const mgrAlerts   = created.filter(n => n.userId === "mgr1"   && n.type === "call_volume_drop");
  assertEqual("admin (leader) was alerted for orphan rep", adminAlerts.length, 1);
  // mgr1 is sales_director leadership, so they also get the fallback alert.
  assertEqual("sales_director (leader) was alerted for orphan rep", mgrAlerts.length, 1);
})();

// ── 6. Pre-existing unread notification blocks duplicate ───────────────────

console.log("\n6. Pre-existing unread notification blocks duplicate");

await (async () => {
  const touchpoints: Touchpoint[] = [
    ...baselineCalls("rep1", 30, "rep1"),
    tp("rep1-w0", "rep1", 1),
  ];
  const { fake, created } = makeFakeStorage({
    users: baseUsers, touchpoints, organizations: [{ id: "o1" }],
    unreadNotifications: new Set(["mgr1|call_volume_drop|rep1"]),
  });
  await __testing__.checkCallVolumeDropoffs(asStorage(fake));
  const mgrAlerts = created.filter(n => n.userId === "mgr1" && n.type === "call_volume_drop");
  assertEqual("dedupe blocked the duplicate alert", mgrAlerts.length, 0);
})();

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
