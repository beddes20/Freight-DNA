/**
 * Task #P2.1b — One-shot, idempotent backfill from the legacy
 * `companies.financial_alias` comma-separated text column into the new
 * `company_financial_aliases` table.
 *
 * For every company in every org we insert two kinds of rows (subject
 * to dedup via ON CONFLICT against the partial unique index):
 *
 *   1. A self-alias row `(alias = company.name, source =
 *      'legacy_column')` so the resolver in P2.2 has no special case
 *      for "the company's own name" — it just hits the alias table
 *      with the normalized company name.
 *
 *   2. One row per non-empty token from
 *      `companies.financial_alias`, split on `,`, trimmed, with
 *      `source = 'legacy_column'`.
 *
 * Idempotent: re-running is safe. The ON CONFLICT target is the
 * partial unique index `cfa_org_alias_norm_uniq` (which covers
 * everything we're inserting since `source = 'legacy_column' <>
 * 'heuristic'`), so duplicate (org_id, alias_normalized) pairs are
 * skipped silently.
 *
 * Run: `npx tsx scripts/backfill-company-financial-aliases.ts`
 *
 * No readers or writers in production code reference
 * `company_financial_aliases` yet — that wiring lands in P2.2. This
 * script is the only thing populating the table today.
 */

import { Pool } from "pg";

// Canonical normalize — keep in sync with the resolver landing in P2.2
// (server/services/aliasResolver.ts). Same shape as the inline
// `normalize` / `normN` helpers currently sprinkled across
// server/routes/dashboard.ts (lines 1149, 1231, 1544) and
// scripts/audits/company-detail-header-trust.ts.
function normalizeAlias(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface Stats {
  companiesScanned: number;
  selfAliasesAttempted: number;
  splitAliasesAttempted: number;
  rowsInserted: number;
  rowsSkippedConflict: number;
  rowsSkippedEmptyNormalized: number;
  errors: number;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const stats: Stats = {
    companiesScanned: 0,
    selfAliasesAttempted: 0,
    splitAliasesAttempted: 0,
    rowsInserted: 0,
    rowsSkippedConflict: 0,
    rowsSkippedEmptyNormalized: 0,
    errors: 0,
  };

  try {
    const { rows: companies } = await pool.query<{
      id: string;
      organization_id: string;
      name: string;
      financial_alias: string | null;
    }>(
      `SELECT id, organization_id, name, financial_alias
         FROM companies
        WHERE archived_at IS NULL OR archived_at = ''`,
    );

    console.log(`[cfa-backfill] scanning ${companies.length} non-archived companies`);

    for (const c of companies) {
      stats.companiesScanned++;

      // The set of (rawAlias) we want to write for this company:
      // company.name + every non-empty token from the comma-blob.
      const rawAliases: string[] = [c.name];
      if (c.financial_alias && c.financial_alias.trim().length > 0) {
        for (const token of c.financial_alias.split(",")) {
          const trimmed = token.trim();
          if (trimmed.length > 0) rawAliases.push(trimmed);
        }
      }

      // Dedupe within a single company by normalized form so we don't
      // attempt 5 inserts for "ACME, Acme, A.C.M.E.".
      const seenNorm = new Set<string>();
      for (const raw of rawAliases) {
        const norm = normalizeAlias(raw);
        if (norm.length === 0) {
          stats.rowsSkippedEmptyNormalized++;
          continue;
        }
        if (seenNorm.has(norm)) continue;
        seenNorm.add(norm);

        if (raw === c.name) stats.selfAliasesAttempted++;
        else stats.splitAliasesAttempted++;

        try {
          // ON CONFLICT against the partial unique index. Since every
          // row we insert has source='legacy_column' (which is in the
          // index's predicate), the conflict target matches.
          const result = await pool.query(
            `INSERT INTO company_financial_aliases
                (org_id, company_id, alias, alias_normalized, source, created_by_user_id)
             VALUES ($1, $2, $3, $4, 'legacy_column', NULL)
             ON CONFLICT (org_id, alias_normalized) WHERE source <> 'heuristic'
             DO NOTHING`,
            [c.organization_id, c.id, raw, norm],
          );
          if (result.rowCount && result.rowCount > 0) {
            stats.rowsInserted++;
          } else {
            stats.rowsSkippedConflict++;
          }
        } catch (err) {
          stats.errors++;
          console.error(
            `[cfa-backfill] insert failed company=${c.id} alias=${JSON.stringify(raw)} err=${(err as Error).message}`,
          );
        }
      }
    }

    const { rows: countRows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM company_financial_aliases`,
    );
    const { rows: legacyRows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM company_financial_aliases
        WHERE source = 'legacy_column'`,
    );

    console.log("[cfa-backfill] done", {
      ...stats,
      tableTotalRows: Number(countRows[0].n),
      legacyColumnSourceRows: Number(legacyRows[0].n),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[cfa-backfill] fatal", err);
  process.exit(1);
});
