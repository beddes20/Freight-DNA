/**
 * Carrier ↔ lane fit scoring (Task #369).
 *
 * Generalized from the much heavier `carrierRankingService.rankCarriersForLane`
 * so any caller — the recommendation engine, an NBA, a lane plan UI — can ask
 * "how good a fit is carrier X for lane Y" in a single function call without
 * spinning up the full RFP-style pipeline.
 *
 * Inputs:
 *   - origin/destination state + equipment_type
 *   - load_fact realized history per carrier (the executed truth)
 *   - carriers.statesServed / equipmentTypes (the carrier's claimed capability)
 *   - optional customerName for customer-specific run history
 *   - optional scorecardSignal (on-time %, recent margin, recency) — when
 *     supplied, blends into the final fit score so the same model captures
 *     "good carrier overall" as well as "ran this lane before"
 *
 * Output: a 0–100 fit score with sub-scores and an evidence tier so callers
 * can show why the carrier was suggested.
 *
 *   Base evidence:
 *     exact (≥1 run on same lane+equipment)         → start at 70, +5 per add'l run capped at 95
 *     nearby (same origin OR destination state)     → start at 50, +3 per run capped at 75
 *     region (states_served / regions overlap)      → 30
 *     equipment_match additive bonus                → +10
 *     none                                          → 0
 *   Modifier signals (each ±0–8 pts):
 *     on_time:  >=95% +8, 85-95% +4, 70-85% 0, <70% -4
 *     margin:   >=15% +8, 10-15% +4, 0-10% 0, <0%  -4
 *     recency:  <30d +6, 30-90d +3, 90-180d 0, >180d -4
 *     customer_history: >=3 runs with this customer +6, 1-2 +3, 0 0
 */

import { sql, eq, and } from "drizzle-orm";
import { db } from "./storage";
import { loadFact, carriers as carriersTbl, carrierLaneFit, type InsertCarrierLaneFit } from "@shared/schema";

export interface FitInput {
  orgId: string;
  carrierName: string;
  originState: string;
  destinationState: string;
  equipmentType?: string | null;
  customerName?: string | null;
  scorecardSignal?: ScorecardSignal | null;
}

export interface ScorecardSignal {
  onTimePct: number | null;
  marginPct: number;
  daysSinceLastLoad: number | null;
}

export interface FitResult {
  fitScore: number;
  baseScore: number;
  modifierScore: number;
  exactLaneRuns: number;
  nearbyRuns: number;
  customerLaneRuns: number;
  equipmentMatch: boolean;
  regionMatch: boolean;
  evidenceTier: "exact" | "nearby" | "region" | "none";
  reason: string;
  modifiers: { onTime: number; margin: number; recency: number; customer: number };
}

interface CountsRow {
  exact_runs: string;
  exact_eq_runs: string;
  nearby_runs: string;
  customer_lane_runs: string;
  [k: string]: unknown;
}

export async function scoreCarrierLaneFit(input: FitInput): Promise<FitResult> {
  const { orgId, carrierName, originState, destinationState, equipmentType, customerName, scorecardSignal } = input;
  const o = originState.toUpperCase();
  const d = destinationState.toUpperCase();
  const equip = equipmentType?.trim() || null;
  const customer = customerName?.trim() || null;

  // Pull carrier rolodex row for region/equipment claims.
  const [carrierRow] = await db.select().from(carriersTbl)
    .where(and(eq(carriersTbl.orgId, orgId), eq(carriersTbl.name, carrierName)))
    .limit(1);

  // Realized run counts in one round-trip: exact lane (with/without equipment),
  // nearby (one endpoint match), and customer-specific lane runs.
  const counts = await db.execute<CountsRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE origin_state = ${o} AND destination_state = ${d})::text AS exact_runs,
      COUNT(*) FILTER (WHERE origin_state = ${o} AND destination_state = ${d} AND (${equip}::text IS NULL OR equipment_type = ${equip}))::text AS exact_eq_runs,
      COUNT(*) FILTER (WHERE (origin_state = ${o} OR destination_state = ${d}) AND NOT (origin_state = ${o} AND destination_state = ${d}))::text AS nearby_runs,
      COUNT(*) FILTER (WHERE origin_state = ${o} AND destination_state = ${d} AND (${customer}::text IS NULL OR customer_name = ${customer}))::text AS customer_lane_runs
    FROM load_fact
    WHERE org_id = ${orgId}
      AND (LOWER(COALESCE(move_status,'')) LIKE '%deliver%' OR bucket = 'realized')
      AND carrier_name = ${carrierName}
  `);
  const row: CountsRow = counts.rows[0] ?? { exact_runs: "0", exact_eq_runs: "0", nearby_runs: "0", customer_lane_runs: "0" };
  const exactRuns = Number(row.exact_eq_runs) || 0;
  const exactRunsAnyEq = Number(row.exact_runs) || 0;
  const nearbyRuns = Number(row.nearby_runs) || 0;
  const customerLaneRuns = customer ? Number(row.customer_lane_runs) || 0 : 0;

  const states = ((carrierRow?.statesServed ?? []) as string[]).map(s => s.toUpperCase());
  const equipmentClaim = ((carrierRow?.equipmentTypes ?? []) as string[]).map(e => e.toLowerCase());
  const regionMatch = states.length === 0 ? false : (states.includes(o) || states.includes(d));
  const equipmentMatch = !equip ? false : equipmentClaim.length === 0 ? false : equipmentClaim.some(e => e.includes(equip.toLowerCase()) || equip.toLowerCase().includes(e));

  let evidenceTier: FitResult["evidenceTier"] = "none";
  let baseScore = 0;
  let reasonParts: string[] = [];

  if (exactRuns > 0) {
    evidenceTier = "exact";
    baseScore = 70 + Math.min(25, (exactRuns - 1) * 5);
    reasonParts.push(`${exactRuns} prior realized run${exactRuns === 1 ? "" : "s"} on this exact lane${equip ? ` with ${equip}` : ""}`);
  } else if (exactRunsAnyEq > 0) {
    evidenceTier = "exact";
    baseScore = 60 + Math.min(20, (exactRunsAnyEq - 1) * 4);
    reasonParts.push(`${exactRunsAnyEq} prior realized run${exactRunsAnyEq === 1 ? "" : "s"} on this lane (different equipment)`);
  } else if (nearbyRuns > 0) {
    evidenceTier = "nearby";
    baseScore = 50 + Math.min(20, nearbyRuns * 3);
    reasonParts.push(`${nearbyRuns} prior realized run${nearbyRuns === 1 ? "" : "s"} touching ${o} or ${d}`);
  } else if (regionMatch) {
    evidenceTier = "region";
    baseScore = 30;
    reasonParts.push(`Carrier rolodex lists ${states.includes(o) ? o : d} in states served, but no realized runs`);
  } else {
    baseScore = 0;
    reasonParts.push("No exact, nearby, or region evidence");
  }

  if (equipmentMatch && evidenceTier !== "none") baseScore = Math.min(100, baseScore + 10);

  // ── Modifier signals (only meaningful when we have a base) ────────────────
  const modifiers = { onTime: 0, margin: 0, recency: 0, customer: 0 };
  if (evidenceTier !== "none" && scorecardSignal) {
    const ot = scorecardSignal.onTimePct;
    if (ot !== null) {
      if (ot >= 95) { modifiers.onTime = 8; reasonParts.push(`on-time ${ot.toFixed(0)}%`); }
      else if (ot >= 85) modifiers.onTime = 4;
      else if (ot < 70) { modifiers.onTime = -4; reasonParts.push(`on-time only ${ot.toFixed(0)}%`); }
    }
    const mp = scorecardSignal.marginPct;
    if (mp >= 15) { modifiers.margin = 8; reasonParts.push(`margin ${mp.toFixed(0)}%`); }
    else if (mp >= 10) modifiers.margin = 4;
    else if (mp < 0) { modifiers.margin = -4; reasonParts.push(`negative margin history ${mp.toFixed(0)}%`); }

    const ds = scorecardSignal.daysSinceLastLoad;
    if (ds !== null) {
      if (ds < 30) modifiers.recency = 6;
      else if (ds <= 90) modifiers.recency = 3;
      else if (ds > 180) { modifiers.recency = -4; reasonParts.push(`last load ${ds}d ago`); }
    }
  }
  if (evidenceTier !== "none" && customer) {
    if (customerLaneRuns >= 3) { modifiers.customer = 6; reasonParts.push(`${customerLaneRuns} runs for this customer`); }
    else if (customerLaneRuns >= 1) modifiers.customer = 3;
  }

  const modifierScore = modifiers.onTime + modifiers.margin + modifiers.recency + modifiers.customer;
  const fitScore = Math.min(100, Math.max(0, Math.round(baseScore + modifierScore)));

  return {
    fitScore,
    baseScore: Math.round(baseScore),
    modifierScore,
    exactLaneRuns: exactRunsAnyEq,
    nearbyRuns,
    customerLaneRuns,
    equipmentMatch,
    regionMatch,
    evidenceTier,
    reason: reasonParts.join("; ") + ".",
    modifiers,
  };
}

/**
 * Persist a fit row (idempotent on the unique (org, carrier, lane, equip) key).
 * Callers don't have to await persistence to use the result.
 */
export async function upsertCarrierLaneFit(input: FitInput, result: FitResult): Promise<void> {
  const equip = input.equipmentType?.trim() || "ALL";
  const row: InsertCarrierLaneFit = {
    orgId: input.orgId,
    carrierName: input.carrierName,
    originState: input.originState.toUpperCase(),
    destinationState: input.destinationState.toUpperCase(),
    equipmentType: equip,
    fitScore: result.fitScore,
    exactLaneRuns: result.exactLaneRuns,
    nearbyRuns: result.nearbyRuns,
    equipmentMatch: result.equipmentMatch,
    regionMatch: result.regionMatch,
    evidenceTier: result.evidenceTier,
    reason: result.reason,
  };
  await db.insert(carrierLaneFit).values(row).onConflictDoUpdate({
    target: [carrierLaneFit.orgId, carrierLaneFit.carrierName, carrierLaneFit.originState, carrierLaneFit.destinationState, carrierLaneFit.equipmentType],
    set: {
      fitScore: row.fitScore,
      exactLaneRuns: row.exactLaneRuns,
      nearbyRuns: row.nearbyRuns,
      equipmentMatch: row.equipmentMatch,
      regionMatch: row.regionMatch,
      evidenceTier: row.evidenceTier,
      reason: row.reason,
      computedAt: new Date(),
    },
  });
}
