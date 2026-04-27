/**
 * Task #705 — Endpoint performance budgets.
 *
 * Adds request-timing middleware that records p50/p95/p99 for the small set
 * of expensive endpoints, plus an admin-only overview endpoint that pulls
 * the per-route aggregates and compares them to the budgets in
 * `server/perfBudgets.ts`.
 *
 * Sampling is fire-and-forget so the middleware adds well under 2ms of
 * overhead per request (single Date.now() diff and a queued insert).
 */
import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../storage";
import { requireUser } from "../auth";
import { qInt } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import { endpointPerfSamples } from "@shared/schema";
import { ENDPOINT_BUDGETS, resolveRouteKey } from "../perfBudgets";

interface PerfRequest extends Request {
  __perfStart?: number;
  __perfCacheHint?: "cold" | "warm" | "miss" | "hit";
}

/**
 * Mark a request as warm/cold so the perf samples can distinguish cache
 * regressions. Call from inside cached read handlers.
 */
export function markCacheHint(req: Request, hint: "cold" | "warm" | "miss" | "hit"): void {
  (req as PerfRequest).__perfCacheHint = hint;
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

export function perfTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const routeKey = resolveRouteKey(req.path, req.method);
  if (!routeKey) return next();
  const r = req as PerfRequest;
  r.__perfStart = Date.now();
  res.on("finish", () => {
    if (!r.__perfStart) return;
    const duration = Date.now() - r.__perfStart;
    // Try to attach the org for filtering; admin-only routes have no
    // organization (e.g. /api/admin/*) — leave null.
    const orgId = (req as Request & { user?: { organizationId?: string } }).user?.organizationId ?? null;
    writeQueue.push({
      organizationId: orgId,
      routeKey,
      durationMs: duration,
      statusCode: res.statusCode,
      cacheHint: r.__perfCacheHint ?? null,
    });
    scheduleFlush();
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
          p50: sql<number>`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
          p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
          p99: sql<number>`PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
        })
        .from(endpointPerfSamples)
        .where(gte(endpointPerfSamples.createdAt, since))
        .groupBy(endpointPerfSamples.routeKey);

      const seen = new Set<string>();
      const out = rows.map((r) => {
        seen.add(r.routeKey);
        const budget = ENDPOINT_BUDGETS[r.routeKey];
        const pass = budget == null ? null : (r.p95 ?? 0) <= budget;
        return {
          routeKey: r.routeKey,
          requests: Number(r.count) || 0,
          errors: Number(r.errors) || 0,
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
            routeKey, requests: 0, errors: 0, p50: 0, p95: 0, p99: 0, budget, pass: null,
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
}
