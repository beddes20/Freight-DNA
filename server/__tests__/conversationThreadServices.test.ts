/**
 * Smarter Conversations Pane — Service Test Suite (Task #553)
 *
 * Guards the three services that back the right-hand detail pane added in
 * Task #534:
 *   - getOrGenerateThreadSummary    (cache hit, cache miss, regenerate, hash)
 *   - pickActionFromRules           (each suggestion branch)
 *   - getOrComputeThreadSuggestion  (AI mark_resolved override)
 *   - recordThreadEvent             (never throws, even on DB failure)
 *
 * The services touch Drizzle directly and call OpenAI; we mock both so the
 * suite runs hermetically. The db mock dispatches by schema-table reference
 * equality (we import the real schema inside the async vi.mock factory) so
 * each call site lands on the queue/value the test set up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted shared state used by the storage + openai mocks ─────────────────

const mockState = vi.hoisted(() => ({
  // Rows the next select() call against each table will resolve with.
  messageRows: [] as any[],
  threadRow: null as any,
  signalsRows: [] as any[],
  cachedSummary: null as any,
  cachedSuggestion: null as any,

  // Captured upserts so tests can assert what got written.
  summaryUpserts: [] as any[],
  suggestionUpserts: [] as any[],
  eventInserts: [] as any[],

  // Make the events insert reject so we can prove recordThreadEvent
  // swallows the error.
  insertEventThrows: false,

  // OpenAI behaviour for the suggestion / summary refinement.
  openaiResponse: "" as string,
  openaiThrows: false as boolean,
  openaiCalls: [] as any[],
}));

// ─── Mock storage.db with table-aware Drizzle chain stubs ────────────────────

vi.mock("../storage", async () => {
  const schema: any = await import("@shared/schema");

  // A thenable that also exposes .orderBy / .limit so the same chain
  // satisfies all three read patterns the services use.
  const makeChain = (data: any[]) => {
    const p: any = Promise.resolve(data);
    p.orderBy = () => Promise.resolve(data);
    p.limit = () => Promise.resolve(data);
    return p;
  };

  return {
    db: {
      select: (_cols?: any) => ({
        from: (table: any) => ({
          where: (_pred?: any) => {
            if (table === schema.emailMessages) {
              return makeChain(mockState.messageRows);
            }
            if (table === schema.conversationThreadSummaries) {
              return makeChain(mockState.cachedSummary ? [mockState.cachedSummary] : []);
            }
            if (table === schema.emailConversationThreads) {
              return makeChain(mockState.threadRow ? [mockState.threadRow] : []);
            }
            if (table === schema.conversationThreadSuggestions) {
              return makeChain(mockState.cachedSuggestion ? [mockState.cachedSuggestion] : []);
            }
            if (table === schema.emailSignals) {
              return makeChain(mockState.signalsRows);
            }
            return makeChain([]);
          },
        }),
      }),
      insert: (table: any) => ({
        values: (vals: any) => {
          if (table === schema.conversationThreadEvents) {
            return {
              returning: () => {
                if (mockState.insertEventThrows) {
                  return Promise.reject(new Error("simulated DB unavailable"));
                }
                const row = { id: "evt-1", createdAt: new Date(), ...vals };
                mockState.eventInserts.push(row);
                return Promise.resolve([row]);
              },
            };
          }
          if (table === schema.conversationThreadSummaries) {
            mockState.summaryUpserts.push(vals);
            return { onConflictDoUpdate: () => Promise.resolve() };
          }
          if (table === schema.conversationThreadSuggestions) {
            mockState.suggestionUpserts.push(vals);
            return { onConflictDoUpdate: () => Promise.resolve() };
          }
          return { onConflictDoUpdate: () => Promise.resolve(), returning: () => Promise.resolve([]) };
        },
      }),
      update: (_t: any) => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    },
    storage: {},
  };
});

vi.mock("../agent/openai", () => ({
  AGENT_MODELS: { fast: "gpt-fast", reasoning: "gpt-reason", embedding: "embed" },
  getAgentOpenAI: () => ({
    chat: {
      completions: {
        create: async (req: any, _opts?: any) => {
          mockState.openaiCalls.push(req);
          if (mockState.openaiThrows) throw new Error("openai down");
          return { choices: [{ message: { content: mockState.openaiResponse } }] };
        },
      },
    },
  }),
}));

// Imports must come AFTER the mocks above so the services pick up the stubs.
const summaryMod = await import("../services/conversationThreadSummaryService");
const suggestionMod = await import("../services/conversationThreadSuggestionService");
const eventsMod = await import("../services/conversationThreadEventsService");

const { getOrGenerateThreadSummary, __testing: summaryTesting } = summaryMod;
const { __internal: suggestionInternal, getOrComputeThreadSuggestion } = suggestionMod;
const { recordThreadEvent } = eventsMod;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<any> = {}): any {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "thr-abc",
    direction: "inbound",
    fromEmail: "shipper@acme.test",
    toEmail: "rep@us.test",
    ccEmail: null,
    subject: "Need rate Chicago → Atlanta",
    body: "<p>What's pricing on a van load PHX→DAL next Tue?</p>",
    providerSentAt: new Date("2026-04-20T10:00:00Z"),
    createdAt: new Date("2026-04-20T10:00:00Z"),
    linkedAccountId: null,
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    ...overrides,
  };
}

function resetState() {
  mockState.messageRows = [];
  mockState.threadRow = null;
  mockState.signalsRows = [];
  mockState.cachedSummary = null;
  mockState.cachedSuggestion = null;
  mockState.summaryUpserts = [];
  mockState.suggestionUpserts = [];
  mockState.eventInserts = [];
  mockState.insertEventThrows = false;
  mockState.openaiResponse = "";
  mockState.openaiThrows = false;
  mockState.openaiCalls = [];
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. getOrGenerateThreadSummary
// ═════════════════════════════════════════════════════════════════════════════

describe("getOrGenerateThreadSummary", () => {
  beforeEach(resetState);

  it("returns null when the thread has no messages", async () => {
    mockState.messageRows = [];
    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-empty" });
    expect(r).toBeNull();
    expect(mockState.openaiCalls).toHaveLength(0);
    expect(mockState.summaryUpserts).toHaveLength(0);
  });

  it("cache HIT — returns cached row without calling OpenAI when the live hash matches", async () => {
    const messages = [makeMsg({ id: "m1" }), makeMsg({ id: "m2", direction: "outbound" })];
    mockState.messageRows = messages;
    const liveHash = summaryTesting.computeContentHash(messages);

    mockState.cachedSummary = {
      summary: "Cached summary text.",
      contentHash: liveHash,
      messageCount: 2,
      lastMessageAt: messages[1].providerSentAt,
      generatedAt: new Date("2026-04-20T11:00:00Z"),
    };

    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-abc" });
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Cached summary text.");
    expect(r!.cached).toBe(true);
    expect(r!.stale).toBe(false);
    expect(r!.contentHash).toBe(liveHash);
    expect(mockState.openaiCalls).toHaveLength(0);
    expect(mockState.summaryUpserts).toHaveLength(0);
  });

  it("cache MISS — generates a new summary, calls OpenAI, and upserts the row", async () => {
    const messages = [makeMsg({ id: "m1" })];
    mockState.messageRows = messages;
    mockState.cachedSummary = null;
    mockState.openaiResponse = "Shipper asking for a van rate. Waiting on us.";

    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-abc" });
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Shipper asking for a van rate. Waiting on us.");
    expect(r!.cached).toBe(false);
    expect(r!.stale).toBe(false);
    expect(r!.messageCount).toBe(1);
    expect(mockState.openaiCalls).toHaveLength(1);
    expect(mockState.summaryUpserts).toHaveLength(1);
    expect(mockState.summaryUpserts[0].summary).toBe("Shipper asking for a van rate. Waiting on us.");
    expect(mockState.summaryUpserts[0].orgId).toBe("org-001");
    expect(mockState.summaryUpserts[0].threadId).toBe("thr-abc");
  });

  it("cache STALE — regenerates when the cached hash no longer matches the live hash", async () => {
    const messages = [makeMsg({ id: "m1" }), makeMsg({ id: "m2-new" })];
    mockState.messageRows = messages;
    mockState.cachedSummary = {
      summary: "Old cached summary.",
      contentHash: "stale-hash-does-not-match",
      messageCount: 1,
      lastMessageAt: messages[0].providerSentAt,
      generatedAt: new Date("2026-04-19T10:00:00Z"),
    };
    mockState.openaiResponse = "Refreshed summary after the new inbound landed.";

    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-abc" });
    expect(r!.summary).toBe("Refreshed summary after the new inbound landed.");
    expect(r!.cached).toBe(false);
    expect(mockState.openaiCalls).toHaveLength(1);
    expect(mockState.summaryUpserts).toHaveLength(1);
  });

  it("force=true REGENERATE — bypasses a valid cache and writes a fresh row", async () => {
    const messages = [makeMsg({ id: "m1" })];
    mockState.messageRows = messages;
    const liveHash = summaryTesting.computeContentHash(messages);
    mockState.cachedSummary = {
      summary: "Old but technically still valid.",
      contentHash: liveHash,
      messageCount: 1,
      lastMessageAt: messages[0].providerSentAt,
      generatedAt: new Date("2026-04-20T11:00:00Z"),
    };
    mockState.openaiResponse = "Manually regenerated by the rep.";

    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-abc", force: true });
    expect(r!.summary).toBe("Manually regenerated by the rep.");
    expect(r!.cached).toBe(false);
    expect(mockState.openaiCalls).toHaveLength(1);
    expect(mockState.summaryUpserts).toHaveLength(1);
  });

  it("falls back to the stale cached row when OpenAI fails and a cache row exists", async () => {
    const messages = [makeMsg({ id: "m1" }), makeMsg({ id: "m2-new" })];
    mockState.messageRows = messages;
    mockState.cachedSummary = {
      summary: "Stale but better than nothing.",
      contentHash: "drifted",
      messageCount: 1,
      lastMessageAt: messages[0].providerSentAt,
      generatedAt: new Date("2026-04-19T10:00:00Z"),
    };
    mockState.openaiThrows = true;

    const r = await getOrGenerateThreadSummary({ orgId: "org-001", threadId: "thr-abc" });
    expect(r!.summary).toBe("Stale but better than nothing.");
    expect(r!.stale).toBe(true);
    expect(r!.cached).toBe(true);
    // No upsert because generation failed.
    expect(mockState.summaryUpserts).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. computeContentHash stability
// ═════════════════════════════════════════════════════════════════════════════

describe("contentHash stability", () => {
  it("returns the same hash for the same ordered messages (deterministic)", () => {
    const messages = [
      makeMsg({ id: "m1", providerSentAt: new Date("2026-04-20T10:00:00Z") }),
      makeMsg({ id: "m2", providerSentAt: new Date("2026-04-20T11:00:00Z") }),
      makeMsg({ id: "m3", providerSentAt: new Date("2026-04-20T12:00:00Z") }),
    ];
    const a = summaryTesting.computeContentHash(messages);
    const b = summaryTesting.computeContentHash(messages);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{40}$/); // sha1 hex
  });

  it("ignores message body changes and only hashes (id, providerSentAt)", () => {
    const base = [
      makeMsg({ id: "m1", body: "<p>Original body.</p>" }),
      makeMsg({ id: "m2", body: "<p>Second.</p>" }),
    ];
    const edited = [
      makeMsg({ id: "m1", body: "<p>SOMEONE EDITED THE BODY.</p>" }),
      makeMsg({ id: "m2", body: "<p>Different second body.</p>" }),
    ];
    expect(summaryTesting.computeContentHash(base)).toBe(summaryTesting.computeContentHash(edited));
  });

  it("changes when a new message is appended", () => {
    const before = [makeMsg({ id: "m1" })];
    const after = [makeMsg({ id: "m1" }), makeMsg({ id: "m2" })];
    expect(summaryTesting.computeContentHash(before)).not.toBe(summaryTesting.computeContentHash(after));
  });

  it("changes when a message timestamp shifts", () => {
    const earlier = [makeMsg({ id: "m1", providerSentAt: new Date("2026-04-20T10:00:00Z") })];
    const later = [makeMsg({ id: "m1", providerSentAt: new Date("2026-04-20T10:05:00Z") })];
    expect(summaryTesting.computeContentHash(earlier)).not.toBe(summaryTesting.computeContentHash(later));
  });

  it("falls back to createdAt when providerSentAt is null", () => {
    const a = [makeMsg({ id: "m1", providerSentAt: null, createdAt: new Date("2026-04-20T10:00:00Z") })];
    const b = [makeMsg({ id: "m1", providerSentAt: new Date("2026-04-20T10:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") })];
    expect(summaryTesting.computeContentHash(a)).toBe(summaryTesting.computeContentHash(b));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. pickActionFromRules — every branch
// ═════════════════════════════════════════════════════════════════════════════

describe("pickActionFromRules", () => {
  const baseThread = {
    id: "rec-1",
    orgId: "org-001",
    threadId: "thr-abc",
    waitingState: "waiting_on_us" as const,
    responsePriority: "normal" as const,
  };

  it("none — no messages on the thread yet", () => {
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [],
      intentTypes: new Set<string>(),
    });
    expect(out.actionType).toBe("none");
    expect(out.actionLabel).toMatch(/Nothing to do/i);
    expect(out.refineWithAI).toBe(false);
  });

  it("none — thread is archived", () => {
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread, waitingState: "archived" } as any,
      messages: [makeMsg()],
      intentTypes: new Set<string>(),
    });
    expect(out.actionType).toBe("none");
    expect(out.actionLabel).toBe("Archived");
    expect(out.refineWithAI).toBe(false);
  });

  it("none — thread is already resolved", () => {
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread, waitingState: "resolved" } as any,
      messages: [makeMsg()],
      intentTypes: new Set<string>(),
    });
    expect(out.actionType).toBe("none");
    expect(out.actionLabel).toBe("Resolved");
    expect(out.refineWithAI).toBe(false);
  });

  it("await_response — waiting on them, no reply needed", () => {
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread, waitingState: "waiting_on_them" } as any,
      messages: [makeMsg({ direction: "outbound" })],
      intentTypes: new Set<string>(),
    });
    expect(out.actionType).toBe("await_response");
    expect(out.actionLabel).toMatch(/waiting on them/i);
    expect(out.refineWithAI).toBe(false);
  });

  it("quote_request_reply — pricing_request signal on a waiting_on_us thread", () => {
    const lastInbound = makeMsg({ id: "msg-pricing", direction: "inbound" });
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [lastInbound],
      intentTypes: new Set<string>(["pricing_request"]),
    });
    expect(out.actionType).toBe("quote_request_reply");
    expect(out.actionLabel).toBe("Send quote");
    expect(out.actionParams).toMatchObject({
      targetMessageId: "msg-pricing",
      playType: "carrier_capacity",
    });
    expect(out.refineWithAI).toBe(true);
  });

  it("quote_request_reply — quote_request signal also triggers it", () => {
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [makeMsg({ id: "msg-q" })],
      intentTypes: new Set<string>(["quote_request"]),
    });
    expect(out.actionType).toBe("quote_request_reply");
  });

  it("draft_reply — urgent signal on a waiting_on_us thread", () => {
    const lastInbound = makeMsg({ id: "msg-urgent" });
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [lastInbound],
      intentTypes: new Set<string>(["urgent"]),
    });
    expect(out.actionType).toBe("draft_reply");
    expect(out.actionLabel).toBe("Reply now");
    expect(out.actionReason).toMatch(/urgent/i);
    expect(out.actionParams).toMatchObject({ targetMessageId: "msg-urgent" });
    expect(out.refineWithAI).toBe(true);
  });

  it("draft_reply — default fallback when waiting_on_us and no special signals", () => {
    const lastInbound = makeMsg({ id: "msg-plain" });
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [lastInbound],
      intentTypes: new Set<string>(),
    });
    expect(out.actionType).toBe("draft_reply");
    expect(out.actionLabel).toBe("Draft reply");
    expect(out.actionParams).toMatchObject({ targetMessageId: "msg-plain" });
    expect(out.refineWithAI).toBe(true);
  });

  it("targets the latest INBOUND message (not the latest outbound) when picking targetMessageId", () => {
    const inbound = makeMsg({ id: "msg-in", direction: "inbound" });
    const outbound = makeMsg({ id: "msg-out", direction: "outbound" });
    const out = suggestionInternal.pickActionFromRules({
      thread: { ...baseThread } as any,
      messages: [inbound, outbound], // latest is outbound, but suggestion targets inbound
      intentTypes: new Set<string>(),
    });
    // Note: with a trailing outbound the thread should really be waiting_on_them
    // upstream, but pickActionFromRules trusts thread.waitingState — proving
    // the targetMessageId selection logic works in isolation.
    expect(out.actionParams).toMatchObject({ targetMessageId: "msg-in" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. getOrComputeThreadSuggestion — mark_resolved via AI override
// ═════════════════════════════════════════════════════════════════════════════
//
// NOTE on the `mark_resolved` branch: the deterministic `pickActionFromRules`
// selector intentionally never picks `mark_resolved` on its own — closing a
// thread is a destructive-ish action we only take when the AI refinement
// confirms the latest message says "we're done". That branch therefore lives
// in `getOrComputeThreadSuggestion` (the AI override path), and is exercised
// here rather than in the `pickActionFromRules` block above.

describe("getOrComputeThreadSuggestion AI override", () => {
  beforeEach(resetState);

  it("returns null when the thread has no messages", async () => {
    mockState.messageRows = [];
    const r = await getOrComputeThreadSuggestion({ orgId: "org-001", threadId: "thr-empty" });
    expect(r).toBeNull();
  });

  it("cache HIT — returns the cached suggestion without recomputing", async () => {
    const messages = [makeMsg({ id: "m1" })];
    mockState.messageRows = messages;
    const liveHash = summaryTesting.computeContentHash(messages);
    mockState.cachedSuggestion = {
      id: "sug-1",
      orgId: "org-001",
      threadId: "thr-abc",
      actionType: "draft_reply",
      actionLabel: "Draft reply",
      actionReason: "Reply needed.",
      actionParams: { targetMessageId: "m1" },
      contentHash: liveHash,
      generatedAt: new Date("2026-04-20T11:00:00Z"),
      dismissedAt: null,
      dismissedByUserId: null,
      feedbackKind: null,
      feedbackNotes: null,
      feedbackAt: null,
      feedbackByUserId: null,
    };

    const r = await getOrComputeThreadSuggestion({ orgId: "org-001", threadId: "thr-abc" });
    expect(r!.cached).toBe(true);
    expect(r!.actionType).toBe("draft_reply");
    expect(mockState.openaiCalls).toHaveLength(0);
    expect(mockState.suggestionUpserts).toHaveLength(0);
  });

  it("AI override promotes the suggestion to mark_resolved when the rep has confirmed they're done", async () => {
    const messages = [makeMsg({ id: "m1", body: "Thanks, that's all I needed!" })];
    mockState.messageRows = messages;
    mockState.threadRow = {
      id: "rec-1",
      orgId: "org-001",
      threadId: "thr-abc",
      waitingState: "waiting_on_us",
      responsePriority: "normal",
    };
    mockState.signalsRows = [];
    mockState.cachedSuggestion = null;
    mockState.openaiResponse = JSON.stringify({
      reason: "They've confirmed everything's covered — no follow-up needed.",
      recommendation: "mark_resolved",
    });

    const r = await getOrComputeThreadSuggestion({ orgId: "org-001", threadId: "thr-abc" });
    expect(r).not.toBeNull();
    expect(r!.actionType).toBe("mark_resolved");
    expect(r!.actionLabel).toMatch(/Close out/i);
    expect(r!.actionReason).toMatch(/no follow-up/i);
    expect(mockState.suggestionUpserts).toHaveLength(1);
    expect(mockState.suggestionUpserts[0].actionType).toBe("mark_resolved");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. recordThreadEvent — best-effort, never throws
// ═════════════════════════════════════════════════════════════════════════════

describe("recordThreadEvent", () => {
  beforeEach(resetState);

  it("returns the inserted row on a successful write", async () => {
    const r = await recordThreadEvent({
      orgId: "org-001",
      threadId: "thr-abc",
      eventType: "assigned",
      description: "Assigned to Casey Lin",
      actorUserId: "user-1",
      actorName: "Alice",
      details: { previousOwnerUserId: null },
    });
    expect(r).not.toBeNull();
    expect(r!.eventType).toBe("assigned");
    expect(r!.description).toBe("Assigned to Casey Lin");
    expect(mockState.eventInserts).toHaveLength(1);
  });

  it("returns null and DOES NOT throw when the underlying DB insert fails", async () => {
    mockState.insertEventThrows = true;
    let caught: unknown = null;
    let result: any = "unset";
    try {
      result = await recordThreadEvent({
        orgId: "org-001",
        threadId: "thr-abc",
        eventType: "ai_drafted",
        description: "AI drafted a reply",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeNull();
    expect(result).toBeNull();
  });

  it("does not throw even when the input is otherwise valid but DB blows up — proves wrappers can rely on it", async () => {
    mockState.insertEventThrows = true;
    // Multiple back-to-back failures should also stay silent.
    const r1 = await recordThreadEvent({
      orgId: "org-001", threadId: "thr-abc", eventType: "human_sent", description: "sent",
    });
    const r2 = await recordThreadEvent({
      orgId: "org-001", threadId: "thr-abc", eventType: "resolved", description: "resolved",
    });
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});
