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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const zipCodeMap: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "server", "zipcodes.json"), "utf-8")
);

function findSheetByName(workbook: XLSX.WorkBook, preferredName: string): string {
  const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === preferredName.toLowerCase());
  return match || workbook.SheetNames[0];
}

async function getVisibleFeedAuthorIds(user: { id: string; role: string; managerId: string | null }): Promise<string[] | undefined> {
  if (user.role === "admin") return undefined;
  if (user.role === "director" || user.role === "sales_director") {
    return storage.getTeamMemberIds(user.id);
  }
  if (user.role === "national_account_manager" || user.role === "sales") {
    const ids = await storage.getTeamMemberIds(user.id);
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

function analyzeRfpSpreadsheet(workbook: XLSX.WorkBook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // First, try to find the real header row by scanning first 15 rows as raw arrays
  const rawAll: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (rawAll.length === 0) {
    return { rows: [], headers: [], highVolumeLanes: [], analysis: { laneCount: 0, totalVolume: "0", originStates: [], destinationStates: [], highVolumeLaneCount: 0 } };
  }

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
  if (!originCol) originCol = findCol(["origin", "orig", "pickup", "ship from", "from"]);

  let destCol = findCol(["destination city", "dest city", "to city", "d_city", "destination_city"]);
  if (!destCol) destCol = findCol(["destination zip", "dest zip", "to zip", "d_zip", "destination_zip", "to_zip"]);
  if (!destCol) destCol = findCol(["destination", "dest", "delivery", "ship to", "to"]);

  const originStateCol = findCol(["origin_state", "origin state", "o_state", "from_state", "from state", "orig state", "orig_state"]);
  const destStateCol = findCol(["destination_state", "dest_state", "dest state", "to_state", "to state", "d_state"]);
  let volumeCol = findCol(["annual volume", "annual loads", "annual shipments", "yearly volume", "yearly loads"]);
  if (!volumeCol) volumeCol = findCol(["volume", "loads", "shipments", "qty", "quantity"]);
  if (!volumeCol) volumeCol = findCol(["weekly volume", "weekly loads", "weekly shipments", "wkly"]);
  const rateCol = findCol(["rate", "price", "cost", "target", "rpm"]);
  let laneCol = findCol(["lane_id", "lane id", "lane name", "lane_name", "lane #", "lane#", "lane"]);
  const equipmentCol = findCol(["equipment name", "equipment type", "equipment code", "equip name", "equip type", "equipment", "equip", "trailer type", "trailer", "mode"]);

  // Fallback: if no volume column found by keyword, auto-detect from column content
  let isWeeklyVolume = false;
  if (!volumeCol) {
    // Find the column with the most numeric values (potential volume)
    let bestNumericCol: string | null = null;
    let bestNumericCount = 0;
    for (const h of headers) {
      const numericValues = rows.map(r => parseFloat(String(r[h] || "").replace(/[^0-9.]/g, ""))).filter(v => !isNaN(v) && v > 0);
      if (numericValues.length > bestNumericCount) {
        bestNumericCount = numericValues.length;
        bestNumericCol = h;
      }
    }
    if (bestNumericCol && bestNumericCount > rows.length * 0.3) {
      volumeCol = bestNumericCol;
      // If max value is small (< 52), it's likely weekly loads
      const maxVal = Math.max(...rows.map(r => parseFloat(String(r[bestNumericCol!] || "").replace(/[^0-9.]/g, ""))).filter(v => !isNaN(v)));
      if (maxVal <= 52) isWeeklyVolume = true;
    }
  } else {
    // Check if the detected volume column has small values suggesting weekly cadence
    const colHeader = volumeCol.toLowerCase();
    if (colHeader.includes("week") || colHeader.includes("wkly")) {
      isWeeklyVolume = true;
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
        const annualV = isWeeklyVolume ? v * 52 : v;
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
    },
  };
}

function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseHistoricalRow(row: any): {
  destCity: string; destState: string;
  origCity: string; origState: string;
  weekKey: string; monthKey: string; margin: number; revenue: number;
} {
  const hasNewFormat = "Origin state" in row || "Destination state" in row || ("Origin" in row && "Destination" in row);
  if (hasNewFormat) {
    const destRaw = String(row["Destination"] || "").trim();
    const destState = String(row["Destination state"] || "").trim();
    const destCity = destRaw.includes(",") ? destRaw.split(",")[0].trim() : destRaw;
    const origRaw = String(row["Origin"] || "").trim();
    const origState = String(row["Origin state"] || "").trim();
    const origCity = origRaw.includes(",") ? origRaw.split(",")[0].trim() : origRaw;
    const weekRaw = String(row["Week"] || "").trim();
    let weekKey = weekRaw || "";
    let monthKey = "";
    // Prefer Delivery date serial for exact month
    const serial = Number(row["Delivery date"]);
    if (!isNaN(serial) && serial > 40000) {
      const d = new Date(new Date(1899, 11, 30).getTime() + serial * 86400000);
      monthKey = toMonthKey(d);
      if (!weekKey) {
        const y = d.getFullYear();
        const wn = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7);
        weekKey = `${y}-W${wn}`;
      }
    }
    // Fall back to parsing "2025 W44" → first day of that week
    if (!monthKey && weekKey) {
      const m = weekKey.match(/^(\d{4})\s*W(\d+)$/);
      if (m) {
        const d = new Date(parseInt(m[1]), 0, 1 + (parseInt(m[2]) - 1) * 7);
        monthKey = toMonthKey(d);
      }
    }
    return { destCity, destState, origCity, origState, weekKey, monthKey, margin: Number(row["Margin $"]) || 0, revenue: Number(row["Total revenue"]) || 0 };
  }
  const destCity = String(row["Consignee city"] || row["consignee_city"] || "").trim();
  const destState = String(row["Consignee state"] || row["consignee_state"] || "").trim();
  const origCity = String(row["Shipper city"] || row["shipper_city"] || row["Origin City"] || "").trim();
  const origState = String(row["Shipper state"] || row["shipper_state"] || row["Origin State"] || "").trim();
  const dateStr = String(row["Date ordered"] || "").trim();
  let weekKey = "";
  let monthKey = "";
  if (dateStr) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const wn = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7);
        weekKey = `${y}-W${wn}`;
        monthKey = toMonthKey(d);
      }
    } catch {}
  }
  return { destCity, destState, origCity, origState, weekKey, monthKey, margin: 0, revenue: 0 };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    requireAuth(req, res, next);
  });

  registerChatbotRoutes(app);

  app.get("/api/search", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const q = (req.query.q as string || "").trim();
      if (!q) return res.json({ accounts: [], accountManagers: [], nationalAccountManagers: [], contacts: [], rfps: [] });
      const [matchedCompanies, matchedUsers, matchedContacts, matchedRfps] = await Promise.all([
        storage.searchCompanies(q),
        storage.searchUsers(q, ["account_manager", "national_account_manager", "director", "sales"]),
        storage.searchContacts(q),
        storage.searchRfps(q),
      ]);
      const accounts = matchedCompanies.map(c => ({ id: c.id, name: c.name }));
      const accountManagers = matchedUsers.filter(u => u.role === "account_manager");
      const nationalAccountManagers = matchedUsers.filter(u => u.role === "national_account_manager" || u.role === "director");
      const contacts = matchedContacts.map(c => ({ id: c.id, name: c.name, title: c.title, companyId: c.companyId }));
      const rfps = matchedRfps.map(r => ({ id: r.id, title: r.title, companyId: r.companyId, status: r.status }));
      res.json({ accounts, accountManagers, nationalAccountManagers, contacts, rfps });
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.get("/api/users", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales" && currentUser.role !== "sales_director") {
        return res.status(403).json({ error: "Access required" });
      }
      const allUsers = await storage.getUsers();
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      if (currentUser.role === "admin") return res.json(safeUsers);
      const teamIds = await storage.getTeamMemberIds(currentUser.id);
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
        const role = TITLE_TO_ROLE[title] || "account_manager";

        if (!name || !email) {
          errors.push(`Skipped row — missing name or email`);
          continue;
        }
        const existing = await storage.getUserByUsername(email);
        if (existing) {
          skipped.push(name);
          continue;
        }
        await storage.createUser({ username: email, password: hashedPassword, name, role, managerId: null });
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
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        if (!teamIds.includes(req.params.id) || req.params.id === currentUser.id) {
          return res.status(403).json({ error: "Cannot edit this user" });
        }
      }
      const data: any = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.username !== undefined) data.username = req.body.username;
      if (req.body.password) data.password = await bcrypt.hash(req.body.password, 10);
      if (currentUser.role === "admin") {
        if (req.body.role !== undefined) {
          if (!userRoles.includes(req.body.role)) {
            return res.status(400).json({ error: "Invalid role" });
          }
          data.role = req.body.role;
        }
        if (req.body.managerId !== undefined) data.managerId = req.body.managerId;
      }
      const user = await storage.updateUser(req.params.id, data);
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
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        if (!teamIds.includes(req.params.id) || req.params.id === currentUser.id) {
          return res.status(403).json({ error: "Cannot delete this user" });
        }
      }
      if (req.params.id === currentUser.id) {
        return res.status(400).json({ error: "Cannot delete yourself" });
      }
      const deleted = await storage.deleteUser(req.params.id);
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

      let allCompanies = await storage.getCompanies();
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
      const company = await storage.getCompany(req.params.id);
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
      const allUsers = await storage.getUsers();
      const safeUsers = allUsers.map(({ password, ...u }) => u);
      if (currentUser.role === "admin") {
        return res.json(safeUsers);
      }
      if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        const visibleIds = new Set([...teamIds, currentUser.id]);
        return res.json(safeUsers.filter(u => visibleIds.has(u.id)));
      }
      const visibleIds = new Set<string>([currentUser.id]);
      if (currentUser.managerId) {
        visibleIds.add(currentUser.managerId);
        allUsers.forEach(u => {
          if (u.managerId === currentUser.managerId) visibleIds.add(u.id);
        });
      }
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

  async function fanOutCelebration(type: "new_account" | "new_contact" | "base_advanced", title: string, body: string, link: string, relatedId: string, actorId: string) {
    try {
      const allUsers = await storage.getUsers();
      const celebrationRoles = ["national_account_manager", "director", "admin"];
      const targets = allUsers.filter(u => celebrationRoles.includes(u.role));
      await Promise.all(targets.map(u =>
        storage.createNotification({ userId: u.id, type, title, body, link, relatedId, read: false }).catch(() => {})
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
      const data = { ...parsed.data };
      if (currentUser.role === "admin") {
        // admin can assign to anyone — leave assignedTo as-is
      } else if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales" || currentUser.role === "sales_director") {
        if (data.assignedTo) {
          const teamIds = await storage.getTeamMemberIds(currentUser.id);
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
        currentUser.id
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
      const company = await storage.updateCompany(req.params.id, data);
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
      const company = await storage.updateCompany(req.params.id, { financialAlias: financialAlias || null } as any);
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update financial alias" });
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
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        if (!teamIds.includes(assignedTo)) {
          return res.status(403).json({ error: "Can only assign to team members" });
        }
      }
      const existing = await storage.getCompany(req.params.id);
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const company = await storage.updateCompany(req.params.id, { ...existing, assignedTo });
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
      const deleted = await storage.deleteCompany(req.params.id);
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
      const updated = await storage.archiveCompany(req.params.id);
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
      const updated = await storage.unarchiveCompany(req.params.id);
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
      storage.getCompany(req.params.companyId).then(co => {
        fanOutCelebration(
          "new_contact",
          `🎉 New contact: ${contact.name}`,
          `${currentUser.name} added ${contact.name}${contact.title ? ` (${contact.title})` : ""} at ${co?.name ?? "an account"}.`,
          `/companies/${req.params.companyId}`,
          contact.id,
          currentUser.id
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
          storage.getCompany(existing.companyId).then(co => {
            fanOutCelebration(
              "base_advanced",
              `🎉 Relationship advanced: ${parsed.data.name ?? existing.name}`,
              `${currentUser.name} moved ${parsed.data.name ?? existing.name} at ${co?.name ?? "an account"} from ${existing.relationshipBase ?? "no base"} → ${parsed.data.relationshipBase}.`,
              `/companies/${existing.companyId}`,
              req.params.id,
              currentUser.id
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

      const company = await storage.getCompany(companyId);
      if (!company) {
        return res.status(400).json({ error: "Company not found" });
      }

      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      } catch {
        return res.status(400).json({ error: "Could not parse file. Please ensure it is a valid Excel or CSV file." });
      }
      const result = analyzeRfpSpreadsheet(workbook);

      const rfpData = {
        companyId,
        title: req.body.title || req.file.originalname.replace(/\.[^.]+$/, ""),
        status: "pending",
        value: null,
        dueDate: null,
        notes: null,
        fileName: req.file.originalname,
        fileData: { rows: result.rows, highVolumeLanes: result.highVolumeLanes },
        laneCount: result.analysis.laneCount,
        totalVolume: result.analysis.totalVolume,
        originStates: result.analysis.originStates,
        destinationStates: result.analysis.destinationStates,
      };

      const rfp = await storage.createRfp(rfpData);
      res.status(201).json({ rfp, analysis: result.analysis, headers: result.headers, highVolumeLanes: result.highVolumeLanes, previewRows: result.rows.slice(0, 10) });
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

  // ── Task Assignment ──────────────────────────────────────────────────────

  app.get("/api/tasks", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allTasks = await storage.getTasks();
      let filtered: typeof allTasks;
      if (user.role === "admin") {
        filtered = allTasks;
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id);
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
      const allUsers = await storage.getUsers();
      let assignableIds: Set<string>;
      if (user.role === "admin") {
        assignableIds = new Set(allUsers.map(u => u.id));
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        assignableIds = new Set(teamIds);
      } else {
        assignableIds = new Set([user.id]);
        if (user.managerId) {
          assignableIds.add(user.managerId);
          allUsers.forEach(u => {
            if (u.managerId === user.managerId) assignableIds.add(u.id);
          });
        }
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
      if (data.status === "completed" && existing.status !== "completed" &&
          existing.assignedBy && existing.assignedBy !== user.id) {
        storage.createNotification({
          userId: existing.assignedBy,
          type: "task_completed",
          title: `${user.name} completed a task`,
          body: task?.title ?? existing.title,
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
      // Notify task assignee and creator (skip the commenter themselves)
      const notifyIds = [...new Set([task.assignedTo, task.assignedBy])].filter(
        id => id && id !== user.id
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
      // Notify the parent callout author if someone else replied
      if (parentCallout && parentCallout.authorId !== user.id) {
        storage.createNotification({
          userId: parentCallout.authorId,
          type: "post_reply",
          title: `${user.name} replied to your callout`,
          body: (title.trim()).length > 80 ? title.trim().slice(0, 80) + "…" : title.trim(),
          link: "/feed",
          relatedId: callout.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
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
            link: "/feed",
            relatedId: post.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
        return res.status(201).json(post);
      }

      // Top-level post: managers and above only
      const canPost = user.role === "admin" || user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director";
      if (!canPost) return res.status(403).json({ error: "Only managers and above can post to the feed" });
      const validCategories = ["trend", "growth", "idea"];
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
          const allUsers = await storage.getUsers();
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
                  link: "/feed",
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
        const teamIds = await storage.getTeamMemberIds(user.id);
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
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: "Failed to get archived sessions" });
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

  // ── Financial Data ─────────────────────────────────────────────────────────

  app.get("/api/historical-data", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin" && user.role !== "director" && user.role !== "national_account_manager" && user.role !== "sales" && user.role !== "sales_director") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const uploads = await storage.getFinancialUploads();
      if (uploads.length === 0) return res.json([]);

      let allRows: any[] = [];
      for (const upload of uploads) {
        if (Array.isArray(upload.rows)) {
          allRows.push(...(upload.rows as any[]));
        }
      }
      allRows = allRows.filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        const teamUsers = (await storage.getUsers()).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
          return teamNames.some(n => op.includes(n) || n.includes(op));
        });
      }

      const byDestWeek = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row);
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

      const uploads = await storage.getFinancialUploads();
      if (uploads.length === 0) return res.json([]);

      let allRows: any[] = [];
      for (const upload of uploads) {
        if (Array.isArray(upload.rows)) {
          allRows.push(...(upload.rows as any[]));
        }
      }
      allRows = allRows.filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        const teamUsers = (await storage.getUsers()).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
          return teamNames.some(n => op.includes(n) || n.includes(op));
        });
      } else if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") {
        const userName = user.name.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
          return op.includes(userName) || userName.includes(op);
        });
      }

      const byDestWeek = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row);
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
      const allCompanies = await storage.getCompanies();
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
      const upload = await storage.getLatestFinancialUpload();
      if (!upload) return res.json(null);

      let rows = ((upload.rows as any[]) || []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        const teamUsers = (await storage.getUsers()).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        rows = rows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
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
      const uploads = await storage.getFinancialUploads();
      res.json(uploads.map(u => ({ id: u.id, fileName: u.fileName, uploadedAt: u.uploadedAt, rowCount: u.rowCount })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  app.get("/api/financials/uploads/:id/download", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      const uploads = await storage.getFinancialUploads();
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

  app.post("/api/financials/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const sheetName = findSheetByName(workbook, "All Data (YTD)");
      const sheet = workbook.Sheets[sheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const summarySheetName = findSheetByName(workbook, "March Replit");
      const summarySheet = workbook.Sheets[summarySheetName];
      const summaryRows: any[] = summarySheetName !== sheetName
        ? XLSX.utils.sheet_to_json(summarySheet, { defval: "" })
        : [];

      const upload = await storage.createFinancialUpload({
        fileName: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        rowCount: rows.length,
        rows,
        summaryRows,
      });

      await storage.setSetting("monthly_sync_failed", "");
      await storage.setSetting("monthly_sync_failed_error", "");

      res.json({ id: upload.id, fileName: upload.fileName, rowCount: upload.rowCount });
    } catch (error) {
      console.error("Error uploading financials:", error);
      res.status(500).json({ error: "Failed to upload financials" });
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

  app.get("/api/financials/customer-names", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploads();
      const names = new Set<string>();
      for (const upload of uploads) {
        const rows: any[] = Array.isArray(upload.rows) ? upload.rows as any[] : [];
        for (const row of rows) {
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
      const uploads = await storage.getFinancialUploads();
      if (!uploads.length) return res.json([]);
      const latest = uploads[uploads.length - 1];
      const raw = (latest.summaryRows as any[]) || [];

      // If no summary sheet, compute from transaction rows (new ReplistNumbers format)
      if (!raw.length) {
        const txRows: any[] = (latest.rows as any[]) || [];
        type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number };
        type CustomerEntry = { customerName: string; totalLoads: number; spotLoads: number; totalMargin: number; repName: string; byMonth: Record<string, MonthBucket> };
        const byCustomer: Record<string, CustomerEntry> = {};
        for (const row of txRows) {
          const customerName = String(row["Customer"] || "").trim();
          if (!customerName) continue;
          // Skip loads with no billed revenue — they are cancelled or error entries
          const revenue = Number(row["Total revenue"] || row["Revenue"] || 0);
          if (revenue === 0) continue;
          const { monthKey, margin } = parseHistoricalRow(row);
          const rep = String(row["Salesperson"] || row["Operations user"] || "").trim();
          const orderType = String(row["Order type"] || "").toLowerCase();
          const isSpot = orderType.includes("spot");
          if (!byCustomer[customerName]) byCustomer[customerName] = { customerName, totalLoads: 0, spotLoads: 0, totalMargin: 0, repName: rep, byMonth: {} };
          byCustomer[customerName].totalLoads++;
          byCustomer[customerName].totalMargin += margin;
          if (isSpot) byCustomer[customerName].spotLoads++;
          if (!byCustomer[customerName].repName && rep) byCustomer[customerName].repName = rep;
          if (monthKey) {
            if (!byCustomer[customerName].byMonth[monthKey]) byCustomer[customerName].byMonth[monthKey] = { totalLoads: 0, spotLoads: 0, totalMargin: 0 };
            byCustomer[customerName].byMonth[monthKey].totalLoads++;
            byCustomer[customerName].byMonth[monthKey].totalMargin += margin;
            if (isSpot) byCustomer[customerName].byMonth[monthKey].spotLoads++;
          }
        }
        return res.json(Object.values(byCustomer).filter(r => r.customerName));
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

  app.post("/api/financials/sync-onedrive", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || (user.role !== "admin" && user.role !== "national_account_manager" && user.role !== "sales")) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const result = await performOneDriveSync(user.id);

      await storage.setSetting("monthly_sync_failed", "");
      await storage.setSetting("monthly_sync_failed_error", "");

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
      const uploads = await storage.getFinancialUploads();
      const allRows = uploads.flatMap(u => (u.rows as any[]) || []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
      const destWeekly: Record<string, Record<string, number>> = {};
      const destMeta: Record<string, { city: string; state: string }> = {};
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row);
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
      const uploads = await storage.getFinancialUploads();
      const allRows = uploads.flatMap(u => (u.rows as any[]) || []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
      const destWeekly: Record<string, Record<string, number>> = {};
      const destMeta: Record<string, { city: string; state: string }> = {};
      for (const row of allRows) {
        const { destCity: city, destState: state, weekKey } = parseHistoricalRow(row);
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
      const allCompanies = await storage.getCompanies();
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
              matches.push({
                companyId: rfp.companyId,
                companyName: companyMap.get(rfp.companyId || "") || "Unknown",
                rfpId: rfp.id,
                rfpTitle: rfp.title,
                lane: `${lane.origin || ""}${lane.originState ? ", " + lane.originState : ""} → ${lane.destination || ""}${lane.destinationState ? ", " + lane.destinationState : ""}`,
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
      const uploads = await storage.getFinancialUploads();
      const corridorMap: Record<string, { origin: string; destination: string; originCity: string; originState: string; destCity: string; destState: string; loads: number }> = {};
      for (const upload of uploads) {
        const rows: any[] = ((upload as any).rows ?? []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
        for (const row of rows) {
          const { origCity: oc, origState: os, destCity: dc, destState: ds } = parseHistoricalRow(row);
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
      const uploads = await storage.getFinancialUploads();
      console.log(`[heatmap] ${uploads.length} upload(s) found`);
      const deliveries: Record<string, { city: string; state: string; count: number }> = {};
      const pickups: Record<string, { city: string; state: string; count: number }> = {};
      let totalRows = 0;
      for (const upload of uploads) {
        const rows: any[] = (Array.isArray((upload as any).rows) ? (upload as any).rows : []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
        totalRows += rows.length;
        for (const row of rows) {
          const { destCity: dc, destState: ds, origCity: oc, origState: os } = parseHistoricalRow(row);
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

      const company = await storage.getCompany(req.params.id);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const uploads = await storage.getFinancialUploads();
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

      for (const upload of uploads) {
        const rows: any[] = (Array.isArray(upload.rows) ? upload.rows as any[] : [])
          .filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
        for (const row of rows) {
          if (!rowMatchesCompany(row)) continue;
          const { destCity, destState, origCity, origState, monthKey, margin } = parseHistoricalRow(row);
          const orderType = String(row["Order type"] || "").toLowerCase();
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
      const uploads = await storage.getFinancialUploads();
      const rfps = await storage.getRfps();
      const companies = await storage.getCompanies();
      const users = await storage.getUsers();

      const companyMap = Object.fromEntries(companies.map((c: any) => [c.id, c]));
      const userMap = Object.fromEntries(users.map((u: any) => [u.id, u.name]));

      // Build delivery zone frequency
      const deliveryMap: Record<string, { city: string; state: string; count: number }> = {};
      for (const upload of uploads) {
        const rows: any[] = ((upload as any).rows ?? []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
        for (const row of rows) {
          const { destCity: c, destState: s } = parseHistoricalRow(row);
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
      const uploads = await storage.getFinancialUploads();
      const allRfps = await storage.getRfps();

      // Build geocoded frequency maps for our deliveries (consignee) and pickups (shipper)
      const ourDeliveryMap: Record<string, { city: string; state: string; count: number; lat: number; lng: number }> = {};
      const ourPickupMap: Record<string, { city: string; state: string; count: number; lat: number; lng: number }> = {};

      for (const upload of uploads) {
        const rows: any[] = (Array.isArray((upload as any).rows) ? (upload as any).rows : []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");
        for (const row of rows) {
          const { destCity: dc, destState: ds, origCity: oc, origState: os } = parseHistoricalRow(row);
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

      const allUsers = await storage.getUsers();
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
        // NAM: downward (their AMs) + upward (their manager)
        const reports = allUsers.filter(u => u.managerId === user.id && amLikeRoles.includes(u.role));
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

  app.get("/api/one-on-one/per-pairing-counts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const allUsers = await storage.getUsers();
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
        const reports = allUsers.filter(u => u.managerId === user.id && amLikeRoles2.includes(u.role));
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

      const allUsers = await storage.getUsers();
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
        // Downward: pairings with their AMs
        const directReports = safeUsers.filter(u => u.managerId === currentUser.id && (u.role === "account_manager" || u.role === "logistics_manager" || u.role === "logistics_coordinator"));
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
      // Notify the other party in the 1:1 session
      const session = await storage.getSession(topic.sessionId);
      if (session) {
        const otherUserId = session.namId === currentUser.id ? session.amId : session.namId;
        if (otherUserId !== currentUser.id) {
          storage.createNotification({
            userId: otherUserId,
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
        const allUsers = await storage.getUsers();
        teamIds = allUsers.filter(u => u.role === "account_manager" || u.role === "national_account_manager" || u.role === "logistics_manager" || u.role === "logistics_coordinator").map(u => u.id);
      } else {
        teamIds = await storage.getTeamMemberIds(user.id);
      }
      const [perf, allUsers] = await Promise.all([
        storage.getTeamPerformance(teamIds),
        storage.getUsers(),
      ]);
      const result = perf.map(p => {
        const u = allUsers.find(u => u.id === p.userId);
        return { ...p, name: u?.name || "Unknown", role: u?.role || "account_manager", managerId: u?.managerId };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch team performance" });
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
      } else {
        goalsList = await storage.getGoals({ amId: user.id });
      }

      // Enrich goals with auto-computed values so dashboard alerts use accurate data
      const allUsers = await storage.getUsers();
      const uploads = await storage.getFinancialUploads();
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
            if (!raw.length) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                const { monthKey, margin } = parseHistoricalRow(row);
                const rep = String(row["Operations user"] || row["Salesperson"] || "").trim().toLowerCase();
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
              for (const r of rows) {
                let repName: string, totalMargin: number;
                if (usesEmptyKeys) { repName = String(r["__EMPTY_6"] || "").trim(); totalMargin = Number(r["__EMPTY_3"] ?? 0); }
                else { repName = String(r["Rep Name"] || r["Rep"] || r["rep name"] || r["REP"] || r["Sales Rep"] || "").trim(); totalMargin = Number(r["Total Margin $"] || r["total margin $"] || r["TOTAL MARGIN $"] || r["Total Margin"] || 0); }
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
      const allUsers = await storage.getUsers();

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeGoals = allGoals.filter(g => g.startDate <= todayStr && g.endDate >= todayStr);

      const uploads = await storage.getFinancialUploads();
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
            if (!raw.length) {
              const txRows: any[] = (latestUpload.rows as any[]) || [];
              const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
              const byRep: Record<string, Record<string, number>> = {};
              for (const row of txRows) {
                const { monthKey, margin } = parseHistoricalRow(row);
                const rep = String(row["Operations user"] || row["Salesperson"] || "").trim().toLowerCase();
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
      if (user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") return res.status(403).json({ error: "Only NAMs can create goals" });
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

  app.patch("/api/goals/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getGoal(req.params.id);
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      const canEdit = user.role === "admin" || existing.namId === user.id || existing.amId === user.id;
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
      const comment = await storage.createGoalComment({
        goalId: req.params.id,
        authorId: user.id,
        body: req.body.body,
        createdAt: new Date().toISOString(),
      });
      // Notify the other party (NAM ↔ AM) about the goal comment
      const notifyGoalId = user.id === goal.namId ? goal.amId : goal.namId;
      if (notifyGoalId && notifyGoalId !== user.id) {
        storage.createNotification({
          userId: notifyGoalId,
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
      if (goal.metric === "contacts_added") {
        autoValue = await storage.getContactsAddedByAm(goal.amId, goal.startDate, goal.endDate);
      } else if (goal.metric === "touchpoints") {
        autoValue = await storage.getTouchpointCountByAm(goal.amId, goal.startDate, goal.endDate);
      } else if (goal.metric === "margin") {
        const allUsers = await storage.getUsers();
        const amUser = allUsers.find(u => u.id === goal.amId);
        if (amUser) {
          const repKey = (amUser as any).financialRepId as string | null;
          if (repKey) {
            const uploads = await storage.getFinancialUploads();
            if (uploads.length) {
              const latest = uploads[uploads.length - 1];
              const raw = (latest.summaryRows as any[]) || [];
              const repKeyLower = repKey.toLowerCase();
              let total = 0;
              if (!raw.length) {
                // Transaction rows (ReplistNumbers) — group directly by rep, not customer
                const txRows: any[] = (latest.rows as any[]) || [];
                // Derive the target month key from startDate (e.g. "2026-03-01" → "2026-03")
                const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
                // byRep: repCode → monthKey → totalMargin
                const byRep: Record<string, Record<string, number>> = {};
                for (const row of txRows) {
                  const { monthKey, margin } = parseHistoricalRow(row);
                  // Operations user holds the rep code (e.g. "m.moore"); Salesperson is a full-name code
                  const rep = String(row["Operations user"] || row["Salesperson"] || "").trim().toLowerCase();
                  if (!rep) continue;
                  if (!byRep[rep]) byRep[rep] = {};
                  if (monthKey) {
                    byRep[rep][monthKey] = (byRep[rep][monthKey] || 0) + margin;
                  }
                }
                const repMonths = byRep[repKeyLower] || {};
                if (goalMonthKey) {
                  total = repMonths[goalMonthKey] || 0;
                }
              } else {
                // Summary rows (account-summary sheet format)
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
      const allUsers = await storage.getUsers();
      const amUser = allUsers.find(u => u.id === goal.amId);
      const repKey = amUser ? (amUser as any).financialRepId as string | null : null;
      if (!repKey) return res.json({ months: [] });
      const uploads = await storage.getFinancialUploads();
      if (!uploads.length) return res.json({ months: [] });
      const latest = uploads[uploads.length - 1];
      const txRows: any[] = (latest.rows as any[]) || [];
      const repKeyLower = repKey.toLowerCase();
      const byMonth: Record<string, number> = {};
      for (const row of txRows) {
        const { monthKey, margin } = parseHistoricalRow(row);
        if (!monthKey) continue;
        const rep = String(row["Operations user"] || row["Salesperson"] || "").trim().toLowerCase();
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
      const scopedUserId = (user.role === "admin" || user.role === "director" || user.role === "sales_director") ? null : user.id;
      const results = await storage.getColdContacts(scopedUserId, days);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch cold contacts" });
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
        const teamIds = await storage.getTeamMemberIds(user.id);
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
      const validEntityTypes = ["feed_post", "one_on_one_topic", "touchpoint", "task", "scorecard"];
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
      res.setHeader("Content-Disposition", `attachment; filename="${att.fileName}"`);
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
      const allCompanies = allCompanyIds.length > 0 ? await storage.getCompaniesByIds(allCompanyIds) : [];
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
            const company = await storage.getCompany(item.companyId);
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
