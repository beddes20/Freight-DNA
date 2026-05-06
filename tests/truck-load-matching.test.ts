/**
 * Truck-Load Matching scoring tests (Task #844)
 *
 * Pure scoring logic — no DB, no HTTP. Verifies fitScore tiers across
 * lane / date / equipment dimensions. Run with:
 *   npx tsx tests/truck-load-matching.test.ts
 */

import { scoreFit } from "../server/truckLoadMatchingService";
import type { TruckPosting, FreightOpportunity } from "@shared/schema";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function makePosting(overrides: Partial<TruckPosting> = {}): TruckPosting {
  return {
    id: "posting-1",
    orgId: "org-1",
    carrierId: null,
    carrierNameRaw: "ACME Trucking",
    source: "email_body",
    emailMessageId: null,
    attachmentName: null,
    rowIndex: null,
    originCity: "Phoenix",
    originState: "AZ",
    destCity: "Dallas",
    destState: "TX",
    destPreference: null,
    availableDate: "2026-05-12",
    availableThrough: null,
    equipment: "Reefer",
    rateAsk: null,
    notes: null,
    rawText: null,
    status: "active",
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TruckPosting;
}

function makeOpp(overrides: Partial<FreightOpportunity> = {}): FreightOpportunity {
  return {
    id: "opp-1",
    orgId: "org-1",
    origin: "Phoenix",
    originState: "AZ",
    destination: "Dallas",
    destinationState: "TX",
    equipmentType: "Reefer",
    pickupWindowStart: "2026-05-12T08:00:00Z",
    pickupWindowEnd: null,
    quotedRate: null,
    targetBuyRate: null,
    status: "open",
    ownerUserId: "user-rep",
    delegatedToUserId: null,
    createdById: "user-rep",
    ...overrides,
  } as unknown as FreightOpportunity;
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Truck-Load Matching — Unit Tests (Task #844)");
console.log("══════════════════════════════════════════════════════════════");

// ── Perfect match ─────────────────────────────────────────────────────────
console.log("── 1. Perfect match (lane + date + equipment) ──");
{
  const posting = makePosting();
  const opp = makeOpp();
  const result = scoreFit(posting, opp);
  ok(result.score >= 75, `score ${result.score} >= 75 (STRONG)`);
  ok(result.reasons.some(r => r.toLowerCase().includes("origin")), "explains origin");
  ok(result.reasons.some(r => r.toLowerCase().includes("dest")), "explains destination");
  ok(result.reasons.some(r => r.toLowerCase().includes("equip") || r.toLowerCase().includes("reefer")), "explains equipment");
}

// ── Equipment mismatch lowers score (different family = 0 pts vs 15) ─────
console.log("── 2. Equipment mismatch reduces by equipment weight ──");
{
  const posting = makePosting({ equipment: "Van" });
  const opp = makeOpp({ equipmentType: "Reefer" });
  const baseline = scoreFit(makePosting(), makeOpp()); // perfect match
  const result = scoreFit(posting, opp);
  ok(result.score < baseline.score, `mismatch score ${result.score} < baseline ${baseline.score}`);
  ok(!result.reasons.some(r => /equip/i.test(r)), "no equipment-match reason");
}

// ── Date 12 days out — falls outside 7-day decay band ────────────────────
console.log("── 3. Date 12 days away gives 0 date points ──");
{
  const posting = makePosting({ availableDate: "2026-05-24" });
  const opp = makeOpp(); // pickup 5/12
  const result = scoreFit(posting, opp);
  ok(!result.reasons.some(r => /day|window/i.test(r)), "no date-credit reason");
}

// ── Date in the past — produces a date-decay tier with no in-window credit
console.log("── 4. Date 17 days in the past — no in-window credit ──");
{
  const posting = makePosting({ availableDate: "2026-04-25" });
  const opp = makeOpp({ pickupWindowStart: "2026-05-12T08:00:00Z" });
  const result = scoreFit(posting, opp);
  ok(
    !result.reasons.some(r => /inside available window/i.test(r)),
    "not credited as in-window",
  );
}

// ── Origin state matches but city different (within state) ───────────────
console.log("── 5. Same state, different city still partial credit ──");
{
  const posting = makePosting({ originCity: "Tucson", originState: "AZ" });
  const opp = makeOpp({ origin: "Phoenix", originState: "AZ" });
  const result = scoreFit(posting, opp);
  ok(result.score > 0, "non-zero");
  ok(result.reasons.length > 0, "has reasons");
}

// ── Destination preference (state-only) match ─────────────────────────────
console.log("── 6. Destination state-only preference matches ──");
{
  const posting = makePosting({ destCity: null, destState: "TX", destPreference: "Texas" });
  const opp = makeOpp({ destination: "Dallas", destinationState: "TX" });
  const result = scoreFit(posting, opp);
  ok(result.score >= 35, `score ${result.score} >= MIN threshold`);
}

// ── Equipment family cross-fit (Dry Van ↔ Van) ────────────────────────────
console.log("── 7. Equipment family cross-fit (Dry Van ↔ Van) ──");
{
  const posting = makePosting({ equipment: "Dry Van" });
  const opp = makeOpp({ equipmentType: "Van" });
  const result = scoreFit(posting, opp);
  ok(
    result.reasons.some(r => /equip|van/i.test(r)),
    "dry van and van treated as same family",
  );
}

// ── No origin info on either side ─────────────────────────────────────────
console.log("── 8. Missing origin disqualifies or scores low ──");
{
  const posting = makePosting({ originCity: null, originState: null });
  const opp = makeOpp();
  const result = scoreFit(posting, opp);
  ok(result.score < 75, `score ${result.score} below STRONG when origin unknown`);
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");
if (failed > 0) process.exit(1);
