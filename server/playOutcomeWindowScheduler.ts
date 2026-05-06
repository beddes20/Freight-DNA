/**
 * Play Outcome Window Scheduler (Task #302)
 *
 * Sweeps every 15 minutes for play_outcomes still in 'pending' status whose
 * window_expires_at has passed and converts them to status='expired',
 * classifier_label='no_response'. Also marks the parent play_run as
 * completed so it leaves the rep's "open" bucket.
 */
import cron from "node-cron";
import { sql } from "drizzle-orm";
import { db } from "./storage";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [play-outcome-window] ${msg}`);
}

export async function expirePendingOutcomes(): Promise<{ expired: number }> {
  try {
    const result = await db.execute<{ id: string; play_run_id: string }>(sql`
      UPDATE play_outcomes
      SET status = 'expired',
          classifier_label = COALESCE(classifier_label, 'no_response'),
          outcome = 'no_response',
          recorded_at = NOW()
      WHERE status = 'pending'
        AND window_expires_at IS NOT NULL
        AND window_expires_at < NOW()
      RETURNING id, play_run_id
    `);
    const rows = result.rows ?? [];
    if (rows.length > 0) {
      const runIds = rows.map(r => r.play_run_id);
      await db.execute(sql`
        UPDATE play_runs
        SET status = 'completed', completed_at = NOW()
        WHERE id = ANY(${runIds}::varchar[])
          AND status <> 'completed'
      `);
    }
    if (rows.length > 0) log(`Expired ${rows.length} pending outcome(s).`);
    return { expired: rows.length };
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return { expired: 0 };
  }
}

export function initPlayOutcomeWindowScheduler() {
  expirePendingOutcomes();
  cron.schedule("*/15 * * * *", () => expirePendingOutcomes());
  log("Play outcome window scheduler initialized (every 15 min).");
}
