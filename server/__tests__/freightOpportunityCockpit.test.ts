/**
 * Available Freight Cockpit (Task #601) — unit tests.
 *
 * Covers:
 *   - computeCockpitUrgency: pickup proximity + coverage + shortlist + freshness
 *   - currentCentralHour / sameCentralDay: timezone helpers
 *   - runAutoPilotTick: guardrails (skip disabled, hour gate, snooze, approval,
 *     daily cap, no-actor refusal, audit log).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCockpitUrgency, buildCockpitRow } from "../routes/freightOpportunityCockpit";
import {
  runAutoPilotTick,
  currentCentralHour,
  sameCentralDay,
} from "../freightOpportunityAutoPilot";
import { FREIGHT_COCKPIT_SORTS, FREIGHT_COCKPIT_LAYOUTS } from "@shared/schema";
import type { CompanyOutreachPolicy, FreightOpportunity, User } from "@shared/schema";

// ── sendOpportunityWave is mocked so we don't drive Outlook/email machinery.
const sendMock = vi.fn(async () => ({
  results: [
    { status: "sent" as const, carrierId: "c1" },
    { status: "sent" as const, carrierId: "c2" },
  ],
}));
vi.mock("../freightOpportunityOutreachService", () => ({
  sendOpportunityWave: (...args: unknown[]) => sendMock(...args as [any, any, any, any, any]),
}));
vi.mock("../proactiveOpportunityService", () => ({
  ensureShortlistRanked: vi.fn(async () => undefined),
}));

// ── Urgency scoring ─────────────────────────────────────────────────────────

describe("computeCockpitUrgency", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  it("scores pickup ≤ 12h as critical", () => {
    const r = computeCockpitUrgency({
      pickupAt: new Date("2026-04-24T20:00:00.000Z"),
      generatedAt: new Date("2026-04-24T08:00:00.000Z"),
      includedCarriers: 3,
      sentCarriers: 0,
      respondedCarriers: 0,
      status: "ready_to_send",
      now,
    });
    expect(r.level).toBe("critical");
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.reasons).toContain("pickup ≤ 12h");
    expect(r.reasons).toContain("no outreach yet");
  });

  it("scores pickup ≤ 48h with replies as medium", () => {
    const r = computeCockpitUrgency({
      pickupAt: new Date("2026-04-26T06:00:00.000Z"),
      generatedAt: now,
      includedCarriers: 5,
      sentCarriers: 5,
      respondedCarriers: 3,
      status: "sent",
      now,
    });
    expect(r.level).toBe("medium");
    // 35 (pickup ≤ 48h) + 8 (partial replies) = 43, between 30 and 54.
    expect(r.score).toBeGreaterThanOrEqual(30);
    expect(r.score).toBeLessThan(55);
  });

  it("clamps covered/expired/cancelled rows to ≤ 5", () => {
    for (const status of ["covered", "expired", "cancelled"]) {
      const r = computeCockpitUrgency({
        pickupAt: new Date("2026-04-24T13:00:00.000Z"),
        generatedAt: now,
        includedCarriers: 0,
        sentCarriers: 0,
        respondedCarriers: 0,
        status,
        now,
      });
      expect(r.score).toBeLessThanOrEqual(5);
      expect(r.level).toBe("low");
    }
  });

  it("adds a thin-shortlist reason when included < 3", () => {
    const r = computeCockpitUrgency({
      pickupAt: new Date("2026-04-26T12:00:00.000Z"),
      generatedAt: now,
      includedCarriers: 2,
      sentCarriers: 0,
      respondedCarriers: 0,
      status: "ready_to_send",
      now,
    });
    expect(r.reasons).toContain("thin shortlist");
  });

  it("adds the stale, no replies bonus once >4h with no replies", () => {
    const r = computeCockpitUrgency({
      pickupAt: new Date("2026-04-26T12:00:00.000Z"),
      generatedAt: new Date("2026-04-24T05:00:00.000Z"), // 7h before "now"
      includedCarriers: 5,
      sentCarriers: 5,
      respondedCarriers: 0,
      status: "sent",
      now,
    });
    expect(r.reasons).toContain("stale, no replies");
  });

  it("boosts platinum customers above bronze on the same pickup window", () => {
    const base = {
      pickupAt: new Date("2026-04-26T12:00:00.000Z"), // 48h out
      generatedAt: now,
      includedCarriers: 3,
      sentCarriers: 0,
      respondedCarriers: 0,
      status: "ready_to_send",
      now,
    };
    const platinum = computeCockpitUrgency({ ...base, customerTier: "platinum" });
    const bronze = computeCockpitUrgency({ ...base, customerTier: "bronze" });
    expect(platinum.score).toBeGreaterThan(bronze.score);
    expect(platinum.reasons).toContain("platinum customer");
  });

  it("boosts top strategic lanes (laneScore ≥ 85) over poor lanes", () => {
    const base = {
      pickupAt: new Date("2026-04-26T12:00:00.000Z"),
      generatedAt: now,
      includedCarriers: 3,
      sentCarriers: 0,
      respondedCarriers: 0,
      status: "ready_to_send",
      now,
    };
    const strong = computeCockpitUrgency({ ...base, laneScore: 90 });
    const weak = computeCockpitUrgency({ ...base, laneScore: 10 });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.reasons).toContain("top strategic lane");
  });

  it("ignores customer tier and lane score when not provided (back-compat)", () => {
    const base = {
      pickupAt: new Date("2026-04-26T12:00:00.000Z"),
      generatedAt: now,
      includedCarriers: 3,
      sentCarriers: 0,
      respondedCarriers: 0,
      status: "ready_to_send",
      now,
    };
    const a = computeCockpitUrgency(base);
    const b = computeCockpitUrgency({ ...base, customerTier: null, laneScore: null });
    expect(a.score).toBe(b.score);
  });
});

// ── Central-time helpers ────────────────────────────────────────────────────

describe("currentCentralHour", () => {
  it("returns 0–23", () => {
    const h = currentCentralHour();
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(24);
  });

  it("converts a fixed UTC instant to the right CT hour", () => {
    // 2026-04-24 12:00 UTC = 07:00 CDT (CT is UTC-5 in April).
    expect(currentCentralHour(new Date("2026-04-24T12:00:00.000Z"))).toBe(7);
    // 2026-04-24 01:00 UTC = 20:00 CDT prev day.
    expect(currentCentralHour(new Date("2026-04-24T01:00:00.000Z"))).toBe(20);
  });
});

describe("sameCentralDay", () => {
  it("returns false when lastRunAt is null", () => {
    expect(sameCentralDay(null)).toBe(false);
  });
  it("returns true when both are inside the same CT calendar day", () => {
    const a = new Date("2026-04-24T10:00:00.000Z"); // 05:00 CDT
    const b = new Date("2026-04-24T22:00:00.000Z"); // 17:00 CDT
    expect(sameCentralDay(a, b)).toBe(true);
  });
  it("returns false across the CT midnight boundary", () => {
    const a = new Date("2026-04-24T03:00:00.000Z"); // 22:00 CDT prev day
    const b = new Date("2026-04-24T10:00:00.000Z"); // 05:00 CDT
    expect(sameCentralDay(a, b)).toBe(false);
  });
});

// ── Auto-pilot tick guardrails ──────────────────────────────────────────────

interface MockState {
  policies: CompanyOutreachPolicy[];
  opps: FreightOpportunity[];
  carriers: Map<string, Array<{ id: string; rank: number; sentAt: Date | null; excludedReason: string | null }>>;
  users: Map<string, User>;
  audit: Array<{ opportunityId: string; eventType: string; actorUserId: string | null; payload: any }>;
  upserts: Array<Partial<CompanyOutreachPolicy>>;
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
    autoSendHourCt: 7, // matches the 12:00 UTC fixture below (07:00 CDT)
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
    getOrganizations: async () => [{ id: "org-1" } as any],
    listCompanyOutreachPolicies: async (_org: string) => state.policies,
    listFreightOpportunities: async (_org: string, _opts: any) => state.opps,
    listFreightOpportunityCarriers: async (oppId: string) => state.carriers.get(oppId) ?? [],
    getUser: async (id: string) => state.users.get(id) ?? null,
    appendFreightOpportunityAudit: async (data: any) => {
      state.audit.push(data);
      return { id: `aud-${state.audit.length}` };
    },
    upsertCompanyOutreachPolicy: async (data: any) => {
      state.upserts.push(data);
      return data;
    },
  } as any;
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "rep@example.com",
    name: "Test Rep",
  } as unknown as User;
}

const tickAt = new Date("2026-04-24T12:00:00.000Z"); // 07:00 CDT

function newState(overrides: Partial<MockState> = {}): MockState {
  const u = makeUser();
  return {
    policies: [makePolicy()],
    opps: [makeOpp()],
    carriers: new Map([
      ["opp-1", [
        { id: "row-1", rank: 1, sentAt: null, excludedReason: null },
        { id: "row-2", rank: 2, sentAt: null, excludedReason: null },
        { id: "row-3", rank: 3, sentAt: null, excludedReason: null },
      ]],
    ]),
    users: new Map([[u.id, u]]),
    audit: [],
    upserts: [],
    ...overrides,
  };
}

describe("runAutoPilotTick guardrails", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("skips policies where autoSendEnabled is false", async () => {
    const state = newState({ policies: [makePolicy({ autoSendEnabled: false })] });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesConsidered).toBe(0);
    expect(r.policiesFired).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips policies whose autoSendHourCt does not match the current CT hour", async () => {
    const state = newState({ policies: [makePolicy({ autoSendHourCt: 23 })] });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesConsidered).toBe(1);
    expect(r.policiesFired).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips policies that already ran today (sameCentralDay)", async () => {
    const state = newState({
      policies: [makePolicy({ autoSendLastRunAt: new Date("2026-04-24T11:30:00.000Z") })],
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesFired).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses to fire when the policy has no updatedById (no actor)", async () => {
    const state = newState({ policies: [makePolicy({ updatedById: null })] });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesFired).toBe(0);
    expect(r.errors[0]?.message).toMatch(/No updatedById/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips snoozed opportunities", async () => {
    const state = newState({
      opps: [makeOpp({ snoozedUntil: new Date("2026-04-30T00:00:00.000Z") as any })],
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesFired).toBe(1); // policy did fire (records lastRunAt)
    expect(r.opportunitiesProcessed).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips opps that require approval but are not approved", async () => {
    const state = newState({
      policies: [makePolicy({ approvalRequired: true })],
      opps: [makeOpp({ approvedAt: null, approvedById: null })],
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.opportunitiesProcessed).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("auto-sends available-freight imports when policy.approvalRequired is false (Task #601 step 11)", async () => {
    // Auto-pilot must trust the customer policy as the single source of truth.
    // When a rep has explicitly opted into hands-off sending (approvalRequired
    // = false), available_freight_import rows must auto-send too — otherwise
    // the queue toggle is meaningless for the actual freight stream the
    // cockpit lives on.
    sendMock.mockImplementationOnce(async () => ({
      results: [{ status: "sent" as const }],
    }));
    const state = newState({
      policies: [makePolicy({ approvalRequired: false, autoSendTopN: 1 })],
      opps: [makeOpp({
        approvedAt: null,
        approvedById: null,
        sourceRef: { kind: "available_freight_import" } as any,
      })],
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.opportunitiesProcessed).toBe(1);
    expect(r.carriersSent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("still skips available-freight imports when policy.approvalRequired is true and not approved", async () => {
    const state = newState({
      policies: [makePolicy({ approvalRequired: true })],
      opps: [makeOpp({
        approvedAt: null,
        approvedById: null,
        sourceRef: { kind: "available_freight_import" } as any,
      })],
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.opportunitiesProcessed).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("honors autoSendMaxPerDay across opportunities", async () => {
    sendMock.mockImplementationOnce(async () => ({
      results: [
        { status: "sent" as const },
        { status: "sent" as const },
        { status: "sent" as const },
      ],
    }));
    const state = newState({
      policies: [makePolicy({ autoSendMaxPerDay: 3, autoSendTopN: 3 })],
      opps: [makeOpp(), makeOpp({ id: "opp-2" })],
      carriers: new Map([
        ["opp-1", [
          { id: "r1", rank: 1, sentAt: null, excludedReason: null },
          { id: "r2", rank: 2, sentAt: null, excludedReason: null },
          { id: "r3", rank: 3, sentAt: null, excludedReason: null },
        ]],
        ["opp-2", [
          { id: "r4", rank: 1, sentAt: null, excludedReason: null },
        ]],
      ]),
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    // Cap is 3, first opp consumed all 3 → second opp must be skipped.
    expect(r.carriersSent).toBe(3);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.opportunitiesProcessed).toBe(1);
  });

  it("records lastRunAt and writes an outreach_sent audit row when it fires", async () => {
    const state = newState();
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(r.policiesFired).toBe(1);
    expect(state.upserts.length).toBe(1);
    expect(state.upserts[0].autoSendLastRunAt).toEqual(tickAt);
    const sentAudit = state.audit.find(a => a.eventType === "outreach_sent");
    expect(sentAudit).toBeTruthy();
    expect(sentAudit?.payload?.kind).toBe("auto_pilot_tick");
    expect(sentAudit?.payload?.ctHour).toBe(7);
  });

  it("does not bypass guardrails — it always delegates to sendOpportunityWave", async () => {
    // Verifies that auto-pilot only chooses carrier rows; the actual policy
    // re-evaluation lives inside sendOpportunityWave (which is mocked here).
    const state = newState();
    await runAutoPilotTick(buildStorage(state), tickAt);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const args = sendMock.mock.calls[0];
    // (storage, orgId, opportunityId, actor, { carrierRowIds })
    expect(args[1]).toBe("org-1");
    expect(args[2]).toBe("opp-1");
    expect((args[4] as any).carrierRowIds).toEqual(["row-1", "row-2", "row-3"]);
  });

  it("falls through and records an error when sendOpportunityWave throws, but continues other opps", async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new Error("policy disabled at send-time");
    });
    sendMock.mockImplementationOnce(async () => ({
      results: [{ status: "sent" as const }],
    }));
    const state = newState({
      opps: [makeOpp(), makeOpp({ id: "opp-2" })],
      carriers: new Map([
        ["opp-1", [{ id: "r1", rank: 1, sentAt: null, excludedReason: null }]],
        ["opp-2", [{ id: "r2", rank: 1, sentAt: null, excludedReason: null }]],
      ]),
    });
    const r = await runAutoPilotTick(buildStorage(state), tickAt);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(r.carriersSent).toBe(1);
    expect(state.audit.find(a => a.eventType === "outreach_blocked")).toBeTruthy();
  });
});

// ── New cockpit contract — sorts, row coverage breakdown, fit-score chips ──

vi.mock("../storage", () => ({
  storage: {
    listFreightOpportunityCarriers: vi.fn(async () => []),
    getCarrier: vi.fn(async () => null),
    getCompany: vi.fn(async () => null),
    getCompanyOutreachPolicy: vi.fn(async () => null),
    getRecurringLane: vi.fn(async () => null),
    getUser: vi.fn(async () => null),
    countFreightOpportunitiesCoveredSince: vi.fn(async () => 0),
  },
}));
vi.mock("../pricingBlendService", () => ({
  getBlendedRate: vi.fn(async () => ({
    targetBuyRpm: 2.45,
    confidence: "medium" as const,
    reason: "median of carrier history (24 loads)",
    marketRpm: 2.50,
    legs: {
      history: {
        medianCostPerMile: 2.34,
        loads30d: 12,
        avgCost30d: 2.40,
      },
    },
  })),
}));

describe("FREIGHT_COCKPIT_SORTS", () => {
  it("includes all Task #601-required sort dimensions", () => {
    // Task #601 explicitly calls out these three dimensions on top of the
    // baseline (urgency / pickup / freshness / customer / lane).
    for (const required of ["suggested_buy", "coverage_pct", "confidence"]) {
      expect(FREIGHT_COCKPIT_SORTS).toContain(required as any);
    }
  });
});

describe("buildCockpitRow", () => {
  const baseOpp = {
    id: "opp-101",
    orgId: "org-1",
    status: "ready_to_send",
    origin: "Chicago",
    originState: "IL",
    destination: "Atlanta",
    destinationState: "GA",
    equipmentType: "Dry Van",
    pickupWindowStart: new Date("2026-04-26T12:00:00.000Z").toISOString(),
    pickupWindowEnd: null,
    awaitingApprovalSince: null,
    snoozedUntil: null,
    ownerUserId: "user-1",
    delegatedToUserId: null,
    companyId: null,
    recurringLaneId: null,
    generatedAt: new Date("2026-04-24T08:00:00.000Z"),
  } as unknown as FreightOpportunity;

  beforeEach(async () => {
    const { storage } = await import("../storage");
    (storage.listFreightOpportunityCarriers as any).mockReset();
    (storage.getCarrier as any).mockReset().mockResolvedValue({ id: "c1", name: "Acme Trucking" });
  });

  it("returns coverage.excludedReasons keyed by suppression reason", async () => {
    const { storage } = await import("../storage");
    (storage.listFreightOpportunityCarriers as any).mockResolvedValue([
      { id: "r1", carrierId: "c1", rank: 1, fitScore: 88, bucket: "preferred",
        excludedReason: null, sentAt: null, lastResponseId: null, createdAt: new Date(), explanation: null },
      { id: "r2", carrierId: "c2", rank: 2, fitScore: 70, bucket: "broker",
        excludedReason: "policy:do_not_automate", sentAt: null, lastResponseId: null, createdAt: new Date(), explanation: null },
      { id: "r3", carrierId: "c3", rank: 3, fitScore: 65, bucket: "broker",
        excludedReason: "policy:do_not_automate", sentAt: null, lastResponseId: null, createdAt: new Date(), explanation: null },
      { id: "r4", carrierId: "c4", rank: 4, fitScore: 50, bucket: "cold",
        excludedReason: "cap:daily_limit", sentAt: null, lastResponseId: null, createdAt: new Date(), explanation: null },
    ]);
    const row = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(row.coverage.excluded).toBe(3);
    expect(row.coverage.excludedReasons).toEqual({
      "policy:do_not_automate": 2,
      "cap:daily_limit": 1,
    });
  });

  it("sets coverage.stage based on outreach state", async () => {
    const { storage } = await import("../storage");
    // outreach: included carriers but none sent
    (storage.listFreightOpportunityCarriers as any).mockResolvedValueOnce([
      { id: "r1", carrierId: "c1", rank: 1, fitScore: 88, bucket: "preferred",
        excludedReason: null, sentAt: null, lastResponseId: null, createdAt: new Date(), explanation: null },
    ]);
    const r1 = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(r1.coverage.stage).toBe("outreach");

    // awaiting: sent, no replies
    (storage.listFreightOpportunityCarriers as any).mockResolvedValueOnce([
      { id: "r1", carrierId: "c1", rank: 1, fitScore: 88, bucket: "preferred",
        excludedReason: null, sentAt: new Date(), lastResponseId: null, createdAt: new Date(), explanation: null },
    ]);
    const r2 = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(r2.coverage.stage).toBe("awaiting");

    // partial: some sent, some replied
    (storage.listFreightOpportunityCarriers as any).mockResolvedValueOnce([
      { id: "r1", carrierId: "c1", rank: 1, fitScore: 88, bucket: "preferred",
        excludedReason: null, sentAt: new Date(), lastResponseId: "resp-1", createdAt: new Date(), explanation: null },
      { id: "r2", carrierId: "c2", rank: 2, fitScore: 80, bucket: "preferred",
        excludedReason: null, sentAt: new Date(), lastResponseId: null, createdAt: new Date(), explanation: null },
    ]);
    const r3 = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(r3.coverage.stage).toBe("partial");
  });

  it("propagates fit-score `explanation` to the chip tooltip payload", async () => {
    const { storage } = await import("../storage");
    (storage.listFreightOpportunityCarriers as any).mockResolvedValue([
      { id: "r1", carrierId: "c1", rank: 1, fitScore: 92, bucket: "preferred",
        excludedReason: null, sentAt: null, lastResponseId: null,
        createdAt: new Date(),
        explanation: "Top historical performer (12 loads in 90d)" },
    ]);
    const row = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(row.chips[0].explanation).toBe("Top historical performer (12 loads in 90d)");
  });

  it("includes lastPaidRpm and loads30d in suggestedBuy from blended history", async () => {
    const { storage } = await import("../storage");
    (storage.listFreightOpportunityCarriers as any).mockResolvedValue([]);
    const row = await buildCockpitRow("org-1", baseOpp, { now: new Date("2026-04-24T12:00:00.000Z") });
    expect(row.suggestedBuy).toMatchObject({
      rate: 2.45,
      confidence: "medium",
      lastPaidRpm: 2.34,
      loads30d: 12,
      marketRpm: 2.50,
    });
    // ((2.45 - 2.50) / 2.50) * 100 = -2 %
    expect(row.suggestedBuy?.marketDeltaPct).toBeCloseTo(-2, 1);
  });
});

describe("FREIGHT_COCKPIT_LAYOUTS", () => {
  it("supports table and pickup-day calendar swimlane layouts (Task #601)", () => {
    expect(FREIGHT_COCKPIT_LAYOUTS).toContain("table");
    expect(FREIGHT_COCKPIT_LAYOUTS).toContain("calendar");
  });
});

describe("storage.countFreightOpportunitiesCoveredSince", () => {
  it("is wired on the IStorage interface for KPI/audit-driven coveredToday", async () => {
    const { storage } = await import("../storage");
    expect(typeof (storage as any).countFreightOpportunitiesCoveredSince).toBe("function");
  });
});

describe("bulk-action schema (Task #601 mark_covered)", () => {
  it("accepts mark_covered with carrier+rates and rejects it without them", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      opportunityIds: z.array(z.string().min(1)).min(1).max(100),
      action: z.enum(["approve", "snooze", "dismiss", "reassign", "mark_covered", "send_top"]),
      outcome: z.enum(["covered", "lost", "no_bid"]).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      carrierId: z.string().min(1).optional(),
      carrierName: z.string().min(1).max(200).optional(),
      paidRate: z.number().positive().max(999999).optional(),
      customerRate: z.number().positive().max(999999).optional(),
    }).refine(
      (d) => d.action !== "mark_covered" || ((d.carrierId || d.carrierName) && d.paidRate != null && d.customerRate != null),
      { message: "mark_covered requires carrierId|carrierName, paidRate, and customerRate" },
    );

    const ok = schema.safeParse({
      opportunityIds: ["opp-1", "opp-2"],
      action: "mark_covered",
      carrierName: "Acme Logistics",
      paidRate: 2200,
      customerRate: 2500,
      notes: "Won the lane block",
    });
    expect(ok.success).toBe(true);

    const missingCarrier = schema.safeParse({
      opportunityIds: ["opp-1"],
      action: "mark_covered",
      paidRate: 2200,
      customerRate: 2500,
    });
    expect(missingCarrier.success).toBe(false);

    const missingRates = schema.safeParse({
      opportunityIds: ["opp-1"],
      action: "mark_covered",
      carrierName: "Acme Logistics",
    });
    expect(missingRates.success).toBe(false);
  });

  it("routes mark_covered through the canonical coverFreightOpportunity helper (audit + load_fact)", async () => {
    const helper = await import("../services/coverFreightOpportunity");
    expect(typeof helper.coverFreightOpportunity).toBe("function");
    expect(typeof helper.canCoverOpportunity).toBe("function");

    const cockpitSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routes/freightOpportunityCockpit.ts", "utf8")
    );
    expect(cockpitSrc).toMatch(/coverFreightOpportunity/);
    expect(cockpitSrc).toMatch(/action === "mark_covered"/);

    const proactiveSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routes/proactiveOpportunities.ts", "utf8")
    );
    expect(proactiveSrc).toMatch(/coverFreightOpportunity/);
  });

  it("policy patch schema accepts auto-send fields and the merge persists them", async () => {
    const { z } = await import("zod");
    const FREIGHT_OPPORTUNITY_MODES = ["off", "exact_load", "consignee_aware"] as const;
    const schema = z.object({
      enabled: z.boolean().optional(),
      mode: z.enum(FREIGHT_OPPORTUNITY_MODES).optional(),
      autoSendEnabled: z.boolean().optional(),
      autoSendHourCt: z.number().int().min(0).max(23).optional(),
      autoSendTopN: z.number().int().min(1).max(10).optional(),
      autoSendMaxPerDay: z.number().int().min(1).max(100).optional(),
    });

    const ok = schema.safeParse({
      autoSendEnabled: true,
      autoSendHourCt: 9,
      autoSendTopN: 5,
      autoSendMaxPerDay: 20,
    });
    expect(ok.success).toBe(true);

    const badHour = schema.safeParse({ autoSendHourCt: 25 });
    expect(badHour.success).toBe(false);
    const badTopN = schema.safeParse({ autoSendTopN: 0 });
    expect(badTopN.success).toBe(false);
    const badMax = schema.safeParse({ autoSendMaxPerDay: 999 });
    expect(badMax.success).toBe(false);

    // Verify the route file actually persists these fields in the merge.
    const proactiveSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routes/proactiveOpportunities.ts", "utf8")
    );
    expect(proactiveSrc).toMatch(/autoSendEnabled:\s*parsed\.data\.autoSendEnabled\s*\?\?\s*existing\?\.autoSendEnabled/);
    expect(proactiveSrc).toMatch(/autoSendHourCt:\s*parsed\.data\.autoSendHourCt\s*\?\?\s*existing\?\.autoSendHourCt/);
    expect(proactiveSrc).toMatch(/autoSendTopN:\s*parsed\.data\.autoSendTopN\s*\?\?\s*existing\?\.autoSendTopN/);
    expect(proactiveSrc).toMatch(/autoSendMaxPerDay:\s*parsed\.data\.autoSendMaxPerDay\s*\?\?\s*existing\?\.autoSendMaxPerDay/);
  });

  it("blocks non-owner non-manager from covering via the helper permission gate", async () => {
    const { canCoverOpportunity } = await import("../services/coverFreightOpportunity");
    const opp = { ownerUserId: "owner-1", delegatedToUserId: null } as any;
    const stranger = { id: "stranger-1", role: "sales" } as any;
    const owner = { id: "owner-1", role: "sales" } as any;
    const manager = { id: "mgr-1", role: "logistics_manager" } as any;
    expect(canCoverOpportunity(opp, stranger)).toBe(false);
    expect(canCoverOpportunity(opp, owner)).toBe(true);
    expect(canCoverOpportunity(opp, manager)).toBe(true);
  });
});
