/**
 * Customer Quotes — Pricing Recommendation engine.
 *
 * Combines:
 *   - TRAC market band (live) via `getLaneMarket`
 *   - Customer-specific win-rate elasticity (per price-position bin)
 *     via `getPricingIntelligence`
 *   - Per-equipment $/mile floor from `quote_pricing_settings`
 *
 * into three actionable tiers (aggressive / balanced / premium) each
 * carrying an estimated win probability, a sample-size badge, and a
 * floor-breach flag.  Falls back gracefully when TRAC or history is
 * sparse so the card always has something useful to show.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteOpportunities,
  quotePricingSettings,
  type QuoteOpportunity,
} from "@shared/schema";
import { getLaneMarket } from "./spotMarketData";
import { getPricingIntelligence, type PricingPriceBin } from "./customerQuotes";

export type TierName = "aggressive" | "balanced" | "premium";

export interface RecommendationTier {
  name: TierName;
  rate: number;
  estimatedWinProb: number;
  winProbSource: "history" | "default";
  sampleSize?: number;
  belowFloor: boolean;
  floorRate?: number;
  rationale: string;
}

export interface PricingRecommendation {
  available: boolean;
  reason?: string;
  marketBand?: { low: number; mid: number; high: number };
  bandSource?: "trac" | "history";
  miles?: number | null;
  equipment?: string;
  marginFloorRpm?: number;
  marginFloorRate?: number;
  tiers: RecommendationTier[];
  customerSampleSize: number;
  customerSweetSpot?: { label: string; winRate: number; sample: number };
}

const DEFAULT_WIN_PROB: Record<TierName, number> = {
  aggressive: 75,
  balanced: 55,
  premium: 30,
};

const POSITION_FOR_DEFAULT: Record<TierName, number> = {
  aggressive: -0.05,
  balanced: 0,
  premium: 0.08,
};

/**
 * Compute three tiers from a benchmark + optional TRAC band.
 * Pure function — exported for unit testing.
 */
export function buildTierRates(
  band: { low: number; mid: number; high: number } | null,
  benchmark: number | null,
): { tiers: Array<{ name: TierName; rate: number }>; mid: number } | null {
  if (band && band.low > 0 && band.mid > 0 && band.high > 0) {
    return {
      mid: band.mid,
      tiers: [
        { name: "aggressive", rate: Math.round(band.low) },
        { name: "balanced", rate: Math.round(band.mid) },
        { name: "premium", rate: Math.round(band.high) },
      ],
    };
  }
  if (benchmark && benchmark > 0) {
    return {
      mid: benchmark,
      tiers: [
        { name: "aggressive", rate: Math.round(benchmark * (1 + POSITION_FOR_DEFAULT.aggressive)) },
        { name: "balanced", rate: Math.round(benchmark * (1 + POSITION_FOR_DEFAULT.balanced)) },
        { name: "premium", rate: Math.round(benchmark * (1 + POSITION_FOR_DEFAULT.premium)) },
      ],
    };
  }
  return null;
}

/**
 * Look up the win-rate for a given rate against a benchmark using
 * pre-computed customer bins. Returns the matching bin or null.
 * Pure function — exported for unit testing.
 */
export function lookupBinForRate(
  rate: number,
  benchmark: number,
  bins: PricingPriceBin[],
): PricingPriceBin | null {
  if (!benchmark || benchmark <= 0) return null;
  const position = (rate - benchmark) / benchmark;
  for (const b of bins) {
    if (position >= b.lo && position < b.hi) return b;
  }
  return null;
}

/**
 * Decide the final win-prob for a tier: use the customer bin if it has
 * meaningful sample (>=2), otherwise fall back to the tier default.
 * Pure function — exported for unit testing.
 */
export function resolveWinProb(
  name: TierName,
  bin: PricingPriceBin | null,
): { winProb: number; source: "history" | "default"; sampleSize?: number } {
  if (bin && bin.total >= 2) {
    return { winProb: Math.round(bin.winRate), source: "history", sampleSize: bin.total };
  }
  return { winProb: DEFAULT_WIN_PROB[name], source: "default" };
}

/**
 * Floor evaluation. Returns { belowFloor, floorRate } where floorRate is
 * the dollar floor (RPM × miles) when computable. Pure function.
 */
export function evaluateFloor(
  rate: number,
  miles: number | null | undefined,
  floorRpm: number | null | undefined,
): { belowFloor: boolean; floorRate?: number } {
  if (!floorRpm || floorRpm <= 0) return { belowFloor: false };
  if (!miles || miles <= 0) return { belowFloor: false };
  const floorRate = Math.round(floorRpm * miles);
  return { belowFloor: rate < floorRate, floorRate };
}

function tierRationale(
  name: TierName,
  band: { low: number; mid: number; high: number } | null,
  benchmark: number | null,
  source: "history" | "default",
  sample?: number,
): string {
  if (source === "history" && sample) {
    return `${sample} prior decided quote${sample === 1 ? "" : "s"} at this price position`;
  }
  if (band) {
    if (name === "aggressive") return "TRAC market low — aim to win";
    if (name === "balanced") return "TRAC market mid — balanced";
    return "TRAC market high — premium positioning";
  }
  if (benchmark) {
    if (name === "aggressive") return "5% below stored benchmark";
    if (name === "balanced") return "At stored benchmark";
    return "8% above stored benchmark";
  }
  return "";
}

/**
 * Returns the per-equipment margin floor map for an org. Empty object
 * when none configured.
 */
export async function getMarginFloors(orgId: string): Promise<Record<string, number>> {
  const [row] = await db.select().from(quotePricingSettings)
    .where(eq(quotePricingSettings.organizationId, orgId)).limit(1);
  return (row?.marginFloorsRpm ?? {}) as Record<string, number>;
}

/**
 * Upserts the per-equipment $/mile floor map for an org. Validates
 * each value is a positive finite number; silently drops invalid keys.
 */
export async function setMarginFloors(
  orgId: string,
  floors: Record<string, number>,
  userId: string,
): Promise<Record<string, number>> {
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(floors ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 100) {
      cleaned[String(k).trim()] = Math.round(n * 100) / 100;
    }
  }
  await db.insert(quotePricingSettings)
    .values({ organizationId: orgId, marginFloorsRpm: cleaned, updatedById: userId })
    .onConflictDoUpdate({
      target: quotePricingSettings.organizationId,
      set: { marginFloorsRpm: cleaned, updatedById: userId, updatedAt: new Date() },
    });
  return cleaned;
}

function pickFloor(floors: Record<string, number>, equipment: string | null | undefined): number | undefined {
  if (!equipment) return undefined;
  const e = equipment.trim();
  if (!e) return undefined;
  // Try exact, lowercased, and uppercased keys for tolerance.
  if (floors[e] != null) return floors[e];
  const lower = e.toLowerCase();
  for (const [k, v] of Object.entries(floors)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Main entry — compute the recommendation for a specific quote.
 */
export async function getPricingRecommendation(
  orgId: string,
  quoteId: string,
): Promise<PricingRecommendation> {
  const [opp] = await db.select().from(quoteOpportunities)
    .where(and(eq(quoteOpportunities.organizationId, orgId), eq(quoteOpportunities.id, quoteId)))
    .limit(1);
  if (!opp) {
    return { available: false, reason: "Quote not found", tiers: [], customerSampleSize: 0 };
  }
  return buildRecommendationForOpp(orgId, opp);
}

async function buildRecommendationForOpp(
  orgId: string,
  opp: QuoteOpportunity,
): Promise<PricingRecommendation> {
  const [marketRes, intel, floors] = await Promise.all([
    getLaneMarket(opp.originCity, opp.originState, opp.destCity, opp.destState, opp.equipment),
    getPricingIntelligence(orgId, {
      customerId: opp.customerId,
      originCity: opp.originCity,
      originState: opp.originState,
      destCity: opp.destCity,
      destState: opp.destState,
      equipment: opp.equipment,
      laneGroupId: opp.laneGroupId ?? undefined,
    }),
    getMarginFloors(orgId),
  ]);

  const band = (marketRes.ok && marketRes.market.band)
    ? marketRes.market.band
    : null;
  const miles = marketRes.ok ? marketRes.market.miles ?? null : null;

  const benchmark = intel.sonarBenchmark;
  const built = buildTierRates(band, benchmark);
  const floorRpm = pickFloor(floors, opp.equipment);

  if (!built) {
    return {
      available: false,
      reason: !band && !benchmark
        ? "No TRAC band or stored benchmark for this lane yet."
        : "Unable to compute tier rates.",
      tiers: [],
      customerSampleSize: intel.decidedSample,
      miles,
      equipment: opp.equipment,
      marginFloorRpm: floorRpm,
    };
  }

  // Bins are computed against `intel.sonarBenchmark` in getPricingIntelligence,
  // so win-prob lookups must use the same basis — NOT the TRAC mid (which can
  // diverge significantly from the historical benchmark).  When sonarBenchmark
  // is unavailable, lookupBinForRate returns null and we fall back to defaults.
  const tiers: RecommendationTier[] = built.tiers.map(({ name, rate }) => {
    const bin = lookupBinForRate(rate, benchmark ?? 0, intel.bins);
    const wp = resolveWinProb(name, bin);
    const floorEval = evaluateFloor(rate, miles ?? 0, floorRpm);
    return {
      name,
      rate,
      estimatedWinProb: wp.winProb,
      winProbSource: wp.source,
      sampleSize: wp.sampleSize,
      belowFloor: floorEval.belowFloor,
      floorRate: floorEval.floorRate,
      rationale: tierRationale(name, band, benchmark, wp.source, wp.sampleSize),
    };
  });

  // Sweet-spot = best bin with sample >= 2 (mirrors getPricingIntelligence)
  let sweetSpot: PricingRecommendation["customerSweetSpot"];
  const candidates = intel.bins.filter(b => b.total >= 2);
  if (candidates.length > 0) {
    const best = [...candidates].sort((a, b) => b.winRate - a.winRate)[0];
    sweetSpot = { label: best.label, winRate: Math.round(best.winRate), sample: best.total };
  }

  return {
    available: true,
    marketBand: band ? { low: band.low, mid: band.mid, high: band.high } : undefined,
    bandSource: band ? "trac" : "history",
    miles,
    equipment: opp.equipment,
    marginFloorRpm: floorRpm,
    marginFloorRate: floorRpm && miles ? Math.round(floorRpm * miles) : undefined,
    tiers,
    customerSampleSize: intel.decidedSample,
    customerSweetSpot: sweetSpot,
  };
}
