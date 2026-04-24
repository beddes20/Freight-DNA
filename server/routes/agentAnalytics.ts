/**
 * Task #360 — DNA Copilot Analytics, Feedback & Audit endpoints.
 *
 * All admin endpoints are gated to `role === "admin"`. Feedback POST is
 * authenticated (any logged-in rep) and scoped to their org.
 */
import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  agentActivity,
  copilotFeedback,
  copilotActions,
  insertCopilotFeedbackSchema,
  insertCopilotActionSchema,
} from "@shared/schema";
import { agentAnalyticsStorage } from "../agentAnalyticsStorage";

function isAdmin(role: string | null | undefined) {
  return role === "admin";
}

/**
 * Roles allowed to view org-wide copilot analytics. Per task #425 this opens
 * the page beyond admin to directors and sales directors so they can see how
 * their teams are using DNA without needing the full admin role.
 */
function isAnalyticsViewer(role: string | null | undefined) {
  return role === "admin" || role === "director" || role === "sales_director";
}

/**
 * Strip obvious secrets from a free-text "report this" payload before we
 * persist it. We never want a stack trace that includes an API key, bearer
 * token, or another org's row to land in the needs-attention queue.
 */
export function sanitizeReportText(input: string): string {
  if (!input) return "";
  let s = String(input).slice(0, 2000);
  // Strip common token shapes (Bearer X, sk-..., generic >=20-char hex/base64).
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  s = s.replace(/\b(sk|rk|pk|whsec|key|token|secret|password|pwd|apikey|api_key)[-_=:\s]+[A-Za-z0-9._\-]{8,}/gi, "$1=[redacted]");
  s = s.replace(/[A-Za-z0-9_\-]{32,}/g, (m) => (m.length >= 32 ? "[redacted]" : m));
  // Strip anything that looks like a UUID we can't attribute to this caller.
  // (We deliberately leave shorter IDs alone — they're not sensitive on their own.)
  return s;
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

      // Mirror onto agent_activity. Org-scoped to prevent cross-org IDOR.
      try {
        if (parsed.messageId) {
          await db.update(agentActivity)
            .set({ feedbackRating: parsed.rating })
            .where(and(
              eq(agentActivity.organizationId, me.organizationId),
              eq(agentActivity.messageId, parsed.messageId),
            ));
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

      // Idempotency via partial unique index on
      // (organizationId, messageId, tool) WHERE message_id IS NOT NULL.
      // The `where` predicate is required so Postgres can match the partial
      // index; without it ON CONFLICT throws "no unique or exclusion
      // constraint matching ON CONFLICT specification".
      let [row] = await db.insert(copilotActions)
        .values(parsed)
        .onConflictDoNothing({
          target: [copilotActions.organizationId, copilotActions.messageId, copilotActions.tool],
          where: sql`message_id IS NOT NULL`,
        })
        .returning();
      if (!row && parsed.messageId != null) {
        [row] = await db.select().from(copilotActions)
          .where(and(
            eq(copilotActions.organizationId, me.organizationId),
            eq(copilotActions.messageId, parsed.messageId),
            eq(copilotActions.tool, parsed.tool),
          ))
          .limit(1);
      }

      try {
        if (parsed.messageId) {
          await db.update(agentActivity)
            .set({ actionOutcome: parsed.result })
            .where(and(
              eq(agentActivity.organizationId, me.organizationId),
              eq(agentActivity.messageId, parsed.messageId),
            ));
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
  // All queries delegated to agentAnalyticsStorage so the org filter lives at
  // the data-access layer, not in the route handler. Route only does AUTHZ.
  app.get("/api/agent/analytics/overview", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAnalyticsViewer(me.role)) return res.status(403).json({ error: "Forbidden" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
      const overview = await agentAnalyticsStorage.getOverview(me.organizationId, days);
      res.json(overview);
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
      if (!isAnalyticsViewer(me.role)) return res.status(403).json({ error: "Forbidden" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14)));
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
      const rows = await agentAnalyticsStorage.getNeedsAttention(me.organizationId, days, limit);
      res.json(rows);
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
      if (!isAnalyticsViewer(me.role)) return res.status(403).json({ error: "Forbidden" });

      const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
      const rows = await agentAnalyticsStorage.getRecentActions(me.organizationId, days, limit);
      res.json(rows);
    } catch (err: any) {
      console.error("[agent-analytics] actions:", err);
      res.status(500).json({ error: "Failed to load actions" });
    }
  });

  // ─── Per-rep audit trail (visible to the rep + analytics viewers) ─────
  // Drives the "Recent DNA actions" section on the rep profile/report page.
  app.get("/api/agent/analytics/actions/by-user/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      const targetId = String(req.params.userId);

      // Org-scope at the storage layer — getUserInOrg returns undefined for
      // any user not in the caller's org, eliminating the IDOR path entirely.
      const { storage } = await import("../storage");
      const target = await storage.getUserInOrg(targetId, me.organizationId);
      if (!target) return res.status(404).json({ error: "User not found" });

      // Task #525: Director (and other team-scoped managers) may only view
      // copilot actions for reps inside their own reporting tree. Admin and
      // Sales Director keep their broader visibility for analytics.
      const { canSeeRepUser } = await import("../auth");
      const isSelf = me.id === targetId;
      const orgWideAnalytics = me.role === "admin" || me.role === "sales_director";
      const inTree = !isSelf && !orgWideAnalytics ? await canSeeRepUser(me, targetId) : true;
      if (!isSelf && !orgWideAnalytics && !inTree) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)));
      const rows = await agentAnalyticsStorage.getActionsByUser(me.organizationId, targetId, limit);
      res.json(rows);
    } catch (err: any) {
      console.error("[agent-analytics] actions/by-user:", err);
      res.status(500).json({ error: "Failed to load actions" });
    }
  });

  // ─── Per-account audit trail (drives the company activity feed entry) ──
  app.get("/api/agent/analytics/actions/by-company/:companyId", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      const companyId = String(req.params.companyId);

      const { storage } = await import("../storage");
      const company = await storage.getCompanyInOrg(companyId, me.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)));
      const rows = await agentAnalyticsStorage.getActionsByCompany(me.organizationId, companyId, limit);
      res.json(rows);
    } catch (err: any) {
      console.error("[agent-analytics] actions/by-company:", err);
      res.status(500).json({ error: "Failed to load actions" });
    }
  });

  // ─── Turn detail (admin/director — drives the needs-attention drawer) ──
  app.get("/api/agent/analytics/turns/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAnalyticsViewer(me.role)) return res.status(403).json({ error: "Forbidden" });

      const turn = await agentAnalyticsStorage.getTurnDetail(me.organizationId, String(req.params.id));
      if (!turn) return res.status(404).json({ error: "Turn not found" });
      res.json(turn);
    } catch (err: any) {
      console.error("[agent-analytics] turns/:id:", err);
      res.status(500).json({ error: "Failed to load turn" });
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
      // Reuse copilotFeedback as the inbox for "report this". Sanitize the
      // payload so we never persist tokens, secrets, or large opaque blobs
      // a stack trace might have carried in.
      const safe = sanitizeReportText(message);
      const [row] = await db.insert(copilotFeedback).values({
        organizationId: me.organizationId,
        userId: me.id,
        conversationRef: conversationRef ?? null,
        messageId: messageId ?? null,
        rating: "down",
        comment: `[error-report] ${safe}`,
      }).returning();
      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to send report" });
    }
  });
}
