/**
 * Shared financial-domain helpers.
 *
 * These pure utility functions are used by both the Financials routes and
 * the Goals routes inside routes.ts. Centralising them here (following the
 * colResolver.ts pattern) makes future extraction of those route sections
 * straightforward without cross-domain coupling.
 *
 * Dependencies: xlsx (parsing), colResolver (field-key types + row-getters).
 * No Express / storage / side-effects.
 */

import XLSX from "xlsx";
import {
  getRepFromRow,
  getDispatcherFromRow,
  getCustomerFromRow,
  type FinancialCols,
} from "./colResolver";

// ── Exclusion list ────────────────────────────────────────────────────────────

/** Customer/ops-user codes that must never appear in any financial report, summary, or aggregation. */
export const EXCLUDED_FINANCIAL_CODES = new Set(["valubuaz"]);

/** Returns true if a financial row should be excluded from all processing. */
export function isExcludedRow(row: any, cols: FinancialCols): boolean {
  const customer = getCustomerFromRow(row, cols).toLowerCase();
  const rep = getRepFromRow(row, cols).toLowerCase();
  for (const code of EXCLUDED_FINANCIAL_CODES) {
    if (customer.includes(code) || rep.includes(code)) return true;
  }
  return false;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function parseHistoricalRow(row: any, cols?: FinancialCols): {
  destCity: string; destState: string;
  origCity: string; origState: string;
  weekKey: string; monthKey: string; margin: number; revenue: number;
} {
  const destK      = cols?.destination      ?? "Destination";
  const destStateK = cols?.destinationState ?? "Destination state";
  const origK      = cols?.origin           ?? "Origin";
  const origStateK = cols?.originState      ?? "Origin state";
  const weekK      = cols?.week             ?? "Week";
  const delivK     = cols?.deliveryDate     ?? "Delivery date";
  const marginK    = cols?.marginDollar     ?? "Margin $";
  const revenueK   = cols?.revenue          ?? "Total revenue";

  const hasNewFormat = row[origStateK] || row[destStateK]
    || "Origin state" in row || "Destination state" in row
    || ("Origin" in row && "Destination" in row);

  if (hasNewFormat) {
    const destRaw   = String(row[destK]      || "").trim();
    const destState = String(row[destStateK] || "").trim();
    const destCity  = destRaw.includes(",") ? destRaw.split(",")[0].trim() : destRaw;
    const origRaw   = String(row[origK]      || "").trim();
    const origState = String(row[origStateK] || "").trim();
    const origCity  = origRaw.includes(",") ? origRaw.split(",")[0].trim() : origRaw;
    const weekRaw   = String(row[weekK]      || "").trim();
    let weekKey  = weekRaw || "";
    let monthKey = "";

    // 1. Best source: "Month" field directly (e.g. "2026 M02")
    const monthFieldRaw = String(row["Month"] || row["month"] || "").trim();
    const mfMatch = monthFieldRaw.match(/^(\d{4})\s+M(\d+)$/i);
    if (mfMatch) {
      monthKey = `${mfMatch[1]}-${String(parseInt(mfMatch[2])).padStart(2, "0")}`;
    }

    // 2. Excel serial delivery date
    if (!monthKey) {
      const serial = Number(row[delivK]);
      if (!isNaN(serial) && serial > 40000) {
        const d = new Date(new Date(1899, 11, 30).getTime() + serial * 86400000);
        monthKey = toMonthKey(d);
        if (!weekKey) {
          const y = d.getFullYear();
          const wn = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7);
          weekKey = `${y}-W${wn}`;
        }
      }
    }

    // 3. ISO/string delivery date (stored after cellDates:true serialization)
    if (!monthKey && row[delivK]) {
      const dStr = String(row[delivK]).trim();
      if (dStr && isNaN(Number(dStr))) {
        const d = new Date(dStr);
        if (!isNaN(d.getTime())) monthKey = toMonthKey(d);
      }
    }

    // 4. Week key fallback
    if (!monthKey && weekKey) {
      const m = weekKey.match(/^(\d{4})\s*W(\d+)$/);
      if (m) {
        const d = new Date(parseInt(m[1]), 0, 1 + (parseInt(m[2]) - 1) * 7);
        monthKey = toMonthKey(d);
      }
    }
    return {
      destCity, destState, origCity, origState, weekKey, monthKey,
      margin: Number(row[marginK]) || 0,
      revenue: Number(row[revenueK]) || 0,
    };
  }

  // TMS / ReplitNumbers format
  const consigneeCityK  = cols?.consigneeCity  ?? "Consignee city";
  const consigneeStateK = cols?.consigneeState ?? "Consignee state";
  const shipperCityK    = cols?.shipperCity    ?? "Shipper city";
  const shipperStateK   = cols?.shipperState   ?? "Shipper state";
  const dateOrderedK    = cols?.dateOrdered    ?? "Date ordered";
  const totalChargesK   = cols?.totalCharges   ?? "Total charges";
  const freightChargeK  = cols?.freightCharge  ?? "Freight charge";

  const destCity  = String(row[consigneeCityK]  || "").trim();
  const destState = String(row[consigneeStateK] || "").trim();
  const origCity  = String(row[shipperCityK]    || "").trim();
  const origState = String(row[shipperStateK]   || "").trim();
  const dateStr   = String(row[dateOrderedK]    || "").trim();
  const tc = Number(row[totalChargesK]  || 0);
  const fc = Number(row[freightChargeK] || 0);
  const rv = Number(row[revenueK]       || row[totalChargesK] || 0);

  let weekKey  = "";
  let monthKey = "";
  if (dateStr) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const wn = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7);
        weekKey  = `${y}-W${wn}`;
        monthKey = toMonthKey(d);
      }
    } catch {}
  }
  return { destCity, destState, origCity, origState, weekKey, monthKey, margin: tc - fc, revenue: rv || tc };
}

// ── Data-quality guard ────────────────────────────────────────────────────────

/**
 * Returns true when the rows array looks like documentation/description text
 * rather than real transaction data (guard against bad summary sheet uploads).
 */
export function isBadSummaryData(rows: any[]): boolean {
  if (!rows.length) return true;
  const firstRow = rows[0];
  const usesEmpty = "__EMPTY" in firstRow;
  const sampleNames = rows.slice(0, 5).map((r: any) =>
    String(usesEmpty ? (r["__EMPTY"] || "") : (r["Customer Name"] || r["customer name"] || "")).trim()
  );
  return sampleNames.every(name =>
    name.length > 60 ||
    name.includes("—") ||
    name.toLowerCase().startsWith("use") ||
    name.toLowerCase().startsWith("remove") ||
    name.toLowerCase().startsWith("date")
  );
}

// ── Goal computation ──────────────────────────────────────────────────────────

/**
 * Count loads, total margin, and total charges for a rep goal.
 * LMs are attributed via the Dispatcher column; AMs/NAMs/sales via Operations User.
 */
export function computeLoadsForRepGoal(
  txRows: any[],
  cols: FinancialCols,
  repKey: string,
  isLMGoal: boolean,
  goalMonthKey: string | null
): { loads: number; totalMargin: number; totalCharges: number } {
  const repKeyLower = repKey.toLowerCase();
  let loads = 0;
  let totalMargin = 0;
  let totalCharges = 0;
  for (const row of txRows) {
    if (isExcludedRow(row, cols)) continue;
    const repInRow = isLMGoal
      ? getDispatcherFromRow(row, cols).toLowerCase()
      : getRepFromRow(row, cols).toLowerCase();
    if (repInRow !== repKeyLower) continue;
    if (goalMonthKey) {
      const { monthKey } = parseHistoricalRow(row, cols);
      if (monthKey !== goalMonthKey) continue;
    }
    loads++;
    totalMargin  += Number(row[cols.marginDollar] || row["Margin $"]      || 0);
    totalCharges += Number(row[cols.totalCharges]  || row["Total charges"] || 0);
  }
  return { loads, totalMargin, totalCharges };
}

// ── Workbook parsing ──────────────────────────────────────────────────────────

/**
 * Extract and merge the relevant data sheets from a Value Truck financial workbook.
 * Handles multiple sheet naming conventions (ReplitNumbers, ReplitNumbers[Month],
 * YTD BORA, All Data (YTD)) and always de-duplicates the current month when a
 * month-specific tab is present.
 */
export function extractSheetsFromWorkbook(workbook: XLSX.WorkBook) {
  const readSheet = (name: string): any[] => {
    const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === name.toLowerCase());
    if (!match) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[match], { defval: "" });
  };

  // Smart reader: skips decorative title rows and uses the first row with ≥2 real string headers
  const readSheetSmart = (name: string): any[] => {
    const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === name.toLowerCase());
    if (!match) return [];
    const raw: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[match], { header: 1, defval: "" }) as any[][];
    let headerIdx = 0;
    for (let i = 0; i < Math.min(10, raw.length); i++) {
      const row = raw[i];
      const nonEmpty = row.filter((c: any) => c !== "" && c !== null && c !== undefined);
      const realStrings = nonEmpty.filter((c: any) => typeof c === "string" && !/^[\u{1F300}-\u{1FFFF}]/u.test(String(c)));
      if (realStrings.length >= 2) { headerIdx = i; break; }
    }
    const headers = (raw[headerIdx] as any[]).map((h: any, i: number) =>
      (h !== "" && h !== null ? String(h).trim() : `_c${i}`)
    );
    return raw.slice(headerIdx + 1)
      .filter((row: any[]) => row.some((c: any) => c !== "" && c !== null && c !== undefined))
      .map((row: any[]) => {
        const obj: Record<string, any> = {};
        headers.forEach((h: string, i: number) => { obj[h] = row[i] ?? ""; });
        return obj;
      });
  };

  // Check for a month-specific tab: ReplitNumbers[Month] e.g. "ReplitNumbersMarch"
  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthTabMatch = workbook.SheetNames.find(s => {
    const lower = s.trim().toLowerCase();
    return monthNames.some(m => lower === `replitnumbers${m}`);
  });
  const monthTabRows = monthTabMatch ? readSheet(monthTabMatch) : [];
  const replitHistoricalRows = readSheet("ReplitNumbers");

  // Helper: parse a row's pickup/delivery date into { month, year }
  const getRowMonthYear = (r: any): { month: number; year: number } | null => {
    const dateVal = r["Pickup Date"] ?? r["pickup date"] ?? r["Pickup date"] ??
                    r["Delivery date"] ?? r["Delivery Date"] ?? r["delivery date"] ??
                    r["Date"] ?? r["date"] ?? "";
    if (!dateVal && dateVal !== 0) return null;
    let d: Date | null = null;
    if (typeof dateVal === "number" && dateVal > 40000) {
      d = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
    } else {
      const parsed = new Date(String(dateVal).trim());
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d || isNaN(d.getTime())) return null;
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  };

  let rows: any[];
  if (monthTabRows.length > 0 && replitHistoricalRows.length > 0) {
    // The month tab is the exclusive source for its month; strip it from ReplitNumbers.
    const monthIndex = monthNames.findIndex(m => monthTabMatch!.trim().toLowerCase() === `replitnumbers${m}`);
    const currentMonthNum = monthIndex + 1;
    const currentYear = new Date().getFullYear();
    const historicalFiltered = replitHistoricalRows.filter(r => {
      const my = getRowMonthYear(r);
      if (!my) return true;
      return !(my.month === currentMonthNum && my.year === currentYear);
    });
    rows = [...historicalFiltered, ...monthTabRows];
  } else if (monthTabRows.length > 0) {
    rows = monthTabRows;
  } else if (replitHistoricalRows.length > 0) {
    rows = replitHistoricalRows;
  } else {
    const boraRaw: any[] = readSheet("YTD BORA");
    if (boraRaw.length > 0) {
      const filtered = boraRaw.filter((r: any) => {
        const rc = (r["Revenue code"] || r["Revenue Code"] || "").toString().trim().toUpperCase();
        return rc === "UTAHB";
      });
      rows = filtered.length > 0 ? filtered : boraRaw;
    } else {
      const altRows = readSheet("All Data (YTD)");
      if (altRows.length > 0) {
        rows = altRows;
      } else {
        // Last resort: read the sheet with the most data rows
        const bestSheetName = workbook.SheetNames.reduce((best, name) => {
          const sh = workbook.Sheets[name];
          const len = (XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" }) as any[][]).length;
          const bestLen = (XLSX.utils.sheet_to_json(workbook.Sheets[best], { header: 1, defval: "" }) as any[][]).length;
          return len > bestLen ? name : best;
        }, workbook.SheetNames[0]);
        rows = readSheet(bestSheetName);
      }
    }
  }
  return {
    rows,
    bestDealDaysSpot:  readSheet("Best Deal Days (SPOT)"),
    bestDealDaysAll:   readSheet("Best Deal Days (ALL)"),
    trendAnalysis:     readSheet("Trend Analysis"),
    averagesData:      readSheet("Averages"),
    dailyAcquisition:  readSheetSmart("Daily Acquisition Data"),
  };
}
