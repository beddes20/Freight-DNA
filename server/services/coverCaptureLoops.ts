// Task #636 — Cover capture loops.
//
// When a rep marks an Available Freight opportunity as covered, three
// downstream surfaces should learn from that outcome so the next rep on
// the same lane benefits from it:
//
//   1. Bench loop — write a positive `lane_carrier_interest` row tagged
//      `interestStatus='available_now'` against every recurring lane that
//      matches the opp's lane signature. The carrier ranker pulls bench
//      via `getOrgWideBenchByLaneSignature` and promotes bench tier-0
//      carriers above `exact` history matches, so the cover carrier
//      jumps to the top of the next AF/LWQ shortlist.
//
//   2. Rate band loop — incrementally update `lane_rate_history` for the
//      (org, originState, destState, equipmentType, customerName='__ANY__')
//      key with the new cover. Bumps load counters always; updates the
//      $/mi rolling averages only when miles are available (looked up
//      from the source `load_fact` row when the opp came from there).
//
//   3. Recurring lane loop — when no `recurring_lanes` row exists for
//      the opp's signature, return a suggestion payload so the client can
//      surface a one-tap "Set as recurring lane" CTA. Acceptance routes
//      through the existing manual-lane endpoint.
//
// Each loop is opt-out per cover (booleans on the cover payload) and
// idempotent: re-marking the same opp covered does not create duplicate
// bench rows (`upsertLaneCarrierInterest` dedups) and does not double-
// count loads (the caller gates re-marks via `opp.status === 'covered'`
// before calling here, see `coverFreightOpportunity.ts`).

import { and, eq, sql } from "drizzle-orm";
import {
  recurringLanes,
  laneRateHistory,
  loadFact,
  type FreightOpportunity,
  type RecurringLane,
  type LaneCarrierInterest,
} from "@shared/schema";
import type { IStorage } from "../storage";

export interface CoverLoopOptions {
  applyToBench: boolean;
  applyToRateBand: boolean;
  offerRecurringLane: boolean;
}

export const DEFAULT_COVER_LOOP_OPTIONS: CoverLoopOptions = {
  applyToBench: true,
  applyToRateBand: true,
  offerRecurringLane: true,
};

export interface RecurringLaneSuggestion {
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  companyName: string | null;
  reason: string;
}

export interface CoverCaptureLoopsResult {
  bench: {
    applied: boolean;
    reason: string;
    rows: Array<{ laneId: string; benchRowId: string }>;
  };
  rateBand: {
    applied: boolean;
    reason: string;
    loadsAfter?: number;
    avgCostPerMileAfter?: number | null;
    milesUsed?: number | null;
  };
  recurringLaneSuggestion: {
    suggested: boolean;
    reason: string;
    suggestion?: RecurringLaneSuggestion;
  };
}

export interface CoverCaptureLoopsInput {
  org: string;
  opp: FreightOpportunity;
  carrierId: string | null;
  carrierName: string;
  paidRate: number;
  customerRate: number;
  /**
   * Lane miles for this cover. When provided, the rate band loop computes
   * cost-per-mile from `paidRate / miles` and folds it into the rolling
   * averages. When omitted, the loop falls back to looking up miles via
   * the opp's `sourceRef.orderId` against `load_fact`.
   */
  miles?: number | null;
  options?: Partial<CoverLoopOptions>;
}

export interface CoverCaptureLoopsDeps {
  storage: Pick<
    IStorage,
    "upsertLaneCarrierInterest"
  >;
  /**
   * Drizzle-shaped db. Defaults to the real `db` from `../storage`. Tests
   * inject a fake that intercepts `select`/`insert`/`update` calls.
   */
  db?: any;
  /** Optional override so tests can short-circuit miles lookup. */
  resolveMiles?: (orgId: string, opp: FreightOpportunity) => Promise<number | null>;
}

const NORM = (s: string | null | undefined) => (s ?? "").toString().trim().toLowerCase();

/**
 * Apply the three cover capture loops. Each loop short-circuits cleanly
 * when its opt-out flag is false or when its preconditions aren't met,
 * and never throws — failures are returned as `applied: false` with a
 * reason so the caller's primary write path (status flip + load_fact
 * emit) is never blocked by a loop side-effect.
 */
export async function applyCoverCaptureLoops(
  input: CoverCaptureLoopsInput,
  deps: CoverCaptureLoopsDeps,
): Promise<CoverCaptureLoopsResult> {
  const opts: CoverLoopOptions = { ...DEFAULT_COVER_LOOP_OPTIONS, ...(input.options ?? {}) };
  const db = deps.db ?? (await import("../storage")).db;

  // Resolve all matching recurring lanes for the opp signature once;
  // bench loop and recurring-lane loop both need this answer. The lookup
  // is wrapped so a transient DB error never throws out of this service —
  // each loop reports `applied: false` with a reason instead.
  let matches: RecurringLane[] = [];
  let matchError: string | null = null;
  try {
    matches = await findMatchingRecurringLanes(db, input.org, input.opp);
  } catch (e) {
    matchError = `recurring_lane_lookup_failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[cover-loops] ${matchError}`);
  }

  let bench: CoverCaptureLoopsResult["bench"];
  if (!opts.applyToBench) {
    bench = { applied: false, reason: "opted_out", rows: [] };
  } else if (matchError) {
    bench = { applied: false, reason: matchError, rows: [] };
  } else {
    try {
      bench = await runBenchLoop(deps.storage, matches, input);
    } catch (e) {
      bench = {
        applied: false,
        reason: `bench_loop_failed: ${e instanceof Error ? e.message : String(e)}`,
        rows: [],
      };
      console.warn(`[cover-loops] ${bench.reason}`);
    }
  }

  let rateBand: CoverCaptureLoopsResult["rateBand"];
  if (!opts.applyToRateBand) {
    rateBand = { applied: false, reason: "opted_out" };
  } else {
    try {
      rateBand = await runRateBandLoop(db, deps.resolveMiles, input);
    } catch (e) {
      rateBand = {
        applied: false,
        reason: `rate_band_loop_failed: ${e instanceof Error ? e.message : String(e)}`,
      };
      console.warn(`[cover-loops] ${rateBand.reason}`);
    }
  }

  let recurringLaneSuggestion: CoverCaptureLoopsResult["recurringLaneSuggestion"];
  if (!opts.offerRecurringLane) {
    recurringLaneSuggestion = { suggested: false, reason: "opted_out" };
  } else if (matchError) {
    recurringLaneSuggestion = { suggested: false, reason: matchError };
  } else {
    recurringLaneSuggestion = buildRecurringLaneSuggestion(matches, input);
  }

  return { bench, rateBand, recurringLaneSuggestion };
}

// ── Loop 1: Bench ──────────────────────────────────────────────────────────

async function runBenchLoop(
  storage: CoverCaptureLoopsDeps["storage"],
  matches: RecurringLane[],
  input: CoverCaptureLoopsInput,
): Promise<CoverCaptureLoopsResult["bench"]> {
  if (matches.length === 0) {
    return {
      applied: false,
      reason: "no_recurring_lane",
      rows: [],
    };
  }
  const rows: Array<{ laneId: string; benchRowId: string }> = [];
  const reason = `Covered ${formatRate(input.paidRate)} on opp ${input.opp.id} (${new Date().toISOString().slice(0, 10)})`;
  for (const lane of matches) {
    try {
      const upserted: LaneCarrierInterest = await storage.upsertLaneCarrierInterest({
        laneId: lane.id,
        carrierId: input.carrierId,
        carrierName: input.carrierName,
        interestStatus: "available_now",
        sourceType: "historical",
        fitReason: reason,
        notes: `Auto-added from cover capture loop`,
        classifiedAt: new Date().toISOString(),
      });
      rows.push({ laneId: lane.id, benchRowId: upserted.id });
    } catch (e) {
      console.warn(
        `[cover-loops] bench upsert failed for lane ${lane.id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  if (rows.length === 0) {
    return { applied: false, reason: "all_writes_failed", rows: [] };
  }
  return {
    applied: true,
    reason: `Wrote ${rows.length} positive bench row(s)`,
    rows,
  };
}

// ── Loop 2: Rate band ──────────────────────────────────────────────────────

async function runRateBandLoop(
  db: any,
  resolveMiles: CoverCaptureLoopsDeps["resolveMiles"],
  input: CoverCaptureLoopsInput,
): Promise<CoverCaptureLoopsResult["rateBand"]> {
  const originState = (input.opp.originState ?? "").toUpperCase();
  const destinationState = (input.opp.destinationState ?? "").toUpperCase();
  if (!originState || !destinationState) {
    return { applied: false, reason: "missing_state" };
  }
  const equipment = (input.opp.equipmentType ?? "").trim() || "ALL";
  const customer = "__ANY__";

  // Resolve miles: explicit input wins, else custom resolver, else
  // load_fact lookup via opp.sourceRef.orderId.
  let miles: number | null = input.miles ?? null;
  if (miles == null) {
    if (resolveMiles) {
      try {
        miles = await resolveMiles(input.org, input.opp);
      } catch {
        miles = null;
      }
    } else {
      miles = await lookupMilesFromLoadFact(db, input.org, input.opp);
    }
  }
  const newCostPerMile = miles && miles > 0 ? input.paidRate / miles : null;

  // Find existing aggregate row.
  const existingRows = await db
    .select()
    .from(laneRateHistory)
    .where(
      and(
        eq(laneRateHistory.orgId, input.org),
        eq(laneRateHistory.originState, originState),
        eq(laneRateHistory.destinationState, destinationState),
        eq(laneRateHistory.equipmentType, equipment),
        eq(laneRateHistory.customerName, customer),
      ),
    )
    .limit(1);

  const existing = existingRows[0] as any | undefined;

  if (!existing) {
    // Create a fresh row reflecting just this cover.
    const initialAvg = newCostPerMile != null ? newCostPerMile.toFixed(4) : null;
    try {
      await db.insert(laneRateHistory).values({
        orgId: input.org,
        originState,
        destinationState,
        equipmentType: equipment,
        customerName: customer,
        windowDays: 180,
        loads: 1,
        loads30d: 1,
        loads60d: 1,
        loads90d: 1,
        avgCostPerMile: initialAvg,
        medianCostPerMile: initialAvg,
        minCostPerMile: initialAvg,
        maxCostPerMile: initialAvg,
        avgCost30d: initialAvg,
        avgCost60d: initialAvg,
        avgCost90d: initialAvg,
        uniqueCarriers: 1,
      });
    } catch (e) {
      return {
        applied: false,
        reason: `insert_failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return {
      applied: true,
      reason: newCostPerMile != null ? "created_with_rate" : "created_counters_only",
      loadsAfter: 1,
      avgCostPerMileAfter: newCostPerMile,
      milesUsed: miles,
    };
  }

  // Incremental update: bump load counters; weighted-average $/mi only
  // when we have miles. Median/p25/p75 are intentionally left as-is —
  // those need full re-aggregation to stay honest, which the nightly
  // `recomputeLaneRateHistory` job handles.
  const oldLoads = Number(existing.loads ?? 0);
  const newLoads = oldLoads + 1;

  const updatePatch: Record<string, unknown> = {
    loads: newLoads,
    loads30d: Number(existing.loads30d ?? 0) + 1,
    loads60d: Number(existing.loads60d ?? 0) + 1,
    loads90d: Number(existing.loads90d ?? 0) + 1,
    computedAt: new Date(),
  };

  let newAvg: number | null = existing.avgCostPerMile != null ? Number(existing.avgCostPerMile) : null;
  if (newCostPerMile != null) {
    const oldAvg = existing.avgCostPerMile != null ? Number(existing.avgCostPerMile) : null;
    newAvg = oldAvg != null && oldLoads > 0
      ? (oldAvg * oldLoads + newCostPerMile) / newLoads
      : newCostPerMile;
    updatePatch.avgCostPerMile = newAvg.toFixed(4);
    // 30/60/90 windows mirror the all-time avg movement when we don't
    // have a per-window split — pragmatic since the nightly recompute
    // re-grounds them.
    if (existing.avgCost30d != null) {
      const old30 = Number(existing.avgCost30d);
      updatePatch.avgCost30d = ((old30 * oldLoads + newCostPerMile) / newLoads).toFixed(4);
    } else {
      updatePatch.avgCost30d = newCostPerMile.toFixed(4);
    }
    if (existing.avgCost60d != null) {
      const old60 = Number(existing.avgCost60d);
      updatePatch.avgCost60d = ((old60 * oldLoads + newCostPerMile) / newLoads).toFixed(4);
    } else {
      updatePatch.avgCost60d = newCostPerMile.toFixed(4);
    }
    if (existing.avgCost90d != null) {
      const old90 = Number(existing.avgCost90d);
      updatePatch.avgCost90d = ((old90 * oldLoads + newCostPerMile) / newLoads).toFixed(4);
    } else {
      updatePatch.avgCost90d = newCostPerMile.toFixed(4);
    }
    const oldMin = existing.minCostPerMile != null ? Number(existing.minCostPerMile) : null;
    const oldMax = existing.maxCostPerMile != null ? Number(existing.maxCostPerMile) : null;
    updatePatch.minCostPerMile = (oldMin == null ? newCostPerMile : Math.min(oldMin, newCostPerMile)).toFixed(4);
    updatePatch.maxCostPerMile = (oldMax == null ? newCostPerMile : Math.max(oldMax, newCostPerMile)).toFixed(4);
  }

  try {
    await db
      .update(laneRateHistory)
      .set(updatePatch)
      .where(eq(laneRateHistory.id, existing.id));
  } catch (e) {
    return {
      applied: false,
      reason: `update_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    applied: true,
    reason: newCostPerMile != null ? "updated_with_rate" : "counters_only",
    loadsAfter: newLoads,
    avgCostPerMileAfter: newAvg,
    milesUsed: miles,
  };
}

// ── Loop 3: Recurring lane suggestion ──────────────────────────────────────

function buildRecurringLaneSuggestion(
  matches: RecurringLane[],
  input: CoverCaptureLoopsInput,
): CoverCaptureLoopsResult["recurringLaneSuggestion"] {
  if (matches.length > 0) {
    return { suggested: false, reason: "already_recurring" };
  }
  return {
    suggested: true,
    reason: "no_recurring_lane",
    suggestion: {
      origin: input.opp.origin,
      originState: input.opp.originState ?? null,
      destination: input.opp.destination,
      destinationState: input.opp.destinationState ?? null,
      equipmentType: input.opp.equipmentType ?? null,
      companyId: input.opp.companyId ?? null,
      companyName: null, // client fills from cockpit row
      reason: `Cover on lane ${input.opp.origin} → ${input.opp.destination}`,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function findMatchingRecurringLanes(
  db: any,
  org: string,
  opp: FreightOpportunity,
): Promise<RecurringLane[]> {
  const origin = NORM(opp.origin);
  const originState = NORM(opp.originState);
  const destination = NORM(opp.destination);
  const destinationState = NORM(opp.destinationState);
  const equipment = NORM(opp.equipmentType);

  const rows: RecurringLane[] = await db
    .select()
    .from(recurringLanes)
    .where(
      and(
        eq(recurringLanes.orgId, org),
        sql`lower(trim(${recurringLanes.origin})) = ${origin}`,
        sql`coalesce(lower(trim(${recurringLanes.originState})), '') = ${originState}`,
        sql`lower(trim(${recurringLanes.destination})) = ${destination}`,
        sql`coalesce(lower(trim(${recurringLanes.destinationState})), '') = ${destinationState}`,
        sql`coalesce(lower(trim(${recurringLanes.equipmentType})), '') = ${equipment}`,
      ),
    );
  return rows;
}

async function lookupMilesFromLoadFact(
  db: any,
  org: string,
  opp: FreightOpportunity,
): Promise<number | null> {
  const ref = opp.sourceRef as { orderId?: unknown } | null | undefined;
  const orderId = typeof ref?.orderId === "string" ? ref.orderId.trim() : "";
  if (!orderId || orderId.startsWith("freight_opp:")) return null;
  try {
    const rows: any[] = await db
      .select({ totalMiles: loadFact.totalMiles })
      .from(loadFact)
      .where(and(eq(loadFact.orgId, org), eq(loadFact.orderId, orderId)))
      .limit(1);
    const tm = rows[0]?.totalMiles;
    const n = tm == null ? null : Number(tm);
    return n != null && isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function formatRate(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}
