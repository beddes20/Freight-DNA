/**
 * Contact Geography Suggestions API Routes (Task #225)
 *
 * GET  /api/internal/accounts/:accountId/geography-suggestions
 * GET  /api/internal/contacts/:contactId/geography-suggestions
 * POST /api/internal/geography-suggestions/:id/accept
 * POST /api/internal/geography-suggestions/:id/reject
 * POST /api/internal/geography-suggestions/:id/dismiss
 */

import type { Express } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";

const VALID_STATUSES = ["pending", "accepted", "rejected", "dismissed"] as const;

export function registerContactGeographySuggestionRoutes(app: Express): void {

  app.get(
    "/api/internal/accounts/:accountId/geography-suggestions",
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
          status: req.query.status as string | undefined,
        };

        const suggestions = await storage.getContactGeographySuggestions(accountId, filters);

        const contactIds = [...new Set(suggestions.map(s => s.contactId))];
        const contactsArr = await Promise.all(contactIds.map(id => storage.getContact(id)));
        const contactMap = new Map(contactsArr.filter(Boolean).map(c => [c!.id, c!]));

        const enriched = suggestions.map(s => ({
          ...s,
          contactName: contactMap.get(s.contactId)?.name ?? null,
          contactTitle: contactMap.get(s.contactId)?.title ?? null,
          contactEmail: contactMap.get(s.contactId)?.email ?? null,
        }));

        return res.json(enriched);
      } catch (err) {
        console.error("[contactGeographySuggestions] GET account suggestions error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.get(
    "/api/internal/contacts/:contactId/geography-suggestions",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { contactId } = req.params;
        const contact = await storage.getContact(contactId);
        if (!contact) return res.status(404).json({ error: "Contact not found" });

        const company = await storage.getCompanyInOrg(contact.companyId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const suggestions = await storage.getContactGeographySuggestions(contact.companyId, { contactId });
        return res.json(suggestions);
      } catch (err) {
        console.error("[contactGeographySuggestions] GET contact suggestions error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.post(
    "/api/internal/geography-suggestions/:id/accept",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { id } = req.params;
        const suggestion = await storage.getContactGeographySuggestion(id);
        if (!suggestion) return res.status(404).json({ error: "Not found" });

        const company = await storage.getCompanyInOrg(suggestion.accountId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const contact = await storage.getContact(suggestion.contactId);
        if (contact) {
          const currentRegions = contact.regions ?? [];
          const currentLanes = contact.lanes ?? [];

          if (suggestion.suggestedRegion && !currentRegions.includes(suggestion.suggestedRegion)) {
            currentRegions.push(suggestion.suggestedRegion);
          }
          if (suggestion.suggestedLane && !currentLanes.includes(suggestion.suggestedLane)) {
            currentLanes.push(suggestion.suggestedLane);
          }

          await storage.updateContact(contact.id, {
            ...contact,
            regions: currentRegions,
            lanes: currentLanes,
          } as any);
        }

        const updated = await storage.updateContactGeographySuggestionStatus(id, "accepted", { userId: user.id });
        return res.json(updated);
      } catch (err) {
        console.error("[contactGeographySuggestions] accept error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.post(
    "/api/internal/geography-suggestions/:id/reject",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { id } = req.params;
        const suggestion = await storage.getContactGeographySuggestion(id);
        if (!suggestion) return res.status(404).json({ error: "Not found" });

        const company = await storage.getCompanyInOrg(suggestion.accountId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const updated = await storage.updateContactGeographySuggestionStatus(id, "rejected", { userId: user.id });
        return res.json(updated);
      } catch (err) {
        console.error("[contactGeographySuggestions] reject error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  app.post(
    "/api/internal/geography-suggestions/:id/dismiss",
    requireAuth,
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const { id } = req.params;
        const suggestion = await storage.getContactGeographySuggestion(id);
        if (!suggestion) return res.status(404).json({ error: "Not found" });

        const company = await storage.getCompanyInOrg(suggestion.accountId, user.organizationId);
        if (!company) return res.status(403).json({ error: "Forbidden" });

        const updated = await storage.updateContactGeographySuggestionStatus(id, "dismissed", { userId: user.id });
        return res.json(updated);
      } catch (err) {
        console.error("[contactGeographySuggestions] dismiss error:", err);
        return res.status(500).json({ error: "Internal server error" });
      }
    },
  );
}
