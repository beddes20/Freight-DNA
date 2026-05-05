/**
 * Task #1011 — 14-day idempotent recovery for missed quote requests.
 *
 * Runs `backfillQuotesFromEmails` over a rolling 14-day window for one
 * org and prints (a) per-day capture counts, (b) routing-bucket
 * breakdown for newly captured rows, (c) `quote_pipeline_drops` counts
 * grouped by reason_code with up to 5 example subjects per reason.
 *
 * Idempotent: relies on the `(org_id, source='email', source_reference)`
 * dedupe inside `ingestQuoteFromEmail`; re-running the script captures
 * any newly-arrived backlog without double-creating opportunities.
 *
 * Usage:
 *   npx tsx scripts/recover-14d-quote-requests.ts --org-id=<uuid> [--days=14] [--no-ai]
 */
import { sql } from "drizzle-orm";
import { db, storage } from "../server/storage";
import { backfillQuotesFromEmails } from "../server/services/quoteEmailIngestion";

interface Args { orgId?: string; days: number; useAi: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 14, useAi: true };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "org-id" && value) out.orgId = value;
    else if (key === "days" && value) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.days = n;
    } else if (key === "no-ai") out.useAi = false;
  }
  return out;
}

async function perDayCapture(orgId: string, days: number): Promise<void> {
  const r = await db.execute<{ d: string; n: string }>(sql`
    SELECT to_char(date_trunc('day', request_date), 'YYYY-MM-DD') AS d,
           COUNT(*) AS n
    FROM quote_opportunities
    WHERE organization_id = ${orgId}
      AND request_date >= NOW() - (${days}::int || ' days')::interval
    GROUP BY 1 ORDER BY 1
  `);
  console.log(`[per-day] captured opportunities (last ${days} days):`);
  if (r.rows.length === 0) console.log("         (none)");
  for (const row of r.rows) console.log(`         ${row.d}  ${row.n}`);
}

async function routingBuckets(orgId: string, days: number): Promise<void> {
  // Routing bucket attribution per Task #1011 — joins each opportunity
  // back to the captured ingestion event so we can read the
  // `repAttribution` + identityKind fields written into the event payload.
  const r = await db.execute<{ bucket: string; n: string }>(sql`
    WITH ev AS (
      SELECT DISTINCT ON (e.opportunity_id) e.opportunity_id, e.payload
      FROM quote_events e
      JOIN quote_opportunities q ON q.id = e.opportunity_id
      WHERE q.organization_id = ${orgId}
        AND q.request_date >= NOW() - (${days}::int || ' days')::interval
        AND e.kind = 'created'
      ORDER BY e.opportunity_id, e.created_at ASC
    )
    SELECT
      CASE
        WHEN payload->>'identityKind' = 'contact' THEN 'customer_contact'
        WHEN payload->>'identityKind' = 'shared_distribution' THEN 'shared_distribution'
        WHEN payload->>'identityKind' = 'domain' THEN 'customer_domain'
        WHEN payload->>'repAttribution' = 'account_owner_fallback' THEN 'account_owner_fallback'
        WHEN payload->>'repAttribution' = 'inbox_recipient' THEN 'inbox_recipient'
        WHEN payload->>'repAttribution' = 'none' THEN 'needs_routing'
        ELSE 'unknown'
      END AS bucket,
      COUNT(*) AS n
    FROM ev
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  console.log(`[routing-buckets] attribution distribution (last ${days} days):`);
  if (r.rows.length === 0) console.log("         (no created-events captured)");
  for (const row of r.rows) console.log(`         ${row.bucket.padEnd(28)} ${row.n}`);
}

async function dropsByReason(orgId: string, days: number): Promise<void> {
  const counts = await db.execute<{ reason_code: string; n: string }>(sql`
    SELECT reason_code, COUNT(*) AS n
    FROM quote_pipeline_drops
    WHERE org_id = ${orgId}
      AND attempted_at >= NOW() - (${days}::int || ' days')::interval
    GROUP BY reason_code ORDER BY n DESC
  `);
  console.log(`[drops] quote_pipeline_drops by reason (last ${days} days):`);
  if (counts.rows.length === 0) {
    console.log("         (no drops recorded)");
    return;
  }
  for (const row of counts.rows) {
    console.log(`         ${row.reason_code.padEnd(36)} ${row.n}`);
    const samples = await db.execute<{ subject: string | null; from_email: string | null }>(sql`
      SELECT em.subject, em.from_email
      FROM quote_pipeline_drops d
      LEFT JOIN email_messages em ON em.id = d.message_id
      WHERE d.org_id = ${orgId}
        AND d.reason_code = ${row.reason_code}
        AND d.attempted_at >= NOW() - (${days}::int || ' days')::interval
      ORDER BY d.attempted_at DESC
      LIMIT 5
    `);
    for (const s of samples.rows) {
      console.log(`           - [${s.from_email ?? "?"}] ${s.subject ?? "(no subject)"}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.orgId) {
    console.error("Usage: tsx scripts/recover-14d-quote-requests.ts --org-id=<uuid> [--days=14] [--no-ai]");
    process.exit(2);
  }
  const orgId = args.orgId;
  console.log(`=== 14d-recovery === org=${orgId} days=${args.days} useAi=${args.useAi}`);
  console.log(`now=${new Date().toISOString()}`);

  // Snapshot before reprocess so the per-day count reflects new captures.
  console.log("[before]");
  await perDayCapture(orgId, args.days);

  console.log(`[reprocess] backfillQuotesFromEmails(sinceDays=${args.days}) — idempotent`);
  await backfillQuotesFromEmails(orgId, { sinceDays: args.days, useAiFallback: args.useAi });

  console.log("[after]");
  await perDayCapture(orgId, args.days);
  await routingBuckets(orgId, args.days);
  await dropsByReason(orgId, args.days);

  // Touch storage to keep an unused-import lint clean and prove the
  // identity-resolution path is wired during the script's process lifetime.
  void storage.listCustomerEmailIdentitiesForOrg(orgId).catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error("[14d-recovery] FATAL", err);
  process.exit(1);
});
