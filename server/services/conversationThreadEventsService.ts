/**
 * Conversation Thread Events Service (Task #534)
 *
 * Append-only audit log for everything that happens on a single conversation
 * thread: ownership changes, waiting-state transitions, AI drafts, human
 * sends, AI corrections (Teach AI), and capture-audit recoveries. Surfaced
 * in the right-hand detail pane on the Conversations page so reps and
 * managers can see who did what to a thread and when.
 *
 * Writes are best-effort — every call site wraps a try/catch so a logging
 * failure can never block the underlying user action.
 */

import { db } from "../storage";
import {
  conversationThreadEvents,
  type ConversationThreadEvent,
} from "@shared/schema";
import { and, eq, desc } from "drizzle-orm";

export type ThreadEventType =
  | "assigned"
  | "reassigned"
  | "unassigned"
  | "resolved"
  | "reopened"
  | "archived"
  | "unarchived"
  | "priority_changed"
  | "ai_drafted"
  | "ai_corrected"
  | "human_sent"
  | "capture_audit_recovery"
  // Task #968 — emitted when an inbound message changes the bucket the
  // thread belongs to (e.g. a follow-up email turns a generic update into
  // a quote request). Surfaced in the detail-pane breadcrumb + as a
  // toast on the Conversations page so the rep notices the move.
  | "reclassified";

export interface RecordThreadEventInput {
  orgId: string;
  threadId: string; // Outlook conversationId
  eventType: ThreadEventType;
  description: string;
  actorUserId?: string | null;
  actorName?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Insert an event row. Failures are logged but never thrown — audit logging
 * is non-essential to the user's action and must never break an assignment,
 * state change, or send.
 */
export async function recordThreadEvent(input: RecordThreadEventInput): Promise<ConversationThreadEvent | null> {
  try {
    const [row] = await db.insert(conversationThreadEvents).values({
      orgId: input.orgId,
      threadId: input.threadId,
      eventType: input.eventType,
      description: input.description,
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
      details: input.details ?? {},
    }).returning();
    return row;
  } catch (err) {
    console.error("[thread-events] failed to record event:", input.eventType, err);
    return null;
  }
}

export async function listThreadEvents(
  orgId: string,
  threadId: string,
  limit = 100,
): Promise<ConversationThreadEvent[]> {
  return db.select()
    .from(conversationThreadEvents)
    .where(and(
      eq(conversationThreadEvents.orgId, orgId),
      eq(conversationThreadEvents.threadId, threadId),
    ))
    .orderBy(desc(conversationThreadEvents.createdAt))
    .limit(limit);
}
