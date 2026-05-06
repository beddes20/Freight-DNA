/**
 * Workflow agent registry — the six outcome-owning bots in the program.
 *
 * Each entry defines the static identity (slug, name, loop, default config) of
 * one workflow agent. Per-org rows live in `workflow_agents` and inherit these
 * defaults on first creation, then admins customize via the Settings page.
 */
import { db } from "../storage";
import { eq, and } from "drizzle-orm";
import { workflowAgents, type WorkflowAgent } from "@shared/schema";

export type AgentSlug =
  | "pricing"
  | "order_schedule"
  | "coverage"
  | "risk"
  | "execution"
  | "billing";

export type Autonomy = "off" | "suggest" | "draft" | "auto_hitl" | "auto";

export interface AgentDefinition {
  slug: AgentSlug;
  name: string;
  loop: string;
  description: string;
  defaultModel: string;
  defaultPersonaOverlay: string;
  defaultGuardrails: WorkflowAgent["guardrails"];
  defaultTriggers: WorkflowAgent["triggers"];
  targetMetric: string;
  /** Adapter keys this agent reads/writes through. */
  adapters: string[];
  /** Plays bound to this agent at first install. */
  starterPlays: Array<{ name: string; whenToUse: string; body: string }>;
}

export const AGENT_DEFS: Record<AgentSlug, AgentDefinition> = {
  pricing: {
    slug: "pricing",
    name: "Pricing & Strategy",
    loop: "rfq_to_quote",
    description:
      "Watches inbound RFQs, pulls history + live market, drafts safe/stretch/aggressive quotes with reasoning, and learns from win/loss.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Pricing Agent. Always cite the lane reference (origin → destination, equipment) and show three rate tiers: safe, stretch, aggressive. Justify with our last 90-day actuals and live SONAR/DAT.",
    defaultGuardrails: { marginFloorUsd: 100, maxDollarPerAction: 25000, dailySendCapEmail: 25 },
    defaultTriggers: { events: ["rfq.received"] },
    targetMetric: "win_rate_at_target_margin",
    adapters: ["dat", "truckstop", "sonar", "graph_mail"],
    starterPlays: [
      {
        name: "Three-tier quote",
        whenToUse: "Any inbound RFQ with valid lane + equipment.",
        body: "Pull our 90-day actuals on this lane (cost, sell, win rate). Pull live spot from DAT/Truckstop and SONAR OTRI/VOTRI. Produce three sell rates: safe (matches our typical buy + 12%), stretch (+18%), aggressive (+25%). Cite reasoning. Stage outbound email for HITL approval.",
      },
    ],
  },
  order_schedule: {
    slug: "order_schedule",
    name: "Order & Schedule",
    loop: "win_to_load",
    description:
      "Detects awards/tenders, validates against the won quote, builds the load shell in ValueTMS, and proposes optimal appointment times.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Order & Schedule Agent. Validate every tender field against the won quote before staging the load build. Always propose appointment times based on facility dwell history.",
    defaultGuardrails: { maxDollarPerAction: 50000 },
    defaultTriggers: { events: ["award.tender_received"] },
    targetMetric: "tender_to_load_minutes",
    adapters: ["edi", "valuetms", "graph_mail"],
    starterPlays: [
      {
        name: "Validate-then-build",
        whenToUse: "Tender or award notification received.",
        body: "Compare tender fields to the won quote (lane, equipment, rate, accessorials). Flag any deltas in the HITL card. If clean, stage load shell creation in ValueTMS with proposed appointment times derived from the facility's prior dwell distribution.",
      },
    ],
  },
  coverage: {
    slug: "coverage",
    name: "Coverage & Carrier",
    loop: "coverage",
    description:
      "Ranks carriers using MatchMaker, builds a posting strategy honoring city-masking rules, drafts outreach, captures offers, and proposes negotiation bands.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Coverage Agent. Always start with the incumbent before posting publicly. Honor each customer's city-masking rules. Propose negotiation bands as ranges, never single numbers.",
    defaultGuardrails: { marginFloorUsd: 75, dailySendCapEmail: 100, dailySendCapSms: 50 },
    defaultTriggers: { events: ["load.available_for_coverage"] },
    targetMetric: "covered_within_sla_pct",
    adapters: ["dat", "truckstop", "graph_mail", "twilio", "valuetms"],
    starterPlays: [
      {
        name: "Incumbent-first outreach",
        whenToUse: "Load is available for coverage and an incumbent carrier exists.",
        body: "Reach out to the incumbent first with a specific target rate. If declined or no response in 30 minutes, expand to top-3 ranked carriers from MatchMaker. Only post publicly if those fail. Capture every offer in the offers panel.",
      },
    ],
  },
  risk: {
    slug: "risk",
    name: "Risk & Compliance",
    loop: "risk",
    description:
      "Control agent that gates Coverage. Pulls Highway/Carrier411, checks domain/phone/authority, computes a risk score, and blocks rate-con send above threshold.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Risk & Compliance Agent. You are a control function. Be explicit about which signals tripped the block and what evidence would clear it.",
    defaultGuardrails: { maxRiskScore: 60 },
    defaultTriggers: { events: ["coverage.rate_con_pending"] },
    targetMetric: "fraud_block_rate",
    adapters: ["highway", "carrier411", "valuetms"],
    starterPlays: [
      {
        name: "Pre-rate-con vetting",
        whenToUse: "Coverage Agent has selected a carrier and a rate-confirmation send is pending.",
        body: "Pull Highway + Carrier411 + canonical contact records. Check domain match, phone authority, MC authority age, and recent VIN proximity to pickup. Compute risk score 0–100. If score > maxRiskScore, BLOCK the send and stage an HITL override card with full evidence.",
      },
    ],
  },
  execution: {
    slug: "execution",
    name: "Execution & Detention",
    loop: "execution",
    description:
      "Monitors ELD vs SLA, sends scheduled check-calls, detects ETA drift, runs detention timers, drafts customer claims and driver payables.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Execution Agent. Be precise about times and who you've contacted. When ETA drifts, propose specific scripted resolutions, not generic advice.",
    defaultGuardrails: { dailySendCapSms: 200, allowedHoursStart: "06:00", allowedHoursEnd: "21:00" },
    defaultTriggers: { schedule: "*/15 * * * *", events: ["load.in_transit", "load.eta_drift"] },
    targetMetric: "on_time_delivery_pct",
    adapters: ["valuetms", "twilio", "graph_mail"],
    starterPlays: [
      {
        name: "Check-call cadence",
        whenToUse: "Load is in transit.",
        body: "Send a scheduled check-call SMS to driver + dispatch at pickup-2hr, in-transit midpoint, and delivery-2hr. If no response within 30 minutes of pickup or delivery window, escalate to voice call.",
      },
      {
        name: "Detention timer",
        whenToUse: "Driver arrived at pickup or delivery and is still on-site past the customer's free-time window.",
        body: "Start the per-customer detention timer. At free-time + 15min, draft both the customer detention claim and the driver detention payable for HITL approval.",
      },
    ],
  },
  billing: {
    slug: "billing",
    name: "Billing & Collections",
    loop: "billing",
    description:
      "Validates POD + accessorials against contracts, generates invoices and doc packets, submits via per-customer portal, and runs scheduled dunning.",
    defaultModel: "gpt-4o",
    defaultPersonaOverlay:
      "You are the Billing Agent. Match every charge line to a contract clause or stage the discrepancy as an HITL action. Use the right portal/email per customer.",
    defaultGuardrails: { maxDollarPerAction: 100000, dailySendCapEmail: 50 },
    defaultTriggers: { events: ["load.pod_received"] },
    targetMetric: "days_to_pay",
    adapters: ["valuetms", "graph_mail", "customer_portal", "payment_portal"],
    starterPlays: [
      {
        name: "Validate-and-invoice",
        whenToUse: "POD received and accessorials confirmed for a load.",
        body: "Validate every line item (linehaul, fuel, detention, lumper, layover) against the customer contract. Generate invoice + doc packet. Stage submission via the customer's preferred portal/email for HITL approval.",
      },
      {
        name: "Dunning cadence",
        whenToUse: "Invoice past due based on payment terms.",
        body: "Send polite reminder at +5 days, firm follow-up at +15, escalate to AR manager + draft dispute review at +30. Adjust cadence based on customer risk profile.",
      },
    ],
  },
};

export const AGENT_SLUGS = Object.keys(AGENT_DEFS) as AgentSlug[];

/** Ensure every workflow agent exists for an org. Idempotent. */
export async function ensureWorkflowAgentsForOrg(organizationId: string): Promise<WorkflowAgent[]> {
  const existing = await db.select().from(workflowAgents).where(eq(workflowAgents.organizationId, organizationId));
  const have = new Set(existing.map((r) => r.slug));
  const out: WorkflowAgent[] = [...existing];
  for (const slug of AGENT_SLUGS) {
    if (have.has(slug)) continue;
    const def = AGENT_DEFS[slug];
    const [row] = await db.insert(workflowAgents).values({
      organizationId,
      slug: def.slug,
      name: def.name,
      description: def.description,
      loop: def.loop,
      autonomy: "off",
      enabled: false,
      scope: {},
      guardrails: def.defaultGuardrails ?? {},
      triggers: def.defaultTriggers ?? {},
      targetMetric: def.targetMetric,
      personaOverlay: def.defaultPersonaOverlay,
      model: def.defaultModel,
    }).returning();
    out.push(row);
  }
  return out;
}

export async function getWorkflowAgent(orgId: string, slug: string) {
  const [row] = await db.select().from(workflowAgents)
    .where(and(eq(workflowAgents.organizationId, orgId), eq(workflowAgents.slug, slug)))
    .limit(1);
  return row ?? null;
}
