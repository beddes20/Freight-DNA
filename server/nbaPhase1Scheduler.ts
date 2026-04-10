/**
 * NBA Phase 1 Scheduler
 *
 * Runs the Phase 1 engine nightly at 3:00 AM for every active org.
 * For each company the engine fires on, it:
 *   1. Checks for an existing non-resolved card of the same rule within 7 days (dedup)
 *   2. Supersedes stale generated/visible cards for that company
 *   3. Writes a new visible card to nba_cards
 *   4. Auto-expires cards older than 14 days that remain unactioned
 *
 * Separately, per-lane × owner cards from generateLaneCapacityCards() are
 * deduped by (laneId, userId) with a 30-day window and written with linkedLaneId set.
 */

import cron from "node-cron";
import { storage } from "./storage";
import { runPhase1EngineForOrg } from "./nbaPhase1Engine";
import { runRecurringLaneEngineForOrg } from "./recurringLaneCapacityEngine";
import { scoreAllEligibleLanes } from "./laneScoringService";
import { syncMarketSignalNbas } from "./marketNbaService";

function log(msg: string) {
  const t = new Date().toISOString();
  console.log(`[nba-phase1] ${t} ${msg}`);
}

async function runNbaPhase1ForAllOrgs(): Promise<void> {
  log("Starting nightly NBA Phase 1 engine run…");
  try {
    const EXCLUDED_ORG_ID = "da3ed822"; // valubuaz — always excluded from org engine runs
    const orgs = await storage.getOrganizations?.() ?? [];
    const activeOrgs = orgs.filter((o: any) => o.id && !o.id.startsWith(EXCLUDED_ORG_ID));

    if (activeOrgs.length === 0) {
      log("No orgs found via getOrganizations — trying direct run for known org…");
      return;
    }

    let totalGenerated = 0;
    let totalSkipped = 0;

    for (const org of activeOrgs) {
      log(`Processing org ${org.id}…`);
      try {
        await storage.processExpiredNbaCards(org.id);

        // Refresh recurring lane data and scores before card generation
        // Only runs when the feature flag is on for this org — avoids unnecessary
        // financial-row scans for orgs that haven't enabled lane carrier outreach.
        const laneOutreachEnabled = await storage.getFeatureFlag(org.id, "lane_carrier_outreach_v1").catch(() => false);
        if (laneOutreachEnabled) {
          try {
            const { upserted } = await runRecurringLaneEngineForOrg(org.id, storage);
            if (upserted > 0) {
              await scoreAllEligibleLanes(org.id, storage);
              log(`Org ${org.id}: lane engine upserted ${upserted} lanes, scored eligible`);
            }
          } catch (laneErr: any) {
            log(`Org ${org.id}: lane engine warning (non-fatal): ${laneErr?.message ?? laneErr}`);
          }
        }

        const engineOutput = await runPhase1EngineForOrg(org.id, storage);
        const now = new Date().toISOString();

        // ── Per-company winner cards ─────────────────────────────────────────
        for (const { userId, result } of engineOutput.companyResults) {
          if (!result.winner) { totalSkipped++; continue; }

          const existing = await storage.getRecentNbaCardByType(result.companyId, result.winner.ruleType, 14);
          if (existing) { totalSkipped++; continue; }

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
            signalSummary: result.winner.signalSummary as string[],
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

        // ── Per-lane × owner cards (recurring_lane_capacity) ─────────────────
        for (const spec of engineOutput.laneCapacitySpecs) {
          // Dedup: skip if this (laneId, userId) already has a card within 30 days
          const existingLane = await storage.getRecentNbaCardByLane(spec.laneId, spec.userId, 30);
          if (existingLane) { totalSkipped++; continue; }

          await storage.createNbaCard({
            orgId: org.id,
            userId: spec.userId,
            companyId: spec.companyId,
            companyName: spec.companyName,
            ruleType: spec.candidate.ruleType,
            outcomeType: spec.candidate.outcomeType,
            confidence: spec.candidate.confidence,
            signalCount: spec.candidate.signalCount,
            signalSummary: spec.candidate.signalSummary as string[],
            whyThisNow: spec.candidate.whyThisNow,
            suggestedAction: spec.candidate.suggestedAction,
            expectedOutcome: spec.candidate.expectedOutcome,
            growthLever: spec.candidate.growthLever,
            relationshipMove: spec.candidate.relationshipMove,
            accountTier: spec.candidate.accountTier,
            urgencyScore: spec.candidate.urgencyScore,
            status: "visible",
            createdAt: now,
            linkedLaneId: spec.laneId,
          });
          totalGenerated++;
        }

        // ── Market Signal NBAs ────────────────────────────────────────────────
        try {
          const { created } = await syncMarketSignalNbas(org.id, storage);
          if (created > 0) {
            log(`Org ${org.id}: market signal NBAs created=${created}`);
            totalGenerated += created;
          }
        } catch (marketErr: any) {
          log(`Org ${org.id}: market NBA sync warning (non-fatal): ${marketErr?.message ?? marketErr}`);
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
  cron.schedule("0 3 * * *", runNbaPhase1ForAllOrgs, { timezone: "America/Chicago" });
  log("NBA Phase 1 nightly scheduler registered (3:00 AM CT)");
}
