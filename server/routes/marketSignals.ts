/**
 * Internal Market Signal API Routes
 *
 * All routes require the `x-internal-token` header (or `Authorization: Bearer <token>`)
 * matching the INTERNAL_SERVICE_TOKEN environment variable. 
 * Requests without a valid token receive 401.
 *
 * POST /api/internal/market-events               — record a normalized event
 * POST /api/internal/market-signals/evaluate     — trigger evaluation manually
 * POST /api/internal/market-signals/:id/suppress — suppress a signal
 * GET  /api/internal/market-signals              — list active signals with filters
 * GET  /api/internal/market-signals/:id          — signal detail with full evidence payload
 * GET  /api/internal/market-nbas                 — NBAs for a specific account, user, or signal
 */

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { getErrorMessage } from "../lib/errors";
import { MarketSignalEngine } from "../marketSignalEngine";
import type { MarketScopeType, MarketSignalType, MarketSignalStatus } from "@shared/schema";

const engine = new MarketSignalEngine(storage);
const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  if (!SERVICE_TOKEN) {
    return res.status(503).json({ error: "Internal service token not configured" });
  }
  
  // Support both Task #185's x-internal-token and Task #186's Bearer token patterns
  const token = (req.headers["x-internal-token"] as string) || 
                (req.headers["authorization"]?.startsWith("Bearer ") ? req.headers["authorization"].slice(7) : "");

  if (!token || token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export function registerMarketSignalRoutes(app: Express): void {
  // All internal routes are protected
  app.use("/api/internal/market-events", requireServiceToken);
  app.use("/api/internal/market-signals", requireServiceToken);
  app.use("/api/internal/market-nbas", requireServiceToken);
  app.use("/api/internal/carriers", requireServiceToken);

  // ── POST /api/internal/market-events ──────────────────────────────────────
  // Record a normalized inbound event.
  app.post("/api/internal/market-events", async (req, res) => {
    try {
      const event = await engine.recordMarketEvent(req.body);
      res.status(201).json({ event });
    } catch (err: unknown) {
      const e = err as { name?: string; errors?: unknown; message?: string };
      if (e?.name === "ZodError") {
        return res.status(400).json({ error: "Invalid event payload", issues: e.errors });
      }
      console.error("[market-signals] recordEvent error:", err);
      res.status(500).json({ error: "Failed to record market event" });
    }
  });

  // ── POST /api/internal/market-signals/evaluate ────────────────────────────
  // Trigger signal evaluation (for manual or test runs).
  app.post("/api/internal/market-signals/evaluate", async (req, res) => {
    try {
      const { scopeType, scopeKey } = req.body ?? {};
      await engine.evaluateMarketSignals(
        scopeType || scopeKey
          ? { scopeType: scopeType as MarketScopeType | undefined, scopeKey }
          : undefined,
      );
      res.json({ ok: true, evaluatedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[market-signals] evaluate error:", err);
      res.status(500).json({ error: "Failed to evaluate market signals" });
    }
  });

  // ── POST /api/internal/market-signals/:id/suppress ────────────────────────
  // Suppress a signal — removes it from active tracking without resolving.
  // Suppressed signals do not participate in lifecycle transitions.
  app.post("/api/internal/market-signals/:id/suppress", async (req, res) => {
    try {
      const signal = await engine.getMarketSignalById(req.params.id);
      if (!signal) {
        return res.status(404).json({ error: "Signal not found" });
      }
      await engine.suppressMarketSignal(req.params.id);
      res.json({ ok: true, id: req.params.id, status: "suppressed" });
    } catch (err) {
      console.error("[market-signals] suppress error:", err);
      res.status(500).json({ error: "Failed to suppress market signal" });
    }
  });

  // ── GET /api/internal/market-signals ──────────────────────────────────────
  // List active (and optionally cooling) signals with optional filters.
  app.get("/api/internal/market-signals", async (req, res) => {
    try {
      const {
        scopeType,
        scopeKey,
        equipmentType,
        signalType,
        status,
      } = req.query as Record<string, string | undefined>;

      const signals = await engine.getActiveMarketSignals({
        scopeType: scopeType as MarketScopeType | undefined,
        scopeKey,
        equipmentType,
        signalType: signalType as MarketSignalType | undefined,
        status: status ? [status as MarketSignalStatus] : ["active", "cooling"],
      });

      res.json({ signals, total: signals.length });
    } catch (err) {
      console.error("[market-signals] list error:", err);
      res.status(500).json({ error: "Failed to list market signals" });
    }
  });

  // ── GET /api/internal/market-signals/:id ──────────────────────────────────
  // Signal detail with full evidence payload.
  app.get("/api/internal/market-signals/:id", async (req, res) => {
    try {
      const signal = await engine.getMarketSignalById(req.params.id);
      if (!signal) {
        return res.status(404).json({ error: "Signal not found" });
      }
      res.json({ signal });
    } catch (err) {
      console.error("[market-signals] detail error:", err);
      res.status(500).json({ error: "Failed to load market signal" });
    }
  });

  // ── GET /api/internal/market-nbas ─────────────────────────────────────────
  // NBAs tied to a specific account, user, or signal (Task #186).
  app.get("/api/internal/market-nbas", async (req, res) => {
    try {
      const { companyId, userId, signalId } = req.query as Record<string, string | undefined>;

      if (signalId) {
        const cards = await storage.getNbaCardsByMarketSignal(signalId);
        return res.json({ cards });
      }

      if (companyId) {
        const cards = await storage.getNbaCardsByCompanyAndRuleType(
          companyId,
          "market_surge_customer_outreach",
        );
        return res.json({ cards });
      }

      if (userId) {
        const cards = await storage.getNbaCardsByUserId(
          userId,
          "market_surge_customer_outreach",
        );
        return res.json({ cards });
      }

      return res.status(400).json({ error: "Provide one of: companyId, userId, signalId" });
    } catch (err) {
      console.error("[market-nbas route]", getErrorMessage(err));
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /api/internal/market-signals/carrier-nbas ─────────────────────────
  // Carrier NBAs for a specific market signal.
  app.get("/api/internal/market-signals/carrier-nbas", async (req, res) => {
    try {
      const { marketSignalId } = req.query as Record<string, string | undefined>;
      if (!marketSignalId) {
        return res.status(400).json({ error: "marketSignalId query parameter is required" });
      }
      const nbas = await storage.getCarrierMarketNbasBySignal(marketSignalId);
      res.json({ nbas, total: nbas.length });
    } catch (err) {
      console.error("[carrier-market-nbas by signal]", getErrorMessage(err));
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /api/internal/carriers/:carrierId/market-nbas ─────────────────────
  // All carrier market NBAs for a specific carrier.
  app.get("/api/internal/carriers/:carrierId/market-nbas", async (req, res) => {
    try {
      const { carrierId } = req.params;
      if (!carrierId) {
        return res.status(400).json({ error: "carrierId path parameter is required" });
      }
      const nbas = await storage.getCarrierMarketNbasByCarrier(carrierId);
      res.json({ nbas, total: nbas.length });
    } catch (err) {
      console.error("[carrier-market-nbas by carrier]", getErrorMessage(err));
      return res.status(500).json({ error: "Internal server error" });
    }
  });
}
