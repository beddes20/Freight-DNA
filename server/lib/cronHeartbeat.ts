/**
 * Cron heartbeat wrapper.
 *
 * Every recurring background job in this codebase should run its tick body
 * through `withHeartbeat()`. The wrapper does three things:
 *
 *   1. Writes a "running" row to `cron_heartbeats` BEFORE the body runs,
 *      with `nextExpectedAt` pushed forward by `expectedIntervalMs`.
 *   2. Runs the body.
 *   3. Updates the row with success/error + duration + consecutive failure
 *      count.
 *
 * The capture-audit status pill (and any future ops dashboard) reads
 * `storage.getStaleCronHeartbeats()` and surfaces any job whose
 * `nextExpectedAt` has passed without a new tick. This is the positive
 * liveness signal we lacked when the recurring "Webhook unhealthy" pill
 * dragged on for five iterations — a silent setInterval that died on
 * restart left no trail. With heartbeats, a missed tick is observable
 * within minutes.
 *
 * Job naming convention: `<domain>_<purpose>_cron`, e.g.
 *   - `mailbox_delta_sync_poll`
 *   - `graph_user_mailbox_renewal`
 *   - `graph_shared_mailbox_renewal`
 *   - `reply_capture_self_heal_sweep`
 * Names are stable identifiers — renaming one orphans its history. Use
 * the JOB_NAMES registry below as the single source of truth.
 */
import { storage } from "../storage";

export const JOB_NAMES = {
  /** Per-rep mailbox subscription renewer. graphSubscriptionService:887, every 6h. */
  graphUserMailboxRenewal: "graph_user_mailbox_renewal",
  /** Shared OUTLOOK_REPLY_EMAIL subscription renewer. Every 6h (was setInterval(48h)). */
  graphSharedMailboxRenewal: "graph_shared_mailbox_renewal",
  /** Shared mailbox activation retry, fires while Mail.Read is not yet granted. Every 1h. */
  graphSharedMailboxActivationRetry: "graph_shared_mailbox_activation_retry",
  /** Polling delta sync across every enabled monitored mailbox. Every 5min. */
  mailboxDeltaSyncPoll: "mailbox_delta_sync_poll",
  /** Self-heal sweep for stuck threads. Every 5min. */
  replyCaptureSelfHealSweep: "reply_capture_self_heal_sweep",
  /** SONAR breaker long-open monitor. Every 5min. */
  sonarBreakerLongOpenPoll: "sonar_breaker_long_open_poll",
  /** PAFOE scheduled-wave dispatcher. Every 2min. */
  pafoeWaveDispatcher: "pafoe_wave_dispatcher",
  /** Email intelligence extraction + quote ingest batch. Every 2min. */
  emailIntelligenceBatch: "email_intelligence_batch",
} as const;

export type JobName = typeof JOB_NAMES[keyof typeof JOB_NAMES];

/**
 * Wrap a cron tick body so that every run leaves a heartbeat. Errors are
 * caught, logged to the heartbeat row as `lastError`, and re-thrown so the
 * caller's existing error handling still fires (most schedulers wrap their
 * body in a try/catch that just logs — re-throwing is a no-op there).
 */
export async function withHeartbeat<T>(
  jobName: JobName,
  expectedIntervalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    await storage.recordCronHeartbeatStart(jobName, expectedIntervalMs);
  } catch (err) {
    // Heartbeat failures must NEVER block actual work — if the heartbeat
    // table is down, fall through and run the body anyway. We log to
    // stderr so the swallowed error is still visible in workflow logs.
    console.warn(`[cron-heartbeat] start write failed for ${jobName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result: T;
  try {
    result = await fn();
  } catch (bodyErr) {
    const message = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
    try {
      await storage.recordCronHeartbeatFinish(jobName, "error", Date.now() - startedAt, message);
    } catch (hbErr) {
      console.warn(`[cron-heartbeat] error write failed for ${jobName}: ${hbErr instanceof Error ? hbErr.message : String(hbErr)}`);
    }
    throw bodyErr;
  }

  try {
    await storage.recordCronHeartbeatFinish(jobName, "success", Date.now() - startedAt);
  } catch (hbErr) {
    console.warn(`[cron-heartbeat] success write failed for ${jobName}: ${hbErr instanceof Error ? hbErr.message : String(hbErr)}`);
  }
  return result;
}

/** Email-pipeline job names — used by the capture-audit pill to flag staleness. */
export const EMAIL_PIPELINE_JOBS: ReadonlySet<JobName> = new Set([
  JOB_NAMES.graphUserMailboxRenewal,
  JOB_NAMES.graphSharedMailboxRenewal,
  JOB_NAMES.graphSharedMailboxActivationRetry,
  JOB_NAMES.mailboxDeltaSyncPoll,
  JOB_NAMES.replyCaptureSelfHealSweep,
  JOB_NAMES.emailIntelligenceBatch,
]);

/**
 * Critical email-pipeline jobs whose missed tick should escalate the audit
 * pill all the way to "unhealthy" (red). Reserved for the fast-cadence cron
 * paths whose silence directly translates to user-visible mail starvation.
 *
 * Slower jobs (the 6-hourly subscription renewers, hourly activation retry)
 * are still surfaced via the heartbeat layer but only escalate to
 * "recovering" (amber) — missing one of their ticks does not immediately
 * break user-facing mail flow because Graph subs survive ~70h.
 */
export const CRITICAL_EMAIL_PIPELINE_JOBS: ReadonlySet<JobName> = new Set([
  JOB_NAMES.mailboxDeltaSyncPoll,
  JOB_NAMES.emailIntelligenceBatch,
  JOB_NAMES.replyCaptureSelfHealSweep,
]);
