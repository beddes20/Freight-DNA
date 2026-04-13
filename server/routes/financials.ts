import type { Express } from "express";
import multer from "multer";
import XLSX from "xlsx";
import { storage } from "../storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds } from "../auth";
import { runRecurringLaneEngineForOrg } from "../recurringLaneCapacityEngine";
import {
  resolveColumns,
  getRepFromRow,
  getDispatcherFromRow,
  getSalespersonFromRow,
  getStatusFromRow,
  getCustomerFromRow,
} from "../colResolver";
import {
  isExcludedRow,
  parseHistoricalRow,
  isBadSummaryData,
  extractSheetsFromWorkbook,
} from "../financialHelpers";
import { performOneDriveSync } from "../monthlyDataRefreshScheduler";
import { azureCredentialsConfigured } from "../graphService";
import { geocodeCity, haversineDistance } from "../geocoding";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "../cache";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

export function registerFinancialRoutes(app: Express): void {
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
        const allOrgUsers = await storage.getUsers(req.session.organizationId!);
        // Always include the current user in teamIds to handle directors who appear
        // in financial data under their own name as well as their reports' names.
        const effectiveIds = teamIds.includes(user.id) ? teamIds : [user.id, ...teamIds];
        const teamUsers = allOrgUsers.filter(u => effectiveIds.includes(u.id));
        const lmNames = teamUsers.filter(u => u.role === "logistics_manager" || u.role === "logistics_coordinator").map(u => u.name.toLowerCase());
        const salesNames = teamUsers.filter(u => u.role !== "logistics_manager" && u.role !== "logistics_coordinator").map(u => u.name.toLowerCase());
        // Also include financialRepIds as alternate name identifiers for matching
        const repIds = teamUsers
          .filter(u => u.financialRepId && u.role !== "logistics_manager" && u.role !== "logistics_coordinator")
          .map(u => u.financialRepId!.toLowerCase());
        const nameMatcher = (candidate: string, nameList: string[], repIdList?: string[]) => {
          if (!candidate) return false;
          if (nameList.some(n => n && (candidate.includes(n) || n.includes(candidate)))) return true;
          if (repIdList && repIdList.some(n => n && (candidate.includes(n) || n.includes(candidate)))) return true;
          return false;
        };
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          const disp = getDispatcherFromRow(r, oppCols).toLowerCase();
          return nameMatcher(op, salesNames, repIds)
            || nameMatcher(disp, lmNames);
        });
      } else if (user.role === "account_manager") {
        const userName = user.name.toLowerCase();
        const userRepId = user.financialRepId?.toLowerCase();
        allRows = allRows.filter((r: any) => {
          const op = getRepFromRow(r, oppCols);
          return op.includes(userName) || userName.includes(op)
            || (userRepId && (op.includes(userRepId) || userRepId.includes(op)));
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

      // Auto-run lane capacity engine after each financial upload (fire-and-forget)
      const orgId = req.session.organizationId;
      if (orgId) {
        runRecurringLaneEngineForOrg(orgId, storage).then(result => {
          console.log(`[lane-engine] auto-run after upload for org=${orgId}: ${result.upserted} upserted, ${result.total} total`);
        }).catch(err => {
          console.error(`[lane-engine] auto-run error for org=${orgId}:`, err);
        });
      }
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

  app.get("/api/settings/azure-enabled", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      res.json({ enabled: azureCredentialsConfigured() });
    } catch (error) {
      res.status(500).json({ error: "Failed to check Azure status" });
    }
  });

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

  // ── Lane Corridors ─────────────────────────────────────────────────────────────────────────────
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

}
