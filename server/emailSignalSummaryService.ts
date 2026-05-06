/**
 * Email Signal Summary Service (Task #191)
 *
 * Input adapters for downstream consumers — aggregates recent email signals
 * from email_signals for a given account or carrier over a configurable
 * lookback window.
 *
 * These are the primary input adapters for:
 *   - Account momentum score email inputs (growthScoreCalculator)
 *   - Account email NBAs (nextBestActionEngine)
 *   - Carrier email NBAs (carrierEmailNbaService)
 *   - Carrier enrichment staging (carrierEmailEnrichmentService)
 */

import type { EmailSignal } from "@shared/schema";

export interface AccountEmailSignalSummary {
  windowDays: number;
  accountId: string;
  signals: EmailSignal[];
  // Pre-aggregated counts by intent type for easy consumer use
  counts: {
    meaningful_touchpoint: number;
    stalled_thread: number;
    service_complaint: number;
    urgency_signal: number;
    new_opportunity: number;
    closed_won_indicator: number;
    closed_lost_indicator: number;
    pricing_request: number;
    objection: number;
    positive_feedback: number;
  };
  hasWarningSigns: boolean;
  hasOpportunitySignals: boolean;
}

export interface CarrierEmailSignalSummary {
  windowDays: number;
  carrierId: string;
  signals: EmailSignal[];
  counts: {
    lane_offer: number;
    lane_decline: number;
    capacity_available: number;
    capacity_unavailable: number;
    new_lane_preference: number;
    new_equipment_or_region: number;
    price_pushback: number;
    service_issue: number;
    soft_commitment: number;
    hard_commitment: number;
    paperwork_compliance: number;
  };
  hasCapacitySignals: boolean;
  hasRiskSignals: boolean;
  hasCommitmentSignals: boolean;
}

// ── Storage interface required by these helpers ───────────────────────────────

export interface EmailSummaryStorage {
  getEmailSignalsForAccount(accountId: string, limit?: number): Promise<EmailSignal[]>;
  getEmailSignalsForCarrier(carrierId: string, limit?: number): Promise<EmailSignal[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withinWindow(signal: EmailSignal, windowDays: number): boolean {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return signal.createdAt.getTime() >= cutoff;
}

// ── Account summary ───────────────────────────────────────────────────────────

/**
 * Aggregate recent customer-side email signals for an account.
 * Filters to signals within the lookback window (default 30 days).
 * Never throws — returns an empty summary on storage errors.
 */
export async function getRecentAccountEmailSignalSummary(
  accountId: string,
  windowDays: number = 30,
  storageInstance: EmailSummaryStorage,
): Promise<AccountEmailSignalSummary> {
  const empty: AccountEmailSignalSummary = {
    windowDays,
    accountId,
    signals: [],
    counts: {
      meaningful_touchpoint: 0,
      stalled_thread: 0,
      service_complaint: 0,
      urgency_signal: 0,
      new_opportunity: 0,
      closed_won_indicator: 0,
      closed_lost_indicator: 0,
      pricing_request: 0,
      objection: 0,
      positive_feedback: 0,
    },
    hasWarningSigns: false,
    hasOpportunitySignals: false,
  };

  let allSignals: EmailSignal[];
  try {
    allSignals = await storageInstance.getEmailSignalsForAccount(accountId, 500);
  } catch (err) {
    console.error(`[emailSignalSummary] getRecentAccountEmailSignalSummary error for ${accountId}:`, err);
    return empty;
  }

  const signals = allSignals.filter(s => withinWindow(s, windowDays));

  const counts = { ...empty.counts };
  for (const s of signals) {
    const k = s.intentType as keyof typeof counts;
    if (k in counts) counts[k]++;
  }

  return {
    windowDays,
    accountId,
    signals,
    counts,
    hasWarningSigns: counts.stalled_thread > 0 || counts.service_complaint > 0 || counts.closed_lost_indicator > 0,
    hasOpportunitySignals: counts.new_opportunity > 0 || counts.pricing_request > 0 || counts.closed_won_indicator > 0,
  };
}

// ── Carrier summary ───────────────────────────────────────────────────────────

/**
 * Aggregate recent carrier-side email signals for a carrier.
 * Filters to signals within the lookback window (default 14 days).
 * Never throws — returns an empty summary on storage errors.
 */
export async function getRecentCarrierEmailSignalSummary(
  carrierId: string,
  windowDays: number = 14,
  storageInstance: EmailSummaryStorage,
): Promise<CarrierEmailSignalSummary> {
  const empty: CarrierEmailSignalSummary = {
    windowDays,
    carrierId,
    signals: [],
    counts: {
      lane_offer: 0,
      lane_decline: 0,
      capacity_available: 0,
      capacity_unavailable: 0,
      new_lane_preference: 0,
      new_equipment_or_region: 0,
      price_pushback: 0,
      service_issue: 0,
      soft_commitment: 0,
      hard_commitment: 0,
      paperwork_compliance: 0,
    },
    hasCapacitySignals: false,
    hasRiskSignals: false,
    hasCommitmentSignals: false,
  };

  let allSignals: EmailSignal[];
  try {
    allSignals = await storageInstance.getEmailSignalsForCarrier(carrierId, 500);
  } catch (err) {
    console.error(`[emailSignalSummary] getRecentCarrierEmailSignalSummary error for ${carrierId}:`, err);
    return empty;
  }

  const signals = allSignals.filter(s => withinWindow(s, windowDays));

  const counts = { ...empty.counts };
  for (const s of signals) {
    const k = s.intentType as keyof typeof counts;
    if (k in counts) counts[k]++;
  }

  return {
    windowDays,
    carrierId,
    signals,
    counts,
    hasCapacitySignals: counts.lane_offer > 0 || counts.capacity_available > 0 || counts.new_lane_preference > 0,
    hasRiskSignals: counts.price_pushback > 0 || counts.service_issue > 0,
    hasCommitmentSignals: counts.soft_commitment > 0 || counts.hard_commitment > 0,
  };
}
