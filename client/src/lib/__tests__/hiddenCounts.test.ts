// Task #871 — Hidden-counts disclosure shared by AF + LWQ.
//
// The disclosure surfaces a "N hidden of M total" pill — but the LWQ
// experience hinges on the per-bucket totals adding up to the headline
// number. This contract is tested explicitly so a future bucket added
// without updating the headline is caught in CI.

import { describe, it, expect } from "vitest";
import {
  sumHiddenBuckets,
  type HiddenCountsSummary,
} from "@/components/freight/hidden-counts";

describe("sumHiddenBuckets", () => {
  it("returns 0 for an empty buckets list", () => {
    const s: HiddenCountsSummary = { totalInScope: 10, visible: 10, buckets: [] };
    expect(sumHiddenBuckets(s)).toBe(0);
  });

  it("sums only positive bucket counts (negative counts are clamped to 0)", () => {
    const s: HiddenCountsSummary = {
      totalInScope: 30,
      visible: 12,
      buckets: [
        { id: "customer",    label: "Customer filter",  count: 8 },
        { id: "highFreq",    label: "High-freq filter", count: 6 },
        { id: "manualOnly",  label: "Manual only",      count: 4 },
        { id: "weird",       label: "Negative bucket",  count: -3 },
      ],
    };
    expect(sumHiddenBuckets(s)).toBe(18);
  });

  it("equals totalInScope - visible when buckets fully account for hidden rows", () => {
    const s: HiddenCountsSummary = {
      totalInScope: 25,
      visible: 10,
      buckets: [
        { id: "customer",    label: "Customer",  count: 5 },
        { id: "highFreq",    label: "HF",        count: 4 },
        { id: "manualOnly",  label: "Manual",    count: 6 },
      ],
    };
    expect(sumHiddenBuckets(s)).toBe(s.totalInScope - s.visible);
  });
});
