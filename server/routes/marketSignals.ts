/**
 * Internal Market Signal API Routes
 *
 * All routes require the `x-internal-token` header matching the INTERNAL_SERVICE_TOKEN
 * environment variable. Requests without a valid token receive 401.
 *
 * POST /api/internal/market-events               — record a normalized event
 * POST /api/internal/market-signals/evaluate     — trigger evaluation manually
 * POST /api/internal/market-signals/:id/suppress — suppress a signal
 * GET  /api/internal/market-signals              — list active signals with filters
 * GET  /api/internal/market-signals/:id          — signal detail with full evidence payload
 */

import type { Express } from "express";
import { storage } from "../storage";
import { MarketSignalEngine } from "../marketSignalEngine";
import type { MarketScopeType, MarketSignalType, MarketSignalStatus } from "@shared/schema";

const engine = new MarketSignalEngine(storage);

export function registerMarketSignalRoutes(app: Express): void {
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
}
