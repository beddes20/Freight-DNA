import type { Express, Request, Response } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import { getErrorMessage } from "../lib/errors";
import {
  buildCompanyCallTrendline,
  buildOrgCallPace,
  buildLaneCallRollup,
} from "../services/callTrendlines";

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 90;
  return Math.max(7, Math.min(365, Math.floor(n)));
}

export function registerCallTrendlineRoutes(app: Express) {
  app.get("/api/calls/trendline/company/:companyId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const companyId = pStr(req.params.companyId);
      const company = await storage.getCompany(companyId);
      if (!company || company.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Company not found" });
      }

      const days = clampDays(req.query.days);
      const repId = typeof req.query.repId === "string" && req.query.repId.trim() ? req.query.repId.trim() : undefined;
      const result = await buildCompanyCallTrendline(companyId, days, repId);
      res.json({ ...result, days, repId: repId ?? null });
    } catch (err) {
      console.error("[call-trendline] company error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/calls/pace", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = clampDays(req.query.days);
      const rows = await buildOrgCallPace(user.organizationId, days);
      res.json({ days, rows });
    } catch (err) {
      console.error("[call-trendline] pace error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/calls/lane-rollup", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const lane = String(req.query.lane || "").trim();
      if (!lane) return res.status(400).json({ error: "lane query param required" });
      const days = clampDays(req.query.days);
      const result = await buildLaneCallRollup(user.organizationId, lane, days);
      res.json(result);
    } catch (err) {
      console.error("[call-trendline] lane error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
