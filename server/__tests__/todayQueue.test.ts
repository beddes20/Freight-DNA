/**
 * Task #639 — Today queue aggregator tests.
 *
 * Focuses on the pure ranking surface (the heart of the feature):
 *   - tier multiplier ordering
 *   - time-decay penalty
 *   - hot-reply floor (replies always float to top)
 *   - composite formula = customerTier × urgency × decay (+floor for replies)
 *   - source diversity (items from all four upstream surfaces survive ranking)
 *
 * The aggregator's per-source DB pulls (LWQ, freight_opps, threads, quote
 * SLA) are exercised in their respective surface tests; here we mock the
 * storage layer to a thin stub so importing the module doesn't open a
 * real DB connection, then drive `rankTodayItems` directly.
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
  rankTodayItems,
  rankerScore,
  tierMultiplier,
  timeDecayMultiplier,
  type TodayQueueItem,
} from "../services/todayQueue";

// Minimal item-shape factory — every field the ranker reads is set; visual
// fields (summary, deepLink, etc.) get cheap stubs.
function makeItem(over: Partial<TodayQueueItem> & {
  source: TodayQueueItem["source"];
  urgencyScore: number;
  ageMinutes: number | null;
  customerName?: string | null;
}): TodayQueueItem & { customerTier?: string | null } {
  return {
    id: `${over.source}:${over.customerName ?? "x"}-${over.urgencyScore}-${over.ageMinutes}`,
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
    ...over,
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

  it("adds the +1000 floor for hot replies so they always outrank others", () => {
    const reply = rankerScore({
      source: "hot_reply",
      urgencyScore: 30,           // even a "low" urgency reply
      customerTier: "bronze",     // even a low-tier customer
      ageMinutes: 60 * 24 * 5,    // even very stale
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
      makeItem({ source: "lwq",         urgencyScore: 30, ageMinutes: 60 * 24, customerName: "C1", customerTier: "bronze"   } as any),
      makeItem({ source: "freight_opp", urgencyScore: 80, ageMinutes: 0,        customerName: "C2", customerTier: "platinum" } as any),
      makeItem({ source: "quote_sla",   urgencyScore: 90, ageMinutes: 30,       customerName: "C3", customerTier: null       } as any),
    ];
    const ranked = rankTodayItems(items);
    // Computed scores: freight_opp 80*1.30*1.0=104, quote_sla 90*1.0*1.0=90, lwq 30*0.95*0.6≈17
    expect(ranked.map(r => r.source)).toEqual(["freight_opp", "quote_sla", "lwq"]);
    // Each row carries a score that mirrors the formula
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[1].priorityScore);
    expect(ranked[1].priorityScore).toBeGreaterThan(ranked[2].priorityScore);
  });

  it("floats hot replies above everything else, regardless of urgency", () => {
    const items = [
      makeItem({ source: "freight_opp", urgencyScore: 100, ageMinutes: 0, customerName: "C1", customerTier: "platinum" } as any),
      makeItem({ source: "quote_sla",   urgencyScore: 95,  ageMinutes: 0, customerName: "C2", customerTier: "platinum" } as any),
      // Even a "low" reply outranks both above due to the +1000 floor
      makeItem({ source: "hot_reply",   urgencyScore: 30,  ageMinutes: 60 * 24 * 3, customerName: "C3", customerTier: "bronze" } as any),
    ];
    const ranked = rankTodayItems(items);
    expect(ranked[0].source).toBe("hot_reply");
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[1].priorityScore + 500);
  });

  it("preserves all four sources after ranking (no source dropped)", () => {
    const items = [
      makeItem({ source: "lwq",         urgencyScore: 60, ageMinutes: 0, customerName: "C1" } as any),
      makeItem({ source: "freight_opp", urgencyScore: 60, ageMinutes: 0, customerName: "C2" } as any),
      makeItem({ source: "hot_reply",   urgencyScore: 60, ageMinutes: 0, customerName: "C3" } as any),
      makeItem({ source: "quote_sla",   urgencyScore: 60, ageMinutes: 0, customerName: "C4" } as any),
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
    const a = makeItem({ source: "lwq", urgencyScore: 50, ageMinutes: 0, customerName: "A" } as any);
    const b = makeItem({ source: "lwq", urgencyScore: 50, ageMinutes: 0, customerName: "B" } as any);
    const ranked = rankTodayItems([a, b]);
    expect(ranked[0].priorityScore).toBe(ranked[1].priorityScore);
  });
});
