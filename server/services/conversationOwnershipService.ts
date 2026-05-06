/**
 * Conversation Ownership Service (Task #202; rep-link strengthening Task #1055)
 *
 * Implements v1 ownership priority order:
 *   (a) account owner if thread is linked to an account
 *         1. companies.ownerRepId  ← canonical owner (Task #1055 / CQ contract)
 *         2. companies.assignedTo  ← legacy fallback for orgs that haven't
 *            backfilled ownerRepId yet
 *   (b) carrier owner if linked to a carrier (no direct ownerUserId on carriers — fall through)
 *   (c) internal user who sent the first outbound email in the thread
 *   (d) null
 *
 * Read-only by design: this helper NEVER writes back to companies.ownerRepId
 * or companies.assignedTo (CQ-3 — Customer Quotes stability contract). It
 * only resolves the rep id used for the email_conversation_threads.ownerUserId
 * column on thread creation.
 *
 * Exposes assignOwner() for manual changes.
 */

import type { IStorage } from "../storage";
import type { EmailMessage, EmailConversationThread } from "@shared/schema";
import { publishBucketChange } from "./conversationWaitingStateService";

export type ConversationOwnershipStorage = Pick<
  IStorage,
  | "getCompany"
  | "getUser"
  | "upsertEmailConversationThread"
>;

/**
 * Determine the initial owner for a thread based on v1 priority rules.
 * Returns a userId string or null (unowned).
 */
export async function determineInitialOwner(
  message: EmailMessage,
  orgId: string,
  storageInstance: ConversationOwnershipStorage,
): Promise<string | null> {
  // (a) Account owner — prefer canonical ownerRepId, then legacy assignedTo.
  if (message.linkedAccountId) {
    const company = await storageInstance.getCompany(message.linkedAccountId);
    const candidates: string[] = [];
    if (company?.ownerRepId) candidates.push(company.ownerRepId);
    if (company?.assignedTo && company.assignedTo !== company.ownerRepId) {
      candidates.push(company.assignedTo);
    }
    for (const candidate of candidates) {
      // Cross-tenant guard: verify the candidate user belongs to the same org.
      const user = await storageInstance.getUser(candidate);
      if (user && user.organizationId === orgId) {
        return user.id;
      }
    }
  }

  // (b) Carrier owner — carriers table has no direct ownerUserId; fall through to (c)

  // (c) Internal user who sent the first outbound email (the message itself may be outbound)
  if (message.direction === "outbound" && message.fromEmail) {
    // We don't have a direct userId on the message, so we cannot determine sender user here.
    // In practice, the outbound send path would need to pass userId — for v1 this returns null.
    return null;
  }

  // (d) null — unowned
  return null;
}

/**
 * Assign (or unassign) the owner of a conversation thread.
 * Scoped by orgId to prevent cross-tenant writes.
 */
export async function assignOwner(
  threadRecordId: string,
  ownerUserId: string | null,
  orgId: string,
  storageInstance: Pick<IStorage, "updateEmailConversationThread" | "getEmailConversationThreadById">,
): Promise<void> {
  // Task #968 — snapshot prev bucket fields, then publish a
  // conversation_thread event so the client reclassification toast
  // can name the destination bucket.
  const before = await storageInstance.getEmailConversationThreadById(threadRecordId);
  if (!before || before.orgId !== orgId) return;
  const prevSnapshot = {
    waitingState: before.waitingState ?? null,
    ownerUserId: before.ownerUserId ?? null,
  };
  const written = await storageInstance.updateEmailConversationThread(threadRecordId, orgId, { ownerUserId });
  publishBucketChange(
    orgId,
    before.threadId,
    prevSnapshot,
    {
      waitingState: written?.waitingState ?? prevSnapshot.waitingState,
      ownerUserId: written?.ownerUserId ?? ownerUserId,
    },
    written?.rowVersionAt instanceof Date ? written.rowVersionAt.getTime() : undefined,
  );
}
