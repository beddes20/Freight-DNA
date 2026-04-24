/**
 * Unit + integration tests for lane outreach email generation.
 *
 * Covers:
 *   - formatLaneLocation: title-casing, state uppercasing, duplicate-state collapse
 *   - formatWeeklyLoadRange: decimal-to-range conversion and edge cases
 *   - normalizeEquipmentType: code → human-readable mapping
 *   - buildFallbackEmail: no banned phrases, no raw decimals, no false relationships,
 *     correct lane display, correct volume phrasing
 *
 * Run with: npx tsx tests/lane-formatters.test.ts
 */

import { formatLaneLocation, formatLaneDisplay, formatWeeklyLoadRange, normalizeEquipmentType } from "../shared/laneFormatters";
import { buildFallbackEmail } from "../server/laneOutreachEmailBuilder";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    failed++;
  }
}

function assertEqual(description: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}\n    expected: "${expected}"\n    got:      "${actual}"`);
    failed++;
  }
}

// ── formatLaneLocation ────────────────────────────────────────────────────────

console.log("\n── formatLaneLocation ────────────────────────────────────────────────\n");

assertEqual("city + state → title-case city, uppercase state", formatLaneLocation("Macon", "GA"), "Macon, GA");
assertEqual("lowercase city title-cased", formatLaneLocation("marietta", "PA"), "Marietta, PA");
assertEqual("multi-word city", formatLaneLocation("new york", "NY"), "New York, NY");
assertEqual("lowercase state uppercased", formatLaneLocation("Dallas", "tx"), "Dallas, TX");
assertEqual("no state returns city only", formatLaneLocation("Chicago", null), "Chicago");
assertEqual("undefined state returns city only", formatLaneLocation("Chicago", undefined), "Chicago");

assertEqual(
  'city "Macon, GA" + state "GA" → "Macon, GA" (no duplication)',
  formatLaneLocation("Macon, GA", "GA"),
  "Macon, GA",
);
assertEqual(
  'city "CHICAGO, IL" + state "IL" → "Chicago, IL" (no duplication)',
  formatLaneLocation("CHICAGO, IL", "IL"),
  "Chicago, IL",
);
assertEqual(
  'city "macon, ga" + state "GA" → "Macon, GA"',
  formatLaneLocation("macon, ga", "GA"),
  "Macon, GA",
);

assert('result never contains "GA, GA"', !formatLaneLocation("Macon, GA", "GA").includes("GA, GA"));

// Hyphenated city names — must preserve the hyphen and title-case both
// segments. Common in NC, FL, MN. Pre-fix the formatter would emit
// "Winston-salem" (only first char capitalized) or "Winston Salem" (hyphen
// dropped). Both are wrong for the Available Loads board.
assertEqual('hyphenated city — "winston-salem"', formatLaneLocation("winston-salem", "NC"), "Winston-Salem, NC");
assertEqual('hyphenated city — "WINSTON-SALEM" uppercase', formatLaneLocation("WINSTON-SALEM", "NC"), "Winston-Salem, NC");
assertEqual('hyphenated city — "wilkes-barre"', formatLaneLocation("wilkes-barre", "PA"), "Wilkes-Barre, PA");
assertEqual('triple-segment hyphenated city', formatLaneLocation("port-au-prince", null), "Port-Au-Prince");

// "St." / "Mt." abbreviations remain title-cased on the period segment.
assertEqual('"st. louis" → "St. Louis"', formatLaneLocation("st. louis", "MO"), "St. Louis, MO");
assertEqual('"mt. pleasant" → "Mt. Pleasant"', formatLaneLocation("mt. pleasant", "SC"), "Mt. Pleasant, SC");

// Apostrophe handling — names like O'Fallon should capitalize after the
// apostrophe rather than collapsing to "O'fallon".
assertEqual('"o\'fallon" → "O\'Fallon"', formatLaneLocation("o'fallon", "MO"), "O'Fallon, MO");

// Null-safety: callers pass nullable load_fact / freight_opportunity columns
// directly. Must never throw — return the bare state (when present) or "".
assertEqual('null city + state → bare state', formatLaneLocation(null, "GA"), "GA");
assertEqual('undefined city + state → bare state', formatLaneLocation(undefined, "ga"), "GA");
assertEqual('null city + null state → empty string', formatLaneLocation(null, null), "");
assertEqual('empty city + state → bare state', formatLaneLocation("", "GA"), "GA");
assertEqual('whitespace city + state → bare state', formatLaneLocation("   ", "GA"), "GA");
assertEqual('whitespace city + null state → empty string', formatLaneLocation("   ", null), "");

// ── formatLaneDisplay ─────────────────────────────────────────────────────────

console.log("\n── formatLaneDisplay ────────────────────────────────────────────────\n");

assertEqual(
  "standard origin → destination",
  formatLaneDisplay("Macon", "GA", "Marietta", "PA"),
  "Macon, GA → Marietta, PA",
);
assertEqual(
  "lowercase inputs normalized",
  formatLaneDisplay("chicago", "il", "dallas", "TX"),
  "Chicago, IL → Dallas, TX",
);
assertEqual(
  "no states",
  formatLaneDisplay("Chicago", null, "Dallas", null),
  "Chicago → Dallas",
);
assert(
  'bare 2-letter state code as city is uppercased, not title-cased — "ga" → "GA" not "Ga"',
  formatLaneDisplay("Macon", "GA", "ga", null) === "Macon, GA → GA" &&
  !formatLaneDisplay("Macon", "GA", "ga", null).endsWith("→ Ga"),
);

// ── formatWeeklyLoadRange ─────────────────────────────────────────────────────

console.log("\n── formatWeeklyLoadRange ────────────────────────────────────────────\n");

assertEqual("5.10 → 'usually 5–7 a week'", formatWeeklyLoadRange(5.10), "usually 5–7 a week");
assertEqual("2.2  → 'around 2–3 a week'",  formatWeeklyLoadRange(2.2),  "around 2–3 a week");
assertEqual("0.9  → 'about 1–2 a week'",   formatWeeklyLoadRange(0.9),  "about 1–2 a week");
assertEqual("0.3  → 'a few times a month'", formatWeeklyLoadRange(0.3), "a few times a month");
assertEqual("10.5 → '10 or more a week'",  formatWeeklyLoadRange(10.5), "10 or more a week");
assertEqual("3.5  → 'around 3–4 a week'",  formatWeeklyLoadRange(3.5),  "around 3–4 a week");
assertEqual("null → 'a few times a week'",  formatWeeklyLoadRange(null), "a few times a week");
assertEqual("string '3.5' → 'around 3–4 a week'", formatWeeklyLoadRange("3.5"), "around 3–4 a week");

assert("no decimal digits in 5.10 output", !formatWeeklyLoadRange(5.10).match(/\d+\.\d+/));

// ── normalizeEquipmentType ────────────────────────────────────────────────────

console.log("\n── normalizeEquipmentType ───────────────────────────────────────────\n");

assertEqual('"dv" → "dry van"',      normalizeEquipmentType("dv"),       "dry van");
assertEqual('"van" → "dry van"',     normalizeEquipmentType("van"),      "dry van");
assertEqual('"po" → "dry van"',      normalizeEquipmentType("po"),       "dry van");
assertEqual('"rf" → "reefer"',       normalizeEquipmentType("rf"),       "reefer");
assertEqual('"flat" → "flatbed"',    normalizeEquipmentType("flat"),     "flatbed");
assertEqual('"dry van" passthrough', normalizeEquipmentType("dry van"),  "dry van");
assertEqual('"reefer" passthrough',  normalizeEquipmentType("reefer"),   "reefer");
assertEqual('null → "dry van"',      normalizeEquipmentType(null),       "dry van");
assert('"po" never surfaces as raw code', normalizeEquipmentType("po") !== "po");

// ── buildFallbackEmail: banned phrases ────────────────────────────────────────

console.log("\n── buildFallbackEmail: banned phrases ───────────────────────────────\n");

const ALL_BANNED = [
  "carrier bench",
  "we value our relationship",
  "building our carrier bench",
  "ongoing coverage",
  "reaching out about",
  "love to connect",
  "i'd love to",
  "would love to",
  "top of mind",
  "lane runs consistently",
  "this lane runs consistently",
  "keep you in mind",
  "averaging",
  "corridor",
];

const laneDisp  = formatLaneDisplay("Macon", "GA", "Marietta", "PA");
const loadRng   = formatWeeklyLoadRange(5.1);
const equipment = normalizeEquipmentType("dv");

// new-prospect (hasVerifiedHistory = false)
const newProspectEmail = buildFallbackEmail("FastHaul LLC", false, laneDisp, equipment, loadRng, "lane_building");
// known carrier (hasVerifiedHistory = true)
const knownCarrierEmail = buildFallbackEmail("TruckCo", true, laneDisp, equipment, loadRng, "lane_building");
// immediate + lane mode
const immediateEmail = buildFallbackEmail("ImmediateCo", false, laneDisp, equipment, loadRng, "immediate_plus_lane");

for (const phrase of ALL_BANNED) {
  assert(
    `new-prospect email: banned phrase absent — "${phrase}"`,
    !newProspectEmail.toLowerCase().includes(phrase.toLowerCase()),
  );
  assert(
    `known-carrier email: banned phrase absent — "${phrase}"`,
    !knownCarrierEmail.toLowerCase().includes(phrase.toLowerCase()),
  );
  assert(
    `immediate-mode email: banned phrase absent — "${phrase}"`,
    !immediateEmail.toLowerCase().includes(phrase.toLowerCase()),
  );
}

// ── buildFallbackEmail: structural checks ─────────────────────────────────────

console.log("\n── buildFallbackEmail: structural checks ────────────────────────────\n");

assert(
  "new-prospect: no raw decimal in body",
  !newProspectEmail.match(/\d+\.\d+\s*(loads|per|\/)/i),
);
assert(
  "known-carrier: no raw decimal in body",
  !knownCarrierEmail.match(/\d+\.\d+\s*(loads|per|\/)/i),
);
assert(
  "lane display present in new-prospect email (City, ST → City, ST)",
  newProspectEmail.includes("Macon, GA → Marietta, PA"),
);
assert(
  "lane display has no duplicate state — no 'GA, GA'",
  !newProspectEmail.includes("GA, GA"),
);
assert(
  "new-prospect: no false prior-relationship claim",
  !newProspectEmail.toLowerCase().includes("we've run freight together") &&
  !newProspectEmail.toLowerCase().includes("worked together before") &&
  !newProspectEmail.toLowerCase().includes("run freight together"),
);
assert(
  "known-carrier: no false prior-relationship claim phrasing",
  !knownCarrierEmail.toLowerCase().includes("run freight together before"),
);
assert(
  "immediate-mode email contains load urgency note",
  immediateEmail.toLowerCase().includes("load coming up") ||
  immediateEmail.toLowerCase().includes("immediate load"),
);
assert(
  "new-prospect ends with operational ask",
  newProspectEmail.includes("Does that fit your network") ||
  newProspectEmail.includes("I'd be glad to talk through it"),
);
assert(
  "new-prospect: volume phrase present without leading adverb duplication",
  !newProspectEmail.includes("usually usually") &&
  !newProspectEmail.includes("around around") &&
  !newProspectEmail.includes("about about"),
);

// ── buildFallbackEmail: equipment normalization flows through ─────────────────

console.log("\n── buildFallbackEmail: equipment normalization ──────────────────────\n");

const poEmail = buildFallbackEmail("TestCo", false, laneDisp, normalizeEquipmentType("po"), loadRng, "lane_building");
assert(
  '"po" equipment type does not appear as raw code in email body',
  !poEmail.toLowerCase().includes(" po ") && !poEmail.toLowerCase().includes(" po freight"),
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  process.exit(1);
}
