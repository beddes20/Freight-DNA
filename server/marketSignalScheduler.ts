/**
 * Market Signal Scheduler
 *
 * Runs the Market Signal Engine evaluation periodically (every 6 hours).
 * Follows the existing node-cron pattern used by nbaPhase1Scheduler.ts.
 */

import cron from "node-cron";
import { storage } from "./storage";
import { MarketSignalEngine } from "./marketSignalEngine";
import { syncCarrierMarketNbas } from "./carrierMarketNbaService";
import type { IStorage } from "./storage";

function log(msg: string) {
  const t = new Date().toISOString();
  console.log(`[market-signal] ${t} ${msg}`);
}

const engine = new MarketSignalEngine(storage);

type CarrierNbaSync = typeof syncCarrierMarketNbas;
type EngineEvaluate = () => Promise<void>;

/**
 * Injectable evaluation function — accepts collaborators explicitly.
 * Used in production (with module-level singletons) and in tests (with mocks).
 */
export async function runEvaluationWithDeps(
  evaluate: EngineEvaluate,
  storageRef: Pick<IStorage, "getOrganizations">,
  carrierSync: CarrierNbaSync,
): Promise<void> {
  log("Starting market signal evaluation run…");
  try {
    await evaluate();
    log("Market signal evaluation complete.");

    // Sync carrier market NBAs immediately after evaluation
    try {
      const orgs = (await storageRef.getOrganizations?.()) ?? [];
      const EXCLUDED_ORG_ID = "da3ed822";
      const activeOrgs = orgs.filter((o: any) => o.id && !o.id.startsWith(EXCLUDED_ORG_ID));
      for (const org of activeOrgs) {
        const { created, updated } = await carrierSync(org.id, storageRef as IStorage);
        if (created > 0 || updated > 0) {
          log(`Org ${org.id}: carrier market NBAs created=${created}, updated=${updated}`);
        }
      }
    } catch (carrierErr: any) {
      log(`WARNING: carrier NBA sync failed (non-fatal): ${carrierErr?.message ?? carrierErr}`);
    }
  } catch (err: any) {
    log(`ERROR during evaluation: ${err?.message ?? err}`);
  }
}

export async function runMarketSignalEvaluation(): Promise<void> {
  await runEvaluationWithDeps(
    () => engine.evaluateMarketSignals(),
    storage,
    syncCarrierMarketNbas,
  );
}

export function initMarketSignalScheduler(): void {
  // Every 6 hours: 0 0,6,12,18 * * *
  cron.schedule("0 0,6,12,18 * * *", runMarketSignalEvaluation, { timezone: "America/Chicago" });
  log("Market signal scheduler registered (every 6 hours CT)");
}
