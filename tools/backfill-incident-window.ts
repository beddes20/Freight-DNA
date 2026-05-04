/**
 * One-shot backfill for the capture-first P0 incident window.
 *
 * Scope: inbound emails for Value Truck (org da3ed822-…) created between
 *        2026-04-30 00:00 UTC and 2026-05-05 00:00 UTC that
 *          (a) have no quote_opportunity row keyed off provider_message_id, AND
 *          (b) look like quote requests under the new contract
 *              (looksLikeQuoteCandidate=true OR subject regex hit).
 *
 * For each candidate the script:
 *   1. Loads the email_messages row.
 *   2. Calls `replayClassificationForReprocess` — the same primitive the
 *      admin replay endpoint uses, which runs `classifyOne` and therefore
 *      applies the post-fix routing_status contract end-to-end.
 *   3. Captures before/after diff so we can emit a per-day summary.
 *
 * Concurrency is bounded so we don't blow OpenAI rate limits.
 */
import { db } from "../server/storage";
import { emailMessages, quoteOpportunities } from "../shared/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { replayClassificationForReprocess } from "../server/services/inlineEmailClassifier";
import { looksLikeQuoteCandidate } from "../server/services/quoteEmailIngestion";

const ORG_ID = "da3ed822-8846-4435-bb13-3cc4bf26f71d";
const WINDOW_START = new Date("2026-04-30T00:00:00Z");
const WINDOW_END = new Date("2026-05-05T00:00:00Z");
const CONCURRENCY = parseInt(process.env.BACKFILL_CONCURRENCY ?? "6", 10);

type DayBucket = {
  day: string;
  attempted: number;
  newAutoCustomer: number;
  newNeedsRouting: number;
  newAutoCarrier: number;
  drops: Record<string, number>;
  errors: number;
};

const buckets = new Map<string, DayBucket>();
function bucket(day: string): DayBucket {
  let b = buckets.get(day);
  if (!b) {
    b = { day, attempted: 0, newAutoCustomer: 0, newNeedsRouting: 0, newAutoCarrier: 0, drops: {}, errors: 0 };
    buckets.set(day, b);
  }
  return b;
}

async function loadCandidates(): Promise<Array<{ id: string; day: string; providerMessageId: string | null; subject: string | null; body: string | null; fromEmail: string | null }>> {
  const rows = await db.execute<{ id: string; day: string; provider_message_id: string | null; subject: string | null; body: string | null; from_email: string | null }>(sql`
    SELECT em.id,
           to_char(em.created_at, 'YYYY-MM-DD') AS day,
           em.provider_message_id,
           em.subject,
           em.body,
           em.from_email
      FROM email_messages em
     WHERE em.org_id = ${ORG_ID}
       AND em.direction = 'inbound'
       AND em.created_at >= ${WINDOW_START.toISOString()}
       AND em.created_at <  ${WINDOW_END.toISOString()}
       AND NOT EXISTS (
         SELECT 1 FROM quote_opportunities q
          WHERE q.organization_id = em.org_id
            AND q.source_reference = em.provider_message_id
       )
     ORDER BY em.created_at ASC
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    day: r.day,
    providerMessageId: r.provider_message_id,
    subject: r.subject,
    body: r.body,
    fromEmail: r.from_email,
  }));
}

async function snapshotOpp(providerMessageId: string | null) {
  if (!providerMessageId) return null;
  const [row] = await db.select({ id: quoteOpportunities.id, routingStatus: quoteOpportunities.routingStatus })
    .from(quoteOpportunities)
    .where(and(eq(quoteOpportunities.organizationId, ORG_ID), eq(quoteOpportunities.sourceReference, providerMessageId)))
    .limit(1);
  return row ?? null;
}

async function snapshotDrop(messageId: string) {
  const rows = await db.execute<{ reason_code: string }>(sql`
    SELECT reason_code FROM quote_pipeline_drops
     WHERE org_id = ${ORG_ID} AND message_id = ${messageId}
       AND attempted_at > NOW() - INTERVAL '5 min'
     ORDER BY attempted_at DESC LIMIT 1
  `);
  return rows.rows[0]?.reason_code ?? null;
}

async function processOne(candidate: Awaited<ReturnType<typeof loadCandidates>>[number]) {
  const b = bucket(candidate.day);
  b.attempted++;
  try {
    // Only spend OpenAI tokens on rows that are actually quote-shaped
    if (!looksLikeQuoteCandidate(candidate.subject ?? "", candidate.body ?? "")) {
      return;
    }
    const [msgRow] = await db.select().from(emailMessages).where(eq(emailMessages.id, candidate.id)).limit(1);
    if (!msgRow) return;
    await replayClassificationForReprocess(msgRow);
    const opp = await snapshotOpp(candidate.providerMessageId);
    if (opp) {
      if (opp.routingStatus === "auto_customer") b.newAutoCustomer++;
      else if (opp.routingStatus === "needs_routing") b.newNeedsRouting++;
      else if (opp.routingStatus === "auto_carrier") b.newAutoCarrier++;
    } else {
      const dropReason = await snapshotDrop(candidate.id);
      if (dropReason) b.drops[dropReason] = (b.drops[dropReason] ?? 0) + 1;
    }
  } catch (err) {
    b.errors++;
    console.error(`[backfill] ${candidate.id} ${candidate.day} ${candidate.subject?.slice(0, 60)}: ${err instanceof Error ? err.message : err}`);
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (it: T) => Promise<void>) {
  let cursor = 0;
  let completed = 0;
  const total = items.length;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
      completed++;
      if (completed % 100 === 0) {
        console.log(`[backfill] progress ${completed}/${total} (${((completed / total) * 100).toFixed(1)}%)`);
      }
    }
  });
  await Promise.all(workers);
}

process.on("unhandledRejection", (e) => { console.error("[backfill] unhandledRejection:", e); });
process.on("uncaughtException", (e) => { console.error("[backfill] uncaughtException:", e); });
process.on("SIGHUP", () => { console.log("[backfill] SIGHUP ignored"); });

(async () => {
  console.log(`[backfill] window ${WINDOW_START.toISOString()} → ${WINDOW_END.toISOString()}`);
  console.log(`[backfill] org=${ORG_ID} concurrency=${CONCURRENCY}`);
  const candidates = await loadCandidates();
  console.log(`[backfill] ${candidates.length} candidate inbound emails without quote_opportunity`);
  const t0 = Date.now();
  await runWithConcurrency(candidates, CONCURRENCY, processOne);
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n[backfill] done in ${elapsedMin} min`);
  const days = Array.from(buckets.values()).sort((a, b) => a.day.localeCompare(b.day));
  console.log("\n=== PER-DAY SUMMARY ===");
  console.log("day        | attempted | auto_cust | needs_rt | auto_carr | drops               | errors");
  console.log("-----------|-----------|-----------|----------|-----------|---------------------|-------");
  for (const b of days) {
    const dropStr = Object.entries(b.drops).map(([k, v]) => `${k}:${v}`).join(",") || "-";
    console.log(`${b.day} | ${String(b.attempted).padStart(9)} | ${String(b.newAutoCustomer).padStart(9)} | ${String(b.newNeedsRouting).padStart(8)} | ${String(b.newAutoCarrier).padStart(9)} | ${dropStr.padEnd(19)} | ${b.errors}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
