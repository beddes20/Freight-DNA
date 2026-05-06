/**
 * Available Freight import scheduler (task #354).
 *
 * Runs the OneDrive importer every weekday morning so that reps see a fresh
 * Available Freight queue when they log in. Uses the same node-cron pattern
 * as the surrounding schedulers in this folder.
 */

import cron from "node-cron";
import { runScheduledAvailableFreightImports } from "./availableFreightImporter";
import { runScheduledSlaSweep, SLA_L1_HOURS, SLA_L2_HOURS } from "./freightOpportunitySlaService";
import { runAutoPilotTick } from "./freightOpportunityAutoPilot";

const CT_TZ = "America/Chicago";
// 6:30 AM CT, Monday–Friday. Reps typically open My Procurement around 7am.
const CRON_EXPR = "30 6 * * 1-5";
// Task #364 — every 15 min, sweep awaiting-approval opportunities and fire
// L1 nudges / L2 escalations once each per opp. Override with
// FREIGHT_APPROVAL_SLA_CRON for tighter or looser cadence in dev.
const SLA_CRON_EXPR = process.env.FREIGHT_APPROVAL_SLA_CRON || "*/15 * * * *";
// Task #601 — Available Freight Cockpit auto-pilot. Top of every hour CT.
const AUTOPILOT_CRON_EXPR = process.env.FREIGHT_AUTOPILOT_CRON || "0 * * * *";

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
  cron.schedule(
    SLA_CRON_EXPR,
    () => {
      runScheduledSlaSweep().catch((err) => {
        console.error("[freight-sla-sweep] tick failed:", err);
      });
    },
    { timezone: CT_TZ },
  );
  cron.schedule(
    AUTOPILOT_CRON_EXPR,
    () => {
      runAutoPilotTick().then((r) => {
        if (r.policiesFired > 0 || r.errors.length > 0) {
          console.log(
            `[freight-autopilot] tick fired=${r.policiesFired} considered=${r.policiesConsidered} ` +
            `opps=${r.opportunitiesProcessed} sent=${r.carriersSent} blocked=${r.carriersBlocked} ` +
            `errors=${r.errors.length}`,
          );
        }
      }).catch((err) => {
        console.error("[freight-autopilot] tick failed:", err);
      });
    },
    { timezone: CT_TZ },
  );
  console.log(
    `[available-freight-scheduler] initialized (import: ${CRON_EXPR}, ` +
    `sla-sweep: ${SLA_CRON_EXPR}, L1=${SLA_L1_HOURS}h, L2=${SLA_L2_HOURS}h, ` +
    `autopilot: ${AUTOPILOT_CRON_EXPR}, tz: ${CT_TZ})`,
  );
}
