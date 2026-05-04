/**
 * Task #972 — runtime behavior of the Available Freight cockpit route
 * under impersonation.
 *
 * Boots the real `registerFreightCockpitRoutes` against a mocked
 * `storage.listFreightOpportunities` that returns rows owned by THREE
 * different reps (the impersonated rep + two others), and a mocked
 * `db.execute` that returns canned hidden-count rows. Then drives the
 * registered handler directly (no HTTP) and asserts that:
 *
 *   1. Without impersonation, all three reps' rows come back in the
 *      feed and the response has `impersonation.isImpersonating === false`.
 *   2. With impersonation active, only the impersonated rep's rows
 *      come back, regardless of the requested `?owner=…` value
 *      (`all`, another userId, `unassigned`, `team:<id>`) — every
 *      branch must clamp to "me".
 *   3. The response envelope reports `impersonation.isImpersonating`
 *      true with the correct `impersonatedUserId`.
 *   4. `effectiveOwnerFilter` is "me" whenever the request widened past
 *      the impersonated rep's scope.
 *   5. `hiddenCounts.byBaseScope` reports the number of rows the base
 *      scope dropped (the two non-impersonated reps' rows in this
 *      fixture).
 *
 * Exercises the real route module's filtering pipeline end-to-end —
 * NOT a source-grep, NOT a synthetic re-implementation. Heavy outside
 * dependencies (pricing service, lwq cross-link, carrier coverable
 * lookup, autopilot, liveSync, raw `db.execute`) are stubbed but the
 * route's own scope logic runs as written.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const ORG_ID = "org_test_972";
const REP_IMPERSONATED = "user_rep_alice";
const REP_OTHER_A = "user_rep_bob";
const REP_OTHER_B = "user_rep_carol";

// Each opp: minimum columns the route reads. `pickupWindowStart` set to
// today (in any local tz) so the default 'actionable' pickup scope keeps
// every row visible (no row dropped by stale-pickup filter).
function makeOpp(id: string, ownerUserId: string | null) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(today.getUTCDate()).padStart(2, "0");
  return {
    id,
    orgId: ORG_ID,
    ownerUserId,
    delegatedToUserId: null,
    createdById: null,
    approvedById: null,
    companyId: null,
    carrierId: null,
    recurringLaneId: null,
    origin: "ATL",
    originState: "GA",
    destination: "MIA",
    destinationState: "FL",
    equipmentType: "VAN",
    pickupWindowStart: `${yyyy}-${mm}-${dd}`,
    pickupWindowEnd: null,
    sourceQuoteId: null,
    sourceFileName: null,
    snoozedUntil: null,
    status: "ready_to_send" as const,
    generatedAt: today,
    targetBuyRpm: null,
    laneScore: null,
    targetTier: null,
    cancelReason: null,
    coverageState: null,
  };
}

const FIXTURE_OPPS = [
  makeOpp("opp_alice_1", REP_IMPERSONATED),
  makeOpp("opp_alice_2", REP_IMPERSONATED),
  makeOpp("opp_bob_1", REP_OTHER_A),
  makeOpp("opp_carol_1", REP_OTHER_B),
];

// ─── Mock harness ─────────────────────────────────────────────────────────────

// Mutable per-test impersonation context returned by the auth helper.
let mockImpersonation: {
  isImpersonating: boolean;
  impersonatedUserId: string | null;
  adminId: string | null;
} = { isImpersonating: false, impersonatedUserId: null, adminId: null };

// The "current user" the route resolves via getCurrentUser(req). When
// impersonating, the real auth layer swaps this to the impersonated
// rep — we mirror that here.
let mockCurrentUser: { id: string; email: string | null; username: string | null; role: string; organizationId: string } | null =
  { id: REP_IMPERSONATED, email: "alice@example.com", username: "alice", role: "rep", organizationId: ORG_ID };

vi.mock("../auth", async () => {
  const actual: any = await vi.importActual("../auth");
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    getCurrentUser: async () => mockCurrentUser,
    getImpersonationContext: (_req: any) => mockImpersonation,
  };
});

vi.mock("../storage", () => {
  const fakeDb = {
    execute: async (_query: any) => ({
      rows: [{
        // Canned hidden-count aggregate. Values don't matter for the
        // base-scope assertions; we only assert `byBaseScope` here,
        // which is computed in JS, not by this SQL.
        total_in_scope: 0,
        hidden_by_status: 0,
        hidden_by_snooze: 0,
        hidden_by_past_pickup: 0,
        hidden_by_past_stale: 0,
        hidden_by_actionable: 0,
        visible_past_pickup_recent: 0,
      }],
    }),
  };
  return {
    db: fakeDb,
    storage: {
      listFreightOpportunities: async (_org: string, _opts: any) => FIXTURE_OPPS,
      listFreightOpportunityCarriers: async () => [],
      countFreightOpportunitiesCoveredSince: async () => 0,
      getCarrierInOrg: async () => null,
      getCompany: async () => null,
      getCompanyOutreachPolicy: async () => null,
      getRecurringLane: async () => null,
      getUser: async (id: string) => {
        if (id === REP_IMPERSONATED) return { id, email: "alice@example.com", username: "alice", role: "rep", organizationId: ORG_ID };
        if (id === REP_OTHER_A) return { id, email: "bob@example.com", username: "bob", role: "rep", organizationId: ORG_ID };
        if (id === REP_OTHER_B) return { id, email: "carol@example.com", username: "carol", role: "rep", organizationId: ORG_ID };
        return null;
      },
      resolveVisibleUserIds: async () => ({ visibleUserIds: [REP_IMPERSONATED, REP_OTHER_A, REP_OTHER_B], canSeeUnassigned: true }),
    },
  };
});

// Heavy side-effect services — we don't care about their behavior here.
vi.mock("../pricingBlendService", () => ({
  getBlendedRateCached: async () => ({
    targetBuyRpm: null, confidence: "low", reason: "test", legs: { history: null },
  }),
}));
vi.mock("../proactiveOpportunityService", () => ({
  ensureShortlistRanked: async () => {},
}));
vi.mock("../freightOpportunityOutreachService", () => ({
  sendOpportunityWave: async () => {},
}));
vi.mock("../freightOpportunityAutoPilot", () => ({
  buildAutoPilotPreview: async () => null,
  scheduleAutoPilotRun: async () => {},
  cancelAutoPilotRun: async () => {},
}));
vi.mock("../laneCrossLinkService", () => ({
  buildLwqContextByLaneSig: async () => new Map(),
  laneSig: (o: string, oS: string, d: string, dS: string, eq: string) => `${o}-${oS}/${d}-${dS}/${eq}`,
}));
vi.mock("../services/carrierCoverableLanes", () => ({
  getCarrierCoverableLanes: async () => null,
}));
vi.mock("../services/liveSync", () => ({
  publish: () => {},
}));

// Imported AFTER mocks so the route module sees the stubs.
import { registerFreightCockpitRoutes } from "../routes/freightOpportunityCockpit";

// ─── Boot the real route + drive the handler directly ────────────────────────

function bootApp() {
  const app = express();
  app.use(express.json());
  // Inject session.organizationId on every request (the route reads it
  // via the module-private `orgId(req)` helper, which is just
  // `req.session?.organizationId`).
  app.use((req: any, _res, next) => {
    req.session = req.session ?? {};
    req.session.organizationId = ORG_ID;
    req.session.userId = mockCurrentUser?.id ?? REP_IMPERSONATED;
    next();
  });
  registerFreightCockpitRoutes(app);
  return app;
}

function findCockpitHandler(app: any) {
  const router = app._router ?? app.router;
  if (!router?.stack) throw new Error("router stack not exposed");
  const layer = router.stack.find((l: any) => l.route?.path === "/api/freight-opportunities/cockpit");
  if (!layer?.route) throw new Error("cockpit route not registered");
  // The handler is the last middleware in the route stack (after requireAuth).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function callCockpit(query: Record<string, string> = {}) {
  const app = bootApp();
  const handler = findCockpitHandler(app);
  const res = {
    _status: 200,
    _body: null as any,
    status(code: number) { this._status = code; return this; },
    json(payload: any) { this._body = payload; return this; },
  };
  await handler(
    {
      query,
      session: { organizationId: ORG_ID, userId: mockCurrentUser?.id ?? REP_IMPERSONATED },
    },
    res,
    () => {},
  );
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task #972 — Available Freight cockpit runtime under impersonation", () => {
  beforeEach(() => {
    mockImpersonation = { isImpersonating: false, impersonatedUserId: null, adminId: null };
    mockCurrentUser = { id: REP_IMPERSONATED, email: "alice@example.com", username: "alice", role: "rep", organizationId: ORG_ID };
  });

  it("returns ALL reps' rows (no base-scope filter) when not impersonating", async () => {
    // Outside viewing-as the impersonation envelope reports false and
    // every row from the fixture flows through to the feed.
    mockImpersonation = { isImpersonating: false, impersonatedUserId: null, adminId: null };
    // Admin user identity for the no-impersonation case so an explicit
    // `?owner=all` request actually returns all rows (no client filter).
    mockCurrentUser = { id: "user_admin", email: "admin@example.com", username: "admin", role: "admin", organizationId: ORG_ID };
    const res = await callCockpit({ ownerFilter: "all" });
    expect(res._status, JSON.stringify(res._body)).toBe(200);
    const body = res._body;
    expect(body.impersonation).toEqual({
      isImpersonating: false,
      impersonatedUserId: null,
    });
    const ownerIds = body.items.map((i: any) => i.opportunity.ownerUserId).sort();
    expect(ownerIds).toEqual([REP_IMPERSONATED, REP_IMPERSONATED, REP_OTHER_A, REP_OTHER_B].sort());
    expect(body.hiddenCounts.byBaseScope).toBe(0);
  });

  it("base scope drops other reps' rows when impersonating, regardless of ?owner=all", async () => {
    mockImpersonation = {
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
      adminId: "user_admin",
    };
    const res = await callCockpit({ ownerFilter: "all" });
    expect(res._status, JSON.stringify(res._body)).toBe(200);
    const body = res._body;
    // Only the impersonated rep's two opps survive.
    const ownerIds = body.items.map((i: any) => i.opportunity.ownerUserId).sort();
    expect(ownerIds).toEqual([REP_IMPERSONATED, REP_IMPERSONATED]);
    // Two rows dropped by base scope (Bob + Carol).
    expect(body.hiddenCounts.byBaseScope).toBe(2);
    // Echoed envelope is correct (adminId stays in the debug payload only —
    // the public envelope deliberately omits it).
    expect(body.impersonation).toEqual({
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
    });
    // Owner filter clamped to "me" because "all" widens past the
    // impersonated rep.
    expect(body.ownerFilter).toBe("me");
  });

  it("clamps owner=<otherUserId> to me when impersonating (cannot pivot to other reps' books)", async () => {
    mockImpersonation = {
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
      adminId: "user_admin",
    };
    const res = await callCockpit({ ownerFilter: REP_OTHER_A });
    expect(res._status, JSON.stringify(res._body)).toBe(200);
    const body = res._body;
    const ownerIds = body.items.map((i: any) => i.opportunity.ownerUserId);
    // No Bob / Carol rows — base scope and owner clamp both protect.
    expect(ownerIds.every((id: string) => id === REP_IMPERSONATED)).toBe(true);
    expect(body.ownerFilter).toBe("me");
  });

  it("clamps owner=unassigned to me when impersonating (cannot reintroduce unassigned)", async () => {
    mockImpersonation = {
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
      adminId: "user_admin",
    };
    const res = await callCockpit({ ownerFilter: "unassigned" });
    expect(res._status, JSON.stringify(res._body)).toBe(200);
    const body = res._body;
    const ownerIds = body.items.map((i: any) => i.opportunity.ownerUserId);
    expect(ownerIds.every((id: string) => id === REP_IMPERSONATED)).toBe(true);
    expect(body.ownerFilter).toBe("me");
  });

  it("alias-only ownership rows DROP under impersonation (parity with SQL aggregate)", async () => {
    // Task #972 — code-review parity fix. The hidden-counts SQL aggregate
    // matches by the four DB id columns; the row-level base-scope filter
    // must agree. A row whose ownership envelope carries only an email
    // (no `ownerUserId` / `delegated_to_user_id` / etc.) must NOT
    // survive the impersonation base scope, even when the impersonated
    // user's email matches — otherwise the row would appear in the
    // feed but be excluded from `hiddenCounts.totalInScope`, breaking
    // empty-state and KPI denominator parity.
    //
    // Inject a fixture with one alias-only row owned by "alice@example.com"
    // (matching the impersonated rep's email) but with NO id columns set.
    const aliasOnlyOpp = {
      ...makeOpp("opp_alias_only", null),
      ownerUserId: null,
      delegatedToUserId: null,
      createdById: null,
      approvedById: null,
    };
    const storageMod = await import("../storage");
    const prevList = (storageMod.storage as any).listFreightOpportunities;
    (storageMod.storage as any).listFreightOpportunities = async () => [
      ...FIXTURE_OPPS,
      aliasOnlyOpp,
    ];
    try {
      mockImpersonation = {
        isImpersonating: true,
        impersonatedUserId: REP_IMPERSONATED,
        adminId: "user_admin",
      };
      const res = await callCockpit({ ownerFilter: "all" });
      expect(res._status, JSON.stringify(res._body)).toBe(200);
      const body = res._body;
      const ids = body.items.map((i: any) => i.opportunity.id).sort();
      // Only Alice's two real-id opps survive — the alias-only row
      // drops because the route now uses ID-only ownership matching
      // for the impersonation base scope.
      expect(ids).toEqual(["opp_alice_1", "opp_alice_2"]);
      expect(ids).not.toContain("opp_alias_only");
    } finally {
      (storageMod.storage as any).listFreightOpportunities = prevList;
    }
  });

  it("preserves owner=me when impersonating (no clamp needed)", async () => {
    mockImpersonation = {
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
      adminId: "user_admin",
    };
    const res = await callCockpit({ ownerFilter: "me" });
    expect(res._status, JSON.stringify(res._body)).toBe(200);
    const body = res._body;
    const ownerIds = body.items.map((i: any) => i.opportunity.ownerUserId);
    expect(ownerIds.every((id: string) => id === REP_IMPERSONATED)).toBe(true);
    // "me" already aligns with the impersonated identity, so the
    // echoed filter stays "me" (no widening to clamp).
    expect(body.ownerFilter).toBe("me");
  });

  it("emits the ?debug=cockpit diagnostics payload only when requested in non-prod", async () => {
    mockImpersonation = {
      isImpersonating: true,
      impersonatedUserId: REP_IMPERSONATED,
      adminId: "user_admin",
    };
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const withDebug = await callCockpit({ ownerFilter: "all", debug: "cockpit" });
      expect(withDebug._body.debug).toBeDefined();
      // The debug payload is FLAT — `isImpersonating` / `impersonatedUserId`
      // / `adminId` are top-level keys (not nested under `impersonation`).
      expect(withDebug._body.debug.isImpersonating).toBe(true);
      expect(withDebug._body.debug.impersonatedUserId).toBe(REP_IMPERSONATED);
      expect(withDebug._body.debug.adminId).toBe("user_admin");
      expect(withDebug._body.debug.hiddenByBaseScope).toBe(2);
      expect(withDebug._body.debug.requestedOwnerFilter).toBe("all");
      expect(withDebug._body.debug.effectiveOwnerFilter).toBe("me");

      const withoutDebug = await callCockpit({ ownerFilter: "all" });
      expect(withoutDebug._body.debug).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
