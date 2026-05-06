/**
 * Autonomy ladder enforcement.
 *
 *   off       — agent does nothing
 *   suggest   — agent records a suggestion only (no action staged)
 *   draft     — agent stages the action in the HITL inbox; human must approve
 *   auto_hitl — agent stages, AND auto-approves low-risk actions; high-risk still HITL
 *   auto      — agent executes immediately, subject to guardrails
 *
 * All decisions go through `enforceAutonomy()` so the rules are uniform across
 * the six agents and cannot be bypassed from the UI.
 */
import type { WorkflowAgent } from "@shared/schema";
import type { Autonomy } from "./registry";

export type ActionRisk = "low" | "medium" | "high";

export interface EnforceArgs {
  agent: WorkflowAgent;
  podOverride?: Autonomy | null;
  risk: ActionRisk;
  /** Dollar amount the action would commit, if applicable. */
  dollarAmount?: number;
  /** Risk score (0–100) from Risk agent, if relevant. */
  riskScore?: number;
}

export type EnforceDecision =
  | { mode: "skip"; reason: string }
  | { mode: "suggest_only" }
  | { mode: "stage_hitl" }
  | { mode: "execute_directly" }
  | { mode: "blocked"; reason: string };

export function effectiveAutonomy(agent: WorkflowAgent, podOverride?: Autonomy | null): Autonomy {
  if (agent.killSwitch) return "off";
  if (!agent.enabled) return "off";
  if (podOverride) return podOverride;
  return (agent.autonomy as Autonomy) || "off";
}

export function enforceAutonomy(args: EnforceArgs): EnforceDecision {
  const auto = effectiveAutonomy(args.agent, args.podOverride);
  if (auto === "off") return { mode: "skip", reason: "Agent autonomy is OFF for this scope." };

  // Guardrails
  const g = args.agent.guardrails ?? {};
  if (g.maxDollarPerAction != null && args.dollarAmount != null && args.dollarAmount > g.maxDollarPerAction) {
    return { mode: "blocked", reason: `Action exceeds dollar cap ($${g.maxDollarPerAction}).` };
  }
  if (g.maxRiskScore != null && args.riskScore != null && args.riskScore > g.maxRiskScore) {
    return { mode: "blocked", reason: `Risk score ${args.riskScore} exceeds threshold ${g.maxRiskScore}.` };
  }
  // Allowed-hours window
  if (g.allowedHoursStart && g.allowedHoursEnd) {
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = g.allowedHoursStart.split(":").map(Number);
    const [eh, em] = g.allowedHoursEnd.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (cur < start || cur > end) {
      return { mode: "blocked", reason: `Outside allowed window (${g.allowedHoursStart}–${g.allowedHoursEnd}).` };
    }
  }

  if (auto === "suggest") return { mode: "suggest_only" };
  if (auto === "draft") return { mode: "stage_hitl" };
  if (auto === "auto_hitl") {
    return args.risk === "low" ? { mode: "execute_directly" } : { mode: "stage_hitl" };
  }
  // auto — but high-risk actions always still go to HITL as a safety net
  if (args.risk === "high") return { mode: "stage_hitl" };
  return { mode: "execute_directly" };
}
