import { computeNextBestAction } from "./nextBestActionEngine";
import { storage } from "./storage";

async function main() {
  const COMPANY_ID = "08970369-595f-4e29-b1b8-5753f3d40c62";
  const company = await storage.getCompany(COMPANY_ID);
  console.log("Company:", company?.name, "| org:", company?.organizationId);
  if (!company) { console.log("NOT FOUND"); process.exit(1); }
  
  const result = await computeNextBestAction(COMPANY_ID, company.organizationId, storage);
  const { signals, ...rest } = result;
  console.log("NBA:", JSON.stringify(rest, null, 2));
  console.log("Signals:", JSON.stringify({
    band: signals.currentBand,
    score: signals.currentScore,
    daysSinceTouch: signals.daysSinceLastTouch,
    contacts: signals.contacts.length,
    rfps: signals.openRfps.length,
    lanes: signals.laneCorridorCount,
  }, null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
