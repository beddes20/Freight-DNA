import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerChatbotRoutes } from "./chatbot";
import { registerTaskRoutes } from "./routes/tasks";
import { registerEngagementRoutes } from "./routes/engagement";
import { registerCoachingRoutes } from "./routes/coaching";
import { registerProspectRoutes } from "./routes/prospects";
import { registerFinancialRoutes } from "./routes/financials";
import { registerLoadFactRoutes } from "./routes/loadFact";
import { registerCarrierIntelligenceScoringRoutes } from "./routes/carrierIntelligenceScoring";
import { registerCarrierIntelligencePrefsRoutes } from "./routes/carrierIntelligencePrefs";
import { registerGoalRoutes } from "./routes/goals";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerForcedFocusRoutes } from "./routes/forcedFocus";
import { registerLaneCarrierOutreachRoutes } from "./routes/laneCarrierOutreach";
import { registerCarrierHubRoutes } from "./routes/carrierHub";
import { registerMyProcurementRoutes } from "./routes/myProcurement";
import { registerProcurementOutreachRoutes } from "./routes/procurementOutreach";
import { registerProactiveOpportunityRoutes } from "./routes/proactiveOpportunities";
import { registerIntelRoutes } from "./routes/intel";
import { registerGraphWebhookRoutes } from "./routes/graphWebhook";
import { registerMarketSignalRoutes } from "./routes/marketSignals";
import { registerEmailIntelligenceRoutes } from "./routes/emailIntelligence";
import { registerConversationsRoutes } from "./routes/conversations";
import { registerProvenTacticsRoutes } from "./routes/provenTactics";
import { registerPlaybookRoutes } from "./routes/playbook";
import { registerEmailAnalyticsRoutes } from "./routes/emailAnalytics";
import { registerGeographicResponsibilitiesRoutes } from "./routes/geographicResponsibilities";
import { registerContactGeographySuggestionRoutes } from "./routes/contactGeographySuggestions";
import { registerSonarRoutes } from "./routes/sonar";
import { registerCallIntelligenceRoutes } from "./routes/callIntelligence";
import { registerAIIntelligenceRoutes } from "./routes/aiIntelligence";
import { getPlayForRuleType } from "./playsRegistry";
import { registerEmailDraftingRoutes } from "./routes/emailDrafting";
import { registerNbaReadyToActRoutes } from "./routes/nbaReadyToAct";
import { registerMonitoredMailboxRoutes } from "./routes/monitoredMailboxes";
import { registerWebexRoutes } from "./routes/webex";
import { registerCallTrendlineRoutes } from "./routes/callTrendlines";
import { readFileSync } from "fs";
import { join } from "path";
import multer from "multer";
import XLSX from "xlsx";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds, canAccessCompany } from "./auth";
import { isAdmin, isLeadership } from "./lib/roles";
import { projectNbaCard, collectProjectionIds } from "./lib/nbaCardProjection";
import { geocodeCity, haversineDistance } from "./geocoding";
import { insertCompanySchema, insertContactSchema, insertRfpSchema, insertAwardSchema, insertTaskSchema, userRoles, insertCalloutSchema, insertFeedPostSchema, type Callout, insertOneOnOneTopicSchema, type User, sharedRepSchema, type SharedRep, contactBaseHistory, insertLaneCarrierSchema, internalPosts as internalPostsTable, emailMessages, emailSignals, onboardingMilestoneToggleSchema, type OnboardingMilestones, upsertSidebarTooltipSchema, type Contact, type RecurringLane } from "@shared/schema";
import { normalizeLaneLocation, normalizeEquipmentType } from "@shared/laneFormatters";
import { performOneDriveSync } from "./monthlyDataRefreshScheduler";
import { resolveColumns, getRepFromRow, getDispatcherFromRow, getSalespersonFromRow, getStatusFromRow, getCustomerFromRow, type FinancialCols } from "./colResolver";
import { isExcludedRow, parseHistoricalRow, isBadSummaryData, computeLoadsForRepGoal, extractSheetsFromWorkbook, toMonthKey } from "./financialHelpers";
import { analyzeTouchpointNote } from "./aiTouchpoint";
import { computeGrowthScore } from "./growthScoreCalculator";
import { checkAndFireMomentumDropNotification } from "./momentumNotifications";
import { computeNextBestAction } from "./nextBestActionEngine";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "./cache";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { db } from "./storage";
import { sql, eq, and, desc, inArray } from "drizzle-orm";

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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── NBA in-process cache ────────────────────────────────────────────────────
  // Declared here (top of registerRoutes) so all touchpoint POST routes can
  // delete stale keys immediately after a new touchpoint is saved, rather than
  // waiting up to 30 min for the TTL to expire naturally.
  const _nbaCache = new Map<string, { result: unknown; expiresAt: number }>();
  const NBA_TTL_MS = 30 * 60 * 1000; // 30 minutes

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    if (req.path === "/config/public" && req.method === "GET") return next();
    if (req.path === "/demo-requests" && req.method === "POST") return next();
    // Public Stripe endpoints (no auth required — landing page checkout flow)
    if (req.path === "/stripe/config" && req.method === "GET") return next();
    if (req.path === "/stripe/products" && req.method === "GET") return next();
    if (req.path === "/stripe/checkout" && req.method === "POST") return next();
    if (req.path === "/stripe/confirm-checkout" && req.method === "GET") return next();
    if (req.path === "/marketing-chat" && req.method === "POST") return next();
    // Outlook reply webhook — Microsoft Graph calls this endpoint directly (no session cookie)
    // Security is handled by clientState secret validation inside the handler
    if (req.path === "/webhooks/outlook-reply") return next();
    // Microsoft Graph webhook endpoints — public (Graph calls without session cookies)
    if (req.path.startsWith("/webhooks/graph/")) return next();
    // Internal service endpoints — can be accessed via INTERNAL_SERVICE_TOKEN header
    // (machine-to-machine) or by an authenticated user session (browser clients).
    if (req.path.startsWith("/internal/")) {
      const token = process.env.INTERNAL_SERVICE_TOKEN;
      const provided = req.headers["x-internal-token"];
      if (token && provided === token) {
        return next(); // Valid service-to-service token — skip session check
      }
      // Fall through to normal session-based requireAuth for browser clients
      return requireAuth(req, res, next);
    }
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

  // PUBLIC — no requireAuth. This endpoint is called from the marketing landing
  // page by unauthenticated visitors. It only accesses the AI model, never any
  // org data. Rate limiting via OpenAI token cap (max_tokens: 400).
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

  app.get("/api/search", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const q = (req.query.q as string || "").trim();
      if (!q) return res.json({ accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [], tasks: [], carriers: [] });
      const [matchedCompanies, matchedUsers, matchedContacts, matchedRfps, matchedTasks, allCompanies, matchedCarriers] = await Promise.all([
        storage.searchCompanies(q, req.session.organizationId!),
        storage.searchUsers(q, ["account_manager", "national_account_manager", "director", "sales"], req.session.organizationId!),
        storage.searchContacts(q, req.session.organizationId!),
        storage.searchRfps(q, req.session.organizationId!),
        storage.searchTasks(q, req.session.organizationId!),
        storage.getCompanies(req.session.organizationId!),
        storage.searchCarriers(q, req.session.organizationId!),
      ]);
      const companyNameMap = new Map(allCompanies.map(c => [c.id, c.name]));
      const accounts = matchedCompanies.map(c => ({ id: c.id, name: c.name }));
      const accountManagers = matchedUsers.filter(u => u.role === "account_manager");
      const nationalAccountManagers = matchedUsers.filter(u => u.role === "national_account_manager" || u.role === "director");
      const contacts = matchedContacts.map(c => ({ id: c.id, name: c.name, title: c.title, companyId: c.companyId, companyName: companyNameMap.get(c.companyId) || "" }));
      const rfps = matchedRfps.map(r => ({ id: r.id, title: r.title, companyId: r.companyId, status: r.status }));
      const tasks = matchedTasks.map(t => ({ id: t.id, title: t.title, status: t.status, companyId: t.companyId || null, companyName: t.companyId ? (companyNameMap.get(t.companyId) || "") : "" }));
      const carriers = matchedCarriers.map(c => ({ id: c.id, name: c.name, mcDot: c.mcDot, state: c.state }));
      res.json({ accounts, accountManagers, nationalAccountManagers, contacts, rfps, tasks, carriers });
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

  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      const allRoles = [...managerRoles, "account_manager", "logistics_manager", "logistics_coordinator"];
      const withManagers = req.query.includeManagers === "true";

      // Lower-level roles may only call this endpoint when explicitly fetching their coverage chain
      if (!allRoles.includes(currentUser.role) || (!managerRoles.includes(currentUser.role) && !withManagers)) {
        return res.status(403).json({ error: "Access required" });
      }

      const allUsers = await storage.getUsers(req.session.organizationId!);
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      if (currentUser.role === "admin") return res.json(safeUsers);

      const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
      if (withManagers) {
        const managerIds = await storage.getManagerChainIds(currentUser.id, currentUser.organizationId);
        const allIds = Array.from(new Set([...teamIds, ...managerIds]));
        return res.json(safeUsers.filter(u => allIds.includes(u.id)));
      }
      return res.json(safeUsers.filter(u => teamIds.includes(u.id)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.post("/api/users", requireAuth, async (req, res) => {
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

  app.post("/api/users/bulk-import", requireAuth, upload.single("file"), async (req, res) => {
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
  app.get("/api/import-templates/:type", requireAuth, async (req, res) => {
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
  app.post("/api/companies/bulk-import", requireAuth, upload.single("file"), async (req, res) => {
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
  app.post("/api/contacts/bulk-import", requireAuth, upload.single("file"), async (req, res) => {
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

  app.patch("/api/users/:id", requireAuth, async (req, res) => {
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

  app.delete("/api/users/:id", requireAuth, async (req, res) => {
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

  app.get("/api/companies", requireAuth, async (req, res) => {
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

  app.get("/api/companies/:id", requireAuth, async (req, res) => {
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

  app.get("/api/team-members", requireAuth, async (req, res) => {
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

  app.post("/api/companies", requireAuth, async (req, res) => {
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

  app.patch("/api/companies/:id", requireAuth, async (req, res) => {
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
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, { financialAlias: financialAlias || null });
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
      const company = await storage.updateCompany((req.params.id as string), currentUser.organizationId, { salesPersonId: salesPersonId || null });
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update salesperson" });
    }
  });

  app.patch("/api/companies/:id/reassign", requireAuth, async (req, res) => {
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

  // ── Customer Email Signals for a Company ─────────────────────────────────
  app.get("/api/companies/:id/email-signals", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = req.params.id as string;
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
      const rows = await db
        .select({
          signalId: emailSignals.id,
          intentType: emailSignals.intentType,
          intentSubtype: emailSignals.intentSubtype,
          actorType: emailSignals.actorType,
          confidence: emailSignals.confidence,
          extractedData: emailSignals.extractedData,
          signalCreatedAt: emailSignals.createdAt,
          messageId: emailMessages.id,
          direction: emailMessages.direction,
          fromEmail: emailMessages.fromEmail,
          toEmail: emailMessages.toEmail,
          subject: emailMessages.subject,
          messageCreatedAt: emailMessages.createdAt,
          threadId: emailMessages.threadId,
        })
        .from(emailSignals)
        .innerJoin(emailMessages, eq(emailSignals.messageId, emailMessages.id))
        .where(and(eq(emailMessages.linkedAccountId, companyId), eq(emailMessages.orgId, currentUser.organizationId)))
        .orderBy(desc(emailSignals.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      console.error("[email-signals] company route error:", err);
      res.status(500).json({ error: "Failed to fetch email signals" });
    }
  });

  app.delete("/api/companies/:id", requireAuth, async (req, res) => {
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

  // ── Pinned Companies (Task #206) ─────────────────────────────────────────
  app.get("/api/pinned-companies", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const pinned = await storage.getPinnedCompanies(currentUser.id);
      res.json(pinned);
    } catch (error) {
      res.status(500).json({ error: "Failed to get pinned companies" });
    }
  });

  app.post("/api/pinned-companies/:companyId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = req.params.companyId as string;
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Enforce max 10 pinned accounts
      const existing = await storage.getPinnedCompanies(currentUser.id);
      const alreadyPinned = existing.some(p => p.companyId === companyId);
      if (!alreadyPinned && existing.length >= 10) {
        return res.status(400).json({ error: "Maximum of 10 pinned accounts allowed" });
      }
      const pinned = await storage.pinCompany(currentUser.id, companyId);
      res.json(pinned);
    } catch (error) {
      res.status(500).json({ error: "Failed to pin company" });
    }
  });

  app.delete("/api/pinned-companies/:companyId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = req.params.companyId as string;
      await storage.unpinCompany(currentUser.id, companyId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to unpin company" });
    }
  });

  app.post("/api/companies/:id/archive", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:id/unarchive", requireAuth, async (req, res) => {
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

  // ── Onboarding Milestones ──────────────────────────────────────────────────
  app.patch("/api/companies/:id/onboarding-milestones", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = onboardingMilestoneToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid milestone payload", details: parsed.error.flatten() });
      }
      const { milestoneId, completed } = parsed.data;
      const existing = await storage.getCompany(req.params.id);
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const stored = existing.onboardingMilestones;
      const current: OnboardingMilestones =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? { ...(stored as OnboardingMilestones) }
          : {};
      current[milestoneId] = completed;
      const updated = await storage.updateCompany(req.params.id, currentUser.organizationId, {
        onboardingMilestones: current,
      });
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update onboarding milestones" });
    }
  });

  app.get("/api/contacts", requireAuth, async (req, res) => {
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

  app.get("/api/companies/:companyId/contacts", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:companyId/contacts", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:companyId/contacts/bulk-import", requireAuth, async (req, res) => {
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

  app.patch("/api/contacts/:id", requireAuth, async (req, res) => {
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
      // Allow companyId to change if provided; fall back to existing value
      const newCompanyId = req.body.companyId && req.body.companyId !== existing.companyId
        ? req.body.companyId
        : existing.companyId;
      // If company is changing, verify the user can also access the destination company
      if (newCompanyId !== existing.companyId) {
        if (!(await canAccessCompany(currentUser, newCompanyId))) {
          return res.status(403).json({ error: "Access denied to destination company" });
        }
      }
      const contactData = {
        ...req.body,
        companyId: newCompanyId,
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
      // B3 fix: if company changed, re-attribute historical touchpoints then refresh growth scores
      // Must await the cascade before recomputing so scores reflect the correct touchpoint set.
      if (newCompanyId !== existing.companyId) {
        try {
          await storage.updateTouchpointCompanyByContact((req.params.id as string), newCompanyId);
        } catch (err) {
          console.error("[contact-update] touchpoint company cascade failed:", err);
        }
        // After cascade completes, refresh growth scores for both companies (async, non-blocking)
        const orgId = req.session.organizationId!;
        Promise.all([
          computeGrowthScore(existing.companyId, orgId, storage).then(gs =>
            storage.upsertGrowthScore({ companyId: existing.companyId, organizationId: orgId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() })
          ),
          computeGrowthScore(newCompanyId, orgId, storage).then(gs =>
            storage.upsertGrowthScore({ companyId: newCompanyId, organizationId: orgId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() })
          ),
        ]).catch(err => {
          console.error("[contact-update] growth score refresh after company change failed:", err);
        });
      }
      res.json({ ...contact });
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/contacts/:id", requireAuth, async (req, res) => {
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
  app.get("/api/rfps/lane-search", requireAuth, async (req, res) => {
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

  app.get("/api/rfps", requireAuth, async (req, res) => {
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

  app.post("/api/rfps", requireAuth, async (req, res) => {
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

  app.post("/api/rfps/preview-headers", requireAuth, upload.single("file"), async (req, res) => {
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

  app.post("/api/rfps/parse-file", requireAuth, upload.single("file"), async (req, res) => {
    try {
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

      const result = analyzeRfpSpreadsheet(workbook);

      return res.json({
        fileName: req.file.originalname,
        fileData: { rows: result.rows, highVolumeLanes: result.highVolumeLanes, sheetName: result.sheetName },
        laneCount: result.analysis.laneCount,
        totalVolume: result.analysis.totalVolume,
        originStates: result.analysis.originStates,
        destinationStates: result.analysis.destinationStates,
      });
    } catch (error) {
      console.error("Error parsing RFP file:", error);
      res.status(500).json({ error: "Failed to parse file" });
    }
  });

  app.post("/api/rfps/upload", requireAuth, upload.single("file"), async (req, res) => {
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

      // Auto-create a coverage-review task for the AM when the upload has extracted lanes.
      // Non-fatal: a task creation failure must never block the upload response.
      if (result.highVolumeLanes && result.highVolumeLanes.length >= 1) {
        try {
          const existingCoverageTask = await storage.findRfpCoverageReviewTask(rfp.id);
          if (!existingCoverageTask) {
            const currentUser = await getCurrentUser(req);
            const assignee = company.assignedTo ?? currentUser?.id;
            if (assignee) {
              const assignedBy = currentUser?.id ?? assignee;
              const laneCount = result.highVolumeLanes.length;
              const topLanes = result.highVolumeLanes
                .slice(0, 3)
                .map((l: any) => `${l.origin || "?"} → ${l.destination || "?"}`)
                .join("; ");
              // Set due date to 5 business days from today
              const dueMs = new Date();
              let bDays = 0;
              while (bDays < 5) {
                dueMs.setDate(dueMs.getDate() + 1);
                const dow = dueMs.getDay();
                if (dow !== 0 && dow !== 6) bDays++;
              }
              const dueDate = dueMs.toISOString().split("T")[0];
              await storage.createTask({
                title: `RFP Coverage Review: ${rfpData.title}`,
                notes: `${laneCount} high-volume lane${laneCount !== 1 ? "s" : ""} extracted from this RFP (top: ${topLanes}). Open the RFP & Lanes tab to see which facility sites have no contact assigned. For each uncovered location, identify who controls inbound/outbound freight decisions and either add them as a contact or ask an existing contact for an introduction.`,
                status: "open",
                dueDate,
                assignedTo: assignee,
                assignedBy,
                companyId: rfp.companyId,
                contactId: null,
                orgId: req.session.organizationId ?? null,
                companyName: company.name ?? null,
                contactName: null,
                attachedLaneData: [{ type: "rfp_coverage_review", rfpId: rfp.id, laneCount }],
                createdAt: new Date().toISOString(),
              });
            }
          }
        } catch (taskErr) {
          console.error("[rfp-upload] Failed to create coverage-review task (non-fatal):", taskErr);
        }
      }

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

  app.post("/api/rfps/upload-pdf", requireAuth, async (req, res) => {
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

  app.patch("/api/rfps/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      // Org-scoped lookup — cross-org IDs hit the 404 branch instead of
      // silently returning a foreign tenant's RFP.
      const existing = await storage.getRfpInOrg(req.params.id as string, currentUser.organizationId);
      if (!existing) {
        return res.status(404).json({ error: "RFP not found" });
      }
      // Even within the same org, enforce per-company visibility (matches
      // the read paths in /api/rfps and /api/research-tasks).
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = insertRfpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      // SECURITY: pin companyId server-side. The insert schema accepts a
      // companyId from the client, but allowing PATCH to reassign would
      // let a caller authorized on company A move the record to company
      // B (potentially in a foreign org or one they don't have visibility
      // on). Reparenting an RFP is not an existing product flow — if it
      // becomes one, build a dedicated /reassign endpoint that validates
      // the target.
      const safeData = { ...parsed.data, companyId: existing.companyId };
      const rfp = await storage.updateRfp((req.params.id as string), safeData);
      res.json(rfp);
    } catch (error) {
      console.error("Error updating RFP:", error);
      res.status(500).json({ error: "Failed to update RFP" });
    }
  });

  app.patch("/api/rfps/:id/lanes/:laneIndex/status", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const rfp = await storage.getRfpInOrg(req.params.id as string, currentUser.organizationId);
      if (!rfp) {
        return res.status(404).json({ error: "RFP not found" });
      }
      if (!(await canAccessCompany(currentUser, rfp.companyId))) {
        return res.status(403).json({ error: "Access denied" });
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

  app.get("/api/research-tasks", requireAuth, async (req, res) => {
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

  app.get("/api/companies/:id/lane-patterns", requireAuth, async (req, res) => {
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

  app.get("/api/companies/:id/facility-coverage", requireAuth, async (req, res) => {
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

      const facilities = Array.from(facilityMap.values()).map((f) => {
        const facilityLower = f.facility.toLowerCase();
        const stateLower = f.state.toLowerCase();
        const fullName = f.state ? `${f.facility}, ${f.state}` : f.facility;
        const fullNameLower = fullName.toLowerCase();

        const coveredBy: { id: string; name: string }[] = [];
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
            coveredBy.push({ id: contact.id, name: contact.name });
          }
        }

        return {
          ...f,
          fullName,
          covered: coveredBy.length > 0,
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

  app.delete("/api/rfps/:id", requireAuth, async (req, res) => {
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

  app.get("/api/awards", requireAuth, async (req, res) => {
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

  app.post("/api/awards", requireAuth, async (req, res) => {
    try {
      const parsed = insertAwardSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const award = await storage.createAward(parsed.data);

      // Auto-create an AM-facing onboarding task for each new award.
      // Non-fatal: task failure must never block the award creation response.
      try {
        const existingOnboarding = await storage.findAwardOnboardingTask(award.id);
        if (!existingOnboarding) {
          const currentUser = await getCurrentUser(req);
          const company = award.companyId ? await storage.getCompany(award.companyId) : null;
          const assignee = company?.assignedTo ?? currentUser?.id;
          if (assignee) {
            const assignedBy = currentUser?.id ?? assignee;
            const laneList = (award.lanes ?? []).filter(Boolean);
            const laneCount = laneList.length;
            // Build lane summary for notes (first 3 lanes)
            const laneSnippet = laneList.slice(0, 3).join("; ") || "No specific lanes recorded";
            // Due date: 7 business days from today
            const dueMs = new Date();
            let bDays = 0;
            while (bDays < 7) {
              dueMs.setDate(dueMs.getDate() + 1);
              const dow = dueMs.getDay();
              if (dow !== 0 && dow !== 6) bDays++;
            }
            const dueDate = dueMs.toISOString().split("T")[0];
            await storage.createTask({
              title: `Award Onboarding: ${award.title}`,
              notes: `${laneCount > 0 ? `${laneCount} lane${laneCount !== 1 ? "s" : ""} won (top: ${laneSnippet}).` : "Award created — no lanes specified yet."} Confirm the kickoff timeline with your contact, verify which lanes will start moving first, and check that the tendering process is set up correctly. Log a touchpoint once the first load ships.`,
              status: "open",
              dueDate,
              assignedTo: assignee,
              assignedBy,
              companyId: award.companyId ?? null,
              contactId: null,
              orgId: req.session.organizationId ?? null,
              companyName: company?.name ?? null,
              contactName: null,
              attachedLaneData: [{ type: "award_onboarding", awardId: award.id, laneCount }],
              createdAt: new Date().toISOString(),
            });
          }
        }
      } catch (taskErr) {
        console.error("[award-create] Failed to create onboarding task (non-fatal):", taskErr);
      }

      res.status(201).json(award);
    } catch (error) {
      console.error("Error creating award:", error);
      res.status(500).json({ error: "Failed to create award" });
    }
  });

  app.patch("/api/awards/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getAwardInOrg(req.params.id as string, currentUser.organizationId);
      if (!existing) {
        return res.status(404).json({ error: "Award not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = insertAwardSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      // SECURITY: pin companyId server-side — see RFP PATCH for rationale.
      const safeData = { ...parsed.data, companyId: existing.companyId };
      const award = await storage.updateAward((req.params.id as string), safeData);
      res.json(award);
    } catch (error) {
      console.error("Error updating award:", error);
      res.status(500).json({ error: "Failed to update award" });
    }
  });

  app.delete("/api/awards/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      // Previously this route had ZERO auth check beyond requireAuth — any
      // authenticated user could delete any award by guessing IDs. Lock it
      // down with the standard org+visibility gate before mutating.
      const existing = await storage.getAwardInOrg(req.params.id as string, currentUser.organizationId);
      if (!existing) {
        return res.status(404).json({ error: "Award not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteAward(req.params.id as string);
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

  app.get("/api/companies/:id/market-share", requireAuth, async (req, res) => {
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
  app.get("/api/companies/:id/market-share/auto-calc", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:id/market-share", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:id/market-share/upload", requireAuth, upload.single("file"), async (req, res) => {
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

  app.patch("/api/market-share/:id", requireAuth, async (req, res) => {
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

  app.delete("/api/market-share/:id", requireAuth, async (req, res) => {
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
  app.get("/api/market-share/summary", requireAuth, async (req, res) => {
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

  registerTaskRoutes(app);
  registerForcedFocusRoutes(app);
  registerEngagementRoutes(app);
  registerLaneCarrierOutreachRoutes(app);
  registerCarrierHubRoutes(app);
  registerMyProcurementRoutes(app);
  registerProcurementOutreachRoutes(app);
  registerProactiveOpportunityRoutes(app);
  registerIntelRoutes(app);
  registerGraphWebhookRoutes(app);
  registerMarketSignalRoutes(app);
  registerEmailIntelligenceRoutes(app);
  registerConversationsRoutes(app);
  registerProvenTacticsRoutes(app);
  registerPlaybookRoutes(app);
  registerEmailAnalyticsRoutes(app);
  registerSonarRoutes(app);
  registerCallIntelligenceRoutes(app);
  registerCoachingRoutes(app);
  registerProspectRoutes(app);
  registerEmailDraftingRoutes(app);
  registerNbaReadyToActRoutes(app);
  registerMonitoredMailboxRoutes(app);
  registerWebexRoutes(app);
  registerCallTrendlineRoutes(app);
  const { registerAgentAdminRoutes } = await import("./routes/agentAdmin");
  registerAgentAdminRoutes(app);
  const { registerAgentAnalyticsRoutes } = await import("./routes/agentAnalytics");
  registerAgentAnalyticsRoutes(app);
  const { registerValueIQRoutes } = await import("./routes/valueiq");
  registerValueIQRoutes(app);
  const { registerAccountReviewRoutes } = await import("./routes/accountReviews");
  registerAccountReviewRoutes(app);
  const { registerAgenticRoutes } = await import("./routes/agentic");
  registerAgenticRoutes(app);

  // Unified AI Center read-side aggregation (combined fleet across both kinds).
  const { registerAiCenterRoutes } = await import("./routes/aiCenter");
  registerAiCenterRoutes(app);

  // Org corpus indexer — nightly reindex + admin trigger.
  {
    const cron = (await import("node-cron")).default;
    const { indexAllOrgs, indexOrg } = await import("./agent/corpusIndexer");
    cron.schedule("0 3 * * *", () => {
      console.log("[corpus] nightly indexAllOrgs starting");
      indexAllOrgs().catch((err) => console.error("[corpus] nightly failed:", err));
    });
    app.post("/api/admin/agents/reindex-corpus", requireAuth, async (req, res) => {
      try {
        const me = await getCurrentUser(req);
        if (!me || me.role !== "admin") return res.status(403).json({ error: "Admin only" });
        const result = await indexOrg(me.organizationId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message ?? "Failed" });
      }
    });
  }

  registerFinancialRoutes(app);
  registerLoadFactRoutes(app);
  registerCarrierIntelligenceScoringRoutes(app);
  registerCarrierIntelligencePrefsRoutes(app);
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

  app.get("/api/one-on-one/session", requireAuth, async (req, res) => {
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

  app.get("/api/one-on-one/pairings", requireAuth, async (req, res) => {
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

  app.post("/api/one-on-one/topics", requireAuth, async (req, res) => {
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

  app.patch("/api/one-on-one/topics/:id/toggle", requireAuth, async (req, res) => {
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

  app.delete("/api/one-on-one/topics/:id", requireAuth, async (req, res) => {
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
  app.get("/api/one-on-one/topics/:id/replies", requireAuth, async (req, res) => {
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

  app.post("/api/one-on-one/topics/:id/replies", requireAuth, async (req, res) => {
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

  app.delete("/api/one-on-one/topic-replies/:id", requireAuth, async (req, res) => {
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

  app.post("/api/one-on-one/sessions/:id/close", requireAuth, async (req, res) => {
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
      res.json({ session: newSession, topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to close session" });
    }
  });

  app.post("/api/one-on-one/sessions/:id/generate-summary", requireAuth, async (req, res) => {
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
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });
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

  app.get("/api/one-on-one/archived", requireAuth, async (req, res) => {
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

  // ── Cadence Accountability Alerts ─────────────────────────────────────────
  app.get("/api/team/cadence-alerts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const restrictedRoles = ["account_manager", "logistics_manager", "logistics_coordinator"];
      if (restrictedRoles.includes(user.role)) return res.status(403).json({ error: "Access denied" });
      const days = parseInt((req.query.days as string) || "30", 10);
      const result = await storage.pool.query<{
        company_id: string; company_name: string; rep_id: string; rep_name: string;
        last_touchpoint_at: string | null; days_since: number | null;
      }>(`
        SELECT
          c.id AS company_id,
          c.name AS company_name,
          u.id AS rep_id,
          u.name AS rep_name,
          MAX(t.created_at) AS last_touchpoint_at,
          CASE
            WHEN MAX(t.created_at) IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (NOW() - MAX(t.created_at::timestamptz))) / 86400
          END AS days_since
        FROM companies c
        JOIN users u ON c.assigned_to = u.id
        LEFT JOIN touchpoints t ON t.company_id = c.id
        WHERE c.organization_id = $1
          AND c.archived_at IS NULL
          AND c.assigned_to IS NOT NULL
        GROUP BY c.id, c.name, u.id, u.name
        HAVING MAX(t.created_at) IS NULL
           OR MAX(t.created_at::timestamptz) < NOW() - ($2 || ' days')::interval
        ORDER BY days_since DESC NULLS FIRST
        LIMIT 100
      `, [user.organizationId, days]);
      res.json(result.rows.map(r => ({
        companyId: r.company_id,
        companyName: r.company_name,
        repId: r.rep_id,
        repName: r.rep_name,
        lastTouchpointAt: r.last_touchpoint_at || null,
        daysSince: r.days_since !== null ? Math.floor(r.days_since) : null,
      })));
    } catch (error) {
      console.error("Error in cadence-alerts:", error);
      res.status(500).json({ error: "Failed to fetch cadence alerts" });
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
            if (contact.companyId) {
              try {
                const gs = await computeGrowthScore(contact.companyId!, currentUser.organizationId, storage);
                await storage.upsertGrowthScore({ companyId: contact.companyId!, organizationId: currentUser.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
              } catch (gsErr) {
                console.error("[outlook] growth score refresh failed:", gsErr);
              }
            }
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
              try {
                const gs = await computeGrowthScore(match.id, currentUser.organizationId, storage);
                await storage.upsertGrowthScore({ companyId: match.id, organizationId: currentUser.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
              } catch (gsErr) {
                console.error("[outlook] growth score refresh (auto-link) failed:", gsErr);
              }
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
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

  registerGoalRoutes(app);

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
        storage.getUsers(user.organizationId),
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
        playLabel: typeof req.body.playLabel === "string" ? req.body.playLabel || null : null,
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
      if (contact.companyId) {
        _nbaCache.delete(`nba:${contact.companyId}`);
        try {
          const gs = await computeGrowthScore(contact.companyId!, user.organizationId, storage);
          await storage.upsertGrowthScore({ companyId: contact.companyId!, organizationId: user.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
        } catch (gsErr) {
          console.error("[contact-touchpoint] growth score refresh failed for company", contact.companyId, "—", gsErr instanceof Error ? gsErr.stack : gsErr);
        }
      }
      res.json({ ...tp, aiInsights, autoTask });
    } catch (error) {
      console.error("Failed to create touchpoint:", error);
      res.status(500).json({ error: "Failed to create touchpoint" });
    }
  });

  app.delete("/api/touchpoints/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowedRoles = ["admin", "director"];
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: "Only admins and directors can delete touchpoints" });
      }
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

  // ── Account Growth Score (per account) ─────────────────────────────────────
  // Returns cached score if <30min old, otherwise recomputes and persists.
  app.get("/api/companies/:id/growth-score", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const companyId = req.params.id as string;
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 16);

      const cached = await storage.getGrowthScore(companyId);
      // Only use cache if it's fresh AND already contains breakdown data
      if (cached && cached.calculatedAt >= thirtyMinAgo && (cached as any).breakdown) {
        return res.json(cached);
      }

      const result = await computeGrowthScore(companyId, user.organizationId, storage);
      const saved = await storage.upsertGrowthScore({
        companyId,
        organizationId: user.organizationId,
        score: result.score,
        band: result.band,
        drivers: result.drivers,
        calculatedAt: new Date().toISOString().slice(0, 16),
      });

      checkAndFireMomentumDropNotification(companyId, result.band, saved.previousBand, storage).catch(() => {});

      // Always include breakdown and bandLabel/bandColor from the freshly computed result
      res.json({ ...saved, bandLabel: result.bandLabel, bandColor: result.bandColor, breakdown: result.breakdown });
    } catch (error) {
      console.error("Error computing growth score:", error);
      res.status(500).json({ error: "Failed to compute growth score" });
    }
  });

  // ── Account Growth Scores (bulk — all visible companies) ───────────────────
  // Used by dashboard portlet and company list. Returns cached scores only;
  // per-account requests trigger fresh computation.
  app.get("/api/growth-scores", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const rawIds = await getVisibleCompanyIds(user);
      // null means admin / all-access — resolve to all active company IDs for the org.
      const visibleIds: string[] = rawIds !== null
        ? rawIds
        : (await storage.getCompanies(user.organizationId)).filter(c => !c.archivedAt).map(c => c.id);
      if (visibleIds.length === 0) return res.json([]);

      const cached = await storage.getGrowthScoresByOrg(user.organizationId, visibleIds);

      // Enrich with band labels / colors
      const BAND_LABELS: Record<string, string> = {
        high_expansion: "Primed to Grow",
        growth_ready:   "Growth Ready",
        stable:         "Stable",
        at_risk:        "At Risk",
      };
      const BAND_COLORS: Record<string, string> = {
        high_expansion: "green",
        growth_ready:   "blue",
        stable:         "amber",
        at_risk:        "red",
      };

      const enriched = cached.map(s => ({
        ...s,
        bandLabel: BAND_LABELS[s.band] ?? s.band,
        bandColor: BAND_COLORS[s.band] ?? "amber",
      }));

      // Background: recompute growth scores for:
      //   (a) visible companies with NO cached score yet (newly visible accounts)
      //   (b) visible companies with a STALE cached score (older than 30 minutes)
      // This ensures stale "No touchpoints on record" scores are corrected
      // without requiring a rep to visit each company page individually.
      const THIRTY_MIN_MS = 30 * 60 * 1000;
      const staleCutoff = new Date(Date.now() - THIRTY_MIN_MS).toISOString();
      const cachedIds = new Set(cached.map(s => s.companyId));
      const unscoredIds = visibleIds.filter(id => !cachedIds.has(id));
      const staleIds = cached
        .filter(s => !s.calculatedAt || s.calculatedAt < staleCutoff)
        .map(s => s.companyId);
      // No cap on unscored companies — every company that has never had a score must
      // be seeded so the Customers page can show a badge. Stale (but already-scored)
      // companies are capped at 30 per request to bound background work.
      const toRecompute = [...new Set([...unscoredIds, ...staleIds.slice(0, 30)])];
      if (toRecompute.length > 0) {
        (async () => {
          for (const cid of toRecompute) {
            try {
              const gs = await computeGrowthScore(cid, user.organizationId, storage);
              const saved = await storage.upsertGrowthScore({ companyId: cid, organizationId: user.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
              checkAndFireMomentumDropNotification(cid, gs.band, saved.previousBand, storage).catch(() => {});
            } catch (_) { /* skip individual failures */ }
          }
        })();
      }

      res.json(enriched);
    } catch (error) {
      console.error("Error fetching growth scores:", error);
      res.status(500).json({ error: "Failed to fetch growth scores" });
    }
  });

  // ── Next Best Action (per account) ────────────────────────────────────────
  // Calls the NBA engine with all account signals and returns a single
  // prioritised recommendation.  Results are cached in-process for 30 minutes
  // to avoid redundant recomputation on rapid page refreshes.
  //
  // Cache key: `nba:<companyId>` — deleted immediately when a touchpoint is
  // logged for that company (see all three touchpoint POST routes below),
  // and expires automatically after NBA_TTL_MS regardless.
  app.get("/api/companies/:id/next-best-action", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const companyId = req.params.id as string;

      // Verify company exists and belongs to this user's organisation.
      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      // RBAC: only users who can access this company may fetch its NBA.
      if (!(await canAccessCompany(user, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check in-process cache before running the engine.
      const cacheKey = `nba:${companyId}`;
      const cached = _nbaCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.result);
      }

      // Run the engine — may throw; caught below.
      const nba = await computeNextBestAction(companyId, user.organizationId, storage);

      // Store result in cache.
      _nbaCache.set(cacheKey, { result: nba, expiresAt: Date.now() + NBA_TTL_MS });

      return res.json(nba);
    } catch (error) {
      console.error("Error computing next-best-action:", error);
      // Graceful fallback — return a valid no-action shape so the UI never hard-errors.
      return res.status(500).json({
        error: "Failed to compute next best action",
        fallback: {
          ruleId: "R13",
          urgency: "none",
          headline: "No Action Required",
          reason: "Unable to evaluate account signals at this time.",
          ctaLabel: null,
          ctaHint: "none",
          owner: "rep",
          signals: null,
        },
      });
    }
  });

  // ── Next Best Actions — batch endpoint for dashboard portlet ─────────────
  // Returns the top actionable accounts for the current user, sorted by
  // urgency. Uses the shared _nbaCache so results computed by the per-account
  // route are re-used here and vice-versa.
  //
  // Strategy: cap the engine run at MAX_BATCH accounts, prioritising
  // at-risk / poorly-scored companies first so the most urgent accounts
  // always appear in the result, even for large orgs.
  app.get("/api/next-best-actions", requireAuth, async (req, res) => {
    const MAX_BATCH  = 30; // max companies to evaluate per request
    const MAX_RESULT = 10; // max rows returned to the frontend

    const URGENCY_RANK: Record<string, number> = {
      critical: 0,
      high:     1,
      moderate: 2,
      none:     3,
    };

    // Band priority — at_risk accounts evaluated first.
    const BAND_RANK: Record<string, number> = {
      at_risk:        0,
      stable:         1,
      growth_ready:   2,
      high_expansion: 3,
    };

    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Fetch all org companies once — used for both name lookup and admin visibility.
      // Exclude archived companies so they never appear in NBA recommendations.
      const allCompanies = (await storage.getCompanies(user.organizationId)).filter(c => !c.archivedAt);
      const nameMap = new Map(allCompanies.map(c => [c.id, c.name]));

      // null means admin / all-access; otherwise filter to RBAC-visible IDs.
      // In both cases, intersect with active (non-archived) company IDs.
      const rawIds = await getVisibleCompanyIds(user);
      const activeIds = new Set(allCompanies.map(c => c.id));
      const visibleIds: string[] = (rawIds ?? [...activeIds]).filter(id => activeIds.has(id));
      if (visibleIds.length === 0) return res.json({ items: [], totalEvaluated: 0 });

      // Pull cached growth scores to order evaluations (at_risk first).
      const scores = await storage.getGrowthScoresByOrg(user.organizationId, visibleIds);
      const scoreMap = new Map(scores.map(s => [s.companyId, s.band]));

      const prioritised = [...visibleIds].sort((a, b) => {
        const ra = BAND_RANK[scoreMap.get(a) ?? ""] ?? 4;
        const rb = BAND_RANK[scoreMap.get(b) ?? ""] ?? 4;
        return ra - rb;
      }).slice(0, MAX_BATCH);

      // Run engine for each company — use cache when available.
      const now = Date.now();
      type EnrichedNba = import("./nextBestActionEngine").NextBestAction & {
        companyId:   string;
        companyName: string;
      };

      const results = await Promise.allSettled(
        prioritised.map(async (companyId): Promise<EnrichedNba> => {
          const cacheKey = `nba:${companyId}`;
          const hit = _nbaCache.get(cacheKey);
          const nba = (hit && hit.expiresAt > now)
            ? hit.result as import("./nextBestActionEngine").NextBestAction
            : await computeNextBestAction(companyId, user.organizationId, storage);
          if (!hit || hit.expiresAt <= now) {
            _nbaCache.set(cacheKey, { result: nba, expiresAt: now + NBA_TTL_MS });
          }
          return { ...nba, companyId, companyName: nameMap.get(companyId) ?? "Unknown" };
        })
      );

      // Collect fulfilled results, drop R13 (urgency = none), sort by urgency.
      const actionable = results
        .filter((r): r is PromiseFulfilledResult<EnrichedNba> =>
          r.status === "fulfilled" && r.value.urgency !== "none"
        )
        .map(r => r.value)
        .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3))
        .slice(0, MAX_RESULT);

      return res.json({
        items:          actionable,
        totalEvaluated: prioritised.length,
      });
    } catch (error) {
      console.error("Error computing next-best-actions batch:", error);
      return res.status(500).json({ error: "Failed to compute next best actions" });
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

      // Use client-supplied local date so the window stays correct all day for
      // users in any timezone (e.g. Mountain Time flips past midnight UTC at 5 pm,
      // which previously zeroed out the list for the rest of the evening).
      const todayStr = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : new Date().toISOString().slice(0, 10);

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
      if (isLeadership(user)) {
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

      const teamIds: string[] | null = isLeadership(user)
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

  app.get("/api/companies/:id/vendor-routed", requireAuth, async (req, res) => {
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

  app.post("/api/companies/:id/vendor-routed/toggle", requireAuth, async (req, res) => {
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
      // Org-scoped fetch — admins/directors/sales_directors see every passoff
      // in THEIR org (not all orgs as the prior `{all:true}` query did).
      const passoffs = isLeadership(currentUser)
        ? await storage.getPtoPassoffsByOrg(req.session.organizationId!)
        : await storage.getPtoPassoffsByOrg(req.session.organizationId!, {
            createdById: currentUser.id,
            coveringUserId: currentUser.id,
          });
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && !isAdmin(currentUser)) {
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && !isAdmin(currentUser)) {
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && !isAdmin(currentUser)) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Cross-tenant guard on optional companyId — if a passoff item references
      // a company, that company must belong to the caller's org.
      if (req.body.companyId) {
        const owning = await storage.getCompanyInOrg(req.body.companyId, currentUser.organizationId);
        if (!owning) return res.status(404).json({ error: "Company not found" });
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      const isCovering = passoff.coveringUserId === currentUser.id;
      const isOwner = passoff.createdById === currentUser.id;
      const isCallerAdmin = isAdmin(currentUser);
      if (!isOwner && !isCovering && !isCallerAdmin) return res.status(403).json({ error: "Access denied" });
      // Cross-record guard: itemId must actually belong to this passoff —
      // otherwise a user authorized on passoff A could mutate items owned
      // by passoff B (different rep, possibly different org) by guessing
      // an itemId.
      const items = await storage.getPtoPassoffItems(req.params.id as string);
      const targetItem = items.find(i => i.id === (req.params.itemId as string));
      if (!targetItem) return res.status(404).json({ error: "Item not found" });
      // Covering user can update acknowledged + coveringNotes; owner/admin can update all
      const allowedFields = isOwner || isCallerAdmin
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      if (passoff.createdById !== currentUser.id && !isAdmin(currentUser)) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Cross-record guard: itemId must belong to this passoff. Same
      // rationale as the PATCH handler above.
      const items = await storage.getPtoPassoffItems(req.params.id as string);
      if (!items.some(i => i.id === (req.params.itemId as string))) {
        return res.status(404).json({ error: "Item not found" });
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
      const passoff = await storage.getPtoPassoffInOrg(req.params.id as string, currentUser.organizationId);
      if (!passoff) return res.status(404).json({ error: "Not found" });
      const isCovering = passoff.coveringUserId === currentUser.id;
      const isOwner = passoff.createdById === currentUser.id;
      // NOTE: includes director — historically broader than the mutating routes.
      const isLeader = isAdmin(currentUser) || currentUser.role === "director";
      if (!isCovering && !isOwner && !isLeader) return res.status(403).json({ error: "Access denied" });
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
      if (!["admin", "director", "national_account_manager", "sales", "sales_director"].includes(user.role)) return res.status(403).json({ error: "Not authorized" });
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

  registerDashboardRoutes(app);

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

      res.json({ ...nomination });
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
      // Cross-tenant guard: a contactId provided in the body MUST belong to
      // the same company we just verified the user can access. Without this
      // a user could attach this touchpoint (and trigger downstream growth
      // recompute / NBA cache invalidation) to a contact from another org.
      if (contactId) {
        if (!contact) return res.status(404).json({ error: "Contact not found" });
        if (contact.companyId !== (req.params.id as string)) {
          return res.status(400).json({ error: "Contact does not belong to this company" });
        }
      }
      const tp = await storage.createTouchpointWithDefaults({
        contactId,
        companyId: req.params.id as string,
        type: req.body.type || "call",
        date: req.body.date || undefined,
        notes,
        sentiment: req.body.sentiment || null,
        isMeaningful: req.body.isMeaningful === true || req.body.isMeaningful === "true",
        loggedById: user.id,
        // Carry through playLabel for outcome classifier parity with /touch-logs.
        playLabel: typeof req.body.playLabel === "string" ? req.body.playLabel || null : null,
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
      _nbaCache.delete(`nba:${req.params.id}`);
      try {
        const gs = await computeGrowthScore(req.params.id as string, user.organizationId, storage);
        const savedGs = await storage.upsertGrowthScore({ companyId: req.params.id as string, organizationId: user.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
        checkAndFireMomentumDropNotification(req.params.id as string, gs.band, savedGs.previousBand, storage).catch(() => {});
      } catch (gsErr) {
        console.error("[company-touchpoint] growth score refresh failed:", gsErr);
      }
      res.json({ ...tp, aiInsights, autoTask });
    } catch (error) {
      console.error("Failed to log touchpoint (company route):", error);
      res.status(500).json({ error: "Failed to log touchpoint" });
    }
  });

  app.post("/api/touch-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { companyId, contactId, type, isMeaningful, sentiment, notes, playLabel } = req.body;
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
      // Cross-tenant guard: contactId, if supplied, MUST belong to the same
      // company we just verified the user can access. Without this, a user
      // could attach this touchpoint (and trigger downstream growth-score
      // recompute, AI follow-up task creation, NBA invalidation) to a contact
      // owned by another company / org. Same class of fix as the
      // /api/companies/:id/touchpoints route.
      if (contactId) {
        if (!contact) return res.status(404).json({ error: "Contact not found" });
        if (contact.companyId !== companyId) {
          return res.status(400).json({ error: "Contact does not belong to this company" });
        }
      }
      const tp = await storage.createTouchpointWithDefaults({
        contactId: contactId || null,
        companyId,
        type: type || "call",
        notes: cleanNotes,
        sentiment: sentiment || null,
        isMeaningful: isMeaningful === true || isMeaningful === "true",
        loggedById: user.id,
        playLabel: typeof playLabel === "string" ? playLabel || null : null,
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
      _nbaCache.delete(`nba:${companyId}`);
      try {
        const gs = await computeGrowthScore(companyId, user.organizationId, storage);
        const savedGs = await storage.upsertGrowthScore({ companyId, organizationId: user.organizationId, score: gs.score, band: gs.band, drivers: gs.drivers, calculatedAt: new Date().toISOString() });
        checkAndFireMomentumDropNotification(companyId, gs.band, savedGs.previousBand, storage).catch(() => {});
      } catch (gsErr) {
        // Log full stack so transient failures are visible in server logs
        console.error("[touch-logs] growth score refresh failed for company", companyId, "—", gsErr instanceof Error ? gsErr.stack : gsErr);
      }
      res.json({ ...tp, aiInsights, autoTask });
    } catch (error) {
      console.error("Failed to log touch:", error);
      res.status(500).json({ error: "Failed to log touch" });
    }
  });

  // PUBLIC — no requireAuth. Contact/demo request form on the landing page;
  // submitted by unauthenticated prospects.
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
      const chainIds = await storage.getTeamMemberIds(user.id, user.organizationId);
      const chainIdSet = new Set(chainIds);
      const allUsers = await storage.getUsers(user.organizationId);
      const lmDirectReports = allUsers
        .filter(u => u.role === "logistics_manager" && chainIdSet.has(u.id) && u.id !== user.id)
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

  // ── NAM/AM → LM Daily Check-In ───────────────────────────────────────────

  // GET /api/lm-checkins/pending  — which LMs need a check-in from the current user today
  app.get("/api/lm-checkins/pending", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // ── Timezone-aware date + active window (all CT) ────────────────────────
      // Using Intl API (built into Node.js) — no extra packages needed.
      // America/Chicago handles CST (UTC-6) and CDT (UTC-5) automatically.
      const ctStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
      const ctDate = new Date(ctStr);
      const dow = ctDate.getDay(); // 0=Sun, 6=Sat

      // Weekday guard: outside Mon–Fri there is no active check-in window.
      const isWeekday = dow >= 1 && dow <= 5;

      // today's date in CT (en-CA gives YYYY-MM-DD format)
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());

      // Active window is determined server-side so all clients see the same window
      // regardless of browser timezone.
      // Morning:   7:00 AM – 11:59 AM CT (covers the 7:30 AM cron alert)
      // Afternoon: 3:30 PM – 11:59 PM CT (covers the 4:00 PM cron alert)
      function getActiveWindow(): "morning" | "afternoon" | null {
        if (!isWeekday) return null;
        const minutes = ctDate.getHours() * 60 + ctDate.getMinutes();
        if (minutes >= 7 * 60 && minutes < 12 * 60) return "morning";
        if (minutes >= 15 * 60 + 30) return "afternoon";
        return null;
      }
      const activeWindow = getActiveWindow();

      // Find LMs directly reporting to this user
      const lms = await storage.pool.query<{ id: string; name: string; role: string }>(
        `SELECT id, name, role FROM users
         WHERE manager_id = $1 AND organization_id = $2
           AND role IN ('logistics_manager','logistics_coordinator')
         ORDER BY name`,
        [user.id, user.organizationId]
      );
      if (lms.rows.length === 0) return res.json({ lms: [], pending: [], activeWindow });

      // Find already-submitted check-ins for today (CT date)
      const done = await storage.pool.query<{ lm_id: string; check_type: string }>(
        `SELECT lm_id, check_type FROM nam_lm_checkins
         WHERE reviewer_id = $1 AND check_date = $2`,
        [user.id, today]
      );
      const doneSet = new Set(done.rows.map(r => `${r.lm_id}:${r.check_type}`));

      // Return pending items for ALL check types (not just the active window) so
      // the client can show history and let the server's activeWindow field drive
      // which one is currently actionable.
      const checkTypes = ["morning", "afternoon"] as const;
      const pending = lms.rows.flatMap(lm =>
        checkTypes
          .filter(t => !doneSet.has(`${lm.id}:${t}`))
          .map(t => ({ lmId: lm.id, lmName: lm.name, lmRole: lm.role, checkType: t }))
      );

      res.json({ lms: lms.rows, pending, activeWindow });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  // POST /api/lm-checkins  — submit check-in responses for one or more LMs
  app.post("/api/lm-checkins", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { checkType, responses } = req.body as {
        checkType: "morning" | "afternoon";
        responses: {
          lmId: string;
          checkCallsDone?: boolean;
          boardClean?: boolean;
          checkoutDone?: boolean;
          notes?: string;
        }[];
      };

      if (!checkType || !Array.isArray(responses) || responses.length === 0) {
        return res.status(400).json({ error: "checkType and responses required" });
      }

      const today = new Date().toISOString().slice(0, 10);
      const inserted: number[] = [];

      for (const r of responses) {
        // Verify the LM reports to this user
        const lmRow = await storage.pool.query(
          `SELECT 1 FROM users WHERE id = $1 AND manager_id = $2 AND organization_id = $3
             AND role IN ('logistics_manager','logistics_coordinator')`,
          [r.lmId, user.id, user.organizationId]
        );
        if ((lmRow.rowCount ?? 0) === 0) continue;

        const result = await storage.pool.query<{ id: number }>(
          `INSERT INTO nam_lm_checkins
             (reviewer_id, lm_id, organization_id, check_date, check_type,
              check_calls_done, board_clean, checkout_done, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (reviewer_id, lm_id, check_date, check_type)
           DO UPDATE SET check_calls_done=$6, board_clean=$7, checkout_done=$8, notes=$9
           RETURNING id`,
          [user.id, r.lmId, user.organizationId, today, checkType,
           r.checkCallsDone ?? null, r.boardClean ?? null, r.checkoutDone ?? null, r.notes ?? null]
        );
        if (result.rows[0]?.id) inserted.push(result.rows[0].id);
      }

      // Mark today's lm_checkin notifications as read
      await storage.pool.query(
        `UPDATE notifications SET read = true
         WHERE user_id = $1 AND type = 'lm_checkin' AND read = false`,
        [user.id]
      );

      res.json({ ok: true, inserted });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  // GET /api/lm-checkins/lm-summary/:userId  — check-in stats for a specific LM (from their perspective)
  app.get("/api/lm-checkins/lm-summary/:userId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { userId } = req.params as { userId: string };
      const period = (req.query.period as string) || "2weeks";

      const isSelf = userId === user.id;
      const isManager = ["admin","director","national_account_manager","account_manager","sales_director"].includes(user.role);
      if (!isSelf && !isManager) return res.status(403).json({ error: "Access denied" });

      const days = period === "month" ? 30 : period === "week" ? 7 : 14;
      const fromDate = new Date(Date.now() - days * 24 * 3600000).toISOString().slice(0, 10);
      const toDate = new Date().toISOString().slice(0, 10);

      const rows = await storage.pool.query(
        `SELECT c.id, c.check_date, c.check_type,
                c.check_calls_done, c.board_clean, c.checkout_done, c.notes,
                r.name AS reviewer_name
         FROM nam_lm_checkins c
         JOIN users r ON r.id = c.reviewer_id
         WHERE c.lm_id = $1 AND c.organization_id = $2
           AND c.check_date >= $3 AND c.check_date <= $4
         ORDER BY c.check_date DESC, c.check_type DESC
         LIMIT 60`,
        [userId, user.organizationId, fromDate, toDate]
      );

      const all = rows.rows;
      const morning = all.filter((r: any) => r.check_type === "morning");
      const afternoon = all.filter((r: any) => r.check_type === "afternoon");

      const pctOf = (arr: any[], field: string) => {
        const withData = arr.filter((r: any) => r[field] !== null);
        if (!withData.length) return null;
        return Math.round(withData.filter((r: any) => r[field] === true).length / withData.length * 100);
      };

      res.json({
        totalCheckins: all.length,
        morningCount: morning.length,
        afternoonCount: afternoon.length,
        checkCallsDonePct: pctOf(morning, "check_calls_done"),
        boardCleanMorningPct: pctOf(morning, "board_clean"),
        boardCleanAfternoonPct: pctOf(afternoon, "board_clean"),
        checkoutDonePct: pctOf(afternoon, "checkout_done"),
        recentCheckins: all.slice(0, 14),
      });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });

  // GET /api/lm-checkins/history  — admin/director/NAM view of check-in history
  app.get("/api/lm-checkins/history", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!managerRoles.includes(user.role) && user.role !== "account_manager") {
        return res.status(403).json({ error: "Access denied" });
      }

      const { from, to, reviewerId, lmId } = req.query as Record<string, string>;
      const fromDate = from || new Date(Date.now() - 30 * 24 * 3600000).toISOString().slice(0, 10);
      const toDate = to || new Date().toISOString().slice(0, 10);

      if (!user.organizationId) {
        return res.json([]);
      }

      let reviewerFilter = "";
      const params: (string | boolean)[] = [user.organizationId, fromDate, toDate];

      if (user.role === "account_manager") {
        // AMs can only see their own submitted check-ins
        params.push(user.id);
        reviewerFilter = `AND c.reviewer_id = $${params.length}`;
      } else if (reviewerId) {
        params.push(reviewerId);
        reviewerFilter = `AND c.reviewer_id = $${params.length}`;
      }

      let lmFilter = "";
      if (lmId) {
        params.push(lmId);
        lmFilter = `AND c.lm_id = $${params.length}`;
      }

      const rows = await storage.pool.query(
        `SELECT
           c.id, c.check_date, c.check_type,
           c.check_calls_done, c.board_clean, c.checkout_done, c.notes,
           c.created_at,
           r.id AS reviewer_id, r.name AS reviewer_name,
           l.id AS lm_id, l.name AS lm_name
         FROM nam_lm_checkins c
         JOIN users r ON r.id = c.reviewer_id
         JOIN users l ON l.id = c.lm_id
         WHERE c.organization_id = $1
           AND c.check_date >= $2 AND c.check_date <= $3
           ${reviewerFilter} ${lmFilter}
         ORDER BY c.check_date DESC, c.check_type DESC, r.name ASC, l.name ASC
         LIMIT 500`,
        params
      );

      res.json(rows.rows);
    } catch (err) {
      res.status(500).json({ error: "Server error" });
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

  /*
   * ── Relationship-Freight Attribution: How it works ────────────────────────────
   *
   * PRIORITY RULE (within-contact, exclusive OR):
   *   If a contact has one or more explicit lane attributions (rows in
   *   contact_lane_attributions), those are used exclusively via
   *   computeFreightMetrics(). The contact's free-text lane strings (lanes/regions
   *   fields from the RFP Coverage tab) are ignored for that contact.
   *   Lane strings are only used as a fallback when a contact has zero explicit
   *   attributions. This prevents the same loads being counted twice for a single
   *   contact who has both sources configured.
   *
   * DEDUPLICATION RULE (cross-contact, per-company aggregate rollup only):
   *   In the global /api/relationship-freight-summary endpoint, each financial row
   *   is counted at most once per company. A per-company Set<number> (row index
   *   tracker) is maintained across contact iterations. If two contacts at the same
   *   company both match the same financial row, only the first contact's iteration
   *   claims that row for the aggregate totals. Per-contact metrics shown in the
   *   company portlet are always computed independently (unaffected by deduplication).
   *
   * COMPANY MATCHING:
   *   Customer name in the financial row is matched against the company's primary
   *   name and all aliases in the financialAlias field (comma-separated). Matching
   *   is fuzzy (normalized, alphanumeric-only substring match). The company alias
   *   field must be maintained manually when a customer's name in the TMS differs
   *   from the CRM company name.
   *
   * UNATTRIBUTED LOADS:
   *   After processing all contacts for a company, any financial rows belonging to
   *   that company that were not matched by any contact are counted as
   *   unattributedLoads / unattributedMargin and surfaced in the API response.
   *
   * KNOWN LIMITATIONS:
   *   - Single-upload snapshot only: attribution is computed against the single
   *     latest financial upload. Historical period comparison is not supported here.
   *   - Relationship base reflects current state, not historical: if a contact's
   *     base level changed after freight shipped, the old loads are attributed to
   *     the new base level.
   *   - Company alias must be maintained manually: if the TMS customer name does
   *     not fuzzy-match the CRM name or any alias, loads will be unattributed.
   *   - Lane strings shorter than 4 chars that are not state abbreviations, or
   *     strings not in directional format (X → Y / X to Y), may not parse
   *     correctly and could produce false matches.
   */

  // Returns matched row indices in addition to metrics — required for deduplication
  // City alias lookup: maps common abbreviations/variants to normalized full city names
  const CITY_ALIASES: Record<string, string> = {
    "stl": "saintlouis",
    "saintlouispark": "saintlouis",
    "nyc": "newyork",
    "newyorkcity": "newyork",
    "la": "losangeles",
    "philly": "philadelphia",
    "chi": "chicago",
    "kc": "kansascity",
    "indy": "indianapolis",
    "cincy": "cincinnati",
    "cle": "cleveland",
    "pgh": "pittsburgh",
    "atl": "atlanta",
    "dfw": "dallas",
    "sfbay": "sanfrancisco",
    "sf": "sanfrancisco",
  };

  function normCity(raw: string): string {
    const n = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    return CITY_ALIASES[n] ?? n;
  }

  function computeFreightMetrics(
    rows: any[],
    cols: any,
    companyNames: string[], // normalized company name + aliases
    attributions: { originCity?: string | null; originState?: string | null; destinationCity?: string | null; destinationState?: string | null }[],
    skipIndices?: Set<number>
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number; matchedIndices: Set<number> } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
    const matchedIndices = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;
      const origCity = normCity(String(row[cols.shipperCity] || row[cols.origin] || "").split(",")[0]);
      const origState = norm(String(row[cols.shipperState] || row[cols.originState] || ""));
      const destCity = normCity(String(row[cols.consigneeCity] || row[cols.destination] || "").split(",")[0]);
      const destState = norm(String(row[cols.consigneeState] || row[cols.destinationState] || ""));
      const matched = attributions.some(a => {
        // Phase 2: exact normalized city match after alias resolution (no substring/prefix matching)
        const normOrigCity = a.originCity ? normCity(a.originCity) : "";
        const normDestCity = a.destinationCity ? normCity(a.destinationCity) : "";
        const origCityOk = !a.originCity || origCity === normOrigCity;
        const origStateOk = !a.originState || origState === norm(a.originState);
        const destCityOk = !a.destinationCity || destCity === normDestCity;
        const destStateOk = !a.destinationState || destState === norm(a.destinationState);
        return origCityOk && origStateOk && destCityOk && destStateOk;
      });
      if (!matched) continue;
      matchedIndices.add(i);
      if (skipIndices?.has(i)) continue;
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const orderTypeRaw = String(row[orderTypeK] || "").toLowerCase();
      const isSpot = orderTypeRaw.includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads, matchedIndices };
  }

  // Compute freight from a contact's free-text lanes/regions arrays (coverage tab data)
  // Returns matched row indices in addition to metrics — required for deduplication
  // Phase 2 rules:
  //   - State-only matchers (no destination, 2-3 char abbreviation) are "broad".
  //   - Broad matchers are INCLUDED when they are the contact's sole attribution method.
  //   - Broad matchers are EXCLUDED when more specific (non-broad) matchers also exist.
  //   - City matching uses exact normalized name after alias resolution.
  function computeFreightFromContactLaneStrings(
    rows: any[],
    cols: any,
    companyNames: string[],
    contactLanes: string[],
    contactRegions: string[],
    skipIndices?: Set<number>
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number; matchedIndices: Set<number>; hasBroadStateOnly: boolean } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
    const matchedIndices = new Set<number>();

    // Convert each lane/region string into a structured matcher
    type LaneMatcher = { originCity?: string; originState?: string; destCity?: string; destState?: string; isBroadStateOnly: boolean };
    const matchers: LaneMatcher[] = [];

    for (const term of [...(contactLanes || []), ...(contactRegions || [])]) {
      const t = term.trim();
      if (!t) continue;
      const dirMatch = t.match(/^(.+?)(?:→|->|\s+to\s+)(.+)$/i);
      if (dirMatch) {
        const from = dirMatch[1].trim();
        const to = dirMatch[2].trim();
        matchers.push({
          originState: from.length <= 3 && /^[a-zA-Z]+$/.test(from) ? from : undefined,
          originCity: from.length > 3 ? from : undefined,
          destState: to.length <= 3 && /^[a-zA-Z]+$/.test(to) ? to : undefined,
          destCity: to.length > 3 ? to : undefined,
          isBroadStateOnly: false, // directional = specific enough
        });
        continue;
      }
      // State abbreviation (2-3 chars, letters only) with no destination = broad
      if (t.length <= 3 && /^[a-zA-Z]+$/.test(t)) {
        matchers.push({ originState: t, isBroadStateOnly: true });
        continue;
      }
      // City / region name — specific
      matchers.push({ originCity: t, isBroadStateOnly: false });
    }

    if (matchers.length === 0) return { loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0, matchedIndices, hasBroadStateOnly: false };

    const hasNonBroad = matchers.some(m => !m.isBroadStateOnly);
    const hasBroadStateOnly = matchers.some(m => m.isBroadStateOnly) && !hasNonBroad;

    // Phase 2: use only specific matchers when both types exist.
    // When ONLY broad matchers exist (sole attribution method), allow them.
    const effectiveMatchers = hasNonBroad
      ? matchers.filter(m => !m.isBroadStateOnly) // drop broad when more specific ones present
      : matchers; // sole attribution = allow broad

    if (effectiveMatchers.length === 0) return { loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0, matchedIndices, hasBroadStateOnly };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;

      const origCity = normCity(String(row[cols.shipperCity] || row[cols.origin] || "").split(",")[0]);
      const origState = norm(String(row[cols.shipperState] || row[cols.originState] || ""));
      const dstCity = normCity(String(row[cols.consigneeCity] || row[cols.destination] || "").split(",")[0]);
      const dstState = norm(String(row[cols.consigneeState] || row[cols.destinationState] || ""));

      const matched = effectiveMatchers.some(m => {
        // Phase 2: exact normalized city match after alias resolution
        const normOrigCity = m.originCity ? normCity(m.originCity) : "";
        const normDstCity = m.destCity ? normCity(m.destCity) : "";
        const origCityOk = !m.originCity || origCity === normOrigCity;
        const origStateOk = !m.originState || origState === norm(m.originState);
        const destCityOk = !m.destCity || dstCity === normDstCity;
        const destStateOk = !m.destState || dstState === norm(m.destState);
        return origCityOk && origStateOk && destCityOk && destStateOk;
      });

      if (!matched) continue;
      matchedIndices.add(i);
      if (skipIndices?.has(i)) continue;
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const isSpot = String(row[orderTypeK] || "").toLowerCase().includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads, matchedIndices, hasBroadStateOnly };
  }

  // All company freight (no lane filtering) — used to compute total company row indices for unattributed calc
  function computeCompanyFreightTotal(
    rows: any[],
    cols: any,
    companyNames: string[]
  ): { loads: number; margin: number; contractedLoads: number; spotLoads: number; allIndices: Set<number> } {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const companyNorms = companyNames.map(n => norm(n));
    let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
    const allIndices = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const custRaw = getCustomerFromRow(row, cols);
      const custNorm = norm(custRaw);
      const isCompany = companyNorms.some(cn => cn.length > 3 && (custNorm.includes(cn) || cn.includes(custNorm)));
      if (!isCompany) continue;
      allIndices.add(i);
      const marginK = cols.marginDollar ?? "Margin $";
      const rowMargin = parseFloat(String(row[marginK] || 0).replace(/[$,]/g, "")) || 0;
      const orderTypeK = cols.orderType ?? "Order Type";
      const isSpot = String(row[orderTypeK] || "").toLowerCase().includes("spot");
      loads++;
      margin += rowMargin;
      if (isSpot) spotLoads++; else contractedLoads++;
    }
    return { loads, margin, contractedLoads, spotLoads, allIndices };
  }

  // ── Shared normBase utility used by all relationship-freight endpoints ─────
  function normRelationshipBase(raw: string | null | undefined): string {
    if (!raw) return "unknown";
    const v = raw.trim().toLowerCase();
    if (v === "1st" || v === "1st base" || v === "first base" || v === "first") return "1st";
    if (v === "2nd" || v === "2nd base" || v === "second base" || v === "second") return "2nd";
    if (v === "3rd" || v === "3rd base" || v === "third base" || v === "third") return "3rd";
    if (v === "hr" || v === "home run" || v === "homerun" || v === "home") return "hr";
    return "unknown";
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
      // Phase 1: base rank for tie-breaking — higher rank wins (hr > 3rd > 2nd > 1st > unknown)
      const BASE_RANK: Record<string, number> = { hr: 4, "3rd": 3, "2nd": 2, "1st": 1, unknown: 0 };

      // Phase 1: sort contacts by base rank descending so highest-base contacts claim lanes first.
      // Secondary sort by id ensures fully deterministic same-base ordering.
      const sortedContacts = [...contacts].sort((a, b) => {
        const rankA = BASE_RANK[normRelationshipBase(a.relationshipBase)] ?? 0;
        const rankB = BASE_RANK[normRelationshipBase(b.relationshipBase)] ?? 0;
        if (rankB !== rankA) return rankB - rankA;
        // Secondary stable sort by id ensures same-base contacts always process in the same order
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      // First pass: compute which row indices each contact MATCHES (ignoring dedup) and
      // which indices are claimed by a higher-ranked contact — used for "shared lane" badge.
      // Maps contactId -> Set of matched indices (pre-dedup, for unattributed calc)
      const contactMatchedIndices: Map<string, Set<number>> = new Map();
      const allContactsMatchedIndices = new Set<number>();

      // Build per-contact match data sorted by base rank (tie-breaking: highest base claims first)
      for (const contact of sortedContacts) {
        const contactAttribs = allAttributions.filter(a => a.contactId === contact.id);
        const hasAttribs = contactAttribs.length > 0;
        const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
        const hasNoAttribution = !hasAttribs && !hasLaneStrings;

        if (rawRows.length > 0 && !hasNoAttribution) {
          let matched: Set<number>;
          if (hasAttribs) {
            const f = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs);
            matched = f.matchedIndices;
          } else {
            const f = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || []);
            matched = f.matchedIndices;
          }
          contactMatchedIndices.set(contact.id, matched);
          matched.forEach(idx => allContactsMatchedIndices.add(idx));
        }
      }

      // Second pass: build final contact results using the sorted (tie-breaking) order.
      // Each contact's freight = matched indices NOT already claimed by a higher-rank contact.
      const claimedByHigher = new Set<number>();
      const contactFreightMap: Map<string, { loads: number; margin: number; contractedLoads: number; spotLoads: number; sharedLane: boolean }> = new Map();
      for (const contact of sortedContacts) {
        const matchedForContact = contactMatchedIndices.get(contact.id) ?? new Set<number>();
        let loads = 0, margin = 0, contractedLoads = 0, spotLoads = 0;
        let sharedLane = false;
        const marginK2 = cols.marginDollar ?? "Margin $";
        const orderTypeK = cols.orderType ?? "Order Type";
        for (const idx of matchedForContact) {
          if (claimedByHigher.has(idx)) {
            sharedLane = true; // this index was won by a higher-ranked contact
            continue;
          }
          const row = rawRows[idx];
          const rowMargin = parseFloat(String(row[marginK2] || 0).replace(/[$,]/g, "")) || 0;
          const isSpot = String(row[orderTypeK] || "").toLowerCase().includes("spot");
          loads++;
          margin += rowMargin;
          if (isSpot) spotLoads++; else contractedLoads++;
        }
        // Mark all this contact's matched indices as claimed (so lower-rank contacts show sharedLane)
        matchedForContact.forEach(idx => claimedByHigher.add(idx));
        contactFreightMap.set(contact.id, { loads, margin, contractedLoads, spotLoads, sharedLane });
      }

      // seenForCompany tracks every row index claimed by any contact (for unattributed + total calc).
      // claimedByHigher already accumulates all matched indices across all contacts by the end of
      // the second pass — alias it here so the unattributed/total calc below can use it directly.
      const seenForCompany = claimedByHigher;

      const contactResults = sortedContacts
        .map(contact => {
          const contactAttribs = allAttributions.filter(a => a.contactId === contact.id);
          const hasAttribs = contactAttribs.length > 0;
          const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
          const hasNoAttribution = !hasAttribs && !hasLaneStrings;
          const attributionSource: "explicit" | "estimate" | "none" =
            hasAttribs ? "explicit" : hasLaneStrings ? "estimate" : "none";

          // Check broad state-only warning for fallback lane strings.
          // Only warn if: (1) all matchers are state-only broad, AND (2) matched count > 0,
          // AND (3) matched rows exceed 20% of the company's total freight.
          let hasBroadLaneWarning = false;
          if (!hasAttribs && hasLaneStrings && rawRows.length > 0) {
            const check = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || []);
            if (check.hasBroadStateOnly && check.matchedIndices.size > 0) {
              const companyTotal = computeCompanyFreightTotal(rawRows, cols, companyNames);
              hasBroadLaneWarning = companyTotal.allIndices.size > 0 && (check.matchedIndices.size / companyTotal.allIndices.size) > 0.2;
            }
          }

          const freight = contactFreightMap.get(contact.id) ?? { loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0, sharedLane: false };
          const base = normRelationshipBase(contact.relationshipBase);
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
            hasNoAttribution,
            attributionSource,
            hasBroadLaneWarning,
            sharedLane: freight.sharedLane,
            attributions: contactAttribs,
            loads: freight.loads,
            margin: freight.margin,
            contractedLoads: freight.contractedLoads,
            spotLoads: freight.spotLoads,
            marginPerLoad,
            contractedPct,
            spotPct,
          };
        })
        .filter(Boolean);

      // Compute deduplicated totals + unattributed loads (company rows not matched by any contact).
      // seenForCompany now tracks exactly which rows were claimed (priority-ordered), so the
      // sum of per-contact claimed loads equals totalLoads and unattributed is accurate.
      let unattributedLoads = 0;
      let unattributedMargin = 0;
      let totalLoads = 0;
      let totalMargin = 0;
      if (rawRows.length > 0) {
        const companyTotal = computeCompanyFreightTotal(rawRows, cols, companyNames);
        const marginK = cols.marginDollar ?? "Margin $";
        for (const idx of companyTotal.allIndices) {
          if (!seenForCompany.has(idx)) {
            unattributedLoads++;
            unattributedMargin += parseFloat(String(rawRows[idx][marginK] || 0).replace(/[$,]/g, "")) || 0;
          }
        }
        // Deduplicated total: rows claimed by at least one contact
        for (const idx of seenForCompany) {
          const marginK2 = cols.marginDollar ?? "Margin $";
          totalLoads++;
          totalMargin += parseFloat(String(rawRows[idx][marginK2] || 0).replace(/[$,]/g, "")) || 0;
        }
      }

      res.json({ contacts: contactResults, companyId: company.id, unattributedLoads, unattributedMargin, totalLoads, totalMargin });
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

      // Bulk load contacts + lane attributions (single queries, no N+1)
      const allContacts = await storage.getContactsByCompanyIds(visibleCompanyIds);
      const allAttributionsList = await storage.getLaneAttributionsByCompanyIds(visibleCompanyIds);

      const rawRows: any[] = upload?.rows ?? [];
      const cols = rawRows.length ? resolveColumns(rawRows) : {} as any;
      const marginK = cols.marginDollar ?? "Margin $";

      const BASE_LABELS: Record<string, string> = { "1st": "1st Base", "2nd": "2nd Base", "3rd": "3rd Base", "hr": "Home Run" };
      const BASE_ORDER = ["1st", "2nd", "3rd", "hr"];

      // ── Classify companies as "worked" vs "unworked" ────────────────────────
      // A company is "worked" if at least one of its contacts has a relationship base set.
      // "Unworked" companies have freight but no mapped relationship base at all.
      const workedCompanyIds = new Set<string>(
        allContacts.filter(c => c.relationshipBase && c.relationshipBase.trim()).map(c => c.companyId)
      );
      const unworkedCompanyIds = visibleCompanyIds.filter(id => !workedCompanyIds.has(id));

      // ── Group by relationship base (worked companies only) ───────────────────
      const grouped: Record<string, { contacts: number; loads: number; margin: number; contractedLoads: number; spotLoads: number }> = {};
      for (const base of BASE_ORDER) grouped[base] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };
      grouped["unknown"] = { contacts: 0, loads: 0, margin: 0, contractedLoads: 0, spotLoads: 0 };

      // Phase 1: base rank for tie-breaking — higher rank wins (hr > 3rd > 2nd > 1st > unknown)
      const DASH_BASE_RANK: Record<string, number> = { hr: 4, "3rd": 3, "2nd": 2, "1st": 1, unknown: 0 };

      // Phase 1: sort contacts by base rank descending (per company) so highest-rank contacts
      // claim shared lanes first — makes attribution deterministic and consistent with company portlet.
      const sortedAllContacts = [...allContacts].sort((a, b) => {
        const rankA = DASH_BASE_RANK[normRelationshipBase(a.relationshipBase)] ?? 0;
        const rankB = DASH_BASE_RANK[normRelationshipBase(b.relationshipBase)] ?? 0;
        if (rankB !== rankA) return rankB - rankA;
        // Secondary stable sort by id for fully deterministic same-base ordering
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      // Per-company deduplication set: tracks row indices already counted for each company's aggregate
      const companySeenIndices: Record<string, Set<number>> = {};

      // Count contacts per base first (independent of freight)
      for (const contact of allContacts) {
        if (!workedCompanyIds.has(contact.companyId)) continue;
        const base = normRelationshipBase(contact.relationshipBase);
        grouped[base].contacts++;
      }

      // Worked companies: attribute freight to each contact's relationship base (sorted by rank)

      for (const contact of sortedAllContacts) {
        if (!workedCompanyIds.has(contact.companyId)) continue; // skip unworked company contacts

        const contactAttribs = allAttributionsList.filter(a => a.contactId === contact.id);
        const hasAttribs = contactAttribs.length > 0;
        const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);

        const base = normRelationshipBase(contact.relationshipBase);

        if (rawRows.length > 0 && (hasAttribs || hasLaneStrings)) {
          const companyNames = companyNameMap[contact.companyId] ?? [];
          if (!companySeenIndices[contact.companyId]) companySeenIndices[contact.companyId] = new Set<number>();
          const seenForCompany = companySeenIndices[contact.companyId];

          // PRIORITY RULE: explicit attributions take precedence; lane strings are only a fallback
          if (hasAttribs) {
            const m = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs, seenForCompany);
            grouped[base].loads += m.loads;
            grouped[base].margin += m.margin;
            grouped[base].contractedLoads += m.contractedLoads;
            grouped[base].spotLoads += m.spotLoads;
            m.matchedIndices.forEach(idx => seenForCompany.add(idx));
          } else {
            // Phase 2: broad state-only lane strings are INCLUDED when they are the contact's sole
            // attribution method; they are excluded only when more specific matchers also exist.
            const m = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || [], seenForCompany);
            grouped[base].loads += m.loads;
            grouped[base].margin += m.margin;
            grouped[base].contractedLoads += m.contractedLoads;
            grouped[base].spotLoads += m.spotLoads;
            m.matchedIndices.forEach(idx => seenForCompany.add(idx));
          }
        }
      }

      // ── Unassigned contacts (worked company, has lanes, but no base set) ─────
      let totalUnassignedContacts = 0;
      for (const contact of allContacts) {
        if (!workedCompanyIds.has(contact.companyId)) continue;
        const base = normRelationshipBase(contact.relationshipBase);
        const hasLaneStrings = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
        const hasAttribs = allAttributionsList.some(a => a.contactId === contact.id);
        if (base === "unknown" && (hasLaneStrings || hasAttribs)) totalUnassignedContacts++;
      }

      // ── Unworked Accounts freight ────────────────────────────────────────────
      // Compute ALL freight for unworked companies (no lane filtering needed — entire company is uncovered)
      let unworkedLoads = 0;
      let unworkedMargin = 0;
      const unworkedCompanyCount = unworkedCompanyIds.length;
      if (rawRows.length > 0) {
        for (const companyId of unworkedCompanyIds) {
          const companyNames = companyNameMap[companyId] ?? [];
          if (companyNames.length === 0) continue;
          const total = computeCompanyFreightTotal(rawRows, cols, companyNames);
          unworkedLoads += total.loads;
          unworkedMargin += total.margin; // reuse already-computed margin (avoids double parsing)
        }
      }

      // ── Unattributed loads (worked companies, lanes not covered by any contact) ──
      let totalUnattributedLoads = 0;
      let totalUnattributedMargin = 0;
      if (rawRows.length > 0) {
        for (const companyId of visibleCompanyIds) {
          if (!workedCompanyIds.has(companyId)) continue; // unworked companies are handled separately
          const companyNames = companyNameMap[companyId] ?? [];
          if (companyNames.length === 0) continue;
          const companyTotal = computeCompanyFreightTotal(rawRows, cols, companyNames);
          const seen = companySeenIndices[companyId] ?? new Set<number>();
          for (const idx of companyTotal.allIndices) {
            if (!seen.has(idx)) {
              totalUnattributedLoads++;
              totalUnattributedMargin += parseFloat(String(rawRows[idx][marginK] || 0).replace(/[$,]/g, "")) || 0;
            }
          }
        }
      }

      // ── Build summary rows ───────────────────────────────────────────────────
      const summaryBases = [...BASE_ORDER, ...(grouped["unknown"].contacts > 0 ? ["unknown"] : [])];
      const summary = summaryBases.map(base => ({
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

      res.json({
        summary,
        totalContacts,
        totalLoads,
        totalMargin,
        unattributedLoads: totalUnattributedLoads,
        unattributedMargin: totalUnattributedMargin,
        unworkedAccounts: unworkedCompanyCount,
        unworkedLoads,
        unworkedMargin,
        unassignedContacts: totalUnassignedContacts,
      });
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
        const base = normRelationshipBase(contact.relationshipBase);
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

      const relSumCacheKey = `rel-summary:${user.id}`;
      const relSumCached = cacheGet(relSumCacheKey);
      if (relSumCached) return res.json(relSumCached);

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

      // FIX 6: Replace N+1 per-company queries with a single bulk fetch
      const allAttributionsListS = await storage.getLaneAttributionsByCompanyIds(visibleCompanyIds);

      // FIX 2 & 3: Add per-company deduplication (seenIndices) and sort contacts by base priority
      // so the highest-value relationship claims a shared load row first.
      const BASE_PRIORITY_DS: Record<string, number> = { hr: 0, "3rd": 1, "2nd": 2, "1st": 3, unknown: 4 };
      const companySeenIndicesDS: Record<string, Set<number>> = {};
      const sortedAllContactsDS = [...allContacts].sort((a, b) => {
        const pa = BASE_PRIORITY_DS[normBaseS(a.relationshipBase)] ?? 4;
        const pb = BASE_PRIORITY_DS[normBaseS(b.relationshipBase)] ?? 4;
        return pa - pb;
      });

      for (const contact of sortedAllContactsDS) {
        if (!contact.relationshipBase || !contact.relationshipBase.trim()) continue;
        const contactAttribs = allAttributionsListS.filter(a => a.contactId === contact.id);
        const hasAttribsS = contactAttribs.length > 0;
        const hasLaneStringsS = (contact.lanes && contact.lanes.length > 0) || (contact.regions && contact.regions.length > 0);
        if (!hasAttribsS && !hasLaneStringsS) continue;

        const base = normBaseS(contact.relationshipBase);
        groupedS[base].contacts++;

        if (rawRows.length > 0) {
          const companyNames = companyNameMap[contact.companyId] ?? [];
          if (!companySeenIndicesDS[contact.companyId]) companySeenIndicesDS[contact.companyId] = new Set<number>();
          const seenDS = companySeenIndicesDS[contact.companyId];

          // FIX 1: Priority rule — explicit attributions take precedence; lane strings are a fallback
          // (previously both branches ran additively — now strictly one or the other)
          if (hasAttribsS) {
            const m = computeFreightMetrics(rawRows, cols, companyNames, contactAttribs, seenDS);
            groupedS[base].loads += m.loads;
            groupedS[base].margin += m.margin;
            groupedS[base].contractedLoads += m.contractedLoads;
            groupedS[base].spotLoads += m.spotLoads;
            m.matchedIndices.forEach(idx => seenDS.add(idx));
          } else {
            const m = computeFreightFromContactLaneStrings(rawRows, cols, companyNames, contact.lanes || [], contact.regions || [], seenDS);
            groupedS[base].loads += m.loads;
            groupedS[base].margin += m.margin;
            groupedS[base].contractedLoads += m.contractedLoads;
            groupedS[base].spotLoads += m.spotLoads;
            m.matchedIndices.forEach(idx => seenDS.add(idx));
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

      // ── Unworked Accounts (no relationship base set on any contact) ──────────
      const marginKDS = (cols as any).marginDollar ?? "Margin $";
      const workedCompanyIdsDS = new Set<string>(
        allContacts.filter((c: any) => c.relationshipBase && c.relationshipBase.trim()).map((c: any) => c.companyId)
      );
      const unworkedCompanyIdsDS = visibleCompanyIds.filter(id => !workedCompanyIdsDS.has(id));
      let unworkedLoadsDS = 0;
      let unworkedMarginDS = 0;
      if (rawRows.length > 0) {
        for (const companyId of unworkedCompanyIdsDS) {
          const companyNames = companyNameMap[companyId] ?? [];
          if (companyNames.length === 0) continue;
          const total = computeCompanyFreightTotal(rawRows, cols, companyNames);
          unworkedLoadsDS += total.loads;
          for (const idx of total.allIndices) {
            unworkedMarginDS += parseFloat(String(rawRows[idx][marginKDS] || 0).replace(/[$,]/g, "")) || 0;
          }
        }
      }

      // ── Unattributed loads (worked companies, unclaimed by any contact lane) ──
      let totalUnattributedLoadsDS = 0;
      let totalUnattributedMarginDS = 0;
      if (rawRows.length > 0) {
        for (const companyId of visibleCompanyIds) {
          if (!workedCompanyIdsDS.has(companyId)) continue;
          const companyNames = companyNameMap[companyId] ?? [];
          if (companyNames.length === 0) continue;
          const companyTotal = computeCompanyFreightTotal(rawRows, cols, companyNames);
          const seen = companySeenIndicesDS[companyId] ?? new Set<number>();
          for (const idx of companyTotal.allIndices) {
            if (!seen.has(idx)) {
              totalUnattributedLoadsDS++;
              totalUnattributedMarginDS += parseFloat(String(rawRows[idx][marginKDS] || 0).replace(/[$,]/g, "")) || 0;
            }
          }
        }
      }

      const relSumResult = {
        distribution: {
          levels: distLevels,
          recentAdvances: recentAdvances2,
          totalCompanies: visibleCompanyIds.length,
          totalContacts: allContacts.length,
          greenfieldCount: greenfieldCount2,
        },
        summary: {
          summary: summaryResult,
          totalContacts,
          totalLoads,
          totalMargin,
          unattributedLoads: totalUnattributedLoadsDS,
          unattributedMargin: totalUnattributedMarginDS,
          unworkedAccounts: unworkedCompanyIdsDS.length,
          unworkedLoads: unworkedLoadsDS,
          unworkedMargin: unworkedMarginDS,
        },
      };
      cacheSet(relSumCacheKey, relSumResult, 10 * 60 * 1000);
      res.json(relSumResult);
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

  // Idempotent procurement task generation — server validates qualifying lanes (any parseable origin → destination) and finds-or-creates
  // Helper: normalize a lane string for dedup matching (trim, collapse whitespace, lowercase)
  function normalizeLane(lane: string): string {
    return lane.trim().replace(/\s+/g, " ").toLowerCase();
  }

  // GET existing procurement tasks for an award (for AwardCard "already set up" indicator)
  app.get("/api/awards/:awardId/procurement-tasks", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { awardId } = req.params;
      if (!(await verifyAwardAccess(user, awardId))) return res.status(403).json({ error: "Access denied" });
      // Count tasks by awardId directly — not gated by current parseable lanes
      const taskCount = await storage.countProcurementTasksByAward(awardId);
      return res.status(200).json({ taskCount });
    } catch (err) {
      console.error("procurement-tasks GET error", err);
      return res.status(500).json({ error: "Failed to check procurement tasks" });
    }
  });

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
      if (!award.lanes || award.lanes.length === 0) {
        return res.status(400).json({ error: "This award has no lanes. Edit the award and add lanes in Origin → Destination format before generating tasks." });
      }
      // Parse award lane strings server-side; origin/dest/volume are derived here, not trusted from client
      const lanePattern = /^(.+?)\s*(?:→|->|\bto\b)\s*(.+?)(?:\s*\((\d[\d,]*)\s*(?:loads?|shipments?|shpts?)[^)]*\))?$/i;
      type LaneMeta = { origin: string; destination: string; volume: number };
      const qualifyingLaneMap = new Map<string, LaneMeta>(
        (award.lanes ?? [])
          .map((l: string) => {
            const normalized = normalizeLane(l);
            const m = normalized.match(lanePattern);
            if (!m) return null;
            const volume = m[3] ? parseInt(m[3].replace(/,/g, "")) : 0;
            return [normalized, { origin: m[1].trim(), destination: m[2].trim(), volume }] as [string, LaneMeta];
          })
          .filter((entry): entry is [string, LaneMeta] => entry !== null)
      );
      // Process all server-computed qualifying lanes (any parseable origin → destination)
      const validLaneEntries = [...qualifyingLaneMap.entries()];
      if (validLaneEntries.length === 0) return res.status(400).json({ error: "No parseable lanes found for this award. Edit the award and ensure lanes use Origin → Destination format (e.g., Chicago, IL → Memphis, TN)." });
      const company = award.companyId ? await storage.getCompany(award.companyId) : null;
      const customerName = company?.name ?? null;
      const awardTitle = award.title ?? null;
      // Per-key serialization prevents concurrent requests from creating duplicate tasks for the same lane
      // Use Promise.allSettled so a single lane DB error does not fail the entire request
      const settled = await Promise.allSettled(validLaneEntries.map(([laneName, meta]) => {
        const lockKey = `${awardId}:${laneName}`;
        if (!procTaskCreationLocks.has(lockKey)) {
          const op = (async () => {
            const existing = await storage.findProcurementTask(awardId, laneName);
            if (existing) return { lane: laneName, taskId: existing.id, created: false };
            // Resolve equipment type from a matching recurring lane (if one exists)
            // This enables precise equipment-aware matching in My Procurement later.
            const normOrigin = normalizeLaneLocation(meta.origin);
            const normDest = normalizeLaneLocation(meta.destination);
            const laneEquipRow = await storage.pool.query<{ equipment_type: string | null }>(
              `SELECT equipment_type FROM recurring_lanes
               WHERE org_id = $1
                 AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(origin), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g')) = $2
                 AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(destination), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g')) = $3
               ORDER BY assigned_at DESC NULLS LAST LIMIT 1`,
              [user.organizationId, normOrigin, normDest]
            );
            const rawEquip = laneEquipRow.rows[0]?.equipment_type ?? null;
            const equipmentType = rawEquip ? normalizeEquipmentType(rawEquip) : null;
            const task = await storage.createTask({
              title: `Carrier Procurement — ${laneName}`,
              notes: `Procurement workspace for lane: ${laneName}${meta.volume > 0 ? ` (${meta.volume.toLocaleString()} loads/yr)` : ""}. Award ID: ${awardId}. Target 5–10 carrier contacts.`,
              status: "open",
              dueDate: null,
              assignedTo: user.id,
              assignedBy: user.id,
              companyId: award.companyId ?? null,
              contactId: null,
              attachedLaneData: [{ type: "carrier_procurement", lane: laneName, origin: meta.origin, destination: meta.destination, volume: meta.volume, awardId, awardTitle, customerName, equipmentType }],
              createdAt: new Date().toISOString(),
            });
            return { lane: laneName, taskId: task.id, created: true };
          })();
          procTaskCreationLocks.set(lockKey, op.finally(() => procTaskCreationLocks.delete(lockKey)));
        }
        return procTaskCreationLocks.get(lockKey)!;
      }));
      const results: Array<{ lane: string; taskId: string; created: boolean; failed?: boolean }> = settled.map((s, i) => {
        if (s.status === "fulfilled") return s.value;
        const laneName = validLaneEntries[i][0];
        console.error(`procurement-tasks: lane "${laneName}" failed`, s.reason);
        return { lane: laneName, taskId: "", created: false, failed: true };
      });
      const successCount = results.filter(r => !r.failed).length;
      if (successCount === 0) {
        return res.status(500).json({ error: "Failed to generate procurement tasks for all lanes" });
      }
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

      const lmCompany = award.companyId ? await storage.getCompany(award.companyId) : null;
      const lmCustomerName = lmCompany?.name ?? null;
      const lmAwardTitle = award.title ?? null;

      const existing = await storage.findProcurementTask(awardId, lane);
      if (existing) {
        // Reassign existing task to the LM
        await storage.updateTask(existing.id, { assignedTo: assignToUserId, assignedBy: user.id });
        taskId = existing.id;
      } else {
        // Resolve equipment type from a matching recurring lane for precise My Procurement matching
        const lmNormOrigin = normalizeLaneLocation(origin);
        const lmNormDest = normalizeLaneLocation(destination);
        const lmEquipRow = await storage.pool.query<{ equipment_type: string | null }>(
          `SELECT equipment_type FROM recurring_lanes
           WHERE org_id = $1
             AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(origin), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g')) = $2
             AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(destination), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g')) = $3
           ORDER BY assigned_at DESC NULLS LAST LIMIT 1`,
          [user.organizationId, lmNormOrigin, lmNormDest]
        );
        const lmRawEquip = lmEquipRow.rows[0]?.equipment_type ?? null;
        const lmEquipmentType = lmRawEquip ? normalizeEquipmentType(lmRawEquip) : null;
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
          attachedLaneData: [{ type: "carrier_procurement", lane, origin, destination, volume, awardId, awardTitle: lmAwardTitle, customerName: lmCustomerName, equipmentType: lmEquipmentType }],
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
  const LANE_CARRIER_STATUS_ENUM = ["contacted", "emailed", "committed", "declined"] as const;
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

      const senderName = user.name || user.username || "the sender";

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

      const systemPrompt = `You are a freight broker at Freight-DNA / Value Truck writing a short email to a shipper contact.

House style — follow every rule:
- Sound like a freight broker, not a corporate sales rep or account manager. Direct, conversational, freight-native.
- 3–5 short sentences MAX. Under 120 words total.
- BANNED phrases — never use any of these:
  "I hope this email finds you well", "I wanted to follow up on our recent exchanges",
  "reaching out about", "just checking in", "I wanted to touch base",
  "as per our last conversation", "circling back", "loop you in",
  "value your partnership", "mutually beneficial", "synergy",
  "at your earliest convenience", "please don't hesitate"
- When you have little context about the contact or company, write a SHORT and HONEST email. Do NOT pad with vague filler or generic pleasantries. Fewer sentences is better than empty ones.
- End with a concrete operational ask — something the recipient can act on. Examples: "Got anything moving this week?", "What lanes are giving you headaches right now?", "Any freight we should be quoting on?"
- Sign off with ONLY the name: ${senderName}. No "Best regards", no "Sincerely", no "Thanks," — just the name on its own line.
- Do NOT include any placeholder like [Your Name] or [Name]. Use the exact sender name provided above.
- Output ONLY the email body. No subject line. No extra commentary.`;

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
        model: "gpt-4o",
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
      if (!["admin", "director", "national_account_manager", "sales", "sales_director"].includes(user.role ?? "")) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = user.organizationId;
      const allUsers = await storage.getUsers(orgId);
      const repRoles = ["account_manager", "national_account_manager"];
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

      // All prospects (for relationshipsMoved count)
      const allProspects = await storage.getProspects(orgId);
      const prospectsMovedInRange = allProspects.filter(p => {
        if (!p.stageChangedAt) return false;
        const changed = new Date(p.stageChangedAt);
        return changed >= rangeStart && changed <= rangeEnd;
      });

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
        const relationshipsMoved = prospectsMovedInRange.filter(p => p.ownerId === rep.id).length;

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
          relationshipsMoved,
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

  app.get("/api/plays-activity", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!["admin", "director", "national_account_manager", "sales", "sales_director"].includes(user.role ?? "")) {
        return res.status(403).json({ error: "Access denied" });
      }

      const orgId = user.organizationId;
      const allUsers = await storage.getUsers(orgId);
      const repRoles = ["account_manager", "national_account_manager"];
      const reps = allUsers.filter(u => repRoles.includes(u.role ?? ""));

      const now = new Date();
      const range = (req.query.range as string) || "last_week";

      let rangeStart: Date;
      let rangeEnd: Date = new Date(now);
      rangeEnd.setHours(23, 59, 59, 999);

      if (range === "mtd") {
        rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
      } else if (range === "last_month") {
        rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        rangeEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        rangeEnd.setHours(23, 59, 59, 999);
      } else if (range === "ytd") {
        rangeStart = new Date(now.getFullYear(), 0, 1);
      } else {
        const day = now.getDay();
        const daysToLastMonday = (day === 0 ? 6 : day - 1) + 7;
        rangeStart = new Date(now);
        rangeStart.setDate(rangeStart.getDate() - daysToLastMonday);
        rangeEnd = new Date(rangeStart);
        rangeEnd.setDate(rangeEnd.getDate() + 6);
        rangeEnd.setHours(23, 59, 59, 999);
      }
      rangeStart.setHours(0, 0, 0, 0);

      const rangeStartStr = rangeStart.toISOString().split("T")[0];
      const rangeEndStr = rangeEnd.toISOString().split("T")[0];

      const allTps = await storage.getTouchpointsSince(rangeStartStr);
      const rangeTps = allTps.filter((t: any) => !t.date || t.date <= rangeEndStr);

      const taggedTps = rangeTps.filter((t: any) => t.playLabel);

      const playCountMap = new Map<string, { total: number; byRep: Map<string, number> }>();
      for (const tp of taggedTps) {
        const label = (tp as any).playLabel as string;
        if (!playCountMap.has(label)) {
          playCountMap.set(label, { total: 0, byRep: new Map() });
        }
        const entry = playCountMap.get(label)!;
        entry.total++;
        const repId = (tp as any).loggedById as string;
        entry.byRep.set(repId, (entry.byRep.get(repId) ?? 0) + 1);
      }

      const plays = Array.from(playCountMap.entries())
        .map(([label, data]) => {
          const topReps = Array.from(data.byRep.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([repId, count]) => {
              const rep = reps.find(r => r.id === repId);
              return { userId: repId, name: rep?.name ?? "Unknown", count };
            });
          return { playLabel: label, totalUsed: data.total, topReps };
        })
        .sort((a, b) => b.totalUsed - a.totalUsed);

      const repPlayStats = reps.map(rep => {
        const repTagged = taggedTps.filter((t: any) => t.loggedById === rep.id);
        const repPlays = new Map<string, number>();
        for (const tp of repTagged) {
          const label = (tp as any).playLabel as string;
          repPlays.set(label, (repPlays.get(label) ?? 0) + 1);
        }
        return {
          userId: rep.id,
          name: rep.name,
          role: rep.role,
          totalPlaysExecuted: repTagged.length,
          plays: Array.from(repPlays.entries())
            .map(([label, count]) => ({ playLabel: label, count }))
            .sort((a, b) => b.count - a.count),
        };
      }).filter(r => r.totalPlaysExecuted > 0).sort((a, b) => b.totalPlaysExecuted - a.totalPlaysExecuted);

      res.json({ plays, repPlayStats });
    } catch (err: any) {
      console.error("[plays-activity]", err?.message ?? err);
      res.status(500).json({ error: "Failed to load plays activity" });
    }
  });

  // ── Weekly Coaching Commitments ──────────────────────────────────────────

  function getWeekStart(date = new Date()): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d.toISOString().split("T")[0];
  }
  function getWeekEnd(weekStart: string): string {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 4);
    return d.toISOString().split("T")[0];
  }

  // Team view MUST come before /:id to avoid route collision
  app.get("/api/weekly-commitments/team", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!managerRoles.includes(currentUser.role)) return res.status(403).json({ error: "Manager access required" });
      const orgId = req.session.organizationId!;
      const weekStart = (req.query.weekStart as string) || getWeekStart();
      const rows = await storage.getTeamWeeklyCommitments(orgId, weekStart);
      res.json(rows);
    } catch (err: any) {
      console.error("[weekly-commitments/team]", err?.message ?? err);
      res.status(500).json({ error: "Failed to load team commitments" });
    }
  });

  app.get("/api/weekly-commitments", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const orgId = req.session.organizationId!;
      const weekStart = req.query.weekStart as string | undefined;
      const rows = await storage.getWeeklyCommitments(currentUser.id, orgId, weekStart);
      res.json(rows);
    } catch (err: any) {
      console.error("[weekly-commitments]", err?.message ?? err);
      res.status(500).json({ error: "Failed to load commitments" });
    }
  });

  app.post("/api/weekly-commitments", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const orgId = req.session.organizationId!;
      // Cross-tenant guard on optional companyId / contactId. The commitment
      // record is rep-owned, but it carries references to a company/contact
      // and surfaces them in dashboards — those references must belong to
      // the same org.
      if (req.body.companyId) {
        const owningCompany = await storage.getCompanyInOrg(req.body.companyId, orgId);
        if (!owningCompany) return res.status(404).json({ error: "Company not found" });
      }
      if (req.body.contactId) {
        const owningContact = await storage.getContact(req.body.contactId);
        if (!owningContact) return res.status(404).json({ error: "Contact not found" });
        const owningCompany = await storage.getCompanyInOrg(owningContact.companyId, orgId);
        if (!owningCompany) return res.status(404).json({ error: "Contact not found" });
      }
      const thisWeek = getWeekStart();
      const dueDate = getWeekEnd(thisWeek);
      const payload = {
        userId: currentUser.id,
        orgId,
        weekStart: thisWeek,
        dueDate,
        createdAt: new Date().toISOString(),
        companyId: req.body.companyId ?? null,
        contactId: req.body.contactId ?? null,
        companyName: req.body.companyName ?? null,
        contactName: req.body.contactName ?? null,
        commitmentText: req.body.commitmentText,
        lever: req.body.lever ?? "Recovery",
        source: req.body.source ?? "dashboard",
        status: "pending" as const,
      };
      if (!payload.commitmentText) return res.status(400).json({ error: "commitmentText is required" });
      const row = await storage.createWeeklyCommitment(payload);
      res.json(row);
    } catch (err: any) {
      console.error("[weekly-commitments POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to create commitment" });
    }
  });

  app.patch("/api/weekly-commitments/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { status } = req.body;
      if (!["pending", "completed", "missed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
      const row = await storage.updateWeeklyCommitmentStatus(req.params.id, currentUser.id, status);
      if (!row) return res.status(404).json({ error: "Commitment not found" });
      res.json(row);
    } catch (err: any) {
      console.error("[weekly-commitments PATCH]", err?.message ?? err);
      res.status(500).json({ error: "Failed to update commitment" });
    }
  });

  app.delete("/api/weekly-commitments/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const ok = await storage.deleteWeeklyCommitment(req.params.id, currentUser.id);
      if (!ok) return res.status(404).json({ error: "Commitment not found" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("[weekly-commitments DELETE]", err?.message ?? err);
      res.status(500).json({ error: "Failed to delete commitment" });
    }
  });

  // ─── NBA Phase 1 Persistent Card Routes ──────────────────────────────────────

  // GET /api/nba/company/:companyId/card — single persistent Phase 1 card for Account 360
  app.get("/api/nba/company/:companyId/card", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      // Enforce company-visibility — cards for foreign-org companies were
      // previously returned to anyone authenticated who guessed the ID.
      if (!(await canAccessCompany(currentUser, req.params.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const card = await storage.getNbaCardForCompany(req.params.companyId);
      if (!card) return res.json(null);

      // Project to the canonical wire shape so this endpoint matches the
      // bulk /api/nba/cards response. Build a minimal ProjectionContext
      // with just the single card's related rows.
      const { contactIds, laneIds } = collectProjectionIds([card]);
      const [contactRows, laneRows] = await Promise.all([
        Promise.all(contactIds.map(id => storage.getContact(id).catch(() => null))),
        Promise.all(laneIds.map(id => storage.getRecurringLane(id).catch(() => null))),
      ]);
      const contacts = new Map<string, Contact>(
        contactRows.filter((c): c is Contact => !!c).map(c => [c.id, c]),
      );
      const lanes = new Map<string, RecurringLane>(
        laneRows.filter((l): l is RecurringLane => !!l).map(l => [l.id, l]),
      );
      const userIds = new Set<string>();
      for (const lane of lanes.values()) {
        if (lane.ownerUserId) userIds.add(lane.ownerUserId);
        if (lane.overseerUserId) userIds.add(lane.overseerUserId);
      }
      const userRows = await Promise.all([...userIds].map(id => storage.getUser(id)));
      const userMap = new Map<string, User>(
        userRows.filter((u): u is User => !!u).map(u => [u.id, u]),
      );

      res.json(projectNbaCard(card, { contacts, lanes, users: userMap }));
    } catch (err: any) {
      console.error("[nba/company/card GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch company NBA card" });
    }
  });

  // GET /api/nba/cards — fetch visible cards for the current user
  // Directors and admins get all visible cards in the org (portfolio view).
  app.get("/api/nba/cards", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const isPortfolioRole = ["admin", "director"].includes(currentUser.role);
      let cards;
      if (isPortfolioRole) {
        // Portfolio roles (admin/director) see all org-wide cards — allow up to 200
        const limit = Math.min(Number(req.query.limit ?? 200), 200);
        cards = await storage.getVisibleNbaCardsForOrg(currentUser.organizationId, limit);
      } else {
        // Default cap is 5 (focused triage) but reps can request up to 50 when
        // they are sorting/filtering by at-stake $ (Task #372 — triage by impact).
        const limit = Math.min(Number(req.query.limit ?? 5), 50);
        cards = await storage.getVisibleNbaCards(currentUser.id, limit);
      }
      // Exclude cards tied to archived companies
      const orgCompanies = await storage.getCompanies(currentUser.organizationId);
      const archivedIds = new Set(orgCompanies.filter(c => c.archivedAt).map(c => c.id));
      let activeCards = cards.filter(c => !c.companyId || !archivedIds.has(c.companyId));
      // Suppress recurring_lane_capacity cards when feature flag is disabled
      const laneOutreachEnabled = await storage.getFeatureFlag(currentUser.organizationId, "lane_carrier_outreach_v1");
      if (!laneOutreachEnabled) {
        activeCards = activeCards.filter(c => c.ruleType !== "recurring_lane_capacity");
      }

      // Task #372 — enrich every card with primary contact + primary lane display info
      const allContactIds = [
        ...new Set(activeCards.map(c => c.primaryContactId).filter((v): v is string => !!v)),
      ];
      const allLaneIds = [
        ...new Set([
          ...activeCards.map(c => c.primaryLaneId).filter((v): v is string => !!v),
          ...activeCards.map(c => c.linkedLaneId).filter((v): v is string => !!v),
        ]),
      ];
      const [contactRows, laneRows] = await Promise.all([
        Promise.all(
          allContactIds.map(id =>
            storage.getContact ? storage.getContact(id).catch(() => null) : Promise.resolve(null),
          ),
        ),
        Promise.all(allLaneIds.map(id => storage.getRecurringLane(id).catch(() => null))),
      ]);
      const contactMap = new Map<string, Contact>(
        contactRows
          .filter((c): c is Contact => !!c)
          .map(c => [c.id, c]),
      );
      const laneInfoMap = new Map<string, RecurringLane>(
        laneRows
          .filter((l): l is RecurringLane => !!l)
          .map(l => [l.id, l]),
      );
      activeCards = activeCards.map(c => {
        const pc = c.primaryContactId ? contactMap.get(c.primaryContactId) : null;
        const pl = c.primaryLaneId
          ? laneInfoMap.get(c.primaryLaneId)
          : (c.linkedLaneId ? laneInfoMap.get(c.linkedLaneId) : null);
        return {
          ...c,
          primaryContactName: pc?.name ?? null,
          primaryContactRelationshipBase: pc?.relationshipBase ?? null,
          primaryLaneLabel: pl
            ? `${pl.origin}${pl.originState ? ", " + pl.originState : ""} → ${pl.destination}${pl.destinationState ? ", " + pl.destinationState : ""}`
            : null,
        };
      });

      // Annotate lane-capacity cards with owner/overseer names for admin/director chip display
      const laneCards = activeCards.filter(c => c.ruleType === "recurring_lane_capacity" && c.linkedLaneId);
      if (laneCards.length > 0) {
        const laneIds = [...new Set(laneCards.map(c => c.linkedLaneId!))];
        const lanes = await Promise.all(laneIds.map(id => storage.getRecurringLane(id)));
        const laneMap = new Map(lanes.filter(Boolean).map(l => [l!.id, l!]));

        // Collect unique user IDs for a single batch lookup
        const userIds = new Set<string>();
        lanes.forEach(l => { if (l?.ownerUserId) userIds.add(l.ownerUserId); if (l?.overseerUserId) userIds.add(l.overseerUserId); });
        const userList = await Promise.all([...userIds].map(id => storage.getUser(id)));
        const userMap = new Map(userList.filter(Boolean).map(u => [u!.id, u!]));

        activeCards = activeCards.map(c => {
          if (c.ruleType !== "recurring_lane_capacity" || !c.linkedLaneId) return c;
          const lane = laneMap.get(c.linkedLaneId);
          if (!lane) return c;
          const ownerUser = lane.ownerUserId ? userMap.get(lane.ownerUserId) : undefined;
          const overseerUser = lane.overseerUserId ? userMap.get(lane.overseerUserId) : undefined;
          return {
            ...c,
            laneOwnerName: ownerUser ? (ownerUser.name?.trim() || ownerUser.username) : null,
            laneOverseerName: overseerUser ? (overseerUser.name?.trim() || overseerUser.username) : null,
          };
        });
      }

      res.json(activeCards);
    } catch (err: any) {
      console.error("[nba/cards GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch NBA cards" });
    }
  });

  // PATCH /api/nba/cards/:id/resolve — act on a card (action/dismiss/snooze/alternate)
  app.patch("/api/nba/cards/:id/resolve", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { action, dismissReason, snoozeUntil, alternateActionNote, linkedCommitmentId, linkedTouchpointId, linkedTaskId } = req.body;

      const validActions = ["actioned", "dismissed", "snoozed", "alternate"];
      if (!validActions.includes(action)) {
        return res.status(400).json({ error: `action must be one of ${validActions.join(", ")}` });
      }

      // recurring_lane_capacity cards can only be completed via outreach threshold
      // or preferred-carrier program toggle — block direct manual resolution
      if (action === "actioned") {
        const card = await storage.getNbaCard(req.params.id);
        if (card?.ruleType === "recurring_lane_capacity") {
          return res.status(409).json({ error: "Lane capacity cards complete automatically when outreach threshold is reached or a preferred-carrier program is activated" });
        }
      }

      const now = new Date().toISOString();
      const updateData: Record<string, unknown> = { status: action, resolvedAt: now };
      if (action === "dismissed")  updateData.dismissReason = dismissReason ?? null;
      if (action === "snoozed")    updateData.snoozeUntil = snoozeUntil;
      if (action === "alternate")  updateData.alternateActionNote = alternateActionNote ?? null;
      if (linkedCommitmentId)      updateData.linkedCommitmentId = linkedCommitmentId;
      if (linkedTouchpointId)      updateData.linkedTouchpointId = linkedTouchpointId;
      if (linkedTaskId)            updateData.linkedTaskId = linkedTaskId;

      const updated = await storage.resolveNbaCard(req.params.id, currentUser.id, updateData);
      if (!updated) return res.status(404).json({ error: "Card not found or not yours" });
      // Task #374: lifecycle events — both the action-specific event and a
      // generic "resolved" event so analytics can reason about resolution
      // independent of the resolution kind (acted/dismissed/snoozed/alternate).
      try {
        await storage.recordNbaCardEvent({
          cardId: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          eventType: action === "actioned" ? "acted" : action,
          reason: action === "dismissed" ? (dismissReason ?? null) : null,
          actorUserId: currentUser.id,
          metadata: action === "snoozed" ? { snoozeUntil } : action === "alternate" ? { alternateActionNote } : null,
        });
        await storage.recordNbaCardEvent({
          cardId: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          eventType: "resolved",
          reason: action,
          actorUserId: currentUser.id,
          metadata: null,
        });
      } catch (e) { console.error("[nba/cards PATCH event]", e); }
      res.json(updated);
    } catch (err: any) {
      console.error("[nba/cards PATCH]", err?.message ?? err);
      res.status(500).json({ error: "Failed to resolve NBA card" });
    }
  });

  // POST /api/nba/cards/:id/view — Task #374 mark a card as viewed by the rep
  app.post("/api/nba/cards/:id/view", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const updated = await storage.markNbaCardViewed(req.params.id, currentUser.id, currentUser.organizationId);
      if (!updated) return res.status(404).json({ error: "Card not found or not yours" });
      res.json({ ok: true, firstViewedAt: updated.firstViewedAt });
    } catch (err: any) {
      console.error("[nba/cards/:id/view POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to record view" });
    }
  });

  // POST /api/nba/cards/:id/link-outcome — attach a touchpoint/task/commitment to a card
  app.post("/api/nba/cards/:id/link-outcome", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { linkedCommitmentId, linkedTouchpointId, linkedTaskId, outcomeTypeLinked } = req.body;
      const now = new Date().toISOString();
      // Linking an outcome implicitly resolves the card as "actioned" so it is
      // (a) no longer visible in the rep's open queue and (b) eligible for the
      // outcome classifier (which only scans non-visible statuses).
      const updateData: Record<string, unknown> = {
        outcomeLinkedAt: now,
        outcomeTypeLinked: outcomeTypeLinked ?? null,
        linkedCommitmentId: linkedCommitmentId ?? null,
        linkedTouchpointId: linkedTouchpointId ?? null,
        linkedTaskId: linkedTaskId ?? null,
        status: "actioned",
        resolutionAction: "link_outcome",
      };
      const updated = await storage.resolveNbaCard(req.params.id, currentUser.id, updateData);
      if (!updated) return res.status(404).json({ error: "Card not found or not yours" });
      try {
        // link-outcome implicitly resolves the card as "acted". Emit the same
        // normalized event triple (acted + resolved + outcome_linked) the PATCH
        // path emits so the lifecycle is uniform across all resolution paths.
        await storage.recordNbaCardEvent({
          cardId: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          eventType: "acted",
          actorUserId: currentUser.id,
          reason: "link_outcome",
          metadata: null,
        });
        await storage.recordNbaCardEvent({
          cardId: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          eventType: "resolved",
          actorUserId: currentUser.id,
          reason: "link_outcome",
          metadata: null,
        });
        await storage.recordNbaCardEvent({
          cardId: updated.id,
          orgId: updated.orgId,
          userId: updated.userId,
          eventType: "outcome_linked",
          actorUserId: currentUser.id,
          metadata: { outcomeTypeLinked, linkedCommitmentId, linkedTouchpointId, linkedTaskId },
        });
      } catch (e) { console.error("[nba/cards/link-outcome event]", e); }
      res.json(updated);
    } catch (err: any) {
      console.error("[nba/cards/link-outcome POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to link outcome" });
    }
  });

  // GET /api/nba/my-impact — Task #374 rep-facing "Your NBA impact" summary
  app.get("/api/nba/my-impact", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      // Default to "this calendar month" (days elapsed since the 1st) per spec;
      // callers can override with ?daysBack=N for an explicit rolling window.
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthDays = Math.max(1, Math.ceil((now.getTime() - startOfMonth.getTime()) / (24 * 60 * 60 * 1000)));
      const daysBack = req.query.daysBack
        ? Math.min(Number(req.query.daysBack), 90)
        : monthDays;
      const summary = await storage.getNbaImpactForUser(currentUser.id, currentUser.organizationId, daysBack);
      res.json(summary);
    } catch (err: any) {
      console.error("[nba/my-impact GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch NBA impact" });
    }
  });

  // GET /api/nba/team-rollup — Task #374 NAM/Director team NBA rollup portlet
  // Director scope = vertical (director → NAMs → AMs); NAM scope = direct AMs.
  app.get("/api/nba/team-rollup", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { role, organizationId } = currentUser;
      const allowed = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!allowed.includes(role)) return res.status(403).json({ error: "Not authorized" });
      const daysBack = Math.min(Number(req.query.daysBack ?? 30), 90);
      const allUsers = await storage.getUsers(organizationId);
      const directReports = allUsers.filter(u => u.managerId === currentUser.id);
      let amIds: string[] = [];
      if (role === "national_account_manager") {
        amIds = directReports.filter(u => u.role === "account_manager").map(u => u.id);
      } else {
        // Director / admin: walk one more level
        const namIds = directReports.map(u => u.id);
        const ams = allUsers.filter(u => u.role === "account_manager"
          && (namIds.includes(u.managerId ?? "") || u.managerId === currentUser.id));
        amIds = ams.map(u => u.id);
      }
      const rollup = await storage.getNbaTeamRollup(amIds, organizationId, daysBack);
      res.json(rollup);
    } catch (err: any) {
      console.error("[nba/team-rollup GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch team rollup" });
    }
  });

  // GET /api/nba/team-rollup/:repId/cards — Task #374 read-only drill-in into an
  // AM's NBA feed for the rep's manager (NAM, director or admin in scope).
  app.get("/api/nba/team-rollup/:repId/cards", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { role, organizationId } = currentUser;
      const allowed = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!allowed.includes(role)) return res.status(403).json({ error: "Not authorized" });
      const repId = req.params.repId;
      const allUsers = await storage.getUsers(organizationId);
      const rep = allUsers.find(u => u.id === repId);
      if (!rep || rep.organizationId !== organizationId) {
        return res.status(404).json({ error: "Rep not found" });
      }
      // Scope check: rep must roll up to currentUser
      const isInScope =
        role === "admin" ||
        rep.managerId === currentUser.id ||
        ((role === "director" || role === "sales_director") && allUsers.some(u => u.id === rep.managerId && u.managerId === currentUser.id));
      if (!isInScope) return res.status(403).json({ error: "Rep not in your scope" });
      const cards = await storage.getNbaCardsForUserReadonly(repId, organizationId);
      // Decorate with companyName so the manager drill-in shows "Acme — Title"
      const companyIds = Array.from(new Set(cards.map(c => c.companyId).filter(Boolean) as string[]));
      const companyNameMap = new Map<string, string>();
      if (companyIds.length > 0) {
        const cos = await storage.getCompaniesByIds(companyIds, organizationId);
        for (const co of cos) companyNameMap.set(co.id, co.name);
      }
      const decorated = cards.map(c => ({
        ...c,
        companyName: c.companyId ? companyNameMap.get(c.companyId) ?? null : null,
      }));
      res.json({ repId, repName: rep.name, cards: decorated });
    } catch (err: any) {
      console.error("[nba/team-rollup/:repId/cards GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch rep cards" });
    }
  });

  // GET /api/nba/manager-summary — manager view of team NBA card engagement
  app.get("/api/nba/manager-summary", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { role, organizationId } = currentUser;
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!managerRoles.includes(role)) return res.status(403).json({ error: "Not authorized" });
      const weekStart = String(req.query.weekStart ?? new Date().toISOString().split("T")[0].slice(0, 10));
      const summary = await storage.getNbaManagerSummary(organizationId, weekStart);
      res.json(summary);
    } catch (err: any) {
      console.error("[nba/manager-summary GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch manager summary" });
    }
  });

  // GET /api/nba/rule-performance — analytics for the Phase 1 engine
  app.get("/api/nba/rule-performance", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { role, organizationId } = currentUser;
      const managerRoles = ["admin", "director", "national_account_manager", "sales", "sales_director"];
      if (!managerRoles.includes(role)) return res.status(403).json({ error: "Not authorized" });
      const daysBack = Math.min(Number(req.query.daysBack ?? 30), 90);
      const performance = await storage.getNbaRulePerformance(organizationId, daysBack);
      res.json(performance);
    } catch (err: any) {
      console.error("[nba/rule-performance GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch rule performance" });
    }
  });

  // POST /api/nba/run-engine — manually trigger Phase 1 engine for the current org
  app.post("/api/nba/run-engine", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { role, organizationId } = currentUser;
      if (!["admin", "director"].includes(role)) return res.status(403).json({ error: "Admin or Director role required" });

      const { runPhase1EngineForOrg } = await import("./nbaPhase1Engine");
      const { companyResults, laneCapacitySpecs } = await runPhase1EngineForOrg(organizationId, storage);

      let generated = 0;
      let skipped = 0;
      const now = new Date().toISOString();

      // ── Per-company winner cards (all rules except R12) ──────────────────
      for (const { userId, result } of companyResults) {
        if (!result.winner) { skipped++; continue; }

        // Dedup: skip if a card for same company + same rule already exists in last 14 days
        const existing = await storage.getRecentNbaCardByType(result.companyId, result.winner.ruleType, 14);
        if (existing) { skipped++; continue; }

        // Supersede any prior visible/generated card for this company with a DIFFERENT rule type
        await storage.supersedePreviousNbaCards(result.companyId, result.winner.ruleType);

        await storage.createNbaCard({
          orgId: organizationId,
          userId,
          companyId: result.companyId,
          companyName: result.companyName,
          ruleType: result.winner.ruleType,
          outcomeType: result.winner.outcomeType,
          confidence: result.winner.confidence,
          signalCount: result.winner.signalCount,
          signalSummary: result.winner.signalSummary,
          whyThisNow: result.winner.whyThisNow,
          suggestedAction: result.winner.suggestedAction,
          expectedOutcome: result.winner.expectedOutcome,
          growthLever: result.winner.growthLever,
          relationshipMove: result.winner.relationshipMove,
          accountTier: result.winner.accountTier,
          urgencyScore: result.winner.urgencyScore,
          playLabel: getPlayForRuleType(result.winner.ruleType)?.name ?? null,
          status: "visible",
          createdAt: now,
          contactId: result.winner.contactId,
          linkedTaskId: result.winner.linkedTaskId,
          linkedLaneId: result.winner.linkedLaneId,
        });

        generated++;
      }

      // ── R12: per-lane × owner cards (dedup by laneId + userId) ──────────
      for (const spec of laneCapacitySpecs) {
        // Dedup: skip if a recurring_lane_capacity card for this lane already exists in last 30 days
        const existingLane = await storage.getRecentNbaCardByLane(spec.laneId, spec.userId, 30);
        if (existingLane) { skipped++; continue; }

        await storage.createNbaCard({
          orgId: organizationId,
          userId: spec.userId,
          companyId: spec.companyId,
          companyName: spec.companyName,
          ruleType: spec.candidate.ruleType,
          outcomeType: spec.candidate.outcomeType,
          confidence: spec.candidate.confidence,
          signalCount: spec.candidate.signalCount,
          signalSummary: spec.candidate.signalSummary,
          whyThisNow: spec.candidate.whyThisNow,
          suggestedAction: spec.candidate.suggestedAction,
          expectedOutcome: spec.candidate.expectedOutcome,
          growthLever: spec.candidate.growthLever,
          relationshipMove: spec.candidate.relationshipMove,
          accountTier: spec.candidate.accountTier,
          urgencyScore: spec.candidate.urgencyScore,
          playLabel: getPlayForRuleType(spec.candidate.ruleType)?.name ?? null,
          status: "visible",
          createdAt: now,
          linkedLaneId: spec.laneId,
        });

        generated++;
      }

      res.json({ generated, skipped, total: companyResults.length + laneCapacitySpecs.length });
    } catch (err: any) {
      console.error("[nba/run-engine POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to run NBA engine" });
    }
  });

  // ── Account Contact Suggestions (Task #201) ───────────────────────────────

  /** GET /api/internal/accounts/suggestion-counts — batch pending count per account */
  app.get("/api/internal/accounts/suggestion-counts", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const counts = await storage.countPendingContactSuggestionsByOrg(currentUser.organizationId);
      res.json(counts);
    } catch (err: any) {
      console.error("[suggestion-counts GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch suggestion counts" });
    }
  });

  /** GET /api/internal/accounts/:accountId/contact-suggestions */
  app.get("/api/internal/accounts/:accountId/contact-suggestions", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { accountId } = req.params as { accountId: string };
      const company = await storage.getCompanyInOrg(accountId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Account not found" });
      const status = req.query.status as string | undefined;
      const suggestions = await storage.getAccountContactSuggestions(accountId, status);
      // Only return pending / snoozed suggestions (exclude accepted/ignored/never_suggest unless explicitly requested)
      const filtered = status ? suggestions : suggestions.filter(s => s.status === "pending" || s.status === "snoozed");
      res.json(filtered);
    } catch (err: any) {
      console.error("[contact-suggestions GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch suggestions" });
    }
  });

  /** POST /api/internal/accounts/:accountId/contact-suggestions/:id/accept */
  app.post("/api/internal/accounts/:accountId/contact-suggestions/:id/accept", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { accountId, id } = req.params as { accountId: string; id: string };
      const company = await storage.getCompanyInOrg(accountId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Account not found" });
      const suggestion = await storage.getAccountContactSuggestion(id);
      if (!suggestion || suggestion.accountId !== accountId) return res.status(404).json({ error: "Suggestion not found" });

      const { roleType } = req.body as { roleType?: string };

      // Accept: create or update contact
      const existingContact = await storage.getContactByEmailAndCompany(suggestion.emailAddress, accountId);
      const now = new Date();
      let contact;
      if (existingContact) {
        // Update lastSeenAt without overwriting manually-curated fields.
        // Build an explicit InsertContact payload.
        // Preserve curated (non-blank) fields; backfill blanks from suggestion hints.
        const updatePayload: import("@shared/schema").InsertContact = {
          companyId: existingContact.companyId,
          name: existingContact.name || suggestion.suggestedName || suggestion.emailAddress,
          title: existingContact.title || suggestion.suggestedTitle || null,
          phone: existingContact.phone || suggestion.suggestedPhone || null,
          relationshipBase: existingContact.relationshipBase ?? null,
          email: existingContact.email ?? null,
          reportsToId: existingContact.reportsToId ?? null,
          lanes: existingContact.lanes ?? null,
          regions: existingContact.regions ?? null,
          freightSpend: existingContact.freightSpend ?? null,
          spotBiddingProcess: existingContact.spotBiddingProcess ?? null,
          nextSteps: existingContact.nextSteps ?? null,
          interests: existingContact.interests ?? null,
          notes: existingContact.notes ?? null,
          createdAt: existingContact.createdAt ?? null,
          createdBy: existingContact.createdBy ?? null,
          baseAdvancedAt: existingContact.baseAdvancedAt ?? null,
          lastSeenAt: now,
          roleType: roleType ?? existingContact.roleType ?? null,
          sourceType: existingContact.sourceType ?? "email_capture",
          status: existingContact.status ?? "active",
          isPrimary: existingContact.isPrimary ?? false,
        };
        contact = await storage.updateContact(existingContact.id, updatePayload);
      } else {
        const createPayload: import("@shared/schema").InsertContact = {
          companyId: accountId,
          name: suggestion.suggestedName ?? suggestion.emailAddress,
          title: suggestion.suggestedTitle ?? null,
          email: suggestion.emailAddress,
          phone: suggestion.suggestedPhone ?? null,
          roleType: roleType ?? null,
          sourceType: "email_capture",
          lastSeenAt: now,
          status: "active",
          isPrimary: false,
          relationshipBase: null,
          reportsToId: null,
          lanes: null,
          regions: null,
          freightSpend: null,
          spotBiddingProcess: null,
          nextSteps: null,
          interests: null,
          notes: null,
          createdAt: null,
          createdBy: null,
          baseAdvancedAt: null,
        };
        contact = await storage.createContact(createPayload);
      }

      // Mark suggestion as accepted
      await storage.updateAccountContactSuggestionStatus(id, "accepted", { userId: currentUser.id });
      res.json({ suggestion: { ...suggestion, status: "accepted" }, contact });
    } catch (err: any) {
      console.error("[contact-suggestions/accept POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to accept suggestion" });
    }
  });

  /** POST /api/internal/accounts/:accountId/contact-suggestions/:id/ignore */
  app.post("/api/internal/accounts/:accountId/contact-suggestions/:id/ignore", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { accountId, id } = req.params as { accountId: string; id: string };
      const company = await storage.getCompanyInOrg(accountId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Account not found" });
      const suggestion = await storage.getAccountContactSuggestion(id);
      if (!suggestion || suggestion.accountId !== accountId) return res.status(404).json({ error: "Suggestion not found" });
      const updated = await storage.updateAccountContactSuggestionStatus(id, "ignored", { userId: currentUser.id });
      res.json(updated);
    } catch (err: any) {
      console.error("[contact-suggestions/ignore POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to ignore suggestion" });
    }
  });

  /** POST /api/internal/accounts/:accountId/contact-suggestions/:id/snooze */
  app.post("/api/internal/accounts/:accountId/contact-suggestions/:id/snooze", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { accountId, id } = req.params as { accountId: string; id: string };
      const company = await storage.getCompanyInOrg(accountId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Account not found" });
      const suggestion = await storage.getAccountContactSuggestion(id);
      if (!suggestion || suggestion.accountId !== accountId) return res.status(404).json({ error: "Suggestion not found" });
      const { snoozedUntil } = req.body as { snoozedUntil?: string };
      const snoozedUntilDate = snoozedUntil ? new Date(snoozedUntil) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const updated = await storage.updateAccountContactSuggestionStatus(id, "snoozed", { userId: currentUser.id, snoozedUntil: snoozedUntilDate });
      res.json(updated);
    } catch (err: any) {
      console.error("[contact-suggestions/snooze POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to snooze suggestion" });
    }
  });

  /** POST /api/internal/accounts/:accountId/contact-suggestions/:id/never-suggest */
  app.post("/api/internal/accounts/:accountId/contact-suggestions/:id/never-suggest", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const { accountId, id } = req.params as { accountId: string; id: string };
      const company = await storage.getCompanyInOrg(accountId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Account not found" });
      const suggestion = await storage.getAccountContactSuggestion(id);
      if (!suggestion || suggestion.accountId !== accountId) return res.status(404).json({ error: "Suggestion not found" });
      const updated = await storage.updateAccountContactSuggestionStatus(id, "never_suggest", { userId: currentUser.id });
      res.json(updated);
    } catch (err: any) {
      console.error("[contact-suggestions/never-suggest POST]", err?.message ?? err);
      res.status(500).json({ error: "Failed to suppress suggestion" });
    }
  });

  registerGeographicResponsibilitiesRoutes(app);
  registerContactGeographySuggestionRoutes(app);
  registerAIIntelligenceRoutes(app);

  // ── Sidebar tooltip overrides (Task #385) ──────────────────────────────
  app.get("/api/sidebar-tooltips", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const items = await storage.getSidebarTooltips(currentUser.organizationId);
      res.json({ items });
    } catch (err: any) {
      console.error("[sidebar-tooltips GET]", err?.message ?? err);
      res.status(500).json({ error: "Failed to load sidebar tooltips" });
    }
  });

  app.put("/api/sidebar-tooltips", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const parsed = upsertSidebarTooltipSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
      const { itemKey, description } = parsed.data;
      const trimmed = description.trim();
      if (!trimmed) {
        await storage.deleteSidebarTooltip(currentUser.organizationId, itemKey);
        return res.json({ deleted: true, itemKey });
      }
      const row = await storage.upsertSidebarTooltip(currentUser.organizationId, itemKey, trimmed, currentUser.id);
      res.json(row);
    } catch (err: any) {
      console.error("[sidebar-tooltips PUT]", err?.message ?? err);
      res.status(500).json({ error: "Failed to save sidebar tooltip" });
    }
  });

  app.delete("/api/sidebar-tooltips/:itemKey", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      await storage.deleteSidebarTooltip(currentUser.organizationId, req.params.itemKey);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[sidebar-tooltips DELETE]", err?.message ?? err);
      res.status(500).json({ error: "Failed to reset sidebar tooltip" });
    }
  });

  return httpServer;
}
