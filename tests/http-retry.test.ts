/**
 * Task #706 — Unit tests for the shared resilience helper.
 *
 * Exercises every branch the legacy bespoke retry/breaker code used to
 * cover so the migrated services keep the same behavior:
 *   - Success path returns the underlying Response and resets the breaker.
 *   - 429 with Retry-After header sleeps for the right duration and retries.
 *   - 5xx is retried with exponential backoff up to the configured cap.
 *   - 4xx (other than 429) is terminal — no retries, no breaker trip.
 *   - Network errors retry until exhausted, then throw.
 *   - tripImmediatelyOn (e.g. SONAR 451) trips the breaker on first hit.
 *   - Open breaker short-circuits subsequent calls.
 *   - getBreakerStatus reports trippedAt / resumesAt while open.
 *
 * Run with: npx tsx tests/http-retry.test.ts
 */

import {
  resilientFetch,
  getBreakerStatus,
  tripBreaker,
  _resetBreakerForTests,
  CircuitOpenError,
} from "../server/lib/httpRetry";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${name}\n    ${detail}` : `  ✗ ${name}`;
    console.error(msg);
    failures.push(name + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

function makeResponse(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n── ${name} ─────────────────────────────────────────`);
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(`${name} did not throw unexpectedly`, false, msg);
  }
}

// ── 1. Success path ──────────────────────────────────────────────────────────
await runTest("Success on first attempt returns Response and resets breaker", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const res = await resilientFetch("graph", async () => {
    calls++;
    return makeResponse(200, "ok");
  });
  assert("returned response is 200", res.status === 200);
  assert("factory called exactly once", calls === 1, `got ${calls}`);
  assert("breaker is closed after success", !getBreakerStatus("graph").isOpen);
});

// ── 2. 429 with Retry-After header ──────────────────────────────────────────
await runTest("429 with Retry-After header sleeps then retries", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const start = Date.now();
  const res = await resilientFetch("webex", async () => {
    calls++;
    if (calls === 1) {
      // Retry-After: 1 second.
      return makeResponse(429, "rate limited", { "retry-after": "1" });
    }
    return makeResponse(200, "ok");
  });
  const elapsed = Date.now() - start;
  assert("eventually returned 200", res.status === 200);
  assert("factory called twice (1 retry)", calls === 2, `got ${calls}`);
  assert("waited at least ~1s for Retry-After (got " + elapsed + "ms)", elapsed >= 900);
});

// ── 3. 5xx retried with exponential backoff ─────────────────────────────────
await runTest("5xx retried with backoff up to retry cap", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const res = await resilientFetch(
    "graph",
    async () => {
      calls++;
      if (calls < 3) return makeResponse(503, "down");
      return makeResponse(200, "ok");
    },
    { retries: 3 },
  );
  assert("eventually returned 200", res.status === 200);
  assert("factory called three times (2 retries)", calls === 3, `got ${calls}`);
});

await runTest("5xx exhausts retries and returns last response", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const res = await resilientFetch(
    "graph",
    async () => {
      calls++;
      return makeResponse(500, "boom");
    },
    { retries: 2 },
  );
  assert("returns final 500 response", res.status === 500);
  assert("factory called retries+1 times", calls === 3, `got ${calls}`);
});

// ── 4. 4xx (other than 429) is terminal ─────────────────────────────────────
await runTest("4xx (401) is terminal — no retries, no breaker trip", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const res = await resilientFetch("graph", async () => {
    calls++;
    return makeResponse(401, "unauthorized");
  });
  assert("returned 401", res.status === 401);
  assert("factory called exactly once", calls === 1, `got ${calls}`);
  assert("breaker stays closed on 4xx", !getBreakerStatus("graph").isOpen);
});

// ── 5. Network errors retry then throw ──────────────────────────────────────
await runTest("Network errors retry then throw after retries exhausted", async () => {
  _resetBreakerForTests();
  let calls = 0;
  let thrown: Error | null = null;
  try {
    await resilientFetch(
      "graph",
      async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
      { retries: 2 },
    );
  } catch (err) {
    thrown = err as Error;
  }
  assert("threw the network error", thrown != null && /ECONNRESET/.test(thrown.message));
  assert("factory called retries+1 times", calls === 3, `got ${calls}`);
});

// ── 6. tripImmediatelyOn — SONAR 451 record-cap ─────────────────────────────
await runTest("SONAR 451 trips breaker immediately and returns response", async () => {
  _resetBreakerForTests();
  let calls = 0;
  const res = await resilientFetch("sonar", async () => {
    calls++;
    return makeResponse(451, "record cap reached");
  });
  assert("returned 451 (caller still gets the response)", res.status === 451);
  assert("factory called exactly once", calls === 1, `got ${calls}`);
  assert("breaker is OPEN after 451", getBreakerStatus("sonar").isOpen);
  const status = getBreakerStatus("sonar");
  assert("trippedAt is set", typeof status.trippedAt === "string");
  assert("resumesAt is set", typeof status.resumesAt === "string");
});

// ── 7. Open breaker short-circuits subsequent calls ─────────────────────────
await runTest("Open breaker short-circuits with CircuitOpenError", async () => {
  _resetBreakerForTests();
  tripBreaker("sonar", "manual trip");
  let calls = 0;
  let thrown: Error | null = null;
  try {
    await resilientFetch("sonar", async () => {
      calls++;
      return makeResponse(200, "ok");
    });
  } catch (err) {
    thrown = err as Error;
  }
  assert("threw CircuitOpenError", thrown != null && thrown instanceof CircuitOpenError);
  assert("factory was NOT invoked while breaker open", calls === 0, `got ${calls}`);
});

// ── 8. Manual tripBreaker via getBreakerStatus reflects state ───────────────
await runTest("tripBreaker + getBreakerStatus reflect state", async () => {
  _resetBreakerForTests();
  assert("starts closed", !getBreakerStatus("zoominfo").isOpen);
  tripBreaker("zoominfo", "test");
  const s = getBreakerStatus("zoominfo");
  assert("now open", s.isOpen);
  assert("has trippedAt iso string", typeof s.trippedAt === "string" && /\dT\d/.test(s.trippedAt!));
});

// ── 9. _resetBreakerForTests clears state ───────────────────────────────────
await runTest("_resetBreakerForTests clears single-source state", async () => {
  tripBreaker("trac", "test");
  assert("trac is open after manual trip", getBreakerStatus("trac").isOpen);
  _resetBreakerForTests("trac");
  assert("trac is closed after reset", !getBreakerStatus("trac").isOpen);
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
if (failed > 0) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
