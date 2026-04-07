import cron from "node-cron";
import XLSX from "xlsx";
import { storage } from "./storage";
import { isFirstBusinessDay } from "./monthlyGoalScheduler";
import { getGraphAccessToken, azureCredentialsConfigured } from "./graphService";

function logMessage(message: string): void {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [data-refresh] ${message}`);
}

function findSheetByName(workbook: XLSX.WorkBook, preferredName: string): string {
  const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === preferredName.toLowerCase());
  return match || workbook.SheetNames[0];
}

function extractSheetsFromWorkbook(workbook: XLSX.WorkBook) {
  const readSheet = (name: string): any[] => {
    const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === name.toLowerCase());
    if (!match) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[match], { defval: "" });
  };
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
  // Check for a month-specific tab first: ReplitNumbers[Month] e.g. "ReplitNumbersMarch"
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
    // The month tab is the exclusive source for its month — strip that month from ReplitNumbers
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
    bestDealDaysSpot: readSheet("Best Deal Days (SPOT)"),
    bestDealDaysAll: readSheet("Best Deal Days (ALL)"),
    trendAnalysis: readSheet("Trend Analysis"),
    averagesData: readSheet("Averages"),
    dailyAcquisition: readSheetSmart("Daily Acquisition Data"),
  };
}

export async function performOneDriveSync(uploadedBy: string): Promise<{ id: string; fileName: string; rowCount: number }> {
  const filePath = await storage.getSetting("onedrive_url");
  if (!filePath) {
    throw new Error("No OneDrive file path configured. Please save a OneDrive file path or item URL first.");
  }

  if (!azureCredentialsConfigured()) {
    throw new Error(
      "Azure credentials are not configured. OneDrive sync requires OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET to be set."
    );
  }

  const token = await getGraphAccessToken();

  // Determine the Graph API content URL from the configured value.
  // Supported formats:
  //   1. OneDrive share link: https://1drv.ms/... or https://onedrive.live.com/...
  //   2. Full Graph API URL: https://graph.microsoft.com/v1.0/drives/{driveId}/items/{itemId}/content
  //   3. Drive item URL without /content suffix (append it automatically)
  //   4. Relative path like /drives/{driveId}/items/{itemId} or drives/{driveId}/items/{itemId}
  let contentUrl: string;
  const trimmed = filePath.trim();

  if (trimmed.startsWith("https://1drv.ms/") || trimmed.startsWith("https://onedrive.live.com/") || trimmed.startsWith("https://sharepoint.com/") || trimmed.includes("sharepoint.com/")) {
    // OneDrive/SharePoint share link — convert to Graph shares URL
    // Encoding: "u!" + base64url(url) with no padding
    const encoded = "u!" + Buffer.from(trimmed).toString("base64").replace(/=/g, "").replace(/\//g, "_").replace(/\+/g, "-");
    contentUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`;
  } else if (trimmed.startsWith("https://graph.microsoft.com/")) {
    // Already a full Graph URL — use as-is, but ensure it ends with /content
    contentUrl = trimmed.endsWith("/content") ? trimmed : `${trimmed}/content`;
  } else if (trimmed.startsWith("/") || trimmed.startsWith("drives/") || trimmed.startsWith("users/") || trimmed.startsWith("me/")) {
    // Relative path — prepend base URL
    const rel = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    const withContent = rel.endsWith("/content") ? rel : `${rel}/content`;
    contentUrl = `https://graph.microsoft.com/v1.0/${withContent}`;
  } else {
    // Unrecognized format — surface a clear, actionable error
    throw new Error(
      `Unrecognized OneDrive path format. Please use one of these formats:\n` +
      `  • Share link:   https://1drv.ms/x/... (paste the link from OneDrive "Share" dialog)\n` +
      `  • Full URL:     https://graph.microsoft.com/v1.0/drives/{driveId}/items/{itemId}/content\n` +
      `  • Relative:     drives/{driveId}/items/{itemId}\n` +
      `  • User path:    users/{userId}/drive/root:/{path-to-file}\n` +
      `Note: Share links require the Azure app to have Files.Read.All application permission. ` +
      `A standalone item ID is not supported — a driveId is required.`
    );
  }

  const response = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let friendlyError: string;
    if (response.status === 401 || response.status === 403) {
      friendlyError = `Permission denied (HTTP ${response.status}). Make sure the Azure app has the Files.Read.All application permission granted in Azure Portal.`;
    } else if (response.status === 404) {
      friendlyError = `File not found (HTTP 404). Please check the OneDrive file path or item URL is correct.`;
    } else {
      friendlyError = `Graph API error (HTTP ${response.status}): ${errorText}`;
    }
    throw new Error(friendlyError);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = extractSheetsFromWorkbook(workbook);

  // Only read "March Replit" summary sheet if it exists by exact name — never fall back to another sheet
  const exactSummarySheetName = workbook.SheetNames.find(
    (s: string) => s.trim().toLowerCase() === "march replit"
  );
  let summaryRows: any[] = [];
  if (exactSummarySheetName) {
    const summarySheet = workbook.Sheets[exactSummarySheetName];
    const parsed: any[] = XLSX.utils.sheet_to_json(summarySheet, { defval: "" });
    const looksLikeSummary = parsed.some((r: any) => {
      const keys = Object.keys(r);
      return keys.some((k: string) => k.toLowerCase().includes("customer")) ||
             (String(r["__EMPTY"] || "").trim().length > 0 && Number(r["__EMPTY_1"]) > 0);
    });
    if (looksLikeSummary) summaryRows = parsed;
  }

  const upload = await storage.createFinancialUpload({
    fileName: `OneDrive Sync — ${new Date().toLocaleDateString()}`,
    uploadedAt: new Date().toISOString(),
    uploadedBy,
    rowCount: sheets.rows.length,
    rows: sheets.rows,
    summaryRows,
    bestDealDaysSpot: sheets.bestDealDaysSpot,
    bestDealDaysAll: sheets.bestDealDaysAll,
    trendAnalysis: sheets.trendAnalysis,
    averagesData: sheets.averagesData,
    dailyAcquisition: sheets.dailyAcquisition,
  });

  return { id: upload.id, fileName: upload.fileName, rowCount: upload.rowCount };
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function runMonthlyDataRefresh(): Promise<void> {
  const today = new Date();
  if (!isFirstBusinessDay(today)) return;

  const monthKey = getMonthKey(today);
  const settingKey = "monthly_data_refresh_last_run";
  const lastRun = await storage.getSetting(settingKey);
  if (lastRun === monthKey) {
    logMessage(`Monthly data refresh already ran for ${monthKey}, skipping`);
    return;
  }

  logMessage("First business day of the month — triggering automatic OneDrive data sync");

  try {
    const result = await performOneDriveSync("system");
    logMessage(`Monthly data refresh succeeded: ${result.rowCount} rows imported (upload ${result.id})`);

    await storage.setSetting("monthly_sync_failed", "");
    await storage.setSetting("monthly_sync_failed_error", "");
    await storage.setSetting(settingKey, monthKey);

    const defaultOrg = await storage.getDefaultOrganization(); const allUsers = defaultOrg ? await storage.getUsers(defaultOrg.id) : [];
    const admins = allUsers.filter(u => u.role === "admin");
    for (const admin of admins) {
      await storage.createNotification({
        userId: admin.id,
        type: "data_refresh",
        title: "Monthly data refresh completed",
        body: `Automatic OneDrive sync imported ${result.rowCount.toLocaleString()} records.`,
        link: "/financials",
        read: false,
      });
    }
  } catch (error: any) {
    const errorMessage = error?.message || "Unknown error";
    logMessage(`Monthly data refresh FAILED: ${errorMessage}`);

    await storage.setSetting("monthly_sync_failed", monthKey);
    await storage.setSetting("monthly_sync_failed_error", errorMessage);
    await storage.setSetting(settingKey, monthKey);

    const defaultOrg = await storage.getDefaultOrganization(); const allUsers = defaultOrg ? await storage.getUsers(defaultOrg.id) : [];
    const admins = allUsers.filter(u => u.role === "admin");
    for (const admin of admins) {
      await storage.createNotification({
        userId: admin.id,
        type: "data_refresh_failed",
        title: "Monthly data refresh failed",
        body: `The automatic OneDrive sync failed: ${errorMessage}. Please upload data manually.`,
        link: "/financials",
        read: false,
      });
    }
  }
}

export function initMonthlyDataRefreshScheduler(): void {
  const cronExpression = process.env.MONTHLY_DATA_REFRESH_CRON || "0 7 * * *";
  cron.schedule(cronExpression, () => {
    runMonthlyDataRefresh().catch(err => {
      logMessage(`Error in monthly data refresh scheduler: ${err.message}`);
    });
  });
  logMessage(`Monthly data refresh scheduler initialized (cron: ${cronExpression})`);

  runMonthlyDataRefresh().catch(err => {
    logMessage(`Error in startup catch-up data refresh check: ${err.message}`);
  });
}
