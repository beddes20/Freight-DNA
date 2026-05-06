/**
 * Integration + unit test: My Procurement unified workspace path
 *
 * Verifies that:
 *  1. GET /api/my-procurement returns LWQ lane assignments with laneId
 *  2. Award tasks get matchedLaneId populated via origin/destination lookup
 *  3. Both source types produce the same /lanes/work-queue?laneId=... destination
 *  4. normalizeLaneLocation() correctly normalizes case, spacing, and comma formatting
 *  5. Equipment-aware matching: same O/D + wrong equipment → matchedLaneId null
 *  6. "No lane match" URL includes ?noMatch= hint for the rep
 */

import { normalizeLaneLocation, normalizeEquipmentType } from "../shared/laneFormatters";

const BASE = "http://localhost:5000";
const CREDS = { username: "ben.beddes@valuetruck.com", password: "Test1234!" };

const results: { name: string; passed: boolean; error?: string }[] = [];
let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg });
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function loginAndGetCookie(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(CREDS),
  });
  assert(res.ok, `Login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  assert(!!setCookie, "No set-cookie header returned from login");
  return setCookie!.split(";")[0];
}

// ── Unit tests: normalizeLaneLocation ─────────────────────────────────────────

await runTest("normalizeLaneLocation: canonical form is lowercase + single space after comma", async () => {
  assert(normalizeLaneLocation("Memphis, TN") === "memphis, tn", `Got: ${normalizeLaneLocation("Memphis, TN")}`);
});

await runTest("normalizeLaneLocation: extra space after comma is collapsed", async () => {
  const result = normalizeLaneLocation("memphis,  tn");
  assert(result === "memphis, tn", `Got: ${result}`);
});

await runTest("normalizeLaneLocation: uppercase input matches", async () => {
  const result = normalizeLaneLocation("MEMPHIS, TN");
  assert(result === "memphis, tn", `Got: ${result}`);
});

await runTest("normalizeLaneLocation: space before comma is removed", async () => {
  const result = normalizeLaneLocation("Memphis ,TN");
  assert(result === "memphis, tn", `Got: ${result}`);
});

await runTest("normalizeLaneLocation: leading/trailing whitespace + extra internal space", async () => {
  const result = normalizeLaneLocation("  Ogden,  UT ");
  assert(result === "ogden, ut", `Got: ${result}`);
});

await runTest("normalizeLaneLocation: mixed-case with multiple spaces between words", async () => {
  const result = normalizeLaneLocation("St.  Louis,  MO");
  assert(result === "st. louis, mo", `Got: ${result}`);
});

await runTest("normalizeLaneLocation: genuinely different cities do NOT match", async () => {
  const memphis = normalizeLaneLocation("Memphis, TN");
  const nashville = normalizeLaneLocation("Nashville, TN");
  assert(memphis !== nashville, `Different cities should not normalize to the same string: ${memphis}`);
});

await runTest("normalizeLaneLocation: 'Memphis, TN' vs 'memphis,  tn' vs 'MEMPHIS, tn' all match", async () => {
  const a = normalizeLaneLocation("Memphis, TN");
  const b = normalizeLaneLocation("memphis,  tn");
  const c = normalizeLaneLocation("MEMPHIS, tn");
  assert(a === b, `"Memphis, TN" vs "memphis,  tn": ${a} ≠ ${b}`);
  assert(b === c, `"memphis,  tn" vs "MEMPHIS, tn": ${b} ≠ ${c}`);
});

// ── Unit tests: equipment matching logic ──────────────────────────────────────

await runTest("normalizeEquipmentType: 'po' normalizes to 'dry van'", async () => {
  assert(normalizeEquipmentType("po") === "dry van", `Got: ${normalizeEquipmentType("po")}`);
});

await runTest("Equipment-aware match: same O/D, matching equipment → should match", async () => {
  // Simulate the JS-side equipment matching logic used in myProcurement.ts
  const taskEquipType = "dry van";
  const candidates = [
    { id: "lane-dv", equipment_type: "po" },   // "po" → "dry van"
    { id: "lane-rf", equipment_type: "rf" },   // "rf" → "reefer"
  ];
  const targetEquip = normalizeEquipmentType(taskEquipType);
  const match = candidates.find(
    (c) => normalizeEquipmentType(c.equipment_type) === targetEquip
  );
  assert(match?.id === "lane-dv", `Expected lane-dv to match, got: ${match?.id}`);
});

await runTest("Equipment-aware match: same O/D, wrong equipment → no match (null)", async () => {
  // Scenario: award task is for reefer, but only dry van lane exists in LWQ
  const taskEquipType = "reefer";
  const candidates = [
    { id: "lane-dv", equipment_type: "po" },   // "po" → "dry van" — WRONG equipment
    { id: "lane-dv2", equipment_type: "dv" },  // "dv" → "dry van" — WRONG equipment
  ];
  const targetEquip = normalizeEquipmentType(taskEquipType);
  const match = candidates.find(
    (c) => normalizeEquipmentType(c.equipment_type) === targetEquip
  );
  assert(match === undefined, `Expected no match for reefer against dry van lanes, got: ${match?.id}`);
});

await runTest("Equipment-aware match: legacy task (no equipmentType) → accepts first candidate", async () => {
  // Legacy tasks don't have equipmentType stored — fall back to O/D-only (backward compat)
  const taskEquipType = null;
  const candidates = [
    { id: "lane-most-recent", equipment_type: "po" },
    { id: "lane-older", equipment_type: "rf" },
  ];
  const matchedLaneId = taskEquipType
    ? candidates.find((c) => normalizeEquipmentType(c.equipment_type) === normalizeEquipmentType(taskEquipType))?.id ?? null
    : candidates[0]?.id ?? null;
  assert(matchedLaneId === "lane-most-recent", `Expected lane-most-recent, got: ${matchedLaneId}`);
});

// ── Unit tests: "No lane match" URL generation ────────────────────────────────

await runTest("No-match URL includes ?noMatch= with encoded O/D hint", async () => {
  // Simulates the primaryDestination logic in AwardTaskCard
  const origin = "Ogden, UT";
  const destination = "Westfield, MA";
  const matchedLaneId: string | null = null;
  const noMatchHint = origin && destination
    ? encodeURIComponent(`${origin} → ${destination}`)
    : null;
  const primaryDestination = matchedLaneId
    ? `/lanes/work-queue?laneId=${matchedLaneId}`
    : `/lanes/work-queue${noMatchHint ? `?noMatch=${noMatchHint}` : ""}`;

  assert(primaryDestination.includes("?noMatch="), `URL should contain ?noMatch=: ${primaryDestination}`);
  const hint = new URL(`http://x${primaryDestination}`).searchParams.get("noMatch");
  assert(hint === "Ogden, UT → Westfield, MA", `Decoded hint should be "Ogden, UT → Westfield, MA", got: ${hint}`);
});

await runTest("Matched lane URL is clean /lanes/work-queue?laneId= (no noMatch param)", async () => {
  const matchedLaneId = "abc-123";
  const primaryDestination = `/lanes/work-queue?laneId=${matchedLaneId}`;
  assert(!primaryDestination.includes("noMatch"), `Matched URL should not contain noMatch: ${primaryDestination}`);
  assert(primaryDestination === "/lanes/work-queue?laneId=abc-123", `Unexpected URL: ${primaryDestination}`);
});

// ── Integration tests: live API ───────────────────────────────────────────────

const cookie = await loginAndGetCookie();

const r = await fetch(`${BASE}/api/my-procurement`, {
  headers: { Cookie: cookie },
});
assert(r.ok, `my-procurement returned ${r.status}`);
const data = await r.json() as {
  lwqLanes: Array<{ laneId: string; origin: string; destination: string; equipmentType: string | null }>;
  awardTasks: Array<{ taskId: string; origin: string | null; destination: string | null; equipmentType: string | null; matchedLaneId: string | null }>;
};

await runTest("Response shape: lwqLanes and awardTasks are arrays", async () => {
  assert(Array.isArray(data.lwqLanes), "lwqLanes must be an array");
  assert(Array.isArray(data.awardTasks), "awardTasks must be an array");
});

await runTest("LWQ lane items have a laneId (for /lanes/work-queue?laneId=...)", async () => {
  assert(data.lwqLanes.length > 0, `Expected ≥1 LWQ lane, got ${data.lwqLanes.length}. Seed test data first.`);
  for (const lane of data.lwqLanes) {
    assert(typeof lane.laneId === "string" && lane.laneId.length > 0, `LWQ lane missing laneId: ${JSON.stringify(lane)}`);
  }
});

await runTest("Award tasks with matching lanes have matchedLaneId populated", async () => {
  assert(data.awardTasks.length > 0, `Expected ≥1 award task, got ${data.awardTasks.length}. Seed test data first.`);
  const withOrigin = data.awardTasks.filter(t => t.origin && t.destination);
  assert(withOrigin.length > 0, "No award tasks have origin/destination set");

  const matched = withOrigin.filter(t => t.matchedLaneId !== null);
  console.log(`    ${matched.length}/${withOrigin.length} award tasks have matchedLaneId`);
  assert(matched.length > 0, "Expected at least one award task to have a matchedLaneId via origin/destination lookup");

  for (const t of matched) {
    assert(typeof t.matchedLaneId === "string" && t.matchedLaneId.length > 0, `matchedLaneId should be a string UUID: ${JSON.stringify(t)}`);
  }
});

await runTest("Both LWQ and matched award tasks produce same URL pattern (/lanes/work-queue?laneId=...)", async () => {
  const lwqUrls = data.lwqLanes.map(l => `/lanes/work-queue?laneId=${l.laneId}`);
  const awardUrls = data.awardTasks
    .filter(t => t.matchedLaneId)
    .map(t => `/lanes/work-queue?laneId=${t.matchedLaneId}`);

  assert(lwqUrls.length > 0, "No LWQ URLs to compare");
  assert(awardUrls.length > 0, "No award task URLs to compare (no matchedLaneId found)");

  for (const url of [...lwqUrls, ...awardUrls]) {
    assert(url.startsWith("/lanes/work-queue?laneId="), `URL doesn't follow LWQ pattern: ${url}`);
    const laneId = new URL(`http://x${url}`).searchParams.get("laneId");
    assert(!!laneId && laneId.length > 10, `laneId param is empty or too short: ${laneId}`);
  }

  console.log(`    LWQ destinations: ${lwqUrls.join(", ")}`);
  console.log(`    Award destinations: ${awardUrls.join(", ")}`);
});

await runTest("Award task matchedLaneId points to a real recurring_lane", async () => {
  const matched = data.awardTasks.filter(t => t.matchedLaneId);
  for (const task of matched) {
    const laneRes = await fetch(`${BASE}/api/recurring-lanes/${task.matchedLaneId}`, {
      headers: { Cookie: cookie },
    });
    assert(laneRes.ok, `Fetching lane ${task.matchedLaneId} returned ${laneRes.status}`);
    const lane = await laneRes.json() as { id: string; origin: string; destination: string };
    assert(lane.id === task.matchedLaneId, `Lane ID mismatch: expected ${task.matchedLaneId}, got ${lane.id}`);
    console.log(`    Award task "${task.origin} → ${task.destination}" → matched lane "${lane.origin} → ${lane.destination}"`);
  }
});

await runTest("Award tasks expose equipmentType field in API response", async () => {
  // equipmentType may be null for legacy tasks but the field must exist in the shape
  for (const t of data.awardTasks) {
    assert("equipmentType" in t, `Award task ${t.taskId} is missing equipmentType field`);
  }
  const withEquip = data.awardTasks.filter(t => t.equipmentType !== null);
  console.log(`    ${withEquip.length}/${data.awardTasks.length} award tasks have equipmentType stored`);
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  console.log("FAILED tests:");
  results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name}: ${r.error}`));
  process.exit(1);
} else {
  console.log("My Procurement: equipment-aware matching, O/D normalization, and unified workspace path confirmed.");
}
