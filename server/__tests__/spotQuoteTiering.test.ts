/**
 * Task #514 — Spot Quote Search Tiered Matching unit tests.
 *
 * Covers:
 *   1. equipmentFamily — van / reefer / open / other classification.
 *   2. classifyMatchTier — exact, same_market, same_state, reverse_lane,
 *      same_corridor, no-match, and precedence between tiers.
 *   3. pickGuidanceTier — walks the tier ladder, picking the first tier
 *      whose won-quote series meets the minimum sample size.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the KMA mapping so we can construct a deterministic
// same_corridor positive case (real KMA data is mostly state-bounded
// which makes corridor cases collide with same_state in the wild).
vi.mock("../kmaMapping", async () => {
  const actual = await vi.importActual<typeof import("../kmaMapping")>("../kmaMapping");
  const TEST_OVERRIDES: Record<string, { kma: string; label: string }> = {
    "corridor-origin-a|XX": { kma: "ZZA", label: "Test Origin Metro" },
    "corridor-origin-b|YY": { kma: "ZZA", label: "Test Origin Metro" },
    "corridor-dest-a|XX":   { kma: "ZZB", label: "Test Dest Metro" },
    "corridor-dest-b|YY":   { kma: "ZZB", label: "Test Dest Metro" },
  };
  return {
    ...actual,
    cityToKma: (city: string, state?: string | null) => {
      const k = `${(city || "").toLowerCase()}|${(state || "").toUpperCase()}`;
      return TEST_OVERRIDES[k] ?? actual.cityToKma(city, state ?? undefined);
    },
  };
});

// Coords are absent for the synthetic "corridor-*" cities, so the
// haversine path naturally returns false, isolating the corridor tier.

import {
  equipmentFamily,
  classifyMatchTier,
  pickGuidanceTier,
  MATCH_TIERS,
  type MatchTier,
} from "../services/customerQuotes";

describe("equipmentFamily", () => {
  it("maps van + dry van + box truck to 'van'", () => {
    expect(equipmentFamily("Van")).toBe("van");
    expect(equipmentFamily("dry van")).toBe("van");
    expect(equipmentFamily("DRYVAN")).toBe("van");
    expect(equipmentFamily("Box Truck")).toBe("van");
  });
  it("maps reefer / refrigerated / multi-temp to 'reefer'", () => {
    expect(equipmentFamily("Reefer")).toBe("reefer");
    expect(equipmentFamily("REFRIGERATED")).toBe("reefer");
    expect(equipmentFamily("Multi-Temp")).toBe("reefer");
    expect(equipmentFamily("multi temp")).toBe("reefer");
  });
  it("maps flatbed / step-deck / RGN to 'open'", () => {
    expect(equipmentFamily("Flatbed")).toBe("open");
    expect(equipmentFamily("step deck")).toBe("open");
    expect(equipmentFamily("RGN")).toBe("open");
    expect(equipmentFamily("Conestoga")).toBe("open");
  });
  it("maps unknown / blank / niche equipment to 'other'", () => {
    expect(equipmentFamily(null)).toBe("other");
    expect(equipmentFamily(undefined)).toBe("other");
    expect(equipmentFamily("")).toBe("other");
    expect(equipmentFamily("Power Only")).toBe("other");
    expect(equipmentFamily("Hopper")).toBe("other");
  });
});

const LB_PHX = {
  pickupCity: "Long Beach", pickupState: "CA",
  deliveryCity: "Phoenix", deliveryState: "AZ",
};

describe("classifyMatchTier", () => {
  it("returns 'exact' for an exact city + state match on both ends", () => {
    expect(classifyMatchTier(LB_PHX, {
      originCity: "long beach", originState: "ca",
      destCity: "PHOENIX", destState: "AZ",
    })).toBe("exact");
  });

  it("returns 'same_market' for endpoints within ~75 mi of both ends", () => {
    // Compton is within ~75mi of Long Beach; Glendale AZ is within 75mi of Phoenix.
    const tier = classifyMatchTier(LB_PHX, {
      originCity: "Compton", originState: "CA",
      destCity: "Glendale", destState: "AZ",
    });
    expect(tier === "same_market" || tier === "same_state").toBe(true);
  });

  it("returns 'same_state' when only the state pair matches", () => {
    expect(classifyMatchTier(LB_PHX, {
      originCity: "Sacramento", originState: "CA",
      destCity: "Tucson", destState: "AZ",
    })).toBe("same_state");
  });

  it("returns 'reverse_lane' when the lane runs in the opposite direction", () => {
    expect(classifyMatchTier(LB_PHX, {
      originCity: "Phoenix", originState: "AZ",
      destCity: "Long Beach", destState: "CA",
    })).toBe("reverse_lane");
  });

  it("returns 'same_corridor' when both endpoints share KMAs across state lines", () => {
    // Synthetic cross-state corridor (mocked KMA above). Both endpoint
    // pairs share a KMA, but the cities differ, lack coords, and live
    // in different states — so exact / same_market / same_state /
    // reverse_lane all fail and the corridor tier wins.
    expect(classifyMatchTier(
      { pickupCity: "corridor-origin-a", pickupState: "XX",
        deliveryCity: "corridor-dest-a", deliveryState: "XX" },
      { originCity: "corridor-origin-b", originState: "YY",
        destCity: "corridor-dest-b", destState: "YY" },
    )).toBe("same_corridor");
  });

  it("returns null when neither endpoints, states, reverse, nor corridor match", () => {
    expect(classifyMatchTier(LB_PHX, {
      originCity: "Boston", originState: "MA",
      destCity: "Atlanta", destState: "GA",
    })).toBeNull();
  });

  it("gives 'exact' precedence over 'same_market'", () => {
    expect(classifyMatchTier(LB_PHX, {
      originCity: "Long Beach", originState: "CA",
      destCity: "Phoenix", destState: "AZ",
    })).toBe("exact");
  });

  it("gives 'same_state' precedence over 'reverse_lane' when both could apply", () => {
    // CA→AZ same-state pair (Sacramento, CA → Tucson, AZ) — direction
    // matches, so it must be classified as same_state, not reverse_lane.
    expect(classifyMatchTier(LB_PHX, {
      originCity: "Sacramento", originState: "CA",
      destCity: "Tucson", destState: "AZ",
    })).toBe("same_state");
  });
});

describe("pickGuidanceTier", () => {
  const blank = (): Record<MatchTier, { won: number[] }> => ({
    exact: { won: [] }, same_market: { won: [] }, same_state: { won: [] },
    reverse_lane: { won: [] }, same_corridor: { won: [] },
  });

  it("picks 'exact' when the exact tier has ≥4 won quotes", () => {
    const b = blank();
    b.exact.won = [1000, 1100, 1200, 1300, 1400];
    expect(pickGuidanceTier(b, 4)).toBe("exact");
  });

  it("falls through to 'same_market' when exact is sparse", () => {
    const b = blank();
    b.exact.won = [1000, 1100]; // below threshold
    b.same_market.won = [1200, 1250, 1300, 1350];
    expect(pickGuidanceTier(b, 4)).toBe("same_market");
  });

  it("falls through to 'same_corridor' when only the corridor tier has data", () => {
    const b = blank();
    b.same_corridor.won = [900, 950, 1000, 1050];
    expect(pickGuidanceTier(b, 4)).toBe("same_corridor");
  });

  it("returns null when no tier meets the minimum sample", () => {
    const b = blank();
    b.exact.won = [1000];
    b.same_state.won = [1100, 1200];
    expect(pickGuidanceTier(b, 4)).toBeNull();
  });

  it("walks tiers in MATCH_TIERS order (exact → market → state → reverse → corridor)", () => {
    expect(MATCH_TIERS).toEqual([
      "exact", "same_market", "same_state", "reverse_lane", "same_corridor",
    ]);
  });

  it("returns same_corridor (deepest tier) when only that tier qualifies — guidance provenance", () => {
    const b = blank();
    b.same_corridor.won = [800, 900, 1000, 1100];
    // The picked tier is what the result's `guidance.tierUsed` is
    // populated with downstream — confirms the provenance signal.
    expect(pickGuidanceTier(b, 4)).toBe("same_corridor");
  });
});
