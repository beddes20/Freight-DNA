/**
 * Guardrails — Static Analysis Regression Tests
 *
 * Purpose: Catch the exact failure modes that happened over the last 3 days
 * before they reach production again. These tests read actual source files
 * and assert constraints on their content. They do NOT test runtime behavior;
 * they enforce structural invariants.
 *
 * Failure modes this guards against:
 *   1. Renamed helper used at missed call site (timeAgo → formatTimeAgo, Task #158)
 *   2. Banned phrases re-introduced in any fallback or AI prompt (Task #166)
 *   3. A parallel/duplicate fallback implementation created outside the canonical file
 *   4. isKnown = !!carrierId logic re-introduced (false relationship claims)
 *   5. Raw lane strings or equipment codes in email-generation paths
 *
 * Run with: npx tsx tests/guardrails.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

function containsPattern(content: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") return content.toLowerCase().includes(pattern.toLowerCase());
  return pattern.test(content);
}

// ── 1. Stale helper call-site check (timeAgo → formatTimeAgo) ─────────────────
// Ensures no file still calls the old timeAgo() function that was renamed.
// This is the exact check that would have caught the Task #158 crash.

console.log("\n── 1. Stale call-site: timeAgo() must not be called anywhere ────────\n");

const CLIENT_SRC = "client/src";
function walkTs(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) results.push(...walkTs(rel));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) results.push(rel);
  }
  return results;
}

const clientFiles = walkTs(CLIENT_SRC);
const staleTimeAgoCalls: string[] = [];

for (const file of clientFiles) {
  const content = readFile(file);
  // Match timeAgo( but NOT formatTimeAgo(
  if (/(?<!format)timeAgo\s*\(/.test(content)) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (/(?<!format)timeAgo\s*\(/.test(line)) {
        staleTimeAgoCalls.push(`${file}:${i + 1} — ${line.trim()}`);
      }
    });
  }
}

assert(
  "No file calls the old timeAgo() helper (must use formatTimeAgo)",
  staleTimeAgoCalls.length === 0,
  staleTimeAgoCalls.length > 0 ? `Stale calls found:\n    ${staleTimeAgoCalls.join("\n    ")}` : undefined,
);

// ── 2. Banned phrases in the server fallback (laneOutreachEmailBuilder.ts) ────
// The canonical fallback must never contain these phrases.

console.log("\n── 2. Server fallback — banned phrases absent ───────────────────────\n");

const BUILDER = "server/laneOutreachEmailBuilder.ts";
const builderContent = readFile(BUILDER);

const BANNED_IN_OUTPUT = [
  "carrier bench",
  "we value our relationship",
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
  // Banned in actual email body generation (not in comments/jsdoc)
];

// Strip JSDoc comments before checking (comments can mention banned phrases for documentation)
const builderStripped = builderContent.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

for (const phrase of BANNED_IN_OUTPUT) {
  assert(
    `${BUILDER}: banned phrase absent — "${phrase}"`,
    !containsPattern(builderStripped, phrase),
  );
}

// The fallback must NOT use "corridor" after a lane display
assert(
  `${BUILDER}: fallback does not append "corridor" after lane display`,
  !builderStripped.toLowerCase().includes("corridor"),
);

// ── 3. AI prompt constructive phrasing checks (laneCarrierOutreach.ts) ───────
// These checks look for phrases that, if present, would instruct or enable the AI
// to generate bad copy. The banned phrases SHOULD appear in the BANNED list inside
// the prompt — that's correct. What must NOT appear is a positive instruction or
// example that uses them (e.g. "invite them to connect by saying 'I'd love to'").

console.log("\n── 3. Route AI prompt — no positive instructions using banned phrases ─\n");

const ROUTE = "server/routes/laneCarrierOutreach.ts";
const routeContent = readFile(ROUTE);
const routeStripped = routeContent.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

// These specific phrases must NEVER appear even as examples — they are the ones
// the AI was copying verbatim when they were used as "example good phrasing".
// "i'd still love to connect" is intentionally NOT in this list — it appears in the prompt
// only as a PROHIBITED example ("not 'I'd still love to connect'"), which is correct.
const MUST_NOT_BE_EXEMPLIFIED = [
  "love to be on your radar",      // was in the prompt as a positive example (AI copied it verbatim)
  "Even if you don't have a truck available this week, I'd still love to connect",
];

for (const phrase of MUST_NOT_BE_EXEMPLIFIED) {
  assert(
    `${ROUTE}: phrase not used as a positive example in prompt — "${phrase}"`,
    !containsPattern(routeStripped, phrase),
  );
}

// The prompt must explicitly list banned phrases (the BANNED block)
assert(
  `${ROUTE}: AI prompt explicitly bans "carrier bench" phrase`,
  routeContent.includes("carrier bench"),
);
assert(
  `${ROUTE}: AI prompt explicitly bans "love to connect" phrase`,
  routeContent.includes("love to connect"),
);
assert(
  `${ROUTE}: AI prompt explicitly bans "top of mind" phrase`,
  routeContent.includes("top of mind"),
);

// The prompt must NOT have the structure instruction that caused false relationship claims
// "If this is a known carrier, reference that you've run freight together before" was the old form
assert(
  `${ROUTE}: prompt does not have old unconditional "run freight together before" instruction`,
  !routeContent.includes("If this is a known carrier, reference that you've run freight together before"),
);

// The prompt must not use "corridor" as a descriptive term for the lane
// (it IS used in modeNote where "corridor" could appear for the immediate_plus_lane note,
// but must not be a core part of the lane description itself)
const promptMatch = routeContent.match(/const prompt = `([\s\S]*?)`;/);
if (promptMatch) {
  const promptText = promptMatch[1];
  // "corridor" must not appear standalone as lane descriptor OUTSIDE the BANNED section
  const bannedSectionMatch = promptText.match(/BANNED[^`]*/i);
  const outsideBanned = bannedSectionMatch
    ? promptText.replace(bannedSectionMatch[0], "")
    : promptText;
  assert(
    `${ROUTE}: AI prompt does not use "corridor" as standalone lane descriptor`,
    !/(the\s+)?[\w,\s]+corridor/i.test(outsideBanned.replace(/\bLane:\s*\${laneDisplay}\b/g, "")),
  );
}

// ── 4. isKnown = !!carrierId must not be used (false relationship claims) ────

console.log("\n── 4. Relationship history logic — no isKnown = !!carrierId ────────\n");

assert(
  `${ROUTE}: isKnown = !!carrierId pattern is not present (use hasVerifiedHistory)`,
  !routeStripped.includes("isKnown = !!carrierId") &&
  !routeStripped.includes("isKnown=!!carrierId"),
);

assert(
  `${ROUTE}: hasVerifiedHistory or payeeCode used for relationship gate`,
  routeStripped.includes("hasVerifiedHistory") || routeStripped.includes("payeeCode"),
);

// The prompt must not unconditionally instruct "reference that you've run freight together"
assert(
  `${ROUTE}: prompt does not unconditionally instruct prior-haul claim`,
  !routeContent.includes("If this is a known carrier, reference that you've run freight together before"),
);

// ── 5. Client-side fallbackBody in CarrierOutreachPanel must not have banned phrases ──

console.log("\n── 5. Client fallbackBody — banned phrases absent ───────────────────\n");

const PANEL = "client/src/components/CarrierOutreachPanel.tsx";
const panelContent = readFile(PANEL);

// Find the fallbackBody assignment specifically
const fallbackBodyMatch = panelContent.match(/const\s+fallbackBody\s*=\s*`([^`]*)`/s);
if (fallbackBodyMatch) {
  const bodyText = fallbackBodyMatch[1];
  for (const phrase of BANNED_IN_OUTPUT) {
    assert(
      `${PANEL} fallbackBody: banned phrase absent — "${phrase}"`,
      !containsPattern(bodyText, phrase),
    );
  }
  assert(
    `${PANEL} fallbackBody: no "corridor" appended after lane`,
    !bodyText.toLowerCase().includes("corridor"),
  );
} else {
  assert(
    `${PANEL}: fallbackBody const found (no template literal fallback means it uses server draft)`,
    true,
  );
}

// Panel must NOT have a second raw inline "we've run freight together" type claim outside the fallback
const panelStripped = panelContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
assert(
  `${PANEL}: no stale "love to connect" copy in any inline string`,
  !containsPattern(panelStripped, "love to connect"),
);
assert(
  `${PANEL}: no stale "top of mind" copy in any inline string`,
  !containsPattern(panelStripped, "top of mind"),
);
assert(
  `${PANEL}: no stale "lane runs consistently" copy in any inline string`,
  !containsPattern(panelStripped, "lane runs consistently"),
);

// ── 6. No dead-code duplicate of buildFallbackEmail in the route file ────────

console.log("\n── 6. No duplicate buildFallbackEmail / formatLaneDisplay in route ─\n");

// Count function definitions of these names. If > 0 in the route file, we have dead code
// that conflicts with the canonical import.
const localBuildFallbackCount = (routeContent.match(/^function buildFallbackEmail/gm) || []).length;
const localFormatLaneCount    = (routeContent.match(/^function formatLaneDisplay/gm) || []).length;
const localHumanLoadCount     = (routeContent.match(/^function humanLoadVolume/gm) || []).length;

assert(
  `${ROUTE}: no local buildFallbackEmail function (use imported version)`,
  localBuildFallbackCount === 0,
  localBuildFallbackCount > 0 ? `Found ${localBuildFallbackCount} local definition(s) — dead code conflicting with import` : undefined,
);

assert(
  `${ROUTE}: no local formatLaneDisplay function (use imported version)`,
  localFormatLaneCount === 0,
  localFormatLaneCount > 0 ? `Found ${localFormatLaneCount} local definition(s) — dead code conflicting with import` : undefined,
);

assert(
  `${ROUTE}: no local humanLoadVolume function (removed in edbaed9)`,
  localHumanLoadCount === 0,
);

// ── 7. Canonical imports are in place ────────────────────────────────────────

console.log("\n── 7. Canonical imports are in place ────────────────────────────────\n");

assert(
  `${ROUTE}: imports formatLaneDisplay from laneOutreachEmailBuilder`,
  routeContent.includes("formatLaneDisplay") && routeContent.includes("laneOutreachEmailBuilder"),
);

assert(
  `${ROUTE}: imports normalizeEquipmentType`,
  routeContent.includes("normalizeEquipmentType"),
);

assert(
  `${BUILDER}: exports buildFallbackEmail`,
  builderContent.includes("export function buildFallbackEmail"),
);

assert(
  `${PANEL}: imports formatLaneDisplay from @shared/laneFormatters`,
  panelContent.includes("formatLaneDisplay") && panelContent.includes("laneFormatters"),
);

// ── 8. formatTimeAgo is imported where needed in ActivityTab ─────────────────

console.log("\n── 8. ActivityTab uses formatTimeAgo (not timeAgo) ──────────────────\n");

const ACTIVITY_TAB = "client/src/pages/company-detail/tabs/ActivityTab.tsx";
const activityContent = readFile(ACTIVITY_TAB);

assert(
  `${ACTIVITY_TAB}: imports formatTimeAgo`,
  activityContent.includes("formatTimeAgo"),
);

assert(
  `${ACTIVITY_TAB}: does not call old timeAgo()`,
  !/(?<!format)timeAgo\s*\(/.test(activityContent),
);

// Specifically verify the previously-crashed section (touchpoint history)
const touchpointSection = activityContent.match(/tp\.loggedByName[\s\S]{0,200}tp\.(createdAt|date)/);
if (touchpointSection) {
  assert(
    `${ACTIVITY_TAB}: touchpoint history section uses formatTimeAgo (not old timeAgo)`,
    !(/(?<!format)timeAgo/.test(touchpointSection[0])),
  );
} else {
  assert(
    `${ACTIVITY_TAB}: touchpoint history section exists`,
    activityContent.includes("tp.loggedByName"),
  );
}

// ── 9. Shared formatter exports are stable ────────────────────────────────────

console.log("\n── 9. shared/laneFormatters.ts — exports are stable ─────────────────\n");

const FORMATTERS = "shared/laneFormatters.ts";
const formattersContent = readFile(FORMATTERS);

assert(
  `${FORMATTERS}: exports formatLaneDisplay`,
  formattersContent.includes("export function formatLaneDisplay"),
);

assert(
  `${FORMATTERS}: exports formatWeeklyLoadRange`,
  formattersContent.includes("export function formatWeeklyLoadRange"),
);

assert(
  `${FORMATTERS}: exports normalizeEquipmentType`,
  formattersContent.includes("export function normalizeEquipmentType"),
);

assert(
  `${FORMATTERS}: exports formatLaneLocation`,
  formattersContent.includes("export function formatLaneLocation"),
);

// normalizeEquipmentType must map "po" to a human value (not return "po")
assert(
  `${FORMATTERS}: normalizeEquipmentType maps "po" (raw TMS code) to a real equipment name`,
  formattersContent.includes('"po"') && formattersContent.includes("dry van"),
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  failures.forEach(f => console.error(`  • ${f}`));
  console.error("\nReview the guardrails in replit.md and the canonical commits listed there.");
  process.exit(1);
} else {
  console.log("\nAll guardrails pass. High-risk shared surfaces are in a clean state.\n");
}
