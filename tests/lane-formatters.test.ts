/**
 * Unit tests for shared/laneFormatters.ts and server/laneOutreachEmailBuilder.ts
 *
 * Covers:
 *   - formatLaneLocation: title-casing, state uppercasing, duplicate-state collapse
 *   - formatWeeklyLoadRange: decimal-to-range conversion and edge cases
 *   - buildFallbackEmail: no banned phrases, no raw decimal averages, no duplicate states
 *
 * Run with: npx tsx tests/lane-formatters.test.ts
 */

import { formatLaneLocation, formatLaneDisplay, formatWeeklyLoadRange } from "../shared/laneFormatters";
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
    console.error(`  ✗ ${description} — expected "${expected}", got "${actual}"`);
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

// Duplicate-state collapse: city already embeds the state abbreviation
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

assert(
  'result never contains "GA, GA"',
  !formatLaneLocation("Macon, GA", "GA").includes("GA, GA"),
);

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

// ── formatWeeklyLoadRange ─────────────────────────────────────────────────────

console.log("\n── formatWeeklyLoadRange ────────────────────────────────────────────\n");

assertEqual("5.10 → 'usually 5–7 a week'", formatWeeklyLoadRange(5.10), "usually 5–7 a week");
assertEqual("2.2  → 'around 2–3 a week'",  formatWeeklyLoadRange(2.2),  "around 2–3 a week");
assertEqual("0.9  → 'about 1–2 a week'",   formatWeeklyLoadRange(0.9),  "about 1–2 a week");
assertEqual("0.3  → 'a few times a month'", formatWeeklyLoadRange(0.3),  "a few times a month");
assertEqual("10.5 → '10 or more a week'",  formatWeeklyLoadRange(10.5), "10 or more a week");
assertEqual("3.5  → 'around 3–4 a week'",  formatWeeklyLoadRange(3.5),  "around 3–4 a week");
assertEqual("null → 'a few times a week'",  formatWeeklyLoadRange(null), "a few times a week");
assertEqual("string '3.5' → 'around 3–4 a week'", formatWeeklyLoadRange("3.5"), "around 3–4 a week");

assert("no decimal digits in 5.10 output", !formatWeeklyLoadRange(5.10).match(/\d+\.\d+/));

// ── buildFallbackEmail: no banned phrases ─────────────────────────────────────

console.log("\n── buildFallbackEmail: no banned phrases ────────────────────────────\n");

const BANNED_PHRASES = [
  "we value our relationship",
  "building our carrier bench",
  "carrier bench",
  "averaging",
  "ongoing coverage",
];

const laneDisp = formatLaneDisplay("Macon", "GA", "Marietta", "PA");
const loadRng  = formatWeeklyLoadRange(5.1);

const knownEmail    = buildFallbackEmail("FastHaul", true,  laneDisp, "dry van", loadRng, "lane_building");
const newEmail      = buildFallbackEmail("NewCo LLC", false, laneDisp, "reefer",  loadRng, "immediate_plus_lane");

for (const phrase of BANNED_PHRASES) {
  assert(
    `known-carrier email: no banned phrase "${phrase}"`,
    !knownEmail.toLowerCase().includes(phrase.toLowerCase()),
  );
  assert(
    `new-prospect email: no banned phrase "${phrase}"`,
    !newEmail.toLowerCase().includes(phrase.toLowerCase()),
  );
}

assert("known email: no raw decimal average", !knownEmail.match(/\d+\.\d+\s*(loads|per)/i));
assert("new email: no raw decimal average",   !newEmail.match(/\d+\.\d+\s*(loads|per)/i));
assert(
  "lane display correct in known email (no duplicate state)",
  knownEmail.includes("Macon, GA → Marietta, PA") && !knownEmail.includes("GA, GA"),
);
assert("immediate_plus_lane mode note present in new email", newEmail.includes("load coming up"));

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  process.exit(1);
}
