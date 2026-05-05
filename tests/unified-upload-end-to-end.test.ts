/**
 * Task #1051 — End-to-end proof that ONE ReplitDailyUpload drives all three
 * unified surfaces (Financials, Available Freight visibility, LWQ) from the
 * SAME canonical row set, tied to the SAME uploadId.
 *
 * Reviewer requirement: "Add integration tests proving one upload drives
 * Financials + AF + LWQ from the same upload/fact rows and shared freshness
 * uploadId."
 *
 * Strategy:
 *   1. Insert a Financials upload row directly (mimics what
 *      `storage.createFinancialUpload` does in the real handler).
 *   2. Run the canonical `ingestUploadIntoFact` writer with both txn rows
 *      and AVL rows from the synthetic workbook.
 *   3. Assert that:
 *        a. Financials sees the upload (financial_uploads).
 *        b. The fact table has rows for that exact uploadId.
 *        c. AVL rows are present in the fact table but moved=false.
 *        d. The LWQ engine, run against the same orgId, surfaces the
 *           same lane (≥6 moved loads on Phoenix→Dallas Van).
 *        e. The unified-upload "latest" query (the same SQL the
 *           /api/unified-upload/latest endpoint runs) returns the same
 *           uploadId.
 *      This proves all three surfaces share the same source of truth.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, storage } from "../server/storage";
import {
  organizations, users, financialUploads, recurringLanes, freightDailyUploadFact,
} from "../shared/schema";
import { ingestUploadIntoFact } from "../server/services/freightDailyUploadFact";
import { runRecurringLaneEngineForOrg } from "../server/recurringLaneCapacityEngine";
import type { InsertFinancialUpload } from "../shared/schema";

let passed = 0; let failed = 0;
const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err: any) { console.error(`  ✗ ${label}\n      ${err.message}`); failed++; failures.push(label); }
}

function txnRow(orderId: string, customer = "Acme Foods") {
  const date = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  return {
    "Order": orderId, "Customer": customer,
    "Origin": "Phoenix", "Origin state": "AZ",
    "Destination": "Dallas", "Destination state": "TX",
    "Trailer type": "V", "Carrier": "9000 - End2End Carrier",
    "Brokerage Status": "POD", "Pickup Date": date, "Delivery date": date,
    "Total Revenue": 2500, "Carrier Total": 2000, "Loaded Miles": 500,
  };
}
function avlRow(orderId: string) {
  const date = new Date().toISOString().slice(0, 10);
  return {
    "Order": orderId, "Customer": "Acme Foods",
    "Origin": "Phoenix", "Origin state": "AZ",
    "Destination": "Dallas", "Destination state": "TX",
    "Trailer type": "V", "Brokerage Status": "AVL",
    "Pickup Date": date, "Delivery date": date,
  };
}

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  Task #1051 — End-to-end Unified ReplitDailyUpload Test");
console.log("══════════════════════════════════════════════════════════════\n");

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const [org] = await db.insert(organizations).values({
  name: `e2e-org-${stamp}`,
  slug: `e2e-org-${stamp}`,
}).returning();
const [user] = await db.insert(users).values({
  organizationId: org.id, username: `e2e-${stamp}`,
  email: `e2e-${stamp}@x.test`, password: "x", role: "admin", name: "E2E",
}).returning();

try {
  console.log("── Step 1: Single upload writes to financial_uploads + fact ──");
  const txnRows = Array.from({ length: 6 }, (_, i) => txnRow(`e2e-txn-${i}`));
  const avlRows = Array.from({ length: 4 }, (_, i) => avlRow(`e2e-avl-${i}`));

  const insertPayload: InsertFinancialUpload = {
    fileName: `e2e-${stamp}.xlsx`,
    uploadedAt: new Date().toISOString(),
    uploadedBy: user.id,
    rowCount: txnRows.length,
    rows: txnRows,
  };
  const created = await storage.createFinancialUpload(insertPayload);
  const uploadId = created.id;

  await ingestUploadIntoFact({ orgId: org.id, uploadId, txnRows, avlRows });

  await check("Financials sees the upload row", async () => {
    const found = await db.select().from(financialUploads).where(sql`${financialUploads.id} = ${uploadId}`);
    assert.equal(found.length, 1);
    assert.equal(found[0].fileName, `e2e-${stamp}.xlsx`);
  });

  await check("Fact table has rows tied to the SAME uploadId", async () => {
    const rows = await db.select().from(freightDailyUploadFact)
      .where(sql`${freightDailyUploadFact.uploadId} = ${uploadId}`);
    assert.equal(rows.length, txnRows.length + avlRows.length);
  });

  await check("AVL rows are persisted with moved=false (no inflation)", async () => {
    const movedFalseCount = await db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM freight_daily_upload_fact
       WHERE upload_id = ${uploadId} AND moved = false
    `);
    const c = Number(movedFalseCount.rows[0]?.c);
    assert.equal(c, avlRows.length);
  });

  console.log("\n── Step 2: LWQ engine sees the same canonical rows ──");
  const engineResult = await runRecurringLaneEngineForOrg(org.id, storage);
  await check("LWQ engine upserts ≥1 lane from the same upload", () => {
    assert.ok(engineResult.upserted >= 1, `expected upserted >= 1, got ${engineResult.upserted}`);
  });
  await check("Persisted recurring_lane row carries qualificationReason", async () => {
    const lanes = await db.select().from(recurringLanes)
      .where(sql`${recurringLanes.orgId} = ${org.id} AND ${recurringLanes.isEligible} = true`);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].movesLast30Days, 6);
    assert.match(lanes[0].qualificationReason ?? "", /6 moved loads in last 30 days/);
  });

  console.log("\n── Step 3: /api/unified-upload/latest returns the SAME uploadId ──");
  await check("Unified freshness query points at the same uploadId", async () => {
    const result = await db.execute<{ upload_id: string }>(sql`
      SELECT fu.id AS upload_id
        FROM financial_uploads fu
        JOIN users u ON u.id = fu.uploaded_by
       WHERE u.organization_id = ${org.id}
       ORDER BY fu.uploaded_at DESC
       LIMIT 1
    `);
    assert.equal(result.rows[0]?.upload_id, uploadId);
  });
  await check("Same uploadId is reachable via fact table (single source of truth)", async () => {
    const result = await db.execute<{ upload_id: string }>(sql`
      SELECT DISTINCT upload_id FROM freight_daily_upload_fact WHERE org_id = ${org.id}
    `);
    const uploadIds = result.rows.map(r => r.upload_id);
    assert.deepEqual(uploadIds, [uploadId]);
  });

  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
} finally {
  await db.execute(sql`DELETE FROM freight_daily_upload_fact WHERE org_id = ${org.id}`).catch(() => {});
  await db.execute(sql`DELETE FROM recurring_lanes WHERE org_id = ${org.id}`).catch(() => {});
  await db.execute(sql`DELETE FROM financial_uploads WHERE uploaded_by = ${user.id}`).catch(() => {});
  await db.execute(sql`DELETE FROM users WHERE id = ${user.id}`).catch(() => {});
  await db.execute(sql`DELETE FROM organizations WHERE id = ${org.id}`).catch(() => {});
}

if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
