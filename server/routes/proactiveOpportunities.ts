/**
 * Proactive Available Freight Outreach Engine — read-only routes (Phase 2).
 *
 * GET   /api/freight-opportunities                         list with filters
 * GET   /api/freight-opportunities/:id                     detail + ranked carriers + audit
 * GET   /api/companies/:id/outreach-policy                 fetch (or default) policy
 * PATCH /api/companies/:id/outreach-policy                 upsert policy
 *
 * No send/queue endpoints in Phase 2.
 */

import type { Express } from "express";
import multer from "multer";
import XLSX from "xlsx";
import { requireAuth, getCurrentUser } from "../auth";
import { storage, db } from "../storage";
import { freightOpportunityCarriers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { runImportFromWorkbook as runAvailableFreightImportFromWorkbook } from "../availableFreightImporter";
import { loadEffectivePolicy, ensureShortlistRanked } from "../proactiveOpportunityService";
import {
  buildOpportunityDraft,
  cancelPendingWaves,
  feedbackToCarrierIntel,
  getOrSeedTemplate,
  sendOpportunityWave,
} from "../freightOpportunityOutreachService";
import {
  FREIGHT_OPPORTUNITY_MODES,
  FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES,
  FREIGHT_OPPORTUNITY_STATUSES,
  FREIGHT_OUTREACH_TEMPLATE_KINDS,
  type FreightOutreachTemplateKind,
  type InsertCompanyOutreachPolicy,
} from "@shared/schema";

function orgId(req: Express.Request): string {
  return (req as any).session?.organizationId as string;
}
function userId(req: Express.Request): string | null {
  return (req as any).session?.userId ?? null;
}

// In-flight rank coordination. Concurrent detail requests for the same
// opportunity share the same in-flight Promise instead of each kicking off
// their own rank (which previously caused the server to hammer the ranker
// every 3s while the frontend polled).
const RANK_TIMEOUT_MS = 25_000;
const inflightRanks = new Map<string, Promise<{ ranked: boolean; carriers: any[]; error?: string }>>();
function runOrJoinRank(opp: import("@shared/schema").FreightOpportunity) {
  const existing = inflightRanks.get(opp.id);
  if (existing) return existing;
  const started = Date.now();
  const p = (async () => {
    try {
      const result = await Promise.race([
        ensureShortlistRanked(storage, opp),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Carrier ranking timed out")), RANK_TIMEOUT_MS),
        ),
      ]);
      console.log(
        `[freight-opps] inline rank ${opp.id} done in ${Date.now() - started}ms ` +
        `ranked=${result.ranked} carriers=${result.carriers.length}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[freight-opps] inline rank ${opp.id} failed after ${Date.now() - started}ms:`, message);
      return { ranked: false, carriers: [] as any[], error: message };
    } finally {
      inflightRanks.delete(opp.id);
    }
  })();
  inflightRanks.set(opp.id, p);
  return p;
}

const carrierPatchSchema = z.object({
  excludedReason: z.union([z.enum([
    "recent_contact", "daily_cap", "not_approved", "do_not_use",
    "opted_out", "rep_override", "customer_carrier_blocked",
  ]), z.null()]).optional(),
  bucket: z.enum(["proven", "strong_fit_underused", "exploratory", "rep_added"]).optional(),
  rank: z.number().int().min(0).max(10000).optional(),
});

const policyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(FREIGHT_OPPORTUNITY_MODES).optional(),
  approvalRequired: z.boolean().optional(),
  maxCarriersPerOpportunity: z.number().int().min(1).max(100).optional(),
  leadTimeMinDays: z.number().int().min(0).max(60).optional(),
  leadTimeMaxDays: z.number().int().min(0).max(180).optional(),
  approvedCarrierOnly: z.boolean().optional(),
  approvedCarrierIds: z.array(z.string()).optional(),
  doNotAutomate: z.boolean().optional(),
  specialNotes: z.string().nullable().optional(),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function registerProactiveOpportunityRoutes(app: Express) {
  // ── UPLOAD ────────────────────────────────────────────────────────────────
  // Direct file-upload entry to the Available Freight importer. Lets users
  // populate freight_opportunities (and load_fact mirror) without OneDrive.
  app.post("/api/freight-opportunities/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const org = orgId(req);
      if (!org) return res.status(400).json({ error: "No organization" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const summary = await runAvailableFreightImportFromWorkbook(
        workbook,
        req.file.originalname,
        org,
        user.id,
        "manual",
      );
      res.json(summary);
    } catch (err) {
      console.error("[freight-opps] upload error:", err);
      const message = err instanceof Error ? err.message : "Failed to import available freight";
      res.status(500).json({ error: message });
    }
  });

  // ── LIST ──────────────────────────────────────────────────────────────────
  app.get("/api/freight-opportunities", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { companyId, status, limit = "50", offset = "0" } = req.query as Record<string, string>;
      const statusList = (status ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .filter((s): s is typeof FREIGHT_OPPORTUNITY_STATUSES[number] =>
          (FREIGHT_OPPORTUNITY_STATUSES as readonly string[]).includes(s));
      const rows = await storage.listFreightOpportunities(org, {
        companyId: companyId || undefined,
        status: statusList.length ? statusList : undefined,
        limit: Math.min(500, parseInt(limit) || 50),
        offset: Math.max(0, parseInt(offset) || 0),
      });
      // Augment each opportunity with included/total recommended-carrier counts
      // so the queue can show shortlist size without a follow-up request per row.
      const counts = await Promise.all(
        rows.map(r => storage.listFreightOpportunityCarriers(r.id)),
      );
      const items = rows.map((r, i) => {
        const carriers = counts[i];
        const includedCarrierCount = carriers.filter(c => !c.excludedReason).length;
        return {
          ...r,
          recommendedCarrierCount: carriers.length,
          includedCarrierCount,
        };
      });
      res.json({ items });
    } catch (err) {
      console.error("[freight-opps] list error:", err);
      res.status(500).json({ error: "Failed to list freight opportunities" });
    }
  });

  // ── DETAIL ────────────────────────────────────────────────────────────────
  app.get("/api/freight-opportunities/:id", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      let carriers = await storage.listFreightOpportunityCarriers(opp.id);
      let rankAttempted = false;
      let rankError: string | undefined;
      // Backfill: rows imported via the Available Freight workbook never went
      // through generateOpportunitiesForCompany, so they may have no carrier
      // shortlist persisted. Run the rank inline (mirrors the LWQ
      // /carrier-suggestions flow with a 25s timeout) so the response is
      // self-contained. Concurrent requests join a single in-flight Promise
      // instead of hammering the ranker with one kickoff per poll.
      if (carriers.length === 0) {
        const result = await runOrJoinRank(opp);
        rankAttempted = true;
        rankError = result.error;
        if (result.carriers.length > 0) {
          carriers = result.carriers as typeof carriers;
        }
      }
      const audit = await storage.listFreightOpportunityAudit(opp.id);
      // Phase 4: hydrate per-carrier response history so the UI can show
      // outcomes (last + count) without N follow-up calls.
      const responsesByRow = await Promise.all(
        carriers.map(c => storage.listFreightOpportunityResponses(c.id)),
      );
      const carriersWithResponses = carriers.map((c, i) => ({
        ...c,
        responses: responsesByRow[i],
        lastResponse: responsesByRow[i][0] ?? null,
      }));
      res.json({
        opportunity: opp,
        carriers: carriersWithResponses,
        audit,
        // rankingInFlight is now only true when another request is already
        // ranking and this caller's runOrJoinRank is still awaiting — which
        // we resolved synchronously above, so it's always false. Kept in the
        // payload for backwards-compat with the polling client until that
        // ships.
        rankingInFlight: false,
        rankAttempted,
        rankError: rankError ?? null,
      });
    } catch (err) {
      console.error("[freight-opps] detail error:", err);
      res.status(500).json({ error: "Failed to fetch freight opportunity" });
    }
  });

  // ── FORCE RERANK ─────────────────────────────────────────────────────────
  // Used by the detail page's "Try ranking again" button. Wipes the existing
  // shortlist and re-runs scoring inside a transaction so a failed rerank
  // never leaves the opportunity worse off than it started.
  app.post("/api/freight-opportunities/:id/rerank", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      // Snapshot-and-restore (rather than a DB transaction) because
      // ensureShortlistRanked uses the global storage/db pool and would not
      // see uncommitted deletes from a wrapping tx (PG MVCC) — making a tx
      // wrapper a footgun. Snapshot in app memory, attempt rerank, and if it
      // fails or comes back empty when we previously had real rows, restore
      // the prior shortlist so we never leave the opp worse off.
      const priorRows = await storage.listFreightOpportunityCarriers(opp.id);
      const restorePayload = (): any[] => priorRows.map((r) => {
        const { id: _id, createdAt: _ca, ...rest } = r as any;
        return rest;
      });
      try {
        await db.delete(freightOpportunityCarriers).where(eq(freightOpportunityCarriers.opportunityId, opp.id));
        await ensureShortlistRanked(storage, opp);
      } catch (e) {
        console.warn(`[freight-opps] force rerank failed for ${opp.id}, restoring prior shortlist:`, e);
        if (priorRows.length > 0) {
          await storage.insertFreightOpportunityCarriers(restorePayload());
        }
        return res.status(500).json({ error: "Re-ranking failed; previous shortlist preserved." });
      }
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      // If rerank silently produced nothing but we did have a prior list,
      // restore it rather than leaving the opp blank — the rep can still see
      // who was previously suggested.
      if (carriers.length === 0 && priorRows.length > 0) {
        await storage.insertFreightOpportunityCarriers(restorePayload());
        return res.status(409).json({ error: "Re-ranking returned no candidates; previous shortlist preserved." });
      }
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "generated",
        actorUserId: userId(req),
        payload: { kind: "manual_force_rerank", shortlistSize: carriers.length },
      });
      res.json({ ranked: true, count: carriers.length });
    } catch (err) {
      console.error("[freight-opps] rerank error:", err);
      res.status(500).json({ error: "Failed to re-rank shortlist" });
    }
  });

  // ── CARRIER REORDER (atomic swap) ─────────────────────────────────────────
  app.post("/api/freight-opportunities/:oppId/carriers/:carrierRowId/swap", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const otherRowId = String((req.body ?? {}).otherRowId ?? "");
      if (!otherRowId) return res.status(400).json({ error: "otherRowId is required" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const a = carriers.find(c => c.id === String(req.params.carrierRowId));
      const b = carriers.find(c => c.id === otherRowId);
      if (!a || !b) return res.status(404).json({ error: "One or both carrier rows not found on this opportunity" });
      if (a.bucket !== b.bucket) {
        return res.status(400).json({ error: "Cannot reorder across buckets" });
      }
      // True swap: each row gets the other's prior rank, deterministic.
      const aRank = a.rank ?? 0;
      const bRank = b.rank ?? 0;
      const [updatedA, updatedB] = await Promise.all([
        storage.updateFreightOpportunityCarrier(a.id, { rank: bRank }),
        storage.updateFreightOpportunityCarrier(b.id, { rank: aRank }),
      ]);
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "carrier_reordered",
        actorUserId: userId(req),
        payload: { swapped: [a.carrierId, b.carrierId], from: [aRank, bRank], to: [bRank, aRank] },
      });
      res.json({ carriers: [updatedA, updatedB] });
    } catch (err) {
      console.error("[freight-opps] carrier swap error:", err);
      res.status(500).json({ error: "Failed to reorder carrier" });
    }
  });

  // ── CARRIER OVERRIDE (include/exclude, pin, reorder) ──────────────────────
  app.patch("/api/freight-opportunities/:oppId/carriers/:carrierRowId", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const parsed = carrierPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid carrier patch", details: parsed.error.flatten() });
      }
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const target = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!target) return res.status(404).json({ error: "Carrier row not found on this opportunity" });
      const updated = await storage.updateFreightOpportunityCarrier(target.id, parsed.data);
      // Audit overrides so reviewers can see who changed what.
      if (parsed.data.excludedReason !== undefined) {
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: parsed.data.excludedReason === null ? "carrier_included_override" : "carrier_excluded",
          actorUserId: userId(req),
          payload: { carrierId: target.carrierId, reason: parsed.data.excludedReason ?? "rep_included" },
        });
      }
      res.json({ carrier: updated });
    } catch (err) {
      console.error("[freight-opps] carrier patch error:", err);
      res.status(500).json({ error: "Failed to update carrier" });
    }
  });

  // Tenant-isolation guard: the policy tables' FKs only reference companies(id),
  // so we must verify here that the company belongs to the caller's org before
  // reading or writing. Without this, a caller could read or create a policy
  // row pointing at any company id across the global tenant space.
  async function assertCompanyBelongsToOrg(companyId: string, org: string): Promise<true | "not_found" | "forbidden"> {
    const company = await storage.getCompany(companyId);
    if (!company) return "not_found";
    if (company.organizationId && company.organizationId !== org) return "forbidden";
    return true;
  }

  // ── COMPANY OUTREACH POLICY ───────────────────────────────────────────────
  app.get("/api/companies/:id/outreach-policy", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const companyId = String(req.params.id);
      const check = await assertCompanyBelongsToOrg(companyId, org);
      if (check === "not_found") return res.status(404).json({ error: "Company not found" });
      if (check === "forbidden") return res.status(403).json({ error: "Company does not belong to your organization" });
      // Return the synthesized effective policy — persisted row if present,
      // otherwise PAFOE defaults bound to this org+company. Callers always
      // receive a usable policy object (never null).
      const policy = await loadEffectivePolicy(storage, org, companyId);
      res.json({ policy });
    } catch (err) {
      console.error("[freight-opps] policy get error:", err);
      res.status(500).json({ error: "Failed to fetch outreach policy" });
    }
  });

  // ── PHASE 4: TEMPLATES ────────────────────────────────────────────────────
  // Org-scoped editable templates with safe defaults seeded on first read.
  app.get("/api/freight-outreach-templates", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const items = await Promise.all(
        FREIGHT_OUTREACH_TEMPLATE_KINDS.map(k => getOrSeedTemplate(storage, org, k)),
      );
      res.json({ items });
    } catch (err) {
      console.error("[freight-opps] templates list error:", err);
      res.status(500).json({ error: "Failed to load templates" });
    }
  });

  const templatePutSchema = z.object({
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(20_000),
  });
  app.put("/api/freight-outreach-templates/:kind", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      // Admin-only: outreach templates are org-wide configuration; reps must
      // not be able to mutate what every other rep on the team will send.
      const actor = uid ? await storage.getUser(uid) : null;
      if (!actor || actor.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const kind = String(req.params.kind);
      if (!(FREIGHT_OUTREACH_TEMPLATE_KINDS as readonly string[]).includes(kind)) {
        return res.status(400).json({ error: "Invalid template kind" });
      }
      const parsed = templatePutSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid template payload", details: parsed.error.flatten() });
      }
      const tmpl = await storage.upsertFreightOutreachTemplate({
        orgId: org,
        kind: kind as FreightOutreachTemplateKind,
        subject: parsed.data.subject,
        body: parsed.data.body,
        updatedById: uid,
      });
      res.json({ template: tmpl });
    } catch (err) {
      console.error("[freight-opps] template upsert error:", err);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  // ── PHASE 4: PER-CARRIER DRAFT PREVIEW (used by the Send modal) ───────────
  app.get("/api/freight-opportunities/:oppId/carriers/:carrierRowId/draft", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const row = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!row) return res.status(404).json({ error: "Carrier row not found" });
      const uid = userId(req);
      const rep = uid ? await storage.getUser(uid) : null;
      if (!rep) return res.status(401).json({ error: "Not authenticated" });
      const draft = await buildOpportunityDraft(storage, opp, row, rep);
      res.json({ draft });
    } catch (err) {
      console.error("[freight-opps] draft error:", err);
      res.status(500).json({ error: "Failed to build draft" });
    }
  });

  // ── PHASE 4: SEND or SCHEDULE A WAVE ──────────────────────────────────────
  const sendWaveSchema = z.object({
    carrierRowIds: z.array(z.string().min(1)).min(1).max(100),
    scheduleAt: z.string().datetime().nullable().optional(),
    wave: z.number().int().min(1).max(10).optional(),
    overrides: z.record(z.object({
      subject: z.string().max(500).optional(),
      body: z.string().max(20_000).optional(),
    })).optional(),
  });
  app.post("/api/freight-opportunities/:oppId/send", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!uid) return res.status(401).json({ error: "Not authenticated" });
      const rep = await storage.getUser(uid);
      if (!rep) return res.status(401).json({ error: "Rep not found" });
      const parsed = sendWaveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid send payload", details: parsed.error.flatten() });
      }
      const out = await sendOpportunityWave(storage, org, String(req.params.oppId), rep, parsed.data);
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[freight-opps] send error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  // ── PHASE 4: MANUAL OUTCOME OVERRIDE (Phase 3 UI button) ──────────────────
  const outcomePostSchema = z.object({
    outcome: z.enum(FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES),
    notes: z.string().max(2000).nullable().optional(),
    quotedRate: z.string().max(50).nullable().optional(),
  });
  app.post("/api/freight-opportunities/:oppId/carriers/:carrierRowId/response", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const row = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!row) return res.status(404).json({ error: "Carrier row not found" });
      const parsed = outcomePostSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid outcome payload", details: parsed.error.flatten() });
      }
      const uid = userId(req);
      const response = await storage.createFreightOpportunityResponse({
        opportunityCarrierId: row.id,
        outcome: parsed.data.outcome,
        replySource: "manual_log",
        emailMessageId: null,
        notes: parsed.data.notes ?? null,
        recordedById: uid,
        quotedRate: parsed.data.quotedRate ?? null,
      });
      await storage.updateFreightOpportunityCarrier(row.id, { lastResponseId: response.id });
      // If the rep logged a positive outcome, halt any pending automated waves.
      if (["interested_now","interested_few_days","interested_next_week","interested_future","booked"].includes(parsed.data.outcome)) {
        await cancelPendingWaves(storage, opp.id, "positive_response_manual").catch(() => undefined);
      }
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "response_recorded",
        actorUserId: uid,
        payload: { carrierId: row.carrierId, outcome: parsed.data.outcome, source: "manual" },
      });
      // Feed the signal back into ranking (additive, no master-data overwrite)
      await feedbackToCarrierIntel(storage, {
        orgId: org,
        carrierId: row.carrierId,
        opportunity: opp,
        outcome: parsed.data.outcome,
        confidence: 95,
        sourceNote: parsed.data.notes ?? "Rep-logged outcome",
        actorUserId: uid,
      });
      res.json({ response });
    } catch (err) {
      console.error("[freight-opps] response error:", err);
      res.status(500).json({ error: "Failed to record response" });
    }
  });

  /**
   * POST /api/freight-opportunities/:oppId/cover
   * Task #366 — Mark a freight opportunity as covered and emit a coaching/
   * rate-positioning row to load_fact. This is what closes the loop between
   * the My Procurement work surface and the Coaching/Rate Intelligence
   * pipeline: every covered load contributes a real rep + carrier + paid
   * rate + customer rate datapoint that downstream features can learn from.
   *
   * Body: { carrierId: string, paidRate: number, customerRate: number,
   *         carrierName?: string, notes?: string }
   *
   * carrierId is a carriers.id reference (the source carrier of truth).
   * carrierName is optional and overrides the looked-up name (useful when
   * the rep covered with a brand-new carrier that hasn't been catalogued
   * yet). paidRate is what we pay the carrier; customerRate is what the
   * customer pays us. revenue/cost/margin are computed as rate × loadCount
   * so a small lane-building sweep contributes correctly.
   */
  const coverSchema = z.object({
    carrierId: z.string().min(1).optional(),
    carrierName: z.string().min(1).max(200).optional(),
    paidRate: z.number().positive().max(999999),
    customerRate: z.number().positive().max(999999),
    notes: z.string().max(2000).nullable().optional(),
  }).refine(d => d.carrierId || d.carrierName, {
    message: "carrierId or carrierName is required",
  });
  app.post("/api/freight-opportunities/:oppId/cover", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!uid) return res.status(401).json({ error: "Not authenticated" });
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      // Anyone with line-of-sight to the opp may close it: owner, delegate,
      // or a manager (managers may close on behalf of an out-of-office rep).
      const rep = await storage.getUser(uid);
      if (!rep) return res.status(401).json({ error: "Rep not found" });
      const isOwner = opp.ownerUserId === uid || opp.delegatedToUserId === uid;
      const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(rep.role);
      if (!isOwner && !isManager) {
        return res.status(403).json({ error: "Only the owner, delegate, or a manager can mark covered" });
      }
      const parsed = coverSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid cover payload", details: parsed.error.flatten() });
      }
      if (opp.status === "covered") {
        return res.status(400).json({ error: "Opportunity is already covered" });
      }

      // Resolve carrier name (either explicit or from the catalog).
      let carrierName: string | null = parsed.data.carrierName ?? null;
      if (!carrierName && parsed.data.carrierId) {
        const c = await storage.getCarrier(parsed.data.carrierId);
        carrierName = c?.name ?? null;
        if (c && c.organizationId !== org) {
          return res.status(403).json({ error: "Carrier does not belong to your organization" });
        }
      }
      if (!carrierName) {
        return res.status(400).json({ error: "Could not resolve carrier name" });
      }

      // Resolve the customer name for the load_fact row.
      const company = await storage.getCompany(opp.companyId);
      const customerName = company?.name ?? null;

      const loadCount = Math.max(1, opp.loadCount ?? 1);
      const revenue = parsed.data.customerRate * loadCount;
      const cost = parsed.data.paidRate * loadCount;
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? margin / revenue : 0;

      const updated = await storage.updateFreightOpportunity(
        org,
        opp.id,
        {
          status: "covered",
          // Clear any pending SLA clock — covered freight no longer needs
          // approval reminders.
          awaitingApprovalSince: null,
        },
        // Canonical opt-in: this is the one and only path allowed to flip an
        // opportunity to `covered`. The downstream load_fact emit + audit
        // happen below in this same handler.
        { allowCoveredTransition: true },
      );
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "status_changed",
        actorUserId: uid,
        payload: {
          kind: "covered",
          carrierId: parsed.data.carrierId ?? null,
          carrierName,
          paidRate: parsed.data.paidRate,
          customerRate: parsed.data.customerRate,
          revenue,
          cost,
          margin,
          loadCount,
          notes: parsed.data.notes ?? null,
        },
      });

      // Emit to load_fact so coaching / rate positioning sees the win.
      // Order id is deterministic so re-running cover (e.g. a follow-up
      // edit) updates the same row instead of inserting duplicates.
      const { upsertLoadFact } = await import("../carrierIntelligenceService");
      const month = (opp.pickupWindowStart || new Date().toISOString()).slice(0, 7);
      let loadFactEmit: { inserted: boolean; updated: boolean; loadFactId?: string } | null = null;
      try {
        const out = await upsertLoadFact({
          orgId: org,
          orderId: `freight_opp:${opp.id}`,
          companyId: opp.companyId,
          customerName,
          carrierName,
          carrierPayeeCode: null,
          originCity: opp.origin,
          originState: opp.originState ?? null,
          originZip: null,
          destinationCity: opp.destination,
          destinationState: opp.destinationState ?? null,
          destinationZip: null,
          accountManager: rep.name ?? rep.email ?? null,
          dispatcher: null,
          equipmentType: opp.equipmentType ?? null,
          pickupDate: opp.pickupWindowStart ?? null,
          deliveryDate: null,
          pickupApptStart: null,
          pickupApptEnd: null,
          deliveryApptStart: null,
          deliveryApptEnd: null,
          arrivedAtPickup: null,
          arrivedAtDelivery: null,
          totalStops: null,
          totalMiles: null,
          month,
          moveStatus: "covered",
          bucket: "realized",
          revenue: revenue.toFixed(2),
          cost: cost.toFixed(2),
          margin: margin.toFixed(2),
          marginPct: marginPct.toFixed(4),
          loadCount,
          rawRow: { source: "freight_opp_coverage", oppId: opp.id, repUserId: uid },
          sourceFileName: null,
          sourceKind: "freight_opp_coverage",
        });
        loadFactEmit = { inserted: out.inserted, updated: out.updated, loadFactId: out.loadFactId };
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: "load_fact_emitted",
          actorUserId: uid,
          payload: {
            loadFactId: out.loadFactId,
            inserted: out.inserted,
            updated: out.updated,
            changedFields: out.changedFields,
          },
        });
      } catch (emitErr) {
        // Coverage status transition still wins even if the load_fact emit
        // fails — log loudly so an admin can backfill, but don't roll back
        // the manual close (which would erase the rep's work).
        console.error("[freight-opps] cover load_fact emit failed:", emitErr);
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: "load_fact_emit_failed",
          actorUserId: uid,
          payload: { error: emitErr instanceof Error ? emitErr.message : String(emitErr) },
        });
      }

      return res.json({ opportunity: updated, loadFact: loadFactEmit });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[freight-opps] cover error:", msg);
      return res.status(500).json({ error: "Failed to mark covered" });
    }
  });

  app.patch("/api/companies/:id/outreach-policy", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const companyId = String(req.params.id);
      const check = await assertCompanyBelongsToOrg(companyId, org);
      if (check === "not_found") return res.status(404).json({ error: "Company not found" });
      if (check === "forbidden") return res.status(403).json({ error: "Company does not belong to your organization" });
      const parsed = policyPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid policy payload", details: parsed.error.flatten() });
      }
      const existing = await storage.getCompanyOutreachPolicy(org, companyId);
      const merged: InsertCompanyOutreachPolicy = {
        orgId: org,
        companyId,
        enabled: parsed.data.enabled ?? existing?.enabled ?? false,
        mode: (parsed.data.mode ?? existing?.mode ?? "exact_load") as InsertCompanyOutreachPolicy["mode"],
        approvalRequired: parsed.data.approvalRequired ?? existing?.approvalRequired ?? true,
        maxCarriersPerOpportunity: parsed.data.maxCarriersPerOpportunity ?? existing?.maxCarriersPerOpportunity ?? 25,
        leadTimeMinDays: parsed.data.leadTimeMinDays ?? existing?.leadTimeMinDays ?? 2,
        leadTimeMaxDays: parsed.data.leadTimeMaxDays ?? existing?.leadTimeMaxDays ?? 7,
        approvedCarrierOnly: parsed.data.approvedCarrierOnly ?? existing?.approvedCarrierOnly ?? false,
        approvedCarrierIds: parsed.data.approvedCarrierIds ?? existing?.approvedCarrierIds ?? [],
        doNotAutomate: parsed.data.doNotAutomate ?? existing?.doNotAutomate ?? false,
        specialNotes: parsed.data.specialNotes ?? existing?.specialNotes ?? null,
        updatedById: userId(req),
      };
      const policy = await storage.upsertCompanyOutreachPolicy(merged);
      res.json({ policy });
    } catch (err) {
      console.error("[freight-opps] policy patch error:", err);
      res.status(500).json({ error: "Failed to update outreach policy" });
    }
  });
}
