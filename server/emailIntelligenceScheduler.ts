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
import type { EmailMessage, InsertEmailSignal } from "@shared/schema";

const EMAIL_INTEL_INTERVAL_MS = 2 * 60 * 1000;

// Task #751: bumped default 50 → 200 to drain the historical backlog.
// Each message is one OpenAI call so this caps at ~200 calls / 2 minutes
// = 6000 / hour, well under typical org rate limits.
const BATCH_SIZE = parseInt(process.env.EMAIL_INTEL_BATCH_SIZE ?? "200", 10);

// Freshness-first split. Of every cron tick's BATCH_SIZE budget, the first
// FRESH_SLICE messages come from the newest unprocessed mail in the last
// FRESH_LOOKBACK_HOURS window (newest-first). The remainder drains the
// oldest backlog as before. This guarantees that today's inbound mail is
// classified within ~one cron tick (≤2 min) regardless of how big the
// historical queue is. Without this split a stalled extractor (OpenAI 500
// storm, restart, etc.) builds a backlog of 10k+ messages and the
// oldest-first cron then takes 24+ hours to reach today's mail — exactly
// what made the Quote Requests tab go silent on April 28.
const FRESH_SLICE = Math.max(1, Math.floor(BATCH_SIZE * 0.75));
const FRESH_LOOKBACK_HOURS = 6;

export async function runEmailIntelligenceBatch(
  overrideBatchSize?: number,
  orgId?: string,
  opts?: { signal?: AbortSignal },
): Promise<{ processed: number }> {
  const size = overrideBatchSize ?? BATCH_SIZE;
  // Task #751: when an operator triggers a manual drain we MUST scope the
  // batch to their org or one tenant's admin can spend OpenAI quota
  // processing other tenants' inboxes. The cron path passes no orgId and
  // continues to process the global queue.
  let messages: EmailMessage[];
  if (orgId) {
    // Manual drain (admin-triggered): keep oldest-first behavior so the
    // operator sees the backlog actually shrink.
    messages = await storage.getUnprocessedEmailMessagesForOrg(orgId, size);
  } else {
    // Cron path: freshness-first slice + oldest-first remainder, deduped on id.
    const fresh = await storage.getRecentUnprocessedEmailMessages(
      FRESH_LOOKBACK_HOURS,
      Math.min(size, FRESH_SLICE),
    );
    const remaining = Math.max(0, size - fresh.length);
    const backlog = remaining > 0
      ? await storage.getUnprocessedEmailMessages(remaining + fresh.length)
      : [];
    const seen = new Set(fresh.map(m => m.id));
    const backlogDeduped = backlog.filter(m => !seen.has(m.id)).slice(0, remaining);
    messages = [...fresh, ...backlogDeduped];
  }
  if (messages.length === 0) return { processed: 0 };

  console.log(
    `[emailIntelligenceScheduler] processing ${messages.length} unprocessed messages` +
    (orgId ? ` (org=${orgId})` : ` (fresh-first split: ≤${FRESH_SLICE} from last ${FRESH_LOOKBACK_HOURS}h, rest oldest-first)`)
  );

  let processedCount = 0;
  for (const msg of messages) {
    // Cooperative cancellation. When the wall clock fires it aborts the
    // shared AbortController; we exit the loop here so the wrapping promise
    // can resolve cleanly and the in-flight guard releases. Without this
    // check the loop would continue running in the background after the
    // wall clock killed the wrapper, racing the next cron tick (the exact
    // pile-up the in-flight guard is meant to prevent).
    if (opts?.signal?.aborted) {
      console.log(
        `[emailIntelligenceScheduler] aborted mid-batch after ${processedCount}/${messages.length} messages`,
      );
      break;
    }
    try {
      let result;
      try {
        result = await extractEmailSignals(msg, { signal: opts?.signal });
      } catch (extractionErr) {
        console.error(`[emailIntelligenceScheduler] extraction error for message ${msg.id}:`, extractionErr);
        await storage.markEmailMessageProcessed(msg.id);
        processedCount++;
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
    processedCount++;
  }

  return { processed: processedCount };
}

// ─── Reentrancy guard + wall-clock (April 28 hot patch, follow-up) ──────────
//
// Three cron-tick failure modes existed before this guard:
//
//   1. node-cron fires every 2 min regardless of whether the prior tick
//      finished. If a tick took 33 min (which happened on April 28 because
//      the OpenAI call had no per-request timeout — the SDK default is 10
//      min) you got 16 overlapping ticks all hammering OpenAI and the DB
//      pool, eventually killing the cron loop entirely for ~4 hours.
//
//   2. The admin "Run AI batch now" button could pile a manual batch on top
//      of a still-running cron tick, doubling the load.
//
//   3. A body that hung indefinitely (DB pool exhaustion, infinite retry,
//      etc.) had no upper bound — it would just sit in `running` forever
//      and only the heartbeat staleness detector would surface it.
//
// The fix is two layers:
//
//   - A single shared `_batchInFlight` flag covers all three call sites
//     (initial pass, cron tick, manual trigger). If a batch is already
//     running, subsequent ticks are skipped (logged, not silently dropped)
//     and the manual trigger returns `batch_in_progress`.
//
//   - A wall-clock `BATCH_WALL_CLOCK_MS` (5 min) races the body via
//     `Promise.race` AND propagates an AbortSignal into the OpenAI calls
//     and the message loop. When the wall clock fires:
//       (a) the wrapping promise rejects with BatchTimeoutError,
//       (b) the AbortController is aborted, which cancels the in-flight
//           OpenAI fetch and is observed by the loop's `if (signal.aborted)`
//           check so subsequent iterations exit cleanly,
//       (c) withHeartbeat records `error: killed by wall clock`,
//       (d) the finally clears the flag so the next cron tick starts fresh.
//     Without (b), the underlying loop would keep running in the background
//     for up to BATCH_SIZE * 60s after the wrapper rejected, racing the next
//     tick — exactly the overlap pattern the in-flight guard is meant to
//     prevent.
//
let _batchInFlight = false;

const BATCH_WALL_CLOCK_MS = 5 * 60 * 1000;

class BatchTimeoutError extends Error {
  constructor(ms: number) {
    super(`email_intelligence_batch exceeded ${ms}ms wall clock`);
    this.name = "BatchTimeoutError";
  }
}

/**
 * Race `fn(controller.signal)` against an `ms` deadline. On timeout the
 * controller is aborted (so cooperative cancellation can stop the body)
 * AND the returned promise rejects with BatchTimeoutError.
 */
function runWithWallClock<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new BatchTimeoutError(ms));
    }, ms);
    timer.unref?.();
    fn(controller.signal).then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Internal: the single execution path used by all three callers (initial
 * pass, cron tick, manual trigger). Enforces the in-flight guard, the
 * heartbeat wrapper, and the wall clock with cooperative abort. Returns
 * whether the batch was actually started.
 */
function _invokeBatch(opts: { source: "initial" | "cron" | "manual"; orgId?: string }): boolean {
  if (_batchInFlight) {
    console.log(
      `[emailIntelligenceScheduler] skipping ${opts.source} tick: previous batch still running`,
    );
    return false;
  }
  _batchInFlight = true;
  void withHeartbeat(JOB_NAMES.emailIntelligenceBatch, EMAIL_INTEL_INTERVAL_MS, () =>
    runWithWallClock(
      signal => runEmailIntelligenceBatch(undefined, opts.orgId, { signal }),
      BATCH_WALL_CLOCK_MS,
    ),
  )
    .catch(err => {
      if (err instanceof BatchTimeoutError) {
        console.error(
          `[emailIntelligenceScheduler] ${opts.source} batch killed by wall clock (${BATCH_WALL_CLOCK_MS}ms) — next tick will start fresh`,
        );
      } else {
        console.error(`[emailIntelligenceScheduler] ${opts.source} batch error:`, err);
      }
    })
    .finally(() => {
      _batchInFlight = false;
    });
  return true;
}

/**
 * Admin-triggerable manual run of the email intelligence batch. Used by the
 * "Run AI batch now" button on the Capture Audit Status pill so an admin
 * can unstick a stalled cron without waiting for the next tick or a
 * workflow restart. Fire-and-forget — returns immediately so the HTTP
 * response isn't held open for a multi-minute drain.
 */
export function triggerImmediateEmailIntelligenceBatch(opts?: {
  orgId?: string;
}): { started: boolean; reason?: string } {
  const started = _invokeBatch({ source: "manual", orgId: opts?.orgId });
  if (!started) {
    return { started: false, reason: "batch_in_progress" };
  }
  return { started: true };
}

/** Test-only: snapshot whether a batch is currently in flight. */
export function _isBatchInFlightForTests(): boolean {
  return _batchInFlight;
}

/** Test-only: reset the in-flight flag between tests. */
export function _resetBatchInFlightForTests(): void {
  _batchInFlight = false;
}

/** Test-only: surface the wall-clock budget. */
export function _getBatchWallClockMsForTests(): number {
  return BATCH_WALL_CLOCK_MS;
}

/**
 * Test-only: expose the wall-clock helper so behavioral tests can verify
 * the AbortController is actually aborted on timeout, not just that the
 * outer promise rejects.
 */
export function _runWithWallClockForTests<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  return runWithWallClock(fn, ms);
}

/** Test-only: surface the BatchTimeoutError class for assertion. */
export const _BatchTimeoutErrorForTests = BatchTimeoutError;

export function startEmailIntelligenceScheduler(): void {
  console.log(
    `[emailIntelligenceScheduler] starting — every 2 min (cron: */2 * * * *), batch=${BATCH_SIZE}, wall_clock=${BATCH_WALL_CLOCK_MS}ms, in-flight guard=on`,
  );

  // Run an initial pass shortly after startup (30s delay to let DB settle).
  // Routed through _invokeBatch so the in-flight guard + wall clock apply
  // even if a manual trigger races the boot sequence.
  const initTimeout = setTimeout(() => {
    _invokeBatch({ source: "initial" });
  }, 30_000);
  initTimeout.unref?.();

  // Cron-anchored every 2 min, heartbeated, in-flight-guarded, wall-clocked.
  // Skipping a tick when the previous one is still running is *desirable* —
  // the next tick will pick up wherever the in-flight one leaves off, and we
  // avoid the 16-overlapping-ticks pile-up that crashed the cron loop on
  // April 28.
  cron.schedule("*/2 * * * *", () => {
    _invokeBatch({ source: "cron" });
  }, { timezone: "America/Chicago" });
}
