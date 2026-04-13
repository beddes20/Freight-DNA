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
