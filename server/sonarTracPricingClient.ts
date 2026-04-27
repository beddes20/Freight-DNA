/**
 * Thin wrapper around sonarClient.getLaneMarketRate (Task #369).
 *
 * Centralizes how the carrier-intelligence stack asks Sonar for a lane price
 * so callers don't need to know about TRAC vs national-fallback or how to
 * read the result shape. We persist the last-known-good rate per lane so a
 * Sonar outage degrades gracefully instead of zeroing the blend:
 *   - On success: cache the fresh value with TTL.
 *   - On failure or null result: do NOT overwrite a prior good cache entry.
 *     Instead return that prior value flagged isStale=true, source="cache".
 *   - On failure with no prior cache entry: return source="unavailable",
 *     ratePerMile=null and DO NOT cache the failure (so the next call retries).
 */

import { getLaneMarketRate, withSonarCaller } from "./sonarClient";

export interface SonarLanePricing {
  origin: string;
  destination: string;
  equipmentType: string;
  ratePerMile: number | null;
  source: "trac" | "national_fallback" | "cache" | "unavailable";
  forecastDirection: "TIGHTENING" | "EASING" | "STABLE" | null;
  weeklyRateChangePct: number;
  fetchedAt: string;
  /** True when the value is from a stale cache entry or the fetch failed. */
  isStale: boolean;
}

interface CachedEntry {
  value: SonarLanePricing;
  fetchedAt: number;
  /** The successful result we last saw — preserved even when fresh fetch fails. */
  lastGood: SonarLanePricing | null;
}

interface RawSonarResult {
  marketRatePerMile?: number | null;
  source?: string;
  forecastDirection?: "TIGHTENING" | "EASING" | "STABLE";
  weeklyRateChange?: number;
}

const inMemoryCache = new Map<string, CachedEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

function cacheKey(o: string, d: string, equip: string): string {
  return `${o.toUpperCase()}::${d.toUpperCase()}::${equip.toUpperCase()}`;
}

function buildSuccess(origin: string, destination: string, equipmentType: string, result: RawSonarResult): SonarLanePricing {
  const rpm = result?.marketRatePerMile ?? null;
  const usable = typeof rpm === "number" && rpm > 0;
  return {
    origin,
    destination,
    equipmentType,
    ratePerMile: usable ? Math.round((rpm as number) * 100) / 100 : null,
    source: usable ? (result?.source === "lane" ? "trac" : "national_fallback") : "unavailable",
    forecastDirection: result?.forecastDirection ?? null,
    weeklyRateChangePct: typeof result?.weeklyRateChange === "number" ? result.weeklyRateChange : 0,
    fetchedAt: new Date().toISOString(),
    isStale: !usable,
  };
}

function staleCopy(prior: SonarLanePricing): SonarLanePricing {
  return { ...prior, source: "cache", isStale: true, fetchedAt: new Date().toISOString() };
}

function unavailable(origin: string, destination: string, equipmentType: string): SonarLanePricing {
  return {
    origin, destination, equipmentType,
    ratePerMile: null,
    source: "unavailable",
    forecastDirection: null,
    weeklyRateChangePct: 0,
    fetchedAt: new Date().toISOString(),
    isStale: true,
  };
}

export async function getSonarLanePricing(
  origin: string,
  destination: string,
  equipmentType: string = "VAN",
): Promise<SonarLanePricing> {
  const key = cacheKey(origin, destination, equipmentType);
  const cached = inMemoryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.value;

  let fresh: SonarLanePricing;
  let success = false;
  try {
    // Tag any new live SONAR call as `pricing:blend` so the Integrations
    // Health Console can distinguish quote-workbench / cockpit / ranking
    // requests from raw UI VOTRI lookups in the call-budget ledger.
    const result = (await withSonarCaller("pricing:blend", () =>
      getLaneMarketRate(origin, destination),
    )) as RawSonarResult | null | undefined;
    fresh = buildSuccess(origin, destination, equipmentType, result ?? {});
    success = fresh.ratePerMile !== null;
  } catch {
    fresh = unavailable(origin, destination, equipmentType);
    success = false;
  }

  if (success) {
    inMemoryCache.set(key, { value: fresh, fetchedAt: Date.now(), lastGood: fresh });
    return fresh;
  }

  // Fetch failed or returned no usable rate — preserve last-known-good if any.
  const prior = cached?.lastGood ?? null;
  if (prior) {
    const stale = staleCopy(prior);
    // Don't overwrite lastGood; just bump TTL marker so we don't hammer the API.
    inMemoryCache.set(key, { value: stale, fetchedAt: Date.now(), lastGood: prior });
    return stale;
  }
  // No prior good value — return unavailable WITHOUT caching so the next call retries.
  return fresh;
}

export async function getSonarLanePricingBatch(
  lanes: Array<{ origin: string; destination: string; equipmentType?: string }>,
): Promise<Map<string, SonarLanePricing>> {
  const out = new Map<string, SonarLanePricing>();
  await Promise.all(
    lanes.map(async ({ origin, destination, equipmentType }) => {
      const p = await getSonarLanePricing(origin, destination, equipmentType ?? "VAN");
      out.set(cacheKey(origin, destination, equipmentType ?? "VAN"), p);
    }),
  );
  return out;
}

/** Test-only hook: reset the in-memory cache. */
export function _resetSonarPricingCache(): void {
  inMemoryCache.clear();
}
