/**
 * /api/ai-center — unified AI Center management module.
 *
 * Surfaces both kinds of agents (callable chat agents from `agents` and
 * outcome-owning workflow agents from `workflow_agents`) as a single fleet
 * for the consolidated `/ai` admin UI. Backed by the same underlying tables
 * — no new persistence; this is a read-side aggregation layer.
 */
import type { Express, Request, Response } from "express";
import { db } from "../storage";
import { eq } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../auth";
import { agents, workflowAgents, type Agent, type WorkflowAgent } from "@shared/schema";
import { ensureWorkflowAgentsForOrg } from "../agentic/registry";
import { fleetStats } from "../agentic/outcomes";

async function ctxFor(req: Request, res: Response) {
  const u = await getCurrentUser(req);
  if (!u || !u.organizationId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { userId: u.id, organizationId: u.organizationId, role: u.role as string | undefined };
}

export function registerAiCenterRoutes(app: Express) {
  /**
   * Unified fleet — every agent the org has, regardless of kind.
   * Returns:
   *   callable[]  – chat agents from `agents` (powering ValueIQ / DNA conversations)
   *   workflow[]  – outcome-owning bots from `workflow_agents` (autonomy, HITL)
   *   stats       – workflow agent suggestion/HITL counts (last 30 days)
   */
  app.get("/api/ai-center/fleet", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;

    // Make sure the workflow agents exist for this org so the fleet list isn't
    // empty on first visit. The callable agents are seeded elsewhere.
    const workflow = await ensureWorkflowAgentsForOrg(ctx.organizationId);
    const callable: Agent[] = await db.select().from(agents).where(eq(agents.organizationId, ctx.organizationId));
    const stats = await fleetStats(ctx.organizationId, 30);

    const summary = {
      callableCount: callable.length,
      workflowCount: workflow.length,
      enabledWorkflowCount: workflow.filter((w: WorkflowAgent) => w.enabled).length,
      autonomyMix: workflow.reduce<Record<string, number>>((acc, w) => {
        acc[w.autonomy] = (acc[w.autonomy] ?? 0) + 1;
        return acc;
      }, {}),
    };

    res.json({ callable, workflow, stats, summary });
  });
}
