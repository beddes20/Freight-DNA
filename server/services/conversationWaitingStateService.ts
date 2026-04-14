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

  // Update timestamps
  if (message.direction === "inbound") {
    update.lastIncomingAt = now;
  } else {
    update.lastOutgoingAt = now;
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

  await storageInstance.updateEmailConversationThread(threadRecordId, orgId, update);
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
