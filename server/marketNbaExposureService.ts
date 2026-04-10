/**
 * Market NBA Exposure Service
 *
 * Deterministically identifies which accounts (companies) are "exposed" to a
 * given active Market Signal, based on their historical lane activity and
 * market share data.
 *
 * Exposure rules (all lookback windows configurable below):
 *   Rule A — Has recurring_lanes with matching origin region in the last 90 days
 *   Rule B — Has market_share_entries activity from that region in the last 60 days
 *   Rule C — Has contact lane attributions whose originRegion matches the signal
 *
 * Matching is conservative: at least ONE rule must match to qualify.
 * Region matching normalizes strings and checks for state abbreviation inclusion.
 */

import type { IStorage } from "./storage";
import type { MarketSignal } from "../shared/schema";

// ── Configuration constants ───────────────────────────────────────────────────

/** How many days back to look for recurring lane activity (Rule A). */
export const RECURRING_LANE_LOOKBACK_DAYS = 90;

/** How many days back to look for market share activity (Rule B). */
export const MARKET_SHARE_LOOKBACK_DAYS = 60;

/** Max accounts matched per signal in a single run (cap to avoid over-generation). */
export const MAX_ACCOUNTS_PER_SIGNAL = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AccountExposureEvidence {
  matchedRule: "recurring_lane" | "market_share" | "lane_attribution";
  laneCount: number;
  lastActivityDate: string | null;
  regionMatched: string;
  equipmentMatched: string | null;
}

export interface ExposedAccount {
  companyId: string;
  companyName: string;
  ownerId: string | null;
  evidence: AccountExposureEvidence;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeRegion(region: string | null | undefined): string {
  if (!region) return "";
  return region.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Returns true if the lane's origin region overlaps with the signal's origin region.
 * Checks if either string contains the other after normalization (handles "Southeast"
 * matching "GA" or "FL", etc.), or if they share a state abbreviation.
 */
function regionMatches(signalRegion: string | null | undefined, laneRegion: string | null | undefined): boolean {
  if (!signalRegion || !laneRegion) return false;
  const sig = normalizeRegion(signalRegion);
  const lane = normalizeRegion(laneRegion);
  if (sig === lane) return true;
  if (sig.includes(lane) || lane.includes(sig)) return true;
  // State abbreviations: check if a 2-char token in one appears in the other
  const sigTokens = sig.split("_").filter(t => t.length === 2);
  const laneTokens = lane.split("_").filter(t => t.length === 2);
  return sigTokens.some(t => laneTokens.includes(t));
}

function daysAgoISOString(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns the list of companies exposed to the given active Market Signal.
 * Caps results to MAX_ACCOUNTS_PER_SIGNAL, sorted by most recent activity.
 */
export async function getExposedAccounts(
  signal: MarketSignal,
  orgId: string,
  storage: IStorage,
): Promise<ExposedAccount[]> {
  if (signal.status !== "active") return [];
  if (!signal.scopeKey && !signal.equipmentType) return [];

  const recurringLaneCutoff = daysAgoISOString(RECURRING_LANE_LOOKBACK_DAYS);
  const marketShareCutoff = daysAgoISOString(MARKET_SHARE_LOOKBACK_DAYS);

  const companies = await storage.getCompanies(orgId);

  const results: ExposedAccount[] = [];

  for (const company of companies) {
    if (results.length >= MAX_ACCOUNTS_PER_SIGNAL) break;

    // ── Rule A: recurring_lanes with matching origin region ───────────────────
    const ruleAResult = await checkRuleA(signal, company.id, recurringLaneCutoff, storage);
    if (ruleAResult) {
      results.push({
        companyId: company.id,
        companyName: company.name,
        ownerId: company.salesPersonId ?? company.assignedTo ?? null,
        evidence: ruleAResult,
      });
      continue;
    }

    // ── Rule B: market_share_entries from the signal region ───────────────────
    const ruleBResult = await checkRuleB(signal, company.id, marketShareCutoff, storage);
    if (ruleBResult) {
      results.push({
        companyId: company.id,
        companyName: company.name,
        ownerId: company.salesPersonId ?? company.assignedTo ?? null,
        evidence: ruleBResult,
      });
      continue;
    }

    // ── Rule C: contact lane attributions matching origin region ──────────────
    const ruleCResult = await checkRuleC(signal, company.id, storage);
    if (ruleCResult) {
      results.push({
        companyId: company.id,
        companyName: company.name,
        ownerId: company.salesPersonId ?? company.assignedTo ?? null,
        evidence: ruleCResult,
      });
    }
  }

  return results;
}

// ── Rule implementations ──────────────────────────────────────────────────────

async function checkRuleA(
  signal: MarketSignal,
  companyId: string,
  cutoffDate: string,
  storage: IStorage,
): Promise<AccountExposureEvidence | null> {
  const allLanes = await storage.getRecurringLanesByCompany(companyId);
  const matchingLanes = allLanes.filter(lane => {
    const updatedAt = lane.updatedAt instanceof Date
      ? lane.updatedAt.toISOString().split("T")[0]
      : String(lane.updatedAt ?? "").split("T")[0];
    if (updatedAt < cutoffDate) return false;
    if (!regionMatches(signal.scopeKey, lane.originState ?? lane.origin)) return false;
    if (signal.equipmentType && lane.equipmentType) {
      const sigEq = signal.equipmentType.toLowerCase();
      const laneEq = lane.equipmentType.toLowerCase();
      if (!sigEq.includes(laneEq) && !laneEq.includes(sigEq)) return false;
    }
    return true;
  });

  if (matchingLanes.length === 0) return null;

  const sorted = [...matchingLanes].sort((a, b) => {
    const aDate = a.updatedAt instanceof Date ? a.updatedAt.toISOString() : String(a.updatedAt ?? "");
    const bDate = b.updatedAt instanceof Date ? b.updatedAt.toISOString() : String(b.updatedAt ?? "");
    return bDate.localeCompare(aDate);
  });
  const lastDate = sorted[0]?.updatedAt instanceof Date
    ? sorted[0].updatedAt.toISOString().split("T")[0]
    : String(sorted[0]?.updatedAt ?? "").split("T")[0];

  return {
    matchedRule: "recurring_lane",
    laneCount: matchingLanes.length,
    lastActivityDate: lastDate || null,
    regionMatched: signal.scopeKey ?? "",
    equipmentMatched: signal.equipmentType ?? null,
  };
}

async function checkRuleB(
  signal: MarketSignal,
  companyId: string,
  cutoffDate: string,
  storage: IStorage,
): Promise<AccountExposureEvidence | null> {
  const entries = await storage.getMarketShareEntries(companyId);
  const matchingEntries = entries.filter(entry => {
    const entryDate = entry.periodEnd ?? entry.periodStart ?? entry.createdAt ?? "";
    if (!entryDate || entryDate < cutoffDate) return false;
    const loads = (entry.spotLoads ?? 0) + (entry.vtLoads ?? 0);
    return loads > 0;
  });

  if (matchingEntries.length === 0) return null;

  const sorted = [...matchingEntries].sort((a, b) => {
    const aDate = a.periodEnd ?? a.periodStart ?? a.createdAt ?? "";
    const bDate = b.periodEnd ?? b.periodStart ?? b.createdAt ?? "";
    return bDate.localeCompare(aDate);
  });
  const lastDate = sorted[0]?.periodEnd ?? sorted[0]?.periodStart ?? sorted[0]?.createdAt ?? null;

  return {
    matchedRule: "market_share",
    laneCount: matchingEntries.length,
    lastActivityDate: lastDate,
    regionMatched: signal.scopeKey ?? "",
    equipmentMatched: signal.equipmentType ?? null,
  };
}

async function checkRuleC(
  signal: MarketSignal,
  companyId: string,
  storage: IStorage,
): Promise<AccountExposureEvidence | null> {
  const attributions = await storage.getLaneAttributionsByCompany(companyId);
  const matchingAttributions = attributions.filter(attr => {
    if (!signal.scopeKey) return false;
    const attrState = (attr.originState ?? "").toUpperCase();
    const attrCity = (attr.originCity ?? "").toLowerCase();
    const combined = `${attrCity} ${attrState}`.trim();
    return regionMatches(signal.scopeKey, attrState) ||
           regionMatches(signal.scopeKey, combined);
  });

  if (matchingAttributions.length === 0) return null;

  return {
    matchedRule: "lane_attribution",
    laneCount: matchingAttributions.length,
    lastActivityDate: null,
    regionMatched: signal.scopeKey ?? "",
    equipmentMatched: signal.equipmentType ?? null,
  };
}
