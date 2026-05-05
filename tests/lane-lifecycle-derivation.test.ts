// Task #1026 (LWQ A) — Unit tests for the pure lifecycle derivation.
//
// Pins every transition in `deriveLaneLifecycleStage()` (the single
// source of truth for `recurring_lanes.lifecycle_stage`) so a future
// refactor cannot silently move a stage boundary. Runs as a plain
// tsx-executed test — no DB, no network — because the derivation is
// pure by contract.

import {
  deriveLaneLifecycleStage,
  isLaneLifecycleStage,
  LIFECYCLE_STAGES,
  type LaneLifecycleInputs,
  type LaneOutreachStats,
} from "../shared/laneLifecycle";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}\n      expected: ${String(expected)}\n      actual:   ${String(actual)}`);
  }
}

const baseLane: LaneLifecycleInputs = {
  isEligible: false,
  eligibilityConfidence: null,
  ownerUserId: null,
  carriersContactedCount: 0,
};
const zeroStats: LaneOutreachStats = {
  outreachAttemptCount: 0,
  engagedReplyCount: 0,
  contactableCount: 0,
};

// ── Stage enum surface ────────────────────────────────────────────────────
expect(
  "LIFECYCLE_STAGES contains exactly the seven canonical stages in order",
  LIFECYCLE_STAGES.join(","),
  "detected,qualified,assigned,contactable,contacted,engaged,operationalized",
);
expect("isLaneLifecycleStage accepts 'engaged'", isLaneLifecycleStage("engaged"), true);
expect("isLaneLifecycleStage rejects 'won'", isLaneLifecycleStage("won"), false);
expect("isLaneLifecycleStage rejects null", isLaneLifecycleStage(null), false);

// ── detected (root fallback) ──────────────────────────────────────────────
expect(
  "detected: nothing happening, ineligible",
  deriveLaneLifecycleStage(baseLane, zeroStats, false),
  "detected",
);
expect(
  "detected: eligible but borderline confidence is NOT qualified",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: true, eligibilityConfidence: "borderline" },
    zeroStats,
    false,
  ),
  "detected",
);
expect(
  "detected: confidence='high' but isEligible=false stays detected",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: false, eligibilityConfidence: "high" },
    zeroStats,
    false,
  ),
  "detected",
);

// ── qualified ─────────────────────────────────────────────────────────────
expect(
  "qualified: eligible + high confidence + no owner",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: true, eligibilityConfidence: "high" },
    zeroStats,
    false,
  ),
  "qualified",
);
expect(
  "qualified: eligible + medium confidence + no owner",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: true, eligibilityConfidence: "MEDIUM" },
    zeroStats,
    false,
  ),
  "qualified",
);

// ── assigned ──────────────────────────────────────────────────────────────
expect(
  "assigned: ownerUserId set, no contactable bench, no outreach",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: true, eligibilityConfidence: "high", ownerUserId: "u1" },
    zeroStats,
    false,
  ),
  "assigned",
);

// ── contactable ───────────────────────────────────────────────────────────
expect(
  "contactable: bench has carriers but no outreach yet (unowned)",
  deriveLaneLifecycleStage(
    baseLane,
    { ...zeroStats, contactableCount: 3 },
    false,
  ),
  "contactable",
);
expect(
  "contactable: even with owner, contactable bench wins over assigned",
  deriveLaneLifecycleStage(
    { ...baseLane, ownerUserId: "u1" },
    { ...zeroStats, contactableCount: 1 },
    false,
  ),
  "contactable",
);

// ── contacted ─────────────────────────────────────────────────────────────
expect(
  "contacted: at least one outreach attempt logged",
  deriveLaneLifecycleStage(
    baseLane,
    { ...zeroStats, outreachAttemptCount: 1, contactableCount: 5 },
    false,
  ),
  "contacted",
);
expect(
  "contacted: legacy lane.carriersContactedCount > 0 also counts",
  deriveLaneLifecycleStage(
    { ...baseLane, carriersContactedCount: 2 },
    { ...zeroStats, contactableCount: 5 },
    false,
  ),
  "contacted",
);

// ── engaged ───────────────────────────────────────────────────────────────
expect(
  "engaged: at least one engaged reply, regardless of attempts",
  deriveLaneLifecycleStage(
    baseLane,
    { outreachAttemptCount: 4, engagedReplyCount: 1, contactableCount: 9 },
    false,
  ),
  "engaged",
);
expect(
  "engaged: even without an attempt, an engaged reply promotes the lane",
  deriveLaneLifecycleStage(
    baseLane,
    { ...zeroStats, engagedReplyCount: 1 },
    false,
  ),
  "engaged",
);

// ── operationalized (terminal) ────────────────────────────────────────────
expect(
  "operationalized: covered-after-outreach flag overrides everything",
  deriveLaneLifecycleStage(
    { ...baseLane, ownerUserId: "u1", carriersContactedCount: 2 },
    { outreachAttemptCount: 5, engagedReplyCount: 3, contactableCount: 8 },
    true,
  ),
  "operationalized",
);
expect(
  "operationalized: even a 'detected'-shaped lane jumps to operationalized when flag is true",
  deriveLaneLifecycleStage(baseLane, zeroStats, true),
  "operationalized",
);

// ── precedence: terminal → root ───────────────────────────────────────────
expect(
  "precedence: engaged > contacted",
  deriveLaneLifecycleStage(
    baseLane,
    { outreachAttemptCount: 5, engagedReplyCount: 1, contactableCount: 0 },
    false,
  ),
  "engaged",
);
expect(
  "precedence: contacted > contactable",
  deriveLaneLifecycleStage(
    baseLane,
    { outreachAttemptCount: 1, engagedReplyCount: 0, contactableCount: 9 },
    false,
  ),
  "contacted",
);
expect(
  "precedence: contactable > assigned",
  deriveLaneLifecycleStage(
    { ...baseLane, ownerUserId: "u1" },
    { ...zeroStats, contactableCount: 1 },
    false,
  ),
  "contactable",
);
expect(
  "precedence: assigned > qualified",
  deriveLaneLifecycleStage(
    { ...baseLane, isEligible: true, eligibilityConfidence: "high", ownerUserId: "u1" },
    zeroStats,
    false,
  ),
  "assigned",
);

console.log(`\nlane-lifecycle-derivation: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
