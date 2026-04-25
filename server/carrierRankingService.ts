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
 * V2 adds high-frequency lane ranking path.
 */

import type { RecurringLane, Carrier, FinancialUpload, LaneCarrierInterest, LaneCoverageProfile, LaneCoverageProfileCarrier } from "@shared/schema";
import type { IStorage } from "./storage";
import { COVERAGE_THRESHOLDS, shouldUseIncumbentFirstFlow } from "./laneCoverageService";
import { cityDistanceMiles } from "./cityCoordinates";
import { db } from "./storage";
import { loadFact } from "@shared/schema";
import { and, eq, isNull, ne, or, sql as sqlOp } from "drizzle-orm";
import { findCarrierContactLocks, formatLockReason, type ContactLock } from "./carrierContactLocks";
import { formatLaneDisplay } from "./laneOutreachEmailBuilder";
import { getCarrierLaneOutcomesForLane, carrierLaneOutcomePrior } from "./services/carrierLaneOutcomes";
import { getCarrierOverridesForLane, carrierOverridePrior } from "./services/carrierOverrides";
import { laneSig as buildLaneSig } from "./laneCrossLinkService";

/** Carriers whose historical origin AND destination are within this radius count as "nearby". */
const NEARBY_RADIUS_MILES = 75;

// ── High-Frequency Lane Configuration ─────────────────────────────

/**
 * Central configuration for high-frequency lane detection and ranking.
 *
 * @property minLoadsPerWeek         - Lanes averaging at least this many loads/week qualify as
 *                                     "high-frequency" and receive the HF ranking path.
 *                                     Default 2: empirically, lanes moving freight 2×/week or
 *                                     more have enough history to support fleet-level carrier
 *                                     relationship management.
 *
 * @property frequencyLookbackDays   - How far back to scan TMS uploads when computing HF status
 *                                     from historical rows (used when avgLoadsPerWeek is stale or
 *                                     null). Default 30: one calendar month is the shortest window
 *                                     that captures seasonal variation without being too noisy.
 *
 * @property maxCandidates           - Hard cap on the ranked set size returned by the HF path.
 *                                     Prevents unbounded iteration and keeps API response sizes
 *                                     predictable. Default 30: covers all practical outreach lists
 *                                     while avoiding unnecessary DB round-trips.
 *
 * @property outreachDedupWindowHours - Re-sending outreach to the same carrier within this window
 *                                     is blocked/flagged as a duplicate. Default 48: gives carriers
 *                                     enough time to respond to a first touch before follow-up is
 *                                     permitted.
 *
 * @property hfExactLaneFloorHigh    - Minimum fitScore for carriers with ≥10 exact-lane runs on
 *                                     an HF lane. Default 95: guarantees these proven carriers
 *                                     always rank above any regional-only carrier (regional ceiling
 *                                     is ~70 with all bonuses).
 *
 * @property hfExactLaneFloorMed     - Minimum fitScore for carriers with ≥5 exact-lane runs on
 *                                     an HF lane. Default 85: strong signal without hitting the
 *                                     ≥10-run ceiling; keeps meaningful score differentiation.
 *
 * @property hfExactLaneFloorAny     - Minimum fitScore for carriers with ≥1 exact-lane run on
 *                                     an HF lane. Default 72: always above the regional/nearby
 *                                     ceiling so any lane history beats a pure catalog match.
 *
 * @property marketNbaBoostPoints    - Score boost applied to HF-lane carriers that have an active
 *                                     market NBA (Next Best Action) matching the lane equipment
 *                                     and origin region. Default 8: meaningful tie-breaker without
 *                                     overriding lane-history tier ordering.
 *
 * @property minExactLaneRunsForFloor - Minimum number of exact-lane runs required for an HF carrier
 *                                     to be considered for floor-score application. Default 1:
 *                                     any carrier with at least one confirmed run on this exact
 *                                     lane corridor qualifies for the HF floor guarantee.
 */
export const HIGH_FREQUENCY_CONFIG = {
  minLoadsPerWeek: 2,
  frequencyLookbackDays: 30,
  maxCandidates: 30,
  outreachDedupWindowHours: 48,
  hfExactLaneFloorHigh: 95,
  hfExactLaneFloorMed: 85,
  hfExactLaneFloorAny: 72,
  marketNbaBoostPoints: 8,
  minExactLaneRunsForFloor: 1,
} as const;

/**
 * Configuration for accepted carrier intelligence scoring.
 *
 * Weights are deliberately conservative to preserve the principle that historical
 * executed lane history is the strongest signal. Accepted intel is an additive
 * boost that cannot push a low-history carrier above a carrier with strong
 * exact-lane history.
 *
 * @property acceptedExactLanePreferenceBoost   - Score boost when carrier has an accepted
 *                                               lane_preference suggestion with an exact
 *                                               corridor matching the lane. Default 8.
 * @property acceptedRegionPreferenceBoost      - Score boost when carrier has an accepted
 *                                               region_preference suggestion whose region
 *                                               overlaps the lane origin or dest. Default 4.
 * @property acceptedEquipmentCapabilityBoost   - Score boost when carrier has an accepted
 *                                               equipment_capability suggestion matching
 *                                               the lane equipment type. Default 3.
 * @property acceptedCapacityAvailableBoost     - Score boost for a fresh accepted
 *                                               capacity_available signal. Default 5.
 * @property acceptedCapacityUnavailablePenalty - Score penalty for a fresh accepted
 *                                               capacity_unavailable signal. Default 6.
 * @property acceptedIntelFreshnessDays         - Accepted capacity signals (available /
 *                                               unavailable) are only applied when they
 *                                               were accepted/updated within this window.
 *                                               Stale signals have no effect. Default 21.
 * @property intelCapExactHighLoads            - Minimum exact-lane loads for the "no cap"
 *                                               tier (≥ this → Infinity cap). Default 10.
 * @property intelCapExact                     - Max total positive intel for carriers with
 *                                               some exact-lane history but below the
 *                                               intelCapExactHighLoads threshold. Default 10.
 * @property intelCapNearby                    - Max total positive intel for carriers whose
 *                                               best history match is nearby / state_pair.
 *                                               Default 8.
 * @property intelCapRegionOrNone              - Max total positive intel for carriers with
 *                                               only region-level or no history. Default 6.
 */
export const ACCEPTED_INTEL_CONFIG = {
  acceptedExactLanePreferenceBoost: 8,
  acceptedRegionPreferenceBoost: 4,
  acceptedEquipmentCapabilityBoost: 3,
  acceptedCapacityAvailableBoost: 5,
  acceptedCapacityUnavailablePenalty: 6,
  acceptedIntelFreshnessDays: 21,
  /** Minimum exact-lane loads for uncapped intel contribution. */
  intelCapExactHighLoads: 10,
  /** Max positive intel contribution for exact-history carriers below the high-loads threshold. */
  intelCapExact: 10,
  /** Max positive intel contribution for nearby / state_pair history carriers. */
  intelCapNearby: 8,
  /** Max positive intel contribution for region-level or no-history carriers. */
  intelCapRegionOrNone: 6,
  /**
   * Score boost when a carrier has an accepted lane_preference whose corridor matches
   * only at the region/state level (not an exact city-to-city match).
   * Treated as a partial region boost — deliberately lower than acceptedRegionPreferenceBoost.
   */
  acceptedLaneRegionFallbackBoost: 2,
} as const;

/** @deprecated Use HIGH_FREQUENCY_CONFIG.hfExactLaneFloorHigh */
export const HF_EXACT_FLOOR_HIGH = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorHigh;
/** @deprecated Use HIGH_FREQUENCY_CONFIG.hfExactLaneFloorMed */
export const HF_EXACT_FLOOR_MED  = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorMed;
/** @deprecated Use HIGH_FREQUENCY_CONFIG.hfExactLaneFloorAny */
export const HF_EXACT_FLOOR_ANY  = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorAny;

const HF_MARKET_NBA_BOOST = HIGH_FREQUENCY_CONFIG.marketNbaBoostPoints;

/**
 * Canonical HF detector — determines whether a lane qualifies as high-frequency.
 *
 * Uses two complementary signals (either is sufficient):
 *   1. lane.avgLoadsPerWeek — stored value pre-computed by the capacity engine (fast path)
 *   2. TMS upload scan — counts exact-lane rows within frequencyLookbackDays from the
 *      most recent uploads, divided by weeks-in-window (accurate when avg is stale/null)
 *
 * Pass `uploads` wherever upload data is already available to enable the historical path.
 * When omitted, the function falls back to avgLoadsPerWeek only (safe default).
 */
export function isHighFrequencyLane(
  lane: Pick<RecurringLane, "avgLoadsPerWeek" | "origin" | "destination">,
  uploads?: FinancialUpload[],
): boolean {
  const minLoads = HIGH_FREQUENCY_CONFIG.minLoadsPerWeek;
  // Fast path: stored avgLoadsPerWeek
  const val = lane.avgLoadsPerWeek;
  if (val !== null && val !== undefined) {
    const n = typeof val === "number" ? val : parseFloat(String(val));
    if (!isNaN(n) && n >= minLoads) return true;
  }
  // Historical path: scan TMS rows within the lookback window
  if (uploads && uploads.length > 0) {
    return computeHfFromUploads(uploads, lane as RecurringLane);
  }
  return false;
}

/**
 * Pre-index TMS uploads into a Map<"origin|dest", count> for O(1) HF lookups.
 *
 * This replaces the per-lane O(rows) scan in computeHfFromUploads with a single
 * O(rows) build pass, reducing work-queue cost from O(lanes × rows) → O(rows + lanes).
 *
 * Use isHighFrequencyLaneFromIndex() to query the index.
 */
export function buildHighFrequencyIndex(uploads: FinancialUpload[]): Map<string, number> {
  const lookbackMs = HIGH_FREQUENCY_CONFIG.frequencyLookbackDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(Date.now() - lookbackMs);
  const cutoffMonth = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;

  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const index = new Map<string, number>();

  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      const rawMonth = readTmsField(row, "Month", "month");
      const month = normalizeTmsMonth(rawMonth);
      if (!month || month < cutoffMonth) continue;

      const rawOriginCity = readTmsField(row, "Origin", "shipperCity", "Shipper city", "Origin city");
      const rowOrigin = (rawOriginCity ?? "").toString().trim().toLowerCase();
      const rawDestCity = readTmsField(row, "Destination", "consigneeCity", "Consignee city", "Destination city");
      const rowDest = (rawDestCity ?? "").toString().trim().toLowerCase();

      if (!rowOrigin || !rowDest) continue;
      const key = `${rowOrigin}|${rowDest}`;
      index.set(key, (index.get(key) ?? 0) + 1);
    }
  }

  return index;
}

/**
 * O(1) HF check using a pre-built index from buildHighFrequencyIndex().
 * Prefer this over isHighFrequencyLane() when processing many lanes at once.
 */
export function isHighFrequencyLaneFromIndex(
  lane: Pick<RecurringLane, "avgLoadsPerWeek" | "origin" | "destination">,
  hfIndex: Map<string, number>,
): boolean {
  const minLoads = HIGH_FREQUENCY_CONFIG.minLoadsPerWeek;
  const val = lane.avgLoadsPerWeek;
  if (val !== null && val !== undefined) {
    const n = typeof val === "number" ? val : parseFloat(String(val));
    if (!isNaN(n) && n >= minLoads) return true;
  }
  const originNorm = (lane.origin ?? "").toString().trim().toLowerCase();
  const destNorm = (lane.destination ?? "").toString().trim().toLowerCase();
  const key = `${originNorm}|${destNorm}`;
  const count = hfIndex.get(key) ?? 0;
  const weeksInWindow = HIGH_FREQUENCY_CONFIG.frequencyLookbackDays / 7;
  return (count / weeksInWindow) >= minLoads;
}

// ── Carrier Fit Explanation ───────────────────────────────

/**
 * Structured explanation of why a carrier is recommended for a lane.
 * Returned as part of the ranked carrier entry for high-frequency lanes.
 */
export interface CarrierFitExplanation {
  exactLaneHistory: {
    runCount: number;
    lastRunDate: string | null;
  };
  regionalHistory: {
    runCount: number; // nearby + state-pair loads
  };
  customerHistory: {
    hasHistory: boolean;
    runCount: number;
  };
  outreachHistory: {
    lastStatus: string | null;
    lastDate: string | null;
  };
  fitSignals: {
    regionEquipmentFitScore: number;
    laneHistoryScore: number;
    customerHistoryScore: number;
    hasMarketNbaBoost: boolean;
  };
  /**
   * Human-readable phrases derived from accepted carrier intelligence.
   * Each phrase clearly identifies it as a declared preference, not historical execution.
   * E.g. "Accepted preference: Phoenix → Kent, Dry Van"
   * Only populated when accepted intel is present.
   */
  acceptedIntelPhrases?: string[];
}

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

/**
 * Raw sub-score breakdown for a single carrier on a single lane.
 * Populated only when the carrier-suggestions endpoint is called with ?debug=true.
 * Never emitted on normal requests (omit-entirely by design).
 */
export interface CarrierDebugScores {
  /** Score contribution from exact city-pair lane history (0 if none) */
  exactLaneScore: number;
  /** Score contribution from nearby-lane history (0 if none) */
  regionalScore: number;
  /** Score contribution from customer-history signal */
  customerHistoryScore: number;
  /** Score delta from outreach-recency decay (may be negative) */
  outreachRecencyDelta: number;
  /** Score boost from market NBA match (0 if none) */
  marketNbaBoost: number;
  /** HF floor score applied (0 if not an HF lane or carrier has no exact-lane runs) */
  hfFloorApplied: number;
  /** Whether a HF floor or boost was applied to this carrier */
  hfAdjustmentApplied: boolean;
  /** Final fitScore after all adjustments */
  finalScore: number;
  // ── Accepted-Intel sub-scores (Task #196) ────────────────────────────────
  /** Boost from an accepted exact lane_preference corridor match (0 if none) */
  acceptedLanePreferenceScore: number;
  /** Boost from an accepted region_preference overlapping lane origin/dest (0 if none) */
  acceptedRegionPreferenceScore: number;
  /** Boost from an accepted equipment_capability matching lane equipment (0 if none) */
  acceptedEquipmentCapabilityScore: number;
  /** Boost from a fresh accepted capacity_available signal (0 if none or stale) */
  acceptedCapacityAvailabilityScore: number;
  /** Penalty from a fresh accepted capacity_unavailable signal (0 if none or stale) */
  acceptedCapacitySuppressionPenalty: number;
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
  /**
   * Governing history tier for this carrier on this lane.
   *   exact      — has loads on this exact city pair
   *   nearby     — has loads where both endpoints are within NEARBY_RADIUS_MILES of requested lane
   *   state_pair — has loads on the same origin-state → dest-state corridor (different cities)
   *   region     — no company history; appears due to catalog region/equipment fit
   *   none       — no matching signals at all
   */
  historyMatch: "exact" | "nearby" | "state_pair" | "region" | "none";
  loadsOnLane: number;
  lastUsedMonth: string | null;
  isNewProspect: boolean;
  estimatedOnTimePct: number | null;   // derived from financial row on-time field if available
  marginContribution: number | null;   // derived from financial rows margin field if available
  customerHistoryLoads: number;        // loads this carrier hauled for the same customer
  priorOutcomeBoost: boolean;          // true if prior bench outcome was positive (available_now/next_week)
  // ── Bench tier-0 (Task #632) ──────────────────────────────────────────────
  /**
   * True when this carrier has at least one positive bench outcome
   * (available_now / available_next_week) on this lane in the last 90 days.
   * Carriers flagged `bench` are eligible for tier-0 placement (above `exact`)
   * up to BENCH_TIER0_CAP. Survives JSON wire transfer to AF cockpit + LWQ.
   */
  bench: boolean;
  /** Count of positive bench outcomes on this lane in the last 90d. */
  benchWins: number;
  /**
   * Task #633 — Plain-language reasons this carrier was ranked, ordered by
   * importance. Capped at REASONS_DISPLAY_CAP entries. Drives the
   * "why this carrier" hover popover in LWQ + Available Freight.
   *
   * Suppression notes live separately in `suppressionReasons` so the popover
   * can render them at the top with muted styling.
   */
  reasons: string[];
  sourceChannel: string | null;        // where this carrier was originally sourced from
  suppressionReasons: string[];        // human-readable negative flags (no email, recently contacted, flagged, etc.)
  equipmentMatch: boolean;             // carrier equipment overlaps with lane equipment
  regionMatch: boolean;                // carrier regions overlap with lane origin/dest
  isIncumbent: boolean;                // true if this carrier is an incumbent for a stable lane
  incumbentRank: number | null;        // 1-based rank among incumbents (null if not incumbent)
  isDoNotUse: boolean;                 // true if carrier status is do_not_use or tags include do_not_use/no_use
  // ── Ranking transparency ──────────────────────────────────────────────────
  exactLaneLoads: number;              // loads on exact city pair
  nearbyLaneLoads: number;             // loads within NEARBY_RADIUS_MILES of both lane endpoints
  statePairLoads: number;              // loads on same state-to-state corridor
  hasAnyCompanyHistory: boolean;       // true if carrier has ANY loads in our TMS data
  hqCity: string | null;              // carrier's HQ city (from Carrier Hub profile)
  hqState: string | null;             // carrier's HQ state (from Carrier Hub profile)
  hqProximityBonus: number;           // points added for HQ proximity to lane endpoints
  // ── High-frequency lane fields ────────────────────────────────
  hasMarketNbaBoost: boolean;         // true when carrier received +8 boost from market NBA match
  carrierFitExplanation?: CarrierFitExplanation; // structured explanation (populated for HF lanes)
  // ── Accepted-intel signals (Task #196) ─────────────────────────────────────
  acceptedIntelPhrases?: string[];    // human-readable phrases from accepted suggestions
  cautionFlags?: {                    // caution signals from accepted intel
    hasAcceptedCapacityUnavailable: boolean;
    hasAcceptedServiceRisk: boolean;
    hasAcceptedPriceSensitivity: boolean;
  };
  // ── Debug instrumentation (only populated when debug=true requested) ────────
  debugScores?: CarrierDebugScores;
}

function normStr(s: string): string {
  return (s ?? "").toString().trim().toLowerCase();
}

/**
 * Task #632 — Bench tier-0 selection helpers (exported for tests).
 *
 * `computeBenchTier0Keys` selects up to BENCH_TIER0_CAP carriers from a
 * RankedCarrier array — the ones with `bench=true`, ordered by
 * (benchWins desc, fitScore desc) — and returns the set of stable keys
 * the rank-time sort comparator uses to decide who gets tier-0 placement.
 *
 * Kept separate from the inline sort so unit tests can validate
 * "1 bench win on a `region` carrier outranks an `exact` carrier with 0
 *  bench wins" without spinning up the full ranker pipeline.
 */
export const BENCH_TIER0_CAP = 5;

/**
 * Task #633 — Cap on the number of plain-language reasons we surface on the
 * "why this carrier" hover popover. We over-collect reasons inside the ranker
 * (one per scoring signal) but the UI tooltip stays scannable when bounded.
 */
export const REASONS_DISPLAY_CAP = 8;

/**
 * Task #633 — Build the final ordered `reasons[]` exposed on RankedCarrier.
 *
 * Bench wins are the strongest possible signal (they outrank `exact` history
 * in the comparator), so they go on top. Everything else preserves the
 * ranker's natural authoring order, which already runs from history quality
 * → fit signals → bonuses, and we cap at REASONS_DISPLAY_CAP for the UI.
 */
export function buildRankReasons(
  rawReasons: string[],
  benchWins: number,
): string[] {
  const out: string[] = [];
  if (benchWins > 0) {
    out.push(`Bench: ${benchWins} win${benchWins === 1 ? "" : "s"} (last 90d)`);
  }
  for (const raw of rawReasons) {
    if (out.length >= REASONS_DISPLAY_CAP) break;
    if (!raw) continue;
    // Trim each reason to suppress whitespace-only entries that would render
    // as a blank bullet in the popover. We re-emit the trimmed copy so the UI
    // never has to defensively trim again.
    const trimmed = raw.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

export function benchTier0KeyFor(c: Pick<RankedCarrier, "carrierId" | "carrierName">): string {
  return c.carrierId ?? `name:${normStr(c.carrierName)}`;
}

export function computeBenchTier0Keys(carriers: RankedCarrier[]): Set<string> {
  return new Set<string>(
    carriers
      .filter(c => c.bench)
      .sort((a, b) => {
        const winsDiff = b.benchWins - a.benchWins;
        if (winsDiff !== 0) return winsDiff;
        return b.fitScore - a.fitScore;
      })
      .slice(0, BENCH_TIER0_CAP)
      .map(benchTier0KeyFor),
  );
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
  loads: number;               // total matched loads (any tier)
  exactLoads: number;          // loads on the exact city pair
  nearbyLoads: number;         // loads where both ends are within NEARBY_RADIUS_MILES
  statePairLoads: number;      // loads on same origin-state → dest-state (different cities)
  lastUsedMonth: string | null;
  /** Average on-time percentage from financial rows (if present) */
  avgOnTimePct: number | null;
  /** Total margin contribution from financial rows (if present) */
  totalMargin: number | null;
  marginRowCount: number;
  /** Best match tier across all matched rows — drives score differentiation */
  bestMatchTier: "exact" | "nearby" | "state_pair";
}

function extractCarrierHistoryFromUploads(
  uploads: FinancialUpload[],
  lane: RecurringLane,
): Map<string, CarrierHistory> {
  const history = new Map<string, CarrierHistory>();
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);

  // State-pair: same origin-state → dest-state corridor
  const laneOrigStateLower = normStr(lane.originState ?? "");
  const laneDestStateLower = normStr(lane.destinationState ?? "");

  // Pre-resolve lane endpoint coordinates once (used for all nearby checks)
  // lane.origin may be "phoenix, az" or "Phoenix, AZ" — getCityCoords handles both
  const laneOriginCityState = lane.origin;        // already "city, st" format
  const laneDestCityState = lane.destination;     // already "city, st" format

  // Sort uploads newest first (scan last 3)
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      // ── Field extraction (title-case TMS and camelCase legacy) ─────────────
      const rawOriginCity = readTmsField(row, "shipperCity", "originCity", "Shipper city", "Origin city");
      const rawOriginFull = readTmsField(row, "origin", "Origin");
      const rowOrigin = normStr(rawOriginCity || extractCity(rawOriginFull));

      const rawDestCity = readTmsField(row, "consigneeCity", "destinationCity", "Consignee city", "Destination city");
      const rawDestFull = readTmsField(row, "destination", "Destination");
      const rowDest = normStr(rawDestCity || extractCity(rawDestFull));

      const rowOriginState = normStr(readTmsField(row, "shipperState", "originState", "Shipper state", "Origin state"));
      const rowDestState = normStr(readTmsField(row, "consigneeState", "destinationState", "destState", "Consignee state", "Destination state"));

      const rawCarrierField = readTmsField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
      const carrierRaw = normStr(parseCarrierName(rawCarrierField));

      const rawMonth = readTmsField(row, "month", "Month");
      const month = normalizeTmsMonth(rawMonth);

      const onTimeRaw = readTmsField(row, "onTimePct", "on_time_pct", "On-time %", "On time pct");
      const onTimeParsed = onTimeRaw ? parseFloat(onTimeRaw) : NaN;
      const marginRaw = readTmsField(row, "margin", "marginPct", "Margin $", "Margin %");
      const marginParsed = marginRaw ? parseFloat(marginRaw) : NaN;

      if (!carrierRaw || !rowOrigin || !rowDest) continue;

      // ── Tier 1: Exact city-pair match ──────────────────────────────────────
      const isExact = rowOrigin === originNorm && rowDest === destNorm;

      // ── Tier 2: Nearby — both endpoints within NEARBY_RADIUS_MILES ─────────
      // Construct a "city, state" string for geo lookup from row data
      let isNearby = false;
      if (!isExact) {
        const rowOriginForGeo = rawOriginFull ||
          (rawOriginCity && rowOriginState ? `${rawOriginCity}, ${rowOriginState}` : rawOriginCity);
        const rowDestForGeo = rawDestFull ||
          (rawDestCity && rowDestState ? `${rawDestCity}, ${rowDestState}` : rawDestCity);

        if (rowOriginForGeo && rowDestForGeo) {
          const originDist = cityDistanceMiles(rowOriginForGeo, laneOriginCityState);
          const destDist = cityDistanceMiles(rowDestForGeo, laneDestCityState);
          isNearby = originDist !== null && destDist !== null &&
            originDist <= NEARBY_RADIUS_MILES && destDist <= NEARBY_RADIUS_MILES;
        }
      }

      // ── Tier 3: Same state-pair corridor ────────────────────────────────────
      const isStatePairMatch =
        laneOrigStateLower.length >= 2 && laneDestStateLower.length >= 2 &&
        rowOriginState.length >= 2 && rowDestState.length >= 2 &&
        rowOriginState === laneOrigStateLower && rowDestState === laneDestStateLower;

      if (!isExact && !isNearby && !isStatePairMatch) continue;

      const thisTier: CarrierHistory["bestMatchTier"] =
        isExact ? "exact" : isNearby ? "nearby" : "state_pair";

      const existing = history.get(carrierRaw) ?? {
        loads: 0, exactLoads: 0, nearbyLoads: 0, statePairLoads: 0,
        lastUsedMonth: null, avgOnTimePct: null, totalMargin: null,
        marginRowCount: 0, bestMatchTier: thisTier,
      };

      // Upgrade stored tier if this row is a better match (exact > nearby > state_pair)
      const tierRank = { exact: 0, nearby: 1, state_pair: 2 } as const;
      const betterTier = tierRank[thisTier] < tierRank[existing.bestMatchTier]
        ? thisTier
        : existing.bestMatchTier;

      history.set(carrierRaw, {
        loads: existing.loads + 1,
        exactLoads:     existing.exactLoads     + (isExact ? 1 : 0),
        nearbyLoads:    existing.nearbyLoads    + (isNearby && !isExact ? 1 : 0),
        statePairLoads: existing.statePairLoads + (isStatePairMatch && !isExact && !isNearby ? 1 : 0),
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
 * Extract carrier history from `load_fact` rows for a given lane.
 *
 * Mirrors the logic of `extractCarrierHistoryFromUploads` so the ranker can
 * blend both data sources. Critical for orgs whose freight history lives in
 * load_fact (Available Freight imports, TMS replays) rather than in
 * `financial_uploads` — without this path, lanes the org runs every week
 * surface zero carriers because the ranker never saw the history.
 *
 * Org-scoped, excludes cancelled / expired rows. Tier classification
 * (exact > nearby > state-pair) uses the same `cityDistanceMiles` and
 * `NEARBY_RADIUS_MILES` thresholds the upload extractor uses.
 */
export async function extractCarrierHistoryFromLoadFact(
  orgId: string,
  lane: RecurringLane,
): Promise<Map<string, CarrierHistory>> {
  const history = new Map<string, CarrierHistory>();
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);
  const laneOrigStateLower = normStr(lane.originState ?? "");
  const laneDestStateLower = normStr(lane.destinationState ?? "");
  const laneOriginCityState = lane.origin;
  const laneDestCityState = lane.destination;

  let rows: Array<{
    carrierName: string | null;
    originCity: string | null;
    originState: string | null;
    destinationCity: string | null;
    destinationState: string | null;
    month: string | null;
    pickupDate: string | null;
  }>;
  try {
    rows = await db
      .select({
        carrierName: loadFact.carrierName,
        originCity: loadFact.originCity,
        originState: loadFact.originState,
        destinationCity: loadFact.destinationCity,
        destinationState: loadFact.destinationState,
        month: loadFact.month,
        pickupDate: loadFact.pickupDate,
      })
      .from(loadFact)
      .where(and(
        eq(loadFact.orgId, orgId),
        isNull(loadFact.expiredAt),
        ne(loadFact.bucket, "cancelled"),
        sqlOp`${loadFact.carrierName} IS NOT NULL AND length(trim(${loadFact.carrierName})) > 0`,
        // Pre-filter to relevant rows: same state-pair OR same exact city-pair.
        // Nearby-but-cross-state is rare enough to accept the trade-off vs the
        // cost of pulling every org row into memory on every rank call.
        or(
          and(
            sqlOp`lower(${loadFact.originCity}) = ${originNorm}`,
            sqlOp`lower(${loadFact.destinationCity}) = ${destNorm}`,
          ),
          laneOrigStateLower && laneDestStateLower
            ? and(
                sqlOp`lower(${loadFact.originState}) = ${laneOrigStateLower}`,
                sqlOp`lower(${loadFact.destinationState}) = ${laneDestStateLower}`,
              )
            : sqlOp`false`,
        ),
      ));
  } catch (e) {
    // Best-effort — never fail ranking because of a load_fact lookup.
    console.warn(`[ranker] load_fact history lookup failed for lane ${lane.id}:`, (e as Error)?.message ?? e);
    return history;
  }

  for (const row of rows) {
    const carrierRaw = normStr(parseCarrierName(row.carrierName ?? ""));
    if (!carrierRaw) continue;
    const rowOrigin = normStr(row.originCity ?? "");
    const rowDest = normStr(row.destinationCity ?? "");
    const rowOriginState = normStr(row.originState ?? "");
    const rowDestState = normStr(row.destinationState ?? "");
    if (!rowOrigin || !rowDest) continue;

    const isExact = rowOrigin === originNorm && rowDest === destNorm;

    let isNearby = false;
    if (!isExact && row.originCity && row.destinationCity) {
      const rowOriginForGeo = rowOriginState
        ? `${row.originCity}, ${rowOriginState}`
        : row.originCity;
      const rowDestForGeo = rowDestState
        ? `${row.destinationCity}, ${rowDestState}`
        : row.destinationCity;
      const originDist = cityDistanceMiles(rowOriginForGeo, laneOriginCityState);
      const destDist = cityDistanceMiles(rowDestForGeo, laneDestCityState);
      isNearby = originDist !== null && destDist !== null
        && originDist <= NEARBY_RADIUS_MILES && destDist <= NEARBY_RADIUS_MILES;
    }

    const isStatePairMatch =
      laneOrigStateLower.length >= 2 && laneDestStateLower.length >= 2 &&
      rowOriginState.length >= 2 && rowDestState.length >= 2 &&
      rowOriginState === laneOrigStateLower && rowDestState === laneDestStateLower;

    if (!isExact && !isNearby && !isStatePairMatch) continue;

    // load_fact stores month as YYYY-MM directly when available; fall back to
    // pickup_date's first 7 chars (YYYY-MM-DD → YYYY-MM) so old rows without
    // month still contribute a recency signal.
    const month = row.month && /^\d{4}-\d{2}/.test(row.month)
      ? row.month.slice(0, 7)
      : (row.pickupDate ?? "").slice(0, 7);

    const thisTier: CarrierHistory["bestMatchTier"] =
      isExact ? "exact" : isNearby ? "nearby" : "state_pair";

    const existing = history.get(carrierRaw) ?? {
      loads: 0, exactLoads: 0, nearbyLoads: 0, statePairLoads: 0,
      lastUsedMonth: null, avgOnTimePct: null, totalMargin: null,
      marginRowCount: 0, bestMatchTier: thisTier,
    };
    const tierRank = { exact: 0, nearby: 1, state_pair: 2 } as const;
    const betterTier = tierRank[thisTier] < tierRank[existing.bestMatchTier]
      ? thisTier
      : existing.bestMatchTier;

    history.set(carrierRaw, {
      loads: existing.loads + 1,
      exactLoads:     existing.exactLoads     + (isExact ? 1 : 0),
      nearbyLoads:    existing.nearbyLoads    + (isNearby && !isExact ? 1 : 0),
      statePairLoads: existing.statePairLoads + (isStatePairMatch && !isExact && !isNearby ? 1 : 0),
      lastUsedMonth: month && month > (existing.lastUsedMonth ?? "") ? month : existing.lastUsedMonth,
      // load_fact does not carry on-time / margin per row in a clean enough
      // shape to blend with the financial-upload signal. Leave nulls — the
      // upload extractor will populate them when it has them.
      avgOnTimePct: existing.avgOnTimePct,
      totalMargin: existing.totalMargin,
      marginRowCount: existing.marginRowCount,
      bestMatchTier: betterTier,
    });
  }

  return history;
}

/**
 * Combine two CarrierHistory maps (e.g. financial_uploads + load_fact) into a
 * single map keyed by normalized carrier name. Loads are summed per tier;
 * lastUsedMonth keeps the more recent value; bestMatchTier promotes to the
 * better of the two; avgOnTimePct / totalMargin prefer the side that actually
 * has signal (load_fact contributes nulls there today).
 */
export function mergeHistoryMaps(
  a: Map<string, CarrierHistory>,
  b: Map<string, CarrierHistory>,
): Map<string, CarrierHistory> {
  const out = new Map<string, CarrierHistory>(a);
  const tierRank = { exact: 0, nearby: 1, state_pair: 2 } as const;
  for (const [key, hb] of b) {
    const ha = out.get(key);
    if (!ha) { out.set(key, hb); continue; }
    const mergedTier = tierRank[hb.bestMatchTier] < tierRank[ha.bestMatchTier]
      ? hb.bestMatchTier
      : ha.bestMatchTier;
    const onTime = ha.avgOnTimePct != null && hb.avgOnTimePct != null
      ? ((ha.avgOnTimePct * ha.loads) + (hb.avgOnTimePct * hb.loads)) / (ha.loads + hb.loads)
      : (ha.avgOnTimePct ?? hb.avgOnTimePct);
    out.set(key, {
      loads:          ha.loads + hb.loads,
      exactLoads:     ha.exactLoads + hb.exactLoads,
      nearbyLoads:    ha.nearbyLoads + hb.nearbyLoads,
      statePairLoads: ha.statePairLoads + hb.statePairLoads,
      lastUsedMonth: (hb.lastUsedMonth ?? "") > (ha.lastUsedMonth ?? "")
        ? hb.lastUsedMonth : ha.lastUsedMonth,
      avgOnTimePct: onTime,
      totalMargin: (ha.totalMargin ?? 0) + (hb.totalMargin ?? 0) || null,
      marginRowCount: ha.marginRowCount + hb.marginRowCount,
      bestMatchTier: mergedTier,
    });
  }
  return out;
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

// ── Accepted-Intel Helpers (Task #196) ─────────────────────────────────────

/**
 * Whether an accepted suggestion was accepted/updated within the freshness window.
 * Uses acceptedAt when available, falls back to updatedAt, then createdAt.
 */
function isAcceptedIntelFresh(
  suggestion: import('@shared/schema').CarrierIntelSuggestion,
  freshnessDays: number,
): boolean {
  const ts = suggestion.acceptedAt ?? suggestion.updatedAt ?? suggestion.createdAt;
  if (!ts) return false;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs <= freshnessDays * 24 * 60 * 60 * 1000;
}

/**
 * Check if an accepted lane_preference suggestion's origin/destination matches
 * the lane using normalized city and/or state comparison.
 * Returns "exact" when the suggestion specifies both origin+destination and both match,
 * "region" when only origin or destination (state) matches, or "none" when no match.
 */
function matchAcceptedLanePreference(
  payload: Record<string, unknown>,
  laneOriginNorm: string,
  laneDestNorm: string,
  laneOriginStateNorm: string,
  laneDestStateNorm: string,
): "exact" | "region" | "none" {
  const origin = normStr(String(payload.origin ?? payload.originState ?? ""));
  const dest = normStr(String(payload.destination ?? payload.destState ?? ""));
  const originState = normStr(String(payload.originState ?? ""));
  const destState = normStr(String(payload.destState ?? ""));

  if (!origin && !dest && !originState && !destState) return "none";

  const originMatch = origin && (
    laneOriginNorm.includes(origin) || origin.includes(laneOriginNorm)
  );
  const destMatch = dest && (
    laneDestNorm.includes(dest) || dest.includes(laneDestNorm)
  );
  const originStateMatch = originState && laneOriginStateNorm === originState;
  const destStateMatch = destState && laneDestStateNorm === destState;

  // Exact: both origin and destination are specified and match
  const hasOriginSignal = originMatch || originStateMatch;
  const hasDestSignal = destMatch || destStateMatch;

  const bothSpecified = (origin || originState) && (dest || destState);
  if (bothSpecified && hasOriginSignal && hasDestSignal) return "exact";

  // Region: at least one side matches
  if (hasOriginSignal || hasDestSignal) return "region";

  return "none";
}

/**
 * Check if an accepted region_preference suggestion overlaps the lane origin or dest state.
 */
function matchAcceptedRegionPreference(
  payload: Record<string, unknown>,
  laneOriginNorm: string,
  laneDestNorm: string,
  laneOriginStateNorm: string,
  laneDestStateNorm: string,
): boolean {
  const region = normStr(String(payload.region ?? payload.state ?? ""));
  const originState = normStr(String(payload.originState ?? ""));
  const destState = normStr(String(payload.destState ?? ""));

  // Try all geo terms in the suggestion against all lane geo terms
  const laneGeoTerms = [laneOriginNorm, laneDestNorm, laneOriginStateNorm, laneDestStateNorm]
    .filter(Boolean);
  const suggGeoTerms = [region, originState, destState].filter(Boolean);

  if (suggGeoTerms.length === 0) return false;

  return suggGeoTerms.some(sg =>
    laneGeoTerms.some(lg => sg.includes(lg) || lg.includes(sg))
  );
}

/**
 * Check if an accepted equipment_capability suggestion matches the lane equipment type.
 */
function matchAcceptedEquipmentCapability(
  payload: Record<string, unknown>,
  laneEquipNorm: string,
): boolean {
  if (!laneEquipNorm) return false;
  const equipment = normStr(String(payload.equipment ?? payload.equipmentType ?? ""));
  if (!equipment) return false;
  return equipment.includes(laneEquipNorm) || laneEquipNorm.includes(equipment);
}

/**
 * Accepted-intel carrier type for batch fetching.
 */
interface CarrierAcceptedIntel {
  lanePrefs: import('@shared/schema').CarrierIntelSuggestion[];
  regionPrefs: import('@shared/schema').CarrierIntelSuggestion[];
  equipCaps: import('@shared/schema').CarrierIntelSuggestion[];
  capacitySignals: import('@shared/schema').CarrierIntelSuggestion[];
  cautionFlags: import('@shared/schema').CarrierIntelSuggestion[];
}

/**
 * Compute the five accepted-intel sub-scores for a carrier on a lane.
 * Returns scores and human-readable phrases.
 * Enforces signal hierarchy: accepted intel cannot push a low-history carrier above
 * a carrier with strong exact-lane history (see maxIntelContribution below).
 */
function computeAcceptedIntelScores(
  intel: CarrierAcceptedIntel,
  laneOriginNorm: string,
  laneDestNorm: string,
  laneOriginStateNorm: string,
  laneDestStateNorm: string,
  laneEquipNorm: string,
  historyMatch: RankedCarrier["historyMatch"],
  exactLaneLoads: number,
): {
  lanePreferenceScore: number;
  regionPreferenceScore: number;
  equipmentCapabilityScore: number;
  capacityAvailabilityScore: number;
  capacitySuppressionPenalty: number;
  phrases: string[];
} {
  const cfg = ACCEPTED_INTEL_CONFIG;
  const freshnessDays = cfg.acceptedIntelFreshnessDays;

  let lanePreferenceScore = 0;
  let regionPreferenceScore = 0;
  let equipmentCapabilityScore = 0;
  let capacityAvailabilityScore = 0;
  let capacitySuppressionPenalty = 0;
  const phrases: string[] = [];

  // ── Lane preference boosts ──────────────────────────────────────────────
  for (const pref of intel.lanePrefs) {
    const payload = (pref.payload ?? {}) as Record<string, unknown>;
    const match = matchAcceptedLanePreference(
      payload, laneOriginNorm, laneDestNorm, laneOriginStateNorm, laneDestStateNorm
    );
    if (match === "exact" && lanePreferenceScore === 0) {
      lanePreferenceScore = cfg.acceptedExactLanePreferenceBoost;
      const origin = String(payload.origin ?? payload.originState ?? laneOriginNorm);
      const dest = String(payload.destination ?? payload.destState ?? laneDestNorm);
      const equip = payload.equipment ? `, ${String(payload.equipment)}` : "";
      phrases.push(`Accepted preference: ${origin} → ${dest}${equip}`);
    } else if (match === "region" && lanePreferenceScore === 0 && regionPreferenceScore === 0) {
      // Region-level lane pref still counts as a smaller region boost
      regionPreferenceScore = Math.max(regionPreferenceScore, cfg.acceptedLaneRegionFallbackBoost);
    }
  }

  // ── Region preference boosts ────────────────────────────────────────────
  for (const pref of intel.regionPrefs) {
    const payload = (pref.payload ?? {}) as Record<string, unknown>;
    if (matchAcceptedRegionPreference(
      payload, laneOriginNorm, laneDestNorm, laneOriginStateNorm, laneDestStateNorm
    )) {
      if (regionPreferenceScore === 0) {
        regionPreferenceScore = cfg.acceptedRegionPreferenceBoost;
        const region = String(payload.region ?? payload.state ?? payload.originState ?? "this region");
        phrases.push(`Accepted region preference: ${region}`);
      }
      break;
    }
  }

  // ── Equipment capability boost ──────────────────────────────────────────
  for (const cap of intel.equipCaps) {
    const payload = (cap.payload ?? {}) as Record<string, unknown>;
    if (matchAcceptedEquipmentCapability(payload, laneEquipNorm)) {
      if (equipmentCapabilityScore === 0) {
        equipmentCapabilityScore = cfg.acceptedEquipmentCapabilityBoost;
        const equip = String(payload.equipment ?? payload.equipmentType ?? laneEquipNorm);
        phrases.push(`Accepted equipment capability: ${equip}`);
      }
      break;
    }
  }

  // ── Capacity signals (freshness-gated) ──────────────────────────────────
  // Both capacity_available and capacity_unavailable are evaluated independently
  // in a single pass — no early break — so that a fresh capacity_unavailable
  // always applies its penalty even when a capacity_available also exists.
  for (const sig of intel.capacitySignals) {
    const fresh = isAcceptedIntelFresh(sig, freshnessDays);
    if (!fresh) continue;

    if (sig.suggestionType === "capacity_available" && capacityAvailabilityScore === 0) {
      capacityAvailabilityScore = cfg.acceptedCapacityAvailableBoost;
      phrases.push("Accepted capacity available signal");
      // Do NOT break — continue scanning for capacity_unavailable
    } else if (sig.suggestionType === "capacity_unavailable" && capacitySuppressionPenalty === 0) {
      capacitySuppressionPenalty = cfg.acceptedCapacityUnavailablePenalty;
      phrases.push("Accepted capacity unavailable signal");
    }
    // Stop once both have been found (optimization)
    if (capacityAvailabilityScore > 0 && capacitySuppressionPenalty > 0) break;
  }

  // ── Signal hierarchy cap ─────────────────────────────────────────────────
  // Accepted intel cannot push a low-history carrier above a carrier with strong
  // exact-lane history. The ceiling for accepted-intel contribution depends on
  // the carrier's actual lane history tier (thresholds in ACCEPTED_INTEL_CONFIG):
  //   exact (≥ intelCapExactHighLoads loads): no cap — intel is additive to already-strong score
  //   exact (< intelCapExactHighLoads loads): cap total positive intel at intelCapExact
  //   nearby/state_pair: cap total positive intel at intelCapNearby
  //   region/none: cap total positive intel at intelCapRegionOrNone
  let maxPositiveIntel: number;
  if (historyMatch === "exact" && exactLaneLoads >= cfg.intelCapExactHighLoads) {
    maxPositiveIntel = Infinity; // already strong; no cap
  } else if (historyMatch === "exact") {
    maxPositiveIntel = cfg.intelCapExact;
  } else if (historyMatch === "nearby" || historyMatch === "state_pair") {
    maxPositiveIntel = cfg.intelCapNearby;
  } else {
    maxPositiveIntel = cfg.intelCapRegionOrNone;
  }

  const totalPositive = lanePreferenceScore + regionPreferenceScore + equipmentCapabilityScore + capacityAvailabilityScore;
  if (totalPositive > maxPositiveIntel) {
    const scale = maxPositiveIntel / totalPositive;
    lanePreferenceScore = Math.round(lanePreferenceScore * scale);
    regionPreferenceScore = Math.round(regionPreferenceScore * scale);
    equipmentCapabilityScore = Math.round(equipmentCapabilityScore * scale);
    capacityAvailabilityScore = Math.round(capacityAvailabilityScore * scale);
  }

  return {
    lanePreferenceScore,
    regionPreferenceScore,
    equipmentCapabilityScore,
    capacityAvailabilityScore,
    capacitySuppressionPenalty,
    phrases,
  };
}

/**
 * Rank all carriers in the org catalog for a given lane.
 * bench (optional): existing lane_carrier_interest rows for outcome-based boosts.
 * coverageProfile + coverageCarriers (optional): if stable lane, incumbents get heavy score boost.
 * debugMode (optional): when true, populates RankedCarrier.debugScores for every carrier.
 *
 * Returns ALL scored carriers (no hard cap on non-HF lanes). HF lanes are capped at
 * HIGH_FREQUENCY_CONFIG.maxCandidates. Callers should apply pagination/filtering.
 *
 * Side-effect: emits a structured JSON metrics log entry to stdout after ranking completes.
 */
export async function rankCarriersForLane(
  lane: RecurringLane,
  storage: IStorage,
  bench?: LaneCarrierInterest[],
  coverageProfile?: LaneCoverageProfile | null,
  coverageCarriers?: LaneCoverageProfileCarrier[],
  debugMode = false,
): Promise<RankedCarrier[]> {
  const [catalogCarriers, uploads] = await Promise.all([
    storage.getCarriers(lane.orgId),
    storage.getFinancialUploadsForOrg(lane.orgId),
  ]);

  // Build a set of carrier names/ids that had positive prior outcomes on this bench
  const positiveOutcomeStatuses = new Set(["available_now", "available_next_week"]);
  const positiveOutcomeCarrierKeys = new Set<string>();
  // Task #632 — Bench tier-0: count positive bench outcomes within the last 90 days.
  // Keyed by both carrierId (when present) and normStr(carrierName) for catalog +
  // history-only carriers. Carriers in this map become bench-tier eligible.
  const benchWindowMs = 90 * 24 * 60 * 60 * 1000;
  const benchCutoff = Date.now() - benchWindowMs;
  const benchWinsByKey = new Map<string, number>();
  const bumpBenchKey = (key: string) => {
    benchWinsByKey.set(key, (benchWinsByKey.get(key) ?? 0) + 1);
  };
  if (bench) {
    for (const b of bench) {
      if (positiveOutcomeStatuses.has(b.interestStatus ?? "")) {
        if (b.carrierId) positiveOutcomeCarrierKeys.add(b.carrierId);
        positiveOutcomeCarrierKeys.add(normStr(b.carrierName));
        // 90-day positive-outcome window — prefer classifiedAt, fall back to updatedAt.
        const tsRaw = b.classifiedAt ?? b.updatedAt ?? null;
        const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
        if (Number.isFinite(ts) && ts >= benchCutoff) {
          if (b.carrierId) bumpBenchKey(b.carrierId);
          bumpBenchKey(normStr(b.carrierName));
        }
      }
    }
  }
  const benchWinsForCarrier = (id: string | null, name: string): number => {
    // De-dup: when both id-keyed and name-keyed counters fire for the same row
    // they count the SAME wins twice. Take the max — never the sum.
    const byId = id ? (benchWinsByKey.get(id) ?? 0) : 0;
    const byName = benchWinsByKey.get(normStr(name)) ?? 0;
    return Math.max(byId, byName);
  };

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

  // Task #631 — fetch the unified contact-lock view ONCE per ranking call.
  // The window here is 48h (HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours)
  // — strictly tighter than the 14-day "recently contacted" window above.
  // When a carrier appears in both, we surface the richer 48h reason
  // ("Contacted 2h ago via Available Freight by Sara") instead of the
  // generic "Recently contacted (X days ago)" so reps know exactly which
  // module + rep already burned the touchpoint and stop second-guessing
  // the suppression. Only catalog carriers have IDs to match against;
  // history-only (TMS) carriers fall back to the legacy bench message.
  const contactLockByCarrierId = new Map<string, ContactLock>();
  const catalogCarrierIds = catalogCarriers.map(c => c.id);
  if (catalogCarrierIds.length > 0) {
    try {
      const locks = await findCarrierContactLocks({
        orgId: lane.orgId,
        carrierIds: catalogCarrierIds,
        recurringLaneId: lane.id ?? null,
        companyId: lane.companyId ?? null,
        laneLabel: formatLaneDisplay(lane.origin, lane.originState, lane.destination, lane.destinationState),
      });
      for (const [cid, lock] of locks) contactLockByCarrierId.set(cid, lock);
    } catch (err) {
      // Lock lookup is informational — never fail the rank on a query error.
      console.warn("[carrier-ranker] contact-lock lookup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Task #637 — Per-(carrier, lane) outcome priors. Read once per ranking
  // call; the helper returns an empty map on failure so this stays
  // strictly additive: a missing table or transient pool error never
  // breaks the rank, the carrier just shows zero prior wins.
  const laneSignature = buildLaneSig(
    lane.origin,
    lane.originState,
    lane.destination,
    lane.destinationState,
    lane.equipmentType,
  );
  const carrierLaneOutcomesByCarrierId = await getCarrierLaneOutcomesForLane(
    lane.orgId,
    laneSignature,
  );
  // Task #638 — Per-(carrier, lane) override prior; soft-fails to empty map.
  const carrierOverridesByCarrierId = await getCarrierOverridesForLane(
    lane.orgId,
    laneSignature,
  );

  // Build carrier history from BOTH financial uploads and load_fact, then
  // merge. Most orgs have one or the other (or strongly skewed weights),
  // and the prior implementation only read uploads — so an org with rich
  // load_fact history but few uploads saw consistently empty shortlists.
  const [uploadHistory, loadFactHistory] = await Promise.all([
    Promise.resolve(extractCarrierHistoryFromUploads(uploads, lane)),
    extractCarrierHistoryFromLoadFact(lane.orgId, lane),
  ]);
  const history = mergeHistoryMaps(uploadHistory, loadFactHistory);
  const laneOrigin = normStr(lane.origin);
  const laneDest = normStr(lane.destination);
  const laneEquip = normStr(lane.equipmentType ?? "");
  const laneOriginState = normStr(lane.originState ?? "");
  const laneDestState = normStr(lane.destinationState ?? "");
  const customerName = lane.companyName ?? "";

  // ── Pre-compute customer-history loads per carrier (single O(rows) pass) ───
  // Previous implementation called extractCustomerHistoryLoads inside the per-carrier
  // scoring loop, making the cost O(catalog × uploadRows). For large orgs this could
  // block the event loop for 100+ seconds. Now we scan uploads once.
  const customerLoadsByCarrier = new Map<string, number>();
  if (customerName) {
    const customerNorm = normStr(customerName);
    const customerNeedle = customerNorm.slice(0, 6);
    const sortedUploads = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    for (const upload of sortedUploads.slice(0, 3)) {
      const rows = (upload.rows as TmsRow[]) ?? [];
      for (const row of rows) {
        const rawCarrier = readTmsField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
        const rowCarrier = normStr(parseCarrierName(rawCarrier));
        if (!rowCarrier) continue;
        const rowCustomer = normStr(readTmsField(row, "customerName", "Customer", "customer", "customer_name"));
        if (!rowCustomer) continue;
        if (!rowCustomer.includes(customerNeedle)) continue;
        customerLoadsByCarrier.set(rowCarrier, (customerLoadsByCarrier.get(rowCarrier) ?? 0) + 1);
      }
    }
  }
  const lookupCustomerLoads = (carrierName: string): number =>
    customerLoadsByCarrier.get(normStr(carrierName)) ?? 0;

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
    // Debug sub-score tracking (accumulated during scoring)
    let _dbgExactLaneScore = 0;
    let _dbgRegionalScore = 0;

    // ── History-based scoring — guaranteed floor bands per tier ───────────
    // Tier order: exact > nearby > state_pair > region > none
    // Any tier with real company history beats catalog-region-only carriers.
    if (hist && hist.loads > 0) {
      if (hist.exactLoads > 0) {
        // ── Tier 1: Exact city-pair ─────────────────────────────────────────
        historyMatch = "exact";
        let exactFloor: number;
        if (hist.exactLoads >= 10) exactFloor = 85;
        else if (hist.exactLoads >= 5) exactFloor = 75;
        else exactFloor = 60;
        fitScore = exactFloor;
        _dbgExactLaneScore = exactFloor;
        const exactDays = daysSinceMonth(hist.lastUsedMonth ?? null);
        if (exactDays <= 90) {
          reasons.push(`Ran this exact lane ${hist.exactLoads}× in last 90 days`);
        } else if (exactDays <= 180) {
          reasons.push(`Ran this exact lane ${hist.exactLoads}× (last ~${Math.round(exactDays / 30)} months ago)`);
        } else {
          reasons.push(`Ran this exact lane ${hist.exactLoads}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
        }
      } else if (hist.nearbyLoads > 0) {
        // ── Tier 2: Nearby lane (both endpoints within NEARBY_RADIUS_MILES) ─
        historyMatch = "nearby";
        let nearbyFloor: number;
        if (hist.nearbyLoads >= 10) nearbyFloor = 72;
        else if (hist.nearbyLoads >= 5) nearbyFloor = 62;
        else nearbyFloor = 48;
        fitScore = nearbyFloor;
        _dbgRegionalScore = nearbyFloor;
        const nearbyDays = daysSinceMonth(hist.lastUsedMonth ?? null);
        if (nearbyDays <= 90) {
          reasons.push(`Ran ${hist.nearbyLoads} nearby lane${hist.nearbyLoads > 1 ? "s" : ""} within 75mi (last 90 days)`);
        } else {
          reasons.push(`Ran ${hist.nearbyLoads} nearby lane${hist.nearbyLoads > 1 ? "s" : ""} within 75mi of this corridor`);
        }
      } else if (hist.statePairLoads > 0) {
        // ── Tier 3: Same state-pair corridor ────────────────────────────────
        historyMatch = "state_pair";
        let spFloor: number;
        if (hist.statePairLoads >= 10) spFloor = 45;
        else if (hist.statePairLoads >= 5) spFloor = 40;
        else spFloor = 35;
        fitScore = spFloor;
        _dbgRegionalScore = spFloor;
        reasons.push(
          `Runs ${(lane.originState ?? "origin state").toUpperCase()} → ` +
          `${(lane.destinationState ?? "dest state").toUpperCase()} lanes ` +
          `(${hist.statePairLoads} loads on this state pair)`
        );
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

    // ── HQ Proximity bonus ────────────────────────────────────────────────
    // Carriers whose home base (city/state) is physically close to the lane
    // endpoints get a geographic affinity boost — they're more likely to have
    // trucks in the area and be receptive to backhaul opportunities.
    // Bonuses: within 75mi of BOTH endpoints (+10), one endpoint (+7), same
    // state only (+4).  These are tie-breakers that cannot change the history
    // tier assignment but do affect ordering within a tier.
    let hqProximityBonus = 0;
    const hqCityRaw = normStr(carrier.city ?? "");
    const hqStateRaw = normStr(carrier.state ?? "");
    if (hqCityRaw && hqStateRaw) {
      const hqCityState = `${hqCityRaw}, ${hqStateRaw}`;
      const distToOrigin = cityDistanceMiles(hqCityState, normStr(lane.origin));
      const distToDest   = cityDistanceMiles(hqCityState, normStr(lane.destination));
      const nearOrigin = distToOrigin !== null && distToOrigin <= NEARBY_RADIUS_MILES;
      const nearDest   = distToDest   !== null && distToDest   <= NEARBY_RADIUS_MILES;

      if (nearOrigin && nearDest) {
        hqProximityBonus = 10;
        reasons.push(`HQ near both endpoints (within 75mi of origin & destination)`);
      } else if (nearOrigin) {
        hqProximityBonus = 7;
        reasons.push(`HQ near origin (within 75mi of ${toTitleCase(lane.origin)})`);
      } else if (nearDest) {
        hqProximityBonus = 7;
        reasons.push(`HQ near destination (within 75mi of ${toTitleCase(lane.destination)})`);
      } else if (hqStateRaw === laneOriginState || hqStateRaw === laneDestState) {
        hqProximityBonus = 4;
        const stateLabel = hqStateRaw === laneOriginState ? "origin" : "destination";
        reasons.push(`HQ in ${hqStateRaw.toUpperCase()} — same state as ${stateLabel}`);
      }

      if (hqProximityBonus > 0) {
        fitScore += hqProximityBonus;
        // Promote catalog-only carriers so the visibility guard keeps them
        if (historyMatch === "none") historyMatch = "region";
      }
    }

    // Capture the pre-decay signal baseline.
    // Used for the visibility guard below: any carrier with at least one positive signal
    // (history, region, equipment) should remain visible even after staleness penalty.
    const preDecayBaseline = fitScore;

    // Recency decay signal — applied to ALL carriers regardless of history.
    // Carriers with no executed loads at all are treated as 365+ days stale (-25).
    // This demotes generic catalog carriers that have no proven freight record.
    let _dbgRecencyDelta = 0;
    {
      // lastUsedMonth from history, or null if carrier has no history at all
      const lastMonth = hist?.lastUsedMonth ?? null;
      const decay = recencyDecayScore(lastMonth);
      _dbgRecencyDelta = decay.score;
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
    const custLoads = lookupCustomerLoads(carrier.name);
    let _dbgCustHistScore = 0;
    if (custLoads > 0) {
      _dbgCustHistScore = Math.min(20, 12 + custLoads * 2);
      fitScore += _dbgCustHistScore;
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

    // Task #637 — read the (carrier, lane) outcome prior. Covers are the
    // strongest possible signal (+15), yes/quote replies +6, lone losses
    // (no positive engagement at all) -4. The summary line goes into
    // reasons so the "why this carrier" popover surfaces it.
    const laneOutcome = carrierLaneOutcomesByCarrierId.get(carrier.id);
    const prior = carrierLaneOutcomePrior(laneOutcome);
    if (prior.delta !== 0) fitScore += prior.delta;
    if (prior.reason) reasons.push(prior.reason);

    // Task #638 — Rep override prior: boost first, then cap (negatives win ties).
    const overrideAgg = carrierOverridesByCarrierId.get(carrier.id);
    if (overrideAgg) {
      const ov = carrierOverridePrior(overrideAgg);
      if (ov.boost !== 0) fitScore += ov.boost;
      if (Number.isFinite(ov.cap)) fitScore = Math.min(fitScore, ov.cap);
      for (const r of ov.reasons) reasons.push(r);
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
    // Task #631 — when a 48h cross-module lock exists, prefer that rich reason
    // ("Contacted 2h ago via Available Freight by Sara") over the legacy
    // 14-day bench message. Falls through to bench when no lock exists yet
    // the carrier was contacted within the wider window.
    const lock = contactLockByCarrierId.get(carrier.id);
    const isRecentlyContacted = !!lock || recentlyContactedKeys.has(carrier.id) || recentlyContactedKeys.has(carrierNorm);
    if (lock) {
      suppressionReasons.push(formatLockReason(lock));
    } else if (isRecentlyContacted) {
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
      bench: hadPositiveOutcome && benchWinsForCarrier(carrier.id, carrier.name) > 0,
      benchWins: benchWinsForCarrier(carrier.id, carrier.name),
      reasons: buildRankReasons(reasons, benchWinsForCarrier(carrier.id, carrier.name)),
      sourceChannel: (carrier as any).sourceChannel ?? null,
      suppressionReasons,
      equipmentMatch,
      regionMatch: !!regionMatch,
      isIncumbent,
      incumbentRank,
      isDoNotUse,
      exactLaneLoads: hist?.exactLoads ?? 0,
      nearbyLaneLoads: hist?.nearbyLoads ?? 0,
      statePairLoads: hist?.statePairLoads ?? 0,
      hasAnyCompanyHistory: (hist?.loads ?? 0) > 0,
      hqCity: carrier.city ?? null,
      hqState: carrier.state ?? null,
      hqProximityBonus,
      hasMarketNbaBoost: false, // set during high-frequency post-processing
      // debugScores populated later during HF post-processing if debugMode=true
      debugScores: debugMode ? {
        exactLaneScore: _dbgExactLaneScore,
        regionalScore: _dbgRegionalScore,
        customerHistoryScore: _dbgCustHistScore,
        outreachRecencyDelta: _dbgRecencyDelta,
        marketNbaBoost: 0,      // filled in during HF post-processing
        hfFloorApplied: 0,      // filled in during HF post-processing
        hfAdjustmentApplied: false,
        finalScore: fitScore,
        acceptedLanePreferenceScore: 0,   // filled in during accepted-intel pass
        acceptedRegionPreferenceScore: 0,
        acceptedEquipmentCapabilityScore: 0,
        acceptedCapacityAvailabilityScore: 0,
        acceptedCapacitySuppressionPenalty: 0,
      } : undefined,
    });
  }

  // Also add carriers from financial history that aren't in catalog yet
  for (const [carrierNorm, hist] of history.entries()) {
    const alreadyInCatalog = ranked.some(r => normStr(r.carrierName) === carrierNorm);
    if (alreadyInCatalog) continue;
    if ((hist.loads ?? 0) < 1) continue;

    // Determine governing tier from per-tier load counts (same logic as catalog carriers)
    let historyMatch: RankedCarrier["historyMatch"];
    let fitScore: number;
    const reasons: string[] = [];

    if (hist.exactLoads > 0) {
      // ── Tier 1: Exact city-pair ───────────────────────────────────────────
      historyMatch = "exact";
      let exactFloor: number;
      if (hist.exactLoads >= 10) exactFloor = 85;
      else if (hist.exactLoads >= 5) exactFloor = 75;
      else exactFloor = 60;
      fitScore = exactFloor;
      const histDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (histDays <= 90) {
        reasons.push(`Ran this exact lane ${hist.exactLoads}× in last 90 days`);
      } else if (histDays <= 180) {
        reasons.push(`Ran this exact lane ${hist.exactLoads}× (last ~${Math.round(histDays / 30)} months ago)`);
      } else {
        reasons.push(`Ran this exact lane ${hist.exactLoads}× (last used ${hist.lastUsedMonth ?? "unknown"})`);
      }
    } else if (hist.nearbyLoads > 0) {
      // ── Tier 2: Nearby lane (both endpoints within NEARBY_RADIUS_MILES) ───
      historyMatch = "nearby";
      let nearbyFloor: number;
      if (hist.nearbyLoads >= 10) nearbyFloor = 72;
      else if (hist.nearbyLoads >= 5) nearbyFloor = 62;
      else nearbyFloor = 48;
      fitScore = nearbyFloor;
      const nearbyDays = daysSinceMonth(hist.lastUsedMonth ?? null);
      if (nearbyDays <= 90) {
        reasons.push(`Ran ${hist.nearbyLoads} nearby lane${hist.nearbyLoads > 1 ? "s" : ""} within 75mi (last 90 days)`);
      } else {
        reasons.push(`Ran ${hist.nearbyLoads} nearby lane${hist.nearbyLoads > 1 ? "s" : ""} within 75mi of this corridor`);
      }
    } else {
      // ── Tier 3: Same state-pair corridor ──────────────────────────────────
      historyMatch = "state_pair";
      const spLoads = hist.statePairLoads > 0 ? hist.statePairLoads : hist.loads;
      let spFloor: number;
      if (spLoads >= 10) spFloor = 45;
      else if (spLoads >= 5) spFloor = 40;
      else spFloor = 35;
      fitScore = spFloor;
      reasons.push(
        `Runs ${(lane.originState ?? "origin state").toUpperCase()} → ` +
        `${(lane.destinationState ?? "dest state").toUpperCase()} lanes ` +
        `(${spLoads} loads on this state pair, financial data)`
      );
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
    const custLoadsHist = lookupCustomerLoads(carrierNorm);
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

    // Task #638 — Overrides are keyed by carriers.id; TMS-only carriers have
    // no catalog row, so no override prior is applied here.

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

    const histExactDbg = hist.exactLoads > 0 ? (hist.exactLoads >= 10 ? 85 : hist.exactLoads >= 5 ? 75 : 60) : 0;
    const histRegDbg = hist.exactLoads === 0 ? (hist.nearbyLoads > 0 ? (hist.nearbyLoads >= 10 ? 72 : hist.nearbyLoads >= 5 ? 62 : 48) : (hist.statePairLoads >= 10 ? 45 : hist.statePairLoads >= 5 ? 40 : 35)) : 0;
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
      bench: hadPositiveOutcomeHist && benchWinsForCarrier(null, carrierNorm) > 0,
      benchWins: benchWinsForCarrier(null, carrierNorm),
      reasons: buildRankReasons(reasons, benchWinsForCarrier(null, carrierNorm)),
      sourceChannel: null,
      suppressionReasons,
      equipmentMatch: false,
      regionMatch: false,
      isIncumbent: isIncumbentHist,
      incumbentRank: incumbentRankHist,
      isDoNotUse: false,
      exactLaneLoads: hist.exactLoads,
      nearbyLaneLoads: hist.nearbyLoads,
      statePairLoads: hist.statePairLoads,
      hasAnyCompanyHistory: true,
      hqCity: null,
      hqState: null,
      hqProximityBonus: 0,
      hasMarketNbaBoost: false, // set during high-frequency post-processing
      debugScores: debugMode ? {
        exactLaneScore: histExactDbg,
        regionalScore: histRegDbg,
        customerHistoryScore: custLoadsHist > 0 ? Math.min(20, 12 + custLoadsHist * 2) : 0,
        outreachRecencyDelta: histDecay.score,
        marketNbaBoost: 0,
        hfFloorApplied: 0,
        hfAdjustmentApplied: false,
        finalScore: fitScore,
        acceptedLanePreferenceScore: 0,
        acceptedRegionPreferenceScore: 0,
        acceptedEquipmentCapabilityScore: 0,
        acceptedCapacityAvailabilityScore: 0,
        acceptedCapacitySuppressionPenalty: 0,
      } : undefined,
    });
  }

  // ── Accepted-Intel Scoring Pass (Task #196) ─────────────────────────────────
  // Single batch query fetches all accepted intel for all catalog carriers at once.
  // TMS-only carriers have no carrierId so they cannot have accepted intel.
  try {
    const catalogRanked = ranked.filter(c => c.carrierId !== null);
    if (catalogRanked.length > 0) {
      const laneOriginNorm = normStr(lane.origin);
      const laneDestNorm = normStr(lane.destination);
      const laneOriginStateNorm = normStr(lane.originState ?? "");
      const laneDestStateNorm = normStr(lane.destinationState ?? "");
      const laneEquipNorm = normStr(lane.equipmentType ?? "");

      // ONE query for all carrier IDs — eliminates per-carrier N+1 pattern
      const carrierIds = catalogRanked.map(c => c.carrierId as string);
      const batchIntelMap = await storage.getBatchAcceptedIntelForCarriers(carrierIds);

      for (const c of catalogRanked) {
        if (!c.carrierId) continue;
        try {
          const allRows = batchIntelMap.get(c.carrierId) ?? [];

          const lanePrefs      = allRows.filter(r => r.suggestionType === "lane_preference");
          const regionPrefs    = allRows.filter(r => r.suggestionType === "region_preference");
          const equipCaps      = allRows.filter(r => r.suggestionType === "equipment_capability");
          const capacitySignals = allRows.filter(r =>
            r.suggestionType === "capacity_available" || r.suggestionType === "capacity_unavailable"
          );
          const cautionFlagSuggs = allRows.filter(r =>
            r.suggestionType === "service_risk" || r.suggestionType === "price_sensitivity"
          );

          const intel: CarrierAcceptedIntel = { lanePrefs, regionPrefs, equipCaps, capacitySignals, cautionFlags: cautionFlagSuggs };
          const intelScores = computeAcceptedIntelScores(
            intel,
            laneOriginNorm, laneDestNorm, laneOriginStateNorm, laneDestStateNorm, laneEquipNorm,
            c.historyMatch,
            c.exactLaneLoads,
          );

          const intelBoost = intelScores.lanePreferenceScore + intelScores.regionPreferenceScore +
            intelScores.equipmentCapabilityScore + intelScores.capacityAvailabilityScore -
            intelScores.capacitySuppressionPenalty;

          if (intelBoost !== 0) {
            c.fitScore = Math.max(0, Math.min(100, c.fitScore + intelBoost));
          }

          // Attach accepted intel phrases (for explanation/whyThisCarrier)
          if (intelScores.phrases.length > 0) {
            c.acceptedIntelPhrases = intelScores.phrases;
          }

          // Caution flags from accepted capacity_unavailable, service_risk, and price_sensitivity
          const hasAcceptedCapacityUnavailable = capacitySignals.some(s =>
            s.suggestionType === "capacity_unavailable" &&
            isAcceptedIntelFresh(s, ACCEPTED_INTEL_CONFIG.acceptedIntelFreshnessDays)
          );
          const hasAcceptedServiceRisk = cautionFlagSuggs.some(s => s.suggestionType === "service_risk");
          const hasAcceptedPriceSensitivity = cautionFlagSuggs.some(s => s.suggestionType === "price_sensitivity");

          if (hasAcceptedCapacityUnavailable || hasAcceptedServiceRisk || hasAcceptedPriceSensitivity) {
            c.cautionFlags = {
              hasAcceptedCapacityUnavailable,
              hasAcceptedServiceRisk,
              hasAcceptedPriceSensitivity,
            };
          }

          // Update debug scores if debug mode is active
          if (debugMode && c.debugScores) {
            c.debugScores.acceptedLanePreferenceScore = intelScores.lanePreferenceScore;
            c.debugScores.acceptedRegionPreferenceScore = intelScores.regionPreferenceScore;
            c.debugScores.acceptedEquipmentCapabilityScore = intelScores.equipmentCapabilityScore;
            c.debugScores.acceptedCapacityAvailabilityScore = intelScores.capacityAvailabilityScore;
            c.debugScores.acceptedCapacitySuppressionPenalty = intelScores.capacitySuppressionPenalty;
            c.debugScores.finalScore = c.fitScore;
          }
        } catch (err) {
          // Per-carrier intel scoring failure is non-fatal — log for observability
          console.warn(JSON.stringify({
            event: "acceptedIntelScoringError",
            carrierId: c.carrierId,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    }
  } catch (err) {
    // Accepted-intel batch fetch failure is non-fatal — proceed without it
    console.warn(JSON.stringify({
      event: "acceptedIntelBatchFetchError",
      laneId: lane.id ?? null,
      orgId: lane.orgId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // ── Task #632 — Bench tier-0 selection ──────────────────────────────────────
  // Carriers who replied "yes" on this lane within the last 90 days outrank
  // even `exact`-tier history. Cap the promoted set at BENCH_TIER0_CAP so a
  // long bench can't drown out genuine TMS history.
  const benchTier0Keys = computeBenchTier0Keys(ranked);
  const isBenchTier0 = (c: RankedCarrier) => benchTier0Keys.has(benchTier0KeyFor(c));

  // Sort by fitScore descending — scores encode history quality + recency + all signals.
  // historyMatch is a secondary tiebreaker only when scores are exactly equal.
  // Tier order: bench (top N wins) > exact > nearby > state_pair > region > none
  ranked.sort((a, b) => {
    const aBench = isBenchTier0(a);
    const bBench = isBenchTier0(b);
    if (aBench !== bBench) return aBench ? -1 : 1;
    if (aBench && bBench) {
      const winsDiff = b.benchWins - a.benchWins;
      if (winsDiff !== 0) return winsDiff;
    }
    const scoreDiff = b.fitScore - a.fitScore;
    if (scoreDiff !== 0) return scoreDiff;
    const matchRank: Record<string, number> = {
      exact: 0, nearby: 1, state_pair: 2, region: 3, none: 4,
    };
    return (matchRank[a.historyMatch] ?? 4) - (matchRank[b.historyMatch] ?? 4);
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
            // Blend rule-based and AI scores (70/30) but enforce history tier floors.
            // AI scoring cannot demote a carrier below its history-guaranteed floor.
            const blended = Math.min(100, Math.max(0,
              Math.round(0.7 * carrier.fitScore + 0.3 * aiItem.adjustedScore)
            ));
            let historyFloor = 0;
            if (carrier.historyMatch === "exact") {
              historyFloor = carrier.exactLaneLoads >= 10 ? 85
                : carrier.exactLaneLoads >= 5 ? 75 : 60;
            } else if (carrier.historyMatch === "nearby") {
              historyFloor = carrier.nearbyLaneLoads >= 10 ? 72
                : carrier.nearbyLaneLoads >= 5 ? 62 : 48;
            } else if (carrier.historyMatch === "state_pair") {
              historyFloor = carrier.statePairLoads >= 10 ? 45
                : carrier.statePairLoads >= 5 ? 40 : 35;
            }
            carrier.fitScore = Math.max(historyFloor, blended);
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

  const isHfLane = isHighFrequencyLane(lane, uploads);

  // ── High-Frequency Post-Processing ────────────────────────────
  // Uses the canonical isHighFrequencyLane(lane, uploads) which checks both
  // avgLoadsPerWeek (fast) and TMS upload history (accurate when avg is stale).
  if (isHfLane) {
    const hfSort = (a: RankedCarrier, b: RankedCarrier) => {
      // Bench tier-0 outranks everything (Task #632) — same cap as the
      // regular path; benchTier0Keys is computed once above.
      const aBench = isBenchTier0(a);
      const bBench = isBenchTier0(b);
      if (aBench !== bBench) return aBench ? -1 : 1;
      if (aBench && bBench) {
        const winsDiff = b.benchWins - a.benchWins;
        if (winsDiff !== 0) return winsDiff;
      }
      const scoreDiff = b.fitScore - a.fitScore;
      if (scoreDiff !== 0) return scoreDiff;
      const matchRank: Record<string, number> = { exact: 0, nearby: 1, state_pair: 2, region: 3, none: 4 };
      return (matchRank[a.historyMatch] ?? 4) - (matchRank[b.historyMatch] ?? 4);
    };

    // ── Guardrail: HF lane with zero exact-lane history ───────────────────────
    // When no carriers have exact-lane runs we fall back gracefully to regional /
    // customer-history carriers already present in `ranked`.  No explicit branch needed:
    // regional carriers are already in `ranked` and surface naturally when there is no
    // exact-lane history.  The `hasExactLaneCarriers` guard is computed in the metrics
    // log block (below) to surface "cold start" HF lanes in observability data.

    // Step 1: Apply HF exact-lane floor scores + service quality adjustments.
    // Service quality (on-time %, margin) applies within the HF path to differentiate
    // carriers that meet the frequency floor but differ in execution quality.
    for (const c of ranked) {
      if (c.historyMatch === "exact" && c.exactLaneLoads >= HIGH_FREQUENCY_CONFIG.minExactLaneRunsForFloor) {
        let hfFloor: number;
        if (c.exactLaneLoads >= 10) hfFloor = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorHigh;
        else if (c.exactLaneLoads >= 5) hfFloor = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorMed;
        else hfFloor = HIGH_FREQUENCY_CONFIG.hfExactLaneFloorAny;
        const prevScore = c.fitScore;
        if (c.fitScore < hfFloor) {
          c.fitScore = hfFloor;
        }
        const floorApplied = c.fitScore > prevScore ? hfFloor : 0;
        // Service quality micro-adjustments for HF lanes (applied within the floor-raised range)
        if (c.estimatedOnTimePct !== null) {
          if (c.estimatedOnTimePct >= 95) c.fitScore = Math.min(100, c.fitScore + 3);
          else if (c.estimatedOnTimePct >= 85) c.fitScore = Math.min(100, c.fitScore + 1);
          else if (c.estimatedOnTimePct < 70) c.fitScore = Math.max(0, c.fitScore - 3);
        }
        if (c.marginContribution !== null && c.marginContribution >= 500) {
          c.fitScore = Math.min(100, c.fitScore + 2);
        }
        if (debugMode && c.debugScores) {
          c.debugScores.hfFloorApplied = floorApplied;
          c.debugScores.hfAdjustmentApplied = floorApplied > 0;
          c.debugScores.finalScore = c.fitScore;
        }
      }
    }

    // Step 1.5: Sort and cap to maxCandidates *before* NBA boost so the boost
    // only operates on the top candidates (guards against unbounded iteration).
    ranked.sort(hfSort);
    if (ranked.length > HIGH_FREQUENCY_CONFIG.maxCandidates) {
      ranked.splice(HIGH_FREQUENCY_CONFIG.maxCandidates);
    }

    // Step 2: Market NBA boost — batch-fetch active carrier_market_nbas joined with
    // market_signals for lane equipment-type AND origin-region matching.
    // Only boosts carriers with demand_surge_capacity / imbalance_outreach NBAs
    // whose signal's region includes the lane's origin state (or has no region constraint).
    try {
      const carrierIds = [...new Set(
        ranked.flatMap(c => c.carrierId ? [c.carrierId] : [])
      )];

      if (carrierIds.length > 0) {
        // Single join query — equipment+region aware, avoids N+1
        const matchingNbas = await storage.getActiveCarrierMarketNbasBatch(
          carrierIds,
          lane.equipmentType ?? null,
          lane.originState ?? null,
        );

        const boostedCarrierIds = new Set(matchingNbas.map(n => n.carrierId));
        for (const c of ranked) {
          if (c.carrierId && boostedCarrierIds.has(c.carrierId)) {
            c.fitScore = Math.min(100, c.fitScore + HF_MARKET_NBA_BOOST);
            c.hasMarketNbaBoost = true;
            if (debugMode && c.debugScores) {
              c.debugScores.marketNbaBoost = HF_MARKET_NBA_BOOST;
              c.debugScores.hfAdjustmentApplied = true;
              c.debugScores.finalScore = c.fitScore;
            }
          }
        }
      }
    } catch {
      // Non-fatal: NBA boost is additive, proceed without it
    }

    // Step 3: Re-sort after NBA boost adjustments
    ranked.sort(hfSort);

    // Step 4: Batch-fetch outreach history for the HF carriers, then build explanations.
    // Outreach history (lastStatus, lastDate) is surfaced in CarrierFitExplanation so the
    // dispatcher can see the last outreach outcome at a glance.
    let outreachMap = new Map<string, { deliveryStatus: string | null; sentAt: Date | null }>();
    if (lane.id) {
      try {
        const carrierIds = ranked.flatMap(c => c.carrierId ? [c.carrierId] : []);
        outreachMap = await storage.getLatestCarrierOutreachLogsForLane(lane.id, carrierIds);
      } catch {
        // Non-fatal: explanations render without outreach data
      }
    }

    for (const c of ranked) {
      const outreachEntry = c.carrierId ? outreachMap.get(c.carrierId) : undefined;
      c.carrierFitExplanation = buildCarrierFitExplanation(c, outreachEntry ?? null);
    }
  }

  // ── Structured Metrics Log ─────────────────────────────────────────────────
  // Emits one JSON log entry per rankCarriersForLane invocation.
  // Intentionally after HF post-processing so scores/counts reflect final state.
  // No PII or large blobs — only lane context + aggregate counts + top-3 summaries.
  try {
    const exactCount = ranked.filter(c => c.historyMatch === "exact").length;
    const regionalCount = ranked.filter(
      c => c.historyMatch === "nearby" || c.historyMatch === "state_pair"
    ).length;
    const marketNbaCount = ranked.filter(c => c.hasMarketNbaBoost).length;
    // hasExactLaneCarriers: true if any carrier has qualifying exact-lane runs.
    // Used to detect "cold start" HF lanes where no exact history exists yet.
    const hasExactLaneCarriersForLog = ranked.some(
      c => c.historyMatch === "exact" && c.exactLaneLoads >= HIGH_FREQUENCY_CONFIG.minExactLaneRunsForFloor
    );
    const top3 = ranked.slice(0, 3).map(c => ({
      carrierId: c.carrierId,
      fitScore: c.fitScore,
      exactLaneRunCount: c.exactLaneLoads,
      hasMarketNbaBoost: c.hasMarketNbaBoost,
    }));
    console.log(JSON.stringify({
      event: "rankCarriersForLane",
      laneId: lane.id ?? null,
      orgId: lane.orgId,
      isHighFrequencyLane: isHfLane,
      hasExactLaneCarriers: hasExactLaneCarriersForLog,
      suggestionCount: ranked.length,
      exactLaneCount: exactCount,
      regionalCount,
      marketNbaCount,
      top3,
    }));
  } catch {
    // Metrics logging is non-fatal — never block the ranking response
  }

  return ranked;
}

/**
 * Compute whether a lane qualifies as high-frequency by counting exact-lane TMS rows
 * within the frequencyLookbackDays window from financial uploads.
 *
 * Complements isHighFrequencyLane(lane) which reads the stored avgLoadsPerWeek.
 * Uses the uploads already loaded for ranking — no additional DB query.
 */
export function computeHfFromUploads(
  uploads: FinancialUpload[],
  lane: RecurringLane,
): boolean {
  const lookbackMs = HIGH_FREQUENCY_CONFIG.frequencyLookbackDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(Date.now() - lookbackMs);
  // e.g. "2025-10" — only count TMS rows whose month falls within the lookback window
  const cutoffMonth = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;

  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);

  let count = 0;
  // Match the same 3-upload scan used by extractCarrierHistoryFromUploads
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      const rawMonth = readTmsField(row, "month", "Month");
      const month = normalizeTmsMonth(rawMonth);
      if (!month || month < cutoffMonth) continue;

      const rawOriginCity = readTmsField(row, "shipperCity", "originCity", "Shipper city", "Origin city");
      const rowOrigin = normStr(rawOriginCity);
      const rawDestCity = readTmsField(row, "consigneeCity", "destinationCity", "Consignee city", "Destination city");
      const rowDest = normStr(rawDestCity);

      if (rowOrigin === originNorm && rowDest === destNorm) count++;
    }
  }

  const weeksInWindow = HIGH_FREQUENCY_CONFIG.frequencyLookbackDays / 7;
  const computedLoadsPerWeek = count / weeksInWindow;
  return computedLoadsPerWeek >= HIGH_FREQUENCY_CONFIG.minLoadsPerWeek;
}

/**
 * Build a structured CarrierFitExplanation from a ranked carrier entry.
 * Called during high-frequency post-processing.
 */
function buildCarrierFitExplanation(
  c: RankedCarrier,
  outreach: { deliveryStatus: string | null; sentAt: Date | null } | null,
): CarrierFitExplanation {
  const explanation: CarrierFitExplanation = {
    exactLaneHistory: {
      runCount: c.exactLaneLoads,
      lastRunDate: c.lastUsedMonth,
    },
    regionalHistory: {
      runCount: c.nearbyLaneLoads + c.statePairLoads,
    },
    customerHistory: {
      hasHistory: c.customerHistoryLoads > 0,
      runCount: c.customerHistoryLoads,
    },
    outreachHistory: {
      lastStatus: outreach?.deliveryStatus ?? null,
      lastDate: outreach?.sentAt ? outreach.sentAt.toISOString().slice(0, 10) : null,
    },
    fitSignals: {
      regionEquipmentFitScore: (c.regionMatch ? 15 : 0) + (c.equipmentMatch ? 10 : 0) + c.hqProximityBonus,
      laneHistoryScore: c.exactLaneLoads > 0
        ? c.fitScore
        : c.nearbyLaneLoads + c.statePairLoads > 0
          ? c.fitScore
          : 0,
      customerHistoryScore: c.customerHistoryLoads > 0 ? Math.min(10, c.customerHistoryLoads * 2) : 0,
      hasMarketNbaBoost: c.hasMarketNbaBoost,
    },
  };
  if (c.acceptedIntelPhrases && c.acceptedIntelPhrases.length > 0) {
    explanation.acceptedIntelPhrases = c.acceptedIntelPhrases;
  }
  return explanation;
}

// extractExactLaneLoads removed: per-tier load counts are now tracked directly in
// CarrierHistory (exactLoads, nearbyLoads, statePairLoads) by extractCarrierHistoryFromUploads.

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
