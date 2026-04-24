import { and, eq, sql, desc, or } from "drizzle-orm";
import { db } from "../storage";
import {
  loadFact,
  carriers,
  carrierLaneFit,
  carrierScorecardFact,
  geographicLanePatterns,
  type GeographicLanePattern,
} from "@shared/schema";
import { fetchFullLane } from "../tracService";
import { cityToKma, toTracEquipment } from "../kmaMapping";

export type LaneMarket = {
  source: "trac";
  band: { low: number; mid: number; high: number } | null;
  rpm: { low: number | null; mid: number | null; high: number | null } | null;
  contractRpm: number | null;
  miles: number | null;
  confidence: number | null;
  loadCount: number | null;
  avgRpm30d: number | null;
  avgRpm90d: number | null;
  forecast7dRpm: number | null;
  /** Task #515 — derived from 7d forecast vs avgRpm30d. */
  forecastDirection: "up" | "down" | "flat";
  /** Task #515 — short capacity outlook string for the guidance band. */
  capacityOutlook: string | null;
  originKma: string | null;
  destKma: string | null;
  equipment: "VAN" | "REEFER" | "FLATBED";
  fetchedAt: number;
};

export type LaneMarketResult =
  | { ok: true; market: LaneMarket }
  | { ok: false; reason: string };

export type LaneTrafficCarrier = {
  name: string;
  loads: number;
  loads30d: number;
  loads90d: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  /** Task #515 — Carrier Reliability Score (from carrier_scorecard_fact). */
  reliabilityScore: number | null;
  reliabilityTier: string | null;
  lastBuyRate: number | null;
};

export type LaneTraffic = {
  totalLoads: number;
  loads30d: number;
  loads90d: number;
  realized: number;
  available: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  uniqueCarriers: number;
  /** Task #515 — tier-style breakdown (exact city → same KMA → same state). */
  tierBreakdown: { exact: number; sameMarket: number; sameState: number };
  topCarriers: LaneTrafficCarrier[];
};

export type CarrierOutreachItem = {
  carrierId: string | null;
  name: string;
  fitScore: number;
  /** Task #515 — combined fit + reliability for ranking. */
  rankScore: number;
  evidenceTier: string;
  exactLaneRuns: number;
  nearbyRuns: number;
  loads90d: number;
  marginPct: number;
  performanceScore: number;
  tier: string;
  doNotUse: boolean;
  primaryEmail: string | null;
  phone: string | null;
  inRolodex: boolean;
  /** Task #515 — presence flag: rolodex membership + above-baseline reliability. */
  presence: "active" | "known" | "cold";
  reason: string | null;
};

export type CorridorPattern = {
  id: string;
  name: string;
  namedCorridor: string | null;
  originRegion: string;
  destinationRegion: string;
  description: string | null;
  isBaseline: boolean;
};

// ---------------------------------------------------------------------------
// LRU cache with TTL — Task #515. Bounded so we don't unbounded-grow the
// process heap if many distinct lanes get hit.
// ---------------------------------------------------------------------------
const TRAC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TRAC_CACHE_MAX_ENTRIES = 500;

type CacheEntry = { fetchedAt: number; result: LaneMarketResult };

class LruCache<K, V extends { fetchedAt: number }> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}
  get(key: K): V | null {
    const v = this.map.get(key);
    if (!v) return null;
    if (Date.now() - v.fetchedAt >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}

const tracCache = new LruCache<string, CacheEntry>(TRAC_CACHE_MAX_ENTRIES, TRAC_CACHE_TTL_MS);

/** Test-only: clear the in-memory TRAC cache. */
export function __resetTracCacheForTests(): void { tracCache.clear(); }

function tracKey(originKma: string, destKma: string, equipment: string): string {
  return `${originKma}|${destKma}|${equipment}`;
}

function deriveForecastDirection(forecast7dRpm: number | null, baseline: number | null): "up" | "down" | "flat" {
  if (forecast7dRpm == null || baseline == null || baseline === 0) return "flat";
  const pct = (forecast7dRpm - baseline) / baseline;
  if (pct >= 0.02) return "up";
  if (pct <= -0.02) return "down";
  return "flat";
}

function deriveCapacityOutlook(direction: "up" | "down" | "flat", forecast: number | null, baseline: number | null): string | null {
  if (forecast == null || baseline == null || baseline === 0) return null;
  const deltaPct = ((forecast - baseline) / baseline) * 100;
  const sign = deltaPct >= 0 ? "+" : "";
  if (direction === "up") return `Tightening — 7d forecast ${sign}${deltaPct.toFixed(1)}% vs 30d`;
  if (direction === "down") return `Loosening — 7d forecast ${sign}${deltaPct.toFixed(1)}% vs 30d`;
  return `Stable — 7d forecast ${sign}${deltaPct.toFixed(1)}% vs 30d`;
}

/**
 * Fetch TRAC market band for a lane. Cached 1hr in-memory (LRU, 500 entry
 * max) per (originKMA, destKMA, equipment). Degrades gracefully when KMAs
 * cannot be resolved or TRAC fails.
 */
export async function getLaneMarket(
  pickupCity: string,
  pickupState: string,
  deliveryCity: string,
  deliveryState: string,
  equipmentRaw: string | null | undefined,
): Promise<LaneMarketResult> {
  const oKma = cityToKma(pickupCity, pickupState);
  const dKma = cityToKma(deliveryCity, deliveryState);
  if (!oKma || !dKma) {
    return { ok: false, reason: "KMA mapping unavailable for one or both endpoints" };
  }
  const equipment = toTracEquipment(equipmentRaw);
  const key = tracKey(oKma.kma, dKma.kma, equipment);
  const cached = tracCache.get(key);
  if (cached) return cached.result;
  let result: LaneMarketResult;
  try {
    const data = await fetchFullLane(oKma.kma, dKma.kma, equipment);
    if (!data) {
      result = { ok: false, reason: "TRAC returned no data" };
    } else {
      const rateLow = data.spot.rateLow;
      const rate = data.spot.rate;
      const rateHigh = data.spot.rateHigh;
      const band = (rateLow != null && rate != null && rateHigh != null)
        ? { low: rateLow, mid: rate, high: rateHigh }
        : null;
      const forecast7dRpm = (() => {
        const seven = (data.forecast ?? []).slice(0, 7).map(d => d.forecastRpm).filter((v): v is number => typeof v === "number");
        if (!seven.length) return null;
        return seven.reduce((s, v) => s + v, 0) / seven.length;
      })();
      const baseline = data.stats.avgRpm30d ?? data.spot.rpm ?? null;
      const forecastDirection = deriveForecastDirection(forecast7dRpm, baseline);
      const capacityOutlook = deriveCapacityOutlook(forecastDirection, forecast7dRpm, baseline);
      result = {
        ok: true,
        market: {
          source: "trac",
          band,
          rpm: { low: data.spot.rpmLow ?? null, mid: data.spot.rpm ?? null, high: data.spot.rpmHigh ?? null },
          contractRpm: data.contract.contractRpm ?? null,
          miles: data.spot.miles ?? null,
          confidence: data.spot.confidenceScore ?? null,
          loadCount: data.spot.totalLoadCount ?? null,
          avgRpm30d: data.stats.avgRpm30d ?? null,
          avgRpm90d: data.stats.avgRpm90d ?? null,
          forecast7dRpm,
          forecastDirection,
          capacityOutlook,
          originKma: oKma.kma,
          destKma: dKma.kma,
          equipment,
          fetchedAt: Date.now(),
        },
      };
    }
  } catch (err) {
    result = { ok: false, reason: (err as Error).message ?? "TRAC fetch error" };
  }
  tracCache.set(key, { fetchedAt: Date.now(), result });
  return result;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function eqMatchesFamily(a: string | null | undefined, want: string | null | undefined): boolean {
  if (!want || want.toUpperCase() === "ANY" || want.toUpperCase() === "ALL") return true;
  if (!a) return false;
  return toTracEquipment(a) === toTracEquipment(want);
}

/**
 * Aggregate load_fact traffic on the requested lane with tier-style
 * matching (exact city → same KMA market → same state). Joins the
 * carrier scorecard so each top carrier carries a Carrier Reliability
 * Score and last paid rate.
 */
export async function getLaneTraffic(
  orgId: string,
  pickupCity: string,
  pickupState: string,
  deliveryCity: string,
  deliveryState: string,
  equipmentRaw: string | null | undefined,
): Promise<LaneTraffic | null> {
  if (!pickupState || !deliveryState) return null;
  try {
    const rows = await db.select().from(loadFact).where(and(
      eq(loadFact.orgId, orgId),
      eq(loadFact.originState, pickupState),
      eq(loadFact.destinationState, deliveryState),
    ));
    const eqFiltered = rows.filter(r => eqMatchesFamily(r.equipmentType, equipmentRaw));
    if (eqFiltered.length === 0) return null;

    const oKma = cityToKma(pickupCity, pickupState)?.kma ?? null;
    const dKma = cityToKma(deliveryCity, deliveryState)?.kma ?? null;
    const pcLower = pickupCity.trim().toLowerCase();
    const dcLower = deliveryCity.trim().toLowerCase();

    const tierFor = (r: typeof eqFiltered[number]): "exact" | "same_market" | "same_state" => {
      const oc = (r.originCity ?? "").trim().toLowerCase();
      const dc = (r.destinationCity ?? "").trim().toLowerCase();
      if (pcLower && dcLower && oc === pcLower && dc === dcLower) return "exact";
      if (oKma && dKma) {
        const rOKma = r.originCity ? cityToKma(r.originCity, r.originState ?? "")?.kma : null;
        const rDKma = r.destinationCity ? cityToKma(r.destinationCity, r.destinationState ?? "")?.kma : null;
        if (rOKma === oKma && rDKma === dKma) return "same_market";
      }
      return "same_state";
    };

    const now = Date.now();
    const cutoff30 = now - 30 * 86_400_000;
    const cutoff90 = now - 90 * 86_400_000;

    let totalLoads = 0, loads30d = 0, loads90d = 0;
    let realized = 0, available = 0;
    let revenue = 0, cost = 0, margin = 0;
    const tierBreakdown = { exact: 0, sameMarket: 0, sameState: 0 };
    type CAgg = { loads: number; loads30d: number; loads90d: number; revenue: number; cost: number; margin: number; lastBuy: number | null; lastBuyAt: number };
    const carrierAgg = new Map<string, CAgg>();
    const carriersSet = new Set<string>();

    for (const r of eqFiltered) {
      const lc = r.loadCount ?? 1;
      totalLoads += lc;
      const t = r.lastSeenAt ? r.lastSeenAt.getTime() : 0;
      if (t >= cutoff30) loads30d += lc;
      if (t >= cutoff90) loads90d += lc;
      if (r.bucket === "realized") realized += lc;
      if (r.bucket === "available") available += lc;
      revenue += num(r.revenue);
      cost += num(r.cost);
      margin += num(r.margin);
      const tier = tierFor(r);
      if (tier === "exact") tierBreakdown.exact += lc;
      else if (tier === "same_market") tierBreakdown.sameMarket += lc;
      else tierBreakdown.sameState += lc;

      const cname = r.carrierName?.trim();
      if (cname) {
        carriersSet.add(cname);
        const cur: CAgg = carrierAgg.get(cname) ?? { loads: 0, loads30d: 0, loads90d: 0, revenue: 0, cost: 0, margin: 0, lastBuy: null, lastBuyAt: 0 };
        cur.loads += lc;
        if (t >= cutoff30) cur.loads30d += lc;
        if (t >= cutoff90) cur.loads90d += lc;
        cur.revenue += num(r.revenue);
        cur.cost += num(r.cost);
        cur.margin += num(r.margin);
        const cAmt = num(r.cost);
        if (cAmt > 0 && t > cur.lastBuyAt) { cur.lastBuy = cAmt / Math.max(1, lc); cur.lastBuyAt = t; }
        carrierAgg.set(cname, cur);
      }
    }

    const sortedNames = Array.from(carrierAgg.entries())
      .sort((a, b) => b[1].loads - a[1].loads)
      .slice(0, 5)
      .map(([n]) => n);

    // Reliability join — pull per-carrier scorecard rows for the equipment
    // family or the cross-equipment ALL rollup. Prefer eq-specific.
    const reliability = new Map<string, { score: number; tier: string }>();
    if (sortedNames.length > 0) {
      const eq3 = toTracEquipment(equipmentRaw);
      const sc = await db.select().from(carrierScorecardFact).where(and(
        eq(carrierScorecardFact.orgId, orgId),
        sql`${carrierScorecardFact.carrierName} = ANY(${sortedNames})`,
        or(eq(carrierScorecardFact.equipmentType, eq3), eq(carrierScorecardFact.equipmentType, "ALL")),
      ));
      for (const s of sc) {
        const k = s.carrierName;
        const prev = reliability.get(k);
        // Prefer eq-specific over ALL.
        if (!prev || s.equipmentType !== "ALL") {
          reliability.set(k, { score: s.performanceScore ?? 0, tier: s.tier ?? "new" });
        }
      }
    }

    const topCarriers: LaneTrafficCarrier[] = sortedNames.map(name => {
      const v = carrierAgg.get(name)!;
      const rel = reliability.get(name) ?? null;
      return {
        name,
        loads: v.loads,
        loads30d: v.loads30d,
        loads90d: v.loads90d,
        revenue: v.revenue,
        cost: v.cost,
        margin: v.margin,
        marginPct: v.revenue > 0 ? (v.margin / v.revenue) * 100 : 0,
        reliabilityScore: rel?.score ?? null,
        reliabilityTier: rel?.tier ?? null,
        lastBuyRate: v.lastBuy,
      };
    });

    return {
      totalLoads,
      loads30d,
      loads90d,
      realized,
      available,
      revenue,
      cost,
      margin,
      marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
      uniqueCarriers: carriersSet.size,
      tierBreakdown,
      topCarriers,
    };
  } catch (err) {
    console.warn("[spotMarketData] getLaneTraffic failed:", (err as Error).message);
    return null;
  }
}

/**
 * Build a Carrier Hub outreach list for the lane: carrier_lane_fit
 * left-joined with carrier_scorecard_fact (for performance signals)
 * and the org carriers rolodex (for contact info + presence flag).
 * Ranked by a composite of fit score and reliability so consistently
 * reliable carriers float above narrowly-better-fit unknowns.
 */
export async function getLaneCarriers(
  orgId: string,
  originState: string,
  destState: string,
  equipmentRaw: string | null | undefined,
): Promise<CarrierOutreachItem[]> {
  if (!originState || !destState) return [];
  try {
    const eq3 = toTracEquipment(equipmentRaw);
    const fits = await db.select().from(carrierLaneFit).where(and(
      eq(carrierLaneFit.orgId, orgId),
      eq(carrierLaneFit.originState, originState),
      eq(carrierLaneFit.destinationState, destState),
      or(eq(carrierLaneFit.equipmentType, eq3), eq(carrierLaneFit.equipmentType, "ALL")),
    )).orderBy(desc(carrierLaneFit.fitScore)).limit(40);

    if (fits.length === 0) return [];

    const names = Array.from(new Set(fits.map(f => f.carrierName).filter(Boolean)));
    const [scoreRows, rolodex] = await Promise.all([
      db.select().from(carrierScorecardFact).where(and(
        eq(carrierScorecardFact.orgId, orgId),
        sql`${carrierScorecardFact.carrierName} = ANY(${names})`,
        or(eq(carrierScorecardFact.equipmentType, eq3), eq(carrierScorecardFact.equipmentType, "ALL")),
      )),
      db.select().from(carriers).where(and(
        eq(carriers.orgId, orgId),
        sql`LOWER(${carriers.name}) = ANY(${names.map(n => n.toLowerCase())})`,
      )),
    ]);

    const scoreMap = new Map<string, typeof scoreRows[number]>();
    for (const s of scoreRows) {
      const key = `${s.carrierName.toLowerCase()}|${s.equipmentType}`;
      scoreMap.set(key, s);
    }
    const rolodexMap = new Map<string, typeof rolodex[number]>(
      rolodex.map(r => [r.name.toLowerCase(), r]),
    );

    const bestFit = new Map<string, typeof fits[number]>();
    for (const f of fits) {
      const k = f.carrierName.toLowerCase();
      const prev = bestFit.get(k);
      if (!prev) { bestFit.set(k, f); continue; }
      const prevSpec = prev.equipmentType !== "ALL";
      const curSpec = f.equipmentType !== "ALL";
      if (curSpec && !prevSpec) bestFit.set(k, f);
      else if (curSpec === prevSpec && f.fitScore > prev.fitScore) bestFit.set(k, f);
    }

    const items: CarrierOutreachItem[] = Array.from(bestFit.values())
      .map(f => {
        const k = f.carrierName.toLowerCase();
        const score = scoreMap.get(`${k}|${f.equipmentType}`) ?? scoreMap.get(`${k}|ALL`);
        const rod = rolodexMap.get(k);
        const perf = score?.performanceScore ?? 0;
        // Composite ranking: fit (0–100) weighted 0.6, reliability 0.4.
        const rankScore = f.fitScore * 0.6 + perf * 0.4;
        const presence: CarrierOutreachItem["presence"] = rod
          ? (perf >= 70 ? "active" : "known")
          : "cold";
        return {
          carrierId: rod?.id ?? null,
          name: f.carrierName,
          fitScore: f.fitScore,
          rankScore,
          evidenceTier: f.evidenceTier,
          exactLaneRuns: f.exactLaneRuns,
          nearbyRuns: f.nearbyRuns,
          loads90d: score?.loads90d ?? 0,
          marginPct: score ? num(score.marginPct) : 0,
          performanceScore: perf,
          tier: score?.tier ?? "new",
          doNotUse: score?.doNotUse ?? rod?.status === "do_not_use",
          primaryEmail: rod?.primaryEmail ?? null,
          phone: rod?.phone ?? null,
          inRolodex: !!rod,
          presence,
          reason: f.reason,
        };
      })
      // Final sort: composite rank desc, with do-not-use sunk to the bottom.
      .sort((a, b) => {
        if (a.doNotUse !== b.doNotUse) return a.doNotUse ? 1 : -1;
        return b.rankScore - a.rankScore;
      })
      .slice(0, 25);
    return items;
  } catch (err) {
    console.warn("[spotMarketData] getLaneCarriers failed:", (err as Error).message);
    return [];
  }
}

/**
 * Match a single corridor pattern for the lane. Heuristic: prefer
 * patterns whose origin/destination region text mentions the
 * pickup/delivery state (case-insensitive). Baseline patterns first.
 *
 * Org scoping mirrors `server/storage.ts:7367` — tenant rows OR rows
 * with `orgId IS NULL` (the seeded global baseline templates from
 * Task #203). This is the project's intentional shared-templates model.
 */
export async function getCorridorPattern(
  orgId: string,
  pickupState: string,
  deliveryState: string,
): Promise<CorridorPattern | null> {
  if (!pickupState || !deliveryState) return null;
  try {
    const ps = pickupState.toUpperCase();
    const ds = deliveryState.toUpperCase();
    const rows = await db.select().from(geographicLanePatterns).where(
      or(eq(geographicLanePatterns.orgId, orgId), sql`${geographicLanePatterns.orgId} IS NULL`),
    );
    const matches: { row: GeographicLanePattern; score: number }[] = [];
    for (const r of rows) {
      const o = (r.originRegion ?? "").toUpperCase();
      const d = (r.destinationRegion ?? "").toUpperCase();
      const corridor = (r.namedCorridor ?? "").toUpperCase();
      const blob = `${o} ${d} ${corridor}`;
      const oHit = o.includes(ps) || corridor.includes(ps);
      const dHit = d.includes(ds) || corridor.includes(ds);
      if (oHit && dHit) {
        let score = 10;
        if (o.includes(ps)) score += 5;
        if (d.includes(ds)) score += 5;
        if (r.isBaseline) score += 2;
        matches.push({ row: r, score });
      } else if (blob.includes(ps) && blob.includes(ds)) {
        matches.push({ row: r, score: r.isBaseline ? 3 : 1 });
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0].row;
    return {
      id: best.id,
      name: best.name,
      namedCorridor: best.namedCorridor,
      originRegion: best.originRegion,
      destinationRegion: best.destinationRegion,
      description: best.description,
      isBaseline: best.isBaseline ?? false,
    };
  } catch (err) {
    console.warn("[spotMarketData] getCorridorPattern failed:", (err as Error).message);
    return null;
  }
}
