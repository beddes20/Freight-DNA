/**
 * load_fact PowerBI import scheduler (Task #368).
 *
 * Two cron slots — early-morning (5:30 AM CT, before reps log in) and
 * mid-afternoon (1:30 PM CT, before EOD). Each slot is independently
 * gated per org by `getLoadFactScheduleConfig` so admins can disable
 * a slot without editing code, and each tick is skipped if a manual
 * import is already in flight (the importer enforces a per-org mutex).
 *
 * April 28 follow-up — applies the email-intelligence hardening pattern
 * (server/emailIntelligenceScheduler.ts) to this scheduler so a slot
 * cannot silently overlap, hang forever, or run without a heartbeat:
 *
 *   - Per-slot in-flight guard (`_slotInFlight`). If a slot is still
 *     running when the next tick fires (e.g. the cron lib re-triggered
 *     after a workflow restart, or the slot took longer than its tick
 *     budget), the new tick is logged and skipped instead of overlapping.
 *
 *   - Wall clock (`SLOT_WALL_CLOCK_MS = 10 min`) races the slot body via
 *     `runWithWallClock`. On timeout the AbortController is aborted AND
 *     the wrapping promise rejects with a distinct `SlotTimeoutError`
 *     so it's greppable in production logs.
 *
 *   - Cooperative cancellation. `runSlot` accepts the wall-clock signal
 *     and checks `signal.aborted` between orgs in the per-org loop, so
 *     a wall-clock kill exits cleanly instead of orphaning a background
 *     loop that would race the next tick. The abort boundary is per-org
 *     because `performLoadFactImport` is not itself signal-aware — a
 *     single in-flight org import will run to completion (or fail) and
 *     remaining orgs are deferred to the next tick.
 *
 *   - `withHeartbeat()` instrumentation per slot under
 *     `JOB_NAMES.loadFactImportMorning` / `loadFactImportAfternoon` so
 *     missed ticks and stuck `running` corpses surface in
 *     `cron_heartbeats` (and roll up to the integrations-health page).
 */

import cron from "node-cron";
import { storage } from "./storage";
import { performLoadFactImport } from "./loadFactPowerBIImporter";
import {
  getLoadFactScheduleConfig,
  isSlotActive,
  loadFactPowerBiUrlKey,
} from "./carrierIntelligenceService";
import { JOB_NAMES, withHeartbeat, type JobName } from "./lib/cronHeartbeat";

const CT_TZ = "America/Chicago";
const MORNING_CRON = "30 5 * * *";
const AFTERNOON_CRON = "30 13 * * *";

// Daily-cadence jobs. Used as the heartbeat row's nextExpectedAt offset so
// the staleness detector knows a missed tick is meaningful within ~24h.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let started = false;

type Slot = "morning" | "afternoon";

const SLOT_JOB_NAME: Record<Slot, JobName> = {
  morning: JOB_NAMES.loadFactImportMorning,
  afternoon: JOB_NAMES.loadFactImportAfternoon,
};

// ─── In-flight guard + wall clock (mirrors emailIntelligenceScheduler) ──
//
// Per-slot rather than process-wide because the morning and afternoon slots
// are independently scheduled jobs with independent heartbeat rows; one
// being in-flight should not block the other from running.

const _slotInFlight: Record<Slot, boolean> = { morning: false, afternoon: false };

const SLOT_WALL_CLOCK_MS = 10 * 60 * 1000;

class SlotTimeoutError extends Error {
  constructor(slot: Slot, ms: number) {
    super(`load_fact_import_${slot} exceeded ${ms}ms wall clock`);
    this.name = "SlotTimeoutError";
  }
}

/**
 * Race `fn(controller.signal)` against an `ms` deadline. On timeout the
 * controller is aborted (so cooperative cancellation can stop the body)
 * AND the returned promise rejects with `SlotTimeoutError`. Mirrors
 * `runWithWallClock` in emailIntelligenceScheduler.
 */
function runWithWallClock<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  slot: Slot,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SlotTimeoutError(slot, ms));
    }, ms);
    timer.unref?.();
    fn(controller.signal).then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runSlot(
  slot: Slot,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const orgs = await storage.getOrganizations();
  for (const org of orgs) {
    // Cooperative cancellation. When the wall clock fires it aborts the
    // shared controller; we exit the loop here so the wrapping promise
    // can resolve cleanly and the in-flight guard releases. Without this
    // the loop would continue running orgs in the background after the
    // wall clock killed the wrapper, racing the next cron tick — exactly
    // the pile-up the in-flight guard is meant to prevent.
    if (opts?.signal?.aborted) {
      console.log(
        `[load-fact-scheduler] slot=${slot} aborted between orgs ` +
        `(wall clock fired); remaining orgs deferred to the next tick`,
      );
      break;
    }
    try {
      const url = await storage.getSetting(loadFactPowerBiUrlKey(org.id));
      if (!url) {
        // Honesty pass: previously this branch was a silent `continue`, which
        // made an unconfigured pipeline look identical to a healthy one in
        // production logs. Surface a single WARN per org per tick so admins
        // can see "we tried to import but you haven't configured the source".
        console.warn(
          `[load-fact-scheduler] org=${org.id} slot=${slot} skipped: ` +
          `load_fact_powerbi_url not configured. Set it under ` +
          `Admin → Integrations Health → Load Fact pipeline to enable imports.`,
        );
        continue;
      }
      const cfg = await getLoadFactScheduleConfig(org.id);
      if (!isSlotActive(cfg, slot)) {
        console.log(`[load-fact-scheduler] org=${org.id} slot=${slot} skipped (cfg=${JSON.stringify(cfg)})`);
        continue;
      }
      const summary = await performLoadFactImport({
        orgId: org.id, actorUserId: null, triggeredBy: "scheduled",
      });
      console.log(
        `[load-fact-scheduler] org=${org.id} slot=${slot} file=${summary.fileName} ` +
        `inserted=${summary.inserted} updated=${summary.updated} unchanged=${summary.unchanged} ` +
        `transitioned=${summary.transitioned} expired=${summary.expired} ` +
        `available=${summary.buckets.available} realized=${summary.buckets.realized}` +
        (summary.replayed ? " (replayed)" : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Lock collisions are expected when an admin kicks off a manual import
      // right around the cron tick — log quietly.
      if (msg.includes("Another load_fact import is already running")) {
        console.log(`[load-fact-scheduler] org=${org.id} slot=${slot} skipped: ${msg}`);
        continue;
      }
      console.error(`[load-fact-scheduler] org=${org.id} slot=${slot} import failed:`, msg);
    }
  }
}

/**
 * Internal: the single execution path used by both cron tick callbacks.
 * Enforces the per-slot in-flight guard, the heartbeat wrapper, and the
 * wall clock with cooperative abort. Returns whether the slot was
 * actually started.
 */
function _invokeSlot(slot: Slot): boolean {
  if (_slotInFlight[slot]) {
    console.log(
      `[load-fact-scheduler] skipping ${slot} tick: previous slot still running`,
    );
    return false;
  }
  _slotInFlight[slot] = true;
  void withHeartbeat(SLOT_JOB_NAME[slot], ONE_DAY_MS, () =>
    runWithWallClock(
      signal => runSlot(slot, { signal }),
      SLOT_WALL_CLOCK_MS,
      slot,
    ),
  )
    .catch(err => {
      if (err instanceof SlotTimeoutError) {
        console.error(
          `[load-fact-scheduler] ${slot} slot killed by wall clock (${SLOT_WALL_CLOCK_MS}ms) — next tick will start fresh`,
        );
      } else {
        console.error(`[load-fact-scheduler] ${slot} slot error:`, err);
      }
    })
    .finally(() => {
      _slotInFlight[slot] = false;
    });
  return true;
}

export function initLoadFactScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule(MORNING_CRON, () => {
    _invokeSlot("morning");
  }, { timezone: CT_TZ });
  cron.schedule(AFTERNOON_CRON, () => {
    _invokeSlot("afternoon");
  }, { timezone: CT_TZ });
  console.log(`[load-fact-scheduler] initialized (morning="${MORNING_CRON}", afternoon="${AFTERNOON_CRON}", tz=${CT_TZ})`);
}

// ─── Test-only exports (mirror emailIntelligenceScheduler) ─────────────

/** Test-only: snapshot whether a slot is currently in flight. */
export function _isSlotInFlightForTests(slot: Slot): boolean {
  return _slotInFlight[slot];
}

/** Test-only: reset both in-flight flags between tests. */
export function _resetSlotInFlightForTests(): void {
  _slotInFlight.morning = false;
  _slotInFlight.afternoon = false;
}

/** Test-only: surface the wall-clock budget. */
export function _getSlotWallClockMsForTests(): number {
  return SLOT_WALL_CLOCK_MS;
}

/**
 * Test-only: expose the wall-clock helper so behavioral tests can verify
 * the AbortController is actually aborted on timeout, not just that the
 * outer promise rejects. Defaults to the morning slot for the error
 * message; behavior is identical for either slot.
 */
export function _runWithWallClockForTests<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  return runWithWallClock(fn, ms, "morning");
}

/** Test-only: surface the timeout error class for `instanceof` assertions. */
export const _SlotTimeoutErrorForTests = SlotTimeoutError;
