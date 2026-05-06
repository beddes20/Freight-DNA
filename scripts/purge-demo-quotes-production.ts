/**
 * Production purge of demo quote_opportunity rows + their orphaned dim
 * rows (customers / carriers / reps / lane_groups / outcome_reasons).
 *
 * Wraps the same `purgeDemoSeed` service used by the admin endpoint
 *   POST /api/customer-quotes/purge-demo-seed
 * so it can be invoked from a shell against the production database.
 *
 * Demo signature (defined in server/services/customerQuotes.ts):
 *   - quote_opportunities.source_reference matches /^(EMAIL|TMS|CRM|MANUAL)-1\d{3}$/
 *   - dim rows whose names/codes/emails match the seeded values AND
 *     are orphaned after the opportunity delete
 *
 * Idempotent: a second run on a clean database is a no-op (every count
 * comes back zero).
 *
 * Usage:
 *   # dry-run preview against production (counts only, no writes)
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/purge-demo-quotes-production.ts --dry-run
 *
 *   # purge across every org on production
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/purge-demo-quotes-production.ts
 *
 *   # purge for one organization only
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/purge-demo-quotes-production.ts \
 *       --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 * Flags:
 *   --org-id=<uuid>   restrict to one organization (default: every org)
 *   --dry-run         report what *would* be deleted without writing
 *
 * Exit code:
 *   0 success
 *   1 unexpected error
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";
import { purgeDemoSeed } from "../server/services/customerQuotes";

interface Args { orgId?: string; dryRun: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") { out.dryRun = true; continue; }
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "org-id" && value) out.orgId = value;
  }
  return out;
}

// Mirrors the demo signature definitions in server/services/customerQuotes.ts.
// Kept duplicated (rather than imported) because they aren't exported from
// that module, and we don't want a refactor purely for a one-shot script.
const DEMO_SOURCE_REF_PATTERN = "^(EMAIL|TMS|CRM|MANUAL)-1\\d{3}$";

interface DryRunReport {
  organizationId: string | null;
  totalQuotes: number;
  demoQuotesBySignature: number;
  demoQuotesByCustomerName: number;
  rowsThatWouldDelete: number;
}

async function dryRunCount(orgId?: string): Promise<DryRunReport> {
  const orgFilter = orgId ? sql`AND organization_id = ${orgId}` : sql``;

  const total = await db.execute<{ c: string }>(sql`
    SELECT COUNT(*)::text AS c FROM quote_opportunities
     WHERE 1=1 ${orgFilter}
  `);

  const bySig = await db.execute<{ c: string }>(sql`
    SELECT COUNT(*)::text AS c FROM quote_opportunities
     WHERE source_reference ~ ${DEMO_SOURCE_REF_PATTERN}
       ${orgFilter}
  `);

  const byCustomer = await db.execute<{ c: string }>(sql`
    SELECT COUNT(*)::text AS c FROM quote_opportunities o
      JOIN quote_customers c ON c.id = o.customer_id
     WHERE c.name IN (
       'Aurora Foods','Northwind Industrial','Cascade Beverage Co',
       'Summit Building Products','Harbor Retail Group','Pioneer Auto Parts'
     )
       ${orgId ? sql`AND o.organization_id = ${orgId}` : sql``}
  `);

  return {
    organizationId: orgId ?? null,
    totalQuotes: Number(total.rows[0]?.c ?? 0),
    demoQuotesBySignature: Number(bySig.rows[0]?.c ?? 0),
    demoQuotesByCustomerName: Number(byCustomer.rows[0]?.c ?? 0),
    // The actual purge removes the source_reference signature set; demo
    // customers/carriers/reps/lane_groups/outcome_reasons are removed via
    // orphan check after that. So the meaningful count is the signature one.
    rowsThatWouldDelete: Number(bySig.rows[0]?.c ?? 0),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.dryRun) {
    console.log("[purge-demo-quotes] DRY RUN — no rows will be modified");
    const report = await dryRunCount(args.orgId);
    console.log(JSON.stringify(report, null, 2));
    console.log(
      "\nDemo rows match BY SIGNATURE (source_reference). The purge also " +
      "drops orphaned dim rows (customers/carriers/reps/lane groups/outcome " +
      "reasons) whose names match the demo set after opportunities are gone."
    );
    return;
  }

  console.log(
    args.orgId
      ? `[purge-demo-quotes] purging org ${args.orgId}…`
      : "[purge-demo-quotes] purging ALL organizations…"
  );

  const summary = await purgeDemoSeed(args.orgId);
  console.log(JSON.stringify(summary, null, 2));

  if (summary.opportunitiesDeleted === 0) {
    console.log("\nNo demo rows found — production is already clean.");
  } else {
    console.log(
      `\nDeleted ${summary.opportunitiesDeleted} demo quote opportunities ` +
      `+ ${summary.customersDeleted} customers, ${summary.carriersDeleted} carriers, ` +
      `${summary.repsDeleted} reps, ${summary.laneGroupsDeleted} lane groups, ` +
      `${summary.outcomeReasonsDeleted} outcome reasons.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[purge-demo-quotes] FAILED:", err);
    process.exit(1);
  });
