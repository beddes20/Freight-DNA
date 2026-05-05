/**
 * Inline email classifier dispatcher (Task #939).
 *
 * Fired in-process by the Graph webhook handler and the polling delta-sync
 * service the moment an inbound customer email is persisted. Runs the same
 * extract → dedupe → quote-ingest pipeline that
 * `emailIntelligenceScheduler.runEmailIntelligenceBatch` runs on its 2-minute
 * cron tick, but for a single freshly-persisted message — so the typical
 * "email hits Outlook → quote row visible in UI" latency drops from ~minutes
 * (worst-case 2min cron + 30s React Query refetch) to seconds.
 *
 * Design contract:
 *   1. Fire-and-forget. `dispatchInlineClassification` returns void
 *      synchronously. The wrapped async work runs in the background and
 *      MUST never bubble an error to the caller — the webhook response
 *      cannot block on OpenAI.
 *   2. Process-wide concurrency limiter. We allow up to
 *      `INLINE_CLASSIFY_MAX_INFLIGHT` (default 8) classifications running
 *      at once. Excess work is queued; the caller never sees backpressure.
 *      8 is roughly aligned with our typical OpenAI Tier-2 RPM headroom and
 *      keeps us well below the rate limits that triggered the April 28 cron
 *      pile-up.
 *   3. Per-message wall-clock. Every job is raced against
 *      `INLINE_CLASSIFY_TIMEOUT_MS` (default 30s). On timeout we abort the
 *      AbortController so the OpenAI call short-circuits, and we log the
 *      timeout — we deliberately do NOT mark the row processed, so the
 *      recovery cron will pick it up again.
 *   4. Recovery-cron compatibility. On any failure path the row stays
 *      `processedForSignalsAt = null`, exactly matching what the cron
 *      expects. Idempotency on (org, source=email, providerMessageId)
 *      inside `ingestQuoteFromEmail` makes a duplicate run from the
 *      recovery cron a no-op.
 *   5. Backfill / admin-drain isolation. This module is intentionally NOT
 *      imported from `mailboxHistoricalBackfillService.ts`,
 *      `routes/emailPipelineOps.ts`, or the manual /drain handler in
 *      `routes/conversations.ts` — those paths are batch-shaped and would
 *      blow OpenAI quota if every backfilled message dispatched inline.
 *      `tests/code-quality-guardrails.test.ts` Section 28 fails if a future
 *      refactor changes that.
 *
 * Quote-side live-sync: the `customer_quote` push is emitted from
 * `services/quoteEmailIngestion.ts` immediately after the quote row is
 * inserted, so the Quote Requests tab updates within the same tick whether
 * the ingest came from this dispatcher or the recovery cron.
 */

import { eq, sql } from "drizzle-orm";
import { emailMessages, type EmailMessage, type InsertEmailSignal, type QuotePipelineDropReason } from "@shared/schema";
import { db, storage } from "../storage";
import { recordIntegrationEvent } from "../integrations/probeRegistry";

/**
 * Task #952 — Phase A0 classifier-side drop helper.
 *
 * Mirror of `recordIngestionDrop` inside `quoteEmailIngestion.ts` for the
 * earlier classifier stage. Distinct stage (`classification` vs `ingest`)
 * so the operator UI can tell apart "we never attempted ingestion" (signal
 * never matched) from "we attempted ingestion and it skipped" (parse failed
 * etc).
 *
 * Best-effort: a write failure here is logged but NEVER bubbles, so a
 * metrics outage cannot break customer-quote capture.
 */
async function recordClassificationDrop(
  message: EmailMessage,
  reasonCode: QuotePipelineDropReason,
  detail: string,
  opts?: {
    extractedSnapshot?: Record<string, unknown> | null;
    confidence?: number | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  try {
    await storage.recordQuotePipelineDrop({
      orgId: message.orgId,
      messageId: message.id,
      stage: "classification",
      reasonCode,
      detail: detail.slice(0, 1000),
      errorMessage: opts?.errorMessage?.slice(0, 1000) ?? null,
      senderEmail: message.fromEmail ?? null,
      subject: message.subject ?? null,
      receivedAt: message.providerSentAt ?? message.createdAt ?? null,
      // Drizzle's numeric column accepts string; pass the raw decimal so
      // precision survives the round-trip. Clamp to [0,1] and reject
      // non-finite values — the column is decimal(5,4) (max 9.9999) and
      // an OpenAI hallucination of e.g. 12.3 would otherwise crash the
      // classifier with a numeric overflow on what is supposed to be a
      // best-effort metrics write.
      confidence:
        opts?.confidence != null && Number.isFinite(opts.confidence)
          ? String(Math.max(0, Math.min(1, opts.confidence)))
          : null,
      extractedSnapshot: opts?.extractedSnapshot ?? null,
      quoteId: null,
      resolvedAt: null,
      resolvedById: null,
      resolutionNote: null,
      lastReprocessAt: null,
      lastReprocessError: null,
    });
  } catch (err) {
    console.error(
      `[inlineEmailClassifier] recordQuotePipelineDrop(${reasonCode}) failed for message ${message.id}:`,
      err,
    );
  }
}

// Tunables — overridable via env so an operator can dial concurrency or
// the per-message budget down without a redeploy.
const INLINE_CLASSIFY_MAX_INFLIGHT = parseInt(
  process.env.INLINE_CLASSIFY_MAX_INFLIGHT ?? "8",
  10,
);
const INLINE_CLASSIFY_TIMEOUT_MS = parseInt(
  process.env.INLINE_CLASSIFY_TIMEOUT_MS ?? "30000",
  10,
);

// Module-level semaphore. Tracks both currently-running jobs and a FIFO
// queue of waiters. Kept private to this module — callers only see
// `dispatchInlineClassification`.
let _inFlight = 0;
const _waitQueue: Array<() => void> = [];
let _totalDispatched = 0;
let _totalCompleted = 0;
let _totalFailed = 0;
let _totalTimedOut = 0;
let _totalQuoteIngestedInline = 0;

function acquireSlot(): Promise<void> {
  if (_inFlight < INLINE_CLASSIFY_MAX_INFLIGHT) {
    _inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _waitQueue.push(() => {
      _inFlight++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  _inFlight--;
  const next = _waitQueue.shift();
  if (next) next();
}

class InlineClassifyTimeoutError extends Error {
  constructor(public readonly ms: number, public readonly messageId: string) {
    super(`inline classification exceeded ${ms}ms for message ${messageId}`);
    this.name = "InlineClassifyTimeoutError";
  }
}

function runWithWallClock<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  messageId: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new InlineClassifyTimeoutError(ms, messageId));
    }, ms);
    timer.unref?.();
    fn(controller.signal).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run the full extract → dedupe → quote-ingest pipeline for one message.
 *
 * Mirrors the per-message body of
 * `runEmailIntelligenceBatch` in `server/emailIntelligenceScheduler.ts` for
 * the customer-quote path. We deliberately skip the carrier-side downstream
 * consumers (carrier intel, NBA generation, win/loss evidence) — those can
 * keep running on the cron's 2-minute cadence per the Task #939 scope. Only
 * the customer-quote pipeline is on the critical "rep is staring at the
 * screen" loop.
 */
async function classifyOne(message: EmailMessage, signal: AbortSignal): Promise<void> {
  // Lazy-import the heavy modules so the dispatcher stays cheap to import
  // from the route layer (which boots before extractor dependencies are
  // wired up in some test entrypoints).
  const { extractEmailSignals, deduplicateSignals } = await import(
    "../emailIntelligenceService"
  );
  const { ingestQuoteFromEmail } = await import("./quoteEmailIngestion");

  if (signal.aborted) return;

  let extraction;
  try {
    extraction = await extractEmailSignals(message, { signal });
  } catch (err) {
    // Extraction failure: leave the row unprocessed so the recovery cron
    // tries again (same behavior as the cron's per-message try/catch).
    const errMsg = err instanceof Error ? err.message : String(err);
    recordIntegrationEvent({
      source: "graph",
      outcome: "error",
      errorMessage: `inline_extract:${message.id}: ${errMsg.slice(0, 200)}`,
    });
    return;
  }

  if (signal.aborted) return;

  const deduped = await deduplicateSignals(extraction.signals, message);

  const inserts: InsertEmailSignal[] = deduped.map((s) => ({
    messageId: message.id,
    intentType: s.intentType,
    intentSubtype: s.intentSubtype ?? null,
    actorType: extraction.actorType,
    entityType: message.linkedCarrierId ? "carrier" : message.linkedAccountId ? "account" : null,
    entityId: message.linkedCarrierId ?? message.linkedAccountId ?? null,
    confidence: s.confidence,
    extractedData: s.extractedData ?? {},
    linkedAccountId: message.linkedAccountId ?? null,
    linkedCarrierId: message.linkedCarrierId ?? null,
    linkedLaneId: message.linkedLaneId ?? null,
    linkedOpportunityId: null,
  }));

  if (inserts.length > 0) {
    try {
      await storage.insertEmailSignals(inserts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordIntegrationEvent({
        source: "graph",
        outcome: "error",
        errorMessage: `inline_signal_insert:${message.id}: ${errMsg.slice(0, 200)}`,
      });
      // Fall through — quote-ingest can still run from the extracted
      // signals even if persisting the signal rows tripped (transient DB
      // contention should not gate quote creation).
    }
  }

  // Task #1003 — capture-first contract. We no longer gate on
  // `actorType === "customer"`. Any inbound email with a quote-shaped
  // signal at conf >= 0.4 (or that looks quote-shaped via the regex
  // candidate detector even when the LLM returned zero signals) becomes
  // a quote_opportunity. The CONFIDENCE gates the routing bucket, not
  // the row's existence:
  //   - actorType=customer + quoteSignal conf >= 0.7 -> auto_customer
  //   - actorType=carrier  + quoteSignal conf >= 0.7 -> auto_carrier
  //   - everything else quote-shaped                  -> needs_routing
  // A `senderRoutingRules` hit overrides the classifier verdict so the
  // rep's prior "Remember for @rimlogistics.com" decision auto-routes
  // future ambiguous mail from that domain.
  if (message.direction === "inbound") {
    const { lookupSenderRoutingDecision, looksLikeQuoteCandidate } = await import(
      "./quoteEmailIngestion"
    );
    const quoteSignal = extraction.signals.find(
      (s) => s.intentType === "pricing_request" || s.intentType === "new_opportunity",
    );
    const signalConf = quoteSignal?.confidence ?? 0;
    const candidateBySignal = !!quoteSignal && signalConf >= 0.4;
    const candidateByShape = looksLikeQuoteCandidate(
      message.subject ?? "",
      message.body ?? "",
    );
    const isCandidate = candidateBySignal || candidateByShape;

    // Email→Exec 1 (Task #1052) — first-touch tender branch. Runs BEFORE the
    // quote pipeline so a clear customer load tender ("please cover ATL→DAL,
    // PO #...") creates a `freight_opportunities` row in `pending_approval`
    // instead of being mis-routed into Customer Quotes. Carrier emails and
    // outbound mail are excluded inside the helper. Honors the inbound email
    // preservation contract: this branch is additive (it inserts a new
    // freight_opportunities row) — it never mutates or drops the underlying
    // email_messages row, so the existing quote pipeline still gets a chance
    // to create a quote_opportunity if the email is mixed-intent.
    if (
      message.direction === "inbound" &&
      !message.linkedCarrierId &&
      extraction.actorType !== "carrier"
    ) {
      try {
        const { ingestTenderFromEmail } = await import("./tenderEmailIngestion");
        const tenderResult = await ingestTenderFromEmail(message);
        if (tenderResult.status === "ingested") {
          // Successful tender ingest. We deliberately fall through to the
          // quote-pipeline block below — a single email CAN legitimately be
          // both a tender AND a price ask, and the existing pipeline is the
          // single source of truth for quote_opportunities. The freight_opps
          // pre-insert lookup makes a re-run of the same email a no-op.
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordIntegrationEvent({
          source: "graph",
          outcome: "error",
          errorMessage: `inline_tender_ingest:${message.id}: ${errMsg.slice(0, 200)}`,
        });
        // Tender ingest failure must NEVER gate the quote pipeline — fall
        // through so the message still gets its quote_opportunity chance.
      }
    }

    if (isCandidate) {
      const senderRule = await lookupSenderRoutingDecision(
        message.orgId,
        message.fromEmail,
      );
      let routingStatus: "auto_customer" | "needs_routing" | "auto_carrier";
      let routingNote: string | null = null;
      if (senderRule?.decision === "customer") {
        routingStatus = "auto_customer";
        routingNote = `Auto-routed via remembered ${senderRule.scopeType} rule (${senderRule.scopeValue}).`;
      } else if (senderRule?.decision === "carrier") {
        routingStatus = "auto_carrier";
        routingNote = `Auto-routed via remembered ${senderRule.scopeType} rule (${senderRule.scopeValue}).`;
      } else if (senderRule?.decision === "dismiss") {
        // Remembered "not a quote" - skip ingest entirely but record drop.
        await recordClassificationDrop(
          message,
          "classifier_miss",
          `Sender rule (${senderRule.scopeType}=${senderRule.scopeValue}) says dismiss; skipping ingest.`,
          { confidence: signalConf },
        );
        return;
      } else if (extraction.actorType === "customer" && signalConf >= 0.7) {
        routingStatus = "auto_customer";
      } else if (extraction.actorType === "carrier" && signalConf >= 0.7) {
        routingStatus = "auto_carrier";
      } else {
        routingStatus = "needs_routing";
        routingNote =
          `Classifier uncertain (actor=${extraction.actorType ?? "unknown"}, ` +
          `quoteSignalConf=${signalConf.toFixed(2)}). Awaiting human routing decision.`;
      }
      // Task #1054 review hardening — trusted-carrier override.
      // If the email row was already linked to a known carrier (e.g. the
      // sender resolver matched the From address to `carriers`), promote
      // routing to `auto_carrier` regardless of the classifier's
      // confidence bucket. Without this, an ambiguous-confidence carrier
      // reply would fall into `needs_routing` and then `ingestQuoteFromEmail`
      // would create a customer `quote_opportunities` row — exactly the
      // pollution this task is meant to prevent.
      if (message.linkedCarrierId && routingStatus !== "auto_carrier") {
        routingStatus = "auto_carrier";
        routingNote =
          (routingNote ? routingNote + " " : "") +
          `Promoted to auto_carrier: sender resolved to known carrier ${message.linkedCarrierId}.`;
      }
      // Task #1054 — Email→Exec sub-task 3: when the routing decision is
      // `auto_carrier`, branch to the dedicated carrier-quote ingestion path
      // (`carrier_quote_events`). This keeps carrier rate offers off the
      // customer `quote_opportunities` table and out of the rep's customer
      // queue. Idempotent on (orgId, sourceReference); the ingest function
      // itself enforces the "must have a numeric rate" gate via
      // `looksLikeCarrierQuote`, so non-pricing carrier traffic (truck-
      // availability pings, bare lane mentions, etc.) is silently skipped
      // and does NOT create a row.
      if (routingStatus === "auto_carrier") {
        try {
          const { ingestCarrierQuoteFromEmail } = await import("./carrierQuoteIngestion");
          await ingestCarrierQuoteFromEmail(message, {
            carrierId: message.linkedCarrierId ?? null,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          recordIntegrationEvent({
            source: "graph",
            outcome: "error",
            errorMessage: `inline_carrier_quote_ingest:${message.id}: ${errMsg.slice(0, 200)}`,
          });
        }
        return;
      }

      // Re-implement the original block here, but pass routingStatus.
      try {
        const result = await ingestQuoteFromEmail(message, {
          extractedData: quoteSignal?.extractedData ?? null,
          routingStatus,
          routingNote,
          // Task #1053 — pass through the classifier's quote-signal
          // confidence so it lands in `quoteHints.confidence` and the
          // Needs Routing drawer can surface it as a badge.
          hintConfidence: signalConf,
        });
        if (result.status === "ingested") {
          _totalQuoteIngestedInline++;
          // Task #968 — record a reclassified event + emit a
          // conversation_thread bucket-change to "Quote Requests" when
          // a follow-up message promotes a thread that previously
          // didn't carry pricing intent.
          if (message.threadId && quoteSignal) {
            try {
              const priorCount = await db.execute<{ c: number }>(sql`
                SELECT COUNT(*)::int AS c
                  FROM email_messages
                 WHERE org_id = ${message.orgId}
                   AND thread_id = ${message.threadId}
                   AND id <> ${message.id}
                 LIMIT 1
              `);
              const hadPrior = (priorCount.rows[0]?.c ?? 0) > 0;
              if (hadPrior) {
                const { recordThreadEvent } = await import("./conversationThreadEventsService");
                await recordThreadEvent({
                  orgId: message.orgId,
                  threadId: message.threadId,
                  eventType: "reclassified",
                  description: "Reclassified to Quote Requests — a new inbound email added pricing intent.",
                  details: {
                    triggerMessageId: message.id,
                    intentType: quoteSignal.intentType,
                    quoteId: result.quoteId ?? null,
                    previousBucket: "all",
                    currentBucket: "quote_requests",
                  },
                });
                try {
                  const { publish: publishLiveSync } = await import("./liveSync");
                  publishLiveSync(message.orgId, "mailbox_inbound", message.threadId, Date.now());
                  publishLiveSync(message.orgId, "conversation_thread", message.threadId, Date.now(), {
                    threadId: message.threadId,
                    previousBucket: "all",
                    currentBucket: "quote_requests",
                  });
                } catch { /* best-effort */ }
              }
            } catch (rErr) {
              console.warn(
                `[inlineEmailClassifier] reclassified-event emit failed for ${message.id}:`,
                rErr instanceof Error ? rErr.message : rErr,
              );
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordIntegrationEvent({
          source: "graph",
          outcome: "error",
          errorMessage: `inline_quote_ingest:${message.id}: ${errMsg.slice(0, 200)}`,
        });
        // Task #952 — record the exception so the operator console can
        // surface it next to the silent skips. Snapshot the signals so
        // a reprocess after a fix can replay with the original context.
        await recordClassificationDrop(message, "exception", errMsg, {
          extractedSnapshot: {
            actorType: extraction.actorType,
            signals: extraction.signals,
          },
          confidence: quoteSignal?.confidence ?? null,
          errorMessage: errMsg,
        });
        return;
      }
    } else {
      // Task #1003 — classifier ran but the email did not look quote-shaped
      // by either signal (>=0.4 pricing intent) or regex (subject/body
      // mentions origin/dest/equipment/rate language). Record the miss
      // so operators can spot regressions and reprocess after rule or
      // prompt changes.
      const topSignal = extraction.signals.reduce<typeof extraction.signals[number] | null>(
        (best, s) => (best == null || (s.confidence ?? 0) > (best.confidence ?? 0)) ? s : best,
        null,
      );
      await recordClassificationDrop(
        message,
        "classifier_miss",
        topSignal
          ? `Not quote-shaped. Top signal: ${topSignal.intentType}@${(topSignal.confidence ?? 0).toFixed(2)} (actor=${extraction.actorType ?? "unknown"}).`
          : `Classifier returned 0 signals and body did not look quote-shaped (actor=${extraction.actorType ?? "unknown"}).`,
        {
          extractedSnapshot: {
            actorType: extraction.actorType,
            signals: extraction.signals,
          },
          confidence: topSignal?.confidence ?? null,
        },
      );
    }
  }

  // Mark processed only after the quote-side path has had its chance.
  // If we mark too early, a quote-ingest failure leaves the row hidden
  // from the recovery cron with no quote written — the worst of both
  // worlds. By marking last we keep recovery semantics intact: if any
  // step before this throws, the row stays unprocessed.
  try {
    await storage.markEmailMessageProcessed(message.id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    recordIntegrationEvent({
      source: "graph",
      outcome: "error",
      errorMessage: `inline_mark_processed:${message.id}: ${errMsg.slice(0, 200)}`,
    });
  }
}

/**
 * Public entry point. Fire-and-forget; never throws, never blocks. Loads
 * the freshly-persisted EmailMessage by id (so callers don't have to pass
 * the full row), then runs `classifyOne` under the semaphore + wall clock.
 *
 * Caller contract: invoke ONLY when (a) the upsert returned `created: true`,
 * (b) `direction === "inbound"`, and (c) the path is one of the live-ingest
 * paths (Graph webhook, polling delta sync). The historical 30-day backfill
 * and the admin manual-drain MUST NOT call this — see the module docstring.
 */
export function dispatchInlineClassification(input: { messageId: string }): void {
  _totalDispatched++;
  void (async () => {
    try {
      const slot = acquireSlot();
      await slot;
      try {
        // Load by primary key. We use a direct db read instead of going
        // through the storage interface because there is no `getEmailMessage(id)`
        // method (existing helpers are scoped by orgId+providerMessageId for
        // the webhook dedup path); a dedicated by-id read here keeps the
        // dispatcher self-contained without bloating IStorage.
        const [message] = await db.select().from(emailMessages)
          .where(eq(emailMessages.id, input.messageId))
          .limit(1)
          .catch(() => [] as EmailMessage[]);
        if (!message) {
          // Either the row was deleted (rare) or storage is briefly down.
          // Nothing else to do — recovery cron will retry if/when the row
          // re-appears. Recorded as an error event so admin sees it.
          recordIntegrationEvent({
            source: "graph",
            outcome: "error",
            errorMessage: `inline_classify:${input.messageId}: message not found`,
          });
          _totalFailed++;
          return;
        }
        await runWithWallClock(
          (signal) => classifyOne(message, signal),
          INLINE_CLASSIFY_TIMEOUT_MS,
          input.messageId,
        );
        _totalCompleted++;
      } catch (err) {
        if (err instanceof InlineClassifyTimeoutError) {
          _totalTimedOut++;
          recordIntegrationEvent({
            source: "graph",
            outcome: "error",
            errorMessage: `inline_classify_timeout:${input.messageId}: exceeded ${INLINE_CLASSIFY_TIMEOUT_MS}ms`,
          });
          console.warn(
            `[inlineEmailClassifier] message ${input.messageId} timed out after ${INLINE_CLASSIFY_TIMEOUT_MS}ms — leaving unprocessed for recovery cron`,
          );
        } else {
          _totalFailed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          recordIntegrationEvent({
            source: "graph",
            outcome: "error",
            errorMessage: `inline_classify:${input.messageId}: ${errMsg.slice(0, 200)}`,
          });
          console.error(
            `[inlineEmailClassifier] failed for message ${input.messageId}:`,
            err,
          );
        }
      } finally {
        releaseSlot();
      }
    } catch (outer) {
      // Defensive belt-and-suspenders: nothing inside the IIFE should
      // throw outside the inner try/catch, but if the semaphore itself
      // somehow rejects we still must not bubble.
      console.error(
        `[inlineEmailClassifier] dispatcher crashed for ${input.messageId}:`,
        outer,
      );
    }
  })();
}

/**
 * Task #952 — Synchronous classification replay for the admin reprocess
 * path. Unlike `dispatchInlineClassification` (fire-and-forget), this:
 *   - awaits classifyOne to completion so the operator sees a real result,
 *   - bypasses the semaphore + wall-clock timeout (the operator is making
 *     a deliberate per-message call from the admin UI; a long classify
 *     here is acceptable, vs. the live path where it would back-pressure
 *     the webhook fan-out),
 *   - rethrows on failure so the route can render the error to the admin.
 *
 * This is the only correct primitive for replaying a `classifier_miss`
 * drop: the live path goes classifier → ingest, so a replay that skips
 * straight to ingest would never re-run the classification logic the
 * drop was created to flag.
 */
export async function replayClassificationForReprocess(
  message: EmailMessage,
): Promise<void> {
  const controller = new AbortController();
  await classifyOne(message, controller.signal);
}

// ── Test / observability helpers ────────────────────────────────────────────

export function _getInlineClassifierStatsForTests(): {
  inFlight: number;
  queued: number;
  totalDispatched: number;
  totalCompleted: number;
  totalFailed: number;
  totalTimedOut: number;
  totalQuoteIngestedInline: number;
  maxInFlight: number;
  timeoutMs: number;
} {
  return {
    inFlight: _inFlight,
    queued: _waitQueue.length,
    totalDispatched: _totalDispatched,
    totalCompleted: _totalCompleted,
    totalFailed: _totalFailed,
    totalTimedOut: _totalTimedOut,
    totalQuoteIngestedInline: _totalQuoteIngestedInline,
    maxInFlight: INLINE_CLASSIFY_MAX_INFLIGHT,
    timeoutMs: INLINE_CLASSIFY_TIMEOUT_MS,
  };
}

export function _resetInlineClassifierStatsForTests(): void {
  _totalDispatched = 0;
  _totalCompleted = 0;
  _totalFailed = 0;
  _totalTimedOut = 0;
  _totalQuoteIngestedInline = 0;
}

/**
 * Returns a promise that resolves once the in-flight queue has fully
 * drained. Used by integration tests to deterministically wait out the
 * fire-and-forget dispatch instead of sleeping for a fixed duration.
 */
export function _drainInlineClassifierForTests(): Promise<void> {
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (_inFlight === 0 && _waitQueue.length === 0) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
