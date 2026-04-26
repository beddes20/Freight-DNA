/**
 * Carrier Intelligence / load_fact admin routes (Task #368).
 *
 * Admin-gated. Surfaces:
 *   - PowerBI URL settings (read/write)
 *   - Manual import trigger
 *   - Import history audit
 *   - Backfill trigger (financial_uploads + freight_opportunities)
 *   - Parity report
 *   - Cutover gate (load_fact_active feature flag) with parity safety check
 *   - Counts/summary (lightweight read for the admin page)
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  loadFactPowerBiUrlKey,
  loadFactScheduleKey,
  loadFactLastImportKey,
  listLoadFactImports,
  getLoadFactCounts,
  isLoadFactActive,
  setLoadFactActive,
  getLoadFactScheduleConfig,
  setLoadFactScheduleConfig,
  getCombinedMetrics,
} from "../carrierIntelligenceService";
import { performLoadFactImport } from "../loadFactPowerBIImporter";
import { backfillAll, backfillFromFinancialUploads, backfillFromFreightOpportunities } from "../loadFactBackfill";
import { runParityHarness } from "../loadFactParity";
import { getErrorMessage } from "../lib/errors";
import { qOptStr, qStr } from "../lib/req";

export function registerLoadFactRoutes(app: Express): void {
  // ── Settings: PowerBI URL ────────────────────────────────────────────────

  app.get("/api/admin/load-fact/settings", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const orgId = user.organizationId;
      const [url, schedule, lastImportRaw, active, counts] = await Promise.all([
        storage.getSetting(loadFactPowerBiUrlKey(orgId)),
        storage.getSetting(loadFactScheduleKey(orgId)),
        storage.getSetting(loadFactLastImportKey(orgId)),
        isLoadFactActive(orgId),
        getLoadFactCounts(orgId),
      ]);
      let lastImport: unknown = null;
      if (lastImportRaw) { try { lastImport = JSON.parse(lastImportRaw); } catch { lastImport = lastImportRaw; } }
      return res.json({
        url: url ?? null,
        schedule: schedule ?? null,
        lastImport,
        cutoverActive: active,
        counts,
      });
    } catch (err) {
      console.error("[load-fact/settings GET]", err);
      return res.status(500).json({ error: "Failed to read load_fact settings" });
    }
  });

  const settingsSchema = z.object({
    url: z.string().trim().min(1).max(2000).optional().nullable(),
    schedule: z.string().trim().max(100).optional().nullable(),
  });
  app.put("/api/admin/load-fact/settings", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const parsed = settingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      const orgId = user.organizationId;
      if (parsed.data.url !== undefined) {
        await storage.setSetting(loadFactPowerBiUrlKey(orgId), parsed.data.url ?? "");
      }
      if (parsed.data.schedule !== undefined) {
        await storage.setSetting(loadFactScheduleKey(orgId), parsed.data.schedule ?? "");
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("[load-fact/settings PUT]", err);
      return res.status(500).json({ error: "Failed to update load_fact settings" });
    }
  });

  // ── Schedule config ──────────────────────────────────────────────────────

  app.get("/api/admin/load-fact/schedule", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const cfg = await getLoadFactScheduleConfig(user.organizationId);
      return res.json(cfg);
    } catch (err) {
      console.error("[load-fact/schedule GET]", err);
      return res.status(500).json({ error: "Failed to read load_fact schedule" });
    }
  });

  const scheduleSchema = z.object({
    morningEnabled: z.boolean().optional(),
    afternoonEnabled: z.boolean().optional(),
    cadence: z.enum(["weekdays", "daily", "off"]).optional(),
    pauseUntil: z.string().min(1).optional().nullable(),
  });
  app.put("/api/admin/load-fact/schedule", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const parsed = scheduleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      const next = await setLoadFactScheduleConfig(user.organizationId, parsed.data);
      return res.json(next);
    } catch (err) {
      console.error("[load-fact/schedule PUT]", err);
      return res.status(500).json({ error: "Failed to update load_fact schedule" });
    }
  });

  // ── Metrics (Available vs Realized vs Active) ───────────────────────────

  app.get("/api/admin/load-fact/metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const filter: Record<string, string | undefined> = {};
      const month = qOptStr(req.query.month);
      const carrierName = qOptStr(req.query.carrier);
      const customerName = qOptStr(req.query.customer);
      const accountManager = qOptStr(req.query.accountManager);
      if (month) filter.month = month;
      if (carrierName) filter.carrierName = carrierName;
      if (customerName) filter.customerName = customerName;
      if (accountManager) filter.accountManager = accountManager;
      const metrics = await getCombinedMetrics(user.organizationId, filter);
      return res.json(metrics);
    } catch (err) {
      console.error("[load-fact/metrics]", err);
      return res.status(500).json({ error: "Failed to compute load_fact metrics" });
    }
  });

  // ── Manual import ────────────────────────────────────────────────────────

  app.post("/api/admin/load-fact/import", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const summary = await performLoadFactImport({
        orgId: user.organizationId,
        actorUserId: user.id,
        triggeredBy: "manual",
      });
      return res.json({ ok: true, summary });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[load-fact/import]", msg);
      return res.status(400).json({ error: msg });
    }
  });

  // ── Audit log ────────────────────────────────────────────────────────────

  app.get("/api/admin/load-fact/imports", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const limit = Math.min(100, Math.max(1, parseInt(qStr(req.query.limit) || "25", 10) || 25));
      const imports = await listLoadFactImports(user.organizationId, limit);
      return res.json({ imports });
    } catch (err) {
      console.error("[load-fact/imports]", err);
      return res.status(500).json({ error: "Failed to list imports" });
    }
  });

  // ── Backfill ─────────────────────────────────────────────────────────────

  const backfillSchema = z.object({
    source: z.enum(["financial_uploads", "freight_opportunities", "all"]).default("all"),
  });
  app.post("/api/admin/load-fact/backfill", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const parsed = backfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
      const orgId = user.organizationId;
      if (parsed.data.source === "financial_uploads") {
        const result = await backfillFromFinancialUploads(orgId, user.id);
        return res.json({ ok: true, result });
      }
      if (parsed.data.source === "freight_opportunities") {
        const result = await backfillFromFreightOpportunities(orgId, user.id);
        return res.json({ ok: true, result });
      }
      const result = await backfillAll(orgId, user.id);
      return res.json({ ok: true, result });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[load-fact/backfill]", msg);
      return res.status(500).json({ error: msg });
    }
  });

  // ── Parity ───────────────────────────────────────────────────────────────

  app.get("/api/admin/load-fact/parity", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const tolerance = Math.max(0.5, Math.min(50, parseFloat(qStr(req.query.tolerance) || "5") || 5));
      const report = await runParityHarness(user.organizationId, tolerance);
      return res.json(report);
    } catch (err) {
      console.error("[load-fact/parity]", err);
      return res.status(500).json({ error: "Failed to compute parity report" });
    }
  });

  // ── Cutover ──────────────────────────────────────────────────────────────

  const cutoverSchema = z.object({
    enabled: z.boolean(),
    /** When true, allow cutover even if parity drift exceeds tolerance. */
    force: z.boolean().optional().default(false),
    tolerancePct: z.number().min(0.5).max(50).optional().default(5),
  });
  app.post("/api/admin/load-fact/cutover", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const parsed = cutoverSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      const orgId = user.organizationId;

      // Turning OFF is always safe — there's no risk to falling back to legacy.
      // Turning ON runs the parity harness as a safety check unless `force`.
      if (parsed.data.enabled && !parsed.data.force) {
        const report = await runParityHarness(orgId, parsed.data.tolerancePct);
        if (!report.withinTolerance) {
          return res.status(409).json({
            error: "Cutover blocked by parity drift",
            report,
            hint: "Re-run backfill, investigate the drift, or pass { force: true } to override.",
          });
        }
      }

      await setLoadFactActive(orgId, parsed.data.enabled, user.id);
      return res.json({ ok: true, cutoverActive: parsed.data.enabled });
    } catch (err) {
      console.error("[load-fact/cutover]", err);
      return res.status(500).json({ error: "Failed to update cutover flag" });
    }
  });
}
