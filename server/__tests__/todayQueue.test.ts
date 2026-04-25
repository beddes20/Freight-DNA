/**
 * Task #639 — Today queue aggregator tests.
 *
 * Two layers of coverage:
 *   1. Pure ranker (tier multiplier, time decay, hot-reply floor, sorting)
 *   2. Composer integration (snooze hide/re-surface, source diversity,
 *      end-to-end priority ordering, pagination) via composeTodayQueue
 *
 * The composer is the seam through which getTodayQueue assembles its result;
 * exercising it with synthetic source pulls lets us verify the integration
 * logic (snooze filter, tier lookup, ranking, pagination, bySource counts)
 * without standing up a real DB.
 */

import { describe, it, expect, vi } from "vitest";

// The aggregator imports computeCockpitUrgency from freightOpportunityCockpit,
// which transitively pulls proactiveOpportunityService → CARRIER_DAILY_BUDGET_CONFIG.
// Stub the export so module init succeeds without opening a real DB connection.
vi.mock("../storage", () => ({
  db: {},
  storage: {},
  CARRIER_DAILY_BUDGET_CONFIG: {
    dailyCap: 5,
    minGapHours: 24,
  },
}));

import {
  composeTodayQueue,
  rankTodayItems,
  rankerScore,
  tierMultiplier,
  timeDecayMultiplier,
  type TodayQueueItem,
} from "../services/todayQueue";

// Test-local extension: the ranker reads `customerTier` off items but our
// public TodayQueueItem shape doesn't carry it (it's joined in by the
// composer). The factory below accepts it explicitly so we can test ranking
// in isolation without `as any` casts.
type RankerInputItem = TodayQueueItem & { customerTier?: string | null };

interface MakeItemArgs {
  source: TodayQueueItem["source"];
  urgencyScore: number;
  ageMinutes: number | null;
  customerName?: string | null;
  customerTier?: string | null;
  id?: string;
  /** Default true for hot_reply rows (so the existing tests keep their
   *  "replies always float" semantics); explicit false exercises the
   *  non-hot reply codepath. */
  isHotReply?: boolean;
}

function makeItem(over: MakeItemArgs): RankerInputItem {
  return {
    id: over.id ?? `${over.source}:${over.customerName ?? "x"}-${over.urgencyScore}-${over.ageMinutes}`,
    source: over.source,
    sourceId: over.customerName ?? "x",
    summary: "stub",
    urgencyScore: over.urgencyScore,
    urgencyLevel: "medium",
    priorityScore: 0,
    reason: "stub reason",
    primaryActionLabel: "Go",
    primaryAction: "send_wave",
    deepLink: "/x",
    customerName: over.customerName ?? null,
    ageMinutes: over.ageMinutes,
    customerTier: over.customerTier ?? null,
    isHotReply: over.isHotReply ?? (over.source === "hot_reply"),
  };
}


describe("tierMultiplier", () => {
  it("scales platinum > gold > silver > bronze, with 1.0 fallback", () => {
    expect(tierMultiplier("platinum")).toBeCloseTo(1.30);
    expect(tierMultiplier("gold")).toBeCloseTo(1.15);
    expect(tierMultiplier("silver")).toBeCloseTo(1.05);
    expect(tierMultiplier("bronze")).toBeCloseTo(0.95);
    expect(tierMultiplier(null)).toBe(1.0);
    expect(tierMultiplier("")).toBe(1.0);
    expect(tierMultiplier("UNKNOWN")).toBe(1.0);
    // case-insensitive
    expect(tierMultiplier("PLATINUM")).toBeCloseTo(1.30);
  });
});


describe("timeDecayMultiplier", () => {
  it("returns 1.0 for the first hour and floors at 0.4 after 72h", () => {
    expect(timeDecayMultiplier(null)).toBe(1.0);
    expect(timeDecayMultiplier(0)).toBe(1.0);
    expect(timeDecayMultiplier(60)).toBe(1.0);
    // Mid-window: between 1.0 and 0.6
    const mid = timeDecayMultiplier(12 * 60);
    expect(mid).toBeLessThan(1.0);
    expect(mid).toBeGreaterThan(0.6);
    // 24h+ → 0.6 exactly at the boundary
    expect(timeDecayMultiplier(24 * 60)).toBeCloseTo(0.6, 1);
    // 72h floors to 0.4
    expect(timeDecayMultiplier(72 * 60)).toBeCloseTo(0.4, 1);
    expect(timeDecayMultiplier(7 * 24 * 60)).toBe(0.4);
  });

  it("decays monotonically", () => {
    const prev = timeDecayMultiplier(60);
    const next = timeDecayMultiplier(8 * 60);
    expect(next).toBeLessThan(prev);
  });
});


describe("rankerScore — composite formula", () => {
  it("multiplies tier × urgency × decay for non-reply sources", () => {
    const score = rankerScore({
      source: "lwq",
      urgencyScore: 50,
      customerTier: "platinum",
      ageMinutes: 0,
    });
    // 50 * 1.30 * 1.0 = 65
    expect(score).toBeCloseTo(65, 5);
  });

  it("adds the +1000 floor for high-priority hot replies so they always outrank others", () => {
    const reply = rankerScore({
      source: "hot_reply",
      urgencyScore: 30,           // even a "low" urgency reply
      customerTier: "bronze",     // even a low-tier customer
      ageMinutes: 60 * 24 * 5,    // even very stale
      isHotReply: true,           // ← high-priority thread
    });
    const critical = rankerScore({
      source: "freight_opp",
      urgencyScore: 100,          // max urgency
      customerTier: "platinum",   // top tier
      ageMinutes: 0,              // brand-new
    });
    expect(reply).toBeGreaterThan(critical);
    // floor must be approximately +1000
    expect(reply).toBeGreaterThanOrEqual(1000);
  });

  it("does NOT apply the +1000 floor to normal/low-priority reply threads", () => {
    // Normal-priority reply (isHotReply=false) ranks on the same scale as
    // the other sources — a critical freight opp must outrank it.
    const lukewarmReply = rankerScore({
      source: "hot_reply",
      urgencyScore: 50,
      customerTier: "gold",
      ageMinutes: 30,
      isHotReply: false,
    });
    const criticalOpp = rankerScore({
      source: "freight_opp",
      urgencyScore: 100,
      customerTier: "platinum",
      ageMinutes: 0,
    });
    expect(criticalOpp).toBeGreaterThan(lukewarmReply);
    // No floor was applied — score is the plain composite (well below 1000)
    expect(lukewarmReply).toBeLessThan(200);
  });

  it("ranks platinum above bronze when urgency and decay are equal", () => {
    const platinum = rankerScore({ source: "lwq", urgencyScore: 50, customerTier: "platinum", ageMinutes: 0 });
    const bronze   = rankerScore({ source: "lwq", urgencyScore: 50, customerTier: "bronze",   ageMinutes: 0 });
    expect(platinum).toBeGreaterThan(bronze);
  });

  it("penalizes stale items vs fresh items at the same urgency/tier", () => {
    const fresh = rankerScore({ source: "lwq", urgencyScore: 50, customerTier: null, ageMinutes: 30 });
    const stale = rankerScore({ source: "lwq", urgencyScore: 50, customerTier: null, ageMinutes: 72 * 60 });
    expect(fresh).toBeGreaterThan(stale);
  });
});


describe("rankTodayItems — list sorting", () => {
  it("returns items sorted by descending priority", () => {
    const items = [
      makeItem({ source: "lwq",         urgencyScore: 30, ageMinutes: 60 * 24, customerName: "C1", customerTier: "bronze"   }),
      makeItem({ source: "freight_opp", urgencyScore: 80, ageMinutes: 0,        customerName: "C2", customerTier: "platinum" }),
      makeItem({ source: "quote_sla",   urgencyScore: 90, ageMinutes: 30,       customerName: "C3", customerTier: null       }),
    ];
    const ranked = rankTodayItems(items);
    // Computed scores: freight_opp 80*1.30*1.0=104, quote_sla 90*1.0*1.0=90, lwq 30*0.95*0.6≈17
    expect(ranked.map(r => r.source)).toEqual(["freight_opp", "quote_sla", "lwq"]);
    // Each row carries a score that mirrors the formula
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[1].priorityScore);
    expect(ranked[1].priorityScore).toBeGreaterThan(ranked[2].priorityScore);
  });

  it("floats high-priority hot replies above everything else, regardless of urgency", () => {
    const items = [
      makeItem({ source: "freight_opp", urgencyScore: 100, ageMinutes: 0, customerName: "C1", customerTier: "platinum" }),
      makeItem({ source: "quote_sla",   urgencyScore: 95,  ageMinutes: 0, customerName: "C2", customerTier: "platinum" }),
      // Even a "low" reply outranks both above due to the +1000 floor
      // (isHotReply defaults to true for hot_reply rows in the factory)
      makeItem({ source: "hot_reply",   urgencyScore: 30,  ageMinutes: 60 * 24 * 3, customerName: "C3", customerTier: "bronze" }),
    ];
    const ranked = rankTodayItems(items);
    expect(ranked[0].source).toBe("hot_reply");
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[1].priorityScore + 500);
  });

  it("does NOT float lukewarm (non-hot) reply threads — they rank by composite only", () => {
    const items = [
      makeItem({ source: "freight_opp", urgencyScore: 90, ageMinutes: 0, customerName: "C1", customerTier: "platinum" }),
      // Reply present but isHotReply=false — should stay below the critical opp
      makeItem({ source: "hot_reply",   urgencyScore: 40, ageMinutes: 30, customerName: "C2", customerTier: "gold", isHotReply: false }),
    ];
    const ranked = rankTodayItems(items);
    expect(ranked[0].source).toBe("freight_opp");
    expect(ranked[1].source).toBe("hot_reply");
  });

  it("preserves all four sources after ranking (no source dropped)", () => {
    const items = [
      makeItem({ source: "lwq",         urgencyScore: 60, ageMinutes: 0, customerName: "C1" }),
      makeItem({ source: "freight_opp", urgencyScore: 60, ageMinutes: 0, customerName: "C2" }),
      makeItem({ source: "hot_reply",   urgencyScore: 60, ageMinutes: 0, customerName: "C3" }),
      makeItem({ source: "quote_sla",   urgencyScore: 60, ageMinutes: 0, customerName: "C4" }),
    ];
    const ranked = rankTodayItems(items);
    expect(new Set(ranked.map(r => r.source))).toEqual(
      new Set(["lwq", "freight_opp", "hot_reply", "quote_sla"]),
    );
    expect(ranked).toHaveLength(4);
    // Reply still floats first
    expect(ranked[0].source).toBe("hot_reply");
  });

  it("breaks ties stably enough that two equal items keep both their priorities equal", () => {
    const a = makeItem({ source: "lwq", urgencyScore: 50, ageMinutes: 0, customerName: "A" });
    const b = makeItem({ source: "lwq", urgencyScore: 50, ageMinutes: 0, customerName: "B" });
    const ranked = rankTodayItems([a, b]);
    expect(ranked[0].priorityScore).toBe(ranked[1].priorityScore);
  });
});


// ── Integration tests for composeTodayQueue ───────────────────────────────
//
// composeTodayQueue is the seam through which getTodayQueue assembles its
// final response. By feeding it canned source pulls we can exercise the
// snooze filter, tier joining, source-diversity ordering, and pagination
// end-to-end without standing up a real DB.

function emptySources() {
  return { lwq: [] as TodayQueueItem[], freight_opp: [] as TodayQueueItem[], hot_reply: [] as TodayQueueItem[], quote_sla: [] as TodayQueueItem[] };
}

describe("composeTodayQueue — aggregator integration", () => {
  it("merges items from all four sources and ranks them end-to-end", () => {
    const sources = {
      lwq:         [makeItem({ source: "lwq",         urgencyScore: 40, ageMinutes: 30,  customerName: "Acme" })],
      freight_opp: [makeItem({ source: "freight_opp", urgencyScore: 80, ageMinutes: 10,  customerName: "Acme" })],
      hot_reply:   [makeItem({ source: "hot_reply",   urgencyScore: 50, ageMinutes: 5,   customerName: "Beta" })],
      quote_sla:   [makeItem({ source: "quote_sla",   urgencyScore: 90, ageMinutes: 120, customerName: "Gamma" })],
    };
    const tier = new Map([["Acme", "platinum"], ["Beta", "gold"], ["Gamma", null] as [string, string | null]]);

    const out = composeTodayQueue({
      sources,
      snoozedIds: new Set(),
      tierByCustomer: tier,
      limit: 50,
      cursor: 0,
    });

    expect(out.items).toHaveLength(4);
    expect(out.totalBeforePagination).toBe(4);
    // All four sources represented
    expect(new Set(out.items.map(i => i.source))).toEqual(
      new Set(["lwq", "freight_opp", "hot_reply", "quote_sla"]),
    );
    // Hot reply floats on top
    expect(out.items[0].source).toBe("hot_reply");
    // bySource count reflects the unsnoozed totals
    expect(out.bySource).toEqual({ lwq: 1, freight_opp: 1, hot_reply: 1, quote_sla: 1 });
    // Items carry priorityScore in descending order
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1].priorityScore).toBeGreaterThanOrEqual(out.items[i].priorityScore);
    }
  });

  it("hides items whose ID is in the snooze set, and re-surfaces them when removed", () => {
    const lwqRow = makeItem({ source: "lwq", urgencyScore: 70, ageMinutes: 0, customerName: "Acme", id: "lwq:lane-1" });
    const oppRow = makeItem({ source: "freight_opp", urgencyScore: 70, ageMinutes: 0, customerName: "Acme", id: "freight_opp:opp-1" });
    const sources = { ...emptySources(), lwq: [lwqRow], freight_opp: [oppRow] };
    const tier = new Map<string, string | null>();

    // First: lwq:lane-1 is snoozed → it disappears, freight_opp survives
    const snoozed = composeTodayQueue({
      sources,
      snoozedIds: new Set(["lwq:lane-1"]),
      tierByCustomer: tier,
      limit: 50,
      cursor: 0,
    });
    expect(snoozed.items.map(i => i.id)).toEqual(["freight_opp:opp-1"]);
    expect(snoozed.totalBeforePagination).toBe(1);
    expect(snoozed.bySource.lwq).toBe(0);

    // After the snooze window expires, the snooze set is empty → row returns
    const reSurfaced = composeTodayQueue({
      sources,
      snoozedIds: new Set(),
      tierByCustomer: tier,
      limit: 50,
      cursor: 0,
    });
    expect(reSurfaced.items.map(i => i.id).sort()).toEqual(["freight_opp:opp-1", "lwq:lane-1"]);
    expect(reSurfaced.totalBeforePagination).toBe(2);
    expect(reSurfaced.bySource.lwq).toBe(1);
  });

  it("applies tier lookup so two equal-urgency items rank by their customer tier", () => {
    const platinumRow = makeItem({ source: "freight_opp", urgencyScore: 60, ageMinutes: 0, customerName: "PlatCo" });
    const bronzeRow   = makeItem({ source: "freight_opp", urgencyScore: 60, ageMinutes: 0, customerName: "BronzeCo" });
    const sources = { ...emptySources(), freight_opp: [bronzeRow, platinumRow] };
    const tier = new Map<string, string | null>([
      ["PlatCo", "platinum"],
      ["BronzeCo", "bronze"],
    ]);

    const out = composeTodayQueue({
      sources,
      snoozedIds: new Set(),
      tierByCustomer: tier,
      limit: 50,
      cursor: 0,
    });
    expect(out.items.map(i => i.customerName)).toEqual(["PlatCo", "BronzeCo"]);
    expect(out.items[0].priorityScore).toBeGreaterThan(out.items[1].priorityScore);
  });

  it("paginates the ranked list by limit/cursor and emits a nextCursor when more remain", () => {
    const sources = { ...emptySources(), freight_opp: [
      makeItem({ source: "freight_opp", urgencyScore: 90, ageMinutes: 0, customerName: "A", id: "freight_opp:a" }),
      makeItem({ source: "freight_opp", urgencyScore: 80, ageMinutes: 0, customerName: "B", id: "freight_opp:b" }),
      makeItem({ source: "freight_opp", urgencyScore: 70, ageMinutes: 0, customerName: "C", id: "freight_opp:c" }),
    ] };

    const page1 = composeTodayQueue({
      sources,
      snoozedIds: new Set(),
      tierByCustomer: new Map(),
      limit: 2,
      cursor: 0,
    });
    expect(page1.items.map(i => i.id)).toEqual(["freight_opp:a", "freight_opp:b"]);
    expect(page1.nextCursor).toBe("2");
    expect(page1.totalBeforePagination).toBe(3);

    const page2 = composeTodayQueue({
      sources,
      snoozedIds: new Set(),
      tierByCustomer: new Map(),
      limit: 2,
      cursor: 2,
    });
    expect(page2.items.map(i => i.id)).toEqual(["freight_opp:c"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("returns an empty result with all-zero bySource when every item is snoozed", () => {
    const sources = { ...emptySources(), quote_sla: [
      makeItem({ source: "quote_sla", urgencyScore: 90, ageMinutes: 0, customerName: "A", id: "quote_sla:a" }),
      makeItem({ source: "quote_sla", urgencyScore: 80, ageMinutes: 0, customerName: "B", id: "quote_sla:b" }),
    ] };
    const out = composeTodayQueue({
      sources,
      snoozedIds: new Set(["quote_sla:a", "quote_sla:b"]),
      tierByCustomer: new Map(),
      limit: 50,
      cursor: 0,
    });
    expect(out.items).toHaveLength(0);
    expect(out.totalBeforePagination).toBe(0);
    expect(out.bySource).toEqual({ lwq: 0, freight_opp: 0, hot_reply: 0, quote_sla: 0 });
    expect(out.nextCursor).toBeNull();
  });
});
