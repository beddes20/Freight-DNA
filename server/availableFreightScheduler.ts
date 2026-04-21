/**
 * Available Freight import scheduler (task #354).
 *
 * Runs the OneDrive importer every weekday morning so that reps see a fresh
 * Available Freight queue when they log in. Uses the same node-cron pattern
 * as the surrounding schedulers in this folder.
 */

import cron from "node-cron";
import { runScheduledAvailableFreightImports } from "./availableFreightImporter";

const CT_TZ = "America/Chicago";
// 6:30 AM CT, Monday–Friday. Reps typically open My Procurement around 7am.
const CRON_EXPR = "30 6 * * 1-5";

let started = false;

export function initAvailableFreightImportScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule(
    CRON_EXPR,
    () => {
      runScheduledAvailableFreightImports().catch((err) => {
        console.error("[available-freight-scheduler] tick failed:", err);
      });
    },
    { timezone: CT_TZ },
  );
  console.log(`[available-freight-scheduler] initialized (cron: ${CRON_EXPR}, tz: ${CT_TZ})`);
}
