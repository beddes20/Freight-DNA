/**
 * Shared lane formatting helpers used across frontend, backend, and tests.
 */

/**
 * Maps raw equipment-type codes (short codes, abbreviations, TMS artifacts)
 * to human-readable names. Falls back to "dry van" for unrecognized short codes
 * that are clearly not real words (e.g. "po", "ltl", "ftl").
 */
const EQUIPMENT_CODE_MAP: Record<string, string> = {
  dv: "dry van",
  van: "dry van",
  fv: "flatbed",
  flat: "flatbed",
  fb: "flatbed",
  rf: "reefer",
  ref: "reefer",
  reefer: "reefer",
  sb: "step deck",
  sd: "step deck",
  dd: "double drop",
  ltl: "LTL",
  ftl: "dry van",
  po: "dry van",
  cn: "conestoga",
  conestoga: "conestoga",
};

export function normalizeEquipmentType(raw: string | null | undefined): string {
  if (!raw) return "dry van";
  const key = raw.trim().toLowerCase();
  if (EQUIPMENT_CODE_MAP[key]) return EQUIPMENT_CODE_MAP[key];
  if (key.length <= 3 && !/[aeiou]/i.test(key)) return "dry van";
  return raw.trim();
}

/**
 * Title-cases a city name and uppercases a state abbreviation.
 * Collapses duplicate state values embedded in the city string
 * (e.g. "Macon, GA" with state "GA" → "Macon, GA" not "Macon, GA, GA").
 *
 * Null-safe on the city argument: callers in the Available Loads board
 * (and elsewhere) pass nullable load_fact / freight_opportunity columns
 * directly. An empty / null / undefined / whitespace-only city returns
 * either the bare uppercase state (when present) or "" so cells render
 * cleanly without throwing.
 */
export function formatLaneLocation(city: string | null | undefined, state: string | null | undefined): string {
  const upperState = state ? state.trim().toUpperCase() : null;
  if (city == null) return upperState ?? "";

  // Strip a trailing ", ST" from the raw city before title-casing so we don't
  // end up with "Macon, Ga" when the state was already embedded.
  // Pattern: optional comma + optional space + 2-letter state abbreviation at end.
  let rawCity = city.trim();
  if (!rawCity) return upperState ?? "";
  if (upperState) {
    const trailingState = new RegExp(`,?\\s*${upperState}$`, "i");
    rawCity = rawCity.replace(trailingState, "").trim();
  }

  // If the remaining "city" is just 2 alphabetic characters (bare state code in wrong field),
  // return it uppercased rather than title-casing "ga" → "Ga".
  if (!upperState && /^[a-zA-Z]{2}$/.test(rawCity)) {
    return rawCity.toUpperCase();
  }

  // Title-case word-by-word. Words are split on whitespace AND hyphens so
  // multi-part city names render correctly:
  //   "knightdale"        → "Knightdale"
  //   "cottage grove"     → "Cottage Grove"
  //   "winston-salem"     → "Winston-Salem"
  //   "st. louis"         → "St. Louis"
  //   "mt. pleasant"      → "Mt. Pleasant"
  //   "o'fallon"          → "O'Fallon"
  // The split-and-rejoin preserves the original separator (space or hyphen)
  // so we don't accidentally collapse "Winston-Salem" to "Winston Salem".
  const titledCity = rawCity
    .split(/(\s+|-)/) // capture-group separators are kept in the array
    .map(part => {
      if (/^\s+$/.test(part) || part === "-") return part;
      return part
        .split("'")
        .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
        .join("'");
    })
    .join("");

  if (!upperState) return titledCity;

  return `${titledCity}, ${upperState}`;
}

/**
 * Returns a full "Origin, ST → Destination, ST" lane display string.
 */
export function formatLaneDisplay(
  origin: string,
  originState: string | null | undefined,
  destination: string,
  destinationState: string | null | undefined,
): string {
  const o = formatLaneLocation(origin, originState);
  const d = formatLaneLocation(destination, destinationState);
  return `${o} → ${d}`;
}

/**
 * Normalizes a lane location string for consistent O/D matching.
 *
 * Applies deterministic, reversible transformations only — no fuzzy matching:
 *   1. Lowercase
 *   2. Trim leading/trailing whitespace
 *   3. Collapse multiple interior spaces to a single space
 *   4. Normalize spacing around commas to exactly ", " (one space after, none before)
 *
 * Examples:
 *   "Memphis, TN"   → "memphis, tn"
 *   "memphis,  tn"  → "memphis, tn"   (extra space after comma)
 *   "MEMPHIS, TN"   → "memphis, tn"   (uppercase)
 *   "Memphis ,TN"   → "memphis, tn"   (space before comma)
 *   "  Ogden,  UT " → "ogden, ut"     (leading/trailing + extra space)
 */
export function normalizeLaneLocation(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")          // collapse multiple interior spaces → single
    .replace(/\s*,\s*/g, ", ");    // normalize "city,state", "city ,  state" → "city, state"
}

/**
 * Strip the leading customer-code prefix and trailing logistics noise from a
 * raw customer label. This is the *cleaning* half — it does not touch case.
 * Used by the importer to derive a stable lookup key, and by
 * `formatCustomerName` as the first pass before title-casing.
 *
 * Examples:
 *   "VERTFOFL - Vertiv Mexico"            → "Vertiv Mexico"
 *   "bloosaca - bloom energy"             → "bloom energy"
 *   "CTSIMIGA - CTSI C/o Rheem WH 1827"   → "CTSI"
 *   "FOODCHIL - Food In Transit"          → "Food In Transit"
 *   "MOTTNOMI - MOTTS C/O RYDER FREIGHT BILL PROCESSING" → "MOTTS"
 *
 * Prefix rules — both supported:
 *   1. Any-case 4+ char alnum token followed by whitespace + dash + whitespace
 *      (e.g. "bloosaca - bloom energy", "VERTFOFL - Vertiv Mexico").
 *   2. Uppercase-or-digit 4+ char token followed by a dash with no whitespace
 *      around it (e.g. "VERTFOFL-Vertiv Mexico"). The all-caps requirement
 *      protects mixed-case hyphenated names like "Coca-Cola" from being
 *      mistaken for a code prefix.
 */
export function cleanCustomerLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // Strip leading 4+ char alnum code followed by space-dash-space (any case).
  s = s.replace(/^[A-Za-z0-9]{4,}\s+[-–—]\s+/, "");
  // Strip leading 4+ char ALL-CAPS-or-digit code followed by an unspaced dash.
  // Restricted to uppercase so "Coca-Cola" survives.
  s = s.replace(/^[A-Z0-9]{4,}[-–—]\s*/, "");
  // Strip everything from "C/o" / "C/O" onward (warehouse/3PL handler)
  s = s.replace(/\s+c\s*\/\s*o\b.*$/i, "");
  // Strip warehouse codes like "WH 1827"
  s = s.replace(/\s+wh\s*#?\s*\d+\b.*$/i, "");
  // Strip noisy back-office tails
  s = s.replace(/\s+(freight\s+bill(\s+processing)?|bill\s+processing|attn[:\s].*)$/i, "");
  return s.replace(/\s+/g, " ").trim();
}

// Connector words that stay lowercase in the middle of a multi-word name
// (never lowercased when first or last). "&" and "vs" included for clarity.
const CUSTOMER_LOWERCASE_CONNECTORS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or",
  "the", "to", "vs", "vs.", "with",
]);

/**
 * Title-case an individual word, preserving internal punctuation
 * (hyphens, slashes, apostrophes). E.g. "coca-cola" → "Coca-Cola".
 */
function titleCaseWord(word: string): string {
  return word
    .split(/([-/'])/)
    .map(part => {
      if (part === "-" || part === "/" || part === "'") return part;
      if (!part) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

/**
 * Display-ready customer/account name. Strips the leading TMS code prefix,
 * collapses whitespace, Title Cases the result, and:
 *   • preserves words that are already all-uppercase in the raw input
 *     (e.g. "BAE", "HP", "NAL", "EAE USA", "USA")
 *   • lowercases common connector words ("of", "and", "the", …) when they
 *     fall mid-name (never first or last)
 *   • keeps "c/o" lowercase when present
 *
 * Idempotent: passing already-clean names through is a no-op.
 *
 * Examples:
 *   "bloosaca - bloom energy"              → "Bloom Energy"
 *   "JOHNCTRL - Johnson Controls"          → "Johnson Controls"
 *   "BAEMAACT - BAE Maritime"              → "BAE Maritime"
 *   "EAEUSCFL - EAE USA"                   → "EAE USA"
 *   "HPHOSULP - HP Hood Sulphur Springs"   → "HP Hood Sulphur Springs"
 *   "lactalis american group"              → "Lactalis American Group"
 *   "GROUP OF EIGHT"                       → "Group of Eight"
 *   "CTSI C/O Rheem"                       → "CTSI"   (handler stripped)
 */
export function formatCustomerName(raw: string | null | undefined): string {
  const cleaned = cleanCustomerLabel(raw);
  if (!cleaned) return "";

  const tokens = cleaned.split(/\s+/);
  const last = tokens.length - 1;

  return tokens
    .map((tok, i) => {
      if (!tok) return tok;

      // "c/o" stays lowercase regardless of position.
      if (/^c\s*\/\s*o$/i.test(tok)) return "c/o";

      const lc = tok.toLowerCase();

      // Connector words stay lowercase mid-name only — checked *before* the
      // acronym rule so short upper-case connectors ("OF", "AND", "THE") in a
      // fully-shouted name like "GROUP OF EIGHT" still get lowercased.
      if (i > 0 && i < last && CUSTOMER_LOWERCASE_CONNECTORS.has(lc)) {
        return lc;
      }

      // Preserve all-uppercase short tokens (2–4 letters) as acronyms /
      // abbreviations (BAE, HP, NAL, EAE, USA, NASA). Longer all-caps tokens
      // (e.g. "JOHNSON", "CONTROLS") are treated as shouted text and get
      // title-cased so we don't end up with "JOHNSON Controls".
      // We test *letters only* so trailing punctuation doesn't break detection.
      const letters = tok.replace(/[^A-Za-z]/g, "");
      if (
        letters.length >= 2 &&
        letters.length <= 4 &&
        letters === letters.toUpperCase() &&
        letters !== letters.toLowerCase()
      ) {
        return tok;
      }

      return titleCaseWord(tok);
    })
    .join(" ");
}

/**
 * Converts a decimal loads-per-week value into a human-friendly range string.
 *
 * Examples:
 *   5.10 → "usually 5–7 a week"
 *   2.2  → "around 2–3 a week"
 *   0.9  → "about 1–2 a week"
 *   0.3  → "a few times a month"
 *   10.5 → "10 or more a week"
 */
export function formatWeeklyLoadRange(avgLoadsPerWeek: number | string | null | undefined): string {
  if (avgLoadsPerWeek === null || avgLoadsPerWeek === undefined) return "a few times a week";

  const n = typeof avgLoadsPerWeek === "number" ? avgLoadsPerWeek : parseFloat(String(avgLoadsPerWeek));
  if (isNaN(n)) return "a few times a week";

  if (n < 0.5) return "a few times a month";
  if (n < 1.5) return "about 1–2 a week";
  if (n < 2.5) return "around 2–3 a week";
  if (n < 4) return "around 3–4 a week";
  if (n < 5) return "usually 4–5 a week";
  if (n < 6.5) return "usually 5–7 a week";
  if (n < 8.5) return "usually 6–8 a week";
  if (n < 9.5) return "usually 8–10 a week";
  return `${Math.floor(n)} or more a week`;
}
