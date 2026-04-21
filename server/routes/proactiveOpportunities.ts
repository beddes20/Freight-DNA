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
      res.json({ items: rows });
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
