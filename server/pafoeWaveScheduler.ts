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
import { storage } from "./storage";

const INTERVAL_MS = 120_000; // every 2 minutes
const STARTUP_DELAY_MS = 6_000;

let timer: NodeJS.Timeout | null = null;

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
  try {
    const { processDueScheduledWaves } = await import("./freightOpportunityOutreachService");
    const r = await processDueScheduledWaves(storage);
    if (r.processed > 0) {
      logMessage(`processed=${r.processed} sent=${r.sent} blocked=${r.blocked} failed=${r.failed}`);
    }
  } catch (e) {
    logMessage(`tick error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function initPafoeWaveScheduler(): void {
  if (timer) return; // idempotent — survives hot-reload in dev
  setTimeout(() => {
    tick();
    timer = setInterval(tick, INTERVAL_MS);
    logMessage(`PAFOE wave scheduler initialized (every ${INTERVAL_MS / 1000}s)`);
  }, STARTUP_DELAY_MS);
}
