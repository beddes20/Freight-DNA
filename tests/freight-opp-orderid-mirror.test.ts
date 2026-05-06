/**
 * Task #576 — Available Loads Planning Board polish.
 *
 * Verifies that `freightOpportunityToInsert` (load_fact mirror builder)
 * prefers the real TMS Order # captured by the importer on
 * `freight_opportunity.sourceRef.orderId` and falls back to the synthetic
 * `freight_opp:<uuid>` key only when sourceRef.orderId is missing.
 *
 * Run with: npx tsx tests/freight-opp-orderid-mirror.test.ts
 */

import { freightOpportunityToInsert } from "../server/loadFactBackfill";
import type { FreightOpportunity } from "../shared/schema";

let passed = 0;
let failed = 0;

function assertEqual(description: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}\n    expected: "${expected}"\n    got:      "${actual}"`);
    failed++;
  }
}

// Minimal FreightOpportunity stub. We only set fields referenced by
// `freightOpportunityToInsert`; the rest are `null` / sentinel values to
// keep the test focused.
function makeOpp(overrides: Partial<FreightOpportunity> = {}): FreightOpportunity {
  const base: FreightOpportunity = {
    id: "11111111-2222-3333-4444-555555555555",
    orgId: "org-1",
    companyId: null,
    origin: "Macon",
    originState: "GA",
    destination: "Marietta",
    destinationState: "PA",
    equipmentType: "DRY_VAN",
    pickupWindowStart: "2026-04-25",
    pickupWindowEnd: "2026-04-25",
    loadCount: 1,
    notes: null,
    status: "ready_to_send",
    urgencyScore: 60,
    createdById: null,
    ownerUserId: null,
    sourceFileName: null,
    sourceRef: null,
    coveredAt: null,
    coveredById: null,
    coverageCarrierId: null,
    coverageCarrierName: null,
    coverageRevenue: null,
    coverageCost: null,
    coverageMarginPct: null,
    coverageNotes: null,
    closedAt: null,
    closedReason: null,
    approvedAt: null,
    approvedById: null,
    customerSlaDeadline: null,
    finalSlaDeadline: null,
    slaEscalatedAt: null,
    slaEscalationLevel: 0,
    slaSnoozedUntil: null,
    slaSnoozeReason: null,
    autoCanceledAt: null,
    requiredPickupCity: null,
    requiredPickupState: null,
    requiredPickupCountry: null,
    requiredDropCity: null,
    requiredDropState: null,
    requiredDropCountry: null,
    generatedAt: new Date(),
    sentAt: null,
    updatedAt: new Date(),
    // Cast to bypass exactly-matching every optional field added to the
    // schema since this test was written; we only care about the orderId
    // recovery path.
  } as unknown as FreightOpportunity;
  return { ...base, ...overrides } as FreightOpportunity;
}

console.log("\n── freightOpportunityToInsert: orderId source-ref preference ────────\n");

// 1) Real Order # present on sourceRef → mirror uses real Order #.
{
  const opp = makeOpp({
    sourceRef: {
      kind: "available_freight_import",
      stableKey: "abc123",
      orderId: "VT-1027389",
      fileName: "available-freight.xlsx",
      importedAt: "2026-04-24T17:00:00.000Z",
    } as FreightOpportunity["sourceRef"],
  });
  const insert = freightOpportunityToInsert(opp, "Acme Logistics");
  assertEqual(
    "real Order # on sourceRef.orderId is used as load_fact.orderId",
    insert.orderId,
    "VT-1027389",
  );
}

// 2) sourceRef present but orderId missing (legacy importer run) → fall back
//    to synthetic `freight_opp:<uuid>` key.
{
  const opp = makeOpp({
    sourceRef: {
      kind: "available_freight_import",
      stableKey: "abc123",
      fileName: "available-freight.xlsx",
      importedAt: "2026-04-24T17:00:00.000Z",
    } as FreightOpportunity["sourceRef"],
  });
  const insert = freightOpportunityToInsert(opp, "Acme Logistics");
  assertEqual(
    "missing sourceRef.orderId → synthetic freight_opp:<uuid> fallback",
    insert.orderId,
    `freight_opp:${opp.id}`,
  );
}

// 3) sourceRef.orderId present but is itself a synthetic key (defensive
//    guard against a re-import accidentally rewriting the real Order #
//    with the synthetic prefix). Must still fall back to synthetic so we
//    never persist nonsense like `freight_opp:freight_opp:<uuid>`.
{
  const opp = makeOpp({
    sourceRef: {
      kind: "available_freight_import",
      stableKey: "abc123",
      orderId: `freight_opp:${"11111111-2222-3333-4444-555555555555"}`,
      fileName: "available-freight.xlsx",
      importedAt: "2026-04-24T17:00:00.000Z",
    } as FreightOpportunity["sourceRef"],
  });
  const insert = freightOpportunityToInsert(opp, "Acme Logistics");
  assertEqual(
    "synthetic sourceRef.orderId is rejected → fallback path",
    insert.orderId,
    `freight_opp:${opp.id}`,
  );
}

// 4) sourceRef.orderId is whitespace → treated as missing.
{
  const opp = makeOpp({
    sourceRef: {
      kind: "available_freight_import",
      stableKey: "abc123",
      orderId: "   ",
      fileName: "available-freight.xlsx",
      importedAt: "2026-04-24T17:00:00.000Z",
    } as FreightOpportunity["sourceRef"],
  });
  const insert = freightOpportunityToInsert(opp, "Acme Logistics");
  assertEqual(
    "whitespace-only sourceRef.orderId → fallback path",
    insert.orderId,
    `freight_opp:${opp.id}`,
  );
}

// 5) sourceRef is null → fallback path. Covers the historical case where
//    an opp predates the importer storing sourceRef at all.
{
  const opp = makeOpp({ sourceRef: null });
  const insert = freightOpportunityToInsert(opp, "Acme Logistics");
  assertEqual(
    "null sourceRef → synthetic freight_opp:<uuid> fallback",
    insert.orderId,
    `freight_opp:${opp.id}`,
  );
}

// 6) Regression — importer update flow.
//    Simulates the in-memory pattern from server/availableFreightImporter.ts:
//    we have a legacy `existingOpp` with sourceRef.orderId == null, and we
//    apply a `patch` that writes the real Order #. The mirror MUST be built
//    from the merged (or updated) view, not from `existingOpp` alone —
//    otherwise the load_fact row keeps the synthetic prefix indefinitely
//    even though the freight_opportunity row was correctly updated.
{
  const existingOpp = makeOpp({
    sourceRef: {
      kind: "available_freight_import",
      stableKey: "abc123",
      fileName: "available-freight.xlsx",
      importedAt: "2026-04-23T17:00:00.000Z",
    } as FreightOpportunity["sourceRef"],
  });
  const patchedSourceRef: FreightOpportunity["sourceRef"] = {
    kind: "available_freight_import",
    stableKey: "abc123",
    orderId: "VT-1027389",
    fileName: "available-freight.xlsx",
    importedAt: "2026-04-24T17:00:00.000Z",
  } as FreightOpportunity["sourceRef"];

  // Bug repro: mirroring the *old* in-memory object keeps the synthetic key.
  const insertFromExisting = freightOpportunityToInsert(existingOpp, "Acme");
  assertEqual(
    "(repro) mirror from stale existingOpp keeps synthetic freight_opp:<uuid>",
    insertFromExisting.orderId,
    `freight_opp:${existingOpp.id}`,
  );

  // Fix: mirroring the merged (existingOpp + patch) view picks up the real ID.
  const merged = { ...existingOpp, sourceRef: patchedSourceRef };
  const insertFromMerged = freightOpportunityToInsert(merged, "Acme");
  assertEqual(
    "mirror from merged {...existingOpp, ...patch} uses real Order #",
    insertFromMerged.orderId,
    "VT-1027389",
  );
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  process.exit(1);
}
