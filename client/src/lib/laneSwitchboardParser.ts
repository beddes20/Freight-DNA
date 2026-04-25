/**
 * laneSwitchboardParser.ts (Task #652)
 *
 * Flexible lane-signature parser for the Global Lane Switchboard palette.
 * Accepts inputs like:
 *   "ATL → DAL"
 *   "ATL, GA → DAL, TX V"
 *   "Atlanta to Dallas reefer"
 *   "Atlanta, GA -> Dallas, TX reefer"
 *
 * Returns the parsed origin/destination (city + state) plus optional
 * equipment family. Origin/destination resolution defers to the existing
 * `resolveLaneLocationWithConfidence` for typo tolerance, and a small
 * curated `CITY_CODES` map handles the 3-letter freight shorthand reps
 * type (ATL, DFW, LAX, ...).
 *
 * Pure: no React, no fetches, no side effects. Safe for Node test runners.
 */

import {
  resolveLaneLocationWithConfidence,
  type NormalizationResult,
} from "@/lib/laneLocationNormalizer";

export interface ParsedLaneSwitchboardInput {
  originCity: string | null;
  originState: string | null;
  destCity: string | null;
  destState: string | null;
  equipment: EquipmentFamily | null;
  /**
   * "ok"          — both sides resolved with at least a city (state may
   *                 still be null when the rep types only "Atlanta").
   * "missing"     — input does not contain an origin/destination split.
   * "ambiguous"   — one side resolved to multiple equally-scored cities.
   * "invalid"     — one side did not resolve to a known US city.
   */
  status: "ok" | "missing" | "ambiguous" | "invalid";
  /** Human-readable parsed signature for the trust hint chip. */
  prettySignature: string | null;
  /**
   * Diagnostic copies of the per-side normalizer results (so the UI can
   * tell the rep "did you mean Carmel-by-the-Sea?" later).
   */
  originResolution: NormalizationResult | null;
  destResolution: NormalizationResult | null;
}

// ── Equipment family detection ────────────────────────────────────────────────

export type EquipmentFamily = "van" | "reefer" | "flatbed" | "open" | "other";

const EQUIPMENT_TOKENS: Array<{ token: RegExp; family: EquipmentFamily }> = [
  { token: /\b(reefer|reef|refrigerated|refr|cold)\b/i, family: "reefer" },
  { token: /\b(flatbed|flat ?bed|fb)\b/i, family: "flatbed" },
  { token: /\b(stepdeck|step ?deck|sd|rgn|conestoga)\b/i, family: "open" },
  { token: /\b(dry ?van|dryvan|box ?truck|box truck)\b/i, family: "van" },
  // Single-letter shorthand at the very end of the input only — avoids
  // matching "V" inside "DOVER" or "F" inside "FORT".
  { token: /(^|\s)(v|van)$/i, family: "van" },
  { token: /(^|\s)(r)$/i, family: "reefer" },
  { token: /(^|\s)(f)$/i, family: "flatbed" },
];

function extractEquipment(raw: string): { equipment: EquipmentFamily | null; stripped: string } {
  for (const { token, family } of EQUIPMENT_TOKENS) {
    const match = raw.match(token);
    if (match) {
      const stripped = raw.replace(token, " ").replace(/\s+/g, " ").trim();
      return { equipment: family, stripped };
    }
  }
  return { equipment: null, stripped: raw };
}

// ── Common freight 3-letter codes ────────────────────────────────────────────
//
// Curated list of the highest-traffic North-American freight markets. These
// shorthand codes are what reps actually type — keeping the list small and
// hand-tuned avoids the "DAL means three cities" ambiguity that a full
// IATA/airport list would introduce.

const CITY_CODES: Record<string, { city: string; state: string }> = {
  ATL: { city: "Atlanta", state: "GA" },
  BHM: { city: "Birmingham", state: "AL" },
  BNA: { city: "Nashville", state: "TN" },
  BOS: { city: "Boston", state: "MA" },
  CHI: { city: "Chicago", state: "IL" },
  CHA: { city: "Charlotte", state: "NC" },
  CLT: { city: "Charlotte", state: "NC" },
  CIN: { city: "Cincinnati", state: "OH" },
  CLE: { city: "Cleveland", state: "OH" },
  CMH: { city: "Columbus", state: "OH" },
  DAL: { city: "Dallas", state: "TX" },
  DFW: { city: "Dallas", state: "TX" },
  DEN: { city: "Denver", state: "CO" },
  DET: { city: "Detroit", state: "MI" },
  ELP: { city: "El Paso", state: "TX" },
  HOU: { city: "Houston", state: "TX" },
  IAH: { city: "Houston", state: "TX" },
  IND: { city: "Indianapolis", state: "IN" },
  JAX: { city: "Jacksonville", state: "FL" },
  JFK: { city: "New York", state: "NY" },
  KCY: { city: "Kansas City", state: "MO" },
  LAR: { city: "Laredo", state: "TX" },
  LAX: { city: "Los Angeles", state: "CA" },
  LAS: { city: "Las Vegas", state: "NV" },
  LGB: { city: "Long Beach", state: "CA" },
  LIT: { city: "Little Rock", state: "AR" },
  MCI: { city: "Kansas City", state: "MO" },
  MEM: { city: "Memphis", state: "TN" },
  MIA: { city: "Miami", state: "FL" },
  MKE: { city: "Milwaukee", state: "WI" },
  MSP: { city: "Minneapolis", state: "MN" },
  MSY: { city: "New Orleans", state: "LA" },
  NYC: { city: "New York", state: "NY" },
  OAK: { city: "Oakland", state: "CA" },
  OKC: { city: "Oklahoma City", state: "OK" },
  ONT: { city: "Ontario", state: "CA" },
  ORD: { city: "Chicago", state: "IL" },
  ORL: { city: "Orlando", state: "FL" },
  PHL: { city: "Philadelphia", state: "PA" },
  PHX: { city: "Phoenix", state: "AZ" },
  PIT: { city: "Pittsburgh", state: "PA" },
  POR: { city: "Portland", state: "OR" },
  PDX: { city: "Portland", state: "OR" },
  RIC: { city: "Richmond", state: "VA" },
  SAC: { city: "Sacramento", state: "CA" },
  SAN: { city: "San Diego", state: "CA" },
  SAT: { city: "San Antonio", state: "TX" },
  SAV: { city: "Savannah", state: "GA" },
  SDF: { city: "Louisville", state: "KY" },
  SEA: { city: "Seattle", state: "WA" },
  SFO: { city: "San Francisco", state: "CA" },
  SLC: { city: "Salt Lake City", state: "UT" },
  STL: { city: "Saint Louis", state: "MO" },
  TPA: { city: "Tampa", state: "FL" },
  TUL: { city: "Tulsa", state: "OK" },
};

function expandCityCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length !== 3) return input;
  const code = trimmed.toUpperCase();
  const hit = CITY_CODES[code];
  if (!hit) return input;
  return `${hit.city}, ${hit.state}`;
}

// ── Splitter ──────────────────────────────────────────────────────────────────

const SPLIT_PATTERNS: RegExp[] = [
  /\s*→\s*/,         // unicode arrow
  /\s*->\s*/,         // ASCII arrow
  /\s+to\s+/i,       // "Atlanta to Dallas"
  /\s*>\s*/,          // single chevron (lower priority — last resort)
];

function splitOriginDestination(raw: string): [string, string] | null {
  for (const re of SPLIT_PATTERNS) {
    const parts = raw.split(re);
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
      // Take first two halves — extra splits (e.g. "X > Y > Z") collapse.
      return [parts[0].trim(), parts.slice(1).join(" ").trim()];
    }
  }
  return null;
}

// ── Main API ──────────────────────────────────────────────────────────────────

const EMPTY_RESULT: ParsedLaneSwitchboardInput = {
  originCity: null,
  originState: null,
  destCity: null,
  destState: null,
  equipment: null,
  status: "missing",
  prettySignature: null,
  originResolution: null,
  destResolution: null,
};

export function parseSwitchboardInput(rawInput: string): ParsedLaneSwitchboardInput {
  const raw = (rawInput ?? "").trim();
  if (!raw) return EMPTY_RESULT;

  const { equipment, stripped } = extractEquipment(raw);
  const split = splitOriginDestination(stripped);
  if (!split) {
    return { ...EMPTY_RESULT, equipment };
  }

  const originRaw = expandCityCode(split[0]);
  const destRaw = expandCityCode(split[1]);

  const originRes = resolveLaneLocationWithConfidence(originRaw);
  const destRes = resolveLaneLocationWithConfidence(destRaw);

  const originOk = originRes.status === "exact" || originRes.status === "corrected" || originRes.status === "suggested";
  const destOk = destRes.status === "exact" || destRes.status === "corrected" || destRes.status === "suggested";

  let status: ParsedLaneSwitchboardInput["status"];
  if (originOk && destOk) status = "ok";
  else if (originRes.status === "ambiguous" || destRes.status === "ambiguous") status = "ambiguous";
  else status = "invalid";

  const originCity = originRes.city ?? null;
  const originState = originRes.state ?? null;
  const destCity = destRes.city ?? null;
  const destState = destRes.state ?? null;

  let prettySignature: string | null = null;
  if (status === "ok" && originCity && destCity) {
    const originLabel = originState ? `${originCity}, ${originState}` : originCity;
    const destLabel = destState ? `${destCity}, ${destState}` : destCity;
    const equipLabel = equipment ? ` · ${equipment}` : "";
    prettySignature = `${originLabel} → ${destLabel}${equipLabel}`;
  }

  return {
    originCity,
    originState,
    destCity,
    destState,
    equipment,
    status,
    prettySignature,
    originResolution: originRes,
    destResolution: destRes,
  };
}

/**
 * Build a backend query string for /api/lane-switchboard. Returns null
 * when the parsed input doesn't have enough to query (no origin/dest).
 */
export function buildSwitchboardQuery(parsed: ParsedLaneSwitchboardInput): string | null {
  if (parsed.status !== "ok") return null;
  if (!parsed.originCity || !parsed.destCity) return null;
  const params = new URLSearchParams();
  params.set("originCity", parsed.originCity);
  if (parsed.originState) params.set("originState", parsed.originState);
  params.set("destCity", parsed.destCity);
  if (parsed.destState) params.set("destState", parsed.destState);
  if (parsed.equipment) params.set("equipment", parsed.equipment);
  return params.toString();
}
