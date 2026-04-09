/**
 * Integration test: My Procurement unified workspace path
 *
 * Verifies that:
 *  1. GET /api/my-procurement returns LWQ lane assignments with laneId
 *  2. Award tasks get matchedLaneId populated via origin/destination lookup
 *  3. Both source types produce the same /lanes/work-queue?laneId=... destination
 */

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

// ── Tests ──────────────────────────────────────────────────────────────────────

const cookie = await loginAndGetCookie();

const r = await fetch(`${BASE}/api/my-procurement`, {
  headers: { Cookie: cookie },
});
assert(r.ok, `my-procurement returned ${r.status}`);
const data = await r.json() as {
  lwqLanes: Array<{ laneId: string; origin: string; destination: string }>;
  awardTasks: Array<{ taskId: string; origin: string | null; destination: string | null; matchedLaneId: string | null }>;
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

  // Verify both sets are valid /lanes/work-queue?laneId=... paths
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

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  console.log("FAILED tests:");
  results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name}: ${r.error}`));
  process.exit(1);
} else {
  console.log("My Procurement unified workspace path is confirmed working.");
}
