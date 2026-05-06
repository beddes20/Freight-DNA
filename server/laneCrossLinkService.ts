// Task #635 — Lane Cross-Link service.
//
// Computes, in a single pass, the data needed to render reciprocal chips
// between the Available Freight (AF) cockpit and the Lane Work Queue (LWQ).
//
//   • LWQ-context-for-AF — for an AF row keyed by lane signature, what is
//     the matching LWQ lane (id, owner, last-touch, contacted count, reply
//     count). Powers the chip "In your LWQ — last touched 2hr ago · 4
//     carriers contacted · 1 reply" rendered on each AF row.
//
//   • AF-context-for-LWQ — for an LWQ lane keyed by lane signature, how
//     many OPEN freight opportunities exist for that signature today.
//     Powers the chip "3 live opps today · 5 loads · pickup MMM DD"
//     rendered on each LWQ row.
//
// Both helpers issue a small constant number of queries per request (no
// per-row N+1) and return a Map keyed by the canonical lane signature.

import { and, eq, inArray, gte, sql } from "drizzle-orm";
import {
  recurringLanes,
  carrierOutreachLogs,
  laneCarrierInterest,
  freightOpportunities,
  loadFact,
} from "@shared/schema";

const HOT_REPLY_STATUSES = ["available_now", "available_next_week"] as const;

const OPEN_OPP_STATUSES = [
  "new",
  "ready_to_send",
  "sent",
  "awaiting_carrier_reply",
  "awaiting_customer_confirm",
  "partially_covered",
] as const;

/**
 * Canonical lane signature shared by AF + LWQ cross-link surfaces.
 *
 * Mirrors the equality check used elsewhere (proactiveOpportunityService
 * resolvedLane lookup, storage.getOrgWideBenchByLaneSignature): trim,
 * lowercase, fall back to empty string for missing parts.
 */
export function laneSig(
  origin: string | null | undefined,
  originState: string | null | undefined,
  destination: string | null | undefined,
  destinationState: string | null | undefined,
  equipmentType: string | null | undefined,
): string {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  return [
    norm(origin),
    norm(originState),
    norm(destination),
    norm(destinationState),
    norm(equipmentType),
  ].join("|");
}

export interface LwqLaneContext {
  laneId: string;
  ownerUserId: string | null;
  contactedCount: number;
  lastTouchAt: string | null;
  replyCount: number;
  hotReplyCount: number;
  /**
   * Task #871 — Lane stability badge derived from `scoreLane` volatility
   * penalty. Mirrors what LWQ computes for its own list so AF rows can
   * surface the same Stable/Volatile/Hot signal next to their cross-link
   * chip. `null` when the lane has not been scored yet.
   */
  stability: LaneStability | null;
}

/**
 * Stable = no volatility penalty; Volatile = mid penalty (CV > medThreshold);
 * Hot    = high penalty (CV > highThreshold) — i.e. the most erratic lanes.
 *
 * The classifier is centralized so the AF row badge, LWQ row badge, and
 * Lane Cockpit header strip cannot disagree.
 */
export type LaneStability = "stable" | "volatile" | "hot";

export function classifyStability(
  volatilityPenalty: number | null | undefined,
): LaneStability | null {
  if (volatilityPenalty === null || volatilityPenalty === undefined) return null;
  if (!Number.isFinite(volatilityPenalty)) return null;
  // recurringLaneCapacityEngine.LANE_CONFIG.scoring values:
  //   volatilityHighPenalty = -10  (CV > 0.5)
  //   volatilityMedPenalty  =  -5  (CV > 0.3)
  //   else                  =   0
  // We treat anything ≤ -8 as "hot" and the band (-8, 0) as "volatile" so a
  // future tweak to the penalty scalars doesn't silently flip categories.
  if (volatilityPenalty <= -8) return "hot";
  if (volatilityPenalty < 0) return "volatile";
  return "stable";
}

export interface OpenOppLaneContext {
  count: number;
  totalLoads: number;
  /**
   * Combined customer-side revenue across all open opps for the lane today,
   * derived by joining each opp to its source `load_fact.revenue` via
   * `freight_opportunities.sourceRef->>'orderId'`. Falls back to 0 when no
   * source row carries a revenue figure (so the chip can hide the dollar
   * fragment cleanly).
   */
  combinedRevenue: number;
  nextPickupAt: string | null;
  sampleOppId: string | null;
  /**
   * Task #1069 — subset of `count` whose source is a won customer quote
   * (`sourceRef.type = 'won_quote'`). Powers the "Active won load" chip
   * on the LWQ row so the LM sees inbound-email-driven won loads next
   * to their lane.
   */
  wonQuoteCount: number;
}

type DrizzleLikeDb = {
  select: (...args: any[]) => any;
};

/**
 * Build the LWQ-context map for the AF cockpit feed.
 *
 * Visibility: only includes lanes the current rep can see in their LWQ
 * (mirrors `resolveVisibleUserIds` semantics — pass the same visibleUserIds
 * + canSeeUnassigned the LWQ endpoint uses).
 */
export async function buildLwqContextByLaneSig(
  db: DrizzleLikeDb,
  orgId: string,
  visibleUserIds: string[],
  canSeeUnassigned: boolean,
): Promise<Map<string, LwqLaneContext>> {
  const out = new Map<string, LwqLaneContext>();

  const lanes = await db
    .select({
      id: recurringLanes.id,
      origin: recurringLanes.origin,
      originState: recurringLanes.originState,
      destination: recurringLanes.destination,
      destinationState: recurringLanes.destinationState,
      equipmentType: recurringLanes.equipmentType,
      ownerUserId: recurringLanes.ownerUserId,
      carriersContactedCount: recurringLanes.carriersContactedCount,
      // Task #871 — pull the score factors jsonb so we can derive the
      // Stable/Volatile/Hot stability badge without an extra round trip.
      laneScoreFactors: recurringLanes.laneScoreFactors,
    })
    .from(recurringLanes)
    .where(eq(recurringLanes.orgId, orgId));

  const visibleSet = new Set(visibleUserIds);
  const inScope = (lanes as Array<{
    id: string;
    origin: string;
    originState: string | null;
    destination: string;
    destinationState: string | null;
    equipmentType: string | null;
    ownerUserId: string | null;
    carriersContactedCount: number | null;
    laneScoreFactors: any;
  }>).filter(l =>
    l.ownerUserId ? visibleSet.has(l.ownerUserId) : canSeeUnassigned,
  );

  if (inScope.length === 0) return out;

  const laneIds = inScope.map(l => l.id);

  // Last-touch per lane — most recent successful outreach.
  const touchRows = (await db
    .select({
      laneId: carrierOutreachLogs.laneId,
      lastTouchAt: sql<Date | null>`MAX(${carrierOutreachLogs.sentAt})`.as("last_touch_at"),
    })
    .from(carrierOutreachLogs)
    .where(and(
      inArray(carrierOutreachLogs.laneId, laneIds),
      inArray(carrierOutreachLogs.deliveryStatus, ["sent", "delivered", "opened", "partial"]),
    ))
    .groupBy(carrierOutreachLogs.laneId)) as Array<{ laneId: string | null; lastTouchAt: Date | null }>;

  const touchByLane = new Map<string, Date | null>();
  for (const r of touchRows) {
    if (r.laneId) touchByLane.set(r.laneId, r.lastTouchAt);
  }

  // Reply counts per lane (any reply + hot replies).
  const replyRows = (await db
    .select({
      laneId: laneCarrierInterest.laneId,
      interestStatus: laneCarrierInterest.interestStatus,
      replyCount: sql<number>`COUNT(*)`.as("reply_count"),
    })
    .from(laneCarrierInterest)
    .where(inArray(laneCarrierInterest.laneId, laneIds))
    .groupBy(laneCarrierInterest.laneId, laneCarrierInterest.interestStatus)) as Array<{
      laneId: string;
      interestStatus: string;
      replyCount: number | string;
    }>;

  const replyByLane = new Map<string, { total: number; hot: number }>();
  for (const r of replyRows) {
    const n = typeof r.replyCount === "string" ? parseInt(r.replyCount, 10) : r.replyCount;
    if (!Number.isFinite(n) || n <= 0) continue;
    const acc = replyByLane.get(r.laneId) ?? { total: 0, hot: 0 };
    // "Reply" = any classified interest record other than the seeded
    // needs_follow_up placeholder (which is created when a carrier is added
    // to the bench but hasn't actually responded yet).
    if (r.interestStatus !== "needs_follow_up") acc.total += n;
    if ((HOT_REPLY_STATUSES as readonly string[]).includes(r.interestStatus)) acc.hot += n;
    replyByLane.set(r.laneId, acc);
  }

  for (const lane of inScope) {
    const sig = laneSig(
      lane.origin,
      lane.originState,
      lane.destination,
      lane.destinationState,
      lane.equipmentType,
    );
    const replies = replyByLane.get(lane.id) ?? { total: 0, hot: 0 };
    const last = touchByLane.get(lane.id) ?? null;
    // First lane wins on signature collision so the chip routes to a
    // deterministic destination. (Two recurring_lanes rows for the same
    // signature is a data-integrity edge case — pick the lower id which
    // matches default ordering.)
    if (out.has(sig)) continue;
    const factors = lane.laneScoreFactors as { volatilityPenalty?: number } | null;
    const volatilityPenalty = factors && typeof factors.volatilityPenalty === "number"
      ? factors.volatilityPenalty
      : null;
    out.set(sig, {
      laneId: lane.id,
      ownerUserId: lane.ownerUserId,
      contactedCount: lane.carriersContactedCount ?? 0,
      lastTouchAt: last ? last.toISOString() : null,
      replyCount: replies.total,
      hotReplyCount: replies.hot,
      stability: classifyStability(volatilityPenalty),
    });
  }

  return out;
}

/**
 * Build the open-opportunity context map for the LWQ feed.
 *
 * "Today" = freight opportunities generated since the start of the local UTC
 * day OR with a pickup window in the future, in an OPEN status. Closed
 * statuses (covered, cancelled, expired) are excluded so the chip reflects
 * actionable freight.
 */
export async function buildOpenOppContextByLaneSig(
  db: DrizzleLikeDb,
  orgId: string,
  opts: { now?: Date } = {},
): Promise<Map<string, OpenOppLaneContext>> {
  const out = new Map<string, OpenOppLaneContext>();
  const now = opts.now ?? new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const rows = (await db
    .select({
      id: freightOpportunities.id,
      origin: freightOpportunities.origin,
      originState: freightOpportunities.originState,
      destination: freightOpportunities.destination,
      destinationState: freightOpportunities.destinationState,
      equipmentType: freightOpportunities.equipmentType,
      pickupWindowStart: freightOpportunities.pickupWindowStart,
      loadCount: freightOpportunities.loadCount,
      generatedAt: freightOpportunities.generatedAt,
      status: freightOpportunities.status,
      // Surface the source TMS order id so we can join to load_fact for the
      // customer-side revenue without making per-row queries.
      sourceOrderId: sql<string | null>`${freightOpportunities.sourceRef}->>'orderId'`.as("source_order_id"),
      // Task #1069 — surface the source discriminator so the per-lane
      // aggregator can split won-quote rows out of the open-opp count.
      sourceType: sql<string | null>`${freightOpportunities.sourceRef}->>'type'`.as("source_type"),
    })
    .from(freightOpportunities)
    .where(and(
      eq(freightOpportunities.orgId, orgId),
      // Drizzle's inArray expects the literal union column type; widening to string[]
      // is safe because OPEN_OPP_STATUSES only contains valid status literals.
      inArray(freightOpportunities.status, OPEN_OPP_STATUSES as unknown as string[]),
      gte(freightOpportunities.generatedAt, startOfDay),
    ))) as Array<{
      id: string;
      origin: string;
      originState: string | null;
      destination: string;
      destinationState: string | null;
      equipmentType: string | null;
      pickupWindowStart: string | null;
      loadCount: number | null;
      generatedAt: Date | string | null;
      status: string;
      sourceOrderId: string | null;
      sourceType: string | null;
    }>;

  // Fetch realized/available revenue for the matching source orders in a
  // single round-trip (no per-row N+1). load_fact.revenue is the canonical
  // customer-side revenue field (`coverFreightOpportunity` uses customerRate
  // × loadCount on cover; until then this is the best per-load revenue
  // signal, populated from the daily TMS extract).
  const orderIds = Array.from(
    new Set(rows.map(r => r.sourceOrderId).filter((x): x is string => !!x)),
  );
  const revenueByOrderId = new Map<string, number>();
  if (orderIds.length > 0) {
    const revRows = (await db
      .select({
        orderId: loadFact.orderId,
        revenue: loadFact.revenue,
      })
      .from(loadFact)
      .where(and(
        eq(loadFact.orgId, orgId),
        inArray(loadFact.orderId, orderIds),
      ))) as Array<{ orderId: string; revenue: string | number | null }>;
    for (const r of revRows) {
      const n = typeof r.revenue === "string" ? parseFloat(r.revenue) : (r.revenue ?? 0);
      if (!Number.isFinite(n)) continue;
      revenueByOrderId.set(r.orderId, (revenueByOrderId.get(r.orderId) ?? 0) + n);
    }
  }

  for (const r of rows) {
    const sig = laneSig(
      r.origin,
      r.originState,
      r.destination,
      r.destinationState,
      r.equipmentType,
    );
    const acc = out.get(sig) ?? {
      count: 0,
      totalLoads: 0,
      combinedRevenue: 0,
      nextPickupAt: null,
      sampleOppId: null,
      wonQuoteCount: 0,
    };
    acc.count += 1;
    acc.totalLoads += r.loadCount ?? 1;
    if (r.sourceType === "won_quote") acc.wonQuoteCount += 1;
    if (r.sourceOrderId) {
      acc.combinedRevenue += revenueByOrderId.get(r.sourceOrderId) ?? 0;
    }
    if (!acc.sampleOppId) acc.sampleOppId = r.id;
    // Earliest pickup wins so "next" reflects the soonest actionable load.
    const pickup = r.pickupWindowStart;
    if (pickup) {
      if (!acc.nextPickupAt || pickup < acc.nextPickupAt) acc.nextPickupAt = pickup;
    }
    out.set(sig, acc);
  }

  return out;
}

/**
 * Round-trippable lane query string for AF deep-links from the LWQ.
 * The AF page reads `?lane=<sig>` and hides anything that doesn't match.
 */
export function buildAfLaneQueryParam(sig: string): string {
  return `lane=${encodeURIComponent(sig)}`;
}

/**
 * Round-trippable LWQ deep-link query string for AF rows that match a
 * lane in the rep's LWQ.
 */
export function buildLwqLaneQueryParam(laneId: string): string {
  return `laneId=${encodeURIComponent(laneId)}`;
}
