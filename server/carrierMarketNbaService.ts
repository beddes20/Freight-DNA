/**
 * Carrier Market NBA Service
 *
 * Converts active/cooling Market Signals → carrier-level NBA rows in
 * carrier_market_nbas, using the carrier exposure service to identify fit.
 *
 * Entry point: syncCarrierMarketNbas(orgId, storage)
 *
 * Dedup key: (carrierId, marketSignalId, recommendationType)
 *   - pending/in_progress rows → update urgencyScore + explanation
 *   - completed/dismissed rows → leave as history (do not reopen)
 *
 * Relevant signal types: demand_surge, regional_heat, demand_capacity_imbalance
 * (regional_heat maps to demand_surge in the existing signal type set)
 *
 * All explanation text is deterministic from data — no LLM involved.
 */

import type { IStorage } from "./storage";
import type { MarketSignal } from "@shared/schema";
import {
  getExposedCarriers,
  MAX_CARRIERS_PER_SIGNAL,
  type CarrierFitResult,
} from "./carrierMarketExposureService";

// ── Recommendation types for carrier NBAs ─────────────────────────────────────

export const CARRIER_NBA_TYPES = {
  DEMAND_SURGE_CAPACITY: "demand_surge_capacity",
  IMBALANCE_OUTREACH: "imbalance_outreach",
} as const;

/** The signal types that trigger carrier NBA generation (v1). */
const RELEVANT_SIGNAL_TYPES = new Set([
  "demand_surge",
  "demand_capacity_imbalance",
  "regional_heat", // future-proofing (maps same as demand_surge)
]);

function log(msg: string) {
  console.log(`[carrierMarketNbaService] ${new Date().toISOString()} ${msg}`);
}

// ── Explanation builder ───────────────────────────────────────────────────────

export interface CarrierMarketNbaExplanation {
  signalSummary: {
    signalId: string;
    signalType: string;
    severity: string;
    scopeKey: string;
    scopeType: string;
    equipmentType: string | null;
    percentChange: number | null;
    supportingEventCount: number;
  };
  carrierFitSummary: {
    runCount: number;
    lastRunDate: string | null;
    declaredPreference: boolean;
    equipmentMatch: boolean;
    fitScore: number;
  };
  prose: string;
}

export function buildCarrierNbaExplanation(
  signal: MarketSignal,
  fit: CarrierFitResult,
  recommendationType: string,
): CarrierMarketNbaExplanation {
  const ep = (signal.evidencePayload ?? {}) as Record<string, unknown>;
  const percentChange = ep.percentChange != null ? Number(ep.percentChange) : null;
  const supportingEventCount = typeof ep.recentCount === "number" ? ep.recentCount : 0;

  const regionLabel = signal.scopeKey ?? "the region";
  const equipLabel = signal.equipmentType ? ` ${signal.equipmentType}` : "";
  const pctStr = percentChange != null
    ? (percentChange > 0 ? `+${Math.round(percentChange)}%` : `${Math.round(percentChange)}%`)
    : "";
  const lastRunStr = fit.lastRunDate
    ? fit.lastRunDate.toISOString().split("T")[0]
    : null;

  let prose: string;
  if (recommendationType === CARRIER_NBA_TYPES.IMBALANCE_OUTREACH) {
    prose = `Demand-capacity imbalance detected in ${regionLabel}${equipLabel}. ` +
      `${fit.carrierName} has ${fit.runCount} run(s) in this corridor` +
      (lastRunStr ? ` (last: ${lastRunStr})` : "") +
      `. Reach out to confirm capacity availability and lock in rates before the market tightens.`;
  } else {
    prose = `Demand surge detected in ${regionLabel}${equipLabel}${pctStr ? ` (${pctStr} above baseline)` : ""}. ` +
      `${fit.carrierName} has ${fit.runCount} run(s) in this corridor` +
      (lastRunStr ? ` (last: ${lastRunStr})` : "") +
      (fit.declaredPreference ? ` and has declared a preference for this lane` : "") +
      `. Contact to add capacity in this corridor.`;
  }

  return {
    signalSummary: {
      signalId: signal.id,
      signalType: signal.signalType,
      severity: signal.severity,
      scopeKey: signal.scopeKey,
      scopeType: signal.scopeType,
      equipmentType: signal.equipmentType ?? null,
      percentChange,
      supportingEventCount,
    },
    carrierFitSummary: {
      runCount: fit.runCount,
      lastRunDate: lastRunStr,
      declaredPreference: fit.declaredPreference,
      equipmentMatch: fit.equipmentMatch,
      fitScore: fit.fitScore,
    },
    prose,
  };
}

// ── Urgency score ─────────────────────────────────────────────────────────────

function computeCarrierUrgencyScore(signal: MarketSignal, fit: CarrierFitResult): number {
  const severityScore: Record<string, number> = { critical: 90, high: 70, medium: 50, low: 30 };
  const base = severityScore[signal.severity] ?? 50;
  const fitBonus = Math.round(fit.fitScore * 0.1); // max 10 pts from fit score
  return Math.min(100, base + fitBonus);
}

// ── Recommendation type selector ──────────────────────────────────────────────

function getRecommendationType(signalType: string): string {
  if (signalType === "demand_capacity_imbalance") {
    return CARRIER_NBA_TYPES.IMBALANCE_OUTREACH;
  }
  return CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY;
}

// ── Sync function ─────────────────────────────────────────────────────────────

/**
 * Main entry point: syncs all active/cooling relevant Market Signals →
 * carrier NBA rows for an org.
 * Called by the scheduler after MarketSignalEngine evaluation.
 */
export async function syncCarrierMarketNbas(orgId: string, storage: IStorage): Promise<{
  processed: number;
  created: number;
  updated: number;
  skipped: number;
}> {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const signals = await storage.getActiveMarketSignals({ status: ["active", "cooling"] });
  const relevantSignals = signals.filter(s => RELEVANT_SIGNAL_TYPES.has(s.signalType));

  if (relevantSignals.length === 0) {
    log(`Org ${orgId}: no relevant active/cooling signals — nothing to do`);
    return { processed, created, updated, skipped };
  }

  log(`Org ${orgId}: ${relevantSignals.length} relevant signal(s) to process`);

  for (const signal of relevantSignals) {
    const exposedCarriers = await getExposedCarriers(signal, orgId, storage);
    log(`Signal ${signal.id} (${signal.signalType}): ${exposedCarriers.length} exposed carriers`);

    const capped = exposedCarriers.slice(0, MAX_CARRIERS_PER_SIGNAL);
    const recommendationType = getRecommendationType(signal.signalType);

    for (const fit of capped) {
      processed++;

      const explanation = buildCarrierNbaExplanation(signal, fit, recommendationType);
      const urgencyScore = computeCarrierUrgencyScore(signal, fit);

      const existing = await storage.getCarrierMarketNbaByDedup(
        fit.carrierId,
        signal.id,
        recommendationType,
      );

      if (existing) {
        if (existing.status === "completed" || existing.status === "dismissed") {
          skipped++;
          continue;
        }
        // Update pending/in_progress
        await storage.upsertCarrierMarketNba({
          carrierId: fit.carrierId,
          marketSignalId: signal.id,
          recommendationType,
          status: existing.status,
          urgencyScore,
          explanation: explanation as unknown as Record<string, unknown>,
          suppressionReason: null,
          lastActionAt: null,
        });
        updated++;
      } else {
        await storage.upsertCarrierMarketNba({
          carrierId: fit.carrierId,
          marketSignalId: signal.id,
          recommendationType,
          status: "pending",
          urgencyScore,
          explanation: explanation as unknown as Record<string, unknown>,
          suppressionReason: null,
          lastActionAt: null,
        });
        created++;
      }
    }
  }

  log(`Org ${orgId}: sync complete — processed=${processed}, created=${created}, updated=${updated}, skipped=${skipped}`);
  return { processed, created, updated, skipped };
}
