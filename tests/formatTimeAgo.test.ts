/**
 * Unit tests for the shared formatTimeAgo utility (client/src/lib/utils.ts)
 *
 * Covers the full threshold ladder:
 *   - null / undefined / invalid input → "just now"
 *   - future timestamps → "just now"
 *   - < 60s → "just now"
 *   - < 60m → Xm ago
 *   - < 24h → Xh ago
 *   - < 7d → Xd ago
 *   - < 4w → Xw ago
 *   - < 12mo → Xmo ago
 *   - >= 12mo → Xy ago
 *
 * Run with:  npx tsx tests/formatTimeAgo.test.ts
 */

import { formatTimeAgo } from "../client/src/lib/utils";

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

function assertEqual(description: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description} — expected "${expected}", got "${actual}"`);
    failed++;
  }
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

console.log("\n── formatTimeAgo unit tests ──────────────────────────────────────────\n");

// ── Null / undefined / invalid / future handling ──────────────────────────────
console.log("Edge cases:");
assertEqual("null input → 'just now'", formatTimeAgo(null), "just now");
assertEqual("undefined input → 'just now'", formatTimeAgo(undefined), "just now");
assertEqual("empty string → 'just now'", formatTimeAgo(""), "just now");
assertEqual("invalid string → 'just now'", formatTimeAgo("not-a-date"), "just now");
{
  const future = new Date(Date.now() + 60000).toISOString();
  assertEqual("future timestamp → 'just now'", formatTimeAgo(future), "just now");
}

// ── < 60 seconds ─────────────────────────────────────────────────────────────
console.log("\n< 60 seconds:");
assertEqual("30s ago → 'just now'", formatTimeAgo(isoSecondsAgo(30)), "just now");
assertEqual("59s ago → 'just now'", formatTimeAgo(isoSecondsAgo(59)), "just now");

// ── < 60 minutes ─────────────────────────────────────────────────────────────
console.log("\n< 60 minutes:");
assertEqual("1m ago → '1m ago'",  formatTimeAgo(isoSecondsAgo(60)),  "1m ago");
assertEqual("5m ago → '5m ago'",  formatTimeAgo(isoSecondsAgo(5 * 60)),  "5m ago");
assertEqual("59m ago → '59m ago'", formatTimeAgo(isoSecondsAgo(59 * 60)), "59m ago");

// ── < 24 hours ───────────────────────────────────────────────────────────────
console.log("\n< 24 hours:");
assertEqual("1h ago → '1h ago'",  formatTimeAgo(isoSecondsAgo(3600)),      "1h ago");
assertEqual("23h ago → '23h ago'", formatTimeAgo(isoSecondsAgo(23 * 3600)), "23h ago");

// ── < 7 days ─────────────────────────────────────────────────────────────────
console.log("\n< 7 days:");
assertEqual("1d ago → '1d ago'", formatTimeAgo(isoSecondsAgo(86400)),    "1d ago");
assertEqual("6d ago → '6d ago'", formatTimeAgo(isoSecondsAgo(6 * 86400)), "6d ago");

// ── < 4 weeks ────────────────────────────────────────────────────────────────
console.log("\n< 4 weeks:");
assertEqual("7d ago → '1w ago'",  formatTimeAgo(isoSecondsAgo(7 * 86400)),  "1w ago");
assertEqual("14d ago → '2w ago'", formatTimeAgo(isoSecondsAgo(14 * 86400)), "2w ago");
assertEqual("20d ago → '2w ago'", formatTimeAgo(isoSecondsAgo(20 * 86400)), "2w ago");

// ── < 12 months ──────────────────────────────────────────────────────────────
console.log("\n< 12 months:");
assertEqual("28d ago → '1mo ago'",  formatTimeAgo(isoSecondsAgo(28 * 86400)),  "1mo ago");
assertEqual("29d ago → '1mo ago'",  formatTimeAgo(isoSecondsAgo(29 * 86400)),  "1mo ago");
assertEqual("30d ago → '1mo ago'",  formatTimeAgo(isoSecondsAgo(30 * 86400)),  "1mo ago");
assertEqual("60d ago → '2mo ago'",  formatTimeAgo(isoSecondsAgo(60 * 86400)),  "2mo ago");
assertEqual("180d ago → '6mo ago'", formatTimeAgo(isoSecondsAgo(180 * 86400)), "6mo ago");
assertEqual("350d ago → '11mo ago'", formatTimeAgo(isoSecondsAgo(350 * 86400)), "11mo ago");

// ── >= 1 year ─────────────────────────────────────────────────────────────────
console.log("\n>= 1 year:");
assertEqual("365d ago → '1y ago'", formatTimeAgo(isoSecondsAgo(365 * 86400)), "1y ago");
assertEqual("730d ago → '2y ago'", formatTimeAgo(isoSecondsAgo(730 * 86400)), "2y ago");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────\n`);
if (failed > 0) {
  process.exit(1);
}
