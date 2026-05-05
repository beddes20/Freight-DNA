// Task #1026 (LWQ A) — Pure derivation of `recurring_lanes.lifecycle_stage`.
//
// This module is the **single source of truth** for the lifecycle of a
// recurring lane. Every surface (LWQ list, NBA cards, manager dashboards,
// future B/C/D/E tasks) that needs to know "what stage is this lane in?"
// MUST read the persisted `lifecycleStage` column. UI code MUST NOT
// recompute the stage from raw signals (`isEligible`, `ownerUserId`,
// `contactableCount`, `carriersContactedCount`, `replyCount`) — a guardrail
// in `tests/code-quality-guardrails.test.ts` enforces this.
//
// The stage column is written exclusively by
// `recomputeLaneLifecycleStage()` in `server/services/laneLifecycle.ts`,
// which calls this pure function with current signals.

export const LIFECYCLE_STAGES = [
  "detected",
  "qualified",
  "assigned",
  "contactable",
  "contacted",
  "engaged",
  "operationalized",
] as const;

export type LaneLifecycleStage = typeof LIFECYCLE_STAGES[number];

export function isLaneLifecycleStage(v: unknown): v is LaneLifecycleStage {
  return typeof v === "string" && (LIFECYCLE_STAGES as readonly string[]).includes(v);
}

// Lane fields the derivation needs. Subset of `RecurringLane` so the
// function stays pure and trivially unit-testable.
export interface LaneLifecycleInputs {
  isEligible: boolean;
  // "high" | "medium" | "borderline" — engine sets this.
  eligibilityConfidence: string | null | undefined;
  ownerUserId: string | null | undefined;
  carriersContactedCount: number | null | undefined;
}

// Per-lane outreach + bench rollup. All fields are non-negative integers.
//   `outreachAttemptCount` — count of carrier_outreach_logs rows for this
//      lane that represent a real attempt (deliveryStatus='sent' or any
//      outbound row with sentAt set, ignoring assignment/reassignment
//      audit rows).
//   `engagedReplyCount` — count of bench rows with an engaged interest
//      status (available_now / available_next_week / future_interest) OR
//      outreach log rows with replyReceivedAt set.
//   `contactableCount` — distinct bench carriers with a contactable email
//      (mirrors `lane_summary_cache.contactable_count`).
export interface LaneOutreachStats {
  outreachAttemptCount: number;
  engagedReplyCount: number;
  contactableCount: number;
}

// True iff at least one covered/won load matching the lane signature
// (`origin|originState|destination|destinationState|equipmentType` for the
// same companyId) has a pickup/booking date AFTER the first carrier
// outreach attempt for the lane. Computed by the server service against
// `load_fact` (bucket='realized') joined to `carrier_outreach_logs` min
// `sent_at`/`timestamp`. The flag MUST be false when no outreach has
// happened yet — Operationalized requires the post-outreach ordering.
export type CoveredAfterOutreachFlag = boolean;

/**
 * Pure derivation. Returns the lifecycle stage that best describes the
 * lane right now. Order of evaluation goes from terminal → root:
 *
 *   operationalized — at least one covered load post-outreach
 *   engaged         — at least one engaged carrier reply
 *   contacted       — at least one outreach attempt was logged OR the
 *                     lane has a non-zero `carriersContactedCount`
 *   contactable     — there is at least one contactable bench carrier
 *                     but no outreach has been attempted yet
 *   assigned        — has an owner but nothing else has happened
 *   qualified       — engine flagged eligible (high/medium confidence)
 *                     and not yet assigned
 *   detected        — fallback (engine emitted the lane but the
 *                     eligibility signal is borderline / not eligible)
 *
 * NOTE: this function MUST stay pure — no DB calls, no Date.now(). All
 * inputs come from the caller so unit tests can pin every transition.
 */
export function deriveLaneLifecycleStage(
  lane: LaneLifecycleInputs,
  outreach: LaneOutreachStats,
  coveredLoadsAfterOutreach: CoveredAfterOutreachFlag,
): LaneLifecycleStage {
  // Operationalized requires a post-outreach covered load. By construction
  // the caller only sets the flag true when both the outreach min-date and
  // the covered-load pickup/booking date were resolvable AND the load
  // post-dates the first outreach attempt — see
  // `coveredLoadAfterFirstOutreachAttempt()` in the server service.
  if (coveredLoadsAfterOutreach) return "operationalized";

  if (outreach.engagedReplyCount > 0) return "engaged";

  const contactedAttempts = (outreach.outreachAttemptCount ?? 0)
    + (lane.carriersContactedCount ?? 0);
  if (contactedAttempts > 0) return "contacted";

  if ((outreach.contactableCount ?? 0) > 0) return "contactable";

  if (lane.ownerUserId) return "assigned";

  const conf = (lane.eligibilityConfidence ?? "").toLowerCase();
  if (lane.isEligible && (conf === "high" || conf === "medium")) {
    return "qualified";
  }

  return "detected";
}
