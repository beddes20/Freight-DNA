/**
 * Carrier Ranking Service
 *
 * Given a recurring lane, scores each candidate carrier using:
 *   - Exact lane history (has the carrier run this corridor before?)
 *   - Similar-lane history (same region, similar haul, same equipment)
 *   - Carrier catalog region/equipment fit
 *   - Recency of last move
 *   - Notes quality
 *
 * Returns a ranked list with a short human-readable reason per carrier.
 *
 * V1 uses rule-based scoring; AI enrichment is additive.
 */

import type { RecurringLane, Carrier, FinancialUpload, LaneCarrierInterest, LaneCoverageProfile, LaneCoverageProfileCarrier } from "@shared/schema";
import type { IStorage } from "./storage";
import { COVERAGE_THRESHOLDS, shouldUseIncumbentFirstFlow } from "./laneCoverageService";

/**
 * Raw TMS row from financial upload JSONB.
 * Keys may be camelCase OR title-case-with-spaces depending on the source TMS file.
 * Always use readTmsField() to access values — never access properties directly.
 */
type TmsRow = Record<string, unknown>;

/**
 * Read a field from a raw TMS JSONB row, trying each candidate key in order.
 * Handles both camelCase variants (old exports) and space-separated title-case variants
 * (e.g. real TMS exports that preserve spreadsheet column names verbatim).
 * Returns the first non-empty string value found, or "" if none.
 * Exported for unit testing.
 */
export function readTmsField(row: TmsRow, ...keys: string[]): string {
  for (const key of keys) {
    const val = row[key];
    if (val !== undefined && val !== null && val !== "") return String(val);
  }
  return "";
}

/**
 * Parse a clean carrier name from a raw TMS carrier field.
 * Handles the "PAYCODE - CARRIER NAME" format used in many TMS exports
 * (e.g. "DHAMLIAZ - DHAMI CARRIER LLC" → "DHAMI CARRIER LLC").
 * If no payee-code prefix is detected, returns the raw value as-is.
 * Exported for unit testing.
 */
export function parseCarrierName(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Pattern: up to ~10 alphanum chars, a space-dash-space, then the real name
  const match = trimmed.match(/^[A-Z0-9]{2,12}\s+-\s+(.+)$/i);
  if (match) return match[1].trim();
  return trimmed;
}

/**
 * Extract the payee code from a "PAYCODE - CARRIER NAME" TMS carrier string.
 * Returns null if the format doesn't match.
 * Exported for unit testing.
 */
export function parsePayeeCode(raw: string): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/^([A-Z0-9]{2,12})\s+-\s+.+$/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Convert a raw TMS month value to canonical "YYYY-MM" format.
 * Handles:
 *   "2026 M03"  → "2026-03"   (real TMS format)
 *   "2025 M10"  → "2025-10"
 *   "2025-10"   → "2025-10"   (already canonical)
 *   "2025-10-01"→ "2025-10"   (ISO date, truncated)
 *   number      → "" (unrecognized)
 */
export function normalizeTmsMonth(raw: string | number | undefined | null): string {
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw).trim();
  // Format: "2025 M10" or "2025 M9"
  const mSpaceMatch = s.match(/^(\d{4})\s+M(\d{1,2})$/i);
  if (mSpaceMatch) return `${mSpaceMatch[1]}-${mSpaceMatch[2].padStart(2, "0")}`;
  // Already "YYYY-MM" or starts with "YYYY-MM-..."
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  // Slash variant "YYYY/MM"
  const slashMatch = s.match(/^(\d{4})\/(\d{1,2})/);
  if (slashMatch) return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}`;
  return "";
}

/**
 * Extract the city portion from a combined "CITY, ST" or "CITY, STATE" origin/destination string.
 * Returns the full string unchanged if no comma is found (already city-only).
 * Examples:
 *   "PHOENIX, AZ"      → "phoenix"
 *   "South Salt Lake, UT" → "south salt lake"
 *   "phoenix"          → "phoenix"
 */
export function extractCity(raw: string): string {
  if (!raw) return "";
  const commaIdx = raw.lastIndexOf(",");
  if (commaIdx > 0) return raw.slice(0, commaIdx).trim().toLowerCase();
  return raw.trim().toLowerCase();
}

export interface RankedCarrier {
  carrierId: string | null;
  carrierName: string;
  mcDot: string | null;
  primaryEmail: string | null;
  backupEmail: string | null;
  regions: string[];
  equipmentTypes: string[];
  tags: string[];
  notes: string | null;
  fitScore: number;           // 0–100
  fitReason: string;
  historyMatch: "exact" | "similar" | "region" | "none";
  loadsOnLane: number;
  lastUsedMonth: string | null;
  isNewProspect: boolean;
  estimatedOnTimePct: number | null;   // derived from financial row on-time field if available
  marginContribution: number | null;   // derived from financial rows margin field if available
  customerHistoryLoads: number;        // loads this carrier hauled for the same customer
  priorOutcomeBoost: boolean;          // true if prior bench outcome was positive (available_now/next_week)
  sourceChannel: string | null;        // where this carrier was originally sourced from
  suppressionReasons: string[];        // human-readable negative flags (no email, recently contacted, flagged, etc.)
  equipmentMatch: boolean;             // carrier equipment overlaps with lane equipment
  regionMatch: boolean;                // carrier regions overlap with lane origin/dest
  isIncumbent: boolean;                // true if this carrier is an incumbent for a stable lane
  incumbentRank: number | null;        // 1-based rank among incumbents (null if not incumbent)
  isDoNotUse: boolean;                 // true if carrier status is do_not_use or tags include do_not_use/no_use
}

function normStr(s: string): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function overlaps(a: string[], b: string): boolean {
  const bLow = normStr(b);
  return a.some(x => normStr(x).includes(bLow) || bLow.includes(normStr(x)));
}

/**
 * Extract carrier history from financial upload rows for a given lane.
 * Returns a map of carrierName (normalized) → { loads, lastUsedMonth }
 */
interface CarrierHistory {
  loads: number;
  lastUsedMonth: string | null;
  /** Average on-time percentage from financial rows (if present) */
  avgOnTimePct: number | null;
  /** Total margin contribution from financial rows (if present) */
  totalMargin: number | null;
  marginRowCount: number;
  /** Best match tier across all matched rows — drives score differentiation */
  bestMatchTier: "exact" | "city" | "state";
}

function extractCarrierHistoryFromUploads(
  uploads: FinancialUpload[],
  lane: RecurringLane,
): Map<string, CarrierHistory> {
  const history = new Map<string, CarrierHistory>();
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);
  // State-pair matching: cast a wider net by accepting any corridor in the same
  // origin-state → dest-state direction (like the carrier lane search radius approach)
  const laneOrigStateLower = normStr(lane.originState ?? "");
  const laneDestStateLower = normStr(lane.destinationState ?? "");

  // Sort uploads newest first
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      // --- Field extraction: handle both camelCase (legacy exports) and title-case-with-spaces (real TMS) ---
      // Origin: try dedicated city field first, then extract city from combined "CITY, ST" field
      const rawOriginCity = readTmsField(row, "shipperCity", "originCity", "Shipper city", "Origin city");
      const rawOriginFull = readTmsField(row, "origin", "Origin");
      const rowOrigin = normStr(rawOriginCity || extractCity(rawOriginFull));

      const rawDestCity = readTmsField(row, "consigneeCity", "destinationCity", "Consignee city", "Destination city");
      const rawDestFull = readTmsField(row, "destination", "Destination");
      const rowDest = normStr(rawDestCity || extractCity(rawDestFull));

      // State: dedicated state field
      const rowOriginState = normStr(readTmsField(row, "shipperState", "originState", "Shipper state", "Origin state"));
      const rowDestState = normStr(readTmsField(row, "consigneeState", "destinationState", "destState", "Consignee state", "Destination state"));

      // Carrier: strip "PAYCODE - " prefix if present
      const rawCarrierField = readTmsField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
      const carrierRaw = normStr(parseCarrierName(rawCarrierField));

      // Month: normalize "2026 M03" → "2026-03"
      const rawMonth = readTmsField(row, "month", "Month");
      const month = normalizeTmsMonth(rawMonth);

      // On-time % and margin
      const onTimeRaw = readTmsField(row, "onTimePct", "on_time_pct", "On-time %", "On time pct");
      const onTimeParsed = onTimeRaw ? parseFloat(onTimeRaw) : NaN;
      const marginRaw = readTmsField(row, "margin", "marginPct", "Margin $", "Margin %");
      const marginParsed = marginRaw ? parseFloat(marginRaw) : NaN;

      if (!carrierRaw) continue;

      // Skip rows with blank origin or destination — they can't be meaningfully matched
      if (!rowOrigin || !rowDest) continue;

      const isExact = rowOrigin === originNorm && rowDest === destNorm;

      // Tier 2: city-prefix similarity (requires 4-char match on both sides)
      const originPrefix = originNorm.slice(0, 4);
      const destPrefix = destNorm.slice(0, 4);
      const isSimilarOrigin = originPrefix.length >= 4 && rowOrigin.length >= 4 &&
        (rowOrigin.includes(originPrefix) || originNorm.includes(rowOrigin.slice(0, 4)));
      const isSimilarDest = destPrefix.length >= 4 && rowDest.length >= 4 &&
        (rowDest.includes(destPrefix) || destNorm.includes(rowDest.slice(0, 4)));
      const isCitySimilar = isSimilarOrigin && isSimilarDest;

      // Tier 3: wider net — same origin state AND same destination state
      // (e.g. "Dallas, TX → Memphis, TN" counts for "Laredo, TX → Nashville, TN")
      const isStatePairMatch = laneOrigStateLower.length >= 2 && laneDestStateLower.length >= 2 &&
        rowOriginState.length >= 2 && rowDestState.length >= 2 &&
        rowOriginState === laneOrigStateLower && rowDestState === laneDestStateLower;

      if (!isExact && !isCitySimilar && !isStatePairMatch) continue;

      const thisTier: CarrierHistory["bestMatchTier"] = isExact ? "exact" : isCitySimilar ? "city" : "state";

      const existing = history.get(carrierRaw) ?? { loads: 0, lastUsedMonth: null, avgOnTimePct: null, totalMargin: null, marginRowCount: 0, bestMatchTier: thisTier };

      // Upgrade the stored tier if this row is a better match (exact > city > state)
      const tierRank = { exact: 0, city: 1, state: 2 } as const;
      const betterTier = tierRank[thisTier] < tierRank[existing.bestMatchTier] ? thisTier : existing.bestMatchTier;

      history.set(carrierRaw, {
        loads: existing.loads + 1,
        lastUsedMonth: month > (existing.lastUsedMonth ?? "") ? month : existing.lastUsedMonth,
        avgOnTimePct: !isNaN(onTimeParsed)
          ? ((existing.avgOnTimePct ?? onTimeParsed) * existing.loads + onTimeParsed) / (existing.loads + 1)
          : existing.avgOnTimePct,
        totalMargin: !isNaN(marginParsed)
          ? (existing.totalMargin ?? 0) + marginParsed
          : existing.totalMargin,
        marginRowCount: !isNaN(marginParsed) ? existing.marginRowCount + 1 : existing.marginRowCount,
        bestMatchTier: betterTier,
      });
    }
  }

  return history;
}

/**
 * Extract how many loads a carrier ran for a specific customer from financial uploads.
 * Used as an additional ranking signal when customer context is available.
 */
function extractCustomerHistoryLoads(
  uploads: FinancialUpload[],
  carrierName: string,
  customerName: string,
): number {
  if (!customerName || !carrierName) return 0;
  const customerNorm = normStr(customerName);
  const carrierNorm = normStr(carrierName);
  let count = 0;
  // Sort newest first (same strategy as extractCarrierHistoryFromUploads)
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      const rawCarrier = readTmsField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
      const rowCarrier = normStr(parseCarrierName(rawCarrier));
      const rowCustomer = normStr(readTmsField(row, "customerName", "Customer", "customer", "customer_name"));
      if (!rowCarrier || !rowCustomer) continue;
      if (rowCarrier === carrierNorm && rowCustomer.includes(customerNorm.slice(0, 6))) count++;
    }
  }
  return count;
}

/**
 * Rank all carriers in the org catalog for a given lane.
 * bench (optional): existing lane_carrier_interest rows for outcome-based boosts.
 * coverageProfile + coverageCarriers (optional): if stable lane, incumbents get heavy score boost.
 *
 * Returns ALL scored carriers (no hard cap). Callers should apply pagination/filtering.
 */
export async function rankCarriersForLane(
  lane: RecurringLane,
  storage: IStorage,
  bench?: LaneCarrierInterest[],
  coverageProfile?: LaneCoverageProfile | null,
  coverageCarriers?: LaneCoverageProfileCarrier[],
): Promise<RankedCarrier[]> {
  const [catalogCarriers, uploads] = await Promise.all([
    storage.getCarriers(lane.orgId),
    storage.getFinancialUploadsForOrg(lane.orgId),
  ]);

  // Build a set of carrier names/ids that had positive prior outcomes on this bench
  const positiveOutcomeStatuses = new Set(["available_now", "available_next_week"]);
  const positiveOutcomeCarrierKeys = new Set<string>();
  if (bench) {
    for (const b of bench) {
      if (positiveOutcomeStatuses.has(b.interestStatus ?? "")) {
        if (b.carrierId) positiveOutcomeCarrierKeys.add(b.carrierId);
        positiveOutcomeCarrierKeys.add(normStr(b.carrierName));
      }
    }
  }

  // Build set of recently-contacted carrier keys (last 14 days)
  const recentlyContactedKeys = new Set<string>();
  const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  if (bench) {
    for (const b of bench) {
      if (b.outreachSentAt) {
        const sentAt = new Date(b.outreachSentAt).getTime();
        if (sentAt > fourteenDaysAgo) {
          if (b.carrierId) recentlyContactedKeys.add(b.carrierId);
          recentlyContactedKeys.add(normStr(b.carrierName));
        }
      }
    }
  }

  const history = extractCarrierHistoryFromUploads(uploads, lane);
  const laneOrigin = normStr(lane.origin);
  const laneDest = normStr(lane.destination);
  const laneEquip = normStr(lane.equipmentType ?? "");
  const laneOriginState = normStr(lane.originState ?? "");
  const laneDestState = normStr(lane.destinationState ?? "");
  const customerName = lane.companyName ?? "";

  // Build incumbent lookup for coverage boost
  const useIncumbentFlow = shouldUseIncumbentFirstFlow(coverageProfile);
  const ineligibleStatuses = new Set(["do_not_use", "inactive", "disqualified"]);
  const ineligibleTags = new Set(["do_not_use", "service_flag", "flagged", "no_use"]);
  // Map: normalized carrier name → incumbent rank (1-based)
  const incumbentRankMap = new Map<string, number>();
  if (useIncumbentFlow && coverageCarriers) {
    for (const ic of coverageCarriers) {
      incumbentRankMap.set(normStr(ic.carrierName), ic.incumbentRank);
      if (ic.carrierId) incumbentRankMap.set(ic.carrierId, ic.incumbentRank);
    }
  }

  const ranked: RankedCarrier[] = [];

  // Score catalog carriers
  for (const carrier of catalogCarriers) {
    const carrierNorm = normStr(carrier.name);
    const hist = history.get(carrierNorm);
    let fitScore = 0;
    const reasons: string[] = [];
    let historyMatch: RankedCarrier["historyMatch"] = "none";

    // Exact history match — use guaranteed floor scores
    if (hist && hist.loads > 0) {
      const exactLoad = extractExactLaneLoads(uploads, lane, carrier.name);
      if (exactLoad > 0) {
        historyMatch = "exact";
        // Guaranteed floor scores that regional-only carriers can't reach
        let exactFloor: number;
        if (exactLoad >= 10) exactFloor = 80;
        else if (exactLoad >= 5) exactFloor = 70;
        else exactFloor = 55;
        // Additional incremental bonus per load (up to 10 extra points)
        const extraPts = Math.min(10, exactLoad * 1);
        fitScore = Math.max(exactFloor, exactFloor + extraPts - 10);
        // Always at least the floor
        fitScore = Math.max(exactFloor, fitScore);
        // Determine recency window for reason label
        const exactDays = daysSinceMonth(hist.lastUsedMonth ?? null);
        if (exactDays <= 90) {
          reasons.push(`Ran this exact lane ${exactLoad}× in last 90 days`);
        } else if (exactDays <= 180) {
          reasons.push(`Ran this exact lane ${exactLoad}× (last ~${Math.round(exactDays / 30)} months ago)`);
        } else {
          reasons.push(`Ran this exact lane ${exactLoad}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
        }
      } else if (hist.bestMatchTier === "city") {
        // Similar corridor (city-level prefix match) — 50–64 band
        historyMatch = "similar";
        fitScore = Math.min(64, 50 + Math.min(14, hist.loads * 2));
        reasons.push(`Ran similar corridors (${hist.loads} loads in region)`);
      } else {
        // State-pair match only — wider net, lower confidence
        historyMatch = "similar";
        fitScore += 12;
        reasons.push(`Runs ${(lane.originState ?? "origin state").toUpperCase()} → ${(lane.destinationState ?? "dest state").toUpperCase()} lanes (${hist.loads} loads)`);
      }
    }

    // Equipment fit — reduced weights; pure tie-breaker territory
    let equipmentMatch = false;
    if (laneEquip && carrier.equipmentTypes && carrier.equipmentTypes.length > 0) {
      if (overlaps(carrier.equipmentTypes, laneEquip)) {
        equipmentMatch = true;
        // Reduced from +20/+5 to +12/+3
        if (historyMatch === "none" || historyMatch === "region") {
          fitScore += 12;
        } else {
          fitScore += 3; // smaller bonus when history already gives the edge
        }
        reasons.push(`Equipment match: ${laneEquip}`);
      }
    } else {
      fitScore += 6; // no equipment filter = assume general fit (reduced from 10)
    }

    // Region fit — reduced weights; pure tie-breaker territory
    const carrierRegions = carrier.regions ?? [];
    const regionMatch =
      (laneOriginState && overlaps(carrierRegions, laneOriginState)) ||
      (laneDestState && overlaps(carrierRegions, laneDestState)) ||
      overlaps(carrierRegions, laneOrigin) ||
      overlaps(carrierRegions, laneDest);
    if (regionMatch) {
      if (historyMatch === "none") historyMatch = "region";
      // Reduced from +15/+5 to +8/+3 — pure tie-breaker, cannot force top rank
      if (historyMatch === "region") {
        fitScore += 8;
      } else {
        fitScore += 3;
      }
      // Region catalog is now a secondary signal, not pushed as primary reason
    }

    // Capture the pre-decay signal baseline.
    // Used for the visibility guard below: any carrier with at least one positive signal
    // (history, region, equipment) should remain visible even after staleness penalty.
    const preDecayBaseline = fitScore;

    // Recency decay signal — applied to ALL carriers regardless of history.
    // Carriers with no executed loads at all are treated as 365+ days stale (-25).
    // This demotes generic catalog carriers that have no proven freight record.
    {
      // lastUsedMonth from history, or null if carrier has no history at all
      const lastMonth = hist?.lastUsedMonth ?? null;
      const decay = recencyDecayScore(lastMonth);
      fitScore += decay.score;

      const days = daysSinceMonth(lastMonth);
      // Show explicit staleness/recency reason when it matters to the operator:
      //   - No history at all → stale fallback
      //   - 181+ days stale → fallback warning
      //   - ≤ 90 days → positive recency credit (only if carrier has lane history)
      if (!hist) {
        // No lane history at all — active carrier, but purely a prospect
        reasons.push("No executed loads on record — shown as fallback");
      } else if (days >= 181) {
        reasons.push(decay.reason);
      } else if (days <= 90 && historyMatch !== "none") {
        // Recency credit only when there's matching history to credit
        reasons.push(decay.reason);
      }
      // 91–180 days: neutral — omit from reason list to keep it clean
    }

    // On-time % bonus from financial rows
    if (hist?.avgOnTimePct !== null && hist?.avgOnTimePct !== undefined) {
      if (hist.avgOnTimePct >= 95) { fitScore += 8; reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
      else if (hist.avgOnTimePct >= 85) { fitScore += 4; reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
    }

    // Margin contribution bonus from financial rows
    if (hist?.totalMargin !== null && hist?.totalMargin !== undefined && hist.totalMargin > 0) {
      const avgMargin = hist.totalMargin / Math.max(1, hist.marginRowCount);
      if (avgMargin >= 500) { fitScore += 5; reasons.push(`Avg margin contribution: $${avgMargin.toFixed(0)}`); }
    }

    // "Has email" is no longer a score signal — removed per recency fix (Task #162)

    // Customer history signal: carrier has run freight for this same customer before
    // Increased cap from +15 to +20; base from +8 to +12
    const custLoads = extractCustomerHistoryLoads(uploads, carrier.name, customerName);
    if (custLoads > 0) {
      fitScore += Math.min(20, 12 + custLoads * 2);
      reasons.push(`Hauled for ${customerName} (${custLoads} loads)`);
    }

    // Prior outreach outcome signal: carrier responded positively on a previous bench
    // Increased from +10 to +12
    const hadPositiveOutcome =
      positiveOutcomeCarrierKeys.has(carrier.id) ||
      positiveOutcomeCarrierKeys.has(carrierNorm);
    if (hadPositiveOutcome) {
      fitScore += 12;
      reasons.push("Showed availability in prior outreach");
    }

    // Clamp score to [0, 100] — negative raw scores are possible after staleness penalty;
    // clamp before display so the UI never shows negative numbers.
    fitScore = Math.max(0, Math.min(100, fitScore));

    // Skip carriers with zero pre-decay signal: no history, no region, no equipment affinity.
    // The pre-decay baseline (rather than the post-penalty score) is the right signal here:
    // a carrier with region or equipment match should remain visible as a fallback even if
    // staleness drives their final score to 0.
    if (preDecayBaseline === 0 && historyMatch === "none" && !regionMatch) continue;

    // Build suppression reasons
    const suppressionReasons: string[] = [];
    if (!carrier.primaryEmail && !carrier.backupEmail) {
      suppressionReasons.push("No email on file");
    }
    const isRecentlyContacted = recentlyContactedKeys.has(carrier.id) || recentlyContactedKeys.has(carrierNorm);
    if (isRecentlyContacted) {
      const benchEntry = bench?.find(b =>
        (b.carrierId === carrier.id || normStr(b.carrierName) === carrierNorm) && b.outreachSentAt
      );
      if (benchEntry?.outreachSentAt) {
        const daysAgo = Math.round((Date.now() - new Date(benchEntry.outreachSentAt).getTime()) / (1000 * 60 * 60 * 24));
        suppressionReasons.push(`Recently contacted (${daysAgo} day${daysAgo === 1 ? "" : "s"} ago)`);
      } else {
        suppressionReasons.push("Recently contacted");
      }
    }
    const flagTags = ["do_not_use", "service_flag", "flagged", "no_use"];
    if ((carrier.tags ?? []).some(t => flagTags.includes(normStr(t)))) {
      suppressionReasons.push("Flagged / do not use");
    }
    // Suppress carriers whose Carrier Hub status is flagged, inactive, or do_not_use
    if (carrier.status === "do_not_use") {
      suppressionReasons.push("Marked Do Not Use in Carrier Hub");
    } else if (carrier.status === "flagged") {
      suppressionReasons.push("Flagged in Carrier Hub — verify before use");
    } else if (carrier.status === "inactive") {
      suppressionReasons.push("Marked Inactive in Carrier Hub");
    }
    if (hist?.lastUsedMonth) {
      const staleDays = daysSinceMonth(hist.lastUsedMonth);
      if (staleDays >= 181) {
        suppressionReasons.push(`No executed loads in ${staleDays} days — shown as fallback`);
      }
    } else {
      // hist is undefined (no history at all) OR hist exists but has no month data
      // Both cases are treated as "no executed loads on record"
      suppressionReasons.push("No executed loads on record — shown as fallback");
    }

    // Incumbent boost: if lane is stable and carrier is an incumbent, apply score floor
    // do_not_use carriers still get suppressed even if they are incumbents
    const isCarrierIneligible =
      ineligibleStatuses.has(carrier.status ?? "") ||
      (carrier.tags ?? []).some(t => ineligibleTags.has(normStr(t)));
    const incumbentRank = (!isCarrierIneligible && useIncumbentFlow)
      ? (incumbentRankMap.get(carrier.id) ?? incumbentRankMap.get(carrierNorm) ?? null)
      : null;
    const isIncumbent = incumbentRank !== null;
    if (isIncumbent && incumbentRank !== null) {
      const incumbentFloor = Math.max(1, COVERAGE_THRESHOLDS.INCUMBENT_SCORE_FLOOR_TOP - (incumbentRank - 1) * COVERAGE_THRESHOLDS.INCUMBENT_SCORE_FLOOR_STEP);
      fitScore = Math.max(incumbentFloor, fitScore);
      if (!reasons.some(r => r.toLowerCase().includes("incumbent"))) {
        reasons.push(`Proven incumbent (rank #${incumbentRank})`);
      }
    }

    const isDoNotUse =
      carrier.status === "do_not_use" ||
      (carrier.tags ?? []).some(t => ["do_not_use", "no_use"].includes(normStr(t)));
    ranked.push({
      carrierId: carrier.id,
      carrierName: carrier.name,
      mcDot: carrier.mcDot ?? null,
      primaryEmail: carrier.primaryEmail ?? null,
      backupEmail: carrier.backupEmail ?? null,
      regions: carrier.regions ?? [],
      equipmentTypes: carrier.equipmentTypes ?? [],
      tags: carrier.tags ?? [],
      notes: carrier.notes ?? null,
      fitScore,
      fitReason: reasons.length > 0 ? reasons.join(". ") + "." : "Carrier in region catalog.",
      historyMatch,
      loadsOnLane: hist?.loads ?? 0,
      lastUsedMonth: hist?.lastUsedMonth ?? null,
      isNewProspect: (hist?.loads ?? 0) === 0,
      estimatedOnTimePct: hist?.avgOnTimePct ?? null,
      marginContribution: hist?.totalMargin ?? null,
      customerHistoryLoads: custLoads,
      priorOutcomeBoost: hadPositiveOutcome,
      sourceChannel: (carrier as any).sourceChannel ?? null,
      suppressionReasons,
      equipmentMatch,
      regionMatch: !!regionMatch,
      isIncumbent,
      incumbentRank,
      isDoNotUse,
    });
  }

  // Also add carriers from financial history that aren't in catalog yet
  for (const [carrierNorm, hist] of history.entries()) {
    const alreadyInCatalog = ranked.some(r => normStr(r.carrierName) === carrierNorm);
    if (alreadyInCatalog) continue;
    if ((hist.loads ?? 0) < 1) continue;

    const exactLoad = extractExactLaneLoads(uploads, lane, carrierNorm);
    const historyMatch: RankedCarrier["historyMatch"] = exactLoad > 0 ? "exact" : "similar";

    // Apply floor scoring for history-only carriers — same bands as catalog carriers
    let fitScore: number;
    const reasons: string[] = [];
    if (exactLoad >= 10) {
      fitScore = 80;
      const histDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (histDays <= 90) {
        reasons.push(`Ran this exact lane ${exactLoad}× in last 90 days`);
      } else if (histDays <= 180) {
        reasons.push(`Ran this exact lane ${exactLoad}× (last ~${Math.round(histDays / 30)} months ago)`);
      } else {
        reasons.push(`Ran this exact lane ${exactLoad}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
      }
    } else if (exactLoad >= 5) {
      fitScore = 70;
      const histDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (histDays <= 90) {
        reasons.push(`Ran this exact lane ${exactLoad}× in last 90 days`);
      } else if (histDays <= 180) {
        reasons.push(`Ran this exact lane ${exactLoad}× (last ~${Math.round(histDays / 30)} months ago)`);
      } else {
        reasons.push(`Ran this exact lane ${exactLoad}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
      }
    } else if (exactLoad > 0) {
      fitScore = 55;
      const histDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (histDays <= 90) {
        reasons.push(`Ran this exact lane ${exactLoad}× in last 90 days`);
      } else if (histDays <= 180) {
        reasons.push(`Ran this exact lane ${exactLoad}× (last ~${Math.round(histDays / 30)} months ago)`);
      } else {
        reasons.push(`Ran this exact lane ${exactLoad}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
      }
    } else if (hist.bestMatchTier === "city") {
      fitScore = Math.min(64, 50 + Math.min(14, hist.loads * 2));
      reasons.push(`${hist.loads} loads on similar corridors`);
    } else {
      // State-pair match only — wider net, lower base score
      fitScore = Math.min(55, 18 + hist.loads * 2);
      reasons.push(`Runs ${(lane.originState ?? "origin state").toUpperCase()} → ${(lane.destinationState ?? "dest state").toUpperCase()} lanes (${hist.loads} loads, financial data)`);
    }

    // Apply recency decay to history-only carriers as well
    const histDecay = recencyDecayScore(hist.lastUsedMonth ?? null);
    fitScore = Math.max(0, Math.min(100, fitScore + histDecay.score));
    // Add staleness reason for any stale history-only carrier (exact or non-exact)
    {
      const histDecayDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (histDecayDays >= 181) {
        reasons.push(histDecay.reason);
      }
      // Recent carriers (≤ 90 days) already carry the load count + recency label above
    }

    // On-time % from financial rows
    if (hist.avgOnTimePct !== null && hist.avgOnTimePct !== undefined) {
      if (hist.avgOnTimePct >= 95) { fitScore = Math.min(100, fitScore + 8); reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
      else if (hist.avgOnTimePct >= 85) { fitScore = Math.min(100, fitScore + 4); reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
    }

    // Customer history signal for TMS-only carriers
    // Increased cap from +15 to +20; base from +8 to +12
    const custLoadsHist = extractCustomerHistoryLoads(uploads, carrierNorm, customerName);
    if (custLoadsHist > 0) {
      fitScore = Math.min(100, fitScore + Math.min(20, 12 + custLoadsHist * 2));
      reasons.push(`Hauled for ${customerName} (${custLoadsHist} loads)`);
    }

    // Outreach outcome signal for TMS-only carriers
    // Increased from +10 to +12
    const hadPositiveOutcomeHist = positiveOutcomeCarrierKeys.has(carrierNorm);
    if (hadPositiveOutcomeHist) {
      fitScore = Math.min(100, fitScore + 12);
      reasons.push("Showed availability in prior outreach");
    }

    // Suppression reasons for history-only carriers
    const suppressionReasons: string[] = [];
    suppressionReasons.push("No email on file"); // TMS-only carriers have no catalog entry
    const isRecentlyContactedHist = recentlyContactedKeys.has(carrierNorm);
    if (isRecentlyContactedHist) {
      const benchEntry = bench?.find(b => normStr(b.carrierName) === carrierNorm && b.outreachSentAt);
      if (benchEntry?.outreachSentAt) {
        const daysAgo = Math.round((Date.now() - new Date(benchEntry.outreachSentAt).getTime()) / (1000 * 60 * 60 * 24));
        suppressionReasons.push(`Recently contacted (${daysAgo} day${daysAgo === 1 ? "" : "s"} ago)`);
      } else {
        suppressionReasons.push("Recently contacted");
      }
    }
    if (hist.lastUsedMonth) {
      const staleDaysHist = daysSinceMonth(hist.lastUsedMonth);
      if (staleDaysHist >= 181) {
        suppressionReasons.push(`No executed loads in ${staleDaysHist} days — shown as fallback`);
      }
    }

    // Incumbent boost for TMS-only carriers
    const incumbentRankHist = useIncumbentFlow ? (incumbentRankMap.get(carrierNorm) ?? null) : null;
    const isIncumbentHist = incumbentRankHist !== null;
    if (isIncumbentHist && incumbentRankHist !== null) {
      const incumbentFloor = Math.max(1, COVERAGE_THRESHOLDS.INCUMBENT_SCORE_FLOOR_TOP - (incumbentRankHist - 1) * COVERAGE_THRESHOLDS.INCUMBENT_SCORE_FLOOR_STEP);
      fitScore = Math.min(100, Math.max(incumbentFloor, fitScore));
      if (!reasons.some(r => r.toLowerCase().includes("incumbent"))) {
        reasons.push(`Proven incumbent (rank #${incumbentRankHist})`);
      }
    }

    ranked.push({
      carrierId: null,
      carrierName: toTitleCase(carrierNorm),
      mcDot: null,
      primaryEmail: null,
      backupEmail: null,
      regions: [],
      equipmentTypes: [],
      tags: [],
      notes: null,
      fitScore,
      fitReason: reasons.join(". ") + ".",
      historyMatch,
      loadsOnLane: hist.loads,
      lastUsedMonth: hist.lastUsedMonth,
      isNewProspect: false,
      estimatedOnTimePct: hist.avgOnTimePct,
      marginContribution: hist.totalMargin,
      customerHistoryLoads: custLoadsHist,
      priorOutcomeBoost: hadPositiveOutcomeHist,
      sourceChannel: null,
      suppressionReasons,
      equipmentMatch: false,
      regionMatch: false,
      isIncumbent: isIncumbentHist,
      incumbentRank: incumbentRankHist,
      isDoNotUse: false,
    });
  }

  // Sort by fitScore descending — scores encode history quality + recency + all signals,
  // so score-first ordering correctly demotes stale exact-lane carriers below fresher proven ones.
  // historyMatch is a secondary tiebreaker only when scores are exactly equal.
  ranked.sort((a, b) => {
    const scoreDiff = b.fitScore - a.fitScore;
    if (scoreDiff !== 0) return scoreDiff;
    const matchRank = { exact: 0, similar: 1, region: 2, none: 3 };
    return matchRank[a.historyMatch] - matchRank[b.historyMatch];
  });

  // AI enrichment: enrich fitReason strings for top-5 rule-scored candidates only.
  // AI re-sort only affects the top-5 positions; the rest keep rule-based order.
  // No hard cap on total returned — callers handle pagination.
  try {
    const { callAI } = await import("./aiHelpers");
    const top5 = ranked.slice(0, 5);
    if (top5.length > 0) {
      const carrierSummaries = top5.map((c, i) =>
        `${i + 1}. ${c.carrierName}: rule fit=${c.fitScore}, history=${c.historyMatch}, ` +
        `loads=${c.loadsOnLane}, onTime=${c.estimatedOnTimePct != null ? c.estimatedOnTimePct.toFixed(0) + "%" : "?"}` +
        `${c.notes ? `, notes: ${c.notes.slice(0, 80)}` : ""}`
      ).join("\n");

      const prompt = `You are a freight logistics analyst. Assess each carrier's fit for this recurring lane.

Lane: ${lane.origin} → ${lane.destination} (${lane.equipmentType ?? "any equipment"})
Customer: ${lane.companyName ?? "Unknown"}, avg ${lane.avgLoadsPerWeek} loads/week

Carriers (rule-scored):
${carrierSummaries}

For each carrier, provide a concise 1-sentence fit reason focusing on capacity reliability and lane experience.
Respond ONLY with JSON array: [{"name": "<carrier name>", "reason": "<1 sentence>", "adjustedScore": <0-100>}]`;

      const raw = await callAI(prompt, 300);
      const aiResults: Array<{ name: string; reason: string; adjustedScore: number }> =
        JSON.parse(raw.replace(/```json|```/g, "").trim());

      if (Array.isArray(aiResults)) {
        for (const aiItem of aiResults) {
          const carrier = top5.find(c => normStr(c.carrierName) === normStr(aiItem.name));
          if (carrier && typeof aiItem.reason === "string" && typeof aiItem.adjustedScore === "number") {
            carrier.fitReason = aiItem.reason;
            // Blend rule-based and AI scores (70/30) but enforce history floor
            const blended = Math.min(100, Math.max(0,
              Math.round(0.7 * carrier.fitScore + 0.3 * aiItem.adjustedScore)
            ));
            // Never let AI drag an exact-history carrier below its floor
            if (carrier.historyMatch === "exact") {
              const exactLoads = carrier.loadsOnLane;
              const floor = exactLoads >= 10 ? 80 : exactLoads >= 5 ? 70 : 55;
              carrier.fitScore = Math.max(floor, blended);
            } else {
              carrier.fitScore = blended;
            }
          }
        }
        // Re-sort top-5 after AI score adjustments, then stitch back
        top5.sort((a, b) => b.fitScore - a.fitScore);
        // Re-insert top-5 into the beginning of ranked array
        for (let i = 0; i < top5.length; i++) {
          ranked[i] = top5[i];
        }
      }
    }
  } catch {
    // Silent fallback to rule-based ranking
  }

  return ranked;
}

/**
 * Extracts the count of exact-lane loads for a carrier from the last 3 uploads.
 * Uses both strict equality AND city-prefix matching (consistent with extractCarrierHistoryFromUploads).
 */
function extractExactLaneLoads(uploads: FinancialUpload[], lane: RecurringLane, carrierName: string): number {
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);
  const carrierNorm = normStr(carrierName);
  let count = 0;
  // Sort newest first — scan last 3 uploads (same as extractCarrierHistoryFromUploads)
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      // Use the same field-reading logic as extractCarrierHistoryFromUploads
      const rawOriginCity = readTmsField(row, "shipperCity", "originCity", "Shipper city", "Origin city");
      const rawOriginFull = readTmsField(row, "origin", "Origin");
      const rowOrigin = normStr(rawOriginCity || extractCity(rawOriginFull));

      const rawDestCity = readTmsField(row, "consigneeCity", "destinationCity", "Consignee city", "Destination city");
      const rawDestFull = readTmsField(row, "destination", "Destination");
      const rowDest = normStr(rawDestCity || extractCity(rawDestFull));

      const rawCarrier = readTmsField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
      const rowCarrier = normStr(parseCarrierName(rawCarrier));

      if (rowCarrier !== carrierNorm) continue;
      if (!rowOrigin || !rowDest) continue;

      // Exact city match
      const isExact = rowOrigin === originNorm && rowDest === destNorm;
      if (isExact) {
        count++;
        continue;
      }

      // Prefix match (consistent with extractCarrierHistoryFromUploads)
      const originPrefix = originNorm.slice(0, 4);
      const destPrefix = destNorm.slice(0, 4);
      const isPrefixOrigin = originPrefix.length >= 4 && rowOrigin.length >= 4 &&
        (rowOrigin.includes(originPrefix) || originNorm.includes(rowOrigin.slice(0, 4)));
      const isPrefixDest = destPrefix.length >= 4 && rowDest.length >= 4 &&
        (rowDest.includes(destPrefix) || destNorm.includes(rowDest.slice(0, 4)));

      if (isPrefixOrigin && isPrefixDest) {
        count++;
      }
    }
  }
  return count;
}

function monthDiff(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  const now = new Date();
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}

/**
 * Convert a lastUsedMonth string ("YYYY-MM") to approximate days since last executed load.
 * Treats as the last day of the given month to be conservative.
 */
function daysSinceMonth(monthKey: string | null): number {
  if (!monthKey) return Infinity;
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return Infinity;
  // Use the last day of that month as the estimate (conservative — benefits recent carriers)
  // new Date(y, m, 0) = day 0 of month m → last calendar day of month m-1 (JS zero-indexed months)
  // Example: new Date(2025, 4, 0) = April 30, 2025 ✓
  const lastDay = new Date(y, m, 0);
  // Clamp to 0 — current-month data produces a negative raw value, which is "very recent" = 0 days
  return Math.max(0, Math.floor((Date.now() - lastDay.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Compute a recency decay score based on days since last executed load.
 * 0–30 days: +15 (strong positive)
 * 31–90 days: +10 (moderate positive)
 * 91–180 days: +3 (neutral/small)
 * 181–364 days: -10 (penalty)
 * 365+ days or never: -25 (severe penalty)
 *
 * Returns { score, reason } — reason is null when no load history exists.
 */
function recencyDecayScore(lastUsedMonth: string | null): { score: number; reason: string } {
  const days = daysSinceMonth(lastUsedMonth);
  if (days === Infinity) {
    return { score: -25, reason: "No executed loads on record — shown as fallback" };
  }
  if (days <= 30) return { score: 15, reason: `Last executed load ${days} day${days === 1 ? "" : "s"} ago` };
  if (days <= 90) return { score: 10, reason: `Last executed load ${days} days ago` };
  if (days <= 180) return { score: 3, reason: `Last executed load ${days} days ago` };
  if (days < 365) return { score: -10, reason: `No executed loads in ${days} days — shown as fallback` };
  return { score: -25, reason: `No executed loads in ${days} days — shown as fallback` };
}
