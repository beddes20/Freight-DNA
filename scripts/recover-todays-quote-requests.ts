/**
 * Diagnose and recover today's missing quote requests for one org.
 * Idempotent and safe to re-run.
 *
 * Default scope is conservative: a strict local-midnight ("today")
 * window applied to every mailbox the org has registered in
 * `monitored_mailboxes` — both per-user inboxes and the shared inbox
 * are represented uniformly in that table, so the audit + Graph
 * subscription remediation in step 1 covers both classes without a
 * separate code path. Use --since-days=N to widen the reprocess window
 * (rolling 24h × N) when chasing older drift. Per-bucket counts and
 * the parser-gate audit always use CURRENT_DATE so BEFORE/AFTER deltas
 * reflect "today" exactly regardless of the backfill window.
 *
 * Timezone note: "today" here is *server-local* (Postgres `CURRENT_DATE`
 * for the buckets, Node `new Date()` local for the strict-midnight
 * computation). When the affected org operates in a different
 * timezone than the database server, run with --since-days=2 to widen
 * the window and avoid clipping early-morning or late-night messages.
 *
 * Steps:
 *   1. Mailbox audit + ACTIVE Graph subscription remediation.
 *      Re-registers any mailbox whose subscription is missing or expires
 *      inside the next hour. With --enable-disabled, also flips
 *      `enabled=true` on disabled mailboxes before re-registering.
 *   2. Capture-leak queue inspection + leak-promotion reprocess via
 *      `ingestQuoteFromEmail` on each pending review.
 *   3. BEFORE per-bucket count of today's quote_opportunities (raw +
 *      customer-only chokepoint visible totals).
 *   4. Scoped reprocess via `backfillQuotesFromEmails`. Idempotent on
 *      (org, source='email', sourceReference). Defaults to today only.
 *   5. AFTER per-bucket count.
 *   6. Filter-endpoint verification: live `getSnapshot()` call with
 *      DEFAULT filters and CLEARED filters so the operator can see if
 *      a filter (saved view, mine-only, status=pending, etc.) is hiding
 *      rows that the data layer is reporting.
 *   7. Parser-gate audit: every today inbound bucketed by
 *      `isObviouslyNotAQuote` / `looksLikeQuoteCandidate` /
 *      `parseQuoteEmail` outcome, with sample subjects for follow-up,
 *      plus the residual orphan customer-quote-y thread sample.
 *   8. Final report: a five-line summary answering the operator's
 *      five questions (mailbox health, leak queue, recovery delta,
 *      filter visibility, parser follow-ups).
 *
 * Usage:
 *   npx tsx scripts/recover-todays-quote-requests.ts --org-id=<uuid> \
 *     [--since-days=N] [--no-ai] [--limit=N] [--no-remediate] \
 *     [--enable-disabled]
 *
 * Production:
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/recover-todays-quote-requests.ts --org-id=<uuid>
 */
import { sql } from "drizzle-orm";
import { db, storage } from "../server/storage";
import {
  backfillQuotesFromEmails,
  ingestQuoteFromEmail,
  isObviouslyNotAQuote,
  looksLikeQuoteCandidate,
  parseQuoteEmail,
  stripHtml,
} from "../server/services/quoteEmailIngestion";
import { getSnapshot, type QuoteFilters } from "../server/services/customerQuotes";
import { registerMailboxSubscription } from "../server/graphSubscriptionService";

interface Args {
  orgId?: string;
  sinceDays?: number;
  useAi: boolean;
  limit?: number;
  remediate: boolean;
  enableDisabled: boolean;
}

/**
 * Convert "from local midnight to now" into the fractional `sinceDays`
 * value `backfillQuotesFromEmails` expects. The cutoff math inside
 * backfill is `Date.now() - sinceDays * 86_400_000`, so any positive
 * fraction works. Pads by 1 minute so a sub-second drift between this
 * call and backfill doesn't quietly drop the earliest message.
 */
function hoursSinceLocalMidnightAsDays(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const ms = now.getTime() - midnight.getTime() + 60_000;
  return ms / 86_400_000;
}

interface FinalReport {
  mailboxesHealthy: number;
  mailboxesTotal: number;
  subscriptionsRegistered: number;
  leakReviewed: number;
  leakPromoted: number;
  oppsBefore: number;
  oppsAfter: number;
  visibleBefore: number;
  visibleAfter: number;
  defaultFilterPending: number;
  clearedFilterPending: number;
  parserParseOk: number;
  parserParseNull: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { useAi: true, remediate: true, enableDisabled: false };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "org-id" && value) out.orgId = value;
    else if (key === "since-days" && value) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.sinceDays = n;
    } else if (key === "limit" && value) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    } else if (key === "no-ai") {
      out.useAi = false;
    } else if (key === "no-remediate") {
      out.remediate = false;
    } else if (key === "enable-disabled") {
      out.enableDisabled = true;
    }
  }
  return out;
}

async function auditAndRemediateMailboxes(
  orgId: string, remediate: boolean, enableDisabled: boolean, report: FinalReport,
): Promise<void> {
  const r = await db.execute<{
    total: string; enabled: string; healthy: string; sync_ok: string;
    stale_15m: string; stale_60m: string; active_inbox_sub: string;
    has_sent_sub: string; oldest_sync: string | null; newest_sync: string | null;
    soonest_sub_expiry: string | null;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE enabled) AS enabled,
      COUNT(*) FILTER (WHERE health_status='healthy') AS healthy,
      COUNT(*) FILTER (WHERE sync_status='active') AS sync_ok,
      COUNT(*) FILTER (WHERE last_sync_at < NOW() - INTERVAL '15 minutes') AS stale_15m,
      COUNT(*) FILTER (WHERE last_sync_at < NOW() - INTERVAL '60 minutes') AS stale_60m,
      COUNT(*) FILTER (WHERE subscription_id IS NOT NULL AND subscription_expires_at > NOW()) AS active_inbox_sub,
      COUNT(*) FILTER (WHERE sent_items_subscription_id IS NOT NULL) AS has_sent_sub,
      MIN(last_sync_at) AS oldest_sync,
      MAX(last_sync_at) AS newest_sync,
      MIN(subscription_expires_at) AS soonest_sub_expiry
    FROM monitored_mailboxes
    WHERE org_id=${orgId}
  `);
  const row = r.rows[0];
  if (!row) {
    console.log("[1/8] mailbox audit: no monitored_mailboxes for this org");
    return;
  }
  report.mailboxesTotal = Number(row.total);
  report.mailboxesHealthy = Number(row.healthy);
  console.log(`[1/8] mailbox audit: total=${row.total} enabled=${row.enabled} healthy=${row.healthy} `
    + `sync_active=${row.sync_ok} stale>15m=${row.stale_15m} stale>60m=${row.stale_60m} `
    + `active_inbox_sub=${row.active_inbox_sub} has_sent_sub=${row.has_sent_sub} `
    + `oldest_sync=${row.oldest_sync ?? "null"} newest_sync=${row.newest_sync ?? "null"} `
    + `soonest_sub_expiry=${row.soonest_sub_expiry ?? "null"}`);

  if (enableDisabled) {
    const flipped = await db.execute<{ id: string; email: string }>(sql`
      UPDATE monitored_mailboxes SET enabled=true, updated_at=NOW()
      WHERE org_id=${orgId} AND NOT enabled
      RETURNING id, email
    `);
    if (flipped.rows.length > 0) {
      console.log(`       --enable-disabled flipped ${flipped.rows.length} mailbox(es) on:`);
      for (const m of flipped.rows) console.log(`         + ${m.email}`);
    }
  }

  const needsRemediation = await db.execute<{
    id: string; email: string; subscription_id: string | null;
    subscription_expires_at: string | null;
  }>(sql`
    SELECT id, email, subscription_id, subscription_expires_at
    FROM monitored_mailboxes
    WHERE org_id=${orgId} AND enabled
      AND (subscription_id IS NULL
        OR subscription_expires_at IS NULL
        OR subscription_expires_at <= NOW() + INTERVAL '1 hour')
    ORDER BY subscription_expires_at NULLS FIRST
    LIMIT 100
  `);
  if (needsRemediation.rows.length === 0) {
    console.log("       all enabled mailboxes have a Graph subscription valid > 1h");
    return;
  }
  console.log(`       ${needsRemediation.rows.length} mailbox(es) need Graph subscription (re-)registration`);
  if (!remediate) {
    console.log("       --no-remediate set; skipping registerMailboxSubscription");
    return;
  }
  let registered = 0;
  let failed = 0;
  for (const m of needsRemediation.rows) {
    try {
      const subId = await registerMailboxSubscription(m.email, m.id);
      if (subId) {
        registered++;
        console.log(`         + ${m.email} → subscription ${subId}`);
      } else {
        failed++;
        console.log(`         × ${m.email} (registerMailboxSubscription returned null — see syncError on row)`);
      }
    } catch (err) {
      failed++;
      console.log(`         × ${m.email} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.subscriptionsRegistered = registered;
  console.log(`       remediation: registered=${registered} failed=${failed}`);
}

/**
 * Per-mailbox health line items. Surfaces, for each enabled mailbox in
 * the org, whether its Inbox and SentItems Graph subscriptions are
 * present + valid + recently delivering, so the operator gets explicit
 * pass/fail rows for the reporting user and the shared inbox without
 * having to cross-reference the aggregate audit numbers.
 */
async function perMailboxHealth(orgId: string): Promise<void> {
  const r = await db.execute<{
    email: string; enabled: boolean; health_status: string;
    last_sync_at: string | null; subscription_id: string | null;
    subscription_expires_at: string | null;
    sent_items_subscription_id: string | null;
    last_inbox_notification_at: string | null;
    last_sent_items_notification_at: string | null;
  }>(sql`
    SELECT email, enabled, health_status, last_sync_at,
      subscription_id, subscription_expires_at, sent_items_subscription_id,
      last_inbox_notification_at, last_sent_items_notification_at
    FROM monitored_mailboxes
    WHERE org_id=${orgId}
    ORDER BY enabled DESC, email ASC
  `);
  console.log(`       per-mailbox health (${r.rows.length} row(s)):`);
  for (const m of r.rows) {
    const inboxOk = m.subscription_id && m.subscription_expires_at && new Date(m.subscription_expires_at) > new Date();
    const sentOk = !!m.sent_items_subscription_id;
    const verdict = m.enabled && m.health_status === "healthy" && inboxOk ? "OK " : "FAIL";
    console.log(`         [${verdict}] ${m.email}  enabled=${m.enabled} health=${m.health_status} `
      + `inbox_sub=${inboxOk ? "valid" : "MISSING/EXPIRED"} sent_sub=${sentOk ? "yes" : "no"} `
      + `last_sync=${m.last_sync_at ?? "never"}`);
  }
}

async function reprocessLeakQueue(orgId: string, useAi: boolean, report: FinalReport): Promise<void> {
  const counts = await db.execute<{ total: string; pending_review: string; decided: string }>(sql`
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE decision IS NULL) AS pending_review,
      COUNT(*) FILTER (WHERE decision IS NOT NULL) AS decided
    FROM capture_leak_reviews
    WHERE organization_id=${orgId}
  `);
  const c = counts.rows[0] ?? { total: "0", pending_review: "0", decided: "0" };
  console.log(`[2/8] capture_leak_reviews: total=${c.total} pending_review=${c.pending_review} decided=${c.decided}`);
  if (Number(c.pending_review) === 0) {
    console.log("       nothing to promote");
    return;
  }
  const pending = await db.execute<{ message_id: string }>(sql`
    SELECT message_id FROM capture_leak_reviews
    WHERE organization_id=${orgId} AND decision IS NULL
    ORDER BY updated_at DESC LIMIT 200
  `);
  let promoted = 0;
  let stillLeaked = 0;
  let errors = 0;
  for (const row of pending.rows) {
    try {
      const msg = await storage.getEmailMessage(row.message_id);
      if (!msg) continue;
      const result = await ingestQuoteFromEmail(msg, { useAiFallback: useAi });
      if (result.status === "ingested") promoted++;
      else stillLeaked++;
    } catch {
      errors++;
    }
  }
  report.leakReviewed = pending.rows.length;
  report.leakPromoted = promoted;
  console.log(`       leak-promotion reprocess: promoted=${promoted} still_leaked=${stillLeaked} errors=${errors}`);
}

interface BucketCounts {
  opps_today: string;
  src_email: string;
  src_email_signal: string;
  src_other: string;
  pending: string;
  no_response: string;
  won: string;
  visible_total: string;
  visible_pending: string;
  visible_won: string;
}

async function snapshotBuckets(orgId: string, label: string): Promise<BucketCounts | null> {
  const r = await db.execute<BucketCounts>(sql`
    WITH carrier_names AS (
      SELECT LOWER(TRIM(name)) AS n FROM quote_carriers WHERE organization_id=${orgId}
    ),
    carrier_domains AS (
      SELECT DISTINCT LOWER(SPLIT_PART(primary_email,'@',2)) AS d
      FROM carriers WHERE org_id=${orgId} AND primary_email IS NOT NULL
      UNION
      SELECT DISTINCT LOWER(SPLIT_PART(backup_email,'@',2)) AS d
      FROM carriers WHERE org_id=${orgId} AND backup_email IS NOT NULL
    ),
    carrier_mapped AS (
      SELECT DISTINCT customer_id FROM quote_sender_mappings
      WHERE organization_id=${orgId}
        AND sender_domain IN (SELECT d FROM carrier_domains WHERE d IS NOT NULL AND d <> '')
    ),
    noncust AS (
      SELECT id FROM quote_customers
      WHERE organization_id=${orgId}
        AND (party_type <> 'customer'
          OR LOWER(name) IN (SELECT n FROM carrier_names WHERE n <> '')
          OR id IN (SELECT customer_id FROM carrier_mapped)
          OR name ~* '\m(freight|logistics|trucking|transport|express|carriers?|carrier)\M')
    )
    SELECT
      COUNT(*) AS opps_today,
      COUNT(*) FILTER (WHERE source='email') AS src_email,
      COUNT(*) FILTER (WHERE source='email_signal') AS src_email_signal,
      COUNT(*) FILTER (WHERE source NOT IN ('email','email_signal')) AS src_other,
      COUNT(*) FILTER (WHERE outcome_status='pending') AS pending,
      COUNT(*) FILTER (WHERE outcome_status='no_response') AS no_response,
      COUNT(*) FILTER (WHERE outcome_status='won') AS won,
      COUNT(*) FILTER (WHERE customer_id NOT IN (SELECT id FROM noncust)) AS visible_total,
      COUNT(*) FILTER (WHERE outcome_status='pending' AND customer_id NOT IN (SELECT id FROM noncust)) AS visible_pending,
      COUNT(*) FILTER (WHERE outcome_status='won' AND customer_id NOT IN (SELECT id FROM noncust)) AS visible_won
    FROM quote_opportunities
    WHERE organization_id=${orgId} AND request_date >= CURRENT_DATE
  `);
  const row = r.rows[0];
  if (!row) {
    console.log(`[${label}] no opps today`);
    return null;
  }
  console.log(`[${label}] opps_today=${row.opps_today} src_email=${row.src_email} `
    + `src_email_signal=${row.src_email_signal} src_other=${row.src_other} `
    + `pending=${row.pending} no_response=${row.no_response} won=${row.won} | `
    + `visible_total=${row.visible_total} visible_pending=${row.visible_pending} visible_won=${row.visible_won}`);
  return row;
}

/**
 * Per-bucket sender/subject samples for today's recovered opportunities.
 * Lets the operator eyeball that the right kind of mail landed in each
 * bucket (carrier replies vs customer RFQs vs AI-fallback recoveries).
 */
async function sampleByBucket(orgId: string): Promise<void> {
  const buckets: Array<{ label: string; pred: ReturnType<typeof sql> }> = [
    { label: "src=email", pred: sql`source='email'` },
    { label: "src=email_signal", pred: sql`source='email_signal'` },
    { label: "outcome=pending", pred: sql`outcome_status='pending'` },
    { label: "outcome=won", pred: sql`outcome_status='won'` },
  ];
  console.log(`       per-bucket samples (today, up to 5 each):`);
  for (const b of buckets) {
    const r = await db.execute<{ subject: string | null; from_email: string | null }>(sql`
      SELECT em.subject, em.from_email
      FROM quote_opportunities q
      LEFT JOIN email_messages em ON em.provider_message_id = q.source_reference AND em.org_id=${orgId}
      WHERE q.organization_id=${orgId} AND q.request_date >= CURRENT_DATE AND ${b.pred}
      ORDER BY q.created_at DESC
      LIMIT 5
    `);
    console.log(`         [${b.label}] ${r.rows.length} sample(s):`);
    for (const row of r.rows) {
      console.log(`           - [${row.from_email ?? "?"}] ${row.subject ?? "(no subject)"}`);
    }
  }
}

async function verifyFilterEndpoints(orgId: string, report: FinalReport): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFilters: QuoteFilters = { startDate: today, endDate: today, outcomeStatus: "pending" };
  const clearedFilters: QuoteFilters = {};
  const [snapDefault, snapCleared] = await Promise.all([
    getSnapshot(orgId, defaultFilters),
    getSnapshot(orgId, clearedFilters),
  ]);
  report.defaultFilterPending = snapDefault.kpis.pending;
  report.clearedFilterPending = snapCleared.kpis.pending;
  console.log(`[6/8] filter-endpoint verification (live getSnapshot):`);
  console.log(`         DEFAULT (today + status=pending): total=${snapDefault.kpis.total} `
    + `pending=${snapDefault.kpis.pending} autoCapturedToday=${snapDefault.kpis.autoCapturedToday}`);
  console.log(`         CLEARED (no filters):              total=${snapCleared.kpis.total} `
    + `pending=${snapCleared.kpis.pending} autoCapturedToday=${snapCleared.kpis.autoCapturedToday}`);
  console.log(`         (DEFAULT object is the page's first-load preset — Mine-only / saved-view / `
    + `repId mappings live on the user session and are not modeled here.)`);
  if (snapDefault.kpis.pending === 0 && snapCleared.kpis.pending > 0) {
    console.log(`       ⚠ default filter is hiding ${snapCleared.kpis.pending} pending row(s) — `
      + `check Mine-only / saved view / date range on the operator's session`);
  }
}

async function parserGateAudit(orgId: string, report: FinalReport): Promise<void> {
  const inbound = await db.execute<{
    id: string; subject: string | null; body: string | null; from_email: string | null;
  }>(sql`
    SELECT id, subject, body, from_email
    FROM email_messages
    WHERE org_id=${orgId} AND direction='inbound' AND created_at >= CURRENT_DATE
  `);
  let total = 0;
  let obviousNot = 0;
  let notCandidate = 0;
  let parseFail = 0;
  let parseOk = 0;
  const parseFailSamples: string[] = [];
  for (const m of inbound.rows) {
    total++;
    const subject = m.subject ?? "";
    const cleanBody = stripHtml(m.body ?? "");
    if (isObviouslyNotAQuote(subject, cleanBody)) { obviousNot++; continue; }
    if (!looksLikeQuoteCandidate(subject, cleanBody)) { notCandidate++; continue; }
    const parsed = parseQuoteEmail({ subject, body: m.body ?? "" });
    if (parsed) {
      parseOk++;
    } else {
      parseFail++;
      if (parseFailSamples.length < 10) {
        parseFailSamples.push(`[${m.from_email ?? "?"}] ${subject}`);
      }
    }
  }
  report.parserParseOk = parseOk;
  report.parserParseNull = parseFail;
  console.log(`[7/8] parser-gate audit on today's ${total} inbound messages:`);
  console.log(`         isObviouslyNotAQuote → ${obviousNot} (skipped early)`);
  console.log(`         not a quote candidate → ${notCandidate} (no lane + no quote signal)`);
  console.log(`         passed gates, parseQuoteEmail succeeded → ${parseOk}`);
  console.log(`         passed gates, parseQuoteEmail returned null → ${parseFail} (handled by AI fallback in live path)`);
  if (parseFailSamples.length > 0) {
    console.log(`         sample of parse-null subjects (parser-rule follow-up candidates):`);
    for (const s of parseFailSamples) console.log(`           - ${s}`);
  }
  const orphans = await db.execute<{ subject: string; from_email: string }>(sql`
    WITH today_inbound AS (
      SELECT m.id, m.thread_id, m.subject, m.from_email
      FROM email_messages m
      WHERE m.org_id=${orgId} AND m.direction='inbound' AND m.created_at >= CURRENT_DATE
        AND m.from_email IS NOT NULL
        AND m.subject !~* 'rate confirmation|carrier setup|invoice|payment|paid|remit|w-?9|insurance|coi|bol|pod|booking conf|tracking|eta|appt|automatic reply'
        AND m.subject ~* 'quote|spot|tender|FTL|LTL|bid|RFP|RFQ|need|pricing|lane|haul|load|capacity|ship|pickup|deliver'
    )
    SELECT subject, from_email
    FROM today_inbound ti
    WHERE NOT EXISTS (
      SELECT 1 FROM email_messages sib
      JOIN quote_opportunities q
        ON q.organization_id=${orgId} AND q.source_reference = sib.provider_message_id
      WHERE sib.org_id=${orgId} AND sib.thread_id = ti.thread_id
    )
    LIMIT 10
  `);
  console.log(`       residual orphan customer-quote-y threads (${orphans.rows.length}):`);
  for (const row of orphans.rows) console.log(`         - [${row.from_email}] ${row.subject}`);
  if (orphans.rows.length === 0) {
    console.log("         (none — every quote-y inbound thread today is linked to an opportunity)");
  }
}

function printFinalReport(report: FinalReport): void {
  const oppsDelta = report.oppsAfter - report.oppsBefore;
  const visibleDelta = report.visibleAfter - report.visibleBefore;
  console.log("[8/8] final report:");
  console.log(`         Q1 mailbox + Graph subscription health:  ${report.mailboxesHealthy}/${report.mailboxesTotal} healthy; subscriptions registered this run: ${report.subscriptionsRegistered}`);
  console.log(`         Q2 capture-leak queue:                    ${report.leakReviewed} pending reviewed → ${report.leakPromoted} promoted to opportunities`);
  console.log(`         Q3 recovery delta (today):                opps ${report.oppsBefore} → ${report.oppsAfter} (Δ${oppsDelta >= 0 ? "+" : ""}${oppsDelta}); visible ${report.visibleBefore} → ${report.visibleAfter} (Δ${visibleDelta >= 0 ? "+" : ""}${visibleDelta})`);
  console.log(`         Q4 default-filter visibility:             default=${report.defaultFilterPending} pending vs cleared=${report.clearedFilterPending} pending`);
  console.log(`         Q5 parser follow-ups:                     ${report.parserParseOk} parsed deterministically, ${report.parserParseNull} fell through to AI fallback (sample above)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.orgId) {
    console.error("Usage: tsx scripts/recover-todays-quote-requests.ts --org-id=<uuid> [--since-days=N] "
      + "[--no-ai] [--limit=N] [--no-remediate] [--enable-disabled]");
    process.exit(2);
  }
  const orgId = args.orgId;
  const effectiveSinceDays = args.sinceDays ?? hoursSinceLocalMidnightAsDays();
  const sinceDaysLabel = args.sinceDays !== undefined
    ? `${args.sinceDays} (rolling 24h × N, opt-in)`
    : `${effectiveSinceDays.toFixed(3)} (strict local-midnight to now)`;
  console.log(`=== recover ===  org=${orgId} sinceDays=${sinceDaysLabel} `
    + `useAi=${args.useAi} limit=${args.limit ?? "∞"} remediate=${args.remediate} `
    + `enable-disabled=${args.enableDisabled}`);
  console.log(`now=${new Date().toISOString()}`);

  const report: FinalReport = {
    mailboxesHealthy: 0, mailboxesTotal: 0, subscriptionsRegistered: 0,
    leakReviewed: 0, leakPromoted: 0,
    oppsBefore: 0, oppsAfter: 0, visibleBefore: 0, visibleAfter: 0,
    defaultFilterPending: 0, clearedFilterPending: 0,
    parserParseOk: 0, parserParseNull: 0,
  };

  await auditAndRemediateMailboxes(orgId, args.remediate, args.enableDisabled, report);
  await perMailboxHealth(orgId);
  await reprocessLeakQueue(orgId, args.useAi, report);

  const before = await snapshotBuckets(orgId, "3/8 BEFORE");
  if (before) { report.oppsBefore = Number(before.opps_today); report.visibleBefore = Number(before.visible_total); }

  console.log(`[4/8] running backfillQuotesFromEmails (sinceDays=${effectiveSinceDays.toFixed(3)})…`);
  const t0 = Date.now();
  const summary = await backfillQuotesFromEmails(orgId, {
    sinceDays: effectiveSinceDays,
    useAiFallback: args.useAi,
    limit: args.limit,
    concurrency: 5,
  });
  const ms = Date.now() - t0;
  console.log(`       (${ms}ms) scanned=${summary.scanned} ingested=${summary.ingested} `
    + `duplicates=${summary.duplicates} unparseable=${summary.unparseable} `
    + `outbound=${summary.outbound} errors=${summary.errors}`);

  const after = await snapshotBuckets(orgId, "5/8 AFTER ");
  if (after) { report.oppsAfter = Number(after.opps_today); report.visibleAfter = Number(after.visible_total); }

  await sampleByBucket(orgId);
  await verifyFilterEndpoints(orgId, report);
  await parserGateAudit(orgId, report);
  printFinalReport(report);

  console.log("=== done ===");
  if (summary.errors > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[recover] fatal:", err);
    process.exit(1);
  });
