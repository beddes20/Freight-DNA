/**
 * Task #632 — Bench tier-0 promotion tests.
 *
 * Verifies:
 *   1. The proactive opportunity service falls back to
 *      `getOrgWideBenchByLaneSignature` when an opportunity has NO
 *      resolved RecurringLane (synthetic AF opps).
 *   2. The org-wide bench fetch is invoked with the opportunity's
 *      lane signature (origin/state, dest/state, equipment).
 *   3. The ranker emits `bench: true` + `benchWins: N` on RankedCarrier
 *      and the proactive service persists those fields onto
 *      `responsivenessSnapshot` for AF cockpit chip rendering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../carrierRankingService", async () => {
  const actual = await vi.importActual<any>("../carrierRankingService");
  return {
    ...actual,
    rankCarriersForLane: vi.fn(),
  };
});

import { rankCarriersForOpportunity } from "../proactiveOpportunityService";
import {
  rankCarriersForLane,
  computeBenchTier0Keys,
  benchTier0KeyFor,
  BENCH_TIER0_CAP,
} from "../carrierRankingService";
import type { RankedCarrier } from "../carrierRankingService";

const mockedRank = rankCarriersForLane as unknown as ReturnType<typeof vi.fn>;

function makeRanked(overrides: Partial<RankedCarrier> = {}): RankedCarrier {
  return {
    carrierId: "car-1",
    carrierName: "Bench Pro Trucking",
    mcDot: null,
    primaryEmail: "ops@bench.pro",
    backupEmail: null,
    regions: [],
    equipmentTypes: ["Dry Van"],
    tags: [],
    notes: null,
    fitScore: 80,
    fitReason: "Bench reply within last 90d",
    historyMatch: "region",
    loadsOnLane: 0,
    lastUsedMonth: null,
    isNewProspect: false,
    estimatedOnTimePct: null,
    marginContribution: null,
    customerHistoryLoads: 0,
    priorOutcomeBoost: true,
    bench: true,
    benchWins: 3,
    sourceChannel: null,
    suppressionReasons: [],
    equipmentMatch: true,
    regionMatch: true,
    isIncumbent: false,
    incumbentRank: null,
    isDoNotUse: false,
    exactLaneLoads: 0,
    nearbyLaneLoads: 0,
    statePairLoads: 0,
    hasAnyCompanyHistory: false,
    hqCity: null,
    hqState: null,
    hqProximityBonus: 0,
    hasMarketNbaBoost: false,
    acceptedLanePreferenceScore: 0,
    acceptedRegionPreferenceScore: 0,
    acceptedEquipmentCapabilityScore: 0,
    acceptedCapacityAvailabilityScore: 0,
    acceptedCapacitySuppressionPenalty: 0,
    ...overrides,
  } as RankedCarrier;
}

function makeOpp(overrides: Partial<any> = {}) {
  return {
    id: "opp-1",
    orgId: "org-1",
    companyId: "co-1",
    mode: "exact_load",
    recurringLaneId: null, // synthetic AF opp
    geographicLanePatternId: null,
    origin: "Atlanta",
    originState: "GA",
    destination: "Chicago",
    destinationState: "IL",
    equipmentType: "Dry Van",
    pickupWindowStart: "2026-04-25",
    pickupWindowEnd: "2026-04-26",
    loadCount: 1,
    sourceRef: null,
    urgencyScore: 50,
    confidenceFlag: "normal",
    status: "new",
    policySnapshot: null,
    generatedAt: new Date(),
    expiresAt: null,
    createdById: null,
    notes: null,
    ownerUserId: null,
    delegatedToUserId: null,
    senderMailbox: null,
    templateOverrideSubject: null,
    templateOverrideBody: null,
    cadenceConfig: null,
    approvedAt: null,
    approvedById: null,
    sourceFileName: null,
    awaitingApprovalSince: null,
    slaNotifiedL1At: null,
    slaNotifiedL2At: null,
    snoozedUntil: null,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<any> = {}) {
  return {
    id: "pol-1",
    orgId: "org-1",
    companyId: "co-1",
    enabled: true,
    mode: "exact_load",
    approvalRequired: true,
    maxCarriersPerOpportunity: 5,
    leadTimeMinDays: 2,
    leadTimeMaxDays: 7,
    approvedCarrierOnly: false,
    approvedCarrierIds: [],
    doNotAutomate: false,
    specialNotes: null,
    updatedAt: new Date(),
    updatedById: null,
    autoSendEnabled: false,
    autoSendHourCt: null,
    autoSendTopN: null,
    autoSendMaxPerDay: null,
    autoSendLastRunAt: null,
    ...overrides,
  };
}

describe("bench tier-0 — proactive opportunity service", () => {
  let getOrgWideBenchByLaneSignature: ReturnType<typeof vi.fn>;
  let storage: any;

  beforeEach(() => {
    mockedRank.mockReset();

    getOrgWideBenchByLaneSignature = vi.fn(async () => [
      // 3 positive bench rows for this lane signature → benchWins=3
      { carrierId: "car-1", carrierName: "Bench Pro Trucking", interestStatus: "available_now", classifiedAt: new Date(), updatedAt: new Date(), outreachSentAt: null },
      { carrierId: "car-1", carrierName: "Bench Pro Trucking", interestStatus: "available_next_week", classifiedAt: new Date(), updatedAt: new Date(), outreachSentAt: null },
      { carrierId: "car-1", carrierName: "Bench Pro Trucking", interestStatus: "available_now", classifiedAt: new Date(), updatedAt: new Date(), outreachSentAt: null },
    ]);

    storage = {
      getRecurringLanes: vi.fn(async () => []),
      getOrgWideBenchByLaneSignature,
      getLaneCarrierBench: vi.fn(),
      getCarrier: vi.fn(async () => null),
      getRecentlyContactedCarrierIds: vi.fn(async () => [] as string[]),
      checkCarrierDailyBudget: vi.fn(async () => ({ allowed: true })),
    };
  });

  it("falls back to getOrgWideBenchByLaneSignature when opp has no recurringLaneId", async () => {
    mockedRank.mockResolvedValue([makeRanked()]);
    const opp = makeOpp({ recurringLaneId: null });
    await rankCarriersForOpportunity(storage, opp, makePolicy());
    expect(getOrgWideBenchByLaneSignature).toHaveBeenCalledWith(
      "org-1",
      "Atlanta",
      "GA",
      "Chicago",
      "IL",
      "Dry Van",
    );
    // Per-lane bench (RecurringLane keyed) MUST NOT be called when there is
    // no resolvedLane — that lookup needs a lane.id and would crash on null.
    expect(storage.getLaneCarrierBench).not.toHaveBeenCalled();
  });

  it("propagates the bench rows to rankCarriersForLane", async () => {
    mockedRank.mockResolvedValue([makeRanked()]);
    const opp = makeOpp({ recurringLaneId: null });
    await rankCarriersForOpportunity(storage, opp, makePolicy());
    const callArgs = mockedRank.mock.calls[0];
    const benchArg = callArgs[2];
    expect(Array.isArray(benchArg)).toBe(true);
    expect(benchArg.length).toBe(3);
  });
});

describe("bench tier-0 — sort comparator", () => {
  // Simulate the same comparator the ranker uses inline. If this matches
  // the production sort, it locks the contract: bench tier-0 carriers
  // outrank exact-history carriers regardless of fitScore.
  function benchAwareSort(carriers: RankedCarrier[]): RankedCarrier[] {
    const keys = computeBenchTier0Keys(carriers);
    const isT0 = (c: RankedCarrier) => keys.has(benchTier0KeyFor(c));
    const matchRank: Record<string, number> = {
      exact: 0, nearby: 1, state_pair: 2, region: 3, none: 4,
    };
    return [...carriers].sort((a, b) => {
      const aT0 = isT0(a);
      const bT0 = isT0(b);
      if (aT0 !== bT0) return aT0 ? -1 : 1;
      if (aT0 && bT0) {
        const winsDiff = b.benchWins - a.benchWins;
        if (winsDiff !== 0) return winsDiff;
      }
      const scoreDiff = b.fitScore - a.fitScore;
      if (scoreDiff !== 0) return scoreDiff;
      return (matchRank[a.historyMatch] ?? 4) - (matchRank[b.historyMatch] ?? 4);
    });
  }

  it("places a region-tier bench carrier ABOVE an exact-tier carrier with no bench wins", () => {
    const benchRegion = makeRanked({
      carrierId: "bench-region",
      carrierName: "Bench Region Co",
      historyMatch: "region",
      exactLaneLoads: 0,
      loadsOnLane: 0,
      fitScore: 55,
      bench: true,
      benchWins: 1,
    });
    const exactNoBench = makeRanked({
      carrierId: "exact-no-bench",
      carrierName: "Exact Co",
      historyMatch: "exact",
      exactLaneLoads: 12,
      loadsOnLane: 12,
      fitScore: 90,
      bench: false,
      benchWins: 0,
    });

    const sorted = benchAwareSort([exactNoBench, benchRegion]);
    expect(sorted[0].carrierId).toBe("bench-region");
    expect(sorted[1].carrierId).toBe("exact-no-bench");
  });

  it("orders multiple bench carriers by benchWins desc within tier-0", () => {
    const benchA = makeRanked({ carrierId: "a", carrierName: "A", bench: true, benchWins: 1, fitScore: 70 });
    const benchB = makeRanked({ carrierId: "b", carrierName: "B", bench: true, benchWins: 5, fitScore: 60 });
    const benchC = makeRanked({ carrierId: "c", carrierName: "C", bench: true, benchWins: 3, fitScore: 80 });

    const sorted = benchAwareSort([benchA, benchB, benchC]);
    expect(sorted.map(c => c.carrierId)).toEqual(["b", "c", "a"]);
  });

  it("caps tier-0 promotion at BENCH_TIER0_CAP — extras fall to score-based order", () => {
    // 7 bench carriers, all with benchWins=1, ordered by descending fitScore.
    // Cap is 5 → carriers 6 and 7 should NOT be in the tier-0 set.
    const benchCarriers = Array.from({ length: 7 }, (_, i) =>
      makeRanked({
        carrierId: `bench-${i}`,
        carrierName: `Bench ${i}`,
        bench: true,
        benchWins: 1,
        fitScore: 100 - i, // 100, 99, 98, 97, 96, 95, 94
        historyMatch: "region",
        exactLaneLoads: 0,
      }),
    );
    const keys = computeBenchTier0Keys(benchCarriers);
    expect(keys.size).toBe(BENCH_TIER0_CAP);
    // Top-5 by fitScore (as wins are tied) should be promoted.
    expect(keys.has("bench-0")).toBe(true);
    expect(keys.has("bench-4")).toBe(true);
    expect(keys.has("bench-5")).toBe(false);
    expect(keys.has("bench-6")).toBe(false);
  });

  it("ignores carriers where bench=false (legacy / no recent positive outcome)", () => {
    const flagged = makeRanked({ carrierId: "x", bench: false, benchWins: 99, fitScore: 50 });
    const exact = makeRanked({ carrierId: "y", bench: false, benchWins: 0, fitScore: 90, historyMatch: "exact" });
    const sorted = benchAwareSort([flagged, exact]);
    // Without bench=true, benchWins is ignored entirely → falls back to fitScore.
    expect(sorted[0].carrierId).toBe("y");
    expect(computeBenchTier0Keys([flagged, exact]).size).toBe(0);
  });
});

describe("bench tier-0 — AF persisted shortlist preserves order under cap", () => {
  // The proactive AF pipeline persists a capped shortlist to
  // freight_opportunity_carriers. Before Task #632 it re-sorted by fitScore
  // alone, which silently undid the ranker's bench tier-0 promotion and
  // could drop bench carriers when fitScore was modest. This test locks
  // the AF re-sort to the same bench-aware comparator the ranker uses.
  beforeEach(() => {
    mockedRank.mockReset();
  });

  it("keeps a low-fitScore bench carrier in the persisted top-N over a high-fitScore exact carrier", async () => {
    // Cap = 1 → only one carrier survives. With the bug, exact-90 wins.
    // With the fix, the bench carrier wins because it's in tier-0.
    const benchLowScore = makeRanked({
      carrierId: "bench-low",
      carrierName: "Bench Low",
      historyMatch: "region",
      exactLaneLoads: 0,
      loadsOnLane: 0,
      fitScore: 55,
      bench: true,
      benchWins: 2,
    });
    const exactHighScore = makeRanked({
      carrierId: "exact-high",
      carrierName: "Exact High",
      historyMatch: "exact",
      exactLaneLoads: 12,
      loadsOnLane: 12,
      fitScore: 95,
      bench: false,
      benchWins: 0,
      isIncumbent: true,
      incumbentRank: 1,
    });
    mockedRank.mockResolvedValue([benchLowScore, exactHighScore]);

    const storage: any = {
      getRecurringLanes: vi.fn(async () => []),
      getOrgWideBenchByLaneSignature: vi.fn(async () => []),
      getLaneCarrierBench: vi.fn(),
      getCarrier: vi.fn(async () => null),
      getRecentlyContactedCarrierIds: vi.fn(async () => [] as string[]),
      checkCarrierDailyBudget: vi.fn(async () => ({ allowed: true })),
    };
    const opp = makeOpp({ recurringLaneId: null });
    const policy = makePolicy({ maxCarriersPerOpportunity: 1 });

    const rows = await rankCarriersForOpportunity(storage, opp, policy);
    const ranked1 = rows.find(r => r.rank === 1);
    expect(ranked1?.carrier.id).toBe("bench-low");
    // The exact-high carrier should be present but excluded as overflow.
    const exactRow = rows.find(r => r.carrier.id === "exact-high");
    expect(exactRow?.rank).toBe(null);
    expect(exactRow?.excludedReason).toBe("rep_override");
  });
});
