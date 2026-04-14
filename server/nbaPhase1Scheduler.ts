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
import { runPhase1EngineForOrg, evalR13MarketTightening, evalR14MarketLoosening } from "./nbaPhase1Engine";
import { runRecurringLaneEngineForOrg } from "./recurringLaneCapacityEngine";
import { scoreAllEligibleLanes } from "./laneScoringService";
import { syncMarketSignalNbas } from "./marketNbaService";
import { generateConversationOwnershipNbas } from "./nextBestActionEngine";
import { getAvgVotriWoW, getLaneVotrisBatch, getLaneVotrisBatchFresh, buildVotriQualifier } from "./sonarClient";
import { resolveColumns, getRepFromRow } from "./colResolver";
import { isExcludedRow } from "./financialHelpers";
import { getPlayForRuleType } from "./playsRegistry";

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

        // Track companies that already received a card this nightly run.
        // R13/R14 market cards check this set to enforce "one winner per account per run".
        const companiesWithCardsThisRun = new Set<string>();

        // ── Per-company winner cards ─────────────────────────────────────────
        for (const { userId, result } of engineOutput.companyResults) {
          if (!result.winner) { totalSkipped++; continue; }

          const existing = await storage.getRecentNbaCardByType(result.companyId, result.winner.ruleType, 14);
          if (existing) { totalSkipped++; continue; }

          await storage.supersedePreviousNbaCards(result.companyId, result.winner.ruleType);

          const play = getPlayForRuleType(result.winner.ruleType);
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
            playLabel: play?.name ?? null,
          });
          companiesWithCardsThisRun.add(result.companyId);
          totalGenerated++;
        }

        // ── Per-lane × owner cards (recurring_lane_capacity) ─────────────────
        for (const spec of engineOutput.laneCapacitySpecs) {
          // Dedup: skip if this (laneId, userId) already has a card within 30 days
          const existingLane = await storage.getRecentNbaCardByLane(spec.laneId, spec.userId, 30);
          if (existingLane) { totalSkipped++; continue; }

          const lanePlay = getPlayForRuleType(spec.candidate.ruleType);
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
            playLabel: lanePlay?.name ?? null,
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

        // ── Conversation Ownership NBAs (Task #202) ────────────────────────────
        try {
          const convThreads = await storage.listEmailConversationThreads(org.id, {
            waitingState: "waiting_on_us",
            limit: 500,
          });
          if (convThreads.length > 0) {
            await generateConversationOwnershipNbas(org.id, convThreads as any, storage as any);
            log(`Org ${org.id}: conversation ownership NBAs processed (${convThreads.length} threads)`);
          }
        } catch (convErr: any) {
          log(`Org ${org.id}: conversation NBA sync warning (non-fatal): ${convErr?.message ?? convErr}`);
        }

        // ── Sonar VOTRI Market NBAs (R13/R14) ─────────────────────────────────
        // Per spec: derive top-3 origin markets per company from financial upload data.
        // Each company's corridor list comes from its financial upload rows (by customer name match).
        // Enforces "one winner per account per nightly run": if the main Phase 1
        // engine already wrote a card for this company, skip market cards.
        try {
          const companies = await storage.getCompanies(org.id);
          const uploads = await storage.getFinancialUploadsForOrg(org.id).catch(() => []);

          if (uploads.length > 0 && companies.length > 0) {
            // Use the most recent financial upload
            const latestUpload = uploads.sort((a, b) =>
              (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")
            )[0];
            const rawRows: unknown = latestUpload.rows;
            const allRows: Record<string, unknown>[] = Array.isArray(rawRows) ? rawRows as Record<string, unknown>[] : [];

            // Normalize name for matching
            const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

            for (const company of companies) {
              if (!company.assignedTo) continue;
              if (companiesWithCardsThisRun.has(company.id)) continue;

              const crmNorm = norm(company.name);
              const aliasNorms = company.financialAlias
                ? (company.financialAlias as string).split(",").map((s: string) => norm(s.trim())).filter(Boolean)
                : [];
              const nameNorms = [crmNorm, ...aliasNorms];

              // Build origin market tally from financial rows matching this company
              const originTally = new Map<string, number>();
              const corrTally = new Map<string, { origin: string; dest: string; count: number }>();
              for (const row of allRows) {
                const cust = norm(String(row.customerName ?? row["Customer Name"] ?? row["CUSTOMER NAME"] ?? ""));
                if (!cust || !nameNorms.some(n => n && cust.includes(n))) continue;
                const origin = String(row.originCity ?? row["Shipper city"] ?? row["Origin city"] ?? row["shipper_city"] ?? "").trim();
                const dest = String(row.destCity ?? row["Consignee city"] ?? row["Destination city"] ?? row["dest_city"] ?? "").trim();
                if (!origin) continue;
                originTally.set(origin, (originTally.get(origin) ?? 0) + 1);
                if (dest) {
                  const corrKey = `${origin}→${dest}`;
                  const prev = corrTally.get(corrKey) ?? { origin, dest, count: 0 };
                  prev.count++;
                  corrTally.set(corrKey, prev);
                }
              }

              if (originTally.size === 0) continue;

              // Top 3 origin markets by load count
              const topOrigins = Array.from(originTally.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([city]) => city);

              // Build lane pairs for each top origin → top destination from that origin
              const topLanes: Array<{ origin: string; destination: string }> = [];
              for (const origin of topOrigins) {
                const bestCorr = Array.from(corrTally.values())
                  .filter(c => c.origin === origin)
                  .sort((a, b) => b.count - a.count)[0];
                if (bestCorr) {
                  topLanes.push({ origin: bestCorr.origin, destination: bestCorr.dest });
                } else {
                  // No corridor data — use origin only (will gracefully degrade in VOTRI lookup)
                  topLanes.push({ origin, destination: "" });
                }
              }

              const validLanes = topLanes.filter(l => l.destination);
              if (validLanes.length === 0) continue;

              const tier = (Number(company.estimatedFreightSpend ?? 0) >= 100_000 ? "A"
                : Number(company.estimatedFreightSpend ?? 0) >= 25_000 ? "B" : null) as "A" | "B" | null;

              const votriWoWAvg = await getAvgVotriWoW(validLanes).catch(() => null);
              if (votriWoWAvg === null) continue;

              const laneSummary = validLanes.slice(0, 3).map(l => `${l.origin}→${l.destination}`).join(", ");
              const laneCount = validLanes.length;

              const r13 = evalR13MarketTightening(company, tier, votriWoWAvg, laneSummary, laneCount);
              const r14 = evalR14MarketLoosening(company, tier, votriWoWAvg, laneSummary, laneCount);
              const marketCard = r13 ?? r14;
              if (!marketCard) continue;

              const ruleKey: string = marketCard.ruleType;
              const existing = await storage.getRecentNbaCardByType(company.id, ruleKey, 7);
              if (existing) continue;

              await storage.supersedePreviousNbaCards(company.id, ruleKey);
              const mktPlay = getPlayForRuleType(ruleKey);
              await storage.createNbaCard({
                orgId: org.id,
                userId: company.assignedTo,
                companyId: company.id,
                companyName: company.name,
                ruleType: ruleKey,
                outcomeType: marketCard.outcomeType,
                confidence: marketCard.confidence,
                signalCount: marketCard.signalCount,
                signalSummary: marketCard.signalSummary as string[],
                whyThisNow: marketCard.whyThisNow,
                suggestedAction: marketCard.suggestedAction,
                expectedOutcome: marketCard.expectedOutcome,
                growthLever: marketCard.growthLever,
                relationshipMove: marketCard.relationshipMove,
                accountTier: marketCard.accountTier,
                urgencyScore: marketCard.urgencyScore,
                status: "visible",
                createdAt: now,
                playLabel: mktPlay?.name ?? null,
              });
              companiesWithCardsThisRun.add(company.id);
              totalGenerated++;
            }
          }
        } catch (sonarErr: any) {
          log(`Org ${org.id}: Sonar VOTRI NBA warning (non-fatal): ${sonarErr?.message ?? sonarErr}`);
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

// ── Intraday VOTRI Alert Job ──────────────────────────────────────────────────
// Runs every 2 hours. For each active user's top 10 lanes, checks if VOTRIW
// (week-over-week VOTRI change, as returned by getLaneVotrisBatch) exceeds
// ±3 percentage points. Uses hasUnreadNotification for same-lane deduplication.
// This avoids in-memory baseline drift across restarts.

async function runIntradayVotriAlerts(): Promise<void> {
  log("Running intraday VOTRIW alert check…");
  try {
    const EXCLUDED_ORG_ID = "da3ed822";
    const orgs = await storage.getOrganizations?.() ?? [];
    const activeOrgs = orgs.filter((o: any) => o.id && !o.id.startsWith(EXCLUDED_ORG_ID));
    if (activeOrgs.length === 0) return;

    for (const org of activeOrgs) {
      try {
        const uploads = await storage.getFinancialUploadsForOrg(org.id).catch(() => []);
        if (uploads.length === 0) continue;

        const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
        let allRows: any[] = [];
        for (const upload of sorted.slice(0, 2)) {
          allRows = allRows.concat((upload.rows as any[]) ?? []);
        }
        if (allRows.length === 0) continue;

        const cols = resolveColumns(allRows);
        const allUsers = await storage.getUsers(org.id);

        // Build lane frequency map per user (count loads per lane, then take top 10 by frequency)
        const userLaneFrequency = new Map<string, Map<string, number>>();

        for (const row of allRows) {
          if (isExcludedRow(row, cols)) continue;
          const rep = getRepFromRow(row, cols);
          const origin = String(row[cols.origin] ?? row[cols.shipperCity] ?? "").trim().toLowerCase();
          const destination = String(row[cols.destination] ?? row[cols.consigneeCity] ?? "").trim().toLowerCase();
          if (!origin || !destination) continue;

          const ownerUser = allUsers.find((u: any) => {
            if (u.financialRepId && rep && u.financialRepId.toLowerCase() === rep.toLowerCase()) return true;
            return u.name && rep && (u.name.toLowerCase().includes(rep) || rep.includes(u.name.toLowerCase()));
          });
          if (!ownerUser) continue;

          const userId = ownerUser.id;
          if (!userLaneFrequency.has(userId)) userLaneFrequency.set(userId, new Map());
          const laneKey = `${origin}|${destination}`;
          const freqMap = userLaneFrequency.get(userId)!;
          freqMap.set(laneKey, (freqMap.get(laneKey) ?? 0) + 1);
        }

        // Convert frequency maps to sorted top-10 lane arrays
        const userLaneMap = new Map<string, Array<{ origin: string; destination: string }>>();
        for (const [userId, freqMap] of userLaneFrequency) {
          const sorted = Array.from(freqMap.entries())
            .sort((a, b) => b[1] - a[1]) // sort by load count descending
            .slice(0, 10)
            .map(([key]) => {
              const [origin, destination] = key.split("|");
              return { origin, destination };
            });
          userLaneMap.set(userId, sorted);
        }

        // Check each user's top 10 lanes using VOTRIW (week-over-week movement)
        const VOTRIW_THRESHOLD = 3; // percentage points
        for (const [userId, lanes] of userLaneMap) {
          if (lanes.length === 0) continue;
          // Use fresh fetch (bypass 4-hour cache) to meet the 2-hour alert SLA
          const votriMap = await getLaneVotrisBatchFresh(lanes);

          for (const lane of lanes) {
            const qualifier = buildVotriQualifier(lane.origin, lane.destination);
            const votriData = votriMap.get(qualifier);
            if (!votriData || votriData.isStale) continue;

            // Use VOTRIW — the week-over-week change in van outbound tender rejection rate
            const votriWoW = votriData.votriWoW ?? 0;
            if (Math.abs(votriWoW) < VOTRIW_THRESHOLD) continue;

            const direction = votriWoW > 0 ? "tightened" : "loosened";
            const action = votriWoW > 0
              ? "Capacity getting tight — reach out to your carriers now to lock in coverage."
              : "Market loosening — good time to negotiate rates with customers.";

            // Dedup: include direction + magnitude bucket (5pp bands) + 6-hour time bucket
            // This allows re-firing if the move grows significantly or reverses direction,
            // but suppresses duplicate alerts within the same 6-hour window for the same move.
            const magnitudeBucket = Math.floor(Math.abs(votriWoW) / 5); // 0=3-4pp, 1=5-9pp, 2=10-14pp …
            const hourBucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000)); // changes every 6 hours
            const dedupeKey = `${qualifier}:${votriWoW > 0 ? "up" : "dn"}:${magnitudeBucket}:${hourBucket}`;

            const alreadyNotified = await storage.hasUnreadNotification(
              userId,
              "votri_alert",
              dedupeKey,
            ).catch(() => false);

            if (!alreadyNotified) {
              const originTitle = lane.origin.charAt(0).toUpperCase() + lane.origin.slice(1);
              const destTitle = lane.destination.charAt(0).toUpperCase() + lane.destination.slice(1);
              await storage.createNotification({
                userId,
                type: "votri_alert",
                title: `${originTitle} → ${destTitle} VOTRIW ${direction} ${Math.abs(votriWoW).toFixed(1)}pts`,
                body: `VOTRIW is ${votriWoW > 0 ? "+" : ""}${votriWoW.toFixed(1)}pp this week on this lane. ${action}`,
                link: "/intel",
                relatedId: dedupeKey,
                read: false,
              }).catch(err => log(`VOTRIW alert notification error: ${err.message}`));
              log(`VOTRIW alert fired: ${qualifier} for user ${userId} (${direction} ${Math.abs(votriWoW).toFixed(1)}pp)`);
            }
          }
        }
      } catch (orgErr: any) {
        log(`VOTRIW alert error for org ${org.id}: ${orgErr?.message ?? orgErr}`);
      }
    }
    log("Intraday VOTRIW alert check complete");
  } catch (err: any) {
    log(`VOTRIW alert FATAL: ${err?.message ?? err}`);
  }
}

export function initNbaPhase1Scheduler(): void {
  cron.schedule("0 3 * * *", runNbaPhase1ForAllOrgs, { timezone: "America/Chicago" });
  log("NBA Phase 1 nightly scheduler registered (3:00 AM CT)");

  // Intraday VOTRI alerts — every 2 hours
  cron.schedule("0 */2 * * *", runIntradayVotriAlerts, { timezone: "America/Chicago" });
  log("Intraday VOTRI alert scheduler registered (every 2 hours)");
}
