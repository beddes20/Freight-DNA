/**
 * Carrier Intelligence service (Task #368).
 *
 * Single read-side over `load_fact`. All downstream code that needs a
 * "what loads has this org touched?" answer should funnel through here so
 * Available-vs-Realized bucketing stays consistent.
 *
 * The bucketing rule is intentionally encoded once, here, derived from the
 * canonical TMS `move_status` column on each load_fact row. Callers never
 * decide buckets themselves and never read `financial_uploads.rows` /
 * `freight_opportunities.status` directly through this service.
 *
 * The service also owns the cutover feature flag — `load_fact_active`. While
 * OFF, this service is callable but downstream consumers should keep reading
 * legacy paths (the parity harness uses both to drift-check). When the flag
 * flips ON for an org, that org becomes load_fact-of-record.
 */

import { and, eq, sql, inArray, lt, isNull } from "drizzle-orm";
import { storage, db } from "./storage";
import { loadFact, loadFactHistory, loadFactImportAudit } from "@shared/schema";
import type { LoadFact, InsertLoadFact } from "@shared/schema";

export const LOAD_FACT_FEATURE_FLAG = "load_fact_active";

export type LoadFactBucket = "available" | "realized" | "cancelled" | "unknown";

/**
 * Map raw TMS Move Status strings to our canonical bucket. The TMS exports
 * use a small handful of statuses but the casing/spelling drifts between
 * customers; normalize aggressively.
 *
 * AVAILABLE  — load is in the queue but not yet a finished, billed move.
 *              (open / pending / quoting / booked / dispatched / in transit)
 * REALIZED   — load has been delivered AND will/did roll into revenue.
 *              (delivered / completed / closed / invoiced / billed / paid)
 * CANCELLED  — load was killed; explicitly excluded from both buckets.
 * UNKNOWN    — status we don't recognize; conservative default of AVAILABLE
 *              for downstream visibility but tagged UNKNOWN so the parity
 *              harness can flag it.
 */
const AVAILABLE_STATUSES = new Set([
  "open", "pending", "quoting", "tendered", "booked",
  "dispatched", "in transit", "intransit", "in-transit",
  "available", "ready", "ready to dispatch", "covered",
  "scheduled",
]);
const REALIZED_STATUSES = new Set([
  "delivered", "completed", "complete", "closed",
  "invoiced", "billed", "paid", "settled",
]);
const CANCELLED_STATUSES = new Set([
  "cancelled", "canceled", "void", "voided", "killed",
  "deleted", "rejected",
]);

export function bucketForMoveStatus(raw: string | null | undefined): LoadFactBucket {
  if (!raw) return "unknown";
  const norm = String(raw).trim().toLowerCase();
  if (!norm) return "unknown";
  if (CANCELLED_STATUSES.has(norm)) return "cancelled";
  if (REALIZED_STATUSES.has(norm)) return "realized";
  if (AVAILABLE_STATUSES.has(norm)) return "available";
  return "unknown";
}

export async function isLoadFactActive(orgId: string): Promise<boolean> {
  return storage.getFeatureFlag(orgId, LOAD_FACT_FEATURE_FLAG);
}

export async function setLoadFactActive(
  orgId: string,
  enabled: boolean,
  updatedById?: string,
): Promise<void> {
  await storage.setFeatureFlag(orgId, LOAD_FACT_FEATURE_FLAG, enabled, updatedById);
}

// ── Read API ───────────────────────────────────────────────────────────────

export interface LoadFactCounts {
  total: number;
  available: number;
  realized: number;
  cancelled: number;
  unknown: number;
}

export async function getLoadFactCounts(orgId: string): Promise<LoadFactCounts> {
  const rows = await db.execute<{ bucket: string; n: string | number }>(sql`
    SELECT bucket, COUNT(*)::int AS n
      FROM load_fact
     WHERE org_id = ${orgId}
     GROUP BY bucket
  `);
  const list = Array.isArray(rows) ? (rows as Array<{ bucket: string; n: number }>) : ((rows as { rows: Array<{ bucket: string; n: number }> }).rows ?? []);
  const out: LoadFactCounts = { total: 0, available: 0, realized: 0, cancelled: 0, unknown: 0 };
  for (const r of list) {
    const n = Number(r.n) || 0;
    out.total += n;
    if (r.bucket === "available") out.available = n;
    else if (r.bucket === "realized") out.realized = n;
    else if (r.bucket === "cancelled") out.cancelled = n;
    else out.unknown += n;
  }
  return out;
}

export interface ListLoadFactOptions {
  bucket?: LoadFactBucket | LoadFactBucket[];
  carrierName?: string;
  companyId?: string;
  month?: string; // YYYY-MM
  pickupAfter?: string; // YYYY-MM-DD
  pickupBefore?: string;
  limit?: number;
  offset?: number;
}

export async function listLoadFacts(orgId: string, opts: ListLoadFactOptions = {}): Promise<LoadFact[]> {
  const limit = Math.min(5000, Math.max(1, opts.limit ?? 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const conds = [eq(loadFact.orgId, orgId)];
  if (opts.bucket) {
    const buckets = Array.isArray(opts.bucket) ? opts.bucket : [opts.bucket];
    conds.push(inArray(loadFact.bucket, buckets));
  }
  if (opts.carrierName) conds.push(eq(loadFact.carrierName, opts.carrierName));
  if (opts.companyId) conds.push(eq(loadFact.companyId, opts.companyId));
  if (opts.month) conds.push(eq(loadFact.month, opts.month));
  if (opts.pickupAfter) conds.push(sql`${loadFact.pickupDate} >= ${opts.pickupAfter}`);
  if (opts.pickupBefore) conds.push(sql`${loadFact.pickupDate} <= ${opts.pickupBefore}`);
  return db.select().from(loadFact)
    .where(and(...conds))
    .orderBy(sql`${loadFact.pickupDate} DESC NULLS LAST`)
    .limit(limit)
    .offset(offset);
}

export async function listAvailableLoads(orgId: string, opts: Omit<ListLoadFactOptions, "bucket"> = {}): Promise<LoadFact[]> {
  return listLoadFacts(orgId, { ...opts, bucket: ["available", "unknown"] });
}

export async function listRealizedLoads(orgId: string, opts: Omit<ListLoadFactOptions, "bucket"> = {}): Promise<LoadFact[]> {
  return listLoadFacts(orgId, { ...opts, bucket: "realized" });
}

/**
 * Lightweight history view per carrier — used by downstream scoring/pricing.
 */
export async function getCarrierLoadHistory(orgId: string, carrierName: string, monthsBack = 24): Promise<LoadFact[]> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;
  return db.select().from(loadFact)
    .where(and(
      eq(loadFact.orgId, orgId),
      eq(loadFact.carrierName, carrierName),
      eq(loadFact.bucket, "realized"),
      sql`${loadFact.month} >= ${cutoffMonth}`,
    ))
    .orderBy(sql`${loadFact.month} DESC`)
    .limit(2000);
}

// ── Write API (used by importer + backfill) ────────────────────────────────

export interface UpsertOutcome {
  inserted: boolean;
  updated: boolean;
  changedFields: string[];
  loadFactId: string;
}

const TRACKED_FIELDS: Array<keyof LoadFact> = [
  "moveStatus", "bucket", "carrierName", "carrierPayeeCode",
  "originCity", "originState", "destinationCity", "destinationState",
  "equipmentType", "pickupDate", "deliveryDate", "month",
  "revenue", "cost", "margin", "loadCount", "companyId", "customerName",
];

function fieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // Decimal columns come back as strings; compare numerically when possible.
  const an = typeof a === "string" ? Number(a) : a;
  const bn = typeof b === "string" ? Number(b) : b;
  if (typeof an === "number" && typeof bn === "number" && !isNaN(an) && !isNaN(bn)) {
    return Math.abs(an - bn) < 1e-9;
  }
  return String(a) === String(b);
}

/**
 * Idempotent upsert keyed by (orgId, orderId). Writes a history row for each
 * tracked field that changed. Safe to call repeatedly with the same payload.
 */
export async function upsertLoadFact(
  payload: InsertLoadFact,
  importBatchId?: string,
): Promise<UpsertOutcome> {
  const existing = await db.select().from(loadFact)
    .where(and(eq(loadFact.orgId, payload.orgId), eq(loadFact.orderId, payload.orderId)))
    .limit(1);

  if (existing.length === 0) {
    const [row] = await db.insert(loadFact).values(payload).returning();
    return { inserted: true, updated: false, changedFields: [], loadFactId: row.id };
  }

  const prev = existing[0];
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const f of TRACKED_FIELDS) {
    const newVal = (payload as Record<string, unknown>)[f as string];
    const oldVal = (prev as Record<string, unknown>)[f as string];
    if (newVal === undefined) continue;
    // Non-destructive merge: a missing-from-feed value (null) must NOT
    // overwrite an existing non-null value. Only accept null→non-null or
    // non-null→non-null transitions. Move-status transitions to cancelled
    // are still respected because bucketForMoveStatus emits a real string,
    // not null.
    if (newVal === null && oldVal !== null && oldVal !== undefined) continue;
    if (!fieldEqual(oldVal, newVal)) {
      changes.push({ field: f as string, from: oldVal, to: newVal });
    }
  }
  if (changes.length === 0) {
    // Touch importedAt + lastSeenAt so the expire-absent sweep knows this
    // order_id was present in this run; skip history because nothing changed.
    const now = new Date();
    await db.update(loadFact)
      .set({ importedAt: now, lastSeenAt: now })
      .where(eq(loadFact.id, prev.id));
    return { inserted: false, updated: false, changedFields: [], loadFactId: prev.id };
  }
  const now = new Date();
  // Only set the fields that actually changed (plus the bookkeeping
  // timestamps). This guarantees we never overwrite a previously-stored
  // non-null value with a null/undefined that came from a sparser feed.
  const setPatch: Record<string, unknown> = {
    importedAt: now,
    lastChangedAt: now,
    lastSeenAt: now,
  };
  for (const c of changes) setPatch[c.field] = c.to;
  await db.update(loadFact)
    .set(setPatch)
    .where(eq(loadFact.id, prev.id));
  if (changes.length > 0) {
    await db.insert(loadFactHistory).values(changes.map(c => ({
      loadFactId: prev.id,
      orgId: payload.orgId,
      fieldName: c.field,
      oldValue: c.from == null ? null : String(c.from),
      newValue: c.to == null ? null : String(c.to),
      importBatchId: importBatchId ?? null,
    })));
  }
  return { inserted: false, updated: true, changedFields: changes.map(c => c.field), loadFactId: prev.id };
}

// ── Lifecycle: expire absent Available rows ────────────────────────────────
//
// When a fresh import runs, every order_id seen has its `last_seen_at`
// touched (see upsertLoadFact). Anything currently in `available` (or
// `unknown`) that wasn't seen since the import started must have been pulled
// from the queue — mark it expired and roll into the `cancelled` bucket so
// dashboards do not double-count dropped freight. `realized` rows are NEVER
// expired this way; once a load is delivered it stays delivered.
export async function expireAbsentAvailableLoads(
  orgId: string,
  importStartedAt: Date,
  importBatchId?: string,
): Promise<number> {
  const expired = await db.update(loadFact)
    .set({ bucket: "cancelled", expiredAt: new Date(), lastChangedAt: new Date() })
    .where(and(
      eq(loadFact.orgId, orgId),
      inArray(loadFact.bucket, ["available", "unknown"]),
      lt(loadFact.lastSeenAt, importStartedAt),
      isNull(loadFact.expiredAt),
    ))
    .returning({ id: loadFact.id, bucket: loadFact.bucket });
  if (expired.length > 0) {
    await db.insert(loadFactHistory).values(expired.map(r => ({
      loadFactId: r.id,
      orgId,
      fieldName: "bucket",
      oldValue: "available",
      newValue: "cancelled:expired",
      importBatchId: importBatchId ?? null,
    })));
  }
  return expired.length;
}

// ── Service-enforced metric API ────────────────────────────────────────────
//
// Downstream pages (carrier dashboards, financial summary, lane tables) MUST
// read these instead of hand-rolling SUM/COUNT queries against load_fact —
// that's how Available-vs-Realized math drifts.
//   - Realized  = bucket='realized'  → executed loads, real revenue/margin.
//   - Active    = bucket='available' AND moveStatus indicates the load is in
//                 motion (booked/dispatched/in transit).
//   - Available = bucket IN ('available','unknown') AND NOT yet active.
//   - Combined  = sum of all three with explicit pipeline placeholders so
//                 callers can show "executed + in-flight + queued" without
//                 conflating them.

export interface LoadFactMetricFilter {
  month?: string;
  monthFrom?: string;
  monthTo?: string;
  carrierName?: string;
  companyId?: string;
  accountManager?: string;
  dispatcher?: string;
}

const ACTIVE_STATUSES = new Set(["booked", "dispatched", "in transit", "intransit", "in-transit", "covered", "scheduled"]);

function applyMetricFilters(orgId: string, f: LoadFactMetricFilter) {
  const conds = [eq(loadFact.orgId, orgId)];
  if (f.month) conds.push(eq(loadFact.month, f.month));
  if (f.monthFrom) conds.push(sql`${loadFact.month} >= ${f.monthFrom}`);
  if (f.monthTo) conds.push(sql`${loadFact.month} <= ${f.monthTo}`);
  if (f.carrierName) conds.push(eq(loadFact.carrierName, f.carrierName));
  if (f.companyId) conds.push(eq(loadFact.companyId, f.companyId));
  if (f.accountManager) conds.push(eq(loadFact.accountManager, f.accountManager));
  if (f.dispatcher) conds.push(eq(loadFact.dispatcher, f.dispatcher));
  return and(...conds);
}

export interface RealizedMetrics {
  executedLoads: number;
  realizedRevenue: number;
  realizedCost: number;
  realizedMargin: number;
  realizedMarginPct: number;
}

export async function getRealizedMetrics(orgId: string, filter: LoadFactMetricFilter = {}): Promise<RealizedMetrics> {
  const where = and(applyMetricFilters(orgId, filter)!, eq(loadFact.bucket, "realized"));
  const rows = await db.select({
    n: sql<string>`COUNT(*)`,
    rev: sql<string>`COALESCE(SUM(revenue), 0)`,
    cost: sql<string>`COALESCE(SUM(cost), 0)`,
    margin: sql<string>`COALESCE(SUM(margin), 0)`,
  }).from(loadFact).where(where);
  const r = rows[0] ?? { n: "0", rev: "0", cost: "0", margin: "0" };
  const executedLoads = Number(r.n) || 0;
  const realizedRevenue = Number(r.rev) || 0;
  const realizedCost = Number(r.cost) || 0;
  const realizedMargin = Number(r.margin) || (realizedRevenue - realizedCost);
  const realizedMarginPct = realizedRevenue > 0 ? (realizedMargin / realizedRevenue) * 100 : 0;
  return {
    executedLoads,
    realizedRevenue: round2(realizedRevenue),
    realizedCost: round2(realizedCost),
    realizedMargin: round2(realizedMargin),
    realizedMarginPct: Math.round(realizedMarginPct * 100) / 100,
  };
}

export interface ActiveMetrics {
  activeLoads: number;
  activeRevenue: number;
  activeCost: number;
  pipelineMarginPlaceholder: number;
}

export async function getActiveMetrics(orgId: string, filter: LoadFactMetricFilter = {}): Promise<ActiveMetrics> {
  const where = and(applyMetricFilters(orgId, filter)!, eq(loadFact.bucket, "available"));
  const rows = await db.select({
    moveStatus: loadFact.moveStatus,
    n: sql<string>`COUNT(*)`,
    rev: sql<string>`COALESCE(SUM(revenue), 0)`,
    cost: sql<string>`COALESCE(SUM(cost), 0)`,
  }).from(loadFact).where(where).groupBy(loadFact.moveStatus);
  let activeLoads = 0;
  let activeRevenue = 0;
  let activeCost = 0;
  for (const r of rows) {
    const ms = (r.moveStatus ?? "").trim().toLowerCase();
    if (!ACTIVE_STATUSES.has(ms)) continue;
    activeLoads += Number(r.n) || 0;
    activeRevenue += Number(r.rev) || 0;
    activeCost += Number(r.cost) || 0;
  }
  // Pipeline margin is not realized — treat as a placeholder until the move
  // closes. Callers should label this clearly so reps don't count it as cash.
  const pipelineMarginPlaceholder = activeRevenue - activeCost;
  return {
    activeLoads,
    activeRevenue: round2(activeRevenue),
    activeCost: round2(activeCost),
    pipelineMarginPlaceholder: round2(pipelineMarginPlaceholder),
  };
}

export interface AvailableMetrics {
  availableLoads: number;
  pipelineRevenue: number;
}

export async function getAvailableMetrics(orgId: string, filter: LoadFactMetricFilter = {}): Promise<AvailableMetrics> {
  const where = and(
    applyMetricFilters(orgId, filter)!,
    inArray(loadFact.bucket, ["available", "unknown"]),
  );
  const rows = await db.select({
    moveStatus: loadFact.moveStatus,
    n: sql<string>`COUNT(*)`,
    rev: sql<string>`COALESCE(SUM(revenue), 0)`,
  }).from(loadFact).where(where).groupBy(loadFact.moveStatus);
  let availableLoads = 0;
  let pipelineRevenue = 0;
  for (const r of rows) {
    const ms = (r.moveStatus ?? "").trim().toLowerCase();
    // "Available" excludes the in-motion subset — those are reported via
    // getActiveMetrics so callers can show queued vs in-flight separately.
    if (ACTIVE_STATUSES.has(ms)) continue;
    availableLoads += Number(r.n) || 0;
    pipelineRevenue += Number(r.rev) || 0;
  }
  return {
    availableLoads,
    pipelineRevenue: round2(pipelineRevenue),
  };
}

export interface CombinedMetrics extends RealizedMetrics, ActiveMetrics, AvailableMetrics {
  totalLoads: number;
}

export async function getCombinedMetrics(orgId: string, filter: LoadFactMetricFilter = {}): Promise<CombinedMetrics> {
  const [realized, active, available] = await Promise.all([
    getRealizedMetrics(orgId, filter),
    getActiveMetrics(orgId, filter),
    getAvailableMetrics(orgId, filter),
  ]);
  return {
    ...realized,
    ...active,
    ...available,
    totalLoads: realized.executedLoads + active.activeLoads + available.availableLoads,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Audit table writes / reads ─────────────────────────────────────────────
//
// The table itself is created/widened by server/runMigrations.ts so the schema
// matches the Drizzle definition. We keep a lightweight runtime ensure as a
// belt-and-braces guard for fresh databases that might run code paths before
// migrations finish (e.g. tests).

let importAuditEnsured = false;
export async function ensureLoadFactImportAuditTable(): Promise<void> {
  if (importAuditEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS load_fact_import_audit (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id varchar NOT NULL,
      file_name text,
      file_hash text,
      replay_token text,
      total_rows integer NOT NULL DEFAULT 0,
      inserted integer NOT NULL DEFAULT 0,
      updated integer NOT NULL DEFAULT 0,
      unchanged integer NOT NULL DEFAULT 0,
      transitioned integer NOT NULL DEFAULT 0,
      expired integer NOT NULL DEFAULT 0,
      skipped integer NOT NULL DEFAULT 0,
      bucket_available integer NOT NULL DEFAULT 0,
      bucket_realized integer NOT NULL DEFAULT 0,
      bucket_cancelled integer NOT NULL DEFAULT 0,
      bucket_unknown integer NOT NULL DEFAULT 0,
      warnings jsonb,
      actor_user_id varchar,
      triggered_by text NOT NULL DEFAULT 'manual',
      kind text NOT NULL DEFAULT 'powerbi',
      error text,
      duration_ms integer,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  importAuditEnsured = true;
}

export interface LoadFactImportAuditRow {
  id: string;
  fileName: string | null;
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
  actorUserId: string | null;
  triggeredBy: string;
  kind: string;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export async function writeLoadFactImportAudit(row: {
  orgId: string;
  fileName: string | null;
  fileHash?: string | null;
  replayToken?: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  transitioned?: number;
  expired?: number;
  skipped?: number;
  buckets: { available: number; realized: number; cancelled: number; unknown: number };
  warnings: string[];
  actorUserId: string | null;
  triggeredBy: "manual" | "scheduled" | "backfill";
  kind: "powerbi" | "backfill_financial_uploads" | "backfill_freight_opportunities";
  error?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  await ensureLoadFactImportAuditTable();
  await db.insert(loadFactImportAudit).values({
    orgId: row.orgId,
    fileName: row.fileName,
    fileHash: row.fileHash ?? null,
    replayToken: row.replayToken ?? null,
    totalRows: row.totalRows,
    inserted: row.inserted,
    updated: row.updated,
    unchanged: row.unchanged,
    transitioned: row.transitioned ?? 0,
    expired: row.expired ?? 0,
    skipped: row.skipped ?? 0,
    bucketAvailable: row.buckets.available,
    bucketRealized: row.buckets.realized,
    bucketCancelled: row.buckets.cancelled,
    bucketUnknown: row.buckets.unknown,
    warnings: row.warnings as unknown as object,
    actorUserId: row.actorUserId,
    triggeredBy: row.triggeredBy,
    kind: row.kind,
    error: row.error ?? null,
    durationMs: row.durationMs ?? null,
  });
}

export async function listLoadFactImports(
  orgId: string,
  limit = 100,
  windowDays = 30,
): Promise<LoadFactImportAuditRow[]> {
  await ensureLoadFactImportAuditTable();
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs);
  const rows = await db.select().from(loadFactImportAudit)
    .where(and(
      eq(loadFactImportAudit.orgId, orgId),
      sql`${loadFactImportAudit.createdAt} >= ${since}`,
    ))
    .orderBy(sql`${loadFactImportAudit.createdAt} DESC`)
    .limit(limit);
  return rows.map(r => ({
    id: r.id,
    fileName: r.fileName,
    fileHash: r.fileHash,
    replayToken: r.replayToken,
    totalRows: r.totalRows,
    inserted: r.inserted,
    updated: r.updated,
    unchanged: r.unchanged,
    transitioned: r.transitioned,
    expired: r.expired,
    skipped: r.skipped,
    buckets: {
      available: r.bucketAvailable,
      realized: r.bucketRealized,
      cancelled: r.bucketCancelled,
      unknown: r.bucketUnknown,
    },
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    actorUserId: r.actorUserId,
    triggeredBy: r.triggeredBy,
    kind: r.kind,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

/**
 * Has this exact source already been applied (deterministic re-apply guard)?
 * Used by the importer to short-circuit when the same file hash has been
 * imported successfully — preserves audit-row-per-attempt without re-writing
 * load_fact.
 */
export async function findRecentSuccessfulAuditByReplayToken(
  orgId: string,
  replayToken: string,
): Promise<LoadFactImportAuditRow | null> {
  await ensureLoadFactImportAuditTable();
  const rows = await db.select().from(loadFactImportAudit)
    .where(and(
      eq(loadFactImportAudit.orgId, orgId),
      eq(loadFactImportAudit.replayToken, replayToken),
      isNull(loadFactImportAudit.error),
    ))
    .orderBy(sql`${loadFactImportAudit.createdAt} DESC`)
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    fileName: r.fileName,
    fileHash: r.fileHash,
    replayToken: r.replayToken,
    totalRows: r.totalRows,
    inserted: r.inserted,
    updated: r.updated,
    unchanged: r.unchanged,
    transitioned: r.transitioned,
    expired: r.expired,
    skipped: r.skipped,
    buckets: {
      available: r.bucketAvailable,
      realized: r.bucketRealized,
      cancelled: r.bucketCancelled,
      unknown: r.bucketUnknown,
    },
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    actorUserId: r.actorUserId,
    triggeredBy: r.triggeredBy,
    kind: r.kind,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

// ── Setting keys ───────────────────────────────────────────────────────────

export function loadFactPowerBiUrlKey(orgId: string): string {
  return `load_fact_powerbi_url:${orgId}`;
}
export function loadFactScheduleKey(orgId: string): string {
  return `load_fact_schedule:${orgId}`;
}
export function loadFactLastImportKey(orgId: string): string {
  return `load_fact_last_import:${orgId}`;
}

// Per-slot scheduler control. The scheduler ticks at 5:30 AM and 1:30 PM CT
// on weekdays, but admins can disable either slot or change the cadence
// (every weekday by default; can be set to "weekdays" or "daily").
export interface LoadFactScheduleConfig {
  morningEnabled: boolean;   // 5:30 AM CT slot
  afternoonEnabled: boolean; // 1:30 PM CT slot
  cadence: "weekdays" | "daily" | "off";
  /** ISO datetime. If set and in the future, both slots are paused. */
  pauseUntil: string | null;
}

function normalizeCadence(v: unknown): "weekdays" | "daily" | "off" {
  return v === "daily" || v === "off" ? v : "weekdays";
}

export async function getLoadFactScheduleConfig(orgId: string): Promise<LoadFactScheduleConfig> {
  const raw = await storage.getSetting(loadFactScheduleKey(orgId));
  if (!raw) {
    return { morningEnabled: true, afternoonEnabled: true, cadence: "weekdays", pauseUntil: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LoadFactScheduleConfig>;
    return {
      morningEnabled: parsed.morningEnabled !== false,
      afternoonEnabled: parsed.afternoonEnabled !== false,
      cadence: normalizeCadence(parsed.cadence),
      pauseUntil: typeof parsed.pauseUntil === "string" && parsed.pauseUntil.length > 0
        ? parsed.pauseUntil : null,
    };
  } catch {
    return { morningEnabled: true, afternoonEnabled: true, cadence: "weekdays", pauseUntil: null };
  }
}

export async function setLoadFactScheduleConfig(
  orgId: string,
  cfg: Partial<LoadFactScheduleConfig>,
): Promise<LoadFactScheduleConfig> {
  // Merge partial input with the persisted config so callers can update only
  // the fields they care about (e.g. UI sends per-slot toggles, scheduler
  // sets pauseUntil) without clobbering the others.
  const current = await getLoadFactScheduleConfig(orgId);
  const next: LoadFactScheduleConfig = {
    morningEnabled: cfg.morningEnabled ?? current.morningEnabled,
    afternoonEnabled: cfg.afternoonEnabled ?? current.afternoonEnabled,
    cadence: cfg.cadence ? normalizeCadence(cfg.cadence) : current.cadence,
    pauseUntil: cfg.pauseUntil === undefined ? current.pauseUntil : (cfg.pauseUntil ?? null),
  };
  await storage.setSetting(loadFactScheduleKey(orgId), JSON.stringify(next));
  return next;
}

/** Should this slot fire for this org right now (DOW + per-slot enable + pauseUntil)? */
export function isSlotActive(cfg: LoadFactScheduleConfig, slot: "morning" | "afternoon", now = new Date()): boolean {
  if (cfg.cadence === "off") return false;
  if (cfg.pauseUntil) {
    const until = new Date(cfg.pauseUntil).getTime();
    if (!isNaN(until) && until > now.getTime()) return false;
  }
  const enabled = slot === "morning" ? cfg.morningEnabled : cfg.afternoonEnabled;
  if (!enabled) return false;
  if (cfg.cadence === "weekdays") {
    const dow = now.getUTCDay();
    if (dow === 0 || dow === 6) return false;
  }
  return true;
}
