/**
 * Carrier Intel Suggestion Mapper Service (Task #193)
 *
 * Maps email_signals where actorType=carrier to carrier_intel_suggestions rows.
 * Called after email signals are created for a carrier. Non-blocking: errors
 * are caught and logged so mapper failures never break email ingestion.
 *
 * Intent → suggestionType mapping:
 *   lane_offer | new_lane_preference → lane_preference
 *   capacity_available               → capacity_available
 *   capacity_unavailable             → capacity_unavailable
 *   soft_commitment | hard_commitment → lane_preference (elevated confidence) or capacity_available
 *   new_equipment_or_region          → equipment_capability or region_preference
 *   price_pushback                   → price_sensitivity
 *   service_issue                    → service_risk
 *
 * Dedup: same (carrierId, suggestionType, emailSignalId) = one suggestion.
 * Skip if an accepted suggestion already exists for the same carrier + type + emailSignalId.
 *
 * Hybrid Auto-Accept:
 *   High-confidence signals (≥75) for safe types are auto-accepted immediately:
 *     - lane_preference with specific origin+destination cities
 *     - hard_commitment (always specific enough)
 *     - capacity_unavailable (safe to suppress proactively)
 *   Lower-confidence or ambiguous signals stay pending for human review:
 *     - region_preference (too broad without human judgment)
 *     - price_sensitivity (rate misinterpretation risk)
 *     - service_risk (reputation impact needs context)
 *     - lane_preference without specific cities
 */

import type { IStorage } from "../storage";
import type { EmailSignal, EmailMessage, InsertCarrierIntelSuggestion } from "@shared/schema";

type SuggestionType =
  | "lane_preference"
  | "capacity_available"
  | "capacity_unavailable"
  | "equipment_capability"
  | "region_preference"
  | "price_sensitivity"
  | "service_risk";

interface MappedSuggestion {
  suggestionType: SuggestionType;
  confidenceScore: number;
  payload: Record<string, unknown>;
}

const AUTO_ACCEPT_THRESHOLD = 75;

const AUTO_ACCEPT_TYPES: Set<SuggestionType> = new Set([
  "lane_preference",
  "capacity_available",
  "capacity_unavailable",
]);

const ALWAYS_MANUAL_TYPES: Set<SuggestionType> = new Set([
  "region_preference",
  "price_sensitivity",
  "service_risk",
  "equipment_capability",
]);

function shouldAutoAccept(mapped: MappedSuggestion): boolean {
  if (mapped.confidenceScore < AUTO_ACCEPT_THRESHOLD) return false;
  if (ALWAYS_MANUAL_TYPES.has(mapped.suggestionType)) return false;
  if (!AUTO_ACCEPT_TYPES.has(mapped.suggestionType)) return false;

  if (mapped.suggestionType === "lane_preference") {
    const p = mapped.payload;
    const hasOrigin = typeof p.origin === "string" && p.origin.trim().length > 0;
    const hasDestination = typeof p.destination === "string" && p.destination.trim().length > 0;
    if (!hasOrigin || !hasDestination) return false;
  }

  return true;
}

function mapSignalToSuggestion(signal: EmailSignal): MappedSuggestion | null {
  const data = (signal.extractedData ?? {}) as Record<string, unknown>;
  const confidence = signal.confidence ?? 50;

  switch (signal.intentType) {
    case "lane_offer":
    case "new_lane_preference":
      return {
        suggestionType: "lane_preference",
        confidenceScore: confidence,
        payload: {
          origin: data.origin ?? null,
          destination: data.destination ?? null,
          originState: data.origin_state ?? data.originState ?? null,
          destState: data.dest_state ?? data.destState ?? null,
          equipment: data.equipment ?? data.equipment_type ?? null,
          timeWindow: data.time_window ?? data.timeWindow ?? null,
          notes: data.notes ?? null,
          intentType: signal.intentType,
        },
      };

    case "capacity_available":
      return {
        suggestionType: "capacity_available",
        confidenceScore: confidence,
        payload: {
          region: data.region ?? null,
          origin: data.origin ?? null,
          destination: data.destination ?? null,
          equipment: data.equipment ?? null,
          availableDate: data.available_date ?? data.availableDate ?? null,
          notes: data.notes ?? null,
        },
      };

    case "capacity_unavailable":
      return {
        suggestionType: "capacity_unavailable",
        confidenceScore: confidence,
        payload: {
          region: data.region ?? null,
          equipment: data.equipment ?? null,
          unavailableUntil: data.unavailable_until ?? data.unavailableUntil ?? null,
          notes: data.notes ?? null,
        },
      };

    case "soft_commitment":
    case "hard_commitment": {
      const elevated = Math.min(100, confidence + (signal.intentType === "hard_commitment" ? 20 : 10));
      if (data.origin || data.destination || data.lane) {
        return {
          suggestionType: "lane_preference",
          confidenceScore: elevated,
          payload: {
            origin: data.origin ?? null,
            destination: data.destination ?? null,
            equipment: data.equipment ?? null,
            commitmentType: signal.intentType,
            notes: data.notes ?? null,
          },
        };
      }
      return {
        suggestionType: "capacity_available",
        confidenceScore: elevated,
        payload: {
          commitmentType: signal.intentType,
          region: data.region ?? null,
          equipment: data.equipment ?? null,
          notes: data.notes ?? null,
        },
      };
    }

    case "price_pushback":
      return {
        suggestionType: "price_sensitivity",
        confidenceScore: confidence,
        payload: {
          rate: data.rate ?? data.requested_rate ?? null,
          origin: data.origin ?? null,
          destination: data.destination ?? null,
          reason: data.reason ?? null,
          notes: data.notes ?? null,
        },
      };

    case "service_issue":
      return {
        suggestionType: "service_risk",
        confidenceScore: confidence,
        payload: {
          issueType: data.issue_type ?? data.issueType ?? null,
          severity: data.severity ?? null,
          notes: data.notes ?? null,
        },
      };

    default:
      return null;
  }
}

/**
 * Process a batch of email signals for a carrier and create intel suggestions.
 * Non-blocking: catches all errors and logs them.
 */
export async function processCarrierEmailSignals(
  storage: IStorage,
  carrierId: string,
  orgId: string,
  message: EmailMessage,
  signals: EmailSignal[]
): Promise<void> {
  try {
    const carrierSignals = signals.filter(s => s.actorType === "carrier");
    if (carrierSignals.length === 0) return;

    for (const signal of carrierSignals) {
      try {
        const mapped = mapSignalToSuggestion(signal);
        if (!mapped) continue;

        const existing = await storage.findDuplicateSuggestion(
          carrierId,
          mapped.suggestionType,
          signal.id
        );
        if (existing) {
          if (existing.status === "accepted" || existing.status === "auto_accepted") continue;
          continue;
        }

        const autoAccept = shouldAutoAccept(mapped);

        const insert: InsertCarrierIntelSuggestion = {
          carrierId,
          orgId,
          sourceType: "email_signal",
          emailSignalId: signal.id,
          marketSignalId: null,
          suggestionType: mapped.suggestionType,
          payload: mapped.payload,
          confidenceScore: mapped.confidenceScore,
          status: autoAccept ? "auto_accepted" : "pending",
          comment: autoAccept ? "Auto-accepted: high-confidence signal" : null,
          acceptedByUserId: null,
          rejectedByUserId: null,
        };

        const created = await storage.insertCarrierIntelSuggestion(insert);

        if (autoAccept) {
          await storage.updateSuggestionStatus(created.id, "auto_accepted", {
            comment: `Auto-accepted (confidence: ${mapped.confidenceScore}%, type: ${mapped.suggestionType})`,
          });
          console.log(
            `[carrierIntelSuggestions] ✅ auto-accepted ${mapped.suggestionType} for carrier ${carrierId} (confidence: ${mapped.confidenceScore}%)`
          );
        }
      } catch (signalErr) {
        console.error(
          `[carrierIntelSuggestions] error processing signal ${signal.id} for carrier ${carrierId}:`,
          signalErr
        );
      }
    }
  } catch (err) {
    console.error(
      `[carrierIntelSuggestions] non-blocking error for carrier ${carrierId}:`,
      err
    );
  }
}
