/**
 * Task #365 — Cross-system throttle.
 *
 * Thin compatibility shim. Since Task #631, the actual lookup lives in
 * `server/carrierContactLocks.ts` so LWQ outreach, AF wave sends,
 * sendOpportunityWave (auto-pilot included), and single-carrier email all
 * share one dedup view. This file preserves the old function/type names
 * (`findCrossThrottledCarriers`, `CrossThrottleHit`, `FREIGHT_CROSS_THROTTLE_HOURS`)
 * so existing call sites do not need to be touched.
 *
 * Lane match strategy (in order of confidence):
 *   1. recurringLaneId match — when the freight opportunity is bound to a
 *      recurring_lanes row (most precise; uses the existing lane index).
 *   2. company + procurement_lane label match — for opportunities without a
 *      recurringLaneId, fall back to a company-scoped match on the
 *      "Origin → Destination" string. Both LWQ AND AF wave persist the label
 *      on every send so this fallback is symmetric.
 */

import {
  findCarrierContactLocks,
  CONTACT_LOCK_WINDOW_HOURS,
  type ContactLockSource,
} from "./carrierContactLocks";

export const FREIGHT_CROSS_THROTTLE_HOURS = CONTACT_LOCK_WINDOW_HOURS;

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
  /** Original send module (lwq / af_wave / auto_pilot / …) — for richer chips. */
  sourceModule: ContactLockSource;
  /** Display name of the actor who sent the previous message. */
  actorName: string | null;
  actorUserId: string | null;
}

/**
 * Returns the subset of `carrierIds` already contacted on the same lane within
 * the last FREIGHT_CROSS_THROTTLE_HOURS. Empty result means none are throttled.
 */
export async function findCrossThrottledCarriers(
  q: CrossThrottleQuery,
): Promise<Map<string, CrossThrottleHit>> {
  const locks = await findCarrierContactLocks({
    orgId: q.orgId,
    carrierIds: q.carrierIds,
    recurringLaneId: q.recurringLaneId,
    companyId: q.companyId,
    laneLabel: q.laneLabel,
  });
  const out = new Map<string, CrossThrottleHit>();
  for (const [carrierId, lock] of locks) {
    out.set(carrierId, {
      carrierId,
      lastSentAt: lock.lastSentAt,
      source: lock.matchedBy === "lane_id" ? "lane_id_match" : "company_lane_label_match",
      sourceModule: lock.source,
      actorName: lock.actorName,
      actorUserId: lock.actorUserId,
    });
  }
  return out;
}
