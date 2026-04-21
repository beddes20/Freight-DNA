/**
 * Carrier recommendation engine (Task #369).
 *
 * For a given Available load (load_fact row), produces a ranked list of
 * candidate carriers blending three signals:
 *   - performance_score from carrier_scorecard_fact (org's executed truth)
 *   - fit_score from scoreCarrierLaneFit (lane/equipment evidence)
 *   - pricing_confidence from getBlendedRate (Sonar TRAC + history + customer)
 *
 * Hard exclusions:
 *   - carriers.status = 'do_not_use' (mirrored to scorecard.do_not_use)
 *   - carriers tagged 'do_not_use' or 'no_use'
 *   - carriers with no fit AND no performance signal (cold strangers)
 *
 * Per-candidate enrichment (persisted on each row):
 *   - lastUsedDate: most recent realized pickup_date for this carrier
 *   - avgHistoricalBuyRpm: cost per mile across all realized loads
 *   - expectedMarginLow/High: margin band centered on suggested sell
 *   - coverageUrgency: red | yellow | green based on pickup proximity
 *
 * Sparse-signal fallback trace is captured in `rationale.fallbackTrace` so
 * surfaces can show "we leaned on state-pair history" when the exact lane is
 * thin.
 */

import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { db } from "./storage";
import {
  loadFact,
  carrierScorecardFact,
  carriers as carriersTbl,
  carrierRecommendation,
  type InsertCarrierRecommendation,
} from "@shared/schema";
import { scoreCarrierLaneFit, upsertCarrierLaneFit, type ScorecardSignal } from "./carrierLaneFitService";
import { getBlendedRate, type BlendedRate } from "./pricingBlendService";

export interface RecommendationCandidate {
  rank: number;
  carrierName: string;
  totalScore: number;
  fitScore: number;
  performanceScore: number;
  targetBuyRpm: number | null;
  pricingConfidence: BlendedRate["confidence"];
  lastUsedDate: string | null;
  avgHistoricalBuyRpm: number | null;
  expectedMarginPct: { low: number; high: number } | null;
  coverageUrgency: "red" | "yellow" | "green";
  reason: string;
  rationale: {
    fit: { tier: string; reason: string };
    pricing: BlendedRate;
    fallbackTrace: string[];
    scorecard: { tier: string; loads: number; marginPct: number; onTimePct: number | null; doNotUse: boolean } | null;
  };
}

export interface RecommendationResult {
  loadFactId: string;
  orderId: string;
  origin: { city: string | null; state: string | null };
  destination: { city: string | null; state: string | null };
  equipmentType: string | null;
  customerName: string | null;
  candidates: RecommendationCandidate[];
  pricing: BlendedRate;
  /** Carriers explicitly excluded from candidates, with the recorded reason. */
  exclusions: Array<{ carrierName: string; reason: string }>;
  generatedAt: string;
}

/** Pure helper, exported for testing. Pickup within 24h = red, 72h = yellow. */
export function computeUrgency(pickupDate: string | null, now: Date = new Date()): "red" | "yellow" | "green" {
  if (!pickupDate) return "green";
  const pickup = new Date(pickupDate);
  const hours = (pickup.getTime() - now.getTime()) / 3600000;
  if (hours <= 24) return "red";
  if (hours <= 72) return "yellow";
  return "green";
}

/** Pure ranker, exported for snapshot testing. */
export interface RankerInput {
  carrierName: string;
  fitScore: number;
  evidenceTier: "exact" | "nearby" | "region" | "none";
  performanceScore: number;
  loads: number;
  isDoNotUse: boolean;
}
export function rankCandidates(items: RankerInput[], limit = 5): RankerInput[] {
  type Scored = RankerInput & { _total: number };
  const scored: Scored[] = items
    .filter(i => !i.isDoNotUse)
    .filter(i => !(i.evidenceTier === "none" && i.performanceScore === 0))
    .map(i => ({
      ...i,
      _total: i.loads >= 3
        ? Math.round(0.55 * i.fitScore + 0.45 * i.performanceScore)
        : Math.round(0.75 * i.fitScore + 0.25 * i.performanceScore),
    }));
  scored.sort((a, b) => b._total - a._total || b.fitScore - a.fitScore);
  return scored.slice(0, limit).map(({ _total, ...rest }) => rest);
}

export async function recommendCarriersForLoad(orgId: string, loadFactId: string, opts: { limit?: number } = {}): Promise<RecommendationResult> {
  const limit = Math.min(25, Math.max(1, opts.limit ?? 5));
  const [load] = await db.select().from(loadFact).where(and(eq(loadFact.orgId, orgId), eq(loadFact.id, loadFactId))).limit(1);
  if (!load) throw new Error(`Load not found for org ${orgId}: ${loadFactId}`);

  const originState = (load.originState ?? "").toUpperCase();
  const destState = (load.destinationState ?? "").toUpperCase();
  const equip = load.equipmentType ?? null;
  const customerName = load.customerName ?? null;
  const urgency = computeUrgency(load.pickupDate);

  const pricing = await getBlendedRate({
    orgId,
    origin: load.originCity ?? originState,
    destination: load.destinationCity ?? destState,
    originState: originState || null,
    destinationState: destState || null,
    equipmentType: equip,
    customerName,
  });

  // Sparse-signal fallback trace describes which legs we tried.
  const fallbackTrace: string[] = [];
  if (pricing.legs.history) fallbackTrace.push(`history:${pricing.historyFallbackTier}`);
  else fallbackTrace.push("history:none");
  fallbackTrace.push(`sonar:${pricing.legs.sonar.source}`);
  if (pricing.sonarWeightAutoBumped) fallbackTrace.push("sonar_weight_auto_bumped");

  if (!originState || !destState) {
    return {
      loadFactId,
      orderId: load.orderId,
      origin: { city: load.originCity, state: load.originState },
      destination: { city: load.destinationCity, state: load.destinationState },
      equipmentType: equip,
      customerName,
      candidates: [],
      pricing,
      exclusions: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const dnuRows = await db.select({ name: carriersTbl.name, status: carriersTbl.status, tags: carriersTbl.tags })
    .from(carriersTbl)
    .where(eq(carriersTbl.orgId, orgId));
  const dnuMap = new Map<string, string>();
  for (const c of dnuRows) {
    const tags = (c.tags ?? []) as string[];
    if (c.status === "do_not_use") dnuMap.set(c.name.trim().toLowerCase(), `carriers.status=do_not_use (${c.name})`);
    else if (tags.some(t => t === "do_not_use" || t === "no_use")) {
      const matched = tags.find(t => t === "do_not_use" || t === "no_use");
      dnuMap.set(c.name.trim().toLowerCase(), `carrier tag '${matched}' (${c.name})`);
    }
  }
  const exclusions: Array<{ carrierName: string; reason: string }> = [];

  // Wide net: top scorecards + carriers with realized runs on this lane.
  const topByPerformance = await db.select().from(carrierScorecardFact)
    .where(and(eq(carrierScorecardFact.orgId, orgId), eq(carrierScorecardFact.equipmentType, "ALL")))
    .orderBy(desc(carrierScorecardFact.performanceScore), desc(carrierScorecardFact.loads))
    .limit(80);
  const exactLaneCarriers = await db.execute<{ carrier_name: string }>(sql`
    SELECT DISTINCT carrier_name FROM load_fact
    WHERE org_id = ${orgId}
      AND (LOWER(COALESCE(move_status,'')) LIKE '%deliver%' OR bucket = 'realized')
      AND origin_state = ${originState} AND destination_state = ${destState}
      AND carrier_name IS NOT NULL AND carrier_name <> ''
    LIMIT 50
  `);

  const candidateNames = new Set<string>();
  for (const c of topByPerformance) candidateNames.add(c.carrierName);
  for (const r of exactLaneCarriers.rows as Array<Record<string, unknown>>) {
    if (r.carrier_name) candidateNames.add(String(r.carrier_name));
  }

  const scored: RecommendationCandidate[] = [];
  for (const name of candidateNames) {
    const dnuReason = dnuMap.get(name.trim().toLowerCase());
    if (dnuReason) {
      exclusions.push({ carrierName: name, reason: dnuReason });
      continue;
    }
    const perf = topByPerformance.find(c => c.carrierName === name);
    const performanceScore = perf?.performanceScore ?? 0;
    const loads = perf?.loads ?? 0;
    const marginPct = perf ? Number(perf.marginPct) || 0 : 0;
    const onTimePct = perf?.onTimePct != null ? Number(perf.onTimePct) : null;
    const tier = perf?.tier ?? "new";
    const lastUsedDate = perf?.lastLoadDate ?? null;
    const avgHistBuy = perf?.avgRpm != null ? Number(perf.avgRpm) : null;
    const daysSinceLastLoad = lastUsedDate
      ? Math.floor((Date.now() - new Date(lastUsedDate).getTime()) / 86400000)
      : null;

    const scorecardSignal: ScorecardSignal | null = perf
      ? { onTimePct, marginPct, daysSinceLastLoad }
      : null;
    const fit = await scoreCarrierLaneFit({
      orgId, carrierName: name, originState, destinationState: destState,
      equipmentType: equip, customerName, scorecardSignal,
    });
    upsertCarrierLaneFit({ orgId, carrierName: name, originState, destinationState: destState, equipmentType: equip }, fit).catch(() => {});

    if (fit.evidenceTier === "none" && performanceScore === 0) {
      exclusions.push({ carrierName: name, reason: "cold_stranger:no fit evidence and no performance signal" });
      continue;
    }

    const totalScore = loads >= 3
      ? Math.round(0.55 * fit.fitScore + 0.45 * performanceScore)
      : Math.round(0.75 * fit.fitScore + 0.25 * performanceScore);

    scored.push({
      rank: 0,
      carrierName: name,
      totalScore,
      fitScore: fit.fitScore,
      performanceScore,
      targetBuyRpm: pricing.targetBuyRpm,
      pricingConfidence: pricing.confidence,
      lastUsedDate,
      avgHistoricalBuyRpm: avgHistBuy,
      expectedMarginPct: pricing.expectedMarginPct,
      coverageUrgency: urgency,
      reason: `${fit.reason} Performance ${performanceScore}/100 (tier ${tier}, ${loads} loads${onTimePct !== null ? `, ${onTimePct.toFixed(0)}% OT` : ""}).`,
      rationale: {
        fit: { tier: fit.evidenceTier, reason: fit.reason },
        pricing,
        fallbackTrace,
        scorecard: perf ? { tier, loads, marginPct, onTimePct, doNotUse: perf.doNotUse } : null,
      },
    });
  }

  scored.sort((a, b) => b.totalScore - a.totalScore || b.fitScore - a.fitScore);
  const topN = scored.slice(0, limit).map((c, i) => {
    // Surface exclusions on rank=1's rationale so any caller reading a single
    // row can see who was filtered out and why.
    if (i === 0 && exclusions.length > 0) {
      return {
        ...c, rank: i + 1,
        rationale: { ...c.rationale, exclusions },
      };
    }
    return { ...c, rank: i + 1 };
  });

  await db.transaction(async (tx) => {
    await tx.delete(carrierRecommendation).where(eq(carrierRecommendation.loadFactId, loadFactId));
    if (topN.length > 0) {
      const rows: InsertCarrierRecommendation[] = topN.map(c => ({
        orgId,
        loadFactId,
        rank: c.rank,
        carrierName: c.carrierName,
        totalScore: c.totalScore,
        fitScore: c.fitScore,
        performanceScore: c.performanceScore,
        targetBuyRpm: c.targetBuyRpm !== null ? c.targetBuyRpm.toFixed(4) : null,
        pricingConfidence: c.pricingConfidence,
        lastUsedDate: c.lastUsedDate,
        avgHistoricalBuyRpm: c.avgHistoricalBuyRpm !== null ? c.avgHistoricalBuyRpm.toFixed(4) : null,
        expectedMarginLowPct: c.expectedMarginPct ? c.expectedMarginPct.low.toFixed(2) : null,
        expectedMarginHighPct: c.expectedMarginPct ? c.expectedMarginPct.high.toFixed(2) : null,
        coverageUrgency: c.coverageUrgency,
        reason: c.reason,
        rationale: c.rationale,
      }));
      await tx.insert(carrierRecommendation).values(rows);
    }
  });

  return {
    loadFactId,
    orderId: load.orderId,
    origin: { city: load.originCity, state: load.originState },
    destination: { city: load.destinationCity, state: load.destinationState },
    equipmentType: equip,
    customerName,
    candidates: topN,
    pricing,
    exclusions,
    generatedAt: new Date().toISOString(),
  };
}

export async function recomputeRecommendationsForOrg(orgId: string, opts: { maxLoads?: number } = {}): Promise<{ processed: number; failed: number }> {
  const maxLoads = Math.min(2000, opts.maxLoads ?? 500);
  const loads = await db.select({ id: loadFact.id }).from(loadFact)
    .where(and(eq(loadFact.orgId, orgId), inArray(loadFact.bucket, ["available", "unknown"])))
    .limit(maxLoads);
  let processed = 0;
  let failed = 0;
  for (const row of loads) {
    try {
      await recommendCarriersForLoad(orgId, row.id, { limit: 5 });
      processed += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[carrier-rec] failed for load ${row.id}: ${(err as Error).message}`);
    }
  }
  return { processed, failed };
}
