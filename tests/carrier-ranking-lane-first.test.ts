/**
 * Lane-First Rebalance — Pure Unit Tests (May 2026)
 *
 * Pins the contract that lane fit (history + geography + equipment + recency)
 * is the PRIMARY signal in carrier ranking and customer history is a
 * secondary booster only. See `replit.md` → "Carrier Ranking Lane-First
 * Rebalance" for the spec; the production helpers under test live in:
 *   - server/carrierRankingService.ts        (LWQ / Available Freight ranker)
 *   - server/carrierRecommendationEngine.ts  (Available Loads engine)
 *
 * These tests are pure — no DB, no HTTP, no network — so they can run in CI
 * without a server boot.
 *
 * Run with: npx tsx tests/carrier-ranking-lane-first.test.ts
 */

import {
  classifyCustomerOnlyFallback,
  CUSTOMER_ONLY_FALLBACK_REASON,
  MIN_LANE_FIT_FOR_TOP_RANK,
} from "../server/carrierRankingService";
import {
  blendFitAndPerformance,
  rankCandidates,
  REC_MIN_LANE_FIT_FOR_TOP_RANK,
  type RankerInput,
} from "../server/carrierRecommendationEngine";

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

// ── 1. Lane-first floors are the same canonical value ────────────────────────
console.log("\n── 1. Min lane-fit floors are aligned across both engines ─────────\n");
assert(
  "MIN_LANE_FIT_FOR_TOP_RANK is 50 in carrierRankingService",
  MIN_LANE_FIT_FOR_TOP_RANK === 50,
  `Got ${MIN_LANE_FIT_FOR_TOP_RANK}`,
);
assert(
  "REC_MIN_LANE_FIT_FOR_TOP_RANK is 50 in carrierRecommendationEngine",
  REC_MIN_LANE_FIT_FOR_TOP_RANK === 50,
  `Got ${REC_MIN_LANE_FIT_FOR_TOP_RANK}`,
);
assert(
  "CUSTOMER_ONLY_FALLBACK_REASON matches the spec verbatim",
  CUSTOMER_ONLY_FALLBACK_REASON === "Customer history only on other lanes (weak lane fit)",
  `Got "${CUSTOMER_ONLY_FALLBACK_REASON}"`,
);

// ── 2. classifyCustomerOnlyFallback semantics ────────────────────────────────
console.log("\n── 2. classifyCustomerOnlyFallback flags only weak-fit + customer-only ─\n");

assert(
  "Returns false when carrier has zero customer history (regardless of fit)",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 0, historyMatch: "none", customerHistoryLoads: 0 }),
);

assert(
  "Returns false for a strong exact-lane carrier with customer history (real lane evidence wins)",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 85, historyMatch: "exact", customerHistoryLoads: 10 }),
);

assert(
  "Returns false for a weak-baseline carrier whose historyMatch is 'exact' (lane evidence trumps weak baseline)",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 30, historyMatch: "exact", customerHistoryLoads: 5 }),
);

assert(
  "Returns false for a 'nearby' carrier even when baseline is weak",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 30, historyMatch: "nearby", customerHistoryLoads: 5 }),
);

assert(
  "Returns false for a 'state_pair' carrier even when baseline is weak",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 35, historyMatch: "state_pair", customerHistoryLoads: 5 }),
);

assert(
  "Returns true for a 'region'-only carrier with customer history when baseline < floor",
  classifyCustomerOnlyFallback({ laneFitBaseline: 40, historyMatch: "region", customerHistoryLoads: 5 }),
);

assert(
  "Returns true for a 'none' carrier with customer history when baseline < floor",
  classifyCustomerOnlyFallback({ laneFitBaseline: 20, historyMatch: "none", customerHistoryLoads: 8 }),
);

assert(
  "Returns false for a 'region' carrier with customer history when baseline ≥ floor",
  !classifyCustomerOnlyFallback({ laneFitBaseline: 50, historyMatch: "region", customerHistoryLoads: 5 }),
);

assert(
  "Honors a custom (lower) threshold when supplied",
  !classifyCustomerOnlyFallback({
    laneFitBaseline: 35,
    historyMatch: "region",
    customerHistoryLoads: 5,
    threshold: 30,
  }),
);

assert(
  "Honors a custom (higher) threshold when supplied",
  classifyCustomerOnlyFallback({
    laneFitBaseline: 55,
    historyMatch: "region",
    customerHistoryLoads: 5,
    threshold: 70,
  }),
);

// Bench wins are lane evidence — a carrier who replied "yes" to outreach on
// THIS lane has proven capacity here, regardless of historyMatch tier.
assert(
  "Returns false when carrier has bench wins, even with weak baseline + customer history on other lanes",
  !classifyCustomerOnlyFallback({
    laneFitBaseline: 25,
    historyMatch: "region",
    customerHistoryLoads: 5,
    benchWins: 2,
  }),
);
assert(
  "Returns true again when benchWins=0 and other conditions match",
  classifyCustomerOnlyFallback({
    laneFitBaseline: 25,
    historyMatch: "region",
    customerHistoryLoads: 5,
    benchWins: 0,
  }),
);

// ── 3. blendFitAndPerformance — lane fit carries ≥65% of score ───────────────
console.log("\n── 3. blendFitAndPerformance puts ≥65% weight on lane fit ─────────\n");

// At loads ≥3 (mature carrier), the blend is 0.65·fit + 0.35·perf.
// Sanity-check the weights by feeding (fit=100, perf=0) and (fit=0, perf=100).
assert(
  "At loads≥3, fit-only carrier scores 65 (=0.65*100)",
  blendFitAndPerformance(100, 0, 5) === 65,
  `Got ${blendFitAndPerformance(100, 0, 5)}`,
);
assert(
  "At loads≥3, perf-only carrier scores 35 (=0.35*100) — perf alone is secondary",
  blendFitAndPerformance(0, 100, 5) === 35,
  `Got ${blendFitAndPerformance(0, 100, 5)}`,
);
assert(
  "At loads<3, fit weight is 80% — fit-only carrier scores 80",
  blendFitAndPerformance(100, 0, 1) === 80,
  `Got ${blendFitAndPerformance(100, 0, 1)}`,
);
assert(
  "At loads<3, perf-only carrier scores 20 — perf alone is heavily downweighted",
  blendFitAndPerformance(0, 100, 1) === 20,
  `Got ${blendFitAndPerformance(0, 100, 1)}`,
);

// Direct head-to-head: a strong-fit / weak-perf carrier MUST beat a
// weak-fit / strong-perf carrier at any loads count. This is the primary
// invariant the rebalance is meant to preserve.
const strongFitWeakPerfMature = blendFitAndPerformance(85, 30, 10); // exact-lane history, average exec
const weakFitStrongPerfMature = blendFitAndPerformance(20, 95, 10); // customer-only, top performer overall
assert(
  "strong-fit / weak-perf (loads≥3) outranks weak-fit / strong-perf (loads≥3) on the blend",
  strongFitWeakPerfMature > weakFitStrongPerfMature,
  `strong=${strongFitWeakPerfMature}, weak=${weakFitStrongPerfMature}`,
);

const strongFitNoPerfNew = blendFitAndPerformance(85, 0, 0);
const weakFitTopPerfNew = blendFitAndPerformance(20, 100, 0);
assert(
  "strong-fit / no-perf (new) outranks weak-fit / top-perf (new)",
  strongFitNoPerfNew > weakFitTopPerfNew,
  `strong=${strongFitNoPerfNew}, weak=${weakFitTopPerfNew}`,
);

// ── 4. rankCandidates — strong lane fit always outranks weak-fit + perf ──────
console.log("\n── 4. rankCandidates puts strong lane fit above weak-fit fallbacks ─\n");

const carriersStrongVsWeak: RankerInput[] = [
  // Carrier A — strong exact-lane history, mediocre overall scorecard
  { carrierName: "Carrier A (strong lane)", fitScore: 85, evidenceTier: "exact", performanceScore: 30, loads: 10, isDoNotUse: false },
  // Carrier B — no lane history, top scorecard performer in the org
  { carrierName: "Carrier B (customer-only weak fit)", fitScore: 20, evidenceTier: "region", performanceScore: 95, loads: 10, isDoNotUse: false },
];
const ranked1 = rankCandidates(carriersStrongVsWeak, 5);
assert(
  "Strong-lane-fit carrier ranks #1, weak-fit carrier ranks #2",
  ranked1[0]?.carrierName === "Carrier A (strong lane)" && ranked1[1]?.carrierName === "Carrier B (customer-only weak fit)",
  `Order: ${ranked1.map(c => c.carrierName).join(" → ")}`,
);

// ── 5. rankCandidates — weak-fit carriers are demoted, never displace primary
console.log("\n── 5. rankCandidates fills primary slots before any fallback ──────\n");

const fiveStrongPlusOneWeak: RankerInput[] = [
  { carrierName: "Strong-1", fitScore: 90, evidenceTier: "exact", performanceScore: 70, loads: 8, isDoNotUse: false },
  { carrierName: "Strong-2", fitScore: 80, evidenceTier: "exact", performanceScore: 60, loads: 6, isDoNotUse: false },
  { carrierName: "Strong-3", fitScore: 75, evidenceTier: "nearby", performanceScore: 55, loads: 4, isDoNotUse: false },
  { carrierName: "Strong-4", fitScore: 70, evidenceTier: "nearby", performanceScore: 50, loads: 4, isDoNotUse: false },
  { carrierName: "Strong-5", fitScore: 65, evidenceTier: "region", performanceScore: 45, loads: 3, isDoNotUse: false },
  // Weak fit + maxed scorecard — would WIN on raw blend math (fit=15 + perf=100 → 45 vs Strong-5 fit=65 + perf=45 → 58... actually Strong-5 wins anyway, but make Weak even more attractive)
  { carrierName: "Weak-fallback", fitScore: 30, evidenceTier: "region", performanceScore: 100, loads: 10, isDoNotUse: false },
];
const ranked2 = rankCandidates(fiveStrongPlusOneWeak, 5);
assert(
  "Top-5 contains all five primary carriers, weak-fit fallback is excluded",
  ranked2.length === 5 &&
    ranked2.every(c => !c.carrierName.startsWith("Weak")),
  `Top-5: ${ranked2.map(c => c.carrierName).join(", ")}`,
);

// ── 6. rankCandidates — fallback fills remaining slot when primary is thin ───
console.log("\n── 6. Fallback fills remaining slots only when primary is thin ────\n");

const onePrimaryPlusFallbacks: RankerInput[] = [
  { carrierName: "Only-Primary", fitScore: 80, evidenceTier: "exact", performanceScore: 50, loads: 5, isDoNotUse: false },
  { carrierName: "Fallback-1", fitScore: 30, evidenceTier: "region", performanceScore: 90, loads: 5, isDoNotUse: false },
  { carrierName: "Fallback-2", fitScore: 25, evidenceTier: "region", performanceScore: 85, loads: 5, isDoNotUse: false },
];
const ranked3 = rankCandidates(onePrimaryPlusFallbacks, 5);
assert(
  "Primary carrier sorts to position #1",
  ranked3[0]?.carrierName === "Only-Primary",
  `Got ${ranked3[0]?.carrierName}`,
);
assert(
  "Fallbacks fill remaining slots (primary count < limit)",
  ranked3.length === 3 &&
    ranked3[1]?.carrierName.startsWith("Fallback") &&
    ranked3[2]?.carrierName.startsWith("Fallback"),
  `Order: ${ranked3.map(c => c.carrierName).join(" → ")}`,
);
assert(
  "Within fallback bucket, higher blend wins",
  ranked3[1]?.carrierName === "Fallback-1",
  `Order: ${ranked3.map(c => c.carrierName).join(" → ")}`,
);

// ── 7. rankCandidates — do_not_use exclusions still respected ────────────────
console.log("\n── 7. do_not_use exclusion still respected on the lane-first path ─\n");

const withDnu: RankerInput[] = [
  { carrierName: "Strong-A", fitScore: 80, evidenceTier: "exact", performanceScore: 70, loads: 5, isDoNotUse: false },
  { carrierName: "DNU-strong-fit", fitScore: 95, evidenceTier: "exact", performanceScore: 90, loads: 10, isDoNotUse: true },
];
const ranked4 = rankCandidates(withDnu, 5);
assert(
  "do_not_use carrier is excluded even with perfect fit + perf",
  ranked4.length === 1 && ranked4[0]?.carrierName === "Strong-A",
  `Got ${ranked4.map(c => c.carrierName).join(", ")}`,
);

// ── 8. rankCandidates — cold strangers (none-fit + zero perf) excluded ───────
console.log("\n── 8. Cold strangers (no fit + no perf) still excluded ─────────────\n");

const withColdStranger: RankerInput[] = [
  { carrierName: "Real-Carrier", fitScore: 70, evidenceTier: "exact", performanceScore: 50, loads: 5, isDoNotUse: false },
  { carrierName: "Cold-Stranger", fitScore: 0, evidenceTier: "none", performanceScore: 0, loads: 0, isDoNotUse: false },
];
const ranked5 = rankCandidates(withColdStranger, 5);
assert(
  "Cold stranger excluded; only the real carrier is returned",
  ranked5.length === 1 && ranked5[0]?.carrierName === "Real-Carrier",
  `Got ${ranked5.map(c => c.carrierName).join(", ")}`,
);

// ── 9. Configurable threshold via 3rd parameter ──────────────────────────────
console.log("\n── 9. rankCandidates accepts a configurable threshold ──────────────\n");

const borderlineCarriers: RankerInput[] = [
  { carrierName: "Borderline-45", fitScore: 45, evidenceTier: "region", performanceScore: 60, loads: 3, isDoNotUse: false },
  { carrierName: "Solid-60", fitScore: 60, evidenceTier: "nearby", performanceScore: 50, loads: 3, isDoNotUse: false },
];
const rankedDefault = rankCandidates(borderlineCarriers, 5); // threshold 50 → Borderline is fallback
const rankedLower = rankCandidates(borderlineCarriers, 5, 40); // threshold 40 → both primary
assert(
  "Default threshold (50): Borderline-45 is treated as fallback (sorts below Solid-60)",
  rankedDefault[0]?.carrierName === "Solid-60" && rankedDefault[1]?.carrierName === "Borderline-45",
);
// With threshold=40 both are primary, sorted by blended total.
// Borderline-45: 0.65*45+0.35*60 = 29.25+21 = 50.25 → 50
// Solid-60:     0.65*60+0.35*50 = 39+17.5 = 56.5 → 57
assert(
  "Lower threshold (40): Solid-60 still wins on raw blend even though both are primary",
  rankedLower[0]?.carrierName === "Solid-60",
  `Order: ${rankedLower.map(c => c.carrierName).join(" → ")}`,
);

// ── Final tally ──────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────────────`);
console.log(`Carrier-Ranking Lane-First — ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✅ All lane-first rebalance assertions passed.");
process.exit(0);
