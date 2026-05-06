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

import { formatLaneLocation, formatLaneDisplay, formatWeeklyLoadRange, normalizeEquipmentType, cleanCustomerLabel, formatCustomerName } from "../shared/laneFormatters";
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

// ── cleanCustomerLabel ────────────────────────────────────────────────────────

console.log("\n── cleanCustomerLabel ───────────────────────────────────────────────\n");

assertEqual(
  "uppercase TMS code stripped",
  cleanCustomerLabel("VERTFOFL - Vertiv Mexico"),
  "Vertiv Mexico",
);
assertEqual(
  "lowercase TMS code stripped",
  cleanCustomerLabel("bloosaca - bloom energy"),
  "bloom energy",
);
assertEqual(
  "C/O handler tail stripped",
  cleanCustomerLabel("CTSIMIGA - CTSI C/o Rheem WH 1827"),
  "CTSI",
);
assertEqual(
  "uppercase C/O tail stripped + freight bill noise removed",
  cleanCustomerLabel("MOTTNOMI - MOTTS C/O RYDER FREIGHT BILL PROCESSING"),
  "MOTTS",
);
assertEqual(
  "Coca-Cola is not mangled (no whitespace around dash)",
  cleanCustomerLabel("Coca-Cola"),
  "Coca-Cola",
);
assertEqual(
  "name without code prefix is left alone",
  cleanCustomerLabel("Food In Transit"),
  "Food In Transit",
);
assertEqual("null safe", cleanCustomerLabel(null), "");
assertEqual("undefined safe", cleanCustomerLabel(undefined), "");
assertEqual("empty string safe", cleanCustomerLabel("   "), "");

// ── formatCustomerName ────────────────────────────────────────────────────────

console.log("\n── formatCustomerName ───────────────────────────────────────────────\n");

assertEqual(
  '"bloosaca - bloom energy" → "Bloom Energy"',
  formatCustomerName("bloosaca - bloom energy"),
  "Bloom Energy",
);
assertEqual(
  '"BAEMAACT - BAE Maritime" → "BAE Maritime" (acronym preserved)',
  formatCustomerName("BAEMAACT - BAE Maritime"),
  "BAE Maritime",
);
assertEqual(
  '"EAEUSCFL - EAE USA" → "EAE USA"',
  formatCustomerName("EAEUSCFL - EAE USA"),
  "EAE USA",
);
assertEqual(
  '"HPHOSULP - HP Hood Sulphur Springs" → "HP Hood Sulphur Springs"',
  formatCustomerName("HPHOSULP - HP Hood Sulphur Springs"),
  "HP Hood Sulphur Springs",
);
assertEqual(
  '"NALCWHIN - NAL Cargo" → "NAL Cargo"',
  formatCustomerName("NALCWHIN - NAL Cargo"),
  "NAL Cargo",
);
assertEqual(
  '"GROUP OF EIGHT" → "Group of Eight" (connector lowercased mid-name)',
  formatCustomerName("GROUP OF EIGHT"),
  "Group of Eight",
);
assertEqual(
  '"the museum of art and design" → connectors lowercased, edges title-cased',
  formatCustomerName("the museum of art and design"),
  "The Museum of Art and Design",
);
assertEqual(
  '"Coca-Cola" → "Coca-Cola" (hyphenated)',
  formatCustomerName("Coca-Cola"),
  "Coca-Cola",
);
assertEqual(
  '"lactalis american group" → "Lactalis American Group"',
  formatCustomerName("lactalis american group"),
  "Lactalis American Group",
);
assertEqual(
  'idempotent — already-clean name passes through unchanged',
  formatCustomerName(formatCustomerName("BAEMAACT - BAE Maritime")),
  "BAE Maritime",
);
assertEqual(
  '"CTSI C/O Rheem" → "CTSI" (handler tail stripped first)',
  formatCustomerName("CTSI C/O Rheem"),
  "CTSI",
);
assertEqual("null safe", formatCustomerName(null), "");
assertEqual("undefined safe", formatCustomerName(undefined), "");
assertEqual(
  "collapses extra whitespace",
  formatCustomerName("  bloosaca  -  bloom    energy  "),
  "Bloom Energy",
);

// Unspaced uppercase code prefix (e.g. CSV exports without padding)
assertEqual(
  "ALL-CAPS code with unspaced dash is stripped",
  cleanCustomerLabel("VERTFOFL-Vertiv Mexico"),
  "Vertiv Mexico",
);
assertEqual(
  "ALL-CAPS code with unspaced dash → formatted",
  formatCustomerName("VERTFOFL-Vertiv Mexico"),
  "Vertiv Mexico",
);
assertEqual(
  "Mixed-case unspaced prefix is NOT stripped (Coca-Cola survives)",
  formatCustomerName("Coca-Cola"),
  "Coca-Cola",
);
assertEqual(
  "Mixed-case unspaced 'Bloosaca-bloom' survives (no whitespace, not all-caps)",
  formatCustomerName("Bloosaca-bloom Energy"),
  "Bloosaca-Bloom Energy",
);

// Curated corporate-suffix / brand-acronym allow-list — should override both
// the default title-case fallback and the 4-letter all-caps acronym cap.
// These cases come from real customer source rows where the suffix arrives
// either mixed-case ("Brooklyn Bedding Llc") or fully shouted
// ("BROOKLYN BEDDING LLC"). Both should normalize to "Brooklyn Bedding LLC".
assertEqual(
  'mixed-case suffix — "brooklyn bedding llc" → "Brooklyn Bedding LLC"',
  formatCustomerName("brooklyn bedding llc"),
  "Brooklyn Bedding LLC",
);
assertEqual(
  'shouted suffix — "BROOKLYN BEDDING LLC" → "Brooklyn Bedding LLC"',
  formatCustomerName("BROOKLYN BEDDING LLC"),
  "Brooklyn Bedding LLC",
);
assertEqual(
  'mixed-case "Brooklyn Bedding Llc" → "Brooklyn Bedding LLC"',
  formatCustomerName("Brooklyn Bedding Llc"),
  "Brooklyn Bedding LLC",
);
assertEqual(
  'suffix "Inc" — "acme widgets inc" → "Acme Widgets INC"',
  formatCustomerName("acme widgets inc"),
  "Acme Widgets INC",
);
assertEqual(
  'suffix "Corp" — "acme corp" → "Acme CORP"',
  formatCustomerName("acme corp"),
  "Acme CORP",
);
assertEqual(
  'suffix "Ltd" — "smith holdings ltd" → "Smith Holdings LTD"',
  formatCustomerName("smith holdings ltd"),
  "Smith Holdings LTD",
);
assertEqual(
  'suffix "Pllc" — "acme legal pllc" → "Acme Legal PLLC"',
  formatCustomerName("acme legal pllc"),
  "Acme Legal PLLC",
);
assertEqual(
  'suffix "LP" — "smith capital lp" → "Smith Capital LP"',
  formatCustomerName("smith capital lp"),
  "Smith Capital LP",
);
assertEqual(
  'suffix with trailing period — "Acme Inc." → "Acme INC." (period preserved)',
  formatCustomerName("Acme Inc."),
  "Acme INC.",
);

// Brand acronyms longer than the 4-letter all-caps cap. Without the
// allow-list, "usps" / "Fedex" would title-case to "Usps" / "Fedex".
assertEqual(
  'brand acronym — "usps logistics" → "USPS Logistics"',
  formatCustomerName("usps logistics"),
  "USPS Logistics",
);
assertEqual(
  'brand acronym — "Fedex Freight" → "FEDEX Freight"',
  formatCustomerName("Fedex Freight"),
  "FEDEX Freight",
);
assertEqual(
  'shouted brand acronym — "FEDEX FREIGHT" → "FEDEX Freight"',
  formatCustomerName("FEDEX FREIGHT"),
  "FEDEX Freight",
);

// Idempotency for the new allow-list cases — running the formatter twice
// must yield the same result.
assertEqual(
  'idempotent — "Brooklyn Bedding LLC" passes through unchanged',
  formatCustomerName(formatCustomerName("brooklyn bedding llc")),
  "Brooklyn Bedding LLC",
);
assertEqual(
  'idempotent — "BROOKLYN BEDDING LLC" stable after second pass',
  formatCustomerName(formatCustomerName("BROOKLYN BEDDING LLC")),
  "Brooklyn Bedding LLC",
);
assertEqual(
  'idempotent — "USPS Logistics" stable after second pass',
  formatCustomerName(formatCustomerName("usps logistics")),
  "USPS Logistics",
);
assertEqual(
  'idempotent — "Acme INC." stable after second pass',
  formatCustomerName(formatCustomerName("Acme Inc.")),
  "Acme INC.",
);

// Edit Lane dialog seed: when the dialog opens with a raw item.companyName,
// the editForm.companyName state should be the cleaned, display-ready label.
// This mirrors the seeding logic in client/src/pages/lane-work-queue.tsx so
// users see "Bloom Energy" in the input — not "BLOOSACA - bloom energy".
assertEqual(
  "Edit Lane dialog seeds with formatted name (TMS prefix stripped)",
  formatCustomerName("BLOOSACA - bloom energy"),
  "Bloom Energy",
);
assertEqual(
  "Edit Lane dialog handles null companyName via ?? '' fallback",
  formatCustomerName(null ?? ""),
  "",
);
assertEqual(
  "Edit Lane dialog: already-clean name passes through unchanged",
  formatCustomerName("Bloom Energy"),
  "Bloom Energy",
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  process.exit(1);
}
