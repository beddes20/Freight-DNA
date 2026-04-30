/**
 * Truck-Posting Scheduler (Task #844)
 *
 * Hourly job that:
 *   1. Expires truck_postings whose available_through (or available_date when no
 *      window is given) is in the past, or whose explicit expires_at has passed.
 *   2. Marks linked truck_load_matches whose posting expired as state="stale".
 *
 * Pattern mirrors `carrierIntelNudgeScheduler` — it is initialized once from
 * `server/index.ts` after the HTTP server is listening.
 */

import { storage } from "./storage";
import { markStaleMatches } from "./truckLoadMatchingService";

const ONE_HOUR_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export async function runTruckPostingMaintenance(): Promise<{ expired: number; staled: number }> {
  const now = new Date();
  const expired = await storage.expireTruckPostings(now);
  const staled = await markStaleMatches();
  if (expired > 0 || staled > 0) {
    console.log(`[truckPostingScheduler] expired=${expired} staled=${staled}`);
  }
  return { expired, staled };
}

export function initTruckPostingScheduler(): void {
  if (timer) return;
  // first run a few seconds after boot so it doesn't block startup
  setTimeout(() => {
    runTruckPostingMaintenance().catch(err =>
      console.error("[truckPostingScheduler] maintenance failed:", err),
    );
  }, 30_000);
  timer = setInterval(() => {
    runTruckPostingMaintenance().catch(err =>
      console.error("[truckPostingScheduler] maintenance failed:", err),
    );
  }, ONE_HOUR_MS);
}

export function stopTruckPostingScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
