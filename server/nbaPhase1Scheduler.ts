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
import { evaluatePlayTriggersForOrg } from "./routes/playbook";
import { syncMarketSignalNbas } from "./marketNbaService";
import { getStaleQuoteFollowUps } from "./services/staleQuoteFollowup";
import { db } from "./storage";
import { users as usersTable } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { detectAndProcessPatternShifts } from "./services/quotePatternShift";
import { generateConversationOwnershipNbas } from "./nextBestActionEngine";
import { getAvgVotriWoW, getLaneVotrisBatch, getLaneVotrisBatchFresh, buildVotriQualifier } from "./sonarClient";
import { tracLaneDirectionSignal } from "./tracAlertEngine";
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

        // Playbook trigger evaluator (Task #300) — non-fatal.
        try {
          const { created } = await evaluatePlayTriggersForOrg(org.id);
          if (created > 0) log(`Org ${org.id}: playbook triggered ${created} suggested run(s)`);
        } catch (pbErr: any) {
          log(`Org ${org.id}: playbook trigger warning: ${pbErr?.message ?? pbErr}`);
        }

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
            // Task #372 — universal at-stake + linkage
            atStakeAmount: result.winner.atStakeAmount != null ? String(result.winner.atStakeAmount) : null,
            atStakeBasis: result.winner.atStakeBasis ?? null,
            primaryContactId: result.winner.primaryContactId ?? result.winner.contactId ?? null,
            primaryLaneId: result.winner.primaryLaneId ?? result.winner.linkedLaneId ?? null,
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
            // Task #372 — universal at-stake + linkage
            atStakeAmount: spec.candidate.atStakeAmount != null ? String(spec.candidate.atStakeAmount) : null,
            atStakeBasis: spec.candidate.atStakeBasis ?? null,
            primaryContactId: spec.candidate.primaryContactId ?? null,
            primaryLaneId: spec.candidate.primaryLaneId ?? spec.laneId,
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

        // ── Stale Quote Follow-Up NBAs (Task #480) ───────────────────────────
        try {
          const stale = await getStaleQuoteFollowUps(org.id, { force: true });
          if (stale.length > 0) {
            const orgUsers = await db.select().from(usersTable).where(eq(usersTable.organizationId, org.id));
            const userByEmail = new Map<string, string>();
            for (const u of orgUsers) {
              const e = (u.username ?? "").toLowerCase().trim();
              if (e) userByEmail.set(e, u.id);
            }
            const adminFallback = orgUsers.find(u => u.role === "admin" || u.role === "director")?.id ?? orgUsers[0]?.id;
            let staleCreated = 0;
            const stalePlay = getPlayForRuleType("stale_quote_followup");
            for (const item of stale.slice(0, 25)) {
              try {
                const exists = await storage.getActiveStaleQuoteFollowUpCard(org.id, item.quoteId);
                if (exists) { totalSkipped++; continue; }
                const userId = item.repUserId
                  ?? (item.repEmail ? userByEmail.get(item.repEmail.toLowerCase()) : undefined)
                  ?? adminFallback;
                if (!userId) { totalSkipped++; continue; }
                const overdueLabel = item.hoursOverdue >= 48
                  ? `${Math.round(item.hoursOverdue / 24)}d`
                  : `${Math.round(item.hoursOverdue)}h`;
                const typicalLabel = item.pTypicalHours >= 48
                  ? `${Math.round(item.pTypicalHours / 24)}d`
                  : `${Math.round(item.pTypicalHours)}h`;
                await storage.createNbaCard({
                  orgId: org.id,
                  userId,
                  companyId: null,
                  companyName: item.customerName,
                  ruleType: "stale_quote_followup",
                  outcomeType: "execute",
                  confidence: item.hoursOverdue >= item.pTypicalHours ? "high" : "medium",
                  signalCount: 1,
                  signalSummary: [
                    `Quoted $${Math.round(item.quotedAmount).toLocaleString()} on ${item.lane}`,
                    `${overdueLabel} past customer's typical ${typicalLabel} window`,
                    item.repName ? `Owned by ${item.repName}` : "No assigned rep",
                  ],
                  whyThisNow: `${item.customerName} quote on ${item.lane} has been pending ${overdueLabel} longer than this customer typically takes (${typicalLabel}).`,
                  suggestedAction: `Follow up with ${item.customerName} on the ${item.equipment} quote — confirm decision or revise.`,
                  expectedOutcome: "Re-engage before the opportunity goes cold.",
                  growthLever: "Quote-to-close cycle",
                  relationshipMove: null,
                  accountTier: null,
                  urgencyScore: Math.min(100, Math.round(50 + item.hoursOverdue / 6)),
                  status: "visible",
                  createdAt: now,
                  contactId: null,
                  linkedCommitmentId: item.quoteId,
                  playLabel: stalePlay?.name ?? null,
                  atStakeAmount: item.estimatedMargin > 0 ? String(Math.round(item.estimatedMargin)) : null,
                  atStakeBasis: item.estimatedMargin > 0 ? `Est. margin ≈ 10% of $${Math.round(item.quotedAmount).toLocaleString()}` : null,
                });
                staleCreated++;
                totalGenerated++;
              } catch (perItemErr: any) {
                log(`Org ${org.id}: stale-quote NBA item ${item.quoteId} error: ${perItemErr?.message ?? perItemErr}`);
              }
            }
            if (staleCreated > 0) log(`Org ${org.id}: stale-quote follow-up NBAs created=${staleCreated}`);
          }
        } catch (staleErr: any) {
          log(`Org ${org.id}: stale-quote NBA warning (non-fatal): ${staleErr?.message ?? staleErr}`);
        }

        // ── Conversation Ownership NBAs (Task #202) ────────────────────────────
        try {
          const convResult = await storage.listEmailConversationThreads(org.id, {
            waitingState: "waiting_on_us",
            limit: 500,
          });
          if (convResult.threads.length > 0) {
            await generateConversationOwnershipNbas(org.id, convResult.threads as any, storage as any);
            log(`Org ${org.id}: conversation ownership NBAs processed (${convResult.threads.length} threads)`);
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

              let tracSignalScore: number | null = null;
              const tracDirs = await Promise.all(
                validLanes.slice(0, 3).map(l =>
                  tracLaneDirectionSignal(l.origin, l.destination).catch(() => null)
                )
              );
              const tracValid = tracDirs.filter(Boolean) as Array<"hot" | "warm" | "stable" | "cool">;
              if (tracValid.length > 0) {
                const scoreMap: Record<string, number> = { hot: 5, warm: 2, stable: 0, cool: -3 };
                tracSignalScore = tracValid.reduce((sum, d) => sum + (scoreMap[d] ?? 0), 0) / tracValid.length;
              }

              const votriWoWAvg = tracSignalScore === null
                ? await getAvgVotriWoW(validLanes).catch(() => null)
                : tracSignalScore;
              if (votriWoWAvg === null) continue;

              const laneSummary = validLanes.slice(0, 3).map(l => `${l.origin}→${l.destination}`).join(", ");
              const laneCount = validLanes.length;

              // Task #372 — resolve primary contact + lane for universal linkage
              let primaryContactId: string | null = null;
              let primaryLaneId: string | null = null;
              try {
                const [contacts, recLanes] = await Promise.all([
                  storage.getContactsByCompany(company.id),
                  storage.getRecurringLanesByCompany(company.id).catch(() => [] as RecurringLane[]),
                ]);
                const rankBase = (b: string | null | undefined) => {
                  const v = (b ?? "").toLowerCase();
                  if (v.includes("home")) return 5;
                  if (v.includes("3rd")) return 4;
                  if (v.includes("2nd")) return 3;
                  if (v.includes("1st")) return 2;
                  if (v.includes("on deck") || v.includes("on-deck")) return 1;
                  return 0;
                };
                const c = [...contacts].sort((a, b) => rankBase(b.relationshipBase) - rankBase(a.relationshipBase))[0];
                primaryContactId = c?.id ?? null;
                const lanes: RecurringLane[] = recLanes ?? [];
                const today = new Date().toISOString().split("T")[0];
                const eligible = lanes.filter(l => l.isEligible !== false && (!l.snoozedUntil || l.snoozedUntil <= today));
                const top = (eligible.length > 0 ? eligible : lanes)
                  .sort((a, b) => Number(b.laneScore ?? 0) - Number(a.laneScore ?? 0))[0];
                primaryLaneId = top?.id ?? null;
              } catch { /* non-fatal */ }

              const r13 = evalR13MarketTightening(company, tier, votriWoWAvg, laneSummary, laneCount, primaryContactId, primaryLaneId);
              const r14 = evalR14MarketLoosening(company, tier, votriWoWAvg, laneSummary, laneCount, primaryContactId, primaryLaneId);
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
                // Task #372 — universal at-stake + linkage
                atStakeAmount: marketCard.atStakeAmount != null ? String(marketCard.atStakeAmount) : null,
                atStakeBasis: marketCard.atStakeBasis ?? null,
                primaryContactId: marketCard.primaryContactId ?? null,
                primaryLaneId: marketCard.primaryLaneId ?? null,
              });
              companiesWithCardsThisRun.add(company.id);
              totalGenerated++;
            }
          }
        } catch (sonarErr: any) {
          log(`Org ${org.id}: Sonar VOTRI NBA warning (non-fatal): ${sonarErr?.message ?? sonarErr}`);
        }

        // ── Customer Quote Pattern-Shift Detection (Task #481) ───────────────
        try {
          const psr = await detectAndProcessPatternShifts(org.id);
          if (psr.created || psr.resolved || psr.refreshed) {
            log(`Org ${org.id}: quote pattern shifts — scanned=${psr.scanned} shifted=${psr.shifted} created=${psr.created} refreshed=${psr.refreshed} resolved=${psr.resolved} notified=${psr.notified}`);
          }
        } catch (qpsErr: any) {
          log(`Org ${org.id}: quote pattern shift warning (non-fatal): ${qpsErr?.message ?? qpsErr}`);
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

        const VOTRIW_THRESHOLD = 3; // percentage points
        for (const [userId, lanes] of userLaneMap) {
          if (lanes.length === 0) continue;
          const votriMap = await getLaneVotrisBatchFresh(lanes);

          for (const lane of lanes) {
            const qualifier = buildVotriQualifier(lane.origin, lane.destination);
            const votriData = votriMap.get(qualifier);

            const tracDir = await tracLaneDirectionSignal(lane.origin, lane.destination).catch(() => null);

            let direction: "tightened" | "loosened" | null = null;
            let action = "";
            let alertLabel = "";

            if (tracDir === "hot" || tracDir === "warm") {
              direction = "tightened";
              action = "TRAC forecasts capacity tightening — reach out to your carriers now to lock in coverage.";
              alertLabel = `TRAC ${tracDir}`;
            } else if (tracDir === "cool") {
              direction = "loosened";
              action = "TRAC forecasts softening — good time to negotiate rates with customers.";
              alertLabel = "TRAC cool";
            } else if (tracDir === "stable") {
              // stable = no alert needed from TRAC, fall through to check VOTRI WoW
            }
            
            if (!direction && votriData && !votriData.isStale && votriData.votriWoW !== null) {
              const votriWoW = votriData.votriWoW;
              if (Math.abs(votriWoW) >= VOTRIW_THRESHOLD) {
                direction = votriWoW > 0 ? "tightened" : "loosened";
                action = votriWoW > 0
                  ? "Capacity getting tight — reach out to your carriers now to lock in coverage."
                  : "Market loosening — good time to negotiate rates with customers.";
                alertLabel = `VOTRIW ${votriWoW > 0 ? "+" : ""}${votriWoW.toFixed(1)}pp`;
              }
            }

            if (!direction) continue;

            const hourBucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
            const dedupeKey = `${qualifier}:${direction === "tightened" ? "up" : "dn"}:${alertLabel}:${hourBucket}`;

            const alreadyNotified = await storage.hasUnreadNotification(
              userId,
              "market_alert",
              dedupeKey,
            ).catch(() => false);

            if (!alreadyNotified) {
              const originTitle = lane.origin.charAt(0).toUpperCase() + lane.origin.slice(1);
              const destTitle = lane.destination.charAt(0).toUpperCase() + lane.destination.slice(1);
              await storage.createNotification({
                userId,
                type: "market_alert",
                title: `${originTitle} → ${destTitle} market ${direction} (${alertLabel})`,
                body: action,
                link: "/intel",
                relatedId: dedupeKey,
                read: false,
              }).catch(err => log(`Market alert notification error: ${err.message}`));
              log(`Market alert fired: ${qualifier} for user ${userId} (${direction}, ${alertLabel})`);
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

  // VOTRI alerts — Task #465 collapses this from every-2-hours to once daily
  // at 5:00 AM CT (after sonarDailyRefreshScheduler at 4:30 AM has populated
  // the daily snapshot). Lane-level rate calls remain real-time on user
  // request, bounded by hard timeouts in sonarClient.
  cron.schedule("0 5 * * *", runIntradayVotriAlerts, { timezone: "America/Chicago" });
  log("Daily VOTRI alert scheduler registered (5:00 AM CT)");
}
