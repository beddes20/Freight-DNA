/**
 * Backfill (Task #587): rewrite legacy customer-name strings already saved
 * in the database through `formatCustomerName` from `shared/laneFormatters.ts`.
 *
 * Customer names are now cleaned at render time everywhere they appear, but
 * the underlying columns may still contain raw TMS code-prefixed labels
 * (e.g. "BLOOSACA - Bloom Energy", "VERTFOFL-Vertiv Mexico", "CTSI C/O Rheem").
 * This one-time backfill normalizes them so filters, exports, search, and any
 * future report that touches the raw column sees the same clean values that
 * the UI shows.
 *
 * Tables touched:
 *   - companies.name
 *   - recurring_lanes.company_name
 *   - lane_summary_cache.company_name
 *
 * Note: `freight_opportunities` does NOT have a denormalized `company_name`
 * column — every freight opportunity references its customer via
 * `freight_opportunities.company_id → companies.id`, so cleaning
 * `companies.name` covers it transitively. The audit at the end joins
 * freight_opportunities → companies to confirm zero remaining offenders.
 *
 * Idempotent: safe to run twice. `formatCustomerName` is idempotent already,
 * so the second pass updates zero rows.
 *
 * Usage:
 *   # default — backfill across the configured DATABASE_URL
 *   npx tsx scripts/backfill-customer-names.ts
 *
 *   # dry-run preview (audit + count only, no writes)
 *   npx tsx scripts/backfill-customer-names.ts --dry-run
 *
 *   # restrict to one organization (companies via organization_id,
 *   # recurring_lanes via org_id, lane_summary_cache via JOIN to its
 *   # parent recurring_lane.org_id — the cache's own org_id column is
 *   # denormalized + nullable so the FK is the source of truth)
 *   npx tsx scripts/backfill-customer-names.ts \
 *     --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 *   # against production
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/backfill-customer-names.ts
 *
 * Exit code:
 *   0 success (audit clean)
 *   1 unexpected error OR audit shows remaining offenders after the run
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../server/storage";
import {
  companies,
  recurringLanes,
  laneSummaryCache,
} from "@shared/schema";
import { formatCustomerName } from "@shared/laneFormatters";

interface Args {
  orgId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { orgId: null, dryRun: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "org-id") out.orgId = value.trim() || null;
  }
  return out;
}

interface TableStats {
  table: string;
  scanned: number;
  updated: number;
  unchanged: number;
  emptyOrNull: number;
}

function emptyStats(name: string): TableStats {
  return { table: name, scanned: 0, updated: 0, unchanged: 0, emptyOrNull: 0 };
}

function fmt(s: TableStats): string {
  return `scanned=${s.scanned} updated=${s.updated} unchanged=${s.unchanged} emptyOrNull=${s.emptyOrNull}`;
}

/**
 * Regex used by the audit to detect any row whose name still matches the
 * legacy "<4+ alnum code> - <name>" prefix pattern. Mirrors the first
 * sanitizer in `cleanCustomerLabel`. The Postgres flavor below uses a
 * POSIX class because PG `~` does not understand `\s` / `[A-Za-z0-9]`.
 */
const AUDIT_REGEX_PG = "^[[:alnum:]]{4,}[[:space:]]+[-–—][[:space:]]+";

async function backfillCompanies(orgId: string | null, dryRun: boolean): Promise<TableStats> {
  const stats = emptyStats("companies.name");
  const rows = orgId
    ? await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.organizationId, orgId))
    : await db.select({ id: companies.id, name: companies.name }).from(companies);

  for (const row of rows) {
    stats.scanned += 1;
    const raw = row.name;
    if (raw == null || raw.trim() === "") {
      stats.emptyOrNull += 1;
      continue;
    }
    const next = formatCustomerName(raw);
    // Preserve a sensible fallback if formatter strips everything (e.g. raw
    // was nothing but a code with no human name). Skip rather than wipe a
    // NOT NULL column.
    if (!next) {
      stats.emptyOrNull += 1;
      continue;
    }
    if (next === raw) {
      stats.unchanged += 1;
      continue;
    }
    if (!dryRun) {
      await db.update(companies).set({ name: next }).where(eq(companies.id, row.id));
    }
    stats.updated += 1;
  }
  return stats;
}

async function backfillRecurringLanes(orgId: string | null, dryRun: boolean): Promise<TableStats> {
  const stats = emptyStats("recurring_lanes.company_name");
  const rows = orgId
    ? await db
        .select({ id: recurringLanes.id, companyName: recurringLanes.companyName })
        .from(recurringLanes)
        .where(eq(recurringLanes.orgId, orgId))
    : await db
        .select({ id: recurringLanes.id, companyName: recurringLanes.companyName })
        .from(recurringLanes);

  for (const row of rows) {
    stats.scanned += 1;
    const raw = row.companyName;
    if (raw == null || raw.trim() === "") {
      stats.emptyOrNull += 1;
      continue;
    }
    const next = formatCustomerName(raw);
    if (next === raw) {
      stats.unchanged += 1;
      continue;
    }
    // company_name is nullable — if the formatter returns "", store NULL
    // rather than an empty string so the column shape stays consistent.
    const value = next === "" ? null : next;
    if (!dryRun) {
      await db
        .update(recurringLanes)
        .set({ companyName: value })
        .where(eq(recurringLanes.id, row.id));
    }
    stats.updated += 1;
  }
  return stats;
}

async function backfillLaneSummaryCache(orgId: string | null, dryRun: boolean): Promise<TableStats> {
  const stats = emptyStats("lane_summary_cache.company_name");
  // For org-scoped runs we join through recurring_lanes rather than filtering
  // on lane_summary_cache.org_id directly, because that denormalized column
  // is nullable and historical cache rows may have a NULL org_id even though
  // they belong to a lane in this org. The lane FK is the source of truth.
  const rows = orgId
    ? await db
        .select({ laneId: laneSummaryCache.laneId, companyName: laneSummaryCache.companyName })
        .from(laneSummaryCache)
        .innerJoin(recurringLanes, eq(recurringLanes.id, laneSummaryCache.laneId))
        .where(eq(recurringLanes.orgId, orgId))
    : await db
        .select({ laneId: laneSummaryCache.laneId, companyName: laneSummaryCache.companyName })
        .from(laneSummaryCache);

  for (const row of rows) {
    stats.scanned += 1;
    const raw = row.companyName;
    if (raw == null || raw.trim() === "") {
      stats.emptyOrNull += 1;
      continue;
    }
    const next = formatCustomerName(raw);
    if (next === raw) {
      stats.unchanged += 1;
      continue;
    }
    const value = next === "" ? null : next;
    if (!dryRun) {
      await db
        .update(laneSummaryCache)
        .set({ companyName: value })
        .where(eq(laneSummaryCache.laneId, row.laneId));
    }
    stats.updated += 1;
  }
  return stats;
}

interface AuditRow {
  table: string;
  remaining: number;
  sample: string[];
}

async function audit(orgId: string | null): Promise<AuditRow[]> {
  // companies.name
  const companiesAudit = orgId
    ? await db.execute(sql`
        SELECT name FROM companies
        WHERE organization_id = ${orgId}
          AND name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `)
    : await db.execute(sql`
        SELECT name FROM companies
        WHERE name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `);
  const companiesCount = orgId
    ? await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM companies
        WHERE organization_id = ${orgId}
          AND name ~ ${AUDIT_REGEX_PG}
      `)
    : await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM companies
        WHERE name ~ ${AUDIT_REGEX_PG}
      `);

  // recurring_lanes.company_name
  const lanesAudit = orgId
    ? await db.execute(sql`
        SELECT company_name FROM recurring_lanes
        WHERE org_id = ${orgId}
          AND company_name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `)
    : await db.execute(sql`
        SELECT company_name FROM recurring_lanes
        WHERE company_name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `);
  const lanesCount = orgId
    ? await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM recurring_lanes
        WHERE org_id = ${orgId}
          AND company_name ~ ${AUDIT_REGEX_PG}
      `)
    : await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM recurring_lanes
        WHERE company_name ~ ${AUDIT_REGEX_PG}
      `);

  // lane_summary_cache.company_name — org-scoped via the recurring_lanes
  // FK (the cache's own org_id is denormalized + nullable; see the
  // matching note on backfillLaneSummaryCache).
  const cacheAudit = orgId
    ? await db.execute(sql`
        SELECT lsc.company_name
        FROM lane_summary_cache lsc
        JOIN recurring_lanes rl ON rl.id = lsc.lane_id
        WHERE rl.org_id = ${orgId}
          AND lsc.company_name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `)
    : await db.execute(sql`
        SELECT company_name FROM lane_summary_cache
        WHERE company_name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `);
  const cacheCount = orgId
    ? await db.execute(sql`
        SELECT COUNT(*)::int AS c
        FROM lane_summary_cache lsc
        JOIN recurring_lanes rl ON rl.id = lsc.lane_id
        WHERE rl.org_id = ${orgId}
          AND lsc.company_name ~ ${AUDIT_REGEX_PG}
      `)
    : await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM lane_summary_cache
        WHERE company_name ~ ${AUDIT_REGEX_PG}
      `);

  // Cross-check: any freight_opportunity whose linked companies.name still
  // matches. Should be zero once companies have been cleaned.
  const freightAudit = orgId
    ? await db.execute(sql`
        SELECT c.name FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
        WHERE fo.org_id = ${orgId}
          AND c.name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `)
    : await db.execute(sql`
        SELECT c.name FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
        WHERE c.name ~ ${AUDIT_REGEX_PG}
        LIMIT 5
      `);
  const freightCount = orgId
    ? await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
        WHERE fo.org_id = ${orgId}
          AND c.name ~ ${AUDIT_REGEX_PG}
      `)
    : await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
        WHERE c.name ~ ${AUDIT_REGEX_PG}
      `);

  const pickRows = (r: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
    if (r && typeof r === "object" && "rows" in r) {
      const rows = (r as { rows: unknown }).rows;
      return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    }
    return [];
  };

  const firstCount = (r: unknown): number => {
    const rows = pickRows(r);
    if (rows.length === 0) return 0;
    const v = rows[0].c;
    return typeof v === "number" ? v : Number(v ?? 0);
  };

  const sampleNames = (r: unknown, key: string): string[] =>
    pickRows(r)
      .map((row) => row[key])
      .filter((v): v is string => typeof v === "string" && v.length > 0);

  return [
    {
      table: "companies.name",
      remaining: firstCount(companiesCount),
      sample: sampleNames(companiesAudit, "name"),
    },
    {
      table: "recurring_lanes.company_name",
      remaining: firstCount(lanesCount),
      sample: sampleNames(lanesAudit, "company_name"),
    },
    {
      table: "lane_summary_cache.company_name",
      remaining: firstCount(cacheCount),
      sample: sampleNames(cacheAudit, "company_name"),
    },
    {
      table: "freight_opportunities → companies.name",
      remaining: firstCount(freightCount),
      sample: sampleNames(freightAudit, "name"),
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  const scope = args.orgId ? `org=${args.orgId}` : "all-orgs";
  const mode = args.dryRun ? "DRY-RUN" : "WRITE";
  console.log(`[backfill-customer-names] starting (${scope}, ${mode})`);

  const before = await audit(args.orgId);
  console.log("[backfill-customer-names] pre-run audit:");
  for (const a of before) {
    const sample = a.sample.length ? ` sample=${JSON.stringify(a.sample)}` : "";
    console.log(`  ${a.table}: ${a.remaining} offending rows${sample}`);
  }

  const stats: TableStats[] = [];
  stats.push(await backfillCompanies(args.orgId, args.dryRun));
  console.log(`[backfill-customer-names] ${stats[stats.length - 1].table}: ${fmt(stats[stats.length - 1])}`);

  stats.push(await backfillRecurringLanes(args.orgId, args.dryRun));
  console.log(`[backfill-customer-names] ${stats[stats.length - 1].table}: ${fmt(stats[stats.length - 1])}`);

  stats.push(await backfillLaneSummaryCache(args.orgId, args.dryRun));
  console.log(`[backfill-customer-names] ${stats[stats.length - 1].table}: ${fmt(stats[stats.length - 1])}`);

  const after = await audit(args.orgId);
  console.log(`[backfill-customer-names] post-run audit (${args.dryRun ? "dry-run, expect unchanged" : "expect zero"}):`);
  let remaining = 0;
  for (const a of after) {
    const sample = a.sample.length ? ` sample=${JSON.stringify(a.sample)}` : "";
    console.log(`  ${a.table}: ${a.remaining} offending rows${sample}`);
    remaining += a.remaining;
  }

  const totals = stats.reduce(
    (acc, s) => ({
      scanned: acc.scanned + s.scanned,
      updated: acc.updated + s.updated,
      unchanged: acc.unchanged + s.unchanged,
      emptyOrNull: acc.emptyOrNull + s.emptyOrNull,
    }),
    { scanned: 0, updated: 0, unchanged: 0, emptyOrNull: 0 },
  );
  console.log(
    `[backfill-customer-names] totals scanned=${totals.scanned} updated=${totals.updated} unchanged=${totals.unchanged} emptyOrNull=${totals.emptyOrNull}`,
  );

  if (!args.dryRun && remaining > 0) {
    console.error(
      `[backfill-customer-names] FAIL: ${remaining} rows still match the legacy code-prefix pattern after the backfill`,
    );
    process.exit(1);
  }

  console.log("[backfill-customer-names] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-customer-names] fatal", err);
  process.exit(1);
});
