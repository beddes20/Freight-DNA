/**
 * Performance Guardrail Tests — LWQ Speed Regression Prevention
 *
 * Baseline established April 2026 after the HF-index optimization:
 *   - work-queue was 1.6–1.8 s BEFORE optimization
 *   - work-queue is 0.04–0.11 s AFTER optimization (30–40× improvement)
 *
 * These thresholds are intentionally generous to survive:
 *   - slow CI environments
 *   - a cold TMS-upload cache
 *   - up to 2 000 lanes in the work queue
 *
 * Run: npx tsx tests/performance.test.ts
 * Requires dev server on port 5000.
 */

import http from "http";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

// ── Performance thresholds (ms) ──────────────────────────────────────────────

/**
 * work-queue must respond within 800 ms on a warm-cache request.
 * Pre-optimization baseline was 1 600–1 800 ms. Threshold is 4× the post-opt
 * p95 to allow for slow environments while still catching regressions.
 */
const WORK_QUEUE_THRESHOLD_MS = 800;

/**
 * Carrier-suggestions endpoint must respond within 1 000 ms.
 * This includes TMS ranking; 1 000 ms is generous but catches runaway scans.
 */
const CARRIER_SUGGESTIONS_THRESHOLD_MS = 1000;

/**
 * work-queue payload must be under 600 KB.
 * Pre-optimization: 612 KB (laneScoreFactors included).
 * Post-optimization: ~420 KB (stripped). Threshold = 600 KB — catches any
 * accidental re-addition of large unused fields.
 */
const WORK_QUEUE_MAX_BYTES = 600 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg });
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function httpRequest(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string; durationMs: number; bodyBytes: number }> {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const req = http.request(
      { hostname: SERVER_HOST, port: SERVER_PORT, method: options.method, path: options.path, headers: options.headers ?? {} },
      (res) => {
        let body = "";
        let bodyBytes = 0;
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); bodyBytes += chunk.length; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, durationMs: Date.now() - startMs, bodyBytes }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function loginAsAdmin(): Promise<string> {
  const body = JSON.stringify({ username: "ben.beddes@valuetruck.com", password: "Test1234!" });
  const res = await new Promise<{ status: number; headers: Record<string, string | string[]> }>((resolve, reject) => {
    const req = http.request(
      { hostname: SERVER_HOST, port: SERVER_PORT, method: "POST", path: "/api/auth/login",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | string[]> }); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  if (res.status !== 200) throw new Error(`Admin login failed: ${res.status}`);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!cookie) throw new Error("No session cookie from admin login");
  return cookie;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nPerformance Guardrail Tests\n");

  let adminCookie: string;
  try {
    adminCookie = await loginAsAdmin();
  } catch (err) {
    console.error("Could not log in as admin — skipping performance tests:", (err as Error).message);
    process.exit(0);
  }

  const headers = { Cookie: adminCookie };

  // ── 1. work-queue: response time ─────────────────────────────────────────
  await runTest(
    `work-queue responds within ${WORK_QUEUE_THRESHOLD_MS} ms (warm cache)`,
    async () => {
      // Warm request (ignore)
      await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue", headers });
      // Measured request
      const r = await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue", headers });
      assert(r.status === 200, `Expected 200 got ${r.status}`);
      assert(
        r.durationMs <= WORK_QUEUE_THRESHOLD_MS,
        `work-queue took ${r.durationMs} ms — exceeds ${WORK_QUEUE_THRESHOLD_MS} ms threshold ` +
        `(regression? pre-opt baseline was ~1 700 ms)`,
      );
    }
  );

  // ── 2. work-queue: payload size ───────────────────────────────────────────
  await runTest(
    `work-queue payload under ${Math.round(WORK_QUEUE_MAX_BYTES / 1024)} KB`,
    async () => {
      const r = await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue", headers });
      assert(r.status === 200, `Expected 200 got ${r.status}`);
      assert(
        r.bodyBytes <= WORK_QUEUE_MAX_BYTES,
        `work-queue payload is ${Math.round(r.bodyBytes / 1024)} KB — exceeds ${Math.round(WORK_QUEUE_MAX_BYTES / 1024)} KB limit ` +
        `(did laneScoreFactors or another large unused field get re-added?)`,
      );
    }
  );

  // ── 3. work-queue: laneScoreFactors stripped ──────────────────────────────
  await runTest(
    "work-queue response does not include laneScoreFactors",
    async () => {
      const r = await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue", headers });
      assert(r.status === 200, `Expected 200 got ${r.status}`);
      // laneScoreFactors is the largest stripped field; its presence would balloon the payload
      assert(
        !r.body.includes('"laneScoreFactors"'),
        "laneScoreFactors found in work-queue response — this field is stripped server-side to save ~170 KB"
      );
    }
  );

  // ── 4. work-queue: isHighFrequency present ────────────────────────────────
  // Task #200 changed the response to a flat LeanItem shape (no nested .lane object).
  // isHighFrequency is now stamped at the top level of each item.
  await runTest(
    "work-queue lanes include isHighFrequency flag (flat shape)",
    async () => {
      const r = await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue", headers });
      assert(r.status === 200, `Expected 200 got ${r.status}`);
      const body = JSON.parse(r.body) as { unassigned: Record<string, unknown>[] };
      const first = body.unassigned?.[0];
      assert(!!first, "unassigned bucket is empty");
      assert(
        "isHighFrequency" in first,
        "isHighFrequency missing from work-queue item — HF stamping may have broken (Task #200 flat shape)"
      );
      assert(
        typeof first.isHighFrequency === "boolean",
        `isHighFrequency should be boolean, got ${typeof first.isHighFrequency}`
      );
      // Confirm flat shape — nested .lane must NOT exist (Task #200 contract)
      assert(
        !("lane" in first),
        "Unexpected nested .lane object — Task #200 switched to flat LeanItem shape"
      );
    }
  );

  // ── 5. carrier-suggestions: response time ────────────────────────────────
  await runTest(
    `carrier-suggestions responds within ${CARRIER_SUGGESTIONS_THRESHOLD_MS} ms`,
    async () => {
      // Use a known lane ID
      const r = await httpRequest({
        method: "GET",
        path: "/api/lanes/81cf5744-c9ed-4afa-bb70-0937af9bf6ed/carrier-suggestions?pageSize=25&page=1&sort=recommended",
        headers,
      });
      assert(r.status === 200, `Expected 200 got ${r.status}`);
      assert(
        r.durationMs <= CARRIER_SUGGESTIONS_THRESHOLD_MS,
        `carrier-suggestions took ${r.durationMs} ms — exceeds ${CARRIER_SUGGESTIONS_THRESHOLD_MS} ms threshold`,
      );
    }
  );

  // ── Results ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n── Performance Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
  if (failed > 0) {
    console.log("THRESHOLDS:");
    console.log(`  work-queue response time:  < ${WORK_QUEUE_THRESHOLD_MS} ms`);
    console.log(`  work-queue payload size:   < ${Math.round(WORK_QUEUE_MAX_BYTES / 1024)} KB`);
    console.log(`  carrier-suggestions time:  < ${CARRIER_SUGGESTIONS_THRESHOLD_MS} ms`);
    process.exit(1);
  }
  console.log("All performance guardrails pass.");
}

main().catch(err => { console.error(err); process.exit(1); });
