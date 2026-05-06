/**
 * Cover capture loops — Unit tests (Task #636).
 *
 * Exercises the three loops triggered when a rep marks an Available
 * Freight opportunity covered:
 *   1) Bench loop writes a positive `lane_carrier_interest` row tagged
 *      `available_now` against every matching recurring lane.
 *   2) Rate band loop bumps `lane_rate_history` counters and folds the
 *      new $/mi into the rolling averages when miles are available.
 *   3) Recurring-lane loop emits a suggestion payload when no
 *      `recurring_lanes` row matches the opp signature.
 *
 * Per-loop opt-out (`applyToBench`, `applyToRateBand`, `offerRecurringLane`)
 * and idempotency (re-marks reuse the existing bench row) are covered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyCoverCaptureLoops,
  type CoverCaptureLoopsInput,
  type CoverLoopsDbHandle,
} from "../services/coverCaptureLoops";
import {
  recurringLanes,
  laneRateHistory,
} from "@shared/schema";

type FakeRow = Record<string, any>;

/**
 * Test fake satisfies the structural shape of `CoverLoopsDbHandle` for the
 * narrow surface the loops actually use (`select/insert/update`). Fully
 * typing it against drizzle's complex generics would obscure intent, so we
 * intentionally cast the fake to the production handle type at the seam
 * — production code itself remains strictly typed.
 */
interface FakeDb {
  recurringLaneRows: FakeRow[];
  laneRateRows: FakeRow[];
  inserts: { table: string; values: FakeRow }[];
  updates: { table: string; patch: FakeRow; whereId: string | null }[];
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
}

/** Casts the test fake to the strict prod handle type at the test boundary. */
function asDbHandle(fake: FakeDb): CoverLoopsDbHandle {
  return fake as unknown as CoverLoopsDbHandle;
}

function makeFakeDb(seed: { recurringLanes?: FakeRow[]; laneRateHistory?: FakeRow[] } = {}): FakeDb {
  const recurring = seed.recurringLanes ?? [];
  const rateHistory = seed.laneRateHistory ?? [];
  const inserts: FakeDb["inserts"] = [];
  const updates: FakeDb["updates"] = [];

  const db: FakeDb = {
    recurringLaneRows: recurring,
    laneRateRows: rateHistory,
    inserts,
    updates,
    select: () => ({
      from: (tbl: any) => {
        const tableName = resolveTableName(tbl);
        const chain = {
          where: (_cond: any) => chain,
          limit: (_n: number) => chain,
          then: (resolve: (rows: FakeRow[]) => void) => {
            if (tableName === "recurring_lanes") resolve(recurring);
            else if (tableName === "lane_rate_history") resolve(rateHistory);
            else resolve([]);
          },
        } as any;
        return chain;
      },
    }),
    insert: (tbl: any) => ({
      values: async (vals: FakeRow) => {
        inserts.push({ table: resolveTableName(tbl), values: vals });
      },
    }),
    update: (tbl: any) => ({
      set: (patch: FakeRow) => ({
        where: async (_cond: any) => {
          updates.push({ table: resolveTableName(tbl), patch, whereId: null });
        },
      }),
    }),
  };
  return db;
}

function resolveTableName(tbl: any): string {
  if (tbl === recurringLanes) return "recurring_lanes";
  if (tbl === laneRateHistory) return "lane_rate_history";
  return "unknown";
}

function makeOpp(overrides: Partial<any> = {}): any {
  return {
    id: "opp_1",
    orgId: "org_a",
    origin: "Atlanta",
    originState: "GA",
    destination: "Dallas",
    destinationState: "TX",
    equipmentType: "Dry Van",
    companyId: "co_1",
    sourceRef: { orderId: "freight_opp:opp_1" },
    ...overrides,
  };
}

function makeStorage() {
  let benchRowSeq = 0;
  const upserts: any[] = [];
  const upsertLaneCarrierInterest = vi.fn(async (row: any) => {
    upserts.push(row);
    benchRowSeq += 1;
    return {
      id: `bench_${benchRowSeq}`,
      ...row,
    };
  });
  return { upsertLaneCarrierInterest, upserts };
}

function baseInput(overrides: Partial<CoverCaptureLoopsInput> = {}): CoverCaptureLoopsInput {
  return {
    org: "org_a",
    opp: makeOpp(),
    carrierId: "car_1",
    carrierName: "Acme Logistics",
    paidRate: 2200,
    customerRate: 2500,
    ...overrides,
  };
}

describe("applyCoverCaptureLoops", () => {
  describe("bench loop", () => {
    it("writes a positive bench row for every matching recurring lane", async () => {
      const db = makeFakeDb({
        recurringLanes: [
          { id: "lane_1", orgId: "org_a", origin: "Atlanta", originState: "GA", destination: "Dallas", destinationState: "TX", equipmentType: "Dry Van" },
          { id: "lane_2", orgId: "org_a", origin: "Atlanta", originState: "GA", destination: "Dallas", destinationState: "TX", equipmentType: "Dry Van" },
        ],
      });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });

      expect(result.bench.applied).toBe(true);
      expect(result.bench.rows).toHaveLength(2);
      expect(storage.upsertLaneCarrierInterest).toHaveBeenCalledTimes(2);
      expect(storage.upserts[0]).toMatchObject({
        laneId: "lane_1",
        carrierId: "car_1",
        carrierName: "Acme Logistics",
        interestStatus: "available_now",
        sourceType: "historical",
      });
      expect(storage.upserts[1]).toMatchObject({ laneId: "lane_2" });
    });

    it("skips the bench loop entirely when applyToBench is false", async () => {
      const db = makeFakeDb({
        recurringLanes: [{ id: "lane_1", orgId: "org_a" }],
      });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ options: { applyToBench: false } }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.bench.applied).toBe(false);
      expect(result.bench.reason).toBe("opted_out");
      expect(result.bench.rows).toHaveLength(0);
      expect(storage.upsertLaneCarrierInterest).not.toHaveBeenCalled();
    });

    it("returns no_recurring_lane when there are no matches", async () => {
      const db = makeFakeDb({ recurringLanes: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });

      expect(result.bench.applied).toBe(false);
      expect(result.bench.reason).toBe("no_recurring_lane");
      expect(storage.upsertLaneCarrierInterest).not.toHaveBeenCalled();
    });

    it("is idempotent: repeated covers reuse the upsert (dedup is the storage layer's job)", async () => {
      const db = makeFakeDb({
        recurringLanes: [{ id: "lane_1", orgId: "org_a" }],
      });
      const storage = makeStorage();

      // The fake `upsertLaneCarrierInterest` returns a stable id when
      // called with the same (laneId, carrierId) — this mirrors the
      // production dedup contract documented on the storage interface.
      storage.upsertLaneCarrierInterest.mockImplementation(async (row: any) => ({
        id: `bench_dedup_${row.laneId}_${row.carrierId}`,
        ...row,
      }));

      const r1 = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });
      const r2 = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });

      expect(r1.bench.rows[0].benchRowId).toBe("bench_dedup_lane_1_car_1");
      expect(r2.bench.rows[0].benchRowId).toBe("bench_dedup_lane_1_car_1");
    });
  });

  describe("rate band loop", () => {
    it("creates a fresh lane_rate_history row when none exists, with rate from miles", async () => {
      const db = makeFakeDb({ laneRateHistory: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ miles: 800 }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.rateBand.applied).toBe(true);
      expect(result.rateBand.reason).toBe("created_with_rate");
      expect(result.rateBand.loadsAfter).toBe(1);
      expect(result.rateBand.avgCostPerMileAfter).toBeCloseTo(2200 / 800, 4);
      expect(db.inserts).toHaveLength(1);
      expect(db.inserts[0].table).toBe("lane_rate_history");
      expect(db.inserts[0].values).toMatchObject({
        orgId: "org_a",
        originState: "GA",
        destinationState: "TX",
        equipmentType: "Dry Van",
        customerName: "__ANY__",
        loads: 1,
        loads30d: 1,
      });
      expect(db.inserts[0].values.avgCostPerMile).toBe((2200 / 800).toFixed(4));
    });

    it("creates a fresh row with counters only when miles are unavailable", async () => {
      const db = makeFakeDb({ laneRateHistory: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ miles: null }),
        { storage, db, resolveMiles: async () => null },
      );

      expect(result.rateBand.applied).toBe(true);
      expect(result.rateBand.reason).toBe("created_counters_only");
      expect(result.rateBand.avgCostPerMileAfter).toBeNull();
      expect(db.inserts[0].values.avgCostPerMile).toBeNull();
    });

    it("incrementally bumps loads and weight-averages $/mi when an existing row is found", async () => {
      const db = makeFakeDb({
        laneRateHistory: [
          {
            id: "lrh_1",
            orgId: "org_a",
            originState: "GA",
            destinationState: "TX",
            equipmentType: "Dry Van",
            customerName: "__ANY__",
            loads: 4,
            loads30d: 2,
            loads60d: 3,
            loads90d: 4,
            avgCostPerMile: "2.5000",
            avgCost30d: "2.5000",
            avgCost60d: "2.5000",
            avgCost90d: "2.5000",
            minCostPerMile: "2.0000",
            maxCostPerMile: "3.0000",
          },
        ],
      });
      const storage = makeStorage();

      // 2200 / 800 = 2.75 — weighted avg should be (2.5 * 4 + 2.75) / 5 = 2.55.
      const result = await applyCoverCaptureLoops(
        baseInput({ miles: 800 }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.rateBand.applied).toBe(true);
      expect(result.rateBand.reason).toBe("updated_with_rate");
      expect(result.rateBand.loadsAfter).toBe(5);
      expect(result.rateBand.avgCostPerMileAfter).toBeCloseTo(2.55, 4);
      expect(db.updates).toHaveLength(1);
      const patch = db.updates[0].patch;
      expect(patch.loads).toBe(5);
      expect(patch.loads30d).toBe(3);
      expect(patch.loads60d).toBe(4);
      expect(patch.loads90d).toBe(5);
      expect(patch.avgCostPerMile).toBe("2.5500");
      // min/max move only when the new sample crosses the existing bound.
      expect(patch.minCostPerMile).toBe("2.0000");
      expect(patch.maxCostPerMile).toBe("3.0000");
    });

    it("bumps counters only and leaves $/mi alone when miles are unavailable", async () => {
      const db = makeFakeDb({
        laneRateHistory: [
          {
            id: "lrh_1",
            orgId: "org_a",
            originState: "GA",
            destinationState: "TX",
            equipmentType: "Dry Van",
            customerName: "__ANY__",
            loads: 4,
            loads30d: 2,
            loads60d: 3,
            loads90d: 4,
            avgCostPerMile: "2.5000",
          },
        ],
      });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ miles: null }),
        { storage, db, resolveMiles: async () => null },
      );

      expect(result.rateBand.applied).toBe(true);
      expect(result.rateBand.reason).toBe("counters_only");
      expect(result.rateBand.loadsAfter).toBe(5);
      expect(result.rateBand.avgCostPerMileAfter).toBeCloseTo(2.5, 4);
      const patch = db.updates[0].patch;
      expect(patch.loads).toBe(5);
      expect(patch.avgCostPerMile).toBeUndefined();
    });

    it("skips the rate band loop entirely when applyToRateBand is false", async () => {
      const db = makeFakeDb({ laneRateHistory: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ miles: 800, options: { applyToRateBand: false } }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.rateBand.applied).toBe(false);
      expect(result.rateBand.reason).toBe("opted_out");
      expect(db.inserts).toHaveLength(0);
      expect(db.updates).toHaveLength(0);
    });

    it("short-circuits when origin/destination state is missing", async () => {
      const db = makeFakeDb({ laneRateHistory: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ miles: 800, opp: makeOpp({ originState: "" }) }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.rateBand.applied).toBe(false);
      expect(result.rateBand.reason).toBe("missing_state");
      expect(db.inserts).toHaveLength(0);
    });
  });

  describe("recurring-lane suggestion", () => {
    it("suggests setting a recurring lane when no match exists", async () => {
      const db = makeFakeDb({ recurringLanes: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });

      expect(result.recurringLaneSuggestion.suggested).toBe(true);
      expect(result.recurringLaneSuggestion.reason).toBe("no_recurring_lane");
      expect(result.recurringLaneSuggestion.suggestion).toMatchObject({
        origin: "Atlanta",
        originState: "GA",
        destination: "Dallas",
        destinationState: "TX",
        equipmentType: "Dry Van",
        companyId: "co_1",
      });
    });

    it("does not suggest when the lane already exists in recurring_lanes", async () => {
      const db = makeFakeDb({
        recurringLanes: [{ id: "lane_1", orgId: "org_a" }],
      });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(baseInput(), { storage, db: asDbHandle(db) });

      expect(result.recurringLaneSuggestion.suggested).toBe(false);
      expect(result.recurringLaneSuggestion.reason).toBe("already_recurring");
      expect(result.recurringLaneSuggestion.suggestion).toBeUndefined();
    });

    it("skips the suggestion entirely when offerRecurringLane is false", async () => {
      const db = makeFakeDb({ recurringLanes: [] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({ options: { offerRecurringLane: false } }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.recurringLaneSuggestion.suggested).toBe(false);
      expect(result.recurringLaneSuggestion.reason).toBe("opted_out");
    });
  });

  describe("opt-out combinations", () => {
    it("honors opting out of all three loops simultaneously", async () => {
      const db = makeFakeDb({ recurringLanes: [{ id: "lane_1", orgId: "org_a" }] });
      const storage = makeStorage();

      const result = await applyCoverCaptureLoops(
        baseInput({
          options: {
            applyToBench: false,
            applyToRateBand: false,
            offerRecurringLane: false,
          },
        }),
        { storage, db: asDbHandle(db) },
      );

      expect(result.bench.reason).toBe("opted_out");
      expect(result.rateBand.reason).toBe("opted_out");
      expect(result.recurringLaneSuggestion.reason).toBe("opted_out");
      expect(storage.upsertLaneCarrierInterest).not.toHaveBeenCalled();
      expect(db.inserts).toHaveLength(0);
      expect(db.updates).toHaveLength(0);
    });
  });
});
