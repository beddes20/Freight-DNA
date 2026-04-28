/**
 * Available Freight OneDrive Importer (task #354).
 *
 * Pulls the daily Available Freight spreadsheet from OneDrive, parses the
 * loads, and upserts them into `freight_opportunities` so they appear in the
 * existing /available-freight page AND the new "Available Freight" tab inside
 * My Procurement.
 *
 * Reuses the Azure AD app-only auth + Graph shares-URL pattern already
 * established by `monthlyDataRefreshScheduler.ts`. The setting key
 * `available_freight_onedrive_url` holds the OneDrive share/relative path.
 *
 * Upsert key: (orgId, sourceFileName, stableLoadKey) where stableLoadKey is
 * a hash of origin+destination+pickup window+equipment+customer name. This
 * keeps repeated imports of the same daily file idempotent and lets us mark
 * vanished rows as `expired`.
 */

import XLSX from "xlsx";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { storage, db } from "./storage";
import { getGraphAccessToken, azureCredentialsConfigured } from "./graphService";
import { resilientFetch } from "./lib/httpRetry";
import { upsertLoadFact } from "./carrierIntelligenceService";
import { freightOpportunityToInsert } from "./loadFactBackfill";
import { ensureShortlistRanked } from "./proactiveOpportunityService";
import { cleanCustomerLabel } from "@shared/laneFormatters";
import type {
  FreightOpportunity,
  InsertFreightOpportunity,
  Company,
  User,
} from "@shared/schema";

/**
 * Per-org settings key. Each organization configures its own OneDrive source
 * so the scheduled importer cannot bleed one tenant's spreadsheet into
 * another tenant's data — even when company names overlap.
 */
export function availableFreightSettingKey(orgId: string): string {
  return `available_freight_onedrive_url:${orgId}`;
}

/**
 * Aggregate audit log of every Available Freight import run. Each row is the
 * "summary" event for one full import (the per-opportunity events still land
 * in `freight_opportunity_audit`). We provision the table on first use to
 * avoid forcing a `npm run db:push` round-trip for this single feature.
 */
let importAuditTableEnsured = false;
async function ensureImportAuditTable(): Promise<void> {
  if (importAuditTableEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS freight_opportunity_import_audit (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id varchar NOT NULL,
      file_name text,
      total_rows integer NOT NULL DEFAULT 0,
      inserted integer NOT NULL DEFAULT 0,
      updated integer NOT NULL DEFAULT 0,
      expired integer NOT NULL DEFAULT 0,
      unmatched_companies integer NOT NULL DEFAULT 0,
      warnings jsonb,
      actor_user_id varchar,
      triggered_by text NOT NULL DEFAULT 'manual',
      error text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS freight_opp_import_audit_org_created_idx
      ON freight_opportunity_import_audit (org_id, created_at DESC)
  `);
  importAuditTableEnsured = true;
}

async function writeImportAudit(row: {
  orgId: string;
  fileName: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  warnings: string[];
  actorUserId: string | null;
  triggeredBy: "manual" | "scheduled";
  error?: string | null;
}): Promise<void> {
  await ensureImportAuditTable();
  await db.execute(sql`
    INSERT INTO freight_opportunity_import_audit
      (org_id, file_name, total_rows, inserted, updated, expired,
       unmatched_companies, warnings, actor_user_id, triggered_by, error)
    VALUES (${row.orgId}, ${row.fileName}, ${row.totalRows}, ${row.inserted},
            ${row.updated}, ${row.expired}, ${row.unmatchedCompanies},
            ${JSON.stringify(row.warnings)}::jsonb, ${row.actorUserId},
            ${row.triggeredBy}, ${row.error ?? null})
  `);
}

export interface AvailableFreightImportAuditRow {
  id: string;
  fileName: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  warnings: string[];
  actorUserId: string | null;
  triggeredBy: string;
  error: string | null;
  createdAt: string;
}

interface RawImportAuditRow {
  id: string;
  file_name: string | null;
  total_rows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatched_companies: number;
  warnings: unknown;
  actor_user_id: string | null;
  triggered_by: string;
  error: string | null;
  created_at: Date | string;
  [k: string]: unknown;
}

export async function listAvailableFreightImports(
  orgId: string,
  limit = 25,
): Promise<AvailableFreightImportAuditRow[]> {
  await ensureImportAuditTable();
  const result = await db.execute<RawImportAuditRow>(sql`
    SELECT id, file_name, total_rows, inserted, updated, expired,
           unmatched_companies, warnings, actor_user_id, triggered_by,
           error, created_at
      FROM freight_opportunity_import_audit
     WHERE org_id = ${orgId}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `);
  // Drizzle's `db.execute` returns a driver-specific shape; on the postgres
  // driver used here it's `{ rows: T[] }`, but on neon-http it's the array
  // itself. Normalize without resorting to `any` casts.
  const rows: RawImportAuditRow[] = Array.isArray(result)
    ? (result as RawImportAuditRow[])
    : ((result as { rows: RawImportAuditRow[] }).rows ?? []);
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    totalRows: r.total_rows,
    inserted: r.inserted,
    updated: r.updated,
    expired: r.expired,
    unmatchedCompanies: r.unmatched_companies,
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    actorUserId: r.actor_user_id,
    triggeredBy: r.triggered_by,
    error: r.error,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export interface AvailableFreightImportSummary {
  fileName: string;
  totalRows: number;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  warnings: string[];
  // Diagnostics: surfaced to the UI so users can debug column/name mismatches
  // without having to grep server logs.
  diagnostics?: {
    sheetName?: string;
    headers?: string[];
    skippedWithCarrier?: number;
    sampleUnmatchedCustomers?: string[];
    parsedRowCount?: number;
    historicalRunsImported?: number;
    historicalRunsTotal?: number;
  };
}

interface ParsedLoad {
  customerName: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  // Delivery date from "Early del dt" (Task #820). Distinct from pickupWindowEnd; empty when absent.
  deliveryDate: string;
  loadCount: number;
  notes: string | null;
  ownerEmail: string | null;
  /** TMS order number from column A — canonical identity across days. */
  orderId: string;
  stableKey: string;
  rawRow: Record<string, unknown>;
}

/**
 * A row whose Brokerage status indicates it has moved out of the AVL queue
 * (AVL → TRANSIT, POD, DEL, etc). We use these to (a) close out the prior AVL
 * opportunity for the same Order#, and (b) selectively feed proven completed
 * runs into load_fact for carrier ranking history.
 */
interface ParsedNonAvlRow {
  orderId: string;
  brokerageStatus: string;
}

/**
 * A row from the spreadsheet that already has a carrier assigned. These are
 * NOT "available" loads (we won't insert them into freight_opportunities) but
 * they ARE valuable as lane history — they tell us "Carrier X ran Phoenix→
 * San Diego for this customer last week", which is exactly what the carrier
 * ranking service uses to put proven carriers at the top of the shortlist on
 * the next available load. We persist these to load_fact as `realized`.
 */
interface ParsedHistoricalRun {
  customerName: string;
  carrierName: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  pickupDate: string;
  deliveryDate: string;
  loadCount: number;
  /** TMS Order#. Used as load_fact.orderId so daily re-imports collapse onto
   * the same row (same Order = same physical load). */
  orderId: string;
  /** Carrier cost from "Total pay" column. Null if absent or zero. */
  carrierCost: number | null;
  /** Brokerage status (TRANSIT, POD, DEL) — used by load_fact moveStatus. */
  brokerageStatus: string;
  rowKey: string;
  rawRow: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    for (const rk of Object.keys(row)) {
      if (rk.trim().toLowerCase() === k.toLowerCase()) {
        const v = row[rk];
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (s) return s;
      }
    }
  }
  return "";
}

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

function splitCityState(value: string): { city: string; state: string | null } {
  const m = value.match(/^(.+?)[,\s]+([A-Z]{2})\s*$/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
  return { city: value.trim(), state: null };
}

function buildStableKey(parts: Array<string | null>): string {
  const base = parts.map(p => (p ?? "").trim().toLowerCase()).join("|");
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 24);
}

/**
 * Re-export of the shared customer-label cleaner. Defined in
 * `shared/laneFormatters.ts` so the frontend display formatter and this
 * importer stay in lock-step. The cleaned label is what we feed into
 * company-name matching; the original is preserved on the row for diagnostics.
 *
 * NOTE: a bare `export { cleanCustomerLabel } from "..."` re-export does *not*
 * create a local binding — calls inside this file would resolve to `undefined`
 * at runtime. Import for local use first, then re-export the identifier.
 */
export { cleanCustomerLabel };

/**
 * TMS equipment-code → canonical Mode label. Every common spreadsheet variant
 * collapses to the same canonical string so the Mode column / filter / carrier
 * ranker all key off one stable label per equipment family. Unknown codes fall
 * back to the trimmed raw value so we never silently lose info.
 *
 * Canonical labels: Van, Reefer, Power Only, Flatbed, Flatbed w/ Tarps,
 * Step Deck, Double Drop, Conestoga, LTL.
 */
const EQUIPMENT_CODE_MAP: Record<string, string> = {
  // Van family
  V: "Van",
  VAN: "Van",
  DV: "Van",
  FTL: "Van",
  // Reefer family
  R: "Reefer",
  RF: "Reefer",
  REF: "Reefer",
  REEFER: "Reefer",
  // Power Only
  PO: "Power Only",
  // Flatbed family
  F: "Flatbed",
  FB: "Flatbed",
  FV: "Flatbed",
  FLAT: "Flatbed",
  FLATBED: "Flatbed",
  FT: "Flatbed w/ Tarps",
  // Step Deck
  SD: "Step Deck",
  SB: "Step Deck",
  // Double Drop
  DD: "Double Drop",
  // Conestoga
  CN: "Conestoga",
  CONESTOGA: "Conestoga",
  // LTL
  LTL: "LTL",
};
function mapEquipmentCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const k = code.trim().toUpperCase();
  if (!k) return null;
  return EQUIPMENT_CODE_MAP[k] ?? code.trim();
}

/**
 * Parses TMS pickup/delivery datetimes. Daily-upload format is
 * "MM/DD/YYYY HHMM" (e.g. "04/27/2026 0700"). Time portion is dropped — we
 * only persist the calendar day. Falls back to the loose ISO parser for any
 * other shape so we don't blow up if TMS export changes incidentally.
 */
function parsePickupDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  return parseDateLoose(value);
}

/**
 * "42000.0 LB" → 42000. Returns null if the cell is empty or unparseable.
 * Currently informational only; not persisted, but future-proofs the parser
 * if we want to expose weight on opportunities.
 */
function parseWeightLbs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** "brock.b" / "BRIANNAC" → normalized lookup key. */
function normalizeOpsHandle(value: string): string {
  return value.trim().toLowerCase();
}

/** Brokerage statuses considered proven completed/in-flight runs to feed
 * load_fact for carrier ranking history. Decision: POD + DEL + TRANSIT. */
const HISTORICAL_STATUSES = new Set(["POD", "DEL", "TRANSIT"]);

/** Map TMS brokerage status to load_fact.moveStatus. */
function mapMoveStatus(brokerageStatus: string): string {
  switch (brokerageStatus.toUpperCase()) {
    case "DEL":
    case "POD":
      return "delivered";
    case "TRANSIT":
      return "in_transit";
    default:
      return "delivered";
  }
}

function parseSheetToLoads(
  rows: Array<Record<string, unknown>>,
  diagnostics: {
    skippedWithCarrier: number;
    historicalRuns: ParsedHistoricalRun[];
    nonAvlRows: ParsedNonAvlRow[];
  },
): ParsedLoad[] {
  const out: ParsedLoad[] = [];
  // New TMS daily-upload format (Apr 2026). Headers are the canonical names
  // produced by the third tab "Available Freight":
  //   A Order   B Brokerage status   C Move status   D Origin city
  //   E Origin state   F Dest city   G Dest state   H Equip type
  //   L Early P/U dt   R Customer   T Total pay   X Carrier name
  //   Z Ops user
  //
  // Routing rules:
  //   • Brokerage status = "AVL" → ParsedLoad (becomes a freight_opportunity)
  //   • Brokerage status ∈ {POD, DEL, TRANSIT} → ParsedHistoricalRun
  //     (feeds load_fact for carrier ranking history)
  //   • Anything else → diagnostics.nonAvlRows (used to auto-close prior AVL
  //     opportunities for the same Order#) — but no other persistence.
  //
  // Planning comment (col N) is intentionally ignored per product decision.
  for (const row of rows) {
    const orderId = pick(row, "Order", "Order #", "Order Number");
    const brokerageStatus = pick(row, "Brokerage status", "Brokerage Status").toUpperCase();
    if (!orderId || !brokerageStatus) continue;

    const customerName = cleanCustomerLabel(pick(row, "Customer"));
    const originCity = pick(row, "Origin city", "Origin City");
    const originStateRaw = pick(row, "Origin state", "Origin State");
    const destCity = pick(row, "Dest city", "Destination city", "Destination City", "Dest City");
    const destStateRaw = pick(row, "Dest state", "Destination state", "Destination State", "Dest State");
    const equipmentCode = pick(row, "Equip type", "Equipment", "Equipment Type", "Trailer Type");
    const equipmentType = mapEquipmentCode(equipmentCode);
    const carrierName = pick(row, "Carrier name", "Carrier Name").trim();
    const opsUser = pick(row, "Ops user", "Ops User", "Owner", "Rep");
    const ownerEmail = opsUser ? normalizeOpsHandle(opsUser) : null;
    const pickupDate = parsePickupDateTime(pick(row, "Early P/U dt", "Pickup Date", "Pickup"));
    const deliveryDate = parsePickupDateTime(pick(row, "Early del dt", "Delivery Date"));
    const stops = parseInt(pick(row, "Stops"), 10);
    const loadCount = 1; // every TMS row = a single load

    // Carrier pay (col T "Total pay") — captured for historical runs only;
    // ignored for AVL because it's always 0 there.
    const totalPayRaw = pick(row, "Total pay", "Total Pay");
    const totalPayNum = totalPayRaw ? parseFloat(totalPayRaw) : NaN;
    const carrierCost = Number.isFinite(totalPayNum) && totalPayNum > 0 ? totalPayNum : null;

    if (brokerageStatus === "AVL") {
      if (!customerName || !originCity || !destCity) continue;
      const start = pickupDate ?? new Date().toISOString().slice(0, 10);
      // Available Freight rows are always a single pickup day. Even if
      // delivery date is later, we collapse the persisted window to one day.
      const end = start;
      // Stable identity = the TMS Order#. Same Order# in tomorrow's file
      // collapses onto the same opportunity (no duplicates) and any drift in
      // city/equipment/date is treated as an in-place edit.
      const stableKey = buildStableKey([orderId]);
      out.push({
        customerName,
        origin: originCity,
        originState: originStateRaw ? originStateRaw.toUpperCase() : null,
        destination: destCity,
        destinationState: destStateRaw ? destStateRaw.toUpperCase() : null,
        equipmentType,
        pickupWindowStart: start,
        pickupWindowEnd: end,
        deliveryDate: deliveryDate ?? "",
        loadCount: Number.isFinite(stops) ? Math.max(1, stops + 1) : loadCount,
        notes: null, // planning comment intentionally excluded
        ownerEmail,
        orderId,
        stableKey,
        rawRow: row,
      });
      continue;
    }

    // Non-AVL row — record so we can auto-close any prior AVL opportunity for
    // the same Order#.
    diagnostics.nonAvlRows.push({ orderId, brokerageStatus });

    if (HISTORICAL_STATUSES.has(brokerageStatus)) {
      diagnostics.skippedWithCarrier++;
      if (!customerName || !originCity || !destCity || !carrierName) continue;
      // rowKey collapses re-imports of the same Order# onto a single load_fact row.
      const rowKey = buildStableKey([orderId]);
      diagnostics.historicalRuns.push({
        customerName,
        carrierName,
        origin: originCity,
        originState: originStateRaw ? originStateRaw.toUpperCase() : null,
        destination: destCity,
        destinationState: destStateRaw ? destStateRaw.toUpperCase() : null,
        equipmentType,
        pickupDate: pickupDate ?? "",
        deliveryDate: deliveryDate ?? "",
        loadCount,
        orderId,
        carrierCost,
        brokerageStatus,
        rowKey,
        rawRow: row,
      });
    }
  }
  return out;
}

// ── OneDrive fetch (mirrors monthlyDataRefreshScheduler.performOneDriveSync) ──

async function fetchWorkbookFromOneDrive(filePath: string): Promise<{ workbook: XLSX.WorkBook; fileName: string }> {
  if (!azureCredentialsConfigured()) {
    throw new Error(
      "Azure credentials are not configured. OneDrive sync requires OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET."
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
      "Unrecognized OneDrive path format for available_freight_onedrive_url. Use a OneDrive/SharePoint share link, full Graph URL, or a relative drives/{driveId}/items/{itemId} path."
    );
  }

  const response = await resilientFetch("onedrive", () => fetch(contentUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  }));
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Graph API error fetching available freight file (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  // Best-effort filename: take the basename from the URL or fall back to a date stamp.
  const dispo = response.headers.get("content-disposition") ?? "";
  const dispoMatch = dispo.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
  const fileName = dispoMatch?.[1]
    ? decodeURIComponent(dispoMatch[1])
    : `available-freight-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { workbook, fileName };
}

function chooseDataSheet(workbook: XLSX.WorkBook): Array<Record<string, unknown>> {
  return chooseDataSheetWithName(workbook).rows;
}

function chooseDataSheetWithName(workbook: XLSX.WorkBook): { sheetName: string; rows: Array<Record<string, unknown>> } {
  // Prefer a sheet literally named "Available Freight"; otherwise pick the
  // sheet with the most non-empty rows (after the header).
  const preferred = workbook.SheetNames.find(
    n => n.trim().toLowerCase() === "available freight",
  );
  const sheetName = preferred ?? workbook.SheetNames.reduce((best, name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "" });
    const bestRows = XLSX.utils.sheet_to_json(workbook.Sheets[best], { defval: "" });
    return rows.length > bestRows.length ? name : best;
  }, workbook.SheetNames[0]);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" }) as Array<Record<string, unknown>>;
  return { sheetName, rows };
}

// ── Company match ───────────────────────────────────────────────────────────

// Normalize a company name for fuzzy matching: lowercase, strip punctuation,
// collapse whitespace, and drop common corporate suffixes (Inc/LLC/Corp/Co/etc).
// "Acme Logistics, Inc." → "acme logistics"
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"`’()\/\\&]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|holdings|group|usa|us|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CompanyIndex {
  exact: Map<string, Company>;
  normalized: Map<string, Company>;
}

function buildCompanyIndex(companies: Company[]): CompanyIndex {
  const exact = new Map<string, Company>();
  const normalized = new Map<string, Company>();
  for (const c of companies) {
    if (!c.name) continue;
    exact.set(c.name.trim().toLowerCase(), c);
    const norm = normalizeCompanyName(c.name);
    if (norm && !normalized.has(norm)) normalized.set(norm, c);
  }
  return { exact, normalized };
}

function lookupCompany(idx: CompanyIndex, customerName: string): Company | undefined {
  const exact = idx.exact.get(customerName.trim().toLowerCase());
  if (exact) return exact;
  const norm = normalizeCompanyName(customerName);
  if (!norm) return undefined;
  return idx.normalized.get(norm);
}

function buildUserEmailIndex(users: User[]): Map<string, User> {
  const idx = new Map<string, User>();
  for (const u of users) {
    // `username` is the email address in this app (see auth flow).
    if (u.username) idx.set(u.username.trim().toLowerCase(), u);
  }
  return idx;
}

// ── Main importer ───────────────────────────────────────────────────────────

export async function performAvailableFreightImport(
  orgId: string,
  actorUserId: string | null,
  triggeredBy: "manual" | "scheduled" = "manual",
): Promise<AvailableFreightImportSummary> {
  const settingKey = availableFreightSettingKey(orgId);
  const filePath = await storage.getSetting(settingKey);
  if (!filePath) {
    throw new Error(
      `No OneDrive path configured for available freight. Set the "${settingKey}" setting to the share link or Graph item path of the daily spreadsheet.`,
    );
  }

  let fileName = "";
  try {
    const fetched = await fetchWorkbookFromOneDrive(filePath);
    fileName = fetched.fileName;
    return await runImportFromWorkbook(fetched.workbook, fileName, orgId, actorUserId, triggeredBy);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeImportAudit({
      orgId,
      fileName: fileName || null,
      totalRows: 0,
      inserted: 0,
      updated: 0,
      expired: 0,
      unmatchedCompanies: 0,
      warnings: [],
      actorUserId,
      triggeredBy,
      error: msg.slice(0, 1000),
    });
    throw err;
  }
}

export async function runImportFromWorkbook(
  workbook: XLSX.WorkBook,
  fileName: string,
  orgId: string,
  actorUserId: string | null,
  triggeredBy: "manual" | "scheduled",
): Promise<AvailableFreightImportSummary> {
  const sheetPick = chooseDataSheetWithName(workbook);
  const rawRows = sheetPick.rows;
  const detectedHeaders = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
  const parseDiagnostics: {
    skippedWithCarrier: number;
    historicalRuns: ParsedHistoricalRun[];
    nonAvlRows: ParsedNonAvlRow[];
  } = {
    skippedWithCarrier: 0,
    historicalRuns: [],
    nonAvlRows: [],
  };
  const loads = parseSheetToLoads(rawRows, parseDiagnostics);
  console.log(
    `[available-freight] sheet="${sheetPick.sheetName}" raw_rows=${rawRows.length} ` +
    `parsed_loads=${loads.length} skipped_with_carrier=${parseDiagnostics.skippedWithCarrier} ` +
    `historical_runs=${parseDiagnostics.historicalRuns.length} ` +
    `headers=${JSON.stringify(detectedHeaders)}`,
  );

  const companies = await storage.getCompanies(orgId);
  const companyIdx = buildCompanyIndex(companies);
  const users = await storage.getUsers(orgId);
  const userIdx = buildUserEmailIndex(users);
  const sampleUnmatched: string[] = [];
  const seenUnmatched = new Set<string>();

  // Pull all current available-freight opportunities tagged with this filename
  // so we can detect rows that vanished from the latest spreadsheet.
  const existing = await storage.listFreightOpportunities(orgId, {
    status: ["new", "ready_to_send", "sent", "partially_covered"],
    limit: 2000,
    offset: 0,
  });
  const existingFromThisFeed = existing.filter(
    o => (o.sourceRef as { kind?: string } | null)?.kind === "available_freight_import",
  );
  const byKey = new Map<string, FreightOpportunity>();
  for (const opp of existingFromThisFeed) {
    const key = (opp.sourceRef as { stableKey?: string } | null)?.stableKey;
    if (key) byKey.set(key, opp);
  }

  const seenKeys = new Set<string>();
  const warnings: string[] = [];
  let inserted = 0;
  let updated = 0;
  let unmatchedCompanies = 0;

  // Build a fast lookup of existing opps for soft-dupe (window slip) detection.
  // Key is (companyId|normOrigin|normDest|normEquip) → list of opps. We only
  // include rows from THIS feed so we don't accidentally absorb a manually
  // created freight_opportunity into the import flow.
  const softDupeIdx = new Map<string, FreightOpportunity[]>();
  function softDupeKey(companyId: string, origin: string, destination: string, equipment: string | null): string {
    return [
      companyId,
      origin.trim().toLowerCase(),
      destination.trim().toLowerCase(),
      (equipment ?? "").trim().toLowerCase(),
    ].join("|");
  }
  for (const opp of existingFromThisFeed) {
    const key = softDupeKey(opp.companyId, opp.origin, opp.destination, opp.equipmentType);
    const list = softDupeIdx.get(key) ?? [];
    list.push(opp);
    softDupeIdx.set(key, list);
  }

  // ±2 day window-slip tolerance: yesterday's row with pickup 4/22 should
  // soft-merge into today's row with pickup 4/23 instead of stacking duplicates.
  // Semantics: expand BOTH windows by ±N days then test interval overlap.
  // This correctly handles unequal-span windows where endpoint-distance alone
  // would produce false negatives (e.g. 4/1-4/10 vs 4/12-4/15 with N=2 should
  // merge because expanded windows touch) or false positives (one endpoint
  // close while the other has shifted materially).
  const SOFT_DUPE_TOLERANCE_DAYS = 2;
  function shiftIso(iso: string, days: number): string {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
  }
  function windowsOverlapWithTolerance(aStart: string, aEnd: string, bStart: string, bEnd: string, tolDays: number): boolean {
    const aS = shiftIso(aStart, -tolDays);
    const aE = shiftIso(aEnd, tolDays);
    const bS = shiftIso(bStart, -tolDays);
    const bE = shiftIso(bEnd, tolDays);
    return aS <= bE && bS <= aE;
  }

  // Index helpers — maintain byKey + softDupeIdx as canonical state evolves
  // within this single workbook pass. Without this, a workbook containing the
  // same lane on two rows could insert duplicates because the second row would
  // not see the first row's just-inserted opp.
  function indexUpsert(opp: FreightOpportunity, oldStableKey?: string | null) {
    const newKey = (opp.sourceRef as { stableKey?: string } | null)?.stableKey;
    if (oldStableKey && oldStableKey !== newKey) byKey.delete(oldStableKey);
    if (newKey) byKey.set(newKey, opp);
    // Rebuild this lane's softDupeIdx bucket so window/key updates are visible
    // immediately to subsequent rows.
    const sdKey = softDupeKey(opp.companyId, opp.origin, opp.destination, opp.equipmentType);
    const list = (softDupeIdx.get(sdKey) ?? []).filter(c => c.id !== opp.id);
    list.push(opp);
    softDupeIdx.set(sdKey, list);
  }

  for (const load of loads) {
    // Dedupe within a single workbook: if we've already processed this
    // stableKey in this pass (rare but seen with copy-paste rows), skip.
    if (seenKeys.has(load.stableKey)) continue;
    seenKeys.add(load.stableKey);
    const company = lookupCompany(companyIdx, load.customerName);
    if (!company) {
      unmatchedCompanies++;
      warnings.push(`Unmatched customer in spreadsheet: "${load.customerName}"`);
      const key = load.customerName.trim().toLowerCase();
      if (!seenUnmatched.has(key)) {
        seenUnmatched.add(key);
        if (sampleUnmatched.length < 10) sampleUnmatched.push(load.customerName);
      }
      continue;
    }
    const owner = load.ownerEmail ? userIdx.get(load.ownerEmail) ?? null : null;

    let existingOpp = byKey.get(load.stableKey);
    let softMergedFrom: { previousStableKey: string; previousStart: string; previousEnd: string } | null = null;

    // Soft-dupe detection: if no exact stableKey match, look for an existing
    // open row on the same lane+equipment whose pickup window overlaps or is
    // within ±2 days of the incoming row. If found we treat THAT row as the
    // canonical one and rewrite its window/stableKey instead of inserting a
    // brand-new row. This prevents "window slip" duplicates when a customer
    // pushes a load by a day.
    if (!existingOpp) {
      const candidateKey = softDupeKey(company.id, load.origin, load.destination, load.equipmentType);
      const candidates = softDupeIdx.get(candidateKey) ?? [];
      // Skip candidates whose stableKey we've already consumed in this same run.
      const candidate = candidates.find(c => {
        const k = (c.sourceRef as { stableKey?: string } | null)?.stableKey;
        if (k && seenKeys.has(k) && k !== load.stableKey) return false;
        return windowsOverlapWithTolerance(
          c.pickupWindowStart, c.pickupWindowEnd,
          load.pickupWindowStart, load.pickupWindowEnd,
          SOFT_DUPE_TOLERANCE_DAYS,
        );
      });
      if (candidate) {
        existingOpp = candidate;
        const previousStableKey = (candidate.sourceRef as { stableKey?: string } | null)?.stableKey ?? "";
        softMergedFrom = {
          previousStableKey,
          previousStart: candidate.pickupWindowStart,
          previousEnd: candidate.pickupWindowEnd,
        };
        // Treat the candidate's old key as "seen" so the vanish-pass below
        // doesn't expire it after we just merged into it.
        if (previousStableKey) seenKeys.add(previousStableKey);
      }
    }

    if (existingOpp) {
      // Material fingerprint = fields a manager actually approved against.
      // Pickup window is intentionally EXCLUDED here: it's already part of
      // stableKey (so re-imports of the identical row can't disagree on it),
      // and a soft-merge across a window slip is the same load shifted by a
      // day — outreach + approval should carry forward (per Tier 1 spec).
      // Only true content changes (equipment swap, load count change) reset
      // approval.
      const materialChanges: Record<string, { from: unknown; to: unknown }> = {};
      if ((existingOpp.equipmentType ?? null) !== (load.equipmentType ?? null)) {
        materialChanges.equipmentType = { from: existingOpp.equipmentType, to: load.equipmentType };
      }
      if (existingOpp.loadCount !== load.loadCount) {
        materialChanges.loadCount = { from: existingOpp.loadCount, to: load.loadCount };
      }
      const materialChanged = Object.keys(materialChanges).length > 0;
      // Track window movement separately for audit transparency even though
      // it doesn't reset approval.
      const windowMoved =
        existingOpp.pickupWindowStart !== load.pickupWindowStart ||
        existingOpp.pickupWindowEnd !== load.pickupWindowEnd;

      const previousApprovedAt = existingOpp.approvedAt;
      const previousApprovedBy = existingOpp.approvedById;
      const previousStatus = existingOpp.status;
      // If yesterday's row was already worked (sent / partially_covered) and
      // the same load is back in today's spreadsheet, reopen it for today's
      // queue. `covered` / `expired` are terminal — leave them alone.
      const reopenStatuses = new Set(["sent", "partially_covered"]);
      const shouldReopen = reopenStatuses.has(previousStatus);
      const patch: Partial<FreightOpportunity> = {
        loadCount: load.loadCount,
        pickupWindowStart: load.pickupWindowStart,
        pickupWindowEnd: load.pickupWindowEnd,
        deliveryDate: load.deliveryDate || null,
        equipmentType: load.equipmentType,
        notes: load.notes,
        sourceFileName: fileName,
      };
      // Always rewrite sourceRef so the (possibly new) stableKey + fileName
      // are recorded for tomorrow's vanish-pass. `orderId` is the real TMS
      // Order # (column A). We persist it on every re-import so the
      // load_fact mirror — and the Available Loads board — render the real
      // Order # instead of the synthetic `freight_opp:<uuid>` fallback.
      (patch as Record<string, unknown>).sourceRef = {
        kind: "available_freight_import",
        stableKey: load.stableKey,
        orderId: load.orderId,
        fileName,
        importedAt: new Date().toISOString(),
        ...(softMergedFrom ? { mergedFromStableKey: softMergedFrom.previousStableKey } : {}),
      };
      if (materialChanged) {
        patch.approvedAt = null;
        patch.approvedById = null;
        // Material change resets approval → restart the SLA clock and arm
        // both nudge levels (Task #364).
        patch.awaitingApprovalSince = new Date();
        patch.slaNotifiedL1At = null;
        patch.slaNotifiedL2At = null;
      } else if (shouldReopen && !previousApprovedAt) {
        // Reopening yesterday's worked-but-unapproved row → start the clock
        // (preserve the original since-timestamp if one was already set).
        patch.awaitingApprovalSince = existingOpp.awaitingApprovalSince ?? new Date();
        patch.slaNotifiedL1At = null;
        patch.slaNotifiedL2At = null;
      }
      if (shouldReopen) patch.status = "ready_to_send";
      if (!existingOpp.ownerUserId && owner) patch.ownerUserId = owner.id;
      const oldStableKeyForIndex = (existingOpp.sourceRef as { stableKey?: string } | null)?.stableKey ?? null;
      const updatedOpp = await storage.updateFreightOpportunity(orgId, existingOpp.id, patch);
      if (updatedOpp) indexUpsert(updatedOpp, oldStableKeyForIndex);
      await storage.appendFreightOpportunityAudit({
        opportunityId: existingOpp.id,
        eventType: "generated",
        actorUserId,
        payload: softMergedFrom
          ? {
              kind: "soft_merge_window_slip",
              fileName,
              stableKey: load.stableKey,
              previousStableKey: softMergedFrom.previousStableKey,
              previousWindow: { start: softMergedFrom.previousStart, end: softMergedFrom.previousEnd },
              newWindow: { start: load.pickupWindowStart, end: load.pickupWindowEnd },
            }
          : { kind: "available_freight_reimport", fileName, stableKey: load.stableKey },
      });
      // Soft-merge with no material change → emit a preserved-on-soft-merge
      // audit unconditionally so traceability doesn't depend on whether the
      // row was previously approved. (When there IS prior approval the same
      // event also serves as the "approval carried forward" record.)
      if (softMergedFrom && !materialChanged && !previousApprovedAt) {
        await storage.appendFreightOpportunityAudit({
          opportunityId: existingOpp.id,
          eventType: "approved",
          actorUserId,
          payload: {
            approved: false,
            kind: "approval_preserved_on_soft_merge",
            reason: "window_slip_merge_no_material_change_no_prior_approval",
            previousWindow: { start: softMergedFrom.previousStart, end: softMergedFrom.previousEnd },
            newWindow: { start: load.pickupWindowStart, end: load.pickupWindowEnd },
          },
        });
      }
      if (previousApprovedAt) {
        if (materialChanged) {
          await storage.appendFreightOpportunityAudit({
            opportunityId: existingOpp.id,
            eventType: "approved",
            actorUserId,
            payload: {
              approved: false,
              kind: "approval_reset_on_reimport",
              reason: "material_fields_changed",
              materialChanges,
              previousApprovedAt: previousApprovedAt instanceof Date ? previousApprovedAt.toISOString() : previousApprovedAt,
              previousApprovedById: previousApprovedBy,
            },
          });
        } else {
          // Approval preserved. Use a distinct audit kind for soft-merges so
          // managers can clearly trace "yesterday's approval carried into the
          // window-shifted load" vs a plain idempotent re-import.
          await storage.appendFreightOpportunityAudit({
            opportunityId: existingOpp.id,
            eventType: "approved",
            actorUserId,
            payload: {
              approved: true,
              kind: softMergedFrom ? "approval_preserved_on_soft_merge" : "approval_preserved_on_reimport",
              reason: softMergedFrom
                ? "window_slip_merge_no_material_change"
                : (windowMoved ? "window_within_same_stable_key" : "material_fields_unchanged"),
              ...(softMergedFrom ? { previousWindow: { start: softMergedFrom.previousStart, end: softMergedFrom.previousEnd }, newWindow: { start: load.pickupWindowStart, end: load.pickupWindowEnd } } : {}),
            },
          });
        }
      }
      updated++;
      // Mirror to load_fact so the Carrier Intelligence "Available Loads"
      // tab sees the latest pickup window / status. Mirror from
      // `updatedOpp` (NOT `existingOpp`) so the freshly written
      // sourceRef.orderId — and any other patched fields — flow through to
      // the load_fact mirror in this same import pass; otherwise legacy
      // rows would keep their synthetic `freight_opp:<uuid>` orderId until
      // the next full backfill. If the storage call returned no row
      // (extremely rare) we fall back to a merged view of existingOpp +
      // patch so we still mirror the new orderId. Best-effort: failures
      // are logged but never abort the importer.
      try {
        const mirrorSource = updatedOpp ?? ({ ...existingOpp, ...patch } as FreightOpportunity);
        // Synthetic→real load_fact.orderId rename. If a prior importer run
        // (before sourceRef.orderId was persisted) mirrored this opp under
        // the synthetic `freight_opp:<uuid>` key, rename that row in-place
        // BEFORE the upsert so we don't end up with two parallel load_fact
        // rows for the same load. NOT EXISTS guard makes it a safe no-op
        // when the real-id row already exists or the synthetic row is
        // absent. Same pattern as proactiveOpportunities cover endpoint.
        const realOrderId = (() => {
          const ref = mirrorSource.sourceRef as { orderId?: unknown } | null | undefined;
          const candidate = ref?.orderId;
          if (typeof candidate !== "string") return null;
          const trimmed = candidate.trim();
          if (!trimmed || trimmed.startsWith("freight_opp:")) return null;
          return trimmed;
        })();
        if (realOrderId) {
          const { db } = await import("./storage");
          const { loadFact } = await import("@shared/schema");
          const { and, eq, sql: sqlOp } = await import("drizzle-orm");
          try {
            await db.update(loadFact)
              .set({ orderId: realOrderId, lastChangedAt: new Date() })
              .where(and(
                eq(loadFact.orgId, orgId),
                eq(loadFact.orderId, `freight_opp:${existingOpp.id}`),
                sqlOp`NOT EXISTS (
                  SELECT 1 FROM ${loadFact} lf2
                   WHERE lf2.org_id = ${orgId}
                     AND lf2.order_id = ${realOrderId}
                )`,
              ));
          } catch (renameErr) {
            console.warn(
              `[available-freight] synthetic→real orderId rename failed for opp ${existingOpp.id}: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
            );
          }
        }
        await upsertLoadFact(freightOpportunityToInsert(mirrorSource, company.name ?? null, load.ownerEmail ?? null));
      } catch (e) {
        console.warn(`[available-freight] load_fact mirror (update) failed for opp ${existingOpp.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    const insert: InsertFreightOpportunity = {
      orgId,
      companyId: company.id,
      mode: "exact_load",
      origin: load.origin,
      originState: load.originState,
      destination: load.destination,
      destinationState: load.destinationState,
      equipmentType: load.equipmentType,
      pickupWindowStart: load.pickupWindowStart,
      pickupWindowEnd: load.pickupWindowEnd,
      deliveryDate: load.deliveryDate || null,
      loadCount: load.loadCount,
      sourceRef: {
        kind: "available_freight_import",
        stableKey: load.stableKey,
        // Real TMS Order # from column A — persisted so load_fact mirror
        // and the Available Loads board can render it instead of the
        // synthetic `freight_opp:<uuid>` fallback.
        orderId: load.orderId,
        fileName,
        importedAt: new Date().toISOString(),
      },
      urgencyScore: 60,
      status: "ready_to_send",
      createdById: actorUserId,
      ownerUserId: owner?.id ?? null,
      sourceFileName: fileName,
      notes: load.notes,
      // Task #364 — start the approval SLA clock for newly imported rows.
      awaitingApprovalSince: new Date(),
    };
    const created = await storage.createFreightOpportunity(insert);
    indexUpsert(created);
    await storage.appendFreightOpportunityAudit({
      opportunityId: created.id,
      eventType: "generated",
      actorUserId,
      payload: {
        kind: "available_freight_import",
        fileName,
        stableKey: load.stableKey,
        ownerEmail: load.ownerEmail,
      },
    });
    // Mirror to load_fact so the new row immediately appears in the
    // Carrier Intelligence "Available Loads" tab without waiting for a
    // manual backfill. Best-effort: failures are logged but never abort
    // the importer (we never want a load_fact issue to corrupt the
    // primary freight_opportunities import).
    try {
      await upsertLoadFact(freightOpportunityToInsert(created, company.name ?? null, load.ownerEmail ?? null));
    } catch (e) {
      console.warn(`[available-freight] load_fact mirror (insert) failed for opp ${created.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    inserted++;
  }

  // ── Historical runs (carrier-assigned rows) → load_fact ──────────────────
  // Each carrier-assigned row in the spreadsheet represents a real lane move
  // we (or another broker on the customer's behalf) ran. Persisting them as
  // `realized` load_fact rows lets the carrier ranking service see "Carrier X
  // moved Phoenix→San Diego for this customer last week" and float that
  // carrier to the top of the shortlist on the next available load.
  let historicalImported = 0;
  let historicalUnmatchedCompanies = 0;
  // Pre-resolve companies and collect upsert payloads, separating unmatched
  // rows so we don't pay round-trip cost for them.
  const matchedHistorical: Array<{ h: ParsedHistoricalRun; company: Company }> = [];
  for (const h of parseDiagnostics.historicalRuns) {
    const company = lookupCompany(companyIdx, h.customerName);
    if (!company) {
      historicalUnmatchedCompanies++;
      const key = h.customerName.trim().toLowerCase();
      if (!seenUnmatched.has(key)) {
        seenUnmatched.add(key);
        if (sampleUnmatched.length < 10) sampleUnmatched.push(h.customerName);
      }
      continue;
    }
    matchedHistorical.push({ h, company });
  }
  // Bounded-concurrency upsert: 5 in flight is enough to cut wall time
  // significantly without saturating the connection pool that the rest of
  // the request workload also relies on.
  const HISTORICAL_CONCURRENCY = 5;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= matchedHistorical.length) return;
      const { h, company } = matchedHistorical[i];
      try {
        await upsertLoadFact({
          orgId,
          // Canonical TMS order# — daily re-imports collapse onto same row.
          orderId: `available_freight_history:${h.orderId}`,
          companyId: company.id,
          customerName: company.name,
          carrierName: h.carrierName,
          carrierPayeeCode: null,
          originCity: h.origin,
          originState: h.originState,
          destinationCity: h.destination,
          destinationState: h.destinationState,
          equipmentType: h.equipmentType,
          pickupDate: h.pickupDate || null,
          deliveryDate: h.deliveryDate || null,
          month: h.pickupDate ? h.pickupDate.slice(0, 7) : null,
          moveStatus: mapMoveStatus(h.brokerageStatus),
          bucket: "realized",
          revenue: null,
          // Carrier pay from "Total pay" column (rep needs to see what we
          // previously paid this carrier on this lane). decimal column → string.
          cost: h.carrierCost === null ? null : h.carrierCost.toFixed(2),
          margin: null,
          loadCount: h.loadCount,
          rawRow: h.rawRow as Record<string, unknown>,
          sourceFileName: fileName,
          sourceKind: "available_freight_history",
        });
        historicalImported++;
      } catch (e) {
        console.warn(
          `[available-freight] historical-run upsert failed for ${h.customerName} ${h.origin}→${h.destination} carrier=${h.carrierName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: HISTORICAL_CONCURRENCY }, () => worker()));
  unmatchedCompanies += historicalUnmatchedCompanies;
  console.log(
    `[available-freight] historical_runs imported=${historicalImported} unmatched_companies=${historicalUnmatchedCompanies}`,
  );

  // ── Shortlist backfill ───────────────────────────────────────────────────
  // The importer creates freight_opportunities directly (no
  // generateOpportunitiesForCompany), so newly-imported rows arrive with no
  // freight_opportunity_carriers persisted and the detail view shows an empty
  // Ranked Carriers panel. Run ensureShortlistRanked across every still-open
  // opp from this feed (existing AND new) so reps see a populated shortlist
  // immediately after the next daily import — without having to click into
  // each row first.
  let shortlistsBackfilled = 0;
  let shortlistsAlreadyPresent = 0;
  let shortlistFailures = 0;
  // Re-fetch the full open set so we include rows just inserted in this pass.
  const openOpps = (await storage.listFreightOpportunities(orgId, {
    status: ["new", "ready_to_send"],
    limit: 2000,
    offset: 0,
  })).filter(o => (o.sourceRef as { kind?: string } | null)?.kind === "available_freight_import");
  const SHORTLIST_CONCURRENCY = 4;
  let backfillCursor = 0;
  async function backfillWorker(): Promise<void> {
    while (true) {
      const i = backfillCursor++;
      if (i >= openOpps.length) return;
      const opp = openOpps[i];
      try {
        const r = await ensureShortlistRanked(storage, opp);
        if (r.ranked) shortlistsBackfilled++;
        else shortlistsAlreadyPresent++;
      } catch (e) {
        shortlistFailures++;
        console.warn(
          `[available-freight] shortlist backfill failed for opp ${opp.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: SHORTLIST_CONCURRENCY }, () => backfillWorker()));
  console.log(
    `[available-freight] shortlist_backfill ranked=${shortlistsBackfilled} ` +
    `already_present=${shortlistsAlreadyPresent} failures=${shortlistFailures} ` +
    `total_open=${openOpps.length}`,
  );

  // Mark vanished rows as expired.
  let expired = 0;
  for (const [key, opp] of byKey) {
    if (seenKeys.has(key)) continue;
    if (opp.status === "expired" || opp.status === "cancelled" || opp.status === "covered") continue;
    await storage.updateFreightOpportunity(orgId, opp.id, { status: "expired" });
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "expired",
      actorUserId,
      payload: { kind: "available_freight_vanished", fileName, stableKey: key },
    });
    expired++;
  }

  // AVL → non-AVL transition close. When today's file shows the same Order#
  // with status TRANSIT/POD/DEL/etc, auto-close the prior AVL opportunity as
  // `covered` and stop ranking carriers for it. This is what prevents stale
  // "available" rows from lingering after dispatch covers the load.
  // (Order# becomes the stableKey for AVL rows — see parseSheetToLoads — so a
  // direct byKey lookup is sufficient.)
  let autoCovered = 0;
  for (const nonAvl of parseDiagnostics.nonAvlRows) {
    const key = buildStableKey([nonAvl.orderId]);
    const opp = byKey.get(key);
    if (!opp) continue;
    if (opp.status === "expired" || opp.status === "cancelled" || opp.status === "covered") continue;
    await storage.updateFreightOpportunity(orgId, opp.id, { status: "covered" });
    await storage.appendFreightOpportunityAudit({
      opportunityId: opp.id,
      eventType: "expired",
      actorUserId,
      payload: {
        kind: "available_freight_status_change",
        fileName,
        orderId: nonAvl.orderId,
        newBrokerageStatus: nonAvl.brokerageStatus,
      },
    });
    autoCovered++;
  }
  if (autoCovered > 0) {
    console.log(`[available-freight] auto-covered=${autoCovered} (AVL→non-AVL transitions)`);
  }

  const summary: AvailableFreightImportSummary = {
    fileName,
    totalRows: loads.length,
    inserted,
    updated,
    expired,
    unmatchedCompanies,
    warnings: warnings.slice(0, 50),
    diagnostics: {
      sheetName: sheetPick.sheetName,
      headers: detectedHeaders,
      skippedWithCarrier: parseDiagnostics.skippedWithCarrier,
      sampleUnmatchedCustomers: sampleUnmatched,
      parsedRowCount: rawRows.length,
      historicalRunsImported: historicalImported,
      historicalRunsTotal: parseDiagnostics.historicalRuns.length,
    },
  };

  await storage.setSetting(
    `available_freight_last_import:${orgId}`,
    JSON.stringify({ ...summary, at: new Date().toISOString() }),
  );
  await writeImportAudit({
    orgId,
    fileName,
    totalRows: summary.totalRows,
    inserted,
    updated,
    expired,
    unmatchedCompanies,
    warnings: summary.warnings,
    actorUserId,
    triggeredBy,
  });

  return summary;
}

// ── Legacy orderId recovery (Task #576) ─────────────────────────────────────

/**
 * Per-org in-memory dedupe so a burst of Available Loads requests doesn't
 * stampede the OneDrive fetch. We track the most recent attempt's promise and
 * timestamp; subsequent calls within the cooldown window resolve to the same
 * promise (or short-circuit on success).
 */
const RECOVER_COOLDOWN_MS = 60_000;
const recoverInFlight = new Map<string, Promise<RecoverLegacyOrderIdsResult>>();
const recoverLastAttemptAt = new Map<string, number>();

export interface RecoverLegacyOrderIdsResult {
  attempted: boolean;
  reason?: "no_legacy_rows" | "no_onedrive_configured" | "cooldown" | "ok" | "error";
  fileName?: string;
  oppsScanned?: number;
  oppsUpdated?: number;
  loadFactsRenamed?: number;
  loadFactsCollided?: number;
  errorMessage?: string;
}

/**
 * Recover real TMS Order #s on freight_opportunity rows + their load_fact
 * mirrors that predate the importer persisting orderId on sourceRef
 * (Task #576). Idempotent and degrades gracefully:
 *
 *   • If the org has no legacy rows → no-op (cheap COUNT pre-flight).
 *   • If OneDrive is not configured for the org → no-op (no error).
 *   • If the workbook fetch / parse fails → logged + no-op.
 *
 * Uses a per-org in-memory mutex + cooldown so the lazy trigger from the
 * Available Loads endpoint doesn't stampede the Graph API.
 */
export async function recoverLegacyAvailableLoadOrderIds(
  orgId: string,
): Promise<RecoverLegacyOrderIdsResult> {
  const inflight = recoverInFlight.get(orgId);
  if (inflight) return inflight;
  const lastAt = recoverLastAttemptAt.get(orgId);
  if (lastAt && Date.now() - lastAt < RECOVER_COOLDOWN_MS) {
    return { attempted: false, reason: "cooldown" };
  }

  const promise = (async (): Promise<RecoverLegacyOrderIdsResult> => {
    try {
      const { db } = await import("./storage");
      const { freightOpportunities, loadFact } = await import("@shared/schema");
      const { and, eq, sql } = await import("drizzle-orm");

      // Pass A — opps that ALREADY have a real sourceRef.orderId but whose
      // load_fact mirror is still keyed by the synthetic `freight_opp:<uuid>`.
      // This covers the partial-deploy / racy-importer case where the
      // freight_opp row was patched but the load_fact rename never happened
      // (e.g., importer ran on the old code, then this code shipped).
      // No OneDrive round-trip needed — the real Order # is already stored.
      let strandedRenamed = 0;
      let strandedCollided = 0;
      try {
        const stranded = await db.select().from(freightOpportunities)
          .where(and(
            eq(freightOpportunities.orgId, orgId),
            sql`source_ref->>'kind' = 'available_freight_import'`,
            sql`(source_ref->>'orderId') IS NOT NULL`,
            sql`(source_ref->>'orderId') NOT LIKE 'freight_opp:%'`,
            sql`EXISTS (
              SELECT 1 FROM ${loadFact} lf
               WHERE lf.org_id = ${orgId}
                 AND lf.order_id = 'freight_opp:' || ${freightOpportunities.id}::text
            )`,
          ));
        for (const opp of stranded) {
          const ref = opp.sourceRef as { orderId?: unknown } | null | undefined;
          const realOrderId = typeof ref?.orderId === "string" ? ref.orderId.trim() : "";
          if (!realOrderId || realOrderId.startsWith("freight_opp:")) continue;
          const synthetic = `freight_opp:${opp.id}`;
          try {
            const result = await db.update(loadFact)
              .set({ orderId: realOrderId, lastChangedAt: new Date() })
              .where(and(
                eq(loadFact.orgId, orgId),
                eq(loadFact.orderId, synthetic),
                sql`NOT EXISTS (
                  SELECT 1 FROM ${loadFact} lf2
                   WHERE lf2.org_id = ${orgId}
                     AND lf2.order_id = ${realOrderId}
                )`,
              ))
              .returning({ id: loadFact.id });
            if (result.length > 0) strandedRenamed += result.length;
            else strandedCollided++;
          } catch (e) {
            console.warn(
              `[available-freight-recover] stranded rename failed for opp ${opp.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      } catch (e) {
        console.warn(
          `[available-freight-recover] pass-A query failed for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Pass B — true legacy: opps that came from the Available Freight
      // import but lack sourceRef.orderId. These need the OneDrive workbook
      // to map stableKey → real Order #.
      const legacyOpps = await db.select().from(freightOpportunities)
        .where(and(
          eq(freightOpportunities.orgId, orgId),
          sql`source_ref->>'kind' = 'available_freight_import'`,
          sql`(source_ref->>'orderId') IS NULL`,
        ));
      if (legacyOpps.length === 0) {
        if (strandedRenamed + strandedCollided > 0) {
          console.log(
            `[available-freight-recover] org=${orgId} pass-A only: ` +
            `stranded_renamed=${strandedRenamed} stranded_collided=${strandedCollided}`,
          );
          return {
            attempted: true,
            reason: "ok",
            oppsScanned: 0,
            oppsUpdated: 0,
            loadFactsRenamed: strandedRenamed,
            loadFactsCollided: strandedCollided,
          };
        }
        return { attempted: false, reason: "no_legacy_rows" };
      }

      const filePath = await storage.getSetting(availableFreightSettingKey(orgId));
      if (!filePath) {
        if (strandedRenamed + strandedCollided > 0) {
          return {
            attempted: true,
            reason: "ok",
            oppsScanned: 0,
            oppsUpdated: 0,
            loadFactsRenamed: strandedRenamed,
            loadFactsCollided: strandedCollided,
          };
        }
        return { attempted: false, reason: "no_onedrive_configured" };
      }

      const fetched = await fetchWorkbookFromOneDrive(filePath);
      const sheetPick = chooseDataSheetWithName(fetched.workbook);
      const rawRows = sheetPick.rows;
      const diagnostics: {
        skippedWithCarrier: number;
        historicalRuns: ParsedHistoricalRun[];
        nonAvlRows: ParsedNonAvlRow[];
      } = { skippedWithCarrier: 0, historicalRuns: [], nonAvlRows: [] };
      const loads = parseSheetToLoads(rawRows, diagnostics);

      // stableKey → real Order # map. Both AVL and historical (POD/DEL/etc.)
      // rows are keyed by the same stableKey = sha1([orderId]), so we
      // include both so any opp whose load has since been carried can still
      // be recovered.
      const byStableKey = new Map<string, string>();
      for (const l of loads) byStableKey.set(l.stableKey, l.orderId);
      for (const h of diagnostics.historicalRuns) byStableKey.set(h.rowKey, h.orderId);

      let oppsUpdated = 0;
      let loadFactsRenamed = 0;
      let loadFactsCollided = 0;

      for (const opp of legacyOpps) {
        const ref = (opp.sourceRef as { stableKey?: unknown } | null | undefined) ?? null;
        const stableKey = typeof ref?.stableKey === "string" ? ref.stableKey : null;
        if (!stableKey) continue;
        const realOrderId = byStableKey.get(stableKey);
        if (!realOrderId) continue;

        // 1) Patch the freight_opportunity sourceRef in place. We do a
        // jsonb_set so we don't disturb other keys (importedAt, fileName).
        try {
          await db.update(freightOpportunities)
            .set({
              sourceRef: sql`jsonb_set(coalesce(source_ref, '{}'::jsonb), '{orderId}', to_jsonb(${realOrderId}::text), true)`,
            })
            .where(and(
              eq(freightOpportunities.id, opp.id),
              eq(freightOpportunities.orgId, orgId),
            ));
          oppsUpdated++;
        } catch (e) {
          console.warn(
            `[available-freight-recover] opp ${opp.id} sourceRef patch failed:`,
            e instanceof Error ? e.message : String(e),
          );
          continue;
        }

        // 2) Rename the load_fact mirror's orderId from the synthetic
        // `freight_opp:<uuid>` to the real one — but only when no real-Order
        // row already exists for this org (collision). We do not destructively
        // remove the legacy row on collision; admins can reconcile via the
        // backfill admin route.
        const synthetic = `freight_opp:${opp.id}`;
        try {
          const result = await db.update(loadFact)
            .set({ orderId: realOrderId, lastChangedAt: new Date() })
            .where(and(
              eq(loadFact.orgId, orgId),
              eq(loadFact.orderId, synthetic),
              sql`NOT EXISTS (
                SELECT 1 FROM ${loadFact} lf2
                 WHERE lf2.org_id = ${orgId}
                   AND lf2.order_id = ${realOrderId}
              )`,
            ))
            .returning({ id: loadFact.id });
          if (result.length > 0) {
            loadFactsRenamed += result.length;
          } else {
            // Either the mirror doesn't exist (cover hadn't run, importer
            // hadn't mirrored yet) OR a real-orderId row already exists
            // (collision). Distinguish for diagnostics.
            const synth = await db.select({ id: loadFact.id }).from(loadFact)
              .where(and(
                eq(loadFact.orgId, orgId),
                eq(loadFact.orderId, synthetic),
              ))
              .limit(1);
            if (synth.length > 0) loadFactsCollided++;
          }
        } catch (e) {
          console.warn(
            `[available-freight-recover] load_fact rename failed for opp ${opp.id}:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      console.log(
        `[available-freight-recover] org=${orgId} file="${fetched.fileName}" ` +
        `opps_scanned=${legacyOpps.length} opps_updated=${oppsUpdated} ` +
        `load_fact_renamed=${loadFactsRenamed + strandedRenamed} ` +
        `load_fact_collided=${loadFactsCollided + strandedCollided} ` +
        `(stranded_renamed=${strandedRenamed} stranded_collided=${strandedCollided})`,
      );

      return {
        attempted: true,
        reason: "ok",
        fileName: fetched.fileName,
        oppsScanned: legacyOpps.length,
        oppsUpdated,
        loadFactsRenamed: loadFactsRenamed + strandedRenamed,
        loadFactsCollided: loadFactsCollided + strandedCollided,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[available-freight-recover] org=${orgId} failed:`, msg);
      return { attempted: true, reason: "error", errorMessage: msg };
    } finally {
      recoverLastAttemptAt.set(orgId, Date.now());
      recoverInFlight.delete(orgId);
    }
  })();

  recoverInFlight.set(orgId, promise);
  return promise;
}

/**
 * Scheduler entry point — iterates orgs that have an Available Freight URL
 * configured and runs the importer for each. Errors are caught per-org so a
 * single failure does not block the rest. Designed to be wired to a cron tick.
 */
export async function runScheduledAvailableFreightImports(): Promise<void> {
  // The OneDrive URL setting is org-scoped — only orgs that have explicitly
  // configured their own source key get a scheduled import. This is the
  // tenant-isolation guarantee for the daily import path.
  const allOrgs = await storage.getOrganizations();
  for (const org of allOrgs) {
    const url = await storage.getSetting(availableFreightSettingKey(org.id));
    if (!url) continue;
    try {
      const summary = await performAvailableFreightImport(org.id, null, "scheduled");
      console.log(
        `[available-freight-scheduler] org=${org.id} file=${summary.fileName} ` +
        `inserted=${summary.inserted} updated=${summary.updated} expired=${summary.expired} ` +
        `unmatched=${summary.unmatchedCompanies}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No URL configured is the common case — log quietly.
      if (msg.includes("No OneDrive path configured")) continue;
      console.error(`[available-freight-scheduler] org=${org.id} import failed:`, msg);
    }
  }
}
