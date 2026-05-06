/**
 * Carrier Market Exposure Service
 *
 * Given a market signal, returns ranked candidate carriers by querying:
 *   (a) Financial upload history (market_events) for origin-region runs in the
 *       last 90 days matching the signal's equipment type.
 *   (b) carrier_claimed_lanes declared preferences matching origin region + equipment.
 *
 * All configuration constants are centralized in the config block below.
 * Returns a structured fit result per carrier, sorted by fit score descending.
 */

import type { IStorage } from "./storage";
import type { MarketSignal } from "@shared/schema";

// ── Configuration ─────────────────────────────────────────────────────────────

/** How many days back to look for carrier run history in market_events. */
export const CARRIER_HISTORY_LOOKBACK_DAYS = 90;

/** Minimum number of runs in the lookback window to count as "active". */
export const CARRIER_MIN_RUN_COUNT = 1;

/** Recency cutoff: runs older than this many days do not count toward fit score. */
export const CARRIER_RECENCY_CUTOFF_DAYS = 60;

/** Maximum number of carriers to return per signal (cap to prevent NBA flooding). */
export const MAX_CARRIERS_PER_SIGNAL = 15;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CarrierFitResult {
  carrierId: string;
  carrierName: string;
  runCount: number;
  lastRunDate: Date | null;
  declaredPreference: boolean;
  equipmentMatch: boolean;
  fitScore: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRegion(region: string | null | undefined): string {
  if (!region) return "";
  return region.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function regionMatches(signalRegion: string | null | undefined, laneRegion: string | null | undefined): boolean {
  if (!signalRegion || !laneRegion) return false;
  const sig = normalizeRegion(signalRegion);
  const lane = normalizeRegion(laneRegion);
  if (sig === lane) return true;
  if (sig.includes(lane) || lane.includes(sig)) return true;
  const sigTokens = sig.split("_").filter(t => t.length === 2);
  const laneTokens = lane.split("_").filter(t => t.length === 2);
  return sigTokens.some(t => laneTokens.includes(t));
}

function equipmentMatches(signalEquip: string | null | undefined, carrierEquip: string | null | undefined): boolean {
  if (!signalEquip || !carrierEquip) return false;
  const sig = signalEquip.toLowerCase();
  const carr = carrierEquip.toLowerCase();
  return sig.includes(carr) || carr.includes(sig);
}

/**
 * Compute a carrier fit score (0–100).
 *   40 pts: run count factor (scaled to CARRIER_MIN_RUN_COUNT * 3 saturation)
 *   30 pts: declared preference match
 *   20 pts: recency bonus (runs within CARRIER_RECENCY_CUTOFF_DAYS)
 *   10 pts: equipment match
 */
function computeFitScore(
  runCount: number,
  lastRunDate: Date | null,
  declaredPreference: boolean,
  equipmentMatch: boolean,
): number {
  const runFactor = Math.min(1.0, runCount / (CARRIER_MIN_RUN_COUNT * 3));
  const runScore = Math.round(runFactor * 40);

  const prefScore = declaredPreference ? 30 : 0;

  let recencyScore = 0;
  if (lastRunDate) {
    const daysSince = (Date.now() - lastRunDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= CARRIER_RECENCY_CUTOFF_DAYS) {
      recencyScore = Math.round((1 - daysSince / CARRIER_RECENCY_CUTOFF_DAYS) * 20);
    }
  }

  const equipScore = equipmentMatch ? 10 : 0;

  return Math.min(100, runScore + prefScore + recencyScore + equipScore);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns ranked carrier fit results for the given market signal.
 * Caps results to MAX_CARRIERS_PER_SIGNAL, sorted by fit score descending.
 */
export async function getExposedCarriers(
  signal: MarketSignal,
  orgId: string,
  storage: IStorage,
): Promise<CarrierFitResult[]> {
  if (!["active", "cooling"].includes(signal.status)) return [];

  const since = new Date(Date.now() - CARRIER_HISTORY_LOOKBACK_DAYS * 24 * 3_600_000);

  const [allCarriers, historyRows] = await Promise.all([
    storage.getCarriersByOrgForMarketSignal(orgId),
    storage.getFinancialRowsForCarrierSignal(orgId, signal.scopeKey, signal.equipmentType ?? null, since),
  ]);

  // Build a map: carrierId → { runCount, lastRunDate, hasRecent }
  const carrierHistory = new Map<string, { runCount: number; lastRunDate: Date | null; hasRecent: boolean }>();
  const recencyCutoff = new Date(Date.now() - CARRIER_RECENCY_CUTOFF_DAYS * 24 * 3_600_000);

  for (const row of historyRows) {
    if (!row.carrierId) continue;
    const existing = carrierHistory.get(row.carrierId);
    const isRecent = row.occurredAt >= recencyCutoff;
    if (!existing) {
      carrierHistory.set(row.carrierId, {
        runCount: 1,
        lastRunDate: row.occurredAt,
        hasRecent: isRecent,
      });
    } else {
      existing.runCount++;
      if (!existing.lastRunDate || row.occurredAt > existing.lastRunDate) {
        existing.lastRunDate = row.occurredAt;
      }
      if (isRecent) existing.hasRecent = true;
    }
  }

  const results: CarrierFitResult[] = [];

  for (const carrier of allCarriers) {
    if (carrier.status !== "active") continue;

    const hist = carrierHistory.get(carrier.id);
    const runCount = hist?.runCount ?? 0;
    const lastRunDate = hist?.lastRunDate ?? null;

    // Check declared preferences
    const claimedLanes = await storage.getCarrierClaimedLanesByCarrierId(carrier.id);
    const declaredPreference = claimedLanes.some(lane => {
      if (lane.laneType !== "prefer") return false;
      const regionOk = regionMatches(signal.scopeKey, lane.originState) ||
                       regionMatches(signal.scopeKey, lane.originCity);
      if (!regionOk) return false;
      if (signal.equipmentType && lane.equipment) {
        return equipmentMatches(signal.equipmentType, lane.equipment);
      }
      return true;
    });

    // Equipment match: check carrier's equipment types array
    const equipmentMatch = !signal.equipmentType ||
      (carrier.equipmentTypes ?? []).some(eq => equipmentMatches(signal.equipmentType!, eq));

    // Must have at least a run or declared preference to qualify
    if (runCount === 0 && !declaredPreference) continue;

    const fitScore = computeFitScore(runCount, lastRunDate, declaredPreference, equipmentMatch);

    results.push({
      carrierId: carrier.id,
      carrierName: carrier.name,
      runCount,
      lastRunDate,
      declaredPreference,
      equipmentMatch,
      fitScore,
    });
  }

  // Sort descending by fit score, then cap
  results.sort((a, b) => b.fitScore - a.fitScore);
  return results.slice(0, MAX_CARRIERS_PER_SIGNAL);
}
