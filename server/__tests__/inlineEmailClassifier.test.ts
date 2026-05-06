/**
 * Inline email classifier dispatcher (Task #939).
 *
 * Locks in the contract that the Graph webhook + delta-sync paths now
 * exercise per-message: extract → ingest → mark processed → emit
 * `customer_quote` live-sync, all under a process-wide concurrency limit
 * and a per-message wall clock, with errors leaving the row unprocessed
 * so the 2-min recovery cron picks it up.
 *
 * Strategy: stub `../storage` (for `db.select()` lookup +
 * `markEmailMessageProcessed` + `insertEmailSignals`),
 * `../emailIntelligenceService` (for `extractEmailSignals` /
 * `deduplicateSignals`), and `./quoteEmailIngestion` (for
 * `ingestQuoteFromEmail`). We observe the customer_quote publish via
 * the production `subscribe` API so we can't drift from the consumer
 * shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  message: {
    id: "msg-001",
    orgId: "org-test-001",
    direction: "inbound" as const,
    fromEmail: "buyer@acme.com",
    subject: "Need quote LA→NYC",
    bodyText: "Need a quote for next Monday.",
    receivedAt: new Date(),
    providerMessageId: "graph-001",
    threadId: "thread-001",
    linkedAccountId: null as string | null,
    linkedCarrierId: null as string | null,
    linkedLaneId: null as string | null,
  } as any,
  // Per-call records so the assertions can count things deterministically.
  markProcessedCalls: [] as string[],
  insertSignalsCalls: [] as any[],
  ingestCalls: [] as any[],
  recordedIntegrationEvents: [] as any[],
  // What ingestQuoteFromEmail returns; tests mutate to flip ingested ↔
  // throw between cases.
  ingestBehavior: { mode: "ingested" as "ingested" | "throw" | "skipped", quoteId: "quote-001" },
  // What extractEmailSignals returns. Default = single pricing_request.
  extractBehavior: {
    actorType: "customer" as "customer" | "carrier" | "internal",
    signals: [
      {
        intentType: "pricing_request",
        intentSubtype: null,
        confidence: 0.9,
        extractedData: { originCity: "Los Angeles", destCity: "New York" },
      },
    ] as any[],
  },
}));

vi.mock("../storage", () => {
  // Build a chainable db.select() mock that always resolves to the
  // current state.message wrapped in an array (or empty when null).
  const buildSelectChain = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (state.message ? [state.message] : []),
      }),
    }),
  });
  return {
    db: {
      select: () => buildSelectChain(),
    },
    storage: {
      markEmailMessageProcessed: async (id: string) => {
        state.markProcessedCalls.push(id);
      },
      insertEmailSignals: async (signals: any[]) => {
        state.insertSignalsCalls.push(signals);
        return signals.map((s, i) => ({ ...s, id: `sig-${i}` }));
      },
    },
  };
});

vi.mock("../integrations/probeRegistry", () => ({
  recordIntegrationEvent: (evt: any) => {
    state.recordedIntegrationEvents.push(evt);
  },
}));

vi.mock("../emailIntelligenceService", () => ({
  extractEmailSignals: async (_msg: any, _opts: any) => ({
    actorType: state.extractBehavior.actorType,
    signals: state.extractBehavior.signals,
  }),
  deduplicateSignals: async (signals: any[], _msg: any) => signals,
}));

vi.mock("../services/quoteEmailIngestion", () => ({
  ingestQuoteFromEmail: async (msg: any, opts: any) => {
    state.ingestCalls.push({ msgId: msg.id, opts });
    if (state.ingestBehavior.mode === "throw") {
      throw new Error("simulated quote ingest failure");
    }
    if (state.ingestBehavior.mode === "skipped") {
      return { status: "skipped" };
    }
    // The dispatcher runs through and then marks the message processed —
    // the inline test does NOT itself publish customer_quote (the real
    // service does that inside ingestQuoteFromEmail). We emit it here in
    // the mock so the live-sync assertion still has something to count.
    const { publish } = await import("../services/liveSync");
    publish(msg.orgId, "customer_quote", state.ingestBehavior.quoteId);
    return { status: "ingested", quoteId: state.ingestBehavior.quoteId };
  },
}));

import { subscribe, type LiveSyncEvent } from "../services/liveSync";

let receivedEvents: LiveSyncEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  state.markProcessedCalls = [];
  state.insertSignalsCalls = [];
  state.ingestCalls = [];
  state.recordedIntegrationEvents = [];
  state.ingestBehavior = { mode: "ingested", quoteId: "quote-001" };
  state.extractBehavior = {
    actorType: "customer",
    signals: [
      {
        intentType: "pricing_request",
        intentSubtype: null,
        confidence: 0.9,
        extractedData: { originCity: "Los Angeles", destCity: "New York" },
      },
    ],
  };
  // Restore state.message in case a prior test cleared it (the "missing
  // message id" case sets it to null to simulate a deleted row).
  state.message = {
    id: "msg-001",
    orgId: "org-test-001",
    direction: "inbound",
    fromEmail: "buyer@acme.com",
    subject: "Need quote LA→NYC",
    bodyText: "Need a quote for next Monday.",
    receivedAt: new Date(),
    providerMessageId: "graph-001",
    threadId: "thread-001",
    linkedAccountId: null,
    linkedCarrierId: null,
    linkedLaneId: null,
  } as any;
  receivedEvents = [];
  unsubscribe = subscribe(state.message.orgId, (evt) => {
    receivedEvents.push(evt);
  });
  const { _resetInlineClassifierStatsForTests } = await import(
    "../services/inlineEmailClassifier"
  );
  _resetInlineClassifierStatsForTests();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe("dispatchInlineClassification — Task #939 event-driven email→quote pipeline", () => {
  it("ingests a customer-quote signal, marks the message processed, and publishes customer_quote exactly once", async () => {
    const { dispatchInlineClassification, _drainInlineClassifierForTests, _getInlineClassifierStatsForTests } =
      await import("../services/inlineEmailClassifier");

    dispatchInlineClassification({ messageId: state.message.id });
    await _drainInlineClassifierForTests();

    // Pipeline ran end-to-end: signals inserted, quote ingested, processed flag set.
    expect(state.insertSignalsCalls).toHaveLength(1);
    expect(state.insertSignalsCalls[0][0].intentType).toBe("pricing_request");
    expect(state.ingestCalls.map(c => c.msgId)).toEqual([state.message.id]);
    expect(state.markProcessedCalls).toEqual([state.message.id]);

    // Live-sync surfaced the new quote so any open Quote Requests tab
    // refetches within ~50ms.
    const quoteEvents = receivedEvents.filter(e => e.topic === "customer_quote");
    expect(quoteEvents).toHaveLength(1);
    expect(quoteEvents[0].key).toBe(state.ingestBehavior.quoteId);

    // Stats sanity — completed exactly one job, no failures/timeouts.
    const stats = _getInlineClassifierStatsForTests();
    expect(stats.totalDispatched).toBe(1);
    expect(stats.totalCompleted).toBe(1);
    expect(stats.totalFailed).toBe(0);
    expect(stats.totalTimedOut).toBe(0);
    expect(stats.inFlight).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it("a quote-ingest failure leaves the row unprocessed so the recovery cron will retry", async () => {
    state.ingestBehavior = { mode: "throw", quoteId: "quote-x" };
    const { dispatchInlineClassification, _drainInlineClassifierForTests, _getInlineClassifierStatsForTests } =
      await import("../services/inlineEmailClassifier");

    dispatchInlineClassification({ messageId: state.message.id });
    await _drainInlineClassifierForTests();

    // Critical contract: NO markEmailMessageProcessed call. If we marked
    // here, the recovery cron would never pick the row up and we'd
    // silently lose a quote.
    expect(state.markProcessedCalls).toHaveLength(0);
    // Signals still inserted (best-effort) — that's expected and
    // idempotent for the recovery cron.
    expect(state.insertSignalsCalls).toHaveLength(1);
    // The error path records an integration event so admin sees the
    // failure surface (this is what the watchdog's classification-lag
    // alert correlates with).
    const errEvents = state.recordedIntegrationEvents.filter(e => e.outcome === "error");
    expect(errEvents.length).toBeGreaterThan(0);
    expect(errEvents.some(e => /inline_quote_ingest:/.test(e.errorMessage))).toBe(true);

    // No customer_quote publish on the throw path.
    expect(receivedEvents.filter(e => e.topic === "customer_quote")).toHaveLength(0);

    // Stats should NOT report this as a dispatcher-level failure: the
    // exception was handled inside classifyOne (recorded via
    // recordIntegrationEvent) and the outer wrapper still completes
    // normally — that's the whole point of "let the recovery cron
    // retry without marking the dispatcher itself broken".
    const stats = _getInlineClassifierStatsForTests();
    expect(stats.totalDispatched).toBe(1);
    expect(stats.totalCompleted).toBe(1);
    expect(stats.totalTimedOut).toBe(0);
  });

  it("a non-customer (carrier) extraction skips the quote ingest path", async () => {
    state.extractBehavior.actorType = "carrier";
    state.extractBehavior.signals = [
      { intentType: "rate_response", intentSubtype: null, confidence: 0.9, extractedData: {} },
    ];
    const { dispatchInlineClassification, _drainInlineClassifierForTests } = await import(
      "../services/inlineEmailClassifier"
    );

    dispatchInlineClassification({ messageId: state.message.id });
    await _drainInlineClassifierForTests();

    // Customer-quote pipeline NOT invoked.
    expect(state.ingestCalls).toHaveLength(0);
    expect(receivedEvents.filter(e => e.topic === "customer_quote")).toHaveLength(0);
    // But the row IS marked processed so we don't make the recovery
    // cron repeatedly re-extract a non-quote email.
    expect(state.markProcessedCalls).toEqual([state.message.id]);
  });

  it("missing message id (deleted between persist + dispatch) records an integration event and does NOT throw", async () => {
    state.message = null as any;
    const { dispatchInlineClassification, _drainInlineClassifierForTests, _getInlineClassifierStatsForTests } =
      await import("../services/inlineEmailClassifier");

    expect(() => dispatchInlineClassification({ messageId: "missing-id" })).not.toThrow();
    await _drainInlineClassifierForTests();

    // No pipeline work happened.
    expect(state.insertSignalsCalls).toHaveLength(0);
    expect(state.ingestCalls).toHaveLength(0);
    expect(state.markProcessedCalls).toHaveLength(0);
    // But we recorded the missing-row error so admin can see the
    // dispatcher's view of the world drifted from the DB.
    const missingEvents = state.recordedIntegrationEvents.filter(e =>
      /message not found/.test(e.errorMessage),
    );
    expect(missingEvents).toHaveLength(1);

    const stats = _getInlineClassifierStatsForTests();
    expect(stats.totalFailed).toBe(1);
  });

  it("dispatch returns synchronously (fire-and-forget)", async () => {
    const { dispatchInlineClassification, _drainInlineClassifierForTests } = await import(
      "../services/inlineEmailClassifier"
    );
    const ret = dispatchInlineClassification({ messageId: state.message.id });
    // The webhook handler depends on this — it must not block on OpenAI.
    expect(ret).toBeUndefined();
    await _drainInlineClassifierForTests();
  });
});
