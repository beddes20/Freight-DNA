/**
 * Tests for the in-process pricing-blend cache (Task #819).
 *
 * Verifies that:
 *  - Repeat calls within the TTL window are served from cache (one underlying
 *    pricing call per unique lane key, not per row).
 *  - Concurrent callers requesting the same key share a single in-flight
 *    promise (request coalescing) so a cockpit page with N rows on the same
 *    lane only triggers ONE pricing call.
 *  - Distinct lane keys are tracked independently.
 *  - Thrown errors are NOT cached — the next call retries — but the cockpit's
 *    existing try/catch contract is preserved (the error re-throws so the
 *    caller surfaces { rate: null, reason: "blend failed" }).
 *  - "Refused/none" outcomes ARE cached so cold lanes don't keep hitting
 *    Sonar + the lane history table on every render.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LaneMarketRate } from "../sonarClient";
import type { LaneHistoryWithTier } from "../laneRateHistoryService";

// Stub the underlying blend dependencies so we control the work and can count
// the number of times the slow path runs. The cache wrapper itself is the
// system under test.
const sonarMock = vi.fn<
  (origin: string, destination: string) => Promise<LaneMarketRate>
>();
vi.mock("../sonarClient", () => ({
  getLaneMarketRate: (origin: string, destination: string) =>
    sonarMock(origin, destination),
  withSonarCaller: async <T>(_caller: string, fn: () => Promise<T>): Promise<T> =>
    fn(),
}));

const historyMock = vi.fn<
  (...args: unknown[]) => Promise<LaneHistoryWithTier | null>
>();
vi.mock("../laneRateHistoryService", () => ({
  getLaneRateHistory: (...args: unknown[]) => historyMock(...args),
  recomputeLaneRateHistory: vi.fn<() => Promise<number>>(),
}));

const settingsStore = new Map<string, string>();
const getSettingMock = vi.fn<(key: string) => Promise<string | null>>(
  async (k) => settingsStore.get(k) ?? null,
);
const setSettingMock = vi.fn<(key: string, value: string) => Promise<void>>(
  async (k, v) => {
    settingsStore.set(k, v);
  },
);
vi.mock("../storage", () => ({
  storage: {
    getSetting: (key: string) => getSettingMock(key),
    setSetting: (key: string, value: string) => setSettingMock(key, value),
  },
  // The pricingBlendService module imports `storage` only; `db` isn't touched
  // by the code under test. Exposing an empty object keeps the module shape
  // intact without giving consumers a typed `db` they could accidentally use.
  db: {},
}));

import {
  getBlendedRateCached,
  _resetBlendedRateCache,
  _getBlendedRateCacheMetrics,
  type BlendInput,
} from "../pricingBlendService";
import { _resetSonarPricingCache } from "../sonarTracPricingClient";

const baseInput: BlendInput = {
  orgId: "org-1",
  origin: "Chicago",
  destination: "Atlanta",
  originState: "IL",
  destinationState: "GA",
  equipmentType: "VAN",
  customerName: "ACME",
};

beforeEach(() => {
  settingsStore.clear();
  sonarMock.mockReset();
  historyMock.mockReset();
  _resetSonarPricingCache();
  _resetBlendedRateCache();
  // Reasonable defaults: Sonar returns a usable rate; history returns nothing.
  sonarMock.mockResolvedValue({
    marketRatePerMile: 2.40,
    source: "lane",
  } as LaneMarketRate);
  historyMock.mockResolvedValue(null);
});

describe("getBlendedRateCached", () => {
  it("serves a second call from cache (no extra sonar/history work)", async () => {
    const a = await getBlendedRateCached(baseInput);
    const b = await getBlendedRateCached(baseInput);
    expect(b).toBe(a);
    // Both legs of the underlying blend run exactly once.
    expect(sonarMock).toHaveBeenCalledTimes(1);
    expect(historyMock).toHaveBeenCalledTimes(1);
    const m = _getBlendedRateCacheMetrics();
    expect(m.misses).toBe(1);
    expect(m.hits).toBe(1);
  });

  it("coalesces concurrent calls for the same key into one underlying call", async () => {
    // 50 concurrent callers (cockpit page with many rows on the same lane).
    const results = await Promise.all(
      Array.from({ length: 50 }, () => getBlendedRateCached(baseInput)),
    );
    // All callers got the same result.
    for (const r of results) expect(r).toBe(results[0]);
    // ONE underlying pricing call total (not 50).
    expect(sonarMock).toHaveBeenCalledTimes(1);
    expect(historyMock).toHaveBeenCalledTimes(1);
    const m = _getBlendedRateCacheMetrics();
    expect(m.misses).toBe(1);
    expect(m.coalesced).toBe(49);
  });

  it("treats different lane keys as independent cache entries", async () => {
    await getBlendedRateCached(baseInput);
    await getBlendedRateCached({ ...baseInput, destination: "Dallas", destinationState: "TX" });
    await getBlendedRateCached(baseInput); // hit
    await getBlendedRateCached({ ...baseInput, customerName: "Other" }); // miss
    // The lane history mock is what we count: sonar has its own
    // longer-TTL cache in `sonarTracPricingClient` so call counts there
    // are not a clean signal.
    expect(historyMock).toHaveBeenCalledTimes(3);
    const m = _getBlendedRateCacheMetrics();
    expect(m.misses).toBe(3);
    expect(m.hits).toBe(1);
  });

  it("does NOT cache thrown errors — the next call retries", async () => {
    // Force the underlying compute path to throw on the first call by
    // making `getBlendConfig` reject (it goes through storage.getSetting).
    // The retry should hit the slow path again, not return a cached error.
    let calls = 0;
    getSettingMock.mockImplementation(async (k: string) => {
      calls++;
      if (calls === 1) throw new Error("settings unavailable");
      return settingsStore.get(k) ?? null;
    });
    try {
      await expect(
        getBlendedRateCached({ ...baseInput, orgId: "org-throw" }),
      ).rejects.toThrow(/settings unavailable/);
      const m1 = _getBlendedRateCacheMetrics();
      expect(m1.errors).toBe(1);
      expect(m1.size).toBe(0); // error must NOT have been written to the cache

      // Retry runs the underlying blend again (not a cache hit) and succeeds.
      const ok = await getBlendedRateCached({ ...baseInput, orgId: "org-throw" });
      expect(ok.targetBuyRpm).not.toBeNull();
      const m2 = _getBlendedRateCacheMetrics();
      // Both the failed and retry attempts are misses (no cached error
      // short-circuited the second call); zero hits.
      expect(m2.misses).toBe(2);
      expect(m2.hits).toBe(0);
    } finally {
      getSettingMock.mockImplementation(async (k: string) => settingsStore.get(k) ?? null);
    }
  });

  it("caches refused/none outcomes so cold lanes are cheap on repeat calls", async () => {
    // Sonar unavailable + zero history — the blend returns confidence 'none'
    // without throwing.
    sonarMock.mockReset();
    sonarMock.mockResolvedValue({ marketRatePerMile: null } as LaneMarketRate);
    historyMock.mockResolvedValue(null);

    const a = await getBlendedRateCached(baseInput);
    const b = await getBlendedRateCached(baseInput);
    expect(a.confidence).toBe("none");
    expect(b).toBe(a);
    // The underlying sonar client memoizes its own miss-with-prior-good
    // semantics, but our cache is what matters here: only ONE blend was
    // computed.
    const m = _getBlendedRateCacheMetrics();
    expect(m.misses).toBe(1);
    expect(m.hits).toBe(1);
  });
});
