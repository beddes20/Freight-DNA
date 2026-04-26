/**
 * Daily Priorities Workspace — bucket mapping constants.
 *
 * Maps existing NBA card ruleType / outcomeType values to the five workspace
 * action buckets. This is the single source of truth for the mapping so the
 * backend endpoint and any future analytics consumers stay in sync.
 */

export type WorkspaceBucket =
  | "quote_now"
  | "follow_up"
  | "defend"
  | "grow"
  | "procure_carrier";

export const BUCKET_LABELS: Record<WorkspaceBucket, string> = {
  quote_now:       "Quote Now",
  follow_up:       "Follow Up",
  defend:          "Defend",
  grow:            "Grow",
  procure_carrier: "Procure Carrier",
};

export const BUCKET_DESCRIPTIONS: Record<WorkspaceBucket, string> = {
  quote_now:       "Accounts waiting on a quote or spot rate from you.",
  follow_up:       "Accounts that need a check-in or pending action closed out.",
  defend:          "Accounts at risk of churning or losing volume — act now.",
  grow:            "Accounts primed for expansion into new lanes or services.",
  procure_carrier: "Lanes needing carrier coverage or capacity outreach.",
};

/**
 * Priority used for cross-bucket deduplication.
 * When a company appears in more than one bucket, the lowest number wins.
 */
export const BUCKET_PRIORITY: Record<WorkspaceBucket, number> = {
  defend:          1,
  quote_now:       2,
  follow_up:       3,
  grow:            4,
  procure_carrier: 5,
};

/**
 * Primary mapping: ruleType → bucket.
 * outcomeType is the fallback when ruleType is absent from this map.
 */
const RULE_TO_BUCKET: Record<string, WorkspaceBucket> = {
  // ── Defend ─────────────────────────────────────────────────────────────────
  load_decline:          "defend",
  single_thread_risk:    "defend",
  margin_slippage:       "defend",
  lane_volume_drop:      "defend",
  payment_credit_issue:  "defend",
  win_back:              "defend",
  // ── Quote Now ──────────────────────────────────────────────────────────────
  spot_to_contract:      "quote_now",
  rfp_expiring:          "quote_now",
  stale_quote_followup:  "quote_now",
  // ── Follow Up ──────────────────────────────────────────────────────────────
  stale_account:         "follow_up",
  overdue_next_action:   "follow_up",
  stalled_award_lanes:   "follow_up",
  webex_missed_call:     "follow_up",
  // ── Grow ───────────────────────────────────────────────────────────────────
  rfp_coverage_gap:                "grow",
  market_loosening:                "grow",
  R_MARKET_LOOSE:                  "grow",
  market_surge_customer_outreach:  "grow",
  // ── Procure Carrier ────────────────────────────────────────────────────────
  recurring_lane_capacity: "procure_carrier",
  market_tightening:       "procure_carrier",
  R_MARKET_TIGHT:          "procure_carrier",
};

const OUTCOME_TYPE_FALLBACK: Record<string, WorkspaceBucket> = {
  protect: "defend",
  execute: "follow_up",
  grow:    "grow",
  deepen:  "follow_up",
};

/**
 * Resolve which bucket a card belongs to.
 * ruleType takes precedence; outcomeType is the fallback.
 */
export function ruleTypeToBucket(
  ruleType: string,
  outcomeType: string,
): WorkspaceBucket {
  return (
    RULE_TO_BUCKET[ruleType] ??
    OUTCOME_TYPE_FALLBACK[outcomeType] ??
    "follow_up"
  );
}

/** All five buckets in display order. */
export const BUCKET_ORDER: WorkspaceBucket[] = [
  "defend",
  "quote_now",
  "follow_up",
  "grow",
  "procure_carrier",
];
