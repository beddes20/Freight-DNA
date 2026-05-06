/**
 * Carrier Email Enrichment Staging Service (Task #191)
 *
 * Processes carrier-side email signals and writes staged enrichment suggestions
 * to carrier_email_suggestions. Carrier core profile fields are NEVER directly
 * overwritten — all changes are staged for human review.
 *
 * Signal → suggestion mappings:
 *   lane_offer / new_lane_preference / new_equipment_or_region → positive lane/equipment suggestions
 *   capacity_unavailable → suppression/negative preference signal
 *   price_pushback / service_issue → flagged notes
 *   soft_commitment / hard_commitment → commitment records
 *
 * Dedup: at most one active suggestion per (carrierId, threadId, suggestionType, payloadHash)
 */

import type { IStorage } from "./storage";
import type {
  EmailMessage,
  EmailSignal,
  InsertCarrierEmailSuggestion,
  CarrierEmailSuggestion,
} from "@shared/schema";

// ── Storage interface required ────────────────────────────────────────────────

type EnrichmentStorage = Pick<
  IStorage,
  | "getCarrierEmailSuggestionByDedup"
  | "insertCarrierEmailSuggestion"
>;

// ── Payload builders ──────────────────────────────────────────────────────────

function buildPayload(signal: EmailSignal, message: EmailMessage): Record<string, unknown> {
  const extracted = (signal.extractedData ?? {}) as Record<string, unknown>;
  return {
    intentType: signal.intentType,
    intentSubtype: signal.intentSubtype ?? null,
    confidence: signal.confidence,
    signalDate: signal.createdAt.toISOString(),
    subject: message.subject ?? null,
    laneId: message.linkedLaneId ?? null,
    lane: extracted.lane ?? extracted.laneDescription ?? null,
    region: extracted.region ?? extracted.originRegion ?? extracted.destRegion ?? null,
    equipment: extracted.equipment ?? extracted.equipmentType ?? null,
    rate: extracted.rate ?? extracted.ratePerMile ?? null,
    notes: extracted.notes ?? extracted.summary ?? null,
  };
}

function determineSuggestionType(intentType: string): string | null {
  switch (intentType) {
    case "lane_offer":              return "positive_lane_preference";
    case "new_lane_preference":     return "positive_lane_preference";
    case "new_equipment_or_region": return "equipment_or_region_preference";
    case "capacity_available":      return "capacity_available_note";
    case "capacity_unavailable":    return "capacity_suppression";
    case "price_pushback":          return "pricing_concern_note";
    case "service_issue":           return "service_issue_flag";
    case "soft_commitment":         return "soft_commitment_record";
    case "hard_commitment":         return "hard_commitment_record";
    default:                        return null;
  }
}

/**
 * Simple deterministic hash for dedup — not cryptographically secure,
 * used only for payload deduplication within a thread.
 */
function simplePayloadHash(payload: Record<string, unknown>): string {
  const key = [
    payload.intentType,
    payload.lane ?? "",
    payload.region ?? "",
    payload.equipment ?? "",
    payload.rate ?? "",
  ].join("|");
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return String(Math.abs(hash));
}

// ── Main consumer ─────────────────────────────────────────────────────────────

export interface CarrierEnrichmentResult {
  carrierId: string;
  staged: number;
  deduped: number;
  skipped: number;
}

/**
 * Process carrier-side email signals and create staged enrichment suggestions.
 * Called after signal extraction for messages with a linked carrier.
 */
export async function stageCarrierEmailEnrichment(
  carrierId: string,
  message: EmailMessage,
  signals: EmailSignal[],
  storageInstance: EnrichmentStorage,
): Promise<CarrierEnrichmentResult> {
  let staged = 0;
  let deduped = 0;
  let skipped = 0;

  for (const signal of signals) {
    if (signal.confidence < 50) { skipped++; continue; }

    const suggestionType = determineSuggestionType(signal.intentType);
    if (!suggestionType) { skipped++; continue; }

    const payload = buildPayload(signal, message);
    const payloadHash = simplePayloadHash(payload);
    const threadId = message.threadId ?? null;

    // Dedup check
    if (threadId) {
      const existing = await storageInstance.getCarrierEmailSuggestionByDedup(
        carrierId,
        threadId,
        suggestionType,
        payloadHash,
      );
      if (existing) {
        deduped++;
        continue;
      }
    }

    const insert: InsertCarrierEmailSuggestion = {
      carrierId,
      emailMessageId: message.id,
      threadId,
      suggestionType,
      payload,
      confidence: signal.confidence,
      payloadHash,
      status: "pending",
    };

    await storageInstance.insertCarrierEmailSuggestion(insert);
    staged++;
  }

  return { carrierId, staged, deduped, skipped };
}
