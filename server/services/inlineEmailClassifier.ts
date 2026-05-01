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

import { eq } from "drizzle-orm";
import { emailMessages, type EmailMessage, type InsertEmailSignal } from "@shared/schema";
import { db, storage } from "../storage";
import { recordIntegrationEvent } from "../integrations/probeRegistry";

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

  // Customer-quote pipeline — the only consumer Task #939 promotes inline.
  if (message.direction === "inbound" && extraction.actorType === "customer") {
    const quoteSignal = extraction.signals.find(
      (s) => s.intentType === "pricing_request" || s.intentType === "new_opportunity",
    );
    if (quoteSignal) {
      try {
        const result = await ingestQuoteFromEmail(message, {
          extractedData: quoteSignal.extractedData ?? null,
        });
        if (result.status === "ingested") {
          _totalQuoteIngestedInline++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordIntegrationEvent({
          source: "graph",
          outcome: "error",
          errorMessage: `inline_quote_ingest:${message.id}: ${errMsg.slice(0, 200)}`,
        });
        return;
      }
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
