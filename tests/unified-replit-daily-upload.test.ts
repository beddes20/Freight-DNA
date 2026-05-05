/**
 * Task #1051 — Unified ReplitDailyUpload behavioral tests.
 *
 * Direct exercises of the contract that the rejected code review demanded
 * proper coverage for:
 *   1. The 6-vs-5 LWQ eligibility threshold (5 moved loads → not eligible,
 *      6 moved loads → eligible).
 *   2. Grace-period retraction: a lane that was eligible yesterday but has
 *      0 moves today MUST stay eligible until lastEligibleAt is older than
 *      LWQ_GRACE_DAYS.
 *   3. AVL-sheet rows are forced to moved=false (cannot inflate the move
 *      count even if their brokerage status implies movement).
 *   4. The fact-table writer is the single source of truth: a synthetic
 *      upload writes rows that summarizeEligibleLanesFromFact reads back
 *      with identical (origin, dest, equipment) anchoring.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, storage } from "../server/storage";
import { organizations, financialUploads, recurringLanes, users } from "../shared/schema";
import {
  ingestUploadIntoFact,
  summarizeEligibleLanesFromFact,
  isMovedBrokerageStatus,
  normalizeRowToFact,
  LWQ_MOVES_THRESHOLD,
  LWQ_ROLLING_DAYS,
  LWQ_GRACE_DAYS,
} from "../server/services/freightDailyUploadFact";
import { runRecurringLaneEngineForOrg } from "../server/recurringLaneCapacityEngine";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${label}`); passed++; })
    .catch(err => { console.error(`  ✗ ${label}\n      ${err.message}`); failed++; failures.push(label); });
}

function makeRow(opts: {
  origin: string; dest: string; equipment: string;
  customer?: string; carrier?: string; status?: string; daysAgo?: number; orderId?: string;
}): Record<string, unknown> {
  const date = new Date(Date.now() - (opts.daysAgo ?? 1) * 86400_000)
    .toISOString().slice(0, 10);
  const [oc, os] = opts.origin.split(",").map(s => s.trim());
  const [dc, ds] = opts.dest.split(",").map(s => s.trim());
  return {
    "Order": opts.orderId ?? `ord-${Math.random().toString(36).slice(2, 10)}`,
    "Customer": opts.customer ?? "Acme Foods",
    "Origin": oc, "Origin state": os,
    "Destination": dc, "Destination state": ds,
    "Trailer type": opts.equipment,
    "Carrier": opts.carrier ?? "1234 - Best Carrier Inc",
    "Brokerage Status": opts.status ?? "POD",
    "Pickup Date": date,
    "Delivery date": date,
    "Total Revenue": 2500,
    "Carrier Total": 2000,
    "Loaded Miles": 500,
  };
}

async function setupOrg(): Promise<{ orgId: string; userId: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizations).values({
    name: `test-org-${stamp}`,
    slug: `test-org-${stamp}`,
  }).returning();
  const [user] = await db.insert(users).values({
    organizationId: org.id,
    username: `tester-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    email: `tester-${Date.now()}@x.test`,
    password: "x",
    role: "admin",
    name: "Tester",
  }).returning();
  return { orgId: org.id, userId: user.id };
}

async function createUpload(orgId: string, userId: string, fileName = "test.xlsx"): Promise<string> {
  const [u] = await db.insert(financialUploads).values({
    fileName, rowCount: 0, rows: [], uploadedBy: userId,
    sheetData: null, columnMapping: null,
    uploadedAt: new Date(),
  }).returning();
  return u.id;
}

async function cleanupOrg(orgId: string): Promise<void> {
  await db.execute(sql`DELETE FROM freight_daily_upload_fact WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM recurring_lanes WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM financial_uploads WHERE uploaded_by IN (SELECT id FROM users WHERE organization_id = ${orgId})`);
  await db.execute(sql`DELETE FROM users WHERE organization_id = ${orgId}`);
  await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
}

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  Task #1051 — Unified ReplitDailyUpload Behavioral Tests");
console.log("══════════════════════════════════════════════════════════════\n");

console.log("── Constants & moved classifier ──");
await check("LWQ_MOVES_THRESHOLD === 6", () => assert.equal(LWQ_MOVES_THRESHOLD, 6));
await check("LWQ_ROLLING_DAYS === 30", () => assert.equal(LWQ_ROLLING_DAYS, 30));
await check("LWQ_GRACE_DAYS === 7", () => assert.equal(LWQ_GRACE_DAYS, 7));
await check("isMovedBrokerageStatus('POD') === true", () => assert.equal(isMovedBrokerageStatus("POD"), true));
await check("isMovedBrokerageStatus('AVL') === false", () => assert.equal(isMovedBrokerageStatus("AVL"), false));
await check("isMovedBrokerageStatus('Quote') === false", () => assert.equal(isMovedBrokerageStatus("Quote"), false));
await check("isMovedBrokerageStatus('') === false", () => assert.equal(isMovedBrokerageStatus(""), false));

console.log("\n── normalizeRowToFact: AVL rows are forced moved=false ──");
{
  const ctxBase = { orgId: "x", uploadId: "y" };
  const r = normalizeRowToFact(makeRow({ origin: "Phoenix, AZ", dest: "Dallas, TX", equipment: "V", status: "POD" }),
    { ...ctxBase, forceMoved: false });
  await check("forceMoved=false overrides POD status", () => assert.equal(r?.moved, false));
  const r2 = normalizeRowToFact(makeRow({ origin: "Phoenix, AZ", dest: "Dallas, TX", equipment: "V", status: "POD" }), ctxBase);
  await check("default classification of POD is moved=true", () => assert.equal(r2?.moved, true));
}

console.log("\n── Threshold: 5 moves → NOT eligible, 6 moves → eligible ──");
{
  const { orgId, userId } = await setupOrg();
  try {
    const uploadId = await createUpload(orgId, userId);
    const lane = { origin: "Phoenix, AZ", dest: "Dallas, TX", equipment: "V" };
    const fiveRows = Array.from({ length: 5 }, (_, i) => makeRow({ ...lane, orderId: `o-${i}` }));
    await ingestUploadIntoFact({ orgId, uploadId, txnRows: fiveRows });
    let { lanes } = await summarizeEligibleLanesFromFact(orgId);
    await check("5 moved loads → 0 eligible lanes", () => assert.equal(lanes.length, 0));

    // add one more so threshold hits exactly 6
    await ingestUploadIntoFact({ orgId, uploadId, txnRows: [makeRow({ ...lane, orderId: "o-5" })] });
    ({ lanes } = await summarizeEligibleLanesFromFact(orgId));
    await check("6 moved loads → 1 eligible lane", () => assert.equal(lanes.length, 1));
    await check("eligible lane reports movesLast30Days=6", () => assert.equal(lanes[0].movesLast30Days, 6));
    await check("eligible lane has qualificationReason text", () =>
      assert.match(lanes[0].qualificationReason, /6 moved loads in last 30 days/));
    await check("supportingCustomers is populated", () => assert.equal(lanes[0].supportingCustomers[0]?.name, "Acme Foods"));
  } finally {
    await cleanupOrg(orgId);
  }
}

console.log("\n── AVL inflation guard: AVL rows do not count toward threshold ──");
{
  const { orgId, userId } = await setupOrg();
  try {
    const uploadId = await createUpload(orgId, userId);
    const lane = { origin: "Phoenix, AZ", dest: "Dallas, TX", equipment: "V" };
    const txn = Array.from({ length: 5 }, (_, i) => makeRow({ ...lane, orderId: `t-${i}` }));
    const avl = Array.from({ length: 10 }, (_, i) =>
      makeRow({ ...lane, orderId: `a-${i}`, status: "POD" }));
    await ingestUploadIntoFact({ orgId, uploadId, txnRows: txn, avlRows: avl });
    const { lanes } = await summarizeEligibleLanesFromFact(orgId);
    await check("5 moved txn + 10 forced-not-moved AVL → still 0 eligible", () => assert.equal(lanes.length, 0));
  } finally {
    await cleanupOrg(orgId);
  }
}

console.log("\n── Grace-period retraction (7 days) ──");
{
  const { orgId, userId } = await setupOrg();
  try {
    // First run: lane qualifies, gets persisted with lastEligibleAt = now.
    const uploadId = await createUpload(orgId, userId);
    const lane = { origin: "Phoenix, AZ", dest: "Dallas, TX", equipment: "V" };
    const sixRows = Array.from({ length: 6 }, (_, i) => makeRow({ ...lane, orderId: `g-${i}` }));
    await ingestUploadIntoFact({ orgId, uploadId, txnRows: sixRows });
    const r1 = await runRecurringLaneEngineForOrg(orgId, storage);
    await check("first engine run upserts the lane as eligible", () => assert.equal(r1.upserted, 1));
    let lanesPersisted = await db.select().from(recurringLanes).where(sql`${recurringLanes.orgId} = ${orgId}`);
    await check("DB reflects 1 eligible lane after first run", () => assert.equal(lanesPersisted.filter(l => l.isEligible).length, 1));

    // Drop the fact rows entirely to simulate "today's upload contains no
    // moves on this lane". lastEligibleAt is still fresh, so the 7-day
    // grace MUST keep the lane visible. (We can't just age the rows —
    // the rolling window is anchored to the latest moved ship_date in the
    // fact table, so uniform backdating keeps them in window.)
    await db.execute(sql`DELETE FROM freight_daily_upload_fact WHERE org_id = ${orgId}`);

    const r2 = await runRecurringLaneEngineForOrg(orgId, storage);
    await check("second run after window aged out → 0 upserts (no organic qualification)", () =>
      assert.equal(r2.upserted, 0));
    lanesPersisted = await db.select().from(recurringLanes).where(sql`${recurringLanes.orgId} = ${orgId}`);
    await check("lane STAYS eligible because lastEligibleAt is fresh (within grace)", () =>
      assert.equal(lanesPersisted.filter(l => l.isEligible).length, 1));

    // Now expire the grace window itself.
    const longAgo = new Date(Date.now() - (LWQ_GRACE_DAYS + 2) * 86400_000).toISOString();
    await db.execute(sql`UPDATE recurring_lanes SET last_eligible_at = ${longAgo} WHERE org_id = ${orgId}`);
    await runRecurringLaneEngineForOrg(orgId, storage);
    lanesPersisted = await db.select().from(recurringLanes).where(sql`${recurringLanes.orgId} = ${orgId}`);
    await check("after grace expires AND no organic qualification, lane is retracted", () =>
      assert.equal(lanesPersisted.filter(l => l.isEligible).length, 0));
  } finally {
    await cleanupOrg(orgId);
  }
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
