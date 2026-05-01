/**
 * Conversation Thread Backfill Service (Task #285)
 *
 * Materialises `email_conversation_threads` rows for any (org_id, thread_id)
 * that has `email_messages` (and therefore possibly `email_signals`) but no
 * thread row yet. Without a thread row the conversation appears in drilldowns
 * as a synthetic `thread:<id>` orphan with no owner, waiting state, or
 * priority — reps can read but cannot act on it.
 *
 * Two entry points:
 *   - backfillMissingConversationThreads({ orgId? }) — bulk one-time / cron
 *   - materializeConversationThreadIfMissing(orgId, threadId) — on-demand
 *     guard used when an orphan id is accessed (and as a safety net inside
 *     ingestion).
 *
 * Both paths are idempotent: they only insert rows for threads that do not
 * yet have an `email_conversation_threads` record, and rely on a unique
 * (org_id, thread_id) constraint added in `runMigrations` to keep concurrent
 * inserts safe.
 */

import { storage, db } from "../storage";
import { sql } from "drizzle-orm";

export interface BackfillResult {
  scanned: number;
  inserted: number;
  durationMs: number;
}

export interface ReconcileDirectionResult {
  /** Number of (org_id, thread_id) pairs the aggregate considered. */
  scanned: number;
  /** Number of thread rows whose per-direction columns were re-anchored. */
  reconciled: number;
  durationMs: number;
}

export interface ReclassifyResult {
  /** Threads where linked_carrier_id was NULLed because the row already had a customer account. */
  threadsRepaired: number;
  /** Threads where linked_account_id was promoted from message-level evidence and the carrier link dropped. */
  threadsPromoted: number;
  messagesRepaired: number;
  durationMs: number;
}

/**
 * Task #727 — Customer-vs-carrier precedence fixup. Drops linked_carrier_id
 * on any existing thread (and any user-mailbox-lane email_message) where a
 * linked_account_id is set. The user-mailbox lane is identified by an
 * ingested_via value in ('delta','backfill','self_heal') — i.e., not a
 * shared-mailbox carrier-outreach insert. This is a one-time pass invoked
 * from the admin "Rebuild thread classification" action.
 */
export async function reclassifyThreadsCustomerWins(opts: {
  orgId?: string;
} = {}): Promise<ReclassifyResult> {
  const startedAt = Date.now();
  const orgId = opts.orgId ?? null;

  // Step 1: drop carrier id on threads that already have a customer account.
  // Task #860 — classification reclassify is a denormalization sweep, not
  // a real conversation event. It bumps `row_version_at` (the audit
  // clock) instead of `updated_at` so the user-visible freshness signal
  // still reflects actual email activity. See the contract in
  // shared/schema.ts; the guardrail in tests/code-quality-guardrails.test.ts
  // pins this site.
  const threadFix = await db.execute(sql`
    UPDATE email_conversation_threads
       SET linked_carrier_id = NULL,
           row_version_at = NOW()
     WHERE linked_account_id IS NOT NULL
       AND linked_carrier_id IS NOT NULL
       AND (${orgId}::text IS NULL OR org_id = ${orgId})
  `);

  // Step 2: promote linked_account_id from message-level evidence onto
  // threads that currently have only carrier linkage but contain at
  // least one message with a linked_account_id. This is the historical
  // mixed-evidence case: a thread was created carrier-first via the
  // shared-mailbox lane, then a later message carries customer evidence
  // (e.g. arrived through the user-mailbox lane). Without this step
  // those threads would stay incorrectly carrier-only and never appear
  // on the Email Intelligence customer leaderboard.
  // Task #860 — same contract as Step 1: this is a denormalization
  // sweep, not a real conversation event. Bumps `row_version_at` only
  // so the user-visible freshness signal stays honest.
  const threadPromote = await db.execute(sql`
    UPDATE email_conversation_threads ect
       SET linked_account_id = m.account_id,
           linked_carrier_id = NULL,
           row_version_at = NOW()
      FROM (
        SELECT em.org_id,
               em.thread_id,
               (ARRAY_AGG(em.linked_account_id ORDER BY em.created_at DESC)
                  FILTER (WHERE em.linked_account_id IS NOT NULL))[1] AS account_id
          FROM email_messages em
         WHERE em.linked_account_id IS NOT NULL
           AND em.thread_id IS NOT NULL
           AND (${orgId}::text IS NULL OR em.org_id = ${orgId})
         GROUP BY em.org_id, em.thread_id
      ) m
     WHERE ect.org_id = m.org_id
       AND ect.thread_id = m.thread_id
       AND ect.linked_account_id IS NULL
       AND ect.linked_carrier_id IS NOT NULL
  `);

  // Lane discriminator: the carrier shared-inbox lane (logInboundCarrierEmail)
  // always sets linked_outreach_log_id; the user-mailbox lane never does. Using
  // that as the gate (rather than ingested_via) means legacy rows that were
  // ingested before ingested_via existed (NULL) are also repaired. The
  // ingested_via fallback remains as a belt-and-braces signal in case a
  // future code path writes to email_messages without an outreach link.
  const msgFix = await db.execute(sql`
    UPDATE email_messages
       SET linked_carrier_id = NULL
     WHERE linked_account_id IS NOT NULL
       AND linked_carrier_id IS NOT NULL
       AND linked_outreach_log_id IS NULL
       AND (${orgId}::text IS NULL OR org_id = ${orgId})
  `);

  // node-postgres returns rowCount; drizzle's pg driver passes it through.
  type ExecResult = { rowCount?: number | null };
  const tCount = (threadFix as unknown as ExecResult).rowCount ?? 0;
  const mCount = (msgFix as unknown as ExecResult).rowCount ?? 0;

  type ExecResult2 = { rowCount?: number | null };
  const pCount = (threadPromote as unknown as ExecResult2).rowCount ?? 0;

  return {
    threadsRepaired: tCount,
    threadsPromoted: pCount,
    messagesRepaired: mCount,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Task #898 — Reconcile per-direction freshness columns to MAX(provider_sent_at).
 *
 * For every (org_id, thread_id) with at least one inbound message that
 * carries a real `provider_sent_at`, force
 *   `last_incoming_at = MAX(provider_sent_at WHERE direction = 'inbound')`
 * and the symmetric statement for outbound. Phase 1 of "Stop lying about
 * freshness." (Task #859) introduced a monotonic write for the
 * denormalized `last_email_at` column inside `applyMessageToThread`, but
 * the per-direction columns are still stamped *unconditionally* with the
 * incoming message's `providerSentAt`. An out-of-order delivery (mailbox
 * historical backfill, late webhook, replay) can therefore regress one of
 * those columns to an older timestamp than the true MAX — which is what
 * the conversations freshness regression suite
 * (`tests/conversations-freshness-regression.test.ts`) flagged on the
 * live app during the Task #862 QA pass (25 thread rows drifting by
 * seconds-to-minutes).
 *
 * The runMigrations.ts freshness backfill block (Task #859) already runs
 * the same statement once per boot, but only inside the schema-migration
 * lifecycle. Hosting it here as a named service entry point lets the boot
 * path (`server/index.ts`) invoke it alongside the orphan-thread
 * backfill, makes it reachable from admin tooling, and keeps the live
 * read-write reconciliation in the same module as the rest of the
 * thread-row maintenance sweeps.
 *
 * Idempotent — re-runs converge to zero rows touched. Per the Task #860
 * freshness contract this is a denormalization sweep (not a real
 * conversation event), so it bumps `row_version_at` only — `updated_at`
 * is intentionally left alone so the user-visible freshness signal keeps
 * reflecting actual conversation activity. The companion guardrail in
 * `tests/code-quality-guardrails.test.ts` pins both halves: the function
 * shape (MAX/FILTER per direction, row_version_at bump) and the boot
 * call site.
 */
export async function reconcileThreadDirectionTimestamps(opts: {
  orgId?: string;
} = {}): Promise<ReconcileDirectionResult> {
  const startedAt = Date.now();
  const orgId = opts.orgId ?? null;

  const result = await storage.pool.query(
    `
    WITH msg_max AS (
      SELECT em.org_id,
             em.thread_id,
             MAX(em.provider_sent_at) FILTER (WHERE em.direction = 'inbound')  AS max_in,
             MAX(em.provider_sent_at) FILTER (WHERE em.direction = 'outbound') AS max_out
        FROM email_messages em
       WHERE em.provider_sent_at IS NOT NULL
         AND em.thread_id IS NOT NULL
         AND ($1::text IS NULL OR em.org_id = $1)
       GROUP BY em.org_id, em.thread_id
    ),
    updated AS (
      UPDATE email_conversation_threads ect
         SET last_incoming_at = COALESCE(msg_max.max_in,  ect.last_incoming_at),
             last_outgoing_at = COALESCE(msg_max.max_out, ect.last_outgoing_at),
             -- Task #860 — denormalization sweep: bump the audit clock
             -- but leave updated_at alone. The user-visible freshness
             -- signal must keep reflecting real conversation activity.
             row_version_at   = NOW()
        FROM msg_max
       WHERE msg_max.org_id    = ect.org_id
         AND msg_max.thread_id = ect.thread_id
         AND (
              (msg_max.max_in  IS NOT NULL AND ect.last_incoming_at IS DISTINCT FROM msg_max.max_in)
           OR (msg_max.max_out IS NOT NULL AND ect.last_outgoing_at IS DISTINCT FROM msg_max.max_out)
         )
       RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM msg_max) AS scanned,
      (SELECT COUNT(*)::int FROM updated) AS reconciled
    `,
    [orgId],
  );

  const row = result.rows[0] ?? { scanned: 0, reconciled: 0 };
  return {
    scanned: Number(row.scanned ?? 0),
    reconciled: Number(row.reconciled ?? 0),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Insert missing thread rows for messages that don't yet have one.
 * Computes initial waiting state, last message timestamps, and overdueAt
 * (against the default "normal" 24h SLA) inline in SQL so a single round
 * trip handles arbitrarily many orphans.
 *
 * Owner is left null (unless the linked account has an assigned rep we can
 * inherit) — reps assign owners through the existing UI after backfill.
 */
export async function backfillMissingConversationThreads(opts: {
  orgId?: string;
} = {}): Promise<BackfillResult> {
  const startedAt = Date.now();

  // Candidate (org_id, thread_id) pairs come from BOTH email_messages AND
  // email_signals so signals-only threads (e.g., a signal whose underlying
  // message was pruned, or future ingestion paths that write signals before
  // the thread row) are not left orphaned. The aggregate columns still come
  // from email_messages so signals-only threads simply land with NULL
  // last-message metadata and the default waiting state.
  const sql = `
    WITH candidate_keys AS (
      SELECT em.org_id, em.thread_id
        FROM email_messages em
       WHERE em.thread_id IS NOT NULL AND em.org_id IS NOT NULL
         AND ($1::text IS NULL OR em.org_id = $1)
      UNION
      SELECT em.org_id, em.thread_id
        FROM email_signals es
        JOIN email_messages em ON em.id = es.message_id
       WHERE em.thread_id IS NOT NULL AND em.org_id IS NOT NULL
         AND ($1::text IS NULL OR em.org_id = $1)
    ),
    missing AS (
      SELECT
        ck.org_id,
        ck.thread_id,
        MAX(em.created_at) FILTER (WHERE em.direction = 'inbound')  AS last_incoming_at,
        MAX(em.created_at) FILTER (WHERE em.direction = 'outbound') AS last_outgoing_at,
        MAX(em.created_at) AS last_message_at,
        (ARRAY_AGG(em.direction       ORDER BY em.created_at DESC))[1] AS last_direction,
        (ARRAY_AGG(em.id              ORDER BY em.created_at DESC))[1] AS last_message_id,
        (ARRAY_AGG(em.linked_account_id ORDER BY em.created_at DESC)
           FILTER (WHERE em.linked_account_id IS NOT NULL))[1]         AS linked_account_id,
        (ARRAY_AGG(em.linked_carrier_id ORDER BY em.created_at DESC)
           FILTER (WHERE em.linked_carrier_id IS NOT NULL))[1]         AS linked_carrier_id
      FROM candidate_keys ck
      LEFT JOIN email_messages em
        ON em.org_id = ck.org_id AND em.thread_id = ck.thread_id
      WHERE NOT EXISTS (
        SELECT 1 FROM email_conversation_threads ect
        WHERE ect.org_id = ck.org_id AND ect.thread_id = ck.thread_id
      )
      GROUP BY ck.org_id, ck.thread_id
    ),
    inserted AS (
      INSERT INTO email_conversation_threads (
        org_id, thread_id, linked_account_id, linked_carrier_id,
        owner_user_id, waiting_state, response_priority, last_message_id,
        last_incoming_at, last_outgoing_at, last_email_at,
        waiting_since_at, overdue_at,
        created_at, updated_at
      )
      SELECT
        m.org_id,
        m.thread_id,
        m.linked_account_id,
        -- Task #727 — customer-vs-carrier precedence: when a thread has any
        -- linked_account_id evidence the carrier link is dropped. The
        -- customer lane always wins; carrier-only threads keep their id.
        CASE WHEN m.linked_account_id IS NOT NULL THEN NULL
             ELSE m.linked_carrier_id END AS linked_carrier_id,
        -- Inherit account owner if the account has one assigned to the same org.
        (
          SELECT c.assigned_to FROM companies c
          JOIN users u ON u.id = c.assigned_to
          WHERE c.id = m.linked_account_id AND u.organization_id = m.org_id
          LIMIT 1
        ) AS owner_user_id,
        CASE WHEN m.last_direction = 'inbound' THEN 'waiting_on_us' ELSE 'waiting_on_them' END AS waiting_state,
        'normal' AS response_priority,
        m.last_message_id,
        m.last_incoming_at,
        m.last_outgoing_at,
        -- Task #859 — denormalized "real email activity" timestamp seeded on
        -- insert so the date filter / sort sees freshness without a separate
        -- backfill pass when the row is first materialized. NULL-safe: bare
        -- GREATEST(a, b) returns NULL if either side is NULL in Postgres,
        -- so we COALESCE each arm so single-direction threads still get a
        -- non-NULL last_email_at and stay visible to the storage date filter.
        GREATEST(
          COALESCE(m.last_incoming_at, m.last_outgoing_at),
          COALESCE(m.last_outgoing_at, m.last_incoming_at)
        ) AS last_email_at,
        CASE WHEN m.last_direction = 'inbound' THEN m.last_incoming_at ELSE NULL END AS waiting_since_at,
        CASE
          WHEN m.last_direction = 'inbound'
           AND m.last_incoming_at IS NOT NULL
           AND m.last_incoming_at < NOW() - INTERVAL '24 hours'
          THEN m.last_incoming_at + INTERVAL '24 hours'
          ELSE NULL
        END AS overdue_at,
        m.last_message_at AS created_at,
        m.last_message_at AS updated_at
      FROM missing m
      ON CONFLICT (org_id, thread_id) DO NOTHING
      RETURNING id
    )
    SELECT
      (SELECT COUNT(*)::int FROM missing)  AS scanned,
      (SELECT COUNT(*)::int FROM inserted) AS inserted
  `;

  const result = await storage.pool.query(sql, [opts.orgId ?? null]);
  const row = result.rows[0] ?? { scanned: 0, inserted: 0 };
  return {
    scanned: Number(row.scanned ?? 0),
    inserted: Number(row.inserted ?? 0),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Ensure a conversation thread row exists for a single (orgId, threadId).
 * Performs a targeted single-pair upsert (no org-wide work) so it is safe
 * to call inline from request paths such as the messages drilldown.
 *
 * Returns the thread record (existing or freshly inserted), or undefined
 * when no `email_messages` / `email_signals` exist for that pair (nothing
 * to materialise).
 */
export async function materializeConversationThreadIfMissing(
  orgId: string,
  threadId: string,
): Promise<import("@shared/schema").EmailConversationThread | undefined> {
  const existing = await storage.getEmailConversationThreadByThreadId(orgId, threadId);
  if (existing) return existing;

  // Bail early if the pair has no messages AND no signals — nothing to
  // materialise. Cheap two-key existence check.
  const presence = await storage.pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM email_messages
                WHERE org_id = $1 AND thread_id = $2)               AS has_msg,
       EXISTS (SELECT 1 FROM email_signals es
                JOIN email_messages em ON em.id = es.message_id
                WHERE em.org_id = $1 AND em.thread_id = $2)         AS has_sig`,
    [orgId, threadId],
  );
  const { has_msg, has_sig } = presence.rows[0] ?? { has_msg: false, has_sig: false };
  if (!has_msg && !has_sig) return undefined;

  // Single-pair targeted insert — bounded work, race-safe via the
  // (org_id, thread_id) unique index added in runMigrations.
  await storage.pool.query(
    `
    WITH agg AS (
      SELECT
        $1::text AS org_id,
        $2::text AS thread_id,
        MAX(em.created_at) FILTER (WHERE em.direction = 'inbound')  AS last_incoming_at,
        MAX(em.created_at) FILTER (WHERE em.direction = 'outbound') AS last_outgoing_at,
        MAX(em.created_at) AS last_message_at,
        (ARRAY_AGG(em.direction       ORDER BY em.created_at DESC))[1] AS last_direction,
        (ARRAY_AGG(em.id              ORDER BY em.created_at DESC))[1] AS last_message_id,
        (ARRAY_AGG(em.linked_account_id ORDER BY em.created_at DESC)
           FILTER (WHERE em.linked_account_id IS NOT NULL))[1]         AS linked_account_id,
        (ARRAY_AGG(em.linked_carrier_id ORDER BY em.created_at DESC)
           FILTER (WHERE em.linked_carrier_id IS NOT NULL))[1]         AS linked_carrier_id
      FROM email_messages em
      WHERE em.org_id = $1 AND em.thread_id = $2
    )
    INSERT INTO email_conversation_threads (
      org_id, thread_id, linked_account_id, linked_carrier_id,
      owner_user_id, waiting_state, response_priority, last_message_id,
      last_incoming_at, last_outgoing_at, last_email_at,
      waiting_since_at, overdue_at,
      created_at, updated_at
    )
    SELECT
      agg.org_id,
      agg.thread_id,
      agg.linked_account_id,
      -- Task #727 — customer wins over carrier on mixed evidence.
      CASE WHEN agg.linked_account_id IS NOT NULL THEN NULL
           ELSE agg.linked_carrier_id END,
      (
        SELECT c.assigned_to FROM companies c
        JOIN users u ON u.id = c.assigned_to
        WHERE c.id = agg.linked_account_id AND u.organization_id = agg.org_id
        LIMIT 1
      ),
      CASE WHEN agg.last_direction = 'inbound' THEN 'waiting_on_us'
           WHEN agg.last_direction = 'outbound' THEN 'waiting_on_them'
           ELSE 'waiting_on_us' END,
      'normal',
      agg.last_message_id,
      agg.last_incoming_at,
      agg.last_outgoing_at,
      -- Task #859 — denormalized "real email activity" timestamp seeded on
      -- insert (single source of truth for the date filter / row label).
      -- NULL-safe — bare GREATEST(a, b) returns NULL if either side is NULL
      -- in Postgres, so single-direction threads must use COALESCE'd arms
      -- to land a non-NULL value the storage filter can see.
      GREATEST(
        COALESCE(agg.last_incoming_at, agg.last_outgoing_at),
        COALESCE(agg.last_outgoing_at, agg.last_incoming_at)
      ),
      CASE WHEN agg.last_direction = 'inbound' THEN agg.last_incoming_at ELSE NULL END,
      CASE
        WHEN agg.last_direction = 'inbound'
         AND agg.last_incoming_at IS NOT NULL
         AND agg.last_incoming_at < NOW() - INTERVAL '24 hours'
        THEN agg.last_incoming_at + INTERVAL '24 hours'
        ELSE NULL
      END,
      COALESCE(agg.last_message_at, NOW()),
      COALESCE(agg.last_message_at, NOW())
    FROM agg
    ON CONFLICT (org_id, thread_id) DO NOTHING
    `,
    [orgId, threadId],
  );

  return storage.getEmailConversationThreadByThreadId(orgId, threadId);
}
