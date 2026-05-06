/**
 * Email Win/Loss Evidence Service (Task #191)
 *
 * Hooks closed_won_indicator and closed_lost_indicator signals into the
 * email_outcome_links table. When a won/lost indicator is detected in a batch,
 * ALL signals in the batch are linked as outcome evidence so that related signals
 * (e.g., objection, pricing_request that led to the outcome) are co-queryable
 * via email_outcome_links.
 *
 * Also back-fills linkedAccountId/linkedCarrierId/linkedLaneId/linkedOpportunityId
 * on email_signals rows from their parent email_messages.
 */

import type { IStorage } from "./storage";
import type { EmailMessage, EmailSignal } from "@shared/schema";

type WinLossStorage = Pick<
  IStorage,
  | "insertEmailOutcomeLink"
  | "updateEmailSignalLinks"
>;

const WIN_INTENTS  = new Set(["closed_won_indicator"]);
const LOSS_INTENTS = new Set(["closed_lost_indicator"]);

const OUTCOME_CONFIDENCE_THRESHOLD = 50;

/**
 * Processes newly created email signals and:
 *  1. Back-fills linkedAccountId / linkedCarrierId / linkedLaneId / linkedOpportunityId
 *     on every signal row from the parent message when those fields are null.
 *  2. For any batch that contains a closed_won or closed_lost signal:
 *       - Writes email_outcome_links for the outcome signal itself (one row per entity).
 *       - Writes email_outcome_links for every OTHER signal in the same batch so
 *         that related evidence (objections, pricing_request, etc.) is co-queryable.
 *
 * Called after signals are saved in the scheduler.
 * Never throws — errors are logged and swallowed.
 */
export async function processWinLossEvidence(
  message: EmailMessage,
  signals: EmailSignal[],
  storageInstance: WinLossStorage,
): Promise<void> {
  // Determine which outcome this batch represents (if any).
  const outcomeSignal = signals.find(s =>
    (WIN_INTENTS.has(s.intentType) || LOSS_INTENTS.has(s.intentType)) &&
    s.confidence >= OUTCOME_CONFIDENCE_THRESHOLD,
  );
  const outcomeType = outcomeSignal
    ? (WIN_INTENTS.has(outcomeSignal.intentType) ? "won" : "lost")
    : null;

  // Collect entity links from the parent message.
  const entityLinks = collectEntityLinks(message);

  for (const signal of signals) {
    try {
      // 1. Back-fill entity links on the signal row from the parent message.
      const linksToUpdate: {
        linkedAccountId?: string | null;
        linkedCarrierId?: string | null;
        linkedLaneId?: string | null;
        linkedOpportunityId?: string | null;
      } = {};

      if (!signal.linkedAccountId && message.linkedAccountId) {
        linksToUpdate.linkedAccountId = message.linkedAccountId;
      }
      if (!signal.linkedCarrierId && message.linkedCarrierId) {
        linksToUpdate.linkedCarrierId = message.linkedCarrierId;
      }
      if (!signal.linkedLaneId && message.linkedLaneId) {
        linksToUpdate.linkedLaneId = message.linkedLaneId;
      }
      // Populate opportunityId from the message's load link when available.
      if (!signal.linkedOpportunityId && message.linkedLoadId) {
        linksToUpdate.linkedOpportunityId = message.linkedLoadId;
      }

      if (Object.keys(linksToUpdate).length > 0) {
        await storageInstance.updateEmailSignalLinks(signal.id, linksToUpdate);
      }

      // 2. If this batch has an outcome signal, link ALL batch signals as evidence.
      if (!outcomeType) continue;

      for (const { entityType, entityId } of entityLinks) {
        await storageInstance.insertEmailOutcomeLink({
          emailSignalId: signal.id,
          entityType,
          entityId,
          outcomeType,
        });
      }

    } catch (err) {
      console.error(`[emailWinLoss] error processing signal ${signal.id}:`, err);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface EntityRef { entityType: string; entityId: string }

function collectEntityLinks(message: EmailMessage): EntityRef[] {
  const refs: EntityRef[] = [];
  if (message.linkedAccountId) {
    refs.push({ entityType: "account", entityId: message.linkedAccountId });
  }
  if (message.linkedCarrierId) {
    refs.push({ entityType: "carrier", entityId: message.linkedCarrierId });
  }
  if (message.linkedLaneId) {
    refs.push({ entityType: "lane", entityId: message.linkedLaneId });
  }
  if (message.linkedLoadId) {
    refs.push({ entityType: "load", entityId: message.linkedLoadId });
  }
  return refs;
}
