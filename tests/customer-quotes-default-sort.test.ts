/**
 * Guards the Customer Quotes table's default sort contract.
 *
 * The page initialises `sortKey` / `sortDir` from
 * `DEFAULT_SORT_KEY` / `DEFAULT_SORT_DIR` in
 * `client/src/pages/customer-quotes-presets.ts`. Flipping these
 * constants would silently change what reps see on first load, so we
 * pin them here. If the contract genuinely changes, update both this
 * test AND the doc comment in the helper file.
 *
 * Background: the previous default was `requestDate desc` (newest
 * first), which buried older actionable quotes. The new default
 * surfaces the OLDEST actionable quote at the top so reps can clear
 * the queue from the bottom up.
 */
import { strict as assert } from "node:assert";
import {
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  presetToFilters,
} from "../client/src/pages/customer-quotes-presets";

// 1. The literal contract — change here only with intent.
assert.equal(DEFAULT_SORT_KEY, "requestDate", "default sort key must be requestDate");
assert.equal(DEFAULT_SORT_DIR, "asc", "default sort direction must be asc (oldest first)");

// 2. The "All" preset — which is the explicit reset chip — must
//    resolve to the same default (so clicking All from any drifted
//    state lands the user on the documented baseline).
{
  const s = presetToFilters("all", null, new Date(2026, 3, 29));
  assert.equal(s.sortKey, DEFAULT_SORT_KEY);
  assert.equal(s.sortDir, DEFAULT_SORT_DIR);
  assert.deepEqual(s.filters, {});
}

// 3. Stale + myOpen also use ascending requestDate so the "oldest
//    first" intent carries through the actionable views.
{
  const stale = presetToFilters("stale", null, new Date(2026, 3, 29));
  assert.equal(stale.sortKey, "requestDate");
  assert.equal(stale.sortDir, "asc");
  const mine = presetToFilters("myOpen", "rep-1", new Date(2026, 3, 29));
  assert.equal(mine.sortKey, "requestDate");
  assert.equal(mine.sortDir, "asc");
}

console.log("customer-quotes-default-sort.test.ts OK");
