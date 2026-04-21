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
  loadCount: number;
  notes: string | null;
  ownerEmail: string | null;
  stableKey: string;
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

function parseSheetToLoads(rows: Array<Record<string, unknown>>): ParsedLoad[] {
  const out: ParsedLoad[] = [];
  for (const row of rows) {
    const customerName = pick(row, "Customer", "Customer Name", "Shipper", "Account");
    const originRaw = pick(row, "Origin", "Pickup", "Pickup City", "From", "Origin City");
    const destinationRaw = pick(row, "Destination", "Drop", "Delivery City", "To", "Dest", "Destination City");
    if (!customerName || !originRaw || !destinationRaw) continue;

    const originStateOnly = pick(row, "Origin State", "Pickup State");
    const destStateOnly = pick(row, "Destination State", "Delivery State", "Dest State");

    const o = splitCityState(originRaw);
    const d = splitCityState(destinationRaw);

    const pickupStartRaw = pick(row, "Pickup Date", "Pickup Start", "Pickup", "Start Date", "Date");
    const pickupEndRaw = pick(row, "Pickup End", "End Date", "Delivery Date", "Drop Date");
    const start = parseDateLoose(pickupStartRaw) ?? new Date().toISOString().slice(0, 10);
    const end = parseDateLoose(pickupEndRaw) ?? start;

    const equipment = pick(row, "Equipment", "Equipment Type", "Trailer", "Trailer Type") || null;
    const ownerEmail = pick(row, "Owner", "Rep", "Rep Email", "Owner Email", "Assigned To") || null;
    const loadCountRaw = pick(row, "Loads", "Load Count", "Qty", "Quantity");
    const loadCount = Math.max(1, parseInt(loadCountRaw, 10) || 1);
    const notes = pick(row, "Notes", "Comments", "Remarks") || null;

    const stableKey = buildStableKey([
      customerName,
      o.city, o.state || originStateOnly || null,
      d.city, d.state || destStateOnly || null,
      equipment,
      start,
      end,
    ]);

    out.push({
      customerName,
      origin: o.city,
      originState: o.state || originStateOnly || null,
      destination: d.city,
      destinationState: d.state || destStateOnly || null,
      equipmentType: equipment,
      pickupWindowStart: start,
      pickupWindowEnd: end,
      loadCount,
      notes,
      ownerEmail: ownerEmail ? ownerEmail.toLowerCase() : null,
      stableKey,
      rawRow: row,
    });
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

  const response = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
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
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" }) as Array<Record<string, unknown>>;
}

// ── Company match ───────────────────────────────────────────────────────────

function buildCompanyIndex(companies: Company[]): Map<string, Company> {
  const idx = new Map<string, Company>();
  for (const c of companies) {
    if (!c.name) continue;
    idx.set(c.name.trim().toLowerCase(), c);
  }
  return idx;
}

function buildUserEmailIndex(users: User[]): Map<string, User> {
  const idx = new Map<string, User>();
  for (const u of users) {
    if (u.username) idx.set(u.username.trim().toLowerCase(), u);
    if (u.email) idx.set(u.email.trim().toLowerCase(), u);
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

async function runImportFromWorkbook(
  workbook: XLSX.WorkBook,
  fileName: string,
  orgId: string,
  actorUserId: string | null,
  triggeredBy: "manual" | "scheduled",
): Promise<AvailableFreightImportSummary> {
  const rawRows = chooseDataSheet(workbook);
  const loads = parseSheetToLoads(rawRows);

  const companies = await storage.getCompanies(orgId);
  const companyIdx = buildCompanyIndex(companies);
  const users = await storage.getUsers(orgId);
  const userIdx = buildUserEmailIndex(users);

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
    const company = companyIdx.get(load.customerName.trim().toLowerCase());
    if (!company) {
      unmatchedCompanies++;
      warnings.push(`Unmatched customer in spreadsheet: "${load.customerName}"`);
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
      // Material fingerprint = the fields a manager actually approved against.
      // If none of these changed, preserve the prior approval so reps don't
      // wait for re-approval every morning on identical loads. If any changed
      // (window slip, equipment swap, load count change) we clear approval and
      // record exactly what changed in the audit trail.
      const materialChanges: Record<string, { from: unknown; to: unknown }> = {};
      if (existingOpp.pickupWindowStart !== load.pickupWindowStart) {
        materialChanges.pickupWindowStart = { from: existingOpp.pickupWindowStart, to: load.pickupWindowStart };
      }
      if (existingOpp.pickupWindowEnd !== load.pickupWindowEnd) {
        materialChanges.pickupWindowEnd = { from: existingOpp.pickupWindowEnd, to: load.pickupWindowEnd };
      }
      if ((existingOpp.equipmentType ?? null) !== (load.equipmentType ?? null)) {
        materialChanges.equipmentType = { from: existingOpp.equipmentType, to: load.equipmentType };
      }
      if (existingOpp.loadCount !== load.loadCount) {
        materialChanges.loadCount = { from: existingOpp.loadCount, to: load.loadCount };
      }
      const materialChanged = Object.keys(materialChanges).length > 0 || !!softMergedFrom;

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
        equipmentType: load.equipmentType,
        notes: load.notes,
        sourceFileName: fileName,
      };
      // Always rewrite sourceRef so the (possibly new) stableKey + fileName
      // are recorded for tomorrow's vanish-pass.
      (patch as Record<string, unknown>).sourceRef = {
        kind: "available_freight_import",
        stableKey: load.stableKey,
        fileName,
        importedAt: new Date().toISOString(),
        ...(softMergedFrom ? { mergedFromStableKey: softMergedFrom.previousStableKey } : {}),
      };
      if (materialChanged) {
        patch.approvedAt = null;
        patch.approvedById = null;
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
      if (previousApprovedAt) {
        if (materialChanged) {
          await storage.appendFreightOpportunityAudit({
            opportunityId: existingOpp.id,
            eventType: "approved",
            actorUserId,
            payload: {
              approved: false,
              kind: "approval_reset_on_reimport",
              reason: softMergedFrom ? "window_slip_merge" : "material_fields_changed",
              materialChanges,
              previousApprovedAt: previousApprovedAt instanceof Date ? previousApprovedAt.toISOString() : previousApprovedAt,
              previousApprovedById: previousApprovedBy,
            },
          });
        } else {
          await storage.appendFreightOpportunityAudit({
            opportunityId: existingOpp.id,
            eventType: "approved",
            actorUserId,
            payload: {
              approved: true,
              kind: "approval_preserved_on_reimport",
              reason: "material_fields_unchanged",
            },
          });
        }
      }
      updated++;
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
      loadCount: load.loadCount,
      sourceRef: {
        kind: "available_freight_import",
        stableKey: load.stableKey,
        fileName,
        importedAt: new Date().toISOString(),
      },
      urgencyScore: 60,
      status: "ready_to_send",
      createdById: actorUserId,
      ownerUserId: owner?.id ?? null,
      sourceFileName: fileName,
      notes: load.notes,
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
    inserted++;
  }

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

  const summary: AvailableFreightImportSummary = {
    fileName,
    totalRows: loads.length,
    inserted,
    updated,
    expired,
    unmatchedCompanies,
    warnings: warnings.slice(0, 50),
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
