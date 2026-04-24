/**
 * Task #531 — One-shot backfill of `quote_opportunities` from historical
 * inbound `email_messages` on production.
 *
 * Wraps the same `backfillQuotesFromEmails` service used by the admin
 * endpoint POST /api/customer-quotes/backfill-from-emails so it can also
 * be invoked from a shell, which is convenient when:
 *   - the org has thousands of inbound messages and the run might exceed
 *     a typical request timeout, and / or
 *   - an admin wants to verify per-org summaries before re-running with
 *     a wider window.
 *
 * Idempotency: the underlying `ingestQuoteFromEmail` deduplicates on
 * (org, source=email, sourceReference). Re-running the script is safe;
 * already-ingested messages are reported as `duplicates`.
 *
 * Usage:
 *   # against the local dev database
 *   npx tsx scripts/backfill-quotes-from-emails.ts
 *
 *   # against production (uses Drizzle with DATABASE_URL — point it at
 *   # production by exporting PROD_URL into DATABASE_URL for this run)
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/backfill-quotes-from-emails.ts
 *
 *   # narrower scope
 *   npx tsx scripts/backfill-quotes-from-emails.ts \
 *     --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d \
 *     --since-days=365 --limit=5000
 *
 * Flags:
 *   --org-id=<uuid>     restrict to one organization (default: every org
 *                       with at least one inbound email_message). Recommended
 *                       for controlled production runs.
 *   --since-days=<n>    only consider messages received in the last n days
 *   --limit=<n>         cap the number of messages scanned PER ORG (the
 *                       cap is applied independently to each org, not to
 *                       the aggregate run)
 *
 * Exit code:
 *   0  every org completed without errors
 *   1  at least one org reported a non-zero `errors` count or threw
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";
import { backfillQuotesFromEmails, type BackfillSummary } from "../server/services/quoteEmailIngestion";

interface Args {
  orgId?: string;
  sinceDays?: number;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "org-id" && value) out.orgId = value;
    else if (key === "since-days") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.sinceDays = n;
    } else if (key === "limit") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    }
  }
  return out;
}

async function listOrgsWithInboundMail(): Promise<string[]> {
  const rows = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id
      FROM email_messages
     WHERE direction = 'inbound'
  `);
  return rows.rows.map(r => r.org_id).filter((v): v is string => !!v);
}

function fmtSummary(s: BackfillSummary): string {
  return `scanned=${s.scanned} ingested=${s.ingested} duplicates=${s.duplicates} `
    + `unparseable=${s.unparseable} outbound=${s.outbound} errors=${s.errors}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const orgIds = args.orgId ? [args.orgId] : await listOrgsWithInboundMail();

  if (orgIds.length === 0) {
    console.log("No organizations have inbound email_messages — nothing to do.");
    return;
  }

  console.log(`[backfill] orgs=${orgIds.length} sinceDays=${args.sinceDays ?? "∞"} limit=${args.limit ?? "∞"}`);
  const totals: BackfillSummary = {
    scanned: 0, ingested: 0, duplicates: 0, unparseable: 0, outbound: 0, errors: 0,
  };

  for (const orgId of orgIds) {
    const startedAt = Date.now();
    try {
      const summary = await backfillQuotesFromEmails(orgId, {
        sinceDays: args.sinceDays,
        limit: args.limit,
      });
      const ms = Date.now() - startedAt;
      console.log(`[backfill] org=${orgId} ${fmtSummary(summary)} (${ms}ms)`);
      totals.scanned += summary.scanned;
      totals.ingested += summary.ingested;
      totals.duplicates += summary.duplicates;
      totals.unparseable += summary.unparseable;
      totals.outbound += summary.outbound;
      totals.errors += summary.errors;
    } catch (err) {
      console.error(`[backfill] org=${orgId} FAILED:`, err);
      totals.errors++;
    }
  }

  console.log(`[backfill] total ${fmtSummary(totals)}`);
  // Surface partial failure to CI / shell automation.
  if (totals.errors > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
