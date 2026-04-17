/**
 * laneLocationNormalizer.ts
 *
 * Typo-tolerant, fuzzy-matching normalization for lane city/state inputs.
 * Self-contained — no external API calls. Uses a bundled US city/state dataset.
 *
 * Confidence levels:
 *   exact      — only formatting changed (whitespace, comma, casing)
 *   corrected  — typo fixed, single clear match (edit distance 1–2)
 *   suggested  — medium-confidence, single best guess but needs confirmation
 *   ambiguous  — multiple equally-scored candidates
 *   invalid    — no plausible match found
 */

import usCitiesRaw from "@/data/usCities.json";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NormalizationStatus = "exact" | "corrected" | "suggested" | "ambiguous" | "invalid";

export interface NormalizationResult {
  status: NormalizationStatus;
  canonical: string | null;
  city: string | null;
  state: string | null;
  originalInput: string;
  candidates?: Array<{ city: string; state: string }>;
  correctedFrom?: string;
}

interface CityEntry {
  city: string;
  state: string;
  aliases: string[];
}

// ── US State abbreviation map ─────────────────────────────────────────────────

const STATE_NAME_TO_ABBR: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

const VALID_STATE_ABBRS = new Set(Object.values(STATE_NAME_TO_ABBR));

// ── Dataset ───────────────────────────────────────────────────────────────────

const US_CITIES: CityEntry[] = usCitiesRaw as CityEntry[];

// Pre-build a deduplicated lookup list: primary city name + all aliases, lowercased
interface IndexedCity {
  city: string;
  state: string;
  searchKey: string;
}

function buildCityIndex(): IndexedCity[] {
  const seen = new Set<string>();
  const index: IndexedCity[] = [];
  for (const entry of US_CITIES) {
    const keys = [entry.city, ...entry.aliases];
    for (const name of keys) {
      const key = `${name.toLowerCase()}|${entry.state}`;
      if (!seen.has(key)) {
        seen.add(key);
        index.push({ city: entry.city, state: entry.state, searchKey: name.toLowerCase() });
      }
    }
  }
  return index;
}

const CITY_INDEX = buildCityIndex();

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Normalize a state string: trim, uppercase. If it's a full state name, convert
 * to abbreviation. Returns the abbreviation or null if unrecognizable.
 */
export function normalizeStateAbbr(raw: string): { abbr: string | null; valid: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { abbr: null, valid: true };

  const upper = trimmed.toUpperCase();

  if (VALID_STATE_ABBRS.has(upper) && upper.length === 2) {
    return { abbr: upper, valid: true };
  }

  const lower = trimmed.toLowerCase();
  if (STATE_NAME_TO_ABBR[lower]) {
    return { abbr: STATE_NAME_TO_ABBR[lower], valid: true };
  }

  return { abbr: upper, valid: false };
}

/**
 * Title-case a city name, preserving multi-word cities and common prefixes.
 */
function titleCaseCity(city: string): string {
  const prefixMap: Record<string, string> = {
    "st.": "St.", "st": "St.", "saint": "Saint",
    "fort": "Fort", "ft.": "Ft.", "ft": "Ft.",
    "mount": "Mount", "mt.": "Mt.", "mt": "Mt.",
    "north": "North", "south": "South", "east": "East", "west": "West",
    "new": "New", "old": "Old", "lake": "Lake", "port": "Port",
    "grand": "Grand", "little": "Little",
  };

  return city
    .split(" ")
    .map((word, i) => {
      if (!word) return word;
      const lower = word.toLowerCase();
      if (i === 0) {
        return prefixMap[lower] ?? (word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Deterministic formatting: trim, collapse spaces, fix comma spacing, title-case city, uppercase state.
 * Returns { city, state } parsed from the raw input.
 */
function parseAndFormatInput(raw: string): { city: string; state: string } {
  const cleaned = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",");

  const commaIdx = cleaned.lastIndexOf(",");
  if (commaIdx !== -1) {
    const city = cleaned.slice(0, commaIdx).trim();
    const state = cleaned.slice(commaIdx + 1).trim();
    return { city: titleCaseCity(city), state: state.toUpperCase() };
  }

  return { city: titleCaseCity(cleaned), state: "" };
}

/**
 * Format canonical output: "City, ST"
 */
export function formatCanonicalCityState(city: string, state: string): string {
  return `${city}, ${state}`;
}

// ── Edit distance (Levenshtein) ───────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

// ── Fuzzy city matching ───────────────────────────────────────────────────────

interface CityMatch {
  city: string;
  state: string;
  distance: number;
}

const MAX_FUZZY_DISTANCE = 3;

function findCityMatches(cityQuery: string, stateFilter?: string): CityMatch[] {
  const query = cityQuery.toLowerCase().trim();
  const results: CityMatch[] = [];

  for (const entry of CITY_INDEX) {
    if (stateFilter && entry.state !== stateFilter.toUpperCase()) continue;

    const dist = editDistance(query, entry.searchKey);
    if (dist <= MAX_FUZZY_DISTANCE) {
      results.push({ city: entry.city, state: entry.state, distance: dist });
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return results;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Normalize a lane location input with confidence scoring.
 *
 * Accepts input formats:
 *   "Phoenix, AZ"     — city with state
 *   "Phoenix"         — city only
 *   "pheonix, az"     — typo
 *   "PHOENIX ,  AZ"   — bad formatting
 *   "phoenix,az"      — missing space
 *
 * @param rawCity    The city name field value
 * @param rawState   The state field value (can be empty if combined in rawCity)
 */
export function resolveLaneLocationWithConfidence(
  rawCity: string,
  rawState?: string,
): NormalizationResult {
  const originalInput = rawState
    ? `${rawCity.trim()}, ${rawState.trim()}`
    : rawCity.trim();

  if (!rawCity.trim()) {
    return {
      status: "invalid",
      canonical: null,
      city: null,
      state: null,
      originalInput,
    };
  }

  const { city: parsedCity, state: parsedStateRaw } = parseAndFormatInput(rawCity);

  const effectiveStateRaw = rawState?.trim() || parsedStateRaw;
  const { abbr: stateAbbr, valid: stateValid } = effectiveStateRaw
    ? normalizeStateAbbr(effectiveStateRaw)
    : { abbr: null, valid: true };

  if (effectiveStateRaw && !stateValid) {
    return {
      status: "invalid",
      canonical: null,
      city: parsedCity,
      state: stateAbbr ?? effectiveStateRaw.toUpperCase(),
      originalInput,
    };
  }

  const cityQuery = parsedCity;
  const cityQueryLower = cityQuery.toLowerCase();

  const withState = stateAbbr
    ? findCityMatches(cityQueryLower, stateAbbr)
    : findCityMatches(cityQueryLower);

  if (withState.length === 0) {
    return {
      status: "invalid",
      canonical: null,
      city: parsedCity,
      state: stateAbbr ?? null,
      originalInput,
    };
  }

  const best = withState[0];
  const bestDist = best.distance;

  if (bestDist === 0) {
    const canonical = formatCanonicalCityState(best.city, best.state);
    const wasFormatting = canonical !== originalInput;
    return {
      status: "exact",
      canonical,
      city: best.city,
      state: best.state,
      originalInput,
      correctedFrom: wasFormatting ? originalInput : undefined,
    };
  }

  const closeMatches = withState.filter(m => m.distance <= 2);
  const nearMatches = withState.filter(m => m.distance === bestDist);

  // If there's a single unique winner at the best distance and it's close (≤2),
  // prefer auto-correction even if there are weaker also-rans within the close window.
  if (bestDist <= 2 && nearMatches.length === 1) {
    const canonical = formatCanonicalCityState(best.city, best.state);
    return {
      status: "corrected",
      canonical,
      city: best.city,
      state: best.state,
      originalInput,
      correctedFrom: originalInput,
    };
  }

  if (bestDist <= 2 && closeMatches.length > 1) {
    const deduped = deduplicateCandidates(closeMatches.slice(0, 5));
    if (deduped.length === 1) {
      const canonical = formatCanonicalCityState(deduped[0].city, deduped[0].state);
      return {
        status: "corrected",
        canonical,
        city: deduped[0].city,
        state: deduped[0].state,
        originalInput,
        correctedFrom: originalInput,
      };
    }
    return {
      status: "ambiguous",
      canonical: null,
      city: null,
      state: null,
      originalInput,
      candidates: deduped.map(m => ({ city: m.city, state: m.state })),
    };
  }

  if (bestDist === 3 && nearMatches.length === 1) {
    const canonical = formatCanonicalCityState(best.city, best.state);
    return {
      status: "suggested",
      canonical,
      city: best.city,
      state: best.state,
      originalInput,
    };
  }

  if (bestDist === 3 && nearMatches.length > 1) {
    const deduped = deduplicateCandidates(nearMatches.slice(0, 5));
    return {
      status: "ambiguous",
      canonical: null,
      city: null,
      state: null,
      originalInput,
      candidates: deduped.map(m => ({ city: m.city, state: m.state })),
    };
  }

  return {
    status: "invalid",
    canonical: null,
    city: parsedCity,
    state: stateAbbr ?? null,
    originalInput,
  };
}

function deduplicateCandidates(matches: CityMatch[]): CityMatch[] {
  const seen = new Set<string>();
  const out: CityMatch[] = [];
  for (const m of matches) {
    const key = `${m.city.toLowerCase()}|${m.state}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/**
 * Simple formatting normalization only — no fuzzy matching.
 * Useful for obviously correct inputs that just need formatting cleanup.
 */
export function normalizeLaneLocationInput(rawCity: string, rawState?: string): string {
  const { city: parsedCity, state: parsedState } = parseAndFormatInput(rawCity);
  const effectiveState = rawState?.trim() || parsedState;
  const { abbr } = effectiveState ? normalizeStateAbbr(effectiveState) : { abbr: null };

  if (abbr) return formatCanonicalCityState(parsedCity, abbr);
  return parsedCity;
}

/**
 * Prefix-based autocomplete for typing. Returns city/state matches whose
 * (city or alias) name begins with the input. Optimized for as-you-type
 * dropdowns rather than typo correction.
 *
 * @param rawCity     The (possibly partial) city the rep is typing.
 * @param stateFilter Optional 2-letter state code to constrain results.
 * @param maxResults  Max number of suggestions to return.
 */
export function getCityAutocompleteSuggestions(
  rawCity: string,
  stateFilter?: string,
  maxResults = 8,
): Array<{ city: string; state: string; canonical: string }> {
  const trimmed = rawCity.trim();
  if (trimmed.length < 2) return [];

  let cityPart = trimmed;
  let inlineStatePart = "";
  const commaIdx = trimmed.lastIndexOf(",");
  if (commaIdx !== -1) {
    cityPart = trimmed.slice(0, commaIdx).trim();
    inlineStatePart = trimmed.slice(commaIdx + 1).trim();
  }

  if (cityPart.length < 2) return [];

  const cityPrefix = cityPart.toLowerCase();
  const stateConstraint = (stateFilter?.trim() || inlineStatePart).toUpperCase();

  const matches: Array<{ city: string; state: string; sortKey: string }> = [];
  const seen = new Set<string>();

  for (const entry of CITY_INDEX) {
    if (stateConstraint) {
      if (stateConstraint.length === 2) {
        if (entry.state !== stateConstraint) continue;
      } else if (stateConstraint.length === 1) {
        if (!entry.state.startsWith(stateConstraint)) continue;
      } else {
        continue;
      }
    }
    if (!entry.searchKey.startsWith(cityPrefix)) continue;

    const dedupeKey = `${entry.city.toLowerCase()}|${entry.state}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    matches.push({
      city: entry.city,
      state: entry.state,
      sortKey: `${entry.searchKey.length.toString().padStart(4, "0")}|${entry.city.toLowerCase()}|${entry.state}`,
    });
  }

  matches.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return matches.slice(0, maxResults).map(m => ({
    city: m.city,
    state: m.state,
    canonical: formatCanonicalCityState(m.city, m.state),
  }));
}

/**
 * Returns a list of possible city/state suggestions for a given input.
 * Useful for building autocomplete or disambiguation UIs.
 */
export function getLaneLocationSuggestions(
  rawCity: string,
  rawState?: string,
  maxResults = 5,
): Array<{ city: string; state: string; canonical: string }> {
  const { city: parsedCity, state: parsedStateRaw } = parseAndFormatInput(rawCity);
  const effectiveStateRaw = rawState?.trim() || parsedStateRaw;
  const { abbr: stateAbbr } = effectiveStateRaw
    ? normalizeStateAbbr(effectiveStateRaw)
    : { abbr: null };

  const matches = stateAbbr
    ? findCityMatches(parsedCity.toLowerCase(), stateAbbr)
    : findCityMatches(parsedCity.toLowerCase());

  const deduped = deduplicateCandidates(matches);
  return deduped.slice(0, maxResults).map(m => ({
    city: m.city,
    state: m.state,
    canonical: formatCanonicalCityState(m.city, m.state),
  }));
}
