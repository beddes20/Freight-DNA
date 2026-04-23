/**
 * Mailbox Historical Backfill Service (Task #508)
 *
 * Pulls the last N days (default 30) of messages from a monitored mailbox's
 * Inbox and SentItems folders via Microsoft Graph and streams each message
 * through the existing delta-sync ingestion path
 * (`processUserMailboxEmailForDelta` in `routes/graphWebhook.ts`). Idempotent:
 * dedup is owned by the unique index on `email_messages(org_id,
 * provider_message_id)`, so re-running the same backfill window is a no-op.
 *
 * Per-mailbox state is persisted in `mailbox_historical_backfills` so admins
 * can see status, window, counts, and the last error from the admin UI.
 *
 * Auto-trigger: invoked by the monitored-mailbox create + bulk-enroll routes
 * the first time a mailbox is added. After the backfill completes the service
 * also seeds a fresh delta token (by running one cycle of `syncMailboxDelta`)
 * so the existing 15-minute scheduler picks up cleanly with no gap.
 */

import { storage } from "../storage";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";
import { syncMailboxDelta } from "./mailboxDeltaSyncService";
import type { MailboxHistoricalBackfill, MonitoredMailbox } from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [historical-backfill] ${msg}`);
}

interface HistoricalMessage {
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

interface ListResponse {
  value: HistoricalMessage[];
  "@odata.nextLink"?: string;
}

const DEFAULT_BACKFILL_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES_PER_FOLDER = 200; // 200 * 50 = 10k messages cap per folder
const RATE_LIMIT_MAX_RETRIES = 5;

function getBackfillDays(): number {
  const env = parseInt(process.env.MAILBOX_BACKFILL_DAYS ?? "", 10);
  if (Number.isFinite(env) && env > 0 && env <= 365) return env;
  return DEFAULT_BACKFILL_DAYS;
}

/**
 * Inject-friendly fetch with 429 / 503 retry-after backoff so production
 * Graph throttling doesn't kill a backfill mid-run.
 */
async function fetchWithBackoff(url: string, token: string): Promise<Response> {
  let attempt = 0;
  // Loop with bounded retries.
  while (true) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt >= RATE_LIMIT_MAX_RETRIES) return res;
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(60_000, 1000 * Math.pow(2, attempt));
    log(`Rate-limited (${res.status}); waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}`);
    await new Promise(r => setTimeout(r, waitMs));
    attempt++;
  }
}

/**
 * Page through historical messages in a single folder with
 * `receivedDateTime ge <iso>`. Yields each page so the caller can stream
 * ingestion incrementally without buffering 10k messages in memory.
 *
 * Exposed for tests; in production callers should use `runBackfillForMailbox`.
 */
export async function* iterateHistoricalMessages(
  mailboxEmail: string,
  folder: "inbox" | "sentitems",
  windowStart: Date,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncGenerator<HistoricalMessage[], void, void> {
  const token = await getGraphAccessToken();
  const selectFields = folder === "sentitems"
    ? "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,sentDateTime,receivedDateTime,internetMessageId"
    : "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId";

  const filterClause = `receivedDateTime ge ${windowStart.toISOString()}`;
  let url: string =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}` +
    `/mailFolders/${folder}/messages?$select=${selectFields}` +
    `&$filter=${encodeURIComponent(filterClause)}` +
    `&$top=${pageSize}&$orderby=receivedDateTime desc`;

  let pageCount = 0;
  while (url && pageCount < MAX_PAGES_PER_FOLDER) {
    pageCount++;
    const res = await fetchWithBackoff(url, token);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph historical fetch failed (${res.status}, ${folder}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as ListResponse;
    if (data.value && data.value.length > 0) {
      yield data.value;
    }
    url = data["@odata.nextLink"] ?? "";
  }
}

// Test-only override for the ingestion path so unit tests can run without
// touching the route module / database. Returns null to use real ingestion.
let _ingestOverrideForTests:
  | ((mailbox: MonitoredMailbox, folder: "inbox" | "sentitems", msg: HistoricalMessage) => Promise<{ created: boolean }>)
  | null = null;
export function __setIngestOverrideForTests(
  fn: typeof _ingestOverrideForTests,
): void {
  _ingestOverrideForTests = fn;
}

async function ingestHistoricalMessage(
  mailbox: MonitoredMailbox,
  folder: "inbox" | "sentitems",
  msg: HistoricalMessage,
): Promise<{ created: boolean }> {
  if (_ingestOverrideForTests) {
    return _ingestOverrideForTests(mailbox, folder, msg);
  }
  // Lazy-import to avoid the route module pulling in everything at boot, and
  // to make stubbing trivial in tests.
  const { processUserMailboxEmailForDelta } = await import("../routes/graphWebhook");

  const fromEmail = msg.from?.emailAddress?.address ?? "";
  const fromName = msg.from?.emailAddress?.name ?? "";
  const allToRecipients = (msg.toRecipients ?? [])
    .map(r => r.emailAddress?.address)
    .filter((a): a is string => !!a);
  const allCcRecipients = (msg.ccRecipients ?? [])
    .map(r => r.emailAddress?.address)
    .filter((a): a is string => !!a);

  // We don't get a created/dup signal back from `processUserMailboxEmailForDelta`,
  // so detect dedup by checking the email_messages row immediately before the
  // call. `processUserMailboxEmailForDelta` is itself idempotent, so a duplicate
  // is still safe — we only need this to maintain accurate counts.
  const existing = await storage.getEmailMessageByProviderId(mailbox.orgId, msg.id).catch(() => null);

  await processUserMailboxEmailForDelta({
    orgId: mailbox.orgId,
    monitoredMailbox: { id: mailbox.id, userId: mailbox.userId, email: mailbox.email },
    fromEmail,
    fromName,
    toEmail: allToRecipients[0] ?? "",
    allToRecipients: [...allToRecipients, ...allCcRecipients],
    subject: msg.subject ?? "",
    bodyPreview: msg.bodyPreview?.slice(0, 255) ?? "",
    bodyFull: (msg.body?.content ?? msg.bodyPreview ?? "").slice(0, 5000),
    conversationId: msg.conversationId ?? null,
    providerMessageId: msg.id,
    receivedAt: msg.sentDateTime
      ? new Date(msg.sentDateTime)
      : msg.receivedDateTime
        ? new Date(msg.receivedDateTime)
        : new Date(),
    mailboxEmail: mailbox.email,
  });

  return { created: !existing };
}

export interface BackfillTriggerOptions {
  triggeredBy?: "auto" | "admin" | "admin_bulk";
  triggeredByUserId?: string | null;
  days?: number;
  /** If a backfill row exists with status completed/running, do nothing. */
  skipIfAlreadyCompleted?: boolean;
}

export interface BackfillResult {
  backfillId: string;
  status: "completed" | "failed" | "skipped";
  messagesFetched: number;
  messagesIngested: number;
  messagesDuplicate: number;
  errorsCount: number;
  lastError?: string | null;
}

/**
 * Run the 30-day historical backfill for a single mailbox. Persists a
 * `mailbox_historical_backfills` row throughout so the admin UI status
 * panel always reflects current progress.
 */
export async function runBackfillForMailbox(
  mailboxId: string,
  opts: BackfillTriggerOptions = {},
): Promise<BackfillResult> {
  const mailbox = await storage.getMonitoredMailbox(mailboxId);
  if (!mailbox) {
    return {
      backfillId: "",
      status: "failed",
      messagesFetched: 0,
      messagesIngested: 0,
      messagesDuplicate: 0,
      errorsCount: 1,
      lastError: "Mailbox not found",
    };
  }

  if (opts.skipIfAlreadyCompleted) {
    const latest = await storage.getLatestMailboxHistoricalBackfill(mailboxId);
    if (latest && (latest.status === "completed" || latest.status === "running")) {
      return {
        backfillId: latest.id,
        status: "skipped",
        messagesFetched: latest.messagesFetched,
        messagesIngested: latest.messagesIngested,
        messagesDuplicate: latest.messagesDuplicate,
        errorsCount: latest.errorsCount,
        lastError: latest.lastError,
      };
    }
  }

  const days = opts.days ?? getBackfillDays();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);

  const row = await storage.createMailboxHistoricalBackfill({
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    status: "running",
    windowStart,
    windowEnd,
    messagesFetched: 0,
    messagesIngested: 0,
    messagesDuplicate: 0,
    errorsCount: 0,
    lastError: null,
    triggeredBy: opts.triggeredBy ?? "auto",
    triggeredByUserId: opts.triggeredByUserId ?? null,
    startedAt: new Date(),
    completedAt: null,
  });

  let messagesFetched = 0;
  let messagesIngested = 0;
  let messagesDuplicate = 0;
  let errorsCount = 0;
  let lastError: string | null = null;

  log(`Backfill start mailbox=${mailbox.email} window=${windowStart.toISOString()}..${windowEnd.toISOString()}`);

  try {
    for (const folder of ["inbox", "sentitems"] as const) {
      try {
        for await (const page of iterateHistoricalMessages(mailbox.email, folder, windowStart)) {
          messagesFetched += page.length;
          for (const msg of page) {
            try {
              const { created } = await ingestHistoricalMessage(mailbox, folder, msg);
              if (created) messagesIngested++; else messagesDuplicate++;
            } catch (msgErr) {
              errorsCount++;
              lastError = msgErr instanceof Error ? msgErr.message : String(msgErr);
              log(`Ingest error ${mailbox.email}/${folder} ${msg.id}: ${lastError.slice(0, 160)}`);
            }
          }
          // Persist mid-run so the admin UI reflects progress on long runs.
          await storage.updateMailboxHistoricalBackfill(row.id, {
            messagesFetched,
            messagesIngested,
            messagesDuplicate,
            errorsCount,
            lastError,
          });
        }
      } catch (folderErr) {
        errorsCount++;
        lastError = folderErr instanceof Error ? folderErr.message : String(folderErr);
        log(`Folder error ${mailbox.email}/${folder}: ${lastError.slice(0, 200)}`);
      }
    }

    // Seed delta token by running one delta-sync cycle. This is idempotent
    // (delta sync upserts on the same provider_message_id) and is what gets
    // the 15-min scheduler back into a known-good state with no gap.
    try {
      await syncMailboxDelta(mailbox.id);
    } catch (seedErr) {
      log(`Delta seed after backfill failed for ${mailbox.email}: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`);
    }

    const finalStatus = errorsCount > 0 && messagesIngested === 0 ? "failed" : "completed";
    await storage.updateMailboxHistoricalBackfill(row.id, {
      status: finalStatus,
      messagesFetched,
      messagesIngested,
      messagesDuplicate,
      errorsCount,
      lastError,
      completedAt: new Date(),
    });

    log(`Backfill done ${mailbox.email}: fetched=${messagesFetched} new=${messagesIngested} dup=${messagesDuplicate} errors=${errorsCount}`);

    return {
      backfillId: row.id,
      status: finalStatus,
      messagesFetched,
      messagesIngested,
      messagesDuplicate,
      errorsCount,
      lastError,
    };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    errorsCount++;
    await storage.updateMailboxHistoricalBackfill(row.id, {
      status: "failed",
      messagesFetched,
      messagesIngested,
      messagesDuplicate,
      errorsCount,
      lastError,
      completedAt: new Date(),
    });
    log(`Backfill FAILED ${mailbox.email}: ${lastError}`);
    return {
      backfillId: row.id,
      status: "failed",
      messagesFetched,
      messagesIngested,
      messagesDuplicate,
      errorsCount,
      lastError,
    };
  }
}

/**
 * Background-friendly trigger: never throws, logs swallowed errors. Used by
 * the auto-trigger on first monitored-mailbox insert.
 */
export function triggerBackfillInBackground(
  mailboxId: string,
  opts: BackfillTriggerOptions = {},
): void {
  if (!azureCredentialsConfigured()) {
    log(`Skipping background backfill for ${mailboxId} — Azure credentials not configured`);
    return;
  }
  // Defer one tick so the caller's HTTP response goes out first.
  setTimeout(() => {
    runBackfillForMailbox(mailboxId, { skipIfAlreadyCompleted: true, ...opts }).catch(err => {
      log(`Background backfill error for ${mailboxId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 0);
}

/**
 * Run backfill for every enabled monitored mailbox in an org. Used by the
 * "Backfill all" admin endpoint. Runs sequentially to avoid hammering Graph
 * with parallel app-only requests against the same tenant.
 */
export async function runBackfillForAllEnabledMailboxes(
  orgId: string,
  opts: BackfillTriggerOptions = {},
): Promise<{ total: number; completed: number; failed: number; skipped: number; results: BackfillResult[] }> {
  const all = await storage.getEnabledMonitoredMailboxes();
  const orgMailboxes = all.filter(m => m.orgId === orgId);
  const results: BackfillResult[] = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const mb of orgMailboxes) {
    const r = await runBackfillForMailbox(mb.id, { triggeredBy: opts.triggeredBy ?? "admin_bulk", triggeredByUserId: opts.triggeredByUserId ?? null });
    results.push(r);
    if (r.status === "completed") completed++;
    else if (r.status === "failed") failed++;
    else skipped++;
  }
  return { total: orgMailboxes.length, completed, failed, skipped, results };
}

export type { MailboxHistoricalBackfill };
