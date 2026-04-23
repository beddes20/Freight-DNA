/**
 * Mailbox Delta Sync Service (Task #230)
 *
 * Periodically checks monitored NAM/AM mailboxes for missed emails using
 * Microsoft Graph delta queries. Acts as a catch-up mechanism alongside
 * real-time webhook notifications.
 *
 * Uses delta tokens to only fetch new/changed messages since the last sync.
 * On first run (no delta token), fetches messages from the last 24 hours.
 *
 * Task #438 — Per-message failure tracking + auto-retry/self-heal loop.
 * Failures during ingestion are recorded individually so admins can see
 * exactly which message failed and why; transient failures are retried with
 * exponential backoff and resolved automatically when they succeed.
 */

import { storage } from "../storage";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";
import type { MailboxSyncFailure, MonitoredMailbox } from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [delta-sync] ${msg}`);
}

interface DeltaMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  internetMessageId?: string;
}

interface DeltaResponse {
  value: DeltaMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// Task #438 — exponential backoff schedule (in minutes) and give-up threshold.
// Indexed by (attemptCount - 1); any attempt past the array length uses the
// last value, and reaching MAX_ATTEMPTS flips the failure to give_up.
//
// Env overrides (so ops can tune without a deploy):
//   MAILBOX_SYNC_MAX_ATTEMPTS       — integer ≥ 1 (default 5)
//   MAILBOX_SYNC_BACKOFF_MINUTES    — comma-separated minutes
//                                     (default "5,15,60,360,1440")
function parseBackoffEnv(): number[] {
  const raw = process.env.MAILBOX_SYNC_BACKOFF_MINUTES;
  if (!raw) return [5, 15, 60, 6 * 60, 24 * 60];
  const parts = raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : [5, 15, 60, 6 * 60, 24 * 60];
}
function parseMaxAttemptsEnv(): number {
  const n = parseInt(process.env.MAILBOX_SYNC_MAX_ATTEMPTS ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}
const RETRY_BACKOFF_MINUTES = parseBackoffEnv();
const MAX_ATTEMPTS = parseMaxAttemptsEnv();

export type SyncFailureCategory =
  | "graph_fetch"
  | "parse"
  | "db_constraint"
  | "oversize"
  | "unknown";

function classifyError(err: unknown): { category: SyncFailureCategory; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("graph") && (lower.includes("fetch") || lower.includes("404") || lower.includes("403") || lower.includes("401") || lower.includes("429") || lower.includes("5"))) {
    return { category: "graph_fetch", message };
  }
  if (lower.includes("not found") || lower.includes("itemnotfound") || lower.includes("404")) {
    return { category: "graph_fetch", message };
  }
  if (lower.includes("too large") || lower.includes("payload") || lower.includes("oversize") || lower.includes("size limit")) {
    return { category: "oversize", message };
  }
  if (lower.includes("constraint") || lower.includes("duplicate key") || lower.includes("violates") || lower.includes("unique")) {
    return { category: "db_constraint", message };
  }
  if (lower.includes("parse") || lower.includes("unexpected token") || lower.includes("invalid json") || lower.includes("cannot read")) {
    return { category: "parse", message };
  }
  return { category: "unknown", message };
}

function nextBackoffAt(attemptCount: number): Date | null {
  // attemptCount is the number of attempts made so far (1 after first failure).
  // Schedule the next retry using index (attemptCount - 1), so the 1st failure
  // schedules RETRY_BACKOFF_MINUTES[0] (e.g. 5m), the 2nd schedules [1] (15m),
  // and so on. Once we'd exceed MAX_ATTEMPTS there is no next retry.
  if (attemptCount >= MAX_ATTEMPTS) return null;
  const idx = Math.min(Math.max(attemptCount - 1, 0), RETRY_BACKOFF_MINUTES.length - 1);
  const minutes = RETRY_BACKOFF_MINUTES[idx];
  return new Date(Date.now() + minutes * 60_000);
}

async function fetchDeltaMessages(
  mailboxEmail: string,
  deltaToken: string | null,
  folder: "inbox" | "sentitems" = "inbox",
): Promise<{ messages: DeltaMessage[]; newDeltaToken: string | null }> {
  const token = await getGraphAccessToken();
  const messages: DeltaMessage[] = [];
  let newDeltaToken: string | null = null;

  // Microsoft Graph's Messages delta endpoint only supports a single $filter
  // shape: `receivedDateTime ge <iso>`. This applies to both Inbox and
  // SentItems — passing `sentDateTime ge ...` gives a 400 ErrorInvalidUrlQuery.
  // (Sent messages also have a receivedDateTime stamped by the server, so this
  // filter still works for the SentItems folder.)
  const selectFields = folder === "sentitems"
    ? "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,sentDateTime,internetMessageId"
    : "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId";

  let url: string;
  if (deltaToken) {
    url = deltaToken;
  } else {
    const lookback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders/${folder}/messages/delta?$select=${selectFields}&$filter=receivedDateTime ge ${lookback}`;
  }

  let pageCount = 0;
  const MAX_PAGES = 10;

  while (url && pageCount < MAX_PAGES) {
    pageCount++;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 410 && deltaToken) {
        log(`Delta token expired for ${mailboxEmail}/${folder} — resetting`);
        return fetchDeltaMessages(mailboxEmail, null, folder);
      }
      throw new Error(`Graph delta query failed (${res.status}, ${folder}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as DeltaResponse;
    if (data.value) {
      messages.push(...data.value);
    }

    if (data["@odata.deltaLink"]) {
      newDeltaToken = data["@odata.deltaLink"];
      break;
    }

    url = data["@odata.nextLink"] ?? "";
  }

  return { messages, newDeltaToken };
}

/**
 * Task #438 — Refetch a single message by ID from Microsoft Graph for retry.
 * Returns the message payload, or `null` if the message no longer exists
 * (which the caller should treat as a successful resolution — the message
 * is gone, nothing to ingest).
 */
async function fetchSingleMessage(
  mailboxEmail: string,
  folder: "inbox" | "sentitems",
  providerMessageId: string,
): Promise<DeltaMessage | null> {
  const token = await getGraphAccessToken();
  const selectFields = folder === "sentitems"
    ? "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,sentDateTime,internetMessageId"
    : "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId";

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/messages/${encodeURIComponent(providerMessageId)}?$select=${selectFields}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Graph fetch single message failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  return await res.json() as DeltaMessage;
}

async function ingestMessage(
  mailbox: MonitoredMailbox,
  folder: "inbox" | "sentitems",
  msg: DeltaMessage,
): Promise<void> {
  const { processUserMailboxEmailForDelta } = await import("../routes/graphWebhook");

  const fromEmail = msg.from?.emailAddress?.address ?? "";
  const fromName = msg.from?.emailAddress?.name ?? "";
  const allToRecipients = (msg.toRecipients ?? [])
    .map(r => r.emailAddress?.address)
    .filter((a): a is string => !!a);
  const allCcRecipients = (msg.ccRecipients ?? [])
    .map(r => r.emailAddress?.address)
    .filter((a): a is string => !!a);
  const toEmail = allToRecipients[0] ?? "";
  const subject = msg.subject ?? "";
  const bodyPreview = msg.bodyPreview?.slice(0, 255) ?? "";
  const bodyFull = msg.body?.content ?? bodyPreview;
  const conversationId = msg.conversationId ?? null;
  const providerMessageId = msg.id;
  const receivedAt = msg.sentDateTime
    ? new Date(msg.sentDateTime)
    : msg.receivedDateTime
      ? new Date(msg.receivedDateTime)
      : new Date();

  await processUserMailboxEmailForDelta({
    orgId: mailbox.orgId,
    monitoredMailbox: { id: mailbox.id, userId: mailbox.userId, email: mailbox.email },
    fromEmail,
    fromName,
    toEmail,
    allToRecipients: [...allToRecipients, ...allCcRecipients],
    subject,
    bodyPreview,
    bodyFull: bodyFull.slice(0, 5000),
    conversationId,
    providerMessageId,
    receivedAt,
    mailboxEmail: mailbox.email,
  });
}

/**
 * Task #438 — Process the retry queue for a mailbox before pulling new
 * deltas. For each pending failure whose nextAttemptAt has elapsed, refetch
 * the message and try ingestion again. Resolves on success, bumps backoff
 * on continued failure, and flips to `give_up` once MAX_ATTEMPTS is hit.
 */
async function processRetriesForMailbox(mailbox: MonitoredMailbox): Promise<void> {
  const due = await storage.getDueMailboxSyncFailuresForMailbox(mailbox.id, new Date());
  for (const failure of due) {
    const folder = (failure.folder === "sentitems" ? "sentitems" : "inbox") as "inbox" | "sentitems";
    try {
      const msg = await fetchSingleMessage(mailbox.email, folder, failure.providerMessageId);
      if (msg === null) {
        // Graph 404 → message gone → resolve.
        await storage.markMailboxSyncFailureResolvedById(failure.id);
        log(`Retry resolved (msg gone) ${mailbox.email}/${folder} ${failure.providerMessageId}`);
        continue;
      }
      await ingestMessage(mailbox, folder, msg);
      await storage.markMailboxSyncFailureResolvedById(failure.id);
      log(`Retry succeeded ${mailbox.email}/${folder} ${failure.providerMessageId}`);
    } catch (err) {
      const { category, message } = classifyError(err);
      const newAttemptCount = failure.attemptCount + 1;
      const nextAt = nextBackoffAt(newAttemptCount);
      await storage.upsertMailboxSyncFailure({
        orgId: mailbox.orgId,
        mailboxId: mailbox.id,
        folder,
        providerMessageId: failure.providerMessageId,
        errorCategory: category,
        errorMessage: message,
        nextAttemptAt: nextAt,
      });
      if (newAttemptCount >= MAX_ATTEMPTS) {
        await storage.markMailboxSyncFailureGiveUp(failure.id);
        log(`Retry give_up ${mailbox.email}/${folder} ${failure.providerMessageId} after ${newAttemptCount} attempts`);
      } else {
        log(`Retry failed ${mailbox.email}/${folder} ${failure.providerMessageId} attempt=${newAttemptCount}: ${message.slice(0, 120)}`);
      }
    }
  }
}

export async function syncMailboxDelta(mailboxId: string): Promise<{ processed: number; errors: number }> {
  const mailbox = await storage.getMonitoredMailbox(mailboxId);
  if (!mailbox || !mailbox.enabled) {
    return { processed: 0, errors: 0 };
  }

  // Task #438 — Drain the retry queue first so transient failures from a
  // previous cycle get a chance to clear before we add new work.
  try {
    await processRetriesForMailbox(mailbox);
  } catch (err) {
    log(`Retry loop error for ${mailbox.email}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let processed = 0;
  let errors = 0;
  let inboxToken: string | null = mailbox.deltaSyncToken;
  let sentToken: string | null = mailbox.sentDeltaSyncToken;

  // Run both folders. A failure in one must not corrupt the other folder's
  // delta token — we persist whichever token(s) we successfully advanced.
  for (const folder of ["inbox", "sentitems"] as const) {
    const currentToken = folder === "inbox" ? inboxToken : sentToken;
    try {
      const { messages, newDeltaToken } = await fetchDeltaMessages(
        mailbox.email,
        currentToken,
        folder,
      );

      if (messages.length > 0) {
        log(`Delta sync for ${mailbox.email}/${folder}: ${messages.length} message(s) fetched`);
      }

      for (const msg of messages) {
        try {
          await ingestMessage(mailbox, folder, msg);
          // Task #438 — clear any prior failure for this message.
          await storage.markMailboxSyncFailureResolved(mailbox.id, folder, msg.id);
          processed++;
        } catch (msgErr) {
          errors++;
          const { category, message } = classifyError(msgErr);
          await storage.upsertMailboxSyncFailure({
            orgId: mailbox.orgId,
            mailboxId: mailbox.id,
            folder,
            providerMessageId: msg.id,
            errorCategory: category,
            errorMessage: message,
            nextAttemptAt: nextBackoffAt(1),
          });
          log(`Delta sync message error (${folder}) ${msg.id} [${category}]: ${message.slice(0, 160)}`);
        }
      }

      // Only advance the persisted delta token when Graph actually returned
      // a new @odata.deltaLink. If we hit MAX_PAGES (huge backlog) or only
      // got @odata.nextLink, keep the prior token so the next cycle resumes
      // from where we were instead of re-fetching the 24h lookback window.
      if (newDeltaToken) {
        if (folder === "inbox") inboxToken = newDeltaToken;
        else sentToken = newDeltaToken;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log(`Delta sync error for ${mailbox.email}/${folder}: ${m}`);
      errors++;
    }
  }

  // Task #438 — syncStatus / syncError reflect the *current unresolved*
  // failure count for this mailbox, not just what happened this run. A
  // dismissed or resolved failure no longer makes the mailbox look broken.
  const unresolvedCount = await storage.countUnresolvedMailboxSyncFailures(mailbox.id);
  await storage.updateMonitoredMailbox(mailbox.id, {
    deltaSyncToken: inboxToken,
    sentDeltaSyncToken: sentToken,
    lastSyncAt: new Date(),
    syncStatus: unresolvedCount > 0 ? "partial" : "active",
    syncError: unresolvedCount > 0 ? `${unresolvedCount} message(s) failed` : null,
  });

  return { processed, errors };
}

/**
 * Task #438 — Manual single-failure retry, used by the admin UI's
 * "Retry now" button. Bypasses the backoff schedule so an admin can force
 * an immediate attempt.
 */
export async function retryMailboxSyncFailure(failureId: string): Promise<{ ok: boolean; resolved: boolean; error?: string }> {
  const failure = await storage.getMailboxSyncFailure(failureId);
  if (!failure) return { ok: false, resolved: false, error: "Failure not found" };
  const mailbox = await storage.getMonitoredMailbox(failure.mailboxId);
  if (!mailbox) return { ok: false, resolved: false, error: "Mailbox not found" };
  const folder = (failure.folder === "sentitems" ? "sentitems" : "inbox") as "inbox" | "sentitems";
  try {
    const msg = await fetchSingleMessage(mailbox.email, folder, failure.providerMessageId);
    if (msg === null) {
      await storage.markMailboxSyncFailureResolvedById(failure.id);
    } else {
      await ingestMessage(mailbox, folder, msg);
      await storage.markMailboxSyncFailureResolvedById(failure.id);
    }
    const unresolved = await storage.countUnresolvedMailboxSyncFailures(mailbox.id);
    await storage.updateMonitoredMailbox(mailbox.id, {
      syncStatus: unresolved > 0 ? "partial" : "active",
      syncError: unresolved > 0 ? `${unresolved} message(s) failed` : null,
    });
    return { ok: true, resolved: true };
  } catch (err) {
    const { category, message } = classifyError(err);
    const newAttemptCount = failure.attemptCount + 1;
    const nextAt = nextBackoffAt(newAttemptCount);
    await storage.upsertMailboxSyncFailure({
      orgId: failure.orgId,
      mailboxId: failure.mailboxId,
      folder,
      providerMessageId: failure.providerMessageId,
      errorCategory: category,
      errorMessage: message,
      nextAttemptAt: nextAt,
    });
    if (newAttemptCount >= MAX_ATTEMPTS) {
      await storage.markMailboxSyncFailureGiveUp(failure.id);
    }
    return { ok: true, resolved: false, error: message };
  }
}

let _deltaSyncTimer: ReturnType<typeof setInterval> | null = null;

async function runDeltaSyncCycle(): Promise<void> {
  if (!azureCredentialsConfigured()) return;

  try {
    const mailboxes = await storage.getEnabledMonitoredMailboxes();
    if (mailboxes.length === 0) return;

    log(`Running delta sync cycle for ${mailboxes.length} mailbox(es)`);

    for (const mb of mailboxes) {
      const result = await syncMailboxDelta(mb.id);
      if (result.processed > 0 || result.errors > 0) {
        log(`Delta sync ${mb.email}: ${result.processed} processed, ${result.errors} errors`);
      }
    }
  } catch (err) {
    log(`Delta sync cycle error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function initDeltaSyncScheduler(): void {
  if (!azureCredentialsConfigured()) {
    log("Azure credentials not configured — delta sync disabled");
    return;
  }

  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  setTimeout(() => runDeltaSyncCycle(), 30_000);

  _deltaSyncTimer = setInterval(runDeltaSyncCycle, FIFTEEN_MIN_MS);
  log("Delta sync scheduler started (every 15 minutes)");
}

export function stopDeltaSyncScheduler(): void {
  if (_deltaSyncTimer) {
    clearInterval(_deltaSyncTimer);
    _deltaSyncTimer = null;
  }
}
