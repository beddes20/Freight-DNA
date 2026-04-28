/**
 * Email-sync cadence + heartbeat regression tests.
 *
 * Locks in three things so a future refactor can't silently regress the
 * never-fail-again pass:
 *
 *   1. Cron cadences. Every email-pipeline scheduler must use the
 *      clock-anchored cron expression we agreed on, NOT a setInterval
 *      (which resets on every workflow restart). A regression here is
 *      what created the recurring "Webhook unhealthy" pill.
 *
 *   2. Heartbeat helper behavior. withHeartbeat() must write start +
 *      finish rows, must record errors without swallowing them, and
 *      must increment consecutiveFailures on repeated errors so the
 *      capture-audit pill can flag them.
 *
 *   3. Idempotency + mutex guards. The poll cycle must enforce its
 *      in-flight mutex, and the per-message ingestion path must
 *      deduplicate on providerMessageId so racing a webhook push and
 *      a poll for the same message is safe.
 *
 * Run with: npx tsx tests/email-sync-cadence.test.ts
 */

import { readFileSync } from "node:fs";
import { storage, db } from "../server/storage";
import { cronHeartbeats } from "../shared/schema";
import { eq } from "drizzle-orm";
import {
  withHeartbeat,
  JOB_NAMES,
  EMAIL_PIPELINE_JOBS,
} from "../server/lib/cronHeartbeat";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Email Sync Cadence + Heartbeat Regression Tests");
  console.log("══════════════════════════════════════════════════════════════");

  // ─── 1. Cron cadence lock ──────────────────────────────────────────────
  console.log("── 1. Cron cadences are clock-anchored ──");

  // Mailbox delta sync poll: every 5 minutes.
  assert(
    "mailboxDeltaSyncService uses cron \"*/5 * * * *\"",
    fileContains("server/services/mailboxDeltaSyncService.ts", `cron.schedule("*/5 * * * *"`),
    "Delta sync polling must be cron-anchored every 5 minutes",
  );

  // User-mailbox subscription renewer: every 6 hours.
  assert(
    "graphSubscriptionService user-mailbox renewer uses cron \"7 */6 * * *\"",
    fileContains("server/graphSubscriptionService.ts", `cron.schedule("7 */6 * * *"`),
    "User mailbox renewer must be cron-anchored every 6 hours",
  );

  // Shared OUTLOOK_REPLY_EMAIL renewer: every 6 hours.
  assert(
    "graphSubscriptionService shared-mailbox renewer uses cron \"13 */6 * * *\"",
    fileContains("server/graphSubscriptionService.ts", `cron.schedule("13 */6 * * *"`),
    "Shared mailbox renewer must be cron-anchored every 6 hours (was setInterval(48h))",
  );

  // Shared mailbox activation retry: every hour.
  assert(
    "graphSubscriptionService activation retry uses cron \"19 * * * *\"",
    fileContains("server/graphSubscriptionService.ts", `cron.schedule("19 * * * *"`),
    "Activation retry must be cron-anchored hourly (was setInterval(1h))",
  );

  // Reply-capture self-heal sweep: every 5 minutes.
  assert(
    "conversationReplyCaptureService sweep uses cron \"*/5 * * * *\"",
    fileContains("server/services/conversationReplyCaptureService.ts", `cron.schedule("*/5 * * * *"`),
    "Self-heal sweep must be cron-anchored every 5 minutes (was setInterval(5m))",
  );

  // SONAR breaker long-open monitor: every 5 minutes.
  assert(
    "sonarDailyRefreshScheduler breaker poll uses cron \"*/5 * * * *\"",
    fileContains("server/sonarDailyRefreshScheduler.ts", `cron.schedule("*/5 * * * *"`),
    "Breaker long-open monitor must be cron-anchored every 5 minutes",
  );

  // PAFOE wave dispatcher: every 2 minutes.
  assert(
    "pafoeWaveScheduler uses cron \"*/2 * * * *\"",
    fileContains("server/pafoeWaveScheduler.ts", `cron.schedule("*/2 * * * *"`),
    "PAFOE wave dispatcher must be cron-anchored every 2 minutes",
  );

  // ─── 2. setInterval has been removed from cron-like roles ─────────────
  console.log("── 2. setInterval has been removed from cron-like roles ──");

  const filesThatMustNotSetInterval = [
    "server/graphSubscriptionService.ts",
    "server/services/conversationReplyCaptureService.ts",
    "server/services/mailboxDeltaSyncService.ts",
    "server/sonarDailyRefreshScheduler.ts",
    "server/pafoeWaveScheduler.ts",
  ];
  for (const f of filesThatMustNotSetInterval) {
    const src = readFileSync(f, "utf8");
    // Only flag setInterval used to schedule recurring work; setTimeout is
    // fine (boot-kick), and references inside comments are also fine.
    const lines = src.split("\n");
    const offenders = lines
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /\bsetInterval\s*\(/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    assert(
      `${f} has no setInterval scheduling`,
      offenders.length === 0,
      offenders.length > 0
        ? `lines: ${offenders.map(o => `${o.i}: ${o.l.trim()}`).join(" | ")}`
        : undefined,
    );
  }

  // ─── 3. Heartbeat registry covers every email-pipeline job ────────────
  console.log("── 3. Heartbeat registry covers email-pipeline jobs ──");

  const expectedJobs = [
    JOB_NAMES.graphUserMailboxRenewal,
    JOB_NAMES.graphSharedMailboxRenewal,
    JOB_NAMES.graphSharedMailboxActivationRetry,
    JOB_NAMES.mailboxDeltaSyncPoll,
    JOB_NAMES.replyCaptureSelfHealSweep,
  ];
  for (const j of expectedJobs) {
    assert(`EMAIL_PIPELINE_JOBS includes ${j}`, EMAIL_PIPELINE_JOBS.has(j));
  }

  // ─── 4. Heartbeat helper writes correct rows ──────────────────────────
  console.log("── 4. Heartbeat helper writes start + finish rows ──");

  // Use a unique test job name so we don't collide with the live schedulers.
  const testJobOk = `__test_heartbeat_ok_${Date.now()}`;
  const testJobErr = `__test_heartbeat_err_${Date.now()}`;
  const interval = 60_000;

  let ranOnce = false;
  await withHeartbeat(testJobOk as any, interval, async () => {
    // Mid-tick: row should be in "running" state.
    const mid = await db.select().from(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobOk));
    assert("mid-tick row exists with status=running", mid[0]?.lastStatus === "running");
    ranOnce = true;
  });
  assert("body actually ran", ranOnce);

  const okRow = (await db.select().from(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobOk)))[0];
  assert("post-tick row exists", !!okRow);
  assert("post-tick status=success", okRow?.lastStatus === "success");
  assert("post-tick lastFinishedAt is set", !!okRow?.lastFinishedAt);
  assert("post-tick lastDurationMs >= 0", (okRow?.lastDurationMs ?? -1) >= 0);
  assert("post-tick consecutiveFailures = 0", okRow?.consecutiveFailures === 0);
  assert("post-tick expectedIntervalMs preserved", okRow?.expectedIntervalMs === interval);
  assert("post-tick nextExpectedAt > lastStartedAt", !!okRow?.nextExpectedAt && !!okRow?.lastStartedAt && okRow.nextExpectedAt > okRow.lastStartedAt);

  // ─── 5. Heartbeat helper records errors and re-throws ────────────────
  console.log("── 5. Heartbeat helper records errors without swallowing ──");

  let caught: Error | null = null;
  try {
    await withHeartbeat(testJobErr as any, interval, async () => {
      throw new Error("boom-1");
    });
  } catch (err) {
    caught = err as Error;
  }
  assert("error from body propagates to caller", caught?.message === "boom-1");

  const errRow1 = (await db.select().from(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobErr)))[0];
  assert("error tick recorded with status=error", errRow1?.lastStatus === "error");
  assert("error tick recorded message", errRow1?.lastError === "boom-1");
  assert("error tick consecutiveFailures = 1", errRow1?.consecutiveFailures === 1);

  // Second consecutive error increments counter.
  try {
    await withHeartbeat(testJobErr as any, interval, async () => {
      throw new Error("boom-2");
    });
  } catch {/* expected */}
  const errRow2 = (await db.select().from(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobErr)))[0];
  assert("second error increments consecutiveFailures to 2", errRow2?.consecutiveFailures === 2);

  // Successful tick after errors resets the counter.
  await withHeartbeat(testJobErr as any, interval, async () => { /* recovery */ });
  const errRow3 = (await db.select().from(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobErr)))[0];
  assert("recovery tick resets consecutiveFailures to 0", errRow3?.consecutiveFailures === 0);
  assert("recovery tick clears lastError", errRow3?.lastError === null);

  // ─── 6. Stale detection finds late jobs ──────────────────────────────
  console.log("── 6. getStaleCronHeartbeats flags overdue jobs ──");

  const staleJob = `__test_stale_${Date.now()}`;
  // Insert directly with nextExpectedAt in the deep past + status=success.
  await db.insert(cronHeartbeats).values({
    jobName: staleJob,
    expectedIntervalMs: 60_000,
    lastStartedAt: new Date(Date.now() - 30 * 60_000),
    lastFinishedAt: new Date(Date.now() - 30 * 60_000),
    lastStatus: "success",
    nextExpectedAt: new Date(Date.now() - 29 * 60_000), // 29 min overdue
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const stale = await storage.getStaleCronHeartbeats(1.5);
  assert("stale job is reported", stale.some(s => s.jobName === staleJob));

  // A *recently* started "running" row is NOT stale — a tick that's actually
  // executing is the opposite of dead.
  const recentRunningJob = `__test_running_recent_${Date.now()}`;
  await db.insert(cronHeartbeats).values({
    jobName: recentRunningJob,
    expectedIntervalMs: 60_000,
    lastStartedAt: new Date(Date.now() - 30_000), // started 30s ago, well under threshold
    lastFinishedAt: null,
    lastStatus: "running",
    nextExpectedAt: new Date(Date.now() + 30_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const stale2 = await storage.getStaleCronHeartbeats(1.5);
  assert(
    "recently-started running job is NOT reported as stale",
    !stale2.some(s => s.jobName === recentRunningJob),
  );

  // A *long*-running non-critical corpse row IS stale — April 28 hot patch.
  // Non-critical threshold is max(intervalMs * 5, 10 min). With a 60s
  // interval the threshold is 10 min, so a row that's been "running" for
  // an hour must surface as stale.
  const stuckRunningJob = `__test_running_stuck_${Date.now()}`;
  await db.insert(cronHeartbeats).values({
    jobName: stuckRunningJob,
    expectedIntervalMs: 60_000,
    lastStartedAt: new Date(Date.now() - 60 * 60_000), // 60min stuck >> 10min threshold
    lastFinishedAt: null,
    lastStatus: "running",
    nextExpectedAt: new Date(Date.now() - 59 * 60_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const stale2b = await storage.getStaleCronHeartbeats(1.5);
  assert(
    "stuck-running non-critical corpse IS reported as stale (April 28 hot patch)",
    stale2b.some(s => s.jobName === stuckRunningJob),
    "Without this, a SIGKILL'd / hung tick stays invisible — that's how email_intelligence_batch went silent for 3h",
  );

  // ─── 6b. Critical-job stuck-running threshold is tighter ───────────
  // Critical jobs (email_intelligence_batch, mailbox_delta_sync_poll,
  // reply_capture_self_heal_sweep) use max(interval*3, 6min) so the
  // 2-min email_intelligence_batch escalates to red within ≤6 min,
  // matching sales' freshness SLA. We assert the exact policy by using
  // the real critical job names with synthetic timing.

  // (i) email_intelligence_batch (interval=2min) running for 7 min must
  // be flagged — threshold = max(2min*3, 6min) = 6 min.
  const criticalStuckJob = JOB_NAMES.emailIntelligenceBatch;
  const criticalIntervalMs = 2 * 60 * 1000;
  // Wipe any real production row for this name first so the test is
  // deterministic, then restore at cleanup time.
  const priorCriticalRow = (
    await db
      .select()
      .from(cronHeartbeats)
      .where(eq(cronHeartbeats.jobName, criticalStuckJob))
      .limit(1)
  )[0];
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, criticalStuckJob));
  await db.insert(cronHeartbeats).values({
    jobName: criticalStuckJob,
    expectedIntervalMs: criticalIntervalMs,
    lastStartedAt: new Date(Date.now() - 7 * 60_000), // 7m old, threshold 6m
    lastFinishedAt: null,
    lastStatus: "running",
    nextExpectedAt: new Date(Date.now() - 5 * 60_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const staleCritical = await storage.getStaleCronHeartbeats(1.5);
  assert(
    "critical email_intelligence_batch stuck >6min IS reported as stale",
    staleCritical.some(s => s.jobName === criticalStuckJob),
    "If this fails, the audit pill won't escalate within sales' ≤6min freshness SLA — the original April 28 outage scenario.",
  );

  // (ii) Same critical job, only 4 min old, must NOT be flagged
  // (legitimately mid-run).
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, criticalStuckJob));
  await db.insert(cronHeartbeats).values({
    jobName: criticalStuckJob,
    expectedIntervalMs: criticalIntervalMs,
    lastStartedAt: new Date(Date.now() - 4 * 60_000), // 4m old, threshold 6m
    lastFinishedAt: null,
    lastStatus: "running",
    nextExpectedAt: new Date(Date.now() - 2 * 60_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const staleCritical2 = await storage.getStaleCronHeartbeats(1.5);
  assert(
    "critical email_intelligence_batch mid-run at 4m is NOT reported as stale",
    !staleCritical2.some(s => s.jobName === criticalStuckJob),
    "False-flagging a legitimately slow tick would create alert fatigue and undermine the pill.",
  );

  // Restore prior row so we don't perturb the live system.
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, criticalStuckJob));
  if (priorCriticalRow) {
    await db.insert(cronHeartbeats).values(priorCriticalRow);
  }

  // Recently-ticked job (nextExpectedAt in future) is NOT stale.
  const freshJob = `__test_fresh_${Date.now()}`;
  await db.insert(cronHeartbeats).values({
    jobName: freshJob,
    expectedIntervalMs: 60_000,
    lastStartedAt: new Date(),
    lastFinishedAt: new Date(),
    lastStatus: "success",
    nextExpectedAt: new Date(Date.now() + 60_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const stale3 = await storage.getStaleCronHeartbeats(1.5);
  assert("fresh job is NOT reported as stale", !stale3.some(s => s.jobName === freshJob));

  // ─── 7. Mutex / idempotency source-level guarantees ──────────────────
  console.log("── 7. Mutex + idempotency guards still in place ──");

  assert(
    "mailboxDeltaSyncService still guards cycles with _cycleInFlight",
    fileContains("server/services/mailboxDeltaSyncService.ts", "_cycleInFlight = true"),
    "Removing the in-flight mutex would let slow cycles pile up on the next tick",
  );
  assert(
    "mailboxDeltaSyncService bails the cron cycle when one is already running",
    fileContains("server/services/mailboxDeltaSyncService.ts", "if (_cycleInFlight)"),
  );
  assert(
    "graphWebhook still keys per-message dedupe on providerMessageId",
    fileContains("server/routes/graphWebhook.ts", "providerMessageId"),
    "processUserMailboxEmailForDelta must remain idempotent so racing a webhook push and a poll is safe",
  );
  assert(
    "graphWebhook logs Duplicate email skipped on dedupe hit",
    fileContains("server/routes/graphWebhook.ts", "Duplicate email skipped"),
  );

  // ─── 7b. Email-intelligence batch hang protections (April 28 follow-up) ──
  // Three layers must remain in place. Removing any of them would let the
  // April 28 outage recur — a single OpenAI hang or one slow tick used to
  // cascade into 16 overlapping batches that killed the cron loop for 4h.
  console.log("── 7b. emailIntelligenceBatch hang protections still in place ──");

  // (a) Per-OpenAI-request timeout. The SDK default is 10 minutes which is
  //     longer than the entire 2-min cron interval. 60s is the negotiated cap.
  assert(
    "extractEmailSignals passes a per-request timeout to OpenAI",
    fileContains("server/emailIntelligenceService.ts", "timeout: 60_000"),
    "Removing the timeout means a single hung OpenAI call can stall the entire batch indefinitely",
  );
  assert(
    "extractEmailSignals caps OpenAI retries to keep tick budget bounded",
    fileContains("server/emailIntelligenceService.ts", "maxRetries: 1"),
  );

  // (b) Single shared in-flight guard across all three call sites.
  assert(
    "scheduler declares the unified _batchInFlight guard",
    fileContains("server/emailIntelligenceScheduler.ts", "let _batchInFlight = false"),
  );
  assert(
    "scheduler routes cron ticks through _invokeBatch",
    fileContains("server/emailIntelligenceScheduler.ts", `_invokeBatch({ source: "cron" })`),
    "If the cron tick bypasses _invokeBatch, overlapping ticks can pile up again",
  );
  assert(
    "scheduler routes the initial pass through _invokeBatch",
    fileContains("server/emailIntelligenceScheduler.ts", `_invokeBatch({ source: "initial" })`),
  );
  assert(
    "scheduler routes the manual trigger through _invokeBatch",
    fileContains("server/emailIntelligenceScheduler.ts", `_invokeBatch({ source: "manual"`),
  );
  assert(
    "scheduler logs skipped ticks instead of silently dropping them",
    fileContains("server/emailIntelligenceScheduler.ts", "skipping ${opts.source} tick: previous batch still running"),
  );

  // (c) Wall clock so a hung body can't sit in `running` forever.
  assert(
    "scheduler defines BATCH_WALL_CLOCK_MS at 5 minutes",
    fileContains("server/emailIntelligenceScheduler.ts", "BATCH_WALL_CLOCK_MS = 5 * 60 * 1000"),
    "A wall clock is what bounds the worst case if the in-flight body itself hangs",
  );
  assert(
    "scheduler races the body against the wall clock via runWithWallClock",
    fileContains("server/emailIntelligenceScheduler.ts", "runWithWallClock("),
  );
  assert(
    "scheduler logs wall-clock kills distinctly so they're greppable in production logs",
    fileContains("server/emailIntelligenceScheduler.ts", "killed by wall clock"),
  );

  // (d) Cooperative cancellation. Without these, a wall-clock kill leaves
  //     the underlying for-loop running in the background — so a 5-min
  //     wall clock against a 7-min batch would cause the next cron tick
  //     to fire while the orphaned loop is still hammering OpenAI. That
  //     recreates the exact pile-up problem the in-flight guard is meant
  //     to prevent.
  assert(
    "extractEmailSignals accepts an AbortSignal so the wall clock can cancel it",
    fileContains("server/emailIntelligenceService.ts", "opts?: { signal?: AbortSignal }"),
    "Without this, a wall-clock kill cannot stop the in-flight OpenAI fetch",
  );
  assert(
    "extractEmailSignals forwards the signal to the OpenAI request options",
    fileContains("server/emailIntelligenceService.ts", "signal: opts?.signal"),
  );
  assert(
    "runEmailIntelligenceBatch accepts an AbortSignal",
    fileContains("server/emailIntelligenceScheduler.ts", "opts?: { signal?: AbortSignal }"),
  );
  assert(
    "runEmailIntelligenceBatch checks signal.aborted between iterations",
    fileContains("server/emailIntelligenceScheduler.ts", "if (opts?.signal?.aborted)"),
    "Without this check the loop continues after the wall clock fires, racing the next tick",
  );
  assert(
    "runEmailIntelligenceBatch threads the signal into extractEmailSignals",
    fileContains("server/emailIntelligenceScheduler.ts", "extractEmailSignals(msg, { signal: opts?.signal })"),
  );
  assert(
    "_invokeBatch threads the wall-clock signal into the batch",
    fileContains("server/emailIntelligenceScheduler.ts", "runEmailIntelligenceBatch(undefined, opts.orgId, { signal })"),
  );
  assert(
    "runWithWallClock aborts the controller on timeout (not just rejects)",
    fileContains("server/emailIntelligenceScheduler.ts", "controller.abort()"),
    "The whole point of the AbortController is that it must fire when the wall clock does",
  );

  // (e) Functional checks: the in-flight test helpers behave as advertised
  //     and runWithWallClock actually aborts the inner signal on timeout.
  const sched = await import("../server/emailIntelligenceScheduler");
  sched._resetBatchInFlightForTests();
  assert(
    "_isBatchInFlightForTests returns false after reset",
    sched._isBatchInFlightForTests() === false,
  );
  assert(
    "_getBatchWallClockMsForTests reports the 5-min budget",
    sched._getBatchWallClockMsForTests() === 5 * 60 * 1000,
  );

  // Behavioral test: when the wall clock fires, the inner fn's AbortSignal
  // must be aborted BEFORE the wrapping promise rejects. This is what
  // guarantees no orphaned background work.
  let observedSignalAbortedAtReject = false;
  let rejectedWith: unknown = null;
  let capturedSignal: AbortSignal | null = null;
  try {
    await sched._runWithWallClockForTests(signal => {
      capturedSignal = signal;
      // Hang forever; only resolve when aborted.
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("inner-aborted"));
        });
      });
    }, 50);
  } catch (err) {
    rejectedWith = err;
    observedSignalAbortedAtReject = capturedSignal?.aborted === true;
  }
  assert(
    "runWithWallClock rejects with BatchTimeoutError on timeout",
    rejectedWith instanceof sched._BatchTimeoutErrorForTests,
  );
  assert(
    "runWithWallClock aborts the inner AbortSignal on timeout",
    observedSignalAbortedAtReject === true,
    "Without abort propagation, the inner work continues running after the wrapper rejects",
  );

  // ─── 8. Cleanup ──────────────────────────────────────────────────────
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobOk));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobErr));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, staleJob));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, recentRunningJob));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, stuckRunningJob));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, freshJob));

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");

  if (failed > 0) {
    console.error("\nFailed assertions:");
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("FATAL", err);
  process.exit(1);
});
