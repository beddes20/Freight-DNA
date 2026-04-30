/**
 * Task #863 polish — Saved Views round-trip regression.
 *
 * The /quote-requests page persists views with the UI-shaped filter
 * payload (status / age / mineOnly / freeEmailOnly / domainFilter /
 * search / pastSlaOnly / includeSnoozed). Earlier the route reused
 * the LIST query's `filtersSchema`, which silently stripped every
 * UI-only key — so a saved view round-tripped to {} or close to it
 * and the rep landed on the wrong workspace.
 *
 * This test pins the `savedViewFiltersSchema` contract: every UI key
 * the dropdown emits MUST survive parse → store → re-parse with no
 * loss. The schema is `passthrough()` so any future UI-only filter
 * also persists without a server change; that branch is covered too.
 */
import { strict as assert } from "node:assert";
import { savedViewFiltersSchema } from "../server/routes/customerQuotes";

// 1. Full UI payload from SavedViewsDropdown's QuoteViewFilters.
const fullUiPayload = {
  status: "new",
  age: "today",
  mineOnly: true,
  freeEmailOnly: true,
  includeSnoozed: false,
  search: "ATL to MIA",
  domainFilter: "acme.com",
  pastSlaOnly: true,
};

const parsed = savedViewFiltersSchema.parse(fullUiPayload);
assert.deepEqual(
  parsed,
  fullUiPayload,
  "every UI filter key must round-trip without being stripped",
);

// 2. domainFilter explicitly nullable (the page stores `null` when
//    cleared; that branch must also survive).
const nulledDomain = { ...fullUiPayload, domainFilter: null };
const parsedNull = savedViewFiltersSchema.parse(nulledDomain);
assert.equal(
  parsedNull.domainFilter,
  null,
  "domainFilter=null must round-trip (cleared-customer state)",
);

// 3. Empty payload is valid (default for the "Save current view…"
//    flow when nothing is filtered).
const empty = savedViewFiltersSchema.parse({});
assert.deepEqual(empty, {}, "empty payload must parse to {}");

// 4. Built-in view shapes — pin every BUILT_INS entry so a future
//    rename in SavedViewsDropdown.tsx that drifts a key doesn't
//    silently break the persisted default.
const builtInShapes = [
  { status: "new", age: "30d", mineOnly: false },                  // all_open
  { status: "all", age: "today", mineOnly: true },                 // today_mine
  { status: "new", age: "today" },                                 // new_today
  { status: "new", age: "7d", pastSlaOnly: true },                 // past_sla
  { status: "won", age: "today" },                                 // won_today
];
for (const s of builtInShapes) {
  assert.deepEqual(
    savedViewFiltersSchema.parse(s),
    s,
    `built-in view shape must round-trip: ${JSON.stringify(s)}`,
  );
}

// 5. Passthrough — a future client-only knob (e.g. equipmentChip)
//    must persist without a server change. If this assertion ever
//    fails because the schema dropped to a strict mode, the comment
//    block above explains why passthrough is intentional.
const future = { status: "new", equipmentChip: "reefer", customSort: 7 };
const parsedFuture = savedViewFiltersSchema.parse(future);
assert.equal(
  (parsedFuture as Record<string, unknown>).equipmentChip,
  "reefer",
  "passthrough must keep unknown UI-only keys",
);
assert.equal(
  (parsedFuture as Record<string, unknown>).customSort,
  7,
  "passthrough must keep unknown UI-only keys (number values too)",
);

// 6. Defensive: garbage types on known keys still rejected (we only
//    relaxed unknown keys, not the typed ones).
assert.throws(
  () => savedViewFiltersSchema.parse({ mineOnly: "yes please" }),
  "typed UI keys must still validate (mineOnly should be boolean)",
);
assert.throws(
  () => savedViewFiltersSchema.parse({ search: "x".repeat(200) }),
  "search length cap should still apply",
);

console.log("Saved-view filter schema round-trip: OK (8 cases)");
