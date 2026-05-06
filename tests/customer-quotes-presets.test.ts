/**
 * Pure-function regression tests for the Customer Quotes preset
 * helpers. The helpers live in
 * `client/src/pages/customer-quotes-presets.ts` so this file can
 * import them directly without dragging React or recharts into the
 * test process.
 *
 * Covers:
 *   1. presetToFilters returns the documented signature for every key.
 *   2. detectActivePreset round-trips presetToFilters.
 *   3. detectActivePreset prefers `myOpen` over `stale` when both
 *      would match (priority order).
 *   4. detectActivePreset returns null when the user has drifted
 *      off-preset (extra filter set).
 *   5. filtersEqual treats undefined / "" / false as equivalent so
 *      the chip stays active across the page's filter-cleanup paths.
 *   6. startOfWeekMondayIso anchors to Monday across edge days
 *      (Sunday, Monday, Wednesday).
 */
import { strict as assert } from "node:assert";
import {
  PRESETS,
  presetToFilters,
  detectActivePreset,
  startOfWeekMondayIso,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  isRepUnassigned,
  type PresetKey,
} from "../client/src/pages/customer-quotes-presets";

const REP = "rep-123";
// Wed 2026-04-29 → ISO week Monday is 2026-04-27.
const WED = new Date(2026, 3, 29, 12, 0, 0);
const MONDAY_ISO = "2026-04-27";

// 1. Every preset descriptor maps to a state.
assert.equal(PRESETS.length, 5, "expected 5 presets");
for (const p of PRESETS) {
  const s = presetToFilters(p.key, REP, WED);
  assert.ok(s.sortKey, `preset ${p.key} missing sortKey`);
  assert.ok(s.sortDir === "asc" || s.sortDir === "desc", `preset ${p.key} bad sortDir`);
}

// 1a. myOpen — activeOnly + repId, sorted oldest-first.
{
  const s = presetToFilters("myOpen", REP, WED);
  assert.deepEqual(s.filters, { activeOnly: true, repId: REP });
  assert.equal(s.sortKey, "requestDate");
  assert.equal(s.sortDir, "asc");
}

// 1b. stale — activeOnly only, oldest-first (uses backend ACTIVE_STATUSES = ["pending"]).
{
  const s = presetToFilters("stale", REP, WED);
  assert.deepEqual(s.filters, { activeOnly: true });
  assert.equal(s.sortKey, "requestDate");
  assert.equal(s.sortDir, "asc");
}

// 1c. wonWeek — wonOnly + startDate=Monday of this week.
{
  const s = presetToFilters("wonWeek", REP, WED);
  assert.deepEqual(s.filters, { wonOnly: true, startDate: MONDAY_ISO });
  assert.equal(s.sortDir, "desc", "won-week shows newest wins first");
}

// 1d. lost — lostOnly only.
{
  const s = presetToFilters("lost", REP, WED);
  assert.deepEqual(s.filters, { lostOnly: true });
  assert.equal(s.sortDir, "desc");
}

// 1e. all — empty filters at the page default sort. Task #837 flipped
//     the default to `requestDate desc` (newest first); we pin that
//     concretely here so a future regression of the constants would
//     fail this test loudly.
{
  const s = presetToFilters("all", REP, WED);
  assert.deepEqual(s.filters, {});
  assert.equal(s.sortKey, DEFAULT_SORT_KEY);
  assert.equal(s.sortDir, DEFAULT_SORT_DIR);
  assert.equal(s.sortKey, "requestDate", "all preset sort key");
  assert.equal(s.sortDir, "desc", "all preset sort dir (newest-first default)");
}

// 2. Round-trip: detectActivePreset recognises every preset's own state.
for (const p of PRESETS) {
  const s = presetToFilters(p.key, REP, WED);
  const detected = detectActivePreset(s.filters, s.sortKey, s.sortDir, REP, WED);
  assert.equal(detected, p.key, `round-trip failed for preset ${p.key}`);
}

// 3. Priority: myOpen wins over stale when the rep is logged in.
{
  const s = presetToFilters("myOpen", REP, WED);
  const detected = detectActivePreset(s.filters, s.sortKey, s.sortDir, REP, WED);
  assert.equal(detected, "myOpen", "myOpen must beat stale when repId matches");
}

// 3a. With no repId, myOpen state collapses to stale shape; detection
// should fall through to stale (since myOpen is skipped).
{
  // Simulate "what stale looks like" — myOpen without repId resolves
  // to {activeOnly: true, repId: undefined}; detection on that shape
  // with myRepId=null should pick stale.
  const detected = detectActivePreset(
    { activeOnly: true },
    "requestDate", "asc",
    null, WED,
  );
  assert.equal(detected, "stale");
}

// 4. Drift detection: extra filter knocks the chip off.
{
  const s = presetToFilters("lost", REP, WED);
  const drifted = { ...s.filters, equipment: "Reefer" };
  const detected = detectActivePreset(drifted, s.sortKey, s.sortDir, REP, WED);
  assert.equal(detected, null, "extra filter must drop the active preset");
}

// 4a. Wrong sort direction also drops the chip.
{
  const s = presetToFilters("stale", REP, WED);
  const detected = detectActivePreset(s.filters, s.sortKey, "desc", REP, WED);
  assert.equal(detected, null, "flipping sortDir must drop the active preset");
}

// 5. Filter normalization: undefined / "" / false are treated as
//    equivalent to "missing" so the chip stays lit when the page's
//    `clearAll` / `removeFilter` helpers leave behind empty values.
{
  const detected = detectActivePreset(
    { activeOnly: true, customerId: "", equipment: undefined, wonOnly: false },
    "requestDate", "asc",
    null, WED,
  );
  assert.equal(detected, "stale", "empty/false filter values must not break detection");
}

// 6. Week-Monday math.
{
  // Sun 2026-04-26 → previous Monday is 2026-04-20.
  const sun = new Date(2026, 3, 26, 23, 59, 0);
  assert.equal(startOfWeekMondayIso(sun), "2026-04-20");
  // Mon 2026-04-27 → itself.
  const mon = new Date(2026, 3, 27, 0, 0, 1);
  assert.equal(startOfWeekMondayIso(mon), "2026-04-27");
  // Wed 2026-04-29 → 2026-04-27.
  assert.equal(startOfWeekMondayIso(WED), "2026-04-27");
}

// 7. Type guard — every PRESETS entry is a known PresetKey.
{
  const allKeys: PresetKey[] = ["myOpen", "stale", "wonWeek", "lost", "all"];
  for (const p of PRESETS) {
    assert.ok(allKeys.includes(p.key), `unknown preset key: ${p.key}`);
  }
}

// 8. Task #837 — isRepUnassigned collapses every "no real owner"
//    server signal (null, "", whitespace, em-dash, ascii dash) to the
//    "render Unassigned" path; real names always read as assigned.
{
  // Unassigned signals from the server.
  assert.equal(isRepUnassigned(null), true, "null repName must be unassigned");
  assert.equal(isRepUnassigned(undefined), true, "undefined repName must be unassigned");
  assert.equal(isRepUnassigned(""), true, "empty repName must be unassigned");
  assert.equal(isRepUnassigned("   "), true, "whitespace repName must be unassigned");
  assert.equal(isRepUnassigned("—"), true, "em-dash repName must be unassigned");
  assert.equal(isRepUnassigned(" — "), true, "padded em-dash repName must be unassigned");
  assert.equal(isRepUnassigned("-"), true, "ascii dash repName must be unassigned");

  // Real names (linked-user or quote_reps fallback) must NOT collapse.
  assert.equal(isRepUnassigned("Jordan Reyes"), false, "real name must render as-is");
  assert.equal(isRepUnassigned("J"), false, "single-char name must render as-is");
  // Edge: a name that *contains* an em-dash (e.g. team alias) is real.
  assert.equal(isRepUnassigned("Team — Northeast"), false, "name containing em-dash is real");
}

console.log("customer-quotes-presets.test.ts OK");
