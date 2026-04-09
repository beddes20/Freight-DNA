/**
 * Carrier History Extraction — Regression Tests
 *
 * Root cause this guards against:
 *   TMS JSONB rows store field names in title-case-with-spaces ("Origin", "Destination",
 *   "Origin state", "Destination state", "Carrier", "Month") while the old code only
 *   checked camelCase variants. This caused ALL rows from the real TMS upload to be
 *   silently skipped, producing zero carrier history for any ranking.
 *
 * Secondary bugs fixed:
 *   - Carrier names in "PAYCODE - CARRIER NAME" format were not stripped
 *   - Month format "2026 M03" was not parseable as "YYYY-MM" for recency scoring
 *
 * Run with: npx tsx tests/carrier-history-extraction.test.ts
 * Does NOT require server — all unit tests run against imported helpers directly.
 */

import {
  readTmsField,
  parseCarrierName,
  parsePayeeCode,
  normalizeTmsMonth,
  extractCity,
  rankCarriersForLane,
} from "../server/carrierRankingService.js";
import type { RecurringLane, FinancialUpload } from "../shared/schema.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.error(`  ✗ FAIL: ${label}`);
    console.error(`       got:      ${JSON.stringify(actual)}`);
    console.error(`       expected: ${JSON.stringify(expected)}`);
  }
}

// ── 1. readTmsField ─────────────────────────────────────────────────────────
console.log("\n── readTmsField ──");

assertEqual(
  readTmsField({ "Origin": "PHOENIX, AZ" }, "shipperCity", "originCity", "Shipper city", "Origin city", "origin", "Origin"),
  "PHOENIX, AZ",
  "reads title-case 'Origin' field when camelCase keys are absent"
);

assertEqual(
  readTmsField({ shipperCity: "Phoenix" }, "shipperCity", "originCity", "Shipper city", "Origin city", "origin", "Origin"),
  "Phoenix",
  "reads camelCase 'shipperCity' when present (prefers first match)"
);

assertEqual(
  readTmsField({ "Carrier": "DHAMLIAZ - DHAMI CARRIER LLC" }, "carrier", "carrierName", "Carrier"),
  "DHAMLIAZ - DHAMI CARRIER LLC",
  "reads title-case 'Carrier' field"
);

assertEqual(
  readTmsField({ "Month": "2026 M03" }, "month", "Month"),
  "2026 M03",
  "reads title-case 'Month' field"
);

assertEqual(
  readTmsField({}, "carrier", "Carrier"),
  "",
  "returns empty string when no matching key"
);

assertEqual(
  readTmsField({ carrier: "" }, "carrier", "Carrier"),
  "",
  "skips empty string values and tries next key"
);

assertEqual(
  readTmsField({ carrier: "", "Carrier": "DHAMLIAZ - DHAMI CARRIER LLC" }, "carrier", "Carrier"),
  "DHAMLIAZ - DHAMI CARRIER LLC",
  "skips empty camelCase and falls through to title-case"
);

// ── 2. parseCarrierName ──────────────────────────────────────────────────────
console.log("\n── parseCarrierName ──");

assertEqual(parseCarrierName("DHAMLIAZ - DHAMI CARRIER LLC"), "DHAMI CARRIER LLC",
  "strips payee code prefix from 'PAYCODE - NAME' format");

assertEqual(parseCarrierName("JACOINSC - JACOBS TRANS LLC"), "JACOBS TRANS LLC",
  "strips payee code prefix from another example");

assertEqual(parseCarrierName("Dhami Carrier LLC"), "Dhami Carrier LLC",
  "returns name unchanged when no payee-code prefix");

assertEqual(parseCarrierName("LETEPHA1 - LETEM TRANSPORTATION LLC"), "LETEM TRANSPORTATION LLC",
  "handles alphanumeric payee codes (with digit)");

assertEqual(parseCarrierName(""), "", "returns empty string for empty input");

assertEqual(parseCarrierName("   DHAMLIAZ - DHAMI CARRIER LLC   "), "DHAMI CARRIER LLC",
  "trims leading/trailing whitespace");

// ── 3. parsePayeeCode ────────────────────────────────────────────────────────
console.log("\n── parsePayeeCode ──");

assertEqual(parsePayeeCode("DHAMLIAZ - DHAMI CARRIER LLC"), "DHAMLIAZ",
  "extracts payee code from 'PAYCODE - NAME' format");

assertEqual(parsePayeeCode("Dhami Carrier LLC"), null,
  "returns null when no payee-code format");

assertEqual(parsePayeeCode(""), null, "returns null for empty input");

assertEqual(parsePayeeCode("JACOINSC - JACOBS TRANS LLC"), "JACOINSC",
  "extracts payee code from another example");

// ── 4. normalizeTmsMonth ─────────────────────────────────────────────────────
console.log("\n── normalizeTmsMonth ──");

assertEqual(normalizeTmsMonth("2026 M03"), "2026-03",
  "converts '2026 M03' to canonical YYYY-MM");

assertEqual(normalizeTmsMonth("2025 M10"), "2025-10",
  "converts '2025 M10' to canonical YYYY-MM");

assertEqual(normalizeTmsMonth("2025 M9"), "2025-09",
  "zero-pads single-digit month");

assertEqual(normalizeTmsMonth("2025-10"), "2025-10",
  "already-canonical format passes through");

assertEqual(normalizeTmsMonth("2025-10-15"), "2025-10",
  "ISO date truncated to YYYY-MM");

assertEqual(normalizeTmsMonth("2025/10"), "2025-10",
  "slash-separated format converted");

assertEqual(normalizeTmsMonth(""), "", "empty string returns empty");
assertEqual(normalizeTmsMonth(null), "", "null returns empty");
assertEqual(normalizeTmsMonth(undefined), "", "undefined returns empty");

// ── 5. extractCity ──────────────────────────────────────────────────────────
console.log("\n── extractCity ──");

assertEqual(extractCity("PHOENIX, AZ"), "phoenix",
  "extracts and lowercases city from 'CITY, ST'");

assertEqual(extractCity("South Salt Lake, UT"), "south salt lake",
  "handles multi-word city name");

assertEqual(extractCity("phoenix"), "phoenix",
  "returns city-only string unchanged (lowercased)");

assertEqual(extractCity("KENT, WA"), "kent",
  "extracts Kent from 'KENT, WA'");

assertEqual(extractCity(""), "", "returns empty for empty input");

assertEqual(extractCity("GLENDALE, AZ"), "glendale",
  "handles 'GLENDALE, AZ'");

// ── 6. Full ranking: TMS-format data with real field names ───────────────────
console.log("\n── rankCarriersForLane (TMS field-name format) ──");

// Mock storage with no catalog carriers — all carriers must come from TMS history
const mockStorage = {
  getCarriers: async () => [],
  getFinancialUploadsForOrg: async () => [
    {
      id: "upload-001",
      fileName: "RealTMS.xlsx",
      uploadedAt: "2026-03-24",
      uploadedBy: "user-001",
      rowCount: 12,
      rows: [
        // Dhami: Phoenix, AZ → Kent, WA (6 loads — exact lane)
        ...Array.from({ length: 6 }, (_, i) => ({
          "Origin": "PHOENIX, AZ",
          "Destination": "KENT, WA",
          "Origin state": "AZ",
          "Destination state": "WA",
          "Carrier": "DHAMLIAZ - DHAMI CARRIER LLC",
          "Month": "2026 M03",
          "Customer": "Acme Corp",
        })),
        // Dhami: Phoenix, AZ → Everett, WA (3 loads — AZ→WA corridor)
        ...Array.from({ length: 3 }, (_, i) => ({
          "Origin": "PHOENIX, AZ",
          "Destination": "EVERETT, WA",
          "Origin state": "AZ",
          "Destination state": "WA",
          "Carrier": "DHAMLIAZ - DHAMI CARRIER LLC",
          "Month": "2026 M02",
          "Customer": "Acme Corp",
        })),
        // 1 61 Inc: zero AZ→WA history — completely unrelated lane
        ...Array.from({ length: 3 }, () => ({
          "Origin": "CHICAGO, IL",
          "Destination": "MEMPHIS, TN",
          "Origin state": "IL",
          "Destination state": "TN",
          "Carrier": "161INCMO - 1 61 INC",
          "Month": "2026 M01",
          "Customer": "Other Corp",
        })),
      ],
      summaryRows: null,
      bestDealDaysSpot: null,
      bestDealDaysAll: null,
      trendAnalysis: null,
      averagesData: null,
      dailyAcquisition: null,
    } as FinancialUpload,
  ],
};

const mockLane: RecurringLane = {
  id: "lane-phx-kent",
  orgId: "test-org",
  origin: "Phoenix",
  destination: "Kent",
  originState: "AZ",
  originCity: "Phoenix",
  destState: "WA",
  destCity: "Kent",
  equipmentType: null,
  companyId: null,
  companyName: null,
  avgLoadsPerWeek: null,
  weeksActive: null,
  resolvedAt: null,
  ownerId: null,
  ownerAssignedAt: null,
  ownerAssignedBy: null,
  laneScore: null,
  laneScoreUpdatedAt: null,
  laneScoreSummary: null,
  coveredByAward: null,
  awardId: null,
} as unknown as RecurringLane;

// Add 1 61 Inc to catalog (region/equipment fit only — no AZ→WA TMS history)
const mockStorageWithCatalog = {
  getCarriers: async () => [
    {
      id: "carrier-161",
      orgId: "test-org",
      name: "1 61 Inc",
      mcDot: null,
      primaryEmail: "dispatch@161inc.com",
      backupEmail: null,
      regions: ["AZ", "WA", "OR"],  // claims AZ and WA regions in catalog
      equipmentTypes: ["Dry Van"],
      tags: [],
      notes: null,
      payeeCode: null,
      phone: null,
      city: null,
      state: null,
      sourceChannel: null,
      importBatchId: null,
      legalName: null,
      dotNumber: null,
      statesServed: [],
      metroAreas: [],
      equipmentNotes: null,
      status: "active",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    } as any,
  ],
  getFinancialUploadsForOrg: mockStorage.getFinancialUploadsForOrg,
};

try {
  const ranked = await rankCarriersForLane(mockLane, mockStorageWithCatalog as any);

  // Dhami should appear (from TMS history path)
  const dhamiEntry = ranked.find(r => r.carrierName.toLowerCase().includes("dhami"));
  // 1 61 Inc should appear (from catalog path, region match for AZ/WA)
  const oneInc = ranked.find(r => r.carrierName.toLowerCase().includes("1 61") || r.carrierName.toLowerCase().includes("161 inc"));

  assert(!!dhamiEntry, "Dhami Carrier LLC appears in ranked list (was not excluded)");
  assert(!!oneInc, "1 61 Inc appears in ranked list (catalog carrier with region match)");

  if (dhamiEntry && oneInc) {
    assert(
      dhamiEntry.fitScore > oneInc.fitScore,
      `Dhami (score ${dhamiEntry.fitScore}) outranks 1 61 Inc (score ${oneInc.fitScore}) due to AZ→WA exact lane history`
    );

    const dhamiIndex = ranked.findIndex(r => r.carrierName.toLowerCase().includes("dhami"));
    const oneIncIndex = ranked.findIndex(r => r.carrierName.toLowerCase().includes("1 61") || r.carrierName.toLowerCase().includes("161 inc"));
    assert(dhamiIndex < oneIncIndex, `Dhami ranks position #${dhamiIndex + 1}, 1 61 Inc ranks #${oneIncIndex + 1} — correct`);
  }

  if (dhamiEntry) {
    assert(
      dhamiEntry.historyMatch === "exact" || dhamiEntry.historyMatch === "similar",
      `Dhami historyMatch is '${dhamiEntry.historyMatch}' (not 'none')`
    );
    assert(
      dhamiEntry.loadsOnLane >= 6,
      `Dhami has ≥6 loads on the AZ→WA corridor (got ${dhamiEntry.loadsOnLane})`
    );
    assert(
      dhamiEntry.lastUsedMonth !== null && dhamiEntry.lastUsedMonth > "",
      `Dhami lastUsedMonth is populated: '${dhamiEntry.lastUsedMonth}'`
    );
  }

  if (oneInc) {
    // 1 61 Inc has catalog regions AZ+WA but no TMS history on this lane.
    // Expected: region-level match (from catalog) but NOT exact/similar history match.
    assert(
      oneInc.historyMatch !== "exact" && oneInc.historyMatch !== "similar",
      `1 61 Inc historyMatch is '${oneInc.historyMatch}' — should NOT be exact/similar (no TMS lane history)`
    );
  }

} catch (err) {
  failed++;
  failures.push(`rankCarriersForLane threw: ${(err as Error).message}`);
  console.error("  ✗ FAIL: rankCarriersForLane threw:", err);
}

// ── 7. Carrier name normalization: legacy camelCase format still works ────────
console.log("\n── rankCarriersForLane (legacy camelCase field format) ──");

const mockStorageLegacy = {
  getCarriers: async () => [],
  getFinancialUploadsForOrg: async () => [
    {
      id: "upload-legacy",
      fileName: "LegacyExport.xlsx",
      uploadedAt: "2026-01-15",
      uploadedBy: "user-001",
      rowCount: 5,
      rows: Array.from({ length: 5 }, () => ({
        shipperCity: "Phoenix",
        consigneeCity: "Kent",
        shipperState: "AZ",
        consigneeState: "WA",
        carrier: "Dhami Carrier LLC",
        month: "2026-01",
        customerName: "Acme Corp",
      })),
      summaryRows: null, bestDealDaysSpot: null, bestDealDaysAll: null,
      trendAnalysis: null, averagesData: null, dailyAcquisition: null,
    } as FinancialUpload,
  ],
};

try {
  const rankedLegacy = await rankCarriersForLane(mockLane, mockStorageLegacy as any);
  const dhamiLegacy = rankedLegacy.find(r => r.carrierName.toLowerCase().includes("dhami"));
  assert(!!dhamiLegacy, "Dhami appears in ranked list with legacy camelCase field format");
  if (dhamiLegacy) {
    assert(
      dhamiLegacy.loadsOnLane > 0,
      `Dhami has loads with legacy format (got ${dhamiLegacy.loadsOnLane})`
    );
  }
} catch (err) {
  failed++;
  failures.push(`legacy format test threw: ${(err as Error).message}`);
  console.error("  ✗ FAIL: legacy format threw:", err);
}

// ── 8. Whitespace / case normalization in carrier names ─────────────────────
console.log("\n── Carrier name normalization edge cases ──");

assertEqual(parseCarrierName("  DHAMLIAZ  -  DHAMI CARRIER LLC  "), "DHAMI CARRIER LLC",
  "handles extra spaces around the dash separator");

assertEqual(parseCarrierName("KTSTMIWI - K & TS TRUCKING LLC"), "K & TS TRUCKING LLC",
  "handles ampersand in carrier name");

assertEqual(parseCarrierName("PLENHUCA - PLENTITUDE TRANSPORTATION IN"), "PLENTITUDE TRANSPORTATION IN",
  "handles truncated carrier name (common in TMS systems)");

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Carrier History Extraction Tests: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error("Failures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log("All tests passed.");
}
