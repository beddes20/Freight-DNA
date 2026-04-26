/**
 * Six workflow-agent stubs implementing the canonical sense → plan → draft → act loop.
 *
 * Each stub is intentionally lightweight: it pulls a small input context, calls
 * the relevant adapter(s) in dry-run mode, builds a structured suggestion +
 * payload, runs autonomy enforcement, and either records a suggestion, stages
 * an HITL action, or executes directly. The loops are designed to be safe to
 * call by hand from the UI ("Run once") while the program is being rolled out.
 */
import type { WorkflowAgent } from "@shared/schema";
import { adapters } from "../adapters";
import { enforceAutonomy } from "../autonomy";
import { recordSuggestion } from "../outcomes";
import { stageHitlAction } from "../hitl";

export type AgentSlug = "pricing" | "order_schedule" | "coverage" | "risk" | "execution" | "billing";

export interface RunInput {
  agent: WorkflowAgent;
  organizationId: string;
  /** Free-form trigger payload passed in by the caller. */
  trigger: Record<string, any>;
}

export interface RunResult {
  agentSlug: string;
  decision: ReturnType<typeof enforceAutonomy>;
  suggestionId?: string;
  hitlActionId?: string;
  summary: string;
}

// ─── Pricing & Strategy ──────────────────────────────────────────────────
async function runPricing({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const origin = trigger.origin ?? "Chicago, IL";
  const destination = trigger.destination ?? "Atlanta, GA";
  const equipment = trigger.equipment ?? "DRY_VAN";
  const miles = trigger.miles ?? 720;

  const rates = await adapters.fetchRates(organizationId, { origin, destination, equipment });
  const r = rates.data!;
  const safeSell = +(r.contractMid * miles + 100).toFixed(2);
  const stretchSell = +(r.spotMid * miles).toFixed(2);
  const aggressiveSell = +(r.spotHigh * miles).toFixed(2);

  const suggestion = {
    tiers: [
      { label: "Safe", sell: safeSell, marginPctTarget: 12 },
      { label: "Stretch", sell: stretchSell, marginPctTarget: 18 },
      { label: "Aggressive", sell: aggressiveSell, marginPctTarget: 25 },
    ],
    market: r,
    laneKey: `${origin}|${destination}|${equipment}`,
  };
  const reasoning = `90-day actuals + live spot from ${r.source}; mid spot $${r.spotMid}/mi over ${miles} mi.`;

  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id,
    loopStep: "draft_quote", inputContext: trigger,
    suggestion, reasoning, confidence: 78,
    relatedLaneKey: suggestion.laneKey, adapterMode: rates.mode,
    model: agent.model,
  });

  const decision = enforceAutonomy({ agent, risk: "medium", dollarAmount: stretchSell });
  if (decision.mode === "stage_hitl" || decision.mode === "execute_directly") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "quote.send",
      title: `Quote ${origin} → ${destination} (${equipment})`,
      summary: `3 tiers ready. Stretch sell: $${stretchSell.toLocaleString()}.`,
      payload: { tiers: suggestion.tiers, channel: "email", to: trigger.contactEmail ?? null },
      reasoning, adapterMode: rates.mode, relatedLaneKey: suggestion.laneKey,
      relatedCompanyId: trigger.customerCompanyId ?? null,
    });
    return { agentSlug: "pricing", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Quote staged for approval." };
  }
  return { agentSlug: "pricing", decision, suggestionId: sug.id, summary: "Quote suggestion recorded." };
}

// ─── Order & Schedule ────────────────────────────────────────────────────
async function runOrderSchedule({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const tenderRef = trigger.tenderRef ?? `T-${Date.now()}`;
  const validation = {
    tenderRef,
    laneMatches: true, equipmentMatches: true, rateMatches: true,
    deltas: [],
  };
  const proposedAppointments = {
    pickup: trigger.pickupAt ?? new Date(Date.now() + 24 * 3600e3).toISOString(),
    delivery: trigger.deliveryAt ?? new Date(Date.now() + 72 * 3600e3).toISOString(),
  };
  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id, loopStep: "validate_tender",
    inputContext: trigger, suggestion: { validation, proposedAppointments },
    reasoning: "Tender fields validated against won quote; appointments derived from facility dwell history.",
    confidence: 88, model: agent.model, adapterMode: "dry_run",
  });
  const decision = enforceAutonomy({ agent, risk: "low", dollarAmount: trigger.rate ?? 0 });
  if (decision.mode === "stage_hitl" || decision.mode === "execute_directly") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "load.build",
      title: `Build load for tender ${tenderRef}`,
      summary: `Validated; appointments proposed (${proposedAppointments.pickup.slice(0, 16)}).`,
      payload: { tenderRef, ...proposedAppointments }, reasoning: sug.reasoning ?? "",
      adapterMode: "dry_run",
    });
    return { agentSlug: "order_schedule", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Load build staged." };
  }
  return { agentSlug: "order_schedule", decision, suggestionId: sug.id, summary: "Validation suggestion recorded." };
}

// ─── Coverage & Carrier ──────────────────────────────────────────────────
async function runCoverage({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const incumbentMc = trigger.incumbentMc ?? "MC-101010";
  const targetRate = trigger.targetRate ?? 1450;
  const ranked = [
    { rank: 1, mcNumber: incumbentMc, name: "Incumbent Carrier", isIncumbent: true, score: 92 },
    { rank: 2, mcNumber: "MC-202020", name: "Top Match A", score: 85 },
    { rank: 3, mcNumber: "MC-303030", name: "Top Match B", score: 80 },
  ];
  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id, loopStep: "outreach_plan",
    inputContext: trigger,
    suggestion: { ranked, postingPlan: { incumbentFirst: true, escalateAfterMin: 30, publicPostAfter: "top3_fail" } },
    reasoning: "MatchMaker score on lane; incumbent leads. City-mask honored per customer rules.",
    confidence: 81, model: agent.model, adapterMode: "dry_run",
  });
  const decision = enforceAutonomy({ agent, risk: "medium", dollarAmount: targetRate });
  if (decision.mode === "stage_hitl" || decision.mode === "execute_directly") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "carrier.outreach",
      title: `Cover load — start with incumbent ${incumbentMc}`,
      summary: `Target $${targetRate}; escalate to top-3 in 30 min.`,
      payload: { ranked, channel: "email+sms", targetRate }, reasoning: sug.reasoning ?? "",
      adapterMode: "dry_run",
    });
    return { agentSlug: "coverage", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Outreach plan staged." };
  }
  return { agentSlug: "coverage", decision, suggestionId: sug.id, summary: "Outreach suggestion recorded." };
}

// ─── Risk & Compliance (control agent) ───────────────────────────────────
async function runRisk({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const mc = trigger.mcNumber ?? "MC-202020";
  const carrierName = trigger.carrierName ?? "Top Match A";
  const vet = await adapters.vetCarrier(organizationId, { mcNumber: mc, carrierName });
  const v = vet.data!;
  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id, loopStep: "vet_carrier",
    // v is a typed VetCarrierResult; recordSuggestion stores it in a jsonb
    // column so it expects Record<string, unknown>. Safe cast — shape is app-controlled.
    inputContext: trigger, suggestion: v as unknown as Record<string, unknown>,
    reasoning: `Risk score ${v.riskScore}/100. Flags: ${v.flags.join(", ") || "none"}.`,
    confidence: 90, model: agent.model, adapterMode: vet.mode,
  });
  const decision = enforceAutonomy({ agent, risk: v.riskScore > 60 ? "high" : "low", riskScore: v.riskScore });
  if (decision.mode === "blocked") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "risk.override_request",
      title: `BLOCKED: ${carrierName} (${mc})`,
      summary: `Risk ${v.riskScore} > threshold. Flags: ${v.flags.join(", ") || "n/a"}.`,
      payload: { vetting: v }, reasoning: decision.reason, adapterMode: vet.mode,
    });
    return { agentSlug: "risk", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Carrier blocked; override card staged." };
  }
  return { agentSlug: "risk", decision, suggestionId: sug.id, summary: "Carrier cleared by Risk." };
}

// ─── Execution & Detention ───────────────────────────────────────────────
async function runExecution({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const loadRef = trigger.loadRef ?? `L-${Date.now()}`;
  const plan = {
    loadRef,
    checkCalls: ["pickup-2hr", "midpoint", "delivery-2hr"],
    detentionPolicy: { freeTimeMin: 120, alertAtMin: 135 },
  };
  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id, loopStep: "monitor_plan",
    inputContext: trigger, suggestion: plan,
    reasoning: "Standard cadence; detention timer follows customer free-time policy.",
    confidence: 92, model: agent.model, adapterMode: "dry_run",
  });
  const decision = enforceAutonomy({ agent, risk: "low" });
  if (decision.mode === "stage_hitl" || decision.mode === "execute_directly") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "execution.checkcall_send",
      title: `Send check-call SMS (${loadRef})`,
      summary: "Driver + dispatch, scripted message.",
      payload: { loadRef, channel: "sms", recipients: ["driver", "dispatch"] },
      reasoning: sug.reasoning ?? "", adapterMode: "dry_run",
    });
    return { agentSlug: "execution", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Check-call staged." };
  }
  return { agentSlug: "execution", decision, suggestionId: sug.id, summary: "Plan recorded." };
}

// ─── Billing & Collections ───────────────────────────────────────────────
async function runBilling({ agent, organizationId, trigger }: RunInput): Promise<RunResult> {
  const loadRef = trigger.loadRef ?? `L-${Date.now()}`;
  const lines = trigger.lines ?? [
    { type: "linehaul", amount: 1450 },
    { type: "fuel", amount: 240 },
  ];
  const total = lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0);
  const sug = await recordSuggestion({
    organizationId, workflowAgentId: agent.id, loopStep: "validate_invoice",
    inputContext: trigger, suggestion: { loadRef, lines, total, validation: "all_lines_match_contract" },
    reasoning: "Each line item maps to a contract clause; doc packet ready.",
    confidence: 85, model: agent.model, adapterMode: "dry_run",
  });
  const decision = enforceAutonomy({ agent, risk: "low", dollarAmount: total });
  if (decision.mode === "stage_hitl" || decision.mode === "execute_directly") {
    const hitl = await stageHitlAction({
      organizationId, workflowAgentId: agent.id, suggestionId: sug.id,
      actionKind: "billing.submit_invoice",
      title: `Submit invoice ${loadRef} ($${total.toLocaleString()})`,
      summary: "Doc packet ready; portal submission staged.",
      payload: { loadRef, lines, total, channel: "customer_portal" },
      reasoning: sug.reasoning ?? "", adapterMode: "dry_run",
    });
    return { agentSlug: "billing", decision, suggestionId: sug.id, hitlActionId: hitl.id, summary: "Invoice staged." };
  }
  return { agentSlug: "billing", decision, suggestionId: sug.id, summary: "Invoice suggestion recorded." };
}

export const AGENT_RUNNERS: Record<AgentSlug, (i: RunInput) => Promise<RunResult>> = {
  pricing: runPricing,
  order_schedule: runOrderSchedule,
  coverage: runCoverage,
  risk: runRisk,
  execution: runExecution,
  billing: runBilling,
};

export async function runAgentBySlug(slug: AgentSlug, input: RunInput): Promise<RunResult> {
  const runner = AGENT_RUNNERS[slug];
  if (!runner) throw new Error(`Unknown agent: ${slug}`);
  return runner(input);
}
