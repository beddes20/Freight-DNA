/**
 * Geographic Lane Pattern Responsibility API Routes (Task #203)
 *
 * GET  /api/internal/accounts/:accountId/geographic-responsibilities
 * GET  /api/internal/contacts/:contactId/geographic-responsibilities
 * POST /api/internal/geographic-responsibilities/:id/confirm
 * POST /api/internal/geographic-responsibilities/:id/dismiss
 * POST /api/internal/geographic-responsibilities (manual confirmed creation)
 */

import type { Express } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import { z } from "zod";

const confirmDismissParamsSchema = z.object({ id: z.string() });

const manualCreateSchema = z.object({
  orgId: z.string(),
  accountId: z.string(),
  contactId: z.string(),
  lanePatternId: z.string(),
  responsibilityType: z.enum(["spot", "mini_bid", "rfp", "ops", "other"]).nullable().optional(),
  notes: z.string().optional(),
});

export function registerGeographicResponsibilitiesRoutes(app: Express): void {

  // GET /api/internal/accounts/:accountId/geographic-responsibilities
  app.get(
    "/api/internal/accounts/:accountId/geographic-responsibilities",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { accountId } = req.params;
        const company = await storage.getCompanyInOrg(accountId, user.organizationId);
        if (!company) return res.status(404).json({ error: "Account not found" });

        const filters = {
          contactId: req.query.contactId as string | undefined,
          lanePatternId: req.query.lanePatternId as string | undefined,
          status: req.query.status as string | undefined,
          minConfidence: req.query.minConfidence ? Number(req.query.minConfidence) : undefined,
          responsibilityType: req.query.responsibilityType as string | undefined,
        };

        const responsibilities = await storage.getResponsibilitiesByAccount(accountId, filters);

        // Enrich with pattern names
        const patternIds = [...new Set(responsibilities.map(r => r.lanePatternId))];
        const patterns = await Promise.all(patternIds.map(id => storage.getGeographicLanePattern(id)));
        const patternMap = new Map(patterns.filter(Boolean).map(p => [p!.id, p!]));

        const enriched = responsibilities.map(r => ({
          ...r,
          pattern: patternMap.get(r.lanePatternId) ?? null,
        }));

        return res.json(enriched);
      } catch (err) {
        console.error("[geographicResponsibilities] GET account responsibilities error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /api/internal/contacts/:contactId/geographic-responsibilities
  app.get(
    "/api/internal/contacts/:contactId/geographic-responsibilities",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { contactId } = req.params;
        const contact = await storage.getContact(contactId);
        if (!contact) return res.status(404).json({ error: "Contact not found" });

        // Verify org scoping via company
        const company = await storage.getCompanyInOrg(contact.companyId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const filters = {
          accountId: req.query.accountId as string | undefined,
          status: req.query.status as string | undefined,
          minConfidence: req.query.minConfidence ? Number(req.query.minConfidence) : undefined,
          responsibilityType: req.query.responsibilityType as string | undefined,
        };

        const responsibilities = await storage.getResponsibilitiesByContact(contactId, filters);

        const patternIds = [...new Set(responsibilities.map(r => r.lanePatternId))];
        const patterns = await Promise.all(patternIds.map(id => storage.getGeographicLanePattern(id)));
        const patternMap = new Map(patterns.filter(Boolean).map(p => [p!.id, p!]));

        const enriched = responsibilities.map(r => ({
          ...r,
          pattern: patternMap.get(r.lanePatternId) ?? null,
        }));

        return res.json(enriched);
      } catch (err) {
        console.error("[geographicResponsibilities] GET contact responsibilities error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/internal/geographic-responsibilities/:id/confirm
  app.post(
    "/api/internal/geographic-responsibilities/:id/confirm",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { id } = req.params;
        const row = await storage.getResponsibility(id);
        if (!row) return res.status(404).json({ error: "Not found" });

        // Org scoping check
        const company = await storage.getCompanyInOrg(row.accountId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const updated = await storage.confirmResponsibility(id, user.id);
        return res.json(updated);
      } catch (err) {
        console.error("[geographicResponsibilities] confirm error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/internal/geographic-responsibilities/:id/dismiss
  app.post(
    "/api/internal/geographic-responsibilities/:id/dismiss",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { id } = req.params;
        const row = await storage.getResponsibility(id);
        if (!row) return res.status(404).json({ error: "Not found" });

        const company = await storage.getCompanyInOrg(row.accountId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const updated = await storage.dismissResponsibility(id, user.id);
        return res.json(updated);
      } catch (err) {
        console.error("[geographicResponsibilities] dismiss error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/internal/geographic-responsibilities (manual confirmed creation)
  app.post(
    "/api/internal/geographic-responsibilities",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const parsed = manualCreateSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

        const { orgId, accountId, contactId, lanePatternId, responsibilityType } = parsed.data;

        // Org scoping
        if (orgId !== user.organizationId) return res.status(403).json({ error: "Forbidden" });
        const company = await storage.getCompanyInOrg(accountId, user.organizationId);
        if (!company) return res.status(404).json({ error: "Account not found" });

        // Check for existing row
        const existing = await storage.getResponsibilityByKey(accountId, contactId, lanePatternId);
        if (existing) {
          const updated = await storage.confirmResponsibility(existing.id, user.id);
          return res.json(updated);
        }

        const created = await storage.createResponsibility({
          orgId,
          accountId,
          contactId,
          lanePatternId,
          isResponsibleForPattern: true,
          responsibilityType: responsibilityType ?? null,
          confidenceScore: 100,
          evidenceCount: 0,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          primarySourceType: "email",
          status: "confirmed",
          lastReviewedAt: new Date(),
          lastReviewedByUserId: user.id,
          evidenceEventKeys: [],
          sourceTypes: [],
        });

        return res.status(201).json(created);
      } catch (err) {
        console.error("[geographicResponsibilities] manual create error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );
}
