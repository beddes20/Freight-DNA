/**
 * Copilot Intelligence routes — Task #926 step 7.
 *
 * Endpoints:
 *   GET    /api/copilot/intelligence/by-doc/:docId     intelligence rows
 *   GET    /api/copilot/extractions/by-doc/:docId      extraction payload(s)
 *   GET    /api/copilot/plays/by-doc/:docId            ranked plays
 *   GET    /api/copilot/plays/by-customer/:companyId   embedded recs
 *   GET    /api/copilot/plays/by-lane/:laneKey         embedded recs
 *   POST   /api/copilot/plays/:id/accept|dismiss|snooze|override
 *   POST   /api/copilot/plays/:id/outcome              realized outcome
 *   GET    /api/copilot/admin/extraction-rates         admin metrics
 *   GET    /api/copilot/admin/play-acceptance          admin metrics
 *   GET    /api/copilot/admin/adjustments              current learning factors
 *
 * All endpoints require auth + scope by `organizationId`. Per-rep visibility
 * is delegated to the existing `canAccessCompany` helper for company-scoped
 * surfaces; doc-scoped surfaces inherit the document's scope.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, eq, sql, desc, gte } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import { requireAuth, getCurrentUser, canAccessCompany } from "../auth";
import { canInvoke } from "../agent/permissions";
import { pStr } from "../lib/req";
import {
  documentExtractions,
  copilotIntelligence,
  copilotPlayRecommendations,
  copilotOutcomes,
  copilotAdjustments,
  copilotActions,
  documents,
  type CopilotPlayRecommendation,
} from "@shared/schema";
import {
  resolveRecommendation,
  listOpenRecommendationsForCustomer,
  listOpenRecommendationsForLane,
  listRecommendationsForDocument,
} from "../services/copilot/copilotPlayCaller";
import { runExtractionForDocument } from "../services/copilot/copilotExtractionEngine";
import { computeIntelligenceForDocument } from "../services/copilot/copilotIntelligenceEngine";
import { recommendPlaysForDocument } from "../services/copilot/copilotPlayCaller";

async function assertDocVisible(req: Request, docId: string) {
  const user = await getCurrentUser(req);
  if (!user) return { ok: false as const, status: 401, msg: "unauthorized" };
  const [doc] = await db.select().from(documents).where(and(
    eq(documents.id, docId),
    eq(documents.organizationId, user.organizationId),
  )).limit(1);
  if (!doc) return { ok: false as const, status: 404, msg: "doc_not_found" };

  // Company-level visibility: if the doc is pinned to a company in its
  // upload context, gate access through canAccessCompany so a rep can't
  // see a doc tied to another rep's customer just because it's in the
  // same org. Uploader always retains access. Admins are exempt because
  // canAccessCompany already short-circuits for them.
  const upload = (doc.uploadContext as { companyId?: string; entityType?: string; entityId?: string } | null) ?? null;
  const pinnedCompanyId = upload?.companyId
    ?? (upload?.entityType === "company" ? upload?.entityId : null)
    ?? null;
  if (pinnedCompanyId && doc.uploaderId !== user.id) {
    const ok = await canAccessCompany(user, pinnedCompanyId);
    if (!ok) return { ok: false as const, status: 403, msg: "forbidden" };
  }
  return { ok: true as const, user, doc };
}

/**
 * Filter a list of recommendations down to ones the rep is allowed to see.
 * Recs without a customerId are visible to anyone in the org (lane-only
 * plays); recs with a customerId require canAccessCompany to pass.
 */
async function filterRecsByCompanyAccess<T extends { customerId: string | null }>(
  user: { id: string; organizationId: string; role: string },
  rows: T[],
): Promise<T[]> {
  if (user.role === "admin") return rows;
  const out: T[] = [];
  const cache = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.customerId) { out.push(r); continue; }
    let allowed = cache.get(r.customerId);
    if (allowed === undefined) {
      allowed = await canAccessCompany(user as never, r.customerId);
      cache.set(r.customerId, allowed);
    }
    if (allowed) out.push(r);
  }
  return out;
}

/**
 * Test-only re-export of the company-access filter so leakage tests can
 * exercise it without standing up an Express stack. Not part of the public
 * route surface — name is `__test` prefixed to keep callers honest.
 */
export const __testFilterRecsByCompanyAccess = filterRecsByCompanyAccess;

const resolveBodySchema = z.object({
  action: z.enum(["accepted", "dismissed", "snoozed", "overridden"]),
  snoozedUntil: z.string().datetime().optional(),
  overrideNote: z.string().max(2000).optional(),
});

const outcomeBodySchema = z.object({
  realizedOutcome: z.enum(["won", "lost", "partial", "no_response", "unknown"]),
  realizedDollarImpact: z.number().nullable().optional(),
  signals: z.record(z.string(), z.unknown()).optional(),
});

export function registerCopilotIntelligenceRoutes(app: Express): void {
  // ─── GET intelligence by document ─────────────────────────────────────
  app.get("/api/copilot/intelligence/by-doc/:docId", requireAuth, async (req, res) => {
    try {
      const guard = await assertDocVisible(req, pStr(req.params.docId));
      if (!guard.ok) return res.status(guard.status).json({ error: guard.msg });
      const rows = await db
        .select()
        .from(copilotIntelligence)
        .where(and(
          eq(copilotIntelligence.organizationId, guard.user.organizationId),
          eq(copilotIntelligence.documentId, pStr(req.params.docId)),
        ))
        .orderBy(desc(copilotIntelligence.computedAt));
      res.json({ intelligence: rows });
    } catch (err) {
      console.error("[copilotIntelligence] by-doc failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── GET extractions by document ──────────────────────────────────────
  app.get("/api/copilot/extractions/by-doc/:docId", requireAuth, async (req, res) => {
    try {
      const guard = await assertDocVisible(req, pStr(req.params.docId));
      if (!guard.ok) return res.status(guard.status).json({ error: guard.msg });
      const rows = await db
        .select()
        .from(documentExtractions)
        .where(and(
          eq(documentExtractions.organizationId, guard.user.organizationId),
          eq(documentExtractions.documentId, pStr(req.params.docId)),
        ))
        .orderBy(desc(documentExtractions.extractedAt));
      res.json({ extractions: rows, document: guard.doc });
    } catch (err) {
      console.error("[copilotIntelligence] extractions/by-doc failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── POST re-run pipeline for a doc (admin/owner only) ────────────────
  app.post("/api/copilot/extractions/by-doc/:docId/run", requireAuth, async (req, res) => {
    try {
      const guard = await assertDocVisible(req, pStr(req.params.docId));
      if (!guard.ok) return res.status(guard.status).json({ error: guard.msg });
      if (guard.user.id !== guard.doc.uploaderId && guard.user.role !== "admin") {
        return res.status(403).json({ error: "forbidden" });
      }
      const ex = await runExtractionForDocument(guard.doc, { force: req.body?.force === true });
      let intels: unknown[] = [];
      if (ex.extraction) {
        const computed = await computeIntelligenceForDocument({ document: guard.doc, extraction: ex.extraction });
        for (const i of computed) {
          await recommendPlaysForDocument({ document: guard.doc, extraction: ex.extraction, intelligence: i });
        }
        intels = computed;
      }
      res.json({ extraction: ex.extraction, intelligence: intels, reason: ex.reason });
    } catch (err) {
      console.error("[copilotIntelligence] re-run failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── GET plays by document ────────────────────────────────────────────
  app.get("/api/copilot/plays/by-doc/:docId", requireAuth, async (req, res) => {
    try {
      const guard = await assertDocVisible(req, pStr(req.params.docId));
      if (!guard.ok) return res.status(guard.status).json({ error: guard.msg });
      const rows = await listRecommendationsForDocument(guard.user.organizationId, pStr(req.params.docId));
      const visible = await filterRecsByCompanyAccess(guard.user, rows);
      res.json({ plays: visible });
    } catch (err) {
      console.error("[copilotIntelligence] plays/by-doc failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── GET embedded plays by customer ───────────────────────────────────
  app.get("/api/copilot/plays/by-customer/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const ok = await canAccessCompany(user, pStr(req.params.companyId));
      if (!ok) return res.status(403).json({ error: "forbidden" });
      const rows = await listOpenRecommendationsForCustomer(user.organizationId, pStr(req.params.companyId));
      res.json({ plays: rows });
    } catch (err) {
      console.error("[copilotIntelligence] plays/by-customer failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── GET embedded plays by lane key ───────────────────────────────────
  // Per-row company visibility is enforced via filterRecsByCompanyAccess so
  // a rep can't enumerate lane keys to view recommendations attached to
  // customers outside their visible-company set.
  app.get("/api/copilot/plays/by-lane/:laneKey", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const rows = await listOpenRecommendationsForLane(user.organizationId, pStr(req.params.laneKey));
      const visible = await filterRecsByCompanyAccess(user, rows);
      res.json({ plays: visible });
    } catch (err) {
      console.error("[copilotIntelligence] plays/by-lane failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── POST resolve a play (accept/dismiss/snooze/override) ─────────────
  app.post("/api/copilot/plays/:id/resolve", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const decision = await canInvoke(user, "write.copilot.recommend");
      if (!decision.allowed) return res.status(403).json({ error: decision.reason });
      const parsed = resolveBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "bad_payload", issues: parsed.error.issues });

      // Confirm the rec belongs to this org first.
      const [existing] = await db.select().from(copilotPlayRecommendations).where(and(
        eq(copilotPlayRecommendations.id, pStr(req.params.id)),
        eq(copilotPlayRecommendations.organizationId, user.organizationId),
      )).limit(1);
      if (!existing) return res.status(404).json({ error: "rec_not_found" });

      const updated = await resolveRecommendation({
        organizationId: user.organizationId,
        recommendationId: pStr(req.params.id),
        userId: user.id,
        action: parsed.data.action,
        snoozedUntil: parsed.data.snoozedUntil ? new Date(parsed.data.snoozedUntil) : null,
        overrideNote: parsed.data.overrideNote ?? null,
      });

      // Append outcome row capturing the rep action.
      await db.insert(copilotOutcomes).values({
        organizationId: user.organizationId,
        recommendationId: pStr(req.params.id),
        userId: user.id,
        repAction: parsed.data.action === "accepted" ? "accepted" : parsed.data.action === "overridden" ? "overridden" : parsed.data.action === "snoozed" ? "snoozed" : "dismissed",
        repEdits: parsed.data.overrideNote ? { note: parsed.data.overrideNote } : null,
        realizedOutcome: null,
        signals: null,
      }).onConflictDoNothing({ target: copilotOutcomes.recommendationId });

      // Audit row to copilot_actions for parity with #97 audit.
      await db.insert(copilotActions).values({
        organizationId: user.organizationId,
        confirmedByUserId: user.id,
        conversationRef: null,
        messageId: null,
        tool: `copilot_play.${parsed.data.action}`,
        args: { recommendationId: pStr(req.params.id), playId: existing.playId },
        result: "success",
        relatedCompanyId: existing.customerId ?? null,
      });

      res.json({ recommendation: updated });
    } catch (err) {
      console.error("[copilotIntelligence] resolve failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── POST realized outcome (won/lost/etc) ─────────────────────────────
  app.post("/api/copilot/plays/:id/outcome", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      const parsed = outcomeBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "bad_payload", issues: parsed.error.issues });

      const [existing] = await db.select().from(copilotPlayRecommendations).where(and(
        eq(copilotPlayRecommendations.id, pStr(req.params.id)),
        eq(copilotPlayRecommendations.organizationId, user.organizationId),
      )).limit(1);
      if (!existing) return res.status(404).json({ error: "rec_not_found" });

      const [row] = await db.insert(copilotOutcomes).values({
        organizationId: user.organizationId,
        recommendationId: pStr(req.params.id),
        userId: user.id,
        repAction: existing.status === "accepted" ? "accepted" : existing.status === "overridden" ? "overridden" : "ignored",
        realizedOutcome: parsed.data.realizedOutcome,
        realizedDollarImpact: parsed.data.realizedDollarImpact != null ? String(parsed.data.realizedDollarImpact) : null,
        realizedAt: new Date(),
        signals: (parsed.data.signals ?? null) as object | null,
      }).onConflictDoUpdate({
        target: copilotOutcomes.recommendationId,
        set: {
          realizedOutcome: parsed.data.realizedOutcome,
          realizedDollarImpact: parsed.data.realizedDollarImpact != null ? String(parsed.data.realizedDollarImpact) : null,
          realizedAt: new Date(),
          signals: (parsed.data.signals ?? null) as object | null,
        },
      }).returning();
      res.json({ outcome: row });
    } catch (err) {
      console.error("[copilotIntelligence] outcome failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ─── Admin metrics ────────────────────────────────────────────────────
  app.get("/api/copilot/admin/extraction-rates", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const since = new Date(Date.now() - 30 * 86400000);
      const totals = await db.execute(sql`
        SELECT d.class_label as class, COUNT(*) as docs,
          COUNT(DISTINCT e.document_id) as extracted
        FROM ${documents} d
        LEFT JOIN ${documentExtractions} e ON e.document_id = d.id
        WHERE d.organization_id = ${user.organizationId}
          AND d.created_at >= ${since}
        GROUP BY d.class_label
        ORDER BY docs DESC
      `);
      res.json({ rows: totals.rows });
    } catch (err) {
      console.error("[copilotIntelligence] admin extraction rates failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.get("/api/copilot/admin/play-acceptance", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const since = new Date(Date.now() - 30 * 86400000);
      const stats = await db.execute(sql`
        SELECT play_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
          SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed,
          SUM(CASE WHEN status = 'overridden' THEN 1 ELSE 0 END) as overridden,
          SUM(CASE WHEN status = 'snoozed' THEN 1 ELSE 0 END) as snoozed
        FROM ${copilotPlayRecommendations}
        WHERE organization_id = ${user.organizationId}
          AND created_at >= ${since}
        GROUP BY play_id
        ORDER BY total DESC
      `);
      // Win rate: accepted recs that have realized=won / accepted recs that have any outcome
      const wins = await db.execute(sql`
        SELECT r.play_id,
          SUM(CASE WHEN o.realized_outcome = 'won' AND r.status = 'accepted' THEN 1 ELSE 0 END) as won_accepted,
          SUM(CASE WHEN o.realized_outcome = 'won' AND r.status = 'overridden' THEN 1 ELSE 0 END) as won_overridden,
          SUM(CASE WHEN o.realized_outcome IS NOT NULL THEN 1 ELSE 0 END) as outcomes
        FROM ${copilotPlayRecommendations} r
        JOIN ${copilotOutcomes} o ON o.recommendation_id = r.id
        WHERE r.organization_id = ${user.organizationId}
          AND r.created_at >= ${since}
        GROUP BY r.play_id
      `);
      res.json({ acceptance: stats.rows, winRates: wins.rows });
    } catch (err) {
      console.error("[copilotIntelligence] admin play acceptance failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.get("/api/copilot/admin/adjustments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const rows = await db
        .select()
        .from(copilotAdjustments)
        .where(eq(copilotAdjustments.organizationId, user.organizationId))
        .orderBy(desc(copilotAdjustments.computedAt))
        .limit(200);
      res.json({ adjustments: rows });
    } catch (err) {
      console.error("[copilotIntelligence] admin adjustments failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });
}
