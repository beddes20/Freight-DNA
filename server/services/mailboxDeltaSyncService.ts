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

import cron, { type ScheduledTask } from "node-cron";
import { storage } from "../storage";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";
import { resilientFetch } from "../lib/httpRetry";
import { JOB_NAMES, withHeartbeat } from "../lib/cronHeartbeat";
// Task #874 — publish live-sync hints from the polling-fallback path so the
// Conversations page refreshes within seconds even when Graph webhooks are
// degraded or missing. Mirror the topic strings + payload shape used by the
// webhook path in `server/routes/graphWebhook.ts` so downstream subscribers
// (`client/src/hooks/useLiveSync.ts`) cannot distinguish the two emit sources.
import { publish as publishLiveSync } from "../services/liveSync";
import { dispatchInlineClassification } from "../services/inlineEmailClassifier";
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
    const res = await resilientFetch("graph", () => fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    }));

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
  const res = await resilientFetch("graph", () => fetch(url, { headers: { Authorization: `Bearer ${token}` } }));
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

  // Task #1002 — refuse to ingest a Graph delta entry that has no sender.
  // Empty-from rows are either (a) a transient Graph response missing
  // required fields, or (b) a placeholder for a deleted message. Either
  // way, persisting them creates a junk row keyed on providerMessageId
  // that blocks the legitimate re-delivery (with real data) from
  // upserting. Skip and let the next delta cycle replay carry the real
  // message. mailbox.email is non-empty by construction (we resolve the
  // monitored mailbox before calling here), so the only failure mode is
  // an empty payload from Graph.
  if (!fromEmail) {
    log(
      `[delta-sync] Skipping empty-from message mailbox=${mailbox.email} ` +
      `folder=${folder} msgId=${msg.id}`,
    );
    return;
  }

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

  const result = await processUserMailboxEmailForDelta({
    orgId: mailbox.orgId,
    monitoredMailbox: { id: mailbox.id, userId: mailbox.userId, email: mailbox.email },
    fromEmail,
    fromName,
    toEmail,
    allToRecipients: [...allToRecipients, ...allCcRecipients],
    subject,
    bodyPreview,
    bodyFull: bodyFull.slice(0, 8000),
    conversationId,
    providerMessageId,
    receivedAt,
    mailboxEmail: mailbox.email,
  });

  // Task #874 — fan out a live-sync hint when (and only when) the polling
  // path actually persisted a new row. The shared ingest helper already
  // dedupes against `providerMessageId`, so a Graph message that arrives via
  // both webhook and a near-simultaneous poll only emits once: whichever
  // path inserts the row wins, and the loser sees `created: false` here.
  //
  // Best-effort: `publishLiveSync` never throws, but we still wrap in
  // try/catch so a future change to the publish surface can't break the
  // ingest correctness contract — live-sync is purely advisory.
  if (result.created) {
    try {
      publishLiveSync(
        mailbox.orgId,
        result.direction === "outbound" ? "mailbox_outbound" : "mailbox_inbound",
        conversationId ?? undefined,
      );
    } catch (err) {
      log(`live-sync publish failed for ${mailbox.email}/${folder} ${providerMessageId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Task #939 — polling-fallback equivalent of the inline classifier
    // dispatch in `processGraphNotifications`. When the delta poll is the
    // path that wins the upsert race (webhook missed or arrived later),
    // we still want sub-15-second classification rather than waiting on
    // the recovery cron. Inbound only — outbound rep mail does not feed
    // the customer-quote pipeline. The dispatcher is fire-and-forget
    // and never throws.
    if (result.direction === "inbound" && result.messageId) {
      dispatchInlineClassification({ messageId: result.messageId });
    }
  }
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

let _deltaSyncCron: ScheduledTask | null = null;

// In-process mutex so a slow cycle (lots of mailboxes / Graph latency) can't
// overlap with the next cron tick. With ~40 mailboxes × 2 folders × ~1-3s of
// Graph latency, a single cycle can take a couple of minutes — comfortably
// under our 5-minute cadence, but if Graph is degraded we don't want a pile-on.
let _cycleInFlight = false;

async function runDeltaSyncCycle(trigger: "boot" | "cron"): Promise<void> {
  if (!azureCredentialsConfigured()) return;
  if (_cycleInFlight) {
    log(`Skipping ${trigger} cycle — previous cycle still running`);
    return;
  }
  _cycleInFlight = true;

  try {
    const mailboxes = await storage.getEnabledMonitoredMailboxes();
    if (mailboxes.length === 0) return;

    const startedAt = Date.now();
    // Task #867 — adaptive polling. The cron now fires every minute, but
    // each mailbox only actually polls when its `pollCadenceSeconds`
    // window has elapsed since its last sync. Healthy mailboxes still
    // only run every 5 minutes (cadence=300); the watchdog drops
    // degraded/unhealthy mailboxes to 60s so we mask a silently-broken
    // webhook within ~1 minute instead of ~5.
    //
    // Boot-trigger bypasses the gate so a fresh restart still pulls
    // immediately for everyone.
    const due: typeof mailboxes = [];
    const skipped: { email: string; cadenceS: number; ageS: number }[] = [];
    const now = Date.now();
    for (const mb of mailboxes) {
      if (trigger === "boot") {
        due.push(mb);
        continue;
      }
      const cadenceS = mb.pollCadenceSeconds ?? 300;
      if (!mb.lastSyncAt) {
        due.push(mb);
        continue;
      }
      const ageMs = now - mb.lastSyncAt.getTime();
      // Allow a small jitter floor (5s) so a sync that finished a few
      // milliseconds ago doesn't immediately re-fire on the next-second
      // cron tick. Otherwise this is exactly `age >= cadence`.
      if (ageMs >= cadenceS * 1000 - 5_000) {
        due.push(mb);
      } else {
        skipped.push({ email: mb.email, cadenceS, ageS: Math.round(ageMs / 1000) });
      }
    }

    if (due.length === 0) {
      // Nothing to do this minute — common case for orgs where every
      // mailbox is healthy and on the 5-min cadence.
      return;
    }

    log(`Running delta sync cycle (${trigger}) for ${due.length}/${mailboxes.length} mailbox(es)`);

    let totalProcessed = 0;
    let totalErrors = 0;
    for (const mb of due) {
      const result = await syncMailboxDelta(mb.id);
      totalProcessed += result.processed;
      totalErrors += result.errors;
      if (result.processed > 0 || result.errors > 0) {
        log(`Delta sync ${mb.email}: ${result.processed} processed, ${result.errors} errors`);
      }
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    log(`Cycle done (${trigger}): ${due.length}/${mailboxes.length} mailbox(es) polled, ${totalProcessed} processed, ${totalErrors} errors, ${elapsedSec}s`);
  } catch (err) {
    log(`Delta sync cycle error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    _cycleInFlight = false;
  }
}

/**
 * Polling-based mailbox sync. Webhooks are still the primary real-time path
 * (Microsoft Graph pushes arrive in seconds while a subscription is healthy),
 * but this poll guarantees a maximum staleness of ~5 minutes regardless of
 * webhook health. Even if every webhook subscription were silently broken,
 * no mailbox would go more than 5 minutes without a refresh.
 *
 * Implementation notes:
 *   - Cron expression is clock-anchored ("at minutes 0, 5, 10, …"), so it
 *     keeps firing on schedule even if the workflow restarts. setInterval was
 *     deliberately removed because it resets to t+5min on every restart.
 *   - `_cycleInFlight` mutex prevents overlap if Graph latency drags one
 *     cycle past the next tick.
 *   - Per-mailbox work goes through `syncMailboxDelta`, which is idempotent
 *     (delta tokens + per-message dedupe in `processUserMailboxEmailForDelta`),
 *     so racing with a webhook push for the same message is safe.
 */
export function initDeltaSyncScheduler(): void {
  if (!azureCredentialsConfigured()) {
    log("Azure credentials not configured — delta sync disabled");
    return;
  }

  // Boot kick: 30s after start, run an immediate cycle so a freshly restarted
  // workflow doesn't have to wait up to 5 minutes for the first tick.
  setTimeout(() => { void runDeltaSyncCycle("boot"); }, 30_000);

  // Task #867 — every minute, but per-mailbox `pollCadenceSeconds` gates
  // which mailboxes actually run. Healthy mailboxes still poll every 5
  // minutes; the watchdog drops degraded/unhealthy ones to 60s for fast
  // recovery. The heartbeat interval stays at 1 min so the capture-audit
  // pill correctly flags a stuck cron at the new cadence.
  const ONE_MIN_MS = 60 * 1000;
  _deltaSyncCron = cron.schedule("* * * * *", () => {
    void withHeartbeat(JOB_NAMES.mailboxDeltaSyncPoll, ONE_MIN_MS, () => runDeltaSyncCycle("cron"));
  });

  log("Delta sync scheduler started (every 1 minute, adaptive per-mailbox cadence)");
}

export function stopDeltaSyncScheduler(): void {
  if (_deltaSyncCron) {
    _deltaSyncCron.stop();
    _deltaSyncCron = null;
  }
}

/**
 * Admin-triggerable manual cycle used by the "Sync now" button on the
 * Capture Audit Status pill. Runs the same loop as the cron tick but is
 * fire-and-forget so the HTTP response isn't held open. Returns immediately
 * with whether a cycle was kicked off (false if one is already in flight).
 */
export function triggerImmediateDeltaSyncCycle(): { started: boolean; reason?: string } {
  if (!azureCredentialsConfigured()) {
    return { started: false, reason: "azure_not_configured" };
  }
  if (_cycleInFlight) {
    return { started: false, reason: "cycle_in_progress" };
  }
  void runDeltaSyncCycle("cron");
  return { started: true };
}
