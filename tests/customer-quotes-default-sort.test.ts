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
 * Background (Task #837): the default for this portlet is
 * `requestDate desc` so it behaves like a recent Customer Quotes
 * list. The SLA / oldest-first workflow remains one click away via
 * the My Open and Stale preset chips, both of which pin their own
 * `requestDate asc` sort and are exercised below.
 */
import { strict as assert } from "node:assert";
import {
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  presetToFilters,
} from "../client/src/pages/customer-quotes-presets";

// 1. The literal contract — change here only with intent.
assert.equal(DEFAULT_SORT_KEY, "requestDate", "default sort key must be requestDate");
assert.equal(DEFAULT_SORT_DIR, "desc", "default sort direction must be desc (newest first) — Task #837");

// 2. The "All" preset — which is the explicit reset chip — must
//    resolve to the same default (so clicking All from any drifted
//    state lands the user on the documented baseline).
{
  const s = presetToFilters("all", null, new Date(2026, 3, 29));
  assert.equal(s.sortKey, DEFAULT_SORT_KEY);
  assert.equal(s.sortDir, DEFAULT_SORT_DIR);
  assert.equal(s.sortDir, "desc", "All preset must inherit the new desc default");
  assert.deepEqual(s.filters, {});
}

// 3. Stale + myOpen still pin `requestDate asc` so the SLA workflow
//    (oldest-actionable-first) is preserved as a one-click chip even
//    though the page-level default flipped to desc.
{
  const stale = presetToFilters("stale", null, new Date(2026, 3, 29));
  assert.equal(stale.sortKey, "requestDate");
  assert.equal(stale.sortDir, "asc", "Stale preset must keep its pinned asc sort (SLA queue)");
  const mine = presetToFilters("myOpen", "rep-1", new Date(2026, 3, 29));
  assert.equal(mine.sortKey, "requestDate");
  assert.equal(mine.sortDir, "asc", "My Open preset must keep its pinned asc sort (SLA queue)");
}

console.log("customer-quotes-default-sort.test.ts OK");
