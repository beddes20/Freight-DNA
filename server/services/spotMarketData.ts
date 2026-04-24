import { and, eq, sql, desc, ilike, or } from "drizzle-orm";
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
  topCarriers: LaneTrafficCarrier[];
};

export type CarrierOutreachItem = {
  carrierId: string | null;
  name: string;
  fitScore: number;
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

const TRAC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const tracCache = new Map<string, { fetchedAt: number; result: LaneMarketResult }>();

function tracKey(originKma: string, destKma: string, equipment: string): string {
  return `${originKma}|${destKma}|${equipment}`;
}

/**
 * Fetch TRAC market band for a lane. Cached 1hr in-memory per
 * (originKMA, destKMA, equipment). Degrades gracefully when KMAs
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
  if (cached && Date.now() - cached.fetchedAt < TRAC_CACHE_TTL_MS) {
    return cached.result;
  }
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
 * Aggregate load_fact traffic on (originState, destState[, equipment]).
 * Used to show recent lane-level realized and available counts plus
 * the top carriers actually moving freight on this lane.
 */
export async function getLaneTraffic(
  orgId: string,
  originState: string,
  destState: string,
  equipmentRaw: string | null | undefined,
): Promise<LaneTraffic | null> {
  if (!originState || !destState) return null;
  try {
    const rows = await db.select().from(loadFact).where(and(
      eq(loadFact.orgId, orgId),
      eq(loadFact.originState, originState),
      eq(loadFact.destinationState, destState),
    ));
    const eqFiltered = rows.filter(r => eqMatchesFamily(r.equipmentType, equipmentRaw));
    if (eqFiltered.length === 0) return null;

    const now = Date.now();
    const cutoff30 = now - 30 * 86_400_000;
    const cutoff90 = now - 90 * 86_400_000;
    const seenAt = (r: typeof eqFiltered[number]): number => {
      const t = r.lastSeenAt ? r.lastSeenAt.getTime() : 0;
      return t;
    };

    let totalLoads = 0, loads30d = 0, loads90d = 0;
    let realized = 0, available = 0;
    let revenue = 0, cost = 0, margin = 0;
    const carrierAgg = new Map<string, { loads: number; loads30d: number; loads90d: number; revenue: number; cost: number; margin: number }>();
    const carriersSet = new Set<string>();

    for (const r of eqFiltered) {
      const lc = r.loadCount ?? 1;
      totalLoads += lc;
      const t = seenAt(r);
      if (t >= cutoff30) loads30d += lc;
      if (t >= cutoff90) loads90d += lc;
      if (r.bucket === "realized") realized += lc;
      if (r.bucket === "available") available += lc;
      revenue += num(r.revenue);
      cost += num(r.cost);
      margin += num(r.margin);
      const cname = r.carrierName?.trim();
      if (cname) {
        carriersSet.add(cname);
        const cur = carrierAgg.get(cname) ?? { loads: 0, loads30d: 0, loads90d: 0, revenue: 0, cost: 0, margin: 0 };
        cur.loads += lc;
        if (t >= cutoff30) cur.loads30d += lc;
        if (t >= cutoff90) cur.loads90d += lc;
        cur.revenue += num(r.revenue);
        cur.cost += num(r.cost);
        cur.margin += num(r.margin);
        carrierAgg.set(cname, cur);
      }
    }

    const topCarriers: LaneTrafficCarrier[] = Array.from(carrierAgg.entries())
      .sort((a, b) => b[1].loads - a[1].loads)
      .slice(0, 3)
      .map(([name, v]) => ({
        name,
        loads: v.loads,
        loads30d: v.loads30d,
        loads90d: v.loads90d,
        revenue: v.revenue,
        cost: v.cost,
        margin: v.margin,
        marginPct: v.revenue > 0 ? (v.margin / v.revenue) * 100 : 0,
      }));

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
    // Pull lane-fit rows for either the specific equipment or the cross-equipment ALL rollup.
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

    // De-dup by carrier name, prefer equipment-specific fit over ALL.
    const bestFit = new Map<string, typeof fits[number]>();
    for (const f of fits) {
      const k = f.carrierName.toLowerCase();
      const prev = bestFit.get(k);
      if (!prev) { bestFit.set(k, f); continue; }
      // Prefer equipment-specific over ALL; if tied, prefer higher fitScore.
      const prevSpec = prev.equipmentType !== "ALL";
      const curSpec = f.equipmentType !== "ALL";
      if (curSpec && !prevSpec) bestFit.set(k, f);
      else if (curSpec === prevSpec && f.fitScore > prev.fitScore) bestFit.set(k, f);
    }

    const items: CarrierOutreachItem[] = Array.from(bestFit.values())
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 25)
      .map(f => {
        const k = f.carrierName.toLowerCase();
        const score = scoreMap.get(`${k}|${f.equipmentType}`) ?? scoreMap.get(`${k}|ALL`);
        const rod = rolodexMap.get(k);
        return {
          carrierId: rod?.id ?? null,
          name: f.carrierName,
          fitScore: f.fitScore,
          evidenceTier: f.evidenceTier,
          exactLaneRuns: f.exactLaneRuns,
          nearbyRuns: f.nearbyRuns,
          loads90d: score?.loads90d ?? 0,
          marginPct: score ? num(score.marginPct) : 0,
          performanceScore: score?.performanceScore ?? 0,
          tier: score?.tier ?? "new",
          doNotUse: score?.doNotUse ?? rod?.status === "do_not_use",
          primaryEmail: rod?.primaryEmail ?? null,
          phone: rod?.phone ?? null,
          inRolodex: !!rod,
          reason: f.reason,
        };
      });
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
