/**
 * Market NBA Service
 *
 * Converts active Market Signals → account-level NBA candidates and upserts
 * them into nba_cards using ruleType = "market_surge_customer_outreach".
 *
 * Dedup key: (companyId, marketSignalId, ruleType)
 * Only one non-dismissed / non-resolved NBA per dedup key at any time.
 *
 * Status mapping (aligned with existing nba_cards lifecycle):
 *   generated → pending (suggested, not yet surfaced)
 *   visible   → in_progress (rep can see it)
 *   resolved  → completed
 *   dismissed → dismissed
 */

import type { IStorage } from "./storage";
import type { MarketSignal } from "../shared/schema";
import { getExposedAccounts, MAX_ACCOUNTS_PER_SIGNAL, type AccountExposureEvidence, type ExposedAccount } from "./marketNbaExposureService";

const RULE_TYPE = "market_surge_customer_outreach" as const;

function log(msg: string) {
  console.log(`[marketNbaService] ${new Date().toISOString()} ${msg}`);
}

// ── Explanation builder ───────────────────────────────────────────────────────

export interface MarketNbaExplanationPayload {
  signalSummary: {
    signalId: string;
    signalType: string;
    severity: string;
    scopeKey: string;
    scopeType: string;
    equipmentType: string | null;
    percentChange: number | null;
    recentCount: number;
  };
  accountExposure: {
    matchedRule: string;
    laneCount: number;
    lastActivityDate: string | null;
    regionMatched: string;
    equipmentMatched: string | null;
  };
  suggestedOutreachScript: string;
}

/**
 * Builds a deterministic, structured JSON explanation payload for a market-signal NBA.
 * Rule-based only — no LLM involved.
 */
export function buildMarketNbaExplanation(
  signal: MarketSignal,
  account: ExposedAccount,
  evidence: AccountExposureEvidence,
): MarketNbaExplanationPayload {
  const regionLabel = signal.scopeKey ?? "the region";
  const equipLabel = signal.equipmentType ? ` ${signal.equipmentType}` : "";
  const activitySuffix = evidence.lastActivityDate
    ? ` (last activity: ${evidence.lastActivityDate})`
    : "";
  const evidencePayload = (signal.evidencePayload ?? {}) as Record<string, unknown>;

  const suggestedOutreachScript =
    `Proactively call ${account.companyName} about outbound ${regionLabel}${equipLabel} ` +
    `as the market is tightening. ` +
    `They have shipped ${evidence.laneCount} lane(s) in this corridor${activitySuffix}. ` +
    `Goal: help them plan ahead and position Value Truck as a reliable partner ` +
    `before capacity becomes constrained.`;

  return {
    signalSummary: {
      signalId: signal.id,
      signalType: signal.signalType,
      severity: signal.severity,
      scopeKey: signal.scopeKey,
      scopeType: signal.scopeType,
      equipmentType: signal.equipmentType ?? null,
      percentChange: evidencePayload.percentChange != null
        ? Number(evidencePayload.percentChange)
        : null,
      recentCount: typeof evidencePayload.recentCount === "number" ? evidencePayload.recentCount : 0,
    },
    accountExposure: {
      matchedRule: evidence.matchedRule,
      laneCount: evidence.laneCount,
      lastActivityDate: evidence.lastActivityDate,
      regionMatched: evidence.regionMatched,
      equipmentMatched: evidence.equipmentMatched,
    },
    suggestedOutreachScript,
  };
}

// ── Urgency score ─────────────────────────────────────────────────────────────

function computeUrgencyScore(signal: MarketSignal): number {
  const severityScore: Record<string, number> = { critical: 90, high: 70, medium: 50, low: 30 };
  const base = severityScore[signal.severity] ?? 50;
  const evidencePayload = (signal.evidencePayload ?? {}) as Record<string, unknown>;
  const pctChange = evidencePayload.percentChange != null ? Number(evidencePayload.percentChange) : 0;
  const pctBonus = pctChange ? Math.min(pctChange, 50) : 0;
  return Math.min(Math.round(base + pctBonus), 100);
}

// ── Sync function ─────────────────────────────────────────────────────────────

/**
 * Main entry point: syncs all active Market Signals → account NBA cards for an org.
 * Called by the scheduler after Phase 1 engine runs.
 */
export async function syncMarketSignalNbas(orgId: string, storage: IStorage): Promise<{
  processed: number;
  created: number;
  skipped: number;
}> {
  let processed = 0;
  let created = 0;
  let skipped = 0;

  const signals = await storage.getActiveMarketSignals({ status: ["active"] });
  if (signals.length === 0) {
    log(`Org ${orgId}: no active signals — nothing to do`);
    return { processed, created, skipped };
  }

  log(`Org ${orgId}: ${signals.length} active signal(s) to process`);

  for (const signal of signals) {
    const exposedAccounts = await getExposedAccounts(signal, orgId, storage);
    log(`Signal ${signal.id} (${signal.signalType}): ${exposedAccounts.length} exposed accounts`);

    // Apply per-signal cap
    const capped = exposedAccounts.slice(0, MAX_ACCOUNTS_PER_SIGNAL);

    for (const account of capped) {
      processed++;
      const ownerId = account.ownerId;
      if (!ownerId) {
        skipped++;
        continue;
      }

      // Dedup: check for existing non-dismissed/non-resolved NBA for this (companyId, signalId, ruleType)
      const existing = await storage.getNbaCardByMarketSignalDedup(
        account.companyId,
        signal.id,
        RULE_TYPE,
      );

      if (existing) {
        skipped++;
        continue;
      }

      const explanation = buildMarketNbaExplanation(signal, account, account.evidence);
      const ep = (signal.evidencePayload ?? {}) as Record<string, unknown>;
      const signalSummaryLines = [
        `Market signal: ${signal.signalType} (${signal.severity})`,
        `Region: ${signal.scopeKey ?? "N/A"}`,
        signal.equipmentType ? `Equipment: ${signal.equipmentType}` : null,
        ep.percentChange != null ? `Change: ${Number(ep.percentChange).toFixed(1)}%` : null,
        `Supporting events: ${typeof ep.recentCount === "number" ? ep.recentCount : 0}`,
        `Account exposure: ${account.evidence.laneCount} lane(s) via ${account.evidence.matchedRule}`,
        account.evidence.lastActivityDate ? `Last activity: ${account.evidence.lastActivityDate}` : null,
      ].filter(Boolean) as string[];

      const regionLabel = signal.scopeKey ?? "the region";
      const equipLabel = signal.equipmentType ? ` ${signal.equipmentType}` : "";

      await storage.createNbaCard({
        orgId,
        userId: ownerId,
        companyId: account.companyId,
        companyName: account.companyName,
        ruleType: RULE_TYPE,
        outcomeType: "grow",
        confidence: signal.severity === "critical" || signal.severity === "high" ? "high" : "medium",
        signalCount: signalSummaryLines.length,
        signalSummary: [explanation, ...signalSummaryLines] as any,
        whyThisNow: `Market signal detected in ${regionLabel}${equipLabel}: ${signal.signalType} (${signal.severity} severity). ${account.companyName} has activity in this corridor.`,
        suggestedAction: explanation.suggestedOutreachScript,
        expectedOutcome: `Position Value Truck as the preferred${equipLabel} carrier for ${account.companyName}'s ${regionLabel} lanes before capacity tightens.`,
        growthLever: `Market signal: ${signal.signalType}`,
        accountTier: null,
        urgencyScore: computeUrgencyScore(signal),
        status: "generated",
        marketSignalId: signal.id,
        playLabel: "Market Signal Outreach",
        createdAt: new Date().toISOString(),
      });

      created++;
    }
  }

  log(`Org ${orgId}: sync complete — processed=${processed}, created=${created}, skipped=${skipped}`);
  return { processed, created, skipped };
}

// ── Signal resolution ─────────────────────────────────────────────────────────

/**
 * Auto-dismisses any still-pending (generated/visible) NBA cards tied to a
 * now-resolved market signal. Called when a signal transitions to resolved/expired.
 */
export async function autoResolveNbasForSignal(signalId: string, storage: IStorage): Promise<number> {
  const dismissed = await storage.dismissNbaCardsByMarketSignal(signalId);
  log(`Signal ${signalId} resolved — dismissed ${dismissed} pending NBAs`);
  return dismissed;
}
