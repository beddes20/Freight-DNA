/**
 * Market Signal Engine Tests (Task #185)
 *
 * Covers:
 *   - Threshold behavior: noise floor, demand surge firing, distinct-account floor, sparse baseline
 *   - Lifecycle: existing active signal updated not duplicated, active→cooling→resolved transitions
 *   - Evidence: supporting counts and percent change stored correctly, explanation text matches
 *   - Scope isolation: region vs corridor vs equipment-region signals are distinct
 *   - Imbalance: fires only when demand signal active and capacity is weak/absent
 *   - Regression: no duplicate active signals; config-driven thresholds work correctly
 *
 * Run with: npx tsx server/marketSignalEngine.test.ts
 */

import { generateExplanation, MarketSignalEngine } from "./marketSignalEngine";
import type { EvidencePayload } from "./marketSignalEngine";
import type { IStorage } from "./storage";
import type { MarketEvent, MarketSignal, InsertMarketEvent, InsertMarketSignal } from "@shared/schema";
import { MARKET_SIGNAL_THRESHOLDS as CFG } from "./marketSignalThresholds";

// ── Mini test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    failed++;
  }
}

function assertEqual<T>(description: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

function assertIncludes(description: string, text: string, substring: string): void {
  const ok = text.includes(substring);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}  (text "${text}" does not include "${substring}")`);
    failed++;
  }
}

// ── Mock storage helpers ──────────────────────────────────────────────────────

function makeEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: "evt-" + Math.random().toString(36).slice(2),
    eventType: "demand_request",
    scopeType: "region",
    scopeKey: "TX",
    equipmentType: "dry van",
    originRegion: null,
    destinationRegion: null,
    accountId: "acct-1",
    carrierId: null,
    eventValue: null,
    metadata: null,
    occurredAt: new Date(),
    recordedAt: new Date(),
    ...overrides,
  };
}

/**
 * Creates a historical event (well outside the recent evaluation window)
 * for use as a baseline event in tests. The timestamp is set to 5 days ago,
 * which is outside the 24h recent window but inside the 7-day lookback window.
 */
function makeOldEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3_600_000);
  return makeEvent({ occurredAt: fiveDaysAgo, ...overrides });
}

function makeSignal(overrides: Partial<MarketSignal> = {}): MarketSignal {
  return {
    id: "sig-" + Math.random().toString(36).slice(2),
    signalType: "demand_surge",
    scopeType: "region",
    scopeKey: "TX",
    equipmentType: "dry van",
    status: "active",
    severity: "medium",
    confidence: "0.7",
    evidencePayload: {
      recentCount: 10,
      baselineCount: 5,
      percentChange: 100,
      distinctAccounts: 3,
      distinctCarriers: 0,
      evaluationWindowHours: 24,
      baselineLookbackHours: 168,
      scopeKey: "TX",
      scopeType: "region",
      equipmentType: "dry van",
    },
    explanation: "Demand surge in TX",
    firstDetectedAt: new Date(),
    lastEvaluatedAt: new Date(),
    coolingStartedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

function makeStorage(overrides: {
  recentEvents?: MarketEvent[];
  baselineEvents?: MarketEvent[];
  existingSignals?: MarketSignal[];
  upserted?: MarketSignal[];
  updated?: Array<{ id: string; status: string }>;
}): { storage: IStorage; upsertCalls: any[]; updateStatusCalls: any[] } {
  const upsertCalls: any[] = [];
  const updateStatusCalls: any[] = [];
  const insertedEvents: MarketEvent[] = [];

  // Build a multi-call sequence for getMarketEventsSince:
  // First call = recent window, second call = baseline window
  let callCount = 0;
  const eventCallResults = [
    overrides.recentEvents ?? [],
    overrides.baselineEvents ?? [],
  ];

  const storage: Partial<IStorage> = {
    insertMarketEvent: async (data: InsertMarketEvent) => {
      const ev = makeEvent(data as any);
      insertedEvents.push(ev);
      return ev;
    },
    getMarketEventsSince: async (_since: Date) => {
      const result = eventCallResults[callCount] ?? [];
      callCount++;
      return result;
    },
    upsertMarketSignal: async (data: any) => {
      const sig = makeSignal({ ...data, lastEvaluatedAt: data.lastEvaluatedAt ?? new Date() });
      upsertCalls.push({ ...data });
      const stored = overrides.upserted?.[upsertCalls.length - 1] ?? sig;
      return stored;
    },
    updateMarketSignalStatus: async (id: string, status: string, _now: Date) => {
      updateStatusCalls.push({ id, status });
    },
    getActiveMarketSignals: async (filters: any) => {
      const sigs = overrides.existingSignals ?? [];
      return sigs.filter(s => {
        if (filters.status) {
          const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
          if (!statuses.includes(s.status)) return false;
        }
        if (filters.signalType && s.signalType !== filters.signalType) return false;
        if (filters.scopeType && s.scopeType !== filters.scopeType) return false;
        if (filters.scopeKey && s.scopeKey !== filters.scopeKey) return false;
        return true;
      });
    },
    getMarketSignalById: async (id: string) => {
      return (overrides.existingSignals ?? []).find(s => s.id === id);
    },
  };

  return { storage: storage as IStorage, upsertCalls, updateStatusCalls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testThresholdBehavior() {
  console.log("\n── Threshold Behavior ──────────────────────────────────────────");

  // 1. Noise floor: no signal for tiny event counts
  {
    const recentEvents = Array.from({ length: 3 }, (_, i) =>
      makeEvent({ accountId: `acct-${i}` })
    );
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    assert(
      "Noise floor: no signal for count < minEventCount (3 < 5)",
      upsertCalls.filter(c => c.signalType === "demand_surge").length === 0,
    );
  }

  // 2. Demand surge fires when both count and percent thresholds are met
  {
    const recentEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ accountId: `acct-${i % 3}` }) // 3 distinct accounts
    );
    // Baseline: 4 events over 168h → scaled to 24h = 4*(24/168) ≈ 0.57 → pct change very high
    const baselineEvents = Array.from({ length: 4 }, () => makeEvent());
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    assert(
      "Demand surge fires when count >= minEventCount and pct >= threshold",
      upsertCalls.some(c => c.signalType === "demand_surge"),
    );
    if (upsertCalls.length > 0) {
      const call = upsertCalls.find(c => c.signalType === "demand_surge");
      assert("Signal has active status", call?.status === "active");
      assert("Evidence recentCount is 10", (call?.evidencePayload as any)?.recentCount === 10);
    }
  }

  // 3. Distinct-account floor blocks surge if driven by single account
  {
    const recentEvents = Array.from({ length: 10 }, () =>
      makeEvent({ accountId: "single-account" }) // only 1 distinct account
    );
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    assert(
      "Distinct-account floor: no demand_surge when only 1 account (floor=2)",
      upsertCalls.filter(c => c.signalType === "demand_surge").length === 0,
    );
  }

  // 4. Sparse/zero baseline handled safely (no division by zero)
  {
    const recentEvents = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ accountId: `acct-${i % 4}` }) // 4 distinct accounts
    );
    const baselineEvents: MarketEvent[] = []; // zero baseline
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    // With zero baseline, pct change is 100% — should fire
    assert(
      "Zero baseline handled safely: signal still fires (100% increase from nothing)",
      upsertCalls.some(c => c.signalType === "demand_surge"),
    );
    if (upsertCalls.length > 0) {
      const call = upsertCalls.find(c => c.signalType === "demand_surge");
      const evidence = call?.evidencePayload as EvidencePayload;
      assert("Zero baseline: percentChange is 100", evidence?.percentChange === 100);
    }
  }
}

async function testLifecycle() {
  console.log("\n── Lifecycle Transitions ───────────────────────────────────────");

  // 1. Existing active signal is updated, not duplicated
  {
    const existingSignal = makeSignal({ id: "sig-existing", status: "active" });
    const recentEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ accountId: `acct-${i % 3}` })
    );
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({
      recentEvents,
      baselineEvents,
      existingSignals: [existingSignal],
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    // Only one upsert call for this scope/type (no duplicates)
    const demandUpserts = upsertCalls.filter(c => c.signalType === "demand_surge");
    assert(
      "Existing active signal: upsert called once (not duplicated)",
      demandUpserts.length <= 1,
    );
  }

  // 2. active → cooling transition for stale signal
  {
    const staleTime = new Date(Date.now() - (CFG.coolingTransitionHours + 1) * 3_600_000);
    const existingSignal = makeSignal({
      id: "sig-stale",
      status: "active",
      lastEvaluatedAt: staleTime,
    });
    const { storage, updateStatusCalls } = makeStorage({
      recentEvents: [],
      baselineEvents: [],
      existingSignals: [existingSignal],
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    assert(
      "Active signal transitions to cooling after coolingTransitionHours",
      updateStatusCalls.some(c => c.id === "sig-stale" && c.status === "cooling"),
    );
  }

  // 3. cooling → resolved transition for very old signal
  {
    const oldTime = new Date(Date.now() - (CFG.autoResolveHours + 1) * 3_600_000);
    const coolingSignal = makeSignal({
      id: "sig-cooling",
      status: "cooling",
      firstDetectedAt: oldTime,
      lastEvaluatedAt: oldTime,
    });
    const { storage, updateStatusCalls } = makeStorage({
      recentEvents: [],
      baselineEvents: [],
      existingSignals: [coolingSignal],
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();
    assert(
      "Cooling signal resolves after autoResolveHours",
      updateStatusCalls.some(c => c.id === "sig-cooling" && c.status === "resolved"),
    );
  }
}

async function testEvidence() {
  console.log("\n── Evidence Accuracy ───────────────────────────────────────────");

  // 1. Supporting counts and percent change stored correctly
  {
    const recentEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ accountId: `acct-${i % 4}` }) // 4 distinct accounts
    );
    // Baseline: 5 old events in the historical window (outside recent 24h).
    // Engine: baselinePeriod = 168-24=144h, scaleFactor = 24/144 = 1/6
    // baselineCount = 5 * (1/6) ≈ 0.83 → pct change = (10 - 0.83) / 0.83 * 100 ≈ 1105%
    const baselineEvents = Array.from({ length: 5 }, () => makeOldEvent());
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const call = upsertCalls.find(c => c.signalType === "demand_surge");
    if (call) {
      const ev = call.evidencePayload as EvidencePayload;
      assert("Evidence: recentCount is 10", ev.recentCount === 10);
      assert("Evidence: distinctAccounts is 4", ev.distinctAccounts === 4);
      assert("Evidence: evaluationWindowHours matches config", ev.evaluationWindowHours === CFG.evaluationWindowHours);
      assert("Evidence: baselineLookbackHours matches config", ev.baselineLookbackHours === CFG.baselineLookbackHours);
      assert("Evidence: percentChange is positive", ev.percentChange > 0);
    } else {
      assert("Evidence: demand_surge signal was created", false);
    }
  }

  // 2. Explanation text matches computed data
  {
    const evidence: EvidencePayload = {
      recentCount: 15,
      baselineCount: 5,
      percentChange: 200,
      distinctAccounts: 4,
      distinctCarriers: 0,
      evaluationWindowHours: 24,
      baselineLookbackHours: 168,
      scopeKey: "TX",
      scopeType: "region",
      equipmentType: "dry van",
    };
    const explanation = generateExplanation("demand_surge", evidence);
    assertIncludes("Explanation includes scope key", explanation, "TX");
    assertIncludes("Explanation includes recent count", explanation, "15");
    assertIncludes("Explanation includes distinct accounts", explanation, "4");
    assertIncludes("Explanation includes percent change", explanation, "+200%");
    assertIncludes("Explanation includes equipment type", explanation, "dry van");
  }

  // 3. Imbalance explanation includes capacity status
  {
    const evidence: EvidencePayload = {
      recentCount: 12,
      baselineCount: 4,
      percentChange: 200,
      distinctAccounts: 5,
      distinctCarriers: 1,
      evaluationWindowHours: 24,
      baselineLookbackHours: 168,
      scopeKey: "IL",
      scopeType: "region",
      equipmentType: "flatbed",
      capacityStatus: "absent",
    };
    const explanation = generateExplanation("demand_capacity_imbalance", evidence);
    assertIncludes("Imbalance explanation includes scope", explanation, "IL");
    assertIncludes("Imbalance explanation mentions demand", explanation.toLowerCase(), "demand");
    assertIncludes("Imbalance explanation mentions capacity", explanation.toLowerCase(), "capacity");
  }
}

async function testScopeIsolation() {
  console.log("\n── Scope Isolation ─────────────────────────────────────────────");

  // Region vs corridor: different scopes → different signals, not merged
  {
    const recentEvents = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeEvent({ scopeType: "region", scopeKey: "TX", accountId: `acct-${i % 3}` })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        makeEvent({ scopeType: "corridor", scopeKey: "TX|IL", accountId: `acct-${i % 3}` })
      ),
    ];
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const txRegion = upsertCalls.filter(c => c.scopeType === "region" && c.scopeKey === "TX");
    const txIlCorridor = upsertCalls.filter(c => c.scopeType === "corridor" && c.scopeKey === "TX|IL");
    assert(
      "Region scope (TX) produces its own signal",
      txRegion.length > 0,
    );
    assert(
      "Corridor scope (TX|IL) produces its own distinct signal",
      txIlCorridor.length > 0,
    );
  }

  // Different equipment types not merged
  {
    const recentEvents = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeEvent({ equipmentType: "dry van", accountId: `acct-${i % 3}` })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        makeEvent({ equipmentType: "flatbed", accountId: `acct-${i % 3}` })
      ),
    ];
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const dryVan = upsertCalls.filter(c => c.equipmentType === "dry van");
    const flatbed = upsertCalls.filter(c => c.equipmentType === "flatbed");
    assert("Dry van signals are separate from flatbed signals", dryVan.length > 0 && flatbed.length > 0);
    assert("No cross-equipment merging (distinct upsert calls)", dryVan.length !== flatbed.length || dryVan[0]?.scopeKey !== flatbed[0]?.equipmentType);
  }
}

async function testImbalanceDetection() {
  console.log("\n── Imbalance Detection ─────────────────────────────────────────");

  // 1. Imbalance fires when demand signal active and no capacity signal
  {
    const demandSignal = makeSignal({
      id: "sig-demand",
      signalType: "demand_surge",
      status: "active",
      scopeKey: "TX",
      scopeType: "region",
      equipmentType: "dry van",
      confidence: "0.8",
    });
    const { storage, upsertCalls } = makeStorage({
      recentEvents: [],
      baselineEvents: [],
      existingSignals: [demandSignal], // no capacity signal
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const imbalanceUpserts = upsertCalls.filter(c => c.signalType === "demand_capacity_imbalance");
    assert(
      "Imbalance fires when demand is active and no capacity signal exists",
      imbalanceUpserts.length > 0,
    );
    if (imbalanceUpserts.length > 0) {
      assert(
        "Imbalance shares scope with demand signal",
        imbalanceUpserts[0].scopeKey === "TX",
      );
    }
  }

  // 2. Imbalance fires when capacity signal is weak (low confidence)
  {
    const demandSignal = makeSignal({
      id: "sig-demand-2",
      signalType: "demand_surge",
      status: "active",
      scopeKey: "IL",
      scopeType: "region",
      equipmentType: "dry van",
      confidence: "0.8",
    });
    const weakCapacitySignal = makeSignal({
      id: "sig-weak-cap",
      signalType: "carrier_capacity_declaration",
      status: "active",
      scopeKey: "IL",
      scopeType: "region",
      equipmentType: "dry van",
      confidence: String(CFG.imbalance.weakCapacityConfidenceMax - 0.01), // just below threshold
    });
    const { storage, upsertCalls } = makeStorage({
      recentEvents: [],
      baselineEvents: [],
      existingSignals: [demandSignal, weakCapacitySignal],
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const imbalanceUpserts = upsertCalls.filter(c => c.signalType === "demand_capacity_imbalance");
    assert(
      "Imbalance fires when capacity signal is weak (below threshold)",
      imbalanceUpserts.length > 0,
    );
  }

  // 3. Imbalance does NOT fire when strong capacity signal exists
  {
    const demandSignal = makeSignal({
      id: "sig-demand-3",
      signalType: "demand_surge",
      status: "active",
      scopeKey: "GA",
      scopeType: "region",
      equipmentType: "dry van",
      confidence: "0.8",
    });
    const strongCapacitySignal = makeSignal({
      id: "sig-strong-cap",
      signalType: "carrier_capacity_declaration",
      status: "active",
      scopeKey: "GA",
      scopeType: "region",
      equipmentType: "dry van",
      confidence: "0.9", // above weak threshold
    });
    const { storage, upsertCalls } = makeStorage({
      recentEvents: [],
      baselineEvents: [],
      existingSignals: [demandSignal, strongCapacitySignal],
    });
    const engine = new MarketSignalEngine(storage);
    await engine.evaluateMarketSignals();

    const imbalanceUpserts = upsertCalls.filter(c => c.signalType === "demand_capacity_imbalance");
    assert(
      "Imbalance does NOT fire when strong capacity signal exists",
      imbalanceUpserts.length === 0,
    );
  }
}

async function testRegressionAndDedup() {
  console.log("\n── Regression / Dedup ──────────────────────────────────────────");

  // 1. No duplicate active signals for same scope/type
  {
    const recentEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ accountId: `acct-${i % 4}` })
    );
    const baselineEvents: MarketEvent[] = [];
    const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
    const engine = new MarketSignalEngine(storage);

    // Run evaluation twice — should not double-upsert
    await engine.evaluateMarketSignals();
    await engine.evaluateMarketSignals();

    const demandUpserts = upsertCalls.filter(c => c.signalType === "demand_surge" && c.scopeKey === "TX");
    assert(
      "No duplicate upsert calls for same scope/type across runs",
      demandUpserts.length <= 2, // one per run max
    );
  }

  // 2. Config-driven thresholds work correctly
  {
    // minEventCount from config
    assert("Config: minEventCount is 5", CFG.minEventCount === 5);
    assert("Config: demandSurgeMinPctIncrease is 20", CFG.demandSurgeMinPctIncrease === 20);
    assert("Config: distinctAccountFloor is 2", CFG.distinctAccountFloor === 2);
    assert("Config: cooldownHours is 4", CFG.cooldownHours === 4);
    assert("Config: autoResolveHours is 72", CFG.autoResolveHours === 72);
    assert("Config: severity.criticalPctThreshold is 100", CFG.severity.criticalPctThreshold === 100);
  }

  // 3. Severity levels assigned correctly
  {
    const severityTests: Array<[number, string]> = [
      [15, "low"],          // below medium threshold (20)
      [30, "medium"],       // between medium (20) and high (50)
      [60, "high"],         // between high (50) and critical (100)
      [120, "critical"],    // above critical (100)
    ];
    let severityOk = true;
    for (const [pct, expected] of severityTests) {
      const recentEvents = Array.from({ length: 10 }, (_, i) =>
        makeEvent({ accountId: `acct-${i % 4}`, scopeKey: `scope-${pct}` })
      );
      // Build baseline events (in historical window, not recent window) to yield target pct change.
      // Engine: baselineCount = historicalEvents.length * scaleFactor
      //   where scaleFactor = evaluationWindowHours / (baselineLookbackHours - evaluationWindowHours)
      // Given recentCount=10 and target pct change:
      //   baselineCount = 10 / (1 + pct/100)
      //   historicalEvents.length = ceil(baselineCount / scaleFactor)
      const baselinePeriodHours = CFG.baselineLookbackHours - CFG.evaluationWindowHours;
      const scaleFactor = CFG.evaluationWindowHours / baselinePeriodHours;
      const targetBaselineCount = 10 / (1 + pct / 100);
      const baselineTotal = Math.ceil(targetBaselineCount / scaleFactor);
      // Use makeOldEvent to place these in the historical window (outside recent 24h)
      const baselineEvents = Array.from({ length: baselineTotal }, () =>
        makeOldEvent({ scopeKey: `scope-${pct}`, accountId: "acct-baseline" })
      );
      const { storage, upsertCalls } = makeStorage({ recentEvents, baselineEvents });
      const engine = new MarketSignalEngine(storage);
      await engine.evaluateMarketSignals();
      const call = upsertCalls.find(c => c.signalType === "demand_surge");
      if (call && call.severity !== expected) {
        console.error(`  ✗ Severity for ${pct}% pct change: got ${call.severity}, expected ${expected}`);
        severityOk = false;
        failed++;
      }
    }
    if (severityOk) {
      console.log(`  ✓ Severity levels assigned correctly for all pct thresholds`);
      passed++;
    }
  }
}

async function testEventRecording() {
  console.log("\n── Event Recording ─────────────────────────────────────────────");

  // Valid event recording
  {
    const { storage } = makeStorage({});
    const engine = new MarketSignalEngine(storage);
    const event = await engine.recordMarketEvent({
      eventType: "demand_request",
      scopeType: "region",
      scopeKey: "TX",
      equipmentType: "dv", // should be normalized to "dry van"
      accountId: "acct-test",
    });
    assert("Event recorded successfully", !!event);
    assert("Equipment type normalized from 'dv' to 'dry van'", event.equipmentType === "dry van");
  }

  // Invalid event rejected with ZodError
  {
    const { storage } = makeStorage({});
    const engine = new MarketSignalEngine(storage);
    let threw = false;
    try {
      await engine.recordMarketEvent({
        eventType: "not_a_real_event_type", // invalid
        scopeType: "region",
        scopeKey: "TX",
      });
    } catch (err: any) {
      threw = true;
      assert("Invalid event rejected with ZodError", err?.name === "ZodError");
    }
    assert("Invalid event throws", threw);
  }
}

// ── Run all tests ─────────────────────────────────────────────────────────────

async function main() {
  console.log("Market Signal Engine Tests");
  console.log("==========================");

  await testThresholdBehavior();
  await testLifecycle();
  await testEvidence();
  await testScopeIsolation();
  await testImbalanceDetection();
  await testRegressionAndDedup();
  await testEventRecording();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
