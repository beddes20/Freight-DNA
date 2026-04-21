/**
 * /api/agentic — workflow agent fleet, HITL inbox, pods, adapters, runs.
 */
import type { Express, Request, Response } from "express";
import { db } from "../storage";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../auth";
import {
  workflowAgents, pods, podMembers, podAgents, hitlActions, agentSuggestions, agentOutcomes,
  insertPodSchema, insertAgentOutcomeSchema,
} from "@shared/schema";
import { ensureWorkflowAgentsForOrg, getWorkflowAgent, AGENT_DEFS, AGENT_SLUGS, type AgentSlug } from "../agentic/registry";
import { listAdapterStatuses, upsertAdapterStatus, ALL_ADAPTERS, type AdapterKey } from "../agentic/adapters";
import { listInbox, decide, markExecuted, inboxCounts } from "../agentic/hitl";
import { recordOutcome, agentStats, fleetStats } from "../agentic/outcomes";
import { runAgentBySlug } from "../agentic/agents";

async function ctxFor(req: Request, res: Response) {
  const u = await getCurrentUser(req);
  if (!u || !u.organizationId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { userId: u.id, organizationId: u.organizationId, role: u.role as string | undefined };
}

export function registerAgenticRoutes(app: Express) {
  // ─── Fleet ────────────────────────────────────────────────
  app.get("/api/agentic/agents", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const rows = await ensureWorkflowAgentsForOrg(ctx.organizationId);
    const stats = await fleetStats(ctx.organizationId, 30);
    res.json({ agents: rows, stats });
  });

  app.get("/api/agentic/agents/:slug", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    await ensureWorkflowAgentsForOrg(ctx.organizationId);
    const agent = await getWorkflowAgent(ctx.organizationId, req.params.slug);
    if (!agent) return res.status(404).json({ error: "not_found" });
    const def = AGENT_DEFS[agent.slug as AgentSlug];
    const stats = await agentStats(ctx.organizationId, agent.id, 30);
    const recentSuggestions = await db.select().from(agentSuggestions)
      .where(and(eq(agentSuggestions.organizationId, ctx.organizationId), eq(agentSuggestions.workflowAgentId, agent.id)))
      .orderBy(desc(agentSuggestions.createdAt)).limit(20);
    const recentHitl = await db.select().from(hitlActions)
      .where(and(eq(hitlActions.organizationId, ctx.organizationId), eq(hitlActions.workflowAgentId, agent.id)))
      .orderBy(desc(hitlActions.createdAt)).limit(20);
    res.json({ agent, definition: def, stats, recentSuggestions, recentHitl });
  });

  app.patch("/api/agentic/agents/:slug", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    if (ctx.role && !["admin", "manager"].includes(ctx.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    const agent = await getWorkflowAgent(ctx.organizationId, req.params.slug);
    if (!agent) return res.status(404).json({ error: "not_found" });
    const allowed: any = {};
    for (const k of ["autonomy", "enabled", "scope", "guardrails", "triggers", "personaOverlay", "model", "killSwitch", "name", "description"]) {
      if (k in req.body) allowed[k] = req.body[k];
    }
    allowed.updatedAt = new Date();
    const [row] = await db.update(workflowAgents).set(allowed).where(eq(workflowAgents.id, agent.id)).returning();
    res.json({ agent: row });
  });

  app.post("/api/agentic/agents/:slug/run", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const agent = await getWorkflowAgent(ctx.organizationId, req.params.slug);
    if (!agent) return res.status(404).json({ error: "not_found" });
    if (!AGENT_SLUGS.includes(agent.slug as AgentSlug)) return res.status(400).json({ error: "unsupported_slug" });
    try {
      const result = await runAgentBySlug(agent.slug as AgentSlug, {
        agent, organizationId: ctx.organizationId, trigger: req.body?.trigger ?? {},
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "run_failed", message: e.message });
    }
  });

  // ─── HITL Inbox / Approvals ───────────────────────────────
  app.get("/api/agentic/inbox", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const status = (req.query.status as string)?.split(",").filter(Boolean) as any[] | undefined;
    const podId = req.query.podId as string | undefined;
    const items = await listInbox(ctx.organizationId, { status: status?.length ? status : ["pending"], podId, limit: 200 });
    const counts = await inboxCounts(ctx.organizationId);
    res.json({ items, counts });
  });

  app.post("/api/agentic/inbox/:id/decision", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const { decision, decisionNote, payloadOverride } = req.body ?? {};
    if (!["approved", "rejected", "edited"].includes(decision)) return res.status(400).json({ error: "bad_decision" });
    const row = await decide({
      id: req.params.id, organizationId: ctx.organizationId,
      decidedByUserId: ctx.userId, decision, decisionNote, payloadOverride,
    });
    if (!row) return res.status(404).json({ error: "not_found" });
    if (decision === "approved") {
      const exec = await markExecuted(row.id, true, "Executed in dry-run mode");
      await recordOutcome({
        organizationId: ctx.organizationId,
        workflowAgentId: row.workflowAgentId,
        suggestionId: row.suggestionId ?? null,
        hitlActionId: row.id,
        overrideKind: "approved_as_is",
        recordedBy: ctx.userId,
      });
      return res.json({ action: exec });
    }
    if (decision === "edited") {
      await recordOutcome({
        organizationId: ctx.organizationId, workflowAgentId: row.workflowAgentId,
        suggestionId: row.suggestionId ?? null, hitlActionId: row.id,
        overrideKind: "edited", recordedBy: ctx.userId,
      });
    } else {
      await recordOutcome({
        organizationId: ctx.organizationId, workflowAgentId: row.workflowAgentId,
        suggestionId: row.suggestionId ?? null, hitlActionId: row.id,
        overrideKind: "rejected", notes: decisionNote ?? null, recordedBy: ctx.userId,
      });
    }
    res.json({ action: row });
  });

  app.post("/api/agentic/outcomes", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const parsed = insertAgentOutcomeSchema.safeParse({ ...req.body, organizationId: ctx.organizationId, recordedBy: ctx.userId });
    if (!parsed.success) return res.status(400).json({ error: "invalid", issues: parsed.error.issues });
    const row = await recordOutcome(parsed.data);
    res.json({ outcome: row });
  });

  // ─── Pods ─────────────────────────────────────────────────
  app.get("/api/agentic/pods", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const rows = await db.select().from(pods).where(eq(pods.organizationId, ctx.organizationId)).orderBy(desc(pods.createdAt));
    res.json({ pods: rows });
  });

  app.post("/api/agentic/pods", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    if (ctx.role && !["admin", "manager"].includes(ctx.role)) return res.status(403).json({ error: "forbidden" });
    const parsed = insertPodSchema.safeParse({ ...req.body, organizationId: ctx.organizationId });
    if (!parsed.success) return res.status(400).json({ error: "invalid", issues: parsed.error.issues });
    const [row] = await db.insert(pods).values(parsed.data).returning();
    res.json({ pod: row });
  });

  app.get("/api/agentic/pods/:id", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const [pod] = await db.select().from(pods)
      .where(and(eq(pods.id, req.params.id), eq(pods.organizationId, ctx.organizationId))).limit(1);
    if (!pod) return res.status(404).json({ error: "not_found" });
    const members = await db.select().from(podMembers).where(eq(podMembers.podId, pod.id));
    const agentLinks = await db.select().from(podAgents).where(eq(podAgents.podId, pod.id));
    const inbox = await listInbox(ctx.organizationId, { podId: pod.id, status: ["pending"], limit: 100 });
    res.json({ pod, members, agents: agentLinks, pendingInbox: inbox });
  });

  // ─── Adapters / Rollout ───────────────────────────────────
  app.get("/api/agentic/adapters", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    const rows = await listAdapterStatuses(ctx.organizationId);
    res.json({ adapters: rows });
  });

  app.patch("/api/agentic/adapters/:key", requireAuth, async (req, res) => {
    const ctx = await ctxFor(req, res); if (!ctx) return;
    if (ctx.role && !["admin"].includes(ctx.role)) return res.status(403).json({ error: "forbidden" });
    const key = req.params.key as AdapterKey;
    if (!ALL_ADAPTERS.includes(key)) return res.status(400).json({ error: "unknown_adapter" });
    const row = await upsertAdapterStatus({
      organizationId: ctx.organizationId, adapterKey: key,
      mode: req.body?.mode, credentialsConfigured: req.body?.credentialsConfigured,
      notes: req.body?.notes, updatedBy: ctx.userId,
    });
    res.json({ adapter: row });
  });
}
