// Task #638 — top-N gating predicate. Both UI surfaces (LWQ import +
// AF detail pool-promote) must agree: a single-carrier add only fires
// the picker when the carrier was NOT already in the ranker shortlist.
import { describe, it, expect } from "vitest";
import { shouldFireAddedOutsideTopN } from "@/components/CarrierOverrideReasonPicker";

describe("shouldFireAddedOutsideTopN", () => {
  it("fires when the carrier id is not present in the shortlist", () => {
    expect(shouldFireAddedOutsideTopN("c-new", ["c-1", "c-2", "c-3"])).toBe(true);
  });

  it("does NOT fire when the carrier id is already in the shortlist", () => {
    expect(shouldFireAddedOutsideTopN("c-2", ["c-1", "c-2", "c-3"])).toBe(false);
  });

  it("does not fire when carrier id is missing", () => {
    expect(shouldFireAddedOutsideTopN(null, ["c-1"])).toBe(false);
    expect(shouldFireAddedOutsideTopN(undefined, ["c-1"])).toBe(false);
    expect(shouldFireAddedOutsideTopN("", ["c-1"])).toBe(false);
  });

  it("ignores nullish entries in the shortlist (history-only carriers)", () => {
    expect(shouldFireAddedOutsideTopN("c-new", [null, undefined, "c-1"])).toBe(true);
  });

  it("treats an empty shortlist as 'fire' for any real carrier id", () => {
    expect(shouldFireAddedOutsideTopN("c-new", [])).toBe(true);
  });
});
