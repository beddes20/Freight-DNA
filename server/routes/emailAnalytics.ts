/**
 * Email Analytics Routes — Win/Loss Patterns, Urgency Tracker, Signal Overview
 *
 * GET /api/analytics/email-intelligence
 *   Returns org-wide email signal analytics:
 *   - signal_summary: top intent types with total counts
 *   - win_loss_patterns: each intent type with won/lost/neutral breakdown
 *   - urgency_unresponded: urgency_signal instances with no touchpoint in 24h
 *   - recent_signals: last 30 signals with message context
 */

import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { cacheGet, cacheSet } from "../cache";
import {
  fetchResponsePairs,
  summarizeBucket,
  buildLeaderboard,
  buildSlowestThreads,
  buildTimeseries,
  type Granularity,
  type ResponsePair,
} from "../services/emailResponseTimeAnalyticsService";

export function registerEmailAnalyticsRoutes(app: Express): void {

  const ALLOWED_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

  // ─── Response Time Analytics (Task #414) ──────────────────────────────────
  // Endpoints:
  //   GET /api/analytics/email-response-time/kpis
  //   GET /api/analytics/email-response-time/timeseries?granularity=day|week|month
  //   GET /api/analytics/email-response-time/leaderboard
  //   GET /api/analytics/email-response-time/slowest
  // Common query params: start, end (ISO), repIds (comma-separated),
  // accountId, businessHours (true|false, default true).

  const RT_CACHE_TTL_MS = 5 * 60 * 1000;

  function parseRtFilters(req: Request, orgId: string) {
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startStr = typeof req.query.start === "string" ? req.query.start : null;
    const endStr = typeof req.query.end === "string" ? req.query.end : null;
    const start = startStr ? new Date(startStr) : defaultStart;
    const end = endStr ? new Date(endStr) : new Date(now.getTime() + 60_000);
    const repIdsRaw = typeof req.query.repIds === "string" ? req.query.repIds : "";
    const repIds = repIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const accountId = typeof req.query.accountId === "string" && req.query.accountId.trim()
      ? req.query.accountId.trim()
      : undefined;
    const businessHours = String(req.query.businessHours ?? "true").toLowerCase() !== "false";
    return {
      orgId,
      start,
      end,
      repIds: repIds.length ? repIds : undefined,
      accountId,
      businessHours,
    };
  }

  async function getCachedPairs(filters: ReturnType<typeof parseRtFilters>): Promise<ResponsePair[]> {
    // Cache the *raw* pair set keyed only by inputs that affect the SQL query
    // (org, range, repIds, accountId). Business-hours toggle does NOT change
    // the SQL — it's applied in JS aggregation, so the same cache row serves
    // both wall-clock and business-hours requests.
    const cacheKey = `rt:pairs:${filters.orgId}:${filters.start.toISOString()}:${filters.end.toISOString()}:${(filters.repIds ?? []).join(",")}:${filters.accountId ?? ""}`;
    const cached = cacheGet<ResponsePair[]>(cacheKey);
    if (cached) {
      return cached.map((p) => ({
        ...p,
        inboundAt: new Date(p.inboundAt as unknown as string),
        outboundAt: p.outboundAt ? new Date(p.outboundAt as unknown as string) : null,
      }));
    }
    const pairs = await fetchResponsePairs(filters);
    cacheSet(cacheKey, pairs, RT_CACHE_TTL_MS);
    return pairs;
  }

  // Anchor each pair at its "event time": the outbound send time for replies,
  // the inbound time for still-waiting threads. Under the new event model,
  // a reply's inbound may predate the bucket — what matters for KPIs is when
  // the rep responded.
  function inRange(p: ResponsePair, start: Date, end: Date): boolean {
    const anchor = (p.outboundAt ?? p.inboundAt).getTime();
    return anchor >= start.getTime() && anchor < end.getTime();
  }

  // ET day boundaries — the rest of the report (business-hours toggle, the
  // Today/Yesterday range presets) is anchored on America/New_York, so KPI
  // tiles that say "Today" must use the same calendar day. Server local time
  // (UTC on Replit) would shift the boundary by ~5 hours.
  const KPI_TZ = "America/New_York";
  function getEtDayStartUtc(d: Date): Date {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: KPI_TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => Number(fmt.find((p) => p.type === t)?.value);
    let hour = get("hour"); if (hour === 24) hour = 0;
    const localMs = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    const offset = localMs - d.getTime();
    return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0) - offset);
  }

  app.get("/api/analytics/email-response-time/kpis", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = user.organizationId;

      // KPI windows are FIXED (today/7d/30d) and independent of the UI range
      // selector — we always fetch the last 60 days so the "prior month" delta
      // is computable. Only rep/account/businessHours filters apply.
      const uiFilters = parseRtFilters(req, orgId);
      const now = new Date();
      const kpiStart = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      const filters = {
        ...uiFilters,
        start: kpiStart,
        end: new Date(now.getTime() + 60_000),
      };
      const pairs = await getCachedPairs(filters);
      const biz = filters.businessHours;

      // All bucket starts are anchored on ET midnight to match the UI presets
      // and the business-hours window. Prior periods step back exactly one
      // window-length so the deltas are comparable.
      const dayStart = getEtDayStartUtc(now);
      const dayPrevStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);

      const weekStart = new Date(dayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      const weekPrevStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

      const monthStart = new Date(dayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
      const monthPrevStart = new Date(monthStart.getTime() - 30 * 24 * 60 * 60 * 1000);

      const today = summarizeBucket(pairs.filter(p => inRange(p, dayStart, now)), biz, "today", dayStart, now);
      const todayPrev = summarizeBucket(pairs.filter(p => inRange(p, dayPrevStart, dayStart)), biz, "yesterday", dayPrevStart, dayStart);
      const week = summarizeBucket(pairs.filter(p => inRange(p, weekStart, now)), biz, "week", weekStart, now);
      const weekPrev = summarizeBucket(pairs.filter(p => inRange(p, weekPrevStart, weekStart)), biz, "prev_week", weekPrevStart, weekStart);
      const month = summarizeBucket(pairs.filter(p => inRange(p, monthStart, now)), biz, "month", monthStart, now);
      const monthPrev = summarizeBucket(pairs.filter(p => inRange(p, monthPrevStart, monthStart)), biz, "prev_month", monthPrevStart, monthStart);

      res.json({
        businessHours: biz,
        today: { current: today, prior: todayPrev },
        week: { current: week, prior: weekPrev },
        month: { current: month, prior: monthPrev },
      });
    } catch (err) {
      console.error("[email-response-time/kpis] error:", err);
      res.status(500).json({ error: "Failed to load response time KPIs" });
    }
  });

  app.get("/api/analytics/email-response-time/timeseries", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = user.organizationId;

      const uiFilters = parseRtFilters(req, orgId);
      const granularityRaw = typeof req.query.granularity === "string" ? req.query.granularity : "day";
      const granularity: Granularity = (["day", "week", "month"] as const).includes(granularityRaw as Granularity)
        ? (granularityRaw as Granularity)
        : "day";

      // Trend horizon is fixed by granularity per spec:
      //   day → 30 days, week → 12 weeks, month → 12 months.
      // The UI range selector does NOT apply to the trend chart.
      const now = new Date();
      const horizonDays = granularity === "day" ? 30 : granularity === "week" ? 84 : 365;
      const start = new Date(now.getTime() - horizonDays * 24 * 60 * 60 * 1000);
      const filters = {
        ...uiFilters,
        start,
        end: new Date(now.getTime() + 60_000),
      };

      const pairs = await getCachedPairs(filters);
      const points = buildTimeseries(pairs, filters.businessHours, granularity);

      res.json({
        granularity,
        businessHours: filters.businessHours,
        horizonDays,
        points,
      });
    } catch (err) {
      console.error("[email-response-time/timeseries] error:", err);
      res.status(500).json({ error: "Failed to load response time timeseries" });
    }
  });

  app.get("/api/analytics/email-response-time/leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = user.organizationId;

      const filters = parseRtFilters(req, orgId);
      const pairs = await getCachedPairs(filters);
      const rows = buildLeaderboard(pairs, filters.businessHours);

      res.json({ businessHours: filters.businessHours, rows });
    } catch (err) {
      console.error("[email-response-time/leaderboard] error:", err);
      res.status(500).json({ error: "Failed to load response time leaderboard" });
    }
  });

  app.get("/api/analytics/email-response-time/slowest", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = user.organizationId;

      const filters = parseRtFilters(req, orgId);
      const pairs = await getCachedPairs(filters);
      const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 25));
      const rows = buildSlowestThreads(pairs, filters.businessHours, new Date(), limit);

      res.json({ businessHours: filters.businessHours, rows });
    } catch (err) {
      console.error("[email-response-time/slowest] error:", err);
      res.status(500).json({ error: "Failed to load slowest threads" });
    }
  });

  app.get("/api/analytics/email-intelligence", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!ALLOWED_ROLES.includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      const orgId = user.organizationId;

      const [
        signalSummaryResult,
        winLossResult,
        recentSignalsResult,
        urgencyResult,
      ] = await Promise.all([

        // ── Signal summary: top intent types org-wide ──────────────────────
        storage.pool.query(
          `SELECT es.intent_type,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE em.direction = 'inbound')::int AS inbound_count,
                  COUNT(*) FILTER (WHERE em.direction = 'outbound')::int AS outbound_count,
                  AVG(es.confidence)::int AS avg_confidence
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           WHERE em.org_id = $1
           GROUP BY es.intent_type
           ORDER BY total DESC`,
          [orgId]
        ),

        // ── Win/loss patterns: signal types by outcome ─────────────────────
        // Join signals to outcome links that are in the same message batch
        storage.pool.query(
          `SELECT
             es.intent_type,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE eol.outcome_type = 'won')::int  AS won,
             COUNT(*) FILTER (WHERE eol.outcome_type = 'lost')::int AS lost
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           LEFT JOIN email_outcome_links eol ON eol.email_signal_id = es.id
           WHERE em.org_id = $1
           GROUP BY es.intent_type
           ORDER BY (COUNT(*) FILTER (WHERE eol.outcome_type IN ('won','lost'))) DESC, total DESC`,
          [orgId]
        ),

        // ── Recent signals: last 30 with message context ───────────────────
        storage.pool.query(
          `SELECT
             es.id AS signal_id,
             es.intent_type,
             es.intent_subtype,
             es.confidence,
             es.actor_type,
             es.created_at AS signal_at,
             em.direction,
             em.from_email,
             em.subject,
             em.linked_account_id,
             em.linked_carrier_id,
             c.name AS company_name,
             ca.name AS carrier_name
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           LEFT JOIN companies c ON c.id = em.linked_account_id
           LEFT JOIN carriers ca ON ca.id = em.linked_carrier_id
           WHERE em.org_id = $1
           ORDER BY es.created_at DESC
           LIMIT 30`,
          [orgId]
        ),

        // ── Urgency signals with no touchpoint logged in 24h ──────────────
        storage.pool.query(
          `SELECT
             es.id AS signal_id,
             es.confidence,
             es.created_at AS signal_at,
             em.subject,
             em.from_email,
             em.linked_account_id,
             c.name AS company_name,
             EXTRACT(EPOCH FROM (NOW() - es.created_at::timestamptz)) / 3600 AS hours_elapsed,
             (
               SELECT COUNT(*) FROM touchpoints t
               WHERE t.company_id = em.linked_account_id
                 AND t.created_at::timestamptz > es.created_at::timestamptz
             )::int AS touchpoints_after
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           LEFT JOIN companies c ON c.id = em.linked_account_id
           WHERE em.org_id = $1
             AND es.intent_type = 'urgency_signal'
             AND es.created_at::timestamptz > NOW() - INTERVAL '7 days'
             AND em.linked_account_id IS NOT NULL
           ORDER BY es.created_at DESC
           LIMIT 50`,
          [orgId]
        ),
      ]);

      res.json({
        signal_summary: signalSummaryResult.rows,
        win_loss_patterns: winLossResult.rows,
        recent_signals: recentSignalsResult.rows,
        urgency_signals: urgencyResult.rows.map((r: {
          signal_id: string; confidence: number; signal_at: string;
          subject: string | null; from_email: string | null;
          linked_account_id: string | null; company_name: string | null;
          hours_elapsed: number; touchpoints_after: number;
        }) => ({
          ...r,
          hours_elapsed: Math.round(r.hours_elapsed * 10) / 10,
          responded: r.touchpoints_after > 0,
        })),
      });
    } catch (err) {
      console.error("[email-analytics] error:", err);
      res.status(500).json({ error: "Failed to load email analytics" });
    }
  });

  // ── Drilldown: threads contributing to a signal type / outcome (Task #283) ──
  // GET /api/analytics/email-intelligence/drilldown?intent_type=X&outcome=won|lost|neutral|all
  // Returns the list of email conversation threads that produced signals of
  // the requested intent type, optionally scoped to a Won/Lost/Neutral outcome.
  app.get("/api/analytics/email-intelligence/drilldown", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!ALLOWED_ROLES.includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      const orgId = user.organizationId;

      const intentTypeRaw = typeof req.query.intent_type === "string" ? req.query.intent_type.trim() : "";
      const outcomeRaw = typeof req.query.outcome === "string" ? req.query.outcome.trim().toLowerCase() : "all";
      if (!intentTypeRaw) return res.status(400).json({ error: "intent_type is required" });
      const outcome = ["won", "lost", "neutral", "all"].includes(outcomeRaw) ? outcomeRaw : "all";

      let havingClause = "";
      if (outcome === "won") havingClause = "HAVING bool_or(eol.outcome_type = 'won')";
      else if (outcome === "lost") havingClause = "HAVING bool_or(eol.outcome_type = 'lost')";
      else if (outcome === "neutral") havingClause = "HAVING bool_or(eol.outcome_type IS NOT NULL) IS NOT TRUE";

      const sql = `
        WITH matching_threads AS (
          SELECT em.thread_id,
                 bool_or(eol.outcome_type = 'won')  AS has_won,
                 bool_or(eol.outcome_type = 'lost') AS has_lost,
                 bool_or(eol.outcome_type IS NOT NULL) AS has_outcome,
                 MAX(es.created_at) AS last_signal_at
          FROM email_signals es
          JOIN email_messages em ON em.id = es.message_id
          LEFT JOIN email_outcome_links eol ON eol.email_signal_id = es.id
          WHERE em.org_id = $1 AND es.intent_type = $2
          GROUP BY em.thread_id
          ${havingClause}
        )
        SELECT
          mt.thread_id,
          mt.has_won, mt.has_lost, mt.has_outcome,
          mt.last_signal_at,
          COALESCE(ect.id, 'thread:' || mt.thread_id) AS conversation_id,
          ect.id              AS ect_id,
          COALESCE(ect.org_id, $1) AS org_id,
          COALESCE(ect.linked_account_id, fallback.linked_account_id) AS linked_account_id,
          COALESCE(ect.linked_carrier_id, fallback.linked_carrier_id) AS linked_carrier_id,
          ect.owner_user_id,
          u.name              AS owner_name,
          COALESCE(ect.waiting_state, 'waiting_on_us') AS waiting_state,
          COALESCE(ect.response_priority, 'normal') AS response_priority,
          ect.last_message_id,
          ect.last_incoming_at,
          ect.last_outgoing_at,
          ect.waiting_since_at,
          ect.overdue_at,
          ect.archived_at,
          COALESCE(ect.created_at, latest.created_at) AS thread_created_at,
          COALESCE(ect.updated_at, latest.created_at) AS thread_updated_at,
          latest.subject,
          latest.from_email,
          latest.to_email,
          latest.cc_email,
          latest.created_at   AS last_message_at,
          COALESCE(c.name, c2.name)   AS company_name,
          COALESCE(ca.name, ca2.name) AS carrier_name
        FROM matching_threads mt
        LEFT JOIN email_conversation_threads ect
          ON ect.thread_id = mt.thread_id AND ect.org_id = $1
        LEFT JOIN users u ON u.id = ect.owner_user_id
        LEFT JOIN companies c ON c.id = ect.linked_account_id
        LEFT JOIN carriers ca ON ca.id = ect.linked_carrier_id
        LEFT JOIN LATERAL (
          SELECT subject, from_email, to_email, cc_email, created_at
          FROM email_messages em2
          WHERE em2.thread_id = mt.thread_id AND em2.org_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT linked_account_id, linked_carrier_id
          FROM email_messages em3
          WHERE em3.thread_id = mt.thread_id AND em3.org_id = $1
            AND (em3.linked_account_id IS NOT NULL OR em3.linked_carrier_id IS NOT NULL)
          ORDER BY created_at DESC
          LIMIT 1
        ) fallback ON true
        LEFT JOIN companies c2 ON c2.id = fallback.linked_account_id
        LEFT JOIN carriers ca2 ON ca2.id = fallback.linked_carrier_id
        ORDER BY COALESCE(latest.created_at, mt.last_signal_at) DESC
        LIMIT 200
      `;

      const result = await storage.pool.query(sql, [orgId, intentTypeRaw]);

      const threads = result.rows.map((r: Record<string, unknown>) => {
        const won = !!r.has_won;
        const lost = !!r.has_lost;
        // When the caller filtered to a specific outcome, label each thread
        // with that outcome so the row label matches the user's intent. For
        // "all", we still show the dominant outcome (won wins ties for
        // display, but threads with both are rare in practice).
        let outcomeLabel: "won" | "lost" | "neutral";
        if (outcome === "won") outcomeLabel = "won";
        else if (outcome === "lost") outcomeLabel = "lost";
        else if (outcome === "neutral") outcomeLabel = "neutral";
        else outcomeLabel = won ? "won" : lost ? "lost" : "neutral";
        return {
          id: r.conversation_id,
          orgId: r.org_id,
          threadId: r.thread_id,
          linkedAccountId: r.linked_account_id,
          linkedCarrierId: r.linked_carrier_id,
          ownerUserId: r.owner_user_id,
          ownerName: r.owner_name ?? null,
          waitingState: r.waiting_state,
          responsePriority: r.response_priority,
          lastMessageId: r.last_message_id,
          lastIncomingAt: r.last_incoming_at,
          lastOutgoingAt: r.last_outgoing_at,
          waitingSinceAt: r.waiting_since_at,
          overdueAt: r.overdue_at,
          archivedAt: r.archived_at,
          createdAt: r.thread_created_at,
          updatedAt: r.thread_updated_at,
          subject: r.subject ?? null,
          fromEmail: r.from_email ?? null,
          toEmail: r.to_email ?? null,
          ccEmail: r.cc_email ?? null,
          lastMessageAt: r.last_message_at ?? null,
          companyName: r.company_name ?? null,
          carrierName: r.carrier_name ?? null,
          outcome: outcomeLabel,
          hasConversationRecord: r.ect_id != null,
        };
      });

      res.json({
        intent_type: intentTypeRaw,
        outcome,
        count: threads.length,
        threads,
      });
    } catch (err) {
      console.error("[email-analytics] drilldown error:", err);
      res.status(500).json({ error: "Failed to load drilldown" });
    }
  });

  // ── "What Email Learned Today" daily digest ─────────────────────────────
  app.get("/api/analytics/email-learned-today", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!ALLOWED_ROLES.includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      const orgId = user.organizationId;

      const [
        newContactSuggestions,
        conversationSparks,
        enrichmentUpdates,
        geographyInferences,
      ] = await Promise.all([
        storage.pool.query(
          `SELECT
             acs.id,
             acs.email_address,
             acs.suggested_name,
             acs.suggested_title,
             acs.suggestion_source,
             acs.confidence_score,
             acs.thread_count,
             acs.notes,
             acs.created_at,
             c.name AS account_name
           FROM account_contact_suggestions acs
           LEFT JOIN companies c ON c.id = acs.account_id
           WHERE acs.org_id = $1
             AND acs.created_at > NOW() - INTERVAL '24 hours'
             AND acs.status = 'pending'
           ORDER BY acs.confidence_score DESC, acs.created_at DESC
           LIMIT 50`,
          [orgId]
        ),

        storage.pool.query(
          `SELECT
             es.id AS signal_id,
             es.intent_type,
             es.confidence,
             es.extracted_data,
             es.created_at AS signal_at,
             em.subject,
             em.from_email,
             em.linked_account_id,
             c.name AS company_name
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           LEFT JOIN companies c ON c.id = em.linked_account_id
           WHERE em.org_id = $1
             AND es.intent_type LIKE 'conversation_spark_%'
             AND es.created_at > NOW() - INTERVAL '24 hours'
           ORDER BY es.created_at DESC
           LIMIT 50`,
          [orgId]
        ),

        storage.pool.query(
          `SELECT
             ces.id,
             ces.suggestion_type,
             ces.confidence,
             ces.payload,
             ces.created_at,
             ca.name AS carrier_name
           FROM carrier_email_suggestions ces
           LEFT JOIN carriers ca ON ca.id = ces.carrier_id
           WHERE ca.org_id = $1
             AND ces.created_at > NOW() - INTERVAL '24 hours'
             AND ces.status = 'pending'
           ORDER BY ces.created_at DESC
           LIMIT 50`,
          [orgId]
        ),

        storage.pool.query(
          `SELECT
             es.id AS signal_id,
             es.intent_type,
             es.confidence,
             es.extracted_data,
             es.created_at AS signal_at,
             em.subject,
             em.from_email,
             em.linked_account_id,
             c.name AS company_name
           FROM email_signals es
           JOIN email_messages em ON em.id = es.message_id
           LEFT JOIN companies c ON c.id = em.linked_account_id
           WHERE em.org_id = $1
             AND es.intent_type IN ('new_lane_preference', 'capacity_available', 'lane_offer', 'conversation_spark_geography_expansion')
             AND es.created_at > NOW() - INTERVAL '24 hours'
           ORDER BY es.created_at DESC
           LIMIT 30`,
          [orgId]
        ),
      ]);

      res.json({
        new_contact_suggestions: newContactSuggestions.rows,
        conversation_sparks: conversationSparks.rows,
        enrichment_updates: enrichmentUpdates.rows,
        geography_inferences: geographyInferences.rows,
        summary: {
          contacts_suggested: newContactSuggestions.rows.length,
          sparks_generated: conversationSparks.rows.length,
          enrichments_staged: enrichmentUpdates.rows.length,
          geographies_inferred: geographyInferences.rows.length,
        },
      });
    } catch (err) {
      console.error("[email-analytics] learned-today error:", err);
      res.status(500).json({ error: "Failed to load daily digest" });
    }
  });

  // ── Carrier reliability leaderboard ─────────────────────────────────────
  app.get("/api/analytics/carrier-reliability", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = user.organizationId;

      const result = await storage.pool.query(
        `SELECT
           ca.id,
           ca.name,
           ca.primary_email,
           ca.hq_city,
           ca.hq_state,
           COUNT(DISTINCT col_out.id)::int AS outreach_sent,
           COUNT(DISTINCT col_in.id)::int  AS replies_received,
           CASE WHEN COUNT(DISTINCT col_out.id) > 0
             THEN ROUND(COUNT(DISTINCT col_in.id)::numeric / COUNT(DISTINCT col_out.id) * 100)::int
             ELSE NULL END AS reply_rate,
           COUNT(DISTINCT CASE WHEN es.intent_type = 'hard_commitment' THEN es.id END)::int AS hard_commitments,
           COUNT(DISTINCT CASE WHEN es.intent_type = 'soft_commitment' THEN es.id END)::int AS soft_commitments,
           COUNT(DISTINCT CASE WHEN es.intent_type = 'lane_offer'      THEN es.id END)::int AS lane_offers
         FROM carriers ca
         LEFT JOIN carrier_outreach_logs col_out
           ON $1 = ANY(col_out.carrier_ids) AND col_out.direction = 'outbound'
         LEFT JOIN carrier_outreach_logs col_in
           ON col_in.matched_carrier_id = ca.id AND col_in.direction = 'inbound'
         LEFT JOIN email_messages em ON em.linked_carrier_id = ca.id
         LEFT JOIN email_signals es ON es.message_id = em.id
         WHERE ca.org_id = $1
           AND COUNT(DISTINCT col_out.id) > 0
         GROUP BY ca.id, ca.name, ca.primary_email, ca.hq_city, ca.hq_state
         ORDER BY reply_rate DESC NULLS LAST, outreach_sent DESC
         LIMIT 50`,
        [orgId]
      ).catch(() => ({ rows: [] as never[] })); // Graceful fallback if aggregation is complex

      res.json(result.rows);
    } catch (err) {
      console.error("[email-analytics] carrier-reliability error:", err);
      res.status(500).json({ error: "Failed to load carrier reliability" });
    }
  });
}
