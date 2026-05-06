// Task #969 — Vitest-style harness (run via `npx tsx`) that pins the
// pure-function units shipped in this task: formatQuoteConfidence (the
// admin pipeline-health UI clamp) and resolveQuotePipelineThreshold
// (the watchdog scaling rule). Both are pure — no DB / no network — so
// running them in this lightweight harness keeps the file dependency-
// free and matches the conventions of the other tests/*.test.ts files
// in this repo.

import { formatQuoteConfidence } from "../client/src/lib/customerQuotes";
import { resolveQuotePipelineThreshold } from "../server/services/mailboxWatchdogService";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expectEq<T>(label: string, actual: T, expected: T): void {
  if (Object.is(actual, expected)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    failures.push(label);
    failed++;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Customer-Quotes Trust Hardening — Unit Tests (Task #969)");
console.log("══════════════════════════════════════════════════════════════");

console.log("── formatQuoteConfidence ──");
expectEq("null → em-dash", formatQuoteConfidence(null), "—");
expectEq("undefined → em-dash", formatQuoteConfidence(undefined), "—");
expectEq("NaN → em-dash", formatQuoteConfidence(NaN), "—");
expectEq("Infinity → em-dash", formatQuoteConfidence(Infinity), "—");
expectEq("0 → 0%", formatQuoteConfidence(0), "0%");
expectEq("0.5 → 50%", formatQuoteConfidence(0.5), "50%");
expectEq("0.876 → rounds to 88%", formatQuoteConfidence(0.876), "88%");
expectEq("1 → 100%", formatQuoteConfidence(1), "100%");
expectEq("clamps above 1 → 100%", formatQuoteConfidence(1.42), "100%");
expectEq("clamps below 0 → 0%", formatQuoteConfidence(-0.3), "0%");

console.log("── resolveQuotePipelineThreshold (Task #969 watchdog scaling) ──");
{
  const r = resolveQuotePipelineThreshold(0);
  expectEq("zero baseline → floor", r.rule, "floor");
  expectEq("zero baseline value = 5", r.value, 5);
}
{
  const r = resolveQuotePipelineThreshold(50);
  // 5% of 50 = 2.5 → ceil 3, below floor of 5 → floor wins.
  expectEq("low-volume baseline → floor", r.rule, "floor");
  expectEq("low-volume baseline value = 5", r.value, 5);
}
{
  const r = resolveQuotePipelineThreshold(100);
  // 5% of 100 = 5 → ceil 5; not strictly greater than 5 → floor wins.
  expectEq("100/day baseline ties on floor", r.rule, "floor");
  expectEq("100/day baseline value = 5", r.value, 5);
}
{
  const r = resolveQuotePipelineThreshold(120);
  // 5% of 120 = 6 → strictly above floor → scaled wins.
  expectEq("120/day baseline → scaled", r.rule, "scaled");
  expectEq("120/day baseline value = 6", r.value, 6);
}
{
  const r = resolveQuotePipelineThreshold(400);
  // 5% of 400 = 20 → scaled.
  expectEq("400/day baseline → scaled", r.rule, "scaled");
  expectEq("400/day baseline value = 20", r.value, 20);
}
{
  // Defensive: a stale row (NaN) must NOT crash the watchdog tick;
  // it should fall back to the floor branch silently.
  const r = resolveQuotePipelineThreshold(NaN);
  expectEq("NaN baseline → floor", r.rule, "floor");
  expectEq("NaN baseline value = 5", r.value, 5);
}
{
  // Defensive: negative averages cannot occur in production but must
  // not punch the threshold below the floor.
  const r = resolveQuotePipelineThreshold(-50);
  expectEq("negative baseline → floor", r.rule, "floor");
  expectEq("negative baseline value = 5", r.value, 5);
}

console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
