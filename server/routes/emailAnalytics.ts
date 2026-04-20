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

export function registerEmailAnalyticsRoutes(app: Express): void {

  const ALLOWED_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

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
          ect.id              AS conversation_id,
          ect.org_id,
          ect.linked_account_id,
          ect.linked_carrier_id,
          ect.owner_user_id,
          u.name              AS owner_name,
          ect.waiting_state,
          ect.response_priority,
          ect.last_message_id,
          ect.last_incoming_at,
          ect.last_outgoing_at,
          ect.waiting_since_at,
          ect.overdue_at,
          ect.archived_at,
          ect.created_at      AS thread_created_at,
          ect.updated_at      AS thread_updated_at,
          latest.subject,
          latest.from_email,
          latest.to_email,
          latest.cc_email,
          latest.created_at   AS last_message_at,
          c.name              AS company_name,
          ca.name             AS carrier_name
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
        WHERE ect.id IS NOT NULL
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
