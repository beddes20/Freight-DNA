/**
 * Tests for the reply-latency regression detector (Task #611).
 *
 * Covers the pure helpers — `previousCompleteIsoWeekStart`,
 * `bucketWeeklyStatsByRep`, `evaluateRegressionDecision` — and the
 * `evaluateOrgRegressions` orchestrator using mocked storage. The scheduler's
 * notification-copy formatter is also locked in so a subtle regression in
 * wording can't slip past review.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Storage / DB are mocked globally so the service module can be imported
// without bootstrapping a real DB. fetchResponsePairs internally calls
// pool.query + db.select, so we override both.
const mockPoolQuery = vi.fn();
const mockSelect = vi.fn();
const mockGetOrganizations = vi.fn(async () => [] as any[]);
const mockGetUsers = vi.fn(async (_orgId: string) => [] as any[]);
const mockHasAnyNotification = vi.fn(async (_userId: string, _type: string, _relatedId: string) => false);
const mockCreateNotification = vi.fn(async (_input: any) => ({} as any));
vi.mock("../storage", () => ({
  storage: {
    pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
    getOrganizations: (...args: unknown[]) => mockGetOrganizations(...(args as [])),
    getUsers: (...args: unknown[]) => mockGetUsers(...(args as [string])),
    hasAnyNotification: (...args: unknown[]) => mockHasAnyNotification(...(args as [string, string, string])),
    createNotification: (...args: unknown[]) => mockCreateNotification(...(args as [any])),
  },
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

// fetchResponsePairs is too DB-heavy to drive end-to-end here; we stub it
// via vi.spyOn in the orchestrator test. The pure helpers don't need it.
import * as analyticsService from "../services/emailResponseTimeAnalyticsService";
import {
  previousCompleteIsoWeekStart,
  bucketWeeklyStatsByRep,
  evaluateRegressionDecision,
  evaluateOrgRegressions,
  formatDurationMs,
  DEFAULT_REGRESSION_CONFIG,
} from "../services/replyLatencyRegressionService";
import { buildNotificationCopy } from "../replyLatencyRegressionScheduler";
import type { ResponsePair } from "../services/emailResponseTimeAnalyticsService";

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockSelect.mockReset();
  mockGetOrganizations.mockReset().mockResolvedValue([]);
  mockGetUsers.mockReset().mockResolvedValue([]);
  mockHasAnyNotification.mockReset().mockResolvedValue(false);
  mockCreateNotification.mockReset().mockResolvedValue({} as any);
  // Default: regression config not stored → empty result.
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
      }),
    }),
  });
});

function pair(overrides: Partial<ResponsePair> & { id: string; outboundAt: Date; ms: number }): ResponsePair {
  // For tests, derive inbound from outbound − ms so wallMs/bizMs match `ms`.
  const inboundAt = overrides.inboundAt ?? new Date(overrides.outboundAt.getTime() - overrides.ms);
  return {
    inboundId: overrides.id,
    threadId: overrides.threadId ?? `t-${overrides.id}`,
    inboundAt,
    outboundAt: overrides.outboundAt,
    ownerUserId: overrides.ownerUserId ?? null,
    ownerName: overrides.ownerName ?? null,
    senderUserId: overrides.senderUserId ?? null,
    senderName: overrides.senderName ?? null,
    accountId: overrides.accountId ?? "acct-1",
    accountName: overrides.accountName ?? "Acct One",
    subject: overrides.subject ?? `Subject ${overrides.id}`,
    fromEmail: overrides.fromEmail ?? null,
    wallMs: overrides.ms,
    bizMs: overrides.ms,
  };
}

describe("previousCompleteIsoWeekStart", () => {
  it("returns the Monday of the prior ISO-week from a mid-week date", () => {
    // Wed 2026-04-22 → prior week's Monday is 2026-04-13.
    expect(previousCompleteIsoWeekStart(new Date("2026-04-22T12:00:00Z"))).toBe("2026-04-13");
  });
  it("from Monday itself, still rolls back to the previous week's Monday", () => {
    // Mon 2026-04-20 → previous Monday is 2026-04-13.
    expect(previousCompleteIsoWeekStart(new Date("2026-04-20T08:00:00Z"))).toBe("2026-04-13");
  });
  it("handles year boundaries correctly", () => {
    // Sun 2026-01-04 falls in ISO-week 1; previous complete week was 2025-12-22.
    expect(previousCompleteIsoWeekStart(new Date("2026-01-04T23:00:00Z"))).toBe("2025-12-22");
  });
});

describe("bucketWeeklyStatsByRep", () => {
  it("groups by attributed sender and ISO-week, ignoring unattributed and missing-ms rows", () => {
    const pairs: ResponsePair[] = [
      pair({ id: "1", senderUserId: "u-alice", senderName: "Alice", outboundAt: new Date("2026-04-15T10:00:00Z"), ms: 60_000 }),
      pair({ id: "2", senderUserId: "u-alice", senderName: "Alice", outboundAt: new Date("2026-04-16T10:00:00Z"), ms: 120_000 }),
      pair({ id: "3", senderUserId: "u-alice", senderName: "Alice", outboundAt: new Date("2026-04-08T10:00:00Z"), ms: 30_000 }),
      pair({ id: "4", senderUserId: "u-bob", senderName: "Bob", outboundAt: new Date("2026-04-15T10:00:00Z"), ms: 240_000 }),
      // Unattributed → must be skipped.
      pair({ id: "5", outboundAt: new Date("2026-04-15T10:00:00Z"), ms: 999_000 }),
    ];
    const grouped = bucketWeeklyStatsByRep(pairs, true);
    expect(grouped.size).toBe(2);
    const alice = grouped.get("u-alice")!;
    expect(alice.name).toBe("Alice");
    expect(alice.weeks.size).toBe(2); // weeks of 04-13 and 04-06
    expect(alice.weeks.get("2026-04-13")!.values.length).toBe(2);
    expect(alice.weeks.get("2026-04-06")!.values.length).toBe(1);
    const bob = grouped.get("u-bob")!;
    expect(bob.weeks.get("2026-04-13")!.values).toEqual([240_000]);
  });

  it("falls back to owner attribution when no sender resolved", () => {
    const pairs: ResponsePair[] = [
      pair({ id: "1", ownerUserId: "u-carol", ownerName: "Carol", outboundAt: new Date("2026-04-15T10:00:00Z"), ms: 60_000 }),
    ];
    const grouped = bucketWeeklyStatsByRep(pairs, true);
    expect(grouped.get("u-carol")!.name).toBe("Carol");
  });

  it("respects the businessHours flag when picking ms field", () => {
    const p: ResponsePair = {
      ...pair({ id: "1", senderUserId: "u-alice", outboundAt: new Date("2026-04-15T10:00:00Z"), ms: 0 }),
      wallMs: 5_000,
      bizMs: 99_000,
    };
    const wall = bucketWeeklyStatsByRep([p], false);
    const biz = bucketWeeklyStatsByRep([p], true);
    expect(wall.get("u-alice")!.weeks.get("2026-04-13")!.values).toEqual([5_000]);
    expect(biz.get("u-alice")!.weeks.get("2026-04-13")!.values).toEqual([99_000]);
  });
});

describe("evaluateRegressionDecision", () => {
  const cfg = { p90RegressionPct: 25, minReplies: 5 };

  it("flags when latest p90 jumps past the percent threshold and reply floor is met", () => {
    const r = evaluateRegressionDecision(
      { weekStart: "2026-04-13", count: 10, p90Ms: 100_000, medianMs: 60_000 },
      60_000,
      cfg,
    );
    expect(r.regressed).toBe(true);
    expect(Math.round(r.deltaPct)).toBe(67);
  });

  it("rejects when reply count is below the floor", () => {
    expect(
      evaluateRegressionDecision(
        { weekStart: "2026-04-13", count: 4, p90Ms: 999_999, medianMs: 60_000 },
        60_000,
        cfg,
      ).regressed,
    ).toBe(false);
  });

  it("rejects when latest p90 is missing", () => {
    expect(
      evaluateRegressionDecision(
        { weekStart: "2026-04-13", count: 10, p90Ms: null, medianMs: null },
        60_000,
        cfg,
      ).regressed,
    ).toBe(false);
  });

  it("rejects when baseline is zero (avoids divide-by-zero blowup)", () => {
    const r = evaluateRegressionDecision(
      { weekStart: "2026-04-13", count: 10, p90Ms: 100_000, medianMs: 60_000 },
      0,
      cfg,
    );
    expect(r.regressed).toBe(false);
  });

  it("rejects when latest is faster than baseline (improvement, not regression)", () => {
    const r = evaluateRegressionDecision(
      { weekStart: "2026-04-13", count: 10, p90Ms: 30_000, medianMs: 20_000 },
      60_000,
      cfg,
    );
    expect(r.regressed).toBe(false);
    expect(r.deltaPct).toBeLessThan(0);
  });
});

describe("formatDurationMs", () => {
  it("formats minutes, hours, days correctly", () => {
    expect(formatDurationMs(45 * 60_000)).toBe("45m");
    expect(formatDurationMs(3 * 3_600_000)).toBe("3h");
    expect(formatDurationMs(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatDurationMs(2 * 86_400_000)).toBe("2d");
    expect(formatDurationMs(2 * 86_400_000 + 5 * 3_600_000)).toBe("2d 5h");
  });
  it("returns em-dash for invalid inputs", () => {
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(NaN)).toBe("—");
  });
});

describe("evaluateOrgRegressions", () => {
  it("returns flags for reps whose latest week's p90 jumped past the threshold", async () => {
    const now = new Date("2026-04-22T08:00:00Z"); // Wed → latest complete week starts 2026-04-13

    // Build a synthetic history: Alice regressed (baseline ~60k, latest ~150k);
    // Bob is steady. Both have enough volume to clear the 10-reply floor.
    const pairs: ResponsePair[] = [];
    const wk = (offset: number) => new Date(new Date("2026-04-15T10:00:00Z").getTime() - offset * 7 * 86_400_000);
    // Alice baseline weeks (4 prior): each with 12 replies of ~60s
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `a-base-${w}-${i}`,
          senderUserId: "u-alice",
          senderName: "Alice",
          outboundAt: wk(w),
          ms: 60_000 + i * 1_000, // p90 ≈ 70s
        }));
      }
    }
    // Alice latest week: 12 replies, p90 around 200s
    for (let i = 0; i < 12; i++) {
      pairs.push(pair({
        id: `a-latest-${i}`,
        senderUserId: "u-alice",
        senderName: "Alice",
        outboundAt: wk(0),
        ms: 60_000 + i * 15_000, // values 60..225k, p90 ≈ 210k+
      }));
    }
    // Bob steady: 12 replies/week at 60s for both baseline and latest
    for (let w = 0; w <= 4; w++) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `b-${w}-${i}`,
          senderUserId: "u-bob",
          senderName: "Bob",
          outboundAt: wk(w),
          ms: 60_000,
        }));
      }
    }

    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue(pairs);

    const { flags, latestWeekStart, config } = await evaluateOrgRegressions("org-1", { now });

    expect(latestWeekStart).toBe("2026-04-13");
    expect(config.enabled).toBe(true);
    expect(config.lookbackWeeks).toBe(DEFAULT_REGRESSION_CONFIG.lookbackWeeks);

    const aliceFlag = flags.find(f => f.repId === "u-alice");
    const bobFlag = flags.find(f => f.repId === "u-bob");
    expect(aliceFlag).toBeDefined();
    expect(aliceFlag!.repName).toBe("Alice");
    expect(aliceFlag!.latest.weekStart).toBe("2026-04-13");
    expect(aliceFlag!.latest.count).toBe(12);
    expect(aliceFlag!.baseline.weeks.length).toBe(4);
    expect(aliceFlag!.p90DeltaPct).toBeGreaterThan(25);
    expect(bobFlag).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("skips the entire sweep when config.enabled is false", async () => {
    // Override the storage mock to return an explicit `enabled: false` row.
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            organizationId: "org-1",
            enabled: false,
            lookbackWeeks: 4,
            p90RegressionPct: 25,
            minReplies: 10,
            businessHours: true,
            updatedAt: new Date(),
            updatedBy: null,
          }]),
        }),
      }),
    });
    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue([]);

    const result = await evaluateOrgRegressions("org-1", { now: new Date("2026-04-22T08:00:00Z") });
    expect(result.flags).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("skips reps with no replies in the latest week", async () => {
    const now = new Date("2026-04-22T08:00:00Z");
    const wk = (offset: number) => new Date(new Date("2026-04-15T10:00:00Z").getTime() - offset * 7 * 86_400_000);
    const pairs: ResponsePair[] = [];
    // Carol has only baseline activity → must not be flagged.
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `c-${w}-${i}`,
          senderUserId: "u-carol",
          senderName: "Carol",
          outboundAt: wk(w),
          ms: 60_000,
        }));
      }
    }
    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue(pairs);
    const { flags } = await evaluateOrgRegressions("org-1", { now });
    expect(flags).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("does not flag reps lacking the full lookback window of baseline coverage", async () => {
    // Dana has a regressed latest week, but only 2 of the prior 4 weeks have
    // data — per the spec's "trailing 4-week baseline" requirement, that's
    // not a stable enough comparison to fire on.
    const now = new Date("2026-04-22T08:00:00Z");
    const wk = (offset: number) => new Date(new Date("2026-04-15T10:00:00Z").getTime() - offset * 7 * 86_400_000);
    const pairs: ResponsePair[] = [];
    // Baseline: only weeks -1 and -3 have data; weeks -2 and -4 missing.
    for (const w of [1, 3]) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `d-base-${w}-${i}`,
          senderUserId: "u-dana",
          senderName: "Dana",
          outboundAt: wk(w),
          ms: 60_000 + i * 1_000,
        }));
      }
    }
    // Latest week: a clear regression (p90 ≈ 4× baseline)
    for (let i = 0; i < 12; i++) {
      pairs.push(pair({
        id: `d-latest-${i}`,
        senderUserId: "u-dana",
        senderName: "Dana",
        outboundAt: wk(0),
        ms: 240_000 + i * 5_000,
      }));
    }
    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue(pairs);
    const { flags } = await evaluateOrgRegressions("org-1", { now });
    expect(flags.find(f => f.repId === "u-dana")).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe("runReplyLatencyRegressionSweep dedupe", () => {
  it("skips creating a notification when one already exists for the same rep+week", async () => {
    const { runReplyLatencyRegressionSweep } = await import("../replyLatencyRegressionScheduler");

    const now = new Date("2026-04-22T08:00:00Z");
    const wk = (offset: number) => new Date(new Date("2026-04-15T10:00:00Z").getTime() - offset * 7 * 86_400_000);
    const pairs: ResponsePair[] = [];
    // Eve has 4 full baseline weeks + a clearly regressed latest week.
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `e-base-${w}-${i}`,
          senderUserId: "u-eve",
          senderName: "Eve",
          outboundAt: wk(w),
          ms: 60_000 + i * 1_000,
        }));
      }
    }
    for (let i = 0; i < 12; i++) {
      pairs.push(pair({
        id: `e-latest-${i}`,
        senderUserId: "u-eve",
        senderName: "Eve",
        outboundAt: wk(0),
        ms: 60_000 + i * 15_000,
      }));
    }

    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue(pairs);

    // Storage helpers used by the scheduler. hasAnyNotification returns true →
    // dedupe path engaged → createNotification must NOT be called.
    mockGetOrganizations.mockResolvedValue([{ id: "org-1" } as any]);
    mockGetUsers.mockResolvedValue([{ id: "u-eve", organizationId: "org-1", email: "eve@x" } as any]);
    mockHasAnyNotification.mockResolvedValue(true);

    const total = await runReplyLatencyRegressionSweep(now);
    expect(total).toBe(0);
    expect(mockHasAnyNotification).toHaveBeenCalledWith("u-eve", "reply_latency_regression", "u-eve:2026-04-13");
    expect(mockCreateNotification).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("creates a notification when no prior one exists for that rep+week", async () => {
    const { runReplyLatencyRegressionSweep } = await import("../replyLatencyRegressionScheduler");

    const now = new Date("2026-04-22T08:00:00Z");
    const wk = (offset: number) => new Date(new Date("2026-04-15T10:00:00Z").getTime() - offset * 7 * 86_400_000);
    const pairs: ResponsePair[] = [];
    for (let w = 1; w <= 4; w++) {
      for (let i = 0; i < 12; i++) {
        pairs.push(pair({
          id: `f-base-${w}-${i}`,
          senderUserId: "u-frank",
          senderName: "Frank",
          outboundAt: wk(w),
          ms: 60_000 + i * 1_000,
        }));
      }
    }
    for (let i = 0; i < 12; i++) {
      pairs.push(pair({
        id: `f-latest-${i}`,
        senderUserId: "u-frank",
        senderName: "Frank",
        outboundAt: wk(0),
        ms: 60_000 + i * 15_000,
      }));
    }

    const fetchSpy = vi.spyOn(analyticsService, "fetchResponsePairs").mockResolvedValue(pairs);
    mockGetOrganizations.mockResolvedValue([{ id: "org-1" } as any]);
    mockGetUsers.mockResolvedValue([{ id: "u-frank", organizationId: "org-1", email: "frank@x" } as any]);
    mockHasAnyNotification.mockResolvedValue(false);

    const total = await runReplyLatencyRegressionSweep(now);
    expect(total).toBe(1);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0]).toMatchObject({
      userId: "u-frank",
      type: "reply_latency_regression",
      relatedId: "u-frank:2026-04-13",
      link: "/email-response-time",
      read: false,
    });

    fetchSpy.mockRestore();
  });
});

describe("buildNotificationCopy", () => {
  it("formats a regression flag into a rep-friendly title and body", () => {
    const copy = buildNotificationCopy({
      repId: "u-alice",
      repName: "Alice",
      latest: { weekStart: "2026-04-13", count: 12, p90Ms: 4 * 3_600_000, medianMs: 30 * 60_000 },
      baseline: {
        weeks: [
          { weekStart: "2026-04-06", count: 10, p90Ms: 60 * 60_000, medianMs: 20 * 60_000 },
        ],
        p90Ms: 60 * 60_000,
        medianMs: 20 * 60_000,
        totalReplies: 10,
      },
      p90DeltaPct: 300,
      businessHours: true,
    });
    expect(copy.title).toContain("300%");
    expect(copy.body).toContain("4h");
    expect(copy.body).toContain("1h"); // baseline 60m → "1h"
    expect(copy.body).toContain("business-hour");
    expect(copy.body).toContain("2026-04-13");
  });
});
