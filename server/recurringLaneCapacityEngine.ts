/**
 * Recurring Lane Capacity Engine
 *
 * Identifies lanes where Value Truck is running ≥2 loads/week in ≥3 of the last 4 weeks.
 * Lane history is derived from financial upload rows, which contain TMS-sourced origin,
 * destination, mode, customer, and date data.
 *
 * All thresholds live in LANE_CONFIG so they can be adjusted without code changes.
 */

import type { IStorage } from "./storage";
import type { FinancialUpload } from "@shared/schema";

// ── Config ───────────────────────────────────────────────────────────────────

export const LANE_CONFIG = {
  // ── Eligibility thresholds ─────────────────────────────────────────────────
  minLoadsPerWeek: 2,          // minimum loads/week to count a week as "active"
  requiredWeeks: 3,            // how many of the lookback weeks must be active
  lookbackWeeks: 4,            // rolling window width
  completionCarriersContacted: 3,  // number of carriers to contact before card resolves
  snoozeAfterResolveDays: 30,  // days before re-evaluating a resolved lane

  // ── Scoring weights / max points per dimension ────────────────────────────
  scoring: {
    // Consistency: fraction of active weeks × maxPts
    maxConsistencyPts: 25,
    // Volume: benchmark loads/week for full points; scale linearly up to maxPts
    volumeBenchmarkLoadsPerWeek: 3,
    maxVolumePts: 20,
    // Confidence bonus levels
    confidenceHigh: 15,
    confidenceMedium: 8,
    confidenceLow: 3,
    // Company tier bonus (based on estimated freight spend)
    tierHigh: 15,       // spend >= $100k
    tierMedium: 10,     // spend >= $25k
    tierLow: 5,         // spend > 0
    tierHighThreshold: 100_000,
    tierMediumThreshold: 25_000,
    // No preferred carrier bonus
    noPreferredCarrierBonus: 15,
    // Margin signal (based on actual avg margin % from financial history)
    marginHigh: 10,     // avgMarginPct >= 15%
    marginMedium: 7,    // avgMarginPct >= 10%
    marginLow: 4,       // avgMarginPct >= 5%
    marginMinimal: 1,   // otherwise
    marginHighPct: 15,
    marginMediumPct: 10,
    marginLowPct: 5,
    // Margin proxy (load density, when no actual margin data)
    marginProxyHigh: 10,     // avgLoads >= 4/week
    marginProxyMedium: 7,    // avgLoads >= 3/week
    marginProxyLow: 4,       // avgLoads >= 2/week
    // Volatility penalty (coefficient of variation of weekly load counts)
    volatilityHighPenalty: -10,  // CV > volatilityHighThreshold
    volatilityMedPenalty: -5,    // CV > volatilityMedThreshold
    volatilityHighThreshold: 0.5,
    volatilityMedThreshold: 0.3,
    minimumThresholdPenalty: -10,  // fallback when no CV data and lane at minimum
    // AI blend: final score = ruleWeight * ruleBased + aiWeight * aiScore
    aiBlendRuleWeight: 0.7,
    aiBlendAiWeight: 0.3,
  },
};

// ── Types ────────────────────────────────────────────────────────────────────

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
  weeklyBreakdown: Record<string, number>; // "YYYY-WW" -> load count
  eligibilityConfidence: "high" | "medium" | "borderline";
  ownerUserId: string | null;
  // V1.5: carrier info extracted from load rows
  historicalPayeeCodes: string[];   // distinct payee codes seen on this lane
  historicalCarrierNames: string[]; // raw carrier names (fallback when no payee code)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
}

function getWeekKeys(weeksBack: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = getWeekKey(d.toISOString().split("T")[0]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function normStr(s: string): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function normCompanyName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Main Engine ──────────────────────────────────────────────────────────────

/**
 * Analyzes financial upload rows to identify recurring lanes.
 * Returns one LaneSummary per eligible origin→destination→equipment→company corridor.
 */
export async function identifyRecurringLanes(
  orgId: string,
  storage: IStorage,
): Promise<LaneSummary[]> {
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  if (uploads.length === 0) return [];

  const companies = await storage.getCompanies(orgId);
  const companyMap = new Map(companies.map(c => [normCompanyName(c.name), c]));

  const targetWeeks = getWeekKeys(LANE_CONFIG.lookbackWeeks);
  if (targetWeeks.length === 0) return [];

  // Sort uploads newest first
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const latestUpload = sorted[0];
  if (!latestUpload) return [];

  // Use rows from the most recent upload (or merge last 2 uploads for coverage)
  const rowSources: any[][] = [];
  for (let i = 0; i < Math.min(2, sorted.length); i++) {
    const rows = (sorted[i].rows as any[]) ?? [];
    if (rows.length > 0) rowSources.push(rows);
  }

  // Lane aggregation: key = "origin|destination|equipment|companyNorm"
  const laneWeekly = new Map<string, {
    origin: string; originState: string;
    destination: string; destinationState: string;
    equipmentType: string;
    companyNorm: string;
    weeks: Map<string, number>;
    shipDates: string[];
    payeeCodes: Set<string>;   // V1.5: distinct payee codes seen on this lane
    carrierNames: Set<string>; // V1.5: raw carrier names as fallback
  }>();

  // Dedup across overlapping uploads: track distinct load fingerprints already counted
  const seenLoadKeys = new Set<string>();

  for (const rows of rowSources) {
    for (const row of rows) {
      // Extract fields from the TMS financial row
      const origin = normStr(row.shipperCity ?? row.originCity ?? row.origin ?? row.shipper_city ?? "");
      const originState = normStr(row.shipperState ?? row.originState ?? row.origin_state ?? "");
      const destination = normStr(row.consigneeCity ?? row.destinationCity ?? row.destination ?? row.consignee_city ?? "");
      const destinationState = normStr(row.consigneeState ?? row.destinationState ?? row.destination_state ?? "");
      const equipment = normStr(row.equipmentType ?? row.equipment_type ?? row.mode ?? row.trailer ?? "");
      const customerRaw = normStr(row.customerName ?? row.customer_name ?? row.customer ?? row.account ?? "");
      const shipDate = row.shipDate ?? row.ship_date ?? row.pickupDate ?? row.pickup_date ?? row.date ?? "";
      // Optional load ID for stable dedup (load number, order ID, etc.)
      const loadId = normStr(row.loadId ?? row.load_id ?? row.orderId ?? row.order_id ?? row.loadNumber ?? row.load_number ?? "");

      if (!origin || !destination || !shipDate || !customerRaw) continue;

      const weekKey = getWeekKey(String(shipDate));
      if (!weekKey) continue;

      // Only count rows within our lookback window
      if (!targetWeeks.includes(weekKey)) continue;

      const laneKey = `${origin}|${destination}|${equipment}|${customerRaw}`;

      // Dedup: use loadId when available; otherwise fall back to lane+date fingerprint
      const loadFingerprint = loadId
        ? `${laneKey}|${loadId}`
        : `${laneKey}|${String(shipDate).trim()}|${normStr(row.carrier ?? row.carrierName ?? "")}`;
      if (seenLoadKeys.has(loadFingerprint)) continue;
      seenLoadKeys.add(loadFingerprint);

      if (!laneWeekly.has(laneKey)) {
        laneWeekly.set(laneKey, {
          origin, originState,
          destination, destinationState,
          equipmentType: equipment,
          companyNorm: customerRaw,
          weeks: new Map(),
          shipDates: [],
          payeeCodes: new Set(),
          carrierNames: new Set(),
        });
      }
      const entry = laneWeekly.get(laneKey)!;
      entry.weeks.set(weekKey, (entry.weeks.get(weekKey) ?? 0) + 1);
      if (shipDate) entry.shipDates.push(String(shipDate));

      // V1.5: Track which carriers ran this lane
      const payeeCode = normStr(row.payeeCode ?? row.payee_code ?? row.payee ?? "");
      const carrierName = normStr(row.carrier ?? row.carrierName ?? row.carrier_name ?? row.payeeName ?? row.payee_name ?? "");
      if (payeeCode) entry.payeeCodes.add(payeeCode);
      else if (carrierName) entry.carrierNames.add(carrierName);
    }
  }

  const eligible: LaneSummary[] = [];

  for (const [, lane] of laneWeekly) {
    // Check how many of the target weeks meet the minimum loads threshold
    let weeksActive = 0;
    let totalLoads = 0;
    for (const wk of targetWeeks) {
      const count = lane.weeks.get(wk) ?? 0;
      if (count >= LANE_CONFIG.minLoadsPerWeek) weeksActive++;
      totalLoads += count;
    }

    if (weeksActive < LANE_CONFIG.requiredWeeks) continue;

    const avgLoadsPerWeek = totalLoads / LANE_CONFIG.lookbackWeeks;

    // Determine confidence
    let eligibilityConfidence: "high" | "medium" | "borderline" = "borderline";
    if (weeksActive === LANE_CONFIG.lookbackWeeks && avgLoadsPerWeek >= 3) {
      eligibilityConfidence = "high";
    } else if (weeksActive >= LANE_CONFIG.requiredWeeks && avgLoadsPerWeek >= LANE_CONFIG.minLoadsPerWeek) {
      eligibilityConfidence = "medium";
    }

    // Resolve company
    const matchedCompany = companyMap.get(normCompanyName(lane.companyNorm)) ?? null;
    const ownerUserId = matchedCompany?.assignedTo ?? null;

    eligible.push({
      origin: lane.origin,
      originState: lane.originState,
      destination: lane.destination,
      destinationState: lane.destinationState,
      equipmentType: lane.equipmentType,
      companyId: matchedCompany?.id ?? null,
      companyName: matchedCompany?.name ?? lane.companyNorm,
      avgLoadsPerWeek: Math.round(avgLoadsPerWeek * 10) / 10,
      weeksActive,
      weeklyBreakdown: Object.fromEntries(lane.weeks),
      eligibilityConfidence,
      ownerUserId,
      historicalPayeeCodes: Array.from(lane.payeeCodes),
      historicalCarrierNames: Array.from(lane.carrierNames),
    });
  }

  // Deduplicate: prefer higher avgLoadsPerWeek for same lane key
  eligible.sort((a, b) => b.avgLoadsPerWeek - a.avgLoadsPerWeek);

  return eligible;
}

/**
 * Run the full recurring lane capacity engine for an org:
 * identifies eligible lanes and upserts them into recurring_lanes.
 * V1.5: also auto-attaches historical carriers (from load rows) to each lane bench.
 */
export async function runRecurringLaneEngineForOrg(
  orgId: string,
  storage: IStorage,
): Promise<{ upserted: number; total: number; historicalCarriersAttached: number }> {
  const lanes = await identifyRecurringLanes(orgId, storage);

  // Pre-load carrier catalog indexed by payee code for O(1) lookups
  const allCarriers = await storage.getCarriers(orgId);
  const carrierByPayee = new Map(
    allCarriers.filter(c => c.payeeCode).map(c => [c.payeeCode!.toLowerCase(), c])
  );
  const carrierByName = new Map(
    allCarriers.map(c => [c.name.toLowerCase().trim(), c])
  );

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
    });
    eligibleIds.push(row.id);
    upserted++;

    // V1.5: Auto-attach historical carriers from load rows
    // Match by payee code first, then by name
    const attachedCarrierIds = new Set<string>();

    for (const payeeCode of lane.historicalPayeeCodes) {
      const carrier = carrierByPayee.get(payeeCode.toLowerCase());
      if (!carrier) continue;
      if (attachedCarrierIds.has(carrier.id)) continue;
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
      } catch {
        // Duplicate entries are safe to ignore (partial unique index)
      }
    }

    for (const carrierName of lane.historicalCarrierNames) {
      const carrier = carrierByName.get(carrierName.toLowerCase().trim());
      const interestData: Parameters<IStorage["upsertLaneCarrierInterest"]>[0] = carrier
        ? { laneId: row.id, carrierId: carrier.id, carrierName: carrier.name, interestStatus: "needs_follow_up", sourceType: "historical" }
        : { laneId: row.id, carrierId: null, carrierName, interestStatus: "needs_follow_up", sourceType: "historical" };

      if (carrier && attachedCarrierIds.has(carrier.id)) continue;
      try {
        await storage.upsertLaneCarrierInterest(interestData);
        if (carrier) attachedCarrierIds.add(carrier.id);
        historicalCarriersAttached++;
      } catch {
        // Duplicate entries are safe to ignore
      }
    }
  }

  // Retract eligibility for lanes that no longer meet criteria in this run
  await storage.retractIneligibleLanes(orgId, eligibleIds);

  return { upserted, total: lanes.length, historicalCarriersAttached };
}
