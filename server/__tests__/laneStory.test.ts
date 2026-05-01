/**
 * Task #873 — Lane Story service unit tests.
 *
 * Covers the five behaviors that make Lane Story trustworthy:
 *   1. parseLaneSignature canonicalizes round-trips with laneSig and rejects
 *      obviously-malformed input.
 *   2. findRecurringLanesBySig + buildLaneStoryHeader picks the canonical
 *      lane (highest score), computes liveOppCount only for matching opps,
 *      and derives laneHealth.
 *   3. buildLaneStoryTimeline merges AF audit + outreach + quote events,
 *      drops rows whose lane signature does not match, and returns them
 *      newest-first.
 *   4. buildLaneStoryOutcomes30d aggregates covers + GM + quote outcomes
 *      + outreach waves/replies/distinct-carriers in the trailing-30d window.
 *   5. groupLaneInboxBySig groups a flat inbox feed by canonical signature,
 *      keeps only the last N events per lane, and sorts buckets newest-first.
 */

import { describe, it, expect } from "vitest";
import {
  recurringLanes,
  freightOpportunities,
  freightOpportunityAudit,
  carrierOutreachLogs,
  quoteEvents,
  quoteOpportunities,
  quoteCustomers,
  loadFact,
  users,
} from "@shared/schema";
import {
  parseLaneSignature,
  findRecurringLanesBySig,
  buildLaneStoryHeader,
  buildLaneStoryTimeline,
  buildLaneStoryOutcomes30d,
  groupLaneInboxBySig,
} from "../services/laneStory";
import { laneSig } from "../laneCrossLinkService";

// ── Tiny Drizzle-shaped fake ────────────────────────────────────────────────
//
// The service uses a small surface area: select([projection]).from(table)
// with optional .where/.innerJoin/.leftJoin/.orderBy/.limit chains. We
// dispatch by the table reference handed to from(), pulling rows from the
// matching seed bucket. db.execute(sql`...`) is stubbed to return the seeded
// `lane_carrier_interest` count (used by buildLaneStoryHeader).
type Seed = Partial<Record<string, any[]>> & {
  lane_carrier_interest_count?: number;
};

const tableName = (t: any): string | null =>
  t?.[Symbol.for("drizzle:Name")] ?? t?.name ?? t?.tableName ?? null;

function fakeDb(seed: Seed) {
  function builder() {
    let target: string | null = null;
    const resolveRows = () => (target ? (seed as any)[target] ?? [] : []);
    const obj: any = {
      from(t: any) { target = tableName(t); return obj; },
      where() { return obj; },
      innerJoin() { return obj; },
      leftJoin() { return obj; },
      orderBy() { return obj; },
      limit() { return Promise.resolve(resolveRows()); },
      groupBy() { return Promise.resolve(resolveRows()); },
      then(resolve: any, reject: any) {
        return Promise.resolve(resolveRows()).then(resolve, reject);
      },
    };
    return obj;
  }
  return {
    select(_projection?: any) { return builder(); },
    execute(_sqlInst: any) {
      return Promise.resolve({ rows: [{ count: seed.lane_carrier_interest_count ?? 0 }] });
    },
  } as any;
}

// ── 1. parseLaneSignature ───────────────────────────────────────────────────

describe("parseLaneSignature", () => {
  it("round-trips with laneSig (canonical 5-part key)", () => {
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const parts = parseLaneSignature(sig);
    expect(parts).toEqual({
      origin: "chicago",
      originState: "il",
      destination: "dallas",
      destinationState: "tx",
      equipmentType: "dry van",
    });
  });
  it("rejects malformed signatures (wrong part count or non-string)", () => {
    expect(parseLaneSignature("a|b|c")).toBeNull();
    expect(parseLaneSignature("only-one")).toBeNull();
    expect(parseLaneSignature(undefined as any)).toBeNull();
  });
  it("preserves empty parts when state/equipment are missing", () => {
    const sig = laneSig("Chicago", null, "Dallas", null, null);
    const parts = parseLaneSignature(sig);
    expect(parts).toEqual({
      origin: "chicago",
      originState: "",
      destination: "dallas",
      destinationState: "",
      equipmentType: "",
    });
  });
});

// ── 2. findRecurringLanesBySig + buildLaneStoryHeader ───────────────────────

describe("buildLaneStoryHeader", () => {
  it("picks the canonical lane (highest score), counts only signature-matching live opps, derives health", async () => {
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const now = new Date("2026-04-25T20:00:00Z");

    const lanes = [
      {
        id: "lane-low",
        orgId: "org-1",
        origin: "Chicago", originState: "IL",
        destination: "Dallas", destinationState: "TX",
        equipmentType: "Dry Van",
        ownerUserId: "rep-1",
        companyId: "co-1", companyName: "Acme Foods",
        carriersContactedCount: 5,
        laneScore: 50,
        laneScoreFactors: null,
        createdAt: new Date("2026-04-01T00:00:00Z"),
      },
      {
        id: "lane-best",
        orgId: "org-1",
        origin: "chicago", originState: "il",
        destination: "DALLAS", destinationState: "tx",
        equipmentType: "Dry Van",
        ownerUserId: "rep-1",
        companyId: "co-1", companyName: "Acme Foods",
        carriersContactedCount: 4,
        laneScore: 82,
        laneScoreFactors: { foo: 1 },
        createdAt: new Date("2026-04-02T00:00:00Z"),
      },
      // Different lane that won't match the signature.
      {
        id: "lane-other",
        orgId: "org-1",
        origin: "Atlanta", originState: "GA",
        destination: "Miami", destinationState: "FL",
        equipmentType: "Reefer",
        ownerUserId: "rep-2",
        companyId: null, companyName: null,
        carriersContactedCount: 1,
        laneScore: 90,
        laneScoreFactors: null,
        createdAt: new Date("2026-04-03T00:00:00Z"),
      },
    ];
    const db = fakeDb({
      recurring_lanes: lanes,
      users: [{ id: "rep-1", name: "Rep One" }],
      freight_opportunities: [
        // matches signature (case-insensitive)
        {
          id: "opp-1",
          origin: "Chicago", originState: "IL",
          destination: "Dallas", destinationState: "TX",
          equipmentType: "Dry Van",
          generatedAt: new Date("2026-04-25T15:00:00Z"),
        },
        {
          id: "opp-2",
          origin: " chicago ", originState: " il ",
          destination: "DALLAS", destinationState: "TX",
          equipmentType: "DRY VAN",
          generatedAt: new Date("2026-04-25T19:30:00Z"),
        },
        // does NOT match
        {
          id: "opp-x",
          origin: "Atlanta", originState: "GA",
          destination: "Miami", destinationState: "FL",
          equipmentType: "Reefer",
          generatedAt: new Date("2026-04-25T18:00:00Z"),
        },
      ],
      lane_carrier_interest_count: 2,
    });

    const matched = await findRecurringLanesBySig(db, "org-1", sig);
    expect(matched.map((l) => l.id).sort()).toEqual(["lane-best", "lane-low"]);

    const header = await buildLaneStoryHeader(db, "org-1", sig, matched as any, now);
    expect(header.laneId).toBe("lane-best"); // higher score wins tiebreak
    expect(header.ownerName).toBe("Rep One");
    expect(header.liveOppCount).toBe(2); // signature filter dropped opp-x
    expect(header.contactableCount).toBe(2);
    expect(header.freshnessMinutes).toBe(30); // newest opp at 19:30 vs now 20:00
    expect(header.laneHealth).toBe("healthy"); // contacted 4 + score 82
    expect(header.carriersContactedCount).toBe(4);
    expect(header.companyName).toBe("Acme Foods");
  });
});

// ── 3. buildLaneStoryTimeline ───────────────────────────────────────────────

describe("buildLaneStoryTimeline", () => {
  it("merges AF + outreach + quote events, drops mismatched signatures, sorts newest-first", async () => {
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const db = fakeDb({
      freight_opportunity_audit: [
        // matches
        {
          id: "af-1",
          eventType: "approved",
          createdAt: new Date("2026-04-25T10:00:00Z"),
          opportunityId: "opp-1",
          actorUserId: "rep-1",
          payload: { note: "approved" },
          origin: "Chicago", originState: "IL",
          destination: "Dallas", destinationState: "TX",
          equipmentType: "Dry Van",
        },
        // mismatched lane — must be filtered
        {
          id: "af-x",
          eventType: "expired",
          createdAt: new Date("2026-04-25T11:00:00Z"),
          opportunityId: "opp-x",
          actorUserId: null,
          payload: null,
          origin: "Atlanta", originState: "GA",
          destination: "Miami", destinationState: "FL",
          equipmentType: "Reefer",
        },
      ],
      carrier_outreach_logs: [
        {
          id: "out-1",
          laneId: "lane-1",
          timestamp: new Date("2026-04-25T12:00:00Z"),
          sentAt: new Date("2026-04-25T12:00:00Z"),
          replyReceivedAt: null,
          outreachMode: "individual",
          direction: "outbound",
          carrierNames: ["RoadRunners", "BlueLine"],
          actorUserId: "rep-1",
          replySnippet: null,
          bodyPreview: null,
        },
        {
          id: "out-2",
          laneId: "lane-1",
          timestamp: new Date("2026-04-25T14:00:00Z"),
          sentAt: null,
          replyReceivedAt: new Date("2026-04-25T14:00:00Z"),
          outreachMode: "individual",
          direction: "inbound",
          carrierNames: ["RoadRunners"],
          actorUserId: null,
          replySnippet: "Yes, available tomorrow",
          bodyPreview: null,
        },
      ],
      quote_events: [
        {
          id: "qe-1",
          quoteId: "q-1",
          eventType: "won",
          occurredAt: new Date("2026-04-25T16:00:00Z"),
          payload: null,
          originCity: "Chicago", originState: "IL",
          destCity: "Dallas", destState: "TX",
          equipment: "Dry Van",
          customerName: "Acme",
        },
        // mismatched
        {
          id: "qe-x",
          quoteId: "q-x",
          eventType: "lost",
          occurredAt: new Date("2026-04-25T17:00:00Z"),
          payload: null,
          originCity: "Atlanta", originState: "GA",
          destCity: "Miami", destState: "FL",
          equipment: "Reefer",
          customerName: "Other",
        },
      ],
    });

    const tl = await buildLaneStoryTimeline(db, "org-1", sig, ["lane-1"], null);
    const ids = tl.events.map((e) => e.id);

    // The mismatched AF + quote rows are dropped. The matching AF + both
    // outreach rows + the matching quote should remain (4 events).
    expect(ids).toContain("af:af-1");
    expect(ids).toContain("outreach:out-1");
    expect(ids).toContain("outreach:out-2");
    expect(ids).toContain("quote:qe-1");
    expect(ids).not.toContain("af:af-x");
    expect(ids).not.toContain("quote:qe-x");

    // Newest-first ordering — qe-1 at 16:00 is the most recent.
    expect(tl.events[0].id).toBe("quote:qe-1");
    // Surface tagging on outreach: reply must surface as carrier_hub.
    const reply = tl.events.find((e) => e.id === "outreach:out-2")!;
    expect(reply.surface).toBe("carrier_hub");
    expect(reply.kind).toBe("reply");
    // Page fits in TIMELINE_PAGE_SIZE (50), so no nextCursor.
    expect(tl.nextCursor).toBeNull();
  });
});

// ── 4. buildLaneStoryOutcomes30d ────────────────────────────────────────────

describe("buildLaneStoryOutcomes30d", () => {
  it("aggregates covers + GM + quote outcomes + outreach waves/replies/distinct carriers in the trailing-30d window", async () => {
    const sig = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const now = new Date("2026-04-25T20:00:00Z");
    const db = fakeDb({
      load_fact: [
        // realized cover with explicit margin
        {
          id: "f-1",
          originCity: "Chicago", originState: "IL",
          destinationCity: "Dallas", destinationState: "TX",
          equipmentType: "Dry Van",
          revenue: "5000.00", cost: "4000.00", margin: "1000.00",
          bucket: "realized",
          lastChangedAt: new Date("2026-04-20T00:00:00Z"),
        },
        // active cover, margin computed from rev−cost
        {
          id: "f-2",
          originCity: " chicago ", originState: "il",
          destinationCity: "DALLAS", destinationState: "TX",
          equipmentType: "Dry Van",
          revenue: "3500.00", cost: "3000.00", margin: null,
          bucket: "active",
          lastChangedAt: new Date("2026-04-22T00:00:00Z"),
        },
        // quoted (not realized/active) — must be ignored for covers
        {
          id: "f-3",
          originCity: "Chicago", originState: "IL",
          destinationCity: "Dallas", destinationState: "TX",
          equipmentType: "Dry Van",
          revenue: "1000", cost: "900", margin: "100",
          bucket: "quoted",
          lastChangedAt: new Date("2026-04-22T00:00:00Z"),
        },
        // mismatched lane — ignored
        {
          id: "f-x",
          originCity: "Atlanta", originState: "GA",
          destinationCity: "Miami", destinationState: "FL",
          equipmentType: "Reefer",
          revenue: "9000", cost: "5000", margin: "4000",
          bucket: "realized",
          lastChangedAt: new Date("2026-04-22T00:00:00Z"),
        },
      ],
      quote_events: [
        {
          eventType: "won", occurredAt: new Date("2026-04-21T00:00:00Z"),
          originCity: "Chicago", originState: "IL",
          destCity: "Dallas", destState: "TX",
          equipment: "Dry Van",
        },
        {
          eventType: "lost", occurredAt: new Date("2026-04-22T00:00:00Z"),
          originCity: "Chicago", originState: "IL",
          destCity: "Dallas", destState: "TX",
          equipment: "Dry Van",
        },
        {
          eventType: "lost", occurredAt: new Date("2026-04-22T00:00:00Z"),
          originCity: "Atlanta", originState: "GA",
          destCity: "Miami", destState: "FL",
          equipment: "Reefer",
        },
      ],
      carrier_outreach_logs: [
        {
          id: "o-1",
          sentAt: new Date("2026-04-20T00:00:00Z"),
          replyReceivedAt: null,
          carrierIds: ["c-1", "c-2"],
        },
        {
          id: "o-2",
          sentAt: new Date("2026-04-21T00:00:00Z"),
          replyReceivedAt: new Date("2026-04-22T00:00:00Z"),
          carrierIds: ["c-2", "c-3"], // c-2 dedup'd
        },
        {
          id: "o-3",
          sentAt: null, // not a wave; reply only
          replyReceivedAt: new Date("2026-04-23T00:00:00Z"),
          carrierIds: [],
        },
      ],
    });

    const out = await buildLaneStoryOutcomes30d(db, "org-1", sig, ["lane-1"], now);
    expect(out.covers.count).toBe(2); // f-1 + f-2 (f-3 wrong bucket; f-x mismatch)
    expect(out.covers.combinedGrossMargin).toBe(1500); // 1000 + (3500-3000)
    expect(out.quotes.won).toBe(1);
    expect(out.quotes.lost).toBe(1);
    expect(out.outreachWaves).toBe(2); // o-1 + o-2 (o-3 has no sentAt)
    expect(out.carrierReplies).toBe(2); // o-2 + o-3
    expect(out.distinctCarriersContacted).toBe(3); // c-1, c-2, c-3
    expect(new Date(out.windowEnd).toISOString()).toBe(now.toISOString());
  });
});

// ── 5. groupLaneInboxBySig ──────────────────────────────────────────────────

describe("groupLaneInboxBySig", () => {
  it("groups rows by canonical signature, keeps only last N per lane, sorts buckets newest-first", () => {
    const make = (overrides: Partial<any>) => ({
      id: "x",
      surface: "available_freight",
      kind: "approved",
      title: "Opp approved",
      subtitle: "",
      occurredAt: "2026-04-20T00:00:00Z",
      deepLink: "/x",
      lane: "Chicago, IL → Dallas, TX",
      refId: null,
      origin: "Chicago", originState: "IL",
      destination: "Dallas", destinationState: "TX",
      equipmentType: "Dry Van",
      ...overrides,
    });
    const rows = [
      make({ id: "r1", occurredAt: "2026-04-20T00:00:00Z" }),
      make({ id: "r2", occurredAt: "2026-04-22T00:00:00Z" }),
      make({ id: "r3", occurredAt: "2026-04-21T00:00:00Z" }),
      make({ id: "r4", occurredAt: "2026-04-23T00:00:00Z" }),
      // a different lane — should land in its own bucket
      make({
        id: "r5",
        occurredAt: "2026-04-19T00:00:00Z",
        origin: "Atlanta", originState: "GA",
        destination: "Miami", destinationState: "FL",
        equipmentType: "Reefer",
        lane: "Atlanta, GA → Miami, FL",
      }),
      // empty-signature row (no lane parts) — must be skipped
      make({
        id: "r-skip",
        origin: null, originState: null,
        destination: null, destinationState: null,
        equipmentType: null,
        lane: null,
      }),
    ];
    const sigChi = laneSig("Chicago", "IL", "Dallas", "TX", "Dry Van");
    const meta = new Map<string, { laneId: string | null; companyName: string | null; ownerName: string | null }>([
      [sigChi, { laneId: "lane-1", companyName: "Acme", ownerName: "Rep One" }],
    ]);

    const groups = groupLaneInboxBySig(rows, meta, 3);
    expect(groups).toHaveLength(2);

    // First bucket is the one with the most recent event (Chicago→Dallas r4).
    const chi = groups[0];
    expect(chi.laneSignature).toBe(sigChi);
    expect(chi.laneId).toBe("lane-1");
    expect(chi.companyName).toBe("Acme");
    expect(chi.totalEvents).toBe(4);
    expect(chi.events).toHaveLength(3); // keepLast=3
    // Newest 3, in newest-first order: r4, r2, r3
    expect(chi.events.map((e) => e.id)).toEqual(["r4", "r2", "r3"]);
    expect(chi.mostRecentAt).toBe("2026-04-23T00:00:00Z");
    expect(chi.storyHref).toBe(`/lanes/story/${encodeURIComponent(sigChi)}`);

    const atl = groups[1];
    expect(atl.events.map((e) => e.id)).toEqual(["r5"]);
    expect(atl.totalEvents).toBe(1);
  });
});
