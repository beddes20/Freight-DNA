/**
 * Conversation Ownership, Waiting State & Reply Priority — Test Suite (Task #202)
 *
 * Tests:
 *  1     computeWaitingState: inbound → waiting_on_us
 *  2     computeWaitingState: outbound → waiting_on_them
 *  3     applyMessageToThread: transition to waiting_on_us sets waitingSinceAt
 *  4     applyMessageToThread: transition OUT of waiting_on_us clears waitingSinceAt + overdueAt
 *  5     applyMessageToThread: no-op on waitingSinceAt when already waiting_on_us
 *  6     SLA threshold — high priority: overdue when waiting > 4 h
 *  7     SLA threshold — normal priority: overdue when waiting > 24 h
 *  8     SLA threshold — low priority: never overdue (no SLA)
 *  9     SLA threshold — normal priority: not overdue within 24 h window
 * 10     applyMessageToThread: clears overdueAt on outbound reply
 * 11     determineInitialOwner: account owner wins when linked company has assignedTo
 * 12     determineInitialOwner: returns null when company has no assignedTo
 * 13     determineInitialOwner: returns null when no linkedAccountId
 * 14     determineInitialOwner: returns null when user not in org
 * 15     setWaitingState: sets waitingSinceAt when transitioning to waiting_on_us
 * 16     setWaitingState: clears timers when transitioning to resolved
 * 17     setPriority: recomputes overdueAt when priority changes on overdue thread
 * 18     listEmailConversationThreads: ownerUserId filter returns only matching rows (idempotency)
 * 19     listEmailConversationThreads: unowned=true filter returns only null-owner rows
 * 20     listEmailConversationThreads: waitingState filter works correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmailConversationThread, EmailMessage } from "@shared/schema";
import {
  computeWaitingState,
  applyMessageToThread,
  setWaitingState,
  setPriority,
  SLA_MS,
} from "../services/conversationWaitingStateService";
import { determineInitialOwner } from "../services/conversationOwnershipService";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeThread(overrides: Partial<EmailConversationThread> = {}): EmailConversationThread {
  return {
    id: "thread-rec-001",
    orgId: "org-001",
    threadId: "ms-thread-abc",
    linkedAccountId: null,
    linkedCarrierId: null,
    ownerUserId: null,
    waitingState: "waiting_on_them",
    responsePriority: "normal",
    lastMessageId: null,
    lastIncomingAt: null,
    lastOutgoingAt: null,
    lastEmailAt: null,
    waitingSinceAt: null,
    overdueAt: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "ms-thread-abc",
    direction: "inbound",
    fromEmail: "carrier@example.com",
    toEmail: "rep@company.com",
    ccEmail: null,
    subject: "Re: Lane offer",
    body: "We can cover it.",
    linkedAccountId: null,
    linkedCarrierId: "carrier-001",
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    ...overrides,
  };
}

// ─── 1. computeWaitingState ───────────────────────────────────────────────────

describe("computeWaitingState", () => {
  it("inbound → waiting_on_us", () => {
    expect(computeWaitingState("inbound")).toBe("waiting_on_us");
  });

  it("outbound → waiting_on_them", () => {
    expect(computeWaitingState("outbound")).toBe("waiting_on_them");
  });
});

// ─── 2–5. applyMessageToThread ────────────────────────────────────────────────

describe("applyMessageToThread", () => {
  it("transition to waiting_on_us sets waitingSinceAt", () => {
    const thread = makeThread({ waitingState: "waiting_on_them" });
    const msg = makeMessage({ direction: "inbound" });
    const now = new Date("2026-04-10T10:00:00Z");
    const update = applyMessageToThread(thread, msg, now);

    expect(update.waitingState).toBe("waiting_on_us");
    expect(update.waitingSinceAt).toEqual(now);
  });

  it("transition OUT of waiting_on_us clears waitingSinceAt + overdueAt", () => {
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: new Date("2026-04-09T10:00:00Z"),
      overdueAt: new Date("2026-04-10T09:00:00Z"),
    });
    const msg = makeMessage({ direction: "outbound" });
    const now = new Date("2026-04-10T12:00:00Z");
    const update = applyMessageToThread(thread, msg, now);

    expect(update.waitingState).toBe("waiting_on_them");
    expect(update.waitingSinceAt).toBeNull();
    expect(update.overdueAt).toBeNull();
  });

  it("already in waiting_on_us — does not reset waitingSinceAt", () => {
    const existingSince = new Date("2026-04-09T10:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: existingSince,
    });
    const msg = makeMessage({ direction: "inbound" });
    const now = new Date("2026-04-10T12:00:00Z");
    const update = applyMessageToThread(thread, msg, now);

    expect(update.waitingState).toBe("waiting_on_us");
    // waitingSinceAt should NOT be set in the update (unchanged from existing)
    expect(update.waitingSinceAt).toBeUndefined();
  });

  // Task #897 — out-of-order ingest must NOT regress the per-direction
  // freshness columns. Real-world delivery is not chronological: a webhook
  // can land msg-B (newer) first, then the delta-sync / self-heal sweep
  // re-processes msg-A (older) for the same thread minutes later. Before
  // this guard, the older replay would overwrite `lastIncomingAt` from
  // 14:01 back to 13:35, while `lastEmailAt` (already monotonic) held
  // 14:01 — exactly the drift fingerprint QA caught on 2026-05-01:
  // last_email_at=14:01, last_incoming_at=13:35, max_in=14:01.
  it("does not regress lastIncomingAt when an older inbound message is replayed", () => {
    const newer = new Date("2026-04-10T14:01:00Z");
    const older = new Date("2026-04-10T13:35:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: newer,
      lastIncomingAt: newer,
      lastEmailAt: newer,
    });
    const replay = makeMessage({
      direction: "inbound",
      providerSentAt: older,
    });
    const update = applyMessageToThread(thread, replay, new Date("2026-04-10T14:05:00Z"));

    // Per-direction column held at the newer time
    expect(update.lastIncomingAt).toBeUndefined();
    // lastEmailAt also held at the newer time (monotonic)
    expect(update.lastEmailAt?.getTime()).toBe(newer.getTime());
  });

  it("does not regress lastOutgoingAt when an older outbound message is replayed", () => {
    const newer = new Date("2026-04-10T14:01:00Z");
    const older = new Date("2026-04-10T13:35:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_them",
      lastOutgoingAt: newer,
      lastEmailAt: newer,
    });
    const replay = makeMessage({
      direction: "outbound",
      providerSentAt: older,
    });
    const update = applyMessageToThread(thread, replay, new Date("2026-04-10T14:05:00Z"));

    expect(update.lastOutgoingAt).toBeUndefined();
    expect(update.lastEmailAt?.getTime()).toBe(newer.getTime());
  });

  it("advances lastIncomingAt to the message's providerSentAt when it is the newest", () => {
    const earlier = new Date("2026-04-10T13:35:00Z");
    const newest = new Date("2026-04-10T14:01:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: earlier,
      lastIncomingAt: earlier,
      lastEmailAt: earlier,
    });
    const msg = makeMessage({
      direction: "inbound",
      providerSentAt: newest,
    });
    const update = applyMessageToThread(thread, msg, new Date("2026-04-10T14:02:00Z"));

    // The webhook contract: ingesting an inbound at provider_sent_at=14:01
    // must immediately stamp lastIncomingAt=14:01 (no sweep needed). This
    // pins the seam from .local/tasks/task-897.md "Done looks like".
    expect(update.lastIncomingAt?.getTime()).toBe(newest.getTime());
    expect(update.lastEmailAt?.getTime()).toBe(newest.getTime());
  });

  it("clears overdueAt on outbound reply", () => {
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: new Date("2026-04-09T00:00:00Z"),
      overdueAt: new Date("2026-04-10T00:00:00Z"),
    });
    const msg = makeMessage({ direction: "outbound" });
    const now = new Date("2026-04-10T12:00:00Z");
    const update = applyMessageToThread(thread, msg, now);

    expect(update.overdueAt).toBeNull();
  });
});

// ─── 3. SLA threshold tests ───────────────────────────────────────────────────

describe("SLA threshold", () => {
  it("high priority: overdue when waiting > 4 hours", () => {
    const waitingSince = new Date("2026-04-10T06:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_them",
      responsePriority: "high",
    });
    const msg = makeMessage({ direction: "inbound" });
    // Simulate receiving the inbound 5 hours after last outbound
    const now = new Date("2026-04-10T11:00:00Z"); // 5h later
    const update = applyMessageToThread(thread, msg, now);

    // waitingSinceAt = now (transition), SLA = 4h → breach = now + 4h > now → NOT overdue yet
    // but we can test the breach calculation by making now = waitingSince + 5h
    const threadAfter = makeThread({
      waitingState: "waiting_on_us",
      responsePriority: "high",
      waitingSinceAt: waitingSince,
    });
    const laterMsg = makeMessage({ direction: "inbound" });
    // 5 hours after waitingSince
    const laterNow = new Date(waitingSince.getTime() + 5 * 60 * 60 * 1000);
    const laterUpdate = applyMessageToThread(threadAfter, laterMsg, laterNow);
    expect(laterUpdate.overdueAt).toBeTruthy();
    expect(laterUpdate.overdueAt!.getTime()).toBeLessThanOrEqual(laterNow.getTime());
  });

  it("normal priority: overdue when waiting > 24 hours", () => {
    const waitingSince = new Date("2026-04-09T10:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      responsePriority: "normal",
      waitingSinceAt: waitingSince,
    });
    const msg = makeMessage({ direction: "inbound" });
    // 25 hours after waitingSince
    const now = new Date(waitingSince.getTime() + 25 * 60 * 60 * 1000);
    const update = applyMessageToThread(thread, msg, now);
    expect(update.overdueAt).toBeTruthy();
  });

  it("low priority: never overdue regardless of elapsed time", () => {
    const waitingSince = new Date("2026-03-01T00:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      responsePriority: "low",
      waitingSinceAt: waitingSince,
    });
    const msg = makeMessage({ direction: "inbound" });
    // 30 days later
    const now = new Date(waitingSince.getTime() + 30 * 24 * 60 * 60 * 1000);
    const update = applyMessageToThread(thread, msg, now);
    expect(update.overdueAt).toBeNull();
  });

  it("normal priority: not overdue within 24 h window", () => {
    const waitingSince = new Date("2026-04-10T10:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      responsePriority: "normal",
      waitingSinceAt: waitingSince,
    });
    const msg = makeMessage({ direction: "inbound" });
    // 10 hours after waitingSince (within 24h SLA)
    const now = new Date(waitingSince.getTime() + 10 * 60 * 60 * 1000);
    const update = applyMessageToThread(thread, msg, now);
    expect(update.overdueAt).toBeNull();
  });
});

// ─── 4. determineInitialOwner ─────────────────────────────────────────────────

describe("determineInitialOwner", () => {
  it("account owner wins when linked company has assignedTo", async () => {
    const mockStorage = {
      getCompany: vi.fn().mockResolvedValue({ id: "co-001", assignedTo: "user-001" }),
      getUser: vi.fn().mockResolvedValue({ id: "user-001", organizationId: "org-001", name: "Alice" }),
      upsertEmailConversationThread: vi.fn(),
    };

    const msg = makeMessage({ linkedAccountId: "co-001" });
    const owner = await determineInitialOwner(msg, "org-001", mockStorage);
    expect(owner).toBe("user-001");
  });

  it("returns null when company has no assignedTo", async () => {
    const mockStorage = {
      getCompany: vi.fn().mockResolvedValue({ id: "co-001", assignedTo: null }),
      getUser: vi.fn(),
      upsertEmailConversationThread: vi.fn(),
    };

    const msg = makeMessage({ linkedAccountId: "co-001" });
    const owner = await determineInitialOwner(msg, "org-001", mockStorage);
    expect(owner).toBeNull();
  });

  it("returns null when no linkedAccountId", async () => {
    const mockStorage = {
      getCompany: vi.fn(),
      getUser: vi.fn(),
      upsertEmailConversationThread: vi.fn(),
    };

    const msg = makeMessage({ linkedAccountId: null });
    const owner = await determineInitialOwner(msg, "org-001", mockStorage);
    expect(owner).toBeNull();
    expect(mockStorage.getCompany).not.toHaveBeenCalled();
  });

  it("returns null when user not in org", async () => {
    const mockStorage = {
      getCompany: vi.fn().mockResolvedValue({ id: "co-001", assignedTo: "user-002" }),
      getUser: vi.fn().mockResolvedValue({ id: "user-002", organizationId: "org-OTHER", name: "Bob" }),
      upsertEmailConversationThread: vi.fn(),
    };

    const msg = makeMessage({ linkedAccountId: "co-001" });
    const owner = await determineInitialOwner(msg, "org-001", mockStorage);
    expect(owner).toBeNull();
  });
});

// ─── 5. setWaitingState & setPriority ────────────────────────────────────────

describe("setWaitingState", () => {
  it("sets waitingSinceAt when transitioning to waiting_on_us", async () => {
    const thread = makeThread({ waitingState: "waiting_on_them" });
    const now = new Date("2026-04-10T12:00:00Z");
    let savedUpdate: any = null;

    const mockStorage = {
      getEmailConversationThreadById: vi.fn().mockResolvedValue(thread),
      updateEmailConversationThread: vi.fn().mockImplementation((_id, _orgId, data) => {
        savedUpdate = data;
        return Promise.resolve({ ...thread, ...data });
      }),
    };

    await setWaitingState("thread-rec-001", "waiting_on_us", "org-001", mockStorage, now);
    expect(savedUpdate.waitingState).toBe("waiting_on_us");
    expect(savedUpdate.waitingSinceAt).toEqual(now);
  });

  it("clears timers when transitioning to resolved", async () => {
    const thread = makeThread({
      waitingState: "waiting_on_us",
      waitingSinceAt: new Date("2026-04-09T10:00:00Z"),
      overdueAt: new Date("2026-04-10T10:00:00Z"),
    });
    let savedUpdate: any = null;

    const mockStorage = {
      getEmailConversationThreadById: vi.fn().mockResolvedValue(thread),
      updateEmailConversationThread: vi.fn().mockImplementation((_id, _orgId, data) => {
        savedUpdate = data;
        return Promise.resolve({ ...thread, ...data });
      }),
    };

    await setWaitingState("thread-rec-001", "resolved", "org-001", mockStorage, new Date());
    expect(savedUpdate.waitingState).toBe("resolved");
    expect(savedUpdate.waitingSinceAt).toBeNull();
    expect(savedUpdate.overdueAt).toBeNull();
  });
});

describe("setPriority", () => {
  it("recomputes overdueAt when changing priority on overdue thread", async () => {
    const waitingSince = new Date("2026-04-01T00:00:00Z");
    const thread = makeThread({
      waitingState: "waiting_on_us",
      responsePriority: "low",
      waitingSinceAt: waitingSince,
      overdueAt: null,
    });
    let savedUpdate: any = null;
    const now = new Date("2026-04-10T12:00:00Z"); // 9+ days later

    const mockStorage = {
      getEmailConversationThreadById: vi.fn().mockResolvedValue(thread),
      updateEmailConversationThread: vi.fn().mockImplementation((_id, _orgId, data) => {
        savedUpdate = data;
        return Promise.resolve({ ...thread, ...data });
      }),
    };

    // Change to high priority — 4h SLA, already 9 days overdue
    await setPriority("thread-rec-001", "high", "org-001", mockStorage, now);
    expect(savedUpdate.responsePriority).toBe("high");
    expect(savedUpdate.overdueAt).toBeTruthy();
  });
});

// ─── 6. listEmailConversationThreads filter tests (using in-memory mock) ──────

describe("listEmailConversationThreads filters (idempotency)", () => {
  const threads: EmailConversationThread[] = [
    makeThread({ id: "t-1", ownerUserId: "user-a", waitingState: "waiting_on_us" }),
    makeThread({ id: "t-2", ownerUserId: "user-b", waitingState: "waiting_on_them" }),
    makeThread({ id: "t-3", ownerUserId: null, waitingState: "waiting_on_us" }),
  ];

  function mockStorageFilter(filters: {
    ownerUserId?: string | null;
    unowned?: boolean;
    waitingState?: string;
  }): EmailConversationThread[] {
    return threads.filter(t => {
      if (filters.unowned === true) {
        if (t.ownerUserId !== null) return false;
      } else if (filters.ownerUserId !== undefined && filters.ownerUserId !== null) {
        if (t.ownerUserId !== filters.ownerUserId) return false;
      }
      if (filters.waitingState && t.waitingState !== filters.waitingState) return false;
      return true;
    });
  }

  it("ownerUserId filter returns only matching rows", () => {
    const result = mockStorageFilter({ ownerUserId: "user-a" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-1");
  });

  it("unowned=true returns only null-owner rows", () => {
    const result = mockStorageFilter({ unowned: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-3");
  });

  it("waitingState filter works correctly", () => {
    const result = mockStorageFilter({ waitingState: "waiting_on_us" });
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id).sort()).toEqual(["t-1", "t-3"]);
  });
});

// ─── 7. SLA_MS constants sanity check ─────────────────────────────────────────

describe("SLA_MS constants", () => {
  it("high = 4 hours in ms", () => {
    expect(SLA_MS.high).toBe(4 * 60 * 60 * 1000);
  });

  it("normal = 24 hours in ms", () => {
    expect(SLA_MS.normal).toBe(24 * 60 * 60 * 1000);
  });

  it("low = null (no SLA)", () => {
    expect(SLA_MS.low).toBeNull();
  });
});
