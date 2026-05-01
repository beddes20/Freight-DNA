/**
 * Task #912 — Copilot Fit & Intelligence Card routes.
 *
 *   GET   /api/copilot/cards/:documentId             latest card for a doc
 *   GET   /api/copilot/cards/by-customer/:companyId  recent cards for a customer
 *   GET   /api/copilot/cards/by-carrier/:carrierId   recent cards for a carrier
 *   GET   /api/copilot/cards/by-opportunity/:id      recent cards for an opportunity
 *   GET   /api/copilot/cards/by-lane/:laneSig        recent cards for a lane signature
 *   POST  /api/copilot/cards/:id/react               record a HITL reaction
 *   POST  /api/copilot/cards/:documentId/regenerate  re-run the reasoner (admin)
 *
 * Visibility mirrors slice 1/2: a rep can read a card if they can read the
 * underlying document. Reactions require the same access; admins can react
 * on any card in their org.
 */
import type { Express } from "express";
import { requireAuth, getCurrentUser, getVisibleCompanyIds } from "../auth";
import { storage } from "../storage";
import { generateAndPersistIntelligenceCard } from "../services/copilotIntelligenceCard";
import { reactToCopilotRecommendationSchema, type CopilotRecommendation, type User } from "@shared/schema";
import { getErrorMessage } from "../lib/errors";

function isAdminish(role: string): boolean {
  return role === "admin" || role === "director" || role === "sales_director";
}

async function canReadCard(
  rep: User,
  card: CopilotRecommendation,
): Promise<boolean> {
  if (card.orgId !== rep.organizationId) return false;
  if (isAdminish(rep.role)) return true;
  // Anchor-based visibility — same shape as the documents route. We accept
  // a card if any of the anchor records is visible to the rep, OR if the
  // underlying document is visible.
  const visible = await getVisibleCompanyIds(rep);
  if (visible === null) return true;
  if (card.customerCompanyId && visible.includes(card.customerCompanyId)) return true;
  // Fall back to the source document's visibility check.
  if (card.sourceDocumentId) {
    const doc = await storage.getDocumentInOrg(card.sourceDocumentId, rep.organizationId);
    if (!doc) return false;
    const linkedCompanyId = (doc.uploadContext as { companyId?: string } | null)?.companyId ?? null;
    if (linkedCompanyId && visible.includes(linkedCompanyId)) return true;
    if (!linkedCompanyId && doc.uploaderId === rep.id) return true;
  }
  return false;
}

async function filterVisibleCards(
  rep: User,
  cards: CopilotRecommendation[],
): Promise<CopilotRecommendation[]> {
  const out: CopilotRecommendation[] = [];
  for (const c of cards) {
    if (await canReadCard(rep, c)) out.push(c);
  }
  return out;
}

export function registerCopilotCardRoutes(app: Express): void {
  // — Latest card for a document. Returns 404 when the document has no
  //   card yet (e.g. extraction is still pending). The UI uses 404 to
  //   render an "extraction in progress" state, not as an error.
  app.get("/api/copilot/cards/by-document/:documentId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const documentId = String(req.params.documentId || "").trim();
      if (!documentId) return res.status(400).json({ error: "documentId required" });
      const card = await storage.getLatestRecommendationForDocument(documentId, currentUser.organizationId);
      if (!card) return res.status(404).json({ error: "no_card_for_document" });
      if (!(await canReadCard(currentUser, card))) {
        return res.status(403).json({ error: "forbidden" });
      }
      res.json({ card });
    } catch (err) {
      console.error("[copilot/cards by-document]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch card" });
    }
  });

  app.get("/api/copilot/cards/by-customer/:companyId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = String(req.params.companyId || "").trim();
      if (!companyId) return res.status(400).json({ error: "companyId required" });
      const visible = await getVisibleCompanyIds(currentUser);
      if (!isAdminish(currentUser.role) && visible !== null && !visible.includes(companyId)) {
        return res.status(403).json({ error: "forbidden" });
      }
      const cards = await storage.listRecommendationsForCustomer(companyId, currentUser.organizationId, 25);
      res.json({ cards });
    } catch (err) {
      console.error("[copilot/cards by-customer]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  });

  app.get("/api/copilot/cards/by-carrier/:carrierId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const carrierId = String(req.params.carrierId || "").trim();
      if (!carrierId) return res.status(400).json({ error: "carrierId required" });
      const cards = await storage.listRecommendationsForCarrier(carrierId, currentUser.organizationId, 25);
      const visibleCards = await filterVisibleCards(currentUser, cards);
      res.json({ cards: visibleCards });
    } catch (err) {
      console.error("[copilot/cards by-carrier]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  });

  app.get("/api/copilot/cards/by-opportunity/:opportunityId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const opportunityId = String(req.params.opportunityId || "").trim();
      if (!opportunityId) return res.status(400).json({ error: "opportunityId required" });
      const cards = await storage.listRecommendationsForOpportunity(opportunityId, currentUser.organizationId, 25);
      const visibleCards = await filterVisibleCards(currentUser, cards);
      res.json({ cards: visibleCards });
    } catch (err) {
      console.error("[copilot/cards by-opportunity]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  });

  app.get("/api/copilot/cards/by-lane/:laneSig", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const sig = decodeURIComponent(String(req.params.laneSig || ""));
      if (!sig) return res.status(400).json({ error: "lane signature required" });
      const cards = await storage.listRecommendationsForLane(sig, currentUser.organizationId, 25);
      const visibleCards = await filterVisibleCards(currentUser, cards);
      res.json({ cards: visibleCards });
    } catch (err) {
      console.error("[copilot/cards by-lane]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch cards" });
    }
  });

  app.post("/api/copilot/cards/:id/react", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const id = String(req.params.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const parsed = reactToCopilotRecommendationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
      }
      const card = await storage.getCopilotRecommendationInOrg(id, currentUser.organizationId);
      if (!card) return res.status(404).json({ error: "card_not_found" });
      if (!(await canReadCard(currentUser, card))) {
        return res.status(403).json({ error: "forbidden" });
      }
      const updated = await storage.reactToRecommendation(id, currentUser.organizationId, {
        reaction: parsed.data.reaction,
        reason: parsed.data.reason ?? null,
        edits: parsed.data.edits ?? null,
        reactedByUserId: currentUser.id,
      });
      res.json({ card: updated });
    } catch (err) {
      console.error("[copilot/cards react]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to record reaction" });
    }
  });

  // Admin-only — re-run the reasoner against the latest extraction state
  // (e.g. after rep corrections). Always inserts a new history row rather
  // than mutating the prior card.
  app.post("/api/copilot/cards/:documentId/regenerate", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "forbidden" });
      const documentId = String(req.params.documentId || "").trim();
      if (!documentId) return res.status(400).json({ error: "documentId required" });
      const result = await generateAndPersistIntelligenceCard({
        documentId,
        organizationId: currentUser.organizationId,
        generatedByUserId: currentUser.id,
      });
      res.json(result);
    } catch (err) {
      console.error("[copilot/cards regenerate]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to regenerate card" });
    }
  });
}
