/**
 * Email Intelligence Internal Debug Routes (Task #191 / #194)
 *
 * All routes gated by INTERNAL_SERVICE_TOKEN (x-internal-token header or
 * Authorization: Bearer <token>). Returns raw data for debugging and analysis.
 *
 * GET /internal/accounts/:accountId/email-signals
 * GET /internal/carriers/:carrierId/email-signals
 * GET /internal/opportunities/:id/email-signals       (Task #194)
 * GET /internal/email-intelligence/thread/:threadId
 * GET /internal/carriers/:carrierId/email-suggestions
 * GET /internal/email-intelligence/win-loss
 */

import type { Express, Request, Response, NextFunction } from "express";
import { pStr, qOptStr, qStr } from "../lib/req";
import { storage } from "../storage";

const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  if (!SERVICE_TOKEN) {
    return res.status(503).json({ error: "Internal service token not configured" });
  }
  const token =
    (req.headers["x-internal-token"] as string) ||
    (req.headers["authorization"]?.startsWith("Bearer ")
      ? req.headers["authorization"].slice(7)
      : "");
  if (!token || token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function registerEmailIntelligenceRoutes(app: Express): void {
  // All routes under /api/internal/email-intelligence and related paths are gated
  app.use("/api/internal/accounts/:accountId/email-signals", requireServiceToken);
  app.use("/api/internal/carriers/:carrierId/email-signals", requireServiceToken);
  app.use("/api/internal/carriers/:carrierId/email-suggestions", requireServiceToken);
  app.use("/api/internal/opportunities/:id/email-signals", requireServiceToken);
  app.use("/api/internal/email-intelligence", requireServiceToken);

  // ── GET /api/internal/accounts/:accountId/email-signals ───────────────────
  app.get("/api/internal/accounts/:accountId/email-signals", async (req: Request, res: Response) => {
    try {
      const accountId = pStr(req.params.accountId);
      const limit = parseInt(qStr(req.query.limit) ?? "100", 10);
      const signals = await storage.getEmailSignalsForAccount(accountId, limit);
      res.json({ accountId, count: signals.length, signals });
    } catch (err) {
      console.error("[emailIntelligence] /accounts/:accountId/email-signals error:", err);
      res.status(500).json({ error: "Failed to fetch email signals" });
    }
  });

  // ── GET /api/internal/carriers/:carrierId/email-signals ───────────────────
  app.get("/api/internal/carriers/:carrierId/email-signals", async (req: Request, res: Response) => {
    try {
      const carrierId = pStr(req.params.carrierId);
      const limit = parseInt(qStr(req.query.limit) ?? "100", 10);
      const signals = await storage.getEmailSignalsForCarrier(carrierId, limit);
      res.json({ carrierId, count: signals.length, signals });
    } catch (err) {
      console.error("[emailIntelligence] /carriers/:carrierId/email-signals error:", err);
      res.status(500).json({ error: "Failed to fetch carrier email signals" });
    }
  });

  // ── GET /api/internal/carriers/:carrierId/email-suggestions ──────────────
  app.get("/api/internal/carriers/:carrierId/email-suggestions", async (req: Request, res: Response) => {
    try {
      const carrierId = pStr(req.params.carrierId);
      const status = qOptStr(req.query.status);
      const suggestions = await storage.getCarrierEmailSuggestions(carrierId, status);
      res.json({ carrierId, count: suggestions.length, suggestions });
    } catch (err) {
      console.error("[emailIntelligence] /carriers/:carrierId/email-suggestions error:", err);
      res.status(500).json({ error: "Failed to fetch carrier email suggestions" });
    }
  });

  // ── GET /api/internal/email-intelligence/thread/:threadId ─────────────────
  app.get("/api/internal/email-intelligence/thread/:threadId", async (req: Request, res: Response) => {
    try {
      const threadId = pStr(req.params.threadId);
      const signals = await storage.getEmailSignalsByThread(threadId);
      res.json({ threadId, count: signals.length, signals });
    } catch (err) {
      console.error("[emailIntelligence] /thread/:threadId error:", err);
      res.status(500).json({ error: "Failed to fetch thread signals" });
    }
  });

  // ── GET /api/internal/email-intelligence/win-loss ─────────────────────────
  // Queryable win/loss evidence — supports ?outcomeType=won|lost
  app.get("/api/internal/email-intelligence/win-loss", async (req: Request, res: Response) => {
    try {
      const outcomeType = qStr(req.query.outcomeType) ?? "won";
      if (outcomeType !== "won" && outcomeType !== "lost") {
        return res.status(400).json({ error: "outcomeType must be 'won' or 'lost'" });
      }
      const results = await storage.getWinLossEmailSignals(outcomeType);
      res.json({ outcomeType, count: results.length, results });
    } catch (err) {
      console.error("[emailIntelligence] /win-loss error:", err);
      res.status(500).json({ error: "Failed to fetch win/loss signals" });
    }
  });

  // ── GET /api/internal/opportunities/:id/email-signals (Task #194) ─────────
  // Returns email signals linked to an opportunity via linkedOpportunityId
  // or via email_messages.linkedLoadId (proxy for opportunityId).
  app.get("/api/internal/opportunities/:id/email-signals", async (req: Request, res: Response) => {
    try {
      const opportunityId = pStr(req.params.id);
      const limit = parseInt(qStr(req.query.limit) ?? "100", 10);
      const signals = await storage.getEmailSignalsForOpportunity(opportunityId, limit);
      res.json({
        opportunityId,
        count: signals.length,
        signals: signals.map(s => ({
          id: s.id,
          intentType: s.intentType,
          intentSubtype: s.intentSubtype,
          actorType: s.actorType,
          confidence: s.confidence,
          createdAt: s.createdAt,
          linkedAccountId: s.linkedAccountId,
          linkedCarrierId: s.linkedCarrierId,
          linkedLaneId: s.linkedLaneId,
          linkedOpportunityId: s.linkedOpportunityId,
        })),
      });
    } catch (err) {
      console.error("[emailIntelligence] /opportunities/:id/email-signals error:", err);
      res.status(500).json({ error: "Failed to fetch opportunity email signals" });
    }
  });
}
