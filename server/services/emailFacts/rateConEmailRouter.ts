/**
 * Email Intelligence v1.5 — Tier 1.3 rate-con caller (Task #943).
 *
 * Builds a `RateConRouterFn` that ingests email-borne rate-con attachments
 * into the `documents` table (using the canonical `documentIngestion`
 * pipeline) and queues the rate-con extractor. Returns the persisted
 * document id so the `email_attachment_classifications.routed_ref_id`
 * column points back at the document for downstream lane evidence.
 *
 * Failure modes are intentionally gentle:
 *   - missing `contentBase64` (Graph stripped the payload because the file
 *     is too large) → returns `{ extractionId: null }`. The attachment row
 *     still records `routed_to = "rate_con_extractor_failed"`.
 *   - no resolvable uploader (no rep mapped to the mailbox) → same.
 *   - duplicate document (sha256 already in org) → returns the existing id
 *     so we never re-queue the same file.
 */

import type { EmailMessage } from "@shared/schema";
import type { AttachmentInput, RateConRouterFn } from "./attachmentRouter";
import type { IStorage } from "../../storage";

export interface RateConRouterDeps {
  /** User mapped to the mailbox that received this email. Required. */
  uploaderId: string;
  /** The email's org. */
  orgId: string;
}

/**
 * Resolve the uploader user id for a message — prefers the rep on outbound
 * mail, otherwise the mailbox owner (the `toEmail` address) on inbound mail.
 */
export async function resolveRateConUploaderId(
  storage: Pick<IStorage, "getUserByEmailAddress">,
  msg: EmailMessage,
): Promise<string | null> {
  const candidates: string[] = [];
  if (msg.direction === "outbound" && msg.fromEmail) candidates.push(msg.fromEmail);
  if (msg.direction === "inbound" && msg.toEmail) candidates.push(msg.toEmail);
  if (msg.direction === "inbound" && msg.fromEmail) candidates.push(msg.fromEmail);
  for (const addr of candidates) {
    try {
      const user = await storage.getUserByEmailAddress(addr.trim().toLowerCase(), msg.orgId);
      if (user?.id) return user.id;
    } catch (err) {
      console.error(`[emailFacts] rate-con uploader lookup failed for ${addr}:`, err);
    }
  }
  return null;
}

/**
 * Construct the router callback that the attachment router invokes for
 * `rate_con` classifications. The returned function is a no-op (returns
 * `{ extractionId: null }`) if `uploaderId` is missing.
 */
export function buildRateConRouter(deps: RateConRouterDeps | null): RateConRouterFn {
  return async (msg: EmailMessage, att: AttachmentInput) => {
    if (!deps?.uploaderId) return { extractionId: null };
    if (!att.contentBase64) return { extractionId: null };

    const { ingestDocument } = await import("../documentIngestion");
    const { enqueueRateConAfterIngest } = await import("../rateConAutoExtractWorker");

    const bytes = Buffer.from(att.contentBase64, "base64");
    const result = await ingestDocument({
      source: "email_forward",
      file: {
        filename: att.name,
        mimeType: att.contentType ?? "application/octet-stream",
        bytes,
      },
      uploader: {
        id: deps.uploaderId,
        organizationId: deps.orgId,
      },
      context: {
        entityType: msg.linkedAccountId ? "account" : msg.linkedCarrierId ? "carrier" : null,
        entityId: msg.linkedAccountId ?? msg.linkedCarrierId ?? null,
        emailMessageId: msg.id,
        emailThreadId: msg.threadId,
        emailProviderMessageId: msg.providerMessageId,
      },
      email: {
        fromEmail: msg.fromEmail,
        subject: msg.subject,
      },
    });

    // Fire-and-forget extraction so the email ingestion hot path stays fast.
    // The pipeline status is recorded on the document row regardless.
    if (!result.failed) {
      enqueueRateConAfterIngest(result.document.id, deps.orgId);
    }
    return { extractionId: result.document.id };
  };
}
