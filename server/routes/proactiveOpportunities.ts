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
  FREIGHT_OPPORTUNITY_MODES,
  FREIGHT_OPPORTUNITY_STATUSES,
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
      res.json({ opportunity: opp, carriers, audit });
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
