/**
 * Task #705 — Endpoint performance budgets.
 *
 * Adds request-timing middleware that records p50/p95/p99 for the small set
 * of expensive endpoints, plus admin-only endpoints that:
 *   - return per-route aggregates compared against the budgets in
 *     `server/perfBudgets.ts`
 *   - return per-day p95 buckets for an inline sparkline
 *
 * Sampling is fire-and-forget so the middleware adds well under 2ms of
 * overhead per request (single Date.now() diff and a queued insert).
 */
import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../storage";
import { requireUser, getCurrentUser } from "../auth";
import { qInt, qStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import { endpointPerfSamples } from "@shared/schema";
import { ENDPOINT_BUDGETS, resolveRouteKey } from "../perfBudgets";
import { markCacheHint, getCacheHint } from "../lib/perfHints";

// Re-export so legacy callers (and tests) still find markCacheHint here.
export { markCacheHint };

interface PerfRequest extends Request {
  __perfStart?: number;
}

const writeQueue: Array<typeof endpointPerfSamples.$inferInsert> = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (writeQueue.length === 0) return;
    const batch = writeQueue.splice(0, 200);
    try {
      await db.insert(endpointPerfSamples).values(batch);
    } catch (err) {
      console.warn("[perf] batch insert failed:", getErrorMessage(err));
    }
    if (writeQueue.length > 0) scheduleFlush();
  }, 1_000);
}

/**
 * Test-only helper: synchronously flush the write queue. Production code
 * relies on the 1-second debounce above.
 */
export async function _flushPerfSamplesForTests(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  while (writeQueue.length > 0) {
    const batch = writeQueue.splice(0, 200);
    await db.insert(endpointPerfSamples).values(batch);
  }
}

export function perfTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const routeKey = resolveRouteKey(req.path, req.method);
  if (!routeKey) return next();
  const r = req as PerfRequest;
  r.__perfStart = Date.now();
  res.on("finish", () => {
    if (!r.__perfStart) return;
    const duration = Date.now() - r.__perfStart;
    // Resolve org via getCurrentUser — it returns the cached user that
    // requireAuth/requireUser stored on the request, regardless of which
    // auth middleware the underlying route used. Run async without blocking
    // the finish handler; if it cannot resolve, the sample is still
    // recorded with organizationId=null (e.g. unauthenticated 401).
    void (async () => {
      let orgId: string | null = null;
      try {
        const user = await getCurrentUser(req);
        orgId = user?.organizationId ?? null;
      } catch {
        orgId = null;
      }
      writeQueue.push({
        organizationId: orgId,
        routeKey,
        durationMs: duration,
        statusCode: res.statusCode,
        cacheHint: getCacheHint(req) ?? null,
      });
      scheduleFlush();
    })();
  });
  next();
}

function isAdmin(role: string | null | undefined) { return role === "admin"; }

export function registerEndpointPerfRoutes(app: Express) {
  app.get("/api/admin/endpoint-perf/overview", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Forbidden" });
      const days = Math.min(30, Math.max(1, qInt(req.query.days, 7)));
      const since = new Date(Date.now() - days * 86400_000);
      const rows = await db
        .select({
          routeKey: endpointPerfSamples.routeKey,
          count: sql<number>`COUNT(*)::int`,
          errors: sql<number>`SUM(CASE WHEN ${endpointPerfSamples.statusCode} >= 500 THEN 1 ELSE 0 END)::int`,
          warmHits: sql<number>`SUM(CASE WHEN ${endpointPerfSamples.cacheHint} IN ('warm','hit') THEN 1 ELSE 0 END)::int`,
          coldHits: sql<number>`SUM(CASE WHEN ${endpointPerfSamples.cacheHint} IN ('cold','miss') THEN 1 ELSE 0 END)::int`,
          p50: sql<number>`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
          p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
          p99: sql<number>`PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
        })
        .from(endpointPerfSamples)
        .where(
          and(
            gte(endpointPerfSamples.createdAt, since),
            eq(endpointPerfSamples.organizationId, me.organizationId),
          ),
        )
        .groupBy(endpointPerfSamples.routeKey);

      const seen = new Set<string>();
      const out = rows.map((r) => {
        seen.add(r.routeKey);
        const budget = ENDPOINT_BUDGETS[r.routeKey];
        const pass = budget == null ? null : (r.p95 ?? 0) <= budget;
        const tagged = (Number(r.warmHits) || 0) + (Number(r.coldHits) || 0);
        const warmPct = tagged > 0 ? Math.round((Number(r.warmHits) / tagged) * 100) : null;
        const requests = Number(r.count) || 0;
        const errors = Number(r.errors) || 0;
        // errorRate = 5xx percentage over the window (0..100, one decimal).
        const errorRate = requests > 0 ? Math.round((errors / requests) * 1000) / 10 : 0;
        return {
          routeKey: r.routeKey,
          requests,
          errors,
          errorRate,
          warmHits: Number(r.warmHits) || 0,
          coldHits: Number(r.coldHits) || 0,
          warmPct,
          p50: Number(r.p50) || 0,
          p95: Number(r.p95) || 0,
          p99: Number(r.p99) || 0,
          budget: budget ?? null,
          pass,
        };
      });
      // Add zero-data routes for visibility.
      for (const [routeKey, budget] of Object.entries(ENDPOINT_BUDGETS)) {
        if (!seen.has(routeKey)) {
          out.push({
            routeKey, requests: 0, errors: 0, errorRate: 0, warmHits: 0, coldHits: 0, warmPct: null,
            p50: 0, p95: 0, p99: 0, budget, pass: null,
          });
        }
      }
      out.sort((a, b) => b.requests - a.requests);
      res.json({ days, routes: out });
    } catch (err) {
      console.error("[endpoint-perf] overview error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  /**
   * Per-day p95 buckets for one route — feeds the inline sparkline on the
   * admin perf page. Returns up to `days` daily points; missing days are
   * omitted (the frontend treats them as zero / no data).
   */
  app.get("/api/admin/endpoint-perf/timeseries", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Forbidden" });
      const routeKey = qStr(req.query.routeKey);
      if (!routeKey) return res.status(400).json({ error: "routeKey is required" });
      if (!ENDPOINT_BUDGETS[routeKey]) {
        return res.status(404).json({ error: `Unknown routeKey: ${routeKey}` });
      }
      const days = Math.min(30, Math.max(1, qInt(req.query.days, 7)));
      const since = new Date(Date.now() - days * 86400_000);
      const rows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${endpointPerfSamples.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`COUNT(*)::int`,
          p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
        })
        .from(endpointPerfSamples)
        .where(
          and(
            eq(endpointPerfSamples.routeKey, routeKey),
            gte(endpointPerfSamples.createdAt, since),
            eq(endpointPerfSamples.organizationId, me.organizationId),
          ),
        )
        .groupBy(sql`date_trunc('day', ${endpointPerfSamples.createdAt})`)
        .orderBy(sql`date_trunc('day', ${endpointPerfSamples.createdAt})`);
      res.json({
        routeKey,
        days,
        budget: ENDPOINT_BUDGETS[routeKey] ?? null,
        points: rows.map((r) => ({ day: r.day, p95: Number(r.p95) || 0, count: Number(r.count) || 0 })),
      });
    } catch (err) {
      console.error("[endpoint-perf] timeseries error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
