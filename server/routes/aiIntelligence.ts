import { Router, type Express } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { requireAuth, getCurrentUser } from "../auth";
import {
  generateMeetingPrepBrief, getRecentBriefs,
  analyzeContactSentiment, getCompanySentiment,
  analyzeFollowUpTiming, getFollowUpRecommendations,
  generateRelationshipCoaching, getRelationshipCoaching,
  analyzeOrgChartGaps, getOrgChartGaps,
  findWarmIntroPaths,
  findLookAlikes,
  analyzeCrossSellOpportunities,
  generateWalletSharePlay,
  analyzeWinLossPatterns, getWinLossPatterns,
  detectCompetitiveSignals, getCompetitiveSignals,
  getAIIntelligenceDashboard,
  bulkAnalyzeCompanySentiment,
  bulkAnalyzeCompanyFollowUps,
} from "../services/aiIntelligenceService";
import { db } from "../storage";
import { contacts, companies, orgChartGaps, warmIntroSuggestions, crossSellOpportunities, competitiveSignals, walletSharePlays, accountLookAlikes, relationshipCoachingInsights } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

export function registerAIIntelligenceRoutes(app: Express) {
  app.get("/api/ai-intelligence/dashboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = await getAIIntelligenceDashboard(user.organizationId);
      res.json(data);
    } catch (err: any) {
      console.error("[ai-intelligence] dashboard error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/meeting-prep/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const brief = await generateMeetingPrepBrief(user.organizationId, pStr(req.params.companyId), user.id);
      res.json(brief);
    } catch (err: any) {
      console.error("[ai-intelligence] meeting-prep error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/meeting-prep/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const briefs = await getRecentBriefs(user.organizationId, pStr(req.params.companyId));
      res.json({ briefs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/sentiment/:companyId/:contactId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const result = await analyzeContactSentiment(user.organizationId, pStr(req.params.companyId), pStr(req.params.contactId));
      res.json(result);
    } catch (err: any) {
      console.error("[ai-intelligence] sentiment error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/sentiment/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = await getCompanySentiment(user.organizationId, pStr(req.params.companyId));
      const contactIds = [...new Set(data.map(d => d.contactId).filter(Boolean))];
      let contactMap: Record<string, string> = {};
      if (contactIds.length) {
        const contactRows = await db.select({ id: contacts.id, name: contacts.name })
          .from(contacts)
          .innerJoin(companies, eq(contacts.companyId, companies.id))
          .where(and(inArray(contacts.id, contactIds), eq(companies.organizationId, user.organizationId)));
        for (const row of contactRows) contactMap[row.id] = row.name;
      }
      const enriched = data.map(d => ({ ...d, contactName: contactMap[d.contactId] || null }));
      res.json({ sentiment: enriched });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/follow-up/:companyId/:contactId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const result = await analyzeFollowUpTiming(user.organizationId, pStr(req.params.companyId), pStr(req.params.contactId));
      res.json(result);
    } catch (err: any) {
      console.error("[ai-intelligence] follow-up error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/follow-ups", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const companyId = qOptStr(req.query.companyId);
      const data = await getFollowUpRecommendations(user.organizationId, companyId);
      const contactIds = [...new Set(data.map(d => d.contactId).filter(Boolean))];
      let contactMap: Record<string, string> = {};
      if (contactIds.length) {
        const contactRows = await db.select({ id: contacts.id, name: contacts.name })
          .from(contacts)
          .innerJoin(companies, eq(contacts.companyId, companies.id))
          .where(and(inArray(contacts.id, contactIds), eq(companies.organizationId, user.organizationId)));
        for (const row of contactRows) contactMap[row.id] = row.name;
      }
      const enriched = data.map(d => ({ ...d, contactName: contactMap[d.contactId] || null }));
      res.json({ recommendations: enriched });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/sentiment-bulk/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const results = await bulkAnalyzeCompanySentiment(user.organizationId, pStr(req.params.companyId));
      res.json({ results });
    } catch (err: any) {
      console.error("[ai-intelligence] bulk sentiment error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/follow-up-bulk/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const results = await bulkAnalyzeCompanyFollowUps(user.organizationId, pStr(req.params.companyId));
      res.json({ results });
    } catch (err: any) {
      console.error("[ai-intelligence] bulk follow-up error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/coaching/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const insights = await generateRelationshipCoaching(user.organizationId, pStr(req.params.companyId));
      res.json({ insights });
    } catch (err: any) {
      console.error("[ai-intelligence] coaching error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/coaching/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const insights = await getRelationshipCoaching(user.organizationId, pStr(req.params.companyId));
      res.json({ insights });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/org-gaps/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const gaps = await analyzeOrgChartGaps(user.organizationId, pStr(req.params.companyId));
      res.json({ gaps });
    } catch (err: any) {
      console.error("[ai-intelligence] org-gaps error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/org-gaps/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const gaps = await getOrgChartGaps(user.organizationId, pStr(req.params.companyId));
      res.json({ gaps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/ai-intelligence/org-gaps/:gapId/dismiss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      await db.update(orgChartGaps)
        .set({ status: "dismissed" })
        .where(and(eq(orgChartGaps.id, pStr(req.params.gapId)), eq(orgChartGaps.orgId, user.organizationId)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/warm-intros/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const suggestions = await findWarmIntroPaths(user.organizationId, pStr(req.params.companyId));
      res.json({ suggestions });
    } catch (err: any) {
      console.error("[ai-intelligence] warm-intros error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/look-alikes/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const matches = await findLookAlikes(user.organizationId, pStr(req.params.companyId));
      res.json({ matches });
    } catch (err: any) {
      console.error("[ai-intelligence] look-alikes error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/cross-sell/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opportunities = await analyzeCrossSellOpportunities(user.organizationId, pStr(req.params.companyId));
      res.json({ opportunities });
    } catch (err: any) {
      console.error("[ai-intelligence] cross-sell error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/cross-sell/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opps = await db.select()
        .from(crossSellOpportunities)
        .where(and(eq(crossSellOpportunities.orgId, user.organizationId), eq(crossSellOpportunities.companyId, pStr(req.params.companyId))));
      res.json({ opportunities: opps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/wallet-share/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const play = await generateWalletSharePlay(user.organizationId, pStr(req.params.companyId));
      res.json(play);
    } catch (err: any) {
      console.error("[ai-intelligence] wallet-share error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/wallet-share/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const plays = await db.select()
        .from(walletSharePlays)
        .where(and(eq(walletSharePlays.orgId, user.organizationId), eq(walletSharePlays.companyId, pStr(req.params.companyId))));
      res.json({ plays });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/win-loss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "sales_director", "director"].includes(user.role)) {
        return res.status(403).json({ error: "Leadership only" });
      }
      const patterns = await analyzeWinLossPatterns(user.organizationId);
      res.json({ patterns });
    } catch (err: any) {
      console.error("[ai-intelligence] win-loss error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/win-loss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const patterns = await getWinLossPatterns(user.organizationId);
      res.json({ patterns });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-intelligence/competitive/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const signals = await detectCompetitiveSignals(user.organizationId, pStr(req.params.companyId));
      res.json({ signals });
    } catch (err: any) {
      console.error("[ai-intelligence] competitive error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-intelligence/competitive", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const companyId = qOptStr(req.query.companyId);
      const signals = await getCompetitiveSignals(user.organizationId, companyId);
      res.json({ signals });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/ai-intelligence/competitive/:signalId/dismiss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      await db.update(competitiveSignals)
        .set({ status: "dismissed" })
        .where(and(eq(competitiveSignals.id, pStr(req.params.signalId)), eq(competitiveSignals.orgId, user.organizationId)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/ai-intelligence/cross-sell/:oppId/status", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { status } = req.body;
      await db.update(crossSellOpportunities)
        .set({ status })
        .where(and(eq(crossSellOpportunities.id, pStr(req.params.oppId)), eq(crossSellOpportunities.orgId, user.organizationId)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/ai-intelligence/coaching/:insightId/dismiss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      await db.update(relationshipCoachingInsights)
        .set({ status: "dismissed" })
        .where(and(eq(relationshipCoachingInsights.id, pStr(req.params.insightId)), eq(relationshipCoachingInsights.orgId, user.organizationId)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
