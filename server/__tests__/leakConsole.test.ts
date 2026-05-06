/**
 * Task #872 — Manager Leak Console unit tests.
 *
 * These tests cover the pure pieces of logic exposed by
 * `server/leakConsoleService.ts` and `server/routes/leakConsole.ts`:
 *
 *   1. tierFromSpend           — bucket boundary correctness for A/B/C/new.
 *   2. laneHealthFromVolatility — volatility penalty → health classification.
 *   3. extractVolatility       — pulls penalty out of the laneScoreFactors
 *                                 JSONB shape (and tolerates malformed input).
 *   4. trimDays                — clamps the trailing-window days param.
 *   5. applyFilters / paginate — owner / tier / health / window filters and
 *                                 the limit/offset slicer.
 *   6. parseFilters (route)    — query-string coercion (owner, team CSV,
 *                                 tier validation, integer coercion).
 *   7. FIX_OUTREACH_MODES      — every fix kind has either an outreach mode
 *                                 (string) or null (deep-link only).
 *   8. fix-payload schema      — every fix kind is enumerated and accepted.
 *
 * Pure helpers only — no DB or HTTP mocking. Run with:
 *   npx tsx --test server/__tests__/leakConsole.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __test as svc,
  type LeakRow,
  type LeakFilters,
} from "../leakConsoleService";
import { __test as routes } from "../routes/leakConsole";
import { LEAK_CONSOLE_FIX_KINDS, LEAK_CONSOLE_PANELS } from "@shared/schema";

const { tierFromSpend, laneHealthFromVolatility, extractVolatility, trimDays, applyFilters, paginate } = svc;
const { parseFilters, FIX_OUTREACH_MODES } = routes;

// ── Fixture builder ──────────────────────────────────────────────────────────

function row(p: Partial<LeakRow> = {}): LeakRow {
  return {
    laneId: p.laneId ?? "lane-1",
    laneSig: p.laneSig ?? "ATL_GA__MEM_TN__VAN",
    origin: p.origin ?? "Atlanta",
    originState: p.originState ?? "GA",
    destination: p.destination ?? "Memphis",
    destinationState: p.destinationState ?? "TN",
    equipmentType: p.equipmentType ?? "VAN",
    companyId: p.companyId ?? "co-1",
    companyName: p.companyName ?? "Acme",
    companyTier: p.companyTier ?? "B",
    ownerUserId: p.ownerUserId ?? "u-1",
    ownerName: p.ownerName ?? "Alice",
    laneScore: p.laneScore ?? 50,
    volatilityPenalty: p.volatilityPenalty ?? null,
    health: p.health ?? "stable",
    evidence: p.evidence ?? [],
  };
}

// ── 1. tierFromSpend ─────────────────────────────────────────────────────────

test("tierFromSpend: null/undefined/non-numeric → 'new'", () => {
  assert.equal(tierFromSpend(null), "new");
  assert.equal(tierFromSpend(undefined), "new");
  assert.equal(tierFromSpend("not-a-number"), "new");
  assert.equal(tierFromSpend(""), "new");
});

test("tierFromSpend: $1M boundary is inclusive for tier A", () => {
  assert.equal(tierFromSpend("999999"), "B");
  assert.equal(tierFromSpend("1000000"), "A");
  assert.equal(tierFromSpend("5000000"), "A");
});

test("tierFromSpend: $250k boundary is inclusive for tier B", () => {
  assert.equal(tierFromSpend("249999"), "C");
  assert.equal(tierFromSpend("250000"), "B");
  assert.equal(tierFromSpend("999999"), "B");
});

test("tierFromSpend: anything below $250k is C", () => {
  assert.equal(tierFromSpend("0"), "C");
  assert.equal(tierFromSpend("1"), "C");
  assert.equal(tierFromSpend("249999.99"), "C");
});

// ── 2. laneHealthFromVolatility ─────────────────────────────────────────────

test("laneHealthFromVolatility: 0/null/undefined → stable", () => {
  assert.equal(laneHealthFromVolatility(0), "stable");
  assert.equal(laneHealthFromVolatility(null), "stable");
  assert.equal(laneHealthFromVolatility(undefined), "stable");
  assert.equal(laneHealthFromVolatility(NaN), "stable");
});

test("laneHealthFromVolatility: ≤ -5 → hot", () => {
  assert.equal(laneHealthFromVolatility(-5), "hot");
  assert.equal(laneHealthFromVolatility(-10), "hot");
  assert.equal(laneHealthFromVolatility(-100), "hot");
});

test("laneHealthFromVolatility: any other negative → volatile", () => {
  assert.equal(laneHealthFromVolatility(-1), "volatile");
  assert.equal(laneHealthFromVolatility(-4.99), "volatile");
});

// ── 3. extractVolatility ─────────────────────────────────────────────────────

test("extractVolatility: pulls a numeric penalty from JSONB", () => {
  assert.equal(extractVolatility({ volatilityPenalty: -3 }), -3);
  assert.equal(extractVolatility({ volatilityPenalty: 0 }), 0);
});

test("extractVolatility: tolerates malformed input", () => {
  assert.equal(extractVolatility(null), null);
  assert.equal(extractVolatility(undefined), null);
  assert.equal(extractVolatility("string"), null);
  assert.equal(extractVolatility({}), null);
  assert.equal(extractVolatility({ volatilityPenalty: "not-numeric" }), null);
});

// ── 4. trimDays ──────────────────────────────────────────────────────────────

test("trimDays: clamps to fallback for invalid input", () => {
  assert.equal(trimDays(undefined, 14, 30), 14);
  assert.equal(trimDays(0, 14, 30), 14);
  assert.equal(trimDays(-3, 14, 30), 14);
  assert.equal(trimDays(NaN, 14, 30), 14);
});

test("trimDays: caps to maxDays and floors fractional values", () => {
  assert.equal(trimDays(7, 14, 30), 7);
  assert.equal(trimDays(45, 14, 30), 30);
  assert.equal(trimDays(7.9, 14, 30), 7);
});

// ── 5. applyFilters / paginate ───────────────────────────────────────────────

test("applyFilters: ownerUserId narrows to one rep", () => {
  const rows = [row({ laneId: "a", ownerUserId: "u-1" }), row({ laneId: "b", ownerUserId: "u-2" })];
  const out = applyFilters(rows, { ownerUserId: "u-2" });
  assert.deepEqual(out.map((r) => r.laneId), ["b"]);
});

test("applyFilters: teamUserIds keeps any owner in the set", () => {
  const rows = [
    row({ laneId: "a", ownerUserId: "u-1" }),
    row({ laneId: "b", ownerUserId: "u-2" }),
    row({ laneId: "c", ownerUserId: "u-3" }),
  ];
  const out = applyFilters(rows, { teamUserIds: ["u-1", "u-3"] });
  assert.deepEqual(out.map((r) => r.laneId), ["a", "c"]);
});

test("applyFilters: tier and health both apply", () => {
  const rows = [
    row({ laneId: "a", companyTier: "A", health: "stable" }),
    row({ laneId: "b", companyTier: "A", health: "hot" }),
    row({ laneId: "c", companyTier: "B", health: "hot" }),
  ];
  const out = applyFilters(rows, { tier: "A", health: "hot" });
  assert.deepEqual(out.map((r) => r.laneId), ["b"]);
});

test("applyFilters: empty filters returns input unchanged (no clone needed)", () => {
  const rows = [row({ laneId: "a" }), row({ laneId: "b" })];
  const out = applyFilters(rows, {});
  assert.deepEqual(out.map((r) => r.laneId), ["a", "b"]);
});

test("paginate: defaults to first 50 rows", () => {
  const rows = Array.from({ length: 75 }, (_, i) => row({ laneId: `l-${i}` }));
  const out = paginate(rows, {});
  assert.equal(out.length, 50);
  assert.equal(out[0]!.laneId, "l-0");
  assert.equal(out[49]!.laneId, "l-49");
});

test("paginate: respects offset/limit and clamps limit to 200", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ laneId: `l-${i}` }));
  const slice = paginate(rows, { offset: 10, limit: 5 });
  assert.equal(slice.length, 5);
  assert.equal(slice[0]!.laneId, "l-10");
  assert.equal(slice[4]!.laneId, "l-14");
  // Out-of-range offset returns empty.
  assert.equal(paginate(rows, { offset: 999, limit: 10 }).length, 0);
  // Limit clamped to 200 (still bounded by row count here).
  assert.equal(paginate(rows, { limit: 9999 }).length, 30);
});

// ── 6. parseFilters (route) ──────────────────────────────────────────────────

test("parseFilters: empty query → empty filters", () => {
  assert.deepEqual(parseFilters({}), {});
});

test("parseFilters: ownerUserId, tier, health, windowDays all coerce", () => {
  const out = parseFilters({
    ownerUserId: "u-7",
    tier: "A",
    health: "hot",
    windowDays: "21",
  });
  assert.deepEqual(out, { ownerUserId: "u-7", tier: "A", health: "hot", windowDays: 21 });
});

test("parseFilters: invalid tier/health silently dropped", () => {
  const out = parseFilters({ tier: "Z", health: "frozen" });
  assert.deepEqual(out, {});
});

test("parseFilters: team CSV splits + trims and drops empties", () => {
  const out = parseFilters({ team: "u-1, u-2 , ,u-3" });
  assert.deepEqual(out.teamUserIds, ["u-1", "u-2", "u-3"]);
});

test("parseFilters: limit/offset coerce to non-negative integers", () => {
  assert.deepEqual(parseFilters({ limit: "25", offset: "10" }), { limit: 25, offset: 10 });
  assert.deepEqual(parseFilters({ limit: "-3" }), {});
  assert.deepEqual(parseFilters({ offset: "-1" }), {});
  assert.deepEqual(parseFilters({ limit: "abc" }), {});
});

test("parseFilters: invalid windowDays dropped, valid kept", () => {
  assert.deepEqual(parseFilters({ windowDays: "0" }), {});
  assert.deepEqual(parseFilters({ windowDays: "-7" }), {});
  assert.deepEqual(parseFilters({ windowDays: "abc" }), {});
  assert.deepEqual(parseFilters({ windowDays: "14" }), { windowDays: 14 });
});

// ── 7. FIX_OUTREACH_MODES ────────────────────────────────────────────────────

test("FIX_OUTREACH_MODES: every fix kind is mapped (no silent drops)", () => {
  for (const kind of LEAK_CONSOLE_FIX_KINDS) {
    assert.ok(kind in FIX_OUTREACH_MODES, `Missing outreach mode mapping for ${kind}`);
    const mode = FIX_OUTREACH_MODES[kind];
    assert.ok(mode === null || (typeof mode === "string" && mode.length > 0));
  }
});

test("FIX_OUTREACH_MODES: pure deep-link fixes do NOT write a Lane Inbox event", () => {
  // build_bench just opens the LWQ outreach panel — no manager action has
  // happened yet, so it must not surface a false event in the Lane Inbox.
  assert.equal(FIX_OUTREACH_MODES.build_bench, null);
});

test("FIX_OUTREACH_MODES: surfacing fixes use the leak_console_ prefix", () => {
  // Lane Inbox renderer keys off the leak_console_ prefix to choose its label.
  // Every surfacing fix must therefore begin with it so the inbox can pick
  // a friendly label without a giant switch.
  for (const kind of [
    "reassign_owner",
    "stabilize",
    "demote_from_recurring",
    "push_to_lwq_owner",
    "nudge_owner",
  ] as const) {
    const mode = FIX_OUTREACH_MODES[kind];
    assert.ok(mode && mode.startsWith("leak_console_"), `${kind} mode should start with leak_console_`);
  }
});

// ── 8. Schema enums match expected shape ─────────────────────────────────────

test("LEAK_CONSOLE_PANELS: shape is exactly the 4 documented panels", () => {
  assert.deepEqual([...LEAK_CONSOLE_PANELS].sort(), [
    "no_contactable_under_demand",
    "owned_untouched_under_pressure",
    "recurring_covered_on_spot",
    "unstable_spot_deployed",
  ]);
});

test("LEAK_CONSOLE_FIX_KINDS: includes all 6 documented fix actions", () => {
  for (const k of [
    "build_bench",
    "reassign_owner",
    "stabilize",
    "demote_from_recurring",
    "push_to_lwq_owner",
    "nudge_owner",
  ] as const) {
    assert.ok(LEAK_CONSOLE_FIX_KINDS.includes(k), `Missing fix kind: ${k}`);
  }
});

// ── 9. Combined pipeline smoke ───────────────────────────────────────────────

test("applyFilters + paginate compose deterministically", () => {
  const rows = [
    row({ laneId: "a", ownerUserId: "u-1", companyTier: "A", health: "hot" }),
    row({ laneId: "b", ownerUserId: "u-1", companyTier: "A", health: "stable" }),
    row({ laneId: "c", ownerUserId: "u-2", companyTier: "A", health: "hot" }),
    row({ laneId: "d", ownerUserId: "u-1", companyTier: "B", health: "hot" }),
  ];
  const filters: LeakFilters = { ownerUserId: "u-1", tier: "A", limit: 1 };
  const out = paginate(applyFilters(rows, filters), filters);
  assert.deepEqual(out.map((r) => r.laneId), ["a"]);
});
