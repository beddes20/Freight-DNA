/**
 * Carrier scorecard fact builder (Task #369).
 *
 * Rebuilds `carrier_scorecard_fact` per org from delivered load_fact rows.
 * Idempotent: deletes the org's scorecard rows in a transaction and inserts
 * fresh ones. Equipment splits stored alongside an 'ALL' rollup.
 *
 *   performance_score = 0.45*marginPctZ + 0.25*volumeZ + 0.15*recency + 0.15*onTime
 * Where margin/volume are min-max scaled across the org's carrier set, and
 * recency = exp(-daysSinceLastLoad / recencyDecayDays). Outputs 0–100.
 *
 * Realized fields are computed strictly from rows where moveStatus matches
 * Delivered (or bucket = 'realized' as a fallback) — Available/cancelled
 * loads NEVER contribute to revenue/margin/on-time. They flow into the
 * separate active/available counters so callers can see capacity at a glance.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "./storage";
import {
  carriers as carriersTbl,
  carrierScorecardFact,
  type InsertCarrierScorecardFact,
} from "@shared/schema";
import { getThresholds } from "./carrierIntelligenceSettings";

const WINDOW_DAYS = 180;

/** SQL guard: realized = moveStatus matches Delivered (case-insensitive)
 *  OR bucket = 'realized' (importer's derived classification). */
const REALIZED_GUARD = sql`(LOWER(COALESCE(move_status,'')) LIKE '%deliver%' OR bucket = 'realized')`;

function ymdNDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function safeNum(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : fallback;
}

export async function recomputeCarrierScorecards(orgId: string): Promise<number> {
  const cutoff = ymdNDaysAgo(WINDOW_DAYS);
  const cutoff30 = ymdNDaysAgo(30);
  const cutoff90 = ymdNDaysAgo(90);

  const dnuRows = await db.select({ name: carriersTbl.name, status: carriersTbl.status, tags: carriersTbl.tags })
    .from(carriersTbl)
    .where(eq(carriersTbl.orgId, orgId));
  const dnuSet = new Set<string>();
  for (const c of dnuRows) {
    if (c.status === "do_not_use") dnuSet.add(normName(c.name));
    const tags = (c.tags ?? []) as string[];
    if (tags.some(t => t === "do_not_use" || t === "no_use")) dnuSet.add(normName(c.name));
  }

  // Realized aggregates per (carrier, equipment) — strictly Delivered rows.
  const rows = await db.execute(sql`
    SELECT
      carrier_name,
      equipment_type,
      COUNT(*)::text AS loads,
      COUNT(*) FILTER (WHERE pickup_date >= ${cutoff30})::text AS loads_30d,
      COUNT(*) FILTER (WHERE pickup_date >= ${cutoff90})::text AS loads_90d,
      COALESCE(SUM(revenue), 0)::text AS revenue,
      COALESCE(SUM(cost), 0)::text AS cost,
      COALESCE(SUM(margin), 0)::text AS margin,
      COALESCE(SUM(total_miles), 0)::text AS miles,
      MAX(pickup_date) AS last_load_date,
      COUNT(*) FILTER (
        WHERE arrived_at_delivery IS NOT NULL
          AND delivery_appt_end IS NOT NULL
          AND arrived_at_delivery <= delivery_appt_end
      )::text AS on_time_count,
      COUNT(*) FILTER (
        WHERE arrived_at_delivery IS NOT NULL AND delivery_appt_end IS NOT NULL
      )::text AS on_time_denom
    FROM load_fact
    WHERE org_id = ${orgId}
      AND ${REALIZED_GUARD}
      AND carrier_name IS NOT NULL
      AND carrier_name <> ''
      AND (pickup_date IS NULL OR pickup_date >= ${cutoff})
      AND COALESCE(source_kind, '') <> 'available_freight_history'
    GROUP BY carrier_name, equipment_type
  `);

  // Active / available counts per carrier (NOT folded into revenue/margin).
  const activeRes = await db.execute(sql`
    SELECT
      carrier_name,
      COUNT(*) FILTER (WHERE bucket NOT IN ('realized','cancelled') AND carrier_name IS NOT NULL AND carrier_name <> '')::text AS active_loads
    FROM load_fact
    WHERE org_id = ${orgId} AND carrier_name IS NOT NULL AND carrier_name <> ''
    GROUP BY carrier_name
  `);
  const activeByCarrier = new Map<string, number>();
  for (const r of activeRes.rows as Array<Record<string, unknown>>) activeByCarrier.set(String(r.carrier_name), Number(r.active_loads) || 0);

  // Available opportunity = available loads on lanes the carrier has run before.
  const availRes = await db.execute(sql`
    WITH carrier_lanes AS (
      SELECT DISTINCT carrier_name, origin_state, destination_state
      FROM load_fact
      WHERE org_id = ${orgId} AND ${REALIZED_GUARD}
        AND carrier_name IS NOT NULL AND carrier_name <> ''
        AND origin_state IS NOT NULL AND destination_state IS NOT NULL
    )
    SELECT cl.carrier_name, COUNT(*)::text AS available_loads
    FROM carrier_lanes cl
    JOIN load_fact lf
      ON lf.org_id = ${orgId}
     AND lf.bucket = 'available'
     AND lf.origin_state = cl.origin_state
     AND lf.destination_state = cl.destination_state
    GROUP BY cl.carrier_name
  `);
  const availByCarrier = new Map<string, number>();
  for (const r of availRes.rows as Array<Record<string, unknown>>) availByCarrier.set(String(r.carrier_name), Number(r.available_loads) || 0);

  type Agg = {
    loads: number; loads30d: number; loads90d: number;
    revenue: number; cost: number; margin: number; miles: number;
    lastLoadDate: string | null;
    onTimeNum: number; onTimeDenom: number;
  };
  const carrierRows = new Map<string, Map<string, Agg>>();
  function blank(): Agg {
    return { loads: 0, loads30d: 0, loads90d: 0, revenue: 0, cost: 0, margin: 0, miles: 0, lastLoadDate: null, onTimeNum: 0, onTimeDenom: 0 };
  }

  for (const r of rows.rows as Array<Record<string, unknown>>) {
    const carrier = String(r.carrier_name);
    const equip = (r.equipment_type as string | null) || "UNKNOWN";
    const equipMap = carrierRows.get(carrier) ?? new Map<string, Agg>();
    carrierRows.set(carrier, equipMap);
    const a = blank();
    a.loads = Number(r.loads) || 0;
    a.loads30d = Number(r.loads_30d) || 0;
    a.loads90d = Number(r.loads_90d) || 0;
    a.revenue = safeNum(r.revenue);
    a.cost = safeNum(r.cost);
    a.margin = safeNum(r.margin);
    a.miles = safeNum(r.miles);
    a.lastLoadDate = r.last_load_date as string | null;
    a.onTimeNum = Number(r.on_time_count) || 0;
    a.onTimeDenom = Number(r.on_time_denom) || 0;
    equipMap.set(equip, a);

    const all = equipMap.get("ALL") ?? blank();
    all.loads += a.loads;
    all.loads30d += a.loads30d;
    all.loads90d += a.loads90d;
    all.revenue += a.revenue;
    all.cost += a.cost;
    all.margin += a.margin;
    all.miles += a.miles;
    all.onTimeNum += a.onTimeNum;
    all.onTimeDenom += a.onTimeDenom;
    if (a.lastLoadDate && (!all.lastLoadDate || a.lastLoadDate > all.lastLoadDate)) {
      all.lastLoadDate = a.lastLoadDate;
    }
    equipMap.set("ALL", all);
  }

  const thresholds = await getThresholds(orgId);
  const today = new Date();

  const allAggs: Agg[] = [];
  for (const eq of carrierRows.values()) {
    const all = eq.get("ALL");
    if (all && all.loads > 0) allAggs.push(all);
  }
  const maxVolume = Math.max(1, ...allAggs.map(a => a.loads));
  const marginPcts = allAggs.map(a => a.revenue > 0 ? (a.margin / a.revenue) * 100 : 0);
  const minMargin = Math.min(0, ...marginPcts);
  const maxMargin = Math.max(1, ...marginPcts);

  const inserts: InsertCarrierScorecardFact[] = [];
  for (const [carrierName, equipMap] of carrierRows.entries()) {
    const all = equipMap.get("ALL")!;
    const marginPct = all.revenue > 0 ? (all.margin / all.revenue) * 100 : 0;
    const lastDate = all.lastLoadDate;
    const daysSince = lastDate ? Math.max(0, Math.floor((today.getTime() - new Date(lastDate).getTime()) / 86400000)) : null;
    const recency = daysSince === null ? 0 : Math.exp(-daysSince / Math.max(1, thresholds.recencyDecayDays));
    const volumeNorm = all.loads / maxVolume;
    const marginNorm = (marginPct - minMargin) / Math.max(0.01, maxMargin - minMargin);
    const onTimeRatio = all.onTimeDenom > 0 ? all.onTimeNum / all.onTimeDenom : 0;
    const score = Math.round(100 * (0.45 * marginNorm + 0.25 * volumeNorm + 0.15 * recency + 0.15 * onTimeRatio));

    let tier = "new";
    if (all.loads >= 3) {
      if (score >= thresholds.tierAMinScore) tier = "A";
      else if (score >= thresholds.tierBMinScore) tier = "B";
      else tier = "C";
    }

    const isDnu = dnuSet.has(normName(carrierName));
    const carrierActive = activeByCarrier.get(carrierName) ?? 0;
    const carrierAvail = availByCarrier.get(carrierName) ?? 0;

    for (const [equip, a] of equipMap.entries()) {
      const pct = a.revenue > 0 ? (a.margin / a.revenue) * 100 : 0;
      const avgRpm = a.miles > 0 ? a.revenue / a.miles : null;
      const onTimePctEq = a.onTimeDenom > 0 ? (a.onTimeNum / a.onTimeDenom) * 100 : null;
      const revPerLoad = a.loads > 0 ? a.revenue / a.loads : null;
      inserts.push({
        orgId,
        carrierName,
        equipmentType: equip,
        windowDays: WINDOW_DAYS,
        loads: a.loads,
        loads30d: a.loads30d,
        loads90d: a.loads90d,
        revenue: a.revenue.toFixed(2),
        cost: a.cost.toFixed(2),
        margin: a.margin.toFixed(2),
        marginPct: pct.toFixed(4),
        avgRpm: avgRpm !== null ? avgRpm.toFixed(4) : null,
        totalMiles: a.miles.toFixed(2),
        revenuePerLoad: revPerLoad !== null ? revPerLoad.toFixed(2) : null,
        onTimePct: onTimePctEq !== null ? onTimePctEq.toFixed(2) : null,
        // active / available are carrier-wide; carry on every equipment row
        // so callers don't need a join.
        activeLoads: carrierActive,
        availableLoads: carrierAvail,
        doNotUse: isDnu,
        performanceScore: score,
        tier,
        daysSinceLastLoad: daysSince,
        lastLoadDate: a.lastLoadDate,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(carrierScorecardFact).where(eq(carrierScorecardFact.orgId, orgId));
    if (inserts.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        await tx.insert(carrierScorecardFact).values(inserts.slice(i, i + CHUNK));
      }
    }
  });

  return inserts.length;
}

function normName(s: string): string {
  return (s || "").trim().toLowerCase();
}

export async function listScorecards(orgId: string, opts: { equipment?: string; minLoads?: number; tier?: string; limit?: number } = {}) {
  const conds = [eq(carrierScorecardFact.orgId, orgId)];
  conds.push(eq(carrierScorecardFact.equipmentType, opts.equipment ?? "ALL"));
  if (opts.tier) conds.push(eq(carrierScorecardFact.tier, opts.tier));
  if (opts.minLoads !== undefined) conds.push(sql`${carrierScorecardFact.loads} >= ${opts.minLoads}`);
  return db.select().from(carrierScorecardFact)
    .where(and(...conds))
    .orderBy(sql`${carrierScorecardFact.performanceScore} DESC, ${carrierScorecardFact.loads} DESC`)
    .limit(Math.min(2000, opts.limit ?? 500));
}

export async function getScorecardForCarrier(orgId: string, carrierName: string) {
  return db.select().from(carrierScorecardFact)
    .where(and(eq(carrierScorecardFact.orgId, orgId), eq(carrierScorecardFact.carrierName, carrierName)));
}
