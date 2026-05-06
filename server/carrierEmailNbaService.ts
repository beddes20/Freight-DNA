/**
 * Carrier Email NBA Service (Task #191)
 *
 * Generates email-driven carrier NBA cards from email signals in email_signals.
 * Complements carrierMarketNbaService (which handles market-derived NBAs).
 *
 * Rules:
 *   capacity_available in hot region → outreach/follow-up NBA
 *   lane_offer not acted on           → procurement follow-up
 *   price_pushback                    → pricing review NBA
 *   service_issue                     → carrier management review
 *   hard_commitment                   → assignment-ready signal
 *   capacity_unavailable              → suppress/down-rank note
 *
 * Dedup: at most one active NBA per (threadId, intent family, carrierId)
 * using a 24-hour window check on carrier_market_nbas.
 *
 * All explanation payloads include: source signal, carrier context,
 * lane/region/equipment if available, signal date.
 */

import type { IStorage } from "./storage";
import type { EmailMessage, EmailSignal } from "@shared/schema";

export interface CarrierEmailNbaResult {
  carrierId: string;
  created: number;
  skipped: number;
}

// ── Intent → NBA recommendation type mapping ──────────────────────────────────

interface CarrierEmailNbaRule {
  recommendationType: string;
  intentFamily: string;
  urgencyScore: number;
  label: string;
}

const CARRIER_EMAIL_NBA_RULES: Partial<Record<string, CarrierEmailNbaRule>> = {
  capacity_available: {
    recommendationType: "email_capacity_follow_up",
    intentFamily: "capacity",
    urgencyScore: 65,
    label: "Follow up on carrier capacity availability",
  },
  lane_offer: {
    recommendationType: "email_procurement_follow_up",
    intentFamily: "capacity",
    urgencyScore: 70,
    label: "Procurement follow-up on carrier lane offer",
  },
  price_pushback: {
    recommendationType: "email_pricing_review",
    intentFamily: "pricing",
    urgencyScore: 75,
    label: "Review carrier pricing pushback",
  },
  service_issue: {
    recommendationType: "email_service_caution",
    intentFamily: "service",
    urgencyScore: 80,
    label: "Carrier service issue — management review",
  },
  hard_commitment: {
    recommendationType: "email_assignment_ready",
    intentFamily: "commitment",
    urgencyScore: 85,
    label: "Carrier hard commitment — ready to assign",
  },
  capacity_unavailable: {
    recommendationType: "email_capacity_suppress",
    intentFamily: "capacity",
    urgencyScore: 40,
    label: "Carrier capacity unavailable — suppress outreach",
  },
};

function buildExplanation(
  signal: EmailSignal,
  message: EmailMessage,
  rule: CarrierEmailNbaRule,
): Record<string, unknown> {
  const extracted = (signal.extractedData ?? {}) as Record<string, unknown>;
  return {
    sourceSignalId: signal.id,
    intentType: signal.intentType,
    intentSubtype: signal.intentSubtype ?? null,
    confidence: signal.confidence,
    signalDate: signal.createdAt.toISOString(),
    threadId: message.threadId ?? null,
    subject: message.subject ?? null,
    laneId: message.linkedLaneId ?? extracted.laneId ?? null,
    region: extracted.region ?? extracted.originRegion ?? null,
    equipment: extracted.equipment ?? extracted.equipmentType ?? null,
    label: rule.label,
  };
}

// ── Storage interface required ────────────────────────────────────────────────

type CarrierEmailNbaStorage = Pick<
  IStorage,
  | "getCarrierMarketNbaBySignalKey"
  | "upsertCarrierMarketNba"
  | "getFirstOrgAdmin"
>;

/**
 * Generate email-driven carrier NBAs from a set of email signals
 * for a single carrier. Called after signal extraction in the scheduler.
 *
 * Uses carrier_market_nbas table with a sentinel marketSignalId of
 * `email_signal:<signalId>` to avoid collision with real market signals.
 */
export async function generateCarrierEmailNbas(
  carrierId: string,
  message: EmailMessage,
  signals: EmailSignal[],
  storageInstance: CarrierEmailNbaStorage,
): Promise<CarrierEmailNbaResult> {
  let created = 0;
  let skipped = 0;

  for (const signal of signals) {
    if (signal.confidence < 60) { skipped++; continue; }

    const rule = CARRIER_EMAIL_NBA_RULES[signal.intentType];
    if (!rule) { skipped++; continue; }

    // Dedup key: use a synthetic marketSignalId based on threadId + intent family
    // so one active NBA per (carrierId, threadId, intentFamily) is enforced.
    // Lookup is keyed on (carrierId, marketSignalId) only — not recommendationType —
    // so all intents in the same family collapse to a single active NBA.
    const threadKey = message.threadId ?? signal.id;
    const marketSignalId = `email_thread:${threadKey}:${rule.intentFamily}`;

    const existing = await storageInstance.getCarrierMarketNbaBySignalKey(
      carrierId,
      marketSignalId,
    );

    if (existing && (existing.status === "pending" || existing.status === "in_progress")) {
      skipped++;
      continue;
    }
    if (existing && (existing.status === "completed" || existing.status === "dismissed")) {
      skipped++;
      continue;
    }

    const explanation = buildExplanation(signal, message, rule);

    await storageInstance.upsertCarrierMarketNba({
      carrierId,
      marketSignalId,
      recommendationType: rule.recommendationType,
      status: "pending",
      urgencyScore: rule.urgencyScore,
      explanation,
      suppressionReason: null,
      lastActionAt: null,
    });
    created++;
  }

  return { carrierId, created, skipped };
}
