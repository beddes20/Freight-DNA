/**
 * Auto-pilot transparency drawer (Task #634) — unit tests.
 *
 * Covers:
 *   - listAutoPilotPendingForOrg: mirrors runAutoPilotTick selection logic
 *     (enabled gate, sameCentralDay skip, snooze, approval gate, top-N + cap).
 *   - nextRunAtForPolicy: today vs tomorrow CT semantics + DST.
 *   - buildSkipNextRunPolicyUpsert: sets autoSendLastRunAt, preserves the rest.
 *   - buildDisableAutoSendPolicyUpsert: flips autoSendEnabled, preserves rest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAutoPilotPendingForOrg,
  nextRunAtForPolicy,
  buildSkipNextRunPolicyUpsert,
  buildDisableAutoSendPolicyUpsert,
} from "../freightOpportunityAutoPilot";
import type { CompanyOutreachPolicy, FreightOpportunity } from "@shared/schema";

vi.mock("../proactiveOpportunityService", () => ({
  ensureShortlistRanked: vi.fn(async () => ({ ranked: false, carriers: [] })),
}));

interface MockState {
  policies: CompanyOutreachPolicy[];
  opps: FreightOpportunity[];
  carriers: Map<string, Array<{ id: string; carrierId: string; rank: number; fitScore: number; bucket: string | null; explanation: string | null; sentAt: Date | null; excludedReason: string | null }>>;
}

function makePolicy(overrides: Partial<CompanyOutreachPolicy> = {}): CompanyOutreachPolicy {
  return {
    id: "pol-1",
    orgId: "org-1",
    companyId: "co-1",
    enabled: true,
    mode: "exact_load",
    approvalRequired: false,
    maxCarriersPerOpportunity: 5,
    leadTimeMinDays: 2,
    leadTimeMaxDays: 7,
    approvedCarrierOnly: false,
    approvedCarrierIds: [],
    doNotAutomate: false,
    specialNotes: null,
    autoSendEnabled: true,
    autoSendHourCt: 7,
    autoSendTopN: 3,
    autoSendMaxPerDay: 6,
    autoSendLastRunAt: null,
    updatedAt: new Date(),
    updatedById: "user-1",
    ...overrides,
  } as CompanyOutreachPolicy;
}

function makeOpp(overrides: Partial<FreightOpportunity> = {}): FreightOpportunity {
  return {
    id: "opp-1",
    orgId: "org-1",
    companyId: "co-1",
    status: "ready_to_send",
    mode: "exact_load",
    origin: "Dallas",
    originState: "TX",
    destination: "Atlanta",
    destinationState: "GA",
    equipmentType: "Dry Van",
    pickupAt: new Date("2026-04-26T12:00:00.000Z"),
    pickupWindowStart: new Date("2026-04-26T12:00:00.000Z").toISOString(),
    pickupWindowEnd: null,
    loadCount: 1,
    targetBuyRpm: null,
    confidenceFlag: "normal",
    sourceRef: { kind: "manual" },
    snoozedUntil: null,
    approvedAt: new Date(),
    approvedById: "user-1",
    ownerUserId: "user-1",
    delegatedToUserId: null,
    generatedAt: new Date("2026-04-24T08:00:00.000Z"),
    urgencyScore: 60,
    ...overrides,
  } as unknown as FreightOpportunity;
}

function buildStorage(state: MockState) {
  return {
    listCompanyOutreachPolicies: async (_org: string, _opts?: any) => state.policies,
    listFreightOpportunities: async (_org: string, _opts: any) => state.opps,
    listFreightOpportunityCarriers: async (oppId: string) => state.carriers.get(oppId) ?? [],
  } as any;
}

const now = new Date("2026-04-24T15:00:00.000Z"); // 10:00 CDT, after the 07:00 CT fire window

beforeEach(() => vi.clearAllMocks());

// ── listAutoPilotPendingForOrg ───────────────────────────────────────────

describe("listAutoPilotPendingForOrg", () => {
  it("returns the top-N candidate carriers per opportunity, capped by maxPerDay", async () => {
    const state: MockState = {
      policies: [makePolicy({ autoSendTopN: 2, autoSendMaxPerDay: 3 })],
      opps: [makeOpp({ id: "opp-A" }), makeOpp({ id: "opp-B" })],
      carriers: new Map([
        ["opp-A", [
          { id: "rA-1", carrierId: "c1", rank: 1, fitScore: 90, bucket: "proven", explanation: "strong", sentAt: null, excludedReason: null },
          { id: "rA-2", carrierId: "c2", rank: 2, fitScore: 80, bucket: "proven", explanation: "strong", sentAt: null, excludedReason: null },
          { id: "rA-3", carrierId: "c3", rank: 3, fitScore: 70, bucket: "exploratory", explanation: null, sentAt: null, excludedReason: null },
        ]],
        ["opp-B", [
          { id: "rB-1", carrierId: "c4", rank: 1, fitScore: 85, bucket: "proven", explanation: "ok", sentAt: null, excludedReason: null },
          { id: "rB-2", carrierId: "c5", rank: 2, fitScore: 75, bucket: "proven", explanation: "ok", sentAt: null, excludedReason: null },
        ]],
      ]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(1);
    const entry = out[0];
    expect(entry.opportunities).toHaveLength(2);
    // Opp A consumes 2 of the 3-cap; opp B can only take 1 (the remaining slot).
    expect(entry.opportunities[0].candidates.map(c => c.rowId)).toEqual(["rA-1", "rA-2"]);
    expect(entry.opportunities[1].candidates.map(c => c.rowId)).toEqual(["rB-1"]);
    expect(entry.opportunities[1].remaining.map(c => c.rowId)).toEqual(["rB-2"]);
    expect(entry.totalCarriers).toBe(3);
  });

  it("skips a policy that already ran today in CT (sameCentralDay)", async () => {
    const state: MockState = {
      policies: [makePolicy({ autoSendLastRunAt: new Date("2026-04-24T13:00:00.000Z") /* 08:00 CDT */ })],
      opps: [makeOpp()],
      carriers: new Map([["opp-1", [
        { id: "r1", carrierId: "c1", rank: 1, fitScore: 90, bucket: null, explanation: null, sentAt: null, excludedReason: null },
      ]]]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(0);
  });

  it("skips snoozed opportunities", async () => {
    const state: MockState = {
      policies: [makePolicy()],
      opps: [makeOpp({ snoozedUntil: new Date(now.getTime() + 60 * 60_000).toISOString() as any })],
      carriers: new Map([["opp-1", [
        { id: "r1", carrierId: "c1", rank: 1, fitScore: 90, bucket: null, explanation: null, sentAt: null, excludedReason: null },
      ]]]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(0);
  });

  it("skips opps that need approval when not yet approved", async () => {
    const state: MockState = {
      policies: [makePolicy({ approvalRequired: true })],
      opps: [makeOpp({ approvedAt: null })],
      carriers: new Map([["opp-1", [
        { id: "r1", carrierId: "c1", rank: 1, fitScore: 90, bucket: null, explanation: null, sentAt: null, excludedReason: null },
      ]]]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(0);
  });

  it("flags missing actor (policy without updatedById) so the UI can warn", async () => {
    const state: MockState = {
      policies: [makePolicy({ updatedById: null as any })],
      opps: [makeOpp()],
      carriers: new Map([["opp-1", [
        { id: "r1", carrierId: "c1", rank: 1, fitScore: 90, bucket: null, explanation: null, sentAt: null, excludedReason: null },
      ]]]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(1);
    expect(out[0].blockedReason).toBe("missing_actor");
  });

  it("surfaces excluded carriers as suppressed for transparency", async () => {
    const state: MockState = {
      policies: [makePolicy()],
      opps: [makeOpp()],
      carriers: new Map([["opp-1", [
        { id: "r1", carrierId: "c1", rank: 1, fitScore: 90, bucket: null, explanation: null, sentAt: null, excludedReason: null },
        { id: "r2", carrierId: "c2", rank: 2, fitScore: 80, bucket: null, explanation: null, sentAt: null, excludedReason: "do_not_use" },
      ]]]),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out[0].opportunities[0].candidates.map(c => c.rowId)).toEqual(["r1"]);
    expect(out[0].opportunities[0].suppressed.map(c => c.carrierId)).toEqual(["c2"]);
    expect(out[0].opportunities[0].suppressed[0].reason).toBe("do_not_use");
  });

  it("returns an empty list when no policies have autoSendEnabled", async () => {
    const state: MockState = {
      policies: [makePolicy({ autoSendEnabled: false })],
      opps: [makeOpp()],
      carriers: new Map(),
    };
    const out = await listAutoPilotPendingForOrg(buildStorage(state), "org-1", now);
    expect(out).toHaveLength(0);
  });
});

// ── nextRunAtForPolicy ───────────────────────────────────────────────────

describe("nextRunAtForPolicy", () => {
  it("returns today's HH:00 CT when not yet ran and the hour is still ahead", async () => {
    // 2026-04-24 08:00 UTC is 03:00 CDT; 07:00 CDT is later today (12:00 UTC).
    const fixed = new Date("2026-04-24T08:00:00.000Z");
    const next = nextRunAtForPolicy(makePolicy({ autoSendHourCt: 7 }), fixed);
    expect(next.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });

  it("rolls to the next CT day when today's window already passed", async () => {
    const fixed = new Date("2026-04-24T15:00:00.000Z"); // 10:00 CDT
    const next = nextRunAtForPolicy(makePolicy({ autoSendHourCt: 7 }), fixed);
    expect(next.toISOString()).toBe("2026-04-25T12:00:00.000Z");
  });

  it("rolls to tomorrow when the policy already ran today (CT)", async () => {
    const fixed = new Date("2026-04-24T04:00:00.000Z"); // 23:00 CDT prev day
    const next = nextRunAtForPolicy(
      makePolicy({ autoSendHourCt: 7, autoSendLastRunAt: new Date("2026-04-23T13:00:00.000Z") /* 08:00 CDT same CT day */ }),
      fixed,
    );
    // sameCentralDay treats both as 2026-04-23 in CT, so we roll to 2026-04-24
    // at 07:00 CDT = 12:00 UTC.
    expect(next.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });
});

// ── buildSkipNextRunPolicyUpsert / buildDisableAutoSendPolicyUpsert ──────

describe("policy upsert builders", () => {
  it("buildSkipNextRunPolicyUpsert stamps the next-fire CT day so the upcoming tick is skipped", () => {
    const policy = makePolicy({ autoSendTopN: 4, autoSendMaxPerDay: 9, autoSendHourCt: 7 });
    // Today's 07:00 CT already passed; next fire is tomorrow at 07:00 CT.
    const fixed = new Date("2026-04-24T15:00:00.000Z"); // 10:00 CDT
    const u = buildSkipNextRunPolicyUpsert(policy, fixed);
    // Stamp must land in the next-fire CT day, NOT `now`. Otherwise the next
    // fire tomorrow would still happen.
    expect(u.autoSendLastRunAt?.toISOString()).toBe("2026-04-25T12:00:00.000Z");
    expect(u.autoSendEnabled).toBe(true);
    expect(u.autoSendTopN).toBe(4);
    expect(u.autoSendMaxPerDay).toBe(9);
    expect(u.autoSendHourCt).toBe(7);
    expect(u.companyId).toBe(policy.companyId);
    expect(u.orgId).toBe(policy.orgId);
  });

  it("buildSkipNextRunPolicyUpsert before today's window stamps today's CT day", () => {
    const policy = makePolicy({ autoSendHourCt: 7 });
    const fixed = new Date("2026-04-24T08:00:00.000Z"); // 03:00 CDT, before 07:00
    const u = buildSkipNextRunPolicyUpsert(policy, fixed);
    expect(u.autoSendLastRunAt?.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });

  it("buildDisableAutoSendPolicyUpsert flips autoSendEnabled to false", () => {
    const policy = makePolicy();
    const u = buildDisableAutoSendPolicyUpsert(policy);
    expect(u.autoSendEnabled).toBe(false);
    expect(u.autoSendHourCt).toBe(7);
    expect(u.companyId).toBe(policy.companyId);
  });
});
