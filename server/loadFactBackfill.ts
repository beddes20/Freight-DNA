/**
 * load_fact backfill (Task #368).
 *
 * Walks legacy `financial_uploads.rows` (TMS history) and
 * `freight_opportunities` (Available Freight import) and merges every distinct
 * row into `load_fact`. Idempotent: order_id collisions go through the same
 * upsert path as the live importer, producing history rows on diff and
 * skipping unchanged rows.
 *
 * Run once per org from the admin settings page before flipping the cutover
 * flag. Safe to re-run.
 */

import { storage } from "./storage";
import {
  upsertLoadFact,
  bucketForMoveStatus,
  writeLoadFactImportAudit,
} from "./carrierIntelligenceService";
import { parseTmsRowToLoadFact } from "./loadFactPowerBIImporter";
import {
  readTmsField,
  parseCarrierName,
  parsePayeeCode,
  normalizeTmsMonth,
  extractCity,
} from "./carrierRankingService";
import type { Company, FreightOpportunity, InsertLoadFact } from "@shared/schema";
import crypto from "crypto";

export interface BackfillSummary {
  source: "financial_uploads" | "freight_opportunities" | "all";
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  durationMs: number;
}

function buildCompanyIndex(companies: Company[]): Map<string, Company> {
  const idx = new Map<string, Company>();
  for (const c of companies) {
    if (c.name) idx.set(c.name.trim().toLowerCase(), c);
  }
  return idx;
}

// ── Financial uploads (real TMS history) ───────────────────────────────────

export async function backfillFromFinancialUploads(orgId: string, actorUserId: string | null): Promise<BackfillSummary> {
  const startedAt = Date.now();
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const companies = await storage.getCompanies(orgId);
  const companyIdx = buildCompanyIndex(companies);
  const importBatchId = crypto.randomBytes(8).toString("hex");

  // Newest-wins precedence: process uploads in DESCENDING upload order so that
  // when the same order_id appears in multiple monthly files (real TMS
  // exports overlap for trailing months), the most recent snapshot is the
  // one that lands in load_fact. Older snapshots are skipped.
  const orderedUploads = [...uploads].sort((a, b) => {
    const aT = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const bT = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return (isNaN(bT) ? 0 : bT) - (isNaN(aT) ? 0 : aT);
  });

  let scanned = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const buckets = { available: 0, realized: 0, cancelled: 0, unknown: 0 };
  const seen = new Set<string>();

  for (const upload of orderedUploads) {
    const rows = Array.isArray(upload.rows) ? (upload.rows as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      scanned++;
      const parsed = parseTmsRowToLoadFact(orgId, row, upload.fileName ?? "financial_upload", "financial_upload_backfill");
      if (!parsed) { skipped++; continue; }
      // Newest-wins: first occurrence in descending upload order is the
      // newest snapshot for this order_id; later (older) occurrences are
      // skipped so they cannot overwrite fresher data.
      if (seen.has(parsed.payload.orderId)) { skipped++; continue; }
      seen.add(parsed.payload.orderId);
      if (parsed.customerName) {
        const company = companyIdx.get(parsed.customerName.trim().toLowerCase());
        if (company) parsed.payload.companyId = company.id;
      }
      buckets[parsed.bucket]++;
      try {
        const out = await upsertLoadFact(parsed.payload, importBatchId);
        if (out.inserted) inserted++;
        else if (out.updated) updated++;
        else unchanged++;
      } catch {
        skipped++;
      }
    }
  }

  const summary: BackfillSummary = {
    source: "financial_uploads",
    scanned,
    inserted,
    updated,
    unchanged,
    skipped,
    durationMs: Date.now() - startedAt,
  };
  await writeLoadFactImportAudit({
    orgId,
    fileName: "(backfill: financial_uploads)",
    totalRows: scanned,
    inserted,
    updated,
    unchanged,
    buckets,
    warnings: skipped > 0 ? [`${skipped} rows skipped (dedupe or parse)`] : [],
    actorUserId,
    triggeredBy: "backfill",
    kind: "backfill_financial_uploads",
    durationMs: summary.durationMs,
  });
  return summary;
}

// ── Freight opportunities (Available Freight imports) ──────────────────────

export function freightOpportunityToInsert(
  opp: FreightOpportunity,
  companyName: string | null,
  accountManager: string | null = null,
): InsertLoadFact {
  // Each freight_opportunity is a not-yet-realized load. We preserve it as
  // an "available" load_fact with a synthetic order_id derived from its UUID
  // (deterministic across runs).
  const orderId = `freight_opp:${opp.id}`;
  return {
    orgId: opp.orgId,
    orderId,
    companyId: opp.companyId,
    customerName: companyName,
    carrierName: null,
    carrierPayeeCode: null,
    originCity: extractCity(opp.origin),
    originState: opp.originState ?? null,
    destinationCity: extractCity(opp.destination),
    destinationState: opp.destinationState ?? null,
    accountManager,
    equipmentType: opp.equipmentType ?? null,
    pickupDate: opp.pickupWindowStart,
    deliveryDate: opp.pickupWindowEnd,
    month: opp.pickupWindowStart ? opp.pickupWindowStart.slice(0, 7) : null,
    moveStatus: opp.status, // freight_opportunities.status acts as the canonical state here
    // Canonical bucketing: only Move Status from the TMS extract can promote
    // a row to "realized" (delivered/billed). A freight opportunity in
    // "covered" state means a carrier has been booked but the load has not
    // yet delivered → treat as still in pipeline ("available") rather than
    // contaminating realized KPIs. Expired/canceled opps map to cancelled.
    bucket: (opp.status === "expired" || opp.status === "canceled") ? "cancelled" : "available",
    revenue: null,
    cost: null,
    margin: null,
    loadCount: opp.loadCount ?? 1,
    rawRow: opp as unknown as Record<string, unknown>,
    sourceFileName: opp.sourceFileName ?? null,
    sourceKind: "freight_opp_backfill",
  };
}

export async function backfillFromFreightOpportunities(orgId: string, actorUserId: string | null): Promise<BackfillSummary> {
  const startedAt = Date.now();
  const importBatchId = crypto.randomBytes(8).toString("hex");
  const companies = await storage.getCompanies(orgId);
  const companyById = new Map(companies.map(c => [c.id, c]));

  let scanned = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const buckets = { available: 0, realized: 0, cancelled: 0, unknown: 0 };

  // Page through opportunities in chunks to avoid loading the entire table at once.
  const PAGE = 500;
  let offset = 0;
  while (true) {
    const page = await storage.listFreightOpportunities(orgId, {
      status: ["new", "ready_to_send", "sent", "partially_covered", "covered", "expired", "canceled"],
      limit: PAGE,
      offset,
    });
    if (page.length === 0) break;
    for (const opp of page) {
      scanned++;
      const company = companyById.get(opp.companyId);
      // Recover the original Ops user (col Z) from the importer audit so
      // load_fact.account_manager parity matches the live importer path.
      let opsUser: string | null = null;
      try {
        const auditRows = await storage.listFreightOpportunityAudit(opp.id);
        for (const a of auditRows) {
          if (a.eventType === "generated" && a.payload && typeof (a.payload as any).ownerEmail === "string") {
            opsUser = (a.payload as any).ownerEmail;
            break;
          }
        }
      } catch {
        // best-effort: account_manager remains null if audit lookup fails.
      }
      const payload = freightOpportunityToInsert(opp, company?.name ?? null, opsUser);
      buckets[payload.bucket as keyof typeof buckets]++;
      try {
        const out = await upsertLoadFact(payload, importBatchId);
        if (out.inserted) inserted++;
        else if (out.updated) updated++;
        else unchanged++;
      } catch {
        skipped++;
      }
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  const summary: BackfillSummary = {
    source: "freight_opportunities",
    scanned,
    inserted,
    updated,
    unchanged,
    skipped,
    durationMs: Date.now() - startedAt,
  };
  await writeLoadFactImportAudit({
    orgId,
    fileName: "(backfill: freight_opportunities)",
    totalRows: scanned,
    inserted,
    updated,
    unchanged,
    buckets,
    warnings: skipped > 0 ? [`${skipped} rows skipped`] : [],
    actorUserId,
    triggeredBy: "backfill",
    kind: "backfill_freight_opportunities",
    durationMs: summary.durationMs,
  });
  return summary;
}

export async function backfillAll(orgId: string, actorUserId: string | null): Promise<{ financial: BackfillSummary; freightOpps: BackfillSummary }> {
  const financial = await backfillFromFinancialUploads(orgId, actorUserId);
  const freightOpps = await backfillFromFreightOpportunities(orgId, actorUserId);
  return { financial, freightOpps };
}
