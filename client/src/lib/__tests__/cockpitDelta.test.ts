import { describe, it, expect } from "vitest";
import { countCockpitDelta } from "@/pages/available-freight";

type Item = Parameters<typeof countCockpitDelta>[0][number];

function mk(id: string, overrides: Partial<{ status: string; level: Item["urgency"]["level"]; responded: number }> = {}): Item {
  return {
    opportunity: {
      id,
      origin: "Chicago",
      originState: "IL",
      destination: "Atlanta",
      destinationState: "GA",
      equipmentType: "DRY",
      pickupWindowStart: null,
      pickupWindowEnd: null,
      status: overrides.status ?? "ready_to_send",
    } as Item["opportunity"],
    chips: [] as Item["chips"],
    coverage: { sent: 0, responded: overrides.responded ?? 0, covered: false } as Item["coverage"],
    suggestedBuy: null,
    urgency: { score: 50, level: overrides.level ?? "medium", reasons: [] },
    freshnessMinutes: 0,
    groupKey: "all",
    customer: null,
    owner: null,
    sla: { level: null, ageMinutes: null },
    laneScore: null,
  } as unknown as Item;
}

describe("countCockpitDelta", () => {
  it("returns 0 when feeds are identical by id, status, urgency, and replies", () => {
    const a = [mk("o1"), mk("o2")];
    const b = [mk("o1"), mk("o2")];
    expect(countCockpitDelta(a, b)).toBe(0);
  });

  it("counts an added opportunity", () => {
    const prev = [mk("o1")];
    const next = [mk("o1"), mk("o2")];
    expect(countCockpitDelta(prev, next)).toBe(1);
  });

  it("counts a removed opportunity", () => {
    const prev = [mk("o1"), mk("o2")];
    const next = [mk("o1")];
    expect(countCockpitDelta(prev, next)).toBe(1);
  });

  it("counts a status change", () => {
    const prev = [mk("o1", { status: "ready_to_send" })];
    const next = [mk("o1", { status: "covered" })];
    expect(countCockpitDelta(prev, next)).toBe(1);
  });

  it("counts an urgency level change", () => {
    const prev = [mk("o1", { level: "medium" })];
    const next = [mk("o1", { level: "critical" })];
    expect(countCockpitDelta(prev, next)).toBe(1);
  });

  it("counts a new carrier reply", () => {
    const prev = [mk("o1", { responded: 0 })];
    const next = [mk("o1", { responded: 1 })];
    expect(countCockpitDelta(prev, next)).toBe(1);
  });

  it("aggregates across multiple kinds of changes", () => {
    const prev = [mk("o1"), mk("o2"), mk("o3")];
    const next = [
      mk("o1", { responded: 2 }),
      mk("o3", { status: "covered" }),
      mk("o4"),
    ];
    // o1 reply++ , o3 status change, o4 added, o2 removed = 4
    expect(countCockpitDelta(prev, next)).toBe(4);
  });
});
