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
import { insertCompanySchema, insertContactSchema, insertRfpSchema, insertAwardSchema, insertTaskSchema, userRoles, insertCalloutSchema, insertFeedPostSchema, type Callout, insertOneOnOneTopicSchema } from "@shared/schema";
import { performOneDriveSync } from "./monthlyDataRefreshScheduler";
import { resolveColumns, getRepFromRow, getDispatcherFromRow, getSalespersonFromRow, getStatusFromRow, getCustomerFromRow, type FinancialCols } from "./colResolver";

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

async function getVisibleFeedAuthorIds(user: { id: string; role: string; managerId: string | null; organizationId: string }): Promise<string[] | undefined> {
  if (user.role === "admin") return undefined;
  if (user.role === "director" || user.role === "sales_director") {
    return storage.getTeamMemberIds(user.id, user.organizationId);
  }
  if (user.role === "national_account_manager" || user.role === "sales") {
    const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
    if (user.managerId) ids.push(user.managerId);
    return ids;
  }
  const ids = new Set<string>([user.id]);
  if (user.managerId) ids.add(user.managerId);
  return Array.from(ids);
}

const ZIP_REGEX = /^\d{5}(-\d{4})?$/;

function zipToCity(value: string): string {
  const trimmed = value.trim();
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
type RfpFieldType = "origin_city" | "origin_state" | "origin_zip" | "dest_city" | "dest_state" | "dest_zip" | "volume" | "equipment" | "lane_id" | "ignore";

type ConfirmedColumnMapping = Record<string, RfpFieldType>;

function analyzeRfpSpreadsheetWithMapping(workbook: XLSX.WorkBook, confirmedMapping: ConfirmedColumnMapping) {
  const sheetName = selectBestRfpSheet(workbook);
  const sheet = workbook.Sheets[sheetName];

  const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (rawAll.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], sheetName, analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0, isWeeklyVolume: false } };
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
    return { rows: [], headers: [], highVolumeLanes: [], sheetName, analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0, isWeeklyVolume: false } };
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

      highVolumeLanes.push({
        lane: laneDescription,
        laneId: laneName || "",
        origin: originCity || rawOriginZip || oState || "",
        destination: destCity || rawDestZip || dState || "",
        originState: oState,
        destinationState: dState,
        volume: rowVolume,
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
    requireAuth(req, res, next);
  });

  registerChatbotRoutes(app);

  app.get("/api/search", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const q = (req.query.q as string || "").trim();
      if (!q) return res.json({ accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [] });
      const [matchedCompanies, matchedUsers, matchedContacts, matchedRfps, allCompanies] = await Promise.all([
        storage.searchCompanies(q, req.session.organizationId!),
        storage.searchUsers(q, ["account_manager", "national_account_manager", "director", "sales"], req.session.organizationId!),
        storage.searchContacts(q),
        storage.searchRfps(q),
        storage.getCompanies(req.session.organizationId!),
      ]);
      const companyNameMap = new Map(allCompanies.map(c => [c.id, c.name]));
      const accounts = matchedCompanies.map(c => ({ id: c.id, name: c.name }));
      const accountManagers = matchedUsers.filter(u => u.role === "account_manager");
      const nationalAccountManagers = matchedUsers.filter(u => u.role === "national_account_manager" || u.role === "director");
      const contacts = matchedContacts.map(c => ({ id: c.id, name: c.name, title: c.title, companyId: c.companyId, companyName: companyNameMap.get(c.companyId) || "" }));
      const rfps = matchedRfps.map(r => ({ id: r.id, title: r.title, companyId: r.companyId, status: r.status }));
      res.json({ accounts, accountManagers, nationalAccountManagers, contacts, rfps });
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
      const { username, password, name, role, managerId } = req.body;
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
        await storage.createUser({ organizationId: req.session.organizationId!, username: email, password: hashedPassword, name, role, managerId: null });
        created.push(name);
      }

      res.json({ created, skipped, errors, total: rows.length });
    } catch (error) {
      console.error("Bulk import error:", error);
      res.status(500).json({ error: "Failed to import users" });
    }
  });

  app.patch("/api/users/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Access required" });
      }
      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        if (!teamIds.includes(req.params.id) || req.params.id === currentUser.id) {
          return res.status(403).json({ error: "Cannot edit this user" });
        }
      }
      const data: any = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.username !== undefined) data.username = req.body.username;
      if (req.body.email !== undefined) data.email = req.body.email || null;
      if (req.body.password) data.password = await bcrypt.hash(req.body.password, 10);
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
      const user = await storage.updateUser(req.params.id, currentUser.organizationId, data);
      if (!user) return res.status(404).json({ error: "User not found" });
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
        if (!teamIds.includes(req.params.id) || req.params.id === currentUser.id) {
          return res.status(403).json({ error: "Cannot delete this user" });
        }
      }
      if (req.params.id === currentUser.id) {
        return res.status(400).json({ error: "Cannot delete yourself" });
      }
      const deleted = await storage.deleteUser(req.params.id, currentUser.organizationId);
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
      const company = await storage.getCompanyInOrg(req.params.id, currentUser.organizationId);
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
      const parsed = insertCompanySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data: typeof parsed.data & { organizationId: string } = { ...parsed.data, organizationId: req.session.organizationId! };
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = insertCompanySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data = { ...parsed.data };
      if (currentUser.role !== "admin") {
        delete (data as any).assignedTo;
      }
      const company = await storage.updateCompany(req.params.id, currentUser.organizationId, data);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { financialAlias } = req.body;
      const company = await storage.updateCompany(req.params.id, currentUser.organizationId, { financialAlias: financialAlias || null } as any);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { salesPersonId } = req.body;
      const company = await storage.updateCompany(req.params.id, currentUser.organizationId, { salesPersonId: salesPersonId || null } as any);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
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
      const existing = await storage.getCompanyInOrg(req.params.id, currentUser.organizationId);
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const company = await storage.updateCompany(req.params.id, currentUser.organizationId, { ...existing, assignedTo });
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteCompany(req.params.id, currentUser.organizationId);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.archiveCompany(req.params.id, currentUser.organizationId);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.unarchiveCompany(req.params.id, currentUser.organizationId);
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
      if (!(await canAccessCompany(currentUser, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contacts = await storage.getContactsByCompany(req.params.companyId);
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
      if (!(await canAccessCompany(currentUser, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contactData = {
        ...req.body,
        companyId: req.params.companyId,
        createdAt: new Date().toISOString(),
        createdBy: currentUser.id,
      };
      const parsed = insertContactSchema.safeParse(contactData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const contact = await storage.createContact(parsed.data);
      const _orgIdForFanOut1 = req.session.organizationId!;
      storage.getCompanyInOrg(req.params.companyId, _orgIdForFanOut1).then(co => {
        fanOutCelebration(
          "new_contact",
          `🎉 New contact: ${contact.name}`,
          `${currentUser.name} added ${contact.name}${contact.title ? ` (${contact.title})` : ""} at ${co?.name ?? "an account"}.`,
          `/companies/${req.params.companyId}`,
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
      if (!(await canAccessCompany(currentUser, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows: any[] = req.body.contacts;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No contacts provided" });
      }
      const now = new Date().toISOString();
      const toInsert = rows.map(r => ({
        companyId: req.params.companyId,
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
      const existing = await storage.getContact(req.params.id);
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
      if (parsed.data.relationshipBase && parsed.data.relationshipBase !== existing.relationshipBase) {
        parsed.data.baseAdvancedAt = new Date().toISOString().split("T")[0];
        const oldRank = getBaseRank(existing.relationshipBase);
        const newRank = getBaseRank(parsed.data.relationshipBase);
        if (newRank > oldRank && newRank > 0) {
          const _orgIdForFanOut2 = req.session.organizationId!;
          storage.getCompanyInOrg(existing.companyId, _orgIdForFanOut2).then(co => {
            fanOutCelebration(
              "base_advanced",
              `🎉 Relationship advanced: ${parsed.data.name ?? existing.name}`,
              `${currentUser.name} moved ${parsed.data.name ?? existing.name} at ${co?.name ?? "an account"} from ${existing.relationshipBase ?? "no base"} → ${parsed.data.relationshipBase}.`,
              `/companies/${existing.companyId}`,
              req.params.id,
              currentUser.id,
              _orgIdForFanOut2
            );
          }).catch(() => {});
        }
      }
      const contact = await storage.updateContact(req.params.id, parsed.data);
      res.json(contact);
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/contacts/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getContact(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteContact(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contact:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.get("/api/rfps", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let rfps = await storage.getRfps();
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
- origin_state: State abbreviation for origin
- origin_zip: ZIP code for origin
- dest_city: City name for destination/delivery location  
- dest_state: State abbreviation for destination
- dest_zip: ZIP code for destination
- volume: Number of loads/shipments (annual or weekly)
- equipment: Equipment or trailer type (e.g. Van, Flatbed, Reefer)
- lane_id: Lane identifier or name
- ignore: Column is not relevant

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
        const validFields = new Set(["origin_city", "origin_state", "origin_zip", "dest_city", "dest_state", "dest_zip", "volume", "equipment", "lane_id", "ignore"]);
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
          result = analyzeRfpSpreadsheetWithMapping(workbook, confirmedMapping);
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
      };

      const rfp = await storage.createRfp(rfpData);
      res.status(201).json({ rfp, analysis: result.analysis, headers: result.headers, highVolumeLanes: result.highVolumeLanes, previewRows: result.rows.slice(0, 10), sheetName: result.sheetName });
    } catch (error) {
      console.error("Error uploading RFP:", error);
      res.status(500).json({ error: "Failed to process uploaded file" });
    }
  });

  app.patch("/api/rfps/:id", async (req, res) => {
    try {
      const existing = await storage.getRfp(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "RFP not found" });
      }
      const parsed = insertRfpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const rfp = await storage.updateRfp(req.params.id, parsed.data);
      res.json(rfp);
    } catch (error) {
      console.error("Error updating RFP:", error);
      res.status(500).json({ error: "Failed to update RFP" });
    }
  });

  app.patch("/api/rfps/:id/lanes/:laneIndex/status", async (req, res) => {
    try {
      const rfp = await storage.getRfp(req.params.id);
      if (!rfp) {
        return res.status(404).json({ error: "RFP not found" });
      }

      const laneIndex = parseInt(req.params.laneIndex);
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

      const updated = await storage.updateRfp(req.params.id, { ...rfp, fileData } as any);
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
      const companyId = req.params.id;
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
      const companyId = req.params.id;
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
      const deleted = await storage.deleteRfp(req.params.id);
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
      const existing = await storage.getAward(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Award not found" });
      }
      const parsed = insertAwardSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const award = await storage.updateAward(req.params.id, parsed.data);
      res.json(award);
    } catch (error) {
      console.error("Error updating award:", error);
      res.status(500).json({ error: "Failed to update award" });
    }
  });

  app.delete("/api/awards/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteAward(req.params.id);
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
      const entries = await storage.getMarketShareEntries(req.params.id);
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
      const company = await storage.getCompanyInOrg(req.params.id, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const customerName = (company.financialAlias || company.name).toLowerCase().trim();
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const allRows: any[] = uploads.flatMap(u => (u.rows as any[]) || []);

      const msCols = resolveColumns(allRows);
      // Filter rows matching this customer
      const matchedRows = allRows.filter(r => {
        const cust = getCustomerFromRow(r, msCols).toLowerCase();
        return cust === customerName || cust.includes(customerName) || customerName.includes(cust);
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
        companyId: req.params.id,
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
          companyId: req.params.id,
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
      const updated = await storage.updateMarketShareEntry(req.params.id, req.body);
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
      const deleted = await storage.deleteMarketShareEntry(req.params.id);
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
      if (!(await canAccessCompany(user, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyTasks = await storage.getTasksByCompany(req.params.companyId);
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
      const { title, notes, status, dueDate, assignedTo, companyId, contactId } = req.body;
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
      const existing = await storage.getTask(req.params.id);
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
      const task = await storage.updateTask(req.params.id, data);
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
      const existing = await storage.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: "Task not found" });
      if (existing.assignedBy !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the creator or admin can delete tasks" });
      }
      await storage.deleteTask(req.params.id);
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
      const comments = await storage.getTaskComments(req.params.id);
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
      const task = await storage.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found" });
      const comment = await storage.createTaskComment({
        taskId: req.params.id,
        authorId: user.id,
        content: content.trim(),
        createdAt: new Date().toISOString(),
        parentId: parentId || null,
      });
      // Notify task assignee, creator, and anyone who has previously commented (thread following)
      const existingComments = await storage.getTaskComments(req.params.id);
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
      const task = await storage.getTask(req.params.id);
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
      const comments = await storage.getTaskComments(req.params.taskId);
      const comment = comments.find(c => c.id === req.params.commentId);
      if (!comment) return res.status(404).json({ error: "Comment not found" });
      if (comment.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }
      await storage.deleteTaskComment(req.params.commentId);
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
      if (!(await canAccessCompany(user, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyCallouts = await storage.getCalloutsByCompany(req.params.companyId);
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
      const callout = await storage.getCallout(req.params.id);
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      if (callout.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete callouts" });
      }
      await storage.deleteCallout(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete callout" });
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
      const post = await storage.getFeedPost(req.params.id);
      if (!post) return res.status(404).json({ error: "Post not found" });
      if (post.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete posts" });
      }
      await storage.deleteFeedPost(req.params.id);
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
      const post = await storage.getFeedPost(req.params.id);
      if (!post) return res.status(404).json({ error: "Post not found" });
      const updated = await storage.pinFeedPost(req.params.id, !!req.body.pinned);
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
      const posts = await storage.getInternalPosts(user.id, user.role);
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
      await storage.deleteInternalPost(req.params.id);
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
      const callout = await storage.getCallout(req.params.id);
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      const result = await storage.toggleReaction(req.params.id, user.id, emoji);
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
      const post = await storage.getFeedPost(req.params.id);
      if (!post) return res.status(404).json({ error: "Feed post not found" });
      if (post.parentId) return res.status(400).json({ error: "Reactions are only allowed on top-level posts" });

      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      if (visibleAuthorIds && !visibleAuthorIds.includes(post.authorId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const result = await storage.toggleFeedPostReaction(req.params.id, user.id, emoji);
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
        sessionId: req.params.id,
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
      const updated = await storage.updateTopicStatus(req.params.id, status);
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
      const deleted = await storage.deleteTopic(req.params.id);
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
      const newSession = await storage.closeSession(req.params.id);
      res.json(newSession);
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
      const session = await storage.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingDate(req.params.id, meetingDate || null);
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
      const session = await storage.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingLink(req.params.id, normalizedLink);
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
      const session = await storage.getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.status !== "active") return res.status(400).json({ error: "Cannot update notes on an archived session" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionNotes(req.params.id, notes);
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
          return {
            amId: s.amId,
            sessionId: s.id,
            startDate: s.startDate,
            pendingCount: topics.filter(t => t.status === "pending").length,
            discussedCount: topics.filter(t => t.status === "discussed").length,
            totalCount: topics.length,
          };
        })
      );
      res.json(overview);
    } catch (error) {
      res.status(500).json({ error: "Failed to get manager overview" });
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

  // ── LM Development Milestones ──────────────────────────────────────────────
  // Stored in developmentGoals table as JSON { milestones: [...] }

  app.get("/api/lm-milestones/:lmId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { lmId } = req.params;
      const lm = await storage.getUser(lmId);
      if (!lm) return res.status(404).json({ error: "User not found" });
      const managerId = lm.managerId;
      const canAccess =
        viewer.id === lmId ||
        viewer.id === managerId ||
        viewer.role === "admin" ||
        viewer.role === "director";
      if (!canAccess) return res.status(403).json({ error: "Access denied" });
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
      const { lmId } = req.params;
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

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (uploads.length === 0) return res.json([]);

      // Use only the latest upload — it already contains merged historical + current month rows
      const latestHistUpload = uploads[uploads.length - 1];
      let allRows: any[] = Array.isArray(latestHistUpload.rows) ? latestHistUpload.rows as any[] : [];
      const histCols = resolveColumns(allRows);
      allRows = allRows.filter((r: any) => getStatusFromRow(r, histCols) !== "void" && !isExcludedRow(r, histCols));

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamUsers = (await storage.getUsers(req.session.organizationId!)).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, histCols);
          return teamNames.some(n => op.includes(n) || n.includes(op));
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

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (uploads.length === 0) return res.json([]);

      // Use only the latest upload — it already contains merged historical + current month rows
      const latestOppUpload = uploads[uploads.length - 1];
      let allRows: any[] = Array.isArray(latestOppUpload.rows) ? latestOppUpload.rows as any[] : [];
      const oppCols = resolveColumns(allRows);
      allRows = allRows.filter((r: any) => getStatusFromRow(r, oppCols) !== "void" && !isExcludedRow(r, oppCols));

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamUsers = (await storage.getUsers(req.session.organizationId!)).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          return teamNames.some(n => op.includes(n) || n.includes(op));
        });
      } else if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") {
        const userName = user.name.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          return op.includes(userName) || userName.includes(op);
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

      res.json(finalResults);
    } catch (error) {
      console.error("Error computing opportunities:", error);
      res.status(500).json({ error: "Failed to compute opportunities" });
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
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        rows = rows.filter((r: any) => {
          const op = getRepFromRow(r, finCols);
          return teamNames.some(n => op.includes(n) || n.includes(op));
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
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      const upload = uploads.find(u => u.id === req.params.id);
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
  async function linkSalespersonsFromRows(rows: any[]) {
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
    const allUsers = await storage.getUsers(req.session.organizationId!);
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
    const allCompanies = await storage.getCompanies(req.session.organizationId!);

    for (const company of allCompanies) {
      const alias = (company.financialAlias || "").toLowerCase().trim();
      const cname = company.name.toLowerCase().trim();

      // Try exact match first, then substring match (handles cases like
      // financial data key "gmccpomi - gmcca..." vs alias "gmccpomi")
      let tally = customerSalesMap.get(alias) || customerSalesMap.get(cname);
      if (!tally && alias.length >= 5) {
        for (const [mapKey, mapVal] of customerSalesMap) {
          if (mapKey.includes(alias) || alias.includes(mapKey)) { tally = mapVal; break; }
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
        await storage.updateCompany(company.id, req.session.organizationId!, { salesPersonId: matched.id });
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
      linkSalespersonsFromRows(sheets.rows).catch(err =>
        console.error("[salesperson-link] auto-link error:", err)
      );

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
      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json([]);
      const latest = uploads[uploads.length - 1];
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
        return res.json(Object.values(byCustomerRep));
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

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch account summary" });
    }
  });

  // ── Dispatcher summary (for Logistics Managers) ────────────────────────────
  app.get("/api/financials/dispatcher-summary", requireAuth, async (req, res) => {
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

      return res.json(Object.values(byDispatcher));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dispatcher summary" });
    }
  });

  // ── Salesperson summary (for Sales roles) ──────────────────────────────────
  app.get("/api/financials/salesperson-summary", requireAuth, async (req, res) => {
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
      storage.getFinancialUploadsForOrg(req.session.organizationId!).then(uploads => {
        if (uploads.length === 0) return;
        const latest = uploads[uploads.length - 1];
        linkSalespersonsFromRows((latest.rows as any[]) || []).catch(err =>
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

      const company = await storage.getCompanyInOrg(req.params.id, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
      if (!uploads.length) return res.json({ months: [], topDestinations: [], topCorridors: [], totalLoads: 0, spotLoads: 0, totalMargin: 0 });

      // Same normalize + nameMatches logic as the frontend
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const crmNorm = normalize(company.name);
      const aliasNorm = company.financialAlias ? normalize(company.financialAlias) : null;
      const nameMatches = (crmToTest: string, excelNorm: string) => {
        if (excelNorm === crmToTest) return true;
        const shorter = crmToTest.length <= excelNorm.length ? crmToTest : excelNorm;
        const longer  = crmToTest.length <= excelNorm.length ? excelNorm : crmToTest;
        return shorter.length >= 5 && longer.includes(shorter);
      };
      const rowMatchesCompany = (row: any) => {
        const custNorm = normalize(String(row["Customer"] || "").trim());
        if (!custNorm) return false;
        if (aliasNorm && nameMatches(aliasNorm, custNorm)) return true;
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
        const matched = (aliasNorm && nameMatches(aliasNorm, custNorm)) || nameMatches(crmNorm, custNorm);
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
      const companyId = req.params.id;
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
        const ams = allUsers.filter(u => amLikeRoles.includes(u.role) && u.managerId);
        // NAM↔AM pairings (deduplicated — only one loop)
        for (const am of ams) {
          pairs.push({ namId: am.managerId!, amId: am.id });
        }
        // Admin↔NAM direct pairings
        const nams = allUsers.filter(u => u.managerId === user.id && (u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director"));
        for (const nam of nams) {
          pairs.push({ namId: user.id, amId: nam.id });
        }
      } else {
        // NAM/Director: downward (ALL direct reports) + upward (their manager)
        const reports = allUsers.filter(u => u.managerId === user.id);
        for (const am of reports) pairs.push({ namId: user.id, amId: am.id });
        if (user.managerId) pairs.push({ namId: user.managerId, amId: user.id });
      }

      let count = 0;
      for (const { namId, amId } of pairs) {
        const session = await storage.getOrCreateActiveSession(namId, amId);
        const topics = await storage.getTopicsBySession(session.id);
        count += topics.filter(t => t.status === "pending").length;
      }
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
        const ams = allUsers.filter(u => amLikeRoles.includes(u.role) && u.managerId);
        for (const am of ams) pairs.push({ namId: am.managerId!, amId: am.id });
        const nams = allUsers.filter(u => u.managerId === user.id && (u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director"));
        for (const nam of nams) pairs.push({ namId: user.id, amId: nam.id });
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

      for (const { namId, amId } of pairs) {
        const session = await storage.getOrCreateActiveSession(namId, amId);
        const topics = await storage.getTopicsBySession(session.id);
        const actionItems = topics.filter(t => t.status === "pending" && (t.tag === "action_item" || t.tag === "Action Item"));
        for (const topic of actionItems) {
          const otherId = user.id === namId ? amId : namId;
          const otherUser = safeUsers.find(u => u.id === otherId);
          const addedByUser = safeUsers.find(u => u.id === topic.addedById);
          results.push({
            id: topic.id,
            text: topic.text,
            tag: topic.tag,
            status: topic.status,
            createdAt: topic.createdAt instanceof Date ? topic.createdAt.toISOString() : String(topic.createdAt),
            sessionId: session.id,
            addedById: topic.addedById,
            namId,
            amId,
            withUserName: otherUser?.name ?? "Unknown",
            addedByName: addedByUser?.name ?? "Unknown",
          });
        }
      }

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
        const ams = allUsers.filter(u => amLikeRoles2.includes(u.role) && u.managerId);
        for (const am of ams) pairs.push({ namId: am.managerId!, amId: am.id });
        const nams = allUsers.filter(u => u.managerId === user.id && (u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director"));
        for (const nam of nams) pairs.push({ namId: user.id, amId: nam.id });
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
        const nams = safeUsers.filter(u => u.managerId === currentUser.id && (u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director"));
        // Admin→NAM direct pairings first
        for (const nam of nams) {
          result.push({ namId: currentUser.id, amId: nam.id, namName: currentUser.name, amName: nam.name, section: "my_nams", groupLabel: nam.name });
        }
        // NAM→AM pairings grouped by NAM
        const amRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
        const ams = safeUsers.filter(u => amRoles.includes(u.role) && u.managerId);
        for (const am of ams) {
          const nam = safeUsers.find(u => u.id === am.managerId);
          if (nam) {
            result.push({ namId: nam.id, amId: am.id, namName: nam.name, amName: am.name, section: "team", groupLabel: nam.name });
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
      const existing = await storage.getTopic(req.params.id);
      if (!existing) return res.status(404).json({ error: "Topic not found" });
      if (!(await canAccessSession(currentUser, existing.sessionId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const topic = await storage.toggleTopicStatus(req.params.id);
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
      const existing = await storage.getTopic(req.params.id);
      if (!existing) return res.status(404).json({ error: "Topic not found" });
      if (!(await canAccessSession(currentUser, existing.sessionId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteTopic(req.params.id);
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
      const topic = await storage.getTopic(req.params.id);
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      const replies = await storage.getTopicReplies(req.params.id);
      res.json(replies);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch replies" });
    }
  });

  app.post("/api/one-on-one/topics/:id/replies", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const topic = await storage.getTopic(req.params.id);
      if (!topic) return res.status(404).json({ error: "Topic not found" });
      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ error: "Text required" });
      const reply = await storage.addTopicReply({
        topicId: req.params.id,
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
      const deleted = await storage.deleteTopicReply(req.params.id);
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
      if (!(await canAccessSession(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const closedSession = await storage.getSession(req.params.id);
      const newSession = await storage.closeSession(req.params.id);
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
      res.json({ session: newSession, topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to close session" });
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
      await storage.markNotificationRead(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notification read" });
    }
  });

  app.patch("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.markAllNotificationsRead(user.id);
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
      const deleted = await storage.deletePersonalAlert(req.params.id, user.id);
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
      const activity = await storage.getCompanyActivity(req.params.id);
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

  // ── Rep Progress Report ───────────────────────────────────────────────────
  app.post("/api/report/rep/:userId/send-email", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { userId } = req.params;
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
      const { userId } = req.params;
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
      const { userId } = req.params;
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
      const { userId } = req.params;
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
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        goalsList = await storage.getGoals({ namId: user.id });
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
        } else if (goal.metric === "margin" && latestUpload) {
          const amUser = allUsers.find(u => u.id === goal.amId);
          const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
          if (repKey) {
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
      const missing = await storage.getAmsMissingMonthlyGoals(namId);
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

      // All goals across the org (NAMs see company-wide leaderboard)
      const allGoals = await storage.getGoals({});
      const allUsers = await storage.getUsers(req.session.organizationId!);

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeGoals = allGoals.filter(g => g.startDate <= todayStr && g.endDate >= todayStr);

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
        } else if (goal.metric === "margin" && latestUpload) {
          const repKey = (amUser as any).financialRepId as string | null;
          if (repKey) {
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
      // AMs can only set goals for users who report directly to them
      if (user.role === "account_manager") {
        const allUsers = await storage.getUsers(req.session.organizationId!);
        const targetUser = allUsers.find(u => u.id === req.body.amId);
        if (!targetUser || targetUser.managerId !== user.id) {
          return res.status(403).json({ error: "You can only set goals for your direct reports" });
        }
      }
      const goal = await storage.createGoal({
        ...req.body,
        namId: user.role === "admin" ? (req.body.namId || user.id) : user.id,
        createdById: user.id,
        createdAt: new Date().toISOString(),
        currentValue: "0",
      });
      // Notify the AM that a goal has been set for them
      if (goal.amId && goal.amId !== user.id) {
        storage.createNotification({
          userId: goal.amId,
          type: "goal_set",
          title: `${user.name} set a goal for you`,
          body: goal.title,
          link: "/goals",
          relatedId: goal.id,
          read: false,
        }).catch(() => {});
      }
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
      const existing = await storage.getGoal(req.params.id);
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
      const updated = await storage.updateGoal(req.params.id, req.body);
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
          await storage.updateGoal(req.params.id, { status: "completed" }).catch(() => {});
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
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update goal" });
    }
  });

  app.delete("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal(req.params.id);
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      if (user.role !== "admin" && existing.namId !== user.id) return res.status(403).json({ error: "Access denied" });
      await storage.deleteGoal(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete goal" });
    }
  });

  app.get("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getGoalComments(req.params.id);
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/goals/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      const canComment = user.role === "admin" || goal.namId === user.id || goal.amId === user.id;
      if (!canComment) return res.status(403).json({ error: "Access denied" });
      const body = (req.body.body || req.body.text || "").trim();
      if (!body) return res.status(400).json({ error: "Comment body is required" });
      const comment = await storage.createGoalComment({
        goalId: req.params.id,
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
      await storage.deleteGoalComment(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });

  app.get("/api/goals/:id/progress", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const goal = await storage.getGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      let autoValue: number | null = null;
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const targetUser = allUsers.find(u => u.id === goal.amId);
      const isLMGoal = targetUser?.role === "logistics_manager";

      if (goal.metric === "contacts_added") {
        autoValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
      } else if (goal.metric === "touchpoints") {
        autoValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
      } else if (goal.metric === "loads_booked" || goal.metric === "margin_pct" || (goal.metric === "margin" && isLMGoal)) {
        // LM metrics — computed from the Dispatcher column in transaction rows
        const repKey = targetUser ? (targetUser as any).financialRepId as string | null : null;
        if (repKey) {
          const uploads = await storage.getFinancialUploadsForOrg(req.session.organizationId!);
          if (uploads.length) {
            const latest = uploads[uploads.length - 1];
            const txRows: any[] = (latest.rows as any[]) || [];
            const cols = resolveColumns(txRows);
            const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
            const repKeyLower = repKey.toLowerCase();
            let count = 0;
            let totalMargin = 0;
            let totalCharges = 0;
            for (const row of txRows) {
              if (isExcludedRow(row, cols)) continue;
              const disp = getDispatcherFromRow(row, cols).toLowerCase();
              if (disp !== repKeyLower) continue;
              if (goalMonthKey) {
                const { monthKey } = parseHistoricalRow(row, cols);
                if (monthKey !== goalMonthKey) continue;
              }
              count++;
              totalMargin += Number(row[cols.marginDollar] || row["Margin $"] || 0);
              totalCharges += Number(row[cols.totalCharges] || row["Total charges"] || 0);
            }
            if (goal.metric === "loads_booked") autoValue = count;
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
      const goal = await storage.getGoal(req.params.id);
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
      const byMonth: Record<string, number> = {};
      for (const row of txRows) {
        if (isExcludedRow(row, trendCols)) continue;
        const { monthKey, margin } = parseHistoricalRow(row, trendCols);
        if (!monthKey) continue;
        const rep = getRepFromRow(row, trendCols);
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

  app.get("/api/contacts/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const tps = await storage.getTouchpointsByContact(req.params.id);
      res.json(tps);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch touchpoints" });
    }
  });

  app.post("/api/contacts/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const contact = await storage.getContact(req.params.id);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      const now = new Date();
      const tp = await storage.createTouchpoint({
        contactId: req.params.id,
        companyId: contact.companyId,
        type: req.body.type || "call",
        date: req.body.date || now.toISOString().split("T")[0],
        notes: req.body.notes || null,
        sentiment: req.body.sentiment || null,
        isMeaningful: req.body.isMeaningful === true || req.body.isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      res.json(tp);
    } catch (error) {
      res.status(500).json({ error: "Failed to create touchpoint" });
    }
  });

  app.delete("/api/touchpoints/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteTouchpoint(req.params.id);
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
        storage.getCompanyInOrg(req.params.id, user.organizationId),
        storage.getTouchpointsByCompany(req.params.id),
        storage.getContactsByCompany(req.params.id),
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
      const companyRfps = allRfps.filter(r => r.companyId === req.params.id);
      const companyAwards = allAwards.filter(a => a.companyId === req.params.id);
      const activeRfp = companyRfps.find(r => r.status === "open" || r.status === "pending");
      const hasAward = companyAwards.length > 0;
      const rfpScore = activeRfp ? 10 : 0;
      const awardScore = hasAward ? 5 : 0;
      const rfpLabel = activeRfp ? `Active RFP: ${activeRfp.title}` : hasAward ? "Award on file (no active RFP)" : "No active RFP or award";

      // Factor 5: Financial data presence (10 pts)
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const crmNorm = normalize(company.name);
      const aliasNorm = company.financialAlias ? normalize(company.financialAlias) : null;
      let hasFinancialData = false;
      let totalLoadsYtd = 0;
      for (const upload of uploads) {
        const rows = (upload.rows as any[]) || [];
        for (const row of rows) {
          const custName = normalize(String(row.customerName || ""));
          if (custName === crmNorm || (aliasNorm && custName === aliasNorm)) {
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

      res.json({
        score: total,
        grade,
        color,
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

  app.get("/api/config/claims-url", requireAuth, async (req, res) => {
    res.json({ url: process.env.CLAIMS_PORTAL_URL || null });
  });

  app.get("/api/companies/:id/touchpoints", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const tps = await storage.getTouchpointsByCompany(req.params.id);
      res.json(tps);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company touchpoints" });
    }
  });

  app.get("/api/companies/:id/touch-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, req.params.id))) return res.status(403).json({ error: "Access denied" });
      const tps = await storage.getTouchpointsByCompany(req.params.id);
      const allUsers = await storage.getUsers(req.session.organizationId!);
      const contactsList = await storage.getContactsByCompany(req.params.id);
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
      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      const weekStr = weekAgo.toISOString().slice(0, 10);
      const monthStr = monthAgo.toISOString().slice(0, 10);

      const all = await storage.getTouchpoints();
      const summary: Record<string, { week: number; month: number }> = {};
      for (const tp of all) {
        if (!summary[tp.companyId]) summary[tp.companyId] = { week: 0, month: 0 };
        if (tp.date >= monthStr) summary[tp.companyId].month++;
        if (tp.date >= weekStr) summary[tp.companyId].week++;
      }
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch touchpoint summary" });
    }
  });

  app.get("/api/dashboard/cold-contacts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      if (user.role === "admin") {
        const results = await storage.getColdContacts(null, days);
        return res.json(results);
      }
      if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const results = await storage.getColdContacts(null, days, teamIds);
        return res.json(results);
      }
      const results = await storage.getColdContacts(user.id, days);
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
      if (user.role === "admin") {
        const results = await storage.getMeaningfulOverdueContacts(null, days);
        return res.json(results);
      }
      if (user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const results = await storage.getMeaningfulOverdueContacts(null, days, teamIds);
        return res.json(results);
      }
      const results = await storage.getMeaningfulOverdueContacts(user.id, days);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch meaningful overdue contacts" });
    }
  });

  app.get("/api/dashboard/opportunity-leaderboard", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const companies = await storage.getCompanies(req.session.organizationId!);
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

        const aliasNorm = normalize((company as any).financialAlias || company.name);
        const fin = byCustomer[aliasNorm] ||
          Object.entries(byCustomer).find(([k]) => k.includes(aliasNorm) || aliasNorm.includes(k))?.[1];

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

      const all = await storage.getTouchpoints();
      const thisWeek = all.filter(t => t.date >= weekStart);

      const teamIds: string[] | null = (user.role === "admin" || user.role === "director" || user.role === "sales_director")
        ? null
        : await storage.getTeamMemberIds(user.id, user.organizationId);

      const filtered = teamIds === null ? thisWeek : thisWeek.filter(t => t.loggedById && (teamIds.includes(t.loggedById) || t.loggedById === user.id));

      const byUser: Record<string, { userId: string; name: string; total: number; call: number; email: number; text: number; site_visit: number; meaningful: number }> = {};
      const allUsers = await storage.getUsers();
      const userMap: Record<string, string> = {};
      for (const u of allUsers) userMap[u.id] = `${u.firstName} ${u.lastName}`.trim() || u.username;

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

  async function canAccessAttachmentEntity(user: { id: string; role: string; managerId: string | null }, entityType: string, entityId: string): Promise<boolean> {
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
        const contact = await storage.getContact(tp.contactId);
        if (!contact) return false;
        return canAccessCompany(user, contact.companyId);
      }
      if (entityType === "one_on_one_topic") {
        const topic = await storage.getTopic(entityId);
        if (!topic) return false;
        return canAccessSession(user, topic.sessionId);
      }
      if (entityType === "scorecard") {
        if (user.role === "admin") return true;
        return canAccessCompany(user, entityId);
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
      const att = await storage.getAttachment(req.params.id);
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
      const att = await storage.getAttachment(req.params.id);
      if (!att) return res.status(404).json({ error: "Attachment not found" });
      if (!(await canAccessAttachmentEntity(user, att.entityType, att.entityId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteAttachment(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete attachment" });
    }
  });

  app.get("/api/companies/:id/vendor-routed", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows = await storage.getVendorRoutedByCompany(req.params.id);
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
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { rowKey } = req.body;
      if (!rowKey || typeof rowKey !== "string") {
        return res.status(400).json({ error: "rowKey is required" });
      }
      const result = await storage.toggleVendorRouted(req.params.id, rowKey);
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
      const passoff = await storage.getPtoPassoff(req.params.id);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.updatePtoPassoff(req.params.id, req.body);
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
      const passoff = await storage.getPtoPassoff(req.params.id);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deletePtoPassoff(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete PTO passoff" });
    }
  });

  app.post("/api/pto-passoffs/:id/items", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const passoff = await storage.getPtoPassoff(req.params.id);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      const item = await storage.createPtoPassoffItem({
        passoffId: req.params.id,
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
      const passoff = await storage.getPtoPassoff(req.params.id);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      const isCovering = passoff.coveringUserId === currentUser.id;
      const isOwner = passoff.createdById === currentUser.id;
      const isAdmin = currentUser.role === "admin";
      if (!isOwner && !isCovering && !isAdmin) return res.status(403).json({ error: "Access denied" });
      // Covering user can only update acknowledged field
      const allowedFields = isOwner || isAdmin ? req.body : { acknowledged: req.body.acknowledged };
      const updated = await storage.updatePtoPassoffItem(req.params.itemId, allowedFields);
      // Notify passoff owner when covering person acknowledges an account
      const justAcknowledged = req.body.acknowledged === true && isCovering && !isOwner;
      if (justAcknowledged && passoff.createdById !== currentUser.id) {
        (async () => {
          const items = await storage.getPtoPassoffItems(req.params.id);
          const item = items.find(i => i.id === req.params.itemId);
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
      const passoff = await storage.getPtoPassoff(req.params.id);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && currentUser.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deletePtoPassoffItem(req.params.itemId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete passoff item" });
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
      if (c.financialAlias) s.add(normAlias(c.financialAlias));
    }
    return s;
  }

  // Returns the effective owner ID for a company: prefer salesPersonId (financial linkage), fall back to assignedTo (CRM assignment)
  function companyOwnerId(c: any): string | null {
    return c.salesPersonId || c.assignedTo || null;
  }

  function getNamTeamCompanies(namId: string, allUsers: any[], allCompanies: any[]): any[] {
    const directReportIds = new Set(allUsers.filter((u: any) => u.managerId === namId).map((u: any) => u.id));
    directReportIds.add(namId); // include companies directly assigned to the NAM
    return allCompanies.filter((c: any) => {
      const owner = companyOwnerId(c);
      return owner && directReportIds.has(owner);
    });
  }

  // Helper: get companies owned by a specific AM
  function getAmCompanies(amId: string, allCompanies: any[]): any[] {
    return allCompanies.filter((c: any) => companyOwnerId(c) === amId);
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
    return allCompanies.filter((c: any) => {
      const owner = companyOwnerId(c);
      return owner && allScopedRepIds.has(owner);
    });
  }

  // Trending accounts — top 5 up, top 5 down by margin delta vs prior month
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
      }

      // Determine current and prior month from the data, not calendar month
      const sortedMonthKeys = Array.from(allMonthKeys).sort();
      const curMonthKey = sortedMonthKeys.length > 0 ? sortedMonthKeys[sortedMonthKeys.length - 1] : toMonthKey(new Date());
      const priorIdx = sortedMonthKeys.indexOf(curMonthKey) - 1;
      const priorMonthKey = priorIdx >= 0 ? sortedMonthKeys[priorIdx] : (() => {
        const [yr, mo] = curMonthKey.split("-").map(Number);
        const priorDate = new Date(yr, mo - 2, 1);
        return toMonthKey(priorDate);
      })();

      // Build delta list
      const deltas: { alias: string; delta: number; curMargin: number; priorMargin: number }[] = [];
      for (const [alias, monthMap] of Object.entries(byCustomerMonth)) {
        const cur = monthMap[curMonthKey] ?? null;
        const prior = monthMap[priorMonthKey] ?? null;
        if (cur === null || prior === null) continue;
        deltas.push({ alias, delta: cur - prior, curMargin: cur, priorMargin: prior });
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

      const resolveCompanyName = (alias: string): string => {
        const norm = normAlias(alias);
        const match = allCompanies.find(c => {
          const cn = normAlias(c.financialAlias || c.name);
          return cn === norm || cn.includes(norm) || norm.includes(cn);
        });
        return match?.name || alias;
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
      const up = filteredDeltas.slice(0, 5).filter(d => d.delta > 0).map(d => ({
        name: resolveCompanyName(d.alias),
        delta: d.delta,
      }));
      const down = [...filteredDeltas].sort((a, b) => a.delta - b.delta).slice(0, 5).filter(d => d.delta < 0).map(d => ({
        name: resolveCompanyName(d.alias),
        delta: d.delta,
      }));

      res.json({ up, down });
    } catch (err) {
      console.error("Error computing trending accounts:", err);
      res.status(500).json({ error: "Failed to compute trending accounts" });
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

      res.json({
        nams: isNamRole ? [] : buildMetrics(namRoles),
        ams: buildMetrics(amRoles),
      });
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

  // Daily briefing data
  app.get("/api/dashboard/briefing", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const today = new Date().toISOString().slice(0, 10);
      const [allTasks, allCompanies, tps, streak] = await Promise.all([
        storage.getTasks(),
        storage.getCompanies(req.session.organizationId!),
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
      ]);

      const myCompanyIds = new Set(allCompanies.filter(c => c.salesPersonId === user.id || user.role === "admin").map(c => c.id));
      const dueTasks = allTasks.filter(t => t.assignedTo === user.id && t.status === "open" && t.dueDate && t.dueDate <= today);
      const todayTouchpoints = tps.length;

      res.json({
        dueTasks: dueTasks.length,
        todayTouchpoints,
        streak: streak.streak,
        streakGoal: streak.goal,
        streakToday: streak.todayCount,
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
      const { fromRole, toRole } = req.params;
      const validRoles = ["logistics_manager", "account_manager", "national_account_manager"];
      if (!validRoles.includes(fromRole) || !validRoles.includes(toRole)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      const { minLoadCount, minMarginPct, minTouchpoints, minTenureMonths, notes } = req.body;
      const safeNum = (v: any) => (v != null && v !== "" ? Number(v) : null);
      const data = {
        minLoadCount: safeNum(minLoadCount),
        minMarginPct: safeNum(minMarginPct),
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
      const deleted = await storage.deletePromotionCriteria(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Criteria not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete promotion criteria" });
    }
  });

  // ─── Promotion Nominations ────────────────────────────────────────────────────

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
      if (user.id !== req.params.nomineeId && !nominationAllowedRoles.includes(user.role)) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const nominations = await storage.getNominationsByNominee(req.params.nomineeId);
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
      res.json(nomination);
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
      const updated = await storage.updatePromotionNomination(req.params.id, allowedFields);
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
      const deleted = await storage.deletePromotionNomination(req.params.id);
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
      const link = await storage.updateToolLink(req.params.id, req.body);
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
      await storage.deleteToolLink(req.params.id);
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
      const company = await storage.getCompanyInOrg(req.params.id, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const now = new Date();
      const tp = await storage.createTouchpoint({
        contactId: req.body.contactId || null,
        companyId: req.params.id,
        type: req.body.type || "call",
        date: req.body.date || now.toISOString().split("T")[0],
        notes: req.body.notes || null,
        sentiment: req.body.sentiment || null,
        isMeaningful: req.body.isMeaningful === true || req.body.isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      res.json(tp);
    } catch (error) {
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
      const tp = await storage.createTouchpoint({
        contactId: contactId || null,
        companyId,
        type: type || "call",
        date: now.toISOString().split("T")[0],
        notes: typeof notes === "string" ? notes.slice(0, 2000) || null : null,
        sentiment: sentiment || null,
        isMeaningful: isMeaningful === true || isMeaningful === "true" ? true : false,
        loggedById: user.id,
        createdAt: now.toISOString(),
      });
      res.json(tp);
    } catch (error) {
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

      const { lmUserId } = req.params;
      const lmUser = await storage.getUser(lmUserId);
      if (!lmUser || lmUser.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "User not found" });
      }

      // LM can see their own checks; managers (anyone in chain above) can also see
      const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
      const isManagerOf = teamIds.includes(lmUserId);
      const isSelf = user.id === lmUserId;
      const isAdmin = user.role === "admin";
      if (!isSelf && !isManagerOf && !isAdmin) {
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

      const { lmUserId } = req.params;
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

  app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File is too large. Maximum size is 50MB." });
      }
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });

  return httpServer;
}
