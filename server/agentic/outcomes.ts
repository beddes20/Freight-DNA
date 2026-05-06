/**
 * Outcome learning loop.
 *
 * Captures (a) realized business outcomes after an HITL action is executed and
 * (b) human overrides (approved-as-is vs edited vs rejected). Aggregates feed
 * the agent dashboards so we can see acceptance %, override rate, and
 * realized-metric trends per agent.
 */
import { db } from "../storage";
import { agentOutcomes, agentSuggestions, hitlActions, type InsertAgentOutcome, type InsertAgentSuggestion } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";

export async function recordSuggestion(input: InsertAgentSuggestion) {
  const [row] = await db.insert(agentSuggestions).values(input).returning();
  return row;
}

export async function recordOutcome(input: InsertAgentOutcome) {
  const [row] = await db.insert(agentOutcomes).values(input).returning();
  return row;
}

/** Acceptance / override / realized-metric stats for a single agent. */
export async function agentStats(orgId: string, workflowAgentId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const hitl = await db.select().from(hitlActions).where(and(
    eq(hitlActions.organizationId, orgId),
    eq(hitlActions.workflowAgentId, workflowAgentId),
    gte(hitlActions.createdAt, since),
  ));
  const total = hitl.length;
  const approved = hitl.filter((r) => r.status === "approved" || r.status === "executed").length;
  const rejected = hitl.filter((r) => r.status === "rejected").length;
  const edited = hitl.filter((r) => r.status === "edited").length;
  const pending = hitl.filter((r) => r.status === "pending").length;

  const outcomes = await db.select().from(agentOutcomes).where(and(
    eq(agentOutcomes.organizationId, orgId),
    eq(agentOutcomes.workflowAgentId, workflowAgentId),
    gte(agentOutcomes.recordedAt, since),
  ));

  const metricCount = outcomes.filter((o) => o.metricValue != null).length;
  const metricAvg = metricCount > 0
    ? outcomes.reduce((s, o) => s + Number(o.metricValue ?? 0), 0) / metricCount
    : null;

  return {
    windowDays: days,
    hitl: { total, pending, approved, rejected, edited, acceptanceRate: total ? approved / total : 0, overrideRate: total ? edited / total : 0 },
    outcomes: { count: outcomes.length, metricCount, metricAvg },
  };
}

export async function fleetStats(orgId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.select({
    workflowAgentId: hitlActions.workflowAgentId,
    status: hitlActions.status,
    count: sql<number>`count(*)::int`,
  }).from(hitlActions)
    .where(and(eq(hitlActions.organizationId, orgId), gte(hitlActions.createdAt, since)))
    .groupBy(hitlActions.workflowAgentId, hitlActions.status);
  const byAgent: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    byAgent[r.workflowAgentId] ??= {};
    byAgent[r.workflowAgentId][r.status] = r.count;
  }
  return { windowDays: days, byAgent };
}
