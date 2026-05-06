// Task #740 — SONAR call-budget regression tests.
// Run with: npx tsx tests/sonar-call-budget.test.ts

import { storage } from "../server/storage";

// ─── Stub storage cache layer (must be installed BEFORE importing sonarClient) ─
(storage as any).getValidCachedApiResponses = async () => [];
(storage as any).getAllCachedApiResponses = async () => [];
(storage as any).setCachedApiResponse = async () => undefined;

// Prevent the auth flow from short-circuiting on missing creds: the bearer
// token path skips the /credential/authenticate request entirely.
process.env.FREIGHTWAVES_TOKEN = "test-bearer-token";
// Disable the inter-call rate limiter so the test suite runs in seconds
// instead of minutes.
process.env.SONAR_RATE_LIMIT_INTERVAL_MS = "0";

const {
  getNationalMarketSummary,
  getMarketOtri,
  getLaneVotri,
  withSonarCaller,
  getSonarCallCounters,
  getSonarCircuitBreakerStatus,
  _resetSonarCallCountersForTests,
  _resetSonarCachesForTests,
} = await import("../server/sonarClient");
const { _resetBreakerForTests } = await import("../server/lib/httpRetry");

// ─── Mock global fetch ─────────────────────────────────────────────────────────
type FetchResponder = (url: string) => { status: number; body: any };
let _fetchResponder: FetchResponder | null = null;
let _fetchCalls: string[] = [];
const _origFetch = global.fetch;

(global as any).fetch = async (url: any) => {
  const u = typeof url === "string" ? url : url.toString();
  _fetchCalls.push(u);
  if (!_fetchResponder) throw new Error(`No fetch responder set for ${u}`);
  const r = _fetchResponder(u);
  return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
};

function setResponder(fn: FetchResponder) {
  _fetchResponder = fn;
  _fetchCalls = [];
}

function sonarCallCount(): number {
  return _fetchCalls.filter(u => u.includes("/data/")).length;
}

// ─── Test runner ───────────────────────────────────────────────────────────────
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

function resetAll() {
  _resetSonarCallCountersForTests();
  _resetSonarCachesForTests();
  _resetBreakerForTests("sonar");
  _fetchCalls = [];
}

// Canned SONAR data row (the shape getNationalMarketSummary's `extractValue`
// understands).
function sonarDataRows(today: string, prior: string, value: number, priorValue: number) {
  return [
    { value: priorValue, timestamp: prior },
    { value, timestamp: today },
  ];
}

// Build a responder that returns valid OTRI/NTI/VCRPM data for the national
// summary path, plus a stub EIA diesel response so the diesel path doesn't
// throw. EIA isn't a SONAR /data/* path so it won't pollute our SONAR-call
// counter.
function nationalHappyResponder(): FetchResponder {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return (url: string) => {
    if (url.includes("/data/OTRI/USA/")) {
      return { status: 200, body: sonarDataRows(today, yesterday, 14.5, 13.2) };
    }
    if (url.includes("/data/NTI/USA/")) {
      return { status: 200, body: sonarDataRows(today, yesterday, 1850, 1820) };
    }
    if (url.includes("/data/VCRPM1/USA/")) {
      return { status: 200, body: sonarDataRows(today, yesterday, 1.92, 1.88) };
    }
    if (url.includes("eia.gov")) {
      return { status: 200, body: { response: { data: [] } } };
    }
    return { status: 404, body: { error: "no responder for " + url } };
  };
}

// ─── Test 1 — warm cache → 0 net live calls ────────────────────────────────────
async function testWarmCacheZeroLiveCalls() {
  console.log("\nTest: warm cache yields 0 net live SONAR calls");
  resetAll();
  setResponder(nationalHappyResponder());

  // First pull: cold — should make 3 live SONAR requests (OTRI, NTI, VCRPM).
  const first = await withSonarCaller("ui:lane-detail", () => getNationalMarketSummary());
  const liveAfterFirst = getSonarCallCounters().today.byCaller["ui:lane-detail"]?.live ?? 0;
  const fetchAfterFirst = sonarCallCount();
  assert(
    "first call returns live data (OTRI populated)",
    first.otri !== null,
    `otri=${first.otri}`,
  );
  assert(
    "first call: counter records ≥1 live",
    liveAfterFirst >= 1,
    `live=${liveAfterFirst}`,
  );
  assert(
    "first call: at least one /data/ request issued",
    fetchAfterFirst >= 1,
    `fetched=${fetchAfterFirst}`,
  );

  // Second pull from a *different* allowed UI tag — must hit memory cache,
  // increment cacheHits, and produce ZERO additional /data/ requests.
  _fetchCalls = [];
  const second = await withSonarCaller("ui:quote-workbench", () => getNationalMarketSummary());
  const fetchAfterSecond = sonarCallCount();
  const counters = getSonarCallCounters();
  const liveSecondTag = counters.today.byCaller["ui:quote-workbench"]?.live ?? 0;
  const cacheHitSecondTag = counters.today.byCaller["ui:quote-workbench"]?.cacheHits ?? 0;
  assert(
    "second call returns the same cached snapshot",
    second.otri === first.otri && second.ntiPerMove === first.ntiPerMove,
    `first.otri=${first.otri} second.otri=${second.otri}`,
  );
  assert(
    "second call: 0 net live SONAR /data/ requests issued",
    fetchAfterSecond === 0,
    `fetched=${fetchAfterSecond}`,
  );
  assert(
    "second call: 0 live counter increments under the new caller tag",
    liveSecondTag === 0,
    `live=${liveSecondTag}`,
  );
  assert(
    "second call: cacheHits counter incremented under the new caller tag",
    cacheHitSecondTag >= 1,
    `cacheHits=${cacheHitSecondTag}`,
  );
}

// ─── Test 2 — 451 trips breaker → downstream returns isStale ───────────────────
async function test451TripsBreakerAndReturnsStale() {
  console.log("\nTest: HTTP 451 trips breaker → downstream returns isStale");
  resetAll();

  // Responder that returns 451 on the very first SONAR /data/* call. The
  // shared resilient-fetch helper is configured to immediately trip the
  // SONAR breaker on 451.
  setResponder((url) => {
    if (url.includes("/data/")) {
      return { status: 451, body: { error: "Record cap exceeded" } };
    }
    return { status: 404, body: { error: "no responder for " + url } };
  });

  const first = await withSonarCaller("ui:lane-detail", () => getNationalMarketSummary());
  const breakerAfter = getSonarCircuitBreakerStatus();
  assert(
    "451 response trips the SONAR circuit breaker",
    breakerAfter.isOpen,
    `breaker=${JSON.stringify(breakerAfter)}`,
  );
  assert(
    "first call returns a stale snapshot (isStale=true)",
    first.isStale === true,
    `first.isStale=${first.isStale}`,
  );
  assert(
    "first call returns null OTRI (no live data available)",
    first.otri === null,
    `first.otri=${first.otri}`,
  );

  // The first call cached a "failed pull" snapshot with 1h TTL. To exercise
  // the breaker-skipped path we must clear that cache so the next call falls
  // through to sonarGet, where the OPEN breaker increments breakerSkipped.
  _resetSonarCachesForTests();

  _fetchCalls = [];
  const before = getSonarCallCounters().today.byCaller["ui:lane-signals"]?.breakerSkipped ?? 0;
  const second = await withSonarCaller("ui:lane-signals", () => getNationalMarketSummary());
  const after = getSonarCallCounters().today.byCaller["ui:lane-signals"]?.breakerSkipped ?? 0;
  const fetchedAfter = sonarCallCount();

  assert(
    "second call: 0 net live SONAR /data/ requests (breaker open)",
    fetchedAfter === 0,
    `fetched=${fetchedAfter}`,
  );
  assert(
    "second call: breakerSkipped counter incremented under the new caller tag",
    after - before >= 1,
    `before=${before} after=${after}`,
  );
  assert(
    "second call: still returns a stale snapshot (isStale=true)",
    second.isStale === true,
    `second.isStale=${second.isStale}`,
  );
}

// ─── Test 3 — non-allowed callers are hard-blocked (budgetSkipped) ─────────────
async function testNonAllowedCallerBudgetSkipped() {
  console.log("\nTest: non-allowed caller is hard-blocked from live SONAR calls");
  resetAll();
  setResponder(nationalHappyResponder());

  const result = await withSonarCaller("chatbot:context", () => getNationalMarketSummary());
  const counters = getSonarCallCounters();
  const chatbotCounter = counters.today.byCaller["chatbot:context"];
  assert(
    "chatbot:context: 0 live calls (hard-blocked by budget)",
    (chatbotCounter?.live ?? 0) === 0,
    `live=${chatbotCounter?.live}`,
  );
  assert(
    "chatbot:context: budgetSkipped > 0 (gate fired)",
    (chatbotCounter?.budgetSkipped ?? 0) >= 1,
    `budgetSkipped=${chatbotCounter?.budgetSkipped}`,
  );
  assert(
    "chatbot:context: 0 net /data/ HTTP requests issued",
    sonarCallCount() === 0,
    `fetched=${sonarCallCount()}`,
  );
  assert(
    "chatbot:context: returns isStale snapshot when blocked",
    result.isStale === true && result.otri === null,
    `isStale=${result.isStale} otri=${result.otri}`,
  );
  assert(
    "unexpectedLiveCallers stays empty (no live escaped)",
    counters.today.unexpectedLiveCallers.length === 0,
    `unexpected=${JSON.stringify(counters.today.unexpectedLiveCallers)}`,
  );
  assert(
    "cacheHitRatio is exposed (number or null)",
    counters.today.cacheHitRatio === null || typeof counters.today.cacheHitRatio === "number",
    `ratio=${counters.today.cacheHitRatio}`,
  );

  // Sanity: scheduler:daily-refresh IS allowed and does live-call.
  resetAll();
  setResponder(nationalHappyResponder());
  await withSonarCaller("scheduler:daily-refresh", () => getNationalMarketSummary());
  const c2 = getSonarCallCounters().today.byCaller["scheduler:daily-refresh"];
  assert(
    "scheduler:daily-refresh: live > 0, budgetSkipped == 0",
    (c2?.live ?? 0) >= 1 && (c2?.budgetSkipped ?? 0) === 0,
    `live=${c2?.live} budgetSkipped=${c2?.budgetSkipped}`,
  );
}

// ─── Test 4 — integrated flow: warm caches → multi-surface zero net live ───────
async function testIntegratedWarmCacheZeroLive() {
  console.log("\nTest: integrated flow — warm caches, mixed surfaces issue 0 net /data/ requests");
  resetAll();

  // Extended responder: serves national + market OTRI + lane VOTRI.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  setResponder((url) => {
    if (url.includes("/data/OTRI/USA/")) return { status: 200, body: sonarDataRows(today, yesterday, 14.5, 13.2) };
    if (url.includes("/data/NTI/USA/")) return { status: 200, body: sonarDataRows(today, yesterday, 1850, 1820) };
    if (url.includes("/data/VCRPM1/USA/")) return { status: 200, body: sonarDataRows(today, yesterday, 1.92, 1.88) };
    if (url.includes("/data/OTRI/ATL/")) return { status: 200, body: sonarDataRows(today, yesterday, 18.0, 16.0) };
    if (url.includes("/data/OTVI/ATL/")) return { status: 200, body: sonarDataRows(today, yesterday, 80.0, 78.0) };
    if (url.includes("/data/HAI/ATL/")) return { status: 200, body: sonarDataRows(today, yesterday, 5.0, 4.5) };
    if (url.includes("/data/VOTRI/ATLDAL/")) return { status: 200, body: sonarDataRows(today, yesterday, 12.0, 10.0) };
    if (url.includes("eia.gov")) return { status: 200, body: { response: { data: [] } } };
    return { status: 404, body: { error: "no responder for " + url } };
  });

  // Phase 1 — warm caches under allowed scheduler tag.
  await withSonarCaller("scheduler:daily-refresh", async () => {
    await getNationalMarketSummary();
    await getMarketOtri("ATL");
  });
  await withSonarCaller("ui:lane-detail", () => getLaneVotri("ATL", "DAL"));

  const liveAfterWarmup = sonarCallCount();
  assert(
    "warmup phase: at least one live /data/ request issued",
    liveAfterWarmup >= 3,
    `fetched=${liveAfterWarmup}`,
  );

  // Phase 2 — exercise the same getters under non-allowed surface tags. Each
  // should serve from cache (allowed) since the cache is warm and the budget
  // gate only fires on cache misses.
  _fetchCalls = [];
  const beforeCounters = getSonarCallCounters();

  await withSonarCaller("ui:market-pulse", () => getNationalMarketSummary());
  await withSonarCaller("chatbot:context", () => getMarketOtri("ATL"));
  await withSonarCaller("ui:intel-bundle", () => getLaneVotri("ATL", "DAL"));

  const fetchedDuringPhase2 = sonarCallCount();
  const afterCounters = getSonarCallCounters();
  const marketPulseHits = afterCounters.today.byCaller["ui:market-pulse"]?.cacheHits ?? 0;
  const chatbotHits = afterCounters.today.byCaller["chatbot:context"]?.cacheHits ?? 0;
  const intelBundleHits = afterCounters.today.byCaller["ui:intel-bundle"]?.cacheHits ?? 0;
  const totalLiveDelta = afterCounters.today.totals.live - beforeCounters.today.totals.live;

  assert(
    "phase 2: 0 net live SONAR /data/ requests across mixed non-allowed surfaces",
    fetchedDuringPhase2 === 0,
    `fetched=${fetchedDuringPhase2}`,
  );
  assert(
    "phase 2: total live counter did not increment",
    totalLiveDelta === 0,
    `delta=${totalLiveDelta}`,
  );
  assert(
    "phase 2: ui:market-pulse cacheHits incremented",
    marketPulseHits >= 1,
    `cacheHits=${marketPulseHits}`,
  );
  assert(
    "phase 2: chatbot:context cacheHits incremented",
    chatbotHits >= 1,
    `cacheHits=${chatbotHits}`,
  );
  assert(
    "phase 2: ui:intel-bundle cacheHits incremented",
    intelBundleHits >= 1,
    `cacheHits=${intelBundleHits}`,
  );
  assert(
    "phase 2: unexpectedLiveCallers stays empty",
    afterCounters.today.unexpectedLiveCallers.length === 0,
    `unexpected=${JSON.stringify(afterCounters.today.unexpectedLiveCallers)}`,
  );
  assert(
    "phase 2: allowedLiveCallers list is exposed and non-empty",
    Array.isArray(afterCounters.today.allowedLiveCallers) &&
      afterCounters.today.allowedLiveCallers.length >= 5,
    `allowed=${JSON.stringify(afterCounters.today.allowedLiveCallers)}`,
  );
}

// ─── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("SONAR call-budget regression tests (Task #740)\n");
  try {
    await testWarmCacheZeroLiveCalls();
    await test451TripsBreakerAndReturnsStale();
    await testNonAllowedCallerBudgetSkipped();
    await testIntegratedWarmCacheZeroLive();
  } catch (err) {
    console.error("\nUnexpected test crash:", err);
    failed++;
  } finally {
    (global as any).fetch = _origFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\nFailures:");
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main();
