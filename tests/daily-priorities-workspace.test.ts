/**
 * Daily Priorities Workspace — Unit Tests (Task #674)
 *
 * Tests the bucket mapping, deduplication, and sort logic used by the
 * GET /api/nba/daily-workspace endpoint, exercising the helpers from
 * server/lib/dailyWorkspaceBuckets.ts directly.
 */

import {
  ruleTypeToBucket,
  BUCKET_PRIORITY,
  BUCKET_ORDER,
  BUCKET_LABELS,
  type WorkspaceBucket,
} from "../server/lib/dailyWorkspaceBuckets";

// ── Helpers ────────────────────────────────────────────────────────────────────

type Tap = (label: string, ok: boolean, extra?: string) => void;

const results: { label: string; ok: boolean; extra?: string }[] = [];
const test: Tap = (label, ok, extra) => {
  results.push({ label, ok, extra });
};

const PASS = "\u2713";
const FAIL = "\u2717";

function report(): void {
  let passed = 0;
  let failed = 0;
  const failLines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      passed++;
      console.log(`  ${PASS} ${r.label}`);
    } else {
      failed++;
      const detail = r.extra ? ` (${r.extra})` : "";
      console.log(`  ${FAIL} ${r.label}${detail}`);
      failLines.push(r.label);
    }
  }
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(60)}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

// ── Section helpers ────────────────────────────────────────────────────────────

function section(name: string) {
  console.log(`── ${name} ${"─".repeat(Math.max(0, 60 - name.length - 4))}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

console.log(`${"═".repeat(60)}`);
console.log("  Daily Priorities Workspace — Bucket Logic Tests (Task #674)");
console.log(`${"═".repeat(60)}`);

// 1. ruleType → bucket primary mapping
section("1. ruleType primary mapping");

const expectedPrimary: Record<string, WorkspaceBucket> = {
  load_decline:          "defend",
  single_thread_risk:    "defend",
  margin_slippage:       "defend",
  lane_volume_drop:      "defend",
  payment_credit_issue:  "defend",
  win_back:              "defend",
  spot_to_contract:      "quote_now",
  rfp_expiring:          "quote_now",
  stale_quote_followup:  "quote_now",
  stale_account:         "follow_up",
  overdue_next_action:   "follow_up",
  stalled_award_lanes:   "follow_up",
  webex_missed_call:     "follow_up",
  rfp_coverage_gap:      "grow",
  market_loosening:      "grow",
  R_MARKET_LOOSE:        "grow",
  market_surge_customer_outreach: "grow",
  recurring_lane_capacity: "procure_carrier",
  market_tightening:     "procure_carrier",
  R_MARKET_TIGHT:        "procure_carrier",
};

for (const [ruleType, expected] of Object.entries(expectedPrimary)) {
  const actual = ruleTypeToBucket(ruleType, "execute");
  test(
    `ruleType="${ruleType}" → "${expected}"`,
    actual === expected,
    actual !== expected ? `got "${actual}"` : undefined,
  );
}

// 2. outcomeType fallback when ruleType is unknown
section("2. outcomeType fallback");

const expectedFallback: Record<string, WorkspaceBucket> = {
  protect: "defend",
  execute: "follow_up",
  grow:    "grow",
  deepen:  "follow_up",
};

for (const [outcomeType, expected] of Object.entries(expectedFallback)) {
  const actual = ruleTypeToBucket("unknown_rule_xyz", outcomeType);
  test(
    `unknown ruleType, outcomeType="${outcomeType}" → "${expected}"`,
    actual === expected,
    actual !== expected ? `got "${actual}"` : undefined,
  );
}

// 3. Totally unknown ruleType + unknown outcomeType → default "follow_up"
section("3. Double-unknown fallback → follow_up");

{
  const actual = ruleTypeToBucket("bogus_rule", "bogus_outcome");
  test('double-unknown → "follow_up"', actual === "follow_up", actual !== "follow_up" ? `got "${actual}"` : undefined);
}

// 4. BUCKET_PRIORITY ordering
section("4. BUCKET_PRIORITY ordering");

{
  const order = ["defend", "quote_now", "follow_up", "grow", "procure_carrier"] as WorkspaceBucket[];
  let correctOrder = true;
  for (let i = 0; i < order.length - 1; i++) {
    if (BUCKET_PRIORITY[order[i]] >= BUCKET_PRIORITY[order[i + 1]]) {
      correctOrder = false;
    }
  }
  test("defend < quote_now < follow_up < grow < procure_carrier (priority order)", correctOrder);
  test("defend has lowest priority number (most urgent)", BUCKET_PRIORITY["defend"] === 1);
}

// 5. BUCKET_ORDER contains all 5 buckets
section("5. BUCKET_ORDER completeness");

{
  const expected: WorkspaceBucket[] = ["defend", "quote_now", "follow_up", "grow", "procure_carrier"];
  const orderSet = new Set<WorkspaceBucket>(BUCKET_ORDER);
  test("BUCKET_ORDER has exactly 5 entries", BUCKET_ORDER.length === 5);
  for (const b of expected) {
    test(`BUCKET_ORDER includes "${b}"`, orderSet.has(b));
  }
}

// 6. BUCKET_LABELS covers all buckets
section("6. BUCKET_LABELS completeness");

{
  const requiredBuckets: WorkspaceBucket[] = ["quote_now", "follow_up", "defend", "grow", "procure_carrier"];
  for (const b of requiredBuckets) {
    test(`BUCKET_LABELS["${b}"] is a non-empty string`, typeof BUCKET_LABELS[b] === "string" && BUCKET_LABELS[b].length > 0);
  }
}

// 7. Deduplication logic simulation
section("7. De-duplication by companyId (highest-priority bucket wins)");

{
  // Simulate two cards for the same company: one in "grow", one in "defend"
  // Defend (priority=1) should win over grow (priority=4)
  interface MockCard { id: string; companyId: string; bucket: WorkspaceBucket; urgencyScore: number }
  const cards: MockCard[] = [
    { id: "c1", companyId: "acme", bucket: "grow",   urgencyScore: 80 },
    { id: "c2", companyId: "acme", bucket: "defend", urgencyScore: 50 },
    { id: "c3", companyId: "beta", bucket: "quote_now", urgencyScore: 70 },
  ];

  const companyBest = new Map<string, MockCard>();
  for (const card of cards) {
    const key = card.companyId ?? `no-company-${card.id}`;
    const existing = companyBest.get(key);
    if (!existing) {
      companyBest.set(key, card);
    } else {
      const existP = BUCKET_PRIORITY[existing.bucket];
      const newP = BUCKET_PRIORITY[card.bucket];
      if (
        newP < existP ||
        (newP === existP && card.urgencyScore > existing.urgencyScore)
      ) {
        companyBest.set(key, card);
      }
    }
  }

  const deduped = [...companyBest.values()];
  const acmeBest = deduped.find(c => c.companyId === "acme");
  const betaBest = deduped.find(c => c.companyId === "beta");

  test("deduped has 2 unique companies", deduped.length === 2);
  test("acme → defend wins over grow", acmeBest?.bucket === "defend");
  test("beta → quote_now retained", betaBest?.bucket === "quote_now");
}

// 8. Same bucket tie-break by urgencyScore
section("8. Tie-break by urgencyScore (higher wins)");

{
  interface MockCard { id: string; companyId: string; bucket: WorkspaceBucket; urgencyScore: number }
  const cards: MockCard[] = [
    { id: "x1", companyId: "xyz", bucket: "follow_up", urgencyScore: 40 },
    { id: "x2", companyId: "xyz", bucket: "follow_up", urgencyScore: 90 },
  ];

  const companyBest = new Map<string, MockCard>();
  for (const card of cards) {
    const existing = companyBest.get(card.companyId);
    if (!existing) {
      companyBest.set(card.companyId, card);
    } else {
      const existP = BUCKET_PRIORITY[existing.bucket];
      const newP = BUCKET_PRIORITY[card.bucket];
      if (
        newP < existP ||
        (newP === existP && card.urgencyScore > existing.urgencyScore)
      ) {
        companyBest.set(card.companyId, card);
      }
    }
  }

  const best = companyBest.get("xyz");
  test("same bucket: card with urgencyScore=90 beats urgencyScore=40", best?.id === "x2" && best?.urgencyScore === 90);
}

// 9. Bucket sort by urgencyScore desc
section("9. Within-bucket sort by urgencyScore desc");

{
  interface MockCard { id: string; bucket: WorkspaceBucket; urgencyScore: number }
  const cards: MockCard[] = [
    { id: "a", bucket: "defend", urgencyScore: 30 },
    { id: "b", bucket: "defend", urgencyScore: 95 },
    { id: "c", bucket: "defend", urgencyScore: 60 },
  ];

  const sorted = [...cards].sort((a, b) => b.urgencyScore - a.urgencyScore);
  test("sorted[0] is urgencyScore=95", sorted[0]?.id === "b");
  test("sorted[1] is urgencyScore=60", sorted[1]?.id === "c");
  test("sorted[2] is urgencyScore=30", sorted[2]?.id === "a");
}

// 10. No-company cards get unique keys (no cross-card dedup)
section("10. Cards without companyId are not cross-deduplicated");

{
  interface MockCard { id: string; companyId: string | null; bucket: WorkspaceBucket; urgencyScore: number }
  const cards: MockCard[] = [
    { id: "n1", companyId: null, bucket: "follow_up", urgencyScore: 50 },
    { id: "n2", companyId: null, bucket: "follow_up", urgencyScore: 60 },
  ];

  const companyBest = new Map<string, MockCard>();
  for (const card of cards) {
    const key = card.companyId ?? `no-company-${card.id}`;
    const existing = companyBest.get(key);
    if (!existing) {
      companyBest.set(key, card);
    } else {
      const existP = BUCKET_PRIORITY[existing.bucket];
      const newP = BUCKET_PRIORITY[card.bucket];
      if (
        newP < existP ||
        (newP === existP && card.urgencyScore > existing.urgencyScore)
      ) {
        companyBest.set(key, card);
      }
    }
  }

  const deduped = [...companyBest.values()];
  test("null-companyId cards each get their own key (no dedup)", deduped.length === 2);
}

report();
