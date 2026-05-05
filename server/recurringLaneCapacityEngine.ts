/**
 * Recurring Lane Capacity Engine — Task #1051 contract.
 *
 * As of Task #1051 the engine reads exclusively from the canonical
 * `freight_daily_upload_fact` table (written by
 * `server/services/freightDailyUploadFact.ts` from the daily ReplitDailyUpload
 * Excel). The eligibility rule is the new rolling 30-day move count:
 *
 *   A `(originCity, originState, destCity, destState, equipment)` lane is
 *   eligible when it shows ≥6 moved loads in the last 30 days. A 7-day
 *   grace period prevents flapping: lanes that drop below the threshold are
 *   only retracted once `now - lastEligibleAt > 7 days`.
 *
 * See docs/unified-replit-daily-upload.md for the full architecture
 * contract. The legacy 8-week / ≥1-load lookback is gone — DO NOT
 * reintroduce it.
 *
 * The scoring weights below are unchanged from the previous engine; only
 * the eligibility derivation moved.
 */

import { sql } from "drizzle-orm";
import type { IStorage } from "./storage";
import { db } from "./storage";
import { recurringLanes } from "@shared/schema";
import { formatCustomerName } from "@shared/laneFormatters";
import {
  summarizeEligibleLanesFromFact,
  LWQ_MOVES_THRESHOLD,
  LWQ_ROLLING_DAYS,
  LWQ_GRACE_DAYS,
  type LaneFactSummary,
} from "./services/freightDailyUploadFact";

// ── Config ───────────────────────────────────────────────────────────────────

export const LANE_CONFIG = {
  // ── Eligibility (Task #1051) ──────────────────────────────────────────────
  // The single canonical rule — see docs/unified-replit-daily-upload.md.
  movesThreshold: LWQ_MOVES_THRESHOLD, // 6
  rollingDays: LWQ_ROLLING_DAYS,       // 30
  graceDays: LWQ_GRACE_DAYS,           // 7
  completionCarriersContacted: 3,      // number of carriers to contact before card resolves
  snoozeAfterResolveDays: 30,          // days before re-evaluating a resolved lane

  // ── Legacy compat — referenced by other modules' status payloads. ─────────
  // The engine no longer uses these for eligibility decisions; they exist so
  // dashboards reading `LANE_CONFIG.lookbackWeeks` still render a sensible
  // window label. Treat them as documentation, not behavior.
  lookbackWeeks: Math.ceil(LWQ_ROLLING_DAYS / 7),
  minLoadsPerWeek: 1,
  requiredWeeks: 1,
  minTotalLoads: LWQ_MOVES_THRESHOLD,

  // ── Scoring weights / max points per dimension ────────────────────────────
  scoring: {
    maxConsistencyPts: 25,
    volumeBenchmarkLoadsPerWeek: 3,
    maxVolumePts: 20,
    confidenceHigh: 15,
    confidenceMedium: 8,
    confidenceLow: 3,
    tierHigh: 15,
    tierMedium: 10,
    tierLow: 5,
    tierHighThreshold: 100_000,
    tierMediumThreshold: 25_000,
    noPreferredCarrierBonus: 15,
    marginHigh: 10,
    marginMedium: 7,
    marginLow: 4,
    marginMinimal: 1,
    marginHighPct: 15,
    marginMediumPct: 10,
    marginLowPct: 5,
    marginProxyHigh: 10,
    marginProxyMedium: 7,
    marginProxyLow: 4,
    volatilityHighPenalty: -10,
    volatilityMedPenalty: -5,
    volatilityHighThreshold: 0.5,
    volatilityMedThreshold: 0.3,
    minimumThresholdPenalty: -10,
    aiBlendRuleWeight: 0.7,
    aiBlendAiWeight: 0.3,
  },
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface EngineRunMeta {
  source: "freight_daily_upload_fact";
  uploadIds: string[];                  // most-recent uploads consumed (for diagnostics)
  latestUploadDate: string;             // uploadedAt of the newest upload used
  rowsScanned: number;                  // moved-fact rows in the rolling window
  lanesGenerated: number;               // eligible lanes found this run
  anchorDate: string;                   // anchor used for the rolling window
}

export interface LaneSummary {
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string;
  companyId: string | null;
  companyName: string;
  avgLoadsPerWeek: number;
  weeksActive: number;
  weeklyBreakdown: Record<string, number>;
  eligibilityConfidence: "high" | "medium" | "borderline";
  ownerUserId: string | null;
  historicalPayeeCodes: string[];
  historicalCarrierNames: string[];
  // Task #1051 enrichment, surfaced on `recurring_lanes` rows.
  movesLast30Days: number;
  lastMovedAt: string;
  qualificationReason: string;
  supportingCustomers: Array<{ name: string; count: number }>;
  recentCarriers: Array<{ name: string; payeeCode: string | null; lastMovedAt: string; count: number }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normCompanyName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Main Engine ──────────────────────────────────────────────────────────────

/**
 * Identify eligible recurring lanes from the canonical fact table.
 *
 * Source of truth: `freight_daily_upload_fact` rows where `moved=true`. The
 * helper `summarizeEligibleLanesFromFact` enforces the ≥6 / 30-day rule.
 */
export async function identifyRecurringLanes(
  orgId: string,
  storage: IStorage,
): Promise<{ lanes: LaneSummary[]; meta: EngineRunMeta }> {
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const sortedUploads = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const latestUpload = sortedUploads[0];

  const { lanes: factLanes, anchorDate } = await summarizeEligibleLanesFromFact(orgId);

  const meta: EngineRunMeta = {
    source: "freight_daily_upload_fact",
    uploadIds: sortedUploads.slice(0, 4).map(u => u.id),
    latestUploadDate: latestUpload?.uploadedAt ?? "",
    rowsScanned: factLanes.reduce((sum, l) => sum + l.movesLast30Days, 0),
    lanesGenerated: 0,
    anchorDate,
  };

  if (factLanes.length === 0) return { lanes: [], meta };

  const companies = await storage.getCompanies(orgId);
  const companyMap = new Map(companies.map(c => [normCompanyName(c.name), c]));

  const summaries: LaneSummary[] = factLanes.map((lane: LaneFactSummary) => {
    const primaryCustomer = lane.supportingCustomers[0]?.name ?? "";
    const matchedCompany = primaryCustomer
      ? (companyMap.get(normCompanyName(primaryCustomer)) ?? null)
      : null;
    const ownerUserId = matchedCompany?.assignedTo ?? null;

    // Confidence buckets — driven by move volume in the rolling window.
    let eligibilityConfidence: "high" | "medium" | "borderline" = "borderline";
    if (lane.movesLast30Days >= 12) eligibilityConfidence = "high";
    else if (lane.movesLast30Days >= 8) eligibilityConfidence = "medium";

    const avgLoadsPerWeek = Math.round((lane.movesLast30Days / (LWQ_ROLLING_DAYS / 7)) * 10) / 10;

    return {
      origin: lane.originCity,
      originState: lane.originState,
      destination: lane.destCity,
      destinationState: lane.destState,
      equipmentType: lane.equipment,
      companyId: matchedCompany?.id ?? null,
      companyName: formatCustomerName(matchedCompany?.name ?? primaryCustomer),
      avgLoadsPerWeek,
      // weeksActive is derived from the rolling-30-day window for compat
      // with downstream readers that still surface the field.
      weeksActive: Math.min(LWQ_ROLLING_DAYS / 7, Math.ceil(lane.movesLast30Days / 2)),
      weeklyBreakdown: {},
      eligibilityConfidence,
      ownerUserId,
      historicalPayeeCodes: lane.recentCarriers
        .map(c => c.payeeCode || "")
        .filter(Boolean),
      historicalCarrierNames: lane.recentCarriers.map(c => c.name),
      movesLast30Days: lane.movesLast30Days,
      lastMovedAt: lane.lastMovedAt,
      qualificationReason: lane.qualificationReason,
      supportingCustomers: lane.supportingCustomers,
      recentCarriers: lane.recentCarriers,
    };
  });

  summaries.sort((a, b) => b.movesLast30Days - a.movesLast30Days);
  meta.lanesGenerated = summaries.length;
  return { lanes: summaries, meta };
}

/**
 * Run the full engine for an org: persist eligible lanes, attach historical
 * carriers, and apply the 7-day grace before retracting fallen-out lanes.
 */
export async function runRecurringLaneEngineForOrg(
  orgId: string,
  storage: IStorage,
): Promise<{ upserted: number; total: number; historicalCarriersAttached: number; meta: EngineRunMeta }> {
  const { lanes, meta } = await identifyRecurringLanes(orgId, storage);

  const allCarriers = await storage.getCarriers(orgId);
  const carrierByPayee = new Map(
    allCarriers.filter(c => c.payeeCode).map(c => [c.payeeCode!.toLowerCase(), c])
  );
  const carrierByName = new Map(
    allCarriers.map(c => [c.name.toLowerCase().trim(), c])
  );

  const nowIso = new Date().toISOString();
  let upserted = 0;
  let historicalCarriersAttached = 0;
  const eligibleIds: string[] = [];

  for (const lane of lanes) {
    const row = await storage.upsertRecurringLane({
      orgId,
      origin: lane.origin,
      originState: lane.originState,
      destination: lane.destination,
      destinationState: lane.destinationState,
      equipmentType: lane.equipmentType,
      companyId: lane.companyId,
      companyName: lane.companyName,
      avgLoadsPerWeek: String(lane.avgLoadsPerWeek),
      weeksActive: lane.weeksActive,
      lookbackWeeks: LANE_CONFIG.lookbackWeeks,
      hasPreferredCarrierProgram: false,
      ownerUserId: lane.ownerUserId,
      eligibilityConfidence: lane.eligibilityConfidence,
      isEligible: true,
      // Task #1051 enrichment columns. JSON columns (`supportingCustomers`,
      // `recentCarriers`) are typed `unknown` by Drizzle's jsonb column —
      // the structured arrays satisfy that contract directly.
      movesLast30Days: lane.movesLast30Days,
      lastMovedAt: lane.lastMovedAt,
      qualificationReason: lane.qualificationReason,
      supportingCustomers: lane.supportingCustomers,
      recentCarriers: lane.recentCarriers,
      lastEligibleAt: nowIso,
    });
    eligibleIds.push(row.id);
    upserted++;

    const attachedCarrierIds = new Set<string>();
    for (const payeeCode of lane.historicalPayeeCodes) {
      const carrier = carrierByPayee.get(payeeCode.toLowerCase());
      if (!carrier || attachedCarrierIds.has(carrier.id)) continue;
      try {
        await storage.upsertLaneCarrierInterest({
          laneId: row.id,
          carrierId: carrier.id,
          carrierName: carrier.name,
          interestStatus: "needs_follow_up",
          sourceType: "historical",
        });
        attachedCarrierIds.add(carrier.id);
        historicalCarriersAttached++;
      } catch { /* idempotent */ }
    }
    for (const carrierName of lane.historicalCarrierNames) {
      const carrier = carrierByName.get(carrierName.toLowerCase().trim());
      if (carrier && attachedCarrierIds.has(carrier.id)) continue;
      const interestData: Parameters<IStorage["upsertLaneCarrierInterest"]>[0] = carrier
        ? { laneId: row.id, carrierId: carrier.id, carrierName: carrier.name, interestStatus: "needs_follow_up", sourceType: "historical" }
        : { laneId: row.id, carrierId: null, carrierName, interestStatus: "needs_follow_up", sourceType: "historical" };
      try {
        await storage.upsertLaneCarrierInterest(interestData);
        if (carrier) attachedCarrierIds.add(carrier.id);
        historicalCarriersAttached++;
      } catch { /* idempotent */ }
    }
  }

  // Retraction with 7-day grace. Lanes that did NOT show up in this run are
  // not immediately flipped to ineligible — they stay eligible until
  // `now - lastEligibleAt > graceDays`. This prevents short-cycle flapping
  // when a single weekend goes by without enough moves to clear the bar.
  const graceCutoff = new Date(Date.now() - LANE_CONFIG.graceDays * 86400_000).toISOString();
  if (eligibleIds.length === 0) {
    await db.execute(sql`
      UPDATE recurring_lanes
         SET is_eligible = false
       WHERE org_id = ${orgId}
         AND (last_eligible_at IS NULL OR last_eligible_at < ${graceCutoff})
    `);
  } else {
    await db.execute(sql`
      UPDATE recurring_lanes
         SET is_eligible = false
       WHERE org_id = ${orgId}
         AND id NOT IN (${sql.join(eligibleIds.map(id => sql`${id}`), sql`, `)})
         AND (last_eligible_at IS NULL OR last_eligible_at < ${graceCutoff})
    `);
  }

  return { upserted, total: lanes.length, historicalCarriersAttached, meta };
}
