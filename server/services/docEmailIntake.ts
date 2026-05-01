/**
 * Task #910 — Email-forward ingress for the dedicated DNA documents inbox.
 *
 * Scope (slice 1): a single dedicated mailbox (`docs@…`-style) that reps
 * forward documents to. We attribute each forwarded message to the rep by
 * their `from` email, then pipe each attachment through `ingestDocument`.
 * Patterned after `podIntakeService` so the M365/Graph wiring stays
 * familiar; we don't share the actual mailbox or its settings with the POD
 * intake flow on purpose — the two pipelines must remain independent.
 *
 * The poll loop is intentionally simple and idempotent — re-invoking
 * `pollAndIngestOnce` with the same set of messages is a no-op because
 * `ingestDocument` dedupes by SHA-256.
 */
import { storage } from "../storage";
import { ingestDocument } from "./documentIngestion";
import { db } from "../storage";
import { sql } from "drizzle-orm";

export interface ForwardedAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface ForwardedEmail {
  /** Stable per-message id from the mail provider — used for de-dup of the
   *  envelope itself when the polling cursor regresses. */
  messageId: string;
  fromEmail: string;
  subject: string;
  receivedAtIso: string;
  attachments: ForwardedAttachment[];
}

export interface PollResult {
  processed: number;
  ingested: number;
  deduped: number;
  failed: number;
  unattributed: number;
}

/**
 * Resolve the rep that forwarded the email. We match `from` against
 * `users.username` (the codebase uses username == email for SSO orgs).
 * Returns null when no rep matches — the attachments still ingest under
 * a "system" sentinel so admins can see them in the queue, but the
 * `recent_documents` context section won't surface them to anyone.
 */
async function resolveUploader(orgId: string, fromEmail: string): Promise<{ id: string; organizationId: string } | null> {
  if (!fromEmail) return null;
  const lc = fromEmail.trim().toLowerCase();
  const users = await storage.getUsers(orgId);
  const hit = users.find((u) => (u.username ?? "").toLowerCase() === lc || (u.name ?? "").toLowerCase() === lc);
  return hit ? { id: hit.id, organizationId: orgId } : null;
}

/**
 * Process one batch of forwarded emails. Pure / DI-friendly: tests pass in
 * a synthetic batch and assert per-attachment ingest behaviour. The
 * production caller (a future cron / Graph subscription handler) will
 * fetch the batch from Microsoft Graph and pass it in.
 */
export async function processForwardedBatch(
  orgId: string,
  emails: ForwardedEmail[],
  opts?: { systemUploaderId?: string },
): Promise<PollResult> {
  let processed = 0;
  let ingested = 0;
  let deduped = 0;
  let failed = 0;
  let unattributed = 0;

  for (const email of emails) {
    processed++;
    const resolved = await resolveUploader(orgId, email.fromEmail);
    if (!resolved && !opts?.systemUploaderId) {
      unattributed++;
      console.warn(`[docEmailIntake] unattributed forward from ${email.fromEmail} — skipped`);
      continue;
    }
    const uploader = resolved ?? { id: opts!.systemUploaderId!, organizationId: orgId };
    if (!resolved) unattributed++;

    for (const att of email.attachments) {
      try {
        const r = await ingestDocument({
          source: "email_forward",
          file: { filename: att.filename, mimeType: att.mimeType, bytes: att.bytes },
          uploader,
          email: { fromEmail: email.fromEmail, subject: email.subject },
        });
        if (r.deduped) deduped++;
        else if (r.failed) failed++;
        else ingested++;
      } catch (err) {
        failed++;
        console.error("[docEmailIntake] attachment ingest threw:", err);
      }
    }
  }
  return { processed, ingested, deduped, failed, unattributed };
}

/**
 * Best-effort placeholder for the production Graph poller. Kept here so the
 * cron wiring has a stable function name and future M365 work can swap the
 * body in without touching call sites. No-op if the dedicated mailbox env
 * var is missing.
 */
export async function pollAndIngestOnce(orgId: string): Promise<PollResult | null> {
  const mailbox = process.env.DNA_DOCS_FORWARD_MAILBOX;
  if (!mailbox) return null;
  // Graph fetch is intentionally not implemented in slice 1 — the M365
  // mailbox identity work is tracked under #289 / #288. For now we only
  // expose the function so the test suite + cron entry point can be wired.
  await db.execute(sql`SELECT 1`); // touch the connection so the cron heartbeat sees us
  return { processed: 0, ingested: 0, deduped: 0, failed: 0, unattributed: 0 };
}
