// Task #871 — Lane stability classifier shared by AF + LWQ + Cockpit.
//
// The badge rendered on AF rows, LWQ rows, and the Lane Cockpit header
// all funnel through `classifyStability`. These tests pin the band
// boundaries so a future tweak to recurringLaneCapacityEngine penalty
// scalars cannot silently flip a lane's category across surfaces.

import { describe, it, expect } from "vitest";
import { classifyStability } from "../laneCrossLinkService";

describe("classifyStability", () => {
  it("returns null when no penalty has been computed yet", () => {
    expect(classifyStability(null)).toBeNull();
    expect(classifyStability(undefined)).toBeNull();
  });

  it("returns null for non-finite values", () => {
    expect(classifyStability(Number.NaN)).toBeNull();
    expect(classifyStability(Number.POSITIVE_INFINITY)).toBeNull();
    expect(classifyStability(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("classifies penalty == 0 as stable", () => {
    expect(classifyStability(0)).toBe("stable");
  });

  it("classifies a positive penalty (defensive — never produced today) as stable", () => {
    expect(classifyStability(5)).toBe("stable");
  });

  it("classifies the medium recurring-lane penalty (-5) as volatile", () => {
    expect(classifyStability(-5)).toBe("volatile");
  });

  it("treats -7.99… as volatile and -8 as the hot boundary", () => {
    expect(classifyStability(-7.99)).toBe("volatile");
    expect(classifyStability(-8)).toBe("hot");
  });

  it("classifies the high recurring-lane penalty (-10) as hot", () => {
    expect(classifyStability(-10)).toBe("hot");
  });

  it("classifies any deeply negative penalty as hot", () => {
    expect(classifyStability(-25)).toBe("hot");
  });
});
