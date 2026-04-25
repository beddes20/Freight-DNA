/**
 * Task #635 — Lane Cross-Link service unit tests.
 *
 * Covers:
 *   - laneSig canonicalization (case + whitespace + missing-state).
 *   - buildLwqContextByLaneSig joins recurring_lanes + outreach logs +
 *     interest replies and respects visibility scope.
 *   - buildOpenOppContextByLaneSig only counts OPEN opps generated today and
 *     groups by canonical lane signature.
 *   - AF row carries lwqContext when lane is in rep's LWQ.
 *   - LWQ row carries openOppCount > 0 when freight_opportunities exist.
 *   - Round-trip of cross-link query parameters.
 */

import { describe, it, expect } from "vitest";
import {
  laneSig,
  buildLwqContextByLaneSig,
  buildOpenOppContextByLaneSig,
  buildAfLaneQueryParam,
  buildLwqLaneQueryParam,
} from "../laneCrossLinkService";

// ── Tiny Drizzle-shaped fake ────────────────────────────────────────────────
//
// The service issues:
//   db.select({...}).from(table).where(...)                     [recurring_lanes]
//   db.select({...}).from(table).where(...).groupBy(...)        [outreach + replies + opps]
//
// We don't need real SQL — we just intercept .from() and return whatever the
// test seeded for that table.
type TableHandle = { _name?: string };

function fakeDb(rows: {
  recurringLanes: any[];
  carrierOutreachLogs: any[]; // pre-aggregated rows the service expects
  laneCarrierInterest: any[]; // pre-aggregated rows the service expects
  freightOpportunities: any[];
}) {
  // We tag table modules by reference identity using their underlying symbol —
  // but the service imports them from @shared/schema. The easiest way to
  // dispatch is to inspect the fields used in the projection (passed to
  // .select). Since tests run synchronously, we can stash the projection and
  // resolve by which table column object is referenced.
  function chain(getRows: () => any[]) {
    const builder: any = {
      from() { return builder; },
      where() { return builder; },
      groupBy() { return Promise.resolve(getRows()); },
      then(resolve: any, reject: any) {
        return Promise.resolve(getRows()).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    select(projection: Record<string, any>) {
      // The projection always references one of four tables via its column
      // objects. Each Drizzle column carries a `.table` reference at runtime.
      // We pluck the first column to read it.
      const firstCol: any = Object.values(projection)[0];
      const tableName = firstCol?.table?.[Symbol.for("drizzle:Name")]
        ?? firstCol?.table?.name
        ?? firstCol?.tableName
        ?? null;
      // Heuristic fallback: route by the names of projection fields the
      // service uses uniquely per query.
      const keys = Object.keys(projection);
      let target: keyof typeof rows;
      if (tableName === "recurring_lanes" || keys.includes("ownerUserId") && keys.includes("origin")) {
        target = "recurringLanes";
      } else if (tableName === "carrier_outreach_logs" || keys.includes("lastTouchAt")) {
        target = "carrierOutreachLogs";
      } else if (tableName === "lane_carrier_interest" || keys.includes("interestStatus")) {
        target = "laneCarrierInterest";
      } else if (tableName === "freight_opportunities" || keys.includes("pickupWindowStart")) {
        target = "freightOpportunities";
      } else {
        // Default to opportunities so unknown shapes don't silently return lane rows
        target = "freightOpportunities";
      }
      return chain(() => rows[target]);
    },
  } as any;
}

// ── laneSig ─────────────────────────────────────────────────────────────────

describe("laneSig", () => {
  it("normalizes case + whitespace consistently", () => {
    const a = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const b = laneSig("  chicago ", "il", "DALLAS", " tx ", "dry van");
    expect(a).toBe(b);
  });
  it("treats missing parts as empty string (deterministic)", () => {
    expect(laneSig("Chicago", null, "Dallas", null, null)).toBe("chicago||dallas||");
    expect(laneSig("Chicago", undefined, "Dallas", undefined, undefined))
      .toBe(laneSig("Chicago", null, "Dallas", null, null));
  });
  it("differs across lanes", () => {
    expect(laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van"))
      .not.toBe(laneSig("Chicago", "IL", "Atlanta", "GA", "Dry Van"));
  });
});

// ── buildLwqContextByLaneSig ────────────────────────────────────────────────

describe("buildLwqContextByLaneSig", () => {
  it("returns map keyed by canonical signature with last-touch + counts", async () => {
    const lane = {
      id: "lane-1",
      origin: "Chicago",
      originState: "IL",
      destination: "Dallas",
      destinationState: "TX",
      equipmentType: "Dry Van",
      ownerUserId: "rep-1",
      carriersContactedCount: 4,
    };
    const db = fakeDb({
      recurringLanes: [lane],
      carrierOutreachLogs: [
        { laneId: "lane-1", lastTouchAt: new Date("2026-04-25T18:00:00Z") },
      ],
      laneCarrierInterest: [
        { laneId: "lane-1", interestStatus: "available_now", replyCount: 1 },
        { laneId: "lane-1", interestStatus: "not_fit", replyCount: 2 },
        { laneId: "lane-1", interestStatus: "needs_follow_up", replyCount: 5 },
      ],
      freightOpportunities: [],
    });

    const map = await buildLwqContextByLaneSig(db, "org-1", ["rep-1"], false);
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const ctx = map.get(sig);
    expect(ctx).toBeDefined();
    expect(ctx!.laneId).toBe("lane-1");
    expect(ctx!.contactedCount).toBe(4);
    expect(ctx!.replyCount).toBe(3); // available_now + not_fit; excludes needs_follow_up
    expect(ctx!.hotReplyCount).toBe(1); // available_now only
    expect(ctx!.lastTouchAt).toBe("2026-04-25T18:00:00.000Z");
  });

  it("filters lanes by visibility scope", async () => {
    const ownedLane = {
      id: "lane-owned",
      origin: "Chicago", originState: "IL",
      destination: "Dallas", destinationState: "TX",
      equipmentType: "Dry Van",
      ownerUserId: "rep-1",
      carriersContactedCount: 2,
    };
    const otherLane = {
      ...ownedLane,
      id: "lane-other",
      origin: "Atlanta", originState: "GA",
      destination: "Miami", destinationState: "FL",
      ownerUserId: "rep-2",
    };
    const unassignedLane = {
      ...ownedLane,
      id: "lane-unassigned",
      origin: "Memphis", originState: "TN",
      destination: "Houston", destinationState: "TX",
      ownerUserId: null,
    };

    const baseDb = (canSeeUnassigned: boolean) => fakeDb({
      recurringLanes: [ownedLane, otherLane, unassignedLane],
      carrierOutreachLogs: [],
      laneCarrierInterest: [],
      freightOpportunities: [],
    });

    const repOnly = await buildLwqContextByLaneSig(baseDb(false), "org-1", ["rep-1"], false);
    expect(repOnly.size).toBe(1);
    expect(repOnly.has(laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van"))).toBe(true);

    const withUnassigned = await buildLwqContextByLaneSig(baseDb(true), "org-1", ["rep-1"], true);
    expect(withUnassigned.size).toBe(2);
    expect(withUnassigned.has(laneSig("Memphis", "TN", "Houston", "TX", "Dry Van"))).toBe(true);
  });

  it("AF row carries lwqContext when its lane is in the rep's LWQ", async () => {
    // Simulates the AF-side merge: an opp with this signature should match
    // the LWQ context the cockpit endpoint will join in.
    const lane = {
      id: "lane-A",
      origin: "Chicago", originState: "IL",
      destination: "Dallas", destinationState: "TX",
      equipmentType: "Dry Van",
      ownerUserId: "rep-1",
      carriersContactedCount: 3,
    };
    const db = fakeDb({
      recurringLanes: [lane],
      carrierOutreachLogs: [{ laneId: "lane-A", lastTouchAt: new Date() }],
      laneCarrierInterest: [],
      freightOpportunities: [],
    });
    const map = await buildLwqContextByLaneSig(db, "org-1", ["rep-1"], false);

    const opp = {
      origin: "chicago", originState: "il",
      destination: "DALLAS", destinationState: "TX",
      equipmentType: "Dry Van",
    };
    const oppSig = laneSig(opp.origin, opp.originState, opp.destination, opp.destinationState, opp.equipmentType);
    const ctx = map.get(oppSig);
    expect(ctx).toBeDefined();
    expect(ctx!.laneId).toBe("lane-A");
    expect(ctx!.contactedCount).toBe(3);
  });
});

// ── buildOpenOppContextByLaneSig ────────────────────────────────────────────

describe("buildOpenOppContextByLaneSig", () => {
  it("LWQ row carries openOppCount > 0 when matching opps exist today", async () => {
    const now = new Date("2026-04-25T20:00:00Z");
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");

    const db = fakeDb({
      recurringLanes: [],
      carrierOutreachLogs: [],
      laneCarrierInterest: [],
      freightOpportunities: [
        {
          id: "opp-1",
          origin: "Chicago", originState: "IL",
          destination: "Dallas", destinationState: "TX",
          equipmentType: "Dry Van",
          pickupWindowStart: "2026-04-26T14:00:00Z",
          loadCount: 2,
          generatedAt: new Date("2026-04-25T08:00:00Z"),
          status: "ready_to_send",
        },
        {
          id: "opp-2",
          origin: "chicago", originState: "il",
          destination: "dallas", destinationState: "tx",
          equipmentType: "Dry Van",
          pickupWindowStart: "2026-04-25T22:00:00Z",
          loadCount: 1,
          generatedAt: new Date("2026-04-25T16:00:00Z"),
          status: "sent",
        },
      ],
    });

    const map = await buildOpenOppContextByLaneSig(db, "org-1", { now });
    const ctx = map.get(sig);
    expect(ctx).toBeDefined();
    expect(ctx!.count).toBe(2);
    expect(ctx!.totalLoads).toBe(3);
    expect(ctx!.nextPickupAt).toBe("2026-04-25T22:00:00Z"); // earlier of the two
    expect(ctx!.sampleOppId).toBe("opp-1");
  });

  it("groups by canonical signature regardless of case/whitespace", async () => {
    const now = new Date();
    const db = fakeDb({
      recurringLanes: [], carrierOutreachLogs: [], laneCarrierInterest: [],
      freightOpportunities: [
        { id: "a", origin: "Chicago", originState: "IL", destination: "Dallas", destinationState: "TX", equipmentType: "Dry Van", pickupWindowStart: "2026-04-26T14:00:00Z", loadCount: 1, generatedAt: now, status: "new" },
        { id: "b", origin: " CHICAGO ", originState: "il", destination: "dallas", destinationState: " TX ", equipmentType: "DRY VAN", pickupWindowStart: "2026-04-26T15:00:00Z", loadCount: 2, generatedAt: now, status: "new" },
      ],
    });
    const map = await buildOpenOppContextByLaneSig(db, "org-1", { now });
    expect(map.size).toBe(1);
    const ctx = map.get(laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van"))!;
    expect(ctx.count).toBe(2);
    expect(ctx.totalLoads).toBe(3);
  });
});

// ── Round-trip of deep-link parameters ──────────────────────────────────────

describe("cross-link deep-link round-trip", () => {
  it("AF→LWQ uses laneId, LWQ→AF uses lane signature; both are URL-safe", () => {
    const sig = laneSig("New York", "NY", "Newark", "NJ", "Reefer");
    const afParam = buildAfLaneQueryParam(sig);
    const lwqParam = buildLwqLaneQueryParam("lane-xyz-123");

    expect(afParam).toBe(`lane=${encodeURIComponent(sig)}`);
    expect(lwqParam).toBe(`laneId=lane-xyz-123`);

    // Round-trip through URLSearchParams to confirm the chip's URL parses
    // back into the same identifier each surface expects.
    const afUrl = new URL(`https://example.com/available-freight?${afParam}`);
    expect(afUrl.searchParams.get("lane")).toBe(sig);

    const lwqUrl = new URL(`https://example.com/lanes/work-queue?${lwqParam}`);
    expect(lwqUrl.searchParams.get("laneId")).toBe("lane-xyz-123");
  });
});
