import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerChatbotRoutes } from "./chatbot";
import { readFileSync } from "fs";
import { join } from "path";
import multer from "multer";
import XLSX from "xlsx";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds, canAccessCompany } from "./auth";
import { geocodeCity, haversineDistance } from "./geocoding";
import { insertCompanySchema, insertContactSchema, insertRfpSchema, insertAwardSchema, insertTaskSchema, userRoles, insertCalloutSchema, insertFeedPostSchema, type Callout, insertOneOnOneTopicSchema, type User, sharedRepSchema, type SharedRep, contactBaseHistory, insertLaneCarrierSchema } from "@shared/schema";
import { performOneDriveSync } from "./monthlyDataRefreshScheduler";
import { resolveColumns, getRepFromRow, getDispatcherFromRow, getSalespersonFromRow, getStatusFromRow, getCustomerFromRow, type FinancialCols } from "./colResolver";
import { analyzeTouchpointNote } from "./aiTouchpoint";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "./cache";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { db } from "./storage";
import { sql } from "drizzle-orm";

// Customer/ops-user codes that must never appear in any financial report, summary, or aggregation.
const EXCLUDED_FINANCIAL_CODES = new Set(["valubuaz"]);

/** Returns true if a financial row should be excluded from all processing. */
function isExcludedRow(row: any, cols: FinancialCols): boolean {
  const customer = getCustomerFromRow(row, cols).toLowerCase();
  const rep = getRepFromRow(row, cols).toLowerCase();
  for (const code of EXCLUDED_FINANCIAL_CODES) {
    if (customer.includes(code) || rep.includes(code)) return true;
  }
  return false;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const zipCodeMap: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "server", "zipcodes.json"), "utf-8")
);

// Build 3-digit zip prefix → best representative city map at startup
const zipPrefixMap: Record<string, string> = (() => {
  const prefixCities: Record<string, Record<string, number>> = {};
  for (const [zip, city] of Object.entries(zipCodeMap)) {
    const prefix = zip.substring(0, 3);
    if (!prefixCities[prefix]) prefixCities[prefix] = {};
    prefixCities[prefix][city] = (prefixCities[prefix][city] || 0) + 1;
  }
  const result: Record<string, string> = {};
  for (const [prefix, cities] of Object.entries(prefixCities)) {
    const best = Object.entries(cities).sort((a, b) => b[1] - a[1])[0];
    if (best) result[prefix] = best[0]; // e.g. "217" -> "Hagerstown, MD"
  }
  return result;
})();

function findSheetByName(workbook: XLSX.WorkBook, preferredName: string): string {
  const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === preferredName.toLowerCase());
  return match || workbook.SheetNames[0];
}

// Guard against bad summary rows (documentation/description strings stored instead of real customer data)
function isBadSummaryData(rows: any[]): boolean {
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

/**
 * Count loads, total margin, and total charges for a rep goal.
 * LMs are attributed via the Dispatcher column; AMs/NAMs/sales via Operations User.
 */
function computeLoadsForRepGoal(
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
    totalMargin += Number(row[cols.marginDollar] || row["Margin $"] || 0);
    totalCharges += Number(row[cols.totalCharges] || row["Total charges"] || 0);
  }
  return { loads, totalMargin, totalCharges };
}

function extractSheetsFromWorkbook(workbook: XLSX.WorkBook) {
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
    const headers = (raw[headerIdx] as any[]).map((h: any, i: number) => (h !== "" && h !== null ? String(h).trim() : `_c${i}`));
    return raw.slice(headerIdx + 1)
      .filter((row: any[]) => row.some((c: any) => c !== "" && c !== null && c !== undefined))
      .map((row: any[]) => {
        const obj: Record<string, any> = {};
        headers.forEach((h: string, i: number) => { obj[h] = row[i] ?? ""; });
        return obj;
      });
  };

  // Check for a month-specific tab: ReplitNumbers[Month] e.g. "ReplitNumbersMarch"
  // If present, merge it with the ReplitNumbers historical tab so trends get full history
  // and account-summary gets the accurate current-month data.
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
      // Excel date serial
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
    // The month tab (e.g. ReplitNumbersMarch) is the exclusive source for its month.
    // Strip that month from ReplitNumbers so data isn't mixed or double-counted.
    const monthIndex = monthNames.findIndex(m => monthTabMatch!.trim().toLowerCase() === `replitnumbers${m}`);
    const currentMonthNum = monthIndex + 1; // 1-based (March = 3)
    const currentYear = new Date().getFullYear();
    const historicalFiltered = replitHistoricalRows.filter(r => {
      const my = getRowMonthYear(r);
      if (!my) return true; // Can't determine date — keep it
      return !(my.month === currentMonthNum && my.year === currentYear);
    });
    // Historical months from ReplitNumbers + current month exclusively from the month tab
    rows = [...historicalFiltered, ...monthTabRows];
  } else if (monthTabRows.length > 0) {
    rows = monthTabRows;
  } else if (replitHistoricalRows.length > 0) {
    rows = replitHistoricalRows;
  } else {
    const boraRaw: any[] = readSheet("YTD BORA");
    if (boraRaw.length > 0) {
      // NUMBERS.xlsx format: filter YTD BORA to Value Truck rows only
      const filtered = boraRaw.filter((r: any) => {
        const rc = (r["Revenue code"] || r["Revenue Code"] || "").toString().trim().toUpperCase();
        return rc === "UTAHB";
      });
      // If UTAHB filter yields nothing, use all BORA rows (different revenue code naming)
      rows = filtered.length > 0 ? filtered : boraRaw;
    } else {
      // No YTD BORA sheet — try "All Data (YTD)" (legacy sheet name)
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
    bestDealDaysSpot: readSheet("Best Deal Days (SPOT)"),
    bestDealDaysAll: readSheet("Best Deal Days (ALL)"),
    trendAnalysis: readSheet("Trend Analysis"),
    averagesData: readSheet("Averages"),
    dailyAcquisition: readSheetSmart("Daily Acquisition Data"),
  };
}

async function getVisibleFeedAuthorIds(user: { id: string; role: string; managerId: string | null; organizationId: string }): Promise<string[]> {
  if (user.role === "admin") {
    const orgUsers = await storage.getUsers(user.organizationId);
    return orgUsers.map(u => u.id);
  }
  if (user.role === "director" || user.role === "sales_director") {
    const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
    ids.push(user.id);
    return ids;
  }
  if (user.role === "national_account_manager" || user.role === "sales") {
    const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
    if (user.managerId) ids.push(user.managerId);
    ids.push(user.id);
    return ids;
  }
  const ids = new Set<string>([user.id]);
  if (user.managerId) ids.add(user.managerId);
  return Array.from(ids);
}

const ZIP_REGEX = /^\d{5}(-\d{4})?$/;

function zipToCity(value: string): string {
  const trimmed = value.trim();
  // Handle 3-digit zip prefix (e.g. "217" from Staples-style RFPs)
  if (/^\d{3}$/.test(trimmed)) {
    return zipPrefixMap[trimmed] || trimmed;
  }
  if (!ZIP_REGEX.test(trimmed)) return trimmed;
  const zip5 = trimmed.substring(0, 5);
  return zipCodeMap[zip5] || trimmed;
}

function selectBestRfpSheet(workbook: XLSX.WorkBook): string {
  const laneKeywords = ["origin", "dest", "volume", "load", "ship", "from", "to", "lane", "state", "city", "zip", "rate", "qty", "pickup", "delivery", "equipment", "trailer", "mode", "annual", "corridor", "sf", "st", "freq", "temp"];
  const skipPatterns = [/^(cover|summary|index|instructions?|notes?|legend|glossary|overview|readme|terms|conditions|contacts?|intro)/i];

  let bestSheet = workbook.SheetNames[0];
  let bestScore = -1;

  for (const name of workbook.SheetNames) {
    if (skipPatterns.some(p => p.test(name.trim()))) continue;

    const sheet = workbook.Sheets[name];
    const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rawAll.length < 2) continue;

    // Count non-empty data rows (rows that have at least one non-empty cell)
    const dataRows = rawAll.filter(row => row.some(cell => cell !== "" && cell !== null && cell !== undefined));
    const rowCount = Math.max(0, dataRows.length - 1); // subtract header row

    // Score the first 15 rows for lane/freight keywords (header detection)
    let keywordScore = 0;
    for (let i = 0; i < Math.min(15, rawAll.length); i++) {
      const rowStr = rawAll[i].join(" ").toLowerCase();
      keywordScore = Math.max(keywordScore, laneKeywords.filter(kw => rowStr.includes(kw)).length);
    }

    // Final score: rows weighted heavily, with a small keyword bonus
    // Sheets with zero keyword matches but lots of rows still win over tiny relevant sheets
    const score = rowCount * 10 + keywordScore * 5;

    if (score > bestScore) {
      bestScore = score;
      bestSheet = name;
    }
  }

  return bestSheet;
}

function analyzeRfpSpreadsheet(workbook: XLSX.WorkBook) {
  const sheetName = selectBestRfpSheet(workbook);
  const sheet = workbook.Sheets[sheetName];

  // First, try to find the real header row by scanning first 15 rows as raw arrays
  const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (rawAll.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0 } };
  }

  const headerKeywords = ["origin", "dest", "volume", "load", "ship", "from", "to", "lane", "state", "city", "zip", "rate", "qty", "pickup", "delivery", "sf", "st", "freq", "temp"];
  let headerRowIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < Math.min(15, rawAll.length); i++) {
    const rowStr = rawAll[i].join(" ").toLowerCase();
    const score = headerKeywords.filter(kw => rowStr.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = i;
    }
  }

  // Build rows from the detected header row
  let rows: Record<string, any>[];
  let headers: string[];

  if (bestScore >= 2) {
    // Use detected header row
    headers = rawAll[headerRowIdx].map((h: any, i: number) => (h !== "" && h !== null) ? String(h).trim() : `col_${i}`);
    rows = rawAll.slice(headerRowIdx + 1).map((row: any[]) => {
      const obj: Record<string, any> = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    }).filter(r => Object.values(r).some(v => v !== "" && v !== null));
  } else {
    // Fallback: use first row as headers (original behavior)
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  }

  if (rows.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0 } };
  }

  const headerLower = headers.map(h => h.toLowerCase());

  const findCol = (keywords: string[]) => {
    for (const kw of keywords) {
      const idx = headerLower.findIndex(h => h.includes(kw));
      if (idx >= 0) return headers[idx];
    }
    return null;
  };

  let originCol = findCol(["origin city", "orig city", "from city", "o_city", "origin_city"]);
  if (!originCol) originCol = findCol(["origin zip", "orig zip", "from zip", "o_zip", "origin_zip", "from_zip"]);
  if (!originCol) originCol = findCol(["origin", "orig", "pickup", "ship from", "sf location", "sf loc", "ship from location", "from"]);

  let destCol = findCol(["destination city", "dest city", "to city", "d_city", "destination_city"]);
  if (!destCol) destCol = findCol(["destination zip", "dest zip", "to zip", "d_zip", "destination_zip", "to_zip"]);
  if (!destCol) destCol = findCol(["destination", "dest", "delivery", "ship to", "st location", "st loc", "ship to location", "to"]);

  const originStateCol = findCol(["origin_state", "origin state", "o_state", "from_state", "from state", "orig state", "orig_state"]);
  const destStateCol = findCol(["destination state", "destination_state", "dest_state", "dest state", "to_state", "to state", "d_state"]);
  let volumeCol = findCol(["annual volume", "annual loads", "annual shipments", "yearly volume", "yearly loads"]);
  if (!volumeCol) volumeCol = findCol(["volume", "loads", "shipments", "qty", "quantity"]);
  if (!volumeCol) volumeCol = findCol(["weekly volume", "weekly loads", "weekly shipments", "wkly"]);
  if (!volumeCol) volumeCol = findCol(["monthly frequency", "monthly freq", "frequency", "freq"]);
  const rateCol = findCol(["rate", "price", "cost", "target", "rpm"]);
  let laneCol = findCol(["lane_id", "lane id", "lane name", "lane_name", "lane #", "lane#", "lane"]);
  const equipmentCol = findCol(["equipment name", "equipment type", "equipment code", "equip name", "equip type", "equipment", "equip", "trailer type", "trailer", "mode", "temp"]);

  // Fallback: if no volume column found by keyword, auto-detect from column content
  let isWeeklyVolume = false;
  let isMonthlyVolume = false;
  if (!volumeCol) {
    // Exclude already-mapped columns so address strings (with embedded ZIP codes) aren't mistaken for volume
    const mappedCols = new Set([originCol, destCol, originStateCol, destStateCol, rateCol, laneCol, equipmentCol].filter(Boolean) as string[]);

    // Find the column with the most numeric values (potential volume)
    let bestNumericCol: string | null = null;
    let bestNumericCount = 0;
    for (const h of headers) {
      if (mappedCols.has(h)) continue;
      const numericValues = rows.map(r => parseFloat(String(r[h] || "").replace(/[^0-9.]/g, ""))).filter(v => !isNaN(v) && v > 0);
      if (numericValues.length > bestNumericCount) {
        // Skip columns where most values look like ZIP codes (5-digit integers 10000-99999)
        const zipLikeCount = numericValues.filter(v => Number.isInteger(v) && v >= 10000 && v <= 99999).length;
        if (zipLikeCount > numericValues.length * 0.5) continue;
        bestNumericCount = numericValues.length;
        bestNumericCol = h;
      }
    }
    if (bestNumericCol && bestNumericCount > rows.length * 0.3) {
      volumeCol = bestNumericCol;
      // If max value is small (<= 31), it's likely monthly loads
      // If max value is small (<= 52), it's likely weekly loads
      const numericVals = rows.map(r => parseFloat(String(r[bestNumericCol!] || "").replace(/[^0-9.]/g, ""))).filter(v => !isNaN(v));
      const maxVal = numericVals.length > 0 ? Math.max(...numericVals) : 0;
      if (numericVals.length > 0 && maxVal <= 31) {
        isMonthlyVolume = true;
      } else if (numericVals.length > 0 && maxVal <= 52) {
        isWeeklyVolume = true;
      }
    }
  } else {
    // Check if the detected volume column has small values suggesting weekly or monthly cadence
    const colHeader = volumeCol.toLowerCase();
    if (colHeader.includes("week") || colHeader.includes("wkly")) {
      isWeeklyVolume = true;
    } else if (colHeader.includes("month") || colHeader.includes("freq")) {
      isMonthlyVolume = true;
    }
  }

  // If no lane/origin/dest columns found, try to detect from text columns
  if (!laneCol && !originCol && !destCol) {
    // Find column with the most text content that looks like lane descriptions
    for (const h of headers) {
      const textValues = rows.map(r => String(r[h] || "")).filter(v => v.length > 3 && /[a-zA-Z]/.test(v));
      if (textValues.length > rows.length * 0.3) {
        if (!laneCol) {
          laneCol = h;
          break;
        }
      }
    }
  }

  const originStates = new Set<string>();
  const destStates = new Set<string>();
  let totalVolume = 0;

  const highVolumeLanes: Record<string, any>[] = [];

  for (const row of rows) {
    if (originStateCol && row[originStateCol]) {
      originStates.add(String(row[originStateCol]).trim().toUpperCase());
    }
    if (destStateCol && row[destStateCol]) {
      destStates.add(String(row[destStateCol]).trim().toUpperCase());
    }

    let rowVolume = 0;
    if (volumeCol && row[volumeCol] !== "" && row[volumeCol] !== null) {
      const v = parseFloat(String(row[volumeCol]).replace(/[^0-9.]/g, ""));
      if (!isNaN(v) && v > 0) {
        const annualV = isWeeklyVolume ? v * 52 : isMonthlyVolume ? v * 12 : v;
        totalVolume += annualV;
        rowVolume = annualV;
      }
    }

    if (rowVolume > 50) {
      const rawOrigin = originCol ? String(row[originCol] || "").trim() : "";
      const rawDest = destCol ? String(row[destCol] || "").trim() : "";
      const originCity = zipToCity(rawOrigin);
      const destCity = zipToCity(rawDest);
      const oState = originStateCol ? String(row[originStateCol] || "").trim() : "";
      const dState = destStateCol ? String(row[destStateCol] || "").trim() : "";
      const laneName = laneCol ? String(row[laneCol] || "").trim() : "";

      const originPart = originCity ? `${originCity}${oState ? `, ${oState}` : ""}` : oState;
      const destPart = destCity ? `${destCity}${dState ? `, ${dState}` : ""}` : dState;
      const cityDescription = originPart && destPart ? `${originPart} → ${destPart}` : originPart || destPart || "";

      const laneDescription = cityDescription || laneName || "Unknown Lane";

      highVolumeLanes.push({
        lane: laneDescription,
        laneId: laneName || "",
        origin: originCity || rawOrigin || oState || "",
        destination: destCity || rawDest || dState || "",
        originState: oState,
        destinationState: dState,
        volume: rowVolume,
        rate: rateCol ? String(row[rateCol] || "") : "",
        equipment: equipmentCol ? String(row[equipmentCol] || "") : "",
        rawRow: row,
      });
    }
  }

  highVolumeLanes.sort((a, b) => b.volume - a.volume);

  return {
    rows: rows.slice(0, 100),
    headers,
    highVolumeLanes,
    sheetName,
    analysis: {
      laneCount: rows.length,
      totalVolume: String(Math.round(totalVolume)),
      originStates: Array.from(originStates).sort(),
      destinationStates: Array.from(destStates).sort(),
      volumeColumn: volumeCol,
      rateColumn: rateCol,
      originColumn: originCol || originStateCol,
      destinationColumn: destCol || destStateCol,
      highVolumeLaneCount: highVolumeLanes.length,
      isWeeklyVolume,
      isMonthlyVolume,
    },
  };
}

// Standard field types for RFP column mapping
type RfpFieldType = "origin_city" | "origin_state" | "origin_zip" | "dest_city" | "dest_state" | "dest_zip" | "volume" | "equipment" | "lane_id" | "miles" | "ignore";

type ConfirmedColumnMapping = Record<string, RfpFieldType>;

function analyzeRfpSpreadsheetWithMapping(workbook: XLSX.WorkBook, confirmedMapping: ConfirmedColumnMapping) {
  const sheetName = selectBestRfpSheet(workbook);
  const sheet = workbook.Sheets[sheetName];

  const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (rawAll.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], sheetName, analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0, isWeeklyVolume: false, isMonthlyVolume: false, volumeColumn: null, rateColumn: null, originColumn: null, destinationColumn: null } };
  }

  // Detect header row using same heuristic
  const headerKeywords = ["origin", "dest", "volume", "load", "ship", "from", "to", "lane", "state", "city", "zip", "rate", "qty", "pickup", "delivery"];
  let headerRowIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < Math.min(15, rawAll.length); i++) {
    const rowStr = rawAll[i].join(" ").toLowerCase();
    const score = headerKeywords.filter(kw => rowStr.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = i;
    }
  }

  let rows: Record<string, any>[];
  let headers: string[];

  if (bestScore >= 2) {
    headers = rawAll[headerRowIdx].map((h: any, i: number) => (h !== "" && h !== null) ? String(h).trim() : `col_${i}`);
    rows = rawAll.slice(headerRowIdx + 1).map((row: any[]) => {
      const obj: Record<string, any> = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    }).filter(r => Object.values(r).some(v => v !== "" && v !== null));
  } else {
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  }

  if (rows.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], sheetName, analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0, isWeeklyVolume: false, isMonthlyVolume: false, volumeColumn: null, rateColumn: null, originColumn: null, destinationColumn: null } };
  }

  // Build reverse lookup: fieldType -> column header
  const fieldToCol = (field: RfpFieldType): string | null => {
    for (const [col, f] of Object.entries(confirmedMapping)) {
      if (f === field) return col;
    }
    return null;
  };

  const originCityCol = fieldToCol("origin_city");
  const originStateCol = fieldToCol("origin_state");
  const originZipCol = fieldToCol("origin_zip");
  const destCityCol = fieldToCol("dest_city");
  const destStateCol = fieldToCol("dest_state");
  const destZipCol = fieldToCol("dest_zip");
  const volumeCol = fieldToCol("volume");
  const equipmentCol = fieldToCol("equipment");
  const laneIdCol = fieldToCol("lane_id");
  const milesCol = fieldToCol("miles");

  // Determine volume cadence from column name (weekly or monthly)
  let isWeeklyVolume = false;
  let isMonthlyVolume = false;
  if (volumeCol) {
    const colLower = volumeCol.toLowerCase();
    if (colLower.includes("week") || colLower.includes("wkly")) {
      isWeeklyVolume = true;
    } else if (colLower.includes("month") || colLower.includes("mthly") || colLower.includes("mo ") || colLower.includes("mo.")) {
      isMonthlyVolume = true;
    } else {
      // Auto-detect: if max value <= 52, likely weekly
      const numericVals = rows.map(r => parseFloat(String(r[volumeCol!] || "").replace(/[^0-9.]/g, ""))).filter(v => !isNaN(v) && v > 0);
      const maxVal = numericVals.length > 0 ? Math.max(...numericVals) : 0;
      if (numericVals.length > 0 && maxVal <= 52) isWeeklyVolume = true;
    }
  }

  const originStates = new Set<string>();
  const destStates = new Set<string>();
  let totalVolume = 0;
  const highVolumeLanes: Record<string, any>[] = [];

  for (const row of rows) {
    const oState = originStateCol ? String(row[originStateCol] || "").trim() : "";
    const dState = destStateCol ? String(row[destStateCol] || "").trim() : "";
    if (oState) originStates.add(oState.toUpperCase());
    if (dState) destStates.add(dState.toUpperCase());

    let rowVolume = 0;
    if (volumeCol && row[volumeCol] !== "" && row[volumeCol] !== null) {
      const v = parseFloat(String(row[volumeCol]).replace(/[^0-9.]/g, ""));
      if (!isNaN(v) && v > 0) {
        const annualV = isWeeklyVolume ? v * 52 : isMonthlyVolume ? v * 12 : v;
        totalVolume += annualV;
        rowVolume = annualV;
      }
    }

    if (rowVolume > 50) {
      // Resolve origin
      const rawOriginCity = originCityCol ? String(row[originCityCol] || "").trim() : "";
      const rawOriginZip = originZipCol ? String(row[originZipCol] || "").trim() : "";
      const originCity = rawOriginCity || zipToCity(rawOriginZip);

      // Resolve dest
      const rawDestCity = destCityCol ? String(row[destCityCol] || "").trim() : "";
      const rawDestZip = destZipCol ? String(row[destZipCol] || "").trim() : "";
      const destCity = rawDestCity || zipToCity(rawDestZip);

      const laneName = laneIdCol ? String(row[laneIdCol] || "").trim() : "";
      const originPart = originCity ? `${originCity}${oState ? `, ${oState}` : ""}` : oState;
      const destPart = destCity ? `${destCity}${dState ? `, ${dState}` : ""}` : dState;
      const cityDescription = originPart && destPart ? `${originPart} → ${destPart}` : originPart || destPart || "";
      const laneDescription = cityDescription || laneName || "Unknown Lane";

      const rawMiles = milesCol ? parseFloat(String(row[milesCol] || "").replace(/[^0-9.]/g, "")) : NaN;
      highVolumeLanes.push({
        lane: laneDescription,
        laneId: laneName || "",
        origin: originCity || rawOriginZip || oState || "",
        destination: destCity || rawDestZip || dState || "",
        originState: oState,
        destinationState: dState,
        volume: rowVolume,
        equipment: equipmentCol ? String(row[equipmentCol] || "") : "",
        miles: !isNaN(rawMiles) && rawMiles > 0 ? rawMiles : null,
        rawRow: row,
      });
    }
  }

  highVolumeLanes.sort((a, b) => b.volume - a.volume);

  return {
    rows: rows.slice(0, 100),
    headers,
    highVolumeLanes,
    sheetName,
    analysis: {
      laneCount: rows.length,
      totalVolume: String(Math.round(totalVolume)),
      originStates: Array.from(originStates).sort(),
      destinationStates: Array.from(destStates).sort(),
      highVolumeLaneCount: highVolumeLanes.length,
      isWeeklyVolume,
      originColumn: originCityCol || originZipCol || originStateCol,
      destinationColumn: destCityCol || destZipCol || destStateCol,
      volumeColumn: volumeCol,
    },
  };
}

function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseHistoricalRow(row: any, cols?: FinancialCols): {
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
    const destRaw  = String(row[destK]      || "").trim();
    const destState = String(row[destStateK] || "").trim();
    const destCity  = destRaw.includes(",") ? destRaw.split(",")[0].trim() : destRaw;
    const origRaw   = String(row[origK]     || "").trim();
    const origState = String(row[origStateK] || "").trim();
    const origCity  = origRaw.includes(",") ? origRaw.split(",")[0].trim() : origRaw;
    const weekRaw   = String(row[weekK]     || "").trim();
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
    return { destCity, destState, origCity, origState, weekKey, monthKey, margin: Number(row[marginK]) || 0, revenue: Number(row[revenueK]) || 0 };
  }

  // TMS / ReplistNumbers format
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    if (req.path === "/demo-requests" && req.method === "POST") return next();
    // Public Stripe endpoints (no auth required — landing page checkout flow)
    if (req.path === "/stripe/config" && req.method === "GET") return next();
    if (req.path === "/stripe/products" && req.method === "GET") return next();
    if (req.path === "/stripe/checkout" && req.method === "POST") return next();
    if (req.path === "/stripe/confirm-checkout" && req.method === "GET") return next();
    if (req.path === "/marketing-chat" && req.method === "POST") return next();
    requireAuth(req, res, next);
  });

  registerChatbotRoutes(app);

  // ── Public marketing chatbot (landing page, no auth required) ──────────────
  const MARKETING_SYSTEM_PROMPT = `You are Dana, the Freight DNA sales assistant. You help freight brokers learn about the Freight DNA platform and decide if it's the right fit for their team. You are warm, knowledgeable, and consultative — not pushy. You ask good questions, listen, and give honest answers. When it makes sense, you encourage prospects to schedule a live demo.

ABOUT FREIGHT DNA:
Freight DNA is a purpose-built sales intelligence and CRM platform designed exclusively for transportation brokerage companies. Core philosophy: "Down, not across" — the highest-ROI growth path for most brokerages is unlocking wallet share in accounts they already own, not just chasing new logos.

PRICING:
All plans start with a demo — we do a call first to make sure it's the right fit before anyone signs.
- Trial: $1,000 for the first month. Includes full platform access, hands-on setup, data import, team configuration, and training. No commitment beyond the trial month.
- Standard: $1,500/month (or $1,200/month billed annually — 20% savings). Full platform, up to 50 team members, all 20+ modules, all AI features, dedicated onboarding support. No per-seat fees.
- Enterprise: $2,000/month (or $1,600/month billed annually — 20% savings). For brokerages with 50+ team members. Everything in Standard plus unlimited seats, dedicated account manager, multi-org/multi-team support, and priority feature development. No per-seat fees.
- Custom Feature Buildout: Quoted per project based on scope and complexity. Simple additions are quick, easy, and start around $500; larger integrations or standalone modules are scoped individually. Contact info@freight-dna.com to discuss.

ONBOARDING:
- Most brokerages are fully live within one week.
- We handle everything: data import, team configuration, workflow setup, training.
- No IT or Salesforce consultants needed.
- Platform is configurable to match how the brokerage actually operates.
- Ongoing flexibility: new features, reports, and workflows can be requested and built quickly.

ROLES SUPPORTED:
Admin (full access, billing, user management), Director (all teams, rep performance), National Account Manager/NAM (team of AMs, goal setting, 1:1s, own book), Account Manager/AM (front-line rep, accounts, contacts, touchpoints), Logistics Manager, Logistics Coordinator. Role-based access means every user sees only what's relevant to their job.

CORE MODULES (22+):
1. Dashboard — role-aware, KPI cards, daily briefing, activity streaks, alerts for cold contacts, RFP deadlines, tasks due
2. Customer/Account Management — rich company profiles, wallet share calculation, health scores, momentum scores, financial snapshots, transportation-specific fields (portal credentials, tendering process, account quirks, operating hours, shipping modes: LTL/FTL/Drayage/IMDL)
3. Contacts & Org Charts — visual org charts, decision-maker mapping, relationship base tracking (1st/2nd/3rd Base/Home Run system), relationship history timeline, lane attributions, contact freight reporting
4. Touchpoint Logging — log calls, emails, texts, site visits in one click from anywhere; automated alerts for cold contacts; daily activity streak tracking
5. Sales Pipeline — Kanban board for prospects; CSV import with template and failed-row recovery; AI Sales Intel Brief generation on prospects; stage-change tracking
6. Pre-Call Planner — AI health narrative, AI touchpoint summary (last 5 notes), lane gap talking points, relationship intel, quick touchpoint log
7. RFP & Award Management — full bid lifecycle, Excel upload with AI column mapping, lane-level analysis, deadline alerts, award tracking vs. bids
8. Goals & Accountability — NAMs set goals for AMs (loads, margin, touchpoints, new contacts); auto-tracking against live data; goal comments
9. 1:1 Sessions — structured manager-rep meetings, threaded topic replies, session summaries, morale tracking, meeting links, automated reminders
10. Team Performance Dashboards — activity metrics, load/margin tracking, leaderboards, rep scorecards, period-over-period trends
11. Top Opportunities — auto-surfaced accounts by untapped wallet share, greenfield accounts flagged
12. Tasks — create/assign/track tasks on accounts and contacts, due dates, comments, dashboard alerts
13. PTO Passoff — structured account coverage during rep absences, covering notes per account, automated return workflow
14. Financial Data & Lane Analytics — Excel/CSV upload or OneDrive auto-sync, load attribution to contacts/relationships, wallet share calc, interactive maps, coverage gap analysis
15. Carrier Lane Search — search financial upload history by corridor (origin + destination + radius) to build an instant carrier call list: every carrier that has run the lane, loads hauled, market share %, avg carrier pay, avg margin, and last ship date — all grouped by mode (Van, Reefer, Flatbed, LTL, Drayage, IMDL). Perfect for when freight drops and you need coverage fast.
16. RFP Lane Search — search across ALL uploaded RFPs in the platform by corridor. Instantly see which customers have freight on specific lanes, what volumes they're bidding, and what equipment they need — grouped by mode. Find your next bid target before the RFP even hits your inbox.
17. DNA Guru Chatbot — natural language Q&A against live CRM data; can log touchpoints and create tasks via confirmed AI proposals; proactive nudges for goals behind, cold contacts, urgent RFPs; PLUS live carrier lane search: ask "what carriers run TX-CA for dry vans?" or "how much are we paying CA-TX?" and get a real-time answer from your own freight data
18. Daily Digest Emails — personalized weekday morning emails with tasks, cold contacts, RFP deadlines, goal progress, AI "Priority for Today"
19. Shared Callouts & Trends Feed — internal broadcast for market intel, lane trends, carrier notes; posts can be pinned
20. Career Progression Tracking — development goals, promotion criteria, nomination workflow
21. Coordinator's Corner — centralized secure storage for customer portal credentials and tendering procedures
22. Feedback Inbox — reps submit feedback; admins respond; submitter notified by email

AI FEATURES:
- AI Sales Intel Brief: one-click prospect intelligence (freight profile, pain points, network overlap, conversation starters, competitive tips) — powered by GPT-4o-mini
- AI Health Score Narrative: 2-sentence GPT-4o-mini explanation of why an account is healthy or at-risk
- AI Touchpoint Summary: auto-summarizes last 5 touchpoint notes for pre-call prep
- Lane Gap Talking Points: AI-generated conversation starters for uncovered freight corridors
- Lane Gap Priority Scoring: High/Medium/Low badges ranked by volume, RFP presence, award status
- DNA Guru Chatbot: natural language CRM queries + action execution (log touchpoint, create task); live carrier lane search via natural language ("what carriers run TX-CA for dry vans?", "how much are we paying CA-TX?")
- Proactive Nudges: chatbot surfaces goals behind, cold contacts, urgent RFPs, tasks due today
- Carrier Lane Search: instant carrier call list from financial history by corridor and mode
- RFP Lane Search: find which customers have freight on specific lanes across all uploaded RFPs, grouped by mode
- RFP Column Mapping: AI suggests which Excel columns map to required RFP data fields
- Daily Brief "Priority for Today": AI-generated daily focus suggestion
- Auto-Intel on Stage Change: brief auto-generates when a prospect first moves pipeline stages

KEY DIFFERENTIATORS vs. Salesforce/HubSpot:
- Built exclusively for freight brokerage — lane data, wallet share, RFPs, shipping modes are native
- 1st/2nd/3rd Base/Home Run relationship depth system (not just contact volume)
- Actual freight loads attributed to specific relationships — dollar impact per contact
- Wallet share as a core metric, not just revenue
- Flat pricing — no per-seat fees
- Done-for-you setup in ~1 week
- Responsive development — feature requests move fast

RULES FOR YOUR RESPONSES:
- Keep answers concise and conversational. Don't dump every feature at once.
- Ask follow-up questions to understand their situation before making recommendations.
- If they ask about pricing, be direct: Trial is $1,000 for the first month, Standard is $1,500/month (or $1,200 billed annually), Enterprise is $2,000/month (or $1,600 billed annually). All plans are flat — no per-seat fees.
- If they seem interested or ask about next steps, suggest scheduling a demo.
- If they ask something you don't know, say so honestly and suggest they schedule a demo to get the full picture.
- Do not make up features or pricing that aren't described above.
- Never be defensive or argue. If they have a criticism, acknowledge it and pivot to what the platform does well.
- You can sign off messages as "Dana" occasionally but don't overdo it.`;

  app.post("/api/marketing-chat", async (req, res) => {
    try {
      const { messages } = req.body as { messages: { role: string; content: string }[] };
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }
      // Safety: cap conversation history to last 20 messages, content to 2000 chars each
      const safeMessages = messages.slice(-20).map((m: any) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content ?? "").slice(0, 2000),
      }));

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: MARKETING_SYSTEM_PROMPT },
          ...safeMessages,
        ],
        max_tokens: 400,
        temperature: 0.7,
      });
      const reply = completion.choices[0]?.message?.content ?? "Sorry, I couldn't generate a response. Please try again.";
      res.json({ reply });
    } catch (err) {
      console.error("[marketing-chat]", err);
      res.status(500).json({ error: "Failed to generate response" });
    }
  });

  app.get("/api/search", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const q = (req.query.q as string || "").trim();
      if (!q) return res.json({ accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [], tasks: [] });
      const [matchedCompanies, matchedUsers, matchedContacts, matchedRfps, matchedTasks, allCompanies] = await Promise.all([
        storage.searchCompanies(q, req.session.organizationId!),
        storage.searchUsers(q, ["account_manager", "national_account_manager", "director", "sales"], req.session.organizationId!),
        storage.searchContacts(q, req.session.organizationId!),
        storage.searchRfps(q, req.session.organizationId!),
        storage.searchTasks(q, req.session.organizationId!),
        storage.getCompanies(req.session.organizationId!),
      ]);
      const companyNameMap = new Map(allCompanies.map(c => [c.id, c.name]));
      const accounts = matchedCompanies.map(c => ({ id: c.id, name: c.name }));
      const accountManagers = matchedUsers.filter(u => u.role === "account_manager");
      const nationalAccountManagers = matchedUsers.filter(u => u.role === "national_account_manager" || u.role === "director");
      const contacts = matchedContacts.map(c => ({ id: c.id, name: c.name, title: c.title, companyId: c.companyId, companyName: companyNameMap.get(c.companyId) || "" }));
      const rfps = matchedRfps.map(r => ({ id: r.id, title: r.title, companyId: r.companyId, status: r.status }));
      const tasks = matchedTasks.map(t => ({ id: t.id, title: t.title, status: t.status, companyId: t.companyId || null, companyName: t.companyId ? (companyNameMap.get(t.companyId) || "") : "" }));
      res.json({ accounts, accountManagers, nationalAccountManagers, contacts, rfps, tasks });
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.get("/api/users/sales", requireAuth, async (req, res) => {
    try {
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const salesUsers = allUsers
        .filter(u => u.role === "sales" || u.role === "sales_director")
        .map(({ password, ...u }) => u);
      res.json(salesUsers);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sales users" });
    }
  });

  app.get("/api/users", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Access required" });
      }
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      if (currentUser.role === "admin") return res.json(safeUsers);
      const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
      if (req.query.includeManagers === "true") {
        const managerIds = await storage.getManagerChainIds(currentUser.id, currentUser.organizationId);
        const allIds = Array.from(new Set([...teamIds, ...managerIds]));
        return res.json(safeUsers.filter(u => allIds.includes(u.id)));
      }
      return res.json(safeUsers.filter(u => teamIds.includes(u.id)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.post("/api/users", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Access required" });
      }
      const { username, password, name, role, managerId, emailSignature } = req.body;
      if (!username || !password || !name) {
        return res.status(400).json({ error: "Username, password, and name are required" });
      }
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ error: "Username already exists" });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      const isNamOrDirector = currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales" || currentUser.role === "sales_director";
      const requestedRole = role || "account_manager";
      if (!userRoles.includes(requestedRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      const assignedRole = isNamOrDirector ? "account_manager" : requestedRole;
      const assignedManagerId = isNamOrDirector ? currentUser.id : (managerId || null);
      const user = await storage.createUser({
        organizationId: req.session.organizationId!,
        username,
        password: hashedPassword,
        name,
        role: assignedRole,
        managerId: assignedManagerId,
        emailSignature: emailSignature?.trim() || null,
      });
      const { password: _, ...safeUser } = user;
      res.status(201).json(safeUser);
    } catch (error) {
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  app.post("/api/users/bulk-import", upload.single("file"), async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const TITLE_TO_ROLE: Record<string, string> = {
        "Account Manager": "account_manager",
        "Admin": "admin",
        "Logistics Coordinator": "logistics_coordinator",
        "Logistics Manager": "logistics_manager",
        "National Account Manager": "national_account_manager",
        "Sales": "sales",
        "Sales Director": "sales_director",
        "Director": "director",
      };

      const defaultPassword = req.body.defaultPassword || "Shipping123!";
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];

      const hashedPassword = await bcrypt.hash(defaultPassword, 10);
      const created: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];

      for (const row of rows) {
        const name = String(row["display_name"] || "").trim();
        const email = String(row["Email"] || row["user_principle_name"] || "").trim();
        const title = String(row["title"] || "").trim();
        const role = (TITLE_TO_ROLE[title] || "account_manager") as User["role"];

        if (!name || !email) {
          errors.push(`Skipped row — missing name or email`);
          continue;
        }
        const existing = await storage.getUserByUsername(email);
        if (existing) {
          skipped.push(name);
          continue;
        }
        await storage.createUser({ organizationId: req.session.organizationId!, username: email, password: hashedPassword, name, role: (role as any), managerId: null });
        created.push(name);
      }

      res.json({ created, skipped, errors, total: rows.length });
    } catch (error) {
      console.error("Bulk import error:", error);
      res.status(500).json({ error: "Failed to import users" });
    }
  });

  // ── Import templates download ────────────────────────────────────────────
  app.get("/api/import-templates/:type", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });

      const type = req.params.type as string;
      const XLSX = await import("xlsx");
      let wb: any;

      if (type === "users") {
        const ws = XLSX.utils.aoa_to_sheet([
          ["display_name", "Email", "title"],
          ["Jane Smith", "jane@example.com", "Account Manager"],
          ["John Doe", "john@example.com", "National Account Manager"],
        ]);
        wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Users");
      } else if (type === "companies") {
        const ws = XLSX.utils.aoa_to_sheet([
          ["company_name", "industry", "website", "shipping_modes", "estimated_freight_spend", "assigned_rep_email", "account_summary", "financial_alias"],
          ["Acme Corp", "Manufacturing", "https://acme.com", "FTL,LTL", "500000", "rep@example.com", "Key account in Midwest", "ACME"],
          ["Beta Logistics", "Logistics", "https://beta.com", "Drayage,IMDL", "250000", "", "", "BETA"],
        ]);
        wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Companies");
      } else if (type === "contacts") {
        const ws = XLSX.utils.aoa_to_sheet([
          ["contact_name", "company_name", "title", "email", "phone", "relationship_base"],
          ["Alice Johnson", "Acme Corp", "VP of Logistics", "alice@acme.com", "555-1234", "2nd Base"],
          ["Bob Williams", "Beta Logistics", "Director of Ops", "bob@beta.com", "555-5678", "1st Base"],
        ]);
        wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Contacts");
      } else {
        return res.status(400).json({ error: "Invalid template type" });
      }

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${type}-import-template.xlsx"`);
      res.send(buf);
    } catch (error) {
      console.error("Template download error:", error);
      res.status(500).json({ error: "Failed to generate template" });
    }
  });

  // ── Companies bulk import ────────────────────────────────────────────────
  app.post("/api/companies/bulk-import", upload.single("file"), async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const XLSX = await import("xlsx");
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];

      // Build a username→userId map for rep assignment
      const orgUsers = await storage.getUsers(req.session.organizationId!);
      const repMap = new Map<string, string>(orgUsers.map(u => [u.username.toLowerCase(), u.id]));

      const created: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      const toInsert: any[] = [];

      // Pre-load existing company names to detect duplicates
      const existingCompanies = await storage.getCompanies(req.session.organizationId!);
      const existingNames = new Set(existingCompanies.map(c => c.name.toLowerCase().trim()));

      for (const row of rows) {
        const name = String(row["company_name"] || "").trim();
        if (!name) { errors.push("Skipped row — missing company_name"); continue; }
        if (existingNames.has(name.toLowerCase())) { skipped.push(name); continue; }

        const rawModes = String(row["shipping_modes"] || "").trim();
        const shippingModes = rawModes ? rawModes.split(",").map((m: string) => m.trim()).filter(Boolean) : null;

        const assignedRepEmail = String(row["assigned_rep_email"] || "").trim().toLowerCase();
        const assignedTo = assignedRepEmail ? (repMap.get(assignedRepEmail) ?? null) : null;

        const rawSpend = String(row["estimated_freight_spend"] || "").replace(/[^0-9.]/g, "");
        const estimatedFreightSpend = rawSpend ? rawSpend : null;

        toInsert.push({
          organizationId: req.session.organizationId!,
          name,
          industry: String(row["industry"] || "").trim() || null,
          website: String(row["website"] || "").trim() || null,
          accountSummary: String(row["account_summary"] || "").trim() || null,
          financialAlias: String(row["financial_alias"] || "").trim() || null,
          assignedTo,
          shippingModes,
          estimatedFreightSpend,
        });
        existingNames.add(name.toLowerCase());
        created.push(name);
      }

      if (toInsert.length > 0) await storage.bulkCreateCompanies(toInsert);

      res.json({ created, skipped, errors, total: rows.length });
    } catch (error) {
      console.error("Company bulk import error:", error);
      res.status(500).json({ error: "Failed to import companies" });
    }
  });

  // ── Contacts global bulk import ──────────────────────────────────────────
  app.post("/api/contacts/bulk-import", upload.single("file"), async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const XLSX = await import("xlsx");
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];

      // Build company name → id map (org-scoped)
      const orgCompanies = await storage.getCompanies(req.session.organizationId!);
      const companyMap = new Map<string, string>(orgCompanies.map(c => [c.name.toLowerCase().trim(), c.id]));

      const created: string[] = [];
      const errors: string[] = [];
      const toInsert: any[] = [];
      const now = new Date().toISOString();

      for (const row of rows) {
        const contactName = String(row["contact_name"] || "").trim();
        const companyName = String(row["company_name"] || "").trim();
        if (!contactName) { errors.push(`Skipped row — missing contact_name`); continue; }
        if (!companyName) { errors.push(`${contactName} — missing company_name`); continue; }

        const companyId = companyMap.get(companyName.toLowerCase());
        if (!companyId) { errors.push(`${contactName} — company "${companyName}" not found`); continue; }

        toInsert.push({
          companyId,
          name: contactName,
          title: String(row["title"] || "").trim() || null,
          email: String(row["email"] || "").trim() || null,
          phone: String(row["phone"] || "").trim() || null,
          relationshipBase: String(row["relationship_base"] || "").trim() || null,
          createdAt: now,
          createdBy: currentUser.id,
        });
        created.push(`${contactName} (${companyName})`);
      }

      if (toInsert.length > 0) await storage.bulkCreateContacts(toInsert);

      res.json({ created, errors, total: rows.length });
    } catch (error) {
      console.error("Contact bulk import error:", error);
      res.status(500).json({ error: "Failed to import contacts" });
    }
  });

  app.patch("/api/users/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const isSelf = (req.params.id as string) === currentUser.id;
      // Any authenticated user can update their own profile (name, email signature, etc.)
      // Editing another user requires manager-level access
      if (!isSelf) {
        const canEditOthers = currentUser.role === "admin" || currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales" || currentUser.role === "sales_director";
        if (!canEditOthers) return res.status(403).json({ error: "Cannot edit other users" });
        // Managers can only edit their own team members (not arbitrary users)
        if (currentUser.role !== "admin") {
          const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
          if (!teamIds.includes((req.params.id as string))) {
            return res.status(403).json({ error: "Cannot edit this user" });
          }
        }
      }
      const data: any = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.username !== undefined) data.username = req.body.username;
      if (req.body.email !== undefined) data.email = req.body.email || null;
      if (req.body.password) data.password = await bcrypt.hash(req.body.password, 10);
      if (req.body.emailSignature !== undefined) data.emailSignature = req.body.emailSignature?.trim() || null;
      if (currentUser.role === "admin") {
        if (req.body.role !== undefined) {
          if (!userRoles.includes(req.body.role)) {
            return res.status(400).json({ error: "Invalid role" });
          }
          data.role = req.body.role;
        }
        if (req.body.managerId !== undefined) data.managerId = req.body.managerId;
        if (req.body.financialRepId !== undefined) data.financialRepId = req.body.financialRepId || null;
      }
      const user = await storage.updateUser((req.params.id as string), currentUser.organizationId, data);
      if (!user) return res.status(404).json({ error: "User not found" });
      // Invalidate financial summary caches when financialRepId changes so team performance
      // immediately reflects the updated rep attribution without waiting for TTL expiry.
      if (req.body.financialRepId !== undefined) {
        cacheInvalidatePrefix(`account-summary:`);
        cacheInvalidatePrefix(`margin-metrics:`);
        cacheInvalidatePrefix(`dispatcher-summary:`);
        cacheInvalidatePrefix(`leaderboard:`);
      }
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/users/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Access required" });
      }
      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        if (!teamIds.includes((req.params.id as string)) || (req.params.id as string) === currentUser.id) {
          return res.status(403).json({ error: "Cannot delete this user" });
        }
      }
      if ((req.params.id as string) === currentUser.id) {
        return res.status(400).json({ error: "Cannot delete yourself" });
      }
      const deleted = await storage.deleteUser((req.params.id as string), currentUser.organizationId);
      if (!deleted) return res.status(404).json({ error: "User not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  app.get("/api/companies", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      let allCompanies = await storage.getCompanies(req.session.organizationId!);
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        allCompanies = allCompanies.filter(c => visibleIds.includes(c.id));
      }
      const includeArchived = req.query.includeArchived === "true";
      if (!includeArchived) {
        allCompanies = allCompanies.filter(c => !c.archivedAt);
      }
      res.json(allCompanies);
    } catch (error) {
      console.error("Error fetching companies:", error);
      res.status(500).json({ error: "Failed to fetch companies" });
    }
  });

  app.get("/api/companies/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg((req.params.id as string), currentUser.organizationId);
      if (!company) {
        return res.status(404).json({ error: "Company not found" });
      }
      if (!(await canAccessCompany(currentUser, company.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(company);
    } catch (error) {
      console.error("Error fetching company:", error);
      res.status(500).json({ error: "Failed to fetch company" });
    }
  });

  app.get("/api/companies/:id/shared-reps", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg(req.params.id, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      if (!(await canAccessCompany(currentUser, company.id))) return res.status(403).json({ error: "Access denied" });
      const reps = (company.sharedReps || []) as SharedRep[];
      const allUsers = await storage.getUsers(currentUser.organizationId);
      const result = reps.map(r => {
        const u = allUsers.find(u => u.id === r.userId);
        return { userId: r.userId, territoryNote: r.territoryNote || "", name: u?.name || "Unknown" };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch shared reps" });
    }
  });

  app.post("/api/companies/:id/shared-reps", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Only admins and NAMs can manage shared reps" });
      }
      const company = await storage.getCompanyInOrg(req.params.id, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const parsed = sharedRepSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { userId, territoryNote } = parsed.data;
      const targetUser = await storage.getUser(userId);
      if (!targetUser || targetUser.organizationId !== currentUser.organizationId) {
        return res.status(400).json({ error: "User not found in organization" });
      }
      const existing = (company.sharedReps || []) as SharedRep[];
      if (existing.some(r => r.userId === userId)) {
        return res.status(400).json({ error: "User is already a shared rep on this account" });
      }
      const updated = [...existing, { userId, territoryNote: territoryNote || "" }];
      await storage.updateCompany(company.id, currentUser.organizationId, { sharedReps: updated });
      res.json({ userId, territoryNote: territoryNote || "", name: targetUser.name });
    } catch (error) {
      res.status(500).json({ error: "Failed to add shared rep" });
    }
  });

  app.delete("/api/companies/:id/shared-reps/:userId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Only admins and NAMs can manage shared reps" });
      }
      const company = await storage.getCompanyInOrg(req.params.id, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const existing = (company.sharedReps || []) as SharedRep[];
      const updated = existing.filter(r => r.userId !== req.params.userId);
      await storage.updateCompany(company.id, currentUser.organizationId, { sharedReps: updated });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove shared rep" });
    }
  });

  app.get("/api/team-members", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      if (currentUser.role === "admin") {
        return res.json(safeUsers);
      }
      if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        const visibleIds = new Set([...teamIds, currentUser.id]);
        // Always include manager (they can post replies to this user's sessions)
        if (currentUser.managerId) visibleIds.add(currentUser.managerId);
        // Always include admins (they can see and post to any session)
        safeUsers.filter(u => u.role === "admin").forEach(u => visibleIds.add(u.id));
        return res.json(safeUsers.filter(u => visibleIds.has(u.id)));
      }
      const visibleIds = new Set<string>([currentUser.id]);
      if (currentUser.managerId) {
        visibleIds.add(currentUser.managerId);
        allUsers.forEach(u => {
          if (u.managerId === currentUser.managerId) visibleIds.add(u.id);
        });
      }
      // Always include admins (they can see and post to any session)
      safeUsers.filter(u => u.role === "admin").forEach(u => visibleIds.add(u.id));
      return res.json(safeUsers.filter(u => visibleIds.has(u.id)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch team members" });
    }
  });

  function getBaseRank(base: string | null | undefined): number {
    if (!base) return 0;
    const s = base.toLowerCase().replace(/\s+/g, "");
    if (s.includes("home") || s === "hr" || s === "homerun") return 4;
    if (s.includes("3rd") || s.includes("third")) return 3;
    if (s.includes("2nd") || s.includes("second")) return 2;
    if (s.includes("1st") || s.includes("first")) return 1;
    return 0;
  }

  // ─── Easter Egg System ──────────────────────────────────────────────────────
  const EGG_CONFIGS: Record<string, { title: string; message: string }> = {
    first_meaningful_2: {
      title: "🥚 Easter Egg Unlocked — First Meaningful!",
      message: "LFG! You're the first rep EVER to rack up 2 meaningful conversations. The bar has officially been set. 📸 Take a screenshot, drop it in the $ales group, and find Ben for $100 cash 💵\n\nYou found a Freight DNA easter egg. There are more hidden in the platform — keep digging.",
    },
    first_nominator: {
      title: "🥚 Easter Egg Unlocked — First Nominator!",
      message: "LFG! You're the first person EVER to nominate a teammate. Leadership is lifting others up. 📸 Take a screenshot, drop it in the $ales group, and find Ben for $100 cash 💵\n\nYou found a Freight DNA easter egg. There are more hidden in the platform — keep digging.",
    },
    first_1on1_close: {
      title: "🥚 Easter Egg Unlocked — First 1:1 Finisher!",
      message: "LFG! You're the first person EVER to close out a full 1:1 session. You just set the standard. 📸 Take a screenshot, drop it in the $ales group, and find Ben for $100 cash 💵\n\nYou found a Freight DNA easter egg. There are more hidden in the platform — keep digging.",
    },
    first_relationship_mover: {
      title: "🥚 Easter Egg Unlocked — First Relationship Mover!",
      message: "LFG! You're the first rep EVER to move two contacts up the relationship ladder. Down, not across. 📸 Take a screenshot, drop it in the $ales group, and find Ben for $100 cash 💵\n\nYou found a Freight DNA easter egg. There are more hidden in the platform — keep digging.",
    },
    first_opportunity_4: {
      title: "🥚 Easter Egg Unlocked — First Opportunity Logger!",
      message: "LFG! You're the first rep EVER to log 4 opportunities. Hunters find the bag. 📸 Take a screenshot, drop it in the $ales group, and find Ben for $100 cash 💵\n\nYou found a Freight DNA easter egg. There are more hidden in the platform — keep digging.",
    },
  };

  async function tryClaimEasterEgg(type: string, userId: string): Promise<{ type: string; title: string; message: string } | null> {
    const config = EGG_CONFIGS[type];
    if (!config) return null;
    // "all-time" means each egg type can only ever be won once globally — no monthly resets
    const claimed = await storage.checkAndClaimEasterEgg(type, "all-time", userId);
    if (!claimed) return null;
    return { type, ...config };
  }

  // ─── Pending eggs (for missed celebrations) ──────────────────────────────────
  app.get("/api/me/pending-eggs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const eggs = await storage.getUncelebratedEggs(user.id);
      const enriched = eggs.map(e => {
        const config = EGG_CONFIGS[e.type] ?? { title: "🥚 Easter Egg!", message: "You found an easter egg!" };
        return { ...e, ...config };
      });
      res.json(enriched);
    } catch {
      res.json([]);
    }
  });

  app.post("/api/me/pending-eggs/:id/celebrate", requireAuth, async (req, res) => {
    try {
      await storage.markEggCelebrated(parseInt(req.params.id, 10));
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  app.get("/api/admin/easter-egg-winners", requireAuth, async (req, res) => {
    try {
      const admin = await getCurrentUser(req);
      if (!admin || admin.role !== "admin") return res.status(403).json({ error: "Admins only" });
      const rows = await pool.query<{ id: number; type: string; month: string; winner_id: string; won_at: string; winner_name: string }>(`
        SELECT e.id, e.type, e.month, e.winner_id, e.won_at,
               u.name AS winner_name
        FROM easter_egg_winners e
        LEFT JOIN users u ON u.id = e.winner_id
        ORDER BY e.won_at DESC
      `);
      res.json(rows.rows);
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/award-easter-egg", requireAuth, async (req, res) => {
    try {
      const admin = await getCurrentUser(req);
      if (!admin || admin.role !== "admin") return res.status(403).json({ error: "Admins only" });
      const { type, winnerId } = req.body;
      if (!type || !winnerId) return res.status(400).json({ error: "type and winnerId required" });
      const id = await storage.adminAwardEasterEgg(type, "all-time", winnerId);
      if (!id) return res.status(500).json({ error: "Failed to award egg" });
      res.json({ ok: true, id });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/admin/easter-egg-winners/:id", requireAuth, async (req, res) => {
    try {
      const admin = await getCurrentUser(req);
      if (!admin || admin.role !== "admin") return res.status(403).json({ error: "Admins only" });
      await pool.query(`DELETE FROM easter_egg_winners WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  async function fanOutCelebration(type: "new_account" | "new_contact" | "base_advanced", title: string, body: string, link: string, relatedId: string, actorId: string, organizationId: string) {
    try {
      const allUsers = await storage.getUsers(organizationId);
      const actor = allUsers.find(u => u.id === actorId);
      const notifyIds = new Set<string>();
      // Walk up the manager chain from the actor
      let current = actor;
      while (current?.managerId) {
        const manager = allUsers.find(u => u.id === current!.managerId);
        if (manager) notifyIds.add(manager.id);
        current = manager;
      }
      // Always include all admins
      allUsers.filter(u => u.role === "admin").forEach(u => notifyIds.add(u.id));
      // Never notify the actor themselves
      notifyIds.delete(actorId);
      await Promise.all([...notifyIds].map(uid =>
        storage.createNotification({ userId: uid, type, title, body, link, relatedId, read: false }).catch(() => {})
      ));
    } catch (e) {
      console.error("fanOutCelebration error:", e);
    }
  }

  app.post("/api/companies", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const parsed = insertCompanySchema.omit({ organizationId: true }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data = { ...parsed.data, organizationId: req.session.organizationId! };
      if (currentUser.role === "admin") {
        // admin can assign to anyone — leave assignedTo as-is
      } else if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        if (data.assignedTo) {
          const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
          if (!teamIds.includes(data.assignedTo)) {
            data.assignedTo = currentUser.id;
          }
        } else {
          data.assignedTo = currentUser.id;
        }
      } else {
        data.assignedTo = currentUser.id;
      }
      const company = await storage.createCompany(data);
      fanOutCelebration(
        "new_account",
        `🎉 New account: ${company.name}`,
        `${currentUser.name} just added a new account to the CRM.`,
        `/companies/${company.id}`,
        company.id,
        currentUser.id,
        req.session.organizationId!
      );
      res.status(201).json(company);
    } catch (error) {
      console.error("Error creating company:", error);
      res.status(500).json({ error: "Failed to create company" });
    }
  });

  app.patch("/api/companies/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = insertCompanySchema.omit({ organizationId: true }).partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data = { ...parsed.data };
      if (currentUser.role !== "admin") {
        delete (data as any).assignedTo;
      }
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, data);
      if (!company) {
        return res.status(404).json({ error: "Company not found" });
      }
      res.json(company);
    } catch (error) {
      console.error("Error updating company:", error);
      res.status(500).json({ error: "Failed to update company" });
    }
  });

  app.patch("/api/companies/:id/financial-alias", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { financialAlias } = req.body;
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, { financialAlias: financialAlias || null } as any);
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update financial alias" });
    }
  });

  app.patch("/api/companies/:id/salesperson", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { salesPersonId } = req.body;
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, { salesPersonId: salesPersonId || null } as any);
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update salesperson" });
    }
  });

  app.patch("/api/companies/:id/reassign", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Only admins, directors and NAMs can reassign accounts" });
      }
      const { assignedTo } = req.body;
      if (!assignedTo) return res.status(400).json({ error: "assignedTo is required" });
      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        if (!teamIds.includes(assignedTo)) {
          return res.status(403).json({ error: "Can only assign to team members" });
        }
      }
      const existing = await storage.getCompanyInOrg((req.params.id as string), currentUser.organizationId);
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, { ...existing, assignedTo });
      if (!company) return res.status(404).json({ error: "Company not found" });
      // Notify the new assignee if they're different from the actor
      if (assignedTo !== currentUser.id && assignedTo !== existing.assignedTo) {
        storage.createNotification({
          userId: assignedTo,
          type: "account_assigned",
          title: `${currentUser.name} assigned you an account`,
          body: existing.name,
          link: `/companies/${existing.id}`,
          relatedId: existing.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to reassign company" });
    }
  });

  app.delete("/api/companies/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteCompany((req.params.id as string), currentUser.organizationId);
      if (!deleted) {
        return res.status(404).json({ error: "Company not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting company:", error);
      res.status(500).json({ error: "Failed to delete company" });
    }
  });

  app.post("/api/companies/:id/archive", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.archiveCompany((req.params.id as string), currentUser.organizationId);
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to archive company" });
    }
  });

  app.post("/api/companies/:id/unarchive", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.unarchiveCompany((req.params.id as string), currentUser.organizationId);
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to unarchive company" });
    }
  });

  app.get("/api/contacts", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let contacts = await storage.getContacts();
      const orgCompanies = await storage.getCompanies(currentUser.organizationId);
      const orgCompanyIds = new Set(orgCompanies.map(c => c.id));
      contacts = contacts.filter(c => orgCompanyIds.has(c.companyId));
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        contacts = contacts.filter(c => visibleIds.includes(c.companyId));
      }
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.get("/api/companies/:companyId/contacts", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contacts = await storage.getContactsByCompany((req.params.companyId as string));
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.post("/api/companies/:companyId/contacts", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contactData = {
        ...req.body,
        companyId: (req.params.companyId as string),
        createdAt: new Date().toISOString(),
        createdBy: currentUser.id,
      };
      const parsed = insertContactSchema.safeParse(contactData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const contact = await storage.createContact(parsed.data);
      const _orgIdForFanOut1 = req.session.organizationId!;
      storage.getCompanyInOrg((req.params.companyId as string), _orgIdForFanOut1).then(co => {
        fanOutCelebration(
          "new_contact",
          `🎉 New contact: ${contact.name}`,
          `${currentUser.name} added ${contact.name}${contact.title ? ` (${contact.title})` : ""} at ${co?.name ?? "an account"}.`,
          `/companies/${(req.params.companyId as string)}`,
          contact.id,
          currentUser.id,
          _orgIdForFanOut1
        );
      }).catch(() => {});
      res.status(201).json(contact);
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.post("/api/companies/:companyId/contacts/bulk-import", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows: any[] = req.body.contacts;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No contacts provided" });
      }
      const now = new Date().toISOString();
      const toInsert = rows.map(r => ({
        companyId: (req.params.companyId as string),
        name: (r.name || "").trim(),
        title: r.title?.trim() || null,
        email: r.email?.trim() || null,
        phone: r.phone?.trim() || null,
        notes: r.notes?.trim() || null,
        nextSteps: r.nextSteps?.trim() || null,
        createdAt: now,
        createdBy: currentUser.id,
      })).filter(r => r.name.length > 0);
      if (toInsert.length === 0) return res.status(400).json({ error: "No valid contacts (name is required)" });
      const created = await storage.bulkCreateContacts(toInsert);
      res.status(201).json({ count: created.length, contacts: created });
    } catch (error) {
      console.error("Error bulk importing contacts:", error);
      res.status(500).json({ error: "Failed to import contacts" });
    }
  });

  app.patch("/api/contacts/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getContact((req.params.id as string));
      if (!existing) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contactData = {
        ...req.body,
        companyId: existing.companyId,
      };
      const parsed = insertContactSchema.safeParse(contactData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const baseChanged = parsed.data.relationshipBase && parsed.data.relationshipBase !== existing.relationshipBase;
      const oldRank = getBaseRank(existing.relationshipBase);
      const newRank = baseChanged ? getBaseRank(parsed.data.relationshipBase) : 0;
      if (baseChanged) {
        parsed.data.baseAdvancedAt = new Date().toISOString().split("T")[0];
        if (newRank > oldRank && newRank > 0) {
          const _orgIdForFanOut2 = req.session.organizationId!;
          storage.getCompanyInOrg(existing.companyId, _orgIdForFanOut2).then(co => {
            fanOutCelebration(
              "base_advanced",
              `🎉 Relationship advanced: ${parsed.data.name ?? existing.name}`,
              `${currentUser.name} moved ${parsed.data.name ?? existing.name} at ${co?.name ?? "an account"} from ${existing.relationshipBase ?? "no base"} → ${parsed.data.relationshipBase}.`,
              `/companies/${existing.companyId}`,
              (req.params.id as string),
              currentUser.id,
              _orgIdForFanOut2
            );
          }).catch(() => {});
        }
        // Log history
        storage.logContactBaseHistory(
          req.params.id as string,
          existing.relationshipBase ?? null,
          parsed.data.relationshipBase!,
          currentUser.id
        ).catch(() => {});
      }
      const contact = await storage.updateContact((req.params.id as string), parsed.data);
      let easterEgg = null;
      if (newRank > oldRank && newRank > 0) {
        const now2 = new Date();
        const monthStart = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}-01`;
        const moved = await storage.countRelationshipsMovedThisMonth(currentUser.id, monthStart);
        if (moved >= 2) easterEgg = await tryClaimEasterEgg("first_relationship_mover", currentUser.id);
      }
      res.json({ ...contact, easterEgg });
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/contacts/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getContact((req.params.id as string));
      if (!existing) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteContact((req.params.id as string));
      if (!deleted) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contact:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // T003: Relationship advancement history
  app.get("/api/contacts/:id/base-history", requireAuth, async (req, res) => {
    try {
      const history = await storage.getContactBaseHistory(req.params.id as string);
      res.json(history);
    } catch (e) {
      console.error("Error fetching base history:", e);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // Cross-RFP lane search: search origin/destination across all uploaded RFP lane data
  app.get("/api/rfps/lane-search", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const originQuery = String(req.query.origin || "").trim();
      const destQuery = String(req.query.destination || "").trim();
      const radiusMiles = Math.max(1, Math.min(500, parseFloat(String(req.query.radius || "75")) || 75));

      if (!originQuery && !destQuery) {
        return res.status(400).json({ error: "Provide at least an origin or destination to search" });
      }

      // Parse "City, ST" or "City ST" or "ST" into {city, state} for geocoding
      function parseCityState(q: string): { city: string; state: string } {
        if (!q) return { city: "", state: "" };
        const commaMatch = q.match(/^(.+),\s*([A-Za-z]{2})$/);
        if (commaMatch) return { city: commaMatch[1].trim(), state: commaMatch[2].trim().toUpperCase() };
        const spaceMatch = q.match(/^(.+)\s+([A-Za-z]{2})$/);
        if (spaceMatch) return { city: spaceMatch[1].trim(), state: spaceMatch[2].trim().toUpperCase() };
        if (/^[A-Za-z]{2}$/.test(q)) return { city: "", state: q.trim().toUpperCase() };
        return { city: q.trim(), state: "" };
      }

      // Geocode the query locations (used as the center of the radius buffer)
      const originParsed = parseCityState(originQuery);
      const destParsed = parseCityState(destQuery);
      const originCenter = originQuery ? geocodeCity(originParsed.city, originParsed.state) : null;
      const destCenter = destQuery ? geocodeCity(destParsed.city, destParsed.state) : null;

      // Check if a lane endpoint is within radiusMiles of the query center.
      // Falls back to text matching when geocoding isn't possible.
      function locationMatches(
        laneCity: string, laneState: string, laneText: string,
        queryRaw: string, queryCenter: [number, number] | null,
      ): { match: boolean; distanceMiles: number | null } {
        if (!queryRaw) return { match: true, distanceMiles: null };

        if (queryCenter) {
          const laneCoords = geocodeCity(laneCity, laneState);
          if (laneCoords) {
            const dist = haversineDistance(queryCenter[0], queryCenter[1], laneCoords[0], laneCoords[1]);
            return { match: dist <= radiusMiles, distanceMiles: Math.round(dist) };
          }
        }
        // Geocode not available — fall back to text contains
        const haystack = laneText.toLowerCase();
        const needle = queryRaw.toLowerCase();
        return { match: haystack.includes(needle), distanceMiles: null };
      }

      // Get all visible RFPs for this org
      let rfpList = await storage.getRfps();
      const orgCompanies = await storage.getCompanies(currentUser.organizationId);
      const orgCompanyIds = new Set(orgCompanies.map(c => c.id));
      rfpList = rfpList.filter(r => orgCompanyIds.has(r.companyId));
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        rfpList = rfpList.filter(r => visibleIds.includes(r.companyId));
      }

      const companyMap = new Map(orgCompanies.map(c => [c.id, c.name]));

      const results: {
        companyId: string;
        companyName: string;
        rfpId: string;
        rfpTitle: string;
        rfpStatus: string;
        rfpDueDate: string | null;
        matchingLanes: any[];
        totalMatchVolume: number;
      }[] = [];

      for (const rfp of rfpList) {
        const fd = rfp.fileData as { rows?: any[]; highVolumeLanes?: any[] } | null;
        if (!fd) continue;

        const lanes: any[] = fd.highVolumeLanes || [];
        if (!lanes.length) continue;

        const matchingLanes: any[] = [];
        for (const lane of lanes) {
          const originText = [lane.origin || "", lane.originState || "", lane.lane || ""].join(" ");
          const destText = [lane.destination || "", lane.destinationState || "", lane.lane || ""].join(" ");

          const originCheck = locationMatches(lane.origin || "", lane.originState || "", originText, originQuery, originCenter);
          const destCheck = locationMatches(lane.destination || "", lane.destinationState || "", destText, destQuery, destCenter);

          if (originCheck.match && destCheck.match) {
            matchingLanes.push({
              ...lane,
              originDistanceMiles: originCheck.distanceMiles,
              destDistanceMiles: destCheck.distanceMiles,
            });
          }
        }

        if (matchingLanes.length === 0) continue;

        const totalMatchVolume = matchingLanes.reduce((sum, l) => sum + (l.volume || 0), 0);
        results.push({
          companyId: rfp.companyId,
          companyName: companyMap.get(rfp.companyId) || "Unknown",
          rfpId: rfp.id,
          rfpTitle: rfp.title,
          rfpStatus: rfp.status,
          rfpDueDate: rfp.dueDate || null,
          matchingLanes,
          totalMatchVolume,
        });
      }

      results.sort((a, b) => b.totalMatchVolume - a.totalMatchVolume);

      res.json({
        results,
        originQuery,
        destQuery,
        radiusMiles,
        originGeocoded: !!originCenter,
        destGeocoded: !!destCenter,
      });
    } catch (error) {
      console.error("Lane search error:", error);
      res.status(500).json({ error: "Lane search failed" });
    }
  });

  app.get("/api/rfps", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let rfps = await storage.getRfps();
      const orgCompanies = await storage.getCompanies(currentUser.organizationId);
      const orgCompanyIds = new Set(orgCompanies.map(c => c.id));
      rfps = rfps.filter(r => orgCompanyIds.has(r.companyId));
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        rfps = rfps.filter(r => visibleIds.includes(r.companyId));
      }
      res.json(rfps);
    } catch (error) {
      console.error("Error fetching RFPs:", error);
      res.status(500).json({ error: "Failed to fetch RFPs" });
    }
  });

  app.post("/api/rfps", async (req, res) => {
    try {
      const parsed = insertRfpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const rfp = await storage.createRfp(parsed.data);
      res.status(201).json(rfp);
    } catch (error) {
      console.error("Error creating RFP:", error);
      res.status(500).json({ error: "Failed to create RFP" });
    }
  });

  app.post("/api/rfps/preview-headers", upload.single("file"), async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const allowedExts = [".xlsx", ".xls", ".csv", ".pdf"];
      const fileExt = req.file.originalname.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
      if (!allowedExts.includes(fileExt)) {
        return res.status(400).json({ error: "Invalid file type. Please upload an Excel (.xlsx, .xls), CSV, or PDF file." });
      }

      // PDF path: extract text via pdf-parse, then use AI to extract lane data
      if (fileExt === ".pdf") {
        try {
          const pdfParse = (await import("pdf-parse")).default;
          const pdfData = await pdfParse(req.file.buffer);
          const pdfText = pdfData.text?.trim() || "";

          if (!pdfText) {
            return res.status(400).json({ error: "Could not extract text from the PDF. The file may be scanned or image-only." });
          }

          const OpenAI = (await import("openai")).default;
          const openai = new OpenAI({
            apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
          });

          const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `You are an expert freight logistics analyst. Your task is to extract structured freight lane data from an RFP (Request for Proposal) document.

Extract every shipping lane you can find from the document text. A "lane" is an origin→destination pair with associated volume or load count.

Return a JSON object with this exact structure:
{
  "lanes": [
    {
      "origin_city": "Chicago",
      "origin_state": "IL",
      "origin_zip": "60601",
      "dest_city": "Dallas",
      "dest_state": "TX",
      "dest_zip": "75201",
      "volume": 120,
      "equipment": "Van",
      "lane_id": "LANE-001"
    }
  ]
}

Rules:
- origin_zip, dest_zip, equipment, and lane_id are optional — only include them if clearly present.
- volume should be the number of annual loads/shipments. If the document shows weekly loads, multiply by 52. If monthly, multiply by 12.
- If volume is not available for a lane, use null.
- State should always be the 2-letter abbreviation (e.g., "IL", "TX").
- If the document has no identifiable lanes, return { "lanes": [] }.
- Do not invent data. Only extract what is present.`,
              },
              {
                role: "user",
                content: `Extract freight lanes from this RFP document:\n\n${pdfText.slice(0, 25000)}`,
              },
            ],
            response_format: { type: "json_object" },
            max_completion_tokens: 4096,
          });

          const parsed = JSON.parse(aiResponse.choices[0].message.content || "{}");
          const extractedLanes: any[] = Array.isArray(parsed.lanes) ? parsed.lanes : [];

          return res.json({
            isPdf: true,
            extractedLanes,
            laneCount: extractedLanes.length,
          });
        } catch (pdfError) {
          console.error("PDF processing error:", pdfError);
          return res.status(500).json({ error: "Failed to process PDF file. Please ensure the PDF contains readable text." });
        }
      }

      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } catch {
        return res.status(400).json({ error: "Could not parse file. Please ensure it is a valid Excel or CSV file." });
      }

      const sheetName = selectBestRfpSheet(workbook);
      const sheet = workbook.Sheets[sheetName];
      const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      if (rawAll.length === 0) {
        return res.status(400).json({ error: "File appears to be empty." });
      }

      // Detect header row
      const headerKeywords = ["origin", "dest", "volume", "load", "ship", "from", "to", "lane", "state", "city", "zip", "rate", "qty", "pickup", "delivery"];
      let headerRowIdx = 0;
      let bestScore = 0;

      for (let i = 0; i < Math.min(15, rawAll.length); i++) {
        const rowStr = rawAll[i].join(" ").toLowerCase();
        const score = headerKeywords.filter(kw => rowStr.includes(kw)).length;
        if (score > bestScore) {
          bestScore = score;
          headerRowIdx = i;
        }
      }

      const allHeaders: { name: string; colIndex: number }[] = rawAll[headerRowIdx]
        .map((h: any, i: number) => ({
          name: (h !== "" && h !== null) ? String(h).trim() : `col_${i}`,
          colIndex: i,
        }))
        .filter((entry: { name: string; colIndex: number }) =>
          !entry.name.startsWith("col_") || rawAll[headerRowIdx + 1]?.[entry.colIndex] !== ""
        );

      const headers: string[] = allHeaders.map(e => e.name);

      // Get a few sample values per column for AI context (use original column indices)
      const sampleRows = rawAll.slice(headerRowIdx + 1, headerRowIdx + 4);
      const columnSamples: Record<string, string[]> = {};
      allHeaders.forEach(({ name, colIndex }) => {
        columnSamples[name] = sampleRows.map(r => String(r[colIndex] ?? "")).filter(v => v !== "");
      });

      let suggestedMappings: Record<string, string> = {};
      try {
        const OpenAI = (await import("openai")).default;
        const openai = new OpenAI({
          apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
          baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
        });

        const headersList = headers.map(h => {
          const samples = columnSamples[h]?.slice(0, 3).join(", ") || "";
          return `"${h}" (samples: ${samples || "none"})`;
        }).join("\n");

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are an expert at analyzing freight RFP (Request for Proposal) spreadsheet headers. 
Your task is to map spreadsheet column headers to standard freight lane fields.
The standard fields are:
- origin_city: City name for origin/pickup location
- origin_state: State abbreviation for origin (e.g. "Origin*", "Origin Country*" with state samples, "Orig State")
- origin_zip: ZIP code or partial postal code for origin (e.g. "Origin Partial Postal Code*", "Origin ZIP", "Orig Zip", "From Zip")
- dest_city: City name for destination/delivery location  
- dest_state: State abbreviation for destination (e.g. "Destination*", "Dest State", "To State")
- dest_zip: ZIP code or partial postal code for destination (e.g. "Destination Partial Postal Code*", "Dest ZIP", "To Zip")
- volume: Number of loads/shipments (e.g. "Estimated Volume*", "Volume*", "Annual Loads", "Weekly Loads")
- equipment: Equipment or trailer type (e.g. "Equipment Type*", "Trailer Type", "Van", "Flatbed", "Reefer")
- lane_id: Lane identifier or name (e.g. "Lane Name*", "Lane ID", "Lane #")
- miles: Distance in miles for the lane (e.g. "Length Of Haul*", "Miles", "Distance", "Mileage")
- ignore: Column is not relevant

IMPORTANT: "Origin Partial Postal Code*" and "Destination Partial Postal Code*" contain 3-digit zip prefix codes — map these to origin_zip and dest_zip respectively.
"Origin*" when samples show 2-letter state codes (MD, FL, TX, etc.) should be mapped to origin_state.
"Destination*" when samples show 2-letter state codes should be mapped to dest_state.

Respond ONLY with a JSON object where keys are the original column names and values are one of the standard field types above.
Be conservative - if unsure, use "ignore". Every column must be assigned.`,
            },
            {
              role: "user",
              content: `Map these columns from an RFP spreadsheet:\n${headersList}\n\nRespond with JSON only.`,
            },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: 1024,
        });

        const parsed = JSON.parse(aiResponse.choices[0].message.content || "{}");
        const validFields = new Set(["origin_city", "origin_state", "origin_zip", "dest_city", "dest_state", "dest_zip", "volume", "equipment", "lane_id", "miles", "ignore"]);
        for (const h of headers) {
          const suggestion = parsed[h];
          suggestedMappings[h] = validFields.has(suggestion) ? suggestion : "ignore";
        }
      } catch (aiError) {
        console.error("AI column mapping failed, using defaults:", aiError);
        headers.forEach(h => { suggestedMappings[h] = "ignore"; });
      }

      // Determine confidence: all non-ignore fields must be present
      const mappedFields = Object.values(suggestedMappings).filter(v => v !== "ignore");
      const hasOrigin = mappedFields.some(f => f.startsWith("origin_"));
      const hasDestination = mappedFields.some(f => f.startsWith("dest_"));
      const hasVolume = mappedFields.includes("volume");
      const confident = hasOrigin && hasDestination && hasVolume;

      return res.json({
        headers,
        suggestedMappings,
        confident,
        sheetName,
        columnSamples,
      });
    } catch (error) {
      console.error("Error previewing RFP headers:", error);
      res.status(500).json({ error: "Failed to analyze file headers" });
    }
  });

  app.post("/api/rfps/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const allowedExts = [".xlsx", ".xls", ".csv"];
      const fileExt = req.file.originalname.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
      if (!allowedExts.includes(fileExt)) {
        return res.status(400).json({ error: "Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file." });
      }

      const companyId = req.body.companyId;
      if (!companyId) {
        return res.status(400).json({ error: "Company ID is required" });
      }

      const company = await storage.getCompanyInOrg(companyId, req.session.organizationId!);
      if (!company) {
        return res.status(400).json({ error: "Company not found" });
      }

      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } catch {
        return res.status(400).json({ error: "Could not parse file. Please ensure it is a valid Excel or CSV file." });
      }

      // Use confirmed mapping if provided, otherwise fall back to keyword guessing
      let result: ReturnType<typeof analyzeRfpSpreadsheet>;
      const confirmedMappingRaw = req.body.confirmedMapping;
      if (confirmedMappingRaw) {
        try {
          const confirmedMapping: ConfirmedColumnMapping = typeof confirmedMappingRaw === "string"
            ? JSON.parse(confirmedMappingRaw)
            : confirmedMappingRaw;
          result = analyzeRfpSpreadsheetWithMapping(workbook, confirmedMapping) as any;
        } catch {
          result = analyzeRfpSpreadsheet(workbook);
        }
      } else {
        result = analyzeRfpSpreadsheet(workbook);
      }

      const rfpData = {
        companyId,
        title: req.body.title || req.file.originalname.replace(/\.[^.]+$/, ""),
        status: "pending",
        value: null,
        dueDate: null,
        notes: null,
        fileName: req.file.originalname,
        fileData: { rows: result.rows, highVolumeLanes: result.highVolumeLanes, sheetName: result.sheetName },
        laneCount: result.analysis.laneCount,
        totalVolume: result.analysis.totalVolume,
        originStates: result.analysis.originStates,
        destinationStates: result.analysis.destinationStates,
        rfpType: req.body.rfpType || null,
      };

      const rfp = await storage.createRfp(rfpData);
      res.status(201).json({ rfp, analysis: result.analysis, headers: result.headers, highVolumeLanes: result.highVolumeLanes, previewRows: result.rows.slice(0, 10), sheetName: result.sheetName });
    } catch (error) {
      console.error("Error uploading RFP:", error);
      res.status(500).json({ error: "Failed to process uploaded file" });
    }
  });

  // Award lane parsing endpoint — reuses same analyzeRfpSpreadsheet logic as RFP upload
  app.post("/api/awards/parse-lanes", requireAuth, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const allowedExts = [".xlsx", ".xls", ".csv"];
      const fileExt = req.file.originalname.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
      if (!allowedExts.includes(fileExt)) {
        return res.status(400).json({ error: "Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file." });
      }
      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } catch {
        return res.status(400).json({ error: "Could not parse file. Please ensure it is a valid Excel or CSV file." });
      }
      const confirmedMappingRaw = req.body.confirmedMapping;
      let result: ReturnType<typeof analyzeRfpSpreadsheet>;
      if (confirmedMappingRaw) {
        try {
          const confirmedMapping: ConfirmedColumnMapping = typeof confirmedMappingRaw === "string"
            ? JSON.parse(confirmedMappingRaw) : confirmedMappingRaw;
          result = analyzeRfpSpreadsheetWithMapping(workbook, confirmedMapping) as any;
        } catch {
          result = analyzeRfpSpreadsheet(workbook);
        }
      } else {
        result = analyzeRfpSpreadsheet(workbook);
      }
      // Build the column→field reverse lookup from the confirmed mapping
      const fieldToOriginalCol = (field: string): string | null => {
        for (const [col, f] of Object.entries(confirmedMappingRaw ? (typeof confirmedMappingRaw === "string" ? JSON.parse(confirmedMappingRaw) : confirmedMappingRaw) : {})) {
          if (f === field) return col;
        }
        return null;
      };
      const oCityCol   = fieldToOriginalCol("origin_city");
      const oStateCol  = fieldToOriginalCol("origin_state");
      const oZipCol    = fieldToOriginalCol("origin_zip");
      const dCityCol   = fieldToOriginalCol("dest_city");
      const dStateCol  = fieldToOriginalCol("dest_state");
      const dZipCol    = fieldToOriginalCol("dest_zip");
      const volCol     = fieldToOriginalCol("volume");

      // Detect cadence for volume scaling (same logic as analyzeRfpSpreadsheetWithMapping)
      let isWeekly = false, isMonthly = false;
      if (volCol) {
        const colLower = volCol.toLowerCase();
        if (colLower.includes("week") || colLower.includes("wkly")) isWeekly = true;
        else if (colLower.includes("month") || colLower.includes("mthly")) isMonthly = true;
        else {
          const nums = result.rows.map((r: Record<string, any>) => parseFloat(String(r[volCol] || "").replace(/[^0-9.]/g, ""))).filter((v: number) => !isNaN(v) && v > 0);
          if (nums.length > 0 && Math.max(...nums) <= 52) isWeekly = true;
        }
      }

      const allLaneLabels: string[] = result.rows
        .map((row: Record<string, any>) => {
          const rawOCity  = oCityCol  ? String(row[oCityCol]  || "").trim() : "";
          const oState    = oStateCol ? String(row[oStateCol] || "").trim() : "";
          const rawOZip   = oZipCol   ? String(row[oZipCol]   || "").trim() : "";
          const rawDCity  = dCityCol  ? String(row[dCityCol]  || "").trim() : "";
          const dState    = dStateCol ? String(row[dStateCol] || "").trim() : "";
          const rawDZip   = dZipCol   ? String(row[dZipCol]   || "").trim() : "";

          const oCity = rawOCity || zipToCity(rawOZip);
          const dCity = rawDCity || zipToCity(rawDZip);

          // zipToCity returns "City, ST" format — don't double-append state if already embedded
          const fmtLocation = (city: string, state: string, zip: string): string => {
            if (city && city.includes(",")) return city; // already "City, ST"
            if (city && state) return `${city}, ${state}`;
            if (city) return city;
            return state || zip;
          };
          const originPart = fmtLocation(oCity, oState, rawOZip);
          const destPart   = fmtLocation(dCity, dState, rawDZip);

          if (!originPart || !destPart) return null;

          let vol = 0;
          if (volCol && row[volCol] !== "" && row[volCol] != null) {
            const v = parseFloat(String(row[volCol]).replace(/[^0-9.]/g, ""));
            if (!isNaN(v) && v > 0) vol = isWeekly ? v * 52 : isMonthly ? v * 12 : v;
          }
          const volSuffix = vol > 0 ? ` (${Math.round(vol).toLocaleString()} loads)` : "";
          return `${originPart} → ${destPart}${volSuffix}`;
        })
        .filter((l: string | null): l is string => l !== null);

      return res.json({
        lanes: result.highVolumeLanes,
        allLaneLabels,
        analysis: result.analysis,
        headers: result.headers,
        sheetName: result.sheetName,
      });
    } catch (err) {
      console.error("award parse-lanes error", err);
      return res.status(500).json({ error: "Failed to process file" });
    }
  });

  app.post("/api/rfps/upload-pdf", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const { companyId, rfpType, lanes, fileName, title } = req.body;
      if (!companyId) return res.status(400).json({ error: "Company ID is required" });
      if (!Array.isArray(lanes)) return res.status(400).json({ error: "lanes must be an array" });

      const company = await storage.getCompanyInOrg(companyId, req.session.organizationId!);
      if (!company) return res.status(400).json({ error: "Company not found" });

      const originStates = [...new Set(lanes.map((l: any) => l.origin_state).filter(Boolean))] as string[];
      const destStates = [...new Set(lanes.map((l: any) => l.dest_state).filter(Boolean))] as string[];
      const totalVolume = lanes.reduce((sum: number, l: any) => sum + (Number(l.volume) || 0), 0);
      const laneCount = lanes.length;

      const highVolumeLanes = lanes
        .filter((l: any) => Number(l.volume) > 0)
        .sort((a: any, b: any) => Number(b.volume) - Number(a.volume))
        .slice(0, 10);

      const rfpData = {
        companyId,
        title: title || (fileName ? fileName.replace(/\.[^.]+$/, "") : "Untitled RFP"),
        status: "pending",
        value: null,
        dueDate: null,
        notes: null,
        fileName: fileName || "rfp.pdf",
        fileData: { rows: lanes, highVolumeLanes, sheetName: "PDF Extract" },
        laneCount,
        totalVolume: String(totalVolume),
        originStates,
        destinationStates: destStates,
        rfpType: rfpType || null,
      };

      const rfp = await storage.createRfp(rfpData);
      res.status(201).json({
        rfp,
        analysis: { laneCount, totalVolume: String(totalVolume), originStates, destinationStates: destStates, highVolumeLaneCount: highVolumeLanes.length },
        laneCount,
      });
    } catch (error) {
      console.error("Error saving PDF RFP:", error);
      res.status(500).json({ error: "Failed to save RFP" });
    }
  });

  app.patch("/api/rfps/:id", async (req, res) => {
    try {
      const existing = await storage.getRfp((req.params.id as string));
      if (!existing) {
        return res.status(404).json({ error: "RFP not found" });
      }
      const parsed = insertRfpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const rfp = await storage.updateRfp((req.params.id as string), parsed.data);
      res.json(rfp);
    } catch (error) {
      console.error("Error updating RFP:", error);
      res.status(500).json({ error: "Failed to update RFP" });
    }
  });

  app.patch("/api/rfps/:id/lanes/:laneIndex/status", async (req, res) => {
    try {
      const rfp = await storage.getRfp((req.params.id as string));
      if (!rfp) {
        return res.status(404).json({ error: "RFP not found" });
      }

      const laneIndex = parseInt((req.params.laneIndex as string));
      if (isNaN(laneIndex) || laneIndex < 0) {
        return res.status(400).json({ error: "Invalid lane index" });
      }
      const { status, contactId } = req.body;
      const validStatuses = ["open", "contact_added", "researched"];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be one of: open, contact_added, researched" });
      }

      const fileData = rfp.fileData as { rows?: any[]; highVolumeLanes?: any[] } | null;
      if (!fileData || Array.isArray(fileData) || !fileData.highVolumeLanes || laneIndex >= fileData.highVolumeLanes.length) {
        return res.status(400).json({ error: "Invalid lane index" });
      }

      fileData.highVolumeLanes[laneIndex].status = status || "contact_added";
      if (contactId) {
        fileData.highVolumeLanes[laneIndex].contactId = contactId;
      }

      const updated = await storage.updateRfp((req.params.id as string), { ...rfp, fileData } as any);
      res.json(updated);
    } catch (error) {
      console.error("Error updating lane status:", error);
      res.status(500).json({ error: "Failed to update lane status" });
    }
  });

  app.get("/api/research-tasks", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let allRfps = await storage.getRfps();
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        allRfps = allRfps.filter(r => visibleIds.includes(r.companyId));
      }
      const companyFilter = req.query.companyId as string | undefined;
      const tasks: any[] = [];

      for (const rfp of allRfps) {
        if (companyFilter && rfp.companyId !== companyFilter) continue;
        const fileData = rfp.fileData as { rows?: any[]; highVolumeLanes?: any[] } | null;
        if (!fileData || Array.isArray(fileData) || !fileData.highVolumeLanes) continue;

        fileData.highVolumeLanes.forEach((lane: any, index: number) => {
          tasks.push({
            rfpId: rfp.id,
            rfpTitle: rfp.title,
            companyId: rfp.companyId,
            laneIndex: index,
            lane: lane.lane,
            laneId: lane.laneId || "",
            origin: lane.origin,
            destination: lane.destination,
            originState: lane.originState,
            destinationState: lane.destinationState,
            volume: lane.volume,
            rate: lane.rate,
            equipment: lane.equipment || "",
            status: lane.status || "open",
            contactId: lane.contactId || null,
          });
        });
      }

      res.json(tasks);
    } catch (error) {
      console.error("Error fetching research tasks:", error);
      res.status(500).json({ error: "Failed to fetch research tasks" });
    }
  });

  app.get("/api/companies/:id/lane-patterns", async (req, res) => {
    try {
      const companyId = (req.params.id as string);
      const allRfps = await storage.getRfps();

      const corridorMap = new Map<string, {
        origin: string;
        originState: string;
        destination: string;
        destinationState: string;
        totalVolume: number;
        count: number;
        rfpTitles: string[];
      }>();

      const hubMap = new Map<string, {
        facility: string;
        state: string;
        inboundVolume: number;
        outboundVolume: number;
        inboundCount: number;
        outboundCount: number;
      }>();

      const stateCorridorMap = new Map<string, {
        originState: string;
        destinationState: string;
        totalVolume: number;
        laneCount: number;
      }>();

      for (const rfp of allRfps) {
        if (rfp.companyId !== companyId) continue;
        const fileData = rfp.fileData as { rows?: any[]; highVolumeLanes?: any[] } | null;
        if (!fileData || Array.isArray(fileData) || !fileData.highVolumeLanes) continue;

        for (const lane of fileData.highVolumeLanes) {
          const orig = (lane.origin || "").trim();
          const dest = (lane.destination || "").trim();
          const oState = (lane.originState || "").trim();
          const dState = (lane.destinationState || "").trim();
          const vol = lane.volume || 0;

          if (orig && dest) {
            const corridorKey = `${orig.toLowerCase()}|${oState.toLowerCase()}|${dest.toLowerCase()}|${dState.toLowerCase()}`;
            const existing = corridorMap.get(corridorKey);
            if (existing) {
              existing.totalVolume += vol;
              existing.count += 1;
              if (!existing.rfpTitles.includes(rfp.title)) existing.rfpTitles.push(rfp.title);
            } else {
              corridorMap.set(corridorKey, {
                origin: orig,
                originState: oState,
                destination: dest,
                destinationState: dState,
                totalVolume: vol,
                count: 1,
                rfpTitles: [rfp.title],
              });
            }
          }

          const addHub = (name: string, state: string, direction: "inbound" | "outbound") => {
            if (!name) return;
            const key = `${name.toLowerCase()}|${state.toLowerCase()}`;
            const existing = hubMap.get(key);
            if (existing) {
              if (direction === "inbound") {
                existing.inboundVolume += vol;
                existing.inboundCount += 1;
              } else {
                existing.outboundVolume += vol;
                existing.outboundCount += 1;
              }
            } else {
              hubMap.set(key, {
                facility: name,
                state,
                inboundVolume: direction === "inbound" ? vol : 0,
                outboundVolume: direction === "outbound" ? vol : 0,
                inboundCount: direction === "inbound" ? 1 : 0,
                outboundCount: direction === "outbound" ? 1 : 0,
              });
            }
          };

          addHub(orig, oState, "outbound");
          addHub(dest, dState, "inbound");

          if (oState && dState) {
            const stKey = `${oState.toLowerCase()}→${dState.toLowerCase()}`;
            const existing = stateCorridorMap.get(stKey);
            if (existing) {
              existing.totalVolume += vol;
              existing.laneCount += 1;
            } else {
              stateCorridorMap.set(stKey, {
                originState: oState,
                destinationState: dState,
                totalVolume: vol,
                laneCount: 1,
              });
            }
          }
        }
      }

      const topCorridors = Array.from(corridorMap.values())
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .slice(0, 15)
        .map(c => ({
          ...c,
          lane: `${c.origin}${c.originState ? `, ${c.originState}` : ""} → ${c.destination}${c.destinationState ? `, ${c.destinationState}` : ""}`,
          appearsInMultipleRfps: c.rfpTitles.length > 1,
        }));

      const hubs = Array.from(hubMap.values())
        .filter(h => h.inboundCount > 0 && h.outboundCount > 0)
        .sort((a, b) => (b.inboundVolume + b.outboundVolume) - (a.inboundVolume + a.outboundVolume))
        .slice(0, 10)
        .map(h => ({
          ...h,
          fullName: h.state ? `${h.facility}, ${h.state}` : h.facility,
          totalVolume: h.inboundVolume + h.outboundVolume,
        }));

      const stateCorridors = Array.from(stateCorridorMap.values())
        .sort((a, b) => b.totalVolume - a.totalVolume)
        .slice(0, 15)
        .map(s => ({
          ...s,
          corridor: `${s.originState} → ${s.destinationState}`,
        }));

      res.json({ topCorridors, hubs, stateCorridors });
    } catch (error) {
      console.error("Error computing lane patterns:", error);
      res.status(500).json({ error: "Failed to compute lane patterns" });
    }
  });

  app.get("/api/companies/:id/facility-coverage", async (req, res) => {
    try {
      const companyId = (req.params.id as string);
      const allRfps = await storage.getRfps();
      const contacts = await storage.getContactsByCompany(companyId);

      const facilityMap = new Map<string, {
        facility: string;
        state: string;
        type: "origin" | "destination";
        totalVolume: number;
        laneCount: number;
        lanes: string[];
        rfpTitles: string[];
      }>();

      for (const rfp of allRfps) {
        if (rfp.companyId !== companyId) continue;
        const fileData = rfp.fileData as { rows?: any[]; highVolumeLanes?: any[] } | null;
        if (!fileData || Array.isArray(fileData) || !fileData.highVolumeLanes) continue;

        for (const lane of fileData.highVolumeLanes) {
          const addFacility = (name: string, state: string, type: "origin" | "destination") => {
            if (!name) return;
            const key = `${name.toLowerCase()}|${state.toLowerCase()}|${type}`;
            const existing = facilityMap.get(key);
            if (existing) {
              existing.totalVolume += lane.volume || 0;
              existing.laneCount += 1;
              if (!existing.lanes.includes(lane.lane)) existing.lanes.push(lane.lane);
              if (!existing.rfpTitles.includes(rfp.title)) existing.rfpTitles.push(rfp.title);
            } else {
              facilityMap.set(key, {
                facility: name,
                state: state,
                type,
                totalVolume: lane.volume || 0,
                laneCount: 1,
                lanes: [lane.lane],
                rfpTitles: [rfp.title],
              });
            }
          };

          addFacility(lane.origin, lane.originState || "", "origin");
          addFacility(lane.destination, lane.destinationState || "", "destination");
        }
      }

      const contactLanes = new Set<string>();
      const contactRegions = new Set<string>();
      for (const contact of contacts) {
        if (contact.lanes) {
          for (const l of contact.lanes) contactLanes.add(l.toLowerCase());
        }
        if (contact.regions) {
          for (const r of contact.regions) contactRegions.add(r.toLowerCase());
        }
      }

      const facilities = Array.from(facilityMap.values()).map((f) => {
        const facilityLower = f.facility.toLowerCase();
        const stateLower = f.state.toLowerCase();
        const fullName = f.state ? `${f.facility}, ${f.state}` : f.facility;
        const fullNameLower = fullName.toLowerCase();

        let coveredBy: string | null = null;
        for (const contact of contacts) {
          const lanes = (contact.lanes || []).map(l => l.toLowerCase().trim());
          const regions = (contact.regions || []).map(r => r.toLowerCase().trim());

          const laneMatch = lanes.some(l => {
            if (!l) return false;
            if (l.includes(facilityLower) || facilityLower.includes(l)) return true;
            if (fullNameLower && l.includes(fullNameLower)) return true;
            return false;
          });

          const regionMatch = regions.some(r => {
            if (!r) return false;
            if (r.includes(facilityLower) || facilityLower.includes(r)) return true;
            if (stateLower && stateLower.length >= 2 && r === stateLower) return true;
            if (fullNameLower && r.includes(fullNameLower)) return true;
            return false;
          });

          if (laneMatch || regionMatch) {
            coveredBy = contact.name;
            break;
          }
        }

        return {
          ...f,
          fullName,
          covered: !!coveredBy,
          coveredBy,
        };
      });

      facilities.sort((a, b) => {
        if (a.covered !== b.covered) return a.covered ? 1 : -1;
        return b.totalVolume - a.totalVolume;
      });

      const gaps = facilities.filter(f => !f.covered).length;
      const covered = facilities.filter(f => f.covered).length;

      res.json({ facilities, summary: { total: facilities.length, gaps, covered } });
    } catch (error) {
      console.error("Error computing facility coverage:", error);
      res.status(500).json({ error: "Failed to compute facility coverage" });
    }
  });

  app.delete("/api/rfps/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteRfp((req.params.id as string));
      if (!deleted) {
        return res.status(404).json({ error: "RFP not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting RFP:", error);
      res.status(500).json({ error: "Failed to delete RFP" });
    }
  });

  app.get("/api/awards", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let allAwards = await storage.getAwards();
      const orgCompanies = await storage.getCompanies(currentUser.organizationId);
      const orgCompanyIds = new Set(orgCompanies.map(c => c.id));
      allAwards = allAwards.filter(a => orgCompanyIds.has(a.companyId));
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        allAwards = allAwards.filter(a => visibleIds.includes(a.companyId));
      }
      res.json(allAwards);
    } catch (error) {
      console.error("Error fetching awards:", error);
      res.status(500).json({ error: "Failed to fetch awards" });
    }
  });

  app.post("/api/awards", async (req, res) => {
    try {
      const parsed = insertAwardSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const award = await storage.createAward(parsed.data);
      res.status(201).json(award);
    } catch (error) {
      console.error("Error creating award:", error);
      res.status(500).json({ error: "Failed to create award" });
    }
  });

  app.patch("/api/awards/:id", async (req, res) => {
    try {
      const existing = await storage.getAward((req.params.id as string));
      if (!existing) {
        return res.status(404).json({ error: "Award not found" });
      }
      const parsed = insertAwardSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const award = await storage.updateAward((req.params.id as string), parsed.data);
      res.json(award);
    } catch (error) {
      console.error("Error updating award:", error);
      res.status(500).json({ error: "Failed to update award" });
    }
  });

  app.delete("/api/awards/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteAward((req.params.id as string));
      if (!deleted) {
        return res.status(404).json({ error: "Award not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting award:", error);
      res.status(500).json({ error: "Failed to delete award" });
    }
  });

  // ── Market Share ──────────────────────────────────────────────────────────

  app.get("/api/companies/:id/market-share", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const entries = await storage.getMarketShareEntries((req.params.id as string));
      res.json(entries);
    } catch (error) {
      console.error("Error fetching market share:", error);
      res.status(500).json({ error: "Failed to fetch market share data" });
    }
  });

  // Auto-calculate monthly load counts from financial data for a given company
  app.get("/api/companies/:id/market-share/auto-calc", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg((req.params.id as string), user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const customerAliases = company.financialAlias
        ? company.financialAlias.split(',').map((a: string) => a.trim().toLowerCase()).filter(Boolean)
        : [company.name.toLowerCase().trim()];
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);

      const msCols = resolveColumns(allRows);
      // Filter rows matching this customer (checks all comma-separated aliases)
      const matchedRows = allRows.filter(r => {
        const cust = getCustomerFromRow(r, msCols).toLowerCase();
        return customerAliases.some(alias => cust === alias || cust.includes(alias) || alias.includes(cust));
      });

      // Group by month
      const byMonth: Record<string, { vtLoads: number; spotLoads: number }> = {};
      for (const row of matchedRows) {
        const rawDate = row[msCols.dateOrdered] || "";
        if (!rawDate) continue;
        const d = new Date(rawDate);
        if (isNaN(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!byMonth[key]) byMonth[key] = { vtLoads: 0, spotLoads: 0 };
        byMonth[key].vtLoads++;
        const tenderType = String(row[msCols.tenderMethod] || row[msCols.orderType] || row[msCols.status] || "").toLowerCase();
        if (tenderType.includes("spot") || tenderType.includes("transact")) byMonth[key].spotLoads++;
      }

      const months = Object.keys(byMonth).sort();
      const result = months.map(key => {
        const [year, month] = key.split("-");
        const date = new Date(Number(year), Number(month) - 1, 1);
        const label = date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
        return {
          periodKey: key,
          periodLabel: label,
          periodStart: `${key}-01`,
          periodEnd: new Date(Number(year), Number(month), 0).toISOString().split("T")[0],
          vtLoads: byMonth[key].vtLoads,
          spotLoads: byMonth[key].spotLoads,
        };
      });

      res.json({ months: result, totalRows: matchedRows.length, customerName });
    } catch (error) {
      console.error("Error auto-calculating market share:", error);
      res.status(500).json({ error: "Failed to calculate from financial data" });
    }
  });

  app.post("/api/companies/:id/market-share", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const entry = await storage.createMarketShareEntry({
        ...req.body,
        companyId: (req.params.id as string),
        createdAt: new Date().toISOString(),
        createdBy: user.id,
      });
      res.status(201).json(entry);
    } catch (error) {
      console.error("Error creating market share entry:", error);
      res.status(500).json({ error: "Failed to create market share entry" });
    }
  });

  app.post("/api/companies/:id/market-share/upload", upload.single("file"), async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" }) as any[];

      const normalize = (key: string) => key.toLowerCase().replace(/[\s_\-\/]+/g, "");

      const findVal = (row: any, ...candidates: string[]): string => {
        const rowNorm = Object.fromEntries(Object.entries(row).map(([k, v]) => [normalize(k), v]));
        for (const c of candidates) {
          const val = rowNorm[normalize(c)];
          if (val !== undefined && val !== "") return String(val);
        }
        return "";
      };

      const created: any[] = [];
      const skipped: string[] = [];

      for (const row of rows) {
        const periodLabel = findVal(row, "periodLabel", "period_label", "Period Label", "Period", "period", "Month", "month");
        if (!periodLabel) { skipped.push("row missing period label"); continue; }

        const vtStr = findVal(row, "vtLoads", "vt_loads", "VT Loads", "VT", "vt", "ContractedLoads", "contracted_loads", "Contracted");
        const spotStr = findVal(row, "spotLoads", "spot_loads", "Spot Loads", "Spot", "spot", "SpotLoads");
        const totalStr = findVal(row, "totalMarketLoads", "total_market_loads", "Total Market Loads", "Total Market", "TotalMarket", "total", "Total");
        const entryType = findVal(row, "entryType", "entry_type", "Type", "type") || "monthly";
        const periodStart = findVal(row, "periodStart", "period_start", "Start", "start_date", "StartDate") || null;
        const periodEnd = findVal(row, "period_end", "periodEnd", "End", "end_date", "EndDate") || null;
        const notes = findVal(row, "notes", "Notes", "note", "Note") || null;

        const vtLoads = vtStr ? parseInt(vtStr.replace(/,/g, ""), 10) || 0 : 0;
        const spotLoads = spotStr ? parseInt(spotStr.replace(/,/g, ""), 10) || 0 : 0;
        const totalMarketLoads = totalStr ? parseInt(totalStr.replace(/,/g, ""), 10) || null : null;

        const entry = await storage.createMarketShareEntry({
          companyId: (req.params.id as string),
          entryType: entryType === "rfp_cycle" ? "rfp_cycle" : "monthly",
          periodLabel,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
          vtLoads,
          spotLoads,
          totalMarketLoads,
          notes,
          rfpId: null,
          createdAt: new Date().toISOString(),
          createdBy: user.id,
        });
        created.push(entry);
      }

      res.json({ created: created.length, skipped: skipped.length, entries: created });
    } catch (error) {
      console.error("Error uploading market share file:", error);
      res.status(500).json({ error: "Failed to process market share file" });
    }
  });

  app.patch("/api/market-share/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const updated = await storage.updateMarketShareEntry((req.params.id as string), req.body);
      if (!updated) return res.status(404).json({ error: "Entry not found" });
      res.json(updated);
    } catch (error) {
      console.error("Error updating market share entry:", error);
      res.status(500).json({ error: "Failed to update entry" });
    }
  });

  app.delete("/api/market-share/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deleteMarketShareEntry((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Entry not found" });
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting market share entry:", error);
      res.status(500).json({ error: "Failed to delete entry" });
    }
  });

  // Market share summary: all companies visible to user, with latest % + trend
  app.get("/api/market-share/summary", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Determine visible companies based on role
      let companies = await storage.getCompanies(req.session.organizationId!);
      if (user.role !== "admin") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        teamIds.push(user.id);
        companies = companies.filter(c => c.assignedTo && teamIds.includes(c.assignedTo));
      }

      const companyIds = new Set(companies.map(c => c.id));
      const allEntries = await storage.getAllMarketShareEntries();
      const allUsers = await storage.getUsers(req.session.organizationId!);

      // Group entries by company, sorted by periodStart asc (already ordered)
      const byCompany: Record<string, typeof allEntries> = {};
      for (const e of allEntries) {
        if (!companyIds.has(e.companyId)) continue;
        if (!byCompany[e.companyId]) byCompany[e.companyId] = [];
        byCompany[e.companyId].push(e);
      }

      const rows = companies
        .filter(c => byCompany[c.id]?.length)
        .map(c => {
          const entries = byCompany[c.id];
          // Only entries with enough denominator data
          const calcable = entries.filter(e => Number(e.totalMarketLoads) > 0);
          const last = calcable[calcable.length - 1];
          const prev = calcable[calcable.length - 2];
          const currentPct = last
            ? Math.round(((Number(last.vtLoads) + Number(last.spotLoads)) / Number(last.totalMarketLoads)) * 100 * 10) / 10
            : null;
          const prevPct = prev
            ? Math.round(((Number(prev.vtLoads) + Number(prev.spotLoads)) / Number(prev.totalMarketLoads)) * 100 * 10) / 10
            : null;
          const trend = currentPct === null ? "none"
            : prevPct === null ? "none"
            : currentPct > prevPct ? "up"
            : currentPct < prevPct ? "down"
            : "flat";
          const am = allUsers.find(u => u.id === c.assignedTo);
          return {
            companyId: c.id,
            companyName: c.name,
            amName: am ? am.name : null,
            currentPct,
            prevPct,
            trend,
            lastPeriodLabel: last?.periodLabel || null,
            entryCount: calcable.length,
            monthlyData: calcable.map(e => ({
              label: e.periodLabel,
              pct: Math.round(((Number(e.vtLoads) + Number(e.spotLoads)) / Number(e.totalMarketLoads)) * 100 * 10) / 10,
            })),
          };
        })
        .filter(r => r.currentPct !== null)
        .sort((a, b) => (b.currentPct ?? 0) - (a.currentPct ?? 0));

      res.json(rows);
    } catch (error) {
      console.error("Error fetching market share summary:", error);
      res.status(500).json({ error: "Failed to fetch market share summary" });
    }
  });

  // ── Task Assignment ──────────────────────────────────────────────────────────

  app.get("/api/tasks", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allTasks = await storage.getTasks();
      let filtered: typeof allTasks;
      if (user.role === "admin") {
        filtered = allTasks;
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        filtered = allTasks.filter(t => teamIds.includes(t.assignedTo) || teamIds.includes(t.assignedBy));
      } else {
        filtered = allTasks.filter(t => t.assignedTo === user.id || t.assignedBy === user.id);
      }
      const counts = await storage.getTaskCommentCounts(filtered.map(t => t.id));
      return res.json(filtered.map(t => ({ ...t, commentCount: counts[t.id] ?? 0 })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.get("/api/tasks/company/:companyId", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyTasks = await storage.getTasksByCompany((req.params.companyId as string));
      const counts = await storage.getTaskCommentCounts(companyTasks.map(t => t.id));
      res.json(companyTasks.map(t => ({ ...t, commentCount: counts[t.id] ?? 0 })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company tasks" });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, notes, status, dueDate, assignedTo, companyId, contactId, attachedLaneData } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      if (!assignedTo || typeof assignedTo !== "string") {
        return res.status(400).json({ error: "Assignee is required" });
      }
      const validStatuses = ["open", "in_progress", "completed"];
      const taskStatus = status && validStatuses.includes(status) ? status : "open";
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      const allUsers = await storage.getUsers(req.session.organizationId!);
      let assignableIds: Set<string>;
      if (user.role === "admin") {
        assignableIds = new Set(allUsers.map(u => u.id));
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        assignableIds = new Set(teamIds);
        // Also allow assigning upward to their manager and all admins
        if (user.managerId) assignableIds.add(user.managerId);
        allUsers.filter(u => u.role === "admin").forEach(u => assignableIds.add(u.id));
      } else {
        assignableIds = new Set([user.id]);
        if (user.managerId) {
          assignableIds.add(user.managerId);
          allUsers.forEach(u => {
            if (u.managerId === user.managerId) assignableIds.add(u.id);
          });
        }
        // Also allow assigning to any admin
        allUsers.filter(u => u.role === "admin").forEach(u => assignableIds.add(u.id));
      }
      if (!assignableIds.has(assignedTo)) {
        return res.status(403).json({ error: "Cannot assign task to that user" });
      }
      if (companyId && !(await canAccessCompany(user, companyId))) {
        return res.status(403).json({ error: "Cannot link task to inaccessible company" });
      }
      const task = await storage.createTask({
        title: title.trim(),
        notes: notes || null,
        status: taskStatus,
        dueDate: dueDate || null,
        assignedTo,
        assignedBy: user.id,
        companyId: companyId || null,
        contactId: contactId || null,
        attachedLaneData: attachedLaneData ?? null,
        createdAt: new Date().toISOString(),
      });
      if (assignedTo !== user.id) {
        storage.createNotification({
          userId: assignedTo,
          type: "task_assigned",
          title: `${user.name} assigned you a task`,
          body: title.trim(),
          link: "/tasks",
          relatedId: task.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.status(201).json(task);
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTask((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Task not found" });
      if (existing.assignedTo !== user.id && existing.assignedBy !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized to edit this task" });
      }
      const validStatuses = ["open", "in_progress", "completed"];
      const data: any = {};
      if (req.body.title !== undefined) {
        const trimmed = String(req.body.title).trim();
        if (!trimmed) return res.status(400).json({ error: "Title cannot be empty" });
        data.title = trimmed;
      }
      if (req.body.notes !== undefined) data.notes = req.body.notes;
      if (req.body.status !== undefined) {
        if (!validStatuses.includes(req.body.status)) {
          return res.status(400).json({ error: "Invalid status. Must be open, in_progress, or completed" });
        }
        data.status = req.body.status;
      }
      if (req.body.dueDate !== undefined) {
        if (req.body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate)) {
          return res.status(400).json({ error: "Invalid date format" });
        }
        data.dueDate = req.body.dueDate;
      }
      if (req.body.assignedTo !== undefined) {
        data.assignedTo = req.body.assignedTo;
      }
      const task = await storage.updateTask((req.params.id as string), data);
      // Notify new assignee if reassigned to someone else
      if (data.assignedTo && data.assignedTo !== existing.assignedTo && data.assignedTo !== user.id) {
        storage.createNotification({
          userId: data.assignedTo,
          type: "task_assigned",
          title: `${user.name} assigned you a task`,
          body: task?.title ?? existing.title,
          link: "/tasks",
          relatedId: existing.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      // Notify creator when assignee marks task completed
      const justCompleted = data.status === "completed" && existing.status !== "completed";
      const completionNote = typeof req.body.completionNote === "string" ? req.body.completionNote.trim() : "";
      if (justCompleted && existing.assignedBy && existing.assignedBy !== user.id) {
        // Post the completion note as a task comment so it's visible in the thread
        if (completionNote) {
          await storage.createTaskComment({
            taskId: existing.id,
            authorId: user.id,
            content: completionNote,
            createdAt: new Date().toISOString(),
            parentId: null,
          }).catch((e) => console.error("Completion note comment error:", e));
        }
        const notifyBody = completionNote
          ? `${task?.title ?? existing.title} — "${completionNote}"`
          : task?.title ?? existing.title;
        storage.createNotification({
          userId: existing.assignedBy,
          type: "task_completed",
          title: `${user.name} completed a task`,
          body: notifyBody,
          link: "/tasks",
          relatedId: existing.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTask((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Task not found" });
      if (existing.assignedBy !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the creator or admin can delete tasks" });
      }
      await storage.deleteTask((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete task" });
    }
  });

  // ── Task Comments ────────────────────────────────────────────────────────

  app.get("/api/tasks/:id/comments", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getTaskComments((req.params.id as string));
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/tasks/:id/comments", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, parentId } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: "Content is required" });
      const task = await storage.getTask((req.params.id as string));
      if (!task) return res.status(404).json({ error: "Task not found" });
      const comment = await storage.createTaskComment({
        taskId: (req.params.id as string),
        authorId: user.id,
        content: content.trim(),
        createdAt: new Date().toISOString(),
        parentId: parentId || null,
      });
      // Notify task assignee, creator, and anyone who has previously commented (thread following)
      const existingComments = await storage.getTaskComments((req.params.id as string));
      const threadParticipants = existingComments.map(c => c.authorId);
      const notifyIds = [...new Set([task.assignedTo, task.assignedBy, ...threadParticipants])].filter(
        (id): id is string => !!id && id !== user.id
      );
      for (const uid of notifyIds) {
        storage.createNotification({
          userId: uid,
          type: "task_comment",
          title: `${user.name} commented on a task`,
          body: task.title,
          link: "/tasks",
          relatedId: task.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ error: "Failed to create comment" });
    }
  });

  app.post("/api/tasks/:id/bump", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const task = await storage.getTask((req.params.id as string));
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (task.assignedBy !== user.id) return res.status(403).json({ error: "Only the task creator can send a reminder" });
      if (task.status === "completed") return res.status(400).json({ error: "Task is already completed" });
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const due = task.dueDate ? new Date(task.dueDate + "T00:00:00") : null;
      if (!due) return res.status(400).json({ error: "Task has no due date" });
      const daysOverdue = Math.floor((today.getTime() - due.getTime()) / 86400000);
      if (daysOverdue < 2) return res.status(400).json({ error: "Task must be at least 2 days overdue to send a reminder" });
      storage.createNotification({
        userId: task.assignedTo,
        type: "task_reminder",
        title: `Reminder from ${user.name}`,
        body: `"${task.title}" is ${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`,
        link: "/tasks",
        relatedId: task.id,
        read: false,
      }).catch((e) => console.error("Notification error:", e));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to send reminder" });
    }
  });

  app.delete("/api/tasks/:taskId/comments/:commentId", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getTaskComments((req.params.taskId as string));
      const comment = comments.find(c => c.id === (req.params.commentId as string));
      if (!comment) return res.status(404).json({ error: "Comment not found" });
      if (comment.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }
      await storage.deleteTaskComment((req.params.commentId as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });

  // ── Callouts ─────────────────────────────────────────────────────────────

  app.get("/api/callouts", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allCallouts = await storage.getCallouts();
      const visibleIds = await getVisibleCompanyIds(user);
      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const filtered = visibleIds === null
        ? allCallouts
        : allCallouts.filter(c => {
            const companyOk = !c.companyId || visibleIds.includes(c.companyId);
            const authorOk = !visibleAuthorIds || visibleAuthorIds.includes(c.authorId);
            return companyOk && authorOk;
          });
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch callouts" });
    }
  });

  app.get("/api/callouts/company/:companyId", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyCallouts = await storage.getCalloutsByCompany((req.params.companyId as string));
      res.json(companyCallouts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company callouts" });
    }
  });

  app.post("/api/callouts", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, body, tag, companyId, parentId } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      const validTags = ["Trend", "Callout", "Idea"];
      if (tag && !validTags.includes(tag)) {
        return res.status(400).json({ error: "Invalid tag" });
      }
      let parentCallout: Awaited<ReturnType<typeof storage.getCallout>> = undefined;
      if (parentId) {
        parentCallout = await storage.getCallout(parentId);
        if (!parentCallout) return res.status(404).json({ error: "Parent callout not found" });
      }
      if (companyId) {
        if (!(await canAccessCompany(user, companyId))) {
          return res.status(403).json({ error: "Cannot link callout to inaccessible company" });
        }
      }
      const callout = await storage.createCallout({
        title: title.trim(),
        body: body || null,
        tag: tag || null,
        companyId: companyId || null,
        authorId: user.id,
        parentId: parentId || null,
        createdAt: new Date().toISOString(),
      });
      // Notify the original author + all thread participants (thread following)
      if (parentCallout) {
        const allCallouts = await storage.getCallouts();
        const threadReplies = allCallouts.filter(c => c.parentId === parentCallout!.id);
        const threadParticipants = new Set([
          parentCallout.authorId,
          ...threadReplies.map(c => c.authorId),
        ]);
        threadParticipants.delete(user.id);
        for (const uid of threadParticipants) {
          const isOriginalAuthor = uid === parentCallout.authorId;
          storage.createNotification({
            userId: uid,
            type: "post_reply",
            title: isOriginalAuthor
              ? `${user.name} replied to your callout`
              : `${user.name} replied to a thread you're in`,
            body: (title.trim()).length > 80 ? title.trim().slice(0, 80) + "…" : title.trim(),
            link: "/",
            relatedId: callout.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
      }
      res.status(201).json(callout);
    } catch (error) {
      console.error("Error creating callout:", error);
      res.status(500).json({ error: "Failed to create callout" });
    }
  });

  app.delete("/api/callouts/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const callout = await storage.getCallout((req.params.id as string));
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      if (callout.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete callouts" });
      }
      await storage.deleteCallout((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete callout" });
    }
  });

  // ── Opportunity / Win Logs ────────────────────────────────────────────────
  app.get("/api/opportunity-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repId, companyId, type, startDate, endDate } = req.query as Record<string, string>;
      const logs = await storage.getOpportunityLogs(req.session.organizationId!, {
        repId: repId || undefined,
        companyId: companyId || undefined,
        type: type || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch opportunity logs" });
    }
  });

  app.get("/api/opportunity-logs/summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repIds, startDate, endDate } = req.query as Record<string, string>;
      const ids = repIds ? repIds.split(",") : [];
      const summary = await storage.getOpportunityLogSummary(
        ids,
        startDate || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
        endDate || new Date().toISOString().split("T")[0]
      );
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch opportunity log summary" });
    }
  });

  app.post("/api/opportunity-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { type, category, title, description, companyId, estimatedLoads, estimatedValue, loggedAt } = req.body;
      if (!type || !title) return res.status(400).json({ error: "type and title are required" });

      const log = await storage.createOpportunityLog({
        organizationId: req.session.organizationId!,
        repId: user.id,
        companyId: companyId || null,
        type,
        category: category || "other",
        title,
        description: description || null,
        estimatedLoads: estimatedLoads != null ? Number(estimatedLoads) : null,
        estimatedValue: estimatedValue != null ? String(estimatedValue) : null,
        loggedAt: loggedAt || new Date().toISOString().split("T")[0],
        createdAt: new Date().toISOString(),
      });

      // Auto-post to callouts feed when a win is logged
      if (type === "win") {
        const categoryLabels: Record<string, string> = {
          spot_batch: "Batch of Spot Loads",
          dedicated_contracted: "Spot to Contracted Conversion",
          mini_bid: "Mini-Bid",
          project: "Project",
          other: "New Site, First Opp",
        };
        const catLabel = categoryLabels[category] || category || "Win";
        const parts = [`🏆 ${user.name} logged a win: ${title}`, `Category: ${catLabel}`];
        if (description) parts.push(description);
        const extras: string[] = [];
        if (estimatedLoads) extras.push(`${estimatedLoads} loads`);
        if (estimatedValue) extras.push(`$${Number(estimatedValue).toLocaleString()} est. value`);
        if (extras.length) parts.push(extras.join(" · "));
        await storage.createCallout({
          title: `${user.name}: ${title}`,
          body: parts.slice(1).join("\n"),
          tag: "win",
          companyId: companyId || null,
          authorId: user.id,
          parentId: null,
          createdAt: new Date().toISOString(),
        });
      }

      let easterEgg = null;
      {
        const now2 = new Date();
        const monthStart = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}-01`;
        const count = await storage.countOpportunityLogsThisMonth(user.id, monthStart);
        if (count >= 4) easterEgg = await tryClaimEasterEgg("first_opportunity_4", user.id);
      }
      res.status(201).json({ ...log, easterEgg });
    } catch (error) {
      res.status(500).json({ error: "Failed to create opportunity log" });
    }
  });

  app.delete("/api/opportunity-logs/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const logs = await storage.getOpportunityLogs(req.session.organizationId!);
      const log = logs.find(l => l.id === req.params.id);
      if (!log) return res.status(404).json({ error: "Not found" });
      if (log.repId !== user.id && user.role !== "admin") return res.status(403).json({ error: "Not authorized" });
      await storage.deleteOpportunityLog(req.params.id as string);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete opportunity log" });
    }
  });

  // ── Feed Posts (Trends / Growth / Ideas) ─────────────────────────────────

  app.get("/api/feed-posts", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const topLevel = await storage.getFeedPosts(visibleAuthorIds);
      // Attach replies to each top-level post
      const parentIds = topLevel.map((p: any) => p.id);
      const replies = await storage.getFeedReplies(parentIds);
      const replyMap: Record<string, any[]> = {};
      for (const r of replies) {
        if (!replyMap[r.parentId!]) replyMap[r.parentId!] = [];
        replyMap[r.parentId!].push(r);
      }
      return res.json(topLevel.map((p: any) => ({ ...p, replies: replyMap[p.id] || [] })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feed posts" });
    }
  });

  app.post("/api/feed-posts", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, category, parentId } = req.body;
      const trimmed = typeof content === "string" ? content.trim() : "";
      if (!trimmed) return res.status(400).json({ error: "Content is required" });

      // If replying to an existing post, all roles are allowed
      if (parentId) {
        const parent = await storage.getFeedPost(parentId);
        if (!parent) return res.status(404).json({ error: "Parent post not found" });
        const post = await storage.createFeedPost({
          content: trimmed,
          category: parent.category,
          authorId: user.id,
          createdAt: new Date().toISOString(),
          parentId,
        });
        // Notify the original post author if someone else replied
        if (parent.authorId !== user.id) {
          storage.createNotification({
            userId: parent.authorId,
            type: "post_reply",
            title: `${user.name} replied to your post`,
            body: trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed,
            link: "/",
            relatedId: post.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
        return res.status(201).json(post);
      }

      // Top-level post: all authenticated users can post
      const validCategories = ["trend", "growth", "idea", "celebrate"];
      if (!validCategories.includes(category)) return res.status(400).json({ error: "Invalid category" });
      const post = await storage.createFeedPost({
        content: trimmed,
        category,
        authorId: user.id,
        createdAt: new Date().toISOString(),
        parentId: null,
      });
      // Fan out notification to team members who can see this post
      (async () => {
        try {
          const allUsers = await storage.getUsers(req.session.organizationId!);
          const directReports = allUsers.filter(u => u.managerId === user.id).map(u => u.id);
          const grandReports = allUsers.filter(u => directReports.includes(u.managerId ?? "")).map(u => u.id);
          let recipientIds: string[];
          if (user.role === "admin") {
            recipientIds = allUsers.filter(u => u.id !== user.id).map(u => u.id);
          } else if (user.role === "director" || user.role === "sales_director") {
            recipientIds = [...new Set([...directReports, ...grandReports])];
          } else {
            recipientIds = [...new Set([...directReports, ...grandReports])];
            if (user.managerId) recipientIds.push(user.managerId);
          }
          const categoryLabel = category === "growth" ? "Growth Win" : category === "trend" ? "Trend" : "Idea";
          const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
          await Promise.all(
            recipientIds
              .filter(id => id !== user.id)
              .map(id =>
                storage.createNotification({
                  userId: id,
                  type: "new_post",
                  title: `${user.name} posted a ${categoryLabel}`,
                  body: preview,
                  link: "/",
                  relatedId: post.id,
                  read: false,
                }).catch(() => {})
              )
          );
        } catch (e) {
          console.error("Feed notification fan-out error:", e);
        }
      })();
      res.status(201).json(post);
    } catch (error) {
      res.status(500).json({ error: "Failed to create feed post" });
    }
  });

  app.delete("/api/feed-posts/:id", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Post not found" });
      if (post.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete posts" });
      }
      await storage.deleteFeedPost((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete feed post" });
    }
  });

  app.patch("/api/feed-posts/:id/pin", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const canPin = ["admin", "director", "national_account_manager", "sales_director"].includes(user.role);
      if (!canPin) return res.status(403).json({ error: "Only admins and managers can pin posts" });
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Post not found" });
      const updated = await storage.pinFeedPost((req.params.id as string), !!req.body.pinned);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to pin post" });
    }
  });

  // ── Internal Posts (Leadership → Team Direct Messages) ────────────────────

  app.get("/api/internal-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgUsers = await storage.getUsers(user.organizationId);
      const orgUserIds = orgUsers.map(u => u.id);
      const posts = await storage.getInternalPosts(user.id, user.role, orgUserIds);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch internal posts" });
    }
  });

  app.post("/api/internal-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, recipientIds, parentId } = req.body;
      // Allow empty content when attachments will follow (attachments are uploaded separately after the post is created)
      // Only admins/directors can start new threads; anyone who can see the thread can reply
      const isLeadership = user.role === "admin" || user.role === "director";
      if (!parentId && !isLeadership) {
        return res.status(403).json({ error: "Only admins and directors can start new threads" });
      }
      const post = await storage.createInternalPost({
        content: content.trim(),
        authorId: user.id,
        recipientIds: Array.isArray(recipientIds) ? recipientIds : [],
        parentId: parentId || null,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(post);
    } catch (error) {
      res.status(500).json({ error: "Failed to create internal post" });
    }
  });

  app.delete("/api/internal-posts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isLeadership = user.role === "admin" || user.role === "director";
      if (!isLeadership) return res.status(403).json({ error: "Only admins and directors can delete posts" });
      await storage.deleteInternalPost((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete internal post" });
    }
  });

  // ── Callout Reactions ──────────────────────────────────────────────────────

  app.get("/api/callouts/reactions", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ids = req.query.ids;
      if (!ids || typeof ids !== "string") return res.json([]);
      const requestedIds = ids.split(",").filter(Boolean);
      if (requestedIds.length === 0) return res.json([]);

      let visibleCallouts: Callout[];
      if (user.role === "admin") {
        visibleCallouts = await storage.getCallouts();
      } else {
        visibleCallouts = await storage.getCallouts();
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamSet = new Set(teamIds);
        visibleCallouts = visibleCallouts.filter(c => teamSet.has(c.authorId));
      }

      const visibleCalloutIds = new Set(visibleCallouts.map(c => c.id));
      const filteredIds = requestedIds.filter(id => visibleCalloutIds.has(id));
      if (filteredIds.length === 0) return res.json([]);

      const reactions = await storage.getReactionsByCalloutIds(filteredIds);
      res.json(reactions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch reactions" });
    }
  });

  app.post("/api/callouts/:id/reactions", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin" && user.role !== "director" && user.role !== "sales_director") {
        return res.status(403).json({ error: "Only admins and directors can react" });
      }
      const { emoji } = req.body;
      const validEmojis = ["👍", "❤️", "🔥", "💡", "✅"];
      if (!emoji || !validEmojis.includes(emoji)) {
        return res.status(400).json({ error: "Invalid emoji" });
      }
      const callout = await storage.getCallout((req.params.id as string));
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      const result = await storage.toggleReaction((req.params.id as string), user.id, emoji);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle reaction" });
    }
  });

  // ── Feed Post Reactions ─────────────────────────────────────────────────────

  app.get("/api/feed/reactions", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ids = req.query.ids;
      if (!ids || typeof ids !== "string") return res.json([]);
      const requestedIds = ids.split(",").filter(Boolean);
      if (requestedIds.length === 0) return res.json([]);

      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const visiblePosts = await storage.getFeedPosts(visibleAuthorIds);
      const visiblePostIds = new Set(visiblePosts.map(p => p.id));
      const filteredIds = requestedIds.filter(id => visiblePostIds.has(id));
      if (filteredIds.length === 0) return res.json([]);

      const reactions = await storage.getReactionsByFeedPostIds(filteredIds);
      res.json(reactions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feed reactions" });
    }
  });

  app.post("/api/feed/:id/reactions", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { emoji } = req.body;
      const validEmojis = ["👍", "🔥", "💡", "❤️", "✅"];
      if (!emoji || !validEmojis.includes(emoji)) {
        return res.status(400).json({ error: "Invalid emoji" });
      }
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Feed post not found" });
      if (post.parentId) return res.status(400).json({ error: "Reactions are only allowed on top-level posts" });

      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      if (visibleAuthorIds && !visibleAuthorIds.includes(post.authorId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const result = await storage.toggleFeedPostReaction((req.params.id as string), user.id, emoji);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle feed reaction" });
    }
  });

  // ── 1-on-1 Sessions ────────────────────────────────────────────────────────

  app.get("/api/1on1/session", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const session = await storage.getOrCreateActiveSession(managerId, repId);
      const topics = await storage.getTopicsBySession(session.id);
      res.json({ session, topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  app.post("/api/1on1/session/:id/topics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { text, tag } = req.body;
      if (!text?.trim()) return res.status(400).json({ error: "Text required" });
      const topic = await storage.createTopic({
        sessionId: (req.params.id as string),
        addedById: user.id,
        text: text.trim(),
        tag: tag || "fyi",
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(topic);
    } catch (error) {
      res.status(500).json({ error: "Failed to add topic" });
    }
  });

  app.patch("/api/1on1/topics/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: "Status required" });
      const updated = await storage.updateTopicStatus((req.params.id as string), status);
      if (!updated) return res.status(404).json({ error: "Topic not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update topic" });
    }
  });

  app.delete("/api/1on1/topics/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deleteTopic((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Topic not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete topic" });
    }
  });

  app.post("/api/1on1/session/:id/close", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { carryForwardTopicIds, moraleScore, sessionSummary, sendSummaryEmail } = req.body || {};
      const oldSession = await storage.getSession((req.params.id as string));
      const newSession = await storage.closeSession((req.params.id as string), {
        carryForwardTopicIds: Array.isArray(carryForwardTopicIds) ? carryForwardTopicIds : undefined,
        moraleScore: typeof moraleScore === "number" ? moraleScore : undefined,
        sessionSummary: typeof sessionSummary === "string" && sessionSummary.trim() ? sessionSummary.trim() : undefined,
      });
      // Optionally send summary email to both participants
      if (sendSummaryEmail && oldSession) {
        try {
          const { build1on1SummaryEmail, sendEmail } = await import("./emailService");
          const topics = await storage.getTopicsBySession((req.params.id as string));
          const allUsers = await storage.getUsers();
          const nam = allUsers.find(u => u.id === oldSession.namId);
          const am = allUsers.find(u => u.id === oldSession.amId);
          if (nam?.email && am?.email) {
            const html = build1on1SummaryEmail({ session: { ...oldSession, moraleScore: moraleScore ?? null, sessionSummary: sessionSummary ?? null }, topics, namName: nam.name, amName: am.name });
            await sendEmail({ to: nam.email, subject: `1:1 Session Recap — ${am.name}`, html });
            await sendEmail({ to: am.email, subject: `1:1 Session Recap — with ${nam.name}`, html });
          }
        } catch (emailErr) {
          console.error("[1on1] summary email error:", emailErr);
        }
      }
      const easterEgg = await tryClaimEasterEgg("first_1on1_close", user.id);
      res.json({ ...newSession, easterEgg });
    } catch (error) {
      res.status(500).json({ error: "Failed to close session" });
    }
  });

  app.get("/api/1on1/archived", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const sessions = await storage.getArchivedSessions(managerId, repId);
      const sessionsWithTopics = await Promise.all(
        sessions.map(async (s) => ({
          ...s,
          topics: await storage.getTopicsBySession(s.id),
        }))
      );
      res.json(sessionsWithTopics);
    } catch (error) {
      res.status(500).json({ error: "Failed to get archived sessions" });
    }
  });

  app.patch("/api/1on1/session/:id/meeting-date", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { meetingDate } = req.body;
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingDate((req.params.id as string), meetingDate || null);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update meeting date" });
    }
  });

  app.patch("/api/1on1/session/:id/meeting-link", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { meetingLink } = req.body;
      if (meetingLink !== undefined && meetingLink !== null && meetingLink !== "" && typeof meetingLink !== "string") {
        return res.status(400).json({ error: "meetingLink must be a string or null" });
      }
      let normalizedLink: string | null = null;
      if (meetingLink && typeof meetingLink === "string" && meetingLink.trim()) {
        const trimmed = meetingLink.trim();
        try {
          const url = new URL(trimmed);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return res.status(400).json({ error: "Meeting link must use http or https" });
          }
        } catch {
          return res.status(400).json({ error: "Invalid URL format" });
        }
        if (trimmed.length > 2048) {
          return res.status(400).json({ error: "Meeting link is too long" });
        }
        normalizedLink = trimmed;
      }
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingLink((req.params.id as string), normalizedLink);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update meeting link" });
    }
  });

  app.patch("/api/1on1/session/:id/notes", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { notes } = req.body;
      if (typeof notes !== "string") return res.status(400).json({ error: "Notes must be a string" });
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.status !== "active") return res.status(400).json({ error: "Cannot update notes on an archived session" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionNotes((req.params.id as string), notes);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update notes" });
    }
  });

  app.get("/api/1on1/action-items", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const actionItems = await storage.getActionItemsByPairing(managerId, repId);
      res.json(actionItems);
    } catch (error) {
      res.status(500).json({ error: "Failed to get action items" });
    }
  });

  app.get("/api/1on1/manager-overview", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId } = req.query as { managerId?: string };
      if (!managerId) return res.status(400).json({ error: "managerId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isSelf = user.id === managerId;
      if (!isAdmin && !isSelf) return res.status(403).json({ error: "Access denied" });
      const activeSessions = await storage.getActiveSessionsForManager(managerId);
      const overview = await Promise.all(
        activeSessions.map(async (s) => {
          const topics = await storage.getTopicsBySession(s.id);
          // Find the most recently archived session for cadence tracking
          const archived = await storage.getArchivedSessions(managerId, s.amId);
          const lastClosed = archived.length > 0
            ? archived.sort((a, b) => new Date(b.closedAt || b.startDate).getTime() - new Date(a.closedAt || a.startDate).getTime())[0]
            : null;
          const daysSinceClose = lastClosed?.closedAt
            ? Math.round((Date.now() - new Date(lastClosed.closedAt).getTime()) / 86400000)
            : null;
          return {
            amId: s.amId,
            sessionId: s.id,
            startDate: s.startDate,
            pendingCount: topics.filter(t => t.status === "pending").length,
            discussedCount: topics.filter(t => t.status === "discussed").length,
            totalCount: topics.length,
            lastClosedAt: lastClosed?.closedAt ?? null,
            daysSinceClose,
          };
        })
      );
      res.json(overview);
    } catch (error) {
      res.status(500).json({ error: "Failed to get manager overview" });
    }
  });

  // ── Suggested topics for 1:1 based on rep's account data ──────────────────
  app.get("/api/1on1/suggested-topics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repId } = req.query as { repId?: string };
      if (!repId) return res.status(400).json({ error: "repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager";
      const isSelf = user.id === repId;
      if (!isAdmin && !isSelf) return res.status(403).json({ error: "Access denied" });

      const suggestions: { type: string; text: string; account?: string }[] = [];
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString();
      const fourteenDaysFromNow = new Date(today.getTime() + 14 * 86400000).toISOString().split("T")[0];

      // Get rep's org to look up companies
      const repUser = await storage.getUser(repId);
      if (!repUser) return res.status(404).json({ error: "User not found" });

      const allCompanies = await storage.getCompanies(repUser.organizationId || "");
      const repCompanies = allCompanies.filter(c => c.salesPersonId === repId || c.assignedTo === repId);

      // 1. Accounts with no meaningful touch in 30+ days (up to 3)
      const meaningfulTouchpoints = await storage.getTouchpointsByUser(repId, thirtyDaysAgo);
      const recentMeaningfulIds = new Set(meaningfulTouchpoints.filter(tp => tp.meaningful).map(tp => tp.companyId).filter(Boolean));
      const overdueAccounts = repCompanies.filter(c => !recentMeaningfulIds.has(c.id)).slice(0, 3);
      for (const co of overdueAccounts) {
        suggestions.push({
          type: "attention",
          text: `${co.name} hasn't had a meaningful conversation in 30+ days — what's the current status?`,
          account: co.name,
        });
      }

      // 2. Approaching RFP deadlines (within 14 days)
      const allRfps = await storage.getRfps();
      const repCompanyIds = new Set(repCompanies.map(c => c.id));
      const urgentRfps = allRfps
        .filter(r => repCompanyIds.has(r.companyId || "") && r.status === "open" && r.dueDate && r.dueDate <= fourteenDaysFromNow && r.dueDate >= todayStr)
        .slice(0, 2);
      for (const rfp of urgentRfps) {
        const company = repCompanies.find(c => c.id === rfp.companyId);
        const daysLeft = rfp.dueDate ? Math.round((new Date(rfp.dueDate + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
        suggestions.push({
          type: "rfp",
          text: `RFP for ${company?.name ?? "an account"} is due in ${daysLeft !== null ? `${daysLeft} day${daysLeft !== 1 ? "s" : ""}` : "soon"} — are we ready to submit?`,
          account: company?.name,
        });
      }

      // 3. Overdue tasks
      const allTasks = await storage.getTasks();
      const overdueTasks = allTasks
        .filter(t => t.assignedTo === repId && t.status !== "completed" && t.dueDate && t.dueDate < todayStr)
        .slice(0, 3);
      if (overdueTasks.length > 0) {
        suggestions.push({
          type: "tasks",
          text: `You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""} — let's pick one to close out this week`,
        });
      }

      res.json(suggestions);
    } catch (error) {
      res.status(500).json({ error: "Failed to get suggested topics" });
    }
  });

  // ── Development Goals ──────────────────────────────────────────────────────

  app.get("/api/1on1/dev-goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query as { namId?: string; amId?: string };
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === namId || user.id === amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const record = await storage.getDevelopmentGoals(namId, amId);
      res.json({ content: record?.content ?? "", updatedAt: record?.updatedAt ?? null });
    } catch (error) {
      res.status(500).json({ error: "Failed to get development goals" });
    }
  });

  app.patch("/api/1on1/dev-goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query as { namId?: string; amId?: string };
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === namId || user.id === amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const { content } = req.body;
      if (typeof content !== "string") return res.status(400).json({ error: "Content must be a string" });
      const record = await storage.upsertDevelopmentGoals(namId, amId, content, user.id);
      res.json({ content: record.content, updatedAt: record.updatedAt });
    } catch (error) {
      res.status(500).json({ error: "Failed to save development goals" });
    }
  });

  // ── 1:1 Prep Summary ──────────────────────────────────────────────────────
  app.get("/api/1on1/prep-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const amId = req.query.amId as string;
      if (!amId) return res.status(400).json({ error: "amId required" });

      const allUsers = await storage.getUsers(user.organizationId);
      const amUser = allUsers.find(u => u.id === amId);
      if (!amUser) return res.status(404).json({ error: "User not found" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const [allCompanies, allTouchpoints, allTasks, amGoals, allSessions] = await Promise.all([
        storage.getCompanies(user.organizationId),
        storage.getTouchpoints(),
        storage.getTasks(),
        storage.getGoals({ amId }),
        storage.getAllSessions(),
      ]);

      const myCompanies = allCompanies.filter(c => !c.archivedAt && c.assignedTo === amId);
      const companyMap: Record<string, string> = Object.fromEntries(allCompanies.map(c => [c.id, c.name]));

      // Last touch per company
      const lastTouchMap: Record<string, { date: string; type: string }> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouchMap[tp.companyId] || tp.date > lastTouchMap[tp.companyId].date) {
          lastTouchMap[tp.companyId] = { date: tp.date, type: tp.type };
        }
      }

      // Cold accounts (30+ days / never touched)
      const staleAccounts = myCompanies
        .filter(c => !lastTouchMap[c.id] || lastTouchMap[c.id].date < thirtyAgo)
        .map(c => ({ name: c.name, daysSince: lastTouchMap[c.id] ? Math.floor((new Date(todayStr).getTime() - new Date(lastTouchMap[c.id].date).getTime()) / (1000 * 60 * 60 * 24)) : null }))
        .sort((a, b) => (b.daysSince ?? 999) - (a.daysSince ?? 999))
        .slice(0, 8);

      // Recent activity
      const touchesThisWeek = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= weekAgo).length;
      const touchesThisMonth = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= monthStart).length;

      // Recent touchpoints (last 7 days with company name + note)
      const recentTouchpoints = allTouchpoints
        .filter(tp => tp.loggedById === amId && tp.date >= weekAgo)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 10)
        .map(tp => ({ companyName: companyMap[tp.companyId] ?? "Unknown", type: tp.type, date: tp.date, note: tp.notes ?? null }));

      // Open tasks (count as "action items" for 1:1 context)
      const openTasks = allTasks.filter(t => t.assignedTo === amId && t.status === "open");

      // Open 1:1 topics
      let openTopics = 0;
      try {
        const sessions1on1 = Array.isArray(allSessions) ? allSessions.filter((s: any) => s.repId === amId || s.managerId === amId) : [];
        // We don't have a direct topics count here; use a fallback of 0
        openTopics = 0;
      } catch {}

      // Last 1:1 session
      let lastSessionDate: string | null = null;
      let daysSinceSession: number | null = null;
      try {
        const mySessions = Array.isArray(allSessions) ? allSessions.filter((s: any) => (s.repId === amId || s.managerId === amId) && s.closedAt) : [];
        if (mySessions.length > 0) {
          const lastClosed = mySessions.sort((a: any, b: any) => b.closedAt.localeCompare(a.closedAt))[0];
          lastSessionDate = lastClosed.closedAt.slice(0, 10);
          daysSinceSession = Math.floor((new Date(todayStr).getTime() - new Date(lastSessionDate).getTime()) / (1000 * 60 * 60 * 24));
        }
      } catch {}

      // Goals
      const activeGoals = amGoals.filter(g => g.startDate <= todayStr && g.endDate >= todayStr);
      const goalSummary = activeGoals.map(g => ({
        metric: g.metric,
        label: (g as any).customLabel || g.metric,
        current: Number(g.currentValue ?? 0),
        target: Number(g.target ?? 0),
        pct: g.target && Number(g.target) > 0 ? Math.min(Math.round((Number(g.currentValue ?? 0) / Number(g.target)) * 100), 100) : 0,
      }));

      res.json({
        amName: amUser.name || amUser.username,
        openTopics,
        openActionItems: openTasks.length,
        touchesThisWeek,
        touchesThisMonth,
        coldAccounts: staleAccounts.length,
        lastSessionDate,
        daysSinceSession,
        goalSummary,
        recentTouchpoints,
        staleAccounts,
      });
    } catch (error) {
      console.error("Prep summary error:", error);
      res.status(500).json({ error: "Failed to load prep summary" });
    }
  });

  // ── LM Development Milestones ──────────────────────────────────────────────
  // Stored in developmentGoals table as JSON { milestones: [...] }

  app.get("/api/lm-milestones/:lmId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { lmId } = req.params as Record<string, string>;
      const lm = await storage.getUser(lmId);
      if (!lm) return res.status(404).json({ error: "User not found" });
      const managerId = lm.managerId;
      const isSelfOrManager = viewer.id === lmId || viewer.id === managerId;
      const isAdminOrDirector = viewer.role === "admin" || viewer.role === "director" || viewer.role === "sales_director";
      let isInChain = false;
      if (!isSelfOrManager && !isAdminOrDirector) {
        const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
        isInChain = teamIds.includes(lmId);
      }
      if (!isSelfOrManager && !isAdminOrDirector && !isInChain) return res.status(403).json({ error: "Access denied" });
      if (!managerId) return res.json({ milestones: [] });
      const row = await storage.getDevelopmentGoals(managerId, lmId);
      if (!row) return res.json({ milestones: [] });
      try {
        const parsed = JSON.parse(row.content || "{}");
        return res.json({ milestones: parsed.milestones || [] });
      } catch {
        return res.json({ milestones: [] });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to get milestones" });
    }
  });

  app.put("/api/lm-milestones/:lmId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { lmId } = req.params as Record<string, string>;
      const lm = await storage.getUser(lmId);
      if (!lm) return res.status(404).json({ error: "User not found" });
      const managerId = lm.managerId;
      const canUpdate =
        viewer.id === managerId ||
        viewer.role === "admin" ||
        viewer.id === lmId ||
        viewer.role === "director";
      if (!canUpdate) return res.status(403).json({ error: "Access denied" });
      if (!managerId) return res.status(400).json({ error: "LM has no manager assigned" });
      const { milestones } = req.body;
      const content = JSON.stringify({ milestones: milestones || [] });
      const row = await storage.upsertDevelopmentGoals(managerId, lmId, content, viewer.id);
      const parsed = JSON.parse(row.content || "{}");
      return res.json({ milestones: parsed.milestones || [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to save milestones" });
    }
  });

  // ── Financial Data ─────────────────────────────────────────────────────────

  app.get("/api/historical-data", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin" && user.role !== "director" && user.role !== "national_account_manager" && user.role !== "sales" && user.role !== "sales_director") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const latestHistUpload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latestHistUpload) return res.json([]);
      let allRows: any[] = Array.isArray(latestHistUpload.rows) ? latestHistUpload.rows as any[] : [];
      const histCols = resolveColumns(allRows);
      allRows = allRows.filter((r: any) => getStatusFromRow(r, histCols) !== "void" && !isExcludedRow(r, histCols));

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamUsers = (await storage.getUsers(req.session.organizationId!)).filter(u => teamIds.includes(u.id));
        const lmNames = teamUsers.filter(u => u.role === "logistics_manager" || u.role === "logistics_coordinator").map(u => u.name.toLowerCase());
        const salesNames = teamUsers.filter(u => u.role !== "logistics_manager" && u.role !== "logistics_coordinator").map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, histCols);
          const disp = getDispatcherFromRow(r, histCols).toLowerCase();
          return salesNames.some(n => op.includes(n) || n.includes(op))
            || lmNames.some(n => disp.includes(n) || n.includes(disp));
        });
      }

      const byDestWeek = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row, histCols);
        if (!city && !state) continue;
        const location = city && state ? `${city}, ${state}` : city || state;
        const week = weekKey || "unknown";
        if (!byDestWeek.has(location)) byDestWeek.set(location, new Map());
        const weekMap = byDestWeek.get(location)!;
        weekMap.set(week, (weekMap.get(week) || 0) + 1);
      }

      const summaries: { location: string; totalLoads: number; weekCount: number; avgWeeklyLoads: number; peakWeeklyLoads: number; isHotZone: boolean }[] = [];
      for (const [location, weekMap] of byDestWeek) {
        const weekValues = Array.from(weekMap.values());
        const totalLoads = weekValues.reduce((a: number, b: number) => a + b, 0);
        const weekCount = weekMap.size;
        const avgWeeklyLoads = weekCount > 0 ? Math.round((totalLoads / weekCount) * 10) / 10 : 0;
        const peakWeeklyLoads = Math.max(...weekValues);
        summaries.push({
          location,
          totalLoads,
          weekCount,
          avgWeeklyLoads,
          peakWeeklyLoads,
          isHotZone: peakWeeklyLoads >= 5,
        });
      }

      summaries.sort((a, b) => b.avgWeeklyLoads - a.avgWeeklyLoads);
      res.json(summaries);
    } catch (error) {
      console.error("Error computing historical data:", error);
      res.status(500).json({ error: "Failed to compute historical data" });
    }
  });

  app.get("/api/opportunities", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const latestOppUpload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latestOppUpload) return res.json([]);
      let allRows: any[] = Array.isArray(latestOppUpload.rows) ? latestOppUpload.rows as any[] : [];
      const oppCols = resolveColumns(allRows);
      allRows = allRows.filter((r: any) => getStatusFromRow(r, oppCols) !== "void" && !isExcludedRow(r, oppCols));

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamUsers = (await storage.getUsers(req.session.organizationId!)).filter(u => teamIds.includes(u.id));
        const lmNames = teamUsers.filter(u => u.role === "logistics_manager" || u.role === "logistics_coordinator").map(u => u.name.toLowerCase());
        const salesNames = teamUsers.filter(u => u.role !== "logistics_manager" && u.role !== "logistics_coordinator").map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          const disp = getDispatcherFromRow(r, oppCols).toLowerCase();
          return salesNames.some(n => op.includes(n) || n.includes(op))
            || lmNames.some(n => disp.includes(n) || n.includes(disp));
        });
      } else if (user.role === "account_manager") {
        const userName = user.name.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          return op.includes(userName) || userName.includes(op);
        });
      } else if (user.role === "logistics_manager" || user.role === "logistics_coordinator") {
        const userName = user.name.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const disp = getDispatcherFromRow(r, oppCols).toLowerCase();
          return disp.includes(userName) || userName.includes(disp);
        });
      }

      const byDestWeek = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row, oppCols);
        if (!city && !state) continue;
        const location = city && state ? `${city}, ${state}` : city || state;
        const week = weekKey || "unknown";
        if (!byDestWeek.has(location)) byDestWeek.set(location, new Map());
        const weekMap = byDestWeek.get(location)!;
        weekMap.set(week, (weekMap.get(week) || 0) + 1);
      }

      const hotDestinations: { location: string; peakWeekly: number; avgWeekly: number }[] = [];
      for (const [location, weekMap] of byDestWeek) {
        const weekValues = Array.from(weekMap.values());
        const totalLoads = weekValues.reduce((a: number, b: number) => a + b, 0);
        const weekCount = weekMap.size;
        const avgWeekly = weekCount > 0 ? totalLoads / weekCount : 0;
        const peakWeekly = Math.max(...weekValues);
        if (peakWeekly >= 5) {
          hotDestinations.push({
            location,
            peakWeekly,
            avgWeekly: Math.round(avgWeekly * 10) / 10,
          });
        }
      }

      hotDestinations.sort((a, b) => b.peakWeekly - a.peakWeekly);

      if (hotDestinations.length === 0) {
        return res.json([]);
      }

      const visibleIds = await getVisibleCompanyIds(user);
      let allRfps = await storage.getRfps();
      if (visibleIds !== null) {
        allRfps = allRfps.filter(r => visibleIds.includes(r.companyId));
      }
      const allCompanies = await storage.getCompanies(req.session.organizationId!);
      const companyMap = new Map(allCompanies.map(c => [c.id, c]));

      const hotLocationSet = new Map<string, { peakWeekly: number; avgWeekly: number }>();
      for (const hd of hotDestinations) {
        hotLocationSet.set(hd.location.toLowerCase(), { peakWeekly: hd.peakWeekly, avgWeekly: hd.avgWeekly });
      }

      const results: {
        destination: string;
        weeklyLoadCount: number;
        avgWeeklyLoadCount: number;
        matches: {
          companyId: string;
          companyName: string;
          rfpId: string;
          rfpTitle: string;
          lane: string;
          volume: number;
          rate: string;
          equipment: string;
        }[];
      }[] = [];

      const destMatchMap = new Map<string, typeof results[0]>();

      for (const rfp of allRfps) {
        const fileData = rfp.fileData as any;
        if (!fileData || !Array.isArray(fileData.highVolumeLanes)) continue;

        const company = companyMap.get(rfp.companyId);
        const companyName = company?.name || "Unknown";

        for (const lane of fileData.highVolumeLanes) {
          const originCity = (lane.origin || "").trim();
          const originState = (lane.originState || "").trim();
          if (!originCity && !originState) continue;

          const originLocation = originCity && originState
            ? `${originCity}, ${originState}`
            : originCity || originState;

          const stats = hotLocationSet.get(originLocation.toLowerCase());
          if (!stats) continue;

          if (!destMatchMap.has(originLocation.toLowerCase())) {
            const entry = {
              destination: originLocation,
              weeklyLoadCount: stats.peakWeekly,
              avgWeeklyLoadCount: stats.avgWeekly,
              matches: [] as typeof results[0]["matches"],
            };
            destMatchMap.set(originLocation.toLowerCase(), entry);
          }

          const entry = destMatchMap.get(originLocation.toLowerCase())!;
          entry.matches.push({
            companyId: rfp.companyId,
            companyName,
            rfpId: rfp.id,
            rfpTitle: rfp.title,
            lane: lane.lane || `${originCity}, ${originState} → ${lane.destination || ""}${lane.destinationState ? `, ${lane.destinationState}` : ""}`,
            volume: lane.volume || 0,
            rate: lane.rate || "",
            equipment: lane.equipment || "",
          });
        }
      }

      const finalResults = Array.from(destMatchMap.values());
      finalResults.sort((a, b) => b.weeklyLoadCount - a.weeklyLoadCount);

      // Filter out dismissed companies
      const { rows: dismissalRows } = await storage.pool.query(
        `SELECT company_id FROM opportunity_dismissals WHERE org_id = $1`,
        [req.session.organizationId]
      );
      const dismissedIds = new Set(dismissalRows.map((r: any) => r.company_id));
      const filtered = finalResults.map(opp => ({
        ...opp,
        matches: opp.matches.filter((m: any) => !dismissedIds.has(m.companyId)),
      })).filter(opp => opp.matches.length > 0);

      res.json(filtered);
    } catch (error) {
      console.error("Error computing opportunities:", error);
      res.status(500).json({ error: "Failed to compute opportunities" });
    }
  });

  app.get("/api/opportunities/dismissals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { rows } = await storage.pool.query(
        `SELECT d.company_id, d.dismissed_by, d.dismissed_at, c.name as company_name
         FROM opportunity_dismissals d
         LEFT JOIN companies c ON c.id = d.company_id
         WHERE d.org_id = $1 ORDER BY d.dismissed_at DESC`,
        [req.session.organizationId]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch dismissals" });
    }
  });

  app.post("/api/opportunities/dismiss/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      await storage.pool.query(
        `INSERT INTO opportunity_dismissals (company_id, org_id, dismissed_by, dismissed_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, org_id) DO UPDATE SET dismissed_by = $3, dismissed_at = $4`,
        [req.params.companyId, req.session.organizationId, user.id, new Date().toISOString()]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to dismiss opportunity" });
    }
  });

  app.delete("/api/opportunities/dismiss/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      await storage.pool.query(
        `DELETE FROM opportunity_dismissals WHERE company_id = $1 AND org_id = $2`,
        [req.params.companyId, req.session.organizationId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to restore opportunity" });
    }
  });

  app.get("/api/financials", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || (user.role !== "admin" && user.role !== "director" && user.role !== "national_account_manager" && user.role !== "sales" && user.role !== "sales_director")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const upload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!upload) return res.json(null);

      const rawRows: any[] = (upload.rows as any[]) || [];
      const finCols = resolveColumns(rawRows);
      let rows = rawRows.filter((r: any) => getStatusFromRow(r, finCols) !== "void" && !isExcludedRow(r, finCols));

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamUsers = (await storage.getUsers(req.session.organizationId!)).filter(u => teamIds.includes(u.id));
        const lmNames = teamUsers.filter(u => u.role === "logistics_manager" || u.role === "logistics_coordinator").map(u => u.name.toLowerCase());
        const salesNames = teamUsers.filter(u => u.role !== "logistics_manager" && u.role !== "logistics_coordinator").map(u => u.name.toLowerCase());
        rows = rows.filter((r: any) => {
          const op = getRepFromRow(r, finCols);
          const disp = getDispatcherFromRow(r, finCols).toLowerCase();
          return salesNames.some(n => op.includes(n) || n.includes(op))
            || lmNames.some(n => disp.includes(n) || n.includes(disp));
        });
      }

      res.json({ ...upload, rows });
    } catch (error) {
      console.error("Error fetching financials:", error);
      res.status(500).json({ error: "Failed to fetch financials" });
    }
  });

  app.get("/api/financials/uploads", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      res.json(uploads.map(u => ({ id: u.id, fileName: u.fileName, uploadedAt: u.uploadedAt, rowCount: u.rowCount })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  app.get("/api/financials/uploads/:id/download", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      const upload = await storage.getFinancialUploadById(req.params.id as string);
      if (!upload) return res.status(404).json({ error: "Upload not found" });

      const wb = XLSX.utils.book_new();
      const rows = Array.isArray(upload.rows) ? upload.rows as any[] : [];
      const summaryRows = Array.isArray(upload.summaryRows) ? upload.summaryRows as any[] : [];

      if (rows.length > 0) {
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, "Data");
      }
      if (summaryRows.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(summaryRows);
        XLSX.utils.book_append_sheet(wb, ws2, "Summary");
      }
      if (rows.length === 0 && summaryRows.length === 0) {
        const ws = XLSX.utils.aoa_to_sheet([["No data available"]]);
        XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      }

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const safeFileName = upload.fileName.replace(/[^\w\-. ]/g, "_");
      const downloadName = safeFileName.endsWith(".xlsx") ? safeFileName : `${safeFileName}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
      res.send(buf);
    } catch (error) {
      res.status(500).json({ error: "Failed to generate download" });
    }
  });

  /**
   * Reads transaction rows and updates companies.sales_person_id based on the
   * "Salesperson" column (col AB).  Only users with role "sales" or "sales_director"
   * are candidates.  Matching uses financialRepId first, then normalised name.
   */
  async function linkSalespersonsFromRows(rows: any[], organizationId: string) {
    if (!rows || rows.length === 0) return;
    const cols = resolveColumns(rows);

    // Build map: normalized customer name → tally of salesperson strings
    const customerSalesMap = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (isExcludedRow(row, cols)) continue;
      const customer = getCustomerFromRow(row, cols);
      const salesperson = getSalespersonFromRow(row, cols);
      if (!customer || !salesperson) continue;
      const key = customer.toLowerCase().trim();
      if (!customerSalesMap.has(key)) customerSalesMap.set(key, new Map());
      const tally = customerSalesMap.get(key)!;
      tally.set(salesperson, (tally.get(salesperson) || 0) + 1);
    }
    if (customerSalesMap.size === 0) return;

    // Load sales users
    const allUsers = await storage.getUsers(organizationId);
    const salesUsers = allUsers.filter(u => u.role === "sales" || u.role === "sales_director");
    if (salesUsers.length === 0) return;

    // Helper: find best matching sales user for a salesperson string
    const normalize = (s: string) => s.toLowerCase().replace(/[\s._\-]+/g, " ").trim();
    function matchUser(spName: string) {
      const norm = normalize(spName);
      // 1. Exact financialRepId match
      const byRepId = salesUsers.find(u => u.financialRepId && normalize(u.financialRepId) === norm);
      if (byRepId) return byRepId;
      // 2. Normalized name match
      const byName = salesUsers.find(u => normalize(u.name) === norm);
      if (byName) return byName;
      // 3. Partial match (name contains spName or vice-versa)
      const partial = salesUsers.find(u => normalize(u.name).includes(norm) || norm.includes(normalize(u.name)));
      return partial || null;
    }

    // Load companies
    const allCompanies = await storage.getCompanies(organizationId);

    for (const company of allCompanies) {
      const aliases = company.financialAlias
        ? company.financialAlias.split(',').map((a: string) => a.trim().toLowerCase()).filter(Boolean)
        : [];
      const cname = company.name.toLowerCase().trim();

      // Try exact match first across all aliases, then substring match
      let tally = customerSalesMap.get(cname);
      for (const alias of aliases) {
        if (tally) break;
        tally = customerSalesMap.get(alias);
      }
      if (!tally) {
        for (const alias of (aliases.length ? aliases : [cname])) {
          if (tally) break;
          if (alias.length >= 5) {
            for (const [mapKey, mapVal] of customerSalesMap) {
              if (mapKey.includes(alias) || alias.includes(mapKey)) { tally = mapVal; break; }
            }
          }
        }
      }
      if (!tally && cname.length >= 5) {
        for (const [mapKey, mapVal] of customerSalesMap) {
          if (mapKey.includes(cname) || cname.includes(mapKey)) { tally = mapVal; break; }
        }
      }
      if (!tally) continue;
      // Pick most-common salesperson for this customer
      let bestSp = "";
      let bestCount = 0;
      for (const [sp, count] of tally) {
        if (count > bestCount) { bestCount = count; bestSp = sp; }
      }
      if (!bestSp) continue;
      const matched = matchUser(bestSp);
      if (!matched) continue;
      // Update only if changed
      if (company.salesPersonId !== matched.id) {
        await storage.updateCompany(company.id, organizationId, { salesPersonId: matched.id });
        console.log(`[salesperson-link] ${company.name} → ${matched.name} (${bestSp})`);
      }
    }
  }

  app.post("/api/financials/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const sheets = extractSheetsFromWorkbook(workbook);

      // Only read "March Replit" summary sheet if it exists by exact name — never fall back to another sheet
      const exactSummarySheetName = workbook.SheetNames.find(
        s => s.trim().toLowerCase() === "march replit"
      );
      let summaryRows: any[] = [];
      if (exactSummarySheetName) {
        const summarySheet = workbook.Sheets[exactSummarySheetName];
        const parsed: any[] = XLSX.utils.sheet_to_json(summarySheet, { defval: "" });
        // Validate: real summary rows have a customer name and numeric load counts
        const looksLikeSummary = parsed.some((r: any) => {
          const keys = Object.keys(r);
          return keys.some(k => k.toLowerCase().includes("customer")) ||
                 (String(r["__EMPTY"] || "").trim().length > 0 && Number(r["__EMPTY_1"]) > 0);
        });
        if (looksLikeSummary) summaryRows = parsed;
      }

      const upload = await storage.createFinancialUpload({
        fileName: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        rowCount: sheets.rows.length,
        rows: sheets.rows,
        summaryRows,
        bestDealDaysSpot: sheets.bestDealDaysSpot,
        bestDealDaysAll: sheets.bestDealDaysAll,
        trendAnalysis: sheets.trendAnalysis,
        averagesData: sheets.averagesData,
        dailyAcquisition: sheets.dailyAcquisition,
      });

      await storage.setSetting("monthly_sync_failed", "");
      await storage.setSetting("monthly_sync_failed_error", "");

      // Auto-link companies to salesperson users based on col AB
      linkSalespersonsFromRows(sheets.rows, req.session.organizationId!).catch(err =>
        console.error("[salesperson-link] auto-link error:", err)
      );

      cacheInvalidatePrefix(`margin-metrics:`);
      cacheInvalidatePrefix(`account-summary:`);
      cacheInvalidatePrefix(`dispatcher-summary:`);
      res.json({ id: upload.id, fileName: upload.fileName, rowCount: upload.rowCount });
    } catch (error) {
      console.error("Error uploading financials:", error);
      const message = error instanceof Error ? error.message : "Failed to upload financials";
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/financials/uploads/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      await storage.deleteFinancialUpload(req.params.id as string);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete upload" });
    }
  });

  app.get("/api/financials/sheets", requireAuth, async (req, res) => {
    try {
      const latest = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latest) return res.json({ bestDealDaysSpot: [], bestDealDaysAll: [], trendAnalysis: [], averagesData: [], dailyAcquisition: [] });
      res.json({
        bestDealDaysSpot: (latest.bestDealDaysSpot as any[]) || [],
        bestDealDaysAll: (latest.bestDealDaysAll as any[]) || [],
        trendAnalysis: (latest.trendAnalysis as any[]) || [],
        averagesData: (latest.averagesData as any[]) || [],
        dailyAcquisition: (latest.dailyAcquisition as any[]) || [],
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sheets" });
    }
  });

  app.get("/api/financials/customer-names", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const names = new Set<string>();
      for (const upload of uploads) {
        const rows: any[] = Array.isArray(upload.rows) ? upload.rows as any[] : [];
        const rowsCols = resolveColumns(rows);
        for (const row of rows) {
          if (isExcludedRow(row, rowsCols)) continue;
          const name = String(row["Customer"] || "").trim();
          if (name) names.add(name);
        }
      }
      res.json([...names].sort());
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch customer names" });
    }
  });

  app.get("/api/financials/account-summary", requireAuth, async (req, res) => {
    try {
      const asCacheKey = `account-summary:${req.session.organizationId}:${req.query.period || "current"}`;
      const asCached = cacheGet(asCacheKey);
      if (asCached) return res.json(asCached);
      const latest = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latest) return res.json([]);
      const raw = (latest.summaryRows as any[]) || [];

      // Determine which month keys are valid for the requested period
      const period = String(req.query.period || "current");
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth(); // 0-indexed
      function mk(y: number, m: number) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
      let allowedMonths: Set<string> | null = null; // null = all months
      if (period === "current") {
        allowedMonths = new Set([mk(curYear, curMonth)]);
      } else if (period === "last") {
        const lm = curMonth === 0 ? 11 : curMonth - 1;
        const ly = curMonth === 0 ? curYear - 1 : curYear;
        allowedMonths = new Set([mk(ly, lm)]);
      } else if (period === "ytd") {
        const keys = new Set<string>();
        for (let m = 0; m <= curMonth; m++) keys.add(mk(curYear, m));
        allowedMonths = keys;
      }

      // If no summary sheet OR summary data looks like documentation, compute from transaction rows
      if (isBadSummaryData(raw)) {
        const txRows: any[] = (latest.rows as any[]) || [];
        const sumCols = resolveColumns(txRows);
        type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
        type CustomerRepEntry = { customerName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number; repName: string; byMonth: Record<string, MonthBucket> };
        // Key by "customerName|repName" so each (customer, opsUser) pair is independent.
        // This lets two reps (e.g. Jason Allen + Alex Shumway) both get full credit for
        // their own loads on a shared account like CTSIMIGA, with no winner-takes-all logic.
        const byCustomerRep: Record<string, CustomerRepEntry> = {};
        for (const row of txRows) {
          if (isExcludedRow(row, sumCols)) continue;
          const customerName = getCustomerFromRow(row, sumCols);
          if (!customerName) continue;
          const revenue = Number(row[sumCols.revenue] || row[sumCols.totalCharges] || 0);
          if (revenue === 0) continue;
          const { monthKey, margin } = parseHistoricalRow(row, sumCols);
          if (allowedMonths && monthKey && !allowedMonths.has(monthKey)) continue;
          const rep = getRepFromRow(row, sumCols);
          if (!rep) continue; // skip rows with no opsUser — can't attribute them
          const orderType = String(row[sumCols.orderType] || "").toLowerCase();
          const isSpot = orderType.includes("spot");
          const key = `${customerName}|${rep}`;
          if (!byCustomerRep[key]) byCustomerRep[key] = { customerName, totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0, repName: rep, byMonth: {} };
          byCustomerRep[key].totalLoads++;
          byCustomerRep[key].totalMargin += margin;
          byCustomerRep[key].totalRevenue += revenue;
          if (isSpot) byCustomerRep[key].spotLoads++;
          if (monthKey) {
            if (!byCustomerRep[key].byMonth[monthKey]) byCustomerRep[key].byMonth[monthKey] = { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
            byCustomerRep[key].byMonth[monthKey].totalLoads++;
            byCustomerRep[key].byMonth[monthKey].totalMargin += margin;
            byCustomerRep[key].byMonth[monthKey].totalRevenue += revenue;
            if (isSpot) byCustomerRep[key].byMonth[monthKey].spotLoads++;
          }
        }
        const result = Object.values(byCustomerRep);
        cacheSet(asCacheKey, result, 15 * 60 * 1000);
        return res.json(result);
      }

      // Detect whether rows use named headers or __EMPTY keys (non-standard header layout)
      const firstRow = raw[0] || {};
      const usesEmptyKeys = "__EMPTY" in firstRow;

      let rows = raw;
      if (usesEmptyKeys) {
        // First row is a header row — skip it; skip any "TOTAL" footer row
        rows = raw.filter((r: any) => {
          const name = String(r["__EMPTY"] || "").trim();
          return name && name !== "Customer Name" && name !== "TOTAL" && name !== "Customer code";
        });
      }

      const result = rows.map((r: any) => {
        let customerName: string, totalLoads: number, spotLoads: number, totalMargin: number, repName: string;
        if (usesEmptyKeys) {
          customerName = String(r["__EMPTY"] || "").trim();
          totalLoads   = Number(r["__EMPTY_1"] ?? 0);
          spotLoads    = Number(r["__EMPTY_2"] ?? 0);
          totalMargin  = Number(r["__EMPTY_3"] ?? 0);
          repName      = String(r["__EMPTY_6"] || "").trim();
        } else {
          customerName = String(r["Customer Name"] || r["customer name"] || r["CUSTOMER NAME"] || "").trim();
          totalLoads   = Number(r["Total Loads"] || r["total loads"] || r["TOTAL LOADS"] || 0);
          spotLoads    = Number(r["SPOT Loads"] || r["Spot Loads"] || r["spot loads"] || r["SPOT LOADS"] || 0);
          totalMargin  = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0);
          repName      = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim();
        }
        return { customerName, totalLoads, spotLoads, totalMargin, repName };
      }).filter((r: any) => r.customerName);

      cacheSet(`account-summary:${req.session.organizationId}:${req.query.period || "current"}`, result, 15 * 60 * 1000);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch account summary" });
    }
  });

  // ── Dispatcher summary (for Logistics Managers) ────────────────────────────
  app.get("/api/financials/dispatcher-summary", requireAuth, async (req, res) => {
    try {
      const dsCacheKey = `dispatcher-summary:${req.session.organizationId}:${req.query.period || "current"}`;
      const dsCached = cacheGet(dsCacheKey);
      if (dsCached) return res.json(dsCached);
      const latest = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latest) return res.json([]);

      const period = String(req.query.period || "current");
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth();
      function mk(y: number, m: number) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
      let allowedMonths: Set<string> | null = null;
      if (period === "current") {
        allowedMonths = new Set([mk(curYear, curMonth)]);
      } else if (period === "last") {
        const lm = curMonth === 0 ? 11 : curMonth - 1;
        const ly = curMonth === 0 ? curYear - 1 : curYear;
        allowedMonths = new Set([mk(ly, lm)]);
      } else if (period === "ytd") {
        const keys = new Set<string>();
        for (let m = 0; m <= curMonth; m++) keys.add(mk(curYear, m));
        allowedMonths = keys;
      }

      const txRows: any[] = (latest.rows as any[]) || [];
      const cols = resolveColumns(txRows);

      type DispEntry = { dispatcherName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
      const byDispatcher: Record<string, DispEntry> = {};

      for (const row of txRows) {
        if (isExcludedRow(row, cols)) continue;
        const dispatcher = getDispatcherFromRow(row, cols);
        if (!dispatcher) continue;
        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || row["Total charges"] || 0);
        if (revenue === 0) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (allowedMonths && monthKey && !allowedMonths.has(monthKey)) continue;
        const orderType = String(row[cols.orderType] || "").toLowerCase();
        const isSpot = orderType.includes("spot");
        const key = dispatcher.toLowerCase().trim();
        if (!byDispatcher[key]) byDispatcher[key] = { dispatcherName: dispatcher, totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
        byDispatcher[key].totalLoads++;
        byDispatcher[key].totalMargin += margin;
        byDispatcher[key].totalRevenue += revenue;
        if (isSpot) byDispatcher[key].spotLoads++;
      }

      const dsResult = Object.values(byDispatcher);
      cacheSet(`dispatcher-summary:${req.session.organizationId}:${req.query.period || "current"}`, dsResult, 15 * 60 * 1000);
      return res.json(dsResult);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dispatcher summary" });
    }
  });

  // ── Repeat Carrier metric (for Logistics Managers) ─────────────────────────
  app.get("/api/financials/repeat-carriers", requireAuth, async (req, res) => {
    try {
      const latest = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latest) return res.json([]);

      const period = String(req.query.period || "current");
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth();
      function mk(y: number, m: number) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
      let allowedMonths: Set<string> | null = null;
      if (period === "current") {
        allowedMonths = new Set([mk(curYear, curMonth)]);
      } else if (period === "last") {
        const lm = curMonth === 0 ? 11 : curMonth - 1;
        const ly = curMonth === 0 ? curYear - 1 : curYear;
        allowedMonths = new Set([mk(ly, lm)]);
      } else if (period === "ytd") {
        const keys = new Set<string>();
        for (let m = 0; m <= curMonth; m++) keys.add(mk(curYear, m));
        allowedMonths = keys;
      }

      const txRows: any[] = (latest.rows as any[]) || [];
      const cols = resolveColumns(txRows);

      type DispData = {
        dispatcherName: string;
        totalLoads: number;
        laneCarrierCounts: Map<string, number>;
      };
      const byDispatcher: Record<string, DispData> = {};

      for (const row of txRows) {
        if (isExcludedRow(row, cols)) continue;
        const dispatcher = getDispatcherFromRow(row, cols);
        if (!dispatcher) continue;
        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || row["Total charges"] || 0);
        if (revenue === 0) continue;
        const { monthKey } = parseHistoricalRow(row, cols);
        if (allowedMonths && monthKey && !allowedMonths.has(monthKey)) continue;

        const carrier = String(row[cols.carrier] || "").trim().toLowerCase();
        const origin = String(row[cols.shipperCity] || row[cols.origin] || "").trim().toLowerCase();
        const dest = String(row[cols.consigneeCity] || row[cols.destination] || "").trim().toLowerCase();
        const laneCarrierKey = `${origin}|${dest}||${carrier}`;

        const key = dispatcher.toLowerCase().trim();
        if (!byDispatcher[key]) byDispatcher[key] = { dispatcherName: dispatcher, totalLoads: 0, laneCarrierCounts: new Map() };
        byDispatcher[key].totalLoads++;
        byDispatcher[key].laneCarrierCounts.set(laneCarrierKey, (byDispatcher[key].laneCarrierCounts.get(laneCarrierKey) || 0) + 1);
      }

      const result = Object.values(byDispatcher).map(d => {
        let repeatCarrierLoads = 0;
        for (const count of d.laneCarrierCounts.values()) {
          if (count > 1) repeatCarrierLoads += count - 1;
        }
        return {
          dispatcherName: d.dispatcherName,
          totalLoads: d.totalLoads,
          repeatCarrierLoads,
          repeatCarrierPct: d.totalLoads > 0 ? Math.round((repeatCarrierLoads / d.totalLoads) * 100) : 0,
        };
      });

      return res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch repeat carrier data" });
    }
  });

  // ── Carrier Lane Search — build a call list of carriers by corridor ─────────
  app.get("/api/carriers/lane-search", requireAuth, async (req, res) => {
    try {
      const orgId = req.session.organizationId!;
      const originQuery = String(req.query.origin || "").trim();
      const destQuery   = String(req.query.destination || "").trim();
      const radiusMiles = Math.max(1, Math.min(500, parseFloat(String(req.query.radius || "75")) || 75));
      const minLoadsPerMonth = Math.max(1, parseFloat(String(req.query.minLoadsPerMonth || "5")) || 5);

      // Parse "City, ST" / "City ST" / "ST" into components for geocoding
      function parseCityState(q: string): { city: string; state: string } {
        if (!q) return { city: "", state: "" };
        const cm = q.match(/^(.+),\s*([A-Za-z]{2})$/);
        if (cm) return { city: cm[1].trim(), state: cm[2].trim().toUpperCase() };
        const sm = q.match(/^(.+)\s+([A-Za-z]{2})$/);
        if (sm) return { city: sm[1].trim(), state: sm[2].trim().toUpperCase() };
        if (/^[A-Za-z]{2}$/.test(q)) return { city: "", state: q.trim().toUpperCase() };
        return { city: q.trim(), state: "" };
      }

      const originParsed = parseCityState(originQuery);
      const destParsed   = parseCityState(destQuery);
      const originCenter = originQuery ? geocodeCity(originParsed.city, originParsed.state) : null;
      const destCenter   = destQuery   ? geocodeCity(destParsed.city,   destParsed.state)   : null;

      function locMatches(city: string, state: string, rawText: string, queryRaw: string, center: [number, number] | null): { match: boolean; dist: number | null } {
        if (!queryRaw) return { match: true, dist: null };
        if (center) {
          const lc = geocodeCity(city, state);
          if (lc) {
            const d = haversineDistance(center[0], center[1], lc[0], lc[1]);
            return { match: d <= radiusMiles, dist: Math.round(d) };
          }
        }
        return { match: rawText.toLowerCase().includes(queryRaw.toLowerCase()), dist: null };
      }

      // Load all financial data for the org (all uploads merged)
      const uploads = await storage.getFinancialUploadsForOrg(orgId);
      if (!uploads.length) return res.json({ corridors: [], originQuery, destQuery, radiusMiles, minLoadsPerMonth, originGeocoded: !!originCenter, destGeocoded: !!destCenter });

      // ─── Aggregate: corridor → month → carrier → load count ────────────────
      function normalizeModeServer(raw: string): string {
        const t = (raw || "").trim().toLowerCase();
        if (!t) return "";
        if (/^(v|van|dry.?van|dv|dryvan)$/.test(t)) return "Van";
        if (/^(r|reefer|refrigerated|temp|temperature|temp.?ctrl)$/.test(t)) return "Reefer";
        if (/^(f|flatbed|fb|flat|step.?deck|rgn|lowboy)$/.test(t)) return "Flatbed";
        if (/^ltl$/.test(t)) return "LTL";
        if (/^(drayage|dray)$/.test(t)) return "Drayage";
        if (/^(imdl|intermodal|im|rail)$/.test(t)) return "IMDL";
        const s = raw.trim();
        return s.charAt(0).toUpperCase() + s.slice(1);
      }

      type CarrierStats = { loads: number; totalMargin: number; totalCarrierPay: number; lastDate: string | null; lastShipDate: string | null };
      type CorridorData = {
        originCity: string; originState: string;
        destCity: string;   destState: string;
        mode: string;
        monthLoads: Map<string, number>;
        carriers: Map<string, CarrierStats>;
      };
      const corridorMap = new Map<string, CorridorData>();

      for (const upload of uploads) {
        const rows: any[] = (upload.rows as any[]) || [];
        if (!rows.length) continue;
        const cols = resolveColumns(rows);

        for (const row of rows) {
          if (isExcludedRow(row, cols)) continue;
          const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || 0);
          if (revenue === 0) continue;

          const origCity  = String(row[cols.shipperCity]    || row[cols.origin]           || "").trim();
          const origState = String(row[cols.shipperState]   || row[cols.originState]       || "").trim().toUpperCase();
          const dstCity   = String(row[cols.consigneeCity]  || row[cols.destination]       || "").trim();
          const dstState  = String(row[cols.consigneeState] || row[cols.destinationState]  || "").trim().toUpperCase();
          const carrier   = String(row[cols.carrier]        || "").trim();
          const mode      = normalizeModeServer(String(row[cols.equipmentType] || "").trim());

          if (!origCity && !origState) continue;
          if (!dstCity  && !dstState)  continue;
          if (!carrier) continue;
          if (!mode) continue;  // skip rows with no mode

          const { monthKey, margin } = parseHistoricalRow(row, cols);

          const key = `${origCity.toLowerCase()}|${origState}|${dstCity.toLowerCase()}|${dstState}|${mode}`;
          if (!corridorMap.has(key)) {
            corridorMap.set(key, {
              originCity: origCity, originState: origState,
              destCity: dstCity,   destState: dstState,
              mode,
              monthLoads: new Map(),
              carriers: new Map(),
            });
          }
          const corridor = corridorMap.get(key)!;

          // track monthly load count
          const mk = monthKey || "unknown";
          corridor.monthLoads.set(mk, (corridor.monthLoads.get(mk) || 0) + 1);

          // track per-carrier stats
          const rawCarrierPay = String(row[cols.carrierPay] || row[cols.freightCharge] || "").replace(/[^0-9.]/g, "");
          const carrierPayVal = rawCarrierPay ? parseFloat(rawCarrierPay) || 0 : 0;

          // Parse actual ship/delivery date to ISO string (YYYY-MM-DD)
          let shipDateIso: string | null = null;
          const rawDate = row[cols.deliveryDate] || row[cols.dateOrdered];
          if (rawDate != null && rawDate !== "") {
            const serial = Number(rawDate);
            if (!isNaN(serial) && serial > 40000) {
              const d = new Date(new Date(1899, 11, 30).getTime() + serial * 86400000);
              shipDateIso = d.toISOString().slice(0, 10);
            } else {
              const dStr = String(rawDate).trim();
              if (dStr && isNaN(Number(dStr))) {
                const d = new Date(dStr);
                if (!isNaN(d.getTime())) shipDateIso = d.toISOString().slice(0, 10);
              }
            }
          }

          if (!corridor.carriers.has(carrier)) corridor.carriers.set(carrier, { loads: 0, totalMargin: 0, totalCarrierPay: 0, lastDate: null, lastShipDate: null });
          const cs = corridor.carriers.get(carrier)!;
          cs.loads++;
          cs.totalMargin += margin || 0;
          cs.totalCarrierPay += carrierPayVal;
          if (monthKey && (!cs.lastDate || monthKey > cs.lastDate)) cs.lastDate = monthKey;
          if (shipDateIso && (!cs.lastShipDate || shipDateIso > cs.lastShipDate)) cs.lastShipDate = shipDateIso;
        }
      }

      // ─── Filter: avg loads/month ≥ minLoadsPerMonth ─────────────────────────
      const results: any[] = [];

      for (const corridor of corridorMap.values()) {
        const realMonths = [...corridor.monthLoads.keys()].filter(k => k !== "unknown");
        const totalLoads = [...corridor.monthLoads.values()].reduce((s, v) => s + v, 0);
        const monthCount = Math.max(1, realMonths.length);
        const avgLoadsPerMonth = totalLoads / monthCount;

        if (avgLoadsPerMonth < minLoadsPerMonth) continue;

        // ─── Radius filter ───────────────────────────────────────────────────
        const origCheck = locMatches(corridor.originCity, corridor.originState, `${corridor.originCity} ${corridor.originState}`, originQuery, originCenter);
        const dstCheck  = locMatches(corridor.destCity,   corridor.destState,   `${corridor.destCity} ${corridor.destState}`,   destQuery,   destCenter);
        if (!origCheck.match || !dstCheck.match) continue;

        const originLabel = [corridor.originCity, corridor.originState].filter(Boolean).join(", ");
        const destLabel   = [corridor.destCity,   corridor.destState].filter(Boolean).join(", ");

        // Build sorted carrier list
        // Note: mcNumber is not present in historical shipment row data;
        // it is set to null here and may be back-filled on the client from
        // previously-catalogued lane_carriers records (same carrier name lookup).
        const carrierList = [...corridor.carriers.entries()]
          .map(([name, cs]) => ({
            name,
            mcNumber: null as string | null,
            loads: cs.loads,
            pct: Math.round((cs.loads / totalLoads) * 100),
            avgMarginPerLoad: cs.loads > 0 ? Math.round(cs.totalMargin / cs.loads) : null,
            avgCarrierPay: cs.loads > 0 && cs.totalCarrierPay > 0 ? Math.round(cs.totalCarrierPay / cs.loads) : null,
            lastUsed: cs.lastDate,
            lastShipDate: cs.lastShipDate,
          }))
          .sort((a, b) => b.loads - a.loads);

        results.push({
          corridorKey: `${corridor.originCity}|${corridor.originState}|${corridor.destCity}|${corridor.destState}|${corridor.mode}`,
          originCity: corridor.originCity, originState: corridor.originState,
          destCity: corridor.destCity,     destState: corridor.destState,
          mode: corridor.mode,
          originLabel, destLabel,
          corridorLabel: `${originLabel} → ${destLabel}`,
          avgLoadsPerMonth: Math.round(avgLoadsPerMonth * 10) / 10,
          totalLoads,
          monthsObserved: monthCount,
          originDistanceMiles: origCheck.dist,
          destDistanceMiles:   dstCheck.dist,
          carriers: carrierList,
        });
      }

      results.sort((a, b) => b.avgLoadsPerMonth - a.avgLoadsPerMonth);

      res.json({ corridors: results, originQuery, destQuery, radiusMiles, minLoadsPerMonth, originGeocoded: !!originCenter, destGeocoded: !!destCenter });
    } catch (err) {
      console.error("Carrier lane search error:", err);
      res.status(500).json({ error: "Carrier lane search failed" });
    }
  });

  // ── Salesperson summary (for Sales roles) ──────────────────────────────────
  app.get("/api/financials/salesperson-summary", requireAuth, async (req, res) => {
    try {
      const latest = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      if (!latest) return res.json([]);

      const period = String(req.query.period || "current");
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth();
      function mk(y: number, m: number) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
      let allowedMonths: Set<string> | null = null;
      if (period === "current") {
        allowedMonths = new Set([mk(curYear, curMonth)]);
      } else if (period === "last") {
        const lm = curMonth === 0 ? 11 : curMonth - 1;
        const ly = curMonth === 0 ? curYear - 1 : curYear;
        allowedMonths = new Set([mk(ly, lm)]);
      } else if (period === "ytd") {
        const keys = new Set<string>();
        for (let m = 0; m <= curMonth; m++) keys.add(mk(curYear, m));
        allowedMonths = keys;
      }

      const txRows: any[] = (latest.rows as any[]) || [];
      const cols = resolveColumns(txRows);

      type SpEntry = { salespersonName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
      const bySalesperson: Record<string, SpEntry> = {};

      for (const row of txRows) {
        if (isExcludedRow(row, cols)) continue;
        const salesperson = getSalespersonFromRow(row, cols);
        if (!salesperson) continue;
        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || row["Total charges"] || 0);
        if (revenue === 0) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (allowedMonths && monthKey && !allowedMonths.has(monthKey)) continue;
        const orderType = String(row[cols.orderType] || "").toLowerCase();
        const isSpot = orderType.includes("spot");
        const key = salesperson.toLowerCase().trim();
        if (!bySalesperson[key]) bySalesperson[key] = { salespersonName: salesperson, totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
        bySalesperson[key].totalLoads++;
        bySalesperson[key].totalMargin += margin;
        bySalesperson[key].totalRevenue += revenue;
        if (isSpot) bySalesperson[key].spotLoads++;
      }

      return res.json(Object.values(bySalesperson));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch salesperson summary" });
    }
  });

  // ── Last Upload Info ─────────────────────────────────────────────────────────
  app.get("/api/financials/last-upload-info", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ uploadedAt: null, fileName: null });
      const latest = uploads[uploads.length - 1];
      res.json({ uploadedAt: latest.uploadedAt, fileName: (latest as any).fileName || null });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch upload info" });
    }
  });

  // ── Attribution Gaps ──────────────────────────────────────────────────────────
  app.get("/api/financials/attribution-gaps", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ opsUserGaps: [], dispatcherGaps: [], salespersonGaps: [], usersMissingId: [] });
      const latest = uploads[uploads.length - 1];

      const txRows: any[] = (latest.rows as any[]) || [];
      const cols = resolveColumns(txRows);
      const allUsers = await storage.getUsers(req.session.organizationId!);

      function backendMatchRep(excelName: string, userName: string): boolean {
        const a = excelName.toLowerCase().trim();
        const b = userName.toLowerCase().trim();
        if (a === b) return true;
        const aParts = a.split(/\s+/);
        const bParts = b.split(/\s+/);
        if (aParts.length === 1 && aParts[0].length > 1) {
          return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
        }
        return aParts.some(p => p.length > 1 && bParts.includes(p));
      }

      function matchesAnyUser(name: string): boolean {
        const nameLower = name.toLowerCase().trim();
        return allUsers.some(u => {
          const frid = (u as any).financialRepId;
          if (frid && frid.toLowerCase() === nameLower) return true;
          return backendMatchRep(name, u.name);
        });
      }

      const opsUserCounts: Record<string, number> = {};
      const dispatcherCounts: Record<string, number> = {};
      const salespersonCounts: Record<string, number> = {};

      for (const row of txRows) {
        if (isExcludedRow(row, cols)) continue;
        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || 0);
        if (revenue === 0) continue;
        const opsUser = getRepFromRow(row, cols);
        if (opsUser) opsUserCounts[opsUser] = (opsUserCounts[opsUser] || 0) + 1;
        const dispatcher = getDispatcherFromRow(row, cols);
        if (dispatcher) dispatcherCounts[dispatcher] = (dispatcherCounts[dispatcher] || 0) + 1;
        const salesperson = getSalespersonFromRow(row, cols);
        if (salesperson) salespersonCounts[salesperson] = (salespersonCounts[salesperson] || 0) + 1;
      }

      const opsUserGaps = Object.entries(opsUserCounts)
        .filter(([name]) => !matchesAnyUser(name))
        .map(([name, loads]) => ({ name, loads, column: "OpsUser" }))
        .sort((a, b) => b.loads - a.loads);

      const dispatcherGaps = Object.entries(dispatcherCounts)
        .filter(([name]) => !matchesAnyUser(name))
        .map(([name, loads]) => ({ name, loads, column: "Dispatcher" }))
        .sort((a, b) => b.loads - a.loads);

      const salespersonGaps = Object.entries(salespersonCounts)
        .filter(([name]) => !matchesAnyUser(name))
        .map(([name, loads]) => ({ name, loads, column: "Salesperson" }))
        .sort((a, b) => b.loads - a.loads);

      const usersMissingId = allUsers
        .filter(u => !(u as any).financialRepId)
        .map(u => ({ id: u.id, name: u.name, role: u.role }));

      res.json({ opsUserGaps, dispatcherGaps, salespersonGaps, usersMissingId });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch attribution gaps" });
    }
  });

  // ── Salesperson Accounts ──────────────────────────────────────────────────────
  app.get("/api/financials/salesperson-accounts", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json([]);
      const latest = uploads[uploads.length - 1];

      const period = String(req.query.period || "current");
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth();
      function mk(y: number, m: number) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
      let allowedMonths: Set<string> | null = null;
      if (period === "current") {
        allowedMonths = new Set([mk(curYear, curMonth)]);
      } else if (period === "last") {
        const lm = curMonth === 0 ? 11 : curMonth - 1;
        const ly = curMonth === 0 ? curYear - 1 : curYear;
        allowedMonths = new Set([mk(ly, lm)]);
      } else if (period === "ytd") {
        const keys = new Set<string>();
        for (let m = 0; m <= curMonth; m++) keys.add(mk(curYear, m));
        allowedMonths = keys;
      }

      const repId = String(req.query.repId || "").toLowerCase().trim();
      const repName = String(req.query.repName || "").toLowerCase().trim();

      function backendMatchRep2(excelName: string, targetName: string): boolean {
        const a = excelName.toLowerCase().trim();
        const b = targetName.toLowerCase().trim();
        if (a === b) return true;
        const aParts = a.split(/\s+/);
        const bParts = b.split(/\s+/);
        if (aParts.length === 1 && aParts[0].length > 1) {
          return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
        }
        return aParts.some(p => p.length > 1 && bParts.includes(p));
      }

      const txRows: any[] = (latest.rows as any[]) || [];
      const cols = resolveColumns(txRows);

      type AcctEntry = { customerName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
      const byCustomer: Record<string, AcctEntry> = {};

      for (const row of txRows) {
        if (isExcludedRow(row, cols)) continue;
        const salesperson = getSalespersonFromRow(row, cols);
        if (!salesperson) continue;
        const spLower = salesperson.toLowerCase().trim();
        const isMatch = (repId && repId === spLower) || (repName && backendMatchRep2(salesperson, repName));
        if (!isMatch) continue;

        const revenue = Number(row[cols.revenue] || row[cols.totalCharges] || row["Total charges"] || 0);
        if (revenue === 0) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (allowedMonths && monthKey && !allowedMonths.has(monthKey)) continue;

        const customer = String(row[cols.customer] || "Unknown").trim();
        const orderType = String(row[cols.orderType] || "").toLowerCase();
        const isSpot = orderType.includes("spot");
        const key = customer.toLowerCase();
        if (!byCustomer[key]) byCustomer[key] = { customerName: customer, totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
        byCustomer[key].totalLoads++;
        byCustomer[key].totalMargin += margin;
        byCustomer[key].totalRevenue += revenue;
        if (isSpot) byCustomer[key].spotLoads++;
      }

      res.json(Object.values(byCustomer).sort((a, b) => b.totalLoads - a.totalLoads));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch salesperson accounts" });
    }
  });

  // ── OneDrive Sync & Settings ────────────────────────────────────────────────

  app.get("/api/settings/onedrive-url", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || (user.role !== "admin" && user.role !== "national_account_manager" && user.role !== "sales")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const url = await storage.getSetting("onedrive_url");
      res.json({ url: url || "" });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch setting" });
    }
  });

  app.patch("/api/settings/onedrive-url", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { url } = req.body;
      if (typeof url !== "string") return res.status(400).json({ error: "url is required" });
      await storage.setSetting("onedrive_url", url.trim());
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to save setting" });
    }
  });

  // Admin-only endpoint to import financial rows in chunks (for DB cloning)
  app.post("/api/admin/import-financial-rows", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      const { uploadId, rows } = req.body;
      if (!uploadId || !Array.isArray(rows)) return res.status(400).json({ error: "uploadId and rows required" });
      await storage.appendFinancialRows(uploadId, rows);
      res.json({ ok: true, added: rows.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/financials/sync-onedrive", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || (user.role !== "admin" && user.role !== "national_account_manager" && user.role !== "sales")) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const result = await performOneDriveSync(user.id);

      await storage.setSetting("monthly_sync_failed", "");
      await storage.setSetting("monthly_sync_failed_error", "");

      // Auto-link companies to salesperson users from synced data
      const orgId = req.session.organizationId!;
      storage.getFinancialUploadsForOrg(orgId).then(uploads => {
        if (uploads.length === 0) return;
        const latest = uploads[uploads.length - 1];
        linkSalespersonsFromRows((latest.rows as any[]) || [], orgId).catch(err =>
          console.error("[salesperson-link] sync auto-link error:", err)
        );
      }).catch(() => {});

      res.json(result);
    } catch (error: any) {
      console.error("Error syncing from OneDrive:", error);
      const message = error?.message || "Failed to sync from OneDrive. Please check the share link and try again.";
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/sync-alert", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.json({ failed: false });
      }
      const failedMonth = await storage.getSetting("monthly_sync_failed");
      if (!failedMonth) {
        return res.json({ failed: false });
      }
      const errorMessage = await storage.getSetting("monthly_sync_failed_error") || "Unknown error";
      res.json({ failed: true, month: failedMonth, error: errorMessage });
    } catch (error) {
      res.json({ failed: false });
    }
  });

  app.post("/api/sync-alert/dismiss", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      await storage.setSetting("monthly_sync_failed", "");
      await storage.setSetting("monthly_sync_failed_error", "");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to dismiss alert" });
    }
  });

  // ── Historical Data & Opportunities ─────────────────────────────────────────

  function getWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  }

  app.get("/api/historical-data-summary", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const rawHdsSrc = uploads.flatMap(u => (u.rows as any[]) || []);
      const hdsCols = resolveColumns(rawHdsSrc);
      const allRows = rawHdsSrc.filter((r: any) => getStatusFromRow(r, hdsCols) !== "void" && !isExcludedRow(r, hdsCols));
      const destWeekly: Record<string, Record<string, number>> = {};
      const destMeta: Record<string, { city: string; state: string }> = {};
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row, hdsCols);
        if (!city || !state) continue;
        const key = `${city.toLowerCase()}||${state.toLowerCase()}`;
        if (!destWeekly[key]) { destWeekly[key] = {}; destMeta[key] = { city, state }; }
        if (weekKey) {
          destWeekly[key][weekKey] = (destWeekly[key][weekKey] || 0) + 1;
        }
      }
      const summary = Object.entries(destWeekly).map(([key, weeks]) => {
        const counts = Object.values(weeks);
        const totalLoads = counts.reduce((a, b) => a + b, 0);
        const avgWeekly = counts.length > 0 ? totalLoads / counts.length : 0;
        const maxWeekly = counts.length > 0 ? Math.max(...counts) : 0;
        const { city, state } = destMeta[key];
        return {
          destination: `${city}, ${state}`,
          city, state, totalLoads,
          avgWeekly: Math.round(avgWeekly * 10) / 10,
          maxWeekly,
          weekCount: counts.length,
          isHotZone: maxWeekly >= 5,
        };
      }).sort((a, b) => b.avgWeekly - a.avgWeekly);
      res.json({ summary, totalRows: allRows.length, uploadCount: uploads.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to compute historical summary" });
    }
  });

  app.get("/api/opportunities", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const rawOppSrc2 = uploads.flatMap(u => (u.rows as any[]) || []);
      const opp2Cols = resolveColumns(rawOppSrc2);
      const allRows = rawOppSrc2.filter((r: any) => getStatusFromRow(r, opp2Cols) !== "void");
      const destWeekly: Record<string, Record<string, number>> = {};
      const destMeta: Record<string, { city: string; state: string }> = {};
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row, opp2Cols);
        if (!city || !state) continue;
        const key = `${city.toLowerCase()}||${state.toLowerCase()}`;
        if (!destWeekly[key]) { destWeekly[key] = {}; destMeta[key] = { city, state }; }
        if (weekKey) {
          destWeekly[key][weekKey] = (destWeekly[key][weekKey] || 0) + 1;
        }
      }
      const hotDests = Object.entries(destWeekly).map(([key, weeks]) => {
        const counts = Object.values(weeks);
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const max = Math.max(...counts);
        return { key, ...destMeta[key], avgWeekly: avg, maxWeekly: max };
      }).filter(d => d.maxWeekly >= 5).sort((a, b) => b.avgWeekly - a.avgWeekly);
      const allRfps = await storage.getRfps();
      const visibleIds = await getVisibleCompanyIds(currentUser);
      const visibleRfps = visibleIds === null ? allRfps : allRfps.filter(r => r.companyId && visibleIds.includes(r.companyId));
      const allCompanies = await storage.getCompanies(req.session.organizationId!);
      const visibleCompanies = visibleIds === null ? allCompanies : allCompanies.filter(c => visibleIds.includes(c.id));
      const companyMap = new Map(visibleCompanies.map(c => [c.id, c.name]));
      const opportunities: any[] = [];
      for (const hot of hotDests) {
        const matches: any[] = [];
        for (const rfp of visibleRfps) {
          const fileData = rfp.fileData as any;
          if (!fileData?.highVolumeLanes?.length) continue;
          for (const lane of fileData.highVolumeLanes) {
            const laneOrigin = String(lane.origin || "").trim().toLowerCase();
            const laneState = String(lane.originState || "").trim().toLowerCase();
            const hotCity = hot.city.toLowerCase();
            const hotState = hot.state.toLowerCase();
            if (!laneOrigin) continue;
            const cityMatch = laneOrigin.includes(hotCity) || hotCity.includes(laneOrigin);
            const stateMatch = !laneState || !hotState || laneState === hotState || laneState.startsWith(hotState.slice(0, 2)) || hotState.startsWith(laneState.slice(0, 2));
            if (cityMatch && stateMatch) {
              const rawRow = (lane as any).rawRow || {};
              const dStateRaw = lane.destinationState ||
                (Object.entries(rawRow).find(([k]) => /destination.?state/i.test(k))?.[1] as string || "");
              const oStateRaw = lane.originState ||
                (Object.entries(rawRow).find(([k]) => /origin.?state/i.test(k))?.[1] as string || "");
              matches.push({
                companyId: rfp.companyId,
                companyName: companyMap.get(rfp.companyId || "") || "Unknown",
                rfpId: rfp.id,
                rfpTitle: rfp.title,
                lane: `${lane.origin || ""}${oStateRaw ? ", " + oStateRaw : ""} → ${lane.destination || ""}${dStateRaw ? ", " + dStateRaw : ""}`,
                volume: lane.volume,
                rate: lane.rate,
                equipment: lane.equipment,
              });
            }
          }
        }
        if (matches.length > 0) {
          opportunities.push({
            destination: `${hot.city}, ${hot.state}`,
            city: hot.city, state: hot.state,
            weeklyLoadCount: Math.round(hot.avgWeekly * 10) / 10,
            maxWeekly: hot.maxWeekly,
            matches,
          });
        }
      }
      res.json(opportunities);
    } catch (error) {
      res.status(500).json({ error: "Failed to compute opportunities" });
    }
  });

  // ── Lane Corridors ────────────────────────────────────────────────────────────
  app.get("/api/historical-lane-corridors", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const corridorMap: Record<string, { origin: string; destination: string; originCity: string; originState: string; destCity: string; destState: string; loads: number }> = {};
      if (uploads.length > 0) {
        const latestCorr = uploads[uploads.length - 1];
        const rawCorrRows: any[] = (latestCorr as any).rows ?? [];
        const corrCols = resolveColumns(rawCorrRows);
        const rows: any[] = rawCorrRows.filter((r: any) => getStatusFromRow(r, corrCols) !== "void");
        for (const row of rows) {
          const { origCity: oc, origState: os, destCity: dc, destState: ds } = parseHistoricalRow(row, corrCols);
          if (!oc || !dc) continue;
          const key = `${oc}|${os}→${dc}|${ds}`;
          if (!corridorMap[key]) {
            corridorMap[key] = { origin: `${oc}, ${os}`, destination: `${dc}, ${ds}`, originCity: oc, originState: os, destCity: dc, destState: ds, loads: 0 };
          }
          corridorMap[key].loads++;
        }
      }
      const corridors = Object.values(corridorMap).sort((a, b) => b.loads - a.loads).slice(0, 200);
      res.json(corridors);
    } catch (err) {
      console.error("Lane corridors error:", err);
      res.status(500).json({ error: "Failed to compute lane corridors" });
    }
  });

  // ── Heatmap Data ─────────────────────────────────────────────────────────────
  app.get("/api/historical-heatmap", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      console.log(`[heatmap] ${uploads.length} upload(s) found`);
      const deliveries: Record<string, { city: string; state: string; count: number }> = {};
      const pickups: Record<string, { city: string; state: string; count: number }> = {};
      let totalRows = 0;
      if (uploads.length > 0) {
        const latestHeat = uploads[uploads.length - 1];
        const rawHeatRows: any[] = Array.isArray((latestHeat as any).rows) ? (latestHeat as any).rows : [];
        const heatCols = resolveColumns(rawHeatRows);
        const rows: any[] = rawHeatRows.filter((r: any) => getStatusFromRow(r, heatCols) !== "void");
        totalRows += rows.length;
        for (const row of rows) {
          const { destCity: dc, destState: ds, origCity: oc, origState: os } = parseHistoricalRow(row, heatCols);
          if (dc) { const k = `${dc}|${ds}`; if (!deliveries[k]) deliveries[k] = { city: dc, state: ds, count: 0 }; deliveries[k].count++; }
          if (oc) { const k = `${oc}|${os}`; if (!pickups[k]) pickups[k] = { city: oc, state: os, count: 0 }; pickups[k].count++; }
        }
      }
      console.log(`[heatmap] processed ${totalRows} rows → ${Object.keys(deliveries).length} delivery cities, ${Object.keys(pickups).length} pickup cities`);
      const geocode = (items: Record<string, { city: string; state: string; count: number }>) =>
        Object.values(items).map(i => {
          const coords = geocodeCity(i.city, i.state);
          if (!coords) return null;
          return { city: i.city, state: i.state, lat: coords[0], lng: coords[1], count: i.count };
        }).filter(Boolean).sort((a: any, b: any) => b.count - a.count).slice(0, 300);
      const result = { deliveries: geocode(deliveries), pickups: geocode(pickups) };
      console.log(`[heatmap] geocoded → ${result.deliveries.length} delivery pts, ${result.pickups.length} pickup pts`);
      res.json(result);
    } catch (err) {
      console.error("Heatmap error:", err);
      res.status(500).json({ error: "Failed to compute heatmap" });
    }
  });

  // ── Company Historical Trends ─────────────────────────────────────────────
  app.get("/api/companies/:id/historical-trends", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const company = await storage.getCompanyInOrg((req.params.id as string), user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ months: [], topDestinations: [], topCorridors: [], totalLoads: 0, spotLoads: 0, totalMargin: 0 });

      // Same normalize + nameMatches logic as the frontend
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const crmNorm = normalize(company.name);
      const aliasNorms = company.financialAlias
        ? company.financialAlias.split(',').map((a: string) => normalize(a.trim())).filter(Boolean)
        : [];
      const nameMatches = (crmToTest: string, excelNorm: string) => {
        if (excelNorm === crmToTest) return true;
        const shorter = crmToTest.length <= excelNorm.length ? crmToTest : excelNorm;
        const longer  = crmToTest.length <= excelNorm.length ? excelNorm : crmToTest;
        return shorter.length >= 5 && longer.includes(shorter);
      };
      const rowMatchesCompany = (row: any) => {
        const custNorm = normalize(String(row["Customer"] || "").trim());
        if (!custNorm) return false;
        if (aliasNorms.some((a: string) => nameMatches(a, custNorm))) return true;
        return nameMatches(crmNorm, custNorm);
      };

      const byMonth: Record<string, { totalLoads: number; spotLoads: number; totalMargin: number }> = {};
      const destMap: Record<string, { city: string; state: string; count: number }> = {};
      const corrMap: Record<string, { origin: string; destination: string; origCity: string; origState: string; destCity: string; destState: string; loads: number }> = {};
      let totalLoads = 0, spotLoads = 0, totalMargin = 0;

      // Only use the latest upload — iterating all uploads multiplies the row count unnecessarily
      const latest = uploads[uploads.length - 1];
      const rawCompRows: any[] = Array.isArray(latest.rows) ? latest.rows as any[] : [];
      const compCols = resolveColumns(rawCompRows);
      // Resolve the customer column name once up-front
      const custCol = compCols.customer;
      const rows: any[] = rawCompRows.filter((r: any) => getStatusFromRow(r, compCols) !== "void");
      for (const row of rows) {
        // Normalise the customer field once per row (not via the full rowMatchesCompany wrapper)
        const custNorm = normalize(String(row[custCol] || "").trim());
        if (!custNorm) continue;
        const matched = aliasNorms.some((a: string) => nameMatches(a, custNorm)) || nameMatches(crmNorm, custNorm);
        if (!matched) continue;
        const { destCity, destState, origCity, origState, monthKey, margin } = parseHistoricalRow(row, compCols);
        const orderType = String(row[compCols.orderType] || "").toLowerCase();
        const isSpot = orderType.includes("spot");
        totalLoads++;
        totalMargin += margin;
        if (isSpot) spotLoads++;
        if (monthKey) {
          if (!byMonth[monthKey]) byMonth[monthKey] = { totalLoads: 0, spotLoads: 0, totalMargin: 0 };
          byMonth[monthKey].totalLoads++;
          byMonth[monthKey].totalMargin += margin;
          if (isSpot) byMonth[monthKey].spotLoads++;
        }
        if (destCity) {
          const k = `${destCity}|${destState}`;
          if (!destMap[k]) destMap[k] = { city: destCity, state: destState, count: 0 };
          destMap[k].count++;
        }
        if (origCity && destCity) {
          const k = `${origCity},${origState}→${destCity},${destState}`;
          if (!corrMap[k]) corrMap[k] = { origin: `${origCity}${origState ? `, ${origState}` : ""}`, destination: `${destCity}${destState ? `, ${destState}` : ""}`, origCity, origState, destCity, destState, loads: 0 };
          corrMap[k].loads++;
        }
      }

      const months = Object.entries(byMonth)
        .map(([monthKey, b]) => ({ monthKey, ...b }))
        .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

      const topDestinations = Object.values(destMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, 15)
        .map(d => ({ destination: d.state ? `${d.city}, ${d.state}` : d.city, loads: d.count }));

      const topCorridors = Object.values(corrMap)
        .sort((a, b) => b.loads - a.loads)
        .slice(0, 15)
        .map(({ origin, destination, loads }) => ({ origin, destination, loads }));

      res.json({ months, topDestinations, topCorridors, totalLoads, spotLoads, totalMargin });
    } catch (err) {
      console.error("Company historical trends error:", err);
      res.status(500).json({ error: "Failed to compute trends" });
    }
  });

  // ── Proximity Matches (75-mile delivery zones vs RFP pickup origins) ────────
  app.get("/api/proximity-matches", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const rfps = await storage.getRfps();
      const companies = await storage.getCompanies(req.session.organizationId!);
      const users = await storage.getUsers(req.session.organizationId!);

      const companyMap = Object.fromEntries(companies.map((c: any) => [c.id, c]));
      const userMap = Object.fromEntries(users.map((u: any) => [u.id, u.name]));

      // Build delivery zone frequency — latest upload only
      const deliveryMap: Record<string, { city: string; state: string; count: number }> = {};
      if (uploads.length > 0) {
        const latestDz = uploads[uploads.length - 1];
        const rawDzRows: any[] = (latestDz as any).rows ?? [];
        const dzCols = resolveColumns(rawDzRows);
        const rows: any[] = rawDzRows.filter((r: any) => getStatusFromRow(r, dzCols) !== "void");
        for (const row of rows) {
          const { destCity: c, destState: s } = parseHistoricalRow(row, dzCols);
          if (!c) continue;
          const k = `${c}|${s}`;
          if (!deliveryMap[k]) deliveryMap[k] = { city: c, state: s, count: 0 };
          deliveryMap[k].count++;
        }
      }
      const deliveryZones = Object.values(deliveryMap)
        .map(d => { const coords = geocodeCity(d.city, d.state); return coords ? { ...d, lat: coords[0], lng: coords[1] } : null; })
        .filter(Boolean)
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 100) as Array<{ city: string; state: string; count: number; lat: number; lng: number }>;

      // Build RFP high-volume lane origins
      type LaneCandidate = { companyId: string; companyName: string; rfpId: string; rfpTitle: string; origin: string; destination: string; volume: number; assignedUserId: string; lat: number; lng: number };
      const laneCandidates: LaneCandidate[] = [];
      for (const rfp of rfps) {
        const fd = rfp.fileData as { highVolumeLanes?: any[] } | null;
        if (!fd?.highVolumeLanes) continue;
        const company = companyMap[rfp.companyId];
        const companyName = company?.name || rfp.companyId;
        const assignedUserId = company?.assignedTo || "";
        for (const lane of fd.highVolumeLanes) {
          const originCity = (lane.origin || "").toString().trim();
          const originState = (lane.originState || "").toString().trim();
          const destCity = (lane.destination || "").toString().trim();
          const destState = (lane.destinationState || "").toString().trim();
          if (!originCity && !originState) continue;
          const coords = geocodeCity(originCity, originState);
          if (!coords) continue;
          laneCandidates.push({
            companyId: rfp.companyId,
            companyName,
            rfpId: rfp.id,
            rfpTitle: rfp.title,
            origin: originCity ? `${originCity}${originState ? `, ${originState}` : ""}` : originState,
            destination: destCity ? `${destCity}${destState ? `, ${destState}` : ""}` : destState,
            volume: lane.volume ?? 0,
            assignedUserId,
            lat: coords[0],
            lng: coords[1],
          });
        }
      }

      const RADIUS_MILES = 75;
      const results = deliveryZones.map(zone => {
        const matches = laneCandidates
          .map(lane => {
            const dist = haversineDistance(zone.lat, zone.lng, lane.lat, lane.lng);
            return dist <= RADIUS_MILES ? { ...lane, distance: Math.round(dist * 10) / 10, assignedName: userMap[lane.assignedUserId] || "Unassigned" } : null;
          })
          .filter(Boolean)
          .sort((a: any, b: any) => a.distance - b.distance);
        return { zone: `${zone.city}, ${zone.state}`, city: zone.city, state: zone.state, lat: zone.lat, lng: zone.lng, weeklyLoads: Math.round(zone.count / 52 * 10) / 10, totalLoads: zone.count, matchCount: matches.length, matches };
      }).filter(r => r.matchCount > 0).sort((a, b) => b.matchCount - a.matchCount);

      res.json(results);
    } catch (err) {
      console.error("Proximity matches error:", err);
      res.status(500).json({ error: "Failed to compute proximity matches" });
    }
  });

  // ── Lane Matching (company-specific: our history vs their RFP lanes) ─────────
  app.get("/api/companies/:id/lane-matching", requireAuth, async (req, res) => {
    try {
      const companyId = (req.params.id as string);
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const allRfps = await storage.getRfps();

      // Build geocoded frequency maps for our deliveries (consignee) and pickups (shipper)
      const ourDeliveryMap: Record<string, { city: string; state: string; count: number; lat: number; lng: number }> = {};
      const ourPickupMap: Record<string, { city: string; state: string; count: number; lat: number; lng: number }> = {};

      for (const upload of uploads) {
        const rawProxRows: any[] = Array.isArray((upload as any).rows) ? (upload as any).rows : [];
        const proxCols = resolveColumns(rawProxRows);
        const rows: any[] = rawProxRows.filter((r: any) => getStatusFromRow(r, proxCols) !== "void");
        for (const row of rows) {
          const { destCity: dc, destState: ds, origCity: oc, origState: os } = parseHistoricalRow(row, proxCols);
          if (dc) {
            const k = `${dc}|${ds}`;
            if (!ourDeliveryMap[k]) {
              const coords = geocodeCity(dc, ds);
              if (coords) ourDeliveryMap[k] = { city: dc, state: ds, count: 0, lat: coords[0], lng: coords[1] };
            }
            if (ourDeliveryMap[k]) ourDeliveryMap[k].count++;
          }
          if (oc) {
            const k = `${oc}|${os}`;
            if (!ourPickupMap[k]) {
              const coords = geocodeCity(oc, os);
              if (coords) ourPickupMap[k] = { city: oc, state: os, count: 0, lat: coords[0], lng: coords[1] };
            }
            if (ourPickupMap[k]) ourPickupMap[k].count++;
          }
        }
      }

      const ourDeliveries = Object.values(ourDeliveryMap);
      const ourPickups = Object.values(ourPickupMap);
      const RADIUS_MILES = 50;

      // Group by geographic pair: one entry per unique (ourCity|ourState|customerCity|customerState)
      type GeoGroup = {
        ourCity: string; ourState: string;
        ourWeeklyLoads: number; ourTotalLoads: number;
        customerCity: string; customerState: string;
        distance: number; totalVolume: number;
        matchingLanes: Array<{ rfpTitle: string; rfpId: string; lane: string; volume: number }>;
      };
      const deliveryGroups: Record<string, GeoGroup> = {};
      const pickupGroups: Record<string, GeoGroup> = {};

      for (const rfp of allRfps) {
        if (rfp.companyId !== companyId) continue;
        const fd = rfp.fileData as { highVolumeLanes?: any[] } | null;
        if (!fd?.highVolumeLanes) continue;
        for (const lane of fd.highVolumeLanes) {
          const origCity = (lane.origin || "").toString().trim();
          const origState = (lane.originState || "").toString().trim();
          const destCity = (lane.destination || "").toString().trim();
          const destState = (lane.destinationState || "").toString().trim();
          const volume = lane.volume ?? 0;
          const laneStr = `${origCity}${origState ? `, ${origState}` : ""} → ${destCity}${destState ? `, ${destState}` : ""}`;

          // Mode A: Our deliveries vs their pickup (RFP origin)
          if (origCity) {
            const coords = geocodeCity(origCity, origState);
            if (coords) {
              for (const d of ourDeliveries) {
                const dist = haversineDistance(coords[0], coords[1], d.lat, d.lng);
                if (dist <= RADIUS_MILES) {
                  const geoKey = `${d.city}|${d.state}|${origCity}|${origState}`;
                  if (!deliveryGroups[geoKey]) {
                    deliveryGroups[geoKey] = {
                      ourCity: d.city, ourState: d.state,
                      ourWeeklyLoads: Math.round(d.count / 52 * 10) / 10,
                      ourTotalLoads: d.count,
                      customerCity: origCity, customerState: origState,
                      distance: Math.round(dist * 10) / 10,
                      totalVolume: 0,
                      matchingLanes: [],
                    };
                  }
                  const g = deliveryGroups[geoKey];
                  if (Math.round(dist * 10) / 10 < g.distance) g.distance = Math.round(dist * 10) / 10;
                  g.totalVolume += volume;
                  // Add lane if not already listed
                  if (!g.matchingLanes.some(l => l.lane === laneStr)) {
                    g.matchingLanes.push({ rfpTitle: rfp.title, rfpId: rfp.id, lane: laneStr, volume });
                  }
                }
              }
            }
          }

          // Mode B: Their deliveries (RFP destination) vs our pickups
          if (destCity) {
            const coords = geocodeCity(destCity, destState);
            if (coords) {
              for (const p of ourPickups) {
                const dist = haversineDistance(coords[0], coords[1], p.lat, p.lng);
                if (dist <= RADIUS_MILES) {
                  const geoKey = `${p.city}|${p.state}|${destCity}|${destState}`;
                  if (!pickupGroups[geoKey]) {
                    pickupGroups[geoKey] = {
                      ourCity: p.city, ourState: p.state,
                      ourWeeklyLoads: Math.round(p.count / 52 * 10) / 10,
                      ourTotalLoads: p.count,
                      customerCity: destCity, customerState: destState,
                      distance: Math.round(dist * 10) / 10,
                      totalVolume: 0,
                      matchingLanes: [],
                    };
                  }
                  const g = pickupGroups[geoKey];
                  if (Math.round(dist * 10) / 10 < g.distance) g.distance = Math.round(dist * 10) / 10;
                  g.totalVolume += volume;
                  if (!g.matchingLanes.some(l => l.lane === laneStr)) {
                    g.matchingLanes.push({ rfpTitle: rfp.title, rfpId: rfp.id, lane: laneStr, volume });
                  }
                }
              }
            }
          }
        }
      }

      const sortGroups = (groups: Record<string, GeoGroup>) =>
        Object.values(groups).sort((a, b) => b.totalVolume - a.totalVolume || a.distance - b.distance);

      res.json({
        ourDeliveriesToTheirPickups: sortGroups(deliveryGroups),
        theirDeliveriesToOurPickups: sortGroups(pickupGroups),
        hasHistoricalData: ourDeliveries.length > 0 || ourPickups.length > 0,
        hasRfpData: allRfps.some(r => r.companyId === companyId && (r.fileData as any)?.highVolumeLanes?.length > 0),
      });
    } catch (err) {
      console.error("Lane matching error:", err);
      res.status(500).json({ error: "Failed to compute lane matching" });
    }
  });

  async function canAccessPairing(user: { id: string; role: string; managerId: string | null }, namId: string, amId: string): Promise<boolean> {
    if (user.role === "admin") return true;
    if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") {
      return user.id === amId && user.managerId === namId;
    }
    if (user.role === "national_account_manager" || user.role === "director" || user.role === "sales" || user.role === "sales_director") {
      // Downward: NAM is namId, AM reports to them
      if (user.id === namId) {
        const am = await storage.getUser(amId);
        return !!am && am.managerId === user.id;
      }
      // Upward: NAM is amId, their manager is namId
      if (user.id === amId && user.managerId === namId) return true;
      return false;
    }
    return false;
  }

  async function canAccessSession(user: { id: string; role: string; managerId: string | null }, sessionId: string): Promise<boolean> {
    const session = await storage.getSession(sessionId);
    if (!session) return false;
    return canAccessPairing(user, session.namId, session.amId);
  }

  app.get("/api/one-on-one/pending-count", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const allUsers = await storage.getUsers(req.session.organizationId!);
      let pairs: Array<{ namId: string; amId: string }> = [];

      const amLikeRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (amLikeRoles.includes(user.role)) {
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      } else if (user.role === "admin") {
        // All manager-report pairs in the entire org (admin→direct + all below)
        const allReports = allUsers.filter(u => u.managerId && u.role !== "admin");
        for (const report of allReports) {
          pairs.push({ namId: report.managerId!, amId: report.id });
        }
      } else {
        // NAM/Director: downward (ALL direct reports) + upward (their manager)
        const reports = allUsers.filter(u => u.managerId === user.id);
        for (const am of reports) pairs.push({ namId: user.id, amId: am.id });
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      }

      const counts = await Promise.all(pairs.map(async ({ namId, amId }) => {
        const session = await storage.getOrCreateActiveSession(namId, amId);
        const topics = await storage.getTopicsBySession(session.id);
        return topics.filter(t => t.status === "pending").length;
      }));
      const count = counts.reduce((s, c) => s + c, 0);
      res.json({ count });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch pending count" });
    }
  });

  app.get("/api/one-on-one/action-items", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const allUsers = await storage.getUsers(req.session.organizationId!);
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      let pairs: Array<{ namId: string; amId: string }> = [];

      const amLikeRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (amLikeRoles.includes(user.role)) {
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      } else if (user.role === "admin") {
        // All manager-report pairs in the entire org (admin→direct + all below)
        const allReports = allUsers.filter(u => u.managerId && u.role !== "admin");
        for (const report of allReports) {
          pairs.push({ namId: report.managerId!, amId: report.id });
        }
      } else {
        const reports = allUsers.filter(u => u.managerId === user.id);
        for (const am of reports) pairs.push({ namId: user.id, amId: am.id });
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      }

      const results: Array<{
        id: string; text: string; tag: string; status: string; createdAt: string;
        sessionId: string; addedById: string; namId: string; amId: string;
        withUserName: string; addedByName: string;
      }> = [];

      const pairResults = await Promise.all(pairs.map(async ({ namId, amId }) => {
        const session = await storage.getOrCreateActiveSession(namId, amId);
        const topics = await storage.getTopicsBySession(session.id);
        const actionItems = topics.filter(t => t.status === "pending" && (t.tag === "action_item" || t.tag === "Action Item"));
        return actionItems.map(topic => {
          const otherId = user.id === namId ? amId : namId;
          const otherUser = safeUsers.find(u => u.id === otherId);
          const addedByUser = safeUsers.find(u => u.id === topic.addedById);
          return {
            id: topic.id!,
            text: topic.text,
            tag: topic.tag ?? "",
            status: topic.status,
            createdAt: String(topic.createdAt),
            sessionId: session.id,
            addedById: topic.addedById,
            namId,
            amId,
            withUserName: otherUser?.name ?? "Unknown",
            addedByName: addedByUser?.name ?? "Unknown",
          };
        });
      }));
      results.push(...pairResults.flat());

      results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch action items" });
    }
  });

  app.get("/api/one-on-one/per-pairing-counts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const allUsers = await storage.getUsers(req.session.organizationId!);
      let pairs: Array<{ namId: string; amId: string }> = [];

      const amLikeRoles2 = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (amLikeRoles2.includes(user.role)) {
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      } else if (user.role === "admin") {
        // All manager-report pairs in the entire org (admin→direct + all below)
        const allReports = allUsers.filter(u => u.managerId && u.role !== "admin");
        for (const report of allReports) {
          pairs.push({ namId: report.managerId!, amId: report.id });
        }
      } else {
        // NAM/Director: downward (ALL direct reports) + upward (their manager)
        const reports = allUsers.filter(u => u.managerId === user.id);
        for (const am of reports) pairs.push({ namId: user.id, amId: am.id });
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      }

      const results = await Promise.all(pairs.map(async ({ namId, amId }) => {
        const session = await storage.getOrCreateActiveSession(namId, amId);
        const topics = await storage.getTopicsBySession(session.id);
        const pending = topics.filter(t => t.status === "pending").length;
        return { namId, amId, pendingCount: pending };
      }));

      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch per-pairing counts" });
    }
  });

  app.get("/api/one-on-one/session", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query;
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId are required" });
      if (!(await canAccessPairing(currentUser, namId as string, amId as string))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const session = await storage.getOrCreateActiveSession(namId as string, amId as string);
      const topics = await storage.getTopicsBySession(session.id);
      res.json({ session, topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.get("/api/one-on-one/pairings", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const allUsers = await storage.getUsers(req.session.organizationId!);
      const safeUsers = allUsers.map(({ password, ...u }) => u);

      if (currentUser.role === "account_manager" || currentUser.role === "logistics_manager" || currentUser.role === "logistics_coordinator") {
        if (!currentUser.managerId) return res.json([]);
        const manager = safeUsers.find(u => u.id === currentUser.managerId);
        if (!manager) return res.json([]);
        return res.json([{ namId: manager.id, amId: currentUser.id, namName: manager.name, amName: currentUser.name, section: "my_manager" }]);
      }

      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        const result: { namId: string; amId: string; namName: string; amName: string; section: string }[] = [];
        // Upward: pairing with their own manager (admin/director above them)
        if (currentUser.managerId) {
          const manager = safeUsers.find(u => u.id === currentUser.managerId);
          if (manager) {
            result.push({ namId: manager.id, amId: currentUser.id, namName: manager.name, amName: currentUser.name, section: "upward" });
          }
        }
        // Downward: pairings with ALL direct reports (AM, NAM, director, etc.)
        const directReports = safeUsers.filter(u => u.managerId === currentUser.id);
        for (const am of directReports) {
          result.push({ namId: currentUser.id, amId: am.id, namName: currentUser.name, amName: am.name, section: "my_reports" });
        }
        return res.json(result);
      }

      if (currentUser.role === "admin") {
        const result: { namId: string; amId: string; namName: string; amName: string; section: string; groupLabel?: string }[] = [];
        const directReports = safeUsers.filter(u => u.managerId === currentUser.id && (u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director"));
        // Admin→Director/NAM direct pairings first
        for (const dr of directReports) {
          result.push({ namId: currentUser.id, amId: dr.id, namName: currentUser.name, amName: dr.name, section: "my_nams", groupLabel: dr.name });
        }
        // ALL manager-report pairs below admin level (Director→NAM, NAM→AM, Director→AM, etc.)
        const allSubReports = safeUsers.filter(u => u.managerId && u.managerId !== currentUser.id && u.role !== "admin");
        for (const report of allSubReports) {
          const manager = safeUsers.find(u => u.id === report.managerId);
          if (manager) {
            result.push({ namId: manager.id, amId: report.id, namName: manager.name, amName: report.name, section: "team", groupLabel: manager.name });
          }
        }
        return res.json(result);
      }

      res.json([]);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch pairings" });
    }
  });

  app.post("/api/one-on-one/topics", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { sessionId, text, tag } = req.body;
      if (!sessionId || !text || typeof text !== "string") {
        return res.status(400).json({ error: "sessionId and text are required" });
      }
      if (!(await canAccessSession(currentUser, sessionId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const validTags = ["Action Item", "Question", "FYI", "Follow-up", "Shoutout", "Let's Work On", "shoutout", "lets_work_on", "fyi", "action_item", "question", "follow_up"];
      const validatedTag = tag && validTags.includes(tag) ? tag : null;
      const topic = await storage.createTopic({
        sessionId,
        addedById: currentUser.id,
        text: text.trim(),
        tag: validatedTag,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      // Notify the other party in the 1:1 session
      const session = await storage.getSession(sessionId);
      if (session) {
        const otherUserId = session.namId === currentUser.id ? session.amId : session.namId;
        if (otherUserId !== currentUser.id) {
          storage.createNotification({
            userId: otherUserId,
            type: "topic_added",
            title: `${currentUser.name} added a 1:1 topic`,
            body: text.trim().length > 80 ? text.trim().slice(0, 80) + "…" : text.trim(),
            link: "/one-on-one",
            relatedId: topic.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
      }
      res.status(201).json(topic);
    } catch (error) {
      res.status(500).json({ error: "Failed to create topic" });
    }
  });

  app.patch("/api/one-on-one/topics/:id/toggle", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTopic((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Topic not found" });
      if (!(await canAccessSession(currentUser, existing.sessionId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const topic = await storage.toggleTopicStatus((req.params.id as string));
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      res.json(topic);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle topic" });
    }
  });

  app.delete("/api/one-on-one/topics/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTopic((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Topic not found" });
      if (!(await canAccessSession(currentUser, existing.sessionId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteTopic((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Topic not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete topic" });
    }
  });

  // Topic replies — threaded dialogue within a 1:1 topic
  app.get("/api/one-on-one/topics/:id/replies", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const topic = await storage.getTopic((req.params.id as string));
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      const replies = await storage.getTopicReplies((req.params.id as string));
      res.json(replies);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch replies" });
    }
  });

  app.post("/api/one-on-one/topics/:id/replies", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const topic = await storage.getTopic((req.params.id as string));
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ error: "Text required" });
      const reply = await storage.addTopicReply({
        topicId: (req.params.id as string),
        authorId: currentUser.id,
        text: text.trim(),
        createdAt: new Date().toISOString(),
      });
      // Notify ALL session participants (both namId and amId) except the author
      const session = await storage.getSession(topic.sessionId);
      if (session) {
        const participantIds = [session.namId, session.amId].filter(id => id && id !== currentUser.id);
        for (const uid of participantIds) {
          storage.createNotification({
            userId: uid,
            type: "topic_reply",
            title: `${currentUser.name} replied to a 1:1 topic`,
            body: text.trim().length > 80 ? text.trim().slice(0, 80) + "…" : text.trim(),
            link: "/one-on-one",
            relatedId: reply.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
      }
      res.status(201).json(reply);
    } catch (error) {
      res.status(500).json({ error: "Failed to add reply" });
    }
  });

  app.delete("/api/one-on-one/topic-replies/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deleteTopicReply((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Reply not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete reply" });
    }
  });

  app.post("/api/one-on-one/sessions/:id/close", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessSession(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const closedSession = await storage.getSession((req.params.id as string));
      const newSession = await storage.closeSession((req.params.id as string));
      if (!newSession) return res.status(404).json({ error: "Session not found" });
      // Notify the other party that the session was closed
      if (closedSession) {
        const otherUserId = closedSession.namId === currentUser.id ? closedSession.amId : closedSession.namId;
        if (otherUserId !== currentUser.id) {
          storage.createNotification({
            userId: otherUserId,
            type: "session_closed",
            title: `${currentUser.name} closed the 1:1 session`,
            body: "Pending topics have been carried forward to a new session.",
            link: "/one-on-one",
            relatedId: newSession.id,
            read: false,
          }).catch(() => {});
        }
      }
      const topics = await storage.getTopicsBySession(newSession.id);
      const easterEgg = await tryClaimEasterEgg("first_1on1_close", currentUser.id);
      res.json({ session: newSession, topics, easterEgg });
    } catch (error) {
      res.status(500).json({ error: "Failed to close session" });
    }
  });

  app.post("/api/one-on-one/sessions/:id/generate-summary", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const session = await storage.getSession(req.params.id as string);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!(await canAccessSession(currentUser, req.params.id as string))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const topics = await storage.getTopicsBySession(req.params.id as string);
      const discussed = topics.filter(t => t.status === "discussed");
      const pending = topics.filter(t => t.status === "pending");
      const notes = session.notes || "";

      const topicLines = (arr: typeof topics) => arr.map(t => `- [${t.tag?.replace(/_/g, " ") || "topic"}] ${t.text}`).join("\n");

      const prompt = `You are summarizing a 1:1 meeting between a manager and a sales rep.

Discussed topics:
${discussed.length > 0 ? topicLines(discussed) : "None"}

Pending / carry-forward topics:
${pending.length > 0 ? topicLines(pending) : "None"}

Session notes:
${notes || "None"}

Write a concise 2–4 sentence summary capturing: key takeaways, any decisions made, and the most important action items. Write in plain prose, no bullet points. Keep it under 100 words.`;

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      const summary = completion.choices[0]?.message?.content?.trim() || "";
      res.json({ summary });
    } catch (error) {
      console.error("Error generating session summary:", error);
      res.status(500).json({ error: "Failed to generate summary" });
    }
  });

  app.get("/api/one-on-one/archived", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query;
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId are required" });
      if (!(await canAccessPairing(currentUser, namId as string, amId as string))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const sessions = await storage.getArchivedSessions(namId as string, amId as string);
      const sessionsWithTopics = await Promise.all(
        sessions.map(async (s) => ({
          ...s,
          topics: await storage.getTopicsBySession(s.id),
        }))
      );
      res.json(sessionsWithTopics);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch archived sessions" });
    }
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const notifs = await storage.getNotifications(user.id);
      res.json(notifs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.markNotificationRead((req.params.id as string));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notification read" });
    }
  });

  app.patch("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { types, ids } = (req.body || {}) as { types?: string[]; ids?: string[] };
      if (ids && Array.isArray(ids) && ids.length > 0) {
        await storage.markNotificationsReadByIds(user.id, ids);
      } else if (types && Array.isArray(types) && types.length > 0) {
        await storage.markNotificationsReadByTypes(user.id, types);
      } else {
        await storage.markAllNotificationsRead(user.id);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark all notifications read" });
    }
  });

  // ── Personal Alerts ──────────────────────────────────────────────────────
  app.get("/api/alerts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.fireDueAlerts(user.id);
      const alerts = await storage.getPersonalAlerts(user.id);
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.post("/api/alerts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, notes, scheduledDate, companyId } = req.body;
      if (!title || !scheduledDate) {
        return res.status(400).json({ error: "Title and scheduled date are required" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) || isNaN(new Date(scheduledDate + "T00:00:00").getTime())) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      }
      const alert = await storage.createPersonalAlert({
        userId: user.id,
        title,
        notes: notes || null,
        scheduledDate,
        companyId: companyId || null,
        fired: false,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(alert);
    } catch (error) {
      res.status(500).json({ error: "Failed to create alert" });
    }
  });

  app.delete("/api/alerts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deletePersonalAlert((req.params.id as string), user.id);
      if (!deleted) return res.status(404).json({ error: "Alert not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete alert" });
    }
  });

  // ── Company Activity Timeline ──────────────────────────────────────────────
  app.get("/api/companies/:id/activity", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const activity = await storage.getCompanyActivity((req.params.id as string));
      res.json(activity);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  // ── Team Performance ───────────────────────────────────────────────────────
  app.get("/api/team/performance", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const amEquivRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (amEquivRoles.includes(user.role)) return res.status(403).json({ error: "Access denied" });
      let teamIds: string[];
      if (user.role === "admin") {
        const allUsers = await storage.getUsers(req.session.organizationId!);
        teamIds = allUsers.filter(u => u.role === "account_manager" || u.role === "national_account_manager" || u.role === "logistics_manager" || u.role === "logistics_coordinator" || u.role === "director" || u.role === "sales_director" || u.role === "sales").map(u => u.id);
      } else {
        teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
      }

      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];
      const period = (req.query.period as string) || "current";
      let startDate: string;
      let endDate: string;
      if (period === "last") {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        startDate = lastMonth.toISOString().split("T")[0];
        endDate = lastMonthEnd.toISOString().split("T")[0];
      } else if (period === "ytd") {
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
      } else {
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        endDate = todayStr;
      }

      // Compute previous-period dates for trend comparison
      let prevStartDate: string;
      let prevEndDate: string;
      if (period === "last") {
        const twoBack = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        const twoBackEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);
        prevStartDate = twoBack.toISOString().split("T")[0];
        prevEndDate = twoBackEnd.toISOString().split("T")[0];
      } else if (period === "ytd") {
        prevStartDate = `${now.getFullYear() - 1}-01-01`;
        prevEndDate = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      } else {
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        prevStartDate = lastMonthStart.toISOString().split("T")[0];
        prevEndDate = lastMonthEnd.toISOString().split("T")[0];
      }

      const [perf, prevPerf, allUsers] = await Promise.all([
        storage.getTeamPerformance(teamIds, startDate, endDate),
        storage.getTeamPerformance(teamIds, prevStartDate, prevEndDate),
        storage.getUsers(req.session.organizationId!),
      ]);
      const prevPerfMap: Record<string, typeof prevPerf[0]> = {};
      for (const p of prevPerf) prevPerfMap[p.userId] = p;

      const result = perf.map(p => {
        const u = allUsers.find(u => u.id === p.userId);
        const prev = prevPerfMap[p.userId];
        return {
          ...p,
          name: u?.name || "Unknown",
          role: u?.role || "account_manager",
          managerId: u?.managerId,
          financialRepId: (u as any)?.financialRepId || null,
          createdAt: u?.createdAt || null,
          prevCallTouchpoints: prev?.callTouchpoints ?? 0,
          prevTextTouchpoints: prev?.textTouchpoints ?? 0,
          prevEmailTouchpoints: prev?.emailTouchpoints ?? 0,
          prevMeaningfulTouchpoints: prev?.meaningfulTouchpoints ?? 0,
        };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch team performance" });
    }
  });

  // ── Team Performance Drill-Down Detail ─────────────────────────────────────
  app.get("/api/team/performance/detail/:metric", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const amEquivRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (amEquivRoles.includes(user.role)) return res.status(403).json({ error: "Access denied" });

      const metric = req.params.metric as string;
      const period = (req.query.period as string) || "current";
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];
      let startDate: string;
      let endDate: string;
      if (period === "last") {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        startDate = lastMonth.toISOString().split("T")[0];
        endDate = lastMonthEnd.toISOString().split("T")[0];
      } else if (period === "ytd") {
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
      } else {
        startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        endDate = todayStr;
      }

      let teamIds: string[];
      if (user.role === "admin") {
        const allUsers = await storage.getUsers(req.session.organizationId!);
        teamIds = allUsers.filter(u => ["account_manager","national_account_manager","logistics_manager","logistics_coordinator","director","sales_director","sales"].includes(u.role)).map(u => u.id);
      } else {
        teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
      }

      const allUsers = await storage.getUsers(req.session.organizationId!);
      const usersById: Record<string, typeof allUsers[0]> = {};
      for (const u of allUsers) usersById[u.id] = u;

      const allCompanies = await storage.getCompanies(req.session.organizationId!);
      const companiesById: Record<string, typeof allCompanies[0]> = {};
      for (const c of allCompanies) companiesById[c.id] = c;

      const allContacts = await storage.getContacts();
      const contactsById: Record<string, typeof allContacts[0]> = {};
      for (const c of allContacts) contactsById[c.id] = c;

      const touchpointMetrics = ["calls", "texts", "emails", "touched", "meaningful"];
      const taskMetrics = ["open_tasks", "overdue"];
      const accountMetrics = ["total_accounts", "new_contacts", "relationships_moved"];

      if (touchpointMetrics.includes(metric)) {
        const teamIdSet = new Set(teamIds);
        const allTps = await storage.getTouchpoints();
        let tps = allTps.filter(tp =>
          teamIdSet.has(tp.loggedById) &&
          tp.date >= startDate &&
          tp.date <= endDate
        );

        if (metric === "calls") tps = tps.filter(tp => tp.type === "call");
        else if (metric === "texts") tps = tps.filter(tp => tp.type === "text");
        else if (metric === "emails") tps = tps.filter(tp => tp.type === "email");
        else if (metric === "meaningful") tps = tps.filter(tp => tp.isMeaningful);
        else if (metric === "touched") {
          // Dedup per-rep per-contact (matches aggregate: sum of each rep's unique contacts)
          const seenRepContact = new Set<string>();
          const uniqueTps: typeof tps = [];
          for (const tp of tps) {
            if (!tp.contactId) continue;
            const key = `${tp.loggedById}:${tp.contactId}`;
            if (!seenRepContact.has(key)) {
              seenRepContact.add(key);
              uniqueTps.push(tp);
            }
          }
          tps = uniqueTps;
        }

        const tpIds = tps.map(t => t.id);
        const attachmentCounts: Record<string, number> = {};
        if (tpIds.length > 0) {
          const attachments = await storage.getAttachmentsByEntities("touchpoint", tpIds);
          for (const a of attachments) {
            attachmentCounts[a.entityId] = (attachmentCounts[a.entityId] || 0) + 1;
          }
        }

        interface TouchpointRow {
          id: string;
          repName: string;
          contactName: string | null;
          companyName: string | null;
          date: string;
          notes: string | null;
          hasAttachments: boolean;
          isMeaningful: boolean;
          type: string;
        }

        const rows: TouchpointRow[] = tps.map(tp => {
          const rep = usersById[tp.loggedById];
          const contact = tp.contactId ? contactsById[tp.contactId] : null;
          const company = companiesById[tp.companyId];
          return {
            id: tp.id,
            repName: rep?.name ?? "Unknown",
            contactName: contact?.name ?? null,
            companyName: company?.name ?? null,
            date: tp.date,
            notes: tp.notes ?? null,
            hasAttachments: (attachmentCounts[tp.id] ?? 0) > 0,
            isMeaningful: tp.isMeaningful ?? false,
            type: tp.type,
          };
        });

        rows.sort((a, b) => b.date.localeCompare(a.date));
        return res.json({ metric, period, startDate, endDate, rows });
      }

      if (taskMetrics.includes(metric)) {
        const allTasks = await storage.getTasks();
        const teamTaskIds = new Set(teamIds);
        let filtered = allTasks.filter(t => teamTaskIds.has(t.assignedTo));
        if (metric === "open_tasks") {
          filtered = filtered.filter(t => t.status === "open" || t.status === "in_progress");
        } else if (metric === "overdue") {
          filtered = filtered.filter(t => (t.status === "open" || t.status === "in_progress") && t.dueDate && t.dueDate < todayStr);
        }

        interface TaskRow {
          id: string;
          title: string;
          notes: string | null;
          repName: string;
          companyName: string | null;
          dueDate: string | null;
          status: string;
          isOverdue: boolean;
        }

        const rows: TaskRow[] = filtered.map(t => {
          const rep = usersById[t.assignedTo];
          const company = t.companyId ? companiesById[t.companyId] : null;
          return {
            id: t.id,
            title: t.title,
            notes: t.notes ?? null,
            repName: rep?.name ?? "Unknown",
            companyName: company?.name ?? null,
            dueDate: t.dueDate ?? null,
            status: t.status,
            isOverdue: !!(t.dueDate && t.dueDate < todayStr && (t.status === "open" || t.status === "in_progress")),
          };
        });

        rows.sort((a, b) => {
          if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          return 0;
        });
        return res.json({ metric, period, startDate, endDate, rows });
      }

      if (accountMetrics.includes(metric)) {
        const companiesByTeam = allCompanies.filter(c => c.assignedTo && teamIds.includes(c.assignedTo));

        if (metric === "total_accounts") {
          const rows = companiesByTeam.map(c => {
            const rep = c.assignedTo ? usersById[c.assignedTo] : null;
            return {
              id: c.id,
              accountName: c.name,
              repName: rep?.name ?? "Unknown",
              industry: c.industry ?? null,
            };
          });
          rows.sort((a, b) => a.accountName.localeCompare(b.accountName));
          return res.json({ metric, period, startDate, endDate, rows });
        }

        if (metric === "new_contacts") {
          const newContacts = allContacts.filter(c => {
            const d = c.createdAt?.slice(0, 10);
            if (!d || d < startDate || d > endDate) return false;
            const company = companiesById[c.companyId];
            return company && company.assignedTo && teamIds.includes(company.assignedTo);
          });
          const rows = newContacts.map(c => {
            const company = companiesById[c.companyId];
            const rep = company?.assignedTo ? usersById[company.assignedTo] : null;
            const creator = c.createdBy ? usersById[c.createdBy] : null;
            return {
              id: c.id,
              contactName: c.name,
              companyName: company?.name ?? null,
              repName: creator?.name ?? rep?.name ?? "Unknown",
              dateAdded: c.createdAt?.slice(0, 10) ?? null,
            };
          });
          rows.sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""));
          return res.json({ metric, period, startDate, endDate, rows });
        }

        if (metric === "relationships_moved") {
          const movedContacts = allContacts.filter(c => {
            const d = c.baseAdvancedAt?.slice(0, 10);
            if (!d || d < startDate || d > endDate) return false;
            const company = companiesById[c.companyId];
            return company && company.assignedTo && teamIds.includes(company.assignedTo);
          });
          const rows = movedContacts.map(c => {
            const company = companiesById[c.companyId];
            const rep = company?.assignedTo ? usersById[company.assignedTo] : null;
            return {
              id: c.id,
              contactName: c.name,
              companyName: company?.name ?? null,
              repName: rep?.name ?? "Unknown",
              dateAdvanced: c.baseAdvancedAt?.slice(0, 10) ?? null,
              relationshipBase: c.relationshipBase ?? null,
            };
          });
          rows.sort((a, b) => (b.dateAdvanced ?? "").localeCompare(a.dateAdvanced ?? ""));
          return res.json({ metric, period, startDate, endDate, rows });
        }
      }

      return res.status(400).json({ error: "Unknown metric" });
    } catch (error) {
      console.error("Error in team performance detail:", error);
      res.status(500).json({ error: "Failed to fetch detail data" });
    }
  });

  // ── SMTP Test ────────────────────────────────────────────────────────────
  app.post("/api/admin/smtp/test", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer || viewer.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const { verifySmtp, emailEnabled } = await import("./emailService");
      if (!emailEnabled()) {
        return res.status(422).json({ ok: false, error: "No email provider configured. Set RESEND_API_KEY (recommended) or SMTP_HOST + SMTP_USER + SMTP_PASSWORD." });
      }
      const result = await verifySmtp();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Seed Demo Org ─────────────────────────────────────────────────────────
  app.post("/api/admin/seed-demo", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer || viewer.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const { execSync } = await import("child_process");
      const output = execSync("npx tsx scripts/seed-demo-org.ts", {
        cwd: process.cwd(),
        timeout: 120000,
        env: { ...process.env },
      });
      res.json({ success: true, message: "Demo org seeded successfully", output: output.toString().slice(-500) });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message?.slice(0, 300) });
    }
  });

  // ── Rep Progress Report ───────────────────────────────────────────────────
  // ── Outlook / Microsoft Graph Email ─────────────────────────────────────
  app.get("/api/outlook/status", requireAuth, async (_req, res) => {
    const { outlookEnabled } = await import("./outlookService");
    res.json({ enabled: outlookEnabled() });
  });

  app.post("/api/outlook/send", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const { toEmail, toName, subject, body, ccEmails, isHtml, contactId } = req.body || {};
      if (!toEmail || !subject || !body) {
        return res.status(400).json({ error: "toEmail, subject, and body are required" });
      }

      // The "from" address is the logged-in user's username (which is their email)
      const fromEmail = currentUser.username;
      if (!fromEmail || !fromEmail.includes("@")) {
        return res.status(400).json({ error: "Your account username must be a valid email address to send via Outlook" });
      }

      const { sendOutlookEmail, outlookEnabled } = await import("./outlookService");
      if (!outlookEnabled()) {
        return res.status(503).json({ error: "Outlook integration is not configured on this server" });
      }

      const result = await sendOutlookEmail({
        fromEmail,
        toEmail,
        toName,
        subject,
        body,
        ccEmails: ccEmails || [],
        isHtml: isHtml !== false,
        saveToSentItems: true,
      });

      if (!result.ok) {
        return res.status(500).json({ success: false, error: result.error });
      }

      // Auto-log a touchpoint if a contactId was provided
      let touchpoint = null;
      if (contactId) {
        try {
          const contact = await storage.getContact(contactId as string);
          if (contact) {
            const now = new Date();
            // Strip signature (everything after <hr>) and HTML tags, then decode entities
            const bodyBeforeHr = body.replace(/<hr\b[^>]*>[\s\S]*/i, "");
            const plainBody = bodyBeforeHr
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<\/div>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            const notes = `Subject: ${subject}\n\n${plainBody}`;
            touchpoint = await storage.createTouchpoint({
              contactId,
              companyId: contact.companyId,
              type: "email",
              date: now.toISOString().split("T")[0],
              notes,
              sentiment: null,
              isMeaningful: false,
              loggedById: currentUser.id,
              createdAt: now.toISOString(),
            });
            cacheInvalidatePrefix(`cold-contacts:${currentUser.id}`);
          }
        } catch (tpErr) {
          console.error("[outlook] touchpoint log failed:", tpErr);
        }
      }

      // Email auto-logging: if no contactId provided, try to match recipient domain to a CRM company
      let autoLinkedCompanyId: string | null = null;
      if (!contactId && toEmail && toEmail.includes("@")) {
        try {
          const domain = toEmail.split("@")[1]?.toLowerCase();
          if (domain && domain.length > 3 && !["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com"].includes(domain)) {
            const allCompanies = await storage.getCompanies(currentUser.organizationId);
            const visibleIds = await getVisibleCompanyIds(currentUser);
            const visibleCompanies = visibleIds === null
              ? allCompanies
              : allCompanies.filter(c => visibleIds.includes(c.id));
            const match = visibleCompanies.find(c => {
              if (c.archivedAt) return false;
              const website = (c.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
              return website && website === domain;
            }) || visibleCompanies.find(c => {
              if (c.archivedAt) return false;
              const nameDomain = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
              const emailDomainCore = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
              return emailDomainCore.length >= 4 && (nameDomain.includes(emailDomainCore) || emailDomainCore.includes(nameDomain.substring(0, 8)));
            });
            if (match) {
              autoLinkedCompanyId = match.id;
              const now = new Date();
              const bodyBeforeHr = body.replace(/<hr\b[^>]*>[\s\S]*/i, "");
              const plainBody = bodyBeforeHr
                .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n")
                .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                .replace(/\n{3,}/g, "\n\n").trim();
              const notes = `Subject: ${subject}\nTo: ${toEmail}\n\n${plainBody}`;
              await storage.createTouchpoint({
                contactId: null,
                companyId: match.id,
                type: "email",
                date: now.toISOString().split("T")[0],
                notes,
                sentiment: null,
                isMeaningful: false,
                loggedById: currentUser.id,
                createdAt: now.toISOString(),
              });
              cacheInvalidatePrefix(`cold-contacts:${currentUser.id}`);
            }
          }
        } catch (autoErr) {
          console.error("[outlook] auto-log email failed:", autoErr);
        }
      }

      res.json({ success: true, message: "Email sent successfully", touchpoint, autoLinkedCompanyId });
    } catch (error: any) {
      console.error("[outlook] send error:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  // Update a touchpoint (toggle meaningful, edit notes)
  app.patch("/api/touchpoints/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const tp = await storage.getTouchpoint(req.params.id as string);
      if (!tp) return res.status(404).json({ error: "Touchpoint not found" });
      const updates: { isMeaningful?: boolean; notes?: string } = {};
      if (req.body.isMeaningful !== undefined) updates.isMeaningful = req.body.isMeaningful === true;
      if (req.body.notes !== undefined) updates.notes = req.body.notes;
      const updated = await storage.updateTouchpoint(tp.id, updates);
      if (updated.isMeaningful) {
        const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
        const count = await storage.countMeaningfulThisMonth(user.id, monthStart);
        if (count >= 2) await tryClaimEasterEgg("first_meaningful_2", user.id);
      }
      cacheInvalidatePrefix(`meaningful-overdue:${user.id}`);
      res.json(updated);
    } catch (error) {
      console.error("Failed to update touchpoint:", error);
      res.status(500).json({ error: "Failed to update touchpoint" });
    }
  });
  // ── End Outlook ──────────────────────────────────────────────────────────

  app.post("/api/report/rep/:userId/send-email", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { userId } = req.params as Record<string, string>;
      const period = (req.body?.period as string) === "monthly" ? "monthly" : "weekly";
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (viewer.id !== userId && !managerRoles.includes(viewer.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { sendRepReportEmail } = await import("./repReportScheduler");
      const { ok, email: sentTo } = await sendRepReportEmail(userId, period);
      if (ok) {
        res.json({ success: true, message: "Report email sent", sentTo });
      } else {
        res.json({ success: false, message: sentTo ? "Email could not be sent — check SMTP configuration and try again." : "No username found for this user.", sentTo });
      }
    } catch (error: any) {
      console.error("send-email error:", error);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  // ── Bulk Report Send ────────────────────────────────────────────────────────
  // GET preview: who would receive emails for the current viewer's role scope
  app.get("/api/report/bulk-preview", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (!managerRoles.includes(viewer.role)) return res.status(403).json({ error: "Access denied" });

      const allUsers = await storage.getUsers(req.session.organizationId!);
      const salesRoles = ["account_manager", "national_account_manager", "sales", "logistics_manager", "sales_director", "director"];

      let targetIds: string[];
      if (viewer.role === "admin") {
        targetIds = allUsers.filter(u => salesRoles.includes(u.role)).map(u => u.id);
      } else {
        const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
        targetIds = teamIds.filter(id => {
          if (id === viewer.id) return false;
          const u = allUsers.find(u => u.id === id);
          return u && salesRoles.includes(u.role);
        });
      }

      const recipients = targetIds.map(id => {
        const u = allUsers.find(u => u.id === id)!;
        return { id: u.id, name: u.name, role: u.role, email: (u as any).email || u.username };
      }).sort((a, b) => a.name.localeCompare(b.name));

      res.json({ recipients, total: recipients.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: actually send bulk reports
  app.post("/api/report/bulk-send", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (!managerRoles.includes(viewer.role)) return res.status(403).json({ error: "Access denied" });

      const period: "weekly" | "monthly" = req.body?.period === "weekly" ? "weekly" : "monthly";
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const salesRoles = ["account_manager", "national_account_manager", "sales", "logistics_manager", "sales_director", "director"];

      let targetIds: string[];
      if (viewer.role === "admin") {
        targetIds = allUsers.filter(u => salesRoles.includes(u.role)).map(u => u.id);
      } else {
        const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
        targetIds = teamIds.filter(id => {
          if (id === viewer.id) return false;
          const u = allUsers.find(u => u.id === id);
          return u && salesRoles.includes(u.role);
        });
      }

      const { sendRepReportEmail } = await import("./repReportScheduler");
      const results: { name: string; email: string | null; ok: boolean }[] = [];

      for (const id of targetIds) {
        const u = allUsers.find(u => u.id === id)!;
        const { ok, email } = await sendRepReportEmail(id, period);
        results.push({ name: u.name, email, ok });
      }

      const sent = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;
      res.json({ sent, failed, total: targetIds.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/report/rep/:userId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { userId } = req.params as Record<string, string>;
      const period = (req.query.period as string) === "monthly" ? "monthly" : "weekly";
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (viewer.id !== userId && !managerRoles.includes(viewer.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = await storage.getRepReport(userId, period);
      res.json(data);
    } catch (error) {
      console.error("getRepReport error:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.post("/api/report/rep/:userId/snapshot", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { userId } = req.params as Record<string, string>;
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (viewer.id !== userId && !managerRoles.includes(viewer.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const period = (req.body?.period as string) === "monthly" ? "monthly" : "weekly";
      const payload = await storage.getRepReport(userId, period);
      const snapshot = await storage.createReportCardSnapshot({
        userId,
        periodType: period,
        periodLabel: payload.period.label,
        snapshotDate: new Date().toISOString(),
        payload,
        savedById: viewer.id,
      });
      res.json(snapshot);
    } catch (error) {
      console.error("snapshot error:", error);
      res.status(500).json({ error: "Failed to save snapshot" });
    }
  });

  app.get("/api/report/rep/:userId/snapshots", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { userId } = req.params as Record<string, string>;
      const managerRoles = ["admin", "director", "national_account_manager", "sales_director"];
      if (viewer.id !== userId && !managerRoles.includes(viewer.role)) {
        return res.status(403).json({ error: "Access denied" });
      }
      const snapshots = await storage.getReportCardSnapshots(userId);
      res.json(snapshots);
    } catch (error) {
      console.error("snapshots error:", error);
      res.status(500).json({ error: "Failed to load snapshots" });
    }
  });

  // ── Goals ─────────────────────────────────────────────────────────────────
  app.get("/api/goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      let goalsList;
      if (user.role === "admin") {
        goalsList = await storage.getGoals({});
      } else if (user.role === "director" || user.role === "sales" || user.role === "sales_director") {
        goalsList = await storage.getGoals({ namId: user.id });
      } else if (user.role === "national_account_manager") {
        const setGoals = await storage.getGoals({ namId: user.id });
        const assignedGoals = await storage.getGoals({ amId: user.id });
        const seen = new Set<string>();
        goalsList = [...setGoals, ...assignedGoals].filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
      } else if (user.role === "account_manager") {
        // AMs see their own goals AND any goals they've set for LM reports
        const ownGoals = await storage.getGoals({ amId: user.id });
        const setGoals = await storage.getGoals({ namId: user.id });
        const seen = new Set<string>();
        goalsList = [...ownGoals, ...setGoals].filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; });
      } else {
        goalsList = await storage.getGoals({ amId: user.id });
      }

      // Enrich goals with auto-computed values so dashboard alerts use accurate data
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const latestUpload = uploads.length ? uploads[uploads.length - 1] : null;

      const enriched = await Promise.all(goalsList.map(async (goal) => {
        let computedValue: number | null = null;
        if (goal.metric === "contacts_added") {
          computedValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "touchpoints") {
          computedValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "meaningful_touchpoints") {
          computedValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "margin" && latestUpload) {
          const amUser = allUsers.find(u => u.id === goal.amId);
          const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
          const isLMUser = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
          if (repKey && isLMUser) {
            // LMs: margin is in the Dispatcher column — use shared helper
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lmTxCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { totalMargin } = computeLoadsForRepGoal(txRows, lmTxCols, repKey, true, goalMonthKey);
            if (totalMargin > 0) computedValue = Math.round(totalMargin);
          } else if (repKey) {
            // AMs/NAMs: margin is in the Ops User column — use summary or tx rows
            const repKeyLower = repKey.toLowerCase();
            const raw = (latestUpload.summaryRows as any[]) || [];
            let total = 0;
            if (isBadSummaryData(raw)) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const goalTxCols = resolveColumns(txRows);
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                if (isExcludedRow(row, goalTxCols)) continue;
                const { monthKey, margin } = parseHistoricalRow(row, goalTxCols);
                const rep = getRepFromRow(row, goalTxCols);
                if (!rep) continue;
                if (!byRep[rep]) byRep[rep] = {};
                if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
              }
              if (goalMonthKey) total = (byRep[repKeyLower] || {})[goalMonthKey] || 0;
            } else {
              const firstRow = raw[0] || {};
              const usesEmptyKeys = "__EMPTY" in firstRow;
              let rows = raw;
              if (usesEmptyKeys) rows = raw.filter((r: any) => { const n = String(r["__EMPTY"] || "").trim(); return n && n !== "Customer Name" && n !== "TOTAL" && n !== "Customer code"; });
              const sumRawCols = resolveColumns(rows);
              for (const r of rows) {
                let repName: string, totalMargin: number;
                if (usesEmptyKeys) { repName = String(r["__EMPTY_6"] || "").trim(); totalMargin = Number(r["__EMPTY_3"] ?? 0); }
                else { repName = getRepFromRow(r, sumRawCols); totalMargin = Number(r["Total Margin $"] || r["Total Margin"] || 0); }
                if (repName.toLowerCase() === repKeyLower) total += totalMargin;
              }
            }
            if (total > 0) computedValue = Math.round(total);
          }
        }
        if ((goal.metric === "loads_booked" || goal.metric === "margin_pct") && latestUpload) {
          const amUser = allUsers.find(u => u.id === goal.amId);
          const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
          if (repKey) {
            const isLM = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lbCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, lbCols, repKey, isLM, goalMonthKey);
            if (goal.metric === "loads_booked") computedValue = loads;
            else computedValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
          }
        }
        return { ...goal, computedValue };
      }));

      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch goals" });
    }
  });

  app.get("/api/goals/monthly-check", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") return res.json([]);
      const namId = user.role === "admin" ? undefined : user.id;
      const missing = await storage.getAmsMissingMonthlyGoals(user.organizationId, namId);
      res.json(missing);
    } catch (error) {
      res.status(500).json({ error: "Failed to check monthly goals" });
    }
  });

  // ── Goals Leaderboard ─────────────────────────────────────────────────────
  app.get("/api/goals/leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const lbCacheKey = `leaderboard:${req.session.organizationId}`;
      const lbCached = cacheGet(lbCacheKey);
      if (lbCached) return res.json(lbCached);

      // All goals across the org (NAMs see company-wide leaderboard)
      const allGoals = await storage.getGoals({});
      const allUsers = await storage.getUsers(req.session.organizationId!);

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeGoals = allGoals.filter(g => g.startDate <= todayStr && (!g.endDate || g.endDate >= todayStr));

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const latestUpload = uploads.length ? uploads[uploads.length - 1] : null;

      type GoalEntry = { metric: string; customLabel: string | null; amId: string; amName: string; currentValue: number; target: number; pct: number };
      const goalEntries: GoalEntry[] = [];

      for (const goal of activeGoals) {
        const amUser = allUsers.find(u => u.id === goal.amId);
        if (!amUser) continue;

        let effectiveValue = parseFloat(goal.currentValue || "0");

        if (goal.metric === "contacts_added") {
          effectiveValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "touchpoints") {
          effectiveValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "meaningful_touchpoints") {
          effectiveValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        } else if (goal.metric === "margin" && latestUpload) {
          const repKey = (amUser as any).financialRepId as string | null;
          const isLMUser = (amUser as any).role === "logistics_manager" || (amUser as any).role === "logistics_coordinator";
          if (repKey && isLMUser) {
            // LMs: margin is in Dispatcher column
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lmTxCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { totalMargin } = computeLoadsForRepGoal(txRows, lmTxCols, repKey, true, goalMonthKey);
            if (totalMargin > 0) effectiveValue = Math.round(totalMargin);
          } else if (repKey) {
            // AMs/NAMs: margin is in Ops User column
            const raw = (latestUpload.summaryRows as any[]) || [];
            const repKeyLower = repKey.toLowerCase();
            let total = 0;
            if (isBadSummaryData(raw)) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const lbTxCols = resolveColumns(txRows);
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                if (isExcludedRow(row, lbTxCols)) continue;
                const { monthKey, margin } = parseHistoricalRow(row, lbTxCols);
                const rep = getRepFromRow(row, lbTxCols);
                if (!rep) continue;
                if (!byRep[rep]) byRep[rep] = {};
                if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
              }
              const repMonths = byRep[repKeyLower] || {};
              if (goalMonthKey) total = repMonths[goalMonthKey] || 0;
            } else {
              const firstRow = raw[0] || {};
              const usesEmptyKeys = "__EMPTY" in firstRow;
              let rows = raw;
              if (usesEmptyKeys) rows = raw.filter((r: any) => { const n = String(r["__EMPTY"] || "").trim(); return n && n !== "Customer Name" && n !== "TOTAL" && n !== "Customer code"; });
              for (const r of rows) {
                let repName: string, totalMargin: number;
                if (usesEmptyKeys) { repName = String(r["__EMPTY_6"] || "").trim(); totalMargin = Number(r["__EMPTY_3"] ?? 0); }
                else { repName = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim(); totalMargin = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0); }
                if (repName.toLowerCase() === repKeyLower) total += totalMargin;
              }
            }
            if (total > 0) effectiveValue = Math.round(total);
          }
        }
        if ((goal.metric === "loads_booked" || goal.metric === "margin_pct") && latestUpload) {
          const repKey = (amUser as any).financialRepId as string | null;
          if (repKey) {
            const isLM = (amUser as any).role === "logistics_manager" || (amUser as any).role === "logistics_coordinator";
            const txRows: any[] = (latestUpload.rows as any[]) || [];
            const lbCols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, lbCols, repKey, isLM, goalMonthKey);
            if (goal.metric === "loads_booked") effectiveValue = loads;
            else effectiveValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
          }
        }

        const target = parseFloat(goal.target || "0");
        const pct = target > 0 ? Math.min((effectiveValue / target) * 100, 999) : 0;
        goalEntries.push({ metric: goal.metric, customLabel: goal.customLabel, amId: goal.amId, amName: amUser.name, currentValue: effectiveValue, target, pct });
      }

      // Group by metric (custom uses label as sub-key), take top 3 by pct
      const metricGroups = new Map<string, GoalEntry[]>();
      for (const entry of goalEntries) {
        const key = entry.metric === "custom" ? `custom:${entry.customLabel || ""}` : entry.metric;
        if (!metricGroups.has(key)) metricGroups.set(key, []);
        metricGroups.get(key)!.push(entry);
      }

      const METRIC_ORDER = ["margin", "touchpoints", "contacts_added", "load_count", "custom"];
      const leaderboard: { metric: string; customLabel: string | null; entries: { rank: number; amId: string; amName: string; currentValue: number; target: number; pct: number }[] }[] = [];

      for (const [, entries] of metricGroups) {
        const sorted = [...entries].sort((a, b) => b.pct - a.pct).slice(0, 3);
        leaderboard.push({ metric: sorted[0].metric, customLabel: sorted[0].customLabel, entries: sorted.map((e, i) => ({ rank: i + 1, amId: e.amId, amName: e.amName, currentValue: e.currentValue, target: e.target, pct: e.pct })) });
      }

      leaderboard.sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
      cacheSet(`leaderboard:${req.session.organizationId}`, leaderboard);
      res.json(leaderboard);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  app.post("/api/goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "logistics_manager" || user.role === "logistics_coordinator") return res.status(403).json({ error: "Only managers can create goals" });
      // AMs can set goals for themselves or for users who report directly to them
      if (user.role === "account_manager") {
        const amId = req.body.amId;
        if (amId !== user.id) {
          const allUsers = await storage.getUsers(req.session.organizationId!);
          const targetUser = allUsers.find(u => u.id === amId);
          if (!targetUser || targetUser.managerId !== user.id) {
            return res.status(403).json({ error: "You can only set goals for yourself or your direct reports" });
          }
        }
      }
      const goal = await storage.createGoal({
        ...req.body,
        namId: user.role === "admin" ? (req.body.namId || user.id) : user.id,
        createdById: user.id,
        createdAt: new Date().toISOString(),
        currentValue: "0",
      });
      const isSelfGoal = goal.amId === user.id;
      if (!isSelfGoal && goal.amId) {
        // Notify the AM that a goal has been set for them
        storage.createNotification({
          userId: goal.amId,
          type: "goal_set",
          title: `${user.name} set a goal for you`,
          body: goal.title,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
      } else if (isSelfGoal) {
        // Self-goal: notify the user's director/manager and all admins
        const orgUsers = await storage.getUsers(req.session.organizationId!);
        const notifyIds = new Set<string>();
        if (user.managerId) notifyIds.add(user.managerId);
        orgUsers.filter(u => u.role === "admin" || u.role === "director" || u.role === "sales_director")
          .forEach(u => { if (u.id !== user.id) notifyIds.add(u.id); });
        for (const uid of notifyIds) {
          storage.createNotification({
            userId: uid,
            type: "goal_set",
            title: `${user.name} set a goal for themselves`,
            body: goal.title || goal.metric.replace(/_/g, " "),
            link: "/goals",
            relatedId: goal.id,
            read: false,
          }).catch(() => {});
        }
      }
      cacheInvalidatePrefix(`leaderboard:`);
      res.status(201).json(goal);
    } catch (error) {
      res.status(500).json({ error: "Failed to create goal" });
    }
  });

  // ── Bulk Goal Creation ──────────────────────────────────────────────────────
  app.post("/api/goals/bulk", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const namRoles = ["admin", "director", "national_account_manager"];
      if (!namRoles.includes(user.role)) return res.status(403).json({ error: "Access denied" });
      const { metric, period, target, startDate, endDate, notes, amIds } = req.body;
      if (!metric || !period || !target || !startDate || !endDate || !Array.isArray(amIds) || !amIds.length) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const existingGoals = await storage.getGoals({ namId: user.id });
      const created = [];
      let skipped = 0;
      for (const amId of amIds) {
        const isDuplicate = existingGoals.some(g =>
          g.amId === amId && g.metric === metric &&
          g.startDate === startDate && g.endDate === endDate
        );
        if (isDuplicate) { skipped++; continue; }
        const goal = await storage.createGoal({
          namId: user.id,
          amId,
          metric,
          period,
          target: String(target),
          currentValue: "0",
          startDate,
          endDate,
          notes: notes || null,
          status: "active",
          createdAt: new Date().toISOString(),
          createdById: user.id,
        });
        storage.createNotification({
          userId: amId,
          type: "goal_set",
          title: `${user.name} set a goal for you`,
          body: `${metric.replace(/_/g, " ")} — target: ${target}`,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
        created.push(goal);
      }
      res.status(201).json({ created: created.length, skipped });
    } catch (error) {
      res.status(500).json({ error: "Failed to bulk create goals" });
    }
  });

  app.patch("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      let canEdit = user.role === "admin" || existing.namId === user.id || existing.amId === user.id;
      if (!canEdit && (user.role === "director" || user.role === "sales_director")) {
        // Directors can edit margin goals for users in their own organization
        const orgId = req.session.organizationId;
        if (orgId && existing.metric === "margin") {
          const orgUsers = await storage.getUsers(orgId);
          const orgUserIds = new Set(orgUsers.map(u => u.id));
          canEdit = (existing.namId ? orgUserIds.has(existing.namId) : false) ||
                    (existing.amId ? orgUserIds.has(existing.amId) : false);
        }
      }
      if (!canEdit) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateGoal((req.params.id as string), req.body);
      // Notify the other party about goal updates
      const isProgressUpdate = req.body.currentValue !== undefined && Object.keys(req.body).length === 1;
      if (isProgressUpdate && existing.namId !== user.id) {
        // AM updated their progress — notify NAM
        storage.createNotification({
          userId: existing.namId,
          type: "goal_updated",
          title: `${user.name} updated goal progress`,
          body: existing.title,
          link: "/goals",
          relatedId: existing.id,
          read: false,
        }).catch(() => {});
      } else if (!isProgressUpdate && existing.amId && existing.amId !== user.id) {
        // NAM changed the goal definition — notify AM
        storage.createNotification({
          userId: existing.amId,
          type: "goal_updated",
          title: `${user.name} updated one of your goals`,
          body: existing.title,
          link: "/goals",
          relatedId: existing.id,
          read: false,
        }).catch(() => {});
      }
      // Goal completion: auto-complete and notify when value crosses target
      if (isProgressUpdate && existing.status !== "completed") {
        const newVal = parseFloat(req.body.currentValue || "0");
        const tgt = parseFloat(existing.target || "0");
        if (tgt > 0 && newVal >= tgt) {
          await storage.updateGoal((req.params.id as string), { status: "completed" }).catch(() => {});
          const goalTitle = existing.title || `${existing.metric.replace(/_/g, " ")} goal`;
          if (existing.namId !== user.id) {
            storage.createNotification({
              userId: existing.namId,
              type: "goal_updated",
              title: `🎉 ${user.name} hit their goal!`,
              body: goalTitle,
              link: "/goals",
              relatedId: existing.id,
              read: false,
            }).catch(() => {});
          }
          if (existing.amId && existing.amId === user.id) {
            storage.createNotification({
              userId: user.id,
              type: "goal_updated",
              title: "🎉 Goal achieved!",
              body: goalTitle,
              link: "/goals",
              relatedId: existing.id,
              read: false,
            }).catch(() => {});
          }
        }
      }
      cacheInvalidatePrefix(`leaderboard:`);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update goal" });
    }
  });

  app.delete("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      if (user.role !== "admin" && existing.namId !== user.id) return res.status(403).json({ error: "Access denied" });
      await storage.deleteGoal((req.params.id as string));
      cacheInvalidatePrefix(`leaderboard:`);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete goal" });
    }
  });

  app.get("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getGoalComments((req.params.id as string));
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      const canComment = user.role === "admin" || goal.namId === user.id || goal.amId === user.id;
      if (!canComment) return res.status(403).json({ error: "Access denied" });
      const body = (req.body.body || req.body.text || "").trim();
      if (!body) return res.status(400).json({ error: "Comment body is required" });
      const comment = await storage.createGoalComment({
        goalId: (req.params.id as string),
        authorId: user.id,
        body,
        createdAt: new Date().toISOString(),
      });
      // Notify both NAM and AM about the goal comment (skip the commenter)
      const goalNotifyIds = [goal.namId, goal.amId].filter(
        (id): id is string => !!id && id !== user.id
      );
      for (const uid of goalNotifyIds) {
        storage.createNotification({
          userId: uid,
          type: "goal_comment",
          title: `${user.name} commented on a goal`,
          body: goal.title,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ error: "Failed to post comment" });
    }
  });

  app.delete("/api/goal-comments/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comment = await storage.getGoalComment((req.params.id as string));
      if (!comment) return res.status(404).json({ error: "Comment not found" });
      if (user.role !== "admin" && comment.authorId !== user.id) return res.status(403).json({ error: "Access denied" });
      await storage.deleteGoalComment((req.params.id as string));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });

  app.get("/api/goals/:id/progress", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      let autoValue: number | null = null;
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const targetUser = allUsers.find(u => u.id === goal.amId);
      const isLMGoal = targetUser?.role === "logistics_manager" || targetUser?.role === "logistics_coordinator";

      if (goal.metric === "contacts_added") {
        // LMs/LCs don't own companies via assignedTo — skip auto-compute so manual update is available
        if (!isLMGoal) {
          autoValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "touchpoints") {
        if (!isLMGoal) {
          autoValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "meaningful_touchpoints") {
        if (!isLMGoal) {
          autoValue = await storage.getMeaningfulTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
        }
      } else if (goal.metric === "loads_booked" || goal.metric === "margin_pct" || (goal.metric === "margin" && isLMGoal)) {
        // loads_booked / margin_pct / LM margin — LMs use Dispatcher col; AMs use Ops User col
        const repKey = targetUser ? (targetUser as any).financialRepId as string | null : null;
        if (repKey) {
          const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
          if (uploads.length) {
            const latest = uploads[uploads.length - 1];
            const txRows: any[] = (latest.rows as any[]) || [];
            const cols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const { loads, totalMargin, totalCharges } = computeLoadsForRepGoal(txRows, cols, repKey, isLMGoal, goalMonthKey);
            if (goal.metric === "loads_booked") autoValue = loads;
            else if (goal.metric === "margin_pct") autoValue = totalCharges > 0 ? Math.round((totalMargin / totalCharges) * 1000) / 10 : 0;
            else autoValue = Math.round(totalMargin); // margin for LM
          }
        }
      } else if (goal.metric === "margin") {
        if (targetUser) {
          const repKey = (targetUser as any).financialRepId as string | null;
          if (repKey) {
            const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
            if (uploads.length) {
              const latest = uploads[uploads.length - 1];
              const raw = (latest.summaryRows as any[]) || [];
              const repKeyLower = repKey.toLowerCase();
              let total = 0;
              if (isBadSummaryData(raw)) {
                const txRows: any[] = (latest.rows as any[]) || [];
                const progTxCols = resolveColumns(txRows);
                const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
                const byRep: Record<string, Record<string, number>> = {};
                for (const row of txRows) {
                  if (isExcludedRow(row, progTxCols)) continue;
                  const { monthKey, margin } = parseHistoricalRow(row, progTxCols);
                  const rep = getRepFromRow(row, progTxCols);
                  if (!rep) continue;
                  if (!byRep[rep]) byRep[rep] = {};
                  if (monthKey) byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
                }
                const repMonths = byRep[repKeyLower] || {};
                if (goalMonthKey) total = repMonths[goalMonthKey] || 0;
              } else {
                const firstRow = raw[0] || {};
                const usesEmptyKeys = "__EMPTY" in firstRow;
                let rows = raw;
                if (usesEmptyKeys) {
                  rows = raw.filter((r: any) => {
                    const name = String(r["__EMPTY"] || "").trim();
                    return name && name !== "Customer Name" && name !== "TOTAL" && name !== "Customer code";
                  });
                }
                for (const r of rows) {
                  let repName: string, totalMargin: number;
                  if (usesEmptyKeys) {
                    repName = String(r["__EMPTY_6"] || "").trim();
                    totalMargin = Number(r["__EMPTY_3"] ?? 0);
                  } else {
                    repName = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim();
                    totalMargin = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0);
                  }
                  if (repName.toLowerCase() === repKeyLower) total += totalMargin;
                }
              }
              autoValue = Math.round(total);
            }
          }
        }
      }
      res.json({ autoValue, currentValue: parseFloat(goal.currentValue || "0") });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch progress" });
    }
  });

  // Margin trend: last 6 months of actual margin for the rep tied to a goal
  app.get("/api/goals/:id/margin-trend", requireAuth, async (req, res) => {
    try {
      const goal = await storage.getGoal((req.params.id as string));
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const amUser = allUsers.find(u => u.id === goal.amId);
      const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
      if (!repKey) return res.json({ months: [] });
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ months: [] });
      const latest = uploads[uploads.length - 1];
      const txRows: any[] = (latest.rows as any[]) || [];
      const trendCols = resolveColumns(txRows);
      const repKeyLower = repKey.toLowerCase();
      const isLMUser = amUser?.role === "logistics_manager" || amUser?.role === "logistics_coordinator";
      const byMonth: Record<string, number> = {};
      for (const row of txRows) {
        if (isExcludedRow(row, trendCols)) continue;
        const { monthKey, margin } = parseHistoricalRow(row, trendCols);
        if (!monthKey) continue;
        // LMs are in Dispatcher column; AMs/NAMs are in Operations User column
        const rep = isLMUser
          ? getDispatcherFromRow(row, trendCols).toLowerCase()
          : getRepFromRow(row, trendCols);
        if (rep !== repKeyLower) continue;
        byMonth[monthKey] = (byMonth[monthKey] || 0) + margin;
      }
      // Build last 6 months relative to goal startDate
      const anchor = new Date(goal.startDate + "T00:00:00");
      const months = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
        months.push({ key, label, margin: Math.round(byMonth[key] || 0) });
      }
      res.json({ months, repKey });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch margin trend" });
    }
  });

  app.get("/api/contacts/:id/lane-intel", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const contact = await storage.getContact(req.params.id as string);
      if (!contact) return res.status(404).json({ error: "Contact not found" });

      // --- Build geography fingerprint from this contact ---
      const ownedLanes: string[] = contact.lanes || [];
      const ownedRegions: string[] = contact.regions || [];

      // Parse state abbreviations from title (e.g. "Manager, Southeast", "Dir. of Trans - GA/TN")
      const stateAbbrevs = new Set<string>();
      const US_STATES: Record<string, string[]> = {
        "southeast": ["GA", "TN", "NC", "SC", "AL", "MS", "FL"],
        "midwest": ["IL", "IN", "OH", "MI", "WI", "MN", "IA", "MO"],
        "northeast": ["NY", "NJ", "CT", "MA", "PA", "VT", "NH", "ME"],
        "southwest": ["TX", "AZ", "NM", "OK", "AR", "LA"],
        "west": ["CA", "WA", "OR", "NV", "UT", "CO", "ID", "MT", "WY"],
        "great plains": ["KS", "NE", "SD", "ND"],
        "mid-atlantic": ["VA", "MD", "DE", "DC", "WV"],
        "northwest": ["WA", "OR", "ID", "MT"],
      };
      const STATE_ABBREV_LIST = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
      const titleLower = (contact.title || "").toLowerCase();
      for (const [region, states] of Object.entries(US_STATES)) {
        if (titleLower.includes(region)) states.forEach(s => stateAbbrevs.add(s));
      }
      // Extract 2-letter state abbreviations from title
      const titleUpper = (contact.title || "").toUpperCase();
      const abbrevMatches = titleUpper.match(/\b([A-Z]{2})\b/g) || [];
      for (const m of abbrevMatches) {
        if (STATE_ABBREV_LIST.includes(m)) stateAbbrevs.add(m);
      }
      // Also parse from regions array
      for (const r of ownedRegions) {
        const ru = r.toUpperCase().trim();
        if (STATE_ABBREV_LIST.includes(ru)) stateAbbrevs.add(ru);
        for (const [region, states] of Object.entries(US_STATES)) {
          if (r.toLowerCase().includes(region)) states.forEach(s => stateAbbrevs.add(s));
        }
      }

      // If no geographic signal at all, return hasData: false
      const hasGeoSignal = ownedLanes.length > 0 || ownedRegions.length > 0 || stateAbbrevs.size > 0;

      if (!hasGeoSignal) {
        const recentTps = (await storage.getTouchpointsByContact(contact.id))
          .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
        return res.json({
          contact,
          hasData: false,
          ownedLanes: [],
          ownedRegions: [],
          matchedRfpLanes: [],
          relatedLanes: [],
          recentTouchpoints: recentTps,
          openTasks: [],
        });
      }

      // --- Get company RFPs and extract lane rows from fileData ---
      const allRfpsForIntel = await storage.getRfps();
      const companyRfps = allRfpsForIntel.filter(r => r.companyId === contact.companyId);
      type ExtractedLane = { lane: string; origin: string; originState: string; destination: string; destState: string; volume: number; rfpTitle: string; rfpId: string };
      const allExtractedLanes: ExtractedLane[] = [];

      for (const rfp of companyRfps) {
        const fd = rfp.fileData as any;
        if (!fd) continue;
        // Support both single-sheet and multi-sheet stored formats
        const sheetsToCheck: any[] = Array.isArray(fd) ? fd : (fd.sheets ? fd.sheets : [fd]);
        for (const sheet of sheetsToCheck) {
          const hvl: any[] = sheet.highVolumeLanes || sheet.lanes || [];
          for (const row of hvl) {
            const origin = String(row.origin || row.originCity || "").trim();
            const originState = String(row.originState || row.origin_state || "").trim().toUpperCase();
            const destination = String(row.destination || row.destCity || "").trim();
            const destState = String(row.destState || row.dest_state || "").trim().toUpperCase();
            const lane = row.lane || `${origin} → ${destination}`;
            const volume = parseFloat(String(row.volume || row.loads || "0").replace(/[^0-9.]/g, "")) || 0;
            allExtractedLanes.push({ lane, origin, originState, destination, destState, volume, rfpTitle: rfp.title, rfpId: rfp.id });
          }
        }
      }

      // --- Match lanes to this contact's geography ---
      const laneKeySet = new Set(ownedLanes.map(l => l.toLowerCase().trim()));
      const regionKeySet = new Set(ownedRegions.map(r => r.toLowerCase().trim()));

      const matchedRfpLanes: ExtractedLane[] = [];
      const relatedLanes: ExtractedLane[] = [];
      const seenLanes = new Set<string>();

      for (const el of allExtractedLanes) {
        const laneStr = el.lane.toLowerCase();
        const originL = el.origin.toLowerCase();
        const destL = el.destination.toLowerCase();
        const originStateU = el.originState.toUpperCase();
        const destStateU = el.destState.toUpperCase();
        const key = `${originL}|${destL}`;
        if (seenLanes.has(key)) continue;

        // Check explicit lane match
        const laneHit = ownedLanes.some(ol => {
          const olL = ol.toLowerCase();
          return laneStr.includes(olL) || olL.includes(originL) || olL.includes(destL);
        });
        // Check region match
        const regionHit = ownedRegions.some(r => {
          const rL = r.toLowerCase();
          return originL.includes(rL) || destL.includes(rL) || rL.includes(originL) || rL.includes(destL);
        });
        // Check state abbreviation match
        const stateHit = stateAbbrevs.has(originStateU) || stateAbbrevs.has(destStateU);

        if (laneHit || regionHit) {
          matchedRfpLanes.push(el);
          seenLanes.add(key);
        } else if (stateHit) {
          // "Related" — in the right state but not explicitly owned
          relatedLanes.push(el);
          seenLanes.add(key);
        }
      }

      // Sort by volume desc, cap at 10 each
      matchedRfpLanes.sort((a, b) => b.volume - a.volume);
      relatedLanes.sort((a, b) => b.volume - a.volume);

      // Touchpoints and tasks
      const recentTps = (await storage.getTouchpointsByContact(contact.id))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

      const allTasks = await storage.getTasksByCompany(contact.companyId);
      const openTasks = allTasks.filter(t => t.contactId === contact.id && t.status !== "completed");

      res.json({
        contact,
        hasData: true,
        ownedLanes,
        ownedRegions,
        stateHints: Array.from(stateAbbrevs),
        matchedRfpLanes: matchedRfpLanes.slice(0, 10),
        relatedLanes: relatedLanes.slice(0, 8),
        recentTouchpoints: recentTps,
        openTasks,
      });
    } catch (error) {
      console.error("Lane intel error:", error);
      res.status(500).json({ error: "Failed to fetch lane intel" });
    }
  });

  app.get("/api/touchpoints/history", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const [allTps, allCompanies, allUsers] = await Promise.all([
        storage.getTouchpointsByOrg(user.organizationId),
        storage.getCompanies(user.organizationId),
        storage.getUsers(),
      ]);
      const companyIds = allCompanies.map(c => c.id);
      const allContacts = companyIds.length > 0 ? await storage.getContactsByCompanyIds(companyIds) : [];

      const companyMap = new Map(allCompanies.map(c => [c.id, c]));
      const contactMap = new Map(allContacts.map(c => [c.id, c]));
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      // Determine which user IDs are visible to this user based on role
      let allowedUserIds: Set<string> | null = null;
      const role = user.role;
      if (role === "admin" || role === "sales" || role === "sales_director") {
        allowedUserIds = null; // see all
      } else if (role === "director") {
        // see everyone in org (or scope by team — show all for now)
        allowedUserIds = null;
      } else if (role === "national_account_manager") {
        // see their team (AMs under them) + themselves
        const teamUsers = allUsers.filter(u => u.managerId === user.id || u.id === user.id);
        allowedUserIds = new Set(teamUsers.map(u => u.id));
      } else {
        // AM, LM, LC — own only
        allowedUserIds = new Set([user.id]);
      }

      let filtered = allTps;
      if (allowedUserIds !== null) {
        filtered = filtered.filter(tp => allowedUserIds!.has(tp.loggedById));
      }

      const enriched = filtered.map(tp => {
        const company = companyMap.get(tp.companyId);
        const contact = tp.contactId ? contactMap.get(tp.contactId) : undefined;
        const loggedBy = userMap.get(tp.loggedById);
        return {
          id: tp.id,
          date: tp.date,
          type: tp.type,
          notes: tp.notes,
          sentiment: tp.sentiment,
          isMeaningful: tp.isMeaningful,
          createdAt: tp.createdAt,
          contactId: tp.contactId,
          contactName: contact?.name ?? null,
          companyId: tp.companyId,
          companyName: company?.name ?? "Unknown",
          loggedById: tp.loggedById,
          loggedByName: loggedBy?.name ?? "Unknown",
        };
      });

      res.json(enriched);
    } catch (error) {
      console.error("Failed to fetch touchpoint history:", error);
      res.status(500).json({ error: "Failed to fetch touchpoint history" });
    }
  });

  app.get("/api/contacts/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const tps = await storage.getTouchpointsByContact((req.params.id as string));
      res.json(tps);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch touchpoints" });
    }
  });

  app.post("/api/contacts/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const contact = await storage.getContact((req.params.id as string));
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      const now = new Date();
      const notes: string | null = req.body.notes || null;
      const tp = await storage.createTouchpoint({
        contactId: (req.params.id as string),
        companyId: contact.companyId,
        type: req.body.type || "call",
        date: req.body.date || now.toISOString().split("T")[0],
        notes,
        sentiment: req.body.sentiment || null,
        isMeaningful: req.body.isMeaningful === true || req.body.isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      const company = contact.companyId ? await storage.getCompanyInOrg(contact.companyId, user.organizationId) : null;
      const aiInsights = await analyzeTouchpointNote(notes || "", contact.name, company?.name).catch(() => null);
      let autoTask = null;
      if (aiInsights?.hasFollowUp && aiInsights.followUpTitle && aiInsights.followUpDueDays != null) {
        try {
          const due = new Date(now); due.setDate(due.getDate() + aiInsights.followUpDueDays);
          autoTask = await storage.createTask({ title: aiInsights.followUpTitle, notes: `Auto-created from touchpoint note: "${(notes || "").slice(0, 200)}"`, status: "open", dueDate: due.toISOString().split("T")[0], assignedTo: user.id, assignedBy: user.id, companyId: contact.companyId || null, contactId: contact.id, createdAt: now.toISOString() });
        } catch (taskError) {
          console.error("Failed to create auto follow-up task for contact touchpoint:", taskError);
        }
      }
      cacheInvalidatePrefix(`cold-contacts:${user.id}`);
      cacheInvalidatePrefix(`meaningful-overdue:${user.id}`);
      let easterEgg = null;
      if (tp.isMeaningful) {
        const now2 = new Date();
        const monthStart = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}-01`;
        const count = await storage.countMeaningfulThisMonth(user.id, monthStart);
        if (count >= 2) easterEgg = await tryClaimEasterEgg("first_meaningful_2", user.id);
      }
      res.json({ ...tp, aiInsights, autoTask, easterEgg });
    } catch (error) {
      console.error("Failed to create touchpoint:", error);
      res.status(500).json({ error: "Failed to create touchpoint" });
    }
  });

  app.delete("/api/touchpoints/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteTouchpoint((req.params.id as string));
      cacheInvalidatePrefix(`cold-contacts:${user.id}`);
      cacheInvalidatePrefix(`meaningful-overdue:${user.id}`);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete touchpoint" });
    }
  });

  app.get("/api/companies/:id/health-score", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const [company, touchpoints, contacts, allRfps, allAwards, uploads] = await Promise.all([
        storage.getCompanyInOrg((req.params.id as string), user.organizationId),
        storage.getTouchpointsByCompany((req.params.id as string)),
        storage.getContactsByCompany((req.params.id as string)),
        storage.getRfps(),
        storage.getAwards(),
        storage.getFinancialUploadsForOrg(req.session.organizationId!),
      ]);

      if (!company) return res.status(404).json({ error: "Company not found" });

      const now = new Date();
      const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);
      const thirtyDaysStr = thirtyDaysAgo.toISOString().slice(0, 10);

      // Factor 1: Touchpoint recency (30 pts)
      const sortedTps = [...touchpoints].sort((a, b) => b.date.localeCompare(a.date));
      const lastTp = sortedTps[0];
      let recencyScore = 0;
      let recencyLabel = "No touchpoints on record";
      if (lastTp) {
        const daysSince = Math.floor((now.getTime() - new Date(lastTp.date + "T12:00:00").getTime()) / 86400000);
        if (daysSince <= 7)       { recencyScore = 30; recencyLabel = `Last touch ${daysSince === 0 ? "today" : `${daysSince}d ago`}`; }
        else if (daysSince <= 14) { recencyScore = 22; recencyLabel = `Last touch ${daysSince}d ago`; }
        else if (daysSince <= 30) { recencyScore = 15; recencyLabel = `Last touch ${daysSince}d ago`; }
        else if (daysSince <= 60) { recencyScore = 7;  recencyLabel = `Last touch ${daysSince}d ago`; }
        else                      { recencyScore = 0;  recencyLabel = `Last touch ${daysSince}d ago — needs attention`; }
      }

      // Factor 2: Touchpoint frequency last 30 days (25 pts)
      const recentCount = touchpoints.filter(t => t.date >= thirtyDaysStr).length;
      let freqScore = 0;
      let freqLabel = "";
      if (recentCount >= 5)      { freqScore = 25; freqLabel = `${recentCount} touches in last 30 days`; }
      else if (recentCount >= 3) { freqScore = 18; freqLabel = `${recentCount} touches in last 30 days`; }
      else if (recentCount >= 2) { freqScore = 12; freqLabel = `${recentCount} touches in last 30 days`; }
      else if (recentCount === 1){ freqScore = 7;  freqLabel = `1 touch in last 30 days`; }
      else                       { freqScore = 0;  freqLabel = "No touches in last 30 days"; }

      // Factor 3: Contact depth (20 pts)
      const contactCount = contacts.length;
      let contactScore = 0;
      const contactLabel = `${contactCount} contact${contactCount !== 1 ? "s" : ""} in account`;
      if (contactCount >= 4)      contactScore = 20;
      else if (contactCount === 3) contactScore = 15;
      else if (contactCount === 2) contactScore = 10;
      else if (contactCount === 1) contactScore = 5;

      // Factor 4: Active RFP or Award (15 pts)
      const companyRfps = allRfps.filter(r => r.companyId === (req.params.id as string));
      const companyAwards = allAwards.filter(a => a.companyId === (req.params.id as string));
      const activeRfp = companyRfps.find(r => r.status === "open" || r.status === "pending");
      const hasAward = companyAwards.length > 0;
      const rfpScore = activeRfp ? 10 : 0;
      const awardScore = hasAward ? 5 : 0;
      const rfpLabel = activeRfp ? `Active RFP: ${activeRfp.title}` : hasAward ? "Award on file (no active RFP)" : "No active RFP or award";

      // Factor 5: Financial data presence (10 pts)
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const crmNorm = normalize(company.name);
      const aliasNorms = company.financialAlias
        ? company.financialAlias.split(',').map((a: string) => normalize(a.trim())).filter(Boolean)
        : [];
      let hasFinancialData = false;
      let totalLoadsYtd = 0;
      for (const upload of uploads) {
        const rows = (upload.rows as any[]) || [];
        for (const row of rows) {
          const custName = normalize(String(row.customerName || ""));
          if (custName === crmNorm || aliasNorms.some((a: string) => custName === a)) {
            totalLoadsYtd += Number(row.totalLoads || 0);
            hasFinancialData = true;
          }
        }
      }
      const finScore = hasFinancialData ? 10 : 0;
      const finLabel = hasFinancialData ? `${totalLoadsYtd} YTD loads on record` : "No financial data matched";

      const total = recencyScore + freqScore + contactScore + rfpScore + awardScore + finScore;
      let grade: string;
      let color: string;
      if (total >= 80)      { grade = "Excellent"; color = "green"; }
      else if (total >= 60) { grade = "Good";      color = "blue"; }
      else if (total >= 40) { grade = "Fair";      color = "amber"; }
      else                  { grade = "At Risk";   color = "red"; }

      // Momentum: compare touches last 30 days vs 31-60 days ago
      const sixtyDaysAgo = new Date(now); sixtyDaysAgo.setDate(now.getDate() - 60);
      const sixtyDaysStr = sixtyDaysAgo.toISOString().slice(0, 10);
      const prevPeriodCount = touchpoints.filter(t => t.date >= sixtyDaysStr && t.date < thirtyDaysStr).length;
      const meaningfulRecent = touchpoints.filter(t => t.date >= thirtyDaysStr && (t as any).isMeaningful).length;

      let momentum: "up" | "flat" | "down";
      let momentumLabel: string;
      if (recentCount === 0 && prevPeriodCount === 0) {
        momentum = "flat"; momentumLabel = "No recent activity";
      } else if (prevPeriodCount === 0) {
        momentum = "up"; momentumLabel = `New engagement — ${recentCount} touch${recentCount !== 1 ? "es" : ""} this period`;
      } else {
        const pctChange = (recentCount - prevPeriodCount) / prevPeriodCount;
        if (pctChange >= 0.25) {
          momentum = "up"; momentumLabel = `Up ${Math.round(pctChange * 100)}% vs prior month (${recentCount} vs ${prevPeriodCount} touches)`;
        } else if (pctChange <= -0.25) {
          momentum = "down"; momentumLabel = `Down ${Math.round(Math.abs(pctChange) * 100)}% vs prior month (${recentCount} vs ${prevPeriodCount} touches)`;
        } else {
          momentum = "flat"; momentumLabel = `Steady — ${recentCount} touches this period`;
        }
      }
      if (meaningfulRecent > 0 && momentum !== "up") {
        momentum = "up"; momentumLabel = `${meaningfulRecent} meaningful conversation${meaningfulRecent !== 1 ? "s" : ""} in last 30 days`;
      }

      res.json({
        score: total,
        grade,
        color,
        momentum,
        momentumLabel,
        factors: [
          { name: "Touchpoint Recency",   score: recencyScore, max: 30, label: recencyLabel },
          { name: "Engagement Frequency", score: freqScore,    max: 25, label: freqLabel },
          { name: "Contact Depth",        score: contactScore, max: 20, label: contactLabel },
          { name: "RFP / Award Activity", score: rfpScore + awardScore, max: 15, label: rfpLabel },
          { name: "Financial Data",       score: finScore,     max: 10, label: finLabel },
        ],
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to compute health score" });
    }
  });

  // Personalized chatbot nudges — alerts + smarter suggestions for the greeting card
  app.get("/api/chatbot/nudges", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const todayStr = now.toISOString().slice(0, 10);

      const [allCompanies, allContacts, allTouchpoints, openRfps, openTasks, activeGoals] = await Promise.all([
        storage.getCompanies(user.organizationId),
        storage.getContacts(),
        storage.getTouchpoints(),
        storage.getRfps(),
        storage.getTasks(),
        storage.getGoals(),
      ]);

      const myCompanies = allCompanies.filter((c: any) => c.assignedTo === user.id);
      const companyIds = myCompanies.map((c: any) => c.id);

      // Find contacts at my companies not touched in 30+ days
      const myContacts = allContacts.filter((c: any) => companyIds.includes(c.companyId));
      const myContactIds = myContacts.map((c: any) => c.id);
      const touchedRecently = new Set(
        allTouchpoints
          .filter((t: any) => myContactIds.includes(t.contactId) && t.date >= thirtyDaysAgo)
          .map((t: any) => t.contactId)
      );
      const coldContactCount = myContacts.filter((c: any) => !touchedRecently.has(c.id)).length;

      // RFPs due within 7 days
      const urgentRfps = openRfps.filter((r: any) =>
        r.status === "open" && r.dueDate && r.dueDate <= sevenDaysFromNow && r.dueDate >= todayStr &&
        companyIds.includes(r.companyId)
      );

      // Goals behind pace (for AMs — check own goals; for NAMs — check team)
      const myGoals = activeGoals.filter((g: any) =>
        g.amId === user.id || g.namId === user.id
      );
      const behindGoals = myGoals.filter((g: any) => {
        const target = parseFloat(g.target || "0");
        const current = parseFloat(g.currentValue || "0");
        const dayOfMonth = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const monthFraction = dayOfMonth / daysInMonth;
        return target > 0 && monthFraction > 0.5 && (current / target) < 0.5;
      });

      // Tasks due today
      const tasksDueToday = openTasks.filter((t: any) =>
        (t.assignedTo === user.id) && t.dueDate && t.dueDate <= todayStr && t.status !== "complete"
      );

      // Build personalized alerts
      const alerts: string[] = [];
      if (behindGoals.length > 0) {
        alerts.push(`⚠️ ${behindGoals.length} goal${behindGoals.length > 1 ? "s are" : " is"} behind pace this month`);
      }
      if (coldContactCount > 0) {
        alerts.push(`📞 ${coldContactCount} contact${coldContactCount > 1 ? "s haven't" : " hasn't"} been touched in 30+ days`);
      }
      if (urgentRfps.length > 0) {
        alerts.push(`📋 ${urgentRfps.length} RFP${urgentRfps.length > 1 ? "s" : ""} due within 7 days`);
      }
      if (tasksDueToday.length > 0) {
        alerts.push(`✅ ${tasksDueToday.length} task${tasksDueToday.length > 1 ? "s" : ""} due today`);
      }

      // Contextual suggestions based on what's happening
      const suggestions: string[] = [];
      if (coldContactCount > 0) suggestions.push("Which contacts haven't been touched in 30+ days?");
      if (urgentRfps.length > 0) suggestions.push("Show me my upcoming RFP deadlines");
      if (behindGoals.length > 0) suggestions.push("Which of my goals are behind this month?");
      if (tasksDueToday.length > 0) suggestions.push("What tasks do I have due today?");

      // Fill with evergreen suggestions
      const evergreen = [
        "What accounts should I prioritize calling today?",
        "Who are my key contacts at my top accounts?",
        "Show me accounts with no touchpoints this month",
        "What's the health status of my top 5 accounts?",
        "Which accounts have open RFPs?",
        "Show me my recent wins this month",
      ];
      for (const s of evergreen) {
        if (suggestions.length >= 6) break;
        if (!suggestions.includes(s)) suggestions.push(s);
      }

      res.json({ alerts, suggestions: suggestions.slice(0, 6) });
    } catch (err) {
      console.error("Nudges error:", err);
      res.json({ alerts: [], suggestions: [] });
    }
  });

  // Health score AI narrative — 2-sentence explanation of the score
  app.post("/api/companies/:id/health-narrative", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { score, grade, factors, momentum, momentumLabel } = req.body as {
        score: number;
        grade: string;
        factors: Array<{ name: string; score: number; max: number; label: string }>;
        momentum: string;
        momentumLabel: string;
      };

      if (!factors?.length) return res.status(400).json({ error: "Factors required" });

      const company = await storage.getCompanyInOrg((req.params.id as string), user.organizationId);
      const companyName = company?.name || "this account";

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const factorSummary = factors.map(f => `${f.name}: ${f.score}/${f.max} — ${f.label}`).join("\n");

      const prompt = `You are a freight brokerage sales coach analyzing the relationship health score for account "${companyName}".

Health Score: ${score}/100 (${grade})
Momentum: ${momentumLabel}

Score Breakdown:
${factorSummary}

Write exactly 2 sentences explaining WHY this score is ${score}/100. Be specific — mention the actual factors driving the score up or down. Be direct and actionable. Do not start with "This account" — vary the opener. No fluff.`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 120,
        temperature: 0.3,
      });

      const narrative = resp.choices[0]?.message?.content?.trim() || "";
      res.json({ narrative });
    } catch (err) {
      console.error("Health narrative error:", err);
      res.status(500).json({ error: "Failed to generate narrative" });
    }
  });

  // AI touchpoint note summarizer for pre-call planner
  app.get("/api/companies/:id/touchpoint-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const [company, allTouchpoints] = await Promise.all([
        storage.getCompanyInOrg((req.params.id as string), user.organizationId),
        storage.getTouchpointsByCompany((req.params.id as string)),
      ]);
      if (!company) return res.status(404).json({ error: "Company not found" });

      // Get last 5 touchpoints that have notes
      const withNotes = [...allTouchpoints]
        .sort((a, b) => b.date.localeCompare(a.date))
        .filter((t: any) => t.notes?.trim())
        .slice(0, 5);

      if (withNotes.length === 0) return res.json({ summary: null });

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const noteList = withNotes.map((t: any) => {
        const dateStr = new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        return `[${dateStr} — ${t.type}] ${t.notes}`;
      }).join("\n\n");

      const prompt = `You are reviewing recent touchpoint notes for sales account "${company.name}". Summarize the key themes, any commitments made, open items, or concerns in 3-5 concise bullet points. Be specific — pull out actual details mentioned. Do not pad or repeat yourself.

Notes:
${noteList}

Respond with bullet points only (no header, no intro sentence).`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 250,
        temperature: 0.2,
      });

      const summary = resp.choices[0]?.message?.content?.trim() || null;
      res.json({ summary, noteCount: withNotes.length });
    } catch (err) {
      console.error("Touchpoint summary error:", err);
      res.status(500).json({ error: "Failed to generate summary" });
    }
  });

  // Lane gap AI talking points — generate a one-liner per unawarded corridor
  app.post("/api/companies/:id/lane-gap-insights", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg((req.params.id as string), user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const { corridors } = req.body as { corridors: Array<{ lane: string; totalVolume: number; originState?: string; destinationState?: string }> };
      if (!corridors?.length) return res.json({ insights: [] });

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const laneList = corridors.slice(0, 5).map((c, i) =>
        `${i + 1}. ${c.lane} — ${c.totalVolume.toLocaleString()} loads/yr${c.originState && c.destinationState ? ` (${c.originState} → ${c.destinationState})` : ""}`
      ).join("\n");

      const prompt = `You are a freight brokerage sales coach. For each of these unawarded shipping lanes for customer "${company.name}", write a single punchy, specific talking point a sales rep can use on a call. Focus on freight density, carrier availability, competitive positioning, or urgency. Keep each to 1-2 sentences max. Be concrete and confident.

Lanes:
${laneList}

Respond with valid JSON only:
{ "insights": [{ "lane": "exact lane name from input", "talkingPoint": "your talking point here" }] }`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.4,
      });

      const raw = resp.choices[0]?.message?.content?.trim() || "";
      const parsed = JSON.parse(raw);
      res.json(parsed);
    } catch (err) {
      console.error("Lane gap insights error:", err);
      res.status(500).json({ error: "Failed to generate lane insights" });
    }
  });

  app.get("/api/config/claims-url", requireAuth, async (req, res) => {
    res.json({ url: process.env.CLAIMS_PORTAL_URL || null });
  });

  app.get("/api/companies/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const tps = await storage.getTouchpointsByCompany((req.params.id as string));
      res.json(tps);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company touchpoints" });
    }
  });

  app.get("/api/companies/:id/touch-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, (req.params.id as string)))) return res.status(403).json({ error: "Access denied" });
      const tps = await storage.getTouchpointsByCompany((req.params.id as string));
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const contactsList = await storage.getContactsByCompany((req.params.id as string));
      const enriched = tps.map(tp => ({
        ...tp,
        loggedByName: allUsers.find(u => u.id === tp.loggedById)?.name || "Unknown",
        contactName: tp.contactId ? contactsList.find(c => c.id === tp.contactId)?.name || null : null,
      }));
      enriched.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      res.json(enriched);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch touch logs" });
    }
  });

  app.get("/api/touchpoints/company-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      const weekStr = weekAgo.toISOString().slice(0, 10);
      const monthStr = monthAgo.toISOString().slice(0, 10);

      const [all, orgCompanies] = await Promise.all([
        storage.getTouchpoints(),
        storage.getCompanies(user.organizationId),
      ]);
      const orgCompanyIds = new Set(orgCompanies.map(c => c.id));
      const summary: Record<string, { week: number; month: number; lastType: string | null; lastDate: string | null; daysSince: number | null }> = {};
      // Track latest tp per company (sorted by date desc)
      const latestByCompany: Record<string, { type: string; date: string }> = {};
      for (const tp of all) {
        if (!orgCompanyIds.has(tp.companyId)) continue;
        if (!summary[tp.companyId]) summary[tp.companyId] = { week: 0, month: 0, lastType: null, lastDate: null, daysSince: null };
        if (tp.date >= monthStr) summary[tp.companyId].month++;
        if (tp.date >= weekStr) summary[tp.companyId].week++;
        if (!latestByCompany[tp.companyId] || tp.date > latestByCompany[tp.companyId].date) {
          latestByCompany[tp.companyId] = { type: tp.type, date: tp.date };
        }
      }
      for (const [companyId, latest] of Object.entries(latestByCompany)) {
        if (summary[companyId]) {
          summary[companyId].lastType = latest.type;
          summary[companyId].lastDate = latest.date;
          const msAgo = new Date(todayStr).getTime() - new Date(latest.date).getTime();
          summary[companyId].daysSince = Math.floor(msAgo / (1000 * 60 * 60 * 24));
        }
      }
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch touchpoint summary" });
    }
  });

  app.get("/api/touchpoints/today", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const todayStr = new Date().toISOString().slice(0, 10);

      const [allTodayTps, allOrgUsers, allOrgCompanies] = await Promise.all([
        storage.getTouchpointsSince(todayStr),
        storage.getUsers(user.organizationId),
        storage.getCompanies(user.organizationId),
      ]);

      const orgCompanyIds = new Set(allOrgCompanies.map(c => c.id));
      const orgUserIds = new Set(allOrgUsers.map(u => u.id));
      const userMap = new Map(allOrgUsers.map(u => [u.id, u.name || u.username]));
      const companyMap = new Map(allOrgCompanies.map(c => [c.id, c.name]));

      const allOrgTps = allTodayTps.filter(t => t.date === todayStr && t.loggedById && orgUserIds.has(t.loggedById) && orgCompanyIds.has(t.companyId));

      let visibleUserIds: Set<string>;
      if (user.role === "admin" || user.role === "director" || user.role === "sales_director") {
        visibleUserIds = orgUserIds;
      } else if (user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        visibleUserIds = new Set(teamIds);
        visibleUserIds.add(user.id);
      } else {
        visibleUserIds = new Set([user.id]);
      }

      const filteredTps = allOrgTps.filter(t => t.loggedById && visibleUserIds.has(t.loggedById));

      const contactIds = [...new Set(filteredTps.map(t => t.contactId).filter(Boolean))] as string[];
      let contactMap = new Map<string, string>();
      if (contactIds.length > 0) {
        const contactResults = await Promise.all(contactIds.map(id => storage.getContact(id)));
        for (const c of contactResults) {
          if (c) contactMap.set(c.id, c.name);
        }
      }

      filteredTps.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const enriched = filteredTps.map(tp => ({
        ...tp,
        repName: tp.loggedById ? (userMap.get(tp.loggedById) ?? "Unknown") : "Unknown",
        companyName: companyMap.get(tp.companyId) ?? "Unknown Company",
        contactName: tp.contactId ? (contactMap.get(tp.contactId) ?? null) : null,
      }));

      res.json(enriched);
    } catch (error) {
      console.error("Error fetching today's touchpoints:", error);
      res.status(500).json({ error: "Failed to fetch today's touchpoints" });
    }
  });

  app.get("/api/dashboard/cold-contacts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      const cacheKey = `cold-contacts:${user.id}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      let results;
      if (user.role === "admin") {
        results = await storage.getColdContacts(null, days);
      } else if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        results = await storage.getColdContacts(null, days, teamIds);
      } else {
        results = await storage.getColdContacts(user.id, days);
      }
      cacheSet(cacheKey, results);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch cold contacts" });
    }
  });

  app.get("/api/dashboard/meaningful-overdue", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      const cacheKey = `meaningful-overdue:${user.id}:${days}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      let results;
      if (user.role === "admin") {
        results = await storage.getMeaningfulOverdueContacts(null, days);
      } else if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        results = await storage.getMeaningfulOverdueContacts(null, days, teamIds);
      } else {
        results = await storage.getMeaningfulOverdueContacts(user.id, days);
      }
      cacheSet(cacheKey, results);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch meaningful overdue contacts" });
    }
  });

  app.get("/api/dashboard/opportunity-leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { rows: dismissedRows } = await storage.pool.query(
        `SELECT company_id FROM opportunity_dismissals WHERE org_id = $1`,
        [req.session.organizationId!]
      );
      const dismissedIds = new Set(dismissedRows.map((r: any) => r.company_id));

      const companies = (await storage.getCompanies(req.session.organizationId!)).filter(c => !dismissedIds.has(c.id));
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);
      const msCols = resolveColumns(allRows);

      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      type FinSummary = { totalLoads: number; totalMargin: number; totalRevenue: number };
      const byCustomer: Record<string, FinSummary> = {};
      const now = new Date();
      const ytdStart = `${now.getFullYear()}-01-01`;
      for (const row of allRows) {
        if (isExcludedRow(row, msCols)) continue;
        const cust = getCustomerFromRow(row, msCols);
        if (!cust) continue;
        const { monthKey, margin } = parseHistoricalRow(row, msCols);
        if (!monthKey) continue;
        const periodStart = monthKey + "-01";
        if (periodStart < ytdStart) continue;
        const revenue = Number(row[msCols.revenue] || row[msCols.totalCharges] || 0);
        if (revenue === 0) continue;
        const key = normalize(cust);
        if (!byCustomer[key]) byCustomer[key] = { totalLoads: 0, totalMargin: 0, totalRevenue: 0 };
        byCustomer[key].totalLoads++;
        byCustomer[key].totalMargin += margin;
        byCustomer[key].totalRevenue += revenue;
      }

      const allRfps = await storage.getRfps();
      const rfpsByCompany: Record<string, typeof allRfps> = {};
      for (const rfp of allRfps) {
        if (!rfpsByCompany[rfp.companyId]) rfpsByCompany[rfp.companyId] = [];
        rfpsByCompany[rfp.companyId].push(rfp);
      }

      const results: { companyId: string; companyName: string; potentialMargin: number; currentLoads: number; rfpVolume: number | null; hasRfp: boolean }[] = [];

      for (const company of companies) {
        const rfps = rfpsByCompany[company.id] || [];
        const rfpVolume = rfps.length > 0
          ? rfps.reduce((sum, r) => sum + (Number((r as any).totalVolume) || 0), 0)
          : 0;
        const hasRfp = rfpVolume > 0;

        const aliasNorms = (company as any).financialAlias
          ? (company as any).financialAlias.split(',').map((a: string) => normalize(a.trim())).filter(Boolean)
          : [normalize(company.name)];
        let fin: FinSummary | undefined;
        for (const aliasNorm of aliasNorms) {
          fin = byCustomer[aliasNorm] ||
            Object.entries(byCustomer).find(([k]) => k.includes(aliasNorm) || aliasNorm.includes(k))?.[1];
          if (fin) break;
        }

        const ytdLoads = fin?.totalLoads || 0;
        const ytdMargin = fin?.totalMargin || 0;
        const avgMarginPerLoad = ytdLoads > 0 ? ytdMargin / ytdLoads : 0;

        let potentialMargin = 0;
        if (hasRfp && ytdLoads > 0 && rfpVolume > ytdLoads) {
          potentialMargin = (rfpVolume - ytdLoads) * avgMarginPerLoad;
        } else if (!hasRfp) {
          const estimatedSpend = parseFloat(String((company as any).estimatedFreightSpend || 0)) || 0;
          if (estimatedSpend > 0 && avgMarginPerLoad > 0) {
            const avgRevPerLoad = ytdLoads > 0 ? (fin?.totalRevenue || 0) / ytdLoads : 0;
            if (avgRevPerLoad > 0) {
              const estimatedLoads = estimatedSpend / avgRevPerLoad;
              potentialMargin = (estimatedLoads - ytdLoads) * avgMarginPerLoad;
            }
          }
        }

        if (potentialMargin > 0) {
          results.push({
            companyId: company.id,
            companyName: company.name,
            potentialMargin,
            currentLoads: ytdLoads,
            rfpVolume: hasRfp ? rfpVolume : null,
            hasRfp,
          });
        }
      }

      results.sort((a, b) => b.potentialMargin - a.potentialMargin);
      res.json(results.slice(0, 5));
    } catch (error) {
      console.error("Error computing opportunity leaderboard:", error);
      res.status(500).json({ error: "Failed to compute opportunity leaderboard" });
    }
  });

  // Churn risk — companies whose load count dropped >20% current vs prior month
  app.get("/api/dashboard/churn-risk", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json([]);

      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);
      const cols = resolveColumns(allRows);
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth(); // 0-indexed
      const mk = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
      const curKey = mk(curYear, curMonth);
      const priorKey = curMonth === 0 ? mk(curYear - 1, 11) : mk(curYear, curMonth - 1);

      type MonthLoads = Record<string, number>;
      const byCustomer: Record<string, MonthLoads> = {};

      for (const row of allRows) {
        if (isExcludedRow(row, cols)) continue;
        const cust = getCustomerFromRow(row, cols);
        if (!cust) continue;
        const { monthKey } = parseHistoricalRow(row, cols);
        if (!monthKey || (monthKey !== curKey && monthKey !== priorKey)) continue;
        const key = normalize(cust);
        if (!byCustomer[key]) byCustomer[key] = {};
        byCustomer[key][monthKey] = (byCustomer[key][monthKey] || 0) + 1;
      }

      const companies = await storage.getCompanies(req.session.organizationId!);

      // Scope by role
      let visibleCompanyIds: Set<string> | null = null;
      if (user.role === "account_manager") {
        const ids = await getVisibleCompanyIds(user);
        visibleCompanyIds = new Set(ids);
      } else if (user.role === "national_account_manager") {
        const ids = await getVisibleCompanyIds(user);
        visibleCompanyIds = new Set(ids);
      }

      const results: { companyId: string; companyName: string; repName: string | null; curLoads: number; priorLoads: number; dropPct: number }[] = [];

      for (const company of companies) {
        if (visibleCompanyIds && !visibleCompanyIds.has(company.id)) continue;
        if ((company as any).archivedAt) continue;

        const aliasNorms = (company as any).financialAlias
          ? (company as any).financialAlias.split(",").map((a: string) => normalize(a.trim())).filter(Boolean)
          : [normalize(company.name)];

        let curLoads = 0, priorLoads = 0;
        for (const alias of aliasNorms) {
          const direct = byCustomer[alias];
          if (direct) {
            curLoads += direct[curKey] || 0;
            priorLoads += direct[priorKey] || 0;
          } else {
            for (const [k, v] of Object.entries(byCustomer)) {
              if (k.includes(alias) || alias.includes(k)) {
                curLoads += v[curKey] || 0;
                priorLoads += v[priorKey] || 0;
                break;
              }
            }
          }
        }

        if (priorLoads < 5) continue; // ignore low-volume accounts — noise
        const dropPct = (priorLoads - curLoads) / priorLoads;
        if (dropPct < 0.20) continue; // only show >20% drops

        let repName: string | null = null;
        const repId = (company as any).salesPersonId || (company as any).assignedTo;
        if (repId) {
          const rep = (await storage.getUsers(req.session.organizationId!)).find(u => u.id === repId);
          repName = rep ? `${rep.firstName} ${rep.lastName}` : null;
        }

        results.push({ companyId: company.id, companyName: company.name, repName, curLoads, priorLoads, dropPct });
      }

      results.sort((a, b) => b.dropPct - a.dropPct);
      res.json(results.slice(0, 8));
    } catch (error) {
      console.error("Churn risk error:", error);
      res.status(500).json({ error: "Failed to compute churn risk" });
    }
  });

  // Weekly touchpoint leaderboard — shows this-week touchpoint counts per rep
  app.get("/api/leaderboard/weekly-touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      const weekStart = monday.toISOString().slice(0, 10);

      const [thisWeekAll, allUsers] = await Promise.all([
        storage.getTouchpointsSince(weekStart),
        storage.getUsers(user.organizationId),
      ]);
      const orgUserIds = new Set(allUsers.map(u => u.id));
      const thisWeek = thisWeekAll.filter(t => t.loggedById && orgUserIds.has(t.loggedById));

      const teamIds: string[] | null = (user.role === "admin" || user.role === "director" || user.role === "sales_director")
        ? null
        : await storage.getTeamMemberIds(user.id, user.organizationId);

      const filtered = teamIds === null ? thisWeek : thisWeek.filter(t => t.loggedById && (teamIds.includes(t.loggedById) || t.loggedById === user.id));

      const byUser: Record<string, { userId: string; name: string; total: number; call: number; email: number; text: number; site_visit: number; meaningful: number }> = {};
      const userMap: Record<string, string> = {};
      for (const u of allUsers) userMap[u.id] = u.name || u.username;

      for (const tp of filtered) {
        if (!tp.loggedById) continue;
        if (!byUser[tp.loggedById]) {
          byUser[tp.loggedById] = { userId: tp.loggedById, name: userMap[tp.loggedById] || "Unknown", total: 0, call: 0, email: 0, text: 0, site_visit: 0, meaningful: 0 };
        }
        byUser[tp.loggedById].total++;
        const t = tp.type as "call" | "email" | "text" | "site_visit";
        if (t in byUser[tp.loggedById]) byUser[tp.loggedById][t]++;
        if ((tp as any).isMeaningful) byUser[tp.loggedById].meaningful++;
      }

      const results = Object.values(byUser).sort((a, b) => b.total - a.total);
      res.json({ weekStart, results });
    } catch (error) {
      console.error("Error computing weekly leaderboard:", error);
      res.status(500).json({ error: "Failed to compute weekly leaderboard" });
    }
  });

  async function canAccessAttachmentEntity(user: { id: string; role: string; managerId: string | null; organizationId: string }, entityType: string, entityId: string): Promise<boolean> {
    try {
      if (entityType === "feed_post") {
        const post = await storage.getFeedPost(entityId);
        if (!post) return false;
        const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
        if (!visibleAuthorIds) return true;
        return visibleAuthorIds.includes(post.authorId);
      }
      if (entityType === "task") {
        const task = await storage.getTask(entityId);
        if (!task) return false;
        if (user.role === "admin") return true;
        if (task.assignedTo === user.id || task.assignedBy === user.id) return true;
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        return teamIds.includes(task.assignedTo) || teamIds.includes(task.assignedBy);
      }
      if (entityType === "touchpoint") {
        const tp = await storage.getTouchpoint(entityId);
        if (!tp) return false;
        if (user.role === "admin") return true;
        if (!tp.contactId) return false;
        const contact = await storage.getContact(tp.contactId);
        if (!contact) return false;
        return canAccessCompany(user as any, contact.companyId);
      }
      if (entityType === "one_on_one_topic") {
        const topic = await storage.getTopic(entityId);
        if (!topic) return false;
        return canAccessSession(user, topic.sessionId as string);
      }
      if (entityType === "scorecard") {
        if (user.role === "admin") return true;
        return canAccessCompany(user as any, entityId);
      }
      if (entityType === "internal_post") {
        return user.role === "admin" || user.role === "director";
      }
      return false;
    } catch {
      return false;
    }
  }

  app.post("/api/attachments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { entityType, entityId, fileName, mimeType, fileData } = req.body;
      const validEntityTypes = ["feed_post", "one_on_one_topic", "touchpoint", "task", "scorecard", "internal_post"];
      if (!validEntityTypes.includes(entityType)) {
        return res.status(400).json({ error: "Invalid entity type" });
      }
      if (!entityId || !fileName || !mimeType || !fileData) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      if (!(await canAccessAttachmentEntity(user, entityType, entityId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const allowedMimeTypes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ];
      if (!allowedMimeTypes.includes(mimeType)) {
        return res.status(400).json({ error: "File type not supported" });
      }
      const maxSize = 10 * 1024 * 1024;
      const dataSize = Buffer.byteLength(fileData, "utf-8");
      if (dataSize > maxSize * 1.37) {
        return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
      }
      const attachment = await storage.createAttachment({
        entityType,
        entityId,
        fileName,
        mimeType,
        fileData,
        createdAt: new Date().toISOString(),
      });
      const { fileData: _, ...meta } = attachment;
      res.status(201).json(meta);
    } catch (error) {
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  });

  app.get("/api/attachments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const entityType = req.query.entityType as string;
      const entityIds = (req.query.entityIds as string || "").split(",").filter(Boolean);
      if (!entityType || entityIds.length === 0) return res.json([]);
      const authorizedIds: string[] = [];
      for (const eid of entityIds) {
        if (await canAccessAttachmentEntity(user, entityType, eid)) {
          authorizedIds.push(eid);
        }
      }
      if (authorizedIds.length === 0) return res.json([]);
      const atts = await storage.getAttachmentsByEntities(entityType, authorizedIds);
      const meta = atts.map(({ fileData, ...rest }) => rest);
      res.json(meta);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch attachments" });
    }
  });

  app.get("/api/attachments/:id/download", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const att = await storage.getAttachment((req.params.id as string));
      if (!att) return res.status(404).json({ error: "Attachment not found" });
      if (!(await canAccessAttachmentEntity(user, att.entityType, att.entityId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const buffer = Buffer.from(att.fileData, "base64");
      res.setHeader("Content-Type", att.mimeType);
      const isImage = att.mimeType.startsWith("image/");
      res.setHeader("Content-Disposition", `${isImage ? "inline" : "attachment"}; filename="${att.fileName}"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).json({ error: "Failed to download attachment" });
    }
  });

  app.delete("/api/attachments/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const att = await storage.getAttachment((req.params.id as string));
      if (!att) return res.status(404).json({ error: "Attachment not found" });
      if (!(await canAccessAttachmentEntity(user, att.entityType, att.entityId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteAttachment((req.params.id as string));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete attachment" });
    }
  });

  app.get("/api/companies/:id/vendor-routed", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows = await storage.getVendorRoutedByCompany((req.params.id as string));
      const keys = rows.map(r => r.rowKey);
      res.json(keys);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch vendor routed data" });
    }
  });

  app.post("/api/companies/:id/vendor-routed/toggle", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, (req.params.id as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { rowKey } = req.body;
      if (!rowKey || typeof rowKey !== "string") {
        return res.status(400).json({ error: "rowKey is required" });
      }
      const result = await storage.toggleVendorRouted((req.params.id as string), rowKey);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle vendor routed" });
    }
  });

  // PTO Passoff routes
  app.get("/api/pto-passoffs", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const isAdminOrDirector = currentUser.role === "admin" || currentUser.role === "director" || currentUser.role === "sales_director";
      const passoffs = isAdminOrDirector
        ? await storage.getPtoPassoffs({ all: true })
        : await storage.getPtoPassoffs({ createdById: currentUser.id, coveringUserId: currentUser.id });
      const allItems = await Promise.all(passoffs.map(p => storage.getPtoPassoffItems(p.id)));
      // Collect all unique companyIds across all items to batch-fetch names
      const allCompanyIds = [...new Set(allItems.flat().map(i => i.companyId).filter(Boolean) as string[])];
      const allCompanies = allCompanyIds.length > 0 ? await storage.getCompaniesByIds(allCompanyIds, req.session.organizationId!) : [];
      const companyNameMap = new Map(allCompanies.map(c => [c.id, c.name]));
      res.json(passoffs.map((p, i) => ({
        ...p,
        items: allItems[i].map(item => ({
          ...item,
          companyName: item.companyId ? (companyNameMap.get(item.companyId) ?? "Unknown Account") : null,
        })),
      })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch PTO passoffs" });
    }
  });

  app.post("/api/pto-passoffs", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { startDate, endDate, coveringUserId, emergencyContact, generalNotes, status } = req.body;
      if (!startDate || !endDate) return res.status(400).json({ error: "Start and end dates are required" });
      const passoff = await storage.createPtoPassoff({
        createdById: currentUser.id,
        coveringUserId: coveringUserId || null,
        startDate,
        endDate,
        emergencyContact: emergencyContact || null,
        generalNotes: generalNotes || null,
        status: status || "draft",
        createdAt: new Date().toISOString(),
      });
      // Notify the covering person if assigned and passoff is active
      if (coveringUserId && coveringUserId !== currentUser.id && (status === "active" || !status || status === "draft")) {
        storage.createNotification({
          userId: coveringUserId,
          type: "pto_covering",
          title: `${currentUser.name} named you as a cover`,
          body: `Covering ${startDate} – ${endDate}`,
          link: "/pto-passoff",
          relatedId: passoff.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.status(201).json({ ...passoff, items: [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to create PTO passoff" });
    }
  });

  app.patch("/api/pto-passoffs/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.updatePtoPassoff((req.params.id as string), req.body);
      // Notify new covering person if coveringUserId changed
      const newCovering = req.body.coveringUserId;
      if (newCovering && newCovering !== passoff.coveringUserId && newCovering !== currentUser.id) {
        storage.createNotification({
          userId: newCovering,
          type: "pto_covering",
          title: `${currentUser.name} named you as a cover`,
          body: `Covering ${passoff.startDate} – ${passoff.endDate}`,
          link: "/pto-passoff",
          relatedId: passoff.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      // Notify covering person when passoff status becomes active
      const activating = req.body.status === "active" && passoff.status !== "active";
      const covering = updated?.coveringUserId || passoff.coveringUserId;
      if (activating && covering && covering !== currentUser.id) {
        storage.createNotification({
          userId: covering,
          type: "pto_covering",
          title: `${currentUser.name}'s PTO passoff is now active`,
          body: `You're covering ${passoff.startDate} – ${passoff.endDate}`,
          link: "/pto-passoff",
          relatedId: passoff.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update PTO passoff" });
    }
  });

  app.delete("/api/pto-passoffs/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deletePtoPassoff((req.params.id as string));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete PTO passoff" });
    }
  });

  app.post("/api/pto-passoffs/:id/items", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      const item = await storage.createPtoPassoffItem({
        passoffId: (req.params.id as string),
        companyId: req.body.companyId || null,
        priority: req.body.priority || "medium",
        spotFreightHandler: req.body.spotFreightHandler || null,
        keyCustomerContact: req.body.keyCustomerContact || null,
        openItems: req.body.openItems || null,
        processNotes: req.body.processNotes || null,
        activeDeals: req.body.activeDeals || null,
        acknowledged: false,
      });
      res.status(201).json(item);
    } catch (error) {
      res.status(500).json({ error: "Failed to add passoff item" });
    }
  });

  app.patch("/api/pto-passoffs/:id/items/:itemId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      const isCovering = passoff.coveringUserId === currentUser.id;
      const isOwner = passoff.createdById === currentUser.id;
      const isAdmin = currentUser.role === "admin";
      if (!isOwner && !isCovering && !isAdmin) return res.status(403).json({ error: "Access denied" });
      // Covering user can update acknowledged + coveringNotes; owner/admin can update all
      const allowedFields = isOwner || isAdmin
        ? req.body
        : { acknowledged: req.body.acknowledged, coveringNotes: req.body.coveringNotes };
      const updated = await storage.updatePtoPassoffItem((req.params.itemId as string), allowedFields);
      // Notify passoff owner when covering person acknowledges an account
      const justAcknowledged = req.body.acknowledged === true && isCovering && !isOwner;
      if (justAcknowledged && passoff.createdById !== currentUser.id) {
        (async () => {
          const items = await storage.getPtoPassoffItems((req.params.id as string));
          const item = items.find(i => i.id === (req.params.itemId as string));
          let body = "Account acknowledged in your passoff";
          if (item?.companyId) {
            const company = await storage.getCompanyInOrg(item.companyId, currentUser.organizationId);
            if (company) body = `Acknowledged: ${company.name}`;
          }
          storage.createNotification({
            userId: passoff.createdById,
            type: "pto_acknowledged",
            title: `${currentUser.name} acknowledged an account`,
            body,
            link: "/pto-passoff",
            relatedId: passoff.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        })();
      }
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update passoff item" });
    }
  });

  app.delete("/api/pto-passoffs/:id/items/:itemId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deletePtoPassoffItem((req.params.itemId as string));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete passoff item" });
    }
  });

  // Open tasks for the PTO rep (visible to covering person)
  app.get("/api/pto-passoffs/:id/open-tasks", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff((req.params.id as string));
      if (!passoff) return res.status(404).json({ error: "Not found" });
      const isCovering = passoff.coveringUserId === currentUser.id;
      const isOwner = passoff.createdById === currentUser.id;
      const isAdmin = currentUser.role === "admin" || currentUser.role === "director";
      if (!isCovering && !isOwner && !isAdmin) return res.status(403).json({ error: "Access denied" });
      const allTasks = await storage.getTasks();
      const openTasks = allTasks.filter(t =>
        t.assignedTo === passoff.createdById && t.status !== "completed"
      );
      res.json(openTasks);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch passoff tasks" });
    }
  });

  // Streak routes
  app.get("/api/users/streak", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const goalSetting = await storage.getSetting("streak_goal");
      const goal = parseInt(goalSetting || "5");

      const since = new Date(); since.setDate(since.getDate() - 60);
      const tps = await storage.getTouchpointsByUser(user.id, since.toISOString().slice(0, 10));

      const byDate: Record<string, number> = {};
      for (const tp of tps) {
        byDate[tp.date] = (byDate[tp.date] || 0) + 1;
      }

      const today = new Date().toISOString().slice(0, 10);
      const todayCount = byDate[today] || 0;

      let streak = 0;
      const cur = new Date();
      for (let i = 0; i < 60; i++) {
        const d = cur.toISOString().slice(0, 10);
        const count = byDate[d] || 0;
        if (i === 0 && count < goal) { cur.setDate(cur.getDate() - 1); continue; }
        if (count >= goal) { streak++; cur.setDate(cur.getDate() - 1); }
        else break;
      }

      res.json({ streak, goal, todayCount });
    } catch (err) {
      res.status(500).json({ error: "Failed to compute streak" });
    }
  });

  app.get("/api/settings/streak-goal", requireAuth, async (req, res) => {
    try {
      const val = await storage.getSetting("streak_goal");
      res.json({ goal: parseInt(val || "5") });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch streak goal" });
    }
  });

  app.put("/api/settings/streak-goal", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager"].includes(user.role)) return res.status(403).json({ error: "Not authorized" });
      const { goal } = req.body;
      if (!goal || goal < 1 || goal > 50) return res.status(400).json({ error: "Goal must be between 1 and 50" });
      await storage.setSetting("streak_goal", String(goal));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update streak goal" });
    }
  });

  // ZoomInfo field mapping settings (org-scoped)
  app.get("/api/settings/zoominfo-mapping", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const val = await storage.getSetting(`zoominfo_field_mapping_${user.organizationId}`);
      res.json({ mapping: val ? JSON.parse(val) : {} });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch ZoomInfo mapping" });
    }
  });

  app.put("/api/settings/zoominfo-mapping", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Not authorized" });
      const { mapping } = req.body;
      if (!mapping || typeof mapping !== "object") return res.status(400).json({ error: "mapping must be an object" });
      await storage.setSetting(`zoominfo_field_mapping_${user.organizationId}`, JSON.stringify(mapping));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save ZoomInfo mapping" });
    }
  });

  // Saved customer filters
  app.get("/api/users/saved-filters", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const val = await storage.getSetting(`saved_filters_${user.id}`);
      res.json({ filters: val ? JSON.parse(val) : [] });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch saved filters" });
    }
  });

  app.put("/api/users/saved-filters", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { filters } = req.body;
      if (!Array.isArray(filters)) return res.status(400).json({ error: "filters must be an array" });
      await storage.setSetting(`saved_filters_${user.id}`, JSON.stringify(filters.slice(0, 10)));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save filters" });
    }
  });

  // ─── Director/Admin Dashboard Portlet Endpoints ───────────────────────────

  const DIRECTOR_ROLES = ["admin", "director", "sales_director"] as const;
  const NAM_ROLES = ["national_account_manager", "sales"] as const;

  // Helper: normalize string for fuzzy matching
  const normAlias = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Helper: get set of normalized company aliases for a list of companies
  function buildAliasSet(companies: any[]): Set<string> {
    const s = new Set<string>();
    for (const c of companies) {
      s.add(normAlias(c.name));
      if (c.financialAlias) {
        for (const a of c.financialAlias.split(',').map((x: string) => x.trim()).filter(Boolean)) {
          s.add(normAlias(a));
        }
      }
    }
    return s;
  }

  // Check if a company belongs to a given set of user IDs — considers BOTH salesPersonId AND assignedTo
  // so that a company isn't excluded just because salesPersonId points to a different person
  function companyBelongsToAny(c: any, idSet: Set<string>): boolean {
    return (c.salesPersonId && idSet.has(c.salesPersonId)) || (c.assignedTo && idSet.has(c.assignedTo));
  }

  function getNamTeamCompanies(namId: string, allUsers: any[], allCompanies: any[]): any[] {
    const directReportIds = new Set(allUsers.filter((u: any) => u.managerId === namId).map((u: any) => u.id));
    directReportIds.add(namId); // include companies directly assigned to the NAM
    return allCompanies.filter((c: any) => companyBelongsToAny(c, directReportIds));
  }

  // Helper: get companies owned by a specific AM (checks both salesPersonId and assignedTo)
  function getAmCompanies(amId: string, allCompanies: any[]): any[] {
    const idSet = new Set([amId]);
    return allCompanies.filter((c: any) => companyBelongsToAny(c, idSet));
  }

  // Helper: get all companies within a director's vertical (director → NAMs → AMs → companies)
  function getDirectorTeamCompanies(directorId: string, allUsers: any[], allCompanies: any[]): any[] {
    // Direct reports of the director (NAMs and any direct AMs)
    const directReportIds = new Set(allUsers.filter((u: any) => u.managerId === directorId).map((u: any) => u.id));
    // Collect all AM-level users under those direct reports (NAMs' direct reports)
    const allScopedRepIds = new Set<string>(directReportIds);
    for (const namId of directReportIds) {
      for (const u of allUsers) {
        if (u.managerId === namId) allScopedRepIds.add(u.id);
      }
    }
    return allCompanies.filter((c: any) => companyBelongsToAny(c, allScopedRepIds));
  }

  // Trending accounts — top 5 up, top 5 down by margin delta vs 3-month average
  // Roles: director/admin (org-wide), NAM (team-scoped), AM (own accounts)
  app.get("/api/dashboard/trending-accounts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      const isAmRole = user.role === "account_manager";
      if (!isDirectorRole && !isNamRole && !isAmRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const upload = await storage.getLatestFinancialUploadForOrg(orgId);
      if (!upload || !upload.rows) return res.json({ up: [], down: [] });

      const rows: any[] = upload.rows as any[];
      const cols = resolveColumns(rows);

      // Compute margin by company alias, grouped by month
      const byCustomerMonth: Record<string, Record<string, number>> = {};
      // Fallback display name for aliases not matched to a CRM company
      // Strips the "ALIAS - " prefix to show a friendlier name
      const aliasFallbackName: Record<string, string> = {};
      const allMonthKeys = new Set<string>();
      for (const row of rows) {
        if (isExcludedRow(row, cols)) continue;
        const cust = getCustomerFromRow(row, cols);
        if (!cust) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (!monthKey) continue;
        allMonthKeys.add(monthKey);
        const key = normAlias(cust);
        if (!byCustomerMonth[key]) byCustomerMonth[key] = {};
        byCustomerMonth[key][monthKey] = (byCustomerMonth[key][monthKey] || 0) + margin;
        // Store friendly display name: strip leading "CODE - " prefix if present
        if (!aliasFallbackName[key]) {
          const dashIdx = cust.indexOf(' - ');
          aliasFallbackName[key] = dashIdx !== -1 ? cust.slice(dashIdx + 3).trim() : cust;
        }
      }

      // Determine current month and the 3 prior months from the data, not calendar month
      const sortedMonthKeys = Array.from(allMonthKeys).sort();
      const curMonthKey = sortedMonthKeys.length > 0 ? sortedMonthKeys[sortedMonthKeys.length - 1] : toMonthKey(new Date());
      const curIdx = sortedMonthKeys.indexOf(curMonthKey);
      // Up to 3 months before the current month (all available in the upload)
      const priorMonthKeys = sortedMonthKeys.slice(Math.max(0, curIdx - 3), curIdx);

      // Compute pace fraction: how far through the current month are we?
      const today = new Date();
      const calendarCurKey = toMonthKey(today);
      let monthFraction = 1.0;
      let isPartialMonth = false;
      if (curMonthKey === calendarCurKey) {
        const [yr, mo] = curMonthKey.split("-").map(Number);
        const daysInMonth = new Date(yr, mo, 0).getDate();
        monthFraction = Math.min(today.getDate() / daysInMonth, 1);
        isPartialMonth = true;
      }
      const [cmYr, cmMo] = curMonthKey.split("-").map(Number);
      const curMonthLabel = new Date(cmYr, cmMo - 1, 1).toLocaleString("en-US", { month: "long" });

      // Build delta list using prorated pace comparison vs 3-month average
      // New customers (no prior month data) are included with avgPrior = 0 and flagged isNew = true
      const deltas: { alias: string; delta: number; curMargin: number; priorMargin: number; isNew: boolean }[] = [];
      for (const [alias, monthMap] of Object.entries(byCustomerMonth)) {
        const cur = monthMap[curMonthKey] ?? null;
        if (cur === null) continue;
        // Average margin across up to 3 prior months (only months where account has data)
        const priorValues = priorMonthKeys.map(m => monthMap[m]).filter((v): v is number => v !== undefined);
        const isNew = priorValues.length === 0;
        const avgPrior = isNew ? 0 : priorValues.reduce((a, b) => a + b, 0) / priorValues.length;
        const paceExpected = avgPrior * monthFraction;
        deltas.push({ alias, delta: cur - paceExpected, curMargin: cur, priorMargin: avgPrior, isNew });
      }

      // Match to company names — optionally scoped
      const allCompanies = await storage.getCompanies(req.session.organizationId!);
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const allUsers = isDirectorOnlyRole || isNamRole || isAmRole || (isDirectorRole && req.query.directorId) ? await storage.getUsers(req.session.organizationId!) : [];

      // Build scoped alias filter for Director (non-admin) / NAM / AM
      // Admins can also filter by a specific director via ?directorId=<userId>
      let scopedAliases: Set<string> | null = null;
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      if (directorIdParam) {
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isDirectorOnlyRole) {
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isNamRole) {
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, allCompanies);
        scopedAliases = buildAliasSet(teamCompanies);
      } else if (isAmRole) {
        const myCompanies = getAmCompanies(user.id, allCompanies);
        scopedAliases = buildAliasSet(myCompanies);
      }

      const resolveCompany = (alias: string): { name: string; companyId?: string } => {
        const norm = normAlias(alias);
        const match = allCompanies.find(c => {
          const cns = c.financialAlias
            ? c.financialAlias.split(',').map((a: string) => normAlias(a.trim())).filter(Boolean)
            : [normAlias(c.name)];
          return cns.some((cn: string) => cn === norm || cn.includes(norm) || norm.includes(cn));
        });
        // Fall back to the friendly display name (alias prefix stripped) if not in CRM
        return { name: match?.name || aliasFallbackName[norm] || alias, companyId: match?.id };
      };

      // Filter deltas by scope if applicable
      const filteredDeltas = scopedAliases
        ? deltas.filter(d => {
            if (scopedAliases!.has(d.alias)) return true;
            // fuzzy: check if any scoped alias contains or is contained by this alias
            for (const sa of scopedAliases!) {
              if (sa.includes(d.alias) || d.alias.includes(sa)) return true;
            }
            return false;
          })
        : deltas;

      filteredDeltas.sort((a, b) => b.delta - a.delta);
      const up = filteredDeltas.filter(d => d.delta > 0).map(d => {
        const { name, companyId } = resolveCompany(d.alias);
        return { name, delta: d.delta, isNew: d.isNew, companyId };
      });
      const down = [...filteredDeltas].sort((a, b) => a.delta - b.delta).filter(d => d.delta < 0).map(d => {
        const { name, companyId } = resolveCompany(d.alias);
        return { name, delta: d.delta, isNew: d.isNew, companyId };
      });

      res.json({ up, down, monthFraction, isPartialMonth, curMonthLabel });
    } catch (err) {
      console.error("Error computing trending accounts:", err);
      res.status(500).json({ error: "Failed to compute trending accounts" });
    }
  });

  // Stale accounts — companies with no touchpoint in 21+ days, scoped to the current rep/NAM
  app.get("/api/dashboard/stale-accounts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const isAmRole = user.role === "account_manager";
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isAmRole && !isNamRole) return res.json({ stale: [] });

      const STALE_DAYS = 21;
      const allCompanies = await storage.getCompanies(req.session.organizationId!);

      let myCompanies: any[];
      if (isAmRole) {
        myCompanies = getAmCompanies(user.id, allCompanies).filter((c: any) => !c.archivedAt);
      } else {
        const allUsers = await storage.getUsers(req.session.organizationId!);
        myCompanies = getNamTeamCompanies(user.id, allUsers, allCompanies).filter((c: any) => !c.archivedAt);
      }

      if (myCompanies.length === 0) return res.json({ stale: [] });

      // Get all touchpoints in the last 90 days — one query, then filter in memory
      const since90 = new Date();
      since90.setDate(since90.getDate() - 90);
      const recentTps = await storage.getTouchpointsSince(since90.toISOString().slice(0, 10));

      // Build map: companyId → latest touchpoint date
      const latestByCompany: Record<string, string> = {};
      for (const tp of recentTps) {
        if (!tp.companyId) continue;
        if (!latestByCompany[tp.companyId] || tp.date > latestByCompany[tp.companyId]) {
          latestByCompany[tp.companyId] = tp.date;
        }
      }

      const today = new Date();
      const stale: { id: string; name: string; daysSince: number }[] = [];
      for (const company of myCompanies) {
        const latestDate = latestByCompany[company.id];
        let daySinceTouch: number;
        if (!latestDate) {
          daySinceTouch = 90;
        } else {
          const d = new Date(latestDate + "T12:00:00");
          daySinceTouch = Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        }
        if (daySinceTouch >= STALE_DAYS) {
          stale.push({ id: company.id, name: company.name, daysSince: daySinceTouch });
        }
      }

      stale.sort((a, b) => b.daysSince - a.daysSince);
      res.json({ stale });
    } catch (err) {
      console.error("Error computing stale accounts:", err);
      res.status(500).json({ error: "Failed to compute stale accounts" });
    }
  });

  // ── Today's 5 — top 5 priority accounts for an AM ────────────────────────
  app.get("/api/dashboard/todays-five", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const thirtyStr = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const [allCompanies, allTouchpoints, allTasks, allRfps] = await Promise.all([
        storage.getCompanies(user.organizationId),
        storage.getTouchpoints(),
        storage.getTasks(),
        storage.getRfps(user.organizationId),
      ]);

      // Scope to companies this user owns (or all visible for NAM/Director)
      const isAM = user.role === "account_manager";
      const myCompanies = isAM
        ? allCompanies.filter(c => !c.archivedAt && c.assignedTo === user.id)
        : allCompanies.filter(c => !c.archivedAt);

      // Build last-touch map
      const lastTouch: Record<string, string> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouch[tp.companyId] || tp.date > lastTouch[tp.companyId]) {
          lastTouch[tp.companyId] = tp.date;
        }
      }

      // Build open-task count per company
      const openTasks: Record<string, number> = {};
      for (const t of allTasks) {
        if (t.companyId && t.status === "open") {
          openTasks[t.companyId] = (openTasks[t.companyId] || 0) + 1;
        }
      }

      // Build open-RFP deadline urgency per company
      const rfpUrgent: Record<string, boolean> = {};
      for (const rfp of allRfps) {
        if (rfp.companyId && rfp.status === "open" && rfp.deadline) {
          const daysLeft = Math.ceil((new Date(rfp.deadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          if (daysLeft <= 14) rfpUrgent[rfp.companyId] = true;
        }
      }

      type PriorityAccount = { id: string; name: string; daysSince: number | null; openTasks: number; hasUrgentRfp: boolean; score: number; reasons: string[] };
      const scored: PriorityAccount[] = myCompanies.map(c => {
        const last = lastTouch[c.id];
        const daysSince = last ? Math.floor((new Date(todayStr).getTime() - new Date(last).getTime()) / (1000 * 60 * 60 * 24)) : null;
        const tasks = openTasks[c.id] || 0;
        const urgentRfp = rfpUrgent[c.id] || false;

        let score = 0;
        const reasons: string[] = [];

        if (daysSince === null) { score += 10; reasons.push("Never touched"); }
        else if (daysSince >= 30) { score += 8; reasons.push(`${daysSince}d since last touch`); }
        else if (daysSince >= 14) { score += 4; reasons.push(`${daysSince}d since last touch`); }
        if (tasks > 0) { score += 3; reasons.push(`${tasks} open task${tasks > 1 ? "s" : ""}`); }
        if (urgentRfp) { score += 5; reasons.push("RFP due soon"); }

        return { id: c.id, name: c.name, daysSince, openTasks: tasks, hasUrgentRfp: urgentRfp, score, reasons };
      });

      const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);
      res.json(top5);
    } catch (err) {
      console.error("Error computing today's five:", err);
      res.status(500).json({ error: "Failed to compute today's five" });
    }
  });

  // ── AM Comparison — side-by-side metrics for NAM/Director ────────────────
  app.get("/api/dashboard/am-comparison", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowed = ["national_account_manager", "director", "admin", "sales", "sales_director"];
      if (!allowed.includes(user.role)) return res.status(403).json({ error: "Access denied" });

      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const allUsers = await storage.getUsers(user.organizationId);
      let amIds: string[];
      if (user.role === "admin" || user.role === "director") {
        const directorIdParam = typeof req.query.directorId === "string" ? req.query.directorId : null;
        if (directorIdParam) {
          // Scope to AMs whose manager (NAM) reports to the selected director
          const directReportIds = new Set(allUsers.filter(u => u.managerId === directorIdParam).map(u => u.id));
          amIds = allUsers.filter(u => u.role === "account_manager" && directReportIds.has(u.managerId!)).map(u => u.id);
        } else {
          amIds = allUsers.filter(u => u.role === "account_manager").map(u => u.id);
        }
      } else {
        amIds = allUsers.filter(u => u.managerId === user.id && u.role === "account_manager").map(u => u.id);
      }
      if (!amIds.length) return res.json([]);

      const [allTouchpoints, allGoals, allCompanies, allTasks] = await Promise.all([
        storage.getTouchpoints(),
        storage.getGoals({ namId: user.role === "admin" || user.role === "director" ? undefined : user.id }),
        storage.getCompanies(user.organizationId),
        storage.getTasks(),
      ]);

      // Last touch per company
      const lastTouchMap: Record<string, string> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouchMap[tp.companyId] || tp.date > lastTouchMap[tp.companyId]) {
          lastTouchMap[tp.companyId] = tp.date;
        }
      }

      const result = amIds.map(amId => {
        const amUser = allUsers.find(u => u.id === amId);
        const touchesWeek = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= weekAgo).length;
        const touchesMonth = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= monthStart).length;
        const myCompanies = allCompanies.filter(c => !c.archivedAt && c.assignedTo === amId);
        const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const coldAccounts = myCompanies.filter(c => !lastTouchMap[c.id] || lastTouchMap[c.id] < thirtyAgo).length;
        const openTasks = allTasks.filter(t => t.assignedTo === amId && t.status === "open").length;
        const currentGoals = allGoals.filter(g => g.amId === amId && g.metric === "touchpoints" && g.startDate <= new Date().toISOString().slice(0, 10) && g.endDate >= new Date().toISOString().slice(0, 10));
        const tpGoal = currentGoals[0];
        const goalTarget = tpGoal?.target ? Number(tpGoal.target) : null;
        const goalPct = goalTarget && goalTarget > 0 ? Math.min(Math.round((touchesMonth / goalTarget) * 100), 100) : null;

        return {
          id: amId,
          name: amUser?.name || amUser?.username || "Unknown",
          touchesWeek,
          touchesMonth,
          coldAccounts,
          openTasks,
          companyCount: myCompanies.length,
          goalPct,
          goalTarget,
        };
      });

      result.sort((a, b) => b.touchesMonth - a.touchesMonth);
      res.json(result);
    } catch (err) {
      console.error("Error computing AM comparison:", err);
      res.status(500).json({ error: "Failed to compute AM comparison" });
    }
  });

  // Team activity metrics — today's touches, meaningful touches, new contacts
  // Directors: org-wide; NAMs: scoped to their team
  app.get("/api/dashboard/team-activity", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const today = new Date().toISOString().slice(0, 10);

      const orgCompanies = await storage.getCompanies(orgId);

      // For Director (non-admin)/NAM: scope to their team's companies
      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedCompanyIds: Set<string>;
      if (isNamRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (directorIdParam) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (isDirectorOnlyRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else {
        scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
      }

      const allTouchpoints = await storage.getTouchpoints();
      const todayTouchpoints = allTouchpoints.filter(t => t.date === today && scopedCompanyIds.has(t.companyId));
      const touches = todayTouchpoints.length;
      const meaningful = todayTouchpoints.filter(t => t.isMeaningful).length;

      const allContacts = await storage.getContacts();
      const newContacts = allContacts.filter(c =>
        c.createdAt &&
        c.createdAt.slice(0, 10) === today &&
        scopedCompanyIds.has(c.companyId)
      ).length;

      res.json({ touches, meaningful, newContacts });
    } catch (err) {
      res.status(500).json({ error: "Failed to load team activity" });
    }
  });

  // Activity detail — enriched records for portlet drill-down
  // type = relationships | touches | meaningful | contacts
  // personal=true scopes to current user's own companies only
  app.get("/api/dashboard/activity-detail", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const type = String(req.query.type || "");
      const personal = req.query.personal === "true";
      const orgId = req.session.organizationId!;
      const today = new Date().toISOString().slice(0, 10);
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const orgCompanies = await storage.getCompanies(orgId);
      const allUsers = await storage.getUsers(orgId);
      const companyMap = new Map(orgCompanies.map(c => [c.id, c]));
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      let scopedCompanyIds: Set<string>;
      if (personal) {
        scopedCompanyIds = new Set(orgCompanies.filter(c => c.assignedTo === user.id).map(c => c.id));
      } else {
        const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
        const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
        const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
        const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
        if (isNamRole) {
          const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (directorIdParam) {
          const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (isDirectorOnlyRole) {
          const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
          scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
        } else if (isDirectorRole) {
          // admin without a directorId filter — see all companies
          scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
        } else {
          scopedCompanyIds = new Set(orgCompanies.filter(c => c.assignedTo === user.id).map(c => c.id));
        }
      }

      if (type === "relationships") {
        const allContacts = await storage.getContacts();
        const result = allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && scopedCompanyIds.has(c.companyId))
          .sort((a, b) => (b.baseAdvancedAt || "").localeCompare(a.baseAdvancedAt || ""))
          .map(c => {
            const company = companyMap.get(c.companyId);
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { contactId: c.id, contactName: c.name, contactTitle: c.title || null, relationshipBase: c.relationshipBase || null, baseAdvancedAt: c.baseAdvancedAt, companyId: c.companyId, companyName: company?.name || "Unknown", repName: rep?.name || null };
          });
        return res.json(result);
      }

      if (type === "touches" || type === "meaningful") {
        const allTouchpoints = await storage.getTouchpoints();
        const allContacts = await storage.getContacts();
        const contactMap = new Map(allContacts.map(c => [c.id, c]));
        let tps = allTouchpoints.filter(t => t.date === today && scopedCompanyIds.has(t.companyId));
        if (type === "meaningful") tps = tps.filter(t => t.isMeaningful);
        const result = tps
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .map(t => {
            const company = companyMap.get(t.companyId);
            const contact = t.contactId ? contactMap.get(t.contactId) : null;
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { id: t.id, type: t.type, isMeaningful: t.isMeaningful || false, notes: t.notes || null, date: t.date, companyId: t.companyId, companyName: company?.name || "Unknown", contactName: contact?.name || null, repName: rep?.name || null };
          });
        return res.json(result);
      }

      if (type === "contacts") {
        const allContacts = await storage.getContacts();
        const result = allContacts
          .filter(c => c.createdAt && c.createdAt.slice(0, 10) === today && scopedCompanyIds.has(c.companyId))
          .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
          .map(c => {
            const company = companyMap.get(c.companyId);
            const rep = company?.assignedTo ? userMap.get(company.assignedTo) : null;
            return { contactId: c.id, contactName: c.name, contactTitle: c.title || null, companyId: c.companyId, companyName: company?.name || "Unknown", repName: rep?.name || null };
          });
        return res.json(result);
      }

      return res.status(400).json({ error: "Invalid type" });
    } catch (err) {
      res.status(500).json({ error: "Failed to load activity detail" });
    }
  });

  // Relationships moved up — accounts with contacts that advanced this month
  // Directors: org-wide; NAMs: their team's accounts
  app.get("/api/dashboard/relationships-moved", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = req.session.organizationId!;
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const orgCompanies = await storage.getCompanies(orgId);

      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedCompanyIds: Set<string>;
      if (isNamRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getNamTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (directorIdParam) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(directorIdParam, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else if (isDirectorOnlyRole) {
        const allUsers = await storage.getUsers(orgId);
        const teamCompanies = getDirectorTeamCompanies(user.id, allUsers, orgCompanies);
        scopedCompanyIds = new Set(teamCompanies.map(c => c.id));
      } else {
        scopedCompanyIds = new Set(orgCompanies.map(c => c.id));
      }

      const allContacts = await storage.getContacts();
      const advancedCompanyIds = new Set(
        allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && scopedCompanyIds.has(c.companyId))
          .map(c => c.companyId)
      );
      const count = advancedCompanyIds.size;

      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: "Failed to load relationships moved" });
    }
  });

  // NAM/AM Margin Metrics — current month margin vs goal for each user by role
  // Directors: org-wide; NAMs: scoped to their direct reports
  app.get("/api/dashboard/margin-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isDirectorRole = (DIRECTOR_ROLES as readonly string[]).includes(user.role);
      const isNamRole = (NAM_ROLES as readonly string[]).includes(user.role);
      if (!isDirectorRole && !isNamRole) {
        return res.status(403).json({ error: "Access denied" });
      }

      const mmDirId = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : "all";
      const mmCacheKey = `margin-metrics:${req.session.organizationId}:${user.id}:${mmDirId}`;
      const mmCached = cacheGet(mmCacheKey);
      if (mmCached) return res.json(mmCached);

      const now = new Date();

      // Get latest financial data — org-scoped to prevent cross-tenant data leakage
      const upload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      const rows: any[] = (upload?.rows as any[]) || [];
      const cols = resolveColumns(rows);
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

      // Derive the latest month from the uploaded data (not calendar month)
      // This ensures correct results even when uploads lag behind the calendar
      const uploadMonthKeys = new Set<string>();
      for (const row of rows) {
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey) uploadMonthKeys.add(monthKey);
      }
      const sortedUploadKeys = Array.from(uploadMonthKeys).sort();
      const curMonthKey = sortedUploadKeys.length > 0
        ? sortedUploadKeys[sortedUploadKeys.length - 1]
        : toMonthKey(now);

      // For goal matching, we still use calendar month range for goal overlap
      const [yr, mo] = curMonthKey.split("-").map(Number);
      const monthStart = `${curMonthKey}-01`;
      const monthEnd = new Date(yr, mo, 0).toISOString().slice(0, 10);

      // Margin by financialRepId / customer — map by user's financialRepId
      const byRepId: Record<string, number> = {};
      for (const row of rows) {
        if (isExcludedRow(row, cols)) continue;
        const { monthKey, margin } = parseHistoricalRow(row, cols);
        if (monthKey !== curMonthKey) continue;
        // Use the rep field in the financial data
        const rep = getRepFromRow(row, cols);
        if (!rep) continue;
        byRepId[rep] = (byRepId[rep] || 0) + margin;
      }

      const allUsers = await storage.getUsers(req.session.organizationId!);
      // Scope goals to org users only — filter after fetching to avoid cross-tenant leakage
      const orgUserIds = new Set(allUsers.map(u => u.id));
      const allGoalsRaw = await storage.getGoals({});
      const allGoals = allGoalsRaw.filter(g =>
        (g.namId && orgUserIds.has(g.namId)) || (g.amId && orgUserIds.has(g.amId))
      );

      const namRoles = ["national_account_manager"];
      const amRoles = ["account_manager"];

      // For NAM role: only show their direct reports as AMs, not all AMs
      // For Director (non-admin) role: only show users within their vertical (direct reports + their direct reports)
      // Admins can filter by a specific director via ?directorId=<userId>
      const isDirectorOnlyRole = isDirectorRole && user.role !== "admin";
      const directorIdParam = isDirectorRole && user.role === "admin" && typeof req.query.directorId === "string" ? req.query.directorId : null;
      let scopedUserIds: Set<string> | null = null;
      if (isNamRole) {
        scopedUserIds = new Set(allUsers.filter(u => u.managerId === user.id).map(u => u.id));
      } else if (directorIdParam) {
        const directReportIds = new Set(allUsers.filter(u => u.managerId === directorIdParam).map(u => u.id));
        scopedUserIds = new Set<string>(directReportIds);
        for (const namId of directReportIds) {
          for (const u of allUsers) {
            if (u.managerId === namId) scopedUserIds.add(u.id);
          }
        }
      } else if (isDirectorOnlyRole) {
        const directReportIds = new Set(allUsers.filter(u => u.managerId === user.id).map(u => u.id));
        scopedUserIds = new Set<string>(directReportIds);
        for (const namId of directReportIds) {
          for (const u of allUsers) {
            if (u.managerId === namId) scopedUserIds.add(u.id);
          }
        }
      }

      const filterByScope = (users: any[]) => scopedUserIds
        ? users.filter(u => scopedUserIds!.has(u.id))
        : users;

      const buildMetrics = (roleFilter: string[]) => {
        return filterByScope(allUsers.filter(u => roleFilter.includes(u.role)))
          .map(u => {
            // Match by financialRepId or by name normalization
            let margin = 0;
            if (u.financialRepId) {
              const repKey = u.financialRepId.toLowerCase().trim();
              margin = byRepId[repKey] || 0;
              if (!margin) {
                const nameNorm = normalize(u.name);
                for (const [k, v] of Object.entries(byRepId)) {
                  if (normalize(k).includes(nameNorm) || nameNorm.includes(normalize(k))) {
                    margin = v;
                    break;
                  }
                }
              }
            } else {
              const nameNorm = normalize(u.name);
              for (const [k, v] of Object.entries(byRepId)) {
                if (normalize(k).includes(nameNorm) || nameNorm.includes(normalize(k))) {
                  margin = v;
                  break;
                }
              }
            }

            const marginGoal = allGoals.find(g =>
              g.metric === "margin" &&
              g.amId === u.id &&
              g.startDate <= monthEnd &&
              g.endDate >= monthStart
            );

            return {
              userId: u.id,
              name: u.name,
              role: u.role,
              margin,
              goal: marginGoal ? { id: marginGoal.id, target: parseFloat(marginGoal.target) } : null,
            };
          });
      };

      const namMetrics = isNamRole ? [] : buildMetrics(namRoles);
      const amMetrics = buildMetrics(amRoles);
      console.log(`[margin-metrics] role=${user.role} nams=${namMetrics.length} ams=${amMetrics.length} scopedUserIds=${scopedUserIds ? scopedUserIds.size : 'null'} byRepIdKeys=${Object.keys(byRepId).length} curMonthKey=${curMonthKey}`);
      const mmResult = { nams: namMetrics, ams: amMetrics };
      cacheSet(`margin-metrics:${req.session.organizationId}:${user.id}`, mmResult, 15 * 60 * 1000);
      res.json(mmResult);
    } catch (err) {
      console.error("Error loading margin metrics:", err);
      res.status(500).json({ error: "Failed to load margin metrics" });
    }
  });

  // Personal metrics — for NAM and AM: their own individual activity stats
  // relationshipsMovedThisMonth: accounts they personally own with contacts that advanced this month
  // meaningfulToday: meaningful touchpoints they personally logged today
  // contactsAddedToday: contacts added today in their personally owned accounts
  // touchesToday: all touchpoints they personally logged today
  app.get("/api/dashboard/personal-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const today = new Date().toISOString().slice(0, 10);
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

      const orgId = req.session.organizationId!;
      const allCompanies = await storage.getCompanies(orgId);
      // Own accounts = companies where salesPersonId === current user
      const myCompanies = allCompanies.filter(c => c.salesPersonId === user.id);
      const myCompanyIds = new Set(myCompanies.map(c => c.id));

      // Relationships moved up this month in my accounts
      const allContacts = await storage.getContacts();
      const advancedCompanyIds = new Set(
        allContacts
          .filter(c => c.baseAdvancedAt && c.baseAdvancedAt >= monthStart && myCompanyIds.has(c.companyId))
          .map(c => c.companyId)
      );
      const relationshipsMovedThisMonth = advancedCompanyIds.size;

      // My own touchpoints today
      const myTouchpointsToday = await storage.getTouchpointsByUser(user.id, today);
      const touchesToday = myTouchpointsToday.length;
      const meaningfulToday = myTouchpointsToday.filter(t => t.isMeaningful).length;

      // New contacts added today in my accounts
      const contactsAddedToday = allContacts.filter(c =>
        c.createdAt &&
        c.createdAt.slice(0, 10) === today &&
        myCompanyIds.has(c.companyId)
      ).length;

      res.json({ relationshipsMovedThisMonth, meaningfulToday, contactsAddedToday, touchesToday });
    } catch (err) {
      res.status(500).json({ error: "Failed to load personal metrics" });
    }
  });

  // LM Carrier metrics — repeat carrier rate for the logged-in LM
  app.get("/api/dashboard/lm-carrier-metrics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "logistics_manager" && user.role !== "logistics_coordinator") {
        return res.status(403).json({ error: "Access denied" });
      }
      const repId = (user as any).financialRepId as string | null;
      if (!repId) return res.json({ totalLoads: 0, uniqueCarriers: 0, repeatCarrierLoads: 0, repeatPct: 0, preferredCarriers: 0, topCarriers: [] });

      const upload = await storage.getLatestFinancialUploadForOrg(req.session.organizationId!);
      const allRows: any[] = (upload?.rows as any[]) || [];
      const cols = resolveColumns(allRows);

      // Determine current month from upload data
      const monthKeys = new Set<string>();
      for (const row of allRows) {
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey) monthKeys.add(monthKey);
      }
      const curMonthKey = monthKeys.size > 0
        ? Array.from(monthKeys).sort().pop()!
        : toMonthKey(new Date());

      // Filter to this LM's dispatched loads in current month
      const repIdLower = repId.toLowerCase().trim();
      const myRows = allRows.filter(row => {
        if (isExcludedRow(row, cols)) return false;
        const { monthKey } = parseHistoricalRow(row, cols);
        if (monthKey !== curMonthKey) return false;
        const disp = getDispatcherFromRow(row, cols).toLowerCase();
        return disp === repIdLower;
      });

      if (myRows.length === 0) {
        return res.json({ totalLoads: 0, uniqueCarriers: 0, repeatCarrierLoads: 0, repeatPct: 0, preferredCarriers: 0, topCarriers: [], curMonthKey });
      }

      // Count uses per carrier
      const carrierUses: Record<string, number> = {};
      for (const row of myRows) {
        const carrier = String(row[cols.carrier] || row["Carrier"] || "").trim();
        if (!carrier) continue;
        carrierUses[carrier] = (carrierUses[carrier] || 0) + 1;
      }

      const totalLoads = myRows.length;
      const uniqueCarriers = Object.keys(carrierUses).length;
      let repeatCarrierLoads = 0;
      let preferredCarriers = 0;
      for (const uses of Object.values(carrierUses)) {
        if (uses >= 2) {
          repeatCarrierLoads += uses;
          preferredCarriers++;
        }
      }
      const repeatPct = totalLoads > 0 ? Math.round((repeatCarrierLoads / totalLoads) * 1000) / 10 : 0;

      // Top 10 carriers by load count
      const topCarriers = Object.entries(carrierUses)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([carrier, loads]) => {
          // Strip the alias prefix (e.g. "JACOINSC - JACOBS TRANS LLC" → "Jacobs Trans LLC")
          const parts = carrier.split(" - ");
          const displayName = parts.length > 1 ? parts.slice(1).join(" - ") : carrier;
          return { carrier: displayName, loads, isRepeat: loads >= 2 };
        });

      res.json({ totalLoads, uniqueCarriers, repeatCarrierLoads, repeatPct, preferredCarriers, topCarriers, curMonthKey });
    } catch (err) {
      console.error("Error loading LM carrier metrics:", err);
      res.status(500).json({ error: "Failed to load carrier metrics" });
    }
  });

  // Daily briefing data
  app.get("/api/dashboard/briefing", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Management roles and LMs don't have individual daily touch targets — skip the banner
      const mgmtRoles = ["director", "national_account_manager", "admin", "sales", "sales_director", "logistics_manager", "logistics_coordinator"];
      if (mgmtRoles.includes(user.role)) {
        return res.json({ skip: true });
      }

      const today = new Date().toISOString().slice(0, 10);
      const currentMonth = today.slice(0, 7);

      const [allTasks, tps, streak, goalsData] = await Promise.all([
        storage.getTasks(),
        storage.getTouchpointsByUser(user.id, today),
        (async () => {
          const goalSetting = await storage.getSetting("streak_goal");
          const goal = parseInt(goalSetting || "5");
          const since = new Date(); since.setDate(since.getDate() - 60);
          const userTps = await storage.getTouchpointsByUser(user.id, since.toISOString().slice(0, 10));
          const byDate: Record<string, number> = {};
          for (const tp of userTps) byDate[tp.date] = (byDate[tp.date] || 0) + 1;
          let s = 0;
          const cur = new Date();
          for (let i = 0; i < 60; i++) {
            const d = cur.toISOString().slice(0, 10);
            const count = byDate[d] || 0;
            if (i === 0 && count < goal) { cur.setDate(cur.getDate() - 1); continue; }
            if (count >= goal) { s++; cur.setDate(cur.getDate() - 1); }
            else break;
          }
          return { streak: s, goal, todayCount: byDate[today] || 0 };
        })(),
        // Fetch and compute current-month goals for this rep
        (async () => {
          const userGoals = await storage.getGoals({ amId: user.id });
          const activeGoals = userGoals.filter(g =>
            g.status === "active" && g.startDate && g.startDate.startsWith(currentMonth)
          );
          const computed = await Promise.all(activeGoals.map(async g => {
            let current = 0;
            if (g.metric === "touchpoints") {
              current = await storage.getTouchpointCountByAm(g.amId, g.startDate, g.endDate);
            } else if (g.metric === "meaningful_touchpoints") {
              current = await storage.getMeaningfulTouchpointCountByAm(g.amId, g.startDate, g.endDate);
            } else if (g.metric === "contacts_added") {
              current = await storage.getContactsAddedByAm(g.amId, g.startDate, g.endDate);
            } else {
              current = Number(g.currentValue) || 0;
            }
            const metricLabels: Record<string, string> = {
              touchpoints: "touches",
              meaningful_touchpoints: "meaningful touches",
              contacts_added: "contacts added",
              tasks_completed: "tasks completed",
            };
            return {
              metric: g.metric,
              label: g.customLabel || metricLabels[g.metric] || g.metric,
              current,
              target: Number(g.target),
            };
          }));
          return computed;
        })(),
      ]);

      const dueTasks = allTasks.filter(t => t.assignedTo === user.id && t.status === "open" && t.dueDate && t.dueDate <= today);
      const todayTouchpoints = tps.length;

      res.json({
        skip: false,
        dueTasks: dueTasks.length,
        todayTouchpoints,
        streak: streak.streak,
        streakGoal: streak.goal,
        streakToday: streak.todayCount,
        goals: goalsData,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load briefing data" });
    }
  });

  // ─── Promotion Criteria ──────────────────────────────────────────────────────

  app.get("/api/promotion/criteria", requireAuth, async (req, res) => {
    try {
      const criteria = await storage.getPromotionCriteria();
      res.json(criteria);
    } catch (err) {
      res.status(500).json({ error: "Failed to load promotion criteria" });
    }
  });

  app.put("/api/promotion/criteria/:fromRole/:toRole", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const { fromRole, toRole } = req.params as Record<string, string>;
      const validRoles = ["logistics_manager", "account_manager", "national_account_manager"];
      if (!validRoles.includes(fromRole) || !validRoles.includes(toRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      const { minLoadCount, minMarginPct, minTouchpoints, minTenureMonths, notes } = req.body;
      const safeNum = (v: any) => (v != null && v !== "" ? Number(v) : null);
      const safeMarginPct = safeNum(minMarginPct);
      const data = {
        minLoadCount: safeNum(minLoadCount),
        minMarginPct: safeMarginPct !== null ? String(safeMarginPct) : null,
        minTouchpoints: safeNum(minTouchpoints),
        minTenureMonths: safeNum(minTenureMonths),
        notes: typeof notes === "string" ? notes : null,
        updatedAt: new Date().toISOString(),
        updatedById: user.id,
      };
      const criteria = await storage.upsertPromotionCriteria(fromRole, toRole, data);
      res.json(criteria);
    } catch (err) {
      res.status(500).json({ error: "Failed to save promotion criteria" });
    }
  });

  app.delete("/api/promotion/criteria/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
      const deleted = await storage.deletePromotionCriteria((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Criteria not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete promotion criteria" });
    }
  });

  // ─── Promotion Nominations ────────────────────────────────────────────────────

  async function getNominationAlertChain(nominatorId: string, organizationId: string): Promise<string[]> {
    const allUsers = await storage.getUsers(organizationId);
    const usersById = Object.fromEntries(allUsers.map(u => [u.id, u]));
    const seen = new Set<string>();
    let current = usersById[nominatorId];
    while (current && current.managerId && usersById[current.managerId]) {
      const managerId = current.managerId;
      if (!seen.has(managerId)) seen.add(managerId);
      current = usersById[managerId];
    }
    allUsers.filter(u => u.role === "admin").forEach(u => seen.add(u.id));
    return Array.from(seen);
  }

  const nominationAllowedRoles = ["national_account_manager", "director", "admin", "sales_director"];

  app.get("/api/promotion/nominations", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!nominationAllowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });
      let nominations = await storage.getPromotionNominations();
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const usersById = Object.fromEntries(allUsers.map(u => [u.id, u]));
      if (user.role === "national_account_manager") {
        const directReportIds = new Set(allUsers.filter(u => u.managerId === user.id).map(u => u.id));
        nominations = nominations.filter(n => directReportIds.has(n.nomineeId) || n.nominatedById === user.id);
      }
      const nomineeIds = [...new Set(nominations.map(n => n.nomineeId))];
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const endDate = now.toISOString().split("T")[0];
      const perfData = nomineeIds.length > 0 ? await storage.getTeamPerformance(nomineeIds, startDate, endDate) : [];
      const perfByUser = Object.fromEntries(perfData.map(p => [p.userId, p]));
      const enriched = nominations.map(n => ({
        ...n,
        nominee: usersById[n.nomineeId] ? { id: usersById[n.nomineeId].id, name: usersById[n.nomineeId].name, role: usersById[n.nomineeId].role } : null,
        nominatedBy: usersById[n.nominatedById] ? { id: usersById[n.nominatedById].id, name: usersById[n.nominatedById].name } : null,
        performance: perfByUser[n.nomineeId] ? {
          companyCount: perfByUser[n.nomineeId].companyCount,
          touchpoints: perfByUser[n.nomineeId].callTouchpoints + perfByUser[n.nomineeId].textTouchpoints + perfByUser[n.nomineeId].emailTouchpoints,
          completedTasks: perfByUser[n.nomineeId].completedTasks,
        } : null,
      }));
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: "Failed to load nominations" });
    }
  });

  app.get("/api/promotion/nominations/nominee/:nomineeId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.id !== (req.params.nomineeId as string) && !nominationAllowedRoles.includes(user.role)) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const nominations = await storage.getNominationsByNominee((req.params.nomineeId as string));
      res.json(nominations);
    } catch (err) {
      res.status(500).json({ error: "Failed to load nominations" });
    }
  });

  app.post("/api/promotion/nominations", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!nominationAllowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized to nominate" });
      const { nomineeId, notes } = req.body;
      if (!nomineeId || typeof nomineeId !== "string") return res.status(400).json({ error: "nomineeId required" });
      if (user.role === "national_account_manager") {
        const nominee = await storage.getUser(nomineeId);
        if (!nominee || nominee.managerId !== user.id) {
          return res.status(403).json({ error: "You can only nominate your direct reports" });
        }
      }
      const existing = await storage.getNominationsByNominee(nomineeId);
      if (existing.some(n => n.status === "active")) {
        return res.status(409).json({ error: "An active nomination already exists for this user" });
      }
      const nomination = await storage.createPromotionNomination({
        nomineeId,
        nominatedById: user.id,
        notes: typeof notes === "string" ? notes : null,
        nominatedAt: new Date().toISOString(),
        status: "active",
      });

      (async () => {
        try {
          const nominee = await storage.getUser(nomineeId);
          const nomineeName = nominee?.name ?? "a team member";
          const nominator = user;
          const alertChain = (await getNominationAlertChain(nominator.id, nominator.organizationId))
            .filter(id => id !== nomineeId);
          const now = new Date().toISOString();
          for (const recipientId of alertChain) {
            await storage.createNotification({
              userId: recipientId,
              type: "promotion_nomination",
              title: `${nominator.name} nominated ${nomineeName} for promotion`,
              body: `Review the nomination and take action in Team Performance.`,
              link: "/team-performance",
              relatedId: nomination.id,
              read: false,
            });
            await storage.createTask({
              title: `Review nomination: ${nomineeName} (nominated by ${nominator.name})`,
              notes: `${nominator.name} has nominated ${nomineeName} for promotion. Please review and take action.`,
              status: "open",
              dueDate: null,
              assignedTo: recipientId,
              assignedBy: nominator.id,
              companyId: null,
              contactId: null,
              createdAt: now,
            });
          }
        } catch (err) {
          console.error("Failed to send nomination alert chain:", err);
        }
      })();

      const easterEgg = await tryClaimEasterEgg("first_nominator", user.id);
      res.json({ ...nomination, easterEgg });
    } catch (err) {
      res.status(500).json({ error: "Failed to create nomination" });
    }
  });

  app.patch("/api/promotion/nominations/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!nominationAllowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });
      const { status, notes } = req.body;
      const allowedFields: Record<string, any> = {};
      if (status && ["active", "approved", "declined"].includes(status)) allowedFields.status = status;
      if (typeof notes === "string") allowedFields.notes = notes;
      if (Object.keys(allowedFields).length === 0) return res.status(400).json({ error: "No valid fields to update" });
      const updated = await storage.updatePromotionNomination((req.params.id as string), allowedFields);
      if (!updated) return res.status(404).json({ error: "Nomination not found" });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: "Failed to update nomination" });
    }
  });

  app.delete("/api/promotion/nominations/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!nominationAllowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });
      const deleted = await storage.deletePromotionNomination((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Nomination not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete nomination" });
    }
  });

  // ── Tool Links (admin-configurable) ────────────────────────────────────────
  app.get("/api/tool-links", requireAuth, async (req, res) => {
    try {
      const links = await storage.getToolLinks();
      res.json(links);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tool links" });
    }
  });

  app.post("/api/tool-links", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      const now = new Date().toISOString();
      const link = await storage.createToolLink({
        title: req.body.title,
        url: req.body.url,
        description: req.body.description || null,
        iconName: req.body.iconName || "Link",
        color: req.body.color || "from-blue-500 to-blue-600",
        sortOrder: req.body.sortOrder ?? 0,
        createdById: user.id,
        createdAt: now,
      });
      res.json(link);
    } catch (error) {
      res.status(500).json({ error: "Failed to create tool link" });
    }
  });

  app.patch("/api/tool-links/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      const link = await storage.updateToolLink((req.params.id as string), req.body);
      if (!link) return res.status(404).json({ error: "Not found" });
      res.json(link);
    } catch (error) {
      res.status(500).json({ error: "Failed to update tool link" });
    }
  });

  app.delete("/api/tool-links/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Forbidden" });
      await storage.deleteToolLink((req.params.id as string));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete tool link" });
    }
  });

  // ── Company-level walk-up touchpoint (no specific contact required) ─────────
  app.post("/api/companies/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg((req.params.id as string), user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const now = new Date();
      const notes: string | null = req.body.notes || null;
      const contactId = req.body.contactId || null;
      const contact = contactId ? await storage.getContact(contactId) : null;
      const tp = await storage.createTouchpoint({
        contactId,
        companyId: (req.params.id as string),
        type: req.body.type || "call",
        date: req.body.date || now.toISOString().split("T")[0],
        notes,
        sentiment: req.body.sentiment || null,
        isMeaningful: req.body.isMeaningful === true || req.body.isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      const aiInsights = await analyzeTouchpointNote(notes || "", contact?.name, company.name).catch(() => null);
      let autoTask = null;
      if (aiInsights?.hasFollowUp && aiInsights.followUpTitle && aiInsights.followUpDueDays != null) {
        try {
          const due = new Date(now); due.setDate(due.getDate() + aiInsights.followUpDueDays);
          autoTask = await storage.createTask({ title: aiInsights.followUpTitle, notes: `Auto-created from touchpoint note: "${(notes || "").slice(0, 200)}"`, status: "open", dueDate: due.toISOString().split("T")[0], assignedTo: user.id, assignedBy: user.id, companyId: req.params.id as string, contactId: contactId || null, createdAt: now.toISOString() });
        } catch (taskError) {
          console.error("Failed to create auto follow-up task for company touchpoint:", taskError);
        }
      }
      let easterEgg = null;
      if (tp.isMeaningful) {
        const now2 = new Date();
        const monthStart = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}-01`;
        const count = await storage.countMeaningfulThisMonth(user.id, monthStart);
        if (count >= 2) easterEgg = await tryClaimEasterEgg("first_meaningful_2", user.id);
      }
      res.json({ ...tp, aiInsights, autoTask, easterEgg });
    } catch (error) {
      console.error("Failed to log touchpoint (company route):", error);
      res.status(500).json({ error: "Failed to log touchpoint" });
    }
  });

  app.post("/api/touch-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { companyId, contactId, type, isMeaningful, sentiment, notes } = req.body;
      if (!companyId) return res.status(400).json({ error: "companyId is required" });
      const validTypes = ["call", "email", "text", "site_visit"];
      const validVibes = ["great", "neutral", "cold"];
      if (type && !validTypes.includes(type)) return res.status(400).json({ error: "Invalid touch type" });
      if (sentiment && !validVibes.includes(sentiment)) return res.status(400).json({ error: "Invalid sentiment" });
      if (!(await canAccessCompany(user, companyId))) return res.status(403).json({ error: "Access denied" });
      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const now = new Date();
      const cleanNotes: string | null = typeof notes === "string" ? notes.slice(0, 2000) || null : null;
      const contact = contactId ? await storage.getContact(contactId) : null;
      const tp = await storage.createTouchpoint({
        contactId: contactId || null,
        companyId,
        type: type || "call",
        date: now.toISOString().split("T")[0],
        notes: cleanNotes,
        sentiment: sentiment || null,
        isMeaningful: isMeaningful === true || isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      const aiInsights = await analyzeTouchpointNote(cleanNotes || "", contact?.name, company.name).catch(() => null);
      let autoTask = null;
      if (aiInsights?.hasFollowUp && aiInsights.followUpTitle && aiInsights.followUpDueDays != null) {
        try {
          const due = new Date(now); due.setDate(due.getDate() + aiInsights.followUpDueDays);
          autoTask = await storage.createTask({ title: aiInsights.followUpTitle, notes: `Auto-created from touchpoint note: "${(cleanNotes || "").slice(0, 200)}"`, status: "open", dueDate: due.toISOString().split("T")[0], assignedTo: user.id, assignedBy: user.id, companyId, contactId: contactId || null, createdAt: now.toISOString() });
        } catch (taskError) {
          console.error("Failed to create auto follow-up task for touch-log:", taskError);
        }
      }
      let easterEgg = null;
      if (tp.isMeaningful) {
        const now2 = new Date();
        const monthStart = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, "0")}-01`;
        const count = await storage.countMeaningfulThisMonth(user.id, monthStart);
        if (count >= 2) easterEgg = await tryClaimEasterEgg("first_meaningful_2", user.id);
      }
      res.json({ ...tp, aiInsights, autoTask, easterEgg });
    } catch (error) {
      console.error("Failed to log touch:", error);
      res.status(500).json({ error: "Failed to log touch" });
    }
  });

  app.post("/api/demo-requests", async (req, res) => {
    try {
      const { insertDemoRequestSchema } = await import("@shared/schema");
      const parsed = insertDemoRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const record = await storage.createDemoRequest(parsed.data);
      res.status(201).json(record);

      const { sendEmail, baseEmailTemplate } = await import("./emailService");
      const d = parsed.data;
      const bodyHtml = `
        <p>A new demo request has been submitted on Freight DNA.</p>
        <div class="item">
          <p class="item-title">${d.firstName} ${d.lastName}</p>
          <p class="item-meta">${d.email}${d.phone ? ` · ${d.phone}` : ""}</p>
        </div>
        <div class="item">
          <p class="item-title">Areas of Interest</p>
          <ul style="margin:4px 0 0 0;padding-left:18px;color:#555;">
            ${d.interest.split(",").map((i: string) => `<li style="margin-bottom:2px;">${i.trim()}</li>`).join("")}
          </ul>
        </div>
        <div class="item">
          <p class="item-title">Preferred Time</p>
          <p class="item-meta">${d.preferredDate} at ${d.preferredTime} CST</p>
        </div>
        <p>Please follow up to confirm the demo time.</p>
      `;
      sendEmail({
        to: "info@freight-dna.com",
        subject: `New Demo Request from ${d.firstName} ${d.lastName}`,
        html: baseEmailTemplate("New Demo Request", bodyHtml),
        text: `New demo request from ${d.firstName} ${d.lastName} (${d.email}). Interests: ${d.interest}. Preferred: ${d.preferredDate} at ${d.preferredTime} CST.`,
      }).catch(() => {});
    } catch (error) {
      console.error("[demo-request] error:", error);
      res.status(500).json({ error: "Failed to save demo request" });
    }
  });

  // LM direct reports for daily check-in purposes (visible to any manager)
  app.get("/api/lm-direct-reports", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const allUsers = await storage.getUsers(user.organizationId);
      const lmDirectReports = allUsers
        .filter(u => u.role === "logistics_manager" && u.managerId === user.id)
        .map(({ password, ...u }) => u);
      res.json(lmDirectReports);
    } catch (error) {
      console.error("[lm-direct-reports] error:", error);
      res.status(500).json({ error: "Failed to fetch LM direct reports" });
    }
  });

  // LM Daily Check-In routes
  app.get("/api/lm-daily-checks/:lmUserId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { lmUserId } = req.params as Record<string, string>;
      const lmUser = await storage.getUser(lmUserId);
      if (!lmUser || lmUser.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "User not found" });
      }

      // LM can see their own checks; managers (anyone in chain above) can also see
      // Admins and directors (who oversee all org LMs) also get read access
      const isSelf = user.id === lmUserId;
      const isAdmin = user.role === "admin";
      const isDirectorRole = user.role === "director" || user.role === "sales_director";
      let isManagerOf = false;
      if (!isSelf && !isAdmin && !isDirectorRole) {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        isManagerOf = teamIds.includes(lmUserId);
      }
      if (!isSelf && !isManagerOf && !isAdmin && !isDirectorRole) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const checks = await storage.getLmDailyChecks(lmUserId);
      // Enrich with checker name
      const allOrgUsers = await storage.getUsers(user.organizationId);
      const userMap = Object.fromEntries(allOrgUsers.map(u => [u.id, u.name]));
      const enriched = checks.map(c => ({ ...c, checkedByName: userMap[c.checkedByUserId] ?? null }));
      res.json(enriched);
    } catch (error) {
      console.error("[lm-daily-checks GET] error:", error);
      res.status(500).json({ error: "Failed to fetch LM daily checks" });
    }
  });

  app.post("/api/lm-daily-checks/:lmUserId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { lmUserId } = req.params as Record<string, string>;
      const lmUser = await storage.getUser(lmUserId);
      if (!lmUser || lmUser.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "User not found" });
      }

      // Only the LM's direct manager or admin can write
      const isDirectManager = lmUser.managerId === user.id;
      const isAdmin = user.role === "admin";
      if (!isDirectManager && !isAdmin) {
        return res.status(403).json({ error: "Only the LM's direct manager can submit daily check-ins" });
      }

      const today = new Date().toISOString().slice(0, 10);
      const { callsBeforeSevenThirty, checkoutCompleted } = req.body as { callsBeforeSevenThirty?: boolean | null; checkoutCompleted?: boolean | null };

      const check = await storage.upsertLmDailyCheck({
        organizationId: user.organizationId,
        lmUserId,
        checkedByUserId: user.id,
        date: today,
        callsBeforeSevenThirty,
        checkoutCompleted,
      });
      res.json(check);
    } catch (error) {
      console.error("[lm-daily-checks POST] error:", error);
      res.status(500).json({ error: "Failed to upsert LM daily check" });
    }
  });

  // ── ZoomInfo Contact Search ───────────────────────────────────────────────
  app.get("/api/zoominfo/search-contacts", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const companyName = req.query.companyName as string;
    if (!companyName?.trim()) return res.status(400).json({ error: "companyName is required" });

    const ziConfigured = !!(
      process.env.ZOOMINFO_USERNAME &&
      process.env.ZOOMINFO_PASSWORD &&
      process.env.ZOOMINFO_CLIENT_ID
    );
    if (!ziConfigured) {
      return res.status(503).json({ error: "ZoomInfo integration not configured. ZOOMINFO_USERNAME, ZOOMINFO_PASSWORD, and ZOOMINFO_CLIENT_ID are required." });
    }

    try {
      const { searchZoomInfoContacts } = await import("./zoominfo.js");
      const contacts = await searchZoomInfoContacts(companyName.trim(), 25);
      res.json({ contacts });
    } catch (error: any) {
      console.error("[zoominfo] search error:", error?.message);
      res.status(502).json({ error: error?.message || "ZoomInfo search failed" });
    }
  });

  app.get("/api/zoominfo/status", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    const configured = !!(
      process.env.ZOOMINFO_USERNAME &&
      process.env.ZOOMINFO_PASSWORD &&
      process.env.ZOOMINFO_CLIENT_ID
    );
    const missing = [];
    if (!process.env.ZOOMINFO_USERNAME) missing.push("ZOOMINFO_USERNAME");
    if (!process.env.ZOOMINFO_PASSWORD) missing.push("ZOOMINFO_PASSWORD");
    if (!process.env.ZOOMINFO_CLIENT_ID) missing.push("ZOOMINFO_CLIENT_ID");
    res.json({ configured, missing });
  });

  // ── Lane Attribution Endpoints ───────────────────────────────────────────
  app.get("/api/contacts/:id/lane-attributions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const attributions = await storage.getLaneAttributionsByContact(req.params.id as string);
      res.json(attributions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/contacts/:id/lane-attributions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const contact = await storage.getContact(req.params.id as string);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      const { originCity, originState, destinationCity, destinationState, source, notes } = req.body;
      const attrib = await storage.createLaneAttribution({
        contactId: req.params.id as string,
        companyId: contact.companyId,
        originCity: originCity?.trim() || null,
        originState: originState?.trim()?.toUpperCase() || null,
        destinationCity: destinationCity?.trim() || null,
        destinationState: destinationState?.trim()?.toUpperCase() || null,
        source: source || "manual",
        notes: notes?.trim() || null,
        createdBy: user.id,
      });
      res.json(attrib);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/contact-lane-attributions/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ok = await storage.deleteLaneAttribution(req.params.id as string);
      if (!ok) return res.status(404).json({ error: "Attribution not found" });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Helper: compute freight metrics for a set of lane attributions against financial rows ─
  function computeFreightMetrics(
    rows: any[],
    cols: any,
    companyNames: string[], // normalized company name + aliases
    attributions: { originCity?: string | null; originState?: string | null; destinationCity?: string | null; destinationState?: string | null }[]
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
    for (const row of rows) {
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;
      const origCity = norm(String(row[cols.shipperCity] || row[cols.origin] || "").split(",")[0]);
      const origState = norm(String(row[cols.shipperState] || row[cols.originState] || ""));
      const destCity = norm(String(row[cols.consigneeCity] || row[cols.destination] || "").split(",")[0]);
      const destState = norm(String(row[cols.consigneeState] || row[cols.destinationState] || ""));
      const matched = attributions.some(a => {
        const origCityOk = !a.originCity || origCity.includes(norm(a.originCity)) || norm(a.originCity).includes(origCity.substring(0, 4));
        const origStateOk = !a.originState || origState === norm(a.originState) || origCity.includes(norm(a.originState));
        const destCityOk = !a.destinationCity || destCity.includes(norm(a.destinationCity)) || norm(a.destinationCity).includes(destCity.substring(0, 4));
        const destStateOk = !a.destinationState || destState === norm(a.destinationState) || destCity.includes(norm(a.destinationState));
        return origCityOk && origStateOk && destCityOk && destStateOk;
      });
      if (!matched) continue;
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const orderTypeRaw = String(row[orderTypeK] || "").toLowerCase();
      const isSpot = orderTypeRaw.includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads };
  }

  // Compute freight from a contact's free-text lanes/regions arrays (coverage tab data)
  function computeFreightFromContactLaneStrings(
    rows: any[],
    cols: any,
    companyNames: string[],
    contactLanes: string[],
    contactRegions: string[]
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;

    // Convert each lane/region string into a structured matcher
    type LaneMatcher = { originCity?: string; originState?: string; destCity?: string; destState?: string };
    const matchers: LaneMatcher[] = [];

    for (const term of [...(contactLanes || []), ...(contactRegions || [])]) {
      const t = term.trim();
      if (!t) continue;
      // Skip purely descriptive text (contains spaces and is not a direction) unless it's a city name
      const dirMatch = t.match(/^(.+?)(?:→|->|\s+to\s+)(.+)$/i);
      if (dirMatch) {
        const from = dirMatch[1].trim();
        const to = dirMatch[2].trim();
        matchers.push({
          originState: from.length <= 3 && /^[a-zA-Z]+$/.test(from) ? from : undefined,
          originCity: from.length > 3 ? from : undefined,
          destState: to.length <= 3 && /^[a-zA-Z]+$/.test(to) ? to : undefined,
          destCity: to.length > 3 ? to : undefined,
        });
        continue;
      }
      // State abbreviation (2-3 chars, letters only)
      if (t.length <= 3 && /^[a-zA-Z]+$/.test(t)) {
        matchers.push({ originState: t });
        continue;
      }
      // City / region name
      matchers.push({ originCity: t });
    }

    if (matchers.length === 0) return { loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };

    for (const row of rows) {
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;

      const origCity = norm(String(row[cols.shipperCity] || row[cols.origin] || "").split(",")[0]);
      const origState = norm(String(row[cols.shipperState] || row[cols.originState] || ""));
      const dstCity = norm(String(row[cols.consigneeCity] || row[cols.destination] || "").split(",")[0]);
      const dstState = norm(String(row[cols.consigneeState] || row[cols.destinationState] || ""));

      const matched = matchers.some(m => {
        const origCityOk = !m.originCity || origCity.includes(norm(m.originCity)) || norm(m.originCity).includes(origCity.substring(0, 4));
        const origStateOk = !m.originState || origState === norm(m.originState);
        const destCityOk = !m.destCity || dstCity.includes(norm(m.destCity)) || norm(m.destCity).includes(dstCity.substring(0, 4));
        const destStateOk = !m.destState || dstState === norm(m.destState);
        return origCityOk && origStateOk && destCityOk && destStateOk;
      });

      if (!matched) continue;
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const isSpot = String(row[orderTypeK] || "").toLowerCase().includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads };
  }

  // All company freight (no lane filtering) — used when contacts have no lane attributions
  function computeCompanyFreightTotal(
    rows: any[],
    cols: any,
    companyNames: string[]
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
    for (const row of rows) {
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const isSpot = String(row[orderTypeK] || "").toLowerCase().includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads };
  }

  // ── Relationship Freight Summary — company-level ─────────────────────────
  app.get("/api/companies/:id/relationship-freight-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg(req.params.id as string, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const [contacts, allAttributions, upload] = await Promise.all([
        storage.getContactsByCompany(company.id),
        storage.getLaneAttributionsByCompany(company.id),
        storage.getLatestFinancialUploadForOrg(user.organizationId),
      ]);

      const companyNames = [company.name, ...(company.financialAlias ? company.financialAlias.split(",").map((a: string) => a.trim()) : [])].filter(Boolean);
      const rawRows: any[] = upload?.rows ?? [];
      const cols = rawRows.length ? resolveColumns(rawRows) : {} as any;

      const BASE_LABELS: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run" };

      function normalizeBase(raw: string | null | undefined): string {
        if (!raw) return "unknown";
        const v = raw.trim().toLowerCase();
        if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
        if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
        if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
        if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
        return "unknown";
      }

      // Include contacts that have explicit lane attributions OR coverage lane strings (lanes/regions fields)
      const contactResults = contacts
        .map(contact => {
          if (!contact.relationshipBase || !contact.relationshipBase.trim()) return null;
          const contactAttribs = allAttributions.filter(a => a.contactId === contact.id);
          const hasAttribs = contactAttribs.length > 0;
          const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
          if (!hasAttribs && !hasLaneStrings) return null;

          let freight = { loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };
          if (rawRows.length > 0) {
            if (hasAttribs) {
              const f1 = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs);
              freight.loads += f1.loads;
              freight.margin += f1.margin;
              freight.contractedLoads += f1.contractedLoads;
              freight.spotLoads += f1.spotLoads;
            }
            if (hasLaneStrings) {
              const f2 = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || []);
              freight.loads += f2.loads;
              freight.margin += f2.margin;
              freight.contractedLoads += f2.contractedLoads;
              freight.spotLoads += f2.spotLoads;
            }
          }

          const base = normalizeBase(contact.relationshipBase);
          const marginPerLoad = freight.loads > 0 ? Math.round((freight.margin / freight.loads) * 100) / 100 : null;
          const contractedPct = freight.loads > 0 ? Math.round(freight.contractedLoads / freight.loads * 1000) / 10 : null;
          const spotPct = freight.loads > 0 ? Math.round(freight.spotLoads / freight.loads * 1000) / 10 : null;
          return {
            contactId: contact.id,
            contactName: contact.name,
            contactTitle: contact.title,
            relationshipBase: base,
            baseLabel: BASE_LABELS[base] || base,
            attributionCount: contactAttribs.length,
            coverageLaneCount: (contact.lanes?.length || 0) + (contact.regions?.length || 0),
            attributions: contactAttribs,
            ...freight,
            marginPerLoad,
            contractedPct,
            spotPct,
          };
        })
        .filter(Boolean);

      res.json({ contacts: contactResults, companyId: company.id });
    } catch (e: any) {
      console.error("[relationship-freight-summary/company]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Relationship Freight Summary — dashboard-level (grouped by base) ─────
  app.get("/api/relationship-freight-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const isAdmin = user.role === "admin";
      const isDirector = ["director", "national_account_manager"].includes(user.role ?? "");

      // Get visible company IDs based on role
      let visibleCompanyIds: string[] = [];
      if (isAdmin) {
        const allCompanies = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = allCompanies.map(c => c.id);
      } else if (isDirector) {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const repIds = [user.id, ...teamIds];
        const allCompanies = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = allCompanies.filter(c => repIds.includes(c.assignedTo ?? "")).map(c => c.id);
      } else {
        // Rep: only their own companies
        const allCompanies = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = allCompanies.filter(c => c.assignedTo === user.id).map(c => c.id);
      }

      if (visibleCompanyIds.length === 0) return res.json({ summary: [], totalContacts: 0, totalLoads: 0, totalMargin: 0 });

      // Load everything in parallel
      const [allCompanies, upload] = await Promise.all([
        storage.getCompaniesByIds(visibleCompanyIds, user.organizationId),
        storage.getLatestFinancialUploadForOrg(user.organizationId),
      ]);

      // Build company → names map
      const companyNameMap: Record<string, string[]> = {};
      for (const c of allCompanies) {
        companyNameMap[c.id] = [c.name, ...(c.financialAlias ? c.financialAlias.split(",").map((a: string) => a.trim()) : [])].filter(Boolean);
      }

      // Load contacts + lane attributions for all visible companies (bulk queries)
      const allContacts = await storage.getContactsByCompanyIds(visibleCompanyIds);
      const allAttributionsList = (await Promise.all(visibleCompanyIds.map(id => storage.getLaneAttributionsByCompany(id)))).flat();

      const rawRows: any[] = upload?.rows ?? [];
      const cols = rawRows.length ? resolveColumns(rawRows) : {} as any;

      const BASE_LABELS: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run", "home": "Home Run" };
      const BASE_ORDER = ["1st", "2nd", "3rd", "hr"];

      // Group by relationship base
      const grouped: Record<string, { contacts: number; loads: number; margin: number; contractedLoads: number; spotLoads: number }> = {};
      for (const base of BASE_ORDER) grouped[base] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };
      grouped["unknown"] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };

      function normBase(raw: string | null | undefined): string {
        if (!raw) return "unknown";
        const v = raw.trim().toLowerCase();
        if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
        if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
        if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
        if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
        return "unknown";
      }

      for (const contact of allContacts) {
        if (!contact.relationshipBase || !contact.relationshipBase.trim()) continue;
        const contactAttribs = allAttributionsList.filter(a => a.contactId === contact.id);
        const hasAttribs = contactAttribs.length > 0;
        const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
        if (!hasAttribs && !hasLaneStrings) continue;

        const base = normBase(contact.relationshipBase);
        grouped[base].contacts++;

        if (rawRows.length > 0) {
          const companyNames = companyNameMap[contact.companyId] ?? [];
          if (hasAttribs) {
            const m = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs);
            grouped[base].loads += m.loads;
            grouped[base].margin += m.margin;
            grouped[base].contractedLoads += m.contractedLoads;
            grouped[base].spotLoads += m.spotLoads;
          }
          if (hasLaneStrings) {
            const m = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || []);
            grouped[base].loads += m.loads;
            grouped[base].margin += m.margin;
            grouped[base].contractedLoads += m.contractedLoads;
            grouped[base].spotLoads += m.spotLoads;
          }
        }
      }

      const summary = [...BASE_ORDER, ...(grouped["unknown"].contacts > 0 ? ["unknown"] : [])].map(base => ({
        base,
        label: BASE_LABELS[base] || "Unassigned",
        ...grouped[base],
        marginPct: grouped[base].loads > 0
          ? Math.round((grouped[base].margin / grouped[base].loads) * 100) / 100
          : null,
        contractedPct: grouped[base].loads > 0
          ? Math.round((grouped[base].contractedLoads / grouped[base].loads) * 1000) / 10
          : null,
        spotPct: grouped[base].loads > 0
          ? Math.round((grouped[base].spotLoads / grouped[base].loads) * 1000) / 10
          : null,
      }));

      const totalLoads = summary.reduce((s, r) => s + r.loads, 0);
      const totalMargin = summary.reduce((s, r) => s + r.margin, 0);
      const totalContacts = summary.reduce((s, r) => s + r.contacts, 0);

      res.json({ summary, totalContacts, totalLoads, totalMargin });
    } catch (e: any) {
      console.error("[relationship-freight-summary]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Relationship Base Distribution — counts companies & contacts per level ──
  app.get("/api/relationship-base-distribution", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const isAdmin = user.role === "admin";
      const isDirector = ["director", "national_account_manager"].includes(user.role ?? "");

      let visibleCompanyIds: string[] = [];
      if (isAdmin) {
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.map(c => c.id);
      } else if (isDirector) {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const repIds = [user.id, ...teamIds];
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.filter(c => repIds.includes(c.assignedTo ?? "")).map(c => c.id);
      } else {
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.filter(c => c.assignedTo === user.id).map(c => c.id);
      }

      if (visibleCompanyIds.length === 0) {
        return res.json({ levels: [], recentAdvances: [], totalCompanies: 0, totalContacts: 0 });
      }

      const [allContacts, visibleCompanies] = await Promise.all([
        storage.getContactsByCompanyIds(visibleCompanyIds),
        storage.getCompaniesByIds(visibleCompanyIds, user.organizationId),
      ]);

      // Build company name map
      const companyNameById: Record<string, string> = {};
      for (const c of visibleCompanies) companyNameById[c.id] = c.name;

      // T002: greenfield companies — have no contacts with any relationship base set
      const companiesWithAttributedContacts = new Set(
        allContacts.filter(c => c.relationshipBase && c.relationshipBase.trim()).map(c => c.companyId)
      );
      const greenfieldCompanyIds = visibleCompanyIds.filter(id => !companiesWithAttributedContacts.has(id));
      const greenfieldCount = greenfieldCompanyIds.length;

      function normB(raw: string | null | undefined): string {
        if (!raw) return "unknown";
        const v = raw.trim().toLowerCase();
        if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
        if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
        if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
        if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
        return "unknown";
      }

      const BASE_ORDER = ["hr", "3rd", "2nd", "1st", "unknown"];
      const BASE_LABELS: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run", "unknown": "Unassigned" };

      // 30-day cutoff for recent advances
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      // Group contacts + build contact list per level
      const companiesPerLevel: Record<string, Set<string>> = {};
      const contactListPerLevel: Record<string, any[]> = {};
      const advancesPerLevel: Record<string, number> = {};
      for (const b of BASE_ORDER) {
        companiesPerLevel[b] = new Set();
        contactListPerLevel[b] = [];
        advancesPerLevel[b] = 0;
      }

      for (const contact of allContacts) {
        const base = normB(contact.relationshipBase);
        companiesPerLevel[base].add(contact.companyId);
        const recentlyAdvanced = !!(contact.baseAdvancedAt && contact.baseAdvancedAt >= cutoffStr);
        if (recentlyAdvanced) advancesPerLevel[base]++;
        contactListPerLevel[base].push({
          contactId: contact.id,
          contactName: contact.name,
          contactTitle: contact.title ?? null,
          companyId: contact.companyId,
          companyName: companyNameById[contact.companyId] ?? "Unknown",
          baseAdvancedAt: contact.baseAdvancedAt ?? null,
          recentlyAdvanced,
        });
      }

      // Sort each level's contact list: recently advanced first, then alpha by company
      for (const b of BASE_ORDER) {
        contactListPerLevel[b].sort((a: any, b: any) => {
          if (a.recentlyAdvanced !== b.recentlyAdvanced) return a.recentlyAdvanced ? -1 : 1;
          return a.companyName.localeCompare(b.companyName);
        });
      }

      const totalCompanies = visibleCompanyIds.length;
      const totalContacts = allContacts.length;

      const levels = BASE_ORDER.map(base => ({
        base,
        label: BASE_LABELS[base],
        companies: companiesPerLevel[base].size,
        contacts: contactListPerLevel[base].length,
        contactList: contactListPerLevel[base],
      })).filter(r => r.contacts > 0);

      const recentAdvances = BASE_ORDER
        .filter(b => advancesPerLevel[b] > 0)
        .map(base => ({ base, label: BASE_LABELS[base], count: advancesPerLevel[base] }));

      res.json({ levels, recentAdvances, totalCompanies, totalContacts, greenfieldCount });
    } catch (e: any) {
      console.error("[relationship-base-distribution]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // T006: Consolidated dashboard relationship summary — replaces 3 separate endpoint calls
  app.get("/api/dashboard-relationship-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const isAdmin = user.role === "admin";
      const isDirector = ["director", "national_account_manager"].includes(user.role ?? "");

      let visibleCompanyIds: string[] = [];
      if (isAdmin) {
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.map(c => c.id);
      } else if (isDirector) {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const repIds = [user.id, ...teamIds];
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.filter(c => repIds.includes(c.assignedTo ?? "")).map(c => c.id);
      } else {
        const all = await storage.getCompanies(user.organizationId);
        visibleCompanyIds = all.filter(c => c.assignedTo === user.id).map(c => c.id);
      }

      if (visibleCompanyIds.length === 0) {
        return res.json({
          distribution: { levels: [], recentAdvances: [], totalCompanies: 0, totalContacts: 0, greenfieldCount: 0 },
          summary: { summary: [], totalContacts: 0, totalLoads: 0, totalMargin: 0 },
        });
      }

      // Single parallel fetch for all data
      const [allContacts, allCompanies, upload] = await Promise.all([
        storage.getContactsByCompanyIds(visibleCompanyIds),
        storage.getCompaniesByIds(visibleCompanyIds, user.organizationId),
        storage.getLatestFinancialUploadForOrg(user.organizationId),
      ]);
      // ----- Distribution section (same logic as /api/relationship-base-distribution) -----
      const companyNameById: Record<string, string> = {};
      for (const c of allCompanies) companyNameById[c.id] = c.name;

      function normBDash(raw: string | null | undefined): string {
        if (!raw) return "unknown";
        const v = raw.trim().toLowerCase();
        if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
        if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
        if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
        if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
        return "unknown";
      }
      const BASE_ORDER_D = ["hr", "3rd", "2nd", "1st", "unknown"];
      const BASE_LABELS_D: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run", "unknown": "Unassigned" };
      const cutoff2 = new Date(); cutoff2.setDate(cutoff2.getDate() - 30);
      const cutoffStr2 = cutoff2.toISOString().slice(0, 10);
      const companiesPerLevel: Record<string, Set<string>> = {};
      const contactListPerLevel: Record<string, any[]> = {};
      const advancesPerLevel: Record<string, number> = {};
      for (const b of BASE_ORDER_D) { companiesPerLevel[b] = new Set(); contactListPerLevel[b] = []; advancesPerLevel[b] = 0; }
      const companiesWithAttributedContacts2 = new Set(allContacts.filter(c => c.relationshipBase && c.relationshipBase.trim()).map(c => c.companyId));
      const greenfieldCount2 = visibleCompanyIds.filter(id => !companiesWithAttributedContacts2.has(id)).length;
      for (const contact of allContacts) {
        const base = normBDash(contact.relationshipBase);
        companiesPerLevel[base].add(contact.companyId);
        const recentlyAdvanced = !!(contact.baseAdvancedAt && contact.baseAdvancedAt >= cutoffStr2);
        if (recentlyAdvanced) advancesPerLevel[base]++;
        contactListPerLevel[base].push({ contactId: contact.id, contactName: contact.name, contactTitle: contact.title ?? null, companyId: contact.companyId, companyName: companyNameById[contact.companyId] ?? "Unknown", baseAdvancedAt: contact.baseAdvancedAt ?? null, recentlyAdvanced });
      }
      for (const b of BASE_ORDER_D) contactListPerLevel[b].sort((a: any, b2: any) => { if (a.recentlyAdvanced !== b2.recentlyAdvanced) return a.recentlyAdvanced ? -1 : 1; return a.companyName.localeCompare(b2.companyName); });
      const distLevels = BASE_ORDER_D.map(base => ({ base, label: BASE_LABELS_D[base], companies: companiesPerLevel[base].size, contacts: contactListPerLevel[base].length, contactList: contactListPerLevel[base] })).filter(r => r.contacts > 0);
      const recentAdvances2 = BASE_ORDER_D.filter(b => advancesPerLevel[b] > 0).map(base => ({ base, label: BASE_LABELS_D[base], count: advancesPerLevel[base] }));

      // ----- Summary section (same logic as /api/relationship-freight-summary) -----
      const companyNameMap: Record<string, string[]> = {};
      for (const c of allCompanies) companyNameMap[c.id] = [c.name, ...(c.financialAlias ? c.financialAlias.split(",").map((a: string) => a.trim()) : [])].filter(Boolean);

      const rawRows: any[] = upload?.rows ?? [];
      const cols = rawRows.length ? resolveColumns(rawRows) : {} as any;
      const BASE_LABELS_S: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run" };
      const BASE_ORDER_S = ["1st", "2nd", "3rd", "hr"];

      function normBaseS(raw: string | null | undefined): string {
        if (!raw) return "unknown";
        const v = raw.trim().toLowerCase();
        if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
        if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
        if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
        if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
        return "unknown";
      }

      const groupedS: Record<string, { contacts: number; loads: number; margin: number; contractedLoads: number; spotLoads: number }> = {};
      for (const base of BASE_ORDER_S) groupedS[base] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };
      groupedS["unknown"] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };

      // Load lane attributions for visible companies
      const allAttributionsListS = (await Promise.all(visibleCompanyIds.map(id => storage.getLaneAttributionsByCompany(id)))).flat();

      for (const contact of allContacts) {
        if (!contact.relationshipBase || !contact.relationshipBase.trim()) continue;
        const contactAttribs = allAttributionsListS.filter(a => a.contactId === contact.id);
        const hasAttribsS = contactAttribs.length > 0;
        const hasLaneStringsS = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
        if (!hasAttribsS && !hasLaneStringsS) continue;

        const base = normBaseS(contact.relationshipBase);
        groupedS[base].contacts++;
        if (rawRows.length > 0) {
          const companyNames = companyNameMap[contact.companyId] ?? [];
          if (hasAttribsS) {
            const m = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs);
            groupedS[base].loads += m.loads;
            groupedS[base].margin += m.margin;
            groupedS[base].contractedLoads += m.contractedLoads;
            groupedS[base].spotLoads += m.spotLoads;
          }
          if (hasLaneStringsS) {
            const m = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || []);
            groupedS[base].loads += m.loads;
            groupedS[base].margin += m.margin;
            groupedS[base].contractedLoads += m.contractedLoads;
            groupedS[base].spotLoads += m.spotLoads;
          }
        }
      }

      const summaryResult = [...BASE_ORDER_S, ...(groupedS["unknown"].contacts > 0 ? ["unknown"] : [])].map(base => ({
        base, label: BASE_LABELS_S[base] ?? base,
        contacts: groupedS[base]?.contacts ?? 0,
        loads: groupedS[base]?.loads ?? 0,
        margin: groupedS[base]?.margin ?? 0,
        contractedLoads: groupedS[base]?.contractedLoads ?? 0,
        spotLoads: groupedS[base]?.spotLoads ?? 0,
      })).filter(r => r.contacts > 0 || r.loads > 0);

      const totalLoads = summaryResult.reduce((s: number, r: any) => s + r.loads, 0);
      const totalMargin = summaryResult.reduce((s: number, r: any) => s + r.margin, 0);
      const totalContacts = summaryResult.reduce((s: number, r: any) => s + r.contacts, 0);

      res.json({
        distribution: {
          levels: distLevels,
          recentAdvances: recentAdvances2,
          totalCompanies: visibleCompanyIds.length,
          totalContacts: allContacts.length,
          greenfieldCount: greenfieldCount2,
        },
        summary: { summary: summaryResult, totalContacts, totalLoads, totalMargin },
      });
    } catch (e: any) {
      console.error("[dashboard-relationship-summary]", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File is too large. Maximum size is 50MB." });
      }
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });

  // ── Sales Prospect Pipeline ──────────────────────────────────────────────────

  const PROSPECT_ROLES = ["admin", "sales", "sales_director"];

  async function requireProspectRole(req: any, res: any, next: any) {
    const user = await getCurrentUser(req);
    if (!user || !PROSPECT_ROLES.includes(user.role)) {
      return res.status(403).json({ error: "Access restricted to sales team" });
    }
    next();
  }

  app.get("/api/prospects", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isSalesDirectorOrAdmin = user.role === "admin" || user.role === "sales_director";
      const ownerId = isSalesDirectorOrAdmin ? undefined : user.id;
      const items = await storage.getProspects(user.organizationId, ownerId);
      const allUsers = await storage.getUsers(user.organizationId);
      const enriched = items.map(p => ({
        ...p,
        ownerName: allUsers.find(u => u.id === p.ownerId)?.name ?? null,
        assignedNamName: allUsers.find(u => u.id === p.assignedNamId)?.name ?? null,
      }));
      res.json(enriched);
    } catch (err) {
      console.error("GET /api/prospects error:", err);
      res.status(500).json({ error: "Failed to fetch prospects" });
    }
  });

  function validateProspectPayload(body: any): string | null {
    if (body.dealProbability != null) {
      const p = Number(body.dealProbability);
      if (!Number.isInteger(p) || p < 0 || p > 100) return "dealProbability must be an integer between 0 and 100";
    }
    if (body.stage === "lost" || body.stage === "disqualified") {
      if (!body.lostReason || typeof body.lostReason !== "string" || body.lostReason.trim() === "") {
        return "lostReason is required when marking a prospect as lost or disqualified";
      }
    }
    return null;
  }

  app.post("/api/prospects", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const validationError = validateProspectPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      const data = { ...req.body, organizationId: user.organizationId, ownerId: req.body.ownerId || user.id };
      const prospect = await storage.createProspect(data);
      res.status(201).json(prospect);
    } catch (err) {
      console.error("POST /api/prospects error:", err);
      res.status(500).json({ error: "Failed to create prospect" });
    }
  });

  // ── Pipeline Analytics (must be before /:id routes) ──────────────────────────
  app.get("/api/prospects/analytics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Access restricted to sales directors and admins" });
      }

      // All prospects for the org
      const allProspects = await storage.getProspects(user.organizationId);

      // Activities in last 30 days across all org prospects
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const prospectIds = allProspects.map(p => p.id);
      const recentActivities = await storage.getOrgProspectActivitiesSince(prospectIds, thirtyDaysAgo);

      // Users for name lookup
      const allUsers = await storage.getUsers(user.organizationId);
      const userMap = new Map(allUsers.map(u => [u.id, u.name]));

      const ACTIVE_STAGES = ["new_lead", "intro_scheduled", "intro_completed", "follow_up", "opportunity_sent", "first_load_won"];
      const CLOSED_STAGES = ["lost", "disqualified"];
      const now = Date.now();

      const parseSpend = (s?: string | null) => {
        if (!s) return 0;
        return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
      };

      // Stage counts
      const stageCounts: Record<string, number> = {};
      const stageWeightedValues: Record<string, number> = {};
      const stageTotalSpends: Record<string, number> = {};
      const stageAgeSums: Record<string, number> = {};
      const stageAgeCounts: Record<string, number> = {};

      allProspects.forEach(p => {
        const s = p.stage;
        stageCounts[s] = (stageCounts[s] || 0) + 1;
        const spend = parseSpend(p.estimatedSpend);
        const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
        const weighted = spend * prob;
        stageTotalSpends[s] = (stageTotalSpends[s] || 0) + spend;
        stageWeightedValues[s] = (stageWeightedValues[s] || 0) + weighted;
        // For stage velocity: use stageChangedAt (stamped only on actual stage transitions)
        // to compute days in current stage. Fall back to createdAt for new prospects that
        // have never moved stages.
        const stageEntry = p.stageChangedAt ?? p.createdAt;
        const stageEntryMs = now - new Date(stageEntry).getTime();
        const stageDays = Math.floor(stageEntryMs / 86400000);
        stageAgeSums[s] = (stageAgeSums[s] || 0) + stageDays;
        stageAgeCounts[s] = (stageAgeCounts[s] || 0) + 1;
      });

      const avgDaysInStage: Record<string, number> = {};
      ACTIVE_STAGES.forEach(s => {
        avgDaysInStage[s] = stageAgeCounts[s] ? Math.round(stageAgeSums[s] / stageAgeCounts[s]) : 0;
      });

      // Lost reason breakdown
      const lostReasonCounts: Record<string, number> = {};
      allProspects.filter(p => CLOSED_STAGES.includes(p.stage)).forEach(p => {
        const r = p.lostReason || "other";
        lostReasonCounts[r] = (lostReasonCounts[r] || 0) + 1;
      });

      // Win rate
      const converted = allProspects.filter(p => p.convertedToCompanyId).length;
      const lost = allProspects.filter(p => CLOSED_STAGES.includes(p.stage)).length;
      const totalClosed = converted + lost;
      const winRate = totalClosed > 0 ? Math.round((converted / totalClosed) * 100) : 0;

      // Total weighted pipeline (active, non-converted only)
      const totalWeighted = allProspects
        .filter(p => ACTIVE_STAGES.includes(p.stage) && !p.convertedToCompanyId)
        .reduce((sum, p) => {
          const spend = parseSpend(p.estimatedSpend);
          const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
          return sum + spend * prob;
        }, 0);

      // Activities by rep (last 30d)
      const activityByRep: Record<string, number> = {};
      recentActivities.forEach(a => {
        activityByRep[a.createdById] = (activityByRep[a.createdById] || 0) + 1;
      });

      // Rep stats
      const repMap: Record<string, {
        name: string; prospectsOwned: number; converted: number; lost: number;
        totalAgeDays: number; ageCount: number;
      }> = {};

      allProspects.forEach(p => {
        if (!repMap[p.ownerId]) {
          repMap[p.ownerId] = { name: userMap.get(p.ownerId) ?? p.ownerId, prospectsOwned: 0, converted: 0, lost: 0, totalAgeDays: 0, ageCount: 0 };
        }
        repMap[p.ownerId].prospectsOwned++;
        if (p.convertedToCompanyId) repMap[p.ownerId].converted++;
        if (CLOSED_STAGES.includes(p.stage)) repMap[p.ownerId].lost++;
        const ageMs = now - new Date(p.createdAt).getTime();
        repMap[p.ownerId].totalAgeDays += Math.floor(ageMs / 86400000);
        repMap[p.ownerId].ageCount++;
      });

      const repStats = Object.entries(repMap).map(([ownerId, data]) => {
        const repTotal = data.converted + data.lost;
        return {
          ownerId,
          ownerName: data.name,
          prospectsOwned: data.prospectsOwned,
          activitiesLast30d: activityByRep[ownerId] || 0,
          avgDealAge: data.ageCount ? Math.round(data.totalAgeDays / data.ageCount) : 0,
          conversionRate: repTotal > 0 ? Math.round((data.converted / repTotal) * 100) : 0,
          converted: data.converted,
        };
      }).sort((a, b) => b.prospectsOwned - a.prospectsOwned);

      res.json({
        stageCounts,
        stageWeightedValues,
        stageTotalSpends,
        avgDaysInStage,
        lostReasonCounts,
        winRate,
        converted,
        totalClosed,
        totalWeighted,
        totalProspects: allProspects.length,
        repStats,
      });
    } catch (err) {
      console.error("GET /api/prospects/analytics error:", err);
      res.status(500).json({ error: "Failed to generate analytics" });
    }
  });

  // ── Prospect Mass Import ─────────────────────────────────────────────────────
  // Allowed text columns that may be passed per-row (no ownerId, no organizationId)
  const IMPORT_ALLOWED_FIELDS = new Set([
    "name", "industry", "estimatedSpend", "website",
    "primaryContactName", "primaryContactTitle", "primaryContactEmail", "primaryContactPhone", "primaryContactLinkedin",
    "currentCarrier", "topLanes", "commodity", "leadSource", "notes", "nextSteps", "painPoints",
    "estLoadsPerWeek", "estimatedAnnualRevenue", "employeeCount",
  ]);

  // ZoomInfo preview endpoint — returns mapped rows with duplicate flags, does NOT create anything
  app.post("/api/prospects/import/preview", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const rows: any[] = req.body.rows;
      if (!Array.isArray(rows)) return res.status(400).json({ error: "rows required" });

      const existingProspects = await storage.getProspects(user.organizationId);
      const existingNames = new Set(existingProspects.map(p => p.name.toLowerCase().trim()));
      const existingWebsites = new Set(
        existingProspects
          .filter(p => p.website)
          .map(p => p.website!.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
      );
      const batchNames = new Set<string>();

      const preview = rows.map((row, i) => {
        const rawName = typeof row.name === "string" ? row.name.trim() : "";
        const nameLower = rawName.toLowerCase();
        const website = typeof row.website === "string"
          ? row.website.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
          : "";
        let duplicateReason: string | null = null;
        if (!rawName) duplicateReason = "Missing company name";
        else if (existingNames.has(nameLower)) duplicateReason = `Already in pipeline (name match)`;
        else if (website && existingWebsites.has(website)) duplicateReason = `Already in pipeline (website match)`;
        else if (batchNames.has(nameLower)) duplicateReason = `Duplicate within file`;

        if (!duplicateReason && rawName) batchNames.add(nameLower);

        return {
          rowIndex: i,
          name: rawName,
          isDuplicate: !!duplicateReason,
          duplicateReason,
          row,
        };
      });

      res.json({ preview });
    } catch (err) {
      console.error("POST /api/prospects/import/preview error:", err);
      res.status(500).json({ error: "Preview failed" });
    }
  });

  app.post("/api/prospects/import", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const rows: any[] = req.body.rows;
      const skipDuplicates: boolean = req.body.skipDuplicates !== false; // default true
      const isZoomInfo: boolean = req.body.isZoomInfo === true;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "rows must be a non-empty array" });
      }

      // Pre-load existing prospect names for duplicate detection
      const existingProspects = await storage.getProspects(user.organizationId);
      const existingNames = new Set(existingProspects.map(p => p.name.toLowerCase().trim()));

      // Track names seen in this batch for in-batch duplicate detection
      const batchNames = new Set<string>();

      let created = 0;
      const errors: { row: number; error: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rawName = typeof row.name === "string" ? row.name.trim() : "";

        if (!rawName) {
          errors.push({ row: i + 1, error: "Company name is required" });
          continue;
        }
        const nameLower = rawName.toLowerCase();
        if (existingNames.has(nameLower)) {
          if (skipDuplicates) {
            errors.push({ row: i + 1, error: `Duplicate: "${rawName}" already exists in your pipeline` });
          }
          continue;
        }
        if (batchNames.has(nameLower)) {
          errors.push({ row: i + 1, error: `Duplicate within file: "${rawName}" appears more than once` });
          continue;
        }
        batchNames.add(nameLower);

        // Whitelist allowed fields — never let caller inject ownerId / organizationId
        const safeRow: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(row)) {
          if (IMPORT_ALLOWED_FIELDS.has(k) && typeof v === "string" && v.trim()) {
            safeRow[k] = v.trim();
          }
        }

        try {
          const prospect = await storage.createProspect({
            ...safeRow,
            name: rawName,
            organizationId: user.organizationId,
            ownerId: user.id,
            stage: "new_lead",
            leadSource: isZoomInfo ? "zoominfo" : (safeRow.leadSource || null),
            dealProbability: null,
          });
          existingNames.add(nameLower); // prevent same name in later rows of same batch

          // Log an activity entry
          const activityNote = isZoomInfo
            ? `Imported from ZoomInfo${row.estimatedAnnualRevenue ? ` — Est. Revenue: ${row.estimatedAnnualRevenue}` : ""}${row.employeeCount ? `, ~${row.employeeCount} employees` : ""}`
            : `Imported via CSV`;
          await storage.createProspectActivity({
            prospectId: prospect.id,
            type: "note",
            notes: activityNote,
            createdById: user.id,
          });

          // Create additional contacts (ZoomInfo contacts 2 & 3) if provided
          if (isZoomInfo) {
            for (let ci = 2; ci <= 3; ci++) {
              const cName = typeof row[`contact${ci}Name`] === "string" ? row[`contact${ci}Name`].trim() : "";
              if (cName) {
                await storage.createProspectContact({
                  prospectId: prospect.id,
                  name: cName,
                  title: row[`contact${ci}Title`] || null,
                  email: row[`contact${ci}Email`] || null,
                  phone: row[`contact${ci}Phone`] || null,
                  linkedin: null,
                  role: "other",
                  notes: null,
                });
              }
            }
          }

          created++;
        } catch (err: any) {
          errors.push({ row: i + 1, error: err.message ?? "Failed to create" });
        }
      }
      res.json({ created, errors });
    } catch (err) {
      console.error("POST /api/prospects/import error:", err);
      res.status(500).json({ error: "Import failed" });
    }
  });

  const VALID_ACCOUNT_STATUSES = ["prospecting", "intro_scheduled", "active_customer", "dormant", "lost"];
  app.patch("/api/prospects/:id", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const validationError = validateProspectPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      // Validate accountStatus if provided
      if (req.body.accountStatus !== undefined && !VALID_ACCOUNT_STATUSES.includes(req.body.accountStatus)) {
        return res.status(400).json({ error: `Invalid account status: ${req.body.accountStatus}` });
      }
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (user.role === "sales" && existing.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const updated = await storage.updateProspect(id, req.body);

      // Log tracked field changes to crm_account_history
      const TRACKED_FIELDS = ["stage", "ownerId", "priority", "estimatedSpend", "dealProbability", "followUpDate", "expectedCloseDate", "name", "industry", "accountStatus"];
      for (const field of TRACKED_FIELDS) {
        if (field in req.body) {
          const oldVal = (existing as any)[field];
          const newVal = req.body[field];
          const oldStr = oldVal != null ? String(oldVal) : null;
          const newStr = newVal != null ? String(newVal) : null;
          if (oldStr !== newStr) {
            storage.logCrmAccountHistory({ prospectId: id, organizationId: user.organizationId, field, oldValue: oldStr, newValue: newStr, changedById: user.id }).catch(() => {});
          }
        }
      }

      res.json(updated);
    } catch (err) {
      console.error("PATCH /api/prospects/:id error:", err);
      res.status(500).json({ error: "Failed to update prospect" });
    }
  });

  app.delete("/api/prospects/:id", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (user.role === "sales" && existing.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      await storage.deleteProspect(id);
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id error:", err);
      res.status(500).json({ error: "Failed to delete prospect" });
    }
  });

  app.get("/api/prospects/:id/activities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const activities = await storage.getProspectActivities(id);
      const allUsers = await storage.getUsers(user.organizationId);
      const enriched = activities.map(a => ({
        ...a,
        createdByName: allUsers.find(u => u.id === a.createdById)?.name ?? "Unknown",
      }));
      res.json(enriched);
    } catch (err) {
      console.error("GET /api/prospects/:id/activities error:", err);
      res.status(500).json({ error: "Failed to fetch activities" });
    }
  });

  app.post("/api/prospects/:id/activities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const activity = await storage.createProspectActivity({
        prospectId: id,
        type: req.body.type,
        notes: req.body.notes,
        createdById: user.id,
      });
      res.status(201).json(activity);
    } catch (err) {
      console.error("POST /api/prospects/:id/activities error:", err);
      res.status(500).json({ error: "Failed to log activity" });
    }
  });

  // ── Prospect Contacts sub-resource ──────────────────────────────────────────

  app.get("/api/prospects/:id/contacts", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const contacts = await storage.getProspectContacts(id);
      res.json(contacts);
    } catch (err) {
      console.error("GET /api/prospects/:id/contacts error:", err);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.post("/api/prospects/:id/contacts", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const contact = await storage.createProspectContact({ ...req.body, prospectId: id });
      res.status(201).json(contact);
    } catch (err) {
      console.error("POST /api/prospects/:id/contacts error:", err);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.patch("/api/prospects/:id/contacts/:contactId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const contactId = parseInt(req.params.contactId);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const updated = await storage.updateProspectContact(id, contactId, req.body);
      if (!updated) return res.status(404).json({ error: "Contact not found under this prospect" });
      res.json(updated);
    } catch (err) {
      console.error("PATCH /api/prospects/:id/contacts/:contactId error:", err);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/prospects/:id/contacts/:contactId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const contactId = parseInt(req.params.contactId);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const deleted = await storage.deleteProspectContact(id, contactId);
      if (!deleted) return res.status(404).json({ error: "Contact not found under this prospect" });
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id/contacts/:contactId error:", err);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // ── AI Sales Intel Brief ─────────────────────────────────────────────────────
  app.post("/api/prospects/:id/intel", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });

      const forceRegen = req.body?.force === true;
      if (prospect.intelBrief && !forceRegen) {
        return res.json({ brief: prospect.intelBrief });
      }

      const allCompanies = await storage.getCompanies(user.organizationId);

      // Parse prospect's top lanes into searchable tokens (city/state keywords)
      const laneTokens: string[] = (prospect.topLanes ?? "")
        .split(/[,\-\/|→to]+/i)
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length >= 3 && !["the", "and"].includes(t));

      // Industry match set
      const industryKey = (prospect.industry ?? "").toLowerCase().slice(0, 12);
      const industryMatchIds = new Set<string>(
        industryKey
          ? allCompanies.filter(c => c.industry && c.industry.toLowerCase().includes(industryKey)).map(c => c.id)
          : []
      );

      // Lane overlap match: find companies whose contacts have lanes containing prospect's lane tokens
      const laneMatchIds = new Set<string>();
      if (laneTokens.length > 0 && allCompanies.length > 0) {
        const { db } = await import("./storage");
        const { contacts: contactsTable } = await import("../shared/schema");
        const { inArray: drizzleInArray } = await import("drizzle-orm");
        const companyIds = allCompanies.map(c => c.id);
        const contactRows = await db
          .select({ companyId: contactsTable.companyId, lanes: contactsTable.lanes })
          .from(contactsTable)
          .where(drizzleInArray(contactsTable.companyId, companyIds));
        contactRows.forEach(row => {
          if (row.companyId && row.lanes && row.lanes.some(lane =>
            laneTokens.some(token => lane.toLowerCase().includes(token))
          )) {
            laneMatchIds.add(row.companyId);
          }
        });
      }

      // Build combined similar set — industry OR lane overlap — prioritize dual matches, cap at 6
      const combinedMap = new Map<string, { company: typeof allCompanies[number]; score: number }>();
      allCompanies.forEach(c => {
        const inIndustry = industryMatchIds.has(c.id);
        const inLane = laneMatchIds.has(c.id);
        if (inIndustry || inLane) {
          combinedMap.set(c.id, { company: c, score: (inIndustry ? 1 : 0) + (inLane ? 1 : 0) });
        }
      });
      const similar = [...combinedMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(x => x.company);

      // Fallback: if no matches, use first 4 companies for general context
      const contextCompanies = similar.length > 0 ? similar : allCompanies.slice(0, 4);

      const networkLines = contextCompanies.length > 0
        ? contextCompanies.map(c => {
            const tags: string[] = [];
            if (industryMatchIds.has(c.id)) tags.push("same industry");
            if (laneMatchIds.has(c.id)) tags.push("overlapping lanes");
            const tag = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
            const spend = c.estimatedFreightSpend ? ` ~$${Number(c.estimatedFreightSpend).toLocaleString()}/mo` : "";
            return `- ${c.name}${c.industry ? ` (${c.industry})` : ""}${spend}${tag}`;
          }).join("\n")
        : "- No closely matching customers found yet";

      const prompt = `You are a strategic sales intelligence analyst for Value Truck, a top-tier transportation brokerage. Prepare a concise, actionable Sales Intel Brief for a prospect the sales team is pursuing.

PROSPECT PROFILE:
- Company: ${prospect.name}
- Industry: ${prospect.industry ?? "Unknown"}
- Estimated Freight Spend: ${prospect.estimatedSpend ? prospect.estimatedSpend + "/mo" : "Unknown"}
- Top Lanes: ${prospect.topLanes ?? "Not specified"}
- Commodity: ${prospect.commodity ?? "Not specified"}
- Current Carrier: ${prospect.currentCarrier ?? "Not specified"}
- Known Pain Points: ${prospect.painPoints ?? "Not specified"}

EXISTING VALUE TRUCK CUSTOMER NETWORK (similar companies already with us):
${networkLines}

Write a Sales Intel Brief using EXACTLY these 4 sections with bullet points. Be specific, practical, and concise:

## 🔗 Network Overlap
(Which existing VT customers are similar to this prospect and what that reveals about needs, patterns, and buying behavior)

## 💬 Conversation Starters
(3-4 specific opening questions or statements tailored to their freight profile, industry, and lanes)

## ⚠️ Industry Pain Points
(Top 3 freight challenges common in their vertical that Value Truck directly solves)

## 🏆 Competitive Tips
(How to position Value Truck vs their current carrier — be specific if the carrier is named, otherwise give general differentiation tips)`;

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 700,
        temperature: 0.7,
      });

      const brief = completion.choices[0].message.content ?? "";
      await storage.updateProspect(id, { intelBrief: brief });
      res.json({ brief });
    } catch (err) {
      console.error("POST /api/prospects/:id/intel error:", err);
      res.status(500).json({ error: "Failed to generate intel brief" });
    }
  });

  // Convert prospect → company
  app.post("/api/prospects/:id/convert", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const id = parseInt(req.params.id);
      const existing = await storage.getProspect(id);
      if (!existing || existing.organizationId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      const { assignedNamId } = req.body;
      const { nanoid } = await import("nanoid");
      const companyId = nanoid(10);
      const company = await storage.createCompany({
        id: companyId,
        organizationId: user.organizationId,
        name: existing.name,
        industry: existing.industry ?? undefined,
        website: existing.website ?? undefined,
        assignedTo: assignedNamId || null,
        shippingModes: existing.shippingModes ?? [],
        estimatedSpend: existing.estimatedSpend ?? undefined,
        notes: existing.notes ? `[Converted from prospect]\n${existing.notes}` : "[Converted from prospect]",
      });
      if (existing.primaryContactName) {
        await storage.createContact({
          id: nanoid(10),
          companyId: company.id,
          name: existing.primaryContactName,
          title: existing.primaryContactTitle ?? undefined,
          email: existing.primaryContactEmail ?? undefined,
          phone: existing.primaryContactPhone ?? undefined,
          linkedin: existing.primaryContactLinkedin ?? undefined,
        });
      }
      await storage.updateProspect(id, {
        convertedToCompanyId: company.id,
        convertedAt: new Date() as any,
        stage: "first_load_won",
        assignedNamId: assignedNamId || existing.assignedNamId,
      });
      res.json({ company, prospectId: id });
    } catch (err) {
      console.error("POST /api/prospects/:id/convert error:", err);
      res.status(500).json({ error: "Failed to convert prospect" });
    }
  });

  // ─── Launchpad CRM — Opportunities ──────────────────────────────────────────

  // Bulk summary: oppCount + pipelineValue for ALL prospects in this org (for Kanban/table views)
  app.get("/api/prospects/opportunities-summary", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Build the summary query, scoped to org and ownership where required
      // Sales reps only see summaries for prospects they own
      let rows: unknown;
      if (user.role === "sales") {
        rows = await db.execute(sql`
          SELECT
            o.prospect_id as "prospectId",
            COUNT(*) FILTER (WHERE o.stage NOT IN ('closed_won','closed_lost')) as "openCount",
            COUNT(*) FILTER (WHERE o.stage = 'closed_won') as "closedWonCount",
            SUM(CASE WHEN o.stage NOT IN ('closed_won','closed_lost')
              AND o.amount IS NOT NULL AND o.amount ~ '^[^0-9]*[0-9]'
              THEN CAST(REGEXP_REPLACE(o.amount, '[^0-9.]', '', 'g') AS NUMERIC)
              ELSE 0 END) as "pipelineValue"
          FROM crm_opportunities o
          INNER JOIN prospects p ON p.id = o.prospect_id
          WHERE o.organization_id = ${user.organizationId}
            AND p.owner_id = ${user.id}
          GROUP BY o.prospect_id
        `);
      } else {
        rows = await db.execute(sql`
          SELECT
            prospect_id as "prospectId",
            COUNT(*) FILTER (WHERE stage NOT IN ('closed_won','closed_lost')) as "openCount",
            COUNT(*) FILTER (WHERE stage = 'closed_won') as "closedWonCount",
            SUM(CASE WHEN stage NOT IN ('closed_won','closed_lost')
              AND amount IS NOT NULL AND amount ~ '^[^0-9]*[0-9]'
              THEN CAST(REGEXP_REPLACE(amount, '[^0-9.]', '', 'g') AS NUMERIC)
              ELSE 0 END) as "pipelineValue"
          FROM crm_opportunities
          WHERE organization_id = ${user.organizationId}
          GROUP BY prospect_id
        `);
      }
      const result: Record<number, { openCount: number; closedWonCount: number; pipelineValue: number }> = {};
      const rowArray = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      for (const row of rowArray as Array<{ prospectId: unknown; openCount: unknown; closedWonCount: unknown; pipelineValue: unknown }>) {
        result[Number(row.prospectId)] = {
          openCount: Number(row.openCount ?? 0),
          closedWonCount: Number(row.closedWonCount ?? 0),
          pipelineValue: Number(row.pipelineValue ?? 0),
        };
      }
      res.json(result);
    } catch (err) {
      console.error("GET /api/prospects/opportunities-summary error:", err);
      res.status(500).json({ error: "Failed to fetch opportunities summary" });
    }
  });

  app.get("/api/prospects/:id/opportunities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Verify prospect belongs to this org (and sales role can only read their own)
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Prospect not found" });
      if (user.role === "sales" && prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const rows = await storage.getCrmOpportunities(id);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/prospects/:id/opportunities error:", err);
      res.status(500).json({ error: "Failed to fetch opportunities" });
    }
  });

  // Allowed values for opportunity fields (server-side validation)
  const VALID_OPP_RECORD_TYPES = ["single_multi_lane", "private_hauling", "rfp", "trucking_opportunity"];
  const VALID_OPP_STAGES = ["qualification", "discovery", "proposal", "negotiation", "closed_won", "closed_lost"];

  function validateOppPayload(body: any): string | null {
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) return "Name is required";
    if (body.recordType && !VALID_OPP_RECORD_TYPES.includes(body.recordType)) return `Invalid record type: ${body.recordType}`;
    if (body.stage && !VALID_OPP_STAGES.includes(body.stage)) return `Invalid stage: ${body.stage}`;
    if (body.probability != null) {
      const p = Number(body.probability);
      if (isNaN(p) || p < 0 || p > 100) return "Probability must be 0–100";
    }
    return null;
  }

  app.post("/api/prospects/:id/opportunities", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Verify prospect belongs to this org and the user has access to it
      const prospect = await storage.getProspect(id);
      if (!prospect || prospect.organizationId !== user.organizationId) return res.status(404).json({ error: "Prospect not found" });
      if (user.role === "sales" && prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      const validationError = validateOppPayload(req.body);
      if (validationError) return res.status(400).json({ error: validationError });
      // Whitelist permitted create fields — never trust client-provided prospectId/orgId/createdById
      const { name, recordType, stage, amount, closeDate, probability, notes, lostReason } = req.body;
      const row = await storage.createCrmOpportunity({
        name,
        recordType: recordType ?? "single_multi_lane",
        stage: stage ?? "qualification",
        amount: amount ?? null,
        closeDate: closeDate ?? null,
        probability: probability ?? null,
        notes: notes ?? null,
        lostReason: lostReason ?? null,
        prospectId: id,
        organizationId: user.organizationId,
        createdById: user.id,
      });
      res.json(row);
    } catch (err) {
      console.error("POST /api/prospects/:id/opportunities error:", err);
      res.status(500).json({ error: "Failed to create opportunity" });
    }
  });

  app.patch("/api/prospects/:id/opportunities/:oppId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const oppId = parseInt(req.params.oppId);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Verify the opportunity belongs to this prospect AND this org (IDOR protection)
      const existing = await storage.getCrmOpportunityById(oppId);
      if (!existing || existing.prospectId !== id || existing.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Opportunity not found" });
      }
      if (user.role === "sales") {
        const prospect = await storage.getProspect(id);
        if (!prospect || prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      }
      // Whitelist editable fields only — prevent mass-assignment of prospectId, organizationId, createdById, etc.
      type OppEditableFields = Pick<import('../shared/schema').InsertCrmOpportunity, "name" | "recordType" | "stage" | "amount" | "closeDate" | "probability" | "notes" | "lostReason">;
      const body = req.body as Partial<OppEditableFields>;
      const safeUpdate: Partial<OppEditableFields> = {};
      if ("name" in body && body.name !== undefined) safeUpdate.name = body.name;
      if ("recordType" in body) safeUpdate.recordType = body.recordType;
      if ("stage" in body) safeUpdate.stage = body.stage;
      if ("amount" in body) safeUpdate.amount = body.amount;
      if ("closeDate" in body) safeUpdate.closeDate = body.closeDate;
      if ("probability" in body) safeUpdate.probability = body.probability;
      if ("notes" in body) safeUpdate.notes = body.notes;
      if ("lostReason" in body) safeUpdate.lostReason = body.lostReason;
      const validationError = validateOppPayload({ name: existing.name, ...safeUpdate });
      if (validationError) return res.status(400).json({ error: validationError });
      const row = await storage.updateCrmOpportunity(oppId, safeUpdate);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err) {
      console.error("PATCH /api/prospects/:id/opportunities/:oppId error:", err);
      res.status(500).json({ error: "Failed to update opportunity" });
    }
  });

  app.delete("/api/prospects/:id/opportunities/:oppId", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const oppId = parseInt(req.params.oppId);
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Verify the opportunity belongs to this prospect AND this org (IDOR protection)
      const existing = await storage.getCrmOpportunityById(oppId);
      if (!existing || existing.prospectId !== id || existing.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Opportunity not found" });
      }
      if (user.role === "sales") {
        const prospect = await storage.getProspect(id);
        if (!prospect || prospect.ownerId !== user.id) return res.status(403).json({ error: "Forbidden" });
      }
      await storage.deleteCrmOpportunity(oppId);
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE /api/prospects/:id/opportunities/:oppId error:", err);
      res.status(500).json({ error: "Failed to delete opportunity" });
    }
  });

  // ─── Launchpad CRM — Ownership Requests ──────────────────────────────────────

  app.get("/api/launchpad/ownership-requests", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const rows = await storage.getCrmOwnershipRequests(user.organizationId);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/launchpad/ownership-requests error:", err);
      res.status(500).json({ error: "Failed to fetch ownership requests" });
    }
  });

  app.post("/api/prospects/:id/ownership-request", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const user = (req as any).user;
      const prospect = await storage.getProspect(id);
      if (!prospect) return res.status(404).json({ error: "Prospect not found" });
      const row = await storage.createCrmOwnershipRequest({
        prospectId: id,
        organizationId: user.organizationId,
        requesterId: user.id,
        currentOwnerId: prospect.ownerId,
        reason: req.body.reason ?? null,
        status: "pending",
      });
      res.json(row);
    } catch (err) {
      console.error("POST /api/prospects/:id/ownership-request error:", err);
      res.status(500).json({ error: "Failed to submit ownership request" });
    }
  });

  app.patch("/api/launchpad/ownership-requests/:id/review", requireAuth, async (req, res) => {
    try {
      const reqId = parseInt(req.params.id);
      const user = (req as any).user;
      if (!["admin", "sales_director", "director"].includes(user.role)) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const { status, adminNote } = req.body;
      const row = await storage.reviewCrmOwnershipRequest(reqId, status, user.id, adminNote);
      if (!row) return res.status(404).json({ error: "Not found" });
      // If approved, transfer ownership
      if (status === "approved") {
        const fullReq = row;
        await storage.updateProspect(fullReq.prospectId, { ownerId: fullReq.requesterId });
      }
      res.json(row);
    } catch (err) {
      console.error("PATCH /api/launchpad/ownership-requests/:id/review error:", err);
      res.status(500).json({ error: "Failed to review ownership request" });
    }
  });

  // ─── Launchpad CRM — Account History ──────────────────────────────────────────

  app.get("/api/prospects/:id/history", requireAuth, requireProspectRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rows = await storage.getCrmAccountHistory(id);
      res.json(rows);
    } catch (err) {
      console.error("GET /api/prospects/:id/history error:", err);
      res.status(500).json({ error: "Failed to fetch account history" });
    }
  });

  // ─── Stripe Billing Routes ────────────────────────────────────────────────────

  // Get Stripe publishable key (public, no auth)
  app.get("/api/stripe/config", async (_req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch {
      res.status(500).json({ error: "Stripe not configured" });
    }
  });

  interface ProductRow {
    product_id: string;
    product_name: string;
    product_description: string | null;
    product_metadata: Record<string, string> | null;
    price_id: string | null;
    unit_amount: number | null;
    currency: string | null;
    recurring: { interval: string; interval_count: number } | null;
  }

  interface ProductEntry {
    id: string;
    name: string;
    description: string | null;
    metadata: Record<string, string>;
    prices: Array<{ id: string; unitAmount: number | null; currency: string; recurring: { interval: string; interval_count: number } | null }>;
  }

  // List products with prices from the stripe schema (public, no auth)
  app.get("/api/stripe/products", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          p.metadata as product_metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring,
          pr.active as price_active
        FROM stripe.products p
        LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        WHERE p.active = true
        ORDER BY p.name, pr.unit_amount
      `);

      const productsMap = new Map<string, ProductEntry>();
      for (const row of result.rows as ProductRow[]) {
        if (!productsMap.has(row.product_id)) {
          productsMap.set(row.product_id, {
            id: row.product_id,
            name: row.product_name,
            description: row.product_description,
            metadata: row.product_metadata ?? {},
            prices: [],
          });
        }
        if (row.price_id && row.currency) {
          productsMap.get(row.product_id)!.prices.push({
            id: row.price_id,
            unitAmount: row.unit_amount,
            currency: row.currency,
            recurring: row.recurring,
          });
        }
      }

      res.json({ products: Array.from(productsMap.values()) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("GET /api/stripe/products error:", message);
      res.json({ products: [] });
    }
  });

  // Simple in-memory rate limiter for the public checkout endpoint.
  // Limits each IP to 5 checkout session requests per hour to prevent abuse.
  const checkoutRateLimit = new Map<string, { count: number; windowStart: number }>();
  const CHECKOUT_LIMIT = 5;
  const CHECKOUT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  // Create a Stripe Checkout session (public, no auth required — prospect is signing up)
  app.post("/api/stripe/checkout", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const bucket = checkoutRateLimit.get(ip);

    if (bucket) {
      if (now - bucket.windowStart < CHECKOUT_WINDOW_MS) {
        if (bucket.count >= CHECKOUT_LIMIT) {
          return res.status(429).json({ error: "Too many checkout requests. Please try again later." });
        }
        bucket.count += 1;
      } else {
        checkoutRateLimit.set(ip, { count: 1, windowStart: now });
      }
    } else {
      checkoutRateLimit.set(ip, { count: 1, windowStart: now });
    }

    try {
      const { priceId, companyName, adminEmail } = req.body as {
        priceId: string;
        companyName?: string;
        adminEmail?: string;
      };
      if (!priceId) return res.status(400).json({ error: "priceId is required" });

      // Basic shape validation on optional identity fields to prevent malformed org records
      if (companyName !== undefined && (typeof companyName !== "string" || companyName.length > 200)) {
        return res.status(400).json({ error: "Invalid companyName" });
      }
      if (adminEmail !== undefined) {
        const emailOk = typeof adminEmail === "string" && adminEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail);
        if (!emailOk) return res.status(400).json({ error: "Invalid adminEmail" });
      }

      // Allowlist: only permit prices that are synced, active, and belong to one of our
      // explicitly typed products (subscription plan or one-time add-on). This prevents
      // a client from passing arbitrary price IDs from unrelated Stripe products.
      const priceCheckResult = await db.execute(sql`
        SELECT pr.id, pr.recurring
        FROM stripe.prices pr
        INNER JOIN stripe.products p ON p.id = pr.product
        WHERE pr.id = ${priceId}
          AND pr.active = true
          AND p.active = true
          AND (p.metadata->>'type' = 'subscription' OR p.metadata->>'type' = 'one_time')
      `);

      if (priceCheckResult.rows.length === 0) {
        return res.status(400).json({ error: "Invalid or inactive price" });
      }

      // Derive mode from price type so the client cannot override it
      const priceRow = priceCheckResult.rows[0] as { recurring: { interval: string } | null };
      const resolvedMode: "subscription" | "payment" = priceRow.recurring ? "subscription" : "payment";

      const stripe = await getUncachableStripeClient();
      const baseUrl = `${req.protocol}://${req.get("host")}`;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: resolvedMode,
        success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?checkout=cancelled`,
        metadata: {
          companyName: companyName ?? "",
          adminEmail: adminEmail ?? "",
        },
        ...(adminEmail ? { customer_email: adminEmail } : {}),
      });
      res.json({ url: session.url });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("POST /api/stripe/checkout error:", message);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // Read a completed checkout session for the success page — informational only.
  // Org creation and billing activation are handled by the webhook (checkout.session.completed),
  // which fires reliably even if the buyer closes the tab before reaching this URL.
  app.get("/api/stripe/confirm-checkout", async (req, res) => {
    try {
      const { session_id } = req.query as { session_id?: string };
      if (!session_id) return res.status(400).json({ error: "session_id required" });

      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(session_id);

      // Require the session to be fully complete (Stripe sets status="complete" once paid).
      // Additionally allow "no_payment_required" for free-trial subscriptions.
      const succeeded =
        session.status === "complete" &&
        (session.payment_status === "paid" || session.payment_status === "no_payment_required");

      if (!succeeded) {
        return res.status(402).json({ error: "Payment not completed" });
      }

      const companyName =
        session.metadata?.companyName ||
        session.customer_details?.name ||
        "New Organization";
      const adminEmail =
        session.metadata?.adminEmail ||
        session.customer_details?.email ||
        "";

      res.json({
        success: true,
        companyName,
        adminEmail,
        planName: "Freight DNA Subscription",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("GET /api/stripe/confirm-checkout error:", message);
      res.status(500).json({ error: "Failed to confirm checkout" });
    }
  });

  // Admin: get own organization's billing status
  app.get("/api/admin/billing", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      // Scope to the admin's own organization — never leak cross-tenant data
      const org = user.organizationId ? await storage.getOrganizationById(user.organizationId) : null;
      res.json({ organization: org ?? null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("GET /api/admin/billing error:", message);
      res.status(500).json({ error: "Failed to fetch billing data" });
    }
  });

  // Admin: list invoices for own organization (admin only)
  app.get("/api/admin/billing/invoices", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });

      const org = user.organizationId ? await storage.getOrganizationById(user.organizationId) : null;
      if (!org?.stripeCustomerId) return res.json({ invoices: [] });

      const stripe = await getUncachableStripeClient();
      const invoiceList = await stripe.invoices.list({
        customer: org.stripeCustomerId,
        limit: 24,
        status: "paid",
      });

      const invoices = invoiceList.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        status: inv.status,
        created: inv.created,
        periodStart: inv.period_start,
        periodEnd: inv.period_end,
        invoicePdf: inv.invoice_pdf,
        hostedInvoiceUrl: inv.hosted_invoice_url,
      }));

      res.json({ invoices });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("GET /api/admin/billing/invoices error:", message);
      res.status(500).json({ error: "Failed to fetch invoices" });
    }
  });

  // ── Lane Carrier Routes (Procurement Rolodex) ─────────────────────────────

  // Helper: verify award is accessible to the current user (same org + visibility)
  async function verifyAwardAccess(user: User, awardId: string): Promise<boolean> {
    const award = await storage.getAward(awardId);
    if (!award) return false;
    const orgCompanies = await storage.getCompanies(user.organizationId);
    const orgCompanyIds = new Set(orgCompanies.map((c) => c.id));
    if (!orgCompanyIds.has(award.companyId)) return false;
    const visibleIds = await getVisibleCompanyIds(user);
    if (visibleIds !== null && !visibleIds.includes(award.companyId)) return false;
    return true;
  }

  // Helper: verify a task is accessible to the current user, respecting company visibility constraints
  async function verifyTaskAccess(user: User, taskId: string): Promise<boolean> {
    const task = await storage.getTask(taskId);
    if (!task) return false;
    // When the task is linked to a company, enforce company-visibility rules (same as canAccessCompany)
    if (task.companyId) {
      return canAccessCompany(user, task.companyId);
    }
    // No company link: fall back to checking the assigned/creating user's org membership
    const assignedUser = await storage.getUser(task.assignedTo);
    return !!(assignedUser && assignedUser.organizationId === user.organizationId);
  }

  // Per-key serialization map: prevents concurrent requests from creating duplicate procurement tasks
  // for the same (awardId, lane) pair (Node.js single-thread, but async interleaving is still possible)
  const procTaskCreationLocks = new Map<string, Promise<{ lane: string; taskId: string; created: boolean }>>();

  // Idempotent procurement task generation — server validates qualifying lanes (>=50 loads) and finds-or-creates
  app.post("/api/awards/:awardId/procurement-tasks", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { awardId } = req.params;
      if (!(await verifyAwardAccess(user, awardId))) return res.status(403).json({ error: "Access denied" });
      // lanes is optional — if omitted, all award qualifying lanes are processed server-side
      const { lanes } = (req.body ?? {}) as { lanes?: Array<{ lane: string }> };
      const award = await storage.getAward(awardId);
      if (!award) return res.status(404).json({ error: "Award not found" });
      // Parse award lane strings server-side; origin/dest/volume are derived here, not trusted from client
      const lanePattern = /^(.+?)\s*(?:→|->|\bto\b)\s*(.+?)(?:\s*\((\d[\d,]*)\s*(?:loads?|shipments?|shpts?)[^)]*\))?$/i;
      type LaneMeta = { origin: string; destination: string; volume: number };
      const qualifyingLaneMap = new Map<string, LaneMeta>(
        (award.lanes ?? [])
          .map((l: string) => {
            const m = l.match(lanePattern);
            if (!m) return null;
            const volume = m[3] ? parseInt(m[3].replace(/,/g, "")) : 0;
            return [l, { origin: m[1].trim(), destination: m[2].trim(), volume }] as [string, LaneMeta];
          })
          .filter((entry): entry is [string, LaneMeta] => entry !== null)
      );
      // Process all server-computed qualifying lanes (any parseable origin → destination)
      const validLaneEntries = [...qualifyingLaneMap.entries()];
      if (validLaneEntries.length === 0) return res.status(400).json({ error: "No parseable lanes found for this award. Use format: Origin → Destination" });
      // Per-key serialization prevents concurrent requests from creating duplicate tasks for the same lane
      const results = await Promise.all(validLaneEntries.map(([laneName, meta]) => {
        const lockKey = `${awardId}:${laneName}`;
        if (!procTaskCreationLocks.has(lockKey)) {
          const op = (async () => {
            const existing = await storage.findProcurementTask(awardId, laneName);
            if (existing) return { lane: laneName, taskId: existing.id, created: false };
            const task = await storage.createTask({
              title: `Carrier Procurement — ${laneName}`,
              notes: `Procurement workspace for lane: ${laneName}${meta.volume > 0 ? ` (${meta.volume.toLocaleString()} loads/yr)` : ""}. Award ID: ${awardId}. Target 5–10 carrier contacts.`,
              status: "open",
              dueDate: null,
              assignedTo: user.id,
              assignedBy: user.id,
              companyId: award.companyId ?? null,
              contactId: null,
              attachedLaneData: [{ type: "carrier_procurement", lane: laneName, origin: meta.origin, destination: meta.destination, volume: meta.volume, awardId }],
              createdAt: new Date().toISOString(),
            });
            return { lane: laneName, taskId: task.id, created: true };
          })();
          procTaskCreationLocks.set(lockKey, op.finally(() => procTaskCreationLocks.delete(lockKey)));
        }
        return procTaskCreationLocks.get(lockKey)!;
      }));
      return res.status(200).json({ results });
    } catch (err) {
      console.error("procurement-tasks error", err);
      return res.status(500).json({ error: "Failed to generate procurement tasks" });
    }
  });

  // Assign a specific procurement lane to an LM — creates task if needed, then reassigns
  app.post("/api/awards/:awardId/lanes/assign-lm", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { awardId } = req.params as { awardId: string };
      if (!(await verifyAwardAccess(user, awardId))) return res.status(403).json({ error: "Access denied" });

      const { lane, assignToUserId } = req.body as { lane?: string; assignToUserId?: string };
      if (!lane || !assignToUserId) return res.status(400).json({ error: "lane and assignToUserId are required" });

      // Verify the assignee is in the same org
      const assignee = await storage.getUser(assignToUserId);
      if (!assignee || assignee.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "Invalid assignee" });
      }

      const award = await storage.getAward(awardId);
      if (!award) return res.status(404).json({ error: "Award not found" });

      // Parse lane string to extract origin/destination/volume
      const lanePattern = /^(.+?)\s*(?:→|->|\bto\b)\s*(.+?)(?:\s*\((\d[\d,]*)\s*(?:loads?|shipments?)[^)]*\))?$/i;
      const m = lane.match(lanePattern);
      if (!m) return res.status(400).json({ error: "Could not parse lane. Use format: Origin → Destination" });
      const origin = m[1].trim();
      const destination = m[2].trim();
      const volume = m[3] ? parseInt(m[3].replace(/,/g, "")) : 0;

      let taskId: string;
      let created = false;

      const existing = await storage.findProcurementTask(awardId, lane);
      if (existing) {
        // Reassign existing task to the LM
        await storage.updateTask(existing.id, { assignedTo: assignToUserId, assignedBy: user.id });
        taskId = existing.id;
      } else {
        // Create a new procurement task assigned to the LM
        const task = await storage.createTask({
          title: `Carrier Procurement — ${lane}`,
          notes: `Procurement workspace for lane: ${lane}${volume > 0 ? ` (${volume.toLocaleString()} loads/yr)` : ""}. Award ID: ${awardId}. Target 5–10 carrier contacts.`,
          status: "open",
          dueDate: null,
          assignedTo: assignToUserId,
          assignedBy: user.id,
          companyId: award.companyId ?? null,
          contactId: null,
          attachedLaneData: [{ type: "carrier_procurement", lane, origin, destination, volume, awardId }],
          createdAt: new Date().toISOString(),
        });
        taskId = task.id;
        created = true;
      }

      // Notify the LM
      if (assignToUserId !== user.id) {
        storage.createNotification({
          userId: assignToUserId,
          type: "task_assigned",
          title: `${user.name} assigned you a carrier procurement task`,
          body: `Source 5–10 carriers for lane: ${lane}`,
          link: "/tasks",
          relatedId: taskId,
          read: false,
        }).catch((e) => console.error("Assign-LM notification error:", e));
      }

      return res.json({ taskId, created, assigneeName: assignee.name });
    } catch (err) {
      console.error("assign-lm error", err);
      return res.status(500).json({ error: "Failed to assign lane to LM" });
    }
  });

  // GET carriers by task
  app.get("/api/tasks/:taskId/lane-carriers", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await verifyTaskAccess(user, req.params.taskId))) return res.status(403).json({ error: "Access denied" });
      const carriers = await storage.getLaneCarriersByTask(req.params.taskId);
      res.json(carriers);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch lane carriers" });
    }
  });

  // GET carriers by award
  app.get("/api/awards/:awardId/lane-carriers", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await verifyAwardAccess(user, req.params.awardId))) return res.status(403).json({ error: "Access denied" });
      const carriers = await storage.getLaneCarriersByAward(req.params.awardId);
      res.json(carriers);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch lane carriers" });
    }
  });

  // POST create lane carrier
  const LANE_CARRIER_STATUS_ENUM = ["contacted", "committed", "declined"] as const;
  type LaneCarrierStatus = typeof LANE_CARRIER_STATUS_ENUM[number];

  app.post("/api/lane-carriers", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Validate status enum
      if (req.body.status && !LANE_CARRIER_STATUS_ENUM.includes(req.body.status as LaneCarrierStatus)) {
        return res.status(400).json({ error: `status must be one of: ${LANE_CARRIER_STATUS_ENUM.join(", ")}` });
      }
      // Verify task belongs to user's org and is accessible
      if (!(await verifyTaskAccess(user, req.body.taskId))) return res.status(403).json({ error: "Access denied" });
      // Verify award is accessible
      if (!(await verifyAwardAccess(user, req.body.awardId))) return res.status(403).json({ error: "Access denied" });
      // Task must explicitly be a carrier_procurement task with matching award+lane metadata
      const task = await storage.getTask(req.body.taskId);
      if (task) {
        const laneData = Array.isArray(task.attachedLaneData) ? task.attachedLaneData as Array<{ awardId?: string; lane?: string; type?: string }> : [];
        const procEntries = laneData.filter(e => e.type === "carrier_procurement");
        if (procEntries.length === 0) {
          return res.status(400).json({ error: "Task is not a carrier procurement task" });
        }
        const taskAwardIds = procEntries.map(e => e.awardId).filter(Boolean);
        if (taskAwardIds.length > 0 && !taskAwardIds.includes(req.body.awardId)) {
          return res.status(400).json({ error: "Task does not belong to the specified award" });
        }
        const taskLanes = procEntries.map(e => e.lane).filter(Boolean);
        if (taskLanes.length > 0 && req.body.lane && !taskLanes.includes(req.body.lane)) {
          return res.status(400).json({ error: "Lane does not match task's procurement lanes" });
        }
      }
      // Prevent duplicate carrier name on the same task+lane
      if (req.body.taskId && req.body.lane && req.body.carrierName) {
        const existing = await storage.getLaneCarriersByTask(req.body.taskId);
        const isDuplicate = existing.some(c =>
          c.lane === req.body.lane &&
          c.carrierName.toLowerCase() === String(req.body.carrierName).trim().toLowerCase()
        );
        if (isDuplicate) {
          return res.status(409).json({ error: "Carrier already logged for this lane" });
        }
      }
      const parsed = insertLaneCarrierSchema.safeParse({
        ...req.body,
        createdAt: new Date().toISOString(),
      });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      const carrier = await storage.createLaneCarrier(parsed.data);
      res.json(carrier);
    } catch (err) {
      res.status(500).json({ error: "Failed to create lane carrier" });
    }
  });

  // PATCH update lane carrier
  app.patch("/api/lane-carriers/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Validate status enum if provided
      if (req.body.status && !LANE_CARRIER_STATUS_ENUM.includes(req.body.status as LaneCarrierStatus)) {
        return res.status(400).json({ error: `status must be one of: ${LANE_CARRIER_STATUS_ENUM.join(", ")}` });
      }
      const existing = await storage.getLaneCarrier(req.params.id);
      if (!existing) return res.status(404).json({ error: "Lane carrier not found" });
      if (!(await verifyAwardAccess(user, existing.awardId))) return res.status(403).json({ error: "Access denied" });
      // Only allow updating mutable fields — never allow changing taskId/awardId/lane/createdAt
      const patchSchema = insertLaneCarrierSchema.pick({
        carrierName: true,
        mcNumber: true,
        contactName: true,
        phone: true,
        email: true,
        rate: true,
        capacityPerWeek: true,
        notes: true,
        status: true,
      }).partial();
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
      let carrier;
      try {
        carrier = await storage.updateLaneCarrier(req.params.id, parsed.data);
      } catch (updateErr: unknown) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        if (msg.includes("unique") || msg.includes("duplicate")) {
          return res.status(409).json({ error: "Carrier already logged for this lane" });
        }
        throw updateErr;
      }
      if (!carrier) return res.status(404).json({ error: "Lane carrier not found" });
      res.json(carrier);
    } catch (err) {
      res.status(500).json({ error: "Failed to update lane carrier" });
    }
  });

  // DELETE lane carrier
  app.delete("/api/lane-carriers/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getLaneCarrier(req.params.id);
      if (!existing) return res.status(404).json({ error: "Lane carrier not found" });
      if (!(await verifyAwardAccess(user, existing.awardId))) return res.status(403).json({ error: "Access denied" });
      const ok = await storage.deleteLaneCarrier(req.params.id);
      if (!ok) return res.status(404).json({ error: "Lane carrier not found" });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete lane carrier" });
    }
  });

  // AI email draft
  app.post("/api/ai/draft-email", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { contactId, companyId, subject, toName, companyName } = req.body as {
        contactId?: string; companyId?: string; subject?: string; toName?: string; companyName?: string;
      };

      let contactCtx = "";
      let recentNotes = "";

      if (contactId) {
        const contact = await storage.getContact(contactId);
        if (contact) {
          const parts: string[] = [];
          if (contact.title) parts.push(`Title: ${contact.title}`);
          if (contact.interests) parts.push(`Personal interests: ${contact.interests}`);
          if (contact.nextSteps) parts.push(`Next steps noted: ${contact.nextSteps}`);
          if (contact.relationshipBase) parts.push(`Relationship level: ${contact.relationshipBase}`);
          contactCtx = parts.join("\n");

          const tps = await storage.getTouchpointsByContact(contactId);
          const withNotes = tps.filter(t => t.notes && t.notes.trim()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
          recentNotes = withNotes.map(t => `[${t.date} ${t.type}] ${t.notes}`).join("\n");
        }
      }

      let companyCtx = "";
      if (companyId) {
        const company = await storage.getCompany(companyId);
        if (company) {
          const parts: string[] = [];
          if (company.industry) parts.push(`Industry: ${company.industry}`);
          if (company.accountSummary) parts.push(`Account summary: ${company.accountSummary}`);
          companyCtx = parts.join("\n");
        }
      }

      const systemPrompt = `You are a sales rep at a freight brokerage called Freight-DNA / Value Truck. 
Write a professional, warm, concise business email to a shipper contact. 
Keep it under 150 words. Be specific and personal where context allows. 
Do NOT use generic filler phrases like "I hope this email finds you well." 
Sign off with just the sender's name placeholder: [Your Name]. 
Return only the email body text — no subject line, no extra commentary.`;

      const userPrompt = `Write an email to ${toName || "the contact"} at ${companyName || "their company"}.
Subject hint: ${subject || "General outreach"}
${contactCtx ? `\nContact context:\n${contactCtx}` : ""}
${companyCtx ? `\nAccount context:\n${companyCtx}` : ""}
${recentNotes ? `\nRecent interaction notes (use for personalization):\n${recentNotes}` : ""}`;

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.7,
      });

      const draft = completion.choices[0]?.message?.content?.trim() ?? "";
      res.json({ draft });
    } catch (err: any) {
      console.error("[ai-draft-email] error:", err?.message ?? err);
      res.status(500).json({ error: "Failed to generate draft" });
    }
  });

  // Rep scorecard — aggregated metrics for all reps (admin/director only)
  app.get("/api/rep-scorecard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager", "sales_director"].includes(user.role ?? "")) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = user.organizationId;
      const allUsers = await storage.getUsers(orgId);
      const repRoles = ["account_manager", "national_account_manager", "logistics_manager", "logistics_coordinator", "sales"];
      const reps = allUsers.filter(u => repRoles.includes(u.role ?? ""));

      const now = new Date();
      const range = (req.query.range as string) || "last_week";

      let rangeStart: Date;
      let rangeEnd: Date = new Date(now);
      rangeEnd.setHours(23, 59, 59, 999);

      if (range === "mtd") {
        rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
        rangeStart.setHours(0, 0, 0, 0);
      } else if (range === "last_month") {
        rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        rangeStart.setHours(0, 0, 0, 0);
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        rangeEnd.setHours(23, 59, 59, 999);
      } else if (range === "ytd") {
        rangeStart = new Date(now.getFullYear(), 0, 1);
        rangeStart.setHours(0, 0, 0, 0);
      } else {
        // last_week: Monday–Sunday of previous week
        const day = now.getDay();
        const daysToLastMonday = (day === 0 ? 6 : day - 1) + 7;
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - daysToLastMonday);
        rangeStart.setHours(0, 0, 0, 0);
        rangeEnd = new Date(rangeStart);
        rangeEnd.setDate(rangeEnd.getDate() + 6);
        rangeEnd.setHours(23, 59, 59, 999);
      }

      const rangeStartStr = rangeStart.toISOString().split("T")[0];
      const rangeEndStr = rangeEnd.toISOString().split("T")[0];

      // Goals always use the current month (targets are not adjusted per selected range)
      const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

      // weekStart used only for display label
      const weekStartStr = rangeStartStr;

      // All touchpoints in range (bulk fetch, then split per rep)
      const allTps = await storage.getTouchpointsSince(rangeStartStr);

      // All contacts (for contacts-added count)
      const allContacts = await storage.getContacts();
      const orgUserIds = new Set(allUsers.map(u => u.id));
      const contactsThisMonth = allContacts.filter(c => {
        if (!c.createdAt || !c.createdBy || !orgUserIds.has(c.createdBy)) return false;
        const dateStr = c.createdAt.slice(0, 10);
        return dateStr >= rangeStartStr && dateStr <= rangeEndStr;
      });

      // All goals (no filter = all org goals via am-scoped logic)
      const allGoals = await storage.getGoals({});

      const results = await Promise.all(reps.map(async rep => {
        const repTps = allTps.filter((t: any) => t.loggedById === rep.id && (!t.date || t.date <= rangeEndStr));
        const weeklyTotal = repTps.length;
        const weeklyCalls = repTps.filter((t: any) => t.type === "call").length;
        const weeklyEmails = repTps.filter((t: any) => t.type === "email").length;
        const weeklyTexts = repTps.filter((t: any) => t.type === "text").length;
        const weeklySiteVisits = repTps.filter((t: any) => t.type === "site_visit").length;
        const weeklyMeaningful = repTps.filter((t: any) => t.isMeaningful).length;
        const contactsAdded = contactsThisMonth.filter(c => c.createdBy === rep.id).length;

        const repGoals = allGoals.filter((g: any) => g.userId === rep.id && g.period === period);
        const touchpointGoal = repGoals.find((g: any) => g.metric === "touchpoints");
        const meaningfulGoal = repGoals.find((g: any) => g.metric === "meaningful_touchpoints");
        const contactsGoal = repGoals.find((g: any) => g.metric === "contacts_added");

        return {
          userId: rep.id,
          name: rep.name,
          role: rep.role,
          weeklyTotal,
          weeklyCalls,
          weeklyEmails,
          weeklyTexts,
          weeklySiteVisits,
          weeklyMeaningful,
          contactsAdded,
          touchpointGoalTarget: touchpointGoal?.targetValue != null ? Number(touchpointGoal.targetValue) : null,
          meaningfulGoalTarget: meaningfulGoal?.targetValue != null ? Number(meaningfulGoal.targetValue) : null,
          contactsGoalTarget: contactsGoal?.targetValue != null ? Number(contactsGoal.targetValue) : null,
        };
      }));

      results.sort((a, b) => b.weeklyTotal - a.weeklyTotal);
      res.json({ weekStart: weekStartStr, results });
    } catch (err: any) {
      console.error("[rep-scorecard]", err?.message ?? err);
      res.status(500).json({ error: "Failed to load rep scorecard" });
    }
  });

  return httpServer;
}
