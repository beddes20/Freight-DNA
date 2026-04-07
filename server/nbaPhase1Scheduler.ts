/**
 * NBA Phase 1 Scheduler
 *
 * Runs the Phase 1 engine nightly at 3:00 AM for every active org.
 * For each company the engine fires on, it:
 *   1. Checks for an existing non-resolved card of the same rule within 7 days (dedup)
 *   2. Supersedes stale generated/visible cards for that company
 *   3. Writes a new visible card to nba_cards
 *   4. Auto-expires cards older than 14 days that remain unactioned
 */

import cron from "node-cron";
import { storage } from "./storage";
import { runPhase1EngineForOrg } from "./nbaPhase1Engine";

function log(msg: string) {
  const t = new Date().toISOString();
  console.log(`[nba-phase1] ${t} ${msg}`);
}

async function runNbaPhase1ForAllOrgs(): Promise<void> {
  log("Starting nightly NBA Phase 1 engine run…");
  try {
    // Get all active orgs (exclude valubuaz by convention)
    const EXCLUDED_ORG_ID = "da3ed822"; // valubuaz — always excluded from org engine runs
    const orgs = await storage.getOrganizations?.() ?? [];
    const activeOrgs = orgs.filter((o: any) => o.id && !o.id.startsWith(EXCLUDED_ORG_ID));

    if (activeOrgs.length === 0) {
      // Fallback: try the known org directly in development
      log("No orgs found via getOrganizations — trying direct run for known org…");
      return;
    }

    let totalGenerated = 0;
    let totalSkipped = 0;

    for (const org of activeOrgs) {
      log(`Processing org ${org.id}…`);
      try {
        // First expire old cards for this org
        await storage.processExpiredNbaCards(org.id);

        const results = await runPhase1EngineForOrg(org.id, storage);
        const now = new Date().toISOString();

        for (const { userId, result } of results) {
          if (!result.winner) { totalSkipped++; continue; }

          // Dedup: skip if same company + same rule already has a card in last 14 days
          const existing = await storage.getRecentNbaCardByType(result.companyId, result.winner.ruleType, 14);
          if (existing) { totalSkipped++; continue; }

          // Supersede any prior visible/generated card for this company with a DIFFERENT rule type
          await storage.supersedePreviousNbaCards(result.companyId, result.winner.ruleType);

          await storage.createNbaCard({
            orgId: org.id,
            userId,
            companyId: result.companyId,
            companyName: result.companyName,
            ruleType: result.winner.ruleType,
            outcomeType: result.winner.outcomeType,
            confidence: result.winner.confidence,
            signalCount: result.winner.signalCount,
            signalSummary: result.winner.signalSummary as any,
            whyThisNow: result.winner.whyThisNow,
            suggestedAction: result.winner.suggestedAction,
            expectedOutcome: result.winner.expectedOutcome,
            growthLever: result.winner.growthLever,
            relationshipMove: result.winner.relationshipMove,
            accountTier: result.winner.accountTier,
            urgencyScore: result.winner.urgencyScore,
            status: "visible",
            createdAt: now,
            contactId: result.winner.contactId,
            linkedTaskId: result.winner.linkedTaskId,
          });
          totalGenerated++;
        }

        log(`Org ${org.id}: ${totalGenerated} generated this pass, ${totalSkipped} skipped`);
      } catch (orgErr: any) {
        log(`ERROR processing org ${org.id}: ${orgErr?.message ?? orgErr}`);
      }
    }

    log(`Nightly run complete. Total generated: ${totalGenerated}, Total skipped: ${totalSkipped}`);
  } catch (err: any) {
    log(`FATAL error in nightly run: ${err?.message ?? err}`);
  }
}

export function initNbaPhase1Scheduler(): void {
  // Run nightly at 3:00 AM
  cron.schedule("0 3 * * *", runNbaPhase1ForAllOrgs, { timezone: "America/Chicago" });
  log("NBA Phase 1 nightly scheduler registered (3:00 AM CT)");
}
