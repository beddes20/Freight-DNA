/**
 * Customer Quotes — Pricing Recommendation engine unit tests.
 *
 * Covers the pure helpers exported from quotePricingRecommendation.ts:
 *   - buildTierRates: TRAC band branch, history fallback, no-data branch
 *   - lookupBinForRate: position math + bin matching
 *   - resolveWinProb: history vs default selection rule
 *   - evaluateFloor: breach detection + floor-rate math + miles guards
 */
import { describe, it, expect } from "vitest";
import {
  buildTierRates,
  lookupBinForRate,
  resolveWinProb,
  evaluateFloor,
} from "../services/quotePricingRecommendation";
import type { PricingPriceBin } from "../services/customerQuotes";

const sampleBins: PricingPriceBin[] = [
  { label: "<-5%", lo: -Infinity, hi: -0.05, total: 4, won: 3, winRate: 75 },
  { label: "-5% to 0%", lo: -0.05, hi: 0, total: 6, won: 4, winRate: 66.67 },
  { label: "0% to +5%", lo: 0, hi: 0.05, total: 5, won: 2, winRate: 40 },
  { label: ">+5%", lo: 0.05, hi: Infinity, total: 1, won: 0, winRate: 0 },
];

describe("buildTierRates", () => {
  it("uses TRAC band when present", () => {
    const out = buildTierRates({ low: 1900, mid: 2100, high: 2400 }, null);
    expect(out).not.toBeNull();
    expect(out!.mid).toBe(2100);
    expect(out!.tiers.map(t => [t.name, t.rate])).toEqual([
      ["aggressive", 1900],
      ["balanced", 2100],
      ["premium", 2400],
    ]);
  });

  it("falls back to benchmark when band missing", () => {
    const out = buildTierRates(null, 2000);
    expect(out).not.toBeNull();
    expect(out!.mid).toBe(2000);
    expect(out!.tiers.map(t => t.name)).toEqual(["aggressive", "balanced", "premium"]);
    expect(out!.tiers[0].rate).toBe(1900); // -5%
    expect(out!.tiers[1].rate).toBe(2000);
    expect(out!.tiers[2].rate).toBe(2160); // +8%
  });

  it("returns null when neither band nor benchmark", () => {
    expect(buildTierRates(null, null)).toBeNull();
    expect(buildTierRates(null, 0)).toBeNull();
    expect(buildTierRates({ low: 0, mid: 0, high: 0 }, null)).toBeNull();
  });
});

describe("lookupBinForRate", () => {
  it("finds the bin for a rate at -5% from benchmark", () => {
    const bin = lookupBinForRate(1900, 2000, sampleBins);
    expect(bin?.label).toBe("-5% to 0%");
  });

  it("snaps to the lowest open-ended bin for very low rate", () => {
    const bin = lookupBinForRate(1500, 2000, sampleBins);
    expect(bin?.label).toBe("<-5%");
  });

  it("snaps to the highest open-ended bin for very high rate", () => {
    const bin = lookupBinForRate(2500, 2000, sampleBins);
    expect(bin?.label).toBe(">+5%");
  });

  it("returns null when benchmark is zero", () => {
    expect(lookupBinForRate(2000, 0, sampleBins)).toBeNull();
  });
});

describe("resolveWinProb", () => {
  it("uses bin win-rate when sample >= 2", () => {
    const out = resolveWinProb("balanced", { label: "x", lo: 0, hi: 1, total: 5, won: 3, winRate: 60 });
    expect(out).toEqual({ winProb: 60, source: "history", sampleSize: 5 });
  });

  it("falls back to default when bin is sparse", () => {
    const out = resolveWinProb("balanced", { label: "x", lo: 0, hi: 1, total: 1, won: 1, winRate: 100 });
    expect(out.source).toBe("default");
    expect(out.winProb).toBe(55);
  });

  it("falls back when bin is null", () => {
    expect(resolveWinProb("aggressive", null)).toEqual({ winProb: 75, source: "default" });
    expect(resolveWinProb("premium", null)).toEqual({ winProb: 30, source: "default" });
  });
});

describe("lookupBinForRate — TRAC vs benchmark divergence", () => {
  // Regression guard: bins are computed in getPricingIntelligence as
  //   position = (quotedAmount - sonarBenchmark) / sonarBenchmark
  // so the recommendation engine MUST use sonarBenchmark (not TRAC mid)
  // when looking tiers up against the bin table — otherwise tiers will
  // land in the wrong bins whenever TRAC mid diverges from the historical
  // benchmark, producing materially wrong win-prob estimates.
  it("produces different bins for the same rate when benchmark differs", () => {
    const rate = 2100;
    // TRAC mid happens to equal 2100 → position 0% → middle bin.
    const wrongBin = lookupBinForRate(rate, 2100, sampleBins);
    expect(wrongBin?.label).toBe("0% to +5%");
    // True historical benchmark is 1900 → position +10.5% → top bin.
    const correctBin = lookupBinForRate(rate, 1900, sampleBins);
    expect(correctBin?.label).toBe(">+5%");
    // The two bins yield very different win-rate signals — exactly why
    // we must pass sonarBenchmark, not built.mid, in the orchestrator.
    expect(wrongBin?.winRate).not.toBe(correctBin?.winRate);
  });
});

describe("evaluateFloor", () => {
  it("flags breach when rate is below floor", () => {
    const out = evaluateFloor(1500, 1000, 1.75);
    expect(out.belowFloor).toBe(true);
    expect(out.floorRate).toBe(1750);
  });

  it("does not flag when rate is at or above floor", () => {
    expect(evaluateFloor(1750, 1000, 1.75).belowFloor).toBe(false);
    expect(evaluateFloor(2000, 1000, 1.75).belowFloor).toBe(false);
  });

  it("returns no breach when miles unknown", () => {
    expect(evaluateFloor(1500, null, 1.75)).toEqual({ belowFloor: false });
    expect(evaluateFloor(1500, 0, 1.75)).toEqual({ belowFloor: false });
  });

  it("returns no breach when floor is unset", () => {
    expect(evaluateFloor(1500, 1000, null)).toEqual({ belowFloor: false });
    expect(evaluateFloor(1500, 1000, 0)).toEqual({ belowFloor: false });
  });
});
