/**
 * PAFOE scheduled-wave dispatcher.
 *
 * Phase 4 of the Proactive Available Freight Outreach Engine. Every
 * `INTERVAL_MS` we drain the queue of `freight_opportunities` whose
 * `scheduled_for` has elapsed and send their next wave. Re-evaluates
 * Phase 2 guardrails per send.
 *
 * Lifted out of an inline `setInterval` in server/index.ts so it has a
 * proper module name, an init function matching the other schedulers,
 * and a single observable surface.
 */
import cron from "node-cron";
import { storage } from "./storage";
import { JOB_NAMES, withHeartbeat } from "./lib/cronHeartbeat";

const INTERVAL_MS = 120_000; // every 2 minutes
const STARTUP_DELAY_MS = 6_000;

// Cron-anchored every 2 minutes. The previous setInterval(2min) reset on
// every workflow restart, so a flapping deploy could leave dispatched
// waves piling up. Heartbeated for liveness observability.
let cronTask: ReturnType<typeof cron.schedule> | null = null;

// In-process mutex matches the pattern in mailboxDeltaSyncService. The
// boot-kick (fires STARTUP_DELAY_MS after init) and the first cron tick
// can land almost simultaneously if init runs near a 2-minute clock
// boundary; the mutex makes that overlap a no-op rather than two parallel
// dispatchers fighting over the same `freight_opportunities` rows.
let _tickInFlight = false;

function logMessage(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [pafoe-scheduler] ${msg}`);
}

async function tick(): Promise<void> {
  if (_tickInFlight) {
    logMessage("skipping tick — previous tick still in flight");
    return;
  }
  _tickInFlight = true;
  try {
    const { processDueScheduledWaves } = await import("./freightOpportunityOutreachService");
    const r = await processDueScheduledWaves(storage);
    if (r.processed > 0) {
      logMessage(`processed=${r.processed} sent=${r.sent} blocked=${r.blocked} failed=${r.failed}`);
    }
  } catch (e) {
    logMessage(`tick error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    _tickInFlight = false;
  }
}

export function initPafoeWaveScheduler(): void {
  if (cronTask) return; // idempotent — survives hot-reload in dev
  setTimeout(() => {
    void withHeartbeat(JOB_NAMES.pafoeWaveDispatcher, INTERVAL_MS, tick);
    cronTask = cron.schedule("*/2 * * * *", () => {
      void withHeartbeat(JOB_NAMES.pafoeWaveDispatcher, INTERVAL_MS, tick);
    });
    logMessage(`PAFOE wave scheduler initialized (every 2min via node-cron)`);
  }, STARTUP_DELAY_MS);
}
