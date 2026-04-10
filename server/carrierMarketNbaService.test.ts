/**
 * Tests for Carrier-Side Market Signal NBAs (Task #187)
 *
 * Covers:
 *   - Exposure matching: history-based, preference-based, recency cutoff
 *   - NBA creation produces pending rows
 *   - Subsequent runs update not duplicate (pending/in_progress)
 *   - Completed/dismissed rows are not reopened
 *   - A new signal ID can produce a new NBA for the same carrier
 *   - Explanation JSON contains both signal and carrier fit blocks
 *   - Deterministic prose is stable for fixed input
 *   - syncCarrierMarketNbas is called from the scheduler
 *   - Migration guards handle re-runs cleanly
 *
 * Run with:  npx tsx server/carrierMarketNbaService.test.ts
 */

import {
  getExposedCarriers,
  CARRIER_HISTORY_LOOKBACK_DAYS,
  CARRIER_RECENCY_CUTOFF_DAYS,
} from "./carrierMarketExposureService";
import {
  syncCarrierMarketNbas,
  buildCarrierNbaExplanation,
  CARRIER_NBA_TYPES,
} from "./carrierMarketNbaService";
import type { IStorage } from "./storage";
import type { MarketSignal, CarrierMarketNba } from "@shared/schema";

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

const BASE_SIGNAL: MarketSignal = {
  id: "sig-001",
  signalType: "demand_surge",
  scopeType: "region",
  scopeKey: "TX",
  equipmentType: "dry_van",
  status: "active",
  severity: "high",
  confidence: "0.85" as any,
  evidencePayload: { recentCount: 8, baselineCount: 4, percentChange: 100 } as any,
  explanation: "Demand surge detected in TX region",
  firstDetectedAt: new Date(),
  lastEvaluatedAt: new Date(),
  coolingStartedAt: null,
  resolvedAt: null,
};

const IMBALANCE_SIGNAL: MarketSignal = {
  ...BASE_SIGNAL,
  id: "sig-imb-001",
  signalType: "demand_capacity_imbalance",
};

function daysAgoDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 3_600_000);
}

function makeCarrier(id: string, equipmentTypes: string[] = ["dry_van"]): any {
  return {
    id,
    orgId: "org-1",
    name: `Carrier ${id}`,
    status: "active",
    equipmentTypes,
    regions: [],
    statesServed: ["TX"],
  };
}

function makeHistoryRow(carrierId: string, daysAgo: number, originRegion = "TX"): any {
  return {
    carrierId,
    originRegion,
    occurredAt: daysAgoDate(daysAgo),
  };
}

function makeClaimedLane(carrierId: string, originState: string, equipment: string, laneType = "prefer"): any {
  return {
    id: `cl-${carrierId}`,
    carrierId,
    originState,
    equipment,
    laneType,
    createdAt: new Date(),
  };
}

function makeStorageMock(overrides: Partial<IStorage> = {}): IStorage {
  return {
    getCarriersByOrgForMarketSignal: async () => [],
    getFinancialRowsForCarrierSignal: async () => [],
    getCarrierClaimedLanesByCarrierId: async () => [],
    getActiveMarketSignals: async () => [],
    upsertCarrierMarketNba: async (data: any) => ({ ...data, id: `nba-${Date.now()}`, createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), lastActionAt: null } as any),
    getCarrierMarketNbaByDedup: async () => undefined,
    getCarrierMarketNbasBySignal: async () => [],
    getCarrierMarketNbasByCarrier: async () => [],
    ...overrides,
  } as unknown as IStorage;
}

// ── Exposure matching tests ───────────────────────────────────────────────────

async function testExposureMatching(): Promise<void> {
  console.log("\n── Carrier Exposure Matching ─────────────────────────────────────────");

  // 1. Carrier with recent run is matched (history-based)
  {
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 10, "TX")],
    });
    const results = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    assert("History-based: carrier with recent TX run is matched", results.length === 1);
    assertEq("History-based: carrierId matches", results[0]?.carrierId, "c1");
    assert("History-based: runCount >= 1", (results[0]?.runCount ?? 0) >= 1);
  }

  // 2. Carrier with no run history and no claimed lanes is excluded
  {
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c2")],
      getFinancialRowsForCarrierSignal: async () => [],
      getCarrierClaimedLanesByCarrierId: async () => [],
    });
    const results = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    assert("No history/preference: carrier is excluded", results.length === 0);
  }

  // 3. Carrier matched via declared preference (no history runs)
  {
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c3")],
      getFinancialRowsForCarrierSignal: async () => [],
      getCarrierClaimedLanesByCarrierId: async (id: string) =>
        id === "c3" ? [makeClaimedLane("c3", "TX", "dry_van")] : [],
    });
    const results = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    assert("Preference-based: carrier with TX preference is matched", results.length === 1);
    assert("Preference-based: declaredPreference is true", results[0]?.declaredPreference === true);
  }

  // 4. Recency cutoff: old runs outside window do not contribute to fit score boost
  {
    const staleDays = CARRIER_RECENCY_CUTOFF_DAYS + 10;
    const recentDays = 5;
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c4")],
      getFinancialRowsForCarrierSignal: async () => [
        makeHistoryRow("c4", staleDays, "TX"),
        makeHistoryRow("c4", recentDays, "TX"),
      ],
    });
    const staleOnly = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c4")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c4", staleDays, "TX")],
    });
    const withRecent = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    const withoutRecent = await getExposedCarriers(BASE_SIGNAL, "org-1", staleOnly);
    assert("Recency: carrier with both recent and stale runs is still matched", withRecent.length === 1);
    // Carrier with stale-only runs should still be matched (runCount > 0) but within HISTORY window
    assert("Recency: stale-only carrier still matched if within history lookback", withoutRecent.length === 1);
    // But fitScore should be lower for stale-only (no recency bonus)
    if (withRecent.length > 0 && withoutRecent.length > 0) {
      assert("Recency: fit score is higher with recent runs", withRecent[0]!.fitScore >= withoutRecent[0]!.fitScore);
    }
  }

  // 5. Carrier outside CARRIER_HISTORY_LOOKBACK_DAYS entirely is excluded if no preference
  {
    const beyondLookback = CARRIER_HISTORY_LOOKBACK_DAYS + 5;
    // Runs older than lookback won't be returned by the storage method (filtered by since date)
    // We simulate this by returning empty history
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c5")],
      getFinancialRowsForCarrierSignal: async () => [],
    });
    const results = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    assert(`Lookback: carrier with no history in ${beyondLookback} days (simulated) and no preference excluded`, results.length === 0);
  }

  // 6. Inactive carrier is excluded
  {
    const inactiveCarrier = { ...makeCarrier("c6"), status: "inactive" };
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [inactiveCarrier],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c6", 10, "TX")],
    });
    const results = await getExposedCarriers(BASE_SIGNAL, "org-1", storage);
    assert("Inactive carrier is excluded regardless of run history", results.length === 0);
  }

  // 7. Resolved/suppressed signal returns empty
  {
    const resolvedSignal: MarketSignal = { ...BASE_SIGNAL, status: "resolved" };
    const storage = makeStorageMock({
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c7")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c7", 5, "TX")],
    });
    const results = await getExposedCarriers(resolvedSignal, "org-1", storage);
    assert("Resolved signal returns no exposed carriers", results.length === 0);
  }
}

// ── NBA creation tests ────────────────────────────────────────────────────────

async function testNbaCreation(): Promise<void> {
  console.log("\n── Carrier NBA Creation ──────────────────────────────────────────────");

  const created: any[] = [];

  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [BASE_SIGNAL],
    getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
    getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 10, "TX")],
    getCarrierClaimedLanesByCarrierId: async () => [],
    getCarrierMarketNbaByDedup: async () => undefined,
    upsertCarrierMarketNba: async (data: any) => {
      const nba = { ...data, id: `nba-${created.length}`, createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), lastActionAt: null };
      created.push(nba);
      return nba as any;
    },
  });

  const result = await syncCarrierMarketNbas("org-1", storage);

  assert("syncCarrierMarketNbas returns processed >= 1", result.processed >= 1);
  assert("syncCarrierMarketNbas creates >= 1 NBA", result.created >= 1);
  assert("First NBA has pending status", created[0]?.status === "pending");
  assertEq("First NBA has correct carrierId", created[0]?.carrierId, "c1");
  assertEq("First NBA has correct marketSignalId", created[0]?.marketSignalId, "sig-001");
  assertEq("First NBA has correct recommendationType", created[0]?.recommendationType, CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY);
  assert("First NBA has urgencyScore > 0", (created[0]?.urgencyScore ?? 0) > 0);
  assert("First NBA explanation is an object", typeof created[0]?.explanation === "object");
  assert("First NBA explanation has signalSummary", created[0]?.explanation?.signalSummary != null);
  assert("First NBA explanation has carrierFitSummary", created[0]?.explanation?.carrierFitSummary != null);
  assert("First NBA explanation has prose", typeof created[0]?.explanation?.prose === "string");
}

// ── Dedup tests ───────────────────────────────────────────────────────────────

async function testDedup(): Promise<void> {
  console.log("\n── Carrier NBA Dedup ─────────────────────────────────────────────────");

  // Pending existing row → update, not duplicate
  {
    const updated: any[] = [];
    const existingPending: CarrierMarketNba = {
      id: "nba-existing",
      carrierId: "c1",
      marketSignalId: "sig-001",
      recommendationType: CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY,
      status: "pending",
      urgencyScore: 50,
      explanation: {} as any,
      suppressionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      firstSeenAt: new Date(),
      lastActionAt: null,
    };

    const storage = makeStorageMock({
      getActiveMarketSignals: async () => [BASE_SIGNAL],
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 5, "TX")],
      getCarrierClaimedLanesByCarrierId: async () => [],
      getCarrierMarketNbaByDedup: async () => existingPending,
      upsertCarrierMarketNba: async (data: any) => {
        updated.push(data);
        return { ...data, id: "nba-existing" } as any;
      },
    });

    const result = await syncCarrierMarketNbas("org-1", storage);
    assert("Dedup: pending row triggers update (not new create)", result.updated >= 1);
    assertEq("Dedup: create count is 0 when existing pending", result.created, 0);
  }

  // Completed existing row → skipped (not reopened)
  {
    const upsertsRan: any[] = [];
    const existingCompleted: CarrierMarketNba = {
      id: "nba-completed",
      carrierId: "c1",
      marketSignalId: "sig-001",
      recommendationType: CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY,
      status: "completed",
      urgencyScore: 70,
      explanation: {} as any,
      suppressionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      firstSeenAt: new Date(),
      lastActionAt: new Date(),
    };

    const storage = makeStorageMock({
      getActiveMarketSignals: async () => [BASE_SIGNAL],
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 5, "TX")],
      getCarrierClaimedLanesByCarrierId: async () => [],
      getCarrierMarketNbaByDedup: async () => existingCompleted,
      upsertCarrierMarketNba: async (data: any) => {
        upsertsRan.push(data);
        return { ...data, id: "nba-completed" } as any;
      },
    });

    const result = await syncCarrierMarketNbas("org-1", storage);
    assert("Dedup: completed row is skipped", result.skipped >= 1);
    assertEq("Dedup: neither create nor update for completed", result.created + result.updated, 0);
  }

  // Dismissed existing row → skipped
  {
    const existingDismissed: CarrierMarketNba = {
      id: "nba-dismissed",
      carrierId: "c1",
      marketSignalId: "sig-001",
      recommendationType: CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY,
      status: "dismissed",
      urgencyScore: 40,
      explanation: {} as any,
      suppressionReason: "manual",
      createdAt: new Date(),
      updatedAt: new Date(),
      firstSeenAt: new Date(),
      lastActionAt: new Date(),
    };

    const storage = makeStorageMock({
      getActiveMarketSignals: async () => [BASE_SIGNAL],
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 5, "TX")],
      getCarrierClaimedLanesByCarrierId: async () => [],
      getCarrierMarketNbaByDedup: async () => existingDismissed,
      upsertCarrierMarketNba: async (data: any) => ({ ...data, id: "nba-dismissed" } as any),
    });

    const result = await syncCarrierMarketNbas("org-1", storage);
    assert("Dedup: dismissed row is skipped", result.skipped >= 1);
    assertEq("Dedup: create+update is 0 for dismissed", result.created + result.updated, 0);
  }

  // New signal ID → new NBA even if prior signal had a completed/dismissed NBA
  {
    const created: any[] = [];
    const newSignal: MarketSignal = { ...BASE_SIGNAL, id: "sig-new-002" };

    const storage = makeStorageMock({
      getActiveMarketSignals: async () => [newSignal],
      getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
      getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 5, "TX")],
      getCarrierClaimedLanesByCarrierId: async () => [],
      getCarrierMarketNbaByDedup: async () => undefined, // new signalId → no existing row
      upsertCarrierMarketNba: async (data: any) => {
        const nba = { ...data, id: `nba-${created.length}` };
        created.push(nba);
        return nba as any;
      },
    });

    const result = await syncCarrierMarketNbas("org-1", storage);
    assert("New signal: creates new NBA for the same carrier", result.created >= 1);
    assertEq("New signal: correct new marketSignalId", created[0]?.marketSignalId, "sig-new-002");
  }
}

// ── Explanation structure tests ───────────────────────────────────────────────

async function testExplanationStructure(): Promise<void> {
  console.log("\n── Explanation Structure & Determinism ───────────────────────────────");

  const fit = {
    carrierId: "c1",
    carrierName: "Test Carrier LLC",
    runCount: 5,
    lastRunDate: new Date("2026-03-15"),
    declaredPreference: true,
    equipmentMatch: true,
    fitScore: 80,
  };

  const explanation = buildCarrierNbaExplanation(BASE_SIGNAL, fit, CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY);

  assert("Explanation has signalSummary", explanation.signalSummary != null);
  assertEq("signalSummary.signalId matches", explanation.signalSummary.signalId, "sig-001");
  assertEq("signalSummary.signalType matches", explanation.signalSummary.signalType, "demand_surge");
  assertEq("signalSummary.severity matches", explanation.signalSummary.severity, "high");
  assertEq("signalSummary.scopeKey matches", explanation.signalSummary.scopeKey, "TX");
  assertEq("signalSummary.equipmentType matches", explanation.signalSummary.equipmentType, "dry_van");
  assert("signalSummary.percentChange is a number", typeof explanation.signalSummary.percentChange === "number");
  assert("signalSummary.supportingEventCount >= 0", explanation.signalSummary.supportingEventCount >= 0);

  assert("Explanation has carrierFitSummary", explanation.carrierFitSummary != null);
  assertEq("carrierFitSummary.runCount matches", explanation.carrierFitSummary.runCount, 5);
  assertEq("carrierFitSummary.declaredPreference matches", explanation.carrierFitSummary.declaredPreference, true);
  assertEq("carrierFitSummary.equipmentMatch matches", explanation.carrierFitSummary.equipmentMatch, true);
  assertEq("carrierFitSummary.fitScore matches", explanation.carrierFitSummary.fitScore, 80);

  assert("Explanation has prose string", typeof explanation.prose === "string" && explanation.prose.length > 0);
  assert("Prose contains carrier name", explanation.prose.includes("Test Carrier LLC"));
  assert("Prose contains scope key", explanation.prose.includes("TX"));

  // Determinism: calling twice with same args produces identical output
  const explanation2 = buildCarrierNbaExplanation(BASE_SIGNAL, fit, CARRIER_NBA_TYPES.DEMAND_SURGE_CAPACITY);
  assertEq("Prose is deterministic for fixed input", explanation.prose, explanation2.prose);

  // Imbalance type uses different prose
  const imbalanceExplanation = buildCarrierNbaExplanation(IMBALANCE_SIGNAL, fit, CARRIER_NBA_TYPES.IMBALANCE_OUTREACH);
  assert("Imbalance prose differs from demand surge prose", imbalanceExplanation.prose !== explanation.prose);
  assert("Imbalance prose mentions imbalance context", imbalanceExplanation.prose.toLowerCase().includes("imbalance") || imbalanceExplanation.prose.toLowerCase().includes("capacity"));
}

// ── Scheduler wiring test ─────────────────────────────────────────────────────

async function testSchedulerWiring(): Promise<void> {
  console.log("\n── Scheduler Wiring ──────────────────────────────────────────────────");

  // ── Part 1: syncCarrierMarketNbas return-type contract ──────────────────────
  const mockStorage = makeStorageMock({
    getActiveMarketSignals: async () => [],
  });

  const result = await syncCarrierMarketNbas("test-org", mockStorage);
  assert("syncCarrierMarketNbas returns an object", typeof result === "object");
  assert("result has processed field", "processed" in result);
  assert("result has created field", "created" in result);
  assert("result has updated field", "updated" in result);
  assert("result has skipped field", "skipped" in result);

  // ── Part 2: runEvaluationWithDeps wires evaluateMarketSignals → syncCarrierMarketNbas ──
  // Test the injectable scheduler function with mock collaborators so we can
  // assert the integration without hitting the DB or requiring monkey-patching.
  const { runEvaluationWithDeps } = await import("./marketSignalScheduler.js");

  let evaluateCalled = false;
  let syncCallCount = 0;
  const orgsSeen: string[] = [];

  const mockEvaluate = async () => { evaluateCalled = true; };
  const fakeOrgs = [{ id: "org-sched-1" }, { id: "org-sched-2" }];
  const mockStorageRef: any = { getOrganizations: async () => fakeOrgs };
  const mockCarrierSync = async (orgId: string, _storage: any) => {
    syncCallCount++;
    orgsSeen.push(orgId);
    return { processed: 0, created: 0, updated: 0, skipped: 0 };
  };

  await runEvaluationWithDeps(mockEvaluate, mockStorageRef, mockCarrierSync as any);

  assert("runEvaluationWithDeps calls evaluate (engine.evaluateMarketSignals)", evaluateCalled);
  assert("runEvaluationWithDeps invokes syncCarrierMarketNbas for each org", syncCallCount === fakeOrgs.length);
  assert("org-sched-1 was synced", orgsSeen.includes("org-sched-1"));
  assert("org-sched-2 was synced", orgsSeen.includes("org-sched-2"));
  assert("excluded org prefix is not synced (da3ed822...)", !orgsSeen.includes("da3ed822-demo"));

  // Also verify excluded org filtering
  let filteredSyncCount = 0;
  const orgsWithExcluded = [
    { id: "org-normal" },
    { id: "da3ed822-should-be-excluded" },
  ];
  const filteredStorageRef: any = { getOrganizations: async () => orgsWithExcluded };
  const filteredSync = async (orgId: string, _storage: any) => {
    filteredSyncCount++;
    return { processed: 0, created: 0, updated: 0, skipped: 0 };
  };
  await runEvaluationWithDeps(async () => {}, filteredStorageRef, filteredSync as any);
  assert("excluded org (da3ed822 prefix) is skipped in carrier NBA sync", filteredSyncCount === 1);
}

// ── Migration guard test ──────────────────────────────────────────────────────

async function testMigrationGuards(): Promise<void> {
  console.log("\n── Migration Guards ──────────────────────────────────────────────────");

  // Verify the migration SQL uses IF NOT EXISTS patterns
  const { readFileSync } = await import("fs");
  try {
    const migrationSql = readFileSync("migrations/0003_carrier_market_nbas.sql", "utf-8");
    assert("Migration uses CREATE TABLE IF NOT EXISTS", migrationSql.includes("CREATE TABLE IF NOT EXISTS"));
    assert("Migration creates carrier_market_nbas table", migrationSql.includes("carrier_market_nbas"));
    assert("Migration creates dedup unique index", migrationSql.includes("idx_carrier_market_nbas_dedup"));
    assert("Migration creates signal index", migrationSql.includes("idx_carrier_market_nbas_signal"));
    assert("Migration creates carrier index", migrationSql.includes("idx_carrier_market_nbas_carrier"));
    assert("Migration uses IF NOT EXISTS on indexes", (migrationSql.match(/CREATE.*INDEX IF NOT EXISTS/g) ?? []).length >= 3);
    assert("Migration status check constraint includes all valid statuses",
      migrationSql.includes("pending") && migrationSql.includes("in_progress") &&
      migrationSql.includes("completed") && migrationSql.includes("dismissed"));
  } catch {
    assert("Migration file 0003_carrier_market_nbas.sql exists", false);
  }
}

// ── Imbalance signal type test ────────────────────────────────────────────────

async function testImbalanceSignalType(): Promise<void> {
  console.log("\n── Imbalance Signal Type ─────────────────────────────────────────────");

  const created: any[] = [];
  const storage = makeStorageMock({
    getActiveMarketSignals: async () => [IMBALANCE_SIGNAL],
    getCarriersByOrgForMarketSignal: async () => [makeCarrier("c1")],
    getFinancialRowsForCarrierSignal: async () => [makeHistoryRow("c1", 5, "TX")],
    getCarrierClaimedLanesByCarrierId: async () => [],
    getCarrierMarketNbaByDedup: async () => undefined,
    upsertCarrierMarketNba: async (data: any) => {
      const nba = { ...data, id: `nba-${created.length}` };
      created.push(nba);
      return nba as any;
    },
  });

  const result = await syncCarrierMarketNbas("org-1", storage);
  assert("Imbalance signal creates carrier NBAs", result.created >= 1);
  assertEq("Imbalance NBA uses imbalance_outreach type", created[0]?.recommendationType, CARRIER_NBA_TYPES.IMBALANCE_OUTREACH);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  Carrier Market NBA Service Tests (Task #187)");
  console.log("═══════════════════════════════════════════════════════════════════════");

  await testExposureMatching();
  await testNbaCreation();
  await testDedup();
  await testExplanationStructure();
  await testSchedulerWiring();
  await testMigrationGuards();
  await testImbalanceSignalType();

  console.log(`\n═══════════════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════════════════════════\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
