/**
 * Phase 2a — Quote-request leakage diagnostic.
 *
 * Surfaces the rate at which inbound customer "pricing_request" /
 * "quote_request" email signals fail to materialize a tracked
 * `quote_opportunities` row (and aren't acknowledged via
 * `capture_leak_reviews` either). The investigation that motivated the
 * Conversations freshness work showed the link rate at ~40%, meaning
 * ~60% of quote-request emails leak past the freight ops team.
 *
 * This endpoint is read-only. It changes nothing. The only purpose is
 * to make the leakage rate visible on /admin/integrations-health so we
 * can watch it for a few normal business days before turning on any
 * auto-create / auto-attach behavior in Phase 2b.
 *
 * Categorization (mutually exclusive, priority order):
 *   1. withOpportunity — signal.linkedOpportunityId is set, OR a
 *      quote_opportunities row in the same org references the message
 *      via source_reference = email_messages.provider_message_id.
 *   2. inLeakQueue    — a capture_leak_reviews row exists for the
 *      (org, message) pair (any decision: not_quote / ignored /
 *      attached). These are signals an admin already acknowledged.
 *   3. leaked         — everything else.
 *
 * Org isolation: every join is keyed on the requesting user's
 * organizationId via `email_messages.org_id`. There is no cross-tenant
 * read path.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { requireUser } from "../auth";
import { getErrorMessage } from "../lib/errors";
import { qOptStr } from "../lib/req";
import {
  getClosureCounters,
  type ClosureCounters,
} from "../services/quoteOpportunityFromSignalService";
import {
  computeClosureCounters,
  CLOSURE_WINDOW_LABELS,
  type ClosureWindowLabel,
} from "../services/quoteLeakageClosureCounters";

function isAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "director" || role === "sales_director";
}

interface WindowStats {
  windowLabel: string;
  windowStart: string;
  totalSignals: number;
  withOpportunity: number;
  inLeakQueue: number;
  leaked: number;
  leakRate: number;
}

interface DomainBreakdown {
  domain: string;
  totalSignals: number;
  leakedSignals: number;
  leakRate: number;
}

interface LeakageStatsResponse {
  generatedAt: string;
  organizationId: string;
  windows: { last24h: WindowStats; last7d: WindowStats };
  topLeakingDomains: DomainBreakdown[];
  /**
   * Task #847 — Phase 2b forward-closure decision counters, scoped to
   * the same per-org / per-window axes as `windows.*` so the tile can
   * stack the two rows. When `closure.enabled` is false (default), the
   * `would_*` fields show what *would* happen once the flag flips; the
   * `created` / `attached` / `skipped_*` fields stay at zero.
   * In-memory ring buffer per process — multi-pod deployments would
   * need to aggregate across instances; we run single-pod today.
   */
  closure: {
    last24h: ClosureCounters;
    last7d: ClosureCounters;
  };
}

async function computeWindow(
  orgId: string,
  windowLabel: string,
  hours: number,
): Promise<WindowStats> {
  const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db.execute(sql`
    WITH eligible AS (
      SELECT
        s.id                       AS signal_id,
        s.message_id               AS message_id,
        s.linked_opportunity_id    AS linked_opportunity_id,
        m.provider_message_id      AS provider_message_id
      FROM email_signals s
      JOIN email_messages m ON m.id = s.message_id
      WHERE s.intent_type IN ('pricing_request', 'quote_request')
        AND s.actor_type = 'customer'
        AND s.created_at >= ${windowStart}
        AND m.org_id = ${orgId}
    ),
    classified AS (
      SELECT
        e.signal_id,
        CASE
          WHEN e.linked_opportunity_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM quote_opportunities qo
              WHERE qo.organization_id = ${orgId}
                AND qo.source_reference IS NOT NULL
                AND qo.source_reference = e.provider_message_id
            ) THEN 'with_opportunity'
          WHEN EXISTS (
            SELECT 1 FROM capture_leak_reviews clr
            WHERE clr.organization_id = ${orgId}
              AND clr.message_id = e.message_id
              AND clr.decision <> 'returned_to_queue'
          ) THEN 'in_leak_queue'
          ELSE 'leaked'
        END AS bucket
      FROM eligible e
    )
    SELECT
      COUNT(*)::int                                                AS total_signals,
      COUNT(*) FILTER (WHERE bucket = 'with_opportunity')::int     AS with_opportunity,
      COUNT(*) FILTER (WHERE bucket = 'in_leak_queue')::int        AS in_leak_queue,
      COUNT(*) FILTER (WHERE bucket = 'leaked')::int               AS leaked
    FROM classified
  `);
  const rowArray = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  const r = (rowArray[0] ?? {}) as {
    total_signals: number;
    with_opportunity: number;
    in_leak_queue: number;
    leaked: number;
  };
  const total = Number(r?.total_signals ?? 0);
  const withOpp = Number(r?.with_opportunity ?? 0);
  const inQ = Number(r?.in_leak_queue ?? 0);
  const leaked = Number(r?.leaked ?? 0);
  return {
    windowLabel,
    windowStart: windowStart.toISOString(),
    totalSignals: total,
    withOpportunity: withOpp,
    inLeakQueue: inQ,
    leaked,
    leakRate: total > 0 ? leaked / total : 0,
  };
}

async function computeTopLeakingDomains(
  orgId: string,
  hours: number,
  limit: number,
): Promise<DomainBreakdown[]> {
  const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db.execute(sql`
    WITH eligible AS (
      SELECT
        s.id                       AS signal_id,
        s.message_id               AS message_id,
        s.linked_opportunity_id    AS linked_opportunity_id,
        m.provider_message_id      AS provider_message_id,
        LOWER(SPLIT_PART(COALESCE(m.from_email, ''), '@', 2)) AS domain
      FROM email_signals s
      JOIN email_messages m ON m.id = s.message_id
      WHERE s.intent_type IN ('pricing_request', 'quote_request')
        AND s.actor_type = 'customer'
        AND s.created_at >= ${windowStart}
        AND m.org_id = ${orgId}
        AND m.from_email IS NOT NULL
        AND POSITION('@' IN m.from_email) > 0
    ),
    classified AS (
      SELECT
        e.domain,
        CASE
          WHEN e.linked_opportunity_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM quote_opportunities qo
              WHERE qo.organization_id = ${orgId}
                AND qo.source_reference IS NOT NULL
                AND qo.source_reference = e.provider_message_id
            ) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM capture_leak_reviews clr
            WHERE clr.organization_id = ${orgId}
              AND clr.message_id = e.message_id
          ) THEN 0
          ELSE 1
        END AS is_leaked
      FROM eligible e
    )
    SELECT
      domain,
      COUNT(*)::int                                AS total_signals,
      SUM(is_leaked)::int                          AS leaked_signals
    FROM classified
    WHERE domain <> ''
    GROUP BY domain
    HAVING SUM(is_leaked) > 0
    ORDER BY leaked_signals DESC, total_signals DESC
    LIMIT ${limit}
  `);
  const out: DomainBreakdown[] = [];
  for (const raw of (rows.rows ?? rows) as Array<{
    domain: string;
    total_signals: number;
    leaked_signals: number;
  }>) {
    const total = Number(raw.total_signals ?? 0);
    const leaked = Number(raw.leaked_signals ?? 0);
    out.push({
      domain: raw.domain,
      totalSignals: total,
      leakedSignals: leaked,
      leakRate: total > 0 ? leaked / total : 0,
    });
  }
  return out;
}

// Task #849 §3.4 — operator-strip cache. Closure counters live in-process
// (in-memory ring buffer); the contract caps the operator surface at a
// 30s freshness window so concurrent dashboards don't hammer the read
// path. Keyed by (orgId, windowLabel) so the three windows the strip
// shows can refresh independently.
const _automationCountersCache = new Map<string, { ts: number; payload: unknown }>();
const AUTOMATION_COUNTERS_TTL_MS = 30_000;

function automationCountersAllowed(role: string | null | undefined): boolean {
  // Wider than the leakage tile (which is admin-only): every role that
  // can SEE the post-2d Quote Requests tab is allowed to read its own
  // counters strip. RBAC for the *actions* that mutate these counters
  // (attach-to / send-to-leak / snooze) is enforced separately on those
  // endpoints — this is a read-only roll-up.
  if (!role) return false;
  return [
    "admin",
    "director",
    "sales_director",
    "national_account_manager",
    "sales",
    "account_manager",
    "logistics_manager",
    "logistics_coordinator",
  ].includes(role);
}

export function registerConversationsLeakageRoutes(app: Express) {
  // Task #849 §3.4 — GET /api/quote-requests/automation-counters
  // Operator strip on the post-2d Quote Requests tab. Reads the same
  // in-process closure-decision buffer as `/leakage-stats` (via the
  // shared `computeClosureCounters` service) but exposes it on a
  // user-facing surface with a 30s cache + Cache-Control header so the
  // strip can refresh on a 60s timer without hitting the buffer math
  // every request. Window selectable: today (default) | last_24h |
  // last_7d.
  app.get(
    "/api/quote-requests/automation-counters",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = req.user!;
        if (!automationCountersAllowed(me.role)) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const orgId = me.organizationId;
        if (!orgId) {
          return res.status(400).json({ error: "Missing organization" });
        }
        const rawWindow = (qOptStr(req.query.window) ?? "today").trim();
        if (!CLOSURE_WINDOW_LABELS.includes(rawWindow as ClosureWindowLabel)) {
          return res.status(400).json({
            error: "Invalid window",
            allowed: CLOSURE_WINDOW_LABELS,
          });
        }
        const windowLabel = rawWindow as ClosureWindowLabel;
        const cacheKey = `${orgId}:${windowLabel}`;
        const cached = _automationCountersCache.get(cacheKey);
        const now = Date.now();
        if (cached && now - cached.ts < AUTOMATION_COUNTERS_TTL_MS) {
          res.setHeader("Cache-Control", `private, max-age=${Math.floor(AUTOMATION_COUNTERS_TTL_MS / 1000)}`);
          res.setHeader("X-Automation-Counters-Cache", "hit");
          return res.json(cached.payload);
        }
        const computed = computeClosureCounters(orgId, windowLabel);
        const payload = {
          generatedAt: new Date().toISOString(),
          organizationId: orgId,
          window: computed.window,
          counters: computed.counters,
          closureFlagEnabled: computed.closureFlagEnabled,
          leakQueueDeepLink: "/admin/integrations-health#leak-tile",
        };
        _automationCountersCache.set(cacheKey, { ts: now, payload });
        res.setHeader("Cache-Control", `private, max-age=${Math.floor(AUTOMATION_COUNTERS_TTL_MS / 1000)}`);
        res.setHeader("X-Automation-Counters-Cache", "miss");
        return res.json(payload);
      } catch (err) {
        console.error("[automation-counters] error:", err);
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  app.get(
    "/api/admin/conversations/leakage-stats",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = req.user!;
        if (!isAdmin(me.role)) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const orgId = me.organizationId;
        if (!orgId) {
          return res.status(400).json({ error: "Missing organization" });
        }
        const [last24h, last7d, topLeakingDomains] = await Promise.all([
          computeWindow(orgId, "Last 24h", 24),
          computeWindow(orgId, "Last 7d", 24 * 7),
          computeTopLeakingDomains(orgId, 24 * 7, 10),
        ]);
        // Closure counters live in-process (in-memory ring buffer in
        // the closure service), so we read them synchronously without
        // a DB roundtrip. Window starts mirror the SQL windows above so
        // the tile's two rows describe the same time slice.
        const now = Date.now();
        const closure = {
          last24h: getClosureCounters(orgId, now - 24 * 60 * 60 * 1000),
          last7d:  getClosureCounters(orgId, now - 7 * 24 * 60 * 60 * 1000),
        };
        const payload: LeakageStatsResponse = {
          generatedAt: new Date().toISOString(),
          organizationId: orgId,
          windows: { last24h, last7d },
          topLeakingDomains,
          closure,
        };
        res.json(payload);
      } catch (err) {
        console.error("[conversations-leakage] error:", err);
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );
}
