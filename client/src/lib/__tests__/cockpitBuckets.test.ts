// Task #957 — shared/cockpitBuckets unit tests.
//
// Pure-data tests over the bucket predicate. The chip strip in the cockpit
// uses these counts to drive the SAME filtered collection that powers
// KPIs / rows / ROI; if a row lands in the wrong bucket the rep sees a
// mismatched count vs row list.

import { describe, it, expect } from "vitest";
import {
  bucketsForRow,
  rowMatchesBucket,
  countBuckets,
  emptyBucketCounts,
  kpisFromFiltered,
  BUCKET_KEYS,
  BUCKET_ORDER,
  BUCKETS,
  type BucketEvalRow,
  type BucketEvalContext,
} from "@shared/cockpitBuckets";
import {
  shouldHideForPickup,
  computePickupFreshness,
  daysSincePickup,
  ACTIONABLE_OPEN_STATUSES,
} from "@shared/pickupFreshness";

const TODAY = "2026-04-24"; // CT
const ctx: BucketEvalContext = {
  todayIso: TODAY,
  currentUserId: "me-id",
  myTeamUserIds: new Set(["me-id", "rep1", "rep2"]),
};

function mk(overrides: Partial<BucketEvalRow["opportunity"]> = {}, extras: Partial<BucketEvalRow> = {}): BucketEvalRow {
  return {
    opportunity: {
      status: "ready_to_send",
      pickupWindowStart: null,
      coveredAt: null,
      ...overrides,
    },
    coverage: { sent: 0, responded: 0, covered: false },
    freshnessMinutes: 0,
    ownership: { ids: ["me-id"], emails: [] },
    owner: { id: "me-id" },
    ...extras,
  };
}

describe("bucketsForRow — base buckets", () => {
  it("always includes 'all'", () => {
    const r = mk();
    expect(bucketsForRow(r, ctx).has("all")).toBe(true);
  });

  it("classifies ready_to_send rows", () => {
    const r = mk({ status: "ready_to_send" });
    expect(bucketsForRow(r, ctx).has("ready_to_send")).toBe(true);
  });

  it("does NOT classify non-ready statuses as ready_to_send", () => {
    const r = mk({ status: "sent" });
    expect(bucketsForRow(r, ctx).has("ready_to_send")).toBe(false);
  });
});

describe("bucketsForRow — pickup-day buckets (org-local)", () => {
  it("classifies pickup_today on the org-local date", () => {
    const r = mk({ pickupWindowStart: `${TODAY}T18:00:00Z` });
    expect(bucketsForRow(r, ctx).has("pickup_today")).toBe(true);
  });

  it("classifies pickup_tomorrow as 24-48h ahead and not today", () => {
    const r = mk({ pickupWindowStart: "2026-04-25T18:00:00Z" });
    const got = bucketsForRow(r, ctx);
    expect(got.has("pickup_tomorrow")).toBe(true);
    expect(got.has("pickup_today")).toBe(false);
  });

  it("classifies at_risk_24h when pickup is within 24h and not yet covered", () => {
    const r = mk({ pickupWindowStart: `${TODAY}T20:00:00Z` });
    expect(bucketsForRow(r, ctx).has("at_risk_24h")).toBe(true);
  });

  it("does NOT mark covered loads as at_risk_24h", () => {
    const r = mk(
      { pickupWindowStart: `${TODAY}T20:00:00Z` },
      { coverage: { sent: 1, responded: 1, covered: true } },
    );
    expect(bucketsForRow(r, ctx).has("at_risk_24h")).toBe(false);
  });
});

describe("bucketsForRow — team_needs_approval", () => {
  it("matches a pending_approval row owned by a team member", () => {
    const r = mk(
      { status: "pending_approval" },
      { ownership: { ids: ["rep1"], emails: [] }, owner: { id: "rep1" } },
    );
    expect(bucketsForRow(r, ctx).has("team_needs_approval")).toBe(true);
  });

  it("does NOT match pending_approval owned by an outsider when team set provided", () => {
    const r = mk(
      { status: "pending_approval" },
      { ownership: { ids: ["someone-else"], emails: [] }, owner: { id: "someone-else" } },
    );
    expect(bucketsForRow(r, ctx).has("team_needs_approval")).toBe(false);
  });

  it("matches every pending_approval row when no team set provided", () => {
    const r = mk(
      { status: "pending_approval" },
      { ownership: { ids: ["someone-else"], emails: [] }, owner: { id: "someone-else" } },
    );
    expect(
      bucketsForRow(r, { ...ctx, myTeamUserIds: null }).has("team_needs_approval"),
    ).toBe(true);
  });
});

describe("bucketsForRow — sent / no_response_4h", () => {
  it("matches when sent>0, responded=0, freshnessMinutes>=240", () => {
    const r = mk(undefined, {
      coverage: { sent: 3, responded: 0, covered: false },
      freshnessMinutes: 245,
    });
    expect(bucketsForRow(r, ctx).has("no_response_4h")).toBe(true);
  });

  it("does not match when at least one carrier replied", () => {
    const r = mk(undefined, {
      coverage: { sent: 3, responded: 1, covered: false },
      freshnessMinutes: 245,
    });
    expect(bucketsForRow(r, ctx).has("no_response_4h")).toBe(false);
  });
});

describe("bucketsForRow — covered_today / unassigned / stale", () => {
  it("covered_today uses the coveredAt date", () => {
    const r = mk(
      { coveredAt: `${TODAY}T03:00:00Z` },
      { coverage: { sent: 1, responded: 1, covered: true } },
    );
    expect(bucketsForRow(r, ctx).has("covered_today")).toBe(true);
  });

  it("unassigned matches rows with empty ownership", () => {
    const r = mk(undefined, { ownership: { ids: [], emails: [] }, owner: { id: null } });
    expect(bucketsForRow(r, ctx).has("unassigned")).toBe(true);
  });

  it("stale matches past_stale + actionable status", () => {
    const r = mk(
      { status: "ready_to_send" },
      { pickupFreshness: "past_stale", pickupDaysAgo: 5 },
    );
    expect(bucketsForRow(r, ctx).has("stale")).toBe(true);
  });
});

describe("rowMatchesBucket + countBuckets", () => {
  it("rowMatchesBucket('all') is always true", () => {
    expect(rowMatchesBucket(mk(), "all", ctx)).toBe(true);
  });

  it("countBuckets sums to a row contributing to multiple buckets", () => {
    const rows: BucketEvalRow[] = [
      mk({ status: "ready_to_send", pickupWindowStart: `${TODAY}T18:00:00Z` }),
      mk({ status: "pending_approval" }, { ownership: { ids: ["rep1"], emails: [] }, owner: { id: "rep1" } }),
      mk({ status: "covered", coveredAt: `${TODAY}T01:00:00Z` }, { coverage: { sent: 1, responded: 1, covered: true } }),
      mk({ status: "ready_to_send" }, { ownership: { ids: [], emails: [] }, owner: { id: null } }),
    ];
    const counts = countBuckets(rows, ctx);
    expect(counts.all).toBe(4);
    expect(counts.ready_to_send).toBeGreaterThanOrEqual(2);
    expect(counts.pickup_today).toBeGreaterThanOrEqual(1);
    expect(counts.team_needs_approval).toBe(1);
    expect(counts.covered_today).toBe(1);
    expect(counts.unassigned).toBe(1);
  });

  it("emptyBucketCounts has every bucket key initialized to 0", () => {
    const z = emptyBucketCounts();
    for (const k of BUCKET_KEYS) {
      expect(z[k]).toBe(0);
    }
  });

  it("BUCKET_ORDER lists every key exactly once", () => {
    expect(new Set(BUCKET_ORDER).size).toBe(BUCKET_KEYS.length);
    for (const k of BUCKET_KEYS) {
      expect(BUCKET_ORDER).toContain(k);
      expect(BUCKETS[k]).toBeDefined();
    }
  });
});

describe("Available Freight strict-actionable pickup gate (Task #957 follow-up)", () => {
  // Co-located with the bucket suite because the chip strip + visible rows
  // both depend on this gate filtering out yesterday before bucket counts
  // are computed. If the gate softens, the AF queue starts dragging
  // yesterday's open loads back in regardless of status.
  const TODAY_AF = "2026-04-30";
  const YESTERDAY_AF = "2026-04-29";
  const STALE_AF = "2026-04-10";

  function gateCtx(pickupIso: string, status: string) {
    return { status, daysSincePickup: daysSincePickup(pickupIso, TODAY_AF) };
  }

  it("yesterday + ready_to_send is EXCLUDED from Available Freight", () => {
    const f = computePickupFreshness(YESTERDAY_AF, TODAY_AF);
    expect(f).toBe("past_recent");
    expect(shouldHideForPickup(f, "actionable", gateCtx(YESTERDAY_AF, "ready_to_send"))).toBe(true);
  });

  it("yesterday + every actionable open status is EXCLUDED (no soft-overdue carve-out)", () => {
    const f = computePickupFreshness(YESTERDAY_AF, TODAY_AF);
    for (const status of ACTIONABLE_OPEN_STATUSES) {
      expect(shouldHideForPickup(f, "actionable", gateCtx(YESTERDAY_AF, status))).toBe(true);
    }
  });

  it("today + ready_to_send is INCLUDED", () => {
    const f = computePickupFreshness(TODAY_AF, TODAY_AF);
    expect(shouldHideForPickup(f, "actionable", gateCtx(TODAY_AF, "ready_to_send"))).toBe(false);
  });

  it("strictly stale is EXCLUDED under actionable, INCLUDED under all", () => {
    const f = computePickupFreshness(STALE_AF, TODAY_AF);
    expect(shouldHideForPickup(f, "actionable", gateCtx(STALE_AF, "ready_to_send"))).toBe(true);
    expect(shouldHideForPickup(f, "all", gateCtx(STALE_AF, "ready_to_send"))).toBe(false);
  });

  it("same yesterday row is VISIBLE when pickupScope flips to 'all' (history view)", () => {
    const f = computePickupFreshness(YESTERDAY_AF, TODAY_AF);
    expect(shouldHideForPickup(f, "all", gateCtx(YESTERDAY_AF, "sent"))).toBe(false);
  });

  it("midnight rollover (CT): 2026-04-29 pickup flips from VISIBLE to HIDDEN at the boundary", () => {
    const before = computePickupFreshness("2026-04-29", "2026-04-29");
    expect(before).toBe("upcoming");
    expect(
      shouldHideForPickup(before, "actionable", {
        status: "ready_to_send",
        daysSincePickup: daysSincePickup("2026-04-29", "2026-04-29"),
      }),
    ).toBe(false);

    const after = computePickupFreshness("2026-04-29", "2026-04-30");
    expect(after).toBe("past_recent");
    expect(
      shouldHideForPickup(after, "actionable", {
        status: "ready_to_send",
        daysSincePickup: daysSincePickup("2026-04-29", "2026-04-30"),
      }),
    ).toBe(true);
  });
});

// Task #957 follow-up #2 — KPI strip is computed from the SAME filtered
// collection that powers visible rows + bucket chips. The helper must
// agree with `bucketsForRow` predicate-for-predicate so the strip and
// the chip counts can never disagree.
describe("kpisFromFiltered — derived from filtered rows", () => {
  it("total equals rows.length", () => {
    const rows: BucketEvalRow[] = [
      mk({ status: "ready_to_send" }),
      mk({ status: "new" }),
      mk({ status: "pending_approval" }),
    ];
    const k = kpisFromFiltered(rows, ctx);
    expect(k.total).toBe(3);
  });

  it("readyToSend matches bucket 'ready_to_send' count", () => {
    const rows: BucketEvalRow[] = [
      mk({ status: "ready_to_send" }),
      mk({ status: "ready_to_send" }),
      mk({ status: "new" }),
      mk({ status: "covered" }),
    ];
    const k = kpisFromFiltered(rows, ctx);
    const bucketCount = countBuckets(rows, ctx).ready_to_send;
    expect(k.readyToSend).toBe(2);
    expect(k.readyToSend).toBe(bucketCount);
  });

  it("atRiskPickup24h matches bucket 'at_risk_24h' count (uses isPickupWithinHours 24 + !covered)", () => {
    const rows: BucketEvalRow[] = [
      // pickup today — within 24h, not covered → at risk
      mk({ pickupWindowStart: "2026-04-24T18:00:00Z" }, { coverage: { sent: 0, responded: 0, covered: false } }),
      // pickup today — covered → NOT at risk
      mk({ pickupWindowStart: "2026-04-24T18:00:00Z" }, { coverage: { sent: 0, responded: 0, covered: true } }),
      // pickup in 3 days → NOT at risk
      mk({ pickupWindowStart: "2026-04-27T12:00:00Z" }),
    ];
    const k = kpisFromFiltered(rows, ctx);
    const bucketCount = countBuckets(rows, ctx).at_risk_24h;
    expect(k.atRiskPickup24h).toBe(1);
    expect(k.atRiskPickup24h).toBe(bucketCount);
  });

  it("coveredToday matches bucket 'covered_today' count", () => {
    const rows: BucketEvalRow[] = [
      mk({ coveredAt: "2026-04-24T15:00:00Z" }),
      mk({ coveredAt: "2026-04-23T15:00:00Z" }),
      mk({ coveredAt: null }),
    ];
    const k = kpisFromFiltered(rows, ctx);
    const bucketCount = countBuckets(rows, ctx).covered_today;
    expect(k.coveredToday).toBe(1);
    expect(k.coveredToday).toBe(bucketCount);
  });

  it("sentAwaitingCarrier counts coverage.sent>0 AND coverage.responded==0", () => {
    const rows: BucketEvalRow[] = [
      mk({}, { coverage: { sent: 3, responded: 0, covered: false } }),
      mk({}, { coverage: { sent: 5, responded: 1, covered: false } }),
      mk({}, { coverage: { sent: 0, responded: 0, covered: false } }),
    ];
    const k = kpisFromFiltered(rows, ctx);
    expect(k.sentAwaitingCarrier).toBe(1);
  });

  it("generatedToday counts opportunity.generatedAt whose date matches todayIso", () => {
    const rows: BucketEvalRow[] = [
      mk({ generatedAt: "2026-04-24T01:00:00Z" }),
      mk({ generatedAt: "2026-04-24T23:30:00Z" }),
      mk({ generatedAt: "2026-04-23T15:00:00Z" }),
      mk({ generatedAt: null }),
      mk({}),
    ];
    const k = kpisFromFiltered(rows, ctx);
    expect(k.generatedToday).toBe(2);
  });

  it("avgFreshnessMinutes is the mean of freshnessMinutes (null when none)", () => {
    const rowsEmpty: BucketEvalRow[] = [mk({}, { freshnessMinutes: null })];
    expect(kpisFromFiltered(rowsEmpty, ctx).avgFreshnessMinutes).toBeNull();

    const rows: BucketEvalRow[] = [
      mk({}, { freshnessMinutes: 10 }),
      mk({}, { freshnessMinutes: 20 }),
      mk({}, { freshnessMinutes: 30 }),
      mk({}, { freshnessMinutes: null }),
    ];
    expect(kpisFromFiltered(rows, ctx).avgFreshnessMinutes).toBe(20);
  });

  it("filtering rows changes KPIs (filter-by-bucket parity)", () => {
    const rows: BucketEvalRow[] = [
      mk({ status: "ready_to_send", pickupWindowStart: "2026-04-24T18:00:00Z" }, { coverage: { sent: 0, responded: 0, covered: false } }),
      mk({ status: "new" }),
      mk({ status: "pending_approval" }, { ownership: { ids: ["rep1"], emails: [] }, owner: { id: "rep1" } }),
      mk({ status: "covered", coveredAt: "2026-04-24T15:00:00Z" }, { coverage: { sent: 5, responded: 2, covered: true } }),
    ];

    const allKpis = kpisFromFiltered(rows, ctx);
    expect(allKpis.total).toBe(4);
    expect(allKpis.readyToSend).toBe(1);
    expect(allKpis.coveredToday).toBe(1);
    expect(allKpis.atRiskPickup24h).toBe(1);

    // Narrow to just the at_risk_24h bucket — KPIs should reflect ONLY
    // those rows. This is the parity guarantee the page leans on: chip
    // counts and KPI tiles can never disagree because both run through
    // the same pipeline.
    const atRiskOnly = rows.filter((r) => bucketsForRow(r, ctx).has("at_risk_24h"));
    const atRiskKpis = kpisFromFiltered(atRiskOnly, ctx);
    expect(atRiskKpis.total).toBe(1);
    expect(atRiskKpis.atRiskPickup24h).toBe(1);
    expect(atRiskKpis.readyToSend).toBe(1); // the at-risk row is also ready_to_send
    expect(atRiskKpis.coveredToday).toBe(0);

    // Narrow to covered_today — KPIs follow.
    const coveredOnly = rows.filter((r) => bucketsForRow(r, ctx).has("covered_today"));
    const coveredKpis = kpisFromFiltered(coveredOnly, ctx);
    expect(coveredKpis.total).toBe(1);
    expect(coveredKpis.coveredToday).toBe(1);
    expect(coveredKpis.readyToSend).toBe(0);
    expect(coveredKpis.atRiskPickup24h).toBe(0);
  });
});

describe("midnight rollover (CT)", () => {
  // 23:55 CT == next day 04:55 UTC; 00:05 CT == next day 05:05 UTC.
  // We pin todayIso to the ORG-LOCAL date the cockpit would compute, and
  // verify the bucket assignment doesn't flip on the wrong side of UTC.
  const yesterdayCT = "2026-04-23";
  const todayCT = "2026-04-24";
  const tomorrowCT = "2026-04-25";

  it("at 23:55 CT (just before rollover), tomorrow's 06:00 CT pickup is still 'pickup_tomorrow'", () => {
    // Pickup at 2026-04-25 06:00 CT == 2026-04-25T11:00:00Z.
    const r = mk({ pickupWindowStart: "2026-04-25T11:00:00Z" });
    const got = bucketsForRow(r, { todayIso: todayCT });
    expect(got.has("pickup_tomorrow")).toBe(true);
    expect(got.has("pickup_today")).toBe(false);
  });

  it("at 00:05 CT (just after rollover), the same 06:00 CT pickup becomes 'pickup_today'", () => {
    const r = mk({ pickupWindowStart: "2026-04-25T11:00:00Z" });
    const got = bucketsForRow(r, { todayIso: tomorrowCT });
    expect(got.has("pickup_today")).toBe(true);
    expect(got.has("pickup_tomorrow")).toBe(false);
  });

  it("at 06:00 CT (mid-morning), yesterday's 18:00 CT pickup is past and not 'pickup_today'", () => {
    // Pickup at 2026-04-23 18:00 CT == 2026-04-23T23:00:00Z.
    const r = mk({ pickupWindowStart: "2026-04-23T23:00:00Z" });
    const got = bucketsForRow(r, { todayIso: todayCT });
    expect(got.has("pickup_today")).toBe(false);
    // 'yesterday' is implicitly in the stale / past_recent universe; the
    // bucket strip leaves it to the 'stale' chip when the row is stamped
    // past_stale, otherwise it's just outside today/tomorrow/at_risk.
    void yesterdayCT;
  });
});
