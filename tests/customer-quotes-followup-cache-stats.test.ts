// Task #1150 — pins the in-memory follow-up cache bust counter exposed
// by clearStaleFollowUpCache / getFollowUpCacheBustStats. The counter
// is the only observability signal we have on the org-wide bust that
// fires from PATCH /api/customer-quotes/quote/:id; if it stops
// incrementing we lose the ability to tell whether per-rep busting
// would actually help. Pure in-memory; no DB / no network.

import { strict as assert } from "node:assert";
import {
  clearStaleFollowUpCache,
  getFollowUpCacheBustStats,
  resetFollowUpCacheBustStatsForTests,
} from "../server/services/staleQuoteFollowup";

resetFollowUpCacheBustStatsForTests();

// 1. Baseline: empty.
{
  const s = getFollowUpCacheBustStats();
  assert.equal(s.totalBusts, 0, "baseline totalBusts must be 0");
  assert.equal(s.orgCount, 0, "baseline orgCount must be 0");
}

// 2. Per-call increment for the same org.
clearStaleFollowUpCache("org-A");
clearStaleFollowUpCache("org-A");
clearStaleFollowUpCache("org-A");
{
  const s = getFollowUpCacheBustStats();
  assert.equal(s.totals["org-A"], 3, "org-A must record 3 busts");
  assert.equal(s.totalBusts, 3, "totalBusts must equal sum across orgs");
  assert.equal(s.orgCount, 1, "orgCount must reflect distinct orgs");
}

// 3. A second org is tracked independently.
clearStaleFollowUpCache("org-B");
{
  const s = getFollowUpCacheBustStats();
  assert.equal(s.totals["org-A"], 3, "org-A count must not be affected by org-B");
  assert.equal(s.totals["org-B"], 1, "org-B must record 1 bust");
  assert.equal(s.totalBusts, 4);
  assert.equal(s.orgCount, 2);
}

// 4. The undefined-orgId clear() path (cache.clear()) is intentionally
//    NOT counted — it's a process-wide reset used in tests / shutdown,
//    not a bust we want to inflate the per-org metric with.
clearStaleFollowUpCache(undefined);
{
  const s = getFollowUpCacheBustStats();
  assert.equal(s.totalBusts, 4, "global clear() must not increment the counter");
  assert.equal(s.totals["org-A"], 3);
  assert.equal(s.totals["org-B"], 1);
}

console.log("✓ followup cache bust counter pins (Task #1150)");
