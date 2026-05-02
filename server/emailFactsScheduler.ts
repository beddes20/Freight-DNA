/**
 * Email Intelligence v1.5 — daily fact-derived task scheduler (Task #943).
 *
 * Runs two best-effort sweeps every morning:
 *   - Forward-calendar fan-out → tasks for upcoming RFP / renewal windows
 *   - Staleness sweep         → tasks for overdue promises + stale questions
 *
 * Both sweeps are idempotent at the task level (forwarded_from key) so a
 * rerun (manual `/api/admin/email-facts/run-sweeps`) is safe.
 */

import cron from "node-cron";
import { storage } from "./storage";
import { runForwardCalendarFanoutAllOrgs } from "./services/emailFacts/forwardCalendarFanout";
import { runStalenessSweepAllOrgs } from "./services/emailFacts/stalenessSweep";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [email-facts-scheduler] ${msg}`);
}

export async function runEmailFactsSweepsOnce(): Promise<void> {
  try {
    const fwcal = await runForwardCalendarFanoutAllOrgs(storage);
    log(`forward-calendar fanout: orgs=${fwcal.orgs} scanned=${fwcal.totals.scanned} created=${fwcal.totals.created} skipped=${fwcal.totals.skipped} errors=${fwcal.totals.errors}`);
  } catch (err) {
    log(`forward-calendar fanout failed: ${(err as Error).message}`);
  }
  try {
    const stale = await runStalenessSweepAllOrgs(storage);
    log(`staleness sweep: orgs=${stale.orgs} promise_tasks=${stale.totals.promiseTasksCreated} question_tasks=${stale.totals.questionTasksCreated} skipped=${stale.totals.skipped} errors=${stale.totals.errors}`);
  } catch (err) {
    log(`staleness sweep failed: ${(err as Error).message}`);
  }
}

export function initEmailFactsScheduler(): void {
  // Daily at 7:30am Central — early enough to land in the rep's morning queue.
  const expr = process.env.EMAIL_FACTS_SWEEP_CRON || "30 7 * * *";
  cron.schedule(expr, () => {
    runEmailFactsSweepsOnce().catch((err) => log(`scheduled sweep failed: ${(err as Error).message}`));
  }, { timezone: "America/Chicago" });
  log(`email-facts scheduler initialized (cron: ${expr})`);
}
