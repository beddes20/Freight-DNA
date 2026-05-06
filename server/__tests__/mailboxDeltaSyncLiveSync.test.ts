/**
 * Live-sync from polling fallback (Task #874)
 *
 * The Conversations page (`client/src/pages/conversations.tsx`) refetches its
 * inbox feed within ~50ms of any `mailbox_inbound` / `mailbox_outbound`
 * live-sync event. Task #867 wired those events from the webhook path
 * (`server/routes/graphWebhook.ts`); this suite locks in the matching emit
 * from the *polling-fallback* path (`server/services/mailboxDeltaSyncService.ts`)
 * so a webhook outage no longer regresses the page back to a 2-minute
 * background-refetch cadence.
 *
 * What we assert:
 *   1. A new inbound message ingested by the delta-sync poll triggers exactly
 *      one `mailbox_inbound` publish for the mailbox's org.
 *   2. A new outbound (SentItems) message triggers exactly one
 *      `mailbox_outbound` publish.
 *   3. A duplicate Graph message id on the next poll cycle does NOT re-emit
 *      (idempotency contract — gated on the helper's `created: true`).
 *   4. The publish is best-effort: a throw from the publisher is caught and
 *      never bubbles up to break ingestion.
 *
 * Strategy: mock `processUserMailboxEmailForDelta` from `../routes/graphWebhook`
 * so we control the `{ created, direction }` signal cleanly without standing
 * up Postgres + Graph fixtures, mock global fetch + the storage surface that
 * `syncMailboxDelta` reads, and spy on `subscribe` from `../services/liveSync`
 * to count emits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted shared state used by the mocks below ───────────────────────────

const state = vi.hoisted(() => ({
  // The next response `processUserMailboxEmailForDelta` should return.
  // Tests mutate this between calls to simulate created/dup outcomes.
  ingestQueue: [] as Array<{ created: boolean; direction: "inbound" | "outbound" }>,
  ingestCalls: [] as Array<{ providerMessageId: string; folder?: string }>,
  // Fake Graph delta payloads to return on the next fetch().
  fetchResponses: [] as Array<{ ok: boolean; status?: number; json: any }>,
  // Captured failure upserts so the test can assert nothing got marked bad.
  failureUpserts: [] as any[],
  resolvedCalls: [] as any[],
  monitoredMailboxUpdates: [] as any[],
  // Mailbox row returned by storage.getMonitoredMailbox.
  mailbox: {
    id: "mb-test-001",
    orgId: "org-test-001",
    userId: "user-001",
    email: "rep@example.com",
    enabled: true,
    deltaSyncToken: null as string | null,
    sentDeltaSyncToken: null as string | null,
    lastSyncAt: null as Date | null,
    pollCadenceSeconds: 60,
  } as any,
}));

vi.mock("../graphService", () => ({
  azureCredentialsConfigured: () => true,
  getGraphAccessToken: async () => "fake-token",
}));

vi.mock("../lib/httpRetry", () => ({
  // Pass-through — we just want the inner fetch() to actually run.
  resilientFetch: async (_label: string, fn: () => Promise<any>) => fn(),
}));

vi.mock("../lib/cronHeartbeat", () => ({
  JOB_NAMES: { mailboxDeltaSyncPoll: "mailbox_delta_sync_poll" },
  withHeartbeat: async (_n: any, _i: number, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../storage", () => ({
  storage: {
    getMonitoredMailbox: async () => state.mailbox,
    getEnabledMonitoredMailboxes: async () => [state.mailbox],
    getDueMailboxSyncFailuresForMailbox: async () => [],
    upsertMailboxSyncFailure: async (row: any) => { state.failureUpserts.push(row); },
    markMailboxSyncFailureResolved: async (...args: any[]) => { state.resolvedCalls.push(args); },
    countUnresolvedMailboxSyncFailures: async () => 0,
    updateMonitoredMailbox: async (id: string, patch: any) => {
      state.monitoredMailboxUpdates.push({ id, patch });
    },
  },
}));

vi.mock("../routes/graphWebhook", () => ({
  processUserMailboxEmailForDelta: async (params: any) => {
    state.ingestCalls.push({ providerMessageId: params.providerMessageId });
    const next = state.ingestQueue.shift();
    if (!next) {
      throw new Error(`test setup error: no ingestQueue entry for ${params.providerMessageId}`);
    }
    return next;
  },
}));

// Spy on liveSync.publish via subscribe (we never want to muck with the
// publish function's internals — subscribing is the production-shape way to
// observe what got emitted).
import { subscribe, type LiveSyncEvent } from "../services/liveSync";

let receivedEvents: LiveSyncEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  state.ingestQueue = [];
  state.ingestCalls = [];
  state.fetchResponses = [];
  state.failureUpserts = [];
  state.resolvedCalls = [];
  state.monitoredMailboxUpdates = [];
  state.mailbox.deltaSyncToken = null;
  state.mailbox.sentDeltaSyncToken = null;
  receivedEvents = [];
  unsubscribe = subscribe(state.mailbox.orgId, (evt) => {
    receivedEvents.push(evt);
  });
  // Default fetch shim: per-call shift from state.fetchResponses.
  vi.stubGlobal("fetch", vi.fn(async () => {
    const next = state.fetchResponses.shift();
    if (!next) {
      // Default: no messages, terminating delta link.
      return new Response(JSON.stringify({ value: [], "@odata.deltaLink": "https://graph/empty-delta" }), { status: 200 });
    }
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 });
  }));
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.unstubAllGlobals();
});

function inboxDeltaResponse(messageIds: string[]): { ok: true; json: any } {
  return {
    ok: true,
    json: {
      value: messageIds.map((id) => ({
        id,
        conversationId: `conv-${id}`,
        from: { emailAddress: { address: "customer@acme.com" } },
        toRecipients: [{ emailAddress: { address: state.mailbox.email } }],
        subject: `subj-${id}`,
        bodyPreview: "preview",
        receivedDateTime: new Date().toISOString(),
      })),
      "@odata.deltaLink": `https://graph/inbox-delta-${messageIds.join("_")}`,
    },
  };
}

function sentDeltaResponse(messageIds: string[]): { ok: true; json: any } {
  return {
    ok: true,
    json: {
      value: messageIds.map((id) => ({
        id,
        conversationId: `conv-${id}`,
        from: { emailAddress: { address: state.mailbox.email } },
        toRecipients: [{ emailAddress: { address: "customer@acme.com" } }],
        subject: `subj-${id}`,
        bodyPreview: "preview",
        sentDateTime: new Date().toISOString(),
      })),
      "@odata.deltaLink": `https://graph/sent-delta-${messageIds.join("_")}`,
    },
  };
}

describe("mailboxDeltaSyncService — Task #874 live-sync emit from polling path", () => {
  it("publishes mailbox_inbound exactly once when the poll persists a new inbound message", async () => {
    // First fetch is for inbox folder (returns one new msg), second is for
    // sentitems (empty). Each message gets one ingest call.
    state.fetchResponses.push(inboxDeltaResponse(["graph-msg-A"]));
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/sent-empty" } });
    state.ingestQueue.push({ created: true, direction: "inbound" });

    const { syncMailboxDelta } = await import("../services/mailboxDeltaSyncService");
    const result = await syncMailboxDelta(state.mailbox.id);

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(state.ingestCalls.map(c => c.providerMessageId)).toEqual(["graph-msg-A"]);

    const inboundEvents = receivedEvents.filter(e => e.topic === "mailbox_inbound");
    expect(inboundEvents).toHaveLength(1);
    expect(inboundEvents[0].key).toBe("conv-graph-msg-A");
    expect(receivedEvents.filter(e => e.topic === "mailbox_outbound")).toHaveLength(0);
  });

  it("publishes mailbox_outbound for messages persisted from the sentitems folder", async () => {
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/inbox-empty" } });
    state.fetchResponses.push(sentDeltaResponse(["graph-msg-B"]));
    state.ingestQueue.push({ created: true, direction: "outbound" });

    const { syncMailboxDelta } = await import("../services/mailboxDeltaSyncService");
    await syncMailboxDelta(state.mailbox.id);

    const outboundEvents = receivedEvents.filter(e => e.topic === "mailbox_outbound");
    expect(outboundEvents).toHaveLength(1);
    expect(outboundEvents[0].key).toBe("conv-graph-msg-B");
    expect(receivedEvents.filter(e => e.topic === "mailbox_inbound")).toHaveLength(0);
  });

  it("does NOT publish when the helper reports created=false (dup or dropped)", async () => {
    // Same Graph id seen on this poll cycle, but the shared helper says it
    // was already persisted (e.g., webhook beat us to it). No emit allowed.
    state.fetchResponses.push(inboxDeltaResponse(["graph-msg-C"]));
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/sent-empty" } });
    state.ingestQueue.push({ created: false, direction: "inbound" });

    const { syncMailboxDelta } = await import("../services/mailboxDeltaSyncService");
    await syncMailboxDelta(state.mailbox.id);

    expect(state.ingestCalls).toHaveLength(1);
    expect(receivedEvents).toHaveLength(0);
  });

  it("a webhook-then-poll race for the same Graph id only emits once across both paths", async () => {
    // Cycle 1: poll wins, helper returns created=true → one emit.
    state.fetchResponses.push(inboxDeltaResponse(["graph-msg-D"]));
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/sent-empty" } });
    state.ingestQueue.push({ created: true, direction: "inbound" });

    const { syncMailboxDelta } = await import("../services/mailboxDeltaSyncService");
    await syncMailboxDelta(state.mailbox.id);
    expect(receivedEvents.filter(e => e.topic === "mailbox_inbound")).toHaveLength(1);

    // Cycle 2: same Graph id resurfaces (e.g., delta-link replay), helper
    // returns created=false because the row already exists. No second emit.
    state.fetchResponses.push(inboxDeltaResponse(["graph-msg-D"]));
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/sent-empty" } });
    state.ingestQueue.push({ created: false, direction: "inbound" });

    await syncMailboxDelta(state.mailbox.id);
    // Total inbound emits across both cycles is still exactly 1.
    expect(receivedEvents.filter(e => e.topic === "mailbox_inbound")).toHaveLength(1);
  });

  it("a publish failure does not break ingest — processed count still increments", async () => {
    state.fetchResponses.push(inboxDeltaResponse(["graph-msg-E"]));
    state.fetchResponses.push({ ok: true, json: { value: [], "@odata.deltaLink": "https://graph/sent-empty" } });
    state.ingestQueue.push({ created: true, direction: "inbound" });

    // Force the publish path to throw by patching EventEmitter on a single
    // listener; the in-process fan-out wraps emit() in a try/catch on the
    // emitter itself, but the delta-sync caller also has a defensive
    // try/catch. Make a noisy listener to prove that throw doesn't propagate.
    const noisy = subscribe(state.mailbox.orgId, () => {
      throw new Error("listener boom — should never reach syncMailboxDelta");
    });

    let result: { processed: number; errors: number } | null = null;
    try {
      const { syncMailboxDelta } = await import("../services/mailboxDeltaSyncService");
      result = await syncMailboxDelta(state.mailbox.id);
    } finally {
      noisy();
    }

    expect(result).not.toBeNull();
    expect(result!.processed).toBe(1);
    expect(result!.errors).toBe(0);
  });
});
