/**
 * Lane rate history rollup builder (Task #369).
 *
 * Builds `lane_rate_history` per org from delivered load_fact at three
 * dimensional cuts so the pricing engine can choose the most specific
 * trustworthy band:
 *
 *   1. (origin_state, destination_state, equipment='ALL', customer='__ANY__')
 *      → lane-only rollup (the broad anchor).
 *   2. (origin_state, destination_state, equipment_type, customer='__ANY__')
 *      → trailer-specific rollup, used by the (lane, trailer) lookup.
 *   3. (origin_state, destination_state, equipment='ALL', customer_name)
 *      → customer-specific rollup, used by the (lane, customer) lookup.
 *
 * Each row carries 30/60/90-day cost-per-mile averages for trend display in
 * addition to min/median/max + p25/p75 spread.
 *
 * Realized strictly = moveStatus matches Delivered (or bucket='realized' as
 * importer-derived fallback). Available/cancelled rows never enter the rollup.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "./storage";
import { laneRateHistory, type InsertLaneRateHistory, type LaneRateHistory } from "@shared/schema";
import type { FallbackTier } from "./carrierIntelligenceSettings";

const WINDOW_DAYS = 180;
const MIN_LOADS_TO_PERSIST = 1;
const REALIZED_GUARD = sql`(LOWER(COALESCE(move_status,'')) LIKE '%deliver%' OR bucket = 'realized')`;

function ymdNDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : null;
}

/** Shared SQL fragment for the per-window aggregate columns. */
function windowAggSql(cutoff30: string, cutoff60: string, cutoff90: string) {
  return sql`
    COUNT(*)::int AS loads,
    COUNT(*) FILTER (WHERE pickup_date >= ${cutoff30})::int AS loads_30d,
    COUNT(*) FILTER (WHERE pickup_date >= ${cutoff60})::int AS loads_60d,
    COUNT(*) FILTER (WHERE pickup_date >= ${cutoff90})::int AS loads_90d,
    COUNT(DISTINCT carrier_name)::int AS unique_carriers,
    AVG(NULLIF(revenue, 0) / NULLIF(total_miles, 0))::numeric(10,4) AS avg_revenue_per_mile,
    AVG(NULLIF(cost, 0) / NULLIF(total_miles, 0))::numeric(10,4) AS avg_cost_per_mile,
    AVG(NULLIF(margin_pct, 0))::numeric(10,4) AS avg_margin_pct,
    MIN(cost / NULLIF(total_miles, 0))::numeric(10,4) AS min_cost_per_mile,
    MAX(cost / NULLIF(total_miles, 0))::numeric(10,4) AS max_cost_per_mile,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY (cost / NULLIF(total_miles, 0))) AS p25_cost,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY (cost / NULLIF(total_miles, 0))) AS p50_cost,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY (cost / NULLIF(total_miles, 0))) AS p75_cost,
    AVG((cost / NULLIF(total_miles, 0))) FILTER (WHERE pickup_date >= ${cutoff30})::numeric(10,4) AS avg_cost_30d,
    AVG((cost / NULLIF(total_miles, 0))) FILTER (WHERE pickup_date >= ${cutoff60})::numeric(10,4) AS avg_cost_60d,
    AVG((cost / NULLIF(total_miles, 0))) FILTER (WHERE pickup_date >= ${cutoff90})::numeric(10,4) AS avg_cost_90d
  `;
}

const REALIZED_LANE_FILTER = (orgId: string, cutoff: string) => sql`
  org_id = ${orgId}
  AND ${REALIZED_GUARD}
  AND origin_state IS NOT NULL AND origin_state <> ''
  AND destination_state IS NOT NULL AND destination_state <> ''
  AND total_miles IS NOT NULL AND total_miles > 0
  AND (pickup_date IS NULL OR pickup_date >= ${cutoff})
`;

export async function recomputeLaneRateHistory(orgId: string): Promise<number> {
  const cutoff = ymdNDaysAgo(WINDOW_DAYS);
  const cutoff30 = ymdNDaysAgo(30);
  const cutoff60 = ymdNDaysAgo(60);
  const cutoff90 = ymdNDaysAgo(90);

  // 1. (lane, trailer) split — equipment != 'ALL', customer = '__ANY__'.
  const trailerRes = await db.execute(sql`
    SELECT origin_state, destination_state, equipment_type,
      ${windowAggSql(cutoff30, cutoff60, cutoff90)}
    FROM load_fact
    WHERE ${REALIZED_LANE_FILTER(orgId, cutoff)}
    GROUP BY origin_state, destination_state, equipment_type
  `);

  // 2. lane-only rollup (equipment='ALL', customer='__ANY__').
  const laneRes = await db.execute(sql`
    SELECT origin_state, destination_state,
      ${windowAggSql(cutoff30, cutoff60, cutoff90)}
    FROM load_fact
    WHERE ${REALIZED_LANE_FILTER(orgId, cutoff)}
    GROUP BY origin_state, destination_state
  `);

  // 3. (lane, customer) rollup (equipment='ALL').
  const customerRes = await db.execute(sql`
    SELECT origin_state, destination_state, customer_name,
      ${windowAggSql(cutoff30, cutoff60, cutoff90)}
    FROM load_fact
    WHERE ${REALIZED_LANE_FILTER(orgId, cutoff)}
      AND customer_name IS NOT NULL AND customer_name <> ''
    GROUP BY origin_state, destination_state, customer_name
  `);

  const inserts: InsertLaneRateHistory[] = [];
  function pushRow(row: any, equip: string, customer: string) {
    if ((row.loads ?? 0) < MIN_LOADS_TO_PERSIST) return;
    inserts.push({
      orgId,
      originState: String(row.origin_state).toUpperCase(),
      destinationState: String(row.destination_state).toUpperCase(),
      equipmentType: equip,
      customerName: customer,
      windowDays: WINDOW_DAYS,
      loads: Number(row.loads) || 0,
      loads30d: Number(row.loads_30d) || 0,
      loads60d: Number(row.loads_60d) || 0,
      loads90d: Number(row.loads_90d) || 0,
      avgRevenuePerMile: safeNum(row.avg_revenue_per_mile)?.toFixed(4) ?? null,
      avgCostPerMile: safeNum(row.avg_cost_per_mile)?.toFixed(4) ?? null,
      avgMarginPct: safeNum(row.avg_margin_pct)?.toFixed(4) ?? null,
      medianCostPerMile: safeNum(row.p50_cost)?.toFixed(4) ?? null,
      minCostPerMile: safeNum(row.min_cost_per_mile)?.toFixed(4) ?? null,
      maxCostPerMile: safeNum(row.max_cost_per_mile)?.toFixed(4) ?? null,
      p25CostPerMile: safeNum(row.p25_cost)?.toFixed(4) ?? null,
      p75CostPerMile: safeNum(row.p75_cost)?.toFixed(4) ?? null,
      avgCost30d: safeNum(row.avg_cost_30d)?.toFixed(4) ?? null,
      avgCost60d: safeNum(row.avg_cost_60d)?.toFixed(4) ?? null,
      avgCost90d: safeNum(row.avg_cost_90d)?.toFixed(4) ?? null,
      uniqueCarriers: Number(row.unique_carriers) || 0,
    });
  }
  type AggRow = Record<string, unknown>;
  for (const r of trailerRes.rows as AggRow[]) pushRow(r, String(r.equipment_type || "UNKNOWN"), "__ANY__");
  for (const r of laneRes.rows as AggRow[]) pushRow(r, "ALL", "__ANY__");
  for (const r of customerRes.rows as AggRow[]) pushRow(r, "ALL", String(r.customer_name));

  await db.transaction(async (tx) => {
    await tx.delete(laneRateHistory).where(eq(laneRateHistory.orgId, orgId));
    const CHUNK = 500;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      if (inserts.length > 0) await tx.insert(laneRateHistory).values(inserts.slice(i, i + CHUNK));
    }
  });
  return inserts.length;
}

export interface LaneHistoryLookup {
  originState: string;
  destinationState: string;
  equipmentType: string | null;
  customerName?: string | null;
}

export type LaneHistoryWithTier = LaneRateHistory & { fallbackTier: FallbackTier };

const DEFAULT_FALLBACK_ORDER: FallbackTier[] = [
  "lane_customer_trailer",
  "lane_customer",
  "lane_trailer",
  "lane",
  "nearby_lane",
  "state_pair",
  "trailer_benchmark",
];

/**
 * Pull the most specific trustworthy lane history row by walking the
 * configurable fallback chain. The first leg with `loads >= 1` wins.
 *
 * Fallback tiers (in default order — admin can re-order via settings):
 *   1. lane_customer_trailer — exact (origin, dest, customer, trailer)
 *   2. lane_customer         — (origin, dest, customer, ALL trailers)
 *   3. lane_trailer          — (origin, dest, ANY customer, trailer)
 *   4. lane                  — (origin, dest, ANY, ALL)
 *   5. nearby_lane           — same origin OR destination state, top by volume
 *   6. state_pair            — alias of `lane` rollup, kept for explicitness
 *   7. trailer_benchmark     — average across all lanes for this trailer type
 *
 * Returns null when no leg has data.
 */
export async function getLaneRateHistory(
  orgId: string,
  originState: string,
  destinationState: string,
  equipmentType: string | null,
  customerName?: string | null,
  fallbackOrder: FallbackTier[] = DEFAULT_FALLBACK_ORDER,
): Promise<LaneHistoryWithTier | null> {
  const o = originState.toUpperCase();
  const d = destinationState.toUpperCase();
  const equip = equipmentType?.trim() || null;
  const customer = customerName?.trim() || null;

  for (const tier of fallbackOrder) {
    const found = await probeLeg(orgId, o, d, equip, customer, tier);
    if (found) return { ...found, fallbackTier: tier };
  }
  return null;
}

async function probeLeg(
  orgId: string,
  o: string,
  d: string,
  equip: string | null,
  customer: string | null,
  tier: FallbackTier,
): Promise<LaneRateHistory | null> {
  switch (tier) {
    case "lane_customer_trailer": {
      if (!customer || !equip) return null;
      const rows = await db.select().from(laneRateHistory).where(sql`
        ${laneRateHistory.orgId} = ${orgId}
        AND ${laneRateHistory.originState} = ${o}
        AND ${laneRateHistory.destinationState} = ${d}
        AND ${laneRateHistory.equipmentType} = ${equip}
        AND ${laneRateHistory.customerName} = ${customer}
      `).limit(1);
      return rows[0] ?? null;
    }
    case "lane_customer": {
      if (!customer) return null;
      const rows = await db.select().from(laneRateHistory).where(sql`
        ${laneRateHistory.orgId} = ${orgId}
        AND ${laneRateHistory.originState} = ${o}
        AND ${laneRateHistory.destinationState} = ${d}
        AND ${laneRateHistory.equipmentType} = 'ALL'
        AND ${laneRateHistory.customerName} = ${customer}
      `).limit(1);
      return rows[0] ?? null;
    }
    case "lane_trailer": {
      if (!equip) return null;
      const rows = await db.select().from(laneRateHistory).where(sql`
        ${laneRateHistory.orgId} = ${orgId}
        AND ${laneRateHistory.originState} = ${o}
        AND ${laneRateHistory.destinationState} = ${d}
        AND ${laneRateHistory.equipmentType} = ${equip}
        AND ${laneRateHistory.customerName} = '__ANY__'
      `).limit(1);
      return rows[0] ?? null;
    }
    case "lane":
    case "state_pair": {
      const rows = await db.select().from(laneRateHistory).where(sql`
        ${laneRateHistory.orgId} = ${orgId}
        AND ${laneRateHistory.originState} = ${o}
        AND ${laneRateHistory.destinationState} = ${d}
        AND ${laneRateHistory.equipmentType} = 'ALL'
        AND ${laneRateHistory.customerName} = '__ANY__'
      `).limit(1);
      return rows[0] ?? null;
    }
    case "nearby_lane": {
      // Same origin OR destination state — pick the highest-volume nearby.
      const rows = await db.select().from(laneRateHistory).where(sql`
        ${laneRateHistory.orgId} = ${orgId}
        AND (${laneRateHistory.originState} = ${o} OR ${laneRateHistory.destinationState} = ${d})
        AND NOT (${laneRateHistory.originState} = ${o} AND ${laneRateHistory.destinationState} = ${d})
        AND ${laneRateHistory.equipmentType} = 'ALL'
        AND ${laneRateHistory.customerName} = '__ANY__'
      `).orderBy(sql`${laneRateHistory.loads} DESC`).limit(1);
      return rows[0] ?? null;
    }
    case "trailer_benchmark": {
      if (!equip) return null;
      // Org-wide average for this trailer type — only used as a last-resort.
      const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          ${o} AS origin_state, ${d} AS destination_state,
          ${equip} AS equipment_type, '__ANY__' AS customer_name,
          180 AS window_days,
          COALESCE(SUM(loads), 0)::int AS loads,
          COALESCE(SUM(loads_30d), 0)::int AS loads_30d,
          COALESCE(SUM(loads_60d), 0)::int AS loads_60d,
          COALESCE(SUM(loads_90d), 0)::int AS loads_90d,
          AVG(avg_revenue_per_mile)::numeric(10,4) AS avg_revenue_per_mile,
          AVG(avg_cost_per_mile)::numeric(10,4) AS avg_cost_per_mile,
          AVG(avg_margin_pct)::numeric(10,4) AS avg_margin_pct,
          AVG(median_cost_per_mile)::numeric(10,4) AS median_cost_per_mile,
          MIN(min_cost_per_mile)::numeric(10,4) AS min_cost_per_mile,
          MAX(max_cost_per_mile)::numeric(10,4) AS max_cost_per_mile,
          AVG(p25_cost_per_mile)::numeric(10,4) AS p25_cost_per_mile,
          AVG(p75_cost_per_mile)::numeric(10,4) AS p75_cost_per_mile,
          AVG(avg_cost_30d)::numeric(10,4) AS avg_cost_30d,
          AVG(avg_cost_60d)::numeric(10,4) AS avg_cost_60d,
          AVG(avg_cost_90d)::numeric(10,4) AS avg_cost_90d,
          COALESCE(SUM(unique_carriers), 0)::int AS unique_carriers,
          NOW() AS computed_at
        FROM lane_rate_history
        WHERE org_id = ${orgId} AND equipment_type = ${equip}
      `);
      const r = rows.rows[0];
      if (!r || !Number(r.loads)) return null;
      // Synthesize a row matching LaneRateHistory shape.
      return {
        id: "synthetic-trailer-benchmark",
        orgId,
        originState: o,
        destinationState: d,
        equipmentType: equip,
        customerName: "__ANY__",
        windowDays: Number(r.window_days) || 180,
        loads: Number(r.loads) || 0,
        loads30d: Number(r.loads_30d) || 0,
        loads60d: Number(r.loads_60d) || 0,
        loads90d: Number(r.loads_90d) || 0,
        avgRevenuePerMile: r.avg_revenue_per_mile != null ? String(r.avg_revenue_per_mile) : null,
        avgCostPerMile: r.avg_cost_per_mile != null ? String(r.avg_cost_per_mile) : null,
        avgMarginPct: r.avg_margin_pct != null ? String(r.avg_margin_pct) : null,
        medianCostPerMile: r.median_cost_per_mile != null ? String(r.median_cost_per_mile) : null,
        minCostPerMile: r.min_cost_per_mile != null ? String(r.min_cost_per_mile) : null,
        maxCostPerMile: r.max_cost_per_mile != null ? String(r.max_cost_per_mile) : null,
        p25CostPerMile: r.p25_cost_per_mile != null ? String(r.p25_cost_per_mile) : null,
        p75CostPerMile: r.p75_cost_per_mile != null ? String(r.p75_cost_per_mile) : null,
        avgCost30d: r.avg_cost_30d != null ? String(r.avg_cost_30d) : null,
        avgCost60d: r.avg_cost_60d != null ? String(r.avg_cost_60d) : null,
        avgCost90d: r.avg_cost_90d != null ? String(r.avg_cost_90d) : null,
        uniqueCarriers: Number(r.unique_carriers) || 0,
        computedAt: new Date(),
      };
    }
  }
  return null;
}

/**
 * Convenience: fetch the nearby-lane band only (no exact match). Used by
 * surfaces that want to display "nearby lanes look like this" alongside the
 * primary band.
 */
export async function getNearbyLaneHistory(orgId: string, originState: string): Promise<LaneRateHistory[]> {
  const o = originState.toUpperCase();
  return db.select().from(laneRateHistory).where(sql`
    ${laneRateHistory.orgId} = ${orgId}
    AND ${laneRateHistory.originState} = ${o}
    AND ${laneRateHistory.equipmentType} = 'ALL'
    AND ${laneRateHistory.customerName} = '__ANY__'
  `).orderBy(sql`${laneRateHistory.loads} DESC`).limit(5);
}
