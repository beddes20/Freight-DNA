/**
 * Weekly Account Review scheduler. Runs Friday afternoon (default 4pm local
 * server time, configurable via WEEKLY_ACCOUNT_REVIEW_CRON) and generates a
 * one-page Account Review per top-25 customer (by current-month revenue) for
 * every sales rep in every organization.
 *
 * Idempotent per (rep, company, weekOf) — re-running upserts the row.
 */

import cron from "node-cron";
import XLSX from "xlsx";
import { storage } from "./storage";
import { resolveColumns, getSalespersonFromRow } from "./colResolver";
import { isExcludedRow, parseHistoricalRow } from "./financialHelpers";
import { addLibraryItem } from "./agent/libraryIndexer";
import { composeAccountReview, weekOfFor } from "./services/accountReviewComposer";
import type { FinancialUpload } from "@shared/schema";

type FinancialRow = Record<string, unknown>;

function logMessage(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [account-review] ${msg}`);
}

const BATCH_CONCURRENCY = Math.max(1, parseInt(process.env.WEEKLY_ACCOUNT_REVIEW_CONCURRENCY || "4", 10));
const BATCH_RETRIES = Math.max(0, parseInt(process.env.WEEKLY_ACCOUNT_REVIEW_RETRIES || "2", 10));
const BATCH_RETRY_BASE_MS = 500;

function asNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function asString(value: unknown): string {
  return value == null ? "" : String(value);
}
async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run async tasks with bounded concurrency. Preserves submission order in
 * results and never throws — each entry is wrapped to settled form.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }>> {
  const results: Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }> = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { status: "fulfilled", value: await worker(items[idx], idx) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Retry an operation with exponential backoff. */
async function withRetry<T>(label: string, fn: () => Promise<T>, retries = BATCH_RETRIES): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const wait = BATCH_RETRY_BASE_MS * Math.pow(2, attempt);
      logMessage(`retry ${attempt + 1}/${retries} for ${label} after ${wait}ms — ${(err as Error)?.message || err}`);
      await delay(wait);
    }
  }
  throw lastErr;
}

interface RepAccount {
  customerName: string;
  totalRevenue: number;
  totalLoads: number;
}

/**
 * Top-25 customers per rep based on the latest financial upload, ranked by
 * current-month revenue (the same view shown on the rep dashboard).
 */
async function topAccountsByRep(orgId: string): Promise<Map<string, RepAccount[]>> {
  const uploads: FinancialUpload[] = await storage.getFinancialUploadsForOrg(orgId);
  if (!uploads.length) return new Map();
  const latest = uploads[uploads.length - 1];
  const rawRows = latest.rows;
  const rows: FinancialRow[] = Array.isArray(rawRows)
    ? (rawRows as FinancialRow[])
    : [];
  if (!rows.length) return new Map();

  const cols = resolveColumns(rows);
  const now = new Date();
  // YTD window — everything from Jan of current year through current month.
  const ytdMonths = new Set<string>();
  for (let m = 0; m <= now.getMonth(); m++) {
    ytdMonths.add(`${now.getFullYear()}-${String(m + 1).padStart(2, "0")}`);
  }

  const byRep = new Map<string, Map<string, RepAccount>>();
  for (const row of rows) {
    if (isExcludedRow(row, cols)) continue;
    const salesperson = getSalespersonFromRow(row, cols);
    if (!salesperson) continue;
    const totalChargesKey = cols.totalCharges ?? "";
    const revenue = asNumber(
      row[cols.revenue] ?? row["Total revenue"] ?? (totalChargesKey ? row[totalChargesKey] : 0),
    );
    if (!revenue) continue;
    const { monthKey } = parseHistoricalRow(row, cols);
    if (monthKey && !ytdMonths.has(monthKey)) continue;

    const customer = asString(row[cols.customer] ?? "Unknown").trim();
    if (!customer || customer.toLowerCase() === "unknown") continue;
    const rep = salesperson.toLowerCase().trim();
    if (!byRep.has(rep)) byRep.set(rep, new Map());
    const inner = byRep.get(rep)!;
    const key = customer.toLowerCase();
    if (!inner.has(key)) inner.set(key, { customerName: customer, totalRevenue: 0, totalLoads: 0 });
    const entry = inner.get(key)!;
    entry.totalRevenue += revenue;
    entry.totalLoads += 1;
  }

  const out = new Map<string, RepAccount[]>();
  for (const [rep, inner] of byRep.entries()) {
    const list = Array.from(inner.values()).sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 25);
    if (list.length) out.set(rep, list);
  }
  return out;
}

function matchRep(excelName: string, fullName: string): boolean {
  const a = excelName.toLowerCase().trim();
  const b = fullName.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  if (aParts.length === 1 && aParts[0].length > 1) {
    return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
  }
  return aParts.some(p => p.length > 1 && bParts.includes(p));
}

type AccountJobOutcome = "generated" | "skipped" | "failed";

async function processSingleAccount(
  orgId: string,
  rep: { id: string; name: string },
  acct: RepAccount,
  weekOf: string,
  companyIndex: Map<string, { id: string; name: string }>,
): Promise<AccountJobOutcome> {
  const key = acct.customerName.toLowerCase().trim();
  const company = companyIndex.get(key);
  if (!company) return "skipped";
  const label = `${rep.name} / ${company.name}`;

  const composed = await withRetry(`compose ${label}`, () => composeAccountReview({
    organizationId: orgId,
    repUserId: rep.id,
    repName: rep.name,
    companyId: company.id,
    weekOf,
  }));
  if (!composed) return "skipped";

  const libraryItemId = await addLibraryItem({
    organizationId: orgId,
    userId: rep.id,
    kind: "account-review",
    title: `Account Review — ${company.name} (week of ${weekOf})`,
    body: composed.body,
    sourceId: company.id,
    metadata: { companyId: company.id, weekOf, kind: "account-review", repName: rep.name },
  }).catch(() => "");

  await withRetry(`persist ${label}`, () => storage.upsertAccountReview({
    organizationId: orgId,
    repUserId: rep.id,
    companyId: company.id,
    weekOf,
    body: composed.body,
    sections: composed.sections,
    sourceSnapshots: composed.sourceSnapshots,
    libraryItemId: libraryItemId || null,
    generatedBy: "scheduled",
  }));
  return "generated";
}

async function generateForRep(
  orgId: string,
  rep: { id: string; name: string },
  accounts: RepAccount[],
  weekOf: string,
  companyIndex: Map<string, { id: string; name: string }>,
): Promise<{ generated: number; skipped: number; failed: number }> {
  const settled = await runWithConcurrency(accounts, BATCH_CONCURRENCY, async (acct) => {
    try {
      return await processSingleAccount(orgId, rep, acct, weekOf, companyIndex);
    } catch (err) {
      logMessage(`failed for rep ${rep.name} / ${acct.customerName}: ${(err as Error)?.message || err}`);
      return "failed" as AccountJobOutcome;
    }
  });
  let generated = 0, skipped = 0, failed = 0;
  for (const r of settled) {
    if (r.status === "rejected") { failed++; continue; }
    if (r.value === "generated") generated++;
    else if (r.value === "skipped") skipped++;
    else failed++;
  }
  return { generated, skipped, failed };
}

export async function runWeeklyAccountReviews(targetWeekOf?: string): Promise<{ totalGenerated: number; totalSkipped: number; totalFailed: number }> {
  const weekOf = targetWeekOf || weekOfFor(new Date());
  logMessage(`Running weekly account reviews for week of ${weekOf}...`);

  const totals = { totalGenerated: 0, totalSkipped: 0, totalFailed: 0 };
  const orgs = await storage.getOrganizations().catch(() => []);
  for (const org of orgs) {
    const rankings = await topAccountsByRep(org.id);
    if (!rankings.size) { logMessage(`Org ${org.name}: no financial uploads yet, skipping.`); continue; }

    const companies = await storage.getCompanies(org.id);
    const companyIndex = new Map<string, { id: string; name: string }>();
    for (const c of companies) companyIndex.set(c.name.toLowerCase().trim(), { id: c.id, name: c.name });

    const users = await storage.getUsers(org.id);
    const reps = users.filter(u =>
      u.role === "sales" || u.role === "account_manager" || u.role === "national_account_manager",
    );
    for (const rep of reps) {
      // Match Excel salesperson to the user record.
      let matchedKey: string | null = null;
      for (const key of rankings.keys()) {
        if (matchRep(key, rep.name)) { matchedKey = key; break; }
      }
      if (!matchedKey) continue;
      const accounts = rankings.get(matchedKey) || [];
      if (!accounts.length) continue;

      const result = await generateForRep(org.id, { id: rep.id, name: rep.name }, accounts, weekOf, companyIndex);
      totals.totalGenerated += result.generated;
      totals.totalSkipped += result.skipped;
      totals.totalFailed += result.failed;
      logMessage(`Org ${org.name} • Rep ${rep.name}: ${result.generated} generated, ${result.skipped} skipped, ${result.failed} failed.`);
    }
  }

  logMessage(`Weekly account reviews complete — ${totals.totalGenerated} generated, ${totals.totalSkipped} skipped, ${totals.totalFailed} failed.`);
  return totals;
}

/**
 * Generate a single review on demand (used by the "Generate now" button).
 */
export async function generateAccountReviewNow(opts: {
  organizationId: string;
  repUserId: string;
  repName: string;
  companyId: string;
  weekOf?: string;
}) {
  const weekOf = opts.weekOf || weekOfFor(new Date());
  const composed = await composeAccountReview({
    organizationId: opts.organizationId,
    repUserId: opts.repUserId,
    repName: opts.repName,
    companyId: opts.companyId,
    weekOf,
  });
  if (!composed) return null;
  const company = await storage.getCompany(opts.companyId);
  const libraryItemId = await addLibraryItem({
    organizationId: opts.organizationId,
    userId: opts.repUserId,
    kind: "account-review",
    title: `Account Review — ${company?.name ?? "Account"} (week of ${weekOf})`,
    body: composed.body,
    sourceId: opts.companyId,
    metadata: { companyId: opts.companyId, weekOf, kind: "account-review", repName: opts.repName },
  }).catch(() => "");
  return storage.upsertAccountReview({
    organizationId: opts.organizationId,
    repUserId: opts.repUserId,
    companyId: opts.companyId,
    weekOf,
    body: composed.body,
    sections: composed.sections,
    sourceSnapshots: composed.sourceSnapshots,
    libraryItemId: libraryItemId || null,
    generatedBy: "manual",
  });
}

export function initWeeklyAccountReviewScheduler(): void {
  // Default: every Friday at 4:00pm in the org-wide timezone (America/Chicago,
  // overridable via WEEKLY_ACCOUNT_REVIEW_TZ). Cron expression itself can be
  // overridden via WEEKLY_ACCOUNT_REVIEW_CRON.
  const cronExpression = process.env.WEEKLY_ACCOUNT_REVIEW_CRON || "0 16 * * 5";
  const timezone = process.env.WEEKLY_ACCOUNT_REVIEW_TZ || "America/Chicago";
  cron.schedule(cronExpression, () => {
    runWeeklyAccountReviews().catch(err => logMessage(`scheduler error: ${err?.message || err}`));
  }, { timezone });
  logMessage(`Weekly account review scheduler initialized (cron: ${cronExpression}, tz: ${timezone})`);
}

// XLSX import retained because financialHelpers may indirectly require it via shared tooling.
void XLSX;
