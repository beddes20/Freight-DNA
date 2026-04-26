import type { Express, Request, Response } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import { getErrorMessage } from "../lib/errors";
import {
  buildCompanyCallTrendline,
  buildOrgCallPace,
  buildOrgCallTrendline,
  buildLaneCallRollup,
} from "../services/callTrendlines";

// Manager allowlist for org-wide telephony rollups. Mirrors the sidebar
// visibility on /calls and the role set used by accountReviews/coaching so
// non-managers cannot hit the rollup endpoint directly with curl.
const ORG_TELEPHONY_MANAGER_ROLES = new Set([
  "admin",
  "director",
  "national_account_manager",
  "sales_director",
]);

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

      const days = clampDays(qOptStr(req.query.days));
      const repId = qStr(req.query.repId).trim() || undefined;
      const result = await buildCompanyCallTrendline(companyId, days, repId);
      res.json({ ...result, days, repId: repId ?? null });
    } catch (err) {
      console.error("[call-trendline] company error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // Task #691 — org-wide trendline used by the Call Performance Hub.
  // Mirrors the per-company trendline shape so the same React component can
  // render either scope. Optional `repId` narrows to a single rep org-wide.
  app.get("/api/calls/trendline/org", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Org-wide rep telephony rollup is a manager-only surface; non-managers
      // (account_manager, sales, logistics_*) have no business reason to see
      // peers' call counts and historically only access company-scoped data.
      if (!ORG_TELEPHONY_MANAGER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Insufficient role for org-wide call rollup" });
      }
      const days = clampDays(qOptStr(req.query.days));
      const repId = qStr(req.query.repId).trim() || undefined;
      const result = await buildOrgCallTrendline(user.organizationId, days, repId);
      res.json({ ...result, days, repId: repId ?? null });
    } catch (err) {
      console.error("[call-trendline] org error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/calls/pace", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = clampDays(qOptStr(req.query.days));
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
      const lane = (qStr(req.query.lane) || "").trim();
      if (!lane) return res.status(400).json({ error: "lane query param required" });
      const days = clampDays(qOptStr(req.query.days));
      const result = await buildLaneCallRollup(user.organizationId, lane, days);
      res.json(result);
    } catch (err) {
      console.error("[call-trendline] lane error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
