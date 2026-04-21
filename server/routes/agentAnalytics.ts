/**
 * Task #360 — DNA Copilot Analytics, Feedback & Audit endpoints.
 *
 * All admin endpoints are gated to `role === "admin"`. Feedback POST is
 * authenticated (any logged-in rep) and scoped to their org.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, gte, sql, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  agentActivity,
  copilotFeedback,
  copilotActions,
  users,
  insertCopilotFeedbackSchema,
  insertCopilotActionSchema,
} from "@shared/schema";

function isAdmin(role: string | null | undefined) {
  return role === "admin";
}

function daysAgo(d: number): Date {
  const t = new Date();
  t.setDate(t.getDate() - d);
  return t;
}

export function registerAgentAnalyticsRoutes(app: Express) {
  // ─── Feedback (any rep, scoped to self/org) ────────────────────────────
  app.post("/api/agent/feedback", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });

      const schema = insertCopilotFeedbackSchema.extend({
        rating: z.enum(["up", "down"]),
        comment: z.string().max(2000).nullable().optional(),
      });
      const parsed = schema.parse({
        ...req.body,
        organizationId: me.organizationId,
        userId: me.id,
      });

      const [row] = await db.insert(copilotFeedback).values(parsed).returning();

      // Mirror onto agent_activity (most recent turn_complete in this convo).
      try {
        if (parsed.messageId) {
          await db.update(agentActivity)
            .set({ feedbackRating: parsed.rating })
            .where(eq(agentActivity.messageId, parsed.messageId));
        }
      } catch { /* non-fatal */ }

      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[agent-analytics] feedback:", err);
      res.status(500).json({ error: "Failed to record feedback" });
    }
  });

  // ─── Action audit ingestion (called from client after a confirm) ──────
  app.post("/api/agent/actions/audit", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });

      const schema = insertCopilotActionSchema.extend({
        tool: z.string().min(1).max(100),
        result: z.enum(["success", "failure", "dismissed"]).default("success"),
        errorMessage: z.string().max(2000).nullable().optional(),
      });
      const parsed = schema.parse({
        ...req.body,
        organizationId: me.organizationId,
        confirmedByUserId: me.id,
      });
      const [row] = await db.insert(copilotActions).values(parsed).returning();

      try {
        if (parsed.messageId) {
          await db.update(agentActivity)
            .set({ actionOutcome: parsed.result })
            .where(eq(agentActivity.messageId, parsed.messageId));
        }
      } catch { /* non-fatal */ }

      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[agent-analytics] audit:", err);
      res.status(500).json({ error: "Failed to record action" });
    }
  });

  // ─── Admin: overview ──────────────────────────────────────────────────
  app.get("/api/agent/analytics/overview", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
      const since = daysAgo(days);
      const orgFilter = eq(agentActivity.organizationId, me.organizationId);
      const sinceFilter = gte(agentActivity.createdAt, since);

      // Top user questions (inbound direction)
      const topQuestionsRaw = await db.execute(sql`
        SELECT lower(trim(summary)) as q, count(*)::int as n
        FROM ${agentActivity}
        WHERE organization_id = ${me.organizationId}
          AND direction = 'inbound'
          AND created_at >= ${since}
          AND summary IS NOT NULL
        GROUP BY lower(trim(summary))
        ORDER BY n DESC
        LIMIT 20
      `);
      const topQuestions = (topQuestionsRaw.rows as any[]).map((r) => ({ question: String(r.q ?? ""), count: Number(r.n ?? 0) }));

      // Tool mix
      const toolMixRaw = await db.execute(sql`
        SELECT tool, outcome, count(*)::int as n
        FROM ${agentActivity}
        WHERE organization_id = ${me.organizationId}
          AND direction = 'tool'
          AND created_at >= ${since}
          AND tool IS NOT NULL
        GROUP BY tool, outcome
        ORDER BY n DESC
      `);
      const toolMix = (toolMixRaw.rows as any[]).map((r) => ({
        tool: String(r.tool), outcome: String(r.outcome), count: Number(r.n),
      }));

      // Latency p50 / p95 over completed turns
      const latencyRaw = await db.execute(sql`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95,
          avg(latency_ms)::int as avg,
          count(*)::int as n
        FROM ${agentActivity}
        WHERE organization_id = ${me.organizationId}
          AND direction = 'turn_complete'
          AND created_at >= ${since}
          AND latency_ms IS NOT NULL
      `);
      const lat = (latencyRaw.rows as any[])[0] || {};

      // Outcome counts (turn_complete rows)
      const outcomesRaw = await db.execute(sql`
        SELECT outcome, count(*)::int as n
        FROM ${agentActivity}
        WHERE organization_id = ${me.organizationId}
          AND direction = 'turn_complete'
          AND created_at >= ${since}
        GROUP BY outcome
      `);
      const outcomes = (outcomesRaw.rows as any[]).map((r) => ({ outcome: String(r.outcome), count: Number(r.n) }));

      // Feedback ratio
      const fbRaw = await db.execute(sql`
        SELECT rating, count(*)::int as n
        FROM ${copilotFeedback}
        WHERE organization_id = ${me.organizationId}
          AND captured_at >= ${since}
        GROUP BY rating
      `);
      const feedback = (fbRaw.rows as any[]).reduce<Record<string, number>>((m, r) => {
        m[String(r.rating)] = Number(r.n);
        return m;
      }, { up: 0, down: 0 });

      // Weekly trend (turns per ISO week)
      const weeklyRaw = await db.execute(sql`
        SELECT date_trunc('week', created_at) as week,
               count(*)::int as turns,
               sum(CASE WHEN outcome != 'ok' THEN 1 ELSE 0 END)::int as failed,
               avg(CASE WHEN confidence IS NOT NULL THEN confidence ELSE NULL END)::float as avg_conf
        FROM ${agentActivity}
        WHERE organization_id = ${me.organizationId}
          AND direction = 'turn_complete'
          AND created_at >= ${daysAgo(Math.max(56, days))}
        GROUP BY week
        ORDER BY week ASC
      `);
      const weekly = (weeklyRaw.rows as any[]).map((r) => ({
        week: r.week instanceof Date ? r.week.toISOString().slice(0, 10) : String(r.week).slice(0, 10),
        turns: Number(r.turns),
        failed: Number(r.failed),
        avgConfidence: r.avg_conf == null ? null : Number(r.avg_conf),
      }));

      res.json({
        windowDays: days,
        topQuestions,
        toolMix,
        latency: {
          p50: lat.p50 == null ? null : Number(lat.p50),
          p95: lat.p95 == null ? null : Number(lat.p95),
          avg: lat.avg == null ? null : Number(lat.avg),
          count: lat.n == null ? 0 : Number(lat.n),
        },
        outcomes,
        feedback,
        weekly,
      });
    } catch (err: any) {
      console.error("[agent-analytics] overview:", err);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });

  // ─── Admin: needs attention queue ─────────────────────────────────────
  app.get("/api/agent/analytics/needs-attention", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14)));
      const since = daysAgo(days);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));

      // Failed / denied / low-confidence turns + every thumbs-down feedback row.
      const turnsRows = await db.select({
        id: agentActivity.id,
        userId: agentActivity.userId,
        conversationRef: agentActivity.conversationRef,
        messageId: agentActivity.messageId,
        summary: agentActivity.summary,
        outcome: agentActivity.outcome,
        confidence: agentActivity.confidence,
        route: agentActivity.route,
        feedbackRating: agentActivity.feedbackRating,
        actionOutcome: agentActivity.actionOutcome,
        latencyMs: agentActivity.latencyMs,
        errorMessage: agentActivity.errorMessage,
        createdAt: agentActivity.createdAt,
      })
        .from(agentActivity)
        .where(and(
          eq(agentActivity.organizationId, me.organizationId),
          eq(agentActivity.direction, "turn_complete"),
          gte(agentActivity.createdAt, since),
          sql`(outcome IN ('error','tool_error','denied','low_confidence') OR feedback_rating = 'down')`,
        ))
        .orderBy(desc(agentActivity.createdAt))
        .limit(limit);

      const ids = Array.from(new Set(turnsRows.map((r) => r.userId)));
      const nameRows = ids.length
        ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
        : [];
      const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));

      // Pull associated comments where present
      const msgIds = turnsRows.map((r) => r.messageId).filter((x): x is number => x != null);
      const comments = msgIds.length
        ? await db.select().from(copilotFeedback).where(inArray(copilotFeedback.messageId, msgIds))
        : [];
      const commentByMsg = new Map<number, string>();
      for (const c of comments) {
        if (c.messageId != null && c.comment) commentByMsg.set(c.messageId, c.comment);
      }

      res.json(turnsRows.map((r) => ({
        ...r,
        userName: nameMap.get(r.userId) ?? "Unknown",
        feedbackComment: r.messageId != null ? (commentByMsg.get(r.messageId) ?? null) : null,
      })));
    } catch (err: any) {
      console.error("[agent-analytics] needs-attention:", err);
      res.status(500).json({ error: "Failed to load queue" });
    }
  });

  // ─── Admin: recent confirmed actions audit trail ──────────────────────
  app.get("/api/agent/analytics/actions", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
      const since = daysAgo(days);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));

      const rows = await db.select()
        .from(copilotActions)
        .where(and(
          eq(copilotActions.organizationId, me.organizationId),
          gte(copilotActions.completedAt, since),
        ))
        .orderBy(desc(copilotActions.completedAt))
        .limit(limit);

      const ids = Array.from(new Set(rows.map((r) => r.confirmedByUserId)));
      const nameRows = ids.length
        ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
        : [];
      const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));
      res.json(rows.map((r) => ({ ...r, userName: nameMap.get(r.confirmedByUserId) ?? "Unknown" })));
    } catch (err: any) {
      console.error("[agent-analytics] actions:", err);
      res.status(500).json({ error: "Failed to load actions" });
    }
  });

  // ─── Friendly error report (anyone) ───────────────────────────────────
  app.post("/api/agent/error-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        conversationRef: z.string().max(100).nullable().optional(),
        messageId: z.number().int().nullable().optional(),
        message: z.string().max(2000),
      });
      const { conversationRef, messageId, message } = schema.parse(req.body);
      // Reuse copilotFeedback as the inbox for "report this"
      const [row] = await db.insert(copilotFeedback).values({
        organizationId: me.organizationId,
        userId: me.id,
        conversationRef: conversationRef ?? null,
        messageId: messageId ?? null,
        rating: "down",
        comment: `[error-report] ${message}`,
      }).returning();
      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to send report" });
    }
  });
}
