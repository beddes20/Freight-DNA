/**
 * Conversation Thread Backfill Scheduler (Task #286)
 *
 * Periodic safety sweep that calls
 * `backfillMissingConversationThreads()` every 6 hours so any orphan
 * email threads created by ingestion paths that bypass the main
 * email intelligence scheduler still get materialised into
 * `email_conversation_threads`.
 *
 * Task #285 introduced:
 *   - A one-time-on-startup backfill (server/index.ts).
 *   - On-demand materialisation when a synthetic `thread:` id is hit.
 *   - Inline thread upsert inside the email intelligence scheduler.
 *
 * This scheduler is the belt-and-suspenders cron sweep: if a future
 * ingestion path inserts into `email_messages` / `email_signals`
 * without going through the intelligence scheduler, this sweep will
 * still rescue the orphans within at most one cadence interval.
 *
 * Anything with `inserted > 0` is logged as a WARN-style line so a
 * regression in ingestion is visible in production logs (and easy to
 * grep / alert on with `[conv-thread-backfill-cron] sweep inserted=`).
 */

import cron from "node-cron";
import { backfillMissingConversationThreads } from "./services/conversationThreadBackfillService";

const CRON_EXPRESSION = process.env.CONV_THREAD_BACKFILL_CRON ?? "0 */6 * * *";

async function runSweep(): Promise<void> {
  try {
    const result = await backfillMissingConversationThreads();
    if (result.inserted > 0) {
      // Non-zero inserts indicate an ingestion path bypassed the
      // inline thread upsert — surface loudly so the regression is
      // noticed early.
      console.warn(
        `[conv-thread-backfill-cron] sweep inserted=${result.inserted} ` +
          `scanned=${result.scanned} (${result.durationMs}ms) — ` +
          `an ingestion path is creating orphan threads, investigate.`,
      );
    } else if (result.scanned > 0) {
      console.log(
        `[conv-thread-backfill-cron] sweep scanned=${result.scanned} inserted=0 (${result.durationMs}ms)`,
      );
    }
  } catch (err) {
    console.error("[conv-thread-backfill-cron] sweep error:", err);
  }
}

export function initConversationThreadBackfillScheduler(): void {
  console.log(
    `[conv-thread-backfill-cron] starting — cron: ${CRON_EXPRESSION} (America/Chicago)`,
  );
  cron.schedule(CRON_EXPRESSION, () => {
    void runSweep();
  }, { timezone: "America/Chicago" });
}
