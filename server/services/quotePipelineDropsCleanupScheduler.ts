/**
 * Task #969 — Customer Quotes trust hardening (defect 4).
 *
 * Daily soft-archive of `quote_pipeline_drops` rows older than 30 days.
 *
 * Why a soft-archive (set `archived_at = now()`) rather than DELETE:
 *   - The drops table doubles as the audit trail for the email → quote
 *     pipeline. Operators occasionally need to look back at a 6-month-old
 *     classifier_miss to understand a recurring failure pattern.
 *   - Archived rows are excluded from the default operator queue
 *     (`/api/admin/quote-pipeline/drops` filters `archived_at IS NULL` by
 *     default) so the page stays fast on orgs with 10k+ historical drops.
 *   - Admins opt-in to the historical tail with `?include_archived=1` and
 *     the matching "Include archived" toggle on `admin-quote-pipeline-
 *     health.tsx`.
 *
 * The cron runs daily at 03:15 (off-peak for the data-refresh job at 07:00
 * and the leak console snapshot at 04:00). The query is partitioned per-
 * row by `attempted_at < now() - 30 days` so it terminates in O(rows-to-
 * archive) regardless of how many already-archived rows exist.
 */
import cron from "node-cron";
import { sql } from "drizzle-orm";
import { db } from "../storage";

const RETENTION_DAYS = 30;

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [quote-pipeline-drops-cleanup] ${message}`);
}

/**
 * Soft-archive every drop whose `attempted_at` is older than the
 * retention window AND that is not yet archived. Returns the number of
 * rows updated. Exposed for unit/integration tests so they can call the
 * job directly without going through the cron timer.
 */
export async function softArchiveOldQuotePipelineDrops(
  retentionDays: number = RETENTION_DAYS,
): Promise<number> {
  // Single-statement UPDATE … RETURNING is cheaper than two round-trips
  // (count then update) and stays consistent under concurrent writes
  // because the index `quote_pipeline_drops_org_archived_idx` already
  // covers the predicate.
  const result = await db.execute(sql`
    UPDATE quote_pipeline_drops
       SET archived_at = now()
     WHERE archived_at IS NULL
       AND attempted_at < now() - (${`${retentionDays} days`})::interval
    RETURNING id
  `);
  const rows = (result.rows ?? []) as Array<{ id: string }>;
  return rows.length;
}

export function initQuotePipelineDropsCleanupScheduler(): void {
  const cronExpression =
    process.env.QUOTE_PIPELINE_DROPS_CLEANUP_CRON || "15 3 * * *";

  cron.schedule(cronExpression, () => {
    softArchiveOldQuotePipelineDrops()
      .then((count) => {
        if (count > 0) {
          logMessage(`Soft-archived ${count} drop(s) older than ${RETENTION_DAYS} days.`);
        } else {
          logMessage(`No drops older than ${RETENTION_DAYS} days to archive.`);
        }
      })
      .catch((err) => {
        logMessage(
          `Error during nightly cleanup: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  logMessage(
    `Quote pipeline drops cleanup scheduler initialized (cron: ${cronExpression}, retention: ${RETENTION_DAYS} days).`,
  );
}
