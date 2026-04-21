/**
 * load_fact PowerBI import scheduler (Task #368).
 *
 * Two cron slots — early-morning (5:30 AM CT, before reps log in) and
 * mid-afternoon (1:30 PM CT, before EOD). Each slot is independently
 * gated per org by `getLoadFactScheduleConfig` so admins can disable
 * a slot without editing code, and each tick is skipped if a manual
 * import is already in flight (the importer enforces a per-org mutex).
 */

import cron from "node-cron";
import { storage } from "./storage";
import { performLoadFactImport } from "./loadFactPowerBIImporter";
import {
  getLoadFactScheduleConfig,
  isSlotActive,
  loadFactPowerBiUrlKey,
} from "./carrierIntelligenceService";

const CT_TZ = "America/Chicago";
const MORNING_CRON = "30 5 * * *";
const AFTERNOON_CRON = "30 13 * * *";

let started = false;

async function runSlot(slot: "morning" | "afternoon"): Promise<void> {
  const orgs = await storage.getOrganizations();
  for (const org of orgs) {
    try {
      const url = await storage.getSetting(loadFactPowerBiUrlKey(org.id));
      if (!url) continue;
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

export function initLoadFactScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule(MORNING_CRON, () => {
    runSlot("morning").catch(err => console.error("[load-fact-scheduler] morning tick failed:", err));
  }, { timezone: CT_TZ });
  cron.schedule(AFTERNOON_CRON, () => {
    runSlot("afternoon").catch(err => console.error("[load-fact-scheduler] afternoon tick failed:", err));
  }, { timezone: CT_TZ });
  console.log(`[load-fact-scheduler] initialized (morning="${MORNING_CRON}", afternoon="${AFTERNOON_CRON}", tz=${CT_TZ})`);
}
