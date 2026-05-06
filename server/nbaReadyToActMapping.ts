/**
 * Task #373 — NBA Ready-to-Act mapping table.
 *
 * Maps each NBA ruleType to the "shape" of the recommended outreach (email,
 * SMS, call talking-points, or quote hint), the email-drafting playType, and
 * the default activity type for the 1-click "Log this touch" button.
 */

export type ReadyToActShape = "email" | "sms" | "call" | "lane_capacity";
export type TouchType = "call" | "email" | "text" | "site_visit";

export interface ReadyToActSpec {
  shape: ReadyToActShape;
  /** Maps to PLAY_TYPES key in server/routes/emailDrafting.ts */
  draftPlayType: string;
  /** Default value for /api/touch-logs `type` */
  defaultTouchType: TouchType;
  /** When true, attach a quote/price hint card */
  includeQuoteHint: boolean;
  /** Short label shown above the draft */
  draftLabel: string;
}

const DEFAULT_SPEC: ReadyToActSpec = {
  shape: "email",
  draftPlayType: "general",
  defaultTouchType: "email",
  includeQuoteHint: false,
  draftLabel: "Suggested outreach",
};

const SPEC_BY_RULE: Record<string, ReadyToActSpec> = {
  load_decline:           { shape: "email", draftPlayType: "service_recovery",        defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Service-recovery email" },
  single_thread_risk:     { shape: "sms",   draftPlayType: "check_in",                defaultTouchType: "text",  includeQuoteHint: false, draftLabel: "Quick text intro" },
  stale_account:          { shape: "email", draftPlayType: "stale_reactivation",      defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Re-engagement email" },
  overdue_next_action:    { shape: "call",  draftPlayType: "check_in",                defaultTouchType: "call",  includeQuoteHint: false, draftLabel: "Call talking-points" },
  spot_to_contract:       { shape: "email", draftPlayType: "spot_to_contract",        defaultTouchType: "email", includeQuoteHint: true,  draftLabel: "Spot → contract pitch" },
  rfp_coverage_gap:       { shape: "email", draftPlayType: "lane_expansion",          defaultTouchType: "email", includeQuoteHint: true,  draftLabel: "Lane-coverage email" },
  stalled_award_lanes:    { shape: "email", draftPlayType: "competitive_displacement",defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Re-activation email" },
  webex_missed_call:      { shape: "call",  draftPlayType: "check_in",                defaultTouchType: "call",  includeQuoteHint: false, draftLabel: "Callback talking-points" },
  margin_slippage:        { shape: "call",  draftPlayType: "carrier_rate_discussion", defaultTouchType: "call",  includeQuoteHint: true,  draftLabel: "Rate-discussion call points" },
  rfp_expiring:           { shape: "email", draftPlayType: "qbr_followup",            defaultTouchType: "email", includeQuoteHint: true,  draftLabel: "Renewal email" },
  win_back:               { shape: "email", draftPlayType: "stale_reactivation",      defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Win-back email" },
  lane_volume_drop:       { shape: "email", draftPlayType: "service_recovery",        defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Volume-drop check-in" },
  payment_credit_issue:   { shape: "call",  draftPlayType: "check_in",                defaultTouchType: "call",  includeQuoteHint: false, draftLabel: "Credit-resolution call" },
  market_surge_customer_outreach: { shape: "email", draftPlayType: "lane_expansion",  defaultTouchType: "email", includeQuoteHint: true,  draftLabel: "Market-surge email" },
  market_tightening:      { shape: "email", draftPlayType: "carrier_rate_discussion", defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Market-tightening email" },
  R_MARKET_TIGHT:         { shape: "email", draftPlayType: "carrier_rate_discussion", defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Market-tightening email" },
  market_loosening:       { shape: "email", draftPlayType: "lane_expansion",          defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Market-loosening email" },
  R_MARKET_LOOSE:         { shape: "email", draftPlayType: "lane_expansion",          defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Market-loosening email" },
  recurring_lane_capacity:{ shape: "lane_capacity", draftPlayType: "carrier_capacity",defaultTouchType: "email", includeQuoteHint: false, draftLabel: "Carrier outreach" },
};

export function getReadyToActSpec(ruleType: string): ReadyToActSpec {
  return SPEC_BY_RULE[ruleType] ?? DEFAULT_SPEC;
}

export const TONE_INSTRUCTIONS: Record<string, string> = {
  default: "",
  warm:    "Use a warm, relationship-first tone — start with something human before getting to the ask.",
  concise: "Be extremely concise — one short sentence of context plus one direct ask.",
  firm:    "Use a firm, professional tone — direct and expectation-setting without being aggressive.",
  curious: "Use a curious, exploratory tone — ask a thoughtful question rather than make a hard ask.",
};
