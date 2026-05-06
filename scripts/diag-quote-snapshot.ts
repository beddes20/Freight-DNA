/**
 * Direct diagnostic: invoke getSnapshot for Value Truck with the same
 * `age=today` filter the Quote Requests page sends. Print the returned
 * KPIs verbatim so we can compare against the SQL ground-truth.
 */
import { getSnapshot } from "../server/services/customerQuotes";

const ORG_ID = "da3ed822-8846-4435-bb13-3cc4bf26f71d";

async function main() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const filters = {
    startDate: start.toISOString(),
    endDate: now.toISOString(),
  };

  console.log("[diag] Calling getSnapshot with filters:", filters);
  console.log("[diag] Server time:", now.toISOString());
  console.log("[diag] Server local midnight:", start.toISOString());

  const snap = await getSnapshot(ORG_ID, filters as any);

  console.log("\n=== KPIs ===");
  console.log("total            :", snap.kpis.total);
  console.log("won              :", snap.kpis.won);
  console.log("lost             :", snap.kpis.lost);
  console.log("pending          :", snap.kpis.pending);
  console.log("autoCapturedToday:", snap.kpis.autoCapturedToday);
  console.log("avgQuoted        :", snap.kpis.avgQuoted);

  console.log("\n=== Validity window ===");
  console.log("activeCount  :", snap.validityWindow.activeCount);
  console.log("expiredCount :", snap.validityWindow.expiredCount);
  console.log("staleCount   :", snap.validityWindow.staleCount);

  console.log("\n=== Taxonomy ===");
  console.log(snap.taxonomy);

  process.exit(0);
}

main().catch((err) => {
  console.error("[diag] FAILED:", err);
  process.exit(1);
});
