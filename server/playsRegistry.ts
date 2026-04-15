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
