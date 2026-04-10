/**
 * Tests for Account-Level Market Signal NBAs (Task #186)
 *
 * Covers:
 *   - Exposure matching: match / no-match / stale-outside-window
 *   - NBA creation from active signal + exposed account
 *   - Dedup: same (companyId, signalId, ruleType) does NOT double-create
 *   - New signal (new ID) can create new NBA even if prior one is resolved
 *   - Signal resolution auto-dismisses pending NBAs
 *   - Explanation payload structure and determinism
 *   - Scheduler/trigger integration path
 *
 * Run with:  npx tsx server/marketNbaService.test.ts
 */

import { getExposedAccounts, RECURRING_LANE_LOOKBACK_DAYS, MARKET_SHARE_LOOKBACK_DAYS } from "./marketNbaExposureService";
import { syncMarketSignalNbas, autoResolveNbasForSignal, buildMarketNbaExplanation } from "./marketNbaService";
import type { IStorage } from "./storage";
import type { MarketSignal, NbaCard } from "../shared/schema";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(desc: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${desc}`);
    failed++;
  }
}

function assertEq<T>(desc: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ ${desc}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function recentDate(daysAgo = 10): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

function staleDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

const BASE_SIGNAL: MarketSignal = {
  id: "sig-001",
  signalType: "demand_surge",
  scopeType: "region",
  scopeKey: "GA",
  equipmentType: "dry_van",
  status: "active",
  severity: "high",
  confidence: "0.85" as any,
  evidencePayload: { recentCount: 5, baselineCount: 3, percentChange: 18.5 } as any,
  explanation: "Demand surge detected in GA region",
  firstDetectedAt: new Date(),
  lastEvaluatedAt: new Date(),
  coolingStartedAt: null,
  resolvedAt: null,
};

function makeStorageMock(overrides: Partial<IStorage> = {}): IStorage {
  return {
    getCompanies: async (_orgId: string) => [],
    getMarketShareEntries: async (_companyId: string) => [],
    getLaneAttributionsByCompany: async (_companyId: string) => [],
    getRecurringLanesByCompany: async (_companyId: string) => [],
    getActiveMarketSignals: async (_filters: any) => [],
    getNbaCardByMarketSignalDedup: async () => undefined,
    createNbaCard: async (data: any) => ({ ...data, id: `nba-${Date.now()}` } as any),
    dismissNbaCardsByMarketSignal: async () => 0,
    getNbaCardsByMarketSignal: async () => [],
    getNbaCardsByCompanyAndRuleType: async () => [],
    getNbaCardsByUserId: async () => [],
    ...overrides,
  } as unknown as IStorage;
}

function makeRecurringLane(originState: string, daysAgo = 5): any {
  const updatedAt = new Date();
  updatedAt.setDate(updatedAt.getDate() - daysAgo);
  return {
    id: `lane-${originState}-${daysAgo}`,
    orgId: "org-1",
    companyId: "co-1",
    origin: `Atlanta, ${originState}`,
    originState,
    destination: "Dallas, TX",
    destinationState: "TX",
    equipmentType: "dry_van",
    updatedAt,
    createdAt: updatedAt,
    ownerUserId: "user-1",
  };
}

function makeMarketShareEntry(daysAgo = 5, spotLoads = 3): any {
  const date = recentDate(daysAgo);
  return {
    id: `mse-${daysAgo}`,
    companyId: "co-1",
    entryType: "monthly",
    periodLabel: "2025-01",
    periodStart: date,
    periodEnd: date,
    spotLoads,
    vtLoads: 2,
    totalMarketLoads: 10,
    createdAt: date,
    createdBy: "user-1",
    notes: null,
    rfpId: null,
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testExposureMatching(): Promise<void> {
  console.log("\n── Exposure Matching ─────────────────────────────────────────────────");

  // 1. Match via recurring_lane (Rule A)
  {
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [makeRecurringLane("GA", 10)],
    });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert("Rule A: account with recent GA lane is matched", exposed.length === 1);
    assertEq("Rule A: matched rule is recurring_lane", exposed[0]?.evidence.matchedRule, "recurring_lane");
    assertEq("Rule A: region matched", exposed[0]?.evidence.regionMatched, "GA");
  }

  // 2. No match: lane origin is different state
  {
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [makeRecurringLane("OR", 10)],
    });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert("Rule A: account with non-matching state is NOT matched (no market share, no attribution)", exposed.length === 0);
  }

  // 3. Stale lane outside 90-day window — not matched
  {
    const staleDays = RECURRING_LANE_LOOKBACK_DAYS + 5;
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [makeRecurringLane("GA", staleDays)],
    });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert(`Rule A: stale lane (${staleDays} days) outside window is NOT matched`, exposed.length === 0);
  }

  // 4. Match via market_share_entries (Rule B)
  {
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [],
      getMarketShareEntries: async () => [makeMarketShareEntry(30, 4)],
    });
    const signalNoEquip: MarketSignal = { ...BASE_SIGNAL, equipmentType: null };
    const exposed = await getExposedAccounts(signalNoEquip, "org-1", storage);
    assert("Rule B: account with recent market share activity is matched", exposed.length === 1);
    assertEq("Rule B: matched rule is market_share", exposed[0]?.evidence.matchedRule, "market_share");
  }

  // 5. Stale market share entry outside 60-day window
  {
    const staleDays = MARKET_SHARE_LOOKBACK_DAYS + 5;
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [],
      getMarketShareEntries: async () => [makeMarketShareEntry(staleDays, 3)],
    });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert(`Rule B: stale market share (${staleDays} days) outside window is NOT matched`, exposed.length === 0);
  }

  // 6. Match via lane attribution (Rule C)
  {
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
      getRecurringLanesByCompany: async () => [],
      getMarketShareEntries: async () => [],
      getLaneAttributionsByCompany: async () => [{
        id: "la-1", companyId: "co-1", contactId: "ct-1",
        originCity: "Atlanta",
        originState: "GA",
        destinationCity: "Dallas",
        destinationState: "TX",
      } as any],
    });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert("Rule C: account with GA lane attribution is matched", exposed.length === 1);
    assertEq("Rule C: matched rule is lane_attribution", exposed[0]?.evidence.matchedRule, "lane_attribution");
  }

  // 7. No companies → empty result
  {
    const storage = makeStorageMock({ getCompanies: async () => [] });
    const exposed = await getExposedAccounts(BASE_SIGNAL, "org-1", storage);
    assert("No companies → no exposed accounts", exposed.length === 0);
  }

  // 8. Resolved signal returns empty
  {
    const storage = makeStorageMock({
      getCompanies: async () => [{ id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any],
    });
    const resolvedSignal: MarketSignal = { ...BASE_SIGNAL, status: "resolved" };
    const exposed = await getExposedAccounts(resolvedSignal, "org-1", storage);
    assert("Resolved signal returns no exposed accounts", exposed.length === 0);
  }
}

async function testNbaCreation(): Promise<void> {
  console.log("\n── NBA Creation ──────────────────────────────────────────────────────");

  const created: any[] = [];

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [BASE_SIGNAL],
    getCompanies: async () => [
      { id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any,
    ],
    getRecurringLanesByCompany: async () => [makeRecurringLane("GA", 10)],
    getNbaCardByMarketSignalDedup: async () => undefined,
    createNbaCard: async (data: any) => {
      const card = { ...data, id: `nba-${created.length}` };
      created.push(card);
      return card as any;
    },
  });

  const result = await syncMarketSignalNbas("org-1", storage);

  assert("syncMarketSignalNbas returns processed count >= 1", result.processed >= 1);
  assert("syncMarketSignalNbas creates exactly 1 card", result.created === 1);
  assertEq("Created card ruleType is market_surge_customer_outreach",
    created[0]?.ruleType, "market_surge_customer_outreach");
  assertEq("Created card has marketSignalId", created[0]?.marketSignalId, "sig-001");
  assertEq("Created card has correct companyId", created[0]?.companyId, "co-1");
  assertEq("Created card has correct userId", created[0]?.userId, "user-1");
  assert("Created card status is generated", created[0]?.status === "generated");
  assert("Created card urgencyScore > 0", (created[0]?.urgencyScore ?? 0) > 0);
}

async function testDedup(): Promise<void> {
  console.log("\n── Dedup ─────────────────────────────────────────────────────────────");

  const created: any[] = [];
  const existingCard: NbaCard = {
    id: "nba-existing",
    orgId: "org-1",
    userId: "user-1",
    companyId: "co-1",
    companyName: "Acme Co",
    ruleType: "market_surge_customer_outreach",
    status: "visible",
    marketSignalId: "sig-001",
  } as any;

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [BASE_SIGNAL],
    getCompanies: async () => [
      { id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any,
    ],
    getRecurringLanesByCompany: async () => [makeRecurringLane("GA", 10)],
    getNbaCardByMarketSignalDedup: async () => existingCard,
    createNbaCard: async (data: any) => {
      created.push(data);
      return { ...data, id: "new" } as any;
    },
  });

  const result = await syncMarketSignalNbas("org-1", storage);
  assert("Dedup: existing active card skips creation", result.created === 0);
  assert("Dedup: createNbaCard was NOT called", created.length === 0);
  assert("Dedup: skipped count >= 1", result.skipped >= 1);
}

async function testNewSignalCreatesNewNba(): Promise<void> {
  console.log("\n── New signal creates new NBA even if prior resolved ─────────────────");

  const created: any[] = [];
  const newSignal: MarketSignal = { ...BASE_SIGNAL, id: "sig-002" };

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [newSignal],
    getCompanies: async () => [
      { id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any,
    ],
    getRecurringLanesByCompany: async () => [makeRecurringLane("GA", 10)],
    getNbaCardByMarketSignalDedup: async (companyId, signalId) => {
      if (signalId === "sig-001") return { id: "old-card", status: "actioned" } as any;
      return undefined;
    },
    createNbaCard: async (data: any) => {
      created.push(data);
      return { ...data, id: `nba-${created.length}` } as any;
    },
  });

  const result = await syncMarketSignalNbas("org-1", storage);
  assert("New signal (sig-002) creates a new NBA", result.created === 1);
  assertEq("New NBA marketSignalId is sig-002", created[0]?.marketSignalId, "sig-002");
}

async function testSignalResolutionAutoDismisses(): Promise<void> {
  console.log("\n── Signal resolution auto-dismisses pending NBAs ─────────────────────");

  let dismissCallSignalId: string | null = null;
  let dismissCount = 0;

  const storage = makeStorageMock({
    dismissNbaCardsByMarketSignal: async (signalId: string) => {
      dismissCallSignalId = signalId;
      dismissCount = 3;
      return dismissCount;
    },
  });

  const dismissed = await autoResolveNbasForSignal("sig-001", storage);
  assertEq("autoResolveNbasForSignal calls dismissNbaCardsByMarketSignal with correct signalId",
    dismissCallSignalId, "sig-001");
  assertEq("autoResolveNbasForSignal returns dismissed count", dismissed, 3);
}

async function testExplanationPayload(): Promise<void> {
  console.log("\n── Explanation Payload ───────────────────────────────────────────────");

  const account = {
    companyId: "co-1",
    companyName: "Acme Logistics",
    ownerId: "user-1",
    evidence: {
      matchedRule: "recurring_lane" as const,
      laneCount: 4,
      lastActivityDate: "2026-03-20",
      regionMatched: "GA",
      equipmentMatched: "dry_van",
    },
  };

  const payload = buildMarketNbaExplanation(BASE_SIGNAL, account, account.evidence);

  assert("Payload has signalSummary", !!payload.signalSummary);
  assert("Payload has accountExposure", !!payload.accountExposure);
  assert("Payload has suggestedOutreachScript", !!payload.suggestedOutreachScript);

  assertEq("signalSummary.signalId", payload.signalSummary.signalId, "sig-001");
  assertEq("signalSummary.signalType", payload.signalSummary.signalType, "demand_surge");
  assertEq("signalSummary.severity", payload.signalSummary.severity, "high");
  assertEq("signalSummary.scopeKey", payload.signalSummary.scopeKey, "GA");
  assert("signalSummary.percentChange is numeric", typeof payload.signalSummary.percentChange === "number");
  assertEq("signalSummary.recentCount", payload.signalSummary.recentCount, 5);

  assertEq("accountExposure.matchedRule", payload.accountExposure.matchedRule, "recurring_lane");
  assertEq("accountExposure.laneCount", payload.accountExposure.laneCount, 4);
  assertEq("accountExposure.lastActivityDate", payload.accountExposure.lastActivityDate, "2026-03-20");

  assert("suggestedOutreachScript mentions account name",
    payload.suggestedOutreachScript.includes("Acme Logistics"));
  assert("suggestedOutreachScript mentions region",
    payload.suggestedOutreachScript.includes("GA"));

  // Determinism: same inputs → same output
  const payload2 = buildMarketNbaExplanation(BASE_SIGNAL, account, account.evidence);
  assertEq("Payload is deterministic (same input → same output)",
    JSON.stringify(payload), JSON.stringify(payload2));
}

async function testSchedulerIntegration(): Promise<void> {
  console.log("\n── Scheduler Integration ─────────────────────────────────────────────");

  const created: any[] = [];

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [BASE_SIGNAL],
    getCompanies: async (orgId: string) => {
      if (orgId === "org-1") return [
        { id: "co-1", name: "Acme Co", salesPersonId: "user-1", organizationId: "org-1" } as any,
        { id: "co-2", name: "Beta Co", salesPersonId: "user-2", organizationId: "org-1" } as any,
      ];
      return [];
    },
    getRecurringLanesByCompany: async (companyId: string) => {
      if (companyId === "co-1") return [makeRecurringLane("GA", 5)];
      return [];
    },
    getMarketShareEntries: async () => [],
    getLaneAttributionsByCompany: async () => [],
    getNbaCardByMarketSignalDedup: async () => undefined,
    createNbaCard: async (data: any) => {
      created.push(data);
      return { ...data, id: `nba-${created.length}` } as any;
    },
    dismissNbaCardsByMarketSignal: async () => 0,
    getNbaCardsByMarketSignal: async (signalId: string) =>
      created.filter((c: any) => c.marketSignalId === signalId) as any,
  });

  const result = await syncMarketSignalNbas("org-1", storage);

  assert("Scheduler: at least 1 NBA created for exposed account", result.created >= 1);
  assert("Scheduler: unexposed account (co-2) did not get a card",
    !created.some((c: any) => c.companyId === "co-2"));

  const bySignal = await storage.getNbaCardsByMarketSignal("sig-001");
  assert("getNbaCardsByMarketSignal returns created cards", bySignal.length >= 1);
  assert("getNbaCardsByMarketSignal returns correct ruleType",
    bySignal.every((c: any) => c.ruleType === "market_surge_customer_outreach"));

  // Confirm org with no signals returns zero
  const emptyResult = await syncMarketSignalNbas("org-2", storage);
  assertEq("Org with no signals: created=0", emptyResult.created, 0);
}

async function testNoOwnerSkipped(): Promise<void> {
  console.log("\n── No-owner company is skipped ──────────────────────────────────────");

  const created: any[] = [];

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [BASE_SIGNAL],
    getCompanies: async () => [
      { id: "co-1", name: "Orphan Co", salesPersonId: null, assignedTo: null, organizationId: "org-1" } as any,
    ],
    getRecurringLanesByCompany: async () => [makeRecurringLane("GA", 5)],
    getNbaCardByMarketSignalDedup: async () => undefined,
    createNbaCard: async (data: any) => {
      created.push(data);
      return { ...data, id: "x" } as any;
    },
  });

  const result = await syncMarketSignalNbas("org-1", storage);
  assert("Company with no owner is skipped (created=0)", result.created === 0);
  assert("No-owner company is counted as skipped", result.skipped >= 1);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Market Signal NBA Tests (Task #186) ===\n");

  await testExposureMatching();
  await testNbaCreation();
  await testDedup();
  await testNewSignalCreatesNewNba();
  await testSignalResolutionAutoDismisses();
  await testExplanationPayload();
  await testSchedulerIntegration();
  await testNoOwnerSkipped();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
