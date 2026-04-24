/**
 * Smarter Conversations Pane — Route-level integration tests (Task #565).
 *
 * The companion service test suite (Task #553,
 * `conversationThreadServices.test.ts`) covers the summary / suggestion /
 * events services in isolation. This file mounts the actual Express
 * handlers from `server/routes/conversations.ts` so we can guarantee the
 * HTTP layer wires them together correctly:
 *
 *   - auth gate (401 for unauthenticated callers)
 *   - org-scoping (404 when the thread belongs to another org)
 *   - access gate (403 when the caller can't see the thread)
 *   - payload shape (response envelope, body validation on POSTs)
 *   - dispatch (the right service is called with the right org/thread,
 *     including `force: true` for the regenerate endpoint and the
 *     100-row pagination cap on the events endpoint)
 *
 * Service modules are fully mocked so this suite never touches Postgres
 * or OpenAI — the goal is to verify the route plumbing, not the service
 * internals.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";

// ── Auth state shared across mocks ───────────────────────────────────────

type FakeUser = { id: string; organizationId: string; role: string; name?: string; username?: string };
let currentUser: FakeUser | null = null;

vi.mock("../auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    if (!currentUser) {
      return _res.status(401).json({ error: "Unauthorized" });
    }
    next();
  },
  getCurrentUser: vi.fn(async () => currentUser),
  // Admin / sales_director short-circuits canAccessThread before these are
  // consulted; the non-admin tests below configure them per-case.
  canSeeRepUser: vi.fn(async () => false),
  getVisibleRepUserIds: vi.fn(async () => null),
}));

// ── Storage state ────────────────────────────────────────────────────────

type FakeThread = {
  id: string;
  orgId: string;
  threadId: string;
  ownerUserId: string | null;
  linkedAccountId: string | null;
  waitingState: string;
  responsePriority: string;
};

const threadsById = new Map<string, FakeThread>();
const threadsByThreadId = new Map<string, FakeThread>(); // key = `${orgId}::${threadId}`

vi.mock("../storage", () => ({
  storage: {
    getEmailConversationThreadById: vi.fn(async (id: string) => threadsById.get(id)),
    getEmailConversationThreadByThreadId: vi.fn(async (orgId: string, threadId: string) =>
      threadsByThreadId.get(`${orgId}::${threadId}`),
    ),
    // Only invoked from canAccessThread for unowned threads when the caller
    // is not admin/sales_director. The non-admin tests below stub a return
    // value via mockImplementationOnce as needed.
    getCompany: vi.fn(async () => undefined),
    // Defensive stubs for storage methods touched by other endpoints in the
    // same router — never called from the smart-pane endpoints we test, but
    // present so the module loads cleanly.
    listEmailConversationThreads: vi.fn(async () => ({ threads: [], totalCount: 0, nextCursor: null })),
    getCompaniesByIds: vi.fn(async () => []),
    getCarriersByIds: vi.fn(async () => []),
    getCompanies: vi.fn(async () => []),
    getTeamMemberIds: vi.fn(async () => []),
    getUser: vi.fn(async () => null),
    getEmailConversationReadStates: vi.fn(async () => new Map()),
    updateEmailConversationThread: vi.fn(async (_id: string, _orgId: string, patch: any) => patch),
  },
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

// ── Service mocks ────────────────────────────────────────────────────────

const summaryMock = vi.hoisted(() => vi.fn());
const suggestionMock = vi.hoisted(() => vi.fn());
const dismissMock = vi.hoisted(() => vi.fn());
const feedbackMock = vi.hoisted(() => vi.fn());
const listEventsMock = vi.hoisted(() => vi.fn());
const recordEventMock = vi.hoisted(() => vi.fn(async () => null));
const materializeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/conversationThreadSummaryService", () => ({
  getOrGenerateThreadSummary: summaryMock,
}));

vi.mock("../services/conversationThreadSuggestionService", () => ({
  getOrComputeThreadSuggestion: suggestionMock,
  dismissSuggestion: dismissMock,
  recordSuggestionFeedback: feedbackMock,
}));

vi.mock("../services/conversationThreadEventsService", () => ({
  recordThreadEvent: recordEventMock,
  listThreadEvents: listEventsMock,
}));

vi.mock("../services/conversationThreadBackfillService", () => ({
  backfillMissingConversationThreads: vi.fn(async () => ({})),
  materializeConversationThreadIfMissing: materializeMock,
}));

// Stubs for services imported by the router but unused by the smart-pane
// endpoints. Keep them as no-ops so the module imports cleanly.
vi.mock("../services/conversationWaitingStateService", () => ({
  setWaitingState: vi.fn(),
  setPriority: vi.fn(),
  snoozeThread: vi.fn(),
}));
vi.mock("../services/conversationOwnershipService", () => ({
  assignOwner: vi.fn(),
}));
vi.mock("../services/conversationReplyCaptureService", () => ({
  selfHealConversationThread: vi.fn(),
  selfHealStuckThreads: vi.fn(),
  getThreadCaptureAuditHistory: vi.fn(),
  listThreadStoredProviderMessageIds: vi.fn(),
  getMailboxSentItemsHealth: vi.fn(),
  getCaptureAuditHealthForUsers: vi.fn(),
}));

// ── Boot the router after mocks are in place ─────────────────────────────

const { registerConversationsRoutes } = await import("../routes/conversations");

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerConversationsRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── Fixtures + reset ────────────────────────────────────────────────────

function seedThread(t: FakeThread) {
  threadsById.set(t.id, t);
  threadsByThreadId.set(`${t.orgId}::${t.threadId}`, t);
}

beforeEach(() => {
  threadsById.clear();
  threadsByThreadId.clear();
  vi.clearAllMocks();
  currentUser = { id: "user-1", organizationId: "org-1", role: "admin", name: "Admin" };
  // Default service responses tests can override.
  summaryMock.mockReset().mockResolvedValue(null);
  suggestionMock.mockReset().mockResolvedValue(null);
  dismissMock.mockReset().mockResolvedValue(true);
  feedbackMock.mockReset().mockResolvedValue(true);
  listEventsMock.mockReset().mockResolvedValue([]);
  materializeMock.mockReset().mockResolvedValue(undefined);
});

// ════════════════════════════════════════════════════════════════════════
// 1. GET /api/internal/conversations/:id/summary
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/internal/conversations/:id/summary", () => {
  it("401s when no session is attached", async () => {
    currentUser = null;
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/summary`);
      expect(res.status).toBe(401);
      expect(summaryMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("404s when the thread id is unknown", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/missing/summary`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
      expect(summaryMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("404s when the thread belongs to another org (org-scoping)", async () => {
    seedThread({
      id: "rec-other", orgId: "org-OTHER", threadId: "thr-other",
      ownerUserId: null, linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-other/summary`);
      expect(res.status).toBe(404);
      expect(summaryMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("403s when the caller can't see the owner of the thread", async () => {
    currentUser = { id: "user-rep", organizationId: "org-1", role: "rep" };
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-other", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/summary`);
      expect(res.status).toBe(403);
      expect(summaryMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("returns the cached summary verbatim from the service", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    summaryMock.mockResolvedValueOnce({
      summary: "Shipper asked for a van rate; we owe a quote.",
      generatedAt: "2026-04-20T11:00:00.000Z",
      messageCount: 3,
      lastMessageAt: "2026-04-20T10:00:00.000Z",
      cached: true,
      stale: false,
      contentHash: "abc123",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/summary`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.summary).toBe("Shipper asked for a van rate; we owe a quote.");
      expect(body.summary.cached).toBe(true);
      expect(summaryMock).toHaveBeenCalledTimes(1);
      expect(summaryMock).toHaveBeenCalledWith({ orgId: "org-1", threadId: "thr-1" });
    } finally { await srv.close(); }
  });

  it("returns { summary: null } when the thread has no messages yet", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    summaryMock.mockResolvedValueOnce(null);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/summary`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ summary: null });
    } finally { await srv.close(); }
  });

  it("supports the `thread:<conversationId>` id form (orphan-thread fallback)", async () => {
    // The smart-pane resolver materialises the thread row first, then loads
    // it by threadId. Seed only the threadId entry to mimic that path.
    threadsByThreadId.set("org-1::thr-orphan", {
      id: "rec-orphan", orgId: "org-1", threadId: "thr-orphan",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    summaryMock.mockResolvedValueOnce({
      summary: "ok", generatedAt: "x", messageCount: 1, lastMessageAt: "y",
      cached: false, stale: false, contentHash: "h",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/${encodeURIComponent("thread:thr-orphan")}/summary`);
      expect(res.status).toBe(200);
      expect(materializeMock).toHaveBeenCalledWith("org-1", "thr-orphan");
      expect(summaryMock).toHaveBeenCalledWith({ orgId: "org-1", threadId: "thr-orphan" });
    } finally { await srv.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. POST /api/internal/conversations/:id/summary/regenerate
// ════════════════════════════════════════════════════════════════════════

describe("POST /api/internal/conversations/:id/summary/regenerate", () => {
  it("calls the summary service with force=true and returns the new row", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    summaryMock.mockResolvedValueOnce({
      summary: "Freshly regenerated.",
      generatedAt: "2026-04-21T10:00:00.000Z",
      messageCount: 4,
      lastMessageAt: "2026-04-21T09:00:00.000Z",
      cached: false,
      stale: false,
      contentHash: "new-hash",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/summary/regenerate`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.summary).toBe("Freshly regenerated.");
      expect(body.summary.cached).toBe(false);
      expect(summaryMock).toHaveBeenCalledWith({
        orgId: "org-1",
        threadId: "thr-1",
        force: true,
      });
    } finally { await srv.close(); }
  });

  it("404s for an unknown thread (does not call the service)", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/missing/summary/regenerate`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(summaryMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. GET /api/internal/conversations/:id/suggestion
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/internal/conversations/:id/suggestion", () => {
  it("returns the suggestion payload from the service", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    suggestionMock.mockResolvedValueOnce({
      actionType: "draft_reply",
      actionLabel: "Draft reply",
      actionReason: "Reply needed.",
      actionParams: { targetMessageId: "m-1" },
      contentHash: "h",
      generatedAt: "2026-04-20T11:00:00.000Z",
      cached: true,
      dismissed: false,
      feedbackKind: null,
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.suggestion.actionType).toBe("draft_reply");
      expect(body.suggestion.actionParams).toEqual({ targetMessageId: "m-1" });
      expect(suggestionMock).toHaveBeenCalledWith({ orgId: "org-1", threadId: "thr-1" });
    } finally { await srv.close(); }
  });

  it("forwards { suggestion: null } when the service has nothing to suggest", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    suggestionMock.mockResolvedValueOnce(null);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ suggestion: null });
    } finally { await srv.close(); }
  });

  it("404s when the thread does not exist", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/missing/suggestion`);
      expect(res.status).toBe(404);
      expect(suggestionMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("404s for a thread in another org", async () => {
    seedThread({
      id: "rec-x", orgId: "org-OTHER", threadId: "thr-x",
      ownerUserId: null, linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-x/suggestion`);
      expect(res.status).toBe(404);
      expect(suggestionMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. POST /api/internal/conversations/:id/suggestion/dismiss
// ════════════════════════════════════════════════════════════════════════

describe("POST /api/internal/conversations/:id/suggestion/dismiss", () => {
  it("dispatches to dismissSuggestion with the user id", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    dismissMock.mockResolvedValueOnce(true);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/dismiss`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(dismissMock).toHaveBeenCalledWith({
        orgId: "org-1",
        threadId: "thr-1",
        userId: "user-1",
      });
    } finally { await srv.close(); }
  });

  it("returns ok=false when no cached suggestion exists to dismiss", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    dismissMock.mockResolvedValueOnce(false);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/dismiss`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false });
    } finally { await srv.close(); }
  });

  it("404s for unknown thread (no service call)", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/missing/suggestion/dismiss`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(dismissMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. POST /api/internal/conversations/:id/suggestion/feedback
// ════════════════════════════════════════════════════════════════════════

describe("POST /api/internal/conversations/:id/suggestion/feedback", () => {
  beforeEach(() => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
  });

  it("forwards a 'good' rating with notes to recordSuggestionFeedback", async () => {
    feedbackMock.mockResolvedValueOnce(true);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "good", notes: "Spot on." }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(feedbackMock).toHaveBeenCalledWith({
        orgId: "org-1",
        threadId: "thr-1",
        userId: "user-1",
        kind: "good",
        notes: "Spot on.",
      });
    } finally { await srv.close(); }
  });

  it("forwards a 'wrong' rating with no notes (notes default to null)", async () => {
    feedbackMock.mockResolvedValueOnce(true);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "wrong" }),
      });
      expect(res.status).toBe(200);
      expect(feedbackMock).toHaveBeenCalledWith({
        orgId: "org-1",
        threadId: "thr-1",
        userId: "user-1",
        kind: "wrong",
        notes: null,
      });
    } finally { await srv.close(); }
  });

  it("400s on invalid kind without calling the service", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "meh" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid/i);
      expect(feedbackMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("400s when notes exceed 500 chars", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/suggestion/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "good", notes: "x".repeat(501) }),
      });
      expect(res.status).toBe(400);
      expect(feedbackMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. GET /api/internal/conversations/:id/events
// ════════════════════════════════════════════════════════════════════════

describe("GET /api/internal/conversations/:id/events", () => {
  it("returns the events array verbatim from the service", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    // Service contract: most-recent-first. The route just forwards the
    // array, so we verify the order survives the round-trip.
    const fakeEvents = [
      { id: "e2", eventType: "human_sent", description: "Pat sent a reply", createdAt: "2026-04-20T12:00:00.000Z" },
      { id: "e1", eventType: "assigned", description: "Pat took ownership", createdAt: "2026-04-20T10:00:00.000Z" },
    ];
    listEventsMock.mockResolvedValueOnce(fakeEvents);
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/events`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.events).toHaveLength(2);
      expect(body.events.map((e: any) => e.id)).toEqual(["e2", "e1"]);
    } finally { await srv.close(); }
  });

  it("calls the service with the 100-row pagination cap", async () => {
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-1", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    listEventsMock.mockResolvedValueOnce([]);
    const srv = await listen(buildApp());
    try {
      await fetch(`${srv.url}/api/internal/conversations/rec-1/events`);
      expect(listEventsMock).toHaveBeenCalledTimes(1);
      expect(listEventsMock).toHaveBeenCalledWith("org-1", "thr-1", 100);
    } finally { await srv.close(); }
  });

  it("404s when the thread is unknown (no service call)", async () => {
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/missing/events`);
      expect(res.status).toBe(404);
      expect(listEventsMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("404s when the thread belongs to another org (org-scoping)", async () => {
    seedThread({
      id: "rec-other", orgId: "org-OTHER", threadId: "thr-other",
      ownerUserId: null, linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-other/events`);
      expect(res.status).toBe(404);
      expect(listEventsMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });

  it("403s when the caller is a non-admin who can't see the owner", async () => {
    currentUser = { id: "user-rep", organizationId: "org-1", role: "rep" };
    seedThread({
      id: "rec-1", orgId: "org-1", threadId: "thr-1",
      ownerUserId: "user-other", linkedAccountId: null,
      waitingState: "waiting_on_us", responsePriority: "normal",
    });
    const srv = await listen(buildApp());
    try {
      const res = await fetch(`${srv.url}/api/internal/conversations/rec-1/events`);
      expect(res.status).toBe(403);
      expect(listEventsMock).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});
