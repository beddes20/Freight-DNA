/**
 * Task #1121 — Company Detail header trust audit (READ-ONLY).
 *
 * Sizes the production blast-radius of five header-trust failure modes on
 * `/companies/:id` so a follow-up Phase A (UI) / Phase B (resolver) plan can
 * be triaged off real numbers instead of vibes:
 *
 *   1. Null / stale growth scores (header chip silently lies)
 *   2. Financial fuzzy-match misses / low-confidence binds (YTD load+margin
 *      attribution drifts)
 *   3. NBA recommendations stuck on the R13 "no action" fallback
 *   4. Email-derived stub companies (`is_email_derived = true`)
 *   5. Owner-conflict summary (joins #1118's CSV — does NOT re-query)
 *
 * Inventory pass — what was reused vs. reimplemented:
 *   • Financial fuzzy-match logic in Category 2 is a verbatim port of the
 *     `matchedPerf` block in `client/src/pages/company-detail.tsx:266-314`
 *     so the audit measures what reps actually see. Ported here as a pure
 *     SQL+JS function, not imported, because the original is a React hook
 *     bound to component state.
 *   • R13 NBA fallback identifier confirmed in `server/routes.ts:4938` and
 *     `server/nextBestActionEngine.ts:562`. Category 3 calls
 *     `computeNextBestAction` directly per company (the same entry point
 *     `GET /api/companies/:id/next-best-action` routes through) and flags
 *     rows where `ruleId === 'R13'`. The persistent `nba_cards` table is
 *     intentionally NOT consulted — it stores Phase-1 batch-engine cards
 *     (different code path) and absence-of-card does not imply the
 *     header-chip fallback.
 *   • `account_growth_scores` schema confirmed at `shared/schema.ts:1142`.
 *     `calculated_at` is `text`, cast to `timestamptz` for age math.
 *   • `freight_daily_upload_fact` columns used: `customer`, `total_revenue`,
 *     `margin_pct`, `moved`, `ship_date`, `ingested_at` — confirmed at
 *     `shared/schema.ts:8103`.
 *   • Owner conflicts deferred to #1118's CSV at
 *     `docs/audits/exports/customers-owner-mismatch-*.csv`.
 *
 * Universe — "active non-archived companies" (`archived_at IS NULL`).
 * Detail-page view telemetry was not available; the report header calls
 * this assumption out explicitly.
 *
 * SAFETY:
 *   • Refuses to run unless `process.env.AUDIT_READ_ONLY !== "false"`.
 *   • No `db.update`, `db.insert`, `db.delete`, no `INSERT/UPDATE/DELETE`
 *     SQL outside string literals used for documentation.
 *   • Idempotent: outputs are dated (`YYYYMMDD`) and overwrite cleanly.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { storage } from "../../server/storage";
import { computeNextBestAction } from "../../server/nextBestActionEngine";

if (process.env.AUDIT_READ_ONLY === "false") {
  console.error("[audit] AUDIT_READ_ONLY=false detected — refusing to run a read-only audit with the safety disabled.");
  process.exit(1);
}

const TMP_DIR = "/tmp/audits";
const DOCS_DIR = join(process.cwd(), "docs", "audits");
const EXPORTS_DIR = join(DOCS_DIR, "exports");
for (const d of [TMP_DIR, DOCS_DIR, EXPORTS_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const today = new Date();
const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const head = headers.join(",");
  const body = rows.map(r => headers.map(h => csvCell(r[h])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}
function writeBoth(filename: string, content: string): string {
  const tmpPath = join(TMP_DIR, filename);
  const exportPath = join(EXPORTS_DIR, filename);
  writeFileSync(tmpPath, content, "utf8");
  writeFileSync(exportPath, content, "utf8");
  return exportPath;
}

// Verbatim port of client/src/pages/company-detail.tsx:269-284 — keep the
// normalisation + nameMatches semantics identical so the audit measures
// what reps actually see. Do NOT "improve" without updating the page first.
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
function nameMatches(crmToTest: string, excelNorm: string): boolean {
  if (excelNorm === crmToTest) return true;
  const shorter = crmToTest.length <= excelNorm.length ? crmToTest : excelNorm;
  const longer  = crmToTest.length <= excelNorm.length ? excelNorm : crmToTest;
  return shorter.length >= 5 && longer.includes(shorter);
}

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  archived_at: string | null;
  is_email_derived: boolean;
  financial_alias: string | null;
  owner_rep_id: string | null;
  assigned_to: string | null;
  email_derived_at: string | null;
  email_derived_seed_message_id: string | null;
}

async function loadActiveCompanies(): Promise<CompanyRow[]> {
  const { rows } = await storage.pool.query<CompanyRow>(
    `SELECT id, organization_id, name, archived_at, is_email_derived,
            financial_alias, owner_rep_id, assigned_to,
            email_derived_at, email_derived_seed_message_id
       FROM companies
      WHERE archived_at IS NULL`
  );
  return rows;
}

// ───────────────────────────────────────────────────────────── Category 1
// Null / stale growth scores. Left-join companies → latest growth score.
async function categoryNullGrowth(companies: CompanyRow[]): Promise<{
  rows: Record<string, unknown>[]; total: number;
}> {
  const { rows: scoreRows } = await storage.pool.query<{
    company_id: string; score: number | null; calculated_at: string | null;
  }>(
    `SELECT DISTINCT ON (company_id)
            company_id, score, calculated_at
       FROM account_growth_scores
      ORDER BY company_id, calculated_at DESC NULLS LAST`
  );
  const byCompany = new Map(scoreRows.map(r => [r.company_id, r]));
  const now = Date.now();
  const out: Record<string, unknown>[] = [];
  for (const c of companies) {
    const s = byCompany.get(c.id);
    const lastComputedAt = s?.calculated_at ?? null;
    const ageDays = lastComputedAt ? Math.floor((now - new Date(lastComputedAt).getTime()) / 86_400_000) : null;
    const isMissing = !s || s.score === null;
    const isStale = ageDays !== null && ageDays > 7;
    if (!isMissing && !isStale) continue;
    out.push({
      company_id: c.id,
      company_name: c.name,
      owner_rep_id_display: c.owner_rep_id ?? c.assigned_to ?? "",
      latest_score: s?.score ?? "",
      score_age_days: ageDays ?? "",
      last_computed_at: lastComputedAt ?? "",
      is_email_derived: c.is_email_derived,
    });
  }
  return { rows: out, total: out.length };
}

// ───────────────────────────────────────────────────────────── Category 2
// Financial match miss / low-confidence — evaluated against BOTH data
// sources the Company Detail page transitively renders:
//   (a) `freight_daily_upload_fact` YTD aggregates (the unified fact
//       table — moved=true, ship_date >= Jan 1)
//   (b) the latest `financial_uploads.summaryRows` blob per org (this is
//       what `GET /api/financials/account-summary` actually serves —
//       see server/routes/financials.ts:825-918; falls back to scanning
//       `rows` when summaryRows is missing/bad)
// Both passes share the same normalize+nameMatches semantics ported
// verbatim from the page. Buckets per source:
//   EXACT | ALIAS | FUZZY_HIGH | FUZZY_LOW | NO_MATCH_BUT_HAS_FREIGHT | NO_FREIGHT
// The exported CSV reports both buckets per company AND flags the row
// when they disagree, so reps can see when the header chip's source
// (upload blob) and the fact-table's YTD attribution drift apart.
// Export filter: any row where either source is in
// {FUZZY_LOW, NO_MATCH_BUT_HAS_FREIGHT}, OR `financial_alias IS NULL`
// with a FUZZY_HIGH suggestion in either source, OR the two sources
// disagree on the bucket assignment.
async function categoryFinancialMatch(companies: CompanyRow[]): Promise<{
  rows: Record<string, unknown>[]; total: number;
  bucketCountsFact: Record<string, number>; bucketCountsBlob: Record<string, number>;
  divergenceCount: number;
}> {
  const yearStart = `${today.getFullYear()}-01-01`;
  // Pass (a): unified fact table — TENANT-SCOPED.
  // freight_daily_upload_fact carries `org_id`; matches must be done
  // per-org to avoid cross-tenant customer-name collisions inflating
  // confidence buckets and YTD attribution.
  const { rows: factRows } = await storage.pool.query<{
    org_id: string; customer: string; ytd_loads: string; ytd_margin: string;
  }>(
    `SELECT org_id, customer,
            COUNT(*)::text AS ytd_loads,
            COALESCE(SUM(total_revenue * margin_pct / 100.0), 0)::text AS ytd_margin
       FROM freight_daily_upload_fact
      WHERE moved = true
        AND ship_date >= $1
        AND customer IS NOT NULL
        AND org_id IS NOT NULL
      GROUP BY org_id, customer`,
    [yearStart]
  );
  type FactRow = { customer: string; norm: string; loads: number; margin: number };
  const factsByOrg = new Map<string, FactRow[]>();
  for (const r of factRows) {
    const fr: FactRow = {
      customer: r.customer,
      norm: normalize(r.customer),
      loads: parseInt(r.ytd_loads, 10) || 0,
      margin: parseFloat(r.ytd_margin) || 0,
    };
    const arr = factsByOrg.get(r.org_id);
    if (arr) arr.push(fr); else factsByOrg.set(r.org_id, [fr]);
  }

  // Pass (b): latest financial_uploads blob per org. We extract distinct
  // customer-name strings from `summary_rows` first; when the summary
  // sheet is missing or doesn't carry a customer column we fall back to
  // scanning `rows` (the same fallback the route does via
  // isBadSummaryData / getCustomerFromRow). Header keys checked match
  // the route at server/routes/financials.ts:902-915 plus the __EMPTY
  // layout escape-hatch.
  // NOTE: financial_uploads has no organization_id column — uploads are
  // scoped via uploaded_by → users.organization_id. Resolve via a join
  // for the latest upload per ORG.
  const { rows: latestPerOrg } = await storage.pool.query<{
    organization_id: string; summary_rows: unknown; rows: unknown;
  }>(
    `SELECT DISTINCT ON (u.organization_id)
            u.organization_id AS organization_id,
            f.summary_rows, f.rows
       FROM financial_uploads f
       JOIN users u ON u.id = f.uploaded_by
      ORDER BY u.organization_id, f.uploaded_at DESC NULLS LAST`
  );
  function extractCustomerNamesFromBlob(summaryBlob: unknown, rowsBlob: unknown): string[] {
    const out = new Set<string>();
    const summary = Array.isArray(summaryBlob) ? summaryBlob : [];
    let pulledFromSummary = 0;
    for (const r of summary) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      const name = String(
        rec["Customer Name"] ?? rec["customer name"] ?? rec["CUSTOMER NAME"] ??
        rec["__EMPTY"] ?? ""
      ).trim();
      if (!name || name === "Customer Name" || name === "TOTAL" || name === "Customer code") continue;
      out.add(name); pulledFromSummary++;
    }
    if (pulledFromSummary > 0) return [...out];
    // Fallback: scan transaction rows for the customer column.
    const rows = Array.isArray(rowsBlob) ? rowsBlob : [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      const name = String(
        rec["Customer Name"] ?? rec["customer name"] ?? rec["CUSTOMER NAME"] ??
        rec["Customer"] ?? rec["customer"] ?? rec["CUSTOMER"] ?? ""
      ).trim();
      if (name) out.add(name);
    }
    return [...out];
  }
  type BlobRow = { customer: string; norm: string };
  const blobByOrg = new Map<string, BlobRow[]>();
  for (const r of latestPerOrg) {
    const names = extractCustomerNamesFromBlob(r.summary_rows, r.rows);
    blobByOrg.set(r.organization_id, names.map(n => ({ customer: n, norm: normalize(n) })));
  }

  const BUCKET_KEYS = ["EXACT","ALIAS","FUZZY_HIGH","FUZZY_LOW","NO_MATCH_BUT_HAS_FREIGHT","NO_FREIGHT"] as const;
  type Bucket = typeof BUCKET_KEYS[number];
  const bucketCountsFact: Record<string, number> = Object.fromEntries(BUCKET_KEYS.map(k => [k, 0]));
  const bucketCountsBlob: Record<string, number> = Object.fromEntries(BUCKET_KEYS.map(k => [k, 0]));

  // Generic bucketer — runs the same matching ladder against any
  // candidate-source set (fact rows or blob rows) using the page's
  // normalize+nameMatches semantics. `loadsOf` is only meaningful for
  // the fact source; for the blob source we fall back to a constant 1
  // so "presence in the upload blob" counts as freight-evidence for the
  // NO_MATCH_BUT_HAS_FREIGHT and FUZZY tie-breakers.
  function bucketFor<T extends { customer: string; norm: string }>(
    crmNorm: string,
    aliasNorms: string[],
    pool: T[],
    loadsOf: (t: T) => number,
  ): { bucket: Bucket; matched: T | null; suggested: string | null } {
    if (!pool.length) return { bucket: "NO_FREIGHT", matched: null, suggested: null };
    const aliasHit = pool.find(p => aliasNorms.some(a => nameMatches(a, p.norm)));
    if (aliasHit) return { bucket: "ALIAS", matched: aliasHit, suggested: null };
    const exactHit = pool.find(p => p.norm === crmNorm);
    if (exactHit) return { bucket: "EXACT", matched: exactHit, suggested: null };
    const fuzzy = pool.filter(p => nameMatches(crmNorm, p.norm));
    if (fuzzy.length) {
      fuzzy.sort((a, b) => loadsOf(b) - loadsOf(a));
      const matched = fuzzy[0];
      const delta = Math.abs(matched.norm.length - crmNorm.length);
      const competing = fuzzy.length > 1;
      const bucket: Bucket = (!competing && delta < 6) ? "FUZZY_HIGH" : "FUZZY_LOW";
      const suggested = bucket === "FUZZY_HIGH" ? matched.customer : null;
      return { bucket, matched, suggested };
    }
    const inverse = pool.filter(p => nameMatches(p.norm, crmNorm));
    if (inverse.length && loadsOf(inverse[0]) > 0) {
      return { bucket: "NO_MATCH_BUT_HAS_FREIGHT", matched: inverse[0], suggested: null };
    }
    return { bucket: "NO_FREIGHT", matched: null, suggested: null };
  }

  const out: Record<string, unknown>[] = [];
  let divergenceCount = 0;

  for (const c of companies) {
    const crmNorm = normalize(c.name);
    const aliasNorms = c.financial_alias
      ? c.financial_alias.split(",").map(a => normalize(a.trim())).filter(Boolean)
      : [];

    const factPool = factsByOrg.get(c.organization_id) ?? [];
    const factRes = bucketFor<FactRow>(crmNorm, aliasNorms, factPool, f => f.loads);
    const blobPool = blobByOrg.get(c.organization_id) ?? [];
    const blobRes = bucketFor<BlobRow>(crmNorm, aliasNorms, blobPool, () => 1);

    bucketCountsFact[factRes.bucket]++;
    bucketCountsBlob[blobRes.bucket]++;

    const ytdLoads = factRes.matched?.loads ?? 0;
    const ytdMargin = factRes.matched?.margin ?? 0;

    const diverges = factRes.bucket !== blobRes.bucket;
    if (diverges) divergenceCount++;

    const factLow = ytdLoads > 0 && (factRes.bucket === "FUZZY_LOW" || factRes.bucket === "NO_MATCH_BUT_HAS_FREIGHT");
    const blobLow = blobRes.matched && (blobRes.bucket === "FUZZY_LOW" || blobRes.bucket === "NO_MATCH_BUT_HAS_FREIGHT");
    const aliasGap = !c.financial_alias && (factRes.bucket === "FUZZY_HIGH" || blobRes.bucket === "FUZZY_HIGH") && (factRes.suggested || blobRes.suggested);

    if (!factLow && !blobLow && !aliasGap && !diverges) continue;

    const reasons: string[] = [];
    if (factLow) reasons.push("low_confidence_with_freight_fact");
    if (blobLow) reasons.push("low_confidence_with_blob_match");
    if (aliasGap) reasons.push("alias_gap_high_confidence_candidate");
    if (diverges) reasons.push("fact_vs_blob_divergence");

    out.push({
      company_id: c.id,
      company_name: c.name,
      financial_alias: c.financial_alias ?? "",
      fact_match_candidate: factRes.matched?.customer ?? "",
      fact_bucket: factRes.bucket,
      blob_match_candidate: blobRes.matched?.customer ?? "",
      blob_bucket: blobRes.bucket,
      buckets_diverge: diverges,
      suggested_alias: factRes.suggested ?? blobRes.suggested ?? "",
      ytd_loads_fact: ytdLoads,
      ytd_margin_fact: ytdMargin.toFixed(2),
      reason: reasons.join("|"),
    });
  }
  return { rows: out, total: out.length, bucketCountsFact, bucketCountsBlob, divergenceCount };
}

// ───────────────────────────────────────────────────────────── Category 3
// NBA R13 fallback. Calls `computeNextBestAction` (the same entry point
// `GET /api/companies/:id/next-best-action` routes through — see
// `server/routes.ts:4926`) per company so we measure what the header
// chip actually renders today. A row is flagged when the engine returns
// `ruleId === 'R13'` (or it threw and we'd fall back to the R13-shape
// graceful response per `server/routes.ts:4938`). The persistent
// `nba_cards` table is intentionally NOT consulted — it stores rule
// cards from the Phase-1 batch engine (different code path) and would
// produce false positives for any account that simply has no card
// persisted yet.
//
// Cost control: the engine runs heavy queries per company. Default
// concurrency is 8; override via `NBA_CONCURRENCY`. Optional cohort
// cap via `NBA_SAMPLE_CAP` (default = unbounded; the script processes
// every active company unless capped). When capped, the report header
// records the sample size so the resulting count is read as
// "X of Y sampled" rather than a population figure.
async function categoryNbaR13(companies: CompanyRow[]): Promise<{
  rows: Record<string, unknown>[]; total: number; sampled: number; concurrency: number;
}> {
  // Touch + freight context for prioritisation.
  const { rows: touchRows } = await storage.pool.query<{
    company_id: string; last_touchpoint_at: string | null;
  }>(
    `SELECT company_id, MAX(date)::text AS last_touchpoint_at
       FROM touchpoints
      GROUP BY company_id`
  );
  const touchByCompany = new Map(touchRows.map(r => [r.company_id, r.last_touchpoint_at]));

  const yearStart = `${today.getFullYear()}-01-01`;
  // Tenant-scoped: group by (org_id, customer) and look up per-company.
  const { rows: ytdRows } = await storage.pool.query<{ org_id: string; customer: string; loads: string }>(
    `SELECT org_id, customer, COUNT(*)::text AS loads
       FROM freight_daily_upload_fact
      WHERE moved = true AND ship_date >= $1 AND customer IS NOT NULL AND org_id IS NOT NULL
      GROUP BY org_id, customer`,
    [yearStart]
  );
  const ytdByOrgNorm = new Map<string, Map<string, number>>();
  for (const r of ytdRows) {
    const inner = ytdByOrgNorm.get(r.org_id) ?? new Map<string, number>();
    inner.set(normalize(r.customer), parseInt(r.loads, 10) || 0);
    ytdByOrgNorm.set(r.org_id, inner);
  }
  function ytdForCompany(c: CompanyRow): number {
    const inner = ytdByOrgNorm.get(c.organization_id);
    if (!inner) return 0;
    const crmNorm = normalize(c.name);
    let best = inner.get(crmNorm) ?? 0;
    if (best > 0) return best;
    for (const [k, v] of inner) if (nameMatches(crmNorm, k) && v > best) best = v;
    return best;
  }

  const concurrency = Math.max(1, parseInt(process.env.NBA_CONCURRENCY ?? "8", 10) || 8);
  const sampleCap = parseInt(process.env.NBA_SAMPLE_CAP ?? "", 10);
  const cohort = Number.isFinite(sampleCap) && sampleCap > 0 ? companies.slice(0, sampleCap) : companies;
  console.log(`[audit][cat3] Evaluating NBA engine for ${cohort.length}/${companies.length} companies (concurrency=${concurrency}, cap=${Number.isFinite(sampleCap) && sampleCap > 0 ? sampleCap : "none"}).`);

  const out: Record<string, unknown>[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= cohort.length) return;
      const c = cohort[idx];
      let ruleId: string;
      let reason: string;
      try {
        const nba = await computeNextBestAction(c.id, c.organization_id, storage);
        ruleId = nba.ruleId;
        reason = ruleId === "R13" ? "engine_returned_R13" : "non_fallback";
      } catch (err) {
        // Mirrors the route-level graceful fallback at server/routes.ts:4938
        // — the header chip will render the R13 shape on engine errors.
        ruleId = "R13";
        reason = `engine_threw:${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)}`;
      }
      if (ruleId !== "R13") continue;
      out.push({
        company_id: c.id,
        company_name: c.name,
        nba_code: ruleId,
        reason,
        last_touchpoint_at: touchByCompany.get(c.id) ?? "",
        ytd_loads_fact: ytdForCompany(c),
      });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { rows: out, total: out.length, sampled: cohort.length, concurrency };
}

// ───────────────────────────────────────────────────────────── Category 4
// Email-derived stubs. Per #1095: legacy stubs predating the flag are NOT
// flagged — the report header notes this and the heuristic-mode count
// from /admin/email-derived-companies should be cross-referenced.
async function categoryEmailDerived(companies: CompanyRow[]): Promise<{
  rows: Record<string, unknown>[]; total: number; legacyHeuristicCount: number;
}> {
  const flagged = companies.filter(c => c.is_email_derived);

  // Contact + freight signal for triage. Freight is tenant-scoped: a
  // stub in org A only counts as "has_freight_activity" if the matching
  // customer name appears in org A's own freight_daily_upload_fact rows.
  const ids = flagged.map(c => c.id);
  const contactCounts = new Map<string, number>();
  const freightByOrg = new Map<string, Set<string>>();
  if (ids.length) {
    const { rows: cRows } = await storage.pool.query<{ company_id: string; cnt: string }>(
      `SELECT company_id, COUNT(*)::text AS cnt
         FROM contacts
        WHERE company_id = ANY($1::varchar[]) AND deleted_at IS NULL
        GROUP BY company_id`,
      [ids]
    );
    for (const r of cRows) contactCounts.set(r.company_id, parseInt(r.cnt, 10) || 0);
    const flaggedOrgIds = Array.from(new Set(flagged.map(c => c.organization_id)));
    if (flaggedOrgIds.length) {
      const { rows: fRows } = await storage.pool.query<{ org_id: string; customer: string }>(
        `SELECT DISTINCT org_id, customer
           FROM freight_daily_upload_fact
          WHERE customer IS NOT NULL AND org_id = ANY($1::varchar[])`,
        [flaggedOrgIds]
      );
      for (const r of fRows) {
        const set = freightByOrg.get(r.org_id) ?? new Set<string>();
        set.add(normalize(r.customer));
        freightByOrg.set(r.org_id, set);
      }
    }
  }

  const out = flagged.map(c => {
    const crmNorm = normalize(c.name);
    const set = freightByOrg.get(c.organization_id) ?? new Set<string>();
    let hasFreight = set.has(crmNorm);
    if (!hasFreight) for (const fc of set) if (nameMatches(crmNorm, fc)) { hasFreight = true; break; }
    return {
      company_id: c.id,
      company_name: c.name,
      email_derived_at: c.email_derived_at ?? "",
      email_derived_seed_message_id: c.email_derived_seed_message_id ?? "",
      contact_count_active: contactCounts.get(c.id) ?? 0,
      has_freight_activity: hasFreight,
      owner_rep_id_display: c.owner_rep_id ?? c.assigned_to ?? "",
    };
  });

  // Legacy-heuristic comparison count (per #1095 gotcha): legacy stubs
  // = no contacts, no owner, no industry, not archived, NOT flagged.
  const { rows: legacyRows } = await storage.pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM companies c
      WHERE c.archived_at IS NULL
        AND c.is_email_derived = false
        AND c.industry IS NULL
        AND c.owner_rep_id IS NULL
        AND c.assigned_to IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM contacts ct
           WHERE ct.company_id = c.id AND ct.deleted_at IS NULL
        )`
  );
  const legacyHeuristicCount = parseInt(legacyRows[0]?.cnt ?? "0", 10) || 0;

  return { rows: out, total: out.length, legacyHeuristicCount };
}

// ───────────────────────────────────────────────────────────── Category 5
// Owner-conflicts summary. Joins #1118's CSV — does NOT re-query.
function loadOwnerConflictsCsv(): { path: string; rows: Record<string, string>[] } | null {
  if (!existsSync(EXPORTS_DIR)) return null;
  const matches = readdirSync(EXPORTS_DIR)
    .filter(f => /^customers-owner-mismatch-\d{8}\.csv$/.test(f))
    .sort()
    .reverse();
  if (!matches.length) return null;
  const path = join(EXPORTS_DIR, matches[0]);
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { path, rows: [] };
  // Tolerant CSV parse — handles quoted fields with embedded commas.
  function parseLine(line: string): string[] {
    const out: string[] = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else {
        if (ch === ",") { out.push(cur); cur = ""; }
        else if (ch === '"') inQuotes = true;
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = parseLine(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    return obj;
  });
  return { path, rows };
}

async function categoryOwnerConflicts(companies: CompanyRow[]): Promise<{
  rows: Record<string, unknown>[]; total: number; sourcePath: string | null; blocked: boolean;
}> {
  const csv = loadOwnerConflictsCsv();
  if (!csv) return { rows: [], total: 0, sourcePath: null, blocked: true };

  const companyById = new Map(companies.map(c => [c.id, c]));

  // Build YTD-loads + latest growth-score lookups for the join.
  // Tenant-scoped: same per-org map shape as Cat 3.
  const yearStart = `${today.getFullYear()}-01-01`;
  const { rows: ytdRows } = await storage.pool.query<{ org_id: string; customer: string; loads: string }>(
    `SELECT org_id, customer, COUNT(*)::text AS loads
       FROM freight_daily_upload_fact
      WHERE moved = true AND ship_date >= $1 AND customer IS NOT NULL AND org_id IS NOT NULL
      GROUP BY org_id, customer`,
    [yearStart]
  );
  const ytdByOrgNorm = new Map<string, Map<string, number>>();
  for (const r of ytdRows) {
    const inner = ytdByOrgNorm.get(r.org_id) ?? new Map<string, number>();
    inner.set(normalize(r.customer), parseInt(r.loads, 10) || 0);
    ytdByOrgNorm.set(r.org_id, inner);
  }
  function ytdFor(c: CompanyRow): number {
    const inner = ytdByOrgNorm.get(c.organization_id);
    if (!inner) return 0;
    const crmNorm = normalize(c.name);
    let best = inner.get(crmNorm) ?? 0;
    if (best > 0) return best;
    for (const [k, v] of inner) if (nameMatches(crmNorm, k) && v > best) best = v;
    return best;
  }
  const { rows: scoreRows } = await storage.pool.query<{
    company_id: string; score: number; calculated_at: string;
  }>(
    `SELECT DISTINCT ON (company_id) company_id, score, calculated_at
       FROM account_growth_scores
      ORDER BY company_id, calculated_at DESC NULLS LAST`
  );
  const scoreByCompany = new Map(scoreRows.map(r => [r.company_id, r]));

  const out: Record<string, unknown>[] = [];
  for (const r of csv.rows) {
    const cid = r.company_id;
    const c = companyById.get(cid);
    const ytd = c ? ytdFor(c) : 0;
    const score = scoreByCompany.get(cid);
    out.push({
      company_id: cid,
      company_name: r.company_name,
      mismatch_category: r.mismatch_category,
      owner_name: r.owner_name,
      assigned_name: r.assigned_name,
      ytd_loads_fact: ytd,
      latest_growth_score: score?.score ?? "",
      score_calculated_at: score?.calculated_at ?? "",
      still_active_in_audit_universe: !!c,
    });
  }
  return { rows: out, total: out.length, sourcePath: csv.path, blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
function topN<T extends Record<string, unknown>>(rows: T[], n: number): T[] {
  return rows.slice(0, n);
}

function md(headers: string[], rows: Record<string, unknown>[]): string {
  if (!rows.length) return "_(no rows)_\n";
  const head = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(r => `| ${headers.map(h => String(r[h] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
  return `${head}\n${body}\n`;
}

async function main() {
  console.log(`[audit] AUDIT_READ_ONLY guard ok. Stamp=${stamp}`);
  const companies = await loadActiveCompanies();
  console.log(`[audit] Universe: ${companies.length} active non-archived companies.`);

  const cat1 = await categoryNullGrowth(companies);
  const cat2 = await categoryFinancialMatch(companies);
  const cat3 = await categoryNbaR13(companies);
  const cat4 = await categoryEmailDerived(companies);
  const cat5 = await categoryOwnerConflicts(companies);

  // ── CSV writes ─────────────────────────────────────────────────────────
  const cat1Headers = ["company_id","company_name","owner_rep_id_display","latest_score","score_age_days","last_computed_at","is_email_derived"];
  const cat2Headers = ["company_id","company_name","financial_alias","fact_match_candidate","fact_bucket","blob_match_candidate","blob_bucket","buckets_diverge","suggested_alias","ytd_loads_fact","ytd_margin_fact","reason"];
  const cat3Headers = ["company_id","company_name","nba_code","reason","last_touchpoint_at","ytd_loads_fact"];
  const cat4Headers = ["company_id","company_name","email_derived_at","email_derived_seed_message_id","contact_count_active","has_freight_activity","owner_rep_id_display"];
  const cat5Headers = ["company_id","company_name","mismatch_category","owner_name","assigned_name","ytd_loads_fact","latest_growth_score","score_calculated_at","still_active_in_audit_universe"];

  const p1 = writeBoth(`company-detail-null-growth-score-${stamp}.csv`, toCsv(cat1Headers, cat1.rows));
  const p2 = writeBoth(`company-detail-financial-match-miss-${stamp}.csv`, toCsv(cat2Headers, cat2.rows));
  const p3 = writeBoth(`company-detail-nba-r13-fallback-${stamp}.csv`, toCsv(cat3Headers, cat3.rows));
  const p4 = writeBoth(`company-detail-email-derived-${stamp}.csv`, toCsv(cat4Headers, cat4.rows));
  const p5 = cat5.blocked
    ? null
    : writeBoth(`company-detail-owner-conflicts-summary-${stamp}.csv`, toCsv(cat5Headers, cat5.rows));

  // ── Markdown report ────────────────────────────────────────────────────
  const reportPath = join(DOCS_DIR, `company-detail-header-trust-${stamp}.md`);
  const lines: string[] = [];
  lines.push(`# Company Detail header trust audit — ${stamp}`);
  lines.push("");
  lines.push("**Generated:** " + new Date().toISOString());
  lines.push("**Posture:** Read-only. No production writes, no schema changes, no UI/route changes, no business-logic changes.");
  lines.push("");
  lines.push("## Universe");
  lines.push("");
  lines.push(`- Cohort: \`companies WHERE archived_at IS NULL\` — **${companies.length}** rows.`);
  lines.push("- Detail-page view telemetry was **not available** at audit time, so the universe is every active non-archived company. A future re-run can scope to the last-30-day viewed cohort once `page_views` (or equivalent) lands.");
  lines.push("- Financial fuzzy-match logic is a verbatim port of `client/src/pages/company-detail.tsx:269-284` so the audit measures what reps actually see.");
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`| Category | Rows flagged |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| 1. Null / stale growth scores | ${cat1.total} |`);
  lines.push(`| 2. Financial match miss / low-confidence | ${cat2.total} |`);
  lines.push(`| 3. NBA R13 fallback (engine call) | ${cat3.total} of ${cat3.sampled} sampled |`);
  lines.push(`| 4. Email-derived stubs (flagged) | ${cat4.total} |`);
  lines.push(`| 5. Owner-conflicts summary | ${cat5.blocked ? "_blocked on #1118_" : cat5.total} |`);
  lines.push("");
  lines.push("### Category 2 — bucket distribution (whole universe, both sources)");
  lines.push("");
  lines.push(`| Bucket | Fact (\`freight_daily_upload_fact\`) | Blob (\`financial_uploads.summaryRows\`) |`);
  lines.push(`| --- | ---: | ---: |`);
  for (const k of ["EXACT","ALIAS","FUZZY_HIGH","FUZZY_LOW","NO_MATCH_BUT_HAS_FREIGHT","NO_FREIGHT"]) {
    lines.push(`| ${k} | ${cat2.bucketCountsFact[k] ?? 0} | ${cat2.bucketCountsBlob[k] ?? 0} |`);
  }
  lines.push("");
  lines.push(`Companies whose fact bucket and blob bucket disagree: **${cat2.divergenceCount}**. Each such row is a place where the header chip's source data and the YTD attribution may render different stories to the rep.`);
  lines.push("");
  lines.push(`### Category 4 — legacy stub backfill`);
  lines.push("");
  lines.push(`Per the \`replit.md\` Task #1095 gotcha: legacy stubs predating the \`is_email_derived\` flag are **not** flagged. Heuristic count of likely-legacy stubs (no contacts, no owner, no industry, not archived, not flagged): **${cat4.legacyHeuristicCount}**. Cross-reference against \`/admin/email-derived-companies\` heuristic mode.`);
  lines.push("");
  lines.push("## Top 10 samples");
  lines.push("");
  lines.push("### 1. Null / stale growth scores");
  lines.push(md(cat1Headers, topN(cat1.rows, 10)));
  lines.push("### 2. Financial match miss / low-confidence");
  lines.push(md(cat2Headers, topN(cat2.rows, 10)));
  lines.push(`### 3. NBA R13 fallback (engine call — sampled ${cat3.sampled}/${companies.length}, concurrency ${cat3.concurrency})`);
  lines.push(md(cat3Headers, topN(cat3.rows, 10)));
  lines.push("### 4. Email-derived stubs");
  lines.push(md(cat4Headers, topN(cat4.rows, 10)));
  lines.push("### 5. Owner-conflicts summary");
  if (cat5.blocked) {
    lines.push("_Blocked on Task #1118 — no `customers-owner-mismatch-*.csv` found in `docs/audits/exports/`._");
  } else {
    lines.push(`Joined from \`${cat5.sourcePath}\`.`);
    lines.push("");
    lines.push(md(cat5Headers, topN(cat5.rows, 10)));
  }
  lines.push("");
  lines.push("## Dependencies");
  lines.push("");
  lines.push("- **#1109 (IMPLEMENTED):** Profile Safety Labels surface (default-ON) shipped non-destructive freshness/mapping pills on the header. The amber/grey/loading triad is already wired (`useCompanyDataFreshness.ts`), so any Phase A trust-label work should extend the existing surface rather than introduce a parallel channel.");
  lines.push("- **#1118 (IN_PROGRESS):** Owner-conflict CSV consumed verbatim by Category 5. Re-running this audit after #1118 refreshes its CSV will pick up the new file automatically.");
  lines.push("");
  lines.push("## Recommended Phase A / B order");
  lines.push("");
  const phaseLines: string[] = [];
  const sorted = [
    ["null/stale growth scores (Phase A label work + Phase B job watchdog)", cat1.total],
    ["financial match miss with freight (Phase A 'unverified mapping' hint + Phase B alias suggester surface)", cat2.total],
    ["NBA R13 fallback (Phase A explicit 'no recommendation' state + Phase B engine signal-coverage audit)", cat3.total],
    ["email-derived stubs (Phase A header banner already exists per #1109; Phase B legacy-stub backfill)", cat4.total],
    ["owner conflicts joined to YTD freight (Phase A header owner-name disambiguation; Phase B reconciliation)", cat5.blocked ? -1 : cat5.total],
  ] as const;
  const ordered = [...sorted].filter(([,n]) => n !== -1).sort((a,b) => (b[1] as number) - (a[1] as number));
  ordered.forEach(([label, n], i) => phaseLines.push(`${i+1}. **${label}** — ${n} rows`));
  if (cat5.blocked) phaseLines.push(`${ordered.length + 1}. **owner conflicts** — _blocked on #1118_`);
  lines.push(phaseLines.join("\n"));
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- [\`exports/company-detail-null-growth-score-${stamp}.csv\`](exports/company-detail-null-growth-score-${stamp}.csv)`);
  lines.push(`- [\`exports/company-detail-financial-match-miss-${stamp}.csv\`](exports/company-detail-financial-match-miss-${stamp}.csv)`);
  lines.push(`- [\`exports/company-detail-nba-r13-fallback-${stamp}.csv\`](exports/company-detail-nba-r13-fallback-${stamp}.csv)`);
  lines.push(`- [\`exports/company-detail-email-derived-${stamp}.csv\`](exports/company-detail-email-derived-${stamp}.csv)`);
  if (p5) lines.push(`- [\`exports/company-detail-owner-conflicts-summary-${stamp}.csv\`](exports/company-detail-owner-conflicts-summary-${stamp}.csv)`);
  lines.push("");
  writeFileSync(reportPath, lines.join("\n"), "utf8");

  console.log(`[audit] Wrote:`);
  console.log(`  ${p1}`);
  console.log(`  ${p2}`);
  console.log(`  ${p3}`);
  console.log(`  ${p4}`);
  if (p5) console.log(`  ${p5}`);
  console.log(`  ${reportPath}`);
  console.log(`[audit] Done. Universe=${companies.length}; cat1=${cat1.total} cat2=${cat2.total} cat3=${cat3.total} cat4=${cat4.total} cat5=${cat5.blocked ? "blocked" : cat5.total}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error("[audit] Failed:", err);
  process.exit(1);
});
