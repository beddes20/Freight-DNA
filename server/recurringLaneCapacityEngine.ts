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
import { formatCustomerName } from "@shared/laneFormatters";

// ── Config ───────────────────────────────────────────────────────────────────

export const LANE_CONFIG = {
  // ── Eligibility thresholds ─────────────────────────────────────────────────
  minLoadsPerWeek: 1,          // minimum loads/week to count a week as "active" (lowered from 2)
  requiredWeeks: 2,            // how many of the lookback weeks must be active (lowered from 3)
  lookbackWeeks: 8,            // rolling window width — 2 months so monthly uploads are covered (up from 4)
  minTotalLoads: 2,            // alternative floor: qualify if total loads >= this, even if weeks spread out
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

/**
 * Metadata about a single engine run — which uploads were used, how many rows
 * were scanned, and whether each lane was resolved via CRM company match or
 * purely via the raw customer name from the TMS export.
 */
export interface EngineRunMeta {
  source: "financial_uploads";         // always "financial_uploads" (ReplitDailyUpload)
  uploadIds: string[];                  // IDs of the financial_uploads rows consumed
  latestUploadDate: string;            // uploadedAt of the newest upload used
  rowsScanned: number;                  // total rows processed (across all consumed uploads)
  lanesGenerated: number;               // eligible lanes found this run
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
  weeklyBreakdown: Record<string, number>; // "YYYY-WW" -> load count
  eligibilityConfidence: "high" | "medium" | "borderline";
  ownerUserId: string | null;
  // V1.5: carrier info extracted from load rows
  historicalPayeeCodes: string[];   // distinct payee codes seen on this lane
  historicalCarrierNames: string[]; // raw carrier names (fallback when no payee code)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWeekKey(dateStr: string): string {
  // Handle both "YYYY-MM-DD" and full ISO datetimes like "2025-10-02T00:00:00.000Z"
  // by extracting just the date part before appending the noon UTC anchor
  const datePart = String(dateStr).trim().slice(0, 10);
  const d = new Date(datePart + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
}

function getWeekKeys(weeksBack: number, anchorDate?: Date): string[] {
  const keys: string[] = [];
  const anchor = anchorDate ?? new Date();
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(anchor);
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
 * Source: financial_uploads table (ReplitDailyUpload from Financials / Lane Analytics tab).
 * Returns one LaneSummary per eligible origin→destination→equipment→company corridor,
 * plus run metadata showing exactly which uploads were consumed.
 */
export async function identifyRecurringLanes(
  orgId: string,
  storage: IStorage,
): Promise<{ lanes: LaneSummary[]; meta: EngineRunMeta }> {
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const emptyMeta: EngineRunMeta = {
    source: "financial_uploads",
    uploadIds: [],
    latestUploadDate: "",
    rowsScanned: 0,
    lanesGenerated: 0,
  };
  if (uploads.length === 0) return { lanes: [], meta: emptyMeta };

  const companies = await storage.getCompanies(orgId);
  const companyMap = new Map(companies.map(c => [normCompanyName(c.name), c]));

  // Sort uploads newest first
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const latestUpload = sorted[0];
  if (!latestUpload) return { lanes: [], meta: emptyMeta };

  // Use rows from the most recent uploads — up to 4 to give 2+ months of coverage
  const rowSources: any[][] = [];
  const consumedUploads: typeof sorted = [];
  for (let i = 0; i < Math.min(4, sorted.length); i++) {
    const rows = (sorted[i].rows as any[]) ?? [];
    if (rows.length > 0) {
      rowSources.push(rows);
      consumedUploads.push(sorted[i]);
    }
  }
  const runMeta: EngineRunMeta = {
    source: "financial_uploads",
    uploadIds: consumedUploads.map(u => u.id),
    latestUploadDate: consumedUploads[0]?.uploadedAt ?? "",
    rowsScanned: rowSources.reduce((sum, r) => sum + r.length, 0),
    lanesGenerated: 0, // filled in below
  };

  // Determine the lookback anchor: use the latest ship date found in the data rather
  // than "today". This ensures the engine produces consistent results even when the
  // most recent upload is several weeks old — otherwise stale data causes a gap where
  // the most-recent target weeks have zero loads and most lanes fail to qualify.
  let latestDataDate: Date | null = null;
  for (const rows of rowSources) {
    for (const row of rows) {
      const dateStr = row["Delivery date"] ?? row.shipDate ?? row.ship_date ??
        row.pickupDate ?? row.pickup_date ?? row.date ?? "";
      if (!dateStr) continue;
      const datePart = String(dateStr).trim().slice(0, 10);
      const d = new Date(datePart + "T12:00:00Z");
      if (!isNaN(d.getTime()) && (latestDataDate === null || d > latestDataDate)) {
        latestDataDate = d;
      }
    }
  }
  // Fall back to today if no dates found; cap drift at 60 days
  const anchor = latestDataDate ?? new Date();
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const effectiveAnchor = anchor < sixtyDaysAgo ? new Date() : anchor;

  const targetWeeks = getWeekKeys(LANE_CONFIG.lookbackWeeks, effectiveAnchor);
  if (targetWeeks.length === 0) return [];

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
      // Extract fields from the TMS financial row.
      // Try multiple naming conventions: camelCase (generic TMS), snake_case, and
      // the Pascal-Case-with-spaces format used by Value Truck's TMS export
      // ("Origin", "Destination", "Delivery date", "Customer", "Trailer type", etc.)
      const origin = normStr(
        row.Origin ?? row.shipperCity ?? row.originCity ?? row.origin ?? row.shipper_city ?? ""
      );
      const originState = normStr(
        row["Origin state"] ?? row.shipperState ?? row.originState ?? row.origin_state ?? ""
      );
      const destination = normStr(
        row.Destination ?? row.consigneeCity ?? row.destinationCity ?? row.destination ?? row.consignee_city ?? ""
      );
      const destinationState = normStr(
        row["Destination state"] ?? row.consigneeState ?? row.destinationState ?? row.destination_state ?? ""
      );
      const equipment = normStr(
        row["Trailer type"] ?? row.equipmentType ?? row.equipment_type ?? row.mode ?? row.trailer ?? ""
      );
      const customerRaw = normStr(
        row.Customer ?? row.customerName ?? row.customer_name ?? row.customer ?? row.account ?? ""
      );
      const shipDate =
        row["Delivery date"] ?? row.shipDate ?? row.ship_date ??
        row.pickupDate ?? row.pickup_date ?? row.date ?? "";
      // Optional load ID for stable dedup (Order number, load number, etc.)
      const loadId = normStr(
        row.Order ?? row.loadId ?? row.load_id ?? row.orderId ?? row.order_id ??
        row.loadNumber ?? row.load_number ?? ""
      );

      if (!origin || !destination || !shipDate || !customerRaw) continue;

      const weekKey = getWeekKey(String(shipDate));
      if (!weekKey) continue;

      // Only count rows within our lookback window
      if (!targetWeeks.includes(weekKey)) continue;

      const laneKey = `${origin}|${destination}|${equipment}|${customerRaw}`;

      // Dedup: use loadId when available; otherwise fall back to lane+date+carrier fingerprint
      const rawCarrierForDedup = normStr(row.Carrier ?? row.carrier ?? row.carrierName ?? "");
      const loadFingerprint = loadId
        ? `${laneKey}|${loadId}`
        : `${laneKey}|${String(shipDate).trim()}|${rawCarrierForDedup}`;
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

      // V1.5: Track which carriers ran this lane.
      // Value Truck's TMS "Carrier" field is "PAYEECODE - CARRIER NAME" (e.g. "JACOINSC - JACOBS TRANS LLC").
      // Extract the payee code prefix when present so we can match against the carrier catalog.
      const rawCarrierField = normStr(row.Carrier ?? row.carrier ?? row.carrierName ?? row.carrier_name ?? "");
      const dashIdx = rawCarrierField.indexOf(" - ");
      const payeeCode = normStr(
        row.payeeCode ?? row.payee_code ?? row.payee ??
        (dashIdx > 0 ? rawCarrierField.slice(0, dashIdx) : "")
      );
      const carrierName = normStr(
        row.carrier ?? row.carrierName ?? row.carrier_name ?? row.payeeName ?? row.payee_name ??
        (dashIdx > 0 ? rawCarrierField.slice(dashIdx + 3) : rawCarrierField)
      );
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

    // Qualify if: (a) enough weeks were "active", OR (b) total loads meet the floor
    const meetsWeeks = weeksActive >= LANE_CONFIG.requiredWeeks;
    const meetsTotalLoads = totalLoads >= LANE_CONFIG.minTotalLoads;
    if (!meetsWeeks && !meetsTotalLoads) continue;

    const avgLoadsPerWeek = totalLoads / LANE_CONFIG.lookbackWeeks;

    // Determine confidence
    let eligibilityConfidence: "high" | "medium" | "borderline" = "borderline";
    if (weeksActive >= 4 && avgLoadsPerWeek >= 2) {
      eligibilityConfidence = "high";
    } else if (meetsWeeks && avgLoadsPerWeek >= 1) {
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
      // Persist a display-ready company name so downstream caches/reads
      // (lane_summary_cache, LWQ, etc.) never surface the raw
      // "code - name" TMS label. Idempotent for already-clean names from
      // the companies table.
      companyName: formatCustomerName(matchedCompany?.name ?? lane.companyNorm),
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

  runMeta.lanesGenerated = eligible.length;
  return { lanes: eligible, meta: runMeta };
}

/**
 * Run the full recurring lane capacity engine for an org:
 * identifies eligible lanes and upserts them into recurring_lanes.
 * V1.5: also auto-attaches historical carriers (from load rows) to each lane bench.
 */
export async function runRecurringLaneEngineForOrg(
  orgId: string,
  storage: IStorage,
): Promise<{ upserted: number; total: number; historicalCarriersAttached: number; meta: EngineRunMeta }> {
  const { lanes, meta } = await identifyRecurringLanes(orgId, storage);

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

  return { upserted, total: lanes.length, historicalCarriersAttached, meta };
}
