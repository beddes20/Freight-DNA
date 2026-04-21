/**
 * load_fact PowerBI/OneDrive importer (Task #368).
 *
 * Pulls the unified TMS extract from PowerBI (OneDrive-hosted .xlsx is the
 * supported delivery format — same Microsoft Graph share-URL trick the other
 * importers use) and upserts every row into `load_fact`. Idempotent on
 * (org_id, order_id); per-row diffs go to `load_fact_history`.
 *
 * The unified extract is the *single* source of truth — replaces the legacy
 * `financial_uploads` per-month upload + `freight_opportunities` import paths
 * once the org cuts over (`load_fact_active` flag ON).
 */

import XLSX from "xlsx";
import { storage } from "./storage";
import { getGraphAccessToken, azureCredentialsConfigured } from "./graphService";
import {
  readTmsField,
  parseCarrierName,
  parsePayeeCode,
  normalizeTmsMonth,
  extractCity,
} from "./carrierRankingService";
import {
  bucketForMoveStatus,
  upsertLoadFact,
  writeLoadFactImportAudit,
  loadFactPowerBiUrlKey,
  loadFactLastImportKey,
  expireAbsentAvailableLoads,
  findRecentSuccessfulAuditByReplayToken,
  type LoadFactBucket,
} from "./carrierIntelligenceService";
import type { Company, InsertLoadFact } from "@shared/schema";
import crypto from "crypto";

export interface LoadFactImportSummary {
  fileName: string;
  fileHash: string | null;
  replayToken: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  transitioned: number;
  expired: number;
  skipped: number;
  buckets: { available: number; realized: number; cancelled: number; unknown: number };
  warnings: string[];
  durationMs: number;
  replayed?: boolean;
}

// Per-org FIFO queue: any concurrent trigger (manual + scheduled) is enqueued
// behind the in-flight run so overlapping triggers are serialized rather than
// dropped. Held in-memory because there is exactly one server process per
// environment; if we ever go multi-process we move this to a row-level
// Postgres advisory lock.
const orgQueues = new Map<string, Promise<unknown>>();

async function enqueueOrgRun<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const tail = orgQueues.get(orgId) ?? Promise.resolve();
  // Run after the previous tail settles, regardless of success/failure.
  const next = tail.then(() => fn(), () => fn());
  // Track this as the new tail; clear when this run settles iff still tail.
  orgQueues.set(orgId, next);
  next.finally(() => {
    if (orgQueues.get(orgId) === next) orgQueues.delete(orgId);
  }).catch(() => {});
  return next;
}

// ── Workbook fetch (mirrors availableFreightImporter.fetchWorkbookFromOneDrive) ──

async function fetchWorkbook(filePath: string): Promise<{ workbook: XLSX.WorkBook; fileName: string; fileHash: string }> {
  if (!azureCredentialsConfigured()) {
    throw new Error(
      "Azure credentials are not configured. PowerBI/OneDrive sync requires OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET.",
    );
  }
  const token = await getGraphAccessToken();
  const trimmed = filePath.trim();
  let contentUrl: string;
  if (
    trimmed.startsWith("https://1drv.ms/") ||
    trimmed.startsWith("https://onedrive.live.com/") ||
    trimmed.includes("sharepoint.com/")
  ) {
    const encoded = "u!" + Buffer.from(trimmed).toString("base64").replace(/=/g, "").replace(/\//g, "_").replace(/\+/g, "-");
    contentUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`;
  } else if (trimmed.startsWith("https://graph.microsoft.com/")) {
    contentUrl = trimmed.endsWith("/content") ? trimmed : `${trimmed}/content`;
  } else if (trimmed.startsWith("/") || trimmed.startsWith("drives/") || trimmed.startsWith("users/") || trimmed.startsWith("me/")) {
    const rel = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    const withContent = rel.endsWith("/content") ? rel : `${rel}/content`;
    contentUrl = `https://graph.microsoft.com/v1.0/${withContent}`;
  } else {
    throw new Error(
      "Unrecognized PowerBI/OneDrive path format for load_fact_powerbi_url. Use a OneDrive/SharePoint share link, full Graph URL, or a relative drives/{driveId}/items/{itemId} path.",
    );
  }

  const response = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Graph API error fetching load_fact extract (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const dispo = response.headers.get("content-disposition") ?? "";
  const dispoMatch = dispo.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
  const fileName = dispoMatch?.[1]
    ? decodeURIComponent(dispoMatch[1])
    : `load-fact-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { workbook, fileName, fileHash };
}

function chooseDataSheet(workbook: XLSX.WorkBook): { rows: Array<Record<string, unknown>>; sheetName: string } {
  // Prefer a sheet literally named "Loads" or "TMS Loads"; otherwise pick the
  // sheet with the most non-empty rows.
  const preferredNames = ["loads", "tms loads", "load fact", "load_fact", "powerbi"];
  const preferred = workbook.SheetNames.find(n => preferredNames.includes(n.trim().toLowerCase()));
  const sheetName = preferred ?? workbook.SheetNames.reduce((best, name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "" });
    const bestRows = XLSX.utils.sheet_to_json(workbook.Sheets[best], { defval: "" });
    return rows.length > bestRows.length ? name : best;
  }, workbook.SheetNames[0]);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" }) as Array<Record<string, unknown>>;
  return { rows, sheetName };
}

// ── Row → InsertLoadFact ───────────────────────────────────────────────────

function parseDateLoose(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && value > 40000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[$,]/g, ""));
  if (!isFinite(n)) return null;
  return n.toFixed(2);
}

function buildCompanyIndex(companies: Company[]): Map<string, Company> {
  const idx = new Map<string, Company>();
  for (const c of companies) {
    if (c.name) idx.set(c.name.trim().toLowerCase(), c);
  }
  return idx;
}

/**
 * Pull a stable order id from a row. Real TMS exports have an Order ID column;
 * if missing we synthesize one from a hash so the import remains idempotent
 * (same row → same id) without polluting downstream queries.
 */
function pickOrderId(row: Record<string, unknown>): string {
  const direct = readTmsField(row, "Order ID", "OrderID", "orderId", "Order #", "Order Number", "Load ID", "loadId", "Shipment ID", "shipmentId", "PRO Number", "BOL");
  if (direct) return String(direct).trim();
  // Synthesize from carrier+route+pickup as a last resort.
  const carrier = readTmsField(row, "Carrier", "Carrier Name", "carrier");
  const origin = readTmsField(row, "Origin", "shipperCity");
  const dest = readTmsField(row, "Destination", "consigneeCity");
  const pickup = readTmsField(row, "Pickup Date", "pickupDate");
  const rev = readTmsField(row, "Revenue", "revenue");
  const base = `${carrier}|${origin}|${dest}|${pickup}|${rev}|${JSON.stringify(row).slice(0, 200)}`;
  return "syn:" + crypto.createHash("sha1").update(base).digest("hex").slice(0, 20);
}

interface ParseResult {
  payload: InsertLoadFact;
  customerName: string | null;
  bucket: LoadFactBucket;
}

function parseRow(orgId: string, row: Record<string, unknown>, fileName: string, sourceKind: InsertLoadFact["sourceKind"] = "powerbi"): ParseResult | null {
  const orderId = pickOrderId(row);
  if (!orderId) return null;

  const carrierRaw = readTmsField(row, "Carrier", "Carrier Name", "carrier", "carrierName");
  const carrierName = carrierRaw ? parseCarrierName(carrierRaw) : null;
  const carrierPayeeCode = carrierRaw ? parsePayeeCode(carrierRaw) : null;

  const originRaw = readTmsField(row, "Origin", "shipperCity", "Origin City");
  const destRaw = readTmsField(row, "Destination", "consigneeCity", "Destination City");
  const originCity = originRaw ? extractCity(originRaw) : null;
  const destCity = destRaw ? extractCity(destRaw) : null;
  const originState = readTmsField(row, "Origin State", "originState", "Pickup State", "shipperState") || null;
  const destState = readTmsField(row, "Destination State", "destinationState", "Delivery State", "consigneeState") || null;
  const originZip = readTmsField(row, "Origin Zip", "Origin ZIP", "originZip", "shipperZip", "Pickup Zip") || null;
  const destZip = readTmsField(row, "Destination Zip", "Destination ZIP", "destinationZip", "consigneeZip", "Delivery Zip") || null;

  const accountManager = readTmsField(row, "Account Manager", "accountManager", "AM", "Sales Rep", "Account Owner") || null;
  const dispatcher = readTmsField(row, "Dispatcher", "dispatcher", "Operations", "Ops Rep") || null;

  const equipmentType = readTmsField(row, "Equipment", "Equipment Type", "Trailer", "Trailer Type", "equipmentType") || null;

  const pickupDate = parseDateLoose(readTmsField(row, "Pickup Date", "pickupDate", "Pickup", "Ship Date", "shipDate"));
  const deliveryDate = parseDateLoose(readTmsField(row, "Delivery Date", "deliveryDate", "Drop Date", "dropDate"));
  const pickupApptStart = parseDateLoose(readTmsField(row, "Pickup Appt Start", "pickupApptStart", "Pickup Appt Open"));
  const pickupApptEnd = parseDateLoose(readTmsField(row, "Pickup Appt End", "pickupApptEnd", "Pickup Appt Close"));
  const deliveryApptStart = parseDateLoose(readTmsField(row, "Delivery Appt Start", "deliveryApptStart", "Delivery Appt Open"));
  const deliveryApptEnd = parseDateLoose(readTmsField(row, "Delivery Appt End", "deliveryApptEnd", "Delivery Appt Close"));
  const arrivedAtPickup = parseDateLoose(readTmsField(row, "Arrived At Pickup", "arrivedAtPickup", "Pickup Actual"));
  const arrivedAtDelivery = parseDateLoose(readTmsField(row, "Arrived At Delivery", "arrivedAtDelivery", "Delivery Actual"));
  const totalStopsRaw = readTmsField(row, "Total Stops", "Stops", "totalStops", "Stop Count");
  const totalStops = totalStopsRaw ? Math.max(0, parseInt(totalStopsRaw, 10) || 0) : null;
  const totalMiles = parseDecimal(readTmsField(row, "Total Miles", "Miles", "totalMiles", "Distance"));
  const monthRaw = readTmsField(row, "Month", "month");
  const month = normalizeTmsMonth(monthRaw) || (pickupDate ? pickupDate.slice(0, 7) : null);

  const moveStatus = readTmsField(row, "Move Status", "MoveStatus", "moveStatus", "Status", "status") || null;
  const bucket = bucketForMoveStatus(moveStatus);

  const revenue = parseDecimal(readTmsField(row, "Revenue", "revenue", "Linehaul Revenue"));
  const cost = parseDecimal(readTmsField(row, "Cost", "cost", "Carrier Cost", "Linehaul Cost"));
  const margin = parseDecimal(readTmsField(row, "Margin", "margin", "Profit", "GM", "Gross Margin"));
  let marginPct: string | null = null;
  if (revenue && margin) {
    const r = parseFloat(revenue);
    const m = parseFloat(margin);
    if (r > 0 && isFinite(m)) marginPct = (m / r).toFixed(4);
  }
  const loadCountRaw = readTmsField(row, "Loads", "Load Count", "loadCount", "Qty");
  const loadCount = Math.max(1, parseInt(loadCountRaw, 10) || 1);

  const customerName = readTmsField(row, "Customer", "Customer Name", "customer", "customerName", "Shipper", "Account") || null;

  const payload: InsertLoadFact = {
    orgId,
    orderId,
    companyId: null,
    customerName,
    carrierName,
    carrierPayeeCode,
    originCity,
    originState,
    originZip,
    destinationCity: destCity,
    destinationState: destState,
    destinationZip: destZip,
    accountManager,
    dispatcher,
    equipmentType,
    pickupDate,
    deliveryDate,
    pickupApptStart,
    pickupApptEnd,
    deliveryApptStart,
    deliveryApptEnd,
    arrivedAtPickup,
    arrivedAtDelivery,
    totalStops,
    totalMiles,
    month: month || null,
    moveStatus,
    bucket,
    revenue,
    cost,
    margin,
    marginPct,
    loadCount,
    rawRow: row,
    sourceFileName: fileName,
    sourceKind,
  };
  return { payload, customerName, bucket };
}

// ── Main entry ─────────────────────────────────────────────────────────────

export interface PerformLoadFactImportOptions {
  orgId: string;
  actorUserId: string | null;
  triggeredBy: "manual" | "scheduled";
}

export async function performLoadFactImport(opts: PerformLoadFactImportOptions): Promise<LoadFactImportSummary> {
  const { orgId, actorUserId, triggeredBy } = opts;
  return enqueueOrgRun(orgId, () => performLoadFactImportInner(orgId, actorUserId, triggeredBy));
}

async function performLoadFactImportInner(
  orgId: string,
  actorUserId: string | null,
  triggeredBy: "manual" | "scheduled",
): Promise<LoadFactImportSummary> {
  const startedAt = Date.now();
  const settingKey = loadFactPowerBiUrlKey(orgId);
  const filePath = await storage.getSetting(settingKey);
  if (!filePath) {
    throw new Error(
      `No PowerBI/OneDrive path configured for load_fact. Set "${settingKey}" to the share link or Graph item path of the unified TMS extract.`,
    );
  }

  let fileName = "";
  let fileHash: string | null = null;
  try {
    const fetched = await fetchWorkbook(filePath);
    fileName = fetched.fileName;
    fileHash = fetched.fileHash;
    // Replay-token guard: same content already applied successfully → skip
    // re-running the upsert loop, but write a fresh audit row so the run is
    // visible. Caller can force a re-run by changing the source file.
    const replayToken = fileHash;
    const prior = await findRecentSuccessfulAuditByReplayToken(orgId, replayToken);
    if (prior) {
      const summary: LoadFactImportSummary = {
        fileName,
        fileHash,
        replayToken,
        totalRows: prior.totalRows,
        inserted: 0,
        updated: 0,
        unchanged: prior.totalRows,
        transitioned: 0,
        expired: 0,
        skipped: 0,
        buckets: prior.buckets,
        warnings: [`Replayed: file hash ${replayToken.slice(0, 12)} matches a prior successful import (${prior.createdAt}). No load_fact writes performed.`],
        durationMs: Date.now() - startedAt,
        replayed: true,
      };
      await writeLoadFactImportAudit({
        orgId,
        fileName,
        fileHash,
        replayToken,
        totalRows: summary.totalRows,
        inserted: 0,
        updated: 0,
        unchanged: summary.unchanged,
        transitioned: 0,
        expired: 0,
        skipped: 0,
        buckets: summary.buckets,
        warnings: summary.warnings,
        actorUserId,
        triggeredBy,
        kind: "powerbi",
        durationMs: summary.durationMs,
      });
      return summary;
    }
    const summary = await runImportFromWorkbook(
      fetched.workbook, fileName, fileHash, replayToken, orgId, actorUserId, triggeredBy,
    );
    await storage.setSetting(loadFactLastImportKey(orgId), JSON.stringify({
      at: new Date().toISOString(),
      ...summary,
      fileName,
    }));
    // Kick off the carrier-intelligence recompute (Task #369) — fire-and-forget
    // so the import call returns promptly. The recompute orchestrator is
    // single-flight per org, so a back-to-back import simply reuses the
    // in-flight rebuild instead of stacking.
    void (async () => {
      try {
        const { recomputeCarrierIntelligence } = await import("./carrierIntelligenceRecompute");
        await recomputeCarrierIntelligence(orgId);
      } catch (err) {
        console.warn(`[load-fact] post-import carrier-intel recompute failed: ${(err as Error).message}`);
      }
    })();
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeLoadFactImportAudit({
      orgId,
      fileName: fileName || null,
      fileHash,
      replayToken: fileHash,
      totalRows: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      transitioned: 0,
      expired: 0,
      skipped: 0,
      buckets: { available: 0, realized: 0, cancelled: 0, unknown: 0 },
      warnings: [],
      actorUserId,
      triggeredBy,
      kind: "powerbi",
      error: msg.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function runImportFromWorkbook(
  workbook: XLSX.WorkBook,
  fileName: string,
  fileHash: string | null,
  replayToken: string | null,
  orgId: string,
  actorUserId: string | null,
  triggeredBy: "manual" | "scheduled",
): Promise<LoadFactImportSummary> {
  const startedAt = Date.now();
  const importStartedAt = new Date();
  const { rows: rawRows, sheetName } = chooseDataSheet(workbook);
  const companies = await storage.getCompanies(orgId);
  const companyIdx = buildCompanyIndex(companies);

  // Snapshot pre-import bucket per order so we can count transitions
  // (e.g. available → realized). We only need a Map of order_id → bucket.
  const { db } = await import("./storage");
  const { sql } = await import("drizzle-orm");
  const preBucketResult = await db.execute<{ order_id: string; bucket: string }>(
    sql`SELECT order_id, bucket FROM load_fact WHERE org_id = ${orgId}`,
  );
  const preBucketRows = Array.isArray(preBucketResult)
    ? (preBucketResult as Array<{ order_id: string; bucket: string }>)
    : ((preBucketResult as { rows: Array<{ order_id: string; bucket: string }> }).rows ?? []);
  const priorBucketByOrder = new Map<string, string>();
  for (const r of preBucketRows) priorBucketByOrder.set(r.order_id, r.bucket);

  const warnings: string[] = [];
  const buckets = { available: 0, realized: 0, cancelled: 0, unknown: 0 };
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let transitioned = 0;
  let skipped = 0;
  const seen = new Set<string>();

  const importBatchId = crypto.randomBytes(8).toString("hex");

  for (const row of rawRows) {
    const parsed = parseRow(orgId, row, fileName, "powerbi");
    if (!parsed) { skipped++; continue; }
    if (seen.has(parsed.payload.orderId)) { skipped++; continue; }
    seen.add(parsed.payload.orderId);

    if (parsed.customerName) {
      const company = companyIdx.get(parsed.customerName.trim().toLowerCase());
      if (company) parsed.payload.companyId = company.id;
    }

    buckets[parsed.bucket]++;

    try {
      const out = await upsertLoadFact(parsed.payload, importBatchId);
      const priorBucket = priorBucketByOrder.get(parsed.payload.orderId);
      if (priorBucket && priorBucket !== parsed.bucket) transitioned++;
      if (out.inserted) inserted++;
      else if (out.updated) updated++;
      else unchanged++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Row order_id=${parsed.payload.orderId}: ${msg.slice(0, 200)}`);
      skipped++;
    }
  }

  if (warnings.length === 0 && rawRows.length > 0 && seen.size === 0) {
    warnings.push(`No usable rows parsed from sheet "${sheetName}" — check column headers (Order ID, Move Status, Carrier, Origin, Destination, Revenue, Cost).`);
  }

  // Lifecycle sweep: anything Available/Unknown that wasn't seen this run is
  // assumed pulled from the queue → expire it. Skip the sweep if the import
  // produced zero usable rows (the file is probably broken).
  let expired = 0;
  if (seen.size > 0) {
    expired = await expireAbsentAvailableLoads(orgId, importStartedAt, importBatchId);
    if (expired > 0) buckets.cancelled += expired;
  }

  const summary: LoadFactImportSummary = {
    fileName,
    fileHash,
    replayToken,
    totalRows: seen.size,
    inserted,
    updated,
    unchanged,
    transitioned,
    expired,
    skipped,
    buckets,
    warnings,
    durationMs: Date.now() - startedAt,
  };

  await writeLoadFactImportAudit({
    orgId,
    fileName,
    fileHash,
    replayToken,
    totalRows: summary.totalRows,
    inserted,
    updated,
    unchanged,
    transitioned,
    expired,
    skipped,
    buckets,
    warnings,
    actorUserId,
    triggeredBy,
    kind: "powerbi",
    durationMs: summary.durationMs,
  });

  return summary;
}

/**
 * Scheduler entry point — iterates orgs that have a PowerBI URL configured.
 * Errors are caught per-org so a single failure does not block the rest.
 */
export async function runScheduledLoadFactImports(): Promise<void> {
  const allOrgs = await storage.getOrganizations();
  for (const org of allOrgs) {
    const url = await storage.getSetting(loadFactPowerBiUrlKey(org.id));
    if (!url) continue;
    try {
      const summary = await performLoadFactImport({ orgId: org.id, actorUserId: null, triggeredBy: "scheduled" });
      console.log(
        `[load-fact-scheduler] org=${org.id} file=${summary.fileName} ` +
        `inserted=${summary.inserted} updated=${summary.updated} unchanged=${summary.unchanged} ` +
        `available=${summary.buckets.available} realized=${summary.buckets.realized}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No PowerBI/OneDrive path configured")) continue;
      console.error(`[load-fact-scheduler] org=${org.id} import failed:`, msg);
    }
  }
}

// Exported for backfill module.
export { parseRow as parseTmsRowToLoadFact };
