/**
 * Phase 1.5 S1 — getFreshnessForJobs() unit tests.
 *
 * Seeds cron_heartbeats rows directly via the storage db handle and asserts
 * the four documented status branches (unknown / ok / stale-by-error /
 * stale-by-age). Cleans up the seeded rows.
 *
 * Run: npx tsx tests/portlet-freshness-helper.test.ts
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/storage";
import { cronHeartbeats } from "../shared/schema";
import { getFreshnessForJobs } from "../server/lib/portletFreshness";
import type { JobName } from "../server/lib/cronHeartbeat";

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

// We use the canonical load-fact job names so the test exercises the same
// code path the dashboard endpoints will hit. We stash the live row (if any)
// before each subtest and restore it after — no test should permanently
// disturb a real heartbeat.
const JOB_A = "load_fact_import_morning" as JobName;
const JOB_B = "load_fact_import_afternoon" as JobName;
const JOBS: JobName[] = [JOB_A, JOB_B];
type SavedRow = typeof cronHeartbeats.$inferSelect;
let saved: SavedRow[] = [];

async function snapshot(): Promise<void> {
  saved = await db.select().from(cronHeartbeats).where(inArray(cronHeartbeats.jobName, JOBS as unknown as string[]));
}

async function clearJobs(): Promise<void> {
  await db.delete(cronHeartbeats).where(inArray(cronHeartbeats.jobName, JOBS as unknown as string[]));
}

async function restore(): Promise<void> {
  await clearJobs();
  if (saved.length > 0) {
    await db.insert(cronHeartbeats).values(saved);
  }
}

async function seedRow(jobName: JobName, opts: {
  lastStatus: "success" | "error" | "running";
  lastFinishedAt: Date | null;
  consecutiveFailures?: number;
  expectedIntervalMs?: number;
}) {
  const now = new Date();
  await db.insert(cronHeartbeats).values({
    jobName,
    expectedIntervalMs: opts.expectedIntervalMs ?? 5 * 60_000,
    lastStartedAt: opts.lastFinishedAt ?? now,
    lastFinishedAt: opts.lastFinishedAt,
    lastStatus: opts.lastStatus,
    lastDurationMs: 1000,
    consecutiveFailures: opts.consecutiveFailures ?? 0,
    nextExpectedAt: new Date(now.getTime() + (opts.expectedIntervalMs ?? 5 * 60_000)),
    updatedAt: now,
  });
}

async function tableExists(): Promise<boolean> {
  try {
    await db.select().from(cronHeartbeats).limit(1);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cron_heartbeats.*does not exist/i.test(msg)) return false;
    throw err;
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Portlet Freshness Helper — getFreshnessForJobs unit tests");
  console.log("══════════════════════════════════════════════════════════════");

  if (!(await tableExists())) {
    // Pre-existing dev-DB schema drift: cron_heartbeats not pushed locally.
    // We can still exercise the defensive branch — getFreshnessForJobs MUST
    // collapse a heartbeat read failure to status="unknown", never throw.
    console.log("  [warn] cron_heartbeats missing in this DB — running defensive-branch only.");
    await test("DB read failure → status='unknown' (defensive fallback)", async () => {
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "unknown") throw new Error(`expected unknown, got ${f.status}`);
    });
    await test("empty job list → status='unknown' (no DB hit)", async () => {
      const f = await getFreshnessForJobs([]);
      if (f.status !== "unknown") throw new Error(`expected unknown, got ${f.status}`);
    });
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    console.log("──────────────────────────────────────────────────────────────");
    console.log(`  ${passed} passed, ${failed} failed (full suite skipped — apply drizzle push to run)`);
    console.log("══════════════════════════════════════════════════════════════");
    if (failed > 0) process.exit(1);
    return;
  }

  await snapshot();

  try {
    await test("no rows → status='unknown'", async () => {
      await clearJobs();
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "unknown") throw new Error(`expected unknown, got ${f.status}`);
      if (f.lastUpdatedAt !== null) throw new Error("expected null lastUpdatedAt");
    });

    await test("fresh success row → status='ok'", async () => {
      await clearJobs();
      await seedRow(JOB_A, { lastStatus: "success", lastFinishedAt: new Date(Date.now() - 60_000) });
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "ok") throw new Error(`expected ok, got ${f.status} (source=${f.source})`);
      if (f.consecutiveFailures !== 0) throw new Error("expected 0 failures");
    });

    await test("lastStatus='error' → status='stale'", async () => {
      await clearJobs();
      await seedRow(JOB_A, { lastStatus: "error", lastFinishedAt: new Date(Date.now() - 60_000), consecutiveFailures: 1 });
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "stale") throw new Error(`expected stale, got ${f.status}`);
      if (f.source !== JOB_A) throw new Error(`expected source=${JOB_A}, got ${f.source}`);
    });

    await test("row older than intervalMs*2 → status='stale'", async () => {
      await clearJobs();
      // intervalMs=5min → window=10min → seed an 11-min-old success
      await seedRow(JOB_A, {
        lastStatus: "success",
        lastFinishedAt: new Date(Date.now() - 11 * 60_000),
        expectedIntervalMs: 5 * 60_000,
      });
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "stale") throw new Error(`expected stale, got ${f.status}`);
    });

    await test("composite: one ok + one stale → status='stale' with stale source", async () => {
      await clearJobs();
      await seedRow(JOB_A, { lastStatus: "success", lastFinishedAt: new Date(Date.now() - 60_000) });
      await seedRow(JOB_B, { lastStatus: "error", lastFinishedAt: new Date(Date.now() - 30_000), consecutiveFailures: 2 });
      const f = await getFreshnessForJobs(JOBS);
      if (f.status !== "stale") throw new Error(`expected stale, got ${f.status}`);
      if (f.source !== JOB_B) throw new Error(`expected stale source=${JOB_B}, got ${f.source}`);
    });

    await test("empty job list → status='unknown' (no DB hit)", async () => {
      const f = await getFreshnessForJobs([]);
      if (f.status !== "unknown") throw new Error(`expected unknown, got ${f.status}`);
    });
  } finally {
    await restore();
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
}).finally(() => process.exit(0));
