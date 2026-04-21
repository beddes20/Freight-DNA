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

import { storage } from "../storage";

export interface BackfillResult {
  scanned: number;
  inserted: number;
  durationMs: number;
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
        last_incoming_at, last_outgoing_at, waiting_since_at, overdue_at,
        created_at, updated_at
      )
      SELECT
        m.org_id,
        m.thread_id,
        m.linked_account_id,
        m.linked_carrier_id,
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
      last_incoming_at, last_outgoing_at, waiting_since_at, overdue_at,
      created_at, updated_at
    )
    SELECT
      agg.org_id,
      agg.thread_id,
      agg.linked_account_id,
      agg.linked_carrier_id,
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
