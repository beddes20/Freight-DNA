/**
 * Carrier Intel nightly expiration scheduler (Task #769).
 *
 * Runs the stale-pending cleanup defined in
 * services/carrierIntelSuggestionExpiration so the "Needs Review" queue
 * never grows unbounded. Cron defaults to 02:15 server time nightly.
 */
import cron from "node-cron";
import { runCarrierIntelStaleCleanupForAllOrgs } from "./services/carrierIntelSuggestionExpiration";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [carrier-intel-expiration] ${message}`);
}

export async function runCarrierIntelExpirationNow(): Promise<void> {
  const start = Date.now();
  const results = await runCarrierIntelStaleCleanupForAllOrgs();
  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      autoAccepted: acc.autoAccepted + r.autoAccepted,
      autoDismissed: acc.autoDismissed + r.autoDismissed,
    }),
    { scanned: 0, autoAccepted: 0, autoDismissed: 0 },
  );
  logMessage(
    `cleanup complete in ${Date.now() - start}ms — orgs=${results.length} scanned=${totals.scanned} auto_accepted=${totals.autoAccepted} auto_dismissed=${totals.autoDismissed}`,
  );
}

export function initCarrierIntelExpirationScheduler(): void {
  const cronExpression = process.env.CARRIER_INTEL_EXPIRATION_CRON || "15 2 * * *";
  cron.schedule(cronExpression, () => {
    runCarrierIntelExpirationNow().catch(err =>
      logMessage(`Error in expiration scheduler: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
  logMessage(`Carrier intel expiration scheduler initialized (cron: ${cronExpression})`);
}
