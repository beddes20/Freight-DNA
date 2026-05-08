/**
 * Customer Quotes — telemetry for silently-dropped filter keys
 * (Task #1148)
 *
 * `filtersSchema` in server/routes/customerQuotes.ts is intentionally
 * non-strict so list/snapshot requests carrying sort/paging keys don't
 * 400 and silently drop every filter. The symmetrical risk: a typo'd or
 * stale filter key from a future client build (e.g. `?lostOnly2=true`)
 * is silently ignored and the rep sees an unfiltered queue with no
 * signal anywhere.
 *
 * Fix: `logDroppedFilterKeys` emits a single `console.debug` line per
 * request, but only when at least one query key is neither in
 * `filtersSchema` nor in the well-known sort/paging set
 * (sortKey, sortDir, offset, limit, mineOnly, includeSnoozed).
 *
 * This test pins:
 *   1. Known keys produce zero debug lines.
 *   2. Unknown keys produce exactly one debug line that includes the
 *      org id and the dropped key names.
 *
 * Run with: npx tsx tests/customer-quotes-dropped-filter-telemetry.test.ts
 */

import { z } from "zod";
import {
  diffDroppedFilterKeys,
  logDroppedFilterKeys,
  summarizeFilterParseFailure,
  logFilterParseFailure,
} from "../server/routes/customerQuotes.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.log(`  \u2717 ${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failures.push(`${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failed++;
  }
}

function captureDebug<T>(fn: () => T): { calls: unknown[][]; result: T } {
  const original = console.debug;
  const calls: unknown[][] = [];
  console.debug = (...args: unknown[]) => { calls.push(args); };
  try {
    const result = fn();
    return { calls, result };
  } finally {
    console.debug = original;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  CQ — silently-dropped filter key telemetry (Task #1148)");
console.log("══════════════════════════════════════════════════════════════");

console.log("── 1. diff: known filter + sort/paging keys produce no drops ──");
{
  const dropped = diffDroppedFilterKeys({
    customerId: "cust-1",
    startDate: "2026-01-01",
    endDate: "2026-02-01",
    equipment: "Van",
    repId: "rep-1",
    outcomeStatus: "open",
    outcomeReasonId: "r-1",
    laneSearch: "ATL",
    laneGroupId: "lg-1",
    wonOnly: "true",
    activeOnly: "true",
    lostOnly: "true",
    expiringOnly: "true",
    needsReviewOnly: "true",
    mineOnly: "true",
    includeSnoozed: "true",
    sortKey: "requestDate",
    sortDir: "desc",
    offset: "0",
    limit: "50",
  });
  assert("zero unknown keys when only known/sort/paging keys present", dropped.length === 0,
    `dropped=[${dropped.join(",")}]`);
}

console.log("── 2. diff: unknown keys are reported in iteration order ──");
{
  const dropped = diffDroppedFilterKeys({
    customerId: "cust-1",
    lostOnly2: "true",
    sortKey: "requestDate",
    favoriteColor: "blue",
  });
  assert("exactly two unknown keys reported", dropped.length === 2,
    `dropped=[${dropped.join(",")}]`);
  assert("includes lostOnly2", dropped.includes("lostOnly2"));
  assert("includes favoriteColor", dropped.includes("favoriteColor"));
}

console.log("── 3. log: known-only query emits zero debug lines ──");
{
  const { calls } = captureDebug(() => logDroppedFilterKeys(
    "list",
    "org-1",
    { customerId: "cust-1", sortKey: "requestDate", offset: "0", limit: "50" },
  ));
  assert("no console.debug calls for clean query", calls.length === 0,
    `calls=${calls.length}`);
}

console.log("── 4. log: dirty query emits exactly one debug line with org id and keys ──");
{
  const { calls } = captureDebug(() => logDroppedFilterKeys(
    "snapshot",
    "org-42",
    { customerId: "cust-1", lostOnly2: "true", favoriteColor: "blue" },
  ));
  assert("exactly one console.debug call", calls.length === 1,
    `calls=${calls.length}`);
  const line = String(calls[0]?.[0] ?? "");
  assert("debug line mentions org-42", line.includes("org=org-42"), line);
  assert("debug line mentions snapshot route", line.includes("snapshot"), line);
  assert("debug line mentions lostOnly2", line.includes("lostOnly2"), line);
  assert("debug line mentions favoriteColor", line.includes("favoriteColor"), line);
}

console.log("── 5. parse-failure summary: dedupes and includes path:code ──");
{
  const schema = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    limit: z.number().int().min(1),
  });
  const result = schema.safeParse({ startDate: "garbage", limit: "notanumber" });
  assert("schema.safeParse fails on bad input", !result.success);
  if (!result.success) {
    const summary = summarizeFilterParseFailure(result.error.issues);
    assert("at least one issue token returned", summary.length >= 1,
      `summary=[${summary.join(",")}]`);
    assert("includes a startDate token", summary.some(t => t.startsWith("startDate:")),
      `summary=[${summary.join(",")}]`);
    assert("each token is path:code shaped", summary.every(t => /^[\w.()]+:[\w_]+$/.test(t)),
      `summary=[${summary.join(",")}]`);
    const dedup = summarizeFilterParseFailure([
      ...result.error.issues, ...result.error.issues,
    ]);
    assert("duplicate issues are deduped", dedup.length === summary.length,
      `dedup=${dedup.length} summary=${summary.length}`);
  }
}

console.log("── 6. logFilterParseFailure: emits exactly one line with org and tokens ──");
{
  const schema = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/) });
  const result = schema.safeParse({ startDate: "garbage" });
  assert("schema.safeParse fails", !result.success);
  if (!result.success) {
    const { calls } = captureDebug(() => logFilterParseFailure(
      "list", "org-77", result.error.issues,
    ));
    assert("exactly one console.debug call", calls.length === 1,
      `calls=${calls.length}`);
    const line = String(calls[0]?.[0] ?? "");
    assert("debug line mentions org-77", line.includes("org=org-77"), line);
    assert("debug line mentions parse failure", line.includes("parse failure"), line);
    assert("debug line mentions list route", line.includes("list"), line);
    assert("debug line mentions startDate token", line.includes("startDate:"), line);
  }
}

console.log("── 7. logFilterParseFailure: empty issues produce zero lines ──");
{
  const { calls } = captureDebug(() => logFilterParseFailure("list", "org-1", []));
  assert("no console.debug calls when issues=[]", calls.length === 0, `calls=${calls.length}`);
}

console.log("══════════════════════════════════════════════════════════════");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
