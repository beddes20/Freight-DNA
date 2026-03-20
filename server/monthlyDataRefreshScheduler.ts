import cron from "node-cron";
import XLSX from "xlsx";
import { storage } from "./storage";
import { isFirstBusinessDay } from "./monthlyGoalScheduler";

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
  const boraRaw: any[] = readSheet("YTD BORA");
  const rows = boraRaw.length > 0
    ? boraRaw.filter((r: any) => {
        const rc = (r["Revenue code"] || r["Revenue Code"] || "").toString().trim().toUpperCase();
        return rc === "UTAHB";
      })
    : readSheet("All Data (YTD)");
  return {
    rows,
    bestDealDaysSpot: readSheet("Best Deal Days (SPOT)"),
    bestDealDaysAll: readSheet("Best Deal Days (ALL)"),
    trendAnalysis: readSheet("Trend Analysis"),
    averagesData: readSheet("Averages"),
    dailyAcquisition: readSheet("Daily Acquisition Data"),
  };
}

export async function performOneDriveSync(uploadedBy: string): Promise<{ id: string; fileName: string; rowCount: number }> {
  const shareUrl = await storage.getSetting("onedrive_url");
  if (!shareUrl) {
    throw new Error("No OneDrive URL configured. Please save a OneDrive share link first.");
  }

  const base64 = Buffer.from(shareUrl)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // Try Microsoft Graph API first (works for OneDrive for Business / Microsoft 365),
  // then fall back to the personal OneDrive API.
  const endpoints = [
    `https://graph.microsoft.com/v1.0/shares/u!${base64}/driveItem/content`,
    `https://api.onedrive.com/v1.0/shares/u!${base64}/root/content`,
  ];

  let response: Response | null = null;
  let lastStatus = 0;
  for (const url of endpoints) {
    const r = await fetch(url, { redirect: "follow" });
    if (r.ok) { response = r; break; }
    lastStatus = r.status;
  }
  if (!response) {
    throw new Error(`Failed to fetch file from OneDrive (HTTP ${lastStatus}). Make sure the share link allows "Anyone with the link" to view and that it is a direct share link (not a folder link).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = extractSheetsFromWorkbook(workbook);

  const summarySheetName = findSheetByName(workbook, "March Replit");
  const summarySheet = workbook.Sheets[summarySheetName];
  const summaryRows: any[] = XLSX.utils.sheet_to_json(summarySheet, { defval: "" });

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

    const allUsers = await storage.getUsers();
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

    const allUsers = await storage.getUsers();
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
