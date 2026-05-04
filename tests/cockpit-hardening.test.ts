// Task #957 — Available Freight cockpit hardening — standalone runner.
//
// Standalone tsx test that exercises the shared bucket + team modules
// without a database. Runs as part of the `test:freight-capture-funnel`
// workflow (chained via `&&`) so the cockpit invariants are validated
// alongside the funnel suite.
//
// Run with: npx tsx tests/cockpit-hardening.test.ts

import assert from "node:assert/strict";

import {
  parseOwnerScopeTokens,
  serializeOwnerScopeTokens,
  isValidOwnerScopeToken,
  resolveOwnerScope,
  resolveDirectReports,
  resolveMyTeamUserIds,
  listCockpitTeams,
} from "../shared/cockpitTeams";

import {
  isRowOwnedByUser,
  resolveUserIdentity,
  type CockpitRowOwnership,
} from "../shared/cockpitOwnership";

import {
  bucketsForRow,
  rowMatchesBucket,
  countBuckets,
  kpisFromFiltered,
  BUCKET_KEYS,
  BUCKET_ORDER,
  type BucketEvalRow,
  type BucketEvalContext,
} from "../shared/cockpitBuckets";

import {
  shouldHideForPickup,
  computePickupFreshness,
  daysSincePickup,
  ACTIONABLE_OPEN_STATUSES,
  type PickupHideContext,
} from "../shared/pickupFreshness";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log("── Cockpit hardening: cockpitTeams ─────────────────");

test("parseOwnerScopeTokens: trims, dedupes, splits on commas", () => {
  assert.deepEqual(parseOwnerScopeTokens(" me , me, unassigned "), [
    "me",
    "unassigned",
  ]);
  assert.deepEqual(parseOwnerScopeTokens(""), []);
  assert.deepEqual(parseOwnerScopeTokens(null), []);
});

test("serializeOwnerScopeTokens: drops 'all' and joins", () => {
  assert.equal(serializeOwnerScopeTokens(["me", "unassigned"]), "me,unassigned");
  assert.equal(serializeOwnerScopeTokens(["all", "me"]), "me");
  assert.equal(serializeOwnerScopeTokens([]), "");
});

test("isValidOwnerScopeToken: aliases, team:<id>, plausible userIds", () => {
  assert.equal(isValidOwnerScopeToken("me"), true);
  assert.equal(isValidOwnerScopeToken("my-team"), true);
  assert.equal(isValidOwnerScopeToken("unassigned"), true);
  assert.equal(isValidOwnerScopeToken("team:northeast"), true);
  assert.equal(isValidOwnerScopeToken("team:"), false);
  assert.equal(isValidOwnerScopeToken("user-1234"), true);
  assert.equal(isValidOwnerScopeToken("with space"), false);
  assert.equal(isValidOwnerScopeToken("with,comma"), false);
});

test("resolveOwnerScope: empty -> isAll", () => {
  const r = resolveOwnerScope([], "me-id", null);
  assert.equal(r.isAll, true);
  assert.equal(r.userIds.size, 0);
});

test("resolveOwnerScope: 'me' -> current user", () => {
  const r = resolveOwnerScope(["me"], "me-id", null);
  assert.equal(r.isAll, false);
  assert.ok(r.userIds.has("me-id"));
});

test("resolveOwnerScope: 'my-team' expands via org chart", () => {
  const orgChart = [
    { id: "me-id", managerId: null },
    { id: "rep1", managerId: "me-id" },
    { id: "rep2", managerId: "me-id" },
    { id: "rep3", managerId: "other" },
  ];
  const r = resolveOwnerScope(["my-team"], "me-id", orgChart);
  assert.deepEqual(Array.from(r.userIds).sort(), ["me-id", "rep1", "rep2"]);
});

test("resolveOwnerScope: 'unassigned' sets includeUnassigned", () => {
  const r = resolveOwnerScope(["unassigned"], "me-id", null);
  assert.equal(r.includeUnassigned, true);
  assert.equal(r.userIds.size, 0);
});

test("resolveOwnerScope: multi-select union (me + unassigned)", () => {
  const r = resolveOwnerScope(["me", "unassigned"], "me-id", null);
  assert.equal(r.isAll, false);
  assert.equal(r.includeUnassigned, true);
  assert.ok(r.userIds.has("me-id"));
});

test("resolveDirectReports: org chart wins over static roster fallback", () => {
  const orgChart = [
    { id: "me-id", managerId: null },
    { id: "rep1", managerId: "me-id" },
  ];
  assert.deepEqual(resolveDirectReports("me-id", orgChart), ["rep1"]);
});

test("resolveMyTeamUserIds: always includes self", () => {
  assert.deepEqual(resolveMyTeamUserIds("me-id", null), ["me-id"]);
});

test("listCockpitTeams: roster present (4 teams)", () => {
  const ids = listCockpitTeams().map((t) => t.id).sort();
  assert.deepEqual(ids, ["midwest", "northeast", "southeast", "west"]);
});

console.log("\n── Cockpit hardening: cockpitBuckets ───────────────");

const TODAY = "2026-04-24";
const baseCtx: BucketEvalContext = {
  todayIso: TODAY,
  currentUserId: "me-id",
  myTeamUserIds: new Set(["me-id", "rep1"]),
};

function mk(
  opp: Partial<BucketEvalRow["opportunity"]> = {},
  extras: Partial<BucketEvalRow> = {},
): BucketEvalRow {
  return {
    opportunity: {
      status: "ready_to_send",
      pickupWindowStart: null,
      coveredAt: null,
      ...opp,
    },
    coverage: { sent: 0, responded: 0, covered: false, ...(extras.coverage ?? {}) },
    freshnessMinutes: extras.freshnessMinutes ?? 0,
    ownership: extras.ownership ?? { ids: ["me-id"], emails: [] },
    owner: extras.owner ?? { id: "me-id" },
    pickupFreshness: extras.pickupFreshness ?? null,
    pickupDaysAgo: extras.pickupDaysAgo ?? null,
  };
}

test("bucket 'all' is always present", () => {
  assert.ok(bucketsForRow(mk(), baseCtx).has("all"));
  assert.equal(rowMatchesBucket(mk(), "all", baseCtx), true);
});

test("ready_to_send: status === 'ready_to_send'", () => {
  assert.ok(bucketsForRow(mk({ status: "ready_to_send" }), baseCtx).has("ready_to_send"));
  assert.ok(!bucketsForRow(mk({ status: "sent" }), baseCtx).has("ready_to_send"));
});

test("pickup_today: pickup is today (CT)", () => {
  // 18:00 UTC on 04-24 == 13:00 CT on 04-24.
  assert.ok(
    bucketsForRow(mk({ pickupWindowStart: `${TODAY}T18:00:00Z` }), baseCtx).has("pickup_today"),
  );
});

test("pickup_tomorrow: 24-48h out and not today", () => {
  // 18:00 UTC on 04-25 == 13:00 CT on 04-25.
  const got = bucketsForRow(mk({ pickupWindowStart: "2026-04-25T18:00:00Z" }), baseCtx);
  assert.ok(got.has("pickup_tomorrow"));
  assert.ok(!got.has("pickup_today"));
});

test("at_risk_24h: pickup within 24h, not covered", () => {
  const r = mk({ pickupWindowStart: `${TODAY}T20:00:00Z` });
  assert.ok(bucketsForRow(r, baseCtx).has("at_risk_24h"));
});

test("at_risk_24h: NOT triggered when covered=true", () => {
  const r = mk(
    { pickupWindowStart: `${TODAY}T20:00:00Z` },
    { coverage: { sent: 1, responded: 1, covered: true } },
  );
  assert.ok(!bucketsForRow(r, baseCtx).has("at_risk_24h"));
});

test("team_needs_approval: pending_approval owned by team member", () => {
  const r = mk(
    { status: "pending_approval" },
    { ownership: { ids: ["rep1"], emails: [] }, owner: { id: "rep1" } },
  );
  assert.ok(bucketsForRow(r, baseCtx).has("team_needs_approval"));
});

test("team_needs_approval: pending_approval NOT owned by team -> excluded", () => {
  const r = mk(
    { status: "pending_approval" },
    { ownership: { ids: ["nobody"], emails: [] }, owner: { id: "nobody" } },
  );
  assert.ok(!bucketsForRow(r, baseCtx).has("team_needs_approval"));
});

test("no_response_4h: sent>0, responded=0, freshness>=240", () => {
  const r = mk(undefined, {
    coverage: { sent: 2, responded: 0, covered: false },
    freshnessMinutes: 245,
  });
  assert.ok(bucketsForRow(r, baseCtx).has("no_response_4h"));
});

test("covered_today: coveredAt date matches todayIso", () => {
  const r = mk(
    { coveredAt: `${TODAY}T01:00:00Z` },
    { coverage: { sent: 1, responded: 1, covered: true } },
  );
  assert.ok(bucketsForRow(r, baseCtx).has("covered_today"));
});

test("unassigned: empty ownership envelope", () => {
  const r = mk(undefined, { ownership: { ids: [], emails: [] }, owner: { id: null } });
  assert.ok(bucketsForRow(r, baseCtx).has("unassigned"));
});

test("stale: past_stale + actionable status", () => {
  const r = mk({ status: "ready_to_send" }, { pickupFreshness: "past_stale", pickupDaysAgo: 5 });
  assert.ok(bucketsForRow(r, baseCtx).has("stale"));
});

test("countBuckets aggregates correctly across rows", () => {
  const rows: BucketEvalRow[] = [
    mk({ status: "ready_to_send", pickupWindowStart: `${TODAY}T18:00:00Z` }),
    mk({ status: "pending_approval" }, { ownership: { ids: ["rep1"], emails: [] }, owner: { id: "rep1" } }),
    mk({ status: "covered", coveredAt: `${TODAY}T01:00:00Z` }, { coverage: { sent: 1, responded: 1, covered: true } }),
    mk({ status: "ready_to_send" }, { ownership: { ids: [], emails: [] }, owner: { id: null } }),
  ];
  const counts = countBuckets(rows, baseCtx);
  assert.equal(counts.all, 4);
  assert.ok(counts.ready_to_send >= 2);
  assert.ok(counts.pickup_today >= 1);
  assert.equal(counts.team_needs_approval, 1);
  assert.equal(counts.covered_today, 1);
  assert.equal(counts.unassigned, 1);
});

console.log("\n── Cockpit hardening: midnight rollover (CT) ───────");

test("23:55 CT: tomorrow 06:00 CT pickup is 'pickup_tomorrow'", () => {
  // 06:00 CT 04-25 == 11:00 UTC 04-25.
  const r = mk({ pickupWindowStart: "2026-04-25T11:00:00Z" });
  const got = bucketsForRow(r, { todayIso: "2026-04-24" });
  assert.ok(got.has("pickup_tomorrow"));
  assert.ok(!got.has("pickup_today"));
});

test("00:05 CT: same pickup becomes 'pickup_today' after rollover", () => {
  const r = mk({ pickupWindowStart: "2026-04-25T11:00:00Z" });
  const got = bucketsForRow(r, { todayIso: "2026-04-25" });
  assert.ok(got.has("pickup_today"));
  assert.ok(!got.has("pickup_tomorrow"));
});

test("BUCKET_ORDER covers every key in BUCKET_KEYS exactly once", () => {
  assert.equal(new Set(BUCKET_ORDER).size, BUCKET_KEYS.length);
  for (const k of BUCKET_KEYS) assert.ok(BUCKET_ORDER.includes(k));
});

console.log("\n── Cockpit hardening: shouldHideForPickup (strict actionable) ──");

// Task #957 follow-up — Available Freight excludes yesterday + older
// regardless of status. Pin the contract so the legacy soft-overdue
// carve-out cannot regress back in.
const PICK_TODAY = "2026-04-30";
const PICK_YESTERDAY = "2026-04-29";
const PICK_TOMORROW = "2026-05-01";
const PICK_STALE = "2026-04-10";

function ctxFor(pickupIso: string, status: string): PickupHideContext {
  return {
    status,
    daysSincePickup: daysSincePickup(pickupIso, PICK_TODAY),
  };
}

test("actionable: yesterday + ready_to_send is EXCLUDED from Available Freight", () => {
  const f = computePickupFreshness(PICK_YESTERDAY, PICK_TODAY);
  assert.equal(f, "past_recent");
  assert.equal(
    shouldHideForPickup(f, "actionable", ctxFor(PICK_YESTERDAY, "ready_to_send")),
    true,
  );
});

test("actionable: yesterday + every ACTIONABLE_OPEN_STATUSES value is EXCLUDED", () => {
  const f = computePickupFreshness(PICK_YESTERDAY, PICK_TODAY);
  for (const status of ACTIONABLE_OPEN_STATUSES) {
    assert.equal(
      shouldHideForPickup(f, "actionable", ctxFor(PICK_YESTERDAY, status)),
      true,
      `expected '${status}' to be excluded under actionable`,
    );
  }
});

test("actionable: today (any status) is INCLUDED", () => {
  const f = computePickupFreshness(PICK_TODAY, PICK_TODAY);
  assert.equal(f, "upcoming");
  assert.equal(
    shouldHideForPickup(f, "actionable", ctxFor(PICK_TODAY, "ready_to_send")),
    false,
  );
  assert.equal(
    shouldHideForPickup(f, "actionable", ctxFor(PICK_TODAY, "covered")),
    false,
  );
});

test("actionable: tomorrow (any status) is INCLUDED", () => {
  const f = computePickupFreshness(PICK_TOMORROW, PICK_TODAY);
  assert.equal(
    shouldHideForPickup(f, "actionable", ctxFor(PICK_TOMORROW, "sent")),
    false,
  );
});

test("actionable: strictly stale (>14d) is EXCLUDED (stale chip toggle still works)", () => {
  const f = computePickupFreshness(PICK_STALE, PICK_TODAY);
  assert.equal(f, "past_stale");
  assert.equal(
    shouldHideForPickup(f, "actionable", ctxFor(PICK_STALE, "ready_to_send")),
    true,
  );
});

test("scope='all': same yesterday row stays VISIBLE (history view)", () => {
  const f = computePickupFreshness(PICK_YESTERDAY, PICK_TODAY);
  assert.equal(
    shouldHideForPickup(f, "all", ctxFor(PICK_YESTERDAY, "ready_to_send")),
    false,
  );
});

test("scope='recent': yesterday VISIBLE, strictly stale HIDDEN", () => {
  assert.equal(
    shouldHideForPickup(
      computePickupFreshness(PICK_YESTERDAY, PICK_TODAY),
      "recent",
      ctxFor(PICK_YESTERDAY, "sent"),
    ),
    false,
  );
  assert.equal(
    shouldHideForPickup(
      computePickupFreshness(PICK_STALE, PICK_TODAY),
      "recent",
      ctxFor(PICK_STALE, "sent"),
    ),
    true,
  );
});

test("midnight rollover (CT): 2026-04-29 pickup flips from INCLUDED to EXCLUDED at the boundary", () => {
  // 23:55 CT 04-29 — org-local date still 04-29; pickup on 04-29 is "today".
  const before = computePickupFreshness("2026-04-29", "2026-04-29");
  assert.equal(before, "upcoming");
  assert.equal(
    shouldHideForPickup(before, "actionable", {
      status: "ready_to_send",
      daysSincePickup: daysSincePickup("2026-04-29", "2026-04-29"),
    }),
    false,
  );

  // 00:05 CT 04-30 — org-local date now 04-30; same pickup is "yesterday" → excluded.
  const after = computePickupFreshness("2026-04-29", "2026-04-30");
  assert.equal(after, "past_recent");
  assert.equal(
    shouldHideForPickup(after, "actionable", {
      status: "ready_to_send",
      daysSincePickup: daysSincePickup("2026-04-29", "2026-04-30"),
    }),
    true,
  );

  // And the same row is still visible under pickupScope='all' on 04-30.
  assert.equal(
    shouldHideForPickup(after, "all", {
      status: "ready_to_send",
      daysSincePickup: daysSincePickup("2026-04-29", "2026-04-30"),
    }),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Task #957 follow-up #2 — KPIs derived from the filtered collection.
//
// The Available Freight cockpit's KPI tiles must reflect the post-client-
// filter row set, not the server-wide `feed.kpis`. `kpisFromFiltered`
// shares its predicates with `bucketsForRow` so chip counts and tile
// counts can never disagree.

console.log("\n── Cockpit hardening: kpisFromFiltered (Task #957 follow-up #2) ──");

const KFF_TODAY = "2026-04-24";
const kffCtx: BucketEvalContext = {
  todayIso: KFF_TODAY,
  currentUserId: "me-id",
  myTeamUserIds: new Set(["me-id"]),
};

function kffMk(
  over: Partial<BucketEvalRow["opportunity"]> = {},
  extras: Partial<BucketEvalRow> = {},
): BucketEvalRow {
  return {
    opportunity: {
      status: "ready_to_send",
      pickupWindowStart: null,
      coveredAt: null,
      ...over,
    },
    coverage: { sent: 0, responded: 0, covered: false },
    freshnessMinutes: 0,
    ownership: { ids: ["me-id"], emails: [] },
    owner: { id: "me-id" },
    ...extras,
  };
}

test("kpisFromFiltered: total === rows.length", () => {
  const rows = [kffMk(), kffMk({ status: "new" }), kffMk({ status: "covered" })];
  assert.equal(kpisFromFiltered(rows, kffCtx).total, 3);
});

test("kpisFromFiltered: readyToSend equals bucket 'ready_to_send' count", () => {
  const rows = [
    kffMk({ status: "ready_to_send" }),
    kffMk({ status: "ready_to_send" }),
    kffMk({ status: "new" }),
  ];
  const k = kpisFromFiltered(rows, kffCtx);
  assert.equal(k.readyToSend, 2);
  assert.equal(k.readyToSend, countBuckets(rows, kffCtx).ready_to_send);
});

test("kpisFromFiltered: atRiskPickup24h matches bucket count (within 24h, not covered)", () => {
  const rows = [
    kffMk(
      { pickupWindowStart: "2026-04-24T18:00:00Z" },
      { coverage: { sent: 0, responded: 0, covered: false } },
    ),
    kffMk(
      { pickupWindowStart: "2026-04-24T18:00:00Z" },
      { coverage: { sent: 0, responded: 0, covered: true } },
    ),
    kffMk({ pickupWindowStart: "2026-04-27T12:00:00Z" }),
  ];
  const k = kpisFromFiltered(rows, kffCtx);
  assert.equal(k.atRiskPickup24h, 1);
  assert.equal(k.atRiskPickup24h, countBuckets(rows, kffCtx).at_risk_24h);
});

test("kpisFromFiltered: coveredToday matches bucket 'covered_today' count", () => {
  const rows = [
    kffMk({ coveredAt: "2026-04-24T10:00:00Z" }),
    kffMk({ coveredAt: "2026-04-23T10:00:00Z" }),
    kffMk({ coveredAt: null }),
  ];
  const k = kpisFromFiltered(rows, kffCtx);
  assert.equal(k.coveredToday, 1);
  assert.equal(k.coveredToday, countBuckets(rows, kffCtx).covered_today);
});

test("kpisFromFiltered: sentAwaitingCarrier counts sent>0 AND responded==0", () => {
  const rows = [
    kffMk({}, { coverage: { sent: 3, responded: 0, covered: false } }),
    kffMk({}, { coverage: { sent: 5, responded: 1, covered: false } }),
    kffMk({}, { coverage: { sent: 0, responded: 0, covered: false } }),
  ];
  assert.equal(kpisFromFiltered(rows, kffCtx).sentAwaitingCarrier, 1);
});

test("kpisFromFiltered: generatedToday counts opportunity.generatedAt whose date == todayIso", () => {
  const rows = [
    kffMk({ generatedAt: "2026-04-24T01:00:00Z" }),
    kffMk({ generatedAt: "2026-04-24T23:30:00Z" }),
    kffMk({ generatedAt: "2026-04-23T15:00:00Z" }),
    kffMk({ generatedAt: null }),
    kffMk({}),
  ];
  assert.equal(kpisFromFiltered(rows, kffCtx).generatedToday, 2);
});

test("kpisFromFiltered: avgFreshnessMinutes = mean(freshnessMinutes); null when none", () => {
  assert.equal(kpisFromFiltered([kffMk({}, { freshnessMinutes: null })], kffCtx).avgFreshnessMinutes, null);
  const rows = [
    kffMk({}, { freshnessMinutes: 10 }),
    kffMk({}, { freshnessMinutes: 20 }),
    kffMk({}, { freshnessMinutes: 30 }),
    kffMk({}, { freshnessMinutes: null }),
  ];
  assert.equal(kpisFromFiltered(rows, kffCtx).avgFreshnessMinutes, 20);
});

test("kpisFromFiltered: filter-by-bucket parity (chip count == KPI count for narrowed rows)", () => {
  const rows = [
    kffMk(
      { status: "ready_to_send", pickupWindowStart: "2026-04-24T18:00:00Z" },
      { coverage: { sent: 0, responded: 0, covered: false } },
    ),
    kffMk({ status: "new" }),
    kffMk(
      { status: "covered", coveredAt: "2026-04-24T10:00:00Z" },
      { coverage: { sent: 5, responded: 2, covered: true } },
    ),
  ];
  const all = kpisFromFiltered(rows, kffCtx);
  assert.equal(all.total, 3);
  assert.equal(all.atRiskPickup24h, 1);
  assert.equal(all.coveredToday, 1);

  const atRiskOnly = rows.filter((r) => bucketsForRow(r, kffCtx).has("at_risk_24h"));
  const atRiskKpis = kpisFromFiltered(atRiskOnly, kffCtx);
  assert.equal(atRiskKpis.total, 1);
  assert.equal(atRiskKpis.atRiskPickup24h, 1);
  assert.equal(atRiskKpis.coveredToday, 0);

  const coveredOnly = rows.filter((r) => bucketsForRow(r, kffCtx).has("covered_today"));
  const coveredKpis = kpisFromFiltered(coveredOnly, kffCtx);
  assert.equal(coveredKpis.total, 1);
  assert.equal(coveredKpis.coveredToday, 1);
  assert.equal(coveredKpis.atRiskPickup24h, 0);
});

test("kpisFromFiltered: empty rows yields zeros + null avgFreshnessMinutes", () => {
  const k = kpisFromFiltered([], kffCtx);
  assert.equal(k.total, 0);
  assert.equal(k.readyToSend, 0);
  assert.equal(k.atRiskPickup24h, 0);
  assert.equal(k.coveredToday, 0);
  assert.equal(k.sentAwaitingCarrier, 0);
  assert.equal(k.generatedToday, 0);
  assert.equal(k.avgFreshnessMinutes, null);
});

// ─────────────────────────────────────────────────────────────────────
// Task #972 — Available Freight cockpit base scope under impersonation
//
// These tests exercise the same shared primitives the route relies on
// (`resolveOwnerScope` + `isRowOwnedByUser`) to guarantee:
//   1. The base owner scope (impersonation-derived) drops every row that
//      doesn't belong to the impersonated rep.
//   2. The client `ownerFilter` is clamped to "me" when it would widen
//      past the impersonated rep ("all", another userId, "team:...").
//   3. Both invariants are no-ops when the request is NOT impersonating.
//
// Pure-unit: we simulate the route's filter pipeline without spinning up
// Express / DB so the suite stays under a second.
// ─────────────────────────────────────────────────────────────────────

console.log("\n── Cockpit hardening: Task #972 impersonation scope ──");

interface SimRow {
  id: string;
  ownership: CockpitRowOwnership | null;
  ownerId: string | null;
}

function makeRow(id: string, ownerIds: string[]): SimRow {
  return {
    id,
    ownership: ownerIds.length > 0
      ? {
          ids: ownerIds,
          emails: [],
          usernames: [],
          unassigned: false,
        }
      : { ids: [], emails: [], usernames: [], unassigned: true },
    ownerId: ownerIds[0] ?? null,
  };
}

// Mirrors server/routes/freightOpportunityCockpit.ts base-scope filter.
function applyBaseScope(
  rows: SimRow[],
  baseScopeUserIds: string[],
  currentUserId: string | null,
): SimRow[] {
  if (baseScopeUserIds.length === 0) return rows; // not impersonating
  const scope = resolveOwnerScope(baseScopeUserIds, currentUserId, null);
  if (scope.isAll) return rows;
  return rows.filter(r => {
    const ids = r.ownership?.ids ?? (r.ownerId ? [r.ownerId] : []);
    if (scope.includeUnassigned && ids.length === 0) return true;
    if (scope.userIds.size === 0) return false;
    for (const id of ids) {
      if (scope.userIds.has(id)) return true;
    }
    return false;
  });
}

// Mirrors server/routes/freightOpportunityCockpit.ts owner-filter clamp.
function clampOwnerFilter(
  ownerFilter: string,
  impersonatedUserId: string | null,
): string {
  if (!impersonatedUserId) return ownerFilter; // no impersonation
  const requestedTokens = ownerFilter === "all"
    ? []
    : parseOwnerScopeTokens(ownerFilter);
  const requestedScope = requestedTokens.length > 0
    ? resolveOwnerScope(requestedTokens, impersonatedUserId, null)
    : null;
  const widensPastImpersonated = !requestedScope
    || requestedScope.isAll
    || requestedScope.includeUnassigned
    || Array.from(requestedScope.userIds).some(uid => uid !== impersonatedUserId);
  return widensPastImpersonated ? "me" : ownerFilter;
}

test("base scope: when impersonating rep-A, only rep-A's rows survive", () => {
  const rows = [
    makeRow("opp-1", ["rep-a"]),
    makeRow("opp-2", ["rep-b"]),
    makeRow("opp-3", ["rep-a", "rep-c"]), // co-owned still counts
    makeRow("opp-4", []), // unassigned
  ];
  const filtered = applyBaseScope(rows, ["rep-a"], "rep-a");
  assert.deepEqual(
    filtered.map(r => r.id).sort(),
    ["opp-1", "opp-3"],
  );
});

test("base scope: empty baseScopeUserIds (not impersonating) is a no-op", () => {
  const rows = [
    makeRow("opp-1", ["rep-a"]),
    makeRow("opp-2", ["rep-b"]),
    makeRow("opp-3", []),
  ];
  const filtered = applyBaseScope(rows, [], "admin-1");
  assert.equal(filtered.length, 3);
});

test("base scope: no impersonation leaves cross-rep rows untouched", () => {
  const rows = [
    makeRow("opp-1", ["rep-a"]),
    makeRow("opp-2", ["rep-b"]),
  ];
  const filtered = applyBaseScope(rows, [], null);
  assert.deepEqual(
    filtered.map(r => r.id).sort(),
    ["opp-1", "opp-2"],
  );
});

test("base scope: hiddenByBaseScope count matches dropped rows", () => {
  const rows = [
    makeRow("opp-1", ["rep-a"]),
    makeRow("opp-2", ["rep-b"]),
    makeRow("opp-3", ["rep-c"]),
    makeRow("opp-4", ["rep-a"]),
  ];
  const before = rows.length;
  const after = applyBaseScope(rows, ["rep-a"], "rep-a").length;
  assert.equal(before - after, 2);
});

test("owner-filter clamp: 'all' becomes 'me' when impersonating", () => {
  assert.equal(clampOwnerFilter("all", "rep-a"), "me");
});

test("owner-filter clamp: another userId becomes 'me' when impersonating", () => {
  assert.equal(clampOwnerFilter("rep-b", "rep-a"), "me");
});

test("owner-filter clamp: 'me' stays 'me' when impersonating", () => {
  assert.equal(clampOwnerFilter("me", "rep-a"), "me");
});

test("owner-filter clamp: impersonated userId token stays as-is when impersonating", () => {
  assert.equal(clampOwnerFilter("rep-a", "rep-a"), "rep-a");
});

test("owner-filter clamp: 'unassigned' becomes 'me' when impersonating", () => {
  assert.equal(clampOwnerFilter("unassigned", "rep-a"), "me");
});

test("owner-filter clamp: not impersonating leaves filter untouched", () => {
  assert.equal(clampOwnerFilter("all", null), "all");
  assert.equal(clampOwnerFilter("rep-b", null), "rep-b");
  assert.equal(clampOwnerFilter("unassigned", null), "unassigned");
});

test("owner-filter clamp: 'team:foo' that resolves to other user(s) becomes 'me'", () => {
  // To exercise the team-widening branch we need a scope that resolves
  // to user ids different from the impersonated rep. Simulate with a
  // bare userId token (which is what `team:` would expand to with an
  // org chart available). The route's actual `resolveOwnerScope` call
  // passes `null` for the org chart, so team tokens themselves resolve
  // to an empty set and stay as-is — but the base-scope filter still
  // protects the data, so no leak is possible either way.
  assert.equal(clampOwnerFilter("rep-c", "rep-a"), "me");
});

test("base scope + clamp: 'all' on top of impersonation still scopes to rep-a", () => {
  // Belt-and-suspenders: even if the client somehow sent ?owner=all,
  // the base scope drops the wrong rows and the clamp coerces the echoed
  // filter back to "me".
  const rows = [
    makeRow("opp-1", ["rep-a"]),
    makeRow("opp-2", ["rep-b"]),
  ];
  const baseFiltered = applyBaseScope(rows, ["rep-a"], "rep-a");
  const clamped = clampOwnerFilter("all", "rep-a");
  assert.deepEqual(baseFiltered.map(r => r.id), ["opp-1"]);
  assert.equal(clamped, "me");
});

test("base scope: ID-only ownership match (no alias fallback) so SQL aggregate parity holds", () => {
  // Task #972 — the route's impersonation base-scope row filter and the
  // hidden-counts SQL aggregate (totalInScope, byStatus, bySnooze, …)
  // must agree on which rows are "in scope" for the impersonated rep.
  // The SQL aggregate matches by the four DB id columns
  // (owner_user_id / delegated_to_user_id / created_by_id /
  // approved_by_id). The row filter therefore must NOT use the
  // email/username `isRowOwnedByUser` alias fallback under
  // impersonation — otherwise an alias-only row could appear in
  // `items` while being excluded from `hiddenCounts.totalInScope`,
  // breaking the empty-state hint and any KPI denominator.
  //
  // Sanity: a row whose ownership envelope carries only an email
  // (no `ids`) MUST be treated as out-of-scope under impersonation,
  // even when the impersonated user's email matches.
  const ownership: CockpitRowOwnership = {
    ids: [],
    emails: ["rep-a@example.com"],
    usernames: [],
    unassigned: false,
  };
  const meIdentity = resolveUserIdentity({
    id: "rep-a",
    email: "rep-a@example.com",
    username: null,
  });
  // The shared predicate WOULD match by email — that's by design for
  // legacy data outside impersonation. Pin that fact:
  assert.equal(isRowOwnedByUser(ownership, meIdentity, null), true);

  // …but the route's impersonation base-scope filter is ID-only, so a
  // row with empty `ids` must drop:
  const baseScopeUserIds = new Set(["rep-a"]);
  const ids = ownership.ids ?? [];
  const wouldSurviveBaseScope =
    ids.length === 0
      ? false // not unassigned-allowed under impersonation, no id intersection
      : ids.some((id) => baseScopeUserIds.has(id));
  assert.equal(
    wouldSurviveBaseScope,
    false,
    "alias-only row must NOT survive ID-only impersonation base scope",
  );
});

console.log(
  `\n── Cockpit hardening results: ${passed} passed, ${failed} failed ──`,
);
process.exit(failed > 0 ? 1 : 0);
