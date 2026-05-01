import type { Phase1RuleType } from "./nbaPhase1Engine";

export interface PlayDefinition {
  id: string;
  name: string;
  description: string;
  outcomeType: "protect" | "execute" | "grow" | "deepen";
  ruleTypes: string[];
}

export const PLAYS_REGISTRY: PlayDefinition[] = [
  {
    id: "stabilize_at_risk",
    name: "Stabilize At-Risk Account",
    description: "Intervene quickly on accounts showing signs of churn — load drops, score declines, or service issues — to stop erosion and restore confidence.",
    outcomeType: "protect",
    ruleTypes: ["load_decline", "email_service_recovery", "email_objection_handling", "email_urgency_outreach"],
  },
  {
    id: "single_thread_coverage",
    name: "Expand Contact Coverage",
    description: "Map additional stakeholders to reduce single-contact dependency and broaden relationship depth across the account.",
    outcomeType: "protect",
    ruleTypes: ["single_thread_risk"],
  },
  {
    id: "re_engage_stale",
    name: "Re-Engage Stale Account",
    description: "Restart communication cadence on revenue-bearing accounts that have gone quiet — confirm health and reset the engagement clock.",
    outcomeType: "protect",
    ruleTypes: ["stale_account", "email_re_engage_thread"],
  },
  {
    id: "clear_overdue_action",
    name: "Clear Overdue Commitment",
    description: "Complete or update overdue next steps to restore execution momentum and demonstrate follow-through.",
    outcomeType: "execute",
    ruleTypes: ["overdue_next_action", "conv_waiting_summary"],
  },
  {
    id: "spot_to_mini_bid",
    name: "Consolidate Spot → Mini-Bid",
    description: "Convert recurring spot volume into a contracted lane agreement — predictable revenue, deeper relationship, harder for competitors to displace.",
    outcomeType: "execute",
    ruleTypes: ["spot_to_contract"],
  },
  {
    id: "rfp_defense_expansion",
    name: "RFP Defense / Expansion",
    description: "Cover uncovered high-volume RFP facilities and position for new freight before competitors fill the gap.",
    outcomeType: "grow",
    ruleTypes: ["rfp_coverage_gap"],
  },
  {
    id: "stalled_award_activation",
    name: "Activate Stalled Awards",
    description: "Re-engage on awarded lanes that have not converted to loads — confirm routing guide status and remove blockers.",
    outcomeType: "execute",
    ruleTypes: ["stalled_award_lanes"],
  },
  {
    id: "lane_capacity_strengthen",
    name: "Carrier Bench Strengthen",
    description: "Build carrier depth on recurring lanes to ensure reliable coverage and protect service quality.",
    outcomeType: "execute",
    ruleTypes: ["recurring_lane_capacity"],
  },
  {
    id: "market_tightening_protect",
    name: "Market Tightening Outreach",
    description: "Proactively reach out to customers and lock in carrier capacity ahead of a tightening market.",
    outcomeType: "protect",
    ruleTypes: ["market_tightening", "R_MARKET_TIGHT"],
  },
  {
    id: "market_loosening_grow",
    name: "Market Loosening Opportunity",
    description: "Leverage a loosening market to negotiate better rates and pitch new lanes to customers.",
    outcomeType: "grow",
    ruleTypes: ["market_loosening", "R_MARKET_LOOSE"],
  },
  {
    id: "geography_expansion",
    name: "Geography Expansion",
    description: "Identify and pursue freight at new customer facilities, sites, or regions not yet covered.",
    outcomeType: "grow",
    ruleTypes: ["contact_lane_responsibility"],
  },
  {
    id: "wallet_share_capture",
    name: "Wallet Share Capture",
    description: "Increase share of customer's total freight spend by displacing underperforming competitors and winning new lanes.",
    outcomeType: "grow",
    ruleTypes: ["email_new_opportunity", "email_opportunity_qualify", "email_quote_follow_up"],
  },
  {
    id: "market_signal_outreach",
    name: "Market Signal Outreach",
    description: "Act on a market signal (surge, tightening, or loosening) that creates an opportunity or risk for a specific account.",
    outcomeType: "execute",
    ruleTypes: ["market_surge_customer_outreach"],
  },
  {
    id: "stale_quote_followup",
    name: "Stale Quote Follow-Up",
    description: "Re-engage on a customer quote that has aged past their typical decision window — confirm interest, defend price, or close the loop before the opportunity goes cold.",
    outcomeType: "execute",
    ruleTypes: ["stale_quote_followup"],
  },
  {
    id: "webex_missed_call_follow_up",
    name: "Return Missed Call",
    description: "Follow up on a missed inbound call or voicemail from a known contact — inbound interest should never fall through the cracks.",
    outcomeType: "protect",
    ruleTypes: ["webex_missed_call"],
  },
];

const ruleToPlayMap = new Map<string, PlayDefinition>();
for (const play of PLAYS_REGISTRY) {
  for (const rt of play.ruleTypes) {
    ruleToPlayMap.set(rt, play);
  }
}

export function getPlayForRuleType(ruleType: string): PlayDefinition | null {
  return ruleToPlayMap.get(ruleType) ?? null;
}

export function getPlayByLabel(label: string): PlayDefinition | null {
  return PLAYS_REGISTRY.find(p => p.name === label) ?? null;
}

export function getAllPlayLabels(): string[] {
  return PLAYS_REGISTRY.map(p => p.name);
}

// ─── Task #926 — Doc-driven plays for the Copilot Play Caller ─────────────
// Independent of the NBA plays above — these are emitted by the copilot
// after a doc is classified + its intelligence row computed. They flow
// through the same HITL action-card pipeline (no autonomous send) and
// dedupe against open NBA cards via `dedupAgainstNbaRuleTypes` below.
export interface DocPlayDef {
  id: string;
  name: string;
  description: string;
  outcomeType: "pursue" | "pass" | "clarify" | "execute" | "escalate";
  /** Pending NBA rule types that should suppress this doc-play. */
  dedupAgainstNbaRuleTypes?: string[];
}

export const DOC_DRIVEN_PLAYS: DocPlayDef[] = [
  {
    id: "pursue_quote_now",
    name: "Pursue Quote Now",
    description: "Lane fit, customer fit, and price band align — quote with the recommended target rate.",
    outcomeType: "pursue",
    dedupAgainstNbaRuleTypes: ["spot_to_contract"],
  },
  {
    id: "clarify_before_quoting",
    name: "Clarify Before Quoting",
    description: "Evidence is thin — ask the customer for missing fields before committing to a number.",
    outcomeType: "clarify",
  },
  {
    id: "pass_low_margin",
    name: "Pass — Low Margin",
    description: "Comparable rate spread + risk profile don't support pursuing this load profitably.",
    outcomeType: "pass",
  },
  {
    id: "route_to_specialist_rep",
    name: "Route to Specialist Rep",
    description: "Lane is unfamiliar to the assigned rep — recommend handing it to a specialist who runs this lane often.",
    outcomeType: "execute",
  },
  {
    id: "start_with_carrier_bench_A",
    name: "Start With A-Tier Bench",
    description: "Carrier bench is performing strongly — start outreach with the A-tier carriers before going to market.",
    outcomeType: "execute",
  },
  {
    id: "negotiate_with_incumbent_first",
    name: "Negotiate With Incumbent First",
    description: "We have history on this lane — try to defend / re-negotiate with the incumbent before opening to spot.",
    outcomeType: "execute",
    dedupAgainstNbaRuleTypes: ["spot_to_contract", "rfp_coverage_gap"],
  },
  {
    id: "escalate_to_manager",
    name: "Escalate to Manager",
    description: "Signals conflict or evidence is too low to recommend a move — needs human judgment.",
    outcomeType: "escalate",
  },
];

export function getDocPlayById(id: string): DocPlayDef | null {
  return DOC_DRIVEN_PLAYS.find((p) => p.id === id) ?? null;
}
