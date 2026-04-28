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

  // A "running" row is NOT stale even if nextExpectedAt is past — a tick
  // that's actually executing is the opposite of dead.
  const runningJob = `__test_running_${Date.now()}`;
  await db.insert(cronHeartbeats).values({
    jobName: runningJob,
    expectedIntervalMs: 60_000,
    lastStartedAt: new Date(Date.now() - 60 * 60_000),
    lastFinishedAt: null,
    lastStatus: "running",
    nextExpectedAt: new Date(Date.now() - 59 * 60_000),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  });
  const stale2 = await storage.getStaleCronHeartbeats(1.5);
  assert("running job is NOT reported as stale", !stale2.some(s => s.jobName === runningJob));

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

  // ─── 8. Cleanup ──────────────────────────────────────────────────────
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobOk));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, testJobErr));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, staleJob));
  await db.delete(cronHeartbeats).where(eq(cronHeartbeats.jobName, runningJob));
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
