/**
 * Task #1147 — pin the route-level helper that produces `sortMeta` on
 * the Customer Quotes list response.
 *
 * The list endpoint must keep its safe `requestDate` fallback for stale
 * saved views / bookmarked URLs that reference a retired sort key
 * (e.g. `carrierPaid`, `marginDollar`, `marginPct`), but it must also
 * surface the coercion via `sortMeta` so the UI can render a one-line
 * notice and operators can grep the tagged debug line.
 *
 * Out of scope: actual route wiring / response shape is exercised by
 * the existing customer-quotes integration tests; this file pins the
 * pure helper in isolation so a refactor that drops `coerced: true`
 * fails fast.
 */
import { strict as assert } from "node:assert";
import { resolveSortKey } from "../server/routes/customerQuotes";

// 1. A known sort key passes through untouched and is NOT flagged as
//    coerced.
{
  const r = resolveSortKey("customerName");
  assert.equal(r.sortKey, "customerName");
  assert.equal(r.meta.requested, "customerName");
  assert.equal(r.meta.applied, "customerName");
  assert.equal(r.meta.coerced, false, "known key must not be marked coerced");
}

// 2. An unknown sort key (e.g. the retired `carrierPaid` column) coerces
//    to the default `requestDate` AND records the original request so
//    the UI can name it back to the rep.
{
  const r = resolveSortKey("carrierPaid");
  assert.equal(r.sortKey, "requestDate", "unknown key must fall back to requestDate");
  assert.equal(r.meta.requested, "carrierPaid");
  assert.equal(r.meta.applied, "requestDate");
  assert.equal(r.meta.coerced, true, "unknown key must be marked coerced");
}

// 3. A missing / undefined sort key uses the default and is NOT flagged
//    as coerced — the absence of an explicit key is the documented
//    healthy path, not a stale-view symptom.
{
  const r = resolveSortKey(undefined);
  assert.equal(r.sortKey, "requestDate");
  assert.equal(r.meta.requested, "requestDate");
  assert.equal(r.meta.applied, "requestDate");
  assert.equal(r.meta.coerced, false, "default (no key requested) must not be marked coerced");
}

console.log("customer-quotes-sort-meta.test.ts OK");
