/**
 * Sonar Public API Routes
 *
 * GET /api/sonar/market-pulse        — national OTRI, NTI/move, contract $/mile (+ role-specific data)
 * GET /api/sonar/market-otris        — per-market OTRI for a ?markets= list
 * GET /api/sonar/lane-signals        — VOTRI for one lane (?origin=&destination=) or batch (?lanes=origin|dest,...)
 * POST /api/sonar/lane-signals/batch — batch VOTRI fetch (legacy; prefer GET ?lanes= batch form)
 *
 * All routes require an authenticated session.
 */

import type { Express, Request, Response } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import {
  getNationalMarketSummary,
  getMarketOtris,
  getLaneVotrisBatch,
  buildVotriQualifier,
  getSonarCircuitBreakerStatus,
  getLaneMarketRate,
  probeSonarHealth,
  runDailySonarRefresh,
  type LaneVotri,
} from "../sonarClient";
import { getLaneTimeoutStats } from "../sonarAlertNotifier";
import { tracLaneDirectionSignal } from "../tracAlertEngine";

/** Normalize string for name-matching (same logic as NBA engine) */
function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * For a given org, extract the top origin cities (by load count) from the latest
 * financial upload, optionally filtered by a list of company IDs.
 * Returns { city, loads }[] sorted descending by load count.
 */
async function getTopOriginMarkets(
  orgId: string,
  limit: number,
  companyIds?: string[],
): Promise<Array<{ city: string; loads: number; companyCount: number }>> {
  const uploads = await storage.getFinancialUploadsForOrg(orgId).catch(() => []);
  if (uploads.length === 0) return [];

  const latestUpload = uploads.sort((a, b) =>
    (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")
  )[0];
  const rawRows: unknown = latestUpload.rows;
  const allRows: Record<string, unknown>[] = Array.isArray(rawRows) ? rawRows as Record<string, unknown>[] : [];

  let companies: any[] = [];
  if (companyIds) {
    const allComps = await storage.getCompanies(orgId).catch(() => []);
    companies = allComps.filter(c => companyIds.includes(c.id));
  }

  // Build origin city tally
  const cityMap = new Map<string, { loads: number; companies: Set<string> }>();

  for (const row of allRows) {
    const origin = String(
      row.originCity ?? row["Shipper city"] ?? row["Origin city"] ?? row["shipper_city"] ?? ""
    ).trim();
    if (!origin) continue;

    // If filtering by company, check customer name match
    if (companyIds && companyIds.length > 0) {
      const cust = norm(String(row.customerName ?? row["Customer Name"] ?? row["CUSTOMER NAME"] ?? ""));
      const matched = companies.some(c => {
        const names = [norm(c.name), ...(c.financialAlias ? (c.financialAlias as string).split(",").map((s: string) => norm(s.trim())).filter(Boolean) : [])];
        return names.some(n => n && cust.includes(n));
      });
      if (!matched) continue;
    }

    const cur = cityMap.get(origin) ?? { loads: 0, companies: new Set<string>() };
    cur.loads++;
    const custName = String(row.customerName ?? row["Customer Name"] ?? "");
    if (custName) cur.companies.add(custName);
    cityMap.set(origin, cur);
  }

  return Array.from(cityMap.entries())
    .map(([city, d]) => ({ city, loads: d.loads, companyCount: d.companies.size }))
    .sort((a, b) => b.loads - a.loads)
    .slice(0, limit);
}

export function registerSonarRoutes(app: Express): void {

  // ── GET /api/sonar/market-pulse?role=... ─────────────────────────────────────
  // Returns national summary + optional role-specific intelligence block.
  app.get("/api/sonar/market-pulse", requireAuth, async (req: Request, res: Response) => {
    try {
      const role = (req.query.role as string | undefined)?.trim();
      const national = await getNationalMarketSummary();
      const cbStatus = getSonarCircuitBreakerStatus();
      const nationalWithStatus = {
        ...national,
        ...(cbStatus.isOpen ? { marketDataLimited: true, marketDataResumesAt: cbStatus.resumesAt } : {}),
      };

      if (!role) {
        return res.json(nationalWithStatus);
      }

      const user = await getCurrentUser(req);
      if (!user) return res.json(nationalWithStatus);

      // Map canonical DB roles to payload keys; never trust the query-param role for non-admin/director users.
      const DB_ROLE_TO_PAYLOAD: Record<string, string> = {
        account_manager:          "am",
        national_account_manager: "nam",
        director:                 "director",
        admin:                    "director",   // admins see director view
        sales_director:           "director",
        logistics_manager:        "logistics_manager",
        logistics_coordinator:    "logistics_manager",
        sales:                    "am",
      };
      // resolvedRole is always derived from the authenticated user's DB role; query param is ignored for RBAC enforcement
      const resolvedRole = DB_ROLE_TO_PAYLOAD[user.role] ?? "am";

      const orgId = req.session.organizationId!;

      // ── AM: top 3 markets affecting their accounts ──────────────────────────
      if (resolvedRole === "am") {
        const assignedCompanies = await storage.getCompanies(orgId).catch(() => []);
        const myCompanies = assignedCompanies.filter(c => c.assignedTo === user.id);
        const myIds = myCompanies.map(c => c.id);

        const topMarkets = await getTopOriginMarkets(orgId, 5, myIds);
        const marketNames = topMarkets.map(m => m.city);
        const otris = marketNames.length > 0 ? await getMarketOtris(marketNames) : [];
        const otriMap = new Map(otris.map(o => [o.market.toLowerCase(), o]));

        const markets = topMarkets.map(m => {
          const otri = otriMap.get(m.city.toLowerCase());
          return {
            city: m.city,
            loads: m.loads,
            companyCount: m.companyCount,
            otri: otri?.otri ?? null,
            otriWoW: otri?.otriWoW ?? null,
            signal: otri?.signal ?? null,
          };
        }).sort((a, b) => {
            if (a.otri === null && b.otri !== null) return 1;
            if (a.otri !== null && b.otri === null) return -1;
            return Math.abs(b.otriWoW ?? 0) - Math.abs(a.otriWoW ?? 0);
          })
          .slice(0, 3);

        return res.json({ ...nationalWithStatus, rolePayload: { role: "am", markets, myAccountCount: myCompanies.length } });
      }

      // ── NAM: org-wide city exposure ─────────────────────────────────────────
      if (resolvedRole === "nam") {
        const topMarkets = await getTopOriginMarkets(orgId, 8);
        const marketNames = topMarkets.map(m => m.city);
        const otris = marketNames.length > 0 ? await getMarketOtris(marketNames) : [];
        const otriMap = new Map(otris.map(o => [o.market.toLowerCase(), o]));

        const markets = topMarkets.map(m => {
          const otri = otriMap.get(m.city.toLowerCase());
          return {
            city: m.city,
            loads: m.loads,
            companyCount: m.companyCount,
            otri: otri?.otri ?? null,
            otriWoW: otri?.otriWoW ?? null,
            signal: otri?.signal ?? null,
          };
        }).sort((a, b) => {
            if (a.otri === null && b.otri !== null) return 1;
            if (a.otri !== null && b.otri === null) return -1;
            return Math.abs(b.otriWoW ?? 0) - Math.abs(a.otriWoW ?? 0);
          });

        return res.json({ ...nationalWithStatus, rolePayload: { role: "nam", markets } });
      }

      // ── Director: portfolio heat summary ────────────────────────────────────
      if (resolvedRole === "director") {
        const allLanes = await storage.getRecurringLanes(orgId).catch(() => []);
        const validLanes = allLanes.filter(l => l.origin && l.destination);

        const topMarkets = await getTopOriginMarkets(orgId, 20);
        const marketNames = topMarkets.map(m => m.city);
        const otris = marketNames.length > 0 ? await getMarketOtris(marketNames) : [];
        const otriByMarket = new Map(otris.map(o => [o.market.toLowerCase(), o]));

        let hot = 0, warm = 0, cool = 0, unknown = 0;
        for (const lane of validLanes) {
          const originKey = (lane.origin ?? "").split(",")[0].trim().toLowerCase();
          const mOtri = otriByMarket.get(originKey);
          if (!mOtri || mOtri.signal === null) { unknown++; continue; }
          if (mOtri.signal === "hot") hot++;
          else if (mOtri.signal === "warm") warm++;
          else cool++;
        }

        const spread = national.ratesSpread;

        return res.json({
          ...nationalWithStatus,
          rolePayload: {
            role: "director",
            heatSummary: { hot, warm, cool, unknown, total: validLanes.length },
            ntiPerMove: national.ntiPerMove,
            ntiPerMile: national.ntiPerMile,
            spread,
            topMovingMarkets: otris
              .filter(o => o.otriWoW !== null && Math.abs(o.otriWoW) >= 2)
              .sort((a, b) => Math.abs(b.otriWoW ?? 0) - Math.abs(a.otriWoW ?? 0))
              .slice(0, 5)
              .map(o => ({ city: o.market, otri: o.otri, otriWoW: o.otriWoW, signal: o.signal })),
          },
        });
      }

      // ── Logistics Manager: capacity urgency list (lanes ranked by VOTRI) ────
      if (resolvedRole === "logistics_manager") {
        const allLanes = await storage.getRecurringLanes(orgId, user.id).catch(() => []);
        // All valid lanes — no cap — so VOTRI is evaluated for every owned recurring lane.
        // The UI display list is trimmed to top-10 by urgency (see urgencyLanes.slice below).
        const validLanes = allLanes.filter(l => l.origin && l.destination);

        let urgencyLanes: Array<{
          origin: string;
          destination: string;
          votri: number | null;
          votriWoW: number | null;
          signal: "hot" | "warm" | "stable" | "cool" | null;
          companyName: string;
        }> = [];

        if (validLanes.length > 0) {
          const pairs = validLanes.map(l => ({ origin: l.origin!, destination: l.destination! }));
          const votriMap = await getLaneVotrisBatch(pairs).catch(() => new Map<string, LaneVotri>());

          for (const lane of validLanes) {
            const qualifier = buildVotriQualifier(lane.origin!, lane.destination!);
            const v = votriMap.get(qualifier);
            if (v) {
              const tracDir = await tracLaneDirectionSignal(lane.origin!, lane.destination!).catch(() => null);
              urgencyLanes.push({
                origin: lane.origin!,
                destination: lane.destination!,
                votri: v.votri,
                votriWoW: v.votriWoW,
                signal: tracDir ?? v.signal,
                companyName: lane.companyName ?? "",
              });
            }
          }

          const signalPriority: Record<string, number> = { hot: 4, warm: 3, stable: 1, cool: 0 };
          urgencyLanes.sort((a, b) => (signalPriority[a.signal ?? ""] ?? 2) === (signalPriority[b.signal ?? ""] ?? 2)
            ? (b.votri ?? 0) - (a.votri ?? 0)
            : (signalPriority[b.signal ?? ""] ?? 2) - (signalPriority[a.signal ?? ""] ?? 2));
        }

        return res.json({
          ...nationalWithStatus,
          rolePayload: {
            role: "logistics_manager",
            urgencyLanes: urgencyLanes.slice(0, 10),
          },
        });
      }

      res.json(nationalWithStatus);
    } catch (err) {
      console.error("[sonar] market-pulse error:", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch market pulse" });
    }
  });

  // ── GET /api/sonar/market-otris?markets=Atlanta,Dallas,... ──────────────────
  app.get("/api/sonar/market-otris", requireAuth, async (req: Request, res: Response) => {
    try {
      const raw = req.query.markets as string | undefined;
      if (!raw) return res.json({ otris: [] });
      const markets = raw.split(",").map(m => m.trim()).filter(Boolean).slice(0, 30);
      const otris = await getMarketOtris(markets);
      res.json({ otris });
    } catch (err) {
      console.error("[sonar] market-otris error:", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch market OTRIs" });
    }
  });

  // ── POST /api/sonar/lane-signals/batch ────────────────────────────────────
  // Body: { lanes: [{ origin: string, destination: string }] }
  // Returns: { signals: { qualifier: string, ... }[] }
  app.post("/api/sonar/lane-signals/batch", requireAuth, async (req: Request, res: Response) => {
    try {
      const { lanes } = req.body as { lanes?: Array<{ origin: string; destination: string }> };
      if (!Array.isArray(lanes) || lanes.length === 0) {
        return res.json({ signals: [] });
      }
      const validLanes = lanes.filter(l => l.origin && l.destination);
      const CHUNK_SIZE = 50;
      const allSignals: LaneVotri[] = [];
      for (let i = 0; i < validLanes.length; i += CHUNK_SIZE) {
        const chunk = validLanes.slice(i, i + CHUNK_SIZE);
        const votriMap = await getLaneVotrisBatch(chunk);
        allSignals.push(...Array.from(votriMap.values()));
      }
      for (const sig of allSignals) {
        const tracDir = await tracLaneDirectionSignal(sig.origin, sig.destination).catch(() => null);
        if (tracDir) sig.signal = tracDir;
      }
      res.json({ signals: allSignals });
    } catch (err) {
      console.error("[sonar] lane-signals/batch error:", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch lane signals" });
    }
  });

  // ── GET /api/sonar/lane-signals ──────────────────────────────────────────
  // Single or batch lane signal lookup (spec: GET endpoint supporting a list of pairs).
  //   Single: ?origin=Atlanta&destination=Dallas → { signal }
  //   Batch:  ?lanes=Atlanta|Dallas;Chicago|Memphis  → { signals: [...] }
  //   Pairs are SEMICOLON-separated (not comma) so city names with commas (e.g. "Los Angeles, CA") are safe.
  //   Within each pair, origin and destination are PIPE-separated.
  app.get("/api/sonar/lane-signals", requireAuth, async (req: Request, res: Response) => {
    try {
      const lanesParam = (req.query.lanes as string | undefined)?.trim();
      if (lanesParam) {
        const pairs = lanesParam.split(";")
          .map(s => s.split("|"))
          .filter(parts => parts.length === 2 && parts[0] && parts[1])
          .map(([origin, destination]) => ({ origin: origin.trim(), destination: destination.trim() }));

        if (pairs.length === 0) return res.json({ signals: [] });

        // Process in chunks of 50 to avoid overwhelming the Sonar API while serving all lanes.
        const CHUNK_SIZE = 50;
        const allSignals: LaneVotri[] = [];
        for (let i = 0; i < pairs.length; i += CHUNK_SIZE) {
          const chunk = pairs.slice(i, i + CHUNK_SIZE);
          const votriMap = await getLaneVotrisBatch(chunk);
          allSignals.push(...Array.from(votriMap.values()));
        }
        for (const sig of allSignals) {
          const tracDir = await tracLaneDirectionSignal(sig.origin, sig.destination).catch(() => null);
          if (tracDir) sig.signal = tracDir;
        }
        return res.json({ signals: allSignals });
      }

      // Single lane mode
      const origin = (req.query.origin as string | undefined)?.trim();
      const destination = (req.query.destination as string | undefined)?.trim();
      if (!origin || !destination) {
        return res.status(400).json({ error: "Provide origin+destination or lanes= query param" });
      }
      const votriMap = await getLaneVotrisBatch([{ origin, destination }]);
      const qualifier = buildVotriQualifier(origin, destination);
      const signal = votriMap.get(qualifier) ?? null;
      let tracSpotRpm: number | null = null;
      if (signal) {
        const tracDir = await tracLaneDirectionSignal(origin, destination).catch(() => null);
        if (tracDir) {
          signal.signal = tracDir;
        }
        try {
          const lmr = await getLaneMarketRate(origin, destination);
          tracSpotRpm = lmr.marketRatePerMile;
        } catch {}
      }
      res.json({ signal, tracSpotRpm });
    } catch (err) {
      console.error("[sonar] lane-signals error:", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch lane signal" });
    }
  });

  // ── GET /api/sonar/health ────────────────────────────────────────────────
  // Diagnostic endpoint for Task #465. Reports auth mode, daily-pull status,
  // circuit-breaker state, freshness of the national snapshot, and a live
  // ATL→DAL probe (timed under the hard lane-call budget).
  app.get("/api/sonar/health", requireAuth, async (req: Request, res: Response) => {
    try {
      const origin = (req.query.origin as string | undefined)?.trim() || "Atlanta";
      const destination = (req.query.destination as string | undefined)?.trim() || "Dallas";
      const report = await probeSonarHealth({ laneOrigin: origin, laneDestination: destination });
      const now = Date.now();
      const lastSuccessMs = report.daily.lastSuccessAt ? Date.parse(report.daily.lastSuccessAt) : 0;
      const dailyAgeHours = lastSuccessMs ? (now - lastSuccessMs) / 3_600_000 : null;
      const status =
        !report.national.ok && !report.laneProbe.ok ? "down" :
        report.national.isStale || report.laneProbe.isStale || (dailyAgeHours !== null && dailyAgeHours > 26) ? "degraded" :
        "ok";
      const laneTimeouts = getLaneTimeoutStats();
      res.json({ status, dailyAgeHours, laneTimeouts, ...report });
    } catch (err) {
      console.error("[sonar] health error:", err?.message ?? err);
      res.status(500).json({ status: "down", error: err?.message ?? "probe failed" });
    }
  });

  // ── POST /api/sonar/health/refresh (admin) ────────────────────────────────
  // Manually trigger the daily refresh for testing / on-demand recovery.
  app.post("/api/sonar/health/refresh", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "admin only" });
      }
      const status = await runDailySonarRefresh();
      res.json({ ok: true, status });
    } catch (err) {
      console.error("[sonar] manual refresh error:", err?.message ?? err);
      res.status(500).json({ error: err?.message ?? "refresh failed" });
    }
  });
}
