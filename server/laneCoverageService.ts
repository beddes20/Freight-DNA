/**
 * Lane Coverage Service
 *
 * Computes stable coverage status for recurring lanes based on financial upload history.
 * Identifies incumbent carriers, classifies coverage as stable/watch/unstable,
 * and provides helpers for carrier ranking integration.
 */

import type { RecurringLane, Carrier, FinancialUpload, LaneCoverageProfile, LaneCoverageProfileCarrier } from "@shared/schema";
import type { IStorage } from "./storage";

// ── Thresholds (configurable constants) ───────────────────────────────────────

export const COVERAGE_THRESHOLDS = {
  MIN_SAMPLE_SIZE: 8,           // minimum loads needed to qualify for "stable" status
  MIN_SAMPLE_FOR_WATCH: 3,      // minimum loads needed to qualify for "watch" status
  STABLE_COVERAGE_SHARE: 0.70,  // top carriers must cover ≥70% of loads for stable
  WATCH_COVERAGE_SHARE: 0.40,   // top carriers must cover ≥40% of loads for watch
  INCUMBENT_CAP: 5,             // max number of incumbent carriers tracked
  INCUMBENT_SCORE_FLOOR_TOP: 85, // score floor for rank-1 incumbent
  INCUMBENT_SCORE_FLOOR_STEP: 3, // score reduction per rank position (rank2 = 82, rank3 = 79, etc.)
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type CoverageStatus = "stable" | "watch" | "unstable";

export interface IncumbentCarrier {
  carrierId: string | null;
  carrierName: string;
  incumbentRank: number;
  successfulLoadCount: number;
  recentLoadCount: number;
  coverageShare: number;
  lastUsedAt: string | null;
  isCurrentPrimary: boolean;
}

export interface LaneCoverageEvaluation {
  status: CoverageStatus;
  sampleSize: number;
  qualifiedCarrierCount: number;
  topCarrierCoverageShare: number;
  incumbents: IncumbentCarrier[];
  reason: string;
}

interface TmsRow {
  shipperCity?: string;
  originCity?: string;
  origin?: string;
  consigneeCity?: string;
  destinationCity?: string;
  destination?: string;
  carrier?: string;
  carrierName?: string;
  carrier_name?: string;
  equipmentType?: string;
  mode?: string;
  month?: string | number;
}

function normStr(s: unknown): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function buildLaneKey(origin: string, destination: string, equipmentType: string | null | undefined): string {
  return `${normStr(origin)}||${normStr(destination)}||${normStr(equipmentType ?? "")}`;
}

/**
 * Returns true if a load row matches the lane for coverage purposes.
 * Equipment check: if lane has equipment type, row must match (blank row equip = no match).
 */
export function isStableCoverageEligible(
  row: TmsRow,
  lane: { origin: string; destination: string; equipmentType: string | null | undefined }
): boolean {
  const rowOrigin = normStr(row.shipperCity ?? row.originCity ?? row.origin ?? "");
  const rowDest = normStr(row.consigneeCity ?? row.destinationCity ?? row.destination ?? "");
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);

  if (!rowOrigin || !rowDest) return false;

  // Exact city match required for coverage stability (no state-level broadening)
  const originMatch = rowOrigin === originNorm ||
    (originNorm.length >= 4 && rowOrigin.length >= 4 &&
      (rowOrigin.includes(originNorm.slice(0, 4)) || originNorm.includes(rowOrigin.slice(0, 4))));
  const destMatch = rowDest === destNorm ||
    (destNorm.length >= 4 && rowDest.length >= 4 &&
      (rowDest.includes(destNorm.slice(0, 4)) || destNorm.includes(rowDest.slice(0, 4))));

  if (!originMatch || !destMatch) return false;

  // Equipment type check: if lane specifies equipment, row must match
  const laneEquip = normStr(lane.equipmentType ?? "");
  if (laneEquip) {
    const rowEquip = normStr(row.equipmentType ?? row.mode ?? "");
    if (!rowEquip) return false;
    // Check for overlap between equipment types (e.g. "dry van" vs "dryvan" vs "dry")
    const equipMatch = rowEquip === laneEquip ||
      rowEquip.includes(laneEquip.slice(0, 3)) ||
      laneEquip.includes(rowEquip.slice(0, 3));
    if (!equipMatch) return false;
  }

  return true;
}

/**
 * Evaluates coverage status from a list of matching TMS rows.
 * Does NOT filter by carrier eligibility — that is done in getIncumbentCarriersForLane.
 */
export function evaluateLaneCoverageStatus(
  matchingRows: Array<{ carrierName: string; month: string | null }>,
): LaneCoverageEvaluation {
  const sampleSize = matchingRows.length;

  // Below the absolute minimum — no meaningful evaluation possible
  if (sampleSize < COVERAGE_THRESHOLDS.MIN_SAMPLE_FOR_WATCH) {
    return {
      status: "unstable",
      sampleSize,
      qualifiedCarrierCount: 0,
      topCarrierCoverageShare: 0,
      incumbents: [],
      reason: `Insufficient history (${sampleSize} loads, need at least ${COVERAGE_THRESHOLDS.MIN_SAMPLE_FOR_WATCH}+)`,
    };
  }

  // Aggregate per carrier
  const carrierMap = new Map<string, { count: number; lastMonth: string | null }>();
  for (const row of matchingRows) {
    const name = normStr(row.carrierName);
    if (!name) continue;
    const existing = carrierMap.get(name) ?? { count: 0, lastMonth: null };
    const month = row.month ?? null;
    carrierMap.set(name, {
      count: existing.count + 1,
      lastMonth: month && month > (existing.lastMonth ?? "") ? month : existing.lastMonth,
    });
  }

  // Sort by load count descending
  const sorted = Array.from(carrierMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, COVERAGE_THRESHOLDS.INCUMBENT_CAP);

  if (sorted.length === 0) {
    return {
      status: "unstable",
      sampleSize,
      qualifiedCarrierCount: 0,
      topCarrierCoverageShare: 0,
      incumbents: [],
      reason: "No carrier data in history",
    };
  }

  // Total loads covered by top carriers
  const topLoads = sorted.reduce((sum, [, v]) => sum + v.count, 0);
  const topCoverageShare = topLoads / sampleSize;
  const qualifiedCarrierCount = sorted.length;

  // Build incumbents list
  const incumbents: IncumbentCarrier[] = sorted.map(([carrierName, data], idx) => ({
    carrierId: null,
    carrierName,
    incumbentRank: idx + 1,
    successfulLoadCount: data.count,
    recentLoadCount: data.count, // will be refined if we have more granular data
    coverageShare: data.count / sampleSize,
    lastUsedAt: data.lastMonth,
    isCurrentPrimary: idx === 0,
  }));

  let status: CoverageStatus;
  let reason: string;

  const hasEnoughForStable = sampleSize >= COVERAGE_THRESHOLDS.MIN_SAMPLE_SIZE;

  if (hasEnoughForStable && topCoverageShare >= COVERAGE_THRESHOLDS.STABLE_COVERAGE_SHARE) {
    status = "stable";
    reason = `${qualifiedCarrierCount} carrier${qualifiedCarrierCount > 1 ? "s" : ""} covered ${topLoads} of ${sampleSize} matching loads (${Math.round(topCoverageShare * 100)}%)`;
  } else if (topCoverageShare >= COVERAGE_THRESHOLDS.WATCH_COVERAGE_SHARE) {
    // Watch applies with sufficient concentration even if sample < MIN_SAMPLE_SIZE for stable
    status = "watch";
    reason = hasEnoughForStable
      ? `Top carriers covered ${Math.round(topCoverageShare * 100)}% of ${sampleSize} loads (need ${Math.round(COVERAGE_THRESHOLDS.STABLE_COVERAGE_SHARE * 100)}% for stable)`
      : `${Math.round(topCoverageShare * 100)}% concentration but only ${sampleSize} loads (need ${COVERAGE_THRESHOLDS.MIN_SAMPLE_SIZE}+ for stable)`;
  } else {
    status = "unstable";
    reason = `Scattered carrier history — top carriers only covered ${Math.round(topCoverageShare * 100)}% of ${sampleSize} loads`;
  }

  return {
    status,
    sampleSize,
    qualifiedCarrierCount,
    topCarrierCoverageShare: topCoverageShare,
    incumbents,
    reason,
  };
}

/**
 * Returns incumbent carriers for a lane filtered by eligibility rules:
 * - Not do_not_use, not inactive, not disqualified
 * - Matched against catalog if possible
 */
export async function getIncumbentCarriersForLane(
  lane: RecurringLane,
  storage: IStorage,
  evaluation: LaneCoverageEvaluation,
): Promise<IncumbentCarrier[]> {
  if (evaluation.incumbents.length === 0) return [];

  // Get catalog carriers to check eligibility
  let catalogCarriers: Carrier[] = [];
  try {
    catalogCarriers = await storage.getCarriers(lane.orgId);
  } catch {
    // If carrier lookup fails, still return incumbents without eligibility check
    return evaluation.incumbents;
  }

  const ineligibleStatuses = new Set(["do_not_use", "inactive", "disqualified"]);
  const ineligibleTags = new Set(["do_not_use", "service_flag", "flagged", "no_use"]);

  return evaluation.incumbents.map(inc => {
    // Try to find in catalog
    const catalogMatch = catalogCarriers.find(c =>
      normStr(c.name) === normStr(inc.carrierName) ||
      (c.id && c.id === inc.carrierId)
    );

    if (catalogMatch) {
      // Check eligibility
      const isIneligible =
        ineligibleStatuses.has(catalogMatch.status ?? "") ||
        (catalogMatch.tags ?? []).some(t => ineligibleTags.has(normStr(t)));

      if (isIneligible) return null; // exclude
      return { ...inc, carrierId: catalogMatch.id };
    }

    // Not in catalog — still include (might be a historical-only carrier)
    return inc;
  }).filter((inc): inc is IncumbentCarrier => inc !== null);
}

/**
 * Returns true if this lane should use the incumbent-first flow.
 * Applies when: profile exists, status is stable (or manually confirmed), and broadenSearchActive is false.
 */
export function shouldUseIncumbentFirstFlow(
  profile: LaneCoverageProfile | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.broadenSearchActive) return false;
  const effectiveStatus = profile.manualOverrideStatus ?? profile.coverageStatus;
  return effectiveStatus === "stable";
}

/**
 * Main entry point: compute and cache coverage profile for a lane.
 * On first call: scans uploads, evaluates, persists to DB, returns profile + carriers.
 * On subsequent calls: returns cached DB record (recomputes if older than 24h).
 */
export async function getLaneCoverageProfile(
  lane: RecurringLane,
  storage: IStorage,
): Promise<{ profile: LaneCoverageProfile; carriers: LaneCoverageProfileCarrier[] }> {
  const laneKey = buildLaneKey(lane.origin, lane.destination, lane.equipmentType);

  // Check for existing profile
  const existing = await storage.getLaneCoverageProfile(lane.orgId, laneKey);
  const cacheAgeHours = existing?.computedAt
    ? (Date.now() - new Date(existing.computedAt).getTime()) / (1000 * 60 * 60)
    : Infinity;

  // Use cache if < 24h old and no manual override changed
  if (existing && cacheAgeHours < 24) {
    const carriers = await storage.getLaneCoverageProfileCarriers(existing.id);
    return { profile: existing, carriers };
  }

  // Recompute from uploads
  const uploads = await storage.getFinancialUploadsForOrg(lane.orgId);

  // Collect matching rows
  const matchingRows: Array<{ carrierName: string; month: string | null }> = [];
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      if (!isStableCoverageEligible(row, lane)) continue;
      const carrierName = normStr(row.carrier ?? row.carrierName ?? row.carrier_name ?? "");
      if (!carrierName) continue;
      const month = String(row.month ?? "").slice(0, 7) || null;
      matchingRows.push({ carrierName, month });
    }
  }

  const evaluation = evaluateLaneCoverageStatus(matchingRows);
  const eligibleIncumbents = await getIncumbentCarriersForLane(lane, storage, evaluation);

  // Get carrier IDs from catalog
  let catalogCarriers: Carrier[] = [];
  try {
    catalogCarriers = await storage.getCarriers(lane.orgId);
  } catch { /* ignore */ }

  const now = new Date().toISOString();

  // Upsert profile
  const profile = await storage.upsertLaneCoverageProfile({
    orgId: lane.orgId,
    laneId: lane.id,
    laneKey,
    coverageStatus: evaluation.status,
    sampleSize: evaluation.sampleSize,
    qualifiedCarrierCount: evaluation.qualifiedCarrierCount,
    topCarrierCoverageShare: evaluation.topCarrierCoverageShare.toFixed(4),
    computedAt: now,
    manualOverrideStatus: existing?.manualOverrideStatus ?? null,
    manualOverrideReason: existing?.manualOverrideReason ?? null,
    manuallyConfirmedByUserId: existing?.manuallyConfirmedByUserId ?? null,
    manuallyConfirmedAt: existing?.manuallyConfirmedAt ?? null,
    broadenSearchActive: existing?.broadenSearchActive ?? false,
  });

  // Clear outdated carrier rows before writing fresh ones (prevents stale incumbents persisting)
  await storage.deleteLaneCoverageProfileCarriers(profile.id);

  // Insert fresh profile carriers
  const carrierRows: LaneCoverageProfileCarrier[] = [];
  for (const inc of eligibleIncumbents) {
    const catalogMatch = catalogCarriers.find(c => normStr(c.name) === normStr(inc.carrierName));
    const row = await storage.upsertLaneCoverageProfileCarrier({
      profileId: profile.id,
      carrierId: catalogMatch?.id ?? null,
      carrierName: inc.carrierName,
      incumbentRank: inc.incumbentRank,
      successfulLoadCount: inc.successfulLoadCount,
      recentLoadCount: inc.recentLoadCount,
      coverageShare: inc.coverageShare.toFixed(4),
      lastUsedAt: inc.lastUsedAt,
      lastSuccessAt: inc.lastUsedAt,
      isCurrentPrimary: inc.isCurrentPrimary,
    });
    carrierRows.push(row);
  }

  return { profile, carriers: carrierRows };
}
