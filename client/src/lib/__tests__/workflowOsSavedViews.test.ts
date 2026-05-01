// Workflow OS — saved view round-trip + Zod schema contract.

import { describe, it, expect } from "vitest";
import {
  serializeFiltersToUrl,
  deserializeFiltersFromUrl,
  myWorkTodayView,
  sharedFiltersSchema,
  type SharedFilters,
} from "@/lib/workflow-os/savedViews";

const ALL_KEYS_SAMPLE: SharedFilters = {
  owner: "me",
  customer: "acme",
  status: "ready_to_send",
  pickupScope: "actionable",
  sort: "pickup_soonest",
  group: "by_owner",
  q: "atlanta",
  surfaceSpecific: {
    af: { confidence: "high", page: 2 },
  },
};

describe("savedViews round-trip", () => {
  it("serializes and deserializes every canonical key losslessly", () => {
    const params = serializeFiltersToUrl(ALL_KEYS_SAMPLE);
    const round = deserializeFiltersFromUrl(params);
    expect(round.owner).toBe("me");
    expect(round.customer).toBe("acme");
    expect(round.status).toBe("ready_to_send");
    expect(round.pickupScope).toBe("actionable");
    expect(round.sort).toBe("pickup_soonest");
    expect(round.group).toBe("by_owner");
    expect(round.q).toBe("atlanta");
    expect(round.surfaceSpecific?.af.confidence).toBe("high");
    expect(round.surfaceSpecific?.af.page).toBe(2);
  });

  it("encodes { specificUserId } as 'specific:<id>' and decodes back", () => {
    const filters: SharedFilters = { owner: { specificUserId: "user-42" } };
    const params = serializeFiltersToUrl(filters);
    expect(params.get("owner")).toBe("specific:user-42");
    const round = deserializeFiltersFromUrl(params);
    expect(round.owner).toEqual({ specificUserId: "user-42" });
  });

  it("ignores unknown query keys without throwing", () => {
    const params = new URLSearchParams("foo=bar&owner=all");
    const round = deserializeFiltersFromUrl(params);
    expect(round.owner).toBe("all");
  });

  it("rejects invalid pickupScope values", () => {
    const params = new URLSearchParams("pickupScope=tomorrow");
    const round = deserializeFiltersFromUrl(params);
    expect(round.pickupScope).toBeUndefined();
  });

  it("Zod schema accepts the canonical sample", () => {
    expect(() => sharedFiltersSchema.parse(ALL_KEYS_SAMPLE)).not.toThrow();
  });

  it("Zod schema rejects an invalid pickupScope literal", () => {
    expect(() =>
      sharedFiltersSchema.parse({ pickupScope: "tomorrow" }),
    ).toThrow();
  });
});

describe("myWorkTodayView", () => {
  it("returns the documented built-in saved view", () => {
    expect(myWorkTodayView()).toEqual({
      owner: "me",
      pickupScope: "actionable",
      sort: "pickup_soonest",
    });
  });
});
