/**
 * Backfill (Task #578): re-resolve customer names for any
 * quote_opportunity whose linked customer row matches a legacy free-mail
 * provider name ("Gmail", "Yahoo", "Outlook", "Hotmail", "Mac", "Pm", …).
 *
 * Wraps the same `backfillFreeMailCustomerNames` service used at task
 * completion so it can be invoked from a shell against any environment.
 *
 * Idempotent: re-running once everything has been migrated is a no-op
 * because the legacy provider-name rows no longer exist.
 *
 * Usage:
 *   # default — backfill across every org on the configured DATABASE_URL
 *   npx tsx scripts/backfill-quote-customer-names.ts
 *
 *   # one org only
 *   npx tsx scripts/backfill-quote-customer-names.ts \
 *     --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 *   # against production
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/backfill-quote-customer-names.ts
 */

import { db } from "../server/storage";
import { organizations } from "@shared/schema";
import { backfillFreeMailCustomerNames, type FreeMailBackfillSummary } from "../server/services/quoteEmailIngestion";

function parseArgs(argv: string[]): { orgId: string | null } {
  let orgId: string | null = null;
  for (const a of argv.slice(2)) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
  }
  return { orgId };
}

function fmt(s: FreeMailBackfillSummary): string {
  return `scanned=${s.scanned} relinked=${s.relinked} movedToUnknown=${s.movedToUnknown} unchanged=${s.unchanged} customerRowsDeleted=${s.customerRowsDeleted}`;
}

async function main() {
  const { orgId } = parseArgs(process.argv);

  let orgIds: string[];
  if (orgId) {
    orgIds = [orgId];
  } else {
    const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
    orgIds = rows.map((r) => r.id);
    console.log(`[backfill-quote-customer-names] processing ${orgIds.length} orgs`);
  }

  const totals: FreeMailBackfillSummary = {
    scanned: 0, relinked: 0, movedToUnknown: 0, unchanged: 0, customerRowsDeleted: 0,
  };
  for (const id of orgIds) {
    try {
      const summary = await backfillFreeMailCustomerNames(id);
      console.log(`[backfill-quote-customer-names] org=${id} ${fmt(summary)}`);
      totals.scanned += summary.scanned;
      totals.relinked += summary.relinked;
      totals.movedToUnknown += summary.movedToUnknown;
      totals.unchanged += summary.unchanged;
      totals.customerRowsDeleted += summary.customerRowsDeleted;
    } catch (err) {
      console.error(`[backfill-quote-customer-names] org=${id} FAILED`, err);
    }
  }
  console.log(`[backfill-quote-customer-names] totals ${fmt(totals)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-quote-customer-names] fatal", err);
  process.exit(1);
});
