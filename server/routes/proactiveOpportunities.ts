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
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { z } from "zod";
import { loadEffectivePolicy } from "../proactiveOpportunityService";
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

export function registerProactiveOpportunityRoutes(app: Express) {
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
      const [carriers, audit] = await Promise.all([
        storage.listFreightOpportunityCarriers(opp.id),
        storage.listFreightOpportunityAudit(opp.id),
      ]);
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
      res.json({ opportunity: opp, carriers: carriersWithResponses, audit });
    } catch (err) {
      console.error("[freight-opps] detail error:", err);
      res.status(500).json({ error: "Failed to fetch freight opportunity" });
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
