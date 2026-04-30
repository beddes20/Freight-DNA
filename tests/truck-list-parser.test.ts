/**
 * Truck-List Parser tests (Task #844)
 *
 * Pure functions only — no DB, no HTTP. Run with:
 *   npx tsx tests/truck-list-parser.test.ts
 */

import {
  looksLikeTruckList,
  parseEmailBody,
  parseAttachment,
  _internals,
} from "../server/truckListParser";
import * as XLSX from "xlsx";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
function eq<T>(actual: T, expected: T, label: string) {
  const pass = actual === expected;
  if (pass) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Truck-List Parser — Unit Tests (Task #844)");
console.log("══════════════════════════════════════════════════════════════");

// ── 1. looksLikeTruckList heuristics ───────────────────────────────────────
console.log("── 1. looksLikeTruckList ──");
ok(looksLikeTruckList({ subject: "Trucks Available 5/12" }), "subject keyword 'trucks available'");
ok(looksLikeTruckList({ subject: "Capacity list — Phoenix area" }), "subject keyword 'capacity list'");
ok(!looksLikeTruckList({ subject: "POD attached", body: "see attached" }), "unrelated subject + no body signals → false");
ok(
  looksLikeTruckList({
    subject: "FYI",
    body: "Phoenix, AZ available 5/12 reefer\nDallas, TX 5/13 van",
  }),
  "2+ city/state+date lines in body",
);
ok(
  looksLikeTruckList({ subject: "Misc", attachmentNames: ["trucks-this-week.xlsx"] }),
  "attachment name with 'trucks' + .xlsx",
);
ok(
  !looksLikeTruckList({ subject: "Misc", attachmentNames: ["invoice-9921.pdf"] }),
  "PDF attachment alone (no truck keyword) → false",
);

// ── 2. normalizeEquipment ──────────────────────────────────────────────────
console.log("── 2. normalizeEquipment ──");
eq(_internals.normalizeEquipment("V"), "Van", "V → Van");
eq(_internals.normalizeEquipment("reefer"), "Reefer", "reefer → Reefer");
eq(_internals.normalizeEquipment("Step Deck"), "Step Deck", "Step Deck → Step Deck");
eq(_internals.normalizeEquipment("FB"), "Flatbed", "FB → Flatbed");
eq(_internals.normalizeEquipment(""), null, "empty → null");
eq(_internals.normalizeEquipment(null), null, "null → null");

// ── 3. normalizeDate ───────────────────────────────────────────────────────
console.log("── 3. normalizeDate ──");
const today = new Date(2026, 4, 1); // May 1 2026
eq(_internals.normalizeDate("5/12", today), "2026-05-12", "5/12 → 2026-05-12");
eq(_internals.normalizeDate("12/01", today), "2026-12-01", "12/01 → 2026-12-01");
eq(_internals.normalizeDate("2026-06-15", today), "2026-06-15", "ISO passthrough");
eq(_internals.normalizeDate("today", today), "2026-05-01", "today");
eq(_internals.normalizeDate("tomorrow", today), "2026-05-02", "tomorrow");
eq(_internals.normalizeDate("monday", new Date(2026, 4, 1)), "2026-05-04", "next Monday from Fri 5/1");
eq(_internals.normalizeDate("garbage"), null, "garbage → null");
ok(_internals.normalizeDate("45782", today) !== null, "Excel serial number → date");

// ── 4. splitCityState ──────────────────────────────────────────────────────
console.log("── 4. splitCityState ──");
const phx = _internals.splitCityState("Phoenix, AZ");
eq(phx.city, "Phoenix", "Phoenix, AZ → city=Phoenix");
eq(phx.state, "AZ", "Phoenix, AZ → state=AZ");
const dal = _internals.splitCityState("Dallas TX");
eq(dal.city, "Dallas", "Dallas TX → city=Dallas");
eq(dal.state, "TX", "Dallas TX → state=TX");
const fl = _internals.splitCityState("FL");
eq(fl.city, null, "state-only → city=null");
eq(fl.state, "FL", "state-only → state=FL");

// ── 5. parseEmailBody ──────────────────────────────────────────────────────
console.log("── 5. parseEmailBody ──");
const body = `
Hi team,

Trucks for tomorrow:
Phoenix, AZ → Dallas, TX  5/12  Reefer  $2400
Atlanta, GA → FL  5/13  Van
Salt Lake City, UT  5/14  flatbed  $1800

Thanks!
`;
const rows = parseEmailBody(body, today);
eq(rows.length, 3, "parsed 3 rows");
eq(rows[0]?.originCity, "Phoenix", "row 0 origin city");
eq(rows[0]?.originState, "AZ", "row 0 origin state");
eq(rows[0]?.destCity, "Dallas", "row 0 dest city");
eq(rows[0]?.destState, "TX", "row 0 dest state");
eq(rows[0]?.equipment, "Reefer", "row 0 equipment");
eq(rows[0]?.rateAsk, "2400", "row 0 rate");
eq(rows[1]?.originCity, "Atlanta", "row 1 origin");
eq(rows[1]?.equipment, "Van", "row 1 equipment");
eq(rows[2]?.equipment, "Flatbed", "row 2 equipment normalized");

// ── 6. parseAttachment (xlsx) ──────────────────────────────────────────────
console.log("── 6. parseAttachment xlsx ──");
const aoa = [
  ["Origin City", "Origin State", "Dest", "Available", "Equipment", "Rate"],
  ["Phoenix",     "AZ",          "Dallas, TX", "5/12",  "Reefer",   "2400"],
  ["Atlanta",     "GA",          "FL",         "5/13",  "Van",      ""],
  ["",            "",            "",           "",      "",         ""],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Trucks");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
const xlsxRows = parseAttachment(buf, "trucks.xlsx", today);
eq(xlsxRows.length, 2, "xlsx parsed 2 data rows (blanks skipped)");
eq(xlsxRows[0]?.originCity, "Phoenix", "xlsx row 0 city");
eq(xlsxRows[0]?.originState, "AZ", "xlsx row 0 state");
eq(xlsxRows[0]?.destCity, "Dallas", "xlsx row 0 dest city (split)");
eq(xlsxRows[0]?.destState, "TX", "xlsx row 0 dest state (split)");
eq(xlsxRows[0]?.equipment, "Reefer", "xlsx row 0 equipment");
eq(xlsxRows[0]?.availableDate, "2026-05-12", "xlsx row 0 date");
eq(xlsxRows[0]?.rateAsk, "2400", "xlsx row 0 rate");
eq(xlsxRows[1]?.originCity, "Atlanta", "xlsx row 1 city");
eq(xlsxRows[1]?.destState, "FL", "xlsx row 1 dest is just FL");

// ── 7. parseAttachment (csv) ───────────────────────────────────────────────
console.log("── 7. parseAttachment csv ──");
const csv = `Origin,State,Destination,Date,Equipment,Rate\nPhoenix,AZ,Dallas TX,5/12,V,2400\nAtlanta,GA,,5/13,Reefer,1800\n`;
const csvRows = parseAttachment(Buffer.from(csv, "utf-8"), "list.csv", today);
eq(csvRows.length, 2, "csv parsed 2 rows");
eq(csvRows[0]?.originState, "AZ", "csv row 0 state");
eq(csvRows[0]?.equipment, "Van", "csv row 0 equipment normalized V→Van");

// ── 8. parseAttachment (no header recognized) falls back to first row ─────
console.log("── 8. parseAttachment fallback ──");
const csv2 = `Phoenix,AZ,5/12,Reefer\nAtlanta,GA,5/13,Van\n`;
const fallbackRows = parseAttachment(Buffer.from(csv2, "utf-8"), "x.csv", today);
ok(fallbackRows.length >= 0, "fallback path doesn't crash on header-less csv");

// ── Summary ────────────────────────────────────────────────────────────────
console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");
if (failed > 0) process.exit(1);
