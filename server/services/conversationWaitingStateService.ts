/**
 * Conversation Waiting State Service (Task #202)
 *
 * Computes and manages the ball-in-court waiting state for email threads.
 *
 * States:
 *   waiting_on_us     — last message was inbound (they replied, we need to act)
 *   waiting_on_them   — last message was outbound (we replied, ball is in their court)
 *   resolved          — thread has been manually resolved
 *
 * SLA thresholds (hardcoded v1):
 *   high priority   = 4 hours
 *   normal priority = 24 hours
 *   low priority    = no SLA
 */

import type { IStorage } from "../storage";
import type { EmailConversationThread, EmailMessage } from "@shared/schema";
import { publish as publishLiveSync } from "./liveSync";

// Task #968 — fire a conversation_thread bucket-change event when a
// thread's waitingState or owner transitions. Best-effort, no-op when
// nothing moved.
export function publishBucketChange(
  orgId: string,
  threadId: string,
  prev: { waitingState: string | null; ownerUserId: string | null },
  curr: { waitingState: string | null; ownerUserId: string | null },
  rowVersionAt?: number,
): void {
  if (
    prev.waitingState === curr.waitingState &&
    prev.ownerUserId === curr.ownerUserId
  ) {
    return;
  }
  publishLiveSync(orgId, "conversation_thread", threadId, rowVersionAt, {
    threadId,
    previousWaitingState: prev.waitingState,
    currentWaitingState: curr.waitingState,
    previousOwnerUserId: prev.ownerUserId,
    currentOwnerUserId: curr.ownerUserId,
  });
}

// ─── SLA constants ────────────────────────────────────────────────────────────

export const SLA_MS: Record<string, number | null> = {
  high:   4  * 60 * 60 * 1000,   // 4 hours
  normal: 24 * 60 * 60 * 1000,   // 24 hours
  low:    null,                   // no SLA
};

// ─── Core computation helpers ─────────────────────────────────────────────────

/**
 * Compute the waiting state from the message direction.
 * Inbound  → someone replied to us → we need to reply → waiting_on_us
 * Outbound → we sent to them → they need to reply   → waiting_on_them
 */
export function computeWaitingState(direction: string): "waiting_on_us" | "waiting_on_them" {
  return direction === "inbound" ? "waiting_on_us" : "waiting_on_them";
}

/**
 * Apply a new message to a thread record, updating:
 *  - waitingState
 *  - waitingSinceAt  (set when transitioning INTO waiting_on_us)
 *  - overdueAt       (set when SLA is breached while in waiting_on_us)
 *  - lastIncomingAt / lastOutgoingAt
 *  - lastEmailAt     (denormalized "real email activity" timestamp; Task #859)
 *
 * Returns a partial update object to merge into the thread record.
 */
export function applyMessageToThread(
  thread: EmailConversationThread,
  message: EmailMessage,
  now: Date = new Date(),
): Partial<EmailConversationThread> {
  const newState = computeWaitingState(message.direction);
  const wasArchived = thread.waitingState === "archived";
  const wasWaitingOnUs = thread.waitingState === "waiting_on_us";
  const isNowWaitingOnUs = newState === "waiting_on_us";

  const update: Partial<EmailConversationThread> = {
    lastMessageId: message.id,
    waitingState: newState,
  };

  if (wasArchived && message.direction === "inbound") {
    update.archivedAt = null;
  }

  // Update timestamps. Phase 1 — "Stop lying about freshness." Prefer
  // the email's actual provider_sent_at over wall-clock now() so the
  // denormalized last-incoming / last-outgoing columns stay anchored
  // to real email events; fall back to `now` only when provider_sent_at
  // is unavailable (rare — mostly drafts).
  //
  // Task #897 / #898 — also monotonic-guard the per-direction columns
  // (the `lastEmailAt` block below is already monotonic). Real-world
  // ingest is NOT chronological: webhook lands msg-B (sentAt=14:01),
  // then the delta-sync / self-heal sweep re-processes msg-A
  // (sentAt=13:35) minutes later. Without this guard, the older replay
  // overwrites `lastIncomingAt` from 14:01 back to 13:35 while
  // `lastEmailAt` holds 14:01 — the exact drift fingerprint QA caught
  // 2026-05-01. The row label "Customer replied …" reads the
  // per-direction column, so reps saw timestamps 5–30 min behind
  // reality. Task #898 adds a boot + 6h cron reconciliation pass that
  // backfills any drift this guard misses (e.g. concurrent inserts
  // racing on the same thread baseline).
  const sentAt = message.providerSentAt ?? now;
  const sentAtMs = sentAt.getTime();
  if (message.direction === "inbound") {
    const existingIncomingMs = thread.lastIncomingAt?.getTime() ?? 0;
    if (sentAtMs > existingIncomingMs) {
      update.lastIncomingAt = sentAt;
    }
  } else {
    const existingOutgoingMs = thread.lastOutgoingAt?.getTime() ?? 0;
    if (sentAtMs > existingOutgoingMs) {
      update.lastOutgoingAt = sentAt;
    }
  }

  // Task #859 — keep the denormalized `last_email_at` column in sync.
  // It must equal MAX(lastIncomingAt, lastOutgoingAt) AFTER this update
  // is applied so the date filter and the row-label UI both read a
  // single source of truth instead of recomputing GREATEST(...) per
  // query. We monotonically advance the column — out-of-order replays
  // with an older sentAt must not regress freshness.
  const newIncomingMs =
    (update.lastIncomingAt ?? thread.lastIncomingAt)?.getTime() ?? 0;
  const newOutgoingMs =
    (update.lastOutgoingAt ?? thread.lastOutgoingAt)?.getTime() ?? 0;
  const existingEmailMs = thread.lastEmailAt?.getTime() ?? 0;
  const maxMs = Math.max(newIncomingMs, newOutgoingMs, existingEmailMs);
  if (maxMs > 0) {
    update.lastEmailAt = new Date(maxMs);
  }

  if (isNowWaitingOnUs) {
    if (!wasWaitingOnUs) {
      // Transitioning INTO waiting_on_us — record when we started waiting
      update.waitingSinceAt = now;
    }
    // Compute overdue based on priority and waitingSinceAt
    const waitingSince = update.waitingSinceAt ?? thread.waitingSinceAt;
    const slaDurationMs = SLA_MS[thread.responsePriority];
    if (slaDurationMs != null && waitingSince) {
      const slaBreach = new Date(waitingSince.getTime() + slaDurationMs);
      update.overdueAt = slaBreach <= now ? slaBreach : null;
    } else {
      update.overdueAt = null;
    }
  } else {
    // Transitioning OUT of waiting_on_us — clear timers
    if (wasWaitingOnUs) {
      update.waitingSinceAt = null;
      update.overdueAt = null;
    }
  }

  return update;
}

/**
 * Compute overdueAt based on current thread state.
 * Used after priority changes.
 */
export function computeOverdueAt(thread: EmailConversationThread, now: Date = new Date()): Date | null {
  if (thread.waitingState !== "waiting_on_us" || !thread.waitingSinceAt) return null;
  const slaDurationMs = SLA_MS[thread.responsePriority];
  if (!slaDurationMs) return null;
  const breach = new Date(thread.waitingSinceAt.getTime() + slaDurationMs);
  return breach <= now ? breach : null;
}

// ─── Manual override helpers ──────────────────────────────────────────────────

export async function setWaitingState(
  threadRecordId: string,
  state: "waiting_on_us" | "waiting_on_them" | "resolved" | "archived",
  orgId: string,
  storageInstance: Pick<IStorage, "updateEmailConversationThread" | "getEmailConversationThreadById">,
  now: Date = new Date(),
): Promise<void> {
  const thread = await storageInstance.getEmailConversationThreadById(threadRecordId);
  if (!thread || thread.orgId !== orgId) return;
  // Snapshot the bucket-derivable fields BEFORE the write so we can
  // surface a destination-aware `conversation_thread` event for tabs
  // watching this org. (Task #968)
  const prevSnapshot = {
    waitingState: thread.waitingState ?? null,
    ownerUserId: thread.ownerUserId ?? null,
  };

  const update: Partial<EmailConversationThread> = { waitingState: state };

  if (state === "archived") {
    update.archivedAt = now;
    update.waitingSinceAt = null;
    update.overdueAt = null;
  } else if (state === "waiting_on_us") {
    update.archivedAt = null;
    if (thread.waitingState !== "waiting_on_us") {
      update.waitingSinceAt = now;
    }
    const slaDurationMs = SLA_MS[thread.responsePriority];
    const since = update.waitingSinceAt ?? thread.waitingSinceAt;
    if (slaDurationMs && since) {
      const breach = new Date(since.getTime() + slaDurationMs);
      update.overdueAt = breach <= now ? breach : null;
    }
  } else {
    update.archivedAt = null;
    update.waitingSinceAt = null;
    update.overdueAt = null;
  }

  const written = await storageInstance.updateEmailConversationThread(threadRecordId, orgId, update);
  publishBucketChange(
    orgId,
    thread.threadId,
    prevSnapshot,
    {
      waitingState: written?.waitingState ?? state,
      ownerUserId: written?.ownerUserId ?? prevSnapshot.ownerUserId,
    },
    written?.rowVersionAt instanceof Date ? written.rowVersionAt.getTime() : undefined,
  );
}

// ─── Snooze helpers (Task #533) ──────────────────────────────────────────────

/**
 * Snooze a thread until `until`. Stores the prior waitingState so the wake
 * job can restore it. Clears overdueAt and waitingSinceAt while snoozed —
 * a snoozed thread isn't waiting on anyone.
 */
export async function snoozeThread(
  threadRecordId: string,
  until: Date,
  byUserId: string,
  orgId: string,
  storageInstance: Pick<IStorage, "updateEmailConversationThread" | "getEmailConversationThreadById">,
): Promise<void> {
  const thread = await storageInstance.getEmailConversationThreadById(threadRecordId);
  if (!thread || thread.orgId !== orgId) return;

  // If the thread is already snoozed, just update the wake time — don't lose
  // the originally captured snoozedFromState.
  const fromState =
    thread.waitingState === "snoozed"
      ? thread.snoozedFromState ?? "waiting_on_us"
      : thread.waitingState;

  const prevSnapshot = {
    waitingState: thread.waitingState ?? null,
    ownerUserId: thread.ownerUserId ?? null,
  };
  const written = await storageInstance.updateEmailConversationThread(threadRecordId, orgId, {
    waitingState: "snoozed",
    snoozedUntil: until,
    snoozedFromState: fromState,
    snoozedByUserId: byUserId,
    waitingSinceAt: null,
    overdueAt: null,
  });
  publishBucketChange(
    orgId,
    thread.threadId,
    prevSnapshot,
    {
      waitingState: written?.waitingState ?? "snoozed",
      ownerUserId: written?.ownerUserId ?? prevSnapshot.ownerUserId,
    },
    written?.rowVersionAt instanceof Date ? written.rowVersionAt.getTime() : undefined,
  );
}

/**
 * Compute the field patch for waking a snoozed thread back to its prior
 * state. Returns `null` if the thread isn't currently snoozed (no-op).
 *
 * Pure helper — does not write. Both the user-initiated wake
 * (`wakeSnoozedThread`) and the scheduler-initiated wake
 * (`wakeSnoozedThreadInternal`) call this and then route the patch
 * through the appropriate write path (Task #860).
 */
async function computeWakePatch(
  threadRecordId: string,
  orgId: string,
  storageInstance: Pick<IStorage, "getEmailConversationThreadById">,
  now: Date,
): Promise<Partial<EmailConversationThread> | null> {
  const thread = await storageInstance.getEmailConversationThreadById(threadRecordId);
  if (!thread || thread.orgId !== orgId || thread.waitingState !== "snoozed") return null;

  const restoreState = (thread.snoozedFromState ?? "waiting_on_us") as
    | "waiting_on_us"
    | "waiting_on_them"
    | "resolved";

  const update: Partial<EmailConversationThread> = {
    waitingState: restoreState,
    snoozedUntil: null,
    snoozedFromState: null,
    snoozedByUserId: null,
  };

  if (restoreState === "waiting_on_us") {
    // Re-arm waiting clocks based on the most recent inbound message we know
    // about, falling back to the snooze wake time so the thread is at least
    // not "instantly overdue" the moment it wakes.
    const waitingSince = thread.lastIncomingAt ?? now;
    update.waitingSinceAt = waitingSince;
    const slaDurationMs = SLA_MS[thread.responsePriority];
    if (slaDurationMs) {
      const breach = new Date(waitingSince.getTime() + slaDurationMs);
      update.overdueAt = breach <= now ? breach : null;
    } else {
      update.overdueAt = null;
    }
  }

  return update;
}

/**
 * USER-initiated wake — the rep clicked "Wake now" / "Unsnooze". This
 * IS a real conversation event, so it routes through
 * `updateEmailConversationThread` and bumps both `updated_at` and
 * `row_version_at`. Background scheduler wakes must call
 * `wakeSnoozedThreadInternal` instead (Task #860).
 */
export async function wakeSnoozedThread(
  threadRecordId: string,
  orgId: string,
  storageInstance: Pick<IStorage, "updateEmailConversationThread" | "getEmailConversationThreadById">,
  now: Date = new Date(),
): Promise<void> {
  const update = await computeWakePatch(threadRecordId, orgId, storageInstance, now);
  if (!update) return;
  // Re-fetch for the prev-state snapshot. Cheap (single PK read) and
  // makes the bucket-change publish path symmetric with setWaitingState.
  const before = await storageInstance.getEmailConversationThreadById(threadRecordId);
  const prevSnapshot = {
    waitingState: before?.waitingState ?? "snoozed",
    ownerUserId: before?.ownerUserId ?? null,
  };
  const written = await storageInstance.updateEmailConversationThread(threadRecordId, orgId, update);
  if (before) {
    publishBucketChange(
      orgId,
      before.threadId,
      prevSnapshot,
      {
        waitingState: written?.waitingState ?? update.waitingState ?? null,
        ownerUserId: written?.ownerUserId ?? prevSnapshot.ownerUserId,
      },
      written?.rowVersionAt instanceof Date ? written.rowVersionAt.getTime() : undefined,
    );
  }
}

/**
 * SCHEDULER-initiated wake — fired by `wakeExpiredSnoozes()` in the
 * archive scheduler when `snoozedUntil` expires. NOT a user action, so
 * it routes through `touchEmailConversationThreadInternal` and bumps
 * only `row_version_at` — `updated_at` stays put so the user-visible
 * freshness signal keeps reflecting actual conversation activity (Task
 * #860). The companion guardrail in
 * `tests/code-quality-guardrails.test.ts` pins this routing.
 */
export async function wakeSnoozedThreadInternal(
  threadRecordId: string,
  orgId: string,
  storageInstance: Pick<IStorage, "touchEmailConversationThreadInternal" | "getEmailConversationThreadById">,
  now: Date = new Date(),
): Promise<void> {
  const update = await computeWakePatch(threadRecordId, orgId, storageInstance, now);
  if (!update) return;
  await storageInstance.touchEmailConversationThreadInternal(threadRecordId, orgId, update);
}

export async function setPriority(
  threadRecordId: string,
  priority: "high" | "normal" | "low",
  orgId: string,
  storageInstance: Pick<IStorage, "updateEmailConversationThread" | "getEmailConversationThreadById">,
  now: Date = new Date(),
): Promise<void> {
  const thread = await storageInstance.getEmailConversationThreadById(threadRecordId);
  if (!thread || thread.orgId !== orgId) return;

  const updated = { ...thread, responsePriority: priority };
  const overdueAt = computeOverdueAt(updated as EmailConversationThread, now);
  await storageInstance.updateEmailConversationThread(threadRecordId, orgId, { responsePriority: priority, overdueAt });
}
