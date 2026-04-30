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

export function registerConversationsLeakageRoutes(app: Express) {
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
        const payload: LeakageStatsResponse = {
          generatedAt: new Date().toISOString(),
          organizationId: orgId,
          windows: { last24h, last7d },
          topLeakingDomains,
        };
        res.json(payload);
      } catch (err) {
        console.error("[conversations-leakage] error:", err);
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );
}
