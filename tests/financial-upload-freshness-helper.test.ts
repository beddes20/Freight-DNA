// Phase 1.5 S8 — Pure unit tests for deriveFinancialUploadFreshness +
// formatAsOfUploadLabel. No DB. Verifies the honest stale/ok/unknown
// derivation and label formatting for the Trending + Margin trust labels.

import { deriveFinancialUploadFreshness, formatAsOfUploadLabel } from "../server/lib/portletFreshness";

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\u2550".repeat(62));
console.log("  Phase 1.5 S8 — deriveFinancialUploadFreshness + label");
console.log("\u2550".repeat(62));

const now = new Date("2026-05-07T12:00:00.000Z");

const okCurrent = deriveFinancialUploadFreshness({
  uploadedAt: "2026-05-06T10:00:00.000Z",
  dataMonthKey: "2026-05",
  now,
});
check("data-month = current calendar month \u2192 status='ok'", okCurrent.status === "ok");
check("ok carries upload timestamp as lastUpdatedAt",
  okCurrent.lastUpdatedAt === "2026-05-06T10:00:00.000Z");
check("source label is financial_uploads.uploadedAt",
  okCurrent.source === "financial_uploads.uploadedAt");

const okPrevMonth = deriveFinancialUploadFreshness({
  uploadedAt: "2026-04-30T18:00:00.000Z",
  dataMonthKey: "2026-04",
  now,
});
check("data-month = one month back \u2192 status='ok' (typical cadence)",
  okPrevMonth.status === "ok");

const stale2Months = deriveFinancialUploadFreshness({
  uploadedAt: "2026-03-30T18:00:00.000Z",
  dataMonthKey: "2026-03",
  now,
});
check("data-month = two months back \u2192 status='stale'",
  stale2Months.status === "stale");

const stale6Months = deriveFinancialUploadFreshness({
  uploadedAt: "2025-11-30T18:00:00.000Z",
  dataMonthKey: "2025-11",
  now,
});
check("data-month = six months back \u2192 status='stale'",
  stale6Months.status === "stale");

const noInputs = deriveFinancialUploadFreshness({
  uploadedAt: null,
  dataMonthKey: null,
  now,
});
check("no upload + no data-month \u2192 status='unknown'",
  noInputs.status === "unknown");
check("unknown carries null lastUpdatedAt",
  noInputs.lastUpdatedAt === null);

const malformedKey = deriveFinancialUploadFreshness({
  uploadedAt: "2026-05-06T10:00:00.000Z",
  dataMonthKey: "garbage",
  now,
});
check("malformed dataMonthKey \u2192 status='unknown' (defensive)",
  malformedKey.status === "unknown");
check("malformed key still preserves upload lastUpdatedAt",
  malformedKey.lastUpdatedAt === "2026-05-06T10:00:00.000Z");

const malformedUpload = deriveFinancialUploadFreshness({
  uploadedAt: "not-a-date",
  dataMonthKey: "2026-05",
  now,
});
check("malformed uploadedAt \u2192 lastUpdatedAt is null but status from monthKey",
  malformedUpload.lastUpdatedAt === null && malformedUpload.status === "ok");

const futureKey = deriveFinancialUploadFreshness({
  uploadedAt: "2026-06-01T00:00:00.000Z",
  dataMonthKey: "2026-06",
  now,
});
check("future-dated data \u2192 NOT stale (don't scold the data)",
  futureKey.status === "ok");

check("formatAsOfUploadLabel('2026-05') = 'As of May 2026 upload'",
  formatAsOfUploadLabel("2026-05") === "As of May 2026 upload");
check("formatAsOfUploadLabel('2026-04') = 'As of April 2026 upload'",
  formatAsOfUploadLabel("2026-04") === "As of April 2026 upload");
check("formatAsOfUploadLabel(null) = null",
  formatAsOfUploadLabel(null) === null);
check("formatAsOfUploadLabel('garbage') = null",
  formatAsOfUploadLabel("garbage") === null);
check("formatAsOfUploadLabel('2026-13') = null (invalid month)",
  formatAsOfUploadLabel("2026-13") === null);

const invalidMonthBound = deriveFinancialUploadFreshness({
  uploadedAt: "2026-05-06T10:00:00.000Z",
  dataMonthKey: "2026-13",
  now,
});
check("dataMonthKey='2026-13' (out-of-range month) \u2192 status='unknown' (architect feedback)",
  invalidMonthBound.status === "unknown");
check("invalid month bound still preserves upload lastUpdatedAt",
  invalidMonthBound.lastUpdatedAt === "2026-05-06T10:00:00.000Z");

const invalidMonthZero = deriveFinancialUploadFreshness({
  uploadedAt: "2026-05-06T10:00:00.000Z",
  dataMonthKey: "2026-00",
  now,
});
check("dataMonthKey='2026-00' (zero month) \u2192 status='unknown'",
  invalidMonthZero.status === "unknown");

console.log("\u2500".repeat(62));
console.log(`  ${passed} passed, ${failed} failed`);
console.log("\u2550".repeat(62));

if (failed > 0) process.exit(1);
