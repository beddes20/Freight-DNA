import type { Express } from "express";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import multer from "multer";
import XLSX from "xlsx";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds, canAccessCompany } from "./auth";
import { insertCompanySchema, insertContactSchema, insertRfpSchema, insertAwardSchema } from "@shared/schema";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const zipCodeMap: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "server", "zipcodes.json"), "utf-8")
);

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

  // ── One-time Production Setup (no auth required, token-protected) ──────────
  app.post("/setup-db", async (req, res) => {
    const { token } = req.body || {};
    if (token !== "VT-SETUP-2026") return res.status(403).json({ error: "Forbidden" });
    try {
      const hash = async (pw: string) => bcrypt.hash(pw, 10);
      const defaultPw = await hash("Shipping123!");
      const allUsers = await storage.getUsers();
      const byEmail = new Map(allUsers.map(u => [u.username, u]));
      const upsertUser = async (username: string, name: string, role: string, managerId: string | null = null) => {
        const existing = byEmail.get(username);
        if (existing) {
          await storage.updateUser(existing.id, { username, name, role, password: existing.password, managerId });
          byEmail.set(username, { ...existing, name, role, managerId });
          return existing;
        }
        const created = await storage.createUser({ username, name, role, password: defaultPw, managerId });
        byEmail.set(username, created);
        return created;
      };
      const ben    = await upsertUser("b.beddes@valuetruckaz.com",       "Ben Beddes",        "admin");
      await upsertUser("jordan.baumgart@valuetruck.com",   "Jordan Baumgart",   "admin");
      await upsertUser("joe.middleton@valuetruck.com",     "Joe Middleton",     "admin");
      const braden  = await upsertUser("braden.shinsel@valuetruck.com",  "Braden Shinsel",    "national_account_manager");
      const brianna = await upsertUser("brianna.coakley@valuetruck.com", "Brianna Coakley",   "national_account_manager");
      const danny   = await upsertUser("danny.beddes@valuetruck.com",    "Danny Beddes",      "national_account_manager");
      const jared   = await upsertUser("jared.reynolds@valuetruck.com",  "Jared Reynolds",    "national_account_manager");
      const jason   = await upsertUser("jason.allen@valuetruck.com",     "Jason Allen",       "national_account_manager");
      const ethan   = await upsertUser("ethan.allen@valuetruck.com",     "Ethan Van Allen",   "national_account_manager");
      const sam     = await upsertUser("sam.davis@valuetruck.com",       "Sam Davis",         "national_account_manager");
      const taylor  = await upsertUser("taylor.call@valuetruck.com",     "Taylor Call",       "national_account_manager");
      const zach    = await upsertUser("zach.satteson@valuetruck.com",   "Zach Satteson",     "national_account_manager");
      const bo      = await upsertUser("bo.aagard@valuetruck.com",       "Bo Aagard",         "national_account_manager");
      const jacqie  = await upsertUser("jacquelyn.hatch@valuetruck.com", "Jacquelyn Hatch",   "national_account_manager");
      const yuri    = await upsertUser("yuri.yassin@valuetruck.com",     "Yuri Yassin",       "national_account_manager", sam.id);
      await upsertUser("adan.castaneda@valuetruck.com",   "Adan Castaneda",    "account_manager", danny.id);
      await upsertUser("mason.moore@valuetruck.com",      "Mason Moore",       "account_manager", danny.id);
      await upsertUser("kimberly.dornseif@valuetruck.com","Kimberly Dornseif", "account_manager", jared.id);
      await upsertUser("dallin.meier@valuetruck.com",     "Dallin Meier",      "account_manager", jared.id);
      await upsertUser("alex.shumway@valuetruck.com",     "Alex Shumway",      "account_manager", jason.id);
      await upsertUser("tj.russon@valuetruck.com",        "TJ Russon",         "account_manager", jason.id);
      await upsertUser("legrand.toia@valuetruck.com",     "Legrand Toia",      "account_manager", sam.id);
      // Use latest IDs for company assignment
      const freshUsers = await storage.getUsers();
      const byName = new Map(freshUsers.map(u => [u.name, u]));
      const uid = (name: string) => byName.get(name)?.id || "";
      const allCompanies = await storage.getCompanies();
      const byCompanyName = new Map(allCompanies.map(c => [c.name, c]));
      const upsertCompany = async (name: string, assignedTo: string, industry?: string) => {
        if (byCompanyName.has(name)) return;
        await storage.createCompany({ name, assignedTo, industry: industry || null, website: null, notes: null, portalUrl: null, portalUsername: null, portalPassword: null });
      };
      await upsertCompany("BAE",    uid("Adan Castaneda"));
      await upsertCompany("Conagra", uid("Adan Castaneda"));
      await upsertCompany("Rheem (Laredo)", uid("Alex Shumway"));
      await upsertCompany("ACUITY C/O RXO", uid("Mason Moore"));
      await upsertCompany("ALF Inc",   uid("Braden Shinsel"));
      await upsertCompany("Ferrara",   uid("Braden Shinsel"));
      await upsertCompany("Ferrero",   uid("Braden Shinsel"));
      await upsertCompany("MOHAWK",    uid("Braden Shinsel"));
      await upsertCompany("Signode",   uid("Braden Shinsel"));
      await upsertCompany("Nortek", uid("Brianna Coakley"));
      await upsertCompany("Vertiv", uid("Brianna Coakley"));
      await upsertCompany("Brooklyn Bedding (consolidated)", uid("Dallin Meier"));
      await upsertCompany("Covestro",                        uid("Dallin Meier"));
      await upsertCompany("International Food Solutions",    uid("Dallin Meier"));
      await upsertCompany("MS International LLC",            uid("Dallin Meier"));
      await upsertCompany("SurfacePrep",                     uid("Dallin Meier"));
      await upsertCompany("Armstrong World Industries", uid("Danny Beddes"));
      await upsertCompany("AMERICAN BOTTLING CO C/O RYDER LOGISTICS", uid("Jared Reynolds"));
      await upsertCompany("Keurig Green Mountain",                     uid("Jared Reynolds"));
      await upsertCompany("MOTTS C/O RYDER FREIGHT BILL PROCESSING",   uid("Jared Reynolds"));
      await upsertCompany("Staples Inc",                               uid("Jared Reynolds"));
      await upsertCompany("Terra Express Logistics Corp",              uid("Jared Reynolds"));
      await upsertCompany("American Woodmark Corporation (AWC)", uid("Jason Allen"));
      await upsertCompany("Johnson Controls (consolidated)",     uid("Jason Allen"));
      await upsertCompany("HP HOOD CO",                   uid("Kimberly Dornseif"));
      await upsertCompany("Nestle Purina Petcare C/O Cass", uid("Kimberly Dornseif"));
      await upsertCompany("DE WELL SUPPLY CHAIN MANAGEMENT", uid("Legrand Toia"));
      await upsertCompany("ACH Food Companies, Inc.",          uid("Ethan Van Allen"));
      await upsertCompany("Food In Transit",                   uid("Ethan Van Allen"));
      await upsertCompany("Honeywell International Inc.",      uid("Ethan Van Allen"));
      await upsertCompany("Lactalis American Group",           uid("Ethan Van Allen"), "Food and Bev");
      await upsertCompany("POOL CORP C/O CASS INFORMATION SYSTEMS", uid("Ethan Van Allen"));
      await upsertCompany("SDDC DOMESTIC BUSINESS",            uid("Ethan Van Allen"));
      await upsertCompany("Wada Farms Marketing Group",        uid("Ethan Van Allen"));
      await upsertCompany("BAY VALLEY FOODS",   uid("Sam Davis"));
      await upsertCompany("Idahoan Foods",       uid("Sam Davis"));
      await upsertCompany("JBS FOODS",           uid("Sam Davis"));
      await upsertCompany("National Food Group", uid("Sam Davis"));
      await upsertCompany("DOW CHEMICAL",                    uid("Taylor Call"));
      await upsertCompany("Rick Miles Produce Service, Inc", uid("Taylor Call"));
      await upsertCompany("Ball Metal Beverage Container Corp", uid("Yuri Yassin"));
      await upsertCompany("MASONITE CORPORATION - MONTERREY",  uid("Yuri Yassin"));
      await upsertCompany("MASONITE CORPORATION - US",         uid("Yuri Yassin"));
      await upsertCompany("MASONITE MEXICO SA DE CV",           uid("Yuri Yassin"));
      await upsertCompany("Rheem (Litchfield Park)", uid("TJ Russon"));
      const finalUsers     = await storage.getUsers();
      const finalCompanies = await storage.getCompanies();
      res.json({ ok: true, users: finalUsers.length, companies: finalCompanies.length });
    } catch (err: any) {
      console.error("Setup error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
    requireAuth(req, res, next);
  });

  app.get("/api/users", async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
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
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
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
      // NAMs can only create account_managers, always assigned to themselves as manager
      const assignedRole = currentUser.role === "national_account_manager" ? "account_manager" : (role || "account_manager");
      const assignedManagerId = currentUser.role === "national_account_manager" ? currentUser.id : (managerId || null);
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
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Access required" });
      }
      // NAMs can only edit users on their own team
      if (currentUser.role === "national_account_manager") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        if (!teamIds.includes(req.params.id) || req.params.id === currentUser.id) {
          return res.status(403).json({ error: "Cannot edit this user" });
        }
      }
      const data: any = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.username !== undefined) data.username = req.body.username;
      if (req.body.password) data.password = await bcrypt.hash(req.body.password, 10);
      // Only admins can change roles or managers
      if (currentUser.role === "admin") {
        if (req.body.role !== undefined) data.role = req.body.role;
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
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Access required" });
      }
      // NAMs can only delete users on their own team (not themselves)
      if (currentUser.role === "national_account_manager") {
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
      if (currentUser.role === "national_account_manager") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        return res.json(safeUsers.filter(u => teamIds.includes(u.id)));
      }
      return res.json(safeUsers.filter(u => u.id === currentUser.id));
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
      } else if (currentUser.role === "national_account_manager") {
        // NAM can assign to themselves or their team members
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
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Only admins and NAMs can reassign accounts" });
      }
      const { assignedTo } = req.body;
      if (!assignedTo) return res.status(400).json({ error: "assignedTo is required" });
      if (currentUser.role === "national_account_manager") {
        const teamIds = await storage.getTeamMemberIds(currentUser.id);
        if (!teamIds.includes(assignedTo)) {
          return res.status(403).json({ error: "Can only assign to team members" });
        }
      }
      const company = await storage.updateCompany(req.params.id, { assignedTo });
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

  // ── Financial Data ─────────────────────────────────────────────────────────

  app.get("/api/financials", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || (user.role !== "admin" && user.role !== "national_account_manager")) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const upload = await storage.getLatestFinancialUpload();
      if (!upload) return res.json(null);

      let rows = (upload.rows as any[]) || [];

      if (user.role === "national_account_manager") {
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
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const upload = await storage.createFinancialUpload({
        fileName: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        rowCount: rows.length,
        rows,
      });

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
      await storage.deleteFinancialUpload(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete upload" });
    }
  });

  return httpServer;
}
