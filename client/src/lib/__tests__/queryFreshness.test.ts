// Task #970 — unit tests for the SSE/cache freshness ordering guard.
//
// Verifies the three behaviours we depend on at runtime:
//   1. A fetch that completes BEFORE any invalidation lands returns
//      its result unchanged.
//   2. A fetch racing an invalidation that lands AFTER the fetch
//      started is discarded and re-fetched once.
//   3. The retry is bounded to a single re-fetch (a second invalidation
//      mid-retry is intentionally tolerated to avoid loops).

import { describe, it, expect, beforeEach } from "vitest";
import {
  markQueryInvalidated,
  fetchWithFreshnessGuard,
  getLastInvalidatedAt,
  _resetFreshnessGuardForTests,
  _peekFreshnessForTests,
} from "@/lib/queryFreshness";

describe("queryFreshness guard", () => {
  beforeEach(() => {
    _resetFreshnessGuardForTests();
  });

  it("returns the result when no invalidation occurs", async () => {
    let calls = 0;
    const result = await fetchWithFreshnessGuard({
      cacheKey: "/api/x",
      fetcher: async () => {
        calls += 1;
        return { value: "first" };
      },
    });
    expect(result).toEqual({ value: "first" });
    expect(calls).toBe(1);
  });

  it("discards stale fetch when invalidation lands AFTER fetch start", async () => {
    let calls = 0;
    const result = await fetchWithFreshnessGuard<{ value: string }>({
      cacheKey: "/api/x",
      fetcher: async () => {
        calls += 1;
        // First call: simulate the in-flight race by stamping the
        // watermark BEFORE the fetcher resolves.
        if (calls === 1) {
          // Force a measurable delta so the watermark is strictly newer
          // than the fetch start time captured by the guard.
          await new Promise(r => setTimeout(r, 5));
          markQueryInvalidated("/api/x", Date.now() + 10);
          return { value: "stale" };
        }
        return { value: "fresh" };
      },
    });
    expect(result).toEqual({ value: "fresh" });
    expect(calls).toBe(2);
  });

  it("returns the original result when invalidation predates the fetch start", async () => {
    // Stamp an OLD watermark (well in the past). The guard must not
    // mistake a pre-existing watermark as racing the new fetch.
    markQueryInvalidated("/api/x", Date.now() - 1_000);
    let calls = 0;
    const result = await fetchWithFreshnessGuard({
      cacheKey: "/api/x",
      fetcher: async () => {
        calls += 1;
        return { value: "fresh-enough" };
      },
    });
    expect(result).toEqual({ value: "fresh-enough" });
    expect(calls).toBe(1);
  });

  it("bounds the retry to a single re-fetch even if invalidation continues", async () => {
    let calls = 0;
    const result = await fetchWithFreshnessGuard<{ value: string }>({
      cacheKey: "/api/x",
      fetcher: async () => {
        calls += 1;
        // Stamp a fresh watermark on EVERY call. Without bounding the
        // retry, this would loop forever.
        await new Promise(r => setTimeout(r, 2));
        markQueryInvalidated("/api/x", Date.now() + 100);
        return { value: `call-${calls}` };
      },
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ value: "call-2" });
  });

  it("monotonically advances the watermark", () => {
    markQueryInvalidated("/api/y", 1_000);
    markQueryInvalidated("/api/y", 500); // older — should be ignored
    expect(_peekFreshnessForTests("/api/y")).toBe(1_000);
    markQueryInvalidated("/api/y", 2_000);
    expect(_peekFreshnessForTests("/api/y")).toBe(2_000);
    expect(getLastInvalidatedAt("/api/y")).toBe(2_000);
    expect(getLastInvalidatedAt("/api/never-stamped")).toBe(null);
  });

  it("ignores empty cache keys", () => {
    markQueryInvalidated("", 1_000);
    expect(_peekFreshnessForTests("")).toBeUndefined();
  });
});
