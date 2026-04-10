/**
 * Market Signal Scheduler
 *
 * Runs the Market Signal Engine evaluation periodically (every 6 hours).
 * Follows the existing node-cron pattern used by nbaPhase1Scheduler.ts.
 */

import cron from "node-cron";
import { storage } from "./storage";
import { MarketSignalEngine } from "./marketSignalEngine";

function log(msg: string) {
  const t = new Date().toISOString();
  console.log(`[market-signal] ${t} ${msg}`);
}

const engine = new MarketSignalEngine(storage);

async function runMarketSignalEvaluation(): Promise<void> {
  log("Starting market signal evaluation run…");
  try {
    await engine.evaluateMarketSignals();
    log("Market signal evaluation complete.");
  } catch (err: any) {
    log(`ERROR during evaluation: ${err?.message ?? err}`);
  }
}

export function initMarketSignalScheduler(): void {
  // Every 6 hours: 0 0,6,12,18 * * *
  cron.schedule("0 0,6,12,18 * * *", runMarketSignalEvaluation, { timezone: "America/Chicago" });
  log("Market signal scheduler registered (every 6 hours CT)");
}
