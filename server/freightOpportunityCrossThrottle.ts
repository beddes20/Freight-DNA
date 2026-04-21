/**
 * Task #365 — Cross-system throttle.
 *
 * Before the freight outreach service sends to a carrier, we check whether the
 * SAME carrier was already pinged on the SAME lane within the per-carrier
 * dedup window used by LWQ outreach (48h). This prevents the LWQ and the
 * Available Freight queues from double-touching a carrier on identical
 * geography.
 *
 * Lane match strategy (in order of confidence):
 *   1. recurringLaneId match — when the freight opportunity is bound to a
 *      recurring_lanes row (most precise; uses the existing lane index).
 *   2. company + procurement_lane label match — for opportunities without a
 *      recurringLaneId, fall back to a company-scoped match on the
 *      "Origin → Destination" string the LWQ writes to procurement_lane.
 *
 * Never invents a new throttle window — reuses the 48h constant that the
 * existing LWQ getRecentSuccessfulOutreachCarrierIds path uses.
 */

import { db } from "./storage";
import { sql } from "drizzle-orm";

export const FREIGHT_CROSS_THROTTLE_HOURS = 48;

export interface CrossThrottleQuery {
  orgId: string;
  carrierIds: string[];
  recurringLaneId: string | null;
  companyId: string;
  /** "Chicago, IL → Dallas, TX" — used for fallback match when laneId is null. */
  laneLabel: string | null;
}

export interface CrossThrottleHit {
  carrierId: string;
  lastSentAt: Date;
  source: "lane_id_match" | "company_lane_label_match";
}

/**
 * Returns the subset of `carrierIds` that have been successfully contacted on
 * the same lane within the last FREIGHT_CROSS_THROTTLE_HOURS. Empty result
 * means none are throttled. Never returns a carrierId that wasn't in the
 * input list.
 */
export async function findCrossThrottledCarriers(
  q: CrossThrottleQuery,
): Promise<Map<string, CrossThrottleHit>> {
  const hits = new Map<string, CrossThrottleHit>();
  if (q.carrierIds.length === 0) return hits;

  // Lane-id path — only when the opportunity is bound to a recurring lane.
  if (q.recurringLaneId) {
    const r = await db.execute(sql`
      SELECT
        unnest(carrier_ids) AS carrier_id,
        MAX(sent_at)        AS last_sent_at
      FROM carrier_outreach_logs
      WHERE org_id = ${q.orgId}
        AND lane_id = ${q.recurringLaneId}
        AND delivery_status IN ('sent','delivered','opened')
        AND sent_at > NOW() - (${FREIGHT_CROSS_THROTTLE_HOURS} || ' hours')::interval
        AND carrier_ids && ${q.carrierIds}::text[]
      GROUP BY carrier_id
    `);
    const rows = (r as { rows?: unknown[] }).rows ?? [];
    for (const row of rows as Array<{ carrier_id: string; last_sent_at: string | Date }>) {
      if (q.carrierIds.includes(row.carrier_id)) {
        hits.set(row.carrier_id, {
          carrierId: row.carrier_id,
          lastSentAt: row.last_sent_at instanceof Date ? row.last_sent_at : new Date(row.last_sent_at),
          source: "lane_id_match",
        });
      }
    }
  }

  // Fallback path — company + procurement_lane label match. Only fills in
  // carriers we haven't already matched via lane_id.
  const remaining = q.carrierIds.filter(id => !hits.has(id));
  if (remaining.length > 0 && q.laneLabel) {
    const r = await db.execute(sql`
      SELECT
        unnest(carrier_ids) AS carrier_id,
        MAX(sent_at)        AS last_sent_at
      FROM carrier_outreach_logs
      WHERE org_id = ${q.orgId}
        AND company_id = ${q.companyId}
        AND procurement_lane IS NOT NULL
        AND LOWER(procurement_lane) = LOWER(${q.laneLabel})
        AND delivery_status IN ('sent','delivered','opened')
        AND sent_at > NOW() - (${FREIGHT_CROSS_THROTTLE_HOURS} || ' hours')::interval
        AND carrier_ids && ${remaining}::text[]
      GROUP BY carrier_id
    `);
    const rows = (r as { rows?: unknown[] }).rows ?? [];
    for (const row of rows as Array<{ carrier_id: string; last_sent_at: string | Date }>) {
      if (remaining.includes(row.carrier_id)) {
        hits.set(row.carrier_id, {
          carrierId: row.carrier_id,
          lastSentAt: row.last_sent_at instanceof Date ? row.last_sent_at : new Date(row.last_sent_at),
          source: "company_lane_label_match",
        });
      }
    }
  }

  return hits;
}
