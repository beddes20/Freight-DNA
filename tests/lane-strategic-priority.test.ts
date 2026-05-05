/**
 * Task #1027 (LWQ B) — unit tests for the Strategic priority composite.
 *
 * The function is pure (no DB / no clock), so each assertion is a single
 * deterministic call. These tests pin down the contract the route relies on:
 *   • Missing customer value collapses that axis to 0 (or to the
 *     strategicTierBoost contribution alone).
 *   • Null `daysSinceOwnerTouchpoint` ⇒ freshness = max (never touched is
 *     the strongest reason to call).
 *   • No prior covered loads ⇒ outcome history = 0.
 *   • Missing lifecycle stage ⇒ neutral floor (30), not a crash.
 *   • `hotReplyCount` drives the tactical axis directly (not lifecycle).
 *   • `strategicTierBoost` lifts the customer-value sub-score.
 *   • Operationalized lanes are heavily downweighted.
 *   • `topReason` reflects the highest-contributing axis.
 */
import {
  computeLaneStrategicPriority,
  DEFAULT_LANE_STRATEGIC_WEIGHTS,
  type LaneStrategicWeights,
} from "../server/services/laneStrategicPriority";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(detail ? `${name} — ${detail}` : name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const W: LaneStrategicWeights = DEFAULT_LANE_STRATEGIC_WEIGHTS;

console.log("── Lane strategic priority — unit tests ───────────────────────");

// (1) Missing customer value: ytdRevenue/spend null AND no tier boost ⇒ axis = 0.
{
  const r = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: null, estimatedFreightSpend: null },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    null,
    W,
  );
  const cv = r.components.find(c => c.label === "Customer value")!;
  assert("missing customer value ⇒ Customer value sub-score = 0", cv.score === 0, `got ${cv.score}`);
}

// (2) Never-touched ⇒ freshness = 100 (max).
{
  const r = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 0, estimatedFreightSpend: 0 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: null, priorCoveredLoads: 0 },
    null,
    W,
  );
  const fr = r.components.find(c => c.label === "Relationship freshness")!;
  assert("null daysSinceOwnerTouchpoint ⇒ Freshness = 100", fr.score === 100, `got ${fr.score}`);
}

// (3) No prior loads ⇒ outcome history = 0.
{
  const r = computeLaneStrategicPriority(
    { laneScore: 50, avgLoadsPerWeek: 1, isHighFrequency: false },
    { ytdRevenue: 1000, estimatedFreightSpend: 1000 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 5, priorCoveredLoads: 0 },
    "qualified",
    W,
  );
  const oh = r.components.find(c => c.label === "Lane outcome history")!;
  assert("priorCoveredLoads=0 ⇒ Outcome history = 0", oh.score === 0, `got ${oh.score}`);
}

// (4) Missing lifecycle stage ⇒ neutral floor 30 (and no crash).
{
  const r = computeLaneStrategicPriority(
    { laneScore: 50, avgLoadsPerWeek: 1, isHighFrequency: false },
    { ytdRevenue: 0, estimatedFreightSpend: 0 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    null,
    W,
  );
  const lc = r.components.find(c => c.label === "Lifecycle stage")!;
  assert("null lifecycle ⇒ Lifecycle sub-score = 30 (neutral floor)", lc.score === 30, `got ${lc.score}`);
}

// (5) hotReplyCount drives Tactical (not lifecycle proxy). Two hot replies on
//     a non-engaged lane should still score Tactical near the top.
{
  const cool = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 0, estimatedFreightSpend: 0 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    "qualified", W,
  );
  const hot = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 0, estimatedFreightSpend: 0 },
    { hotReplyCount: 2, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    "qualified", W,
  );
  const coolTac = cool.components.find(c => c.label === "Tactical signal")!.score;
  const hotTac = hot.components.find(c => c.label === "Tactical signal")!.score;
  assert("hotReplyCount=2 raises Tactical above hotReplyCount=0", hotTac > coolTac, `cool=${coolTac} hot=${hotTac}`);
}

// (6) strategicTierBoost lifts Customer value sub-score.
{
  const noBoost = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 100_000, estimatedFreightSpend: 100_000 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    null, W,
  );
  const boosted = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 100_000, estimatedFreightSpend: 100_000, strategicTierBoost: 1 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    null, W,
  );
  const a = noBoost.components.find(c => c.label === "Customer value")!.score;
  const b = boosted.components.find(c => c.label === "Customer value")!.score;
  assert("strategicTierBoost=1 lifts Customer value sub-score", b > a, `noBoost=${a} boosted=${b}`);
  assert("strategicTierBoost contribution capped at +25 over base", b - a <= 25 + 0.01, `delta=${b - a}`);
}

// (7) Operationalized lifecycle is heavily downweighted vs. engaged.
{
  const engaged = computeLaneStrategicPriority(
    { laneScore: 50, avgLoadsPerWeek: 1, isHighFrequency: false },
    { ytdRevenue: 100_000, estimatedFreightSpend: 100_000 },
    { hotReplyCount: 1, daysSinceOwnerTouchpoint: 7, priorCoveredLoads: 1 },
    "engaged", W,
  );
  const opd = computeLaneStrategicPriority(
    { laneScore: 50, avgLoadsPerWeek: 1, isHighFrequency: false },
    { ytdRevenue: 100_000, estimatedFreightSpend: 100_000 },
    { hotReplyCount: 1, daysSinceOwnerTouchpoint: 7, priorCoveredLoads: 1 },
    "operationalized", W,
  );
  assert("operationalized scores below engaged", opd.score < engaged.score, `engaged=${engaged.score} opd=${opd.score}`);
}

// (8) topReason reflects the highest-contributing axis.
{
  const r = computeLaneStrategicPriority(
    { laneScore: 0, avgLoadsPerWeek: 0, isHighFrequency: false },
    { ytdRevenue: 5_000_000, estimatedFreightSpend: 5_000_000 },
    { hotReplyCount: 0, daysSinceOwnerTouchpoint: 0, priorCoveredLoads: 0 },
    "qualified", W,
  );
  assert("dominant Customer value ⇒ topReason = 'Customer value'", r.topReason === "Customer value", `got ${r.topReason}`);
}

// (9) Score is bounded 0..100 and `components` enumerates all five axes.
{
  const r = computeLaneStrategicPriority(
    { laneScore: 100, avgLoadsPerWeek: 100, isHighFrequency: true },
    { ytdRevenue: 10_000_000, estimatedFreightSpend: 10_000_000, strategicTierBoost: 1 },
    { hotReplyCount: 99, daysSinceOwnerTouchpoint: 999, priorCoveredLoads: 999 },
    "engaged", W,
  );
  assert("score bounded ≤ 100", r.score <= 100, `got ${r.score}`);
  assert("score bounded ≥ 0", r.score >= 0, `got ${r.score}`);
  assert("five components enumerated", r.components.length === 5, `got ${r.components.length}`);
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
