/**
 * Email Intelligence Scheduler (Tasks #190 + #191)
 *
 * Background cron processor that picks up unprocessed email_messages rows,
 * runs OpenAI intent extraction, and writes email_signals. Also calls the
 * downstream consumer areas introduced in Task #191:
 *   - Account NBA generation
 *   - Carrier email NBA generation
 *   - Carrier enrichment staging
 *   - Win/loss evidence linkage
 *
 * Runs every 2 minutes via node-cron for fast quote request SLA response.
 * Batch size: 50 messages per run (configurable via EMAIL_INTEL_BATCH_SIZE).
 */

import cron from "node-cron";
import { storage } from "./storage";
import { extractEmailSignals, deduplicateSignals } from "./emailIntelligenceService";
import { generateNbasFromEmailSignals, generateAccountEmailNbas } from "./nextBestActionEngine";
import { generateCarrierEmailNbas } from "./carrierEmailNbaService";
import { stageCarrierEmailEnrichment } from "./carrierEmailEnrichmentService";
import { processWinLossEvidence } from "./emailWinLossService";
import { processCarrierEmailSignals } from "./services/carrierIntelSuggestions";
import { detectAndSuggest, detectUnlinkedDomainSuggestions } from "./accountContactCaptureService";
import { applyMessageToThread } from "./services/conversationWaitingStateService";
import { determineInitialOwner } from "./services/conversationOwnershipService";
import { ingestPatternEvidence, maybeFireResponsibilityNba } from "./accountContactLanePatternResponsibilityService";
import { mapLaneToPatternIds, extractStateFromLocation } from "./geographicLanePatternUtils";
import { inferContactGeography } from "./contactGeographyInferenceService";
import { fireQuoteRequestAlert } from "./quoteRequestSlaService";
import {
  ingestQuoteFromEmail,
  applyClosedLostToOpenQuote,
  applyClosedWonToOpenQuote,
  isWonLanguage,
  isLostLanguage,
} from "./services/quoteEmailIngestion";
import { JOB_NAMES, withHeartbeat } from "./lib/cronHeartbeat";
import { createHash } from "crypto";
import type { InsertEmailSignal } from "@shared/schema";

const EMAIL_INTEL_INTERVAL_MS = 2 * 60 * 1000;

// Task #751: bumped default 50 → 200 to drain the historical backlog.
// Each message is one OpenAI call so this caps at ~200 calls / 2 minutes
// = 6000 / hour, well under typical org rate limits.
const BATCH_SIZE = parseInt(process.env.EMAIL_INTEL_BATCH_SIZE ?? "200", 10);

export async function runEmailIntelligenceBatch(
  overrideBatchSize?: number,
  orgId?: string,
): Promise<{ processed: number }> {
  const size = overrideBatchSize ?? BATCH_SIZE;
  // Task #751: when an operator triggers a manual drain we MUST scope the
  // batch to their org or one tenant's admin can spend OpenAI quota
  // processing other tenants' inboxes. The cron path passes no orgId and
  // continues to process the global queue.
  const messages = orgId
    ? await storage.getUnprocessedEmailMessagesForOrg(orgId, size)
    : await storage.getUnprocessedEmailMessages(size);
  if (messages.length === 0) return { processed: 0 };

  console.log(`[emailIntelligenceScheduler] processing ${messages.length} unprocessed messages`);

  for (const msg of messages) {
    try {
      let result;
      try {
        result = await extractEmailSignals(msg);
      } catch (extractionErr) {
        console.error(`[emailIntelligenceScheduler] extraction error for message ${msg.id}:`, extractionErr);
        await storage.markEmailMessageProcessed(msg.id);
        continue;
      }

      const deduped = await deduplicateSignals(result.signals, msg);

      const inserts: InsertEmailSignal[] = deduped.map(s => ({
        messageId: msg.id,
        intentType: s.intentType,
        intentSubtype: s.intentSubtype ?? null,
        actorType: result.actorType,
        entityType: msg.linkedCarrierId ? "carrier" : msg.linkedAccountId ? "account" : null,
        entityId: msg.linkedCarrierId ?? msg.linkedAccountId ?? null,
        confidence: s.confidence,
        extractedData: s.extractedData ?? {},
        // Back-fill entity links from message
        linkedAccountId: msg.linkedAccountId ?? null,
        linkedCarrierId: msg.linkedCarrierId ?? null,
        linkedLaneId: msg.linkedLaneId ?? null,
        linkedOpportunityId: null,
      }));

      const saved = inserts.length > 0 ? await storage.insertEmailSignals(inserts) : [];
      await storage.markEmailMessageProcessed(msg.id);

      // ── Consumer area 0: Customer Quotes pipeline (Task #470) ──────────────
      // Mirror the quote-side ingest behavior from `processEmailMessage` so
      // every inbound customer email that classifies as a pricing/quote
      // request becomes a `quote_opportunity` row. Without this the cron
      // path silently dropped every signal — emails got classified but
      // never made it into the Customer Quotes dashboard until someone
      // hit the manual backfill button. Fault-isolated: a failure here
      // never stops downstream NBA / win-loss / enrichment paths from
      // running, and idempotency on (org, source=email, providerMessageId)
      // inside `ingestQuoteFromEmail` makes a same-message replay a no-op.
      if (msg.direction === "inbound" && result.actorType === "customer") {
        const quoteSignal = result.signals.find(
          (s) => s.intentType === "pricing_request" || s.intentType === "new_opportunity",
        );
        if (quoteSignal) {
          try {
            await ingestQuoteFromEmail(msg, { extractedData: quoteSignal.extractedData ?? null });
          } catch (err) {
            console.error(`[emailIntelligenceScheduler] quote ingest failed for ${msg.id}:`, err);
          }
        }

        // Won-language path runs FIRST. Both Won and Lost detectors bail
        // when the quote is no longer pending, so Won claims the pending
        // row before Lost gets a chance on ambiguous-but-positive replies.
        const wonSignal = result.signals.find(
          (s) => s.intentType === "closed_won_indicator" || s.intentSubtype === "closed_won_indicator",
        );
        const shouldTryWon = !!wonSignal || isWonLanguage(msg.body) || isWonLanguage(msg.subject);
        if (shouldTryWon) {
          try {
            await applyClosedWonToOpenQuote(msg, {
              extractedData: wonSignal?.extractedData ?? null,
              intentSubtype: wonSignal?.intentSubtype ?? null,
            });
          } catch (err) {
            console.error(`[emailIntelligenceScheduler] closed-won handling failed for ${msg.id}:`, err);
          }
        }

        const lostSignal = result.signals.find((s) => s.intentType === "closed_lost_indicator");
        const shouldTryLost = !!lostSignal || isLostLanguage(msg.body) || isLostLanguage(msg.subject);
        if (shouldTryLost) {
          try {
            await applyClosedLostToOpenQuote(msg, {
              extractedData: lostSignal?.extractedData ?? null,
              intentSubtype: lostSignal?.intentSubtype ?? null,
            });
          } catch (err) {
            console.error(`[emailIntelligenceScheduler] closed-lost handling failed for ${msg.id}:`, err);
          }
        }
      }

      // ── Consumer area 5: Account contact capture (Task #201) ───────────────
      // Runs for every account-linked message regardless of signal count.
      if (msg.linkedAccountId) {
        detectAndSuggest(msg, storage).catch(err => {
          console.error(`[emailIntelligenceScheduler] contact capture error for message ${msg.id}:`, err);
        });
      } else if (msg.orgId) {
        // Domain-based discovery: detect unknown senders whose domain matches a known account
        detectUnlinkedDomainSuggestions(msg, storage).catch(err => {
          console.error(`[emailIntelligenceScheduler] domain-match contact capture error for message ${msg.id}:`, err);
        });
      }

      // ── Conversation thread ownership + waiting state upsert ────────────────
      // Fault-isolated: failure here never interrupts ingestion.
      // Task #285: previously gated on (linkedAccountId || linkedCarrierId),
      // which left every unlinked thread without an email_conversation_threads
      // row and thus surfaced as a synthetic `thread:` orphan in drilldowns.
      // We now create a thread record for every (org_id, thread_id) so reps
      // can always assign owners and track waiting state.
      if (msg.threadId && msg.orgId) {
        try {
          const now = new Date();
          const existing = await storage.getEmailConversationThreadByThreadId(msg.orgId, msg.threadId);
          const isFirstMessage = !existing;

          let ownerUserId = existing?.ownerUserId ?? null;
          if (isFirstMessage) {
            ownerUserId = await determineInitialOwner(msg, msg.orgId, storage);
          }

          const threadBase = existing ?? {
            id: "",
            orgId: msg.orgId,
            threadId: msg.threadId,
            linkedAccountId: msg.linkedAccountId ?? null,
            linkedCarrierId: msg.linkedCarrierId ?? null,
            ownerUserId,
            waitingState: "waiting_on_us" as const,
            responsePriority: "normal" as const,
            lastMessageId: null,
            lastIncomingAt: null,
            lastOutgoingAt: null,
            waitingSinceAt: null,
            overdueAt: null,
            createdAt: now,
            updatedAt: now,
          };

          const update = applyMessageToThread(threadBase as any, msg, now);

          await storage.upsertEmailConversationThread({
            orgId: msg.orgId,
            threadId: msg.threadId,
            linkedAccountId: msg.linkedAccountId ?? null,
            linkedCarrierId: msg.linkedCarrierId ?? null,
            update: {
              ...update,
              ownerUserId: ownerUserId ?? undefined,
            },
          });
        } catch (convErr) {
          console.error(`[emailIntelligenceScheduler] conversation thread upsert error for ${msg.id}:`, convErr);
        }
      }

      // ── Consumer area 7: Contact geography inference (Task #225) ──────────────
      if (msg.linkedAccountId && msg.orgId) {
        inferContactGeography(msg, storage).catch(err => {
          console.error(`[emailIntelligenceScheduler] geography inference error for ${msg.id}:`, err);
        });
      }

      // ── Consumer area 6: Geographic lane pattern responsibility (Task #203) ──
      // Emits evidence when account, contact, and lane are all identifiable.
      if (msg.linkedAccountId && msg.linkedLaneId && msg.orgId) {
        (async () => {
          try {
            const lane = await storage.getRecurringLane(msg.linkedLaneId!);
            if (!lane) return;
            const originState = extractStateFromLocation(lane.originState ?? lane.origin);
            const destState = extractStateFromLocation(lane.destinationState ?? lane.destination);
            const patternIds = await mapLaneToPatternIds(originState, destState, storage);
            if (patternIds.length === 0) return;

            const contacts = await storage.getContactsByCompany(msg.linkedAccountId!);
            const fromEmail = msg.fromEmail?.toLowerCase();
            const matchedContact = fromEmail
              ? contacts.find(c => c.email?.toLowerCase() === fromEmail)
              : null;
            if (!matchedContact) return;

            for (const patternId of patternIds) {
              const eventKey = createHash("sha256")
                .update(`email:${msg.id}:${patternId}`)
                .digest("hex");
              const ingestResult = await ingestPatternEvidence({
                orgId: msg.orgId!,
                accountId: msg.linkedAccountId!,
                contactId: matchedContact.id,
                lanePatternId: patternId,
                responsibilityType: null,
                sourceType: "email",
                occurredAt: new Date(),
                eventKey,
              }, storage);
              if (ingestResult.crossedHighConfidenceThreshold) {
                maybeFireResponsibilityNba({
                  orgId: msg.orgId!,
                  accountId: msg.linkedAccountId!,
                  contactId: matchedContact.id,
                  lanePatternId: patternId,
                  rowId: ingestResult.rowId,
                  confidenceScore: ingestResult.confidenceScore,
                  crossedHighConfidenceThreshold: true,
                  storage,
                }).catch(() => {});
              }
            }
          } catch (err) {
            console.error(`[emailIntelligenceScheduler] lane pattern responsibility error for ${msg.id}:`, err);
          }
        })();
      }

      if (saved.length === 0) continue;

      // ── Consumer area 1: Win/loss evidence linkage ─────────────────────────
      processWinLossEvidence(msg, saved, storage).catch(err =>
        console.error(`[emailIntelligenceScheduler] win/loss evidence error for ${msg.id}:`, err)
      );

      // ── Consumer area 2: Account NBA generation ────────────────────────────
      if (msg.orgId) {
        // Legacy email → NBA card path (from Task #190 — kept for backward compat)
        generateNbasFromEmailSignals(msg.orgId, msg, saved).catch(err =>
          console.error(`[emailIntelligenceScheduler] legacy NBA error for ${msg.id}:`, err)
        );

        // New account email NBA consumer (Task #191)
        if (msg.linkedAccountId) {
          generateAccountEmailNbas(msg.orgId, msg.linkedAccountId, msg, saved).catch(err =>
            console.error(`[emailIntelligenceScheduler] account email NBA error for ${msg.id}:`, err)
          );

          const hasPricingRequest = saved.some(s => s.intentType === "pricing_request");
          if (hasPricingRequest) {
            const pricingSignal = saved.find(s => s.intentType === "pricing_request")!;
            fireQuoteRequestAlert(msg.orgId, msg.linkedAccountId, pricingSignal.id, msg.subject ?? null).catch(err =>
              console.error(`[emailIntelligenceScheduler] quote SLA alert error for ${msg.id}:`, err)
            );
          }
        }

        // ── Consumer area 3 & 4: Carrier email NBAs + enrichment ──────────────
        if (msg.linkedCarrierId) {
          generateCarrierEmailNbas(msg.linkedCarrierId, msg, saved, storage).catch(err =>
            console.error(`[emailIntelligenceScheduler] carrier email NBA error for ${msg.id}:`, err)
          );

          stageCarrierEmailEnrichment(msg.linkedCarrierId, msg, saved, storage).catch(err =>
            console.error(`[emailIntelligenceScheduler] carrier enrichment error for ${msg.id}:`, err)
          );
        }
      }

      // Non-blocking: map carrier email signals → intel suggestions
      if (saved.length > 0 && msg.linkedCarrierId && msg.orgId) {
        processCarrierEmailSignals(storage, msg.linkedCarrierId, msg.orgId, msg, saved).catch(err => {
          console.error(`[emailIntelligenceScheduler] carrier intel mapper error for message ${msg.id}:`, err);
        });
      }

    } catch (err) {
      console.error(`[emailIntelligenceScheduler] fatal error for message ${msg.id}:`, err);
      // Mark processed so the same message doesn't stall the queue
      try {
        await storage.markEmailMessageProcessed(msg.id);
      } catch {
        // ignore secondary error
      }
    }
  }

  return { processed: messages.length };
}

export function startEmailIntelligenceScheduler(): void {
  console.log(`[emailIntelligenceScheduler] starting — every 2 min (cron: */2 * * * *), batch=${BATCH_SIZE}`);

  // Run an initial pass shortly after startup (30s delay to let DB settle).
  // Wrapped in withHeartbeat so a dead initial pass is observable from the
  // capture-audit pill within the next tick rather than going silent.
  const initTimeout = setTimeout(() => {
    withHeartbeat(JOB_NAMES.emailIntelligenceBatch, EMAIL_INTEL_INTERVAL_MS, () =>
      runEmailIntelligenceBatch(),
    ).catch(err =>
      console.error("[emailIntelligenceScheduler] initial batch error:", err),
    );
  }, 30_000);
  initTimeout.unref?.();

  // Cron-anchored every 2 min, heartbeated. The previous unwrapped path
  // meant a silently-failing extractor (e.g. OpenAI 500 storm) stopped
  // producing quote_opportunities for hours without any visible signal —
  // exactly the bug that left the Customer Quotes dashboard frozen.
  cron.schedule("*/2 * * * *", () => {
    withHeartbeat(JOB_NAMES.emailIntelligenceBatch, EMAIL_INTEL_INTERVAL_MS, () =>
      runEmailIntelligenceBatch(),
    ).catch(err =>
      console.error("[emailIntelligenceScheduler] batch error:", err),
    );
  }, { timezone: "America/Chicago" });
}
