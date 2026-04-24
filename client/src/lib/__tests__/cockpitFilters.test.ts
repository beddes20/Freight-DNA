import { describe, it, expect } from "vitest";
import { applyCockpitFilters, type CockpitFilterItem } from "../cockpitFilters";

const NOW = new Date("2026-04-24T12:00:00Z").getTime();

function mk(overrides: Partial<CockpitFilterItem> & { id: string }): CockpitFilterItem & { id: string } {
  return {
    opportunity: {
      origin: "Chicago, IL",
      destination: "Atlanta, GA",
      equipmentType: "DRY",
      pickupWindowStart: null,
      status: "ready_to_send",
      ...(overrides.opportunity ?? {}),
    },
    chips: overrides.chips ?? [{ carrierName: "Acme Logistics" }],
    coverage: { sent: 0, responded: 0, ...(overrides.coverage ?? {}) },
    suggestedBuy: overrides.suggestedBuy ?? null,
    freshnessMinutes: overrides.freshnessMinutes ?? 0,
    owner: overrides.owner ?? null,
    id: overrides.id,
  };
}

describe("applyCockpitFilters", () => {
  it("matches search across origin/destination/equipment/carrier names", () => {
    const items = [
      mk({ id: "a" }),
      mk({ id: "b", opportunity: { origin: "Dallas, TX", destination: "Houston, TX", status: "new" } }),
      mk({ id: "c", chips: [{ carrierName: "Bravo Trucking" }] }),
    ];
    expect(applyCockpitFilters(items, "atlanta", {}, null, NOW).map(i => i.id)).toEqual(["a", "c"]);
    expect(applyCockpitFilters(items, "bravo", {}, null, NOW).map(i => i.id)).toEqual(["c"]);
    expect(applyCockpitFilters(items, "dallas", {}, null, NOW).map(i => i.id)).toEqual(["b"]);
  });

  it("statuses filter restricts to listed statuses", () => {
    const items = [
      mk({ id: "a", opportunity: { status: "ready_to_send" } }),
      mk({ id: "b", opportunity: { status: "new" } }),
      mk({ id: "c", opportunity: { status: "awaiting_approval" } }),
    ];
    expect(applyCockpitFilters(items, "", { statuses: ["new", "awaiting_approval"] }, null, NOW).map(i => i.id)).toEqual(["b", "c"]);
  });

  it("ownerScope=mine returns only items owned by currentUser; team excludes them", () => {
    const items = [
      mk({ id: "a", owner: { id: "u1", name: "Me" } }),
      mk({ id: "b", owner: { id: "u2", name: "Other" } }),
      mk({ id: "c", owner: null }),
    ];
    expect(applyCockpitFilters(items, "", { ownerScope: "mine" }, "u1", NOW).map(i => i.id)).toEqual(["a"]);
    expect(applyCockpitFilters(items, "", { ownerScope: "team" }, "u1", NOW).map(i => i.id)).toEqual(["b", "c"]);
    expect(applyCockpitFilters(items, "", { ownerScope: "mine" }, null, NOW)).toEqual([]);
    expect(
      applyCockpitFilters(items, "", { ownerScope: "team" }, null, NOW).map(i => i.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("pickupWithinHours keeps future pickups inside the window only", () => {
    const inWindow = new Date(NOW + 6 * 3600_000).toISOString();
    const outWindow = new Date(NOW + 30 * 3600_000).toISOString();
    const past = new Date(NOW - 1 * 3600_000).toISOString();
    const items = [
      mk({ id: "in", opportunity: { pickupWindowStart: inWindow, status: "new" } }),
      mk({ id: "out", opportunity: { pickupWindowStart: outWindow, status: "new" } }),
      mk({ id: "past", opportunity: { pickupWindowStart: past, status: "new" } }),
      mk({ id: "none", opportunity: { pickupWindowStart: null, status: "new" } }),
    ];
    expect(applyCockpitFilters(items, "", { pickupWithinHours: 24 }, null, NOW).map(i => i.id)).toEqual(["in"]);
  });

  it("pickupAfterHours keeps only pickups beyond the threshold", () => {
    const items = [
      mk({ id: "soon", opportunity: { pickupWindowStart: new Date(NOW + 6 * 3600_000).toISOString(), status: "new" } }),
      mk({ id: "later", opportunity: { pickupWindowStart: new Date(NOW + 36 * 3600_000).toISOString(), status: "new" } }),
    ];
    expect(applyCockpitFilters(items, "", { pickupAfterHours: 24 }, null, NOW).map(i => i.id)).toEqual(["later"]);
  });

  it("confidenceFlag matches suggestedBuy.confidence exactly", () => {
    const items = [
      mk({ id: "low", suggestedBuy: { confidence: "low" } }),
      mk({ id: "med", suggestedBuy: { confidence: "medium" } }),
      mk({ id: "none", suggestedBuy: null }),
    ];
    expect(applyCockpitFilters(items, "", { confidenceFlag: "low" }, null, NOW).map(i => i.id)).toEqual(["low"]);
  });

  it("sentNoReplyMinAgeMin requires sent>0, responded=0, and freshness ≥ threshold", () => {
    const items = [
      mk({ id: "stale", coverage: { sent: 3, responded: 0 }, freshnessMinutes: 240 }),
      mk({ id: "fresh", coverage: { sent: 3, responded: 0 }, freshnessMinutes: 60 }),
      mk({ id: "replied", coverage: { sent: 3, responded: 1 }, freshnessMinutes: 240 }),
      mk({ id: "unsent", coverage: { sent: 0, responded: 0 }, freshnessMinutes: 240 }),
    ];
    expect(applyCockpitFilters(items, "", { sentNoReplyMinAgeMin: 240 }, null, NOW).map(i => i.id)).toEqual(["stale"]);
  });

  it("filters compose (statuses + ownerScope + pickupWithinHours)", () => {
    const items = [
      mk({
        id: "match",
        opportunity: { status: "ready_to_send", pickupWindowStart: new Date(NOW + 6 * 3600_000).toISOString() },
        owner: { id: "u1" },
      }),
      mk({
        id: "wrongStatus",
        opportunity: { status: "covered", pickupWindowStart: new Date(NOW + 6 * 3600_000).toISOString() },
        owner: { id: "u1" },
      }),
      mk({
        id: "wrongOwner",
        opportunity: { status: "ready_to_send", pickupWindowStart: new Date(NOW + 6 * 3600_000).toISOString() },
        owner: { id: "u2" },
      }),
    ];
    expect(
      applyCockpitFilters(
        items,
        "",
        { statuses: ["ready_to_send"], ownerScope: "mine", pickupWithinHours: 24 },
        "u1",
        NOW,
      ).map(i => i.id),
    ).toEqual(["match"]);
  });
});
