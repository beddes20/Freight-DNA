/**
 * Proactive Available Freight Outreach Engine — Phase 2 service tests (Task #304).
 *
 * Covers the 10 validation scenarios listed in
 * docs/proactive-freight-outreach/phase1-audit.md (eligibility gate,
 * bucket assignment, confidence flag, generation policy gating).
 */

import { describe, it, expect, vi } from "vitest";
import {
  evaluateCarrierEligibility,
  assignBucket,
  deriveConfidenceFlag,
  generateOpportunitiesForCompany,
  loadEffectivePolicy,
  PAFOE_DEFAULTS,
  type CarrierEligibilityContext,
  type RankedShortlistRow,
} from "../proactiveOpportunityService";
import type { CompanyOutreachPolicy } from "@shared/schema";
import type { RankedCarrier } from "../carrierRankingService";

// ── helpers ────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<CompanyOutreachPolicy> = {}): CompanyOutreachPolicy {
  return {
    id: "pol-1",
    orgId: "org-1",
    companyId: "co-1",
    enabled: true,
    mode: "exact_load",
    approvalRequired: true,
    maxCarriersPerOpportunity: 5,
    leadTimeMinDays: 2,
    leadTimeMaxDays: 7,
    approvedCarrierOnly: false,
    approvedCarrierIds: [],
    doNotAutomate: false,
    specialNotes: null,
    updatedAt: new Date(),
    updatedById: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CarrierEligibilityContext> = {}): CarrierEligibilityContext {
  return {
    policy: makePolicy(),
    recentContactCarrierIds: new Set(),
    repOverrideCarrierIds: new Set(),
    dailyBudgetCheck: async () => ({ allowed: true }),
    ...overrides,
  };
}

function makeRanked(overrides: Partial<RankedCarrier> = {}): RankedCarrier {
  return {
    carrierId: "car-1",
    carrierName: "Acme Trucking",
    mcDot: null,
    primaryEmail: "ops@acme.com",
    backupEmail: null,
    regions: [],
    equipmentTypes: ["Dry Van"],
    tags: [],
    notes: null,
    fitScore: 75,
    fitReason: "Strong match",
    historyMatch: "exact",
    loadsOnLane: 4,
    lastUsedMonth: null,
    isNewProspect: false,
    estimatedOnTimePct: null,
    marginContribution: null,
    customerHistoryLoads: 0,
    priorOutcomeBoost: false,
    bench: false,
    benchWins: 0,
    sourceChannel: null,
    suppressionReasons: [],
    equipmentMatch: true,
    regionMatch: true,
    isIncumbent: false,
    incumbentRank: null,
    isDoNotUse: false,
    exactLaneLoads: 4,
    nearbyLaneLoads: 0,
    statePairLoads: 0,
    hasAnyCompanyHistory: true,
    hqCity: null,
    hqState: null,
    hqProximityBonus: 0,
    hasMarketNbaBoost: false,
    ...overrides,
  };
}

// ── eligibility gate (scenarios 1–6) ───────────────────────────────────────

describe("evaluateCarrierEligibility", () => {
  it("scenario 1 — allows a clean carrier", async () => {
    const d = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: [] },
      makeCtx(),
    );
    expect(d.allowed).toBe(true);
  });

  it("scenario 2 — blocks do_not_use status", async () => {
    const d = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "do_not_use", tags: [] },
      makeCtx(),
    );
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toBe("do_not_use");
  });

  it("scenario 3 — blocks opted_out tag and survives rep override", async () => {
    const ctx = makeCtx({ repOverrideCarrierIds: new Set(["c1"]) });
    const d = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: ["opted_out"] },
      ctx,
    );
    expect(d.allowed).toBe(false);
    expect((d as any).reason).toBe("opted_out");
  });

  it("scenario 4 — approvedCarrierOnly excludes non-approved carriers", async () => {
    const ctx = makeCtx({
      policy: makePolicy({ approvedCarrierOnly: true, approvedCarrierIds: ["c-other"] }),
    });
    const d = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: [] },
      ctx,
    );
    expect((d as any).reason).toBe("not_approved");
  });

  it("scenario 5 — daily_cap blocks over-budget carriers", async () => {
    const ctx = makeCtx({ dailyBudgetCheck: async () => ({ allowed: false, reason: "5/5 reached" }) });
    const d = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: [] },
      ctx,
    );
    expect((d as any).reason).toBe("daily_cap");
  });

  it("scenario 6 — recent_contact blocks but rep override bypasses it", async () => {
    const blocked = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: [] },
      makeCtx({ recentContactCarrierIds: new Set(["c1"]) }),
    );
    expect((blocked as any).reason).toBe("recent_contact");

    const overridden = await evaluateCarrierEligibility(
      { id: "c1", primaryEmail: "x@y.com", status: "active", tags: [] },
      makeCtx({
        recentContactCarrierIds: new Set(["c1"]),
        repOverrideCarrierIds: new Set(["c1"]),
      }),
    );
    expect(overridden.allowed).toBe(true);
  });
});

// ── bucket assignment + confidence (scenarios 7–8) ─────────────────────────

describe("assignBucket", () => {
  it("scenario 7a — proven when exact lane loads >= 1", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 2, fitScore: 60 }))).toBe("proven");
  });
  it("scenario 7b — proven when prior outcome boost is set", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 0, priorOutcomeBoost: true, fitScore: 30 }))).toBe("proven");
  });
  it("scenario 7c — strong_fit_underused when score >= 70 with no exact loads", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 0, fitScore: 72 }))).toBe("strong_fit_underused");
  });
  it("scenario 7d — exploratory between exploratoryMinScore and strongFit threshold", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 0, fitScore: 55 }))).toBe("exploratory");
  });
  it("scenario 7e — null (drop) below the exploratory floor", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 0, fitScore: 30 }))).toBeNull();
  });
  it("scenario 7f — rep_added overrides everything when flagged", () => {
    expect(assignBucket(makeRanked({ exactLaneLoads: 5, fitScore: 90 }), { repAdded: true })).toBe("rep_added");
  });
});

describe("deriveConfidenceFlag", () => {
  it("scenario 8 — low when no eligible rows", () => {
    expect(deriveConfidenceFlag([])).toBe("low");
  });
  it("scenario 8 — normal when proven share >= 25% and median >= 60", () => {
    const rows: RankedShortlistRow[] = [
      { carrier: { id: "1", primaryEmail: null, status: "active", tags: [] }, ranked: makeRanked({ fitScore: 80 }), bucket: "proven", excludedReason: null, rank: 1 },
      { carrier: { id: "2", primaryEmail: null, status: "active", tags: [] }, ranked: makeRanked({ fitScore: 65 }), bucket: "strong_fit_underused", excludedReason: null, rank: 2 },
      { carrier: { id: "3", primaryEmail: null, status: "active", tags: [] }, ranked: makeRanked({ fitScore: 60 }), bucket: "exploratory", excludedReason: null, rank: 3 },
    ];
    expect(deriveConfidenceFlag(rows)).toBe("normal");
  });
  it("scenario 8 — low when proven share is low and median is mediocre", () => {
    const rows: RankedShortlistRow[] = [
      { carrier: { id: "1", primaryEmail: null, status: "active", tags: [] }, ranked: makeRanked({ fitScore: 50 }), bucket: "exploratory", excludedReason: null, rank: 1 },
      { carrier: { id: "2", primaryEmail: null, status: "active", tags: [] }, ranked: makeRanked({ fitScore: 50 }), bucket: "exploratory", excludedReason: null, rank: 2 },
    ];
    expect(deriveConfidenceFlag(rows)).toBe("low");
  });
});

// ── generation policy gating (scenarios 9–10) ──────────────────────────────

function makeStorageMock(policy: CompanyOutreachPolicy | undefined = undefined) {
  const opportunities: any[] = [];
  const audit: any[] = [];
  const carrierRows: any[] = [];
  return {
    storage: {
      getCompanyOutreachPolicy: vi.fn(async () => policy),
      createFreightOpportunity: vi.fn(async (data: any) => {
        const row = { ...data, id: `opp-${opportunities.length + 1}`, generatedAt: new Date() };
        opportunities.push(row);
        return row;
      }),
      updateFreightOpportunity: vi.fn(async (_org: string, id: string, fields: any) => {
        const row = opportunities.find(o => o.id === id);
        if (row) Object.assign(row, fields);
        return row;
      }),
      insertFreightOpportunityCarriers: vi.fn(async (rows: any[]) => {
        const persisted = rows.map((r, i) => ({ ...r, id: `opc-${carrierRows.length + i + 1}`, createdAt: new Date() }));
        carrierRows.push(...persisted);
        return persisted;
      }),
      appendFreightOpportunityAudit: vi.fn(async (data: any) => {
        const row = { ...data, id: `aud-${audit.length + 1}`, createdAt: new Date() };
        audit.push(row);
        return row;
      }),
      // Used by buildEligibilityContext via the IStorage method.
      getRecentlyContactedCarrierIds: vi.fn(async () => [] as string[]),
      checkCarrierDailyBudget: vi.fn(async () => ({ allowed: true })),
      getCarriers: vi.fn(async () => []),
      getFinancialUploadsForOrg: vi.fn(async () => []),
    } as any,
    opportunities,
    audit,
    carrierRows,
  };
}

describe("generateOpportunitiesForCompany", () => {
  it("scenario 9 — blocks when policy is missing/disabled", async () => {
    const { storage } = makeStorageMock(undefined);
    const result = await generateOpportunitiesForCompany(storage, "org-1", "co-1", {
      mode: "exact_load",
      loads: [{ origin: "ATL", destination: "ORD", pickupWindowStart: "2026-04-25", pickupWindowEnd: "2026-04-26" }],
    });
    expect((result as any).blocked).toBe(true);
    expect((result as any).reason).toBe("policy_disabled");
  });

  it("scenario 10 — blocks when do_not_automate is true even if enabled", async () => {
    const { storage } = makeStorageMock(makePolicy({ enabled: true, doNotAutomate: true }));
    const result = await generateOpportunitiesForCompany(storage, "org-1", "co-1", {
      mode: "exact_load",
      loads: [{ origin: "ATL", destination: "ORD", pickupWindowStart: "2026-04-25", pickupWindowEnd: "2026-04-26" }],
    });
    expect((result as any).blocked).toBe(true);
    expect((result as any).reason).toBe("policy_do_not_automate");
  });

  it("creates opportunities and writes audit when enabled (no eligible carriers in mock)", async () => {
    const { storage, opportunities, audit } = makeStorageMock(makePolicy({ enabled: true }));
    const result = await generateOpportunitiesForCompany(storage, "org-1", "co-1", {
      mode: "exact_load",
      loads: [{ origin: "ATL", destination: "ORD", pickupWindowStart: "2026-04-25", pickupWindowEnd: "2026-04-26" }],
    });
    expect(Array.isArray(result)).toBe(true);
    expect(opportunities.length).toBe(1);
    expect(audit.some(a => a.eventType === "generated")).toBe(true);
    expect(audit.some(a => a.eventType === "status_changed")).toBe(true);
    // No carriers in catalog → confidence flag should be "low".
    expect(opportunities[0].confidenceFlag).toBe("low");
    expect(opportunities[0].status).toBe("ready_to_send");
  });
});

describe("loadEffectivePolicy", () => {
  it("returns synthetic disabled default when no row exists", async () => {
    const storage = { getCompanyOutreachPolicy: async () => undefined } as any;
    const policy = await loadEffectivePolicy(storage, "org-1", "co-x");
    expect(policy.enabled).toBe(false);
    expect(policy.mode).toBe("exact_load");
    expect(policy.maxCarriersPerOpportunity).toBe(PAFOE_DEFAULTS.policy.maxCarriersPerOpportunity);
  });
});
