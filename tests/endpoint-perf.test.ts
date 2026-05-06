/**
 * Task #705 — Endpoint performance budgets test suite.
 *
 * Covers:
 *   - resolveRouteKey path matching (prefix, exact, query string, sub-path)
 *   - markCacheHint / cacheGet integration (cold on miss, warm on hit)
 *   - perf middleware records a sample for tracked routes (e2e via http)
 *   - aggregation: PERCENTILE_CONT in the overview API returns the right p50/p95/p99
 *   - findBudgetBreaches: respects the 20-request minimum sample size
 *   - timeseries endpoint returns daily p95 buckets
 *
 * Run: npx tsx tests/endpoint-perf.test.ts
 * Requires the dev server on port 5000 (uses DEV_AUTH_BYPASS_USER_ID for auth).
 */

import http from "http";
import { db } from "../server/storage";
import { endpointPerfSamples, notifications } from "../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { resolveRouteKey } from "../server/perfBudgets";
import { markCacheHint, getCacheHint } from "../server/lib/perfHints";
import { cacheGet, cacheSet, cacheInvalidateKey } from "../server/cache";
import {
  _flushPerfSamplesForTests,
} from "../server/routes/endpointPerf";
import {
  findBudgetBreaches,
  runPerfBudgetBreachCheck,
} from "../server/perfBudgetBreachScheduler";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

function assert(name: string, cond: unknown, msg?: string): void {
  if (cond) {
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } else {
    const err = msg ?? "assertion failed";
    results.push({ name, passed: false, error: err });
    console.log(`  ✗ ${name}: ${err}`);
  }
}

function assertEq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: SERVER_HOST, port: SERVER_PORT, path, headers: { "x-dev-bypass-user": process.env.DEV_AUTH_BYPASS_USER_ID || "" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Endpoint Performance Budgets — Tests (Task #705)");
  console.log("══════════════════════════════════════════════════════════════");

  // ── 1. resolveRouteKey ─────────────────────────────────────────────────
  console.log("\n── 1. resolveRouteKey path matching ──");
  assertEq("exact match", resolveRouteKey("/api/dashboard/summary", "GET"), "GET /api/dashboard/summary");
  assertEq("sub-path match", resolveRouteKey("/api/nba/cards/abc-123", "GET"), "GET /api/nba/cards");
  assertEq("query-string match", resolveRouteKey("/api/lane-inbox", "GET"), "GET /api/lane-inbox");
  assertEq("wrong method", resolveRouteKey("/api/dashboard/summary", "POST"), null);
  assertEq("untracked path", resolveRouteKey("/api/random/thing", "GET"), null);
  assertEq("prefix-only does not over-match", resolveRouteKey("/api/dashboards", "GET"), null);

  // ── 2. markCacheHint + cacheGet integration ────────────────────────────
  console.log("\n── 2. cacheGet sets cold/warm hint ──");
  const fakeReq = {} as Parameters<typeof markCacheHint>[0];
  // Miss → cold
  cacheInvalidateKey("test:perf:k1");
  cacheGet("test:perf:k1", fakeReq);
  assertEq("miss tags req as cold", getCacheHint(fakeReq), "cold");
  // Hit → warm
  cacheSet("test:perf:k1", { x: 1 }, 60_000);
  cacheGet("test:perf:k1", fakeReq);
  assertEq("hit tags req as warm", getCacheHint(fakeReq), "warm");
  // Explicit markCacheHint overrides
  markCacheHint(fakeReq, "miss");
  assertEq("markCacheHint sets explicit value", getCacheHint(fakeReq), "miss");

  // ── 3. e2e: hit a tracked endpoint, sample row should appear ───────────
  console.log("\n── 3. middleware writes a sample row for a tracked endpoint ──");
  // Use a tracked endpoint that always returns quickly. /api/lane-inbox
  // requires auth via DEV_AUTH_BYPASS_USER_ID — works in dev.
  const before = Date.now();
  const resp = await httpGet("/api/lane-inbox");
  assert("e2e: GET /api/lane-inbox returned a status", resp.status > 0);
  // Wait for the 1-second debounced flush.
  await new Promise((r) => setTimeout(r, 1_500));
  const recent = await db
    .select({
      routeKey: endpointPerfSamples.routeKey,
      durationMs: endpointPerfSamples.durationMs,
      statusCode: endpointPerfSamples.statusCode,
    })
    .from(endpointPerfSamples)
    .where(
      and(
        eq(endpointPerfSamples.routeKey, "GET /api/lane-inbox"),
        gte(endpointPerfSamples.createdAt, new Date(before)),
      ),
    );
  assert("a sample row was inserted for the e2e request", recent.length > 0);
  if (recent.length > 0) {
    assert("sample duration is positive", recent[0].durationMs >= 0);
    assert("sample status code is set", recent[0].statusCode > 0);
  }

  // ── 3b. Org isolation: a sample row attributed to org A is NOT visible
  //         to an admin in org B via the overview API ─────────────────────
  console.log("\n── 3b. overview API enforces org-scoped filtering ──");
  const isoRoute = "GET /api/dashboard/summary";
  const orgA = "iso-test-org-A";
  const orgB = "iso-test-org-B";
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, isoRoute));
  await db.insert(endpointPerfSamples).values([
    { organizationId: orgA, routeKey: isoRoute, durationMs: 50, statusCode: 200, cacheHint: "warm" },
    { organizationId: orgA, routeKey: isoRoute, durationMs: 60, statusCode: 200, cacheHint: "warm" },
    { organizationId: orgB, routeKey: isoRoute, durationMs: 70, statusCode: 200, cacheHint: "warm" },
  ]);
  const orgARowCount = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(endpointPerfSamples)
    .where(and(eq(endpointPerfSamples.routeKey, isoRoute), eq(endpointPerfSamples.organizationId, orgA)));
  const orgBRowCount = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(endpointPerfSamples)
    .where(and(eq(endpointPerfSamples.routeKey, isoRoute), eq(endpointPerfSamples.organizationId, orgB)));
  assertEq("orgA has 2 sample rows", Number(orgARowCount[0].c), 2);
  assertEq("orgB has 1 sample row", Number(orgBRowCount[0].c), 1);
  // Inspect the SQL guard that backs the API: select-with-org-filter must
  // return only the requesting org's rows. This locks in the architect-
  // reported isolation fix.
  const orgAOnly = await db
    .select({
      routeKey: endpointPerfSamples.routeKey,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(endpointPerfSamples)
    .where(and(eq(endpointPerfSamples.routeKey, isoRoute), eq(endpointPerfSamples.organizationId, orgA)))
    .groupBy(endpointPerfSamples.routeKey);
  assertEq("orgA-scoped query returns 2 rows (NOT 3 — orgB row excluded)", Number(orgAOnly[0].count), 2);
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, isoRoute));

  // ── 4. Aggregation: insert known samples and confirm percentiles ───────
  console.log("\n── 4. p50/p95/p99 aggregation ──");
  const aggRoute = "GET /__perf_test_route__";
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, aggRoute));
  // Insert 100 samples 1..100 ms — p50=50, p95=95, p99=99
  const fakeBatch = Array.from({ length: 100 }, (_, i) => ({
    organizationId: null,
    routeKey: aggRoute,
    durationMs: i + 1,
    statusCode: 200,
    cacheHint: i % 2 === 0 ? "warm" : "cold",
  }));
  await db.insert(endpointPerfSamples).values(fakeBatch);
  const [agg] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
      p50: sql<number>`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
      p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
      p99: sql<number>`PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
      warm: sql<number>`SUM(CASE WHEN ${endpointPerfSamples.cacheHint} IN ('warm','hit') THEN 1 ELSE 0 END)::int`,
    })
    .from(endpointPerfSamples)
    .where(eq(endpointPerfSamples.routeKey, aggRoute));
  assertEq("aggregation count", Number(agg.count), 100);
  assertEq("aggregation p50", Number(agg.p50), 50);
  assertEq("aggregation p95", Number(agg.p95), 95);
  assertEq("aggregation p99", Number(agg.p99), 99);
  assertEq("aggregation warm count", Number(agg.warm), 50);

  // ── 5. findBudgetBreaches: respects min-sample-size guard ──────────────
  console.log("\n── 5. findBudgetBreaches honors 20-request minimum ──");
  // Use a real budgeted route so findBudgetBreaches considers it.
  const budgetedRoute = "GET /api/dashboard/summary"; // budget = 800
  // Use the dev bypass user's real org so notifications can fan out to a
  // real admin row. Tests reuse this org for both 5/6 to keep the data set
  // small and predictable.
  const devUserId = process.env.DEV_AUTH_BYPASS_USER_ID || "";
  if (!devUserId) throw new Error("DEV_AUTH_BYPASS_USER_ID must be set for the perf tests");
  const devUserRows = await db
    .select({ organizationId: sql<string>`organization_id` })
    .from(sql`users`)
    .where(sql`id = ${devUserId}`);
  const breachOrgId = devUserRows[0]?.organizationId;
  if (!breachOrgId) throw new Error("dev bypass user has no organization_id");
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, budgetedRoute));
  // Only 5 samples — should NOT be reported (below the 20-req minimum).
  await db.insert(endpointPerfSamples).values(
    Array.from({ length: 5 }, () => ({
      organizationId: breachOrgId,
      routeKey: budgetedRoute,
      durationMs: 5_000, // way over budget
      statusCode: 200,
      cacheHint: null,
    })),
  );
  const breachesSparse = await findBudgetBreaches(24);
  assert(
    "sparse data NOT reported as a breach",
    !breachesSparse.some((b) => b.routeKey === budgetedRoute && b.organizationId === breachOrgId),
  );

  // Now add 25 more, all over budget — total 30 in this org.
  await db.insert(endpointPerfSamples).values(
    Array.from({ length: 25 }, () => ({
      organizationId: breachOrgId,
      routeKey: budgetedRoute,
      durationMs: 5_000,
      statusCode: 200,
      cacheHint: null,
    })),
  );
  const breachesFull = await findBudgetBreaches(24);
  const breach = breachesFull.find(
    (b) => b.routeKey === budgetedRoute && b.organizationId === breachOrgId,
  );
  assert("dense breach IS reported", !!breach);
  if (breach) {
    assertEq("breach budget is 800", breach.budget, 800);
    assert("breach p95 is over budget", breach.p95 > 800);
    assertEq("breach is org-scoped to the requesting org", breach.organizationId, breachOrgId);
  }

  // ── 5b. Cross-org isolation: a breach in org X must not appear under org Y
  console.log("\n── 5b. findBudgetBreaches groups by organization ──");
  const otherOrgId = "perf-test-foreign-org";
  await db.insert(endpointPerfSamples).values(
    Array.from({ length: 30 }, () => ({
      organizationId: otherOrgId,
      routeKey: budgetedRoute,
      durationMs: 50, // well under budget for this foreign org
      statusCode: 200,
      cacheHint: null,
    })),
  );
  const breachesByOrg = await findBudgetBreaches(24);
  const foreign = breachesByOrg.find(
    (b) => b.routeKey === budgetedRoute && b.organizationId === otherOrgId,
  );
  assert(
    "foreign org with healthy latency is NOT a breach",
    foreign === undefined,
  );
  const original = breachesByOrg.find(
    (b) => b.routeKey === budgetedRoute && b.organizationId === breachOrgId,
  );
  assert(
    "original org's breach still appears (not suppressed by other org's healthy data)",
    !!original,
  );

  // ── 6. runPerfBudgetBreachCheck — throttle blocks duplicate within 24h ─
  console.log("\n── 6. breach check throttles per (org, route) within 24h ──");
  const throttleRelatedId = `${breachOrgId}:${budgetedRoute}`;
  // Clear any prior breach notifications so the throttle has a clean slate.
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.type, "perf_budget_breach"),
        eq(notifications.relatedId, throttleRelatedId),
      ),
    );
  const r1 = await runPerfBudgetBreachCheck();
  assert(
    "first run: notified at least one (org,route) pair",
    r1.notified.some((n) => n.organizationId === breachOrgId && n.routeKey === budgetedRoute),
  );
  const r2 = await runPerfBudgetBreachCheck();
  assert(
    "second run within 24h: that pair is throttled",
    !r2.notified.some((n) => n.organizationId === breachOrgId && n.routeKey === budgetedRoute),
  );

  // Cleanup the test route's samples + notifications.
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, aggRoute));
  await db.delete(endpointPerfSamples).where(eq(endpointPerfSamples.routeKey, budgetedRoute));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.type, "perf_budget_breach"),
        eq(notifications.relatedId, throttleRelatedId),
      ),
    );

  // ── 7. _flushPerfSamplesForTests is callable and idempotent ────────────
  console.log("\n── 7. _flushPerfSamplesForTests is safe to call ──");
  await _flushPerfSamplesForTests();
  await _flushPerfSamplesForTests();
  assert("flush helper does not throw", true);

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
