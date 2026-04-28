/**
 * Pricing blend service (Task #369).
 *
 * Combines two independent rate signals into a single "what should we pay
 * the carrier" number:
 *   1. Sonar TRAC market rate per mile
 *   2. The org's own realized cost-per-mile history on the same lane
 *      (with customer + trailer specificity when available)
 *
 * Default weight is 65% Sonar / 35% history — surfaces the live market when
 * spot is moving fast, but anchors to the org's executed truth so the engine
 * doesn't quote rates the desk would never pay.
 *
 * Per-customer overrides: when an admin has saved an override for the load's
 * customer, both the Sonar/history weight and the minHistoryLoads floor are
 * substituted before the auto-bump kicks in.
 *
 * Sparse-data fallback chain (drives `historyFallbackTier`, configurable via
 * blend.fallbackOrder):
 *   lane_customer_trailer → lane_customer → lane_trailer → lane
 *   → nearby_lane → state_pair → trailer_benchmark → none
 *
 * Sonar-weight auto-bump: when the matched history leg has fewer than
 * `sparseHistoryMultiplier × minHistoryLoads` loads, the Sonar weight is
 * bumped by `sonarSparseBumpAmount` (capped at 0.95) so live market dominates
 * when our own data is thin. Both knobs are admin-configurable.
 *
 * Refusal threshold: when both legs are absent AND realized history loads
 * < `thresholds.refusalMinLoads`, the service returns no rate (confidence
 * "none") so the UI can refuse to suggest one.
 *
 * Confidence semantics (driven by thresholds.confidenceChips):
 *   - high: both legs present, agree within `highConfidenceSpreadPct`,
 *           and history loads ≥ greenMinLoads
 *   - medium: both legs present but spread wider OR loads ≥ yellowMinLoads
 *   - low: only one leg trustworthy (Sonar-only or history-only)
 *   - none: neither leg has a usable rate → recommendation marks no_pricing
 */

import { getBlendConfig, getThresholds, resolveBlendForCustomer, type FallbackTier } from "./carrierIntelligenceSettings";
import { getSonarLanePricing, type SonarLanePricing } from "./sonarTracPricingClient";
import { getLaneRateHistory } from "./laneRateHistoryService";

export interface BlendedRate {
  /** Final blended target buy rate, $/mi. Null when neither leg has data. */
  targetBuyRpm: number | null;
  /** Same value but with the rep-margin guard applied (suggested ask). */
  suggestedSellRpm: number | null;
  /** Margin band low/high in percent points around the buy rate. */
  expectedMarginPct: { low: number; high: number } | null;
  confidence: "high" | "medium" | "low" | "none";
  legs: {
    sonar: SonarLanePricing;
    history: {
      avgCostPerMile: number | null;
      medianCostPerMile: number | null;
      loads: number;
      loads30d: number;
      loads60d: number;
      loads90d: number;
      avgCost30d: number | null;
      avgCost60d: number | null;
      avgCost90d: number | null;
      fallbackTier: FallbackTier;
    } | null;
  };
  /** Which fallback leg the history came from (or "none"). */
  historyFallbackTier: FallbackTier | "none";
  weights: { sonar: number; history: number };
  /** True when we auto-bumped Sonar weight because our history was sparse. */
  sonarWeightAutoBumped: boolean;
  /** True when refusal threshold tripped (we explicitly refused to quote). */
  refusedBelowThreshold: boolean;
  reason: string;
}

export interface BlendInput {
  orgId: string;
  origin: string;
  destination: string;
  originState: string | null;
  destinationState: string | null;
  equipmentType: string | null;
  /** Customer dimension — enables (lane, customer) history specificity + per-customer override. */
  customerName?: string | null;
  /** Rep-side gross margin guard, default 12%. */
  marginPctGuard?: number;
}

export async function getBlendedRate(input: BlendInput): Promise<BlendedRate> {
  return computeBlendedRate(input);
}

async function computeBlendedRate(input: BlendInput): Promise<BlendedRate> {
  const { orgId, origin, destination, originState, destinationState, equipmentType, customerName } = input;
  const baseCfg = await getBlendConfig(orgId);
  const cfg = resolveBlendForCustomer(baseCfg, customerName);
  const thresholds = await getThresholds(orgId);
  const equip = equipmentType ?? "VAN";
  const marginGuard = input.marginPctGuard ?? 0.12;

  const [sonar, history] = await Promise.all([
    getSonarLanePricing(origin, destination, equip),
    originState && destinationState
      ? getLaneRateHistory(orgId, originState, destinationState, equipmentType, customerName ?? null, cfg.fallbackOrder)
      : Promise.resolve(null),
  ]);

  const sonarRpm = sonar.ratePerMile;
  const histRpm = history?.medianCostPerMile != null ? Number(history.medianCostPerMile)
                : history?.avgCostPerMile != null ? Number(history.avgCostPerMile) : null;
  const histLoads = history?.loads ?? 0;
  const histTrustworthy = histLoads >= cfg.minHistoryLoads && histRpm !== null && histRpm > 0;

  const sparse = histTrustworthy && histLoads < cfg.minHistoryLoads * cfg.sparseHistoryMultiplier;
  const bumpedWeight = Math.min(0.95, sparse ? cfg.sonarWeight + cfg.sonarSparseBumpAmount : cfg.sonarWeight);
  const sonarWeightAutoBumped = sparse && bumpedWeight !== cfg.sonarWeight;

  let target: number | null = null;
  let weights = { sonar: 0, history: 0 };
  let confidence: BlendedRate["confidence"] = "none";
  let reason = "";
  let refusedBelowThreshold = false;

  if (sonarRpm !== null && histTrustworthy) {
    weights = { sonar: bumpedWeight, history: 1 - bumpedWeight };
    target = sonarRpm * weights.sonar + histRpm! * weights.history;
    const spread = Math.abs(sonarRpm - histRpm!) / Math.max(0.01, (sonarRpm + histRpm!) / 2) * 100;
    const chips = thresholds.confidenceChips;
    if (spread <= chips.greenMaxSpreadPct && histLoads >= chips.greenMinLoads) confidence = "high";
    else if (histLoads >= chips.yellowMinLoads) confidence = "medium";
    else confidence = "low";
    reason = `Blended ${(weights.sonar * 100).toFixed(0)}/${(weights.history * 100).toFixed(0)} Sonar/history (${histLoads} loads, ${history!.fallbackTier})${sonarWeightAutoBumped ? " — Sonar weight auto-bumped due to sparse history" : ""}.`;
  } else if (sonarRpm !== null) {
    weights = { sonar: 1, history: 0 };
    target = sonarRpm;
    confidence = "low";
    reason = histLoads > 0
      ? `Sonar only — history under ${cfg.minHistoryLoads}-load floor (have ${histLoads}).`
      : "Sonar only — no realized history on this lane.";
  } else if (histTrustworthy) {
    weights = { sonar: 0, history: 1 };
    target = histRpm!;
    confidence = "low";
    reason = `History only — Sonar ${sonar.source === "unavailable" ? "unavailable" : "stale"} (${histLoads} loads, ${history!.fallbackTier}).`;
  } else {
    confidence = "none";
    if (histLoads < thresholds.refusalMinLoads && sonar.source === "unavailable") {
      refusedBelowThreshold = true;
      reason = `Refusing to quote — Sonar unavailable and only ${histLoads} realized load(s) (need ≥ ${thresholds.refusalMinLoads}).`;
    } else {
      reason = sonar.source === "unavailable"
        ? "No pricing — Sonar unavailable and lane has no realized history."
        : "No pricing — Sonar returned no rate and lane has no realized history.";
    }
  }

  const targetRounded = target !== null ? Math.round(target * 100) / 100 : null;
  const suggestedSell = targetRounded !== null
    ? Math.round((targetRounded / Math.max(0.01, 1 - marginGuard)) * 100) / 100
    : null;

  let expectedMarginPct: { low: number; high: number } | null = null;
  if (suggestedSell !== null && targetRounded !== null) {
    const center = ((suggestedSell - targetRounded) / suggestedSell) * 100;
    const spreadPts = confidence === "high" ? 2 : confidence === "medium" ? 5 : 8;
    expectedMarginPct = {
      low: Math.round((center - spreadPts) * 10) / 10,
      high: Math.round((center + spreadPts) * 10) / 10,
    };
  }

  return {
    targetBuyRpm: targetRounded,
    suggestedSellRpm: suggestedSell,
    expectedMarginPct,
    confidence,
    legs: {
      sonar,
      history: history ? {
        avgCostPerMile: history.avgCostPerMile != null ? Number(history.avgCostPerMile) : null,
        medianCostPerMile: history.medianCostPerMile != null ? Number(history.medianCostPerMile) : null,
        loads: history.loads,
        loads30d: history.loads30d,
        loads60d: history.loads60d,
        loads90d: history.loads90d,
        avgCost30d: history.avgCost30d != null ? Number(history.avgCost30d) : null,
        avgCost60d: history.avgCost60d != null ? Number(history.avgCost60d) : null,
        avgCost90d: history.avgCost90d != null ? Number(history.avgCost90d) : null,
        fallbackTier: history.fallbackTier,
      } : null,
    },
    historyFallbackTier: history?.fallbackTier ?? "none",
    weights,
    sonarWeightAutoBumped,
    refusedBelowThreshold,
    reason,
  };
}

/**
 * Short-TTL in-process cache in front of `getBlendedRate` (Task #819).
 *
 * Why: the Available Freight cockpit calls the pricing service once per row,
 * and on a typical page many rows share the same lane. The blend itself
 * round-trips Sonar TRAC + the lane_rate_history table, which dominates the
 * cockpit's response time. Caching by the inputs that actually drive the
 * blend collapses dozens of pricing calls down to one per unique lane key
 * within a 90-second window without changing what the user sees (Sonar's
 * own cache TTL is 6h; lane history is recomputed on a slower cadence).
 *
 * Properties:
 *   - LRU-bounded so a long-running process can't grow the map unbounded.
 *   - Successful results AND "refused/none" outcomes are cached so the second
 *     hit on a cold lane is just as cheap as the second hit on a hot one.
 *     Thrown errors are NOT cached — callers should re-attempt and the
 *     existing try/catch in the cockpit row builder will swallow them as
 *     `{ rate: null, reason: "blend failed" }` exactly like before.
 *   - Request coalescing: concurrent callers requesting the same key share a
 *     single in-flight promise so a cockpit page with 50 rows on the same
 *     lane only makes one pricing call total (instead of 50 racing each
 *     other into the cache and triggering 50 Sonar lookups).
 */
const BLEND_CACHE_TTL_MS = 90_000;
const BLEND_CACHE_MAX_ENTRIES = 500;
const BLEND_LOG_SAMPLE_RATE = 0.02;

interface BlendCacheEntry {
  value: BlendedRate;
  expiresAt: number;
}

const blendCache = new Map<string, BlendCacheEntry>();
const blendInFlight = new Map<string, Promise<BlendedRate>>();

const blendCacheMetrics = {
  hits: 0,
  misses: 0,
  coalesced: 0,
  evicted: 0,
  errors: 0,
};

function blendCacheKey(input: BlendInput): string {
  return [
    input.orgId,
    (input.origin ?? "").toUpperCase(),
    (input.destination ?? "").toUpperCase(),
    (input.originState ?? "").toUpperCase(),
    (input.destinationState ?? "").toUpperCase(),
    (input.equipmentType ?? "").toUpperCase(),
    (input.customerName ?? "").toLowerCase(),
    input.marginPctGuard ?? "",
  ].join("|");
}

function evictExpired(now: number): void {
  // Cheap pass: walk the map in insertion order and drop expired entries.
  // The Map iteration is ordered, and in the LRU bump path we delete+set
  // to keep insertion order = recency order, so the head is always the
  // oldest entry which lets us early-exit once we hit a fresh one.
  for (const [key, entry] of blendCache) {
    if (entry.expiresAt > now) break;
    blendCache.delete(key);
    blendCacheMetrics.evicted++;
  }
}

function evictLruIfFull(): void {
  while (blendCache.size >= BLEND_CACHE_MAX_ENTRIES) {
    const oldest = blendCache.keys().next().value as string | undefined;
    if (!oldest) break;
    blendCache.delete(oldest);
    blendCacheMetrics.evicted++;
    maybeLogBlendMetrics("evicted", oldest);
  }
}

/**
 * Strict-bound trim. Called after a successful insert so that even under
 * burst concurrency (many distinct-key misses racing in) the cache cannot
 * exceed `BLEND_CACHE_MAX_ENTRIES`. The pre-compute `evictLruIfFull` is
 * still useful for the steady state because it trims before we add work
 * that might be in flight, but it can be undercut by parallel inserts;
 * this post-insert pass closes that window.
 */
function enforceMaxSize(): void {
  while (blendCache.size > BLEND_CACHE_MAX_ENTRIES) {
    const oldest = blendCache.keys().next().value as string | undefined;
    if (!oldest) break;
    blendCache.delete(oldest);
    blendCacheMetrics.evicted++;
    maybeLogBlendMetrics("evicted", oldest);
  }
}

function maybeLogBlendMetrics(
  event: "hit" | "miss" | "coalesced" | "error" | "evicted",
  key: string,
): void {
  if (Math.random() > BLEND_LOG_SAMPLE_RATE) return;
  console.log("[pricing-blend-cache]", {
    event,
    key,
    size: blendCache.size,
    inFlight: blendInFlight.size,
    ...blendCacheMetrics,
  });
}

/**
 * Cached + request-coalesced wrapper around `getBlendedRate`.
 *
 * Use this from request paths that fan out the pricing call across many rows
 * (the Available Freight cockpit row builder, the Auto-Pilot preview). Other
 * callers — single-shot quote workbenches, agent tools — can keep using the
 * uncached `getBlendedRate` since they don't repeat the same lane many times
 * in one request.
 *
 * Errors thrown by the underlying service are NOT cached and are re-thrown so
 * the caller's existing try/catch contract (null rate + "blend failed"
 * reason) is preserved exactly.
 */
export async function getBlendedRateCached(input: BlendInput): Promise<BlendedRate> {
  const key = blendCacheKey(input);
  const now = Date.now();

  const cached = blendCache.get(key);
  if (cached && cached.expiresAt > now) {
    // Touch for LRU recency: re-insert at the tail.
    blendCache.delete(key);
    blendCache.set(key, cached);
    blendCacheMetrics.hits++;
    maybeLogBlendMetrics("hit", key);
    return cached.value;
  }
  if (cached) {
    blendCache.delete(key);
    blendCacheMetrics.evicted++;
  }

  const inFlight = blendInFlight.get(key);
  if (inFlight) {
    blendCacheMetrics.coalesced++;
    maybeLogBlendMetrics("coalesced", key);
    return inFlight;
  }

  blendCacheMetrics.misses++;
  evictExpired(now);
  evictLruIfFull();

  const promise = (async () => {
    try {
      const value = await computeBlendedRate(input);
      blendCache.set(key, { value, expiresAt: Date.now() + BLEND_CACHE_TTL_MS });
      // Strict bound enforcement after the insert in case multiple races
      // landed before any of them got to the pre-compute trim.
      enforceMaxSize();
      maybeLogBlendMetrics("miss", key);
      return value;
    } catch (err) {
      blendCacheMetrics.errors++;
      maybeLogBlendMetrics("error", key);
      throw err;
    } finally {
      blendInFlight.delete(key);
    }
  })();

  blendInFlight.set(key, promise);
  return promise;
}

/** Test-only: reset the blend cache + metrics so tests start from a clean slate. */
export function _resetBlendedRateCache(): void {
  blendCache.clear();
  blendInFlight.clear();
  blendCacheMetrics.hits = 0;
  blendCacheMetrics.misses = 0;
  blendCacheMetrics.coalesced = 0;
  blendCacheMetrics.evicted = 0;
  blendCacheMetrics.errors = 0;
}

/** Test-only: snapshot of the cache metrics counters. */
export function _getBlendedRateCacheMetrics(): Readonly<typeof blendCacheMetrics> & { size: number } {
  return { ...blendCacheMetrics, size: blendCache.size };
}
