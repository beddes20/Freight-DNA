/**
 * Tests for the Growth Score reweight (Task #156)
 *
 * Covers:
 *   - businessDaysBetween worked examples from the spec
 *   - businessDaysAgo wrapper
 *   - BD recency point assignment via actual computeGrowthScore
 *   - Mutual exclusivity of the two stale-touch penalties via actual computeGrowthScore
 *   - NBA rule R2/R3/R12 firing on business-day thresholds via actual computeNextBestAction
 *
 * Run with:  npx tsx server/growthScore.test.ts
 */

import { businessDaysBetween, businessDaysAgo, computeGrowthScore } from "./growthScoreCalculator";
import { computeNextBestAction } from "./nextBestActionEngine";
import type { IStorage } from "./storage";

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
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

// ── Mock storage builder ──────────────────────────────────────────────────────

function makeMockStorage(overrides: Partial<IStorage> = {}): IStorage {
  const base: Partial<IStorage> = {
    getCompany: async () => ({ id: "c1", name: "Acme", organizationId: "o1", financialAlias: null, shippingModes: [] } as any),
    getTouchpointsByCompany: async () => [],
    getContactsByCompany: async () => [],
    getLaneAttributionsByCompany: async () => [],
    getTasksByCompany: async () => [],
    getRfps: async () => [],
    getFinancialUploadsForOrg: async () => [],
    getGrowthScore: async () => null,
  };
  return { ...base, ...overrides } as IStorage;
}

function makeTouchpoint(date: string, opts: { isMeaningful?: boolean; contactId?: string } = {}): any {
  return { id: `tp-${date}`, date, companyId: "c1", isMeaningful: opts.isMeaningful ?? false, contactId: opts.contactId ?? null };
}

// ── 1. businessDaysBetween worked examples ───────────────────────────────────

console.log("\n1. businessDaysBetween");

assertEqual("same Monday → same Monday = 0",          businessDaysBetween("2026-04-06", "2026-04-06"), 0);
assertEqual("Mon (Apr 6) → Mon (Apr 13) = 5",         businessDaysBetween("2026-04-06", "2026-04-13"), 5);
assertEqual("Fri (Apr 10) → Mon (Apr 13) = 1",        businessDaysBetween("2026-04-10", "2026-04-13"), 1);
assertEqual("Thu (Apr 9) → Mon (Apr 13) = 2",         businessDaysBetween("2026-04-09", "2026-04-13"), 2);
assertEqual("Wed (Apr 8) → Mon (Apr 13) = 3",         businessDaysBetween("2026-04-08", "2026-04-13"), 3);
assertEqual("Tue (Apr 7) → Mon (Apr 13) = 4",         businessDaysBetween("2026-04-07", "2026-04-13"), 4);
assertEqual("Fri (Apr 10) → Fri (Apr 17) = 5",        businessDaysBetween("2026-04-10", "2026-04-17"), 5);
assertEqual("to before from = 0",                     businessDaysBetween("2026-04-13", "2026-04-06"), 0);

// ── 2. businessDaysAgo wrapper ────────────────────────────────────────────────

console.log("\n2. businessDaysAgo");

const TODAY = "2026-04-13"; // Monday

assertEqual("touch today → 0 BD ago",                 businessDaysAgo("2026-04-13", TODAY), 0);
assertEqual("touch Fri (Apr 10) → 1 BD ago",          businessDaysAgo("2026-04-10", TODAY), 1);
assertEqual("touch Thu (Apr 9) → 2 BD ago",           businessDaysAgo("2026-04-09", TODAY), 2);
assertEqual("touch Wed (Apr 8) → 3 BD ago",           businessDaysAgo("2026-04-08", TODAY), 3);
assertEqual("touch Tue (Apr 7) → 4 BD ago",           businessDaysAgo("2026-04-07", TODAY), 4);
assertEqual("touch Mon (Apr 6) → 5 BD ago",           businessDaysAgo("2026-04-06", TODAY), 5);

// ── 3. BD Recency points via computeGrowthScore ───────────────────────────────
// We use a fixed "today" by setting the touch to a specific date offset from now.
// Since computeGrowthScore uses `new Date()` internally, we use real offsets.

console.log("\n3. BD recency points (via computeGrowthScore)");

async function recencyPtsForBD(bdAgo: number): Promise<number> {
  const now = new Date();
  // Find a date that is exactly bdAgo business days ago from today
  const date = new Date(now);
  let counted = 0;
  while (counted < bdAgo) {
    date.setDate(date.getDate() - 1);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) counted++;
  }
  if (bdAgo === 0) {
    // today exactly
    date.setTime(now.getTime());
  }
  const dateStr = date.toISOString().slice(0, 10);
  const storage = makeMockStorage({
    getTouchpointsByCompany: async () => [makeTouchpoint(dateStr)],
  });
  const result = await computeGrowthScore("c1", "o1", storage);
  // Find recency driver
  const recencyDriver = result.drivers.find(d =>
    d.label.includes("today") || d.label.includes("business day")
  );
  if (recencyDriver) return recencyDriver.points;
  // If not in top-5 drivers, infer from total score - other known components
  // (0 freq, 0 meaningful, 0 rel, 0 volume baseline 3, 0 lane, 0 rfp, trendPts)
  // For simple check: just check that the appropriate points are in the scoring
  return result.score; // fallback for assertions that check range
}

// Test specific recency point values using score comparison
(async () => {

  // 0 BD ago → 28 recency pts  
  const today = new Date().toISOString().slice(0, 10);
  const storage0 = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(today)] });
  const r0 = await computeGrowthScore("c1", "o1", storage0);
  const recency0Driver = r0.drivers.find(d => d.label.includes("today"));
  assert("0 BD ago → 28 recency pts driver present", recency0Driver?.points === 28);

  // 1 BD ago (last business day) → 22 recency pts
  const oneBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 1) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const storage1 = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(oneBDDate)] });
  const r1 = await computeGrowthScore("c1", "o1", storage1);
  const recency1Driver = r1.drivers.find(d => d.label.includes("1 business day ago"));
  assert("1 BD ago → 22 recency pts driver present", recency1Driver?.points === 22);

  // 2 BD ago → 12 recency pts
  const twoBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 2) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const storage2 = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(twoBDDate)] });
  const r2 = await computeGrowthScore("c1", "o1", storage2);
  const recency2Driver = r2.drivers.find(d => d.label.includes("2 business days ago"));
  assert("2 BD ago → 12 recency pts driver present", recency2Driver?.points === 12);

  // 3 BD ago → 4 recency pts
  const threeBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 3) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const storage3 = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(threeBDDate)] });
  const r3 = await computeGrowthScore("c1", "o1", storage3);
  const recency3Driver = r3.drivers.find(d => d.label.includes("3 business days ago"));
  assert("3 BD ago → 4 recency pts driver present", recency3Driver?.points === 4);

  // 4+ BD ago → 0 recency pts (no recency driver)
  const fourBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 4) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const storage4 = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(fourBDDate)] });
  const r4 = await computeGrowthScore("c1", "o1", storage4);
  // At 4 BD gap: no positive recency driver (label patterns: "today" or "X business day(s) ago")
  const positiveRecency4 = r4.drivers.find(d =>
    d.positive && (d.label.includes("today") || d.label.includes("business day ago") || d.label.includes("business days ago"))
  );
  assert("4 BD ago → 0 recency pts (no positive recency driver)", !positiveRecency4);

  // ── 4. Stale-touch penalty mutual exclusivity ───────────────────────────────

  console.log("\n4. Stale-touch penalty mutual exclusivity (via computeGrowthScore)");

  // 2 BDs → no stale penalty
  const twoBDSt = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(twoBDDate)] });
  const rSt2 = await computeGrowthScore("c1", "o1", twoBDSt);
  const penaltyDriver2 = rSt2.drivers.find(d => d.label.includes("business days") && d.points < 0);
  assert("2 BD since touch → no stale penalty driver", !penaltyDriver2);

  // 3 BDs → −4 penalty (light)
  const threeBDSt = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(threeBDDate)] });
  const rSt3 = await computeGrowthScore("c1", "o1", threeBDSt);
  const penaltyDriver3 = rSt3.drivers.find(d => d.label.includes("business days") && d.points < 0);
  assert("3 BD since touch → −4 stale penalty", penaltyDriver3?.points === -4);

  // 7 BDs → −10 penalty (heavy, not −14)
  const sevenBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 7) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const sevenBDSt = makeMockStorage({ getTouchpointsByCompany: async () => [makeTouchpoint(sevenBDDate)] });
  const rSt7 = await computeGrowthScore("c1", "o1", sevenBDSt);
  const penaltyDriver7 = rSt7.drivers.find(d => d.label.includes("business days") && d.points < 0);
  assert("7 BD since touch → −10 stale penalty (heavy)",     penaltyDriver7?.points === -10);
  assert("7 BD since touch → not double-penalized (not -4)", penaltyDriver7?.points !== -4);
  const penaltyDrivers7 = rSt7.drivers.filter(d => d.label.includes("business days") && d.points < 0);
  assert("7 BD since touch → exactly one stale-touch penalty driver", penaltyDrivers7.length === 1);

  // never touched → −10 penalty
  const storageNever = makeMockStorage({ getTouchpointsByCompany: async () => [] });
  const rNever = await computeGrowthScore("c1", "o1", storageNever);
  const neverPenalty = rNever.drivers.find(d => d.label === "Never contacted");
  assert("Never touched → Never contacted −10 driver", neverPenalty?.points === -10);

  // ── 5. NBA rule R2/R3/R12 fire on business-day thresholds ──────────────────

  console.log("\n5. NBA rule threshold logic (via computeNextBestAction)");

  // Base NBA storage (no growth score history)
  function makeNbaStorage(touchDates: string[], band?: string): IStorage {
    return makeMockStorage({
      getTouchpointsByCompany: async () => touchDates.map(d => makeTouchpoint(d)),
      getGrowthScore: async () => band ? {
        id: "g1", companyId: "c1", score: band === "at_risk" ? 10 : 60,
        band: band as any, bandLabel: band, bandColor: "red",
        previousScore: null, previousBand: null, calculatedAt: today
      } : null,
    });
  }

  // R2: never touched → R2
  const nbaR2Never = await computeNextBestAction("c1", "o1", makeNbaStorage([]));
  assert("R2 fires when never touched",            nbaR2Never.ruleId === "R2");

  // R2: 7+ BDs since touch → R2
  const sevenBDNba = makeNbaStorage([sevenBDDate]);
  const nbaR2_7 = await computeNextBestAction("c1", "o1", sevenBDNba);
  assert("R2 fires at 7 BD gap",                  nbaR2_7.ruleId === "R2");

  // R2 does NOT fire at 1 BD gap
  const nbaR2_1 = await computeNextBestAction("c1", "o1", makeNbaStorage([oneBDDate]));
  assert("R2 does NOT fire at 1 BD gap",           nbaR2_1.ruleId !== "R2");

  // R3: at_risk + 5 BD gap
  const fiveBDDate = (() => {
    const d = new Date(); let count = 0;
    while (count < 5) { d.setDate(d.getDate() - 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++; }
    return d.toISOString().slice(0, 10);
  })();
  const nbaR3 = await computeNextBestAction("c1", "o1", makeNbaStorage([fiveBDDate], "at_risk"));
  assert("R3 fires: at_risk + 5 BD gap",           nbaR3.ruleId === "R3");

  // R3 does NOT fire: at_risk + 4 BD gap (fires R12 or below)
  const nbaR3_4 = await computeNextBestAction("c1", "o1", makeNbaStorage([fourBDDate], "at_risk"));
  assert("R3 does NOT fire: at_risk + 4 BD gap",   nbaR3_4.ruleId !== "R3");

  // R12: 3 BD gap (no band match for R3) → R12 fires
  const nbaR12_3 = await computeNextBestAction("c1", "o1", makeNbaStorage([threeBDDate]));
  assert("R12 fires at 3 BD gap (no at_risk band)", nbaR12_3.ruleId === "R12");

  // R12 does NOT fire at 2 BD gap (should get R13 on a pristine account)
  const nbaR12_2 = await computeNextBestAction("c1", "o1", makeNbaStorage([twoBDDate]));
  assert("R12 does NOT fire at 2 BD gap",           nbaR12_2.ruleId !== "R12");

  // R13: today's touch, no issues → R13
  const nbaR13 = await computeNextBestAction("c1", "o1", makeNbaStorage([today]));
  assert("R13 fires when all signals clear (touch today)", nbaR13.ruleId === "R13");

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
})();
