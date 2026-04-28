/**
 * load_fact scheduler hardening regression tests.
 *
 * Mirrors tests/email-sync-cadence.test.ts section 7b. Locks in:
 *
 *   - JOB_NAMES exposes the two new load_fact slot constants and they
 *     map to the stable strings the heartbeat row + audit pill key on.
 *   - server/loadFactScheduler.ts wires every cron tick through the
 *     `_invokeSlot` helper, which combines the in-flight guard,
 *     `withHeartbeat()`, and `runWithWallClock(...)`.
 *   - The per-slot in-flight guard (`_slotInFlight`) is in place and
 *     skipped ticks are logged distinctly so they're greppable in prod.
 *   - The wall clock (`SLOT_WALL_CLOCK_MS = 10 min`) actually aborts
 *     the inner AbortSignal on timeout (cooperative cancellation),
 *     not just rejects the outer promise — without this, an orphaned
 *     loop would keep iterating orgs in the background after the
 *     wrapper rejected and race the next tick.
 *   - `runSlot` accepts the signal and exits between orgs when aborted.
 *
 * Removing any of these protections would let a hung Power BI import or
 * a slow per-org loop pile up across cron ticks — the same pattern that
 * killed the email_intelligence batch on April 28 before it was hardened.
 *
 * Run with: npx tsx tests/load-fact-scheduler-hardening.test.ts
 */

import { readFileSync } from "node:fs";
import { JOB_NAMES } from "../server/lib/cronHeartbeat";

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
  console.log("  load_fact Scheduler Hardening Tests");
  console.log("══════════════════════════════════════════════════════════════");

  // ─── 1. JOB_NAMES registry exposes the two slot entries ─────────────
  console.log("── 1. JOB_NAMES has the two load_fact slot constants ──");
  assert(
    "JOB_NAMES.loadFactImportMorning === 'load_fact_import_morning'",
    JOB_NAMES.loadFactImportMorning === "load_fact_import_morning",
    "Renaming this string orphans the heartbeat history the audit pill keys on",
  );
  assert(
    "JOB_NAMES.loadFactImportAfternoon === 'load_fact_import_afternoon'",
    JOB_NAMES.loadFactImportAfternoon === "load_fact_import_afternoon",
  );

  // ─── 2. Scheduler imports + uses the heartbeat helpers ──────────────
  console.log("── 2. Scheduler imports the heartbeat helpers ──");
  assert(
    "loadFactScheduler imports from ./lib/cronHeartbeat",
    fileContains("server/loadFactScheduler.ts", `from "./lib/cronHeartbeat"`),
  );
  assert(
    "loadFactScheduler wraps each slot under withHeartbeat(SLOT_JOB_NAME[slot], ...)",
    fileContains("server/loadFactScheduler.ts", "withHeartbeat(SLOT_JOB_NAME[slot]"),
    "Without this neither slot writes a row to cron_heartbeats and missed ticks are invisible",
  );
  assert(
    "loadFactScheduler maps both slots into the SLOT_JOB_NAME table",
    fileContains("server/loadFactScheduler.ts", "JOB_NAMES.loadFactImportMorning")
      && fileContains("server/loadFactScheduler.ts", "JOB_NAMES.loadFactImportAfternoon"),
  );

  // ─── 3. Per-slot in-flight guard ────────────────────────────────────
  console.log("── 3. Per-slot in-flight guard ──");
  assert(
    "scheduler declares the per-slot _slotInFlight record",
    fileContains("server/loadFactScheduler.ts", "_slotInFlight"),
    "Removing the in-flight guard lets a slow slot pile up if the cron re-fires before the prior run finished",
  );
  assert(
    "scheduler routes the morning cron tick through _invokeSlot",
    fileContains("server/loadFactScheduler.ts", `_invokeSlot("morning")`),
  );
  assert(
    "scheduler routes the afternoon cron tick through _invokeSlot",
    fileContains("server/loadFactScheduler.ts", `_invokeSlot("afternoon")`),
  );
  assert(
    "scheduler logs skipped ticks instead of silently dropping them",
    fileContains(
      "server/loadFactScheduler.ts",
      "skipping ${slot} tick: previous slot still running",
    ),
  );

  // ─── 4. Wall clock + cooperative cancellation ───────────────────────
  console.log("── 4. Wall clock + cooperative cancellation ──");
  assert(
    "scheduler defines SLOT_WALL_CLOCK_MS at 10 minutes",
    fileContains("server/loadFactScheduler.ts", "SLOT_WALL_CLOCK_MS = 10 * 60 * 1000"),
    "A wall clock is what bounds the worst case if a slot body itself hangs",
  );
  assert(
    "scheduler races the slot body against the wall clock via runWithWallClock",
    fileContains("server/loadFactScheduler.ts", "runWithWallClock("),
  );
  assert(
    "scheduler logs wall-clock kills distinctly so they're greppable in production",
    fileContains("server/loadFactScheduler.ts", "killed by wall clock"),
  );
  assert(
    "runWithWallClock aborts the controller on timeout (not just rejects)",
    fileContains("server/loadFactScheduler.ts", "controller.abort()"),
    "The whole point of the AbortController is that it must fire when the wall clock does",
  );
  assert(
    "runSlot accepts an AbortSignal",
    fileContains("server/loadFactScheduler.ts", "opts?: { signal?: AbortSignal }"),
  );
  assert(
    "runSlot checks signal.aborted between orgs",
    fileContains("server/loadFactScheduler.ts", "if (opts?.signal?.aborted)"),
    "Without this check the loop would keep iterating orgs after the wall clock fires, racing the next tick",
  );
  assert(
    "_invokeSlot threads the wall-clock signal into runSlot",
    fileContains("server/loadFactScheduler.ts", "runSlot(slot, { signal })"),
  );

  // ─── 5. Test helpers + AbortSignal propagation (functional) ─────────
  console.log("── 5. Test helpers + AbortSignal propagation ──");

  // Importing the scheduler module executes its top-level code (declares
  // the in-flight record, defines runWithWallClock) but does NOT call
  // initLoadFactScheduler(), so no cron tasks are registered. Safe to
  // import in tests.
  const sched = await import("../server/loadFactScheduler");

  sched._resetSlotInFlightForTests();
  assert(
    "_isSlotInFlightForTests('morning') is false after reset",
    sched._isSlotInFlightForTests("morning") === false,
  );
  assert(
    "_isSlotInFlightForTests('afternoon') is false after reset",
    sched._isSlotInFlightForTests("afternoon") === false,
  );
  assert(
    "_getSlotWallClockMsForTests reports the 10-min budget",
    sched._getSlotWallClockMsForTests() === 10 * 60 * 1000,
  );

  // Behavioral test: when the wall clock fires, the inner fn's
  // AbortSignal must be aborted BEFORE the wrapping promise rejects.
  // This is what guarantees no orphaned background work — the hardening
  // pattern's most important invariant.
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
    "runWithWallClock rejects with SlotTimeoutError on timeout",
    rejectedWith instanceof sched._SlotTimeoutErrorForTests,
  );
  assert(
    "runWithWallClock aborts the inner AbortSignal on timeout",
    observedSignalAbortedAtReject === true,
    "Without abort propagation, the inner work continues running after the wrapper rejects",
  );

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
