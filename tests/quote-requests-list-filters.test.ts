/**
 * Quote Requests — LIST endpoint filter parsing regression
 * (Task #850 — re-review fix)
 *
 * Bug: `parseFilters` and `applyMineOnly` in
 * `server/routes/customerQuotes.ts` re-parsed the full `req.query` against
 * `queryFiltersSchema`. That schema inherited `.strict()` from
 * `filtersSchema`, which rejects unknown keys. The LIST endpoint always
 * receives `sortKey`, `sortDir`, `offset`, and `limit` in the same query
 * string, so the strict parse failed and `parseFilters` silently returned
 * `{}` — dropping every filter on the LIST route, including the new
 * `includeSnoozed` and `mineOnly` toggles.
 *
 * Fix: removed `.strict()` from `filtersSchema`. Default Zod object mode
 * strips unknown keys instead of failing parse, so the declared filter
 * fields are preserved when sort/paging keys are present.
 *
 * This test imports `queryFiltersSchema` directly and asserts the
 * post-fix behaviour, so a future re-introduction of `.strict()` (or
 * any other regression that drops keys on the LIST path) is caught at
 * test time instead of in production.
 *
 * Run with: npx tsx tests/quote-requests-list-filters.test.ts
 */

import { queryFiltersSchema } from "../server/routes/customerQuotes.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.log(`  \u2717 ${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failures.push(`${description}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Quote Requests LIST — filter-parse regression (Task #850)");
console.log("══════════════════════════════════════════════════════════════");

console.log("── 1. LIST query (filters + sort + paging together) ──");
{
  const q = {
    customerId: "cust-123",
    outcomeStatus: "pending",
    mineOnly: "1",
    includeSnoozed: "1",
    wonOnly: "true",
    sortKey: "requestDate",
    sortDir: "desc",
    offset: "0",
    limit: "50",
  };
  const parsed = queryFiltersSchema.safeParse(q);
  assert("safeParse succeeds when sort/paging keys are present", parsed.success);
  if (parsed.success) {
    const d = parsed.data;
    assert("customerId preserved", d.customerId === "cust-123", `got ${d.customerId}`);
    assert("outcomeStatus preserved", d.outcomeStatus === "pending", `got ${d.outcomeStatus}`);
    assert("mineOnly coerced from '1' to true", d.mineOnly === true, `got ${d.mineOnly}`);
    assert("includeSnoozed coerced from '1' to true", d.includeSnoozed === true, `got ${d.includeSnoozed}`);
    assert("wonOnly coerced from 'true' to true", d.wonOnly === true, `got ${d.wonOnly}`);
  }
}

console.log("── 2. SNAPSHOT query (filters only, no sort/paging) ──");
{
  const q = {
    customerId: "cust-456",
    outcomeStatus: "won",
    mineOnly: "true",
  };
  const parsed = queryFiltersSchema.safeParse(q);
  assert("safeParse succeeds for snapshot-style request", parsed.success);
  if (parsed.success) {
    const d = parsed.data;
    assert("snapshot: customerId preserved", d.customerId === "cust-456");
    assert("snapshot: outcomeStatus preserved", d.outcomeStatus === "won");
    assert("snapshot: mineOnly true", d.mineOnly === true);
    // The preprocess coerces missing → false (not undefined). parseFilters
    // intentionally treats false as falsy via `if (d.includeSnoozed)`, so
    // the downstream filter object never receives the key — equivalent to
    // omission for routing purposes.
    assert("snapshot: includeSnoozed false when omitted (falsy → filter dropped)", d.includeSnoozed === false);
  }
}

console.log("── 3. mineOnly=false / 0 / undefined are falsy (filter dropped) ──");
{
  const cases: Array<[string, unknown]> = [
    ["mineOnly omitted", undefined],
    ["mineOnly = '0'", "0"],
    ["mineOnly = 'false'", "false"],
    ["mineOnly = ''", ""],
  ];
  for (const [label, raw] of cases) {
    const q: Record<string, unknown> = { sortKey: "requestDate", limit: "50" };
    if (raw !== undefined) q.mineOnly = raw;
    const parsed = queryFiltersSchema.safeParse(q);
    assert(
      `${label}: parse succeeds`,
      parsed.success,
    );
    if (parsed.success) {
      // The preprocess returns boolean false for any non-"1"/"true"
      // value. parseFilters guards on `if (d.mineOnly)` so false →
      // filter not applied. Either `false` or `undefined` is acceptable
      // here; the contract is "must be falsy".
      assert(
        `${label}: mineOnly is falsy`,
        !parsed.data.mineOnly,
        `got ${parsed.data.mineOnly}`,
      );
    }
  }
}

console.log("── 4. Unknown keys are stripped, not rejected ──");
{
  const q = {
    outcomeStatus: "pending",
    sortKey: "requestDate",
    sortDir: "desc",
    offset: "0",
    limit: "50",
    cursor: "deadbeef",
    bogus_extra: "xyz",
  };
  const parsed = queryFiltersSchema.safeParse(q);
  assert("safeParse succeeds despite unknown keys", parsed.success);
  if (parsed.success) {
    assert(
      "outcomeStatus still preserved alongside unknown keys",
      parsed.data.outcomeStatus === "pending",
    );
    // The schema isn't `.passthrough()`, so unknown keys must be absent
    // from parsed.data — strip mode, not passthrough.
    assert(
      "unknown key 'bogus_extra' is stripped from parsed.data",
      !("bogus_extra" in parsed.data),
    );
  }
}

console.log("──────────────────────────────────────────────────────────────");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────────────────");

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
