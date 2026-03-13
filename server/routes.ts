import type { Express } from "express";
import { createServer, type Server } from "http";
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
  if (user.role === "director") {
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    requireAuth(req, res, next);
  });

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
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales") {
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
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales") {
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
      const isNamOrDirector = currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales";
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

  app.patch("/api/users/:id", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales") {
        return res.status(403).json({ error: "Access required" });
      }
      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales") {
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
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales") {
        return res.status(403).json({ error: "Access required" });
      }
      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales") {
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

      let companies = await storage.getCompanies();
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        companies = companies.filter(c => visibleIds.includes(c.id));
      }
      res.json(companies);
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
      if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales") {
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
      } else if (currentUser.role === "director" || currentUser.role === "national_account_manager" || currentUser.role === "sales") {
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

  app.patch("/api/companies/:id/reassign", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (currentUser.role !== "admin" && currentUser.role !== "director" && currentUser.role !== "national_account_manager" && currentUser.role !== "sales") {
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
      res.status(201).json(contact);
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ error: "Failed to create contact" });
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
      if (user.role === "admin") return res.json(allTasks);
      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        return res.json(allTasks.filter(t => teamIds.includes(t.assignedTo) || teamIds.includes(t.assignedBy)));
      }
      return res.json(allTasks.filter(t => t.assignedTo === user.id || t.assignedBy === user.id));
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
      res.json(companyTasks);
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
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
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
      const task = await storage.updateTask(req.params.id, data);
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

  // ── Callouts ─────────────────────────────────────────────────────────────

  app.get("/api/callouts", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allCallouts = await storage.getCallouts();
      const visibleIds = await getVisibleCompanyIds(user);
      const filtered = visibleIds === null
        ? allCallouts
        : allCallouts.filter(c => !c.companyId || visibleIds.includes(c.companyId));
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
      const canPost = user.role === "admin" || user.role === "director" || user.role === "national_account_manager" || user.role === "sales";
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
      if (user.role !== "admin" && user.role !== "director") {
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
      const isAdmin = user.role === "admin" || user.role === "director";
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
      const topic = await storage.addTopic({
        sessionId: req.params.id,
        addedById: user.id,
        text: text.trim(),
        tag: tag || "fyi",
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
      const isAdmin = user.role === "admin" || user.role === "director";
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
      const isAdmin = user.role === "admin" || user.role === "director";
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
      const isAdmin = user.role === "admin" || user.role === "director";
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
      const isAdmin = user.role === "admin" || user.role === "director";
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
      if (user.role !== "admin" && user.role !== "director" && user.role !== "national_account_manager" && user.role !== "sales") {
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

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
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
        const city = (row["Consignee city"] || "").trim();
        const state = (row["Consignee state"] || "").trim();
        if (!city && !state) continue;
        const location = city && state ? `${city}, ${state}` : city || state;

        let week = "unknown";
        try {
          const d = new Date(row["Date ordered"] || "");
          if (!isNaN(d.getTime())) {
            const year = d.getFullYear();
            const startOfYear = new Date(year, 0, 1);
            const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
            week = `${year}-W${weekNum}`;
          }
        } catch {}

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

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
        const teamIds = await storage.getTeamMemberIds(user.id);
        const teamUsers = (await storage.getUsers()).filter(u => teamIds.includes(u.id));
        const teamNames = teamUsers.map(u => u.name.toLowerCase());
        allRows = allRows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
          return teamNames.some(n => op.includes(n) || n.includes(op));
        });
      } else if (user.role === "account_manager") {
        const userName = user.name.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const op = String(r["Operations user"] || r["operations user"] || r["OPERATIONS USER"] || "").toLowerCase();
          return op.includes(userName) || userName.includes(op);
        });
      }

      const byDestWeek = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        const city = (row["Consignee city"] || "").trim();
        const state = (row["Consignee state"] || "").trim();
        if (!city && !state) continue;
        const location = city && state ? `${city}, ${state}` : city || state;

        let week = "unknown";
        try {
          const d = new Date(row["Date ordered"] || "");
          if (!isNaN(d.getTime())) {
            const year = d.getFullYear();
            const startOfYear = new Date(year, 0, 1);
            const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
            week = `${year}-W${weekNum}`;
          }
        } catch {}

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
      if (!user || (user.role !== "admin" && user.role !== "director" && user.role !== "national_account_manager" && user.role !== "sales")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const upload = await storage.getLatestFinancialUpload();
      if (!upload) return res.json(null);

      let rows = ((upload.rows as any[]) || []).filter((r: any) => String(r["Status"] || "").toLowerCase() !== "void");

      if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
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

  app.get("/api/financials/account-summary", requireAuth, async (req, res) => {
    try {
      const uploads = await storage.getFinancialUploads();
      if (!uploads.length) return res.json([]);
      const latest = uploads[uploads.length - 1];
      const raw = (latest.summaryRows as any[]) || [];

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
        const city = String(row["Consignee city"] || "").trim();
        const state = String(row["Consignee state"] || "").trim();
        const dateStr = String(row["Date ordered"] || "").trim();
        if (!city || !state) continue;
        const key = `${city.toLowerCase()}||${state.toLowerCase()}`;
        if (!destWeekly[key]) { destWeekly[key] = {}; destMeta[key] = { city, state }; }
        if (dateStr) {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            const wk = getWeekKey(d);
            destWeekly[key][wk] = (destWeekly[key][wk] || 0) + 1;
          }
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
        const city = String(row["Consignee city"] || "").trim();
        const state = String(row["Consignee state"] || "").trim();
        const dateStr = String(row["Date ordered"] || "").trim();
        if (!city || !state) continue;
        const key = `${city.toLowerCase()}||${state.toLowerCase()}`;
        if (!destWeekly[key]) { destWeekly[key] = {}; destMeta[key] = { city, state }; }
        if (dateStr) {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            const wk = getWeekKey(d);
            destWeekly[key][wk] = (destWeekly[key][wk] || 0) + 1;
          }
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
          const oc = (row["Shipper city"] || row["shipper_city"] || row["Origin City"] || "").toString().trim();
          const os = (row["Shipper state"] || row["shipper_state"] || row["Origin State"] || "").toString().trim();
          const dc = (row["Consignee city"] || row["consignee_city"] || row["Dest City"] || "").toString().trim();
          const ds = (row["Consignee state"] || row["consignee_state"] || row["Dest State"] || "").toString().trim();
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
          const dc = (row["Consignee city"] || row["consignee_city"] || "").toString().trim();
          const ds = (row["Consignee state"] || row["consignee_state"] || "").toString().trim();
          const oc = (row["Shipper city"] || row["shipper_city"] || "").toString().trim();
          const os = (row["Shipper state"] || row["shipper_state"] || "").toString().trim();
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
          const c = (row["Consignee city"] || row["consignee_city"] || "").toString().trim();
          const s = (row["Consignee state"] || row["consignee_state"] || "").toString().trim();
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
          const dc = (row["Consignee city"] || row["consignee_city"] || "").toString().trim();
          const ds = (row["Consignee state"] || row["consignee_state"] || "").toString().trim();
          if (dc) {
            const k = `${dc}|${ds}`;
            if (!ourDeliveryMap[k]) {
              const coords = geocodeCity(dc, ds);
              if (coords) ourDeliveryMap[k] = { city: dc, state: ds, count: 0, lat: coords[0], lng: coords[1] };
            }
            if (ourDeliveryMap[k]) ourDeliveryMap[k].count++;
          }
          const oc = (row["Shipper city"] || row["shipper_city"] || "").toString().trim();
          const os = (row["Shipper state"] || row["shipper_state"] || "").toString().trim();
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
      const RADIUS_MILES = 75;
      const ourDeliveriesToTheirPickups: any[] = [];
      const theirDeliveriesToOurPickups: any[] = [];

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
                  ourDeliveriesToTheirPickups.push({
                    rfpTitle: rfp.title, rfpId: rfp.id,
                    customerCity: origCity, customerState: origState, customerLane: laneStr, customerVolume: volume,
                    ourCity: d.city, ourState: d.state,
                    distance: Math.round(dist * 10) / 10,
                    weeklyLoads: Math.round(d.count / 52 * 10) / 10,
                    totalLoads: d.count,
                  });
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
                  theirDeliveriesToOurPickups.push({
                    rfpTitle: rfp.title, rfpId: rfp.id,
                    customerCity: destCity, customerState: destState, customerLane: laneStr, customerVolume: volume,
                    ourCity: p.city, ourState: p.state,
                    distance: Math.round(dist * 10) / 10,
                    weeklyLoads: Math.round(p.count / 52 * 10) / 10,
                    totalLoads: p.count,
                  });
                }
              }
            }
          }
        }
      }

      const dedup = (arr: any[], keyFn: (x: any) => string) => {
        const seen = new Set<string>();
        return arr.filter(x => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((a, b) => b.customerVolume - a.customerVolume || a.distance - b.distance);
      };

      res.json({
        ourDeliveriesToTheirPickups: dedup(ourDeliveriesToTheirPickups, x => `${x.customerCity}|${x.ourCity}|${x.rfpId}`),
        theirDeliveriesToOurPickups: dedup(theirDeliveriesToOurPickups, x => `${x.customerCity}|${x.ourCity}|${x.rfpId}`),
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
    if (user.role === "account_manager") {
      return user.id === amId && user.managerId === namId;
    }
    if (user.role === "national_account_manager" || user.role === "director" || user.role === "sales") {
      if (user.id !== namId) return false;
      const am = await storage.getUser(amId);
      return !!am && am.managerId === user.id;
    }
    return false;
  }

  async function canAccessSession(user: { id: string; role: string; managerId: string | null }, sessionId: string): Promise<boolean> {
    const session = await storage.getSession(sessionId);
    if (!session) return false;
    return canAccessPairing(user, session.namId, session.amId);
  }

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

      if (currentUser.role === "account_manager") {
        if (!currentUser.managerId) return res.json([]);
        const manager = safeUsers.find(u => u.id === currentUser.managerId);
        if (!manager) return res.json([]);
        return res.json([{ namId: manager.id, amId: currentUser.id, namName: manager.name, amName: currentUser.name }]);
      }

      if (currentUser.role === "national_account_manager" || currentUser.role === "director" || currentUser.role === "sales") {
        const directReports = safeUsers.filter(u => u.managerId === currentUser.id && u.role === "account_manager");
        return res.json(directReports.map(am => ({
          namId: currentUser.id,
          amId: am.id,
          namName: currentUser.name,
          amName: am.name,
        })));
      }

      if (currentUser.role === "admin") {
        const pairings: { namId: string; amId: string; namName: string; amName: string }[] = [];
        const ams = safeUsers.filter(u => u.role === "account_manager" && u.managerId);
        for (const am of ams) {
          const nam = safeUsers.find(u => u.id === am.managerId);
          if (nam) {
            pairings.push({ namId: nam.id, amId: am.id, namName: nam.name, amName: am.name });
          }
        }
        return res.json(pairings);
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
      const validTags = ["Action Item", "Question", "FYI", "Follow-up"];
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

  app.post("/api/one-on-one/sessions/:id/close", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessSession(currentUser, req.params.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const newSession = await storage.closeSession(req.params.id);
      if (!newSession) return res.status(404).json({ error: "Session not found" });
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
      if (user.role === "account_manager") return res.status(403).json({ error: "Access denied" });
      let teamIds: string[];
      if (user.role === "admin") {
        const allUsers = await storage.getUsers();
        teamIds = allUsers.filter(u => u.role === "account_manager" || u.role === "national_account_manager").map(u => u.id);
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
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales") {
        goalsList = await storage.getGoals({ namId: user.id });
      } else {
        goalsList = await storage.getGoals({ amId: user.id });
      }
      res.json(goalsList);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch goals" });
    }
  });

  app.get("/api/goals/monthly-check", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "account_manager") return res.json([]);
      const namId = user.role === "admin" ? undefined : user.id;
      const missing = await storage.getAmsMissingMonthlyGoals(namId);
      res.json(missing);
    } catch (error) {
      res.status(500).json({ error: "Failed to check monthly goals" });
    }
  });

  app.post("/api/goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role === "account_manager") return res.status(403).json({ error: "Only NAMs can create goals" });
      const goal = await storage.createGoal({
        ...req.body,
        namId: user.role === "admin" ? (req.body.namId || user.id) : user.id,
        createdById: user.id,
        createdAt: new Date().toISOString(),
        currentValue: "0",
      });
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
      }
      res.json({ autoValue, currentValue: parseFloat(goal.currentValue || "0") });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch progress" });
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

  app.get("/api/dashboard/cold-contacts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const days = parseInt(req.query.days as string) || 30;
      const scopedUserId = (user.role === "admin" || user.role === "director") ? null : user.id;
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
      const validEntityTypes = ["feed_post", "one_on_one_topic", "touchpoint", "task"];
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
