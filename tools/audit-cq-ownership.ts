/**
 * Phase 1.1-A — Read-only Customer Quotes ownership audit.
 *
 * For every org, loads every `quote_opportunities` row that would appear
 * in `/quote-requests` under TODAY's filters (CQ-2 customer-only chokepoint:
 * party_type='customer' and routing_status NOT IN ('auto_carrier','needs_routing')).
 *
 * For each row, resolves:
 *   - CQ_owner_user_id        = companies.owner_rep_id (CQ-3 strict rule —
 *                               what enrich()'s ownerRepNameByCustomerId map
 *                               actually surfaces today; null when no
 *                               canonical-name bridge to a CRM company exists
 *                               or that company has owner_rep_id IS NULL).
 *   - canonical_owner_user_id = COALESCE(companies.owner_rep_id,
 *                                        companies.assigned_to,
 *                                        companies.sales_person_id)
 *                               (the rule used by Customers tab + auth
 *                               visibility via getCanonicalCompanyOwnerId).
 *
 * Buckets:
 *   agree            — both present and equal
 *   cq_only          — CQ has an owner, canonical does not (impossible by
 *                      construction, since canonical's first arm IS the CQ
 *                      rule — reported for completeness as a sanity check)
 *   customers_only   — canonical has an owner via assignedTo / salesPersonId,
 *                      CQ shows nothing (THIS is the cross-surface
 *                      divergence we are measuring)
 *   both_unowned     — both null
 *   no_company_link  — quote_customers row name doesn't bridge to any
 *                      companies row (no CRM company at all — the divergence
 *                      question doesn't apply, but the count is reported so
 *                      the reader can see the denominator)
 *
 * Strict zero-write contract: SELECT-only, no production code modified, no
 * schema, no flags, no behavior change.
 *
 * Usage:
 *   npx tsx tools/audit-cq-ownership.ts
 *   npx tsx tools/audit-cq-ownership.ts --org-slug=valuetruck
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";
import { writeFileSync } from "node:fs";

const SAMPLES_PER_BUCKET = 8;
const REPORT_PATH = "docs/cq-ownership-audit-2026-05-15.md";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  quote_count: number;
}

type Bucket = "agree" | "cq_only" | "customers_only" | "both_unowned" | "no_company_link";

interface QuoteRow {
  quote_id: string;
  customer_id: string;
  customer_name: string;
  company_id: string | null;
  company_name: string | null;
  cq_owner_user_id: string | null;
  canonical_owner_user_id: string | null;
  routing_status: string;
  outcome_status: string;
  source: string;
  rep_id: string | null;
  is_email_derived: boolean | null;
}

interface OrgResult {
  org: OrgRow;
  total: number;
  counts: Record<Bucket, number>;
  samples: Record<Bucket, QuoteRow[]>;
}

function parseArgs(): { orgSlug: string | null } {
  let orgSlug: string | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--org-slug=")) orgSlug = arg.slice("--org-slug=".length);
  }
  return { orgSlug };
}

async function listOrgs(orgSlug: string | null): Promise<OrgRow[]> {
  // Order by quote count desc so the largest org (typically Value Truck)
  // is first in the report.
  const filter = orgSlug ? sql`WHERE o.slug = ${orgSlug}` : sql``;
  const rows = await db.execute<{ id: string; name: string; slug: string; quote_count: string }>(sql`
    SELECT
      o.id, o.name, o.slug,
      (SELECT count(*) FROM quote_opportunities q WHERE q.organization_id = o.id) AS quote_count
    FROM organizations o
    ${filter}
    ORDER BY (SELECT count(*) FROM quote_opportunities q WHERE q.organization_id = o.id) DESC
  `);
  return rows.rows
    .map(r => ({ id: r.id, name: r.name, slug: r.slug, quote_count: Number(r.quote_count) }))
    .filter(r => r.quote_count > 0);
}

async function loadVisibleQuotesForOrg(orgId: string): Promise<QuoteRow[]> {
  // Mirrors the today-visible filter in `applyFilters` (CQ-2):
  //   - party_type = 'customer' (drops carrier / unknown party types)
  //   - routing_status NOT IN ('auto_carrier', 'needs_routing')
  // The customer-facing-rep gate (third arm of applyFilters) is NOT
  // applied here because it is a per-org rep-mapping gate that varies
  // with rep configuration; this audit is about the ownership rule, so
  // the broader visible set (rep-gate-agnostic) is the correct
  // denominator. The CQ-5 null-passthrough means rep-gate dropping
  // never reaches a row whose owner is being measured anyway.
  //
  // Bridge to CRM companies via canonical name match (the same
  // bridge `loadContext` uses at customerQuotes.ts:1338-1346 — by
  // exact `companies.name` lookup). Lowercased trim is NOT applied
  // here because the production code uses exact name lookup; reporting
  // an honest mirror of today's behavior matters more than charity-
  // matching extra rows.
  const rows = await db.execute<{
    quote_id: string;
    customer_id: string;
    customer_name: string;
    company_id: string | null;
    company_name: string | null;
    company_owner_rep_id: string | null;
    company_assigned_to: string | null;
    company_sales_person_id: string | null;
    routing_status: string;
    outcome_status: string;
    source: string;
    rep_id: string | null;
    is_email_derived: boolean | null;
  }>(sql`
    SELECT
      q.id            AS quote_id,
      q.customer_id   AS customer_id,
      qc.name         AS customer_name,
      c.id            AS company_id,
      c.name          AS company_name,
      c.owner_rep_id  AS company_owner_rep_id,
      c.assigned_to   AS company_assigned_to,
      c.sales_person_id AS company_sales_person_id,
      q.routing_status,
      q.outcome_status,
      q.source,
      q.rep_id,
      c.is_email_derived
    FROM quote_opportunities q
      JOIN quote_customers qc ON qc.id = q.customer_id
      LEFT JOIN companies c
        ON c.organization_id = q.organization_id
       AND c.name = qc.name
    WHERE q.organization_id = ${orgId}
      AND qc.party_type = 'customer'
      AND q.routing_status NOT IN ('auto_carrier', 'needs_routing')
  `);

  return rows.rows.map(r => {
    const cq_owner_user_id = r.company_owner_rep_id;
    const canonical_owner_user_id =
      r.company_owner_rep_id ?? r.company_assigned_to ?? r.company_sales_person_id ?? null;
    return {
      quote_id: r.quote_id,
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      company_id: r.company_id,
      company_name: r.company_name,
      cq_owner_user_id,
      canonical_owner_user_id,
      routing_status: r.routing_status,
      outcome_status: r.outcome_status,
      source: r.source,
      rep_id: r.rep_id,
      is_email_derived: r.is_email_derived,
    };
  });
}

function classify(row: QuoteRow): Bucket {
  if (!row.company_id) return "no_company_link";
  const cq = row.cq_owner_user_id;
  const can = row.canonical_owner_user_id;
  if (cq && can) return cq === can ? "agree" : "cq_only"; // cq_only: same-row mismatch (canonical first arm IS cq, so cq must equal can when both set — impossible by construction; reserved as sanity bucket)
  if (cq && !can) return "cq_only";
  if (!cq && can) return "customers_only";
  return "both_unowned";
}

async function auditOrg(org: OrgRow): Promise<OrgResult> {
  const rows = await loadVisibleQuotesForOrg(org.id);
  const counts: Record<Bucket, number> = {
    agree: 0, cq_only: 0, customers_only: 0, both_unowned: 0, no_company_link: 0,
  };
  const samples: Record<Bucket, QuoteRow[]> = {
    agree: [], cq_only: [], customers_only: [], both_unowned: [], no_company_link: [],
  };
  for (const row of rows) {
    const b = classify(row);
    counts[b]++;
    if (samples[b].length < SAMPLES_PER_BUCKET) samples[b].push(row);
  }
  return { org, total: rows.length, counts, samples };
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtSampleRow(r: QuoteRow): string {
  const cq = r.cq_owner_user_id ?? "∅";
  const can = r.canonical_owner_user_id ?? "∅";
  const ed = r.is_email_derived ? " EMAIL_DERIVED" : "";
  return `  - \`${r.quote_id.slice(0, 8)}\` cust=\`${r.customer_id.slice(0, 8)}\` ` +
         `name="${(r.customer_name ?? "").slice(0, 40)}" ` +
         `comp=${r.company_id ? `\`${r.company_id.slice(0, 8)}\`` : "∅"} ` +
         `cq=${cq.slice(0, 8)} can=${can.slice(0, 8)} ` +
         `routing=${r.routing_status} outcome=${r.outcome_status} ` +
         `src=${r.source} rep=${r.rep_id ? r.rep_id.slice(0, 8) : "∅"}${ed}`;
}

function renderOrgSection(res: OrgResult): string {
  const lines: string[] = [];
  lines.push(`### ${res.org.name} (\`${res.org.slug}\`)`);
  lines.push("");
  lines.push(`Total visible quote rows (CQ-2 customer-only): **${res.total}**`);
  lines.push("");
  lines.push(`| Bucket | Count | % of total |`);
  lines.push(`|---|---:|---:|`);
  for (const b of ["agree", "customers_only", "cq_only", "both_unowned", "no_company_link"] as Bucket[]) {
    lines.push(`| ${b} | ${res.counts[b]} | ${pct(res.counts[b], res.total)} |`);
  }
  lines.push("");
  for (const b of ["customers_only", "cq_only", "both_unowned", "no_company_link"] as Bucket[]) {
    if (res.samples[b].length === 0) continue;
    lines.push(`**Sample — ${b}** (up to ${SAMPLES_PER_BUCKET}):`);
    lines.push("");
    for (const row of res.samples[b]) lines.push(fmtSampleRow(row));
    lines.push("");
  }
  return lines.join("\n");
}

function renderReport(results: OrgResult[]): string {
  const totals: Record<Bucket, number> = {
    agree: 0, cq_only: 0, customers_only: 0, both_unowned: 0, no_company_link: 0,
  };
  let grandTotal = 0;
  for (const r of results) {
    grandTotal += r.total;
    for (const b of Object.keys(totals) as Bucket[]) totals[b] += r.counts[b];
  }

  const lines: string[] = [];
  lines.push("# Customer Quotes Ownership Audit (Phase 1.1-A, 2026-05-15)");
  lines.push("");
  lines.push("> **Read-only audit.** No production code, schema, or data was");
  lines.push("> modified by this script (`tools/audit-cq-ownership.ts`). The");
  lines.push("> queries are SELECT-only.");
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("Every `quote_opportunities` row that passes today's CQ-2");
  lines.push("customer-only chokepoint (`party_type='customer'` AND");
  lines.push("`routing_status NOT IN ('auto_carrier','needs_routing')`) is");
  lines.push("classified by comparing two ownership rules applied to the");
  lines.push("same CRM company (bridged via canonical `companies.name = ");
  lines.push("quote_customers.name` — the exact match `loadContext` uses):");
  lines.push("");
  lines.push("- **CQ rule (CQ-3 strict):** `companies.owner_rep_id` only.");
  lines.push("  This is what `enrich()`'s `ownerRepNameByCustomerId` map");
  lines.push("  surfaces in `/quote-requests` today.");
  lines.push("- **Canonical rule (Customers tab + auth visibility):**");
  lines.push("  `COALESCE(owner_rep_id, assigned_to, sales_person_id)` —");
  lines.push("  the chain pinned by `getCanonicalCompanyOwnerId(c)` in");
  lines.push("  `server/lib/companyOwner.ts`.");
  lines.push("");
  lines.push("Buckets:");
  lines.push("");
  lines.push("- `agree` — both rules return the same user id (or both null).");
  lines.push("  In practice this means `owner_rep_id` is set; the canonical");
  lines.push("  rule's first arm is the CQ rule, so when CQ has an answer");
  lines.push("  the canonical rule must agree.");
  lines.push("- `customers_only` — CQ shows no owner (`owner_rep_id IS NULL`)");
  lines.push("  but the canonical chain resolves to a user via `assigned_to`");
  lines.push("  or `sales_person_id`. **This is the cross-surface divergence");
  lines.push("  we're quantifying** (CQ-G1, CQ-G10).");
  lines.push("- `cq_only` — sanity check; should be 0 by construction.");
  lines.push("- `both_unowned` — neither rule resolves an owner. CQ shows");
  lines.push("  \"Unowned\"; Customers tab shows \"Unowned\". The two");
  lines.push("  surfaces agree (and the underlying account has no owner");
  lines.push("  on any column).");
  lines.push("- `no_company_link` — `quote_customers.name` doesn't match any");
  lines.push("  `companies.name` in the same org. The divergence question");
  lines.push("  doesn't apply (no CRM company exists), but the count is");
  lines.push("  reported as a denominator-of-truth.");
  lines.push("");
  lines.push("## Grand totals across all orgs");
  lines.push("");
  lines.push(`Total visible quote rows: **${grandTotal}**`);
  lines.push("");
  lines.push(`| Bucket | Count | % |`);
  lines.push(`|---|---:|---:|`);
  for (const b of ["agree", "customers_only", "cq_only", "both_unowned", "no_company_link"] as Bucket[]) {
    lines.push(`| ${b} | ${totals[b]} | ${pct(totals[b], grandTotal)} |`);
  }
  lines.push("");
  lines.push("## Per-org breakdown");
  lines.push("");
  for (const res of results) lines.push(renderOrgSection(res));
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Out of scope for this audit");
  lines.push("");
  lines.push("- No production code paths were changed.");
  lines.push("- No data was written.");
  lines.push("- No tests / guardrails were modified.");
  lines.push("- The Mine Only resolver semantics (CQ-G2) were not exercised");
  lines.push("  here — that lands in P1.1-D.");
  lines.push("- Cross-surface owner-display parity beyond Customers vs");
  lines.push("  Quote Requests (e.g. Top Opps, Dashboard) is out of scope.");
  lines.push("- No recommendation is made here whether to document the");
  lines.push("  divergence as intentional (P1.1-F) or schedule unification");
  lines.push("  under Task #1169. Decision is the human's based on the");
  lines.push("  numbers above.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const { orgSlug } = parseArgs();
  const orgs = await listOrgs(orgSlug);
  if (orgs.length === 0) {
    console.error(orgSlug ? `No org with slug=${orgSlug} (or it has 0 quotes).` : "No orgs with quote rows.");
    process.exit(1);
  }
  const results: OrgResult[] = [];
  for (const org of orgs) {
    process.stderr.write(`auditing ${org.name} (${org.slug}) — ${org.quote_count} total quote rows\n`);
    results.push(await auditOrg(org));
  }
  const report = renderReport(results);
  writeFileSync(REPORT_PATH, report, "utf8");
  process.stderr.write(`\nWrote ${REPORT_PATH}\n`);

  // Brief stdout summary so CI logs / piped output are useful too.
  console.log("## Summary");
  let grand = 0;
  const totals: Record<Bucket, number> = { agree: 0, cq_only: 0, customers_only: 0, both_unowned: 0, no_company_link: 0 };
  for (const r of results) {
    grand += r.total;
    for (const b of Object.keys(totals) as Bucket[]) totals[b] += r.counts[b];
  }
  console.log(`Total: ${grand}`);
  for (const b of ["agree", "customers_only", "cq_only", "both_unowned", "no_company_link"] as Bucket[]) {
    console.log(`  ${b}: ${totals[b]} (${pct(totals[b], grand)})`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
