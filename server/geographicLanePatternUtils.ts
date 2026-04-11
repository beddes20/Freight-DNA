/**
 * Geographic Lane Pattern Utilities (Task #203)
 *
 * Provides:
 *   - STATE_TO_REGION mapping (US state abbreviations → named region buckets)
 *   - Baseline named patterns seed data
 *   - mapLaneToPatternIds(): translate (originState, destinationState) → matching pattern IDs
 *   - normalizeRegion / regionMatches — reused from existing exposure services
 */

import type { IStorage } from "./storage";

// ─── Region buckets ───────────────────────────────────────────────────────────

export const STATE_TO_REGION: Record<string, string> = {
  // Upper Midwest
  MN: "Upper Midwest", WI: "Upper Midwest", MI: "Upper Midwest",
  ND: "Upper Midwest", SD: "Upper Midwest", NE: "Upper Midwest",
  IA: "Upper Midwest", MO: "Upper Midwest",
  // Midwest
  IL: "Midwest", IN: "Midwest", OH: "Midwest",
  KY: "Midwest", WV: "Midwest",
  // Southeast
  TN: "Southeast", AL: "Southeast", GA: "Southeast",
  FL: "Southeast", SC: "Southeast", NC: "Southeast",
  VA: "Southeast", MS: "Southeast", AR: "Southeast",
  // Texas
  TX: "Texas", OK: "Oklahoma",
  // Northeast
  PA: "Northeast", NY: "Northeast", NJ: "Northeast",
  CT: "Northeast", MA: "Northeast", RI: "Northeast",
  VT: "Northeast", NH: "Northeast", ME: "Northeast",
  MD: "Northeast", DE: "Northeast", DC: "Northeast",
  // Southwest
  AZ: "Southwest", NM: "Southwest", NV: "Southwest",
  UT: "Southwest", CO: "Southwest",
  // SoCal / West
  CA: "SoCal", OR: "Pacific Northwest", WA: "Pacific Northwest",
  ID: "Pacific Northwest", MT: "Mountain West",
  WY: "Mountain West", KS: "Plains", LA: "Southeast",
};

// ─── Baseline seed patterns ────────────────────────────────────────────────────

export interface BaselineLanePattern {
  name: string;
  originRegion: string;
  destinationRegion: string;
  namedCorridor: string | null;
  description: string | null;
}

export const BASELINE_LANE_PATTERNS: BaselineLanePattern[] = [
  {
    name: "Upper Midwest Outbound",
    originRegion: "Upper Midwest",
    destinationRegion: "*",
    namedCorridor: null,
    description: "Outbound shipments originating in Upper Midwest states (MN, WI, MI, ND, SD, NE, IA, MO)",
  },
  {
    name: "Upper Midwest Inbound",
    originRegion: "*",
    destinationRegion: "Upper Midwest",
    namedCorridor: null,
    description: "Inbound shipments destined for Upper Midwest states",
  },
  {
    name: "Southeast Outbound",
    originRegion: "Southeast",
    destinationRegion: "*",
    namedCorridor: null,
    description: "Outbound shipments originating in Southeast states (TN, AL, GA, FL, SC, NC, VA, MS, AR, LA)",
  },
  {
    name: "Southeast Inbound",
    originRegion: "*",
    destinationRegion: "Southeast",
    namedCorridor: null,
    description: "Inbound shipments destined for Southeast states",
  },
  {
    name: "Texas → Midwest",
    originRegion: "Texas",
    destinationRegion: "Midwest",
    namedCorridor: "Texas → Midwest",
    description: "Shipments from Texas to Midwest corridor (IL, IN, OH, KY, WV)",
  },
  {
    name: "Midwest → Texas",
    originRegion: "Midwest",
    destinationRegion: "Texas",
    namedCorridor: "Midwest → Texas",
    description: "Shipments from Midwest corridor to Texas",
  },
  {
    name: "SoCal → Texas",
    originRegion: "SoCal",
    destinationRegion: "Texas",
    namedCorridor: "SoCal → Texas",
    description: "Shipments from Southern California to Texas",
  },
  {
    name: "Texas → SoCal",
    originRegion: "Texas",
    destinationRegion: "SoCal",
    namedCorridor: "Texas → SoCal",
    description: "Shipments from Texas to Southern California",
  },
  {
    name: "Midwest → Northeast",
    originRegion: "Midwest",
    destinationRegion: "Northeast",
    namedCorridor: "Midwest → Northeast",
    description: "Shipments from Midwest states to Northeast corridor",
  },
  {
    name: "Northeast → Midwest",
    originRegion: "Northeast",
    destinationRegion: "Midwest",
    namedCorridor: "Northeast → Midwest",
    description: "Shipments from Northeast to Midwest states",
  },
  {
    name: "Southeast → Northeast",
    originRegion: "Southeast",
    destinationRegion: "Northeast",
    namedCorridor: "Southeast → Northeast",
    description: "Southeast to Northeast corridor",
  },
  {
    name: "Northeast → Southeast",
    originRegion: "Northeast",
    destinationRegion: "Southeast",
    namedCorridor: "Northeast → Southeast",
    description: "Northeast to Southeast corridor",
  },
  {
    name: "Midwest → Southeast",
    originRegion: "Midwest",
    destinationRegion: "Southeast",
    namedCorridor: "Midwest → Southeast",
    description: "Shipments from Midwest to Southeast",
  },
  {
    name: "Southeast → Midwest",
    originRegion: "Southeast",
    destinationRegion: "Midwest",
    namedCorridor: "Southeast → Midwest",
    description: "Shipments from Southeast to Midwest",
  },
  {
    name: "Texas → Southeast",
    originRegion: "Texas",
    destinationRegion: "Southeast",
    namedCorridor: "Texas → Southeast",
    description: "Shipments from Texas to Southeast",
  },
  {
    name: "Southeast → Texas",
    originRegion: "Southeast",
    destinationRegion: "Texas",
    namedCorridor: "Southeast → Texas",
    description: "Shipments from Southeast to Texas",
  },
  {
    name: "Upper Midwest → Southeast",
    originRegion: "Upper Midwest",
    destinationRegion: "Southeast",
    namedCorridor: "Upper Midwest → Southeast",
    description: "Shipments from Upper Midwest to Southeast",
  },
  {
    name: "Southeast → Upper Midwest",
    originRegion: "Southeast",
    destinationRegion: "Upper Midwest",
    namedCorridor: "Southeast → Upper Midwest",
    description: "Shipments from Southeast to Upper Midwest",
  },
  {
    name: "Pacific Northwest Outbound",
    originRegion: "Pacific Northwest",
    destinationRegion: "*",
    namedCorridor: null,
    description: "Outbound shipments from Pacific Northwest (OR, WA, ID)",
  },
  {
    name: "Southwest Outbound",
    originRegion: "Southwest",
    destinationRegion: "*",
    namedCorridor: null,
    description: "Outbound shipments from Southwest (AZ, NM, NV, UT, CO)",
  },
];

// ─── Region normalization (mirroring marketNbaExposureService pattern) ─────────

export function normalizeRegion(region: string | null | undefined): string {
  if (!region) return "";
  return region.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function regionMatches(
  patternRegion: string | null | undefined,
  laneRegion: string | null | undefined,
): boolean {
  if (!patternRegion || !laneRegion) return false;
  if (patternRegion === "*") return true;
  const pat = normalizeRegion(patternRegion);
  const lane = normalizeRegion(laneRegion);
  if (pat === lane) return true;
  if (pat.includes(lane) || lane.includes(pat)) return true;
  const patTokens = pat.split("_").filter(t => t.length >= 2);
  const laneTokens = lane.split("_").filter(t => t.length >= 2);
  return patTokens.some(t => laneTokens.includes(t));
}

// ─── Lane → Pattern ID mapping ────────────────────────────────────────────────

/**
 * Maps a (originState, destinationState) pair to an array of matching baseline
 * pattern IDs by looking up the regions for each state and checking which stored
 * patterns' originRegion/destinationRegion match.
 *
 * Returns an array of pattern IDs (may be empty if no patterns match).
 */
export async function mapLaneToPatternIds(
  originState: string | null | undefined,
  destinationState: string | null | undefined,
  storage: IStorage,
): Promise<string[]> {
  if (!originState && !destinationState) return [];

  const originRegion = originState ? (STATE_TO_REGION[originState.toUpperCase()] ?? originState) : null;
  const destRegion = destinationState ? (STATE_TO_REGION[destinationState.toUpperCase()] ?? destinationState) : null;

  const patterns = await storage.getGeographicLanePatterns();
  const matches: string[] = [];

  for (const pattern of patterns) {
    const originMatch = !originRegion || regionMatches(pattern.originRegion, originRegion);
    const destMatch = !destRegion || regionMatches(pattern.destinationRegion, destRegion);
    if (originMatch && destMatch) {
      matches.push(pattern.id);
    }
  }

  return matches;
}

/**
 * Given origin/destination from a recurring lane (full city name or state abbrev),
 * extract the state part if present (e.g. "Chicago, IL" → "IL").
 */
export function extractStateFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.trim().split(",");
  const statePart = parts[parts.length - 1]?.trim().toUpperCase();
  if (statePart && statePart.length === 2 && /^[A-Z]{2}$/.test(statePart)) {
    return statePart;
  }
  if (statePart && STATE_TO_REGION[statePart]) {
    return statePart;
  }
  return null;
}
