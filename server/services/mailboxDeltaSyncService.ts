/**
 * Mailbox Delta Sync Service (Task #230)
 *
 * Periodically checks monitored NAM/AM mailboxes for missed emails using
 * Microsoft Graph delta queries. Acts as a catch-up mechanism alongside
 * real-time webhook notifications.
 *
 * Uses delta tokens to only fetch new/changed messages since the last sync.
 * On first run (no delta token), fetches messages from the last 24 hours.
 */

import { storage } from "../storage";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";

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

async function fetchDeltaMessages(
  mailboxEmail: string,
  deltaToken: string | null,
  folder: "inbox" | "sentitems" = "inbox",
): Promise<{ messages: DeltaMessage[]; newDeltaToken: string | null }> {
  const token = await getGraphAccessToken();
  const messages: DeltaMessage[] = [];
  let newDeltaToken: string | null = null;

  // Sent Items uses sentDateTime as the filter field; Inbox uses receivedDateTime.
  const dateField = folder === "sentitems" ? "sentDateTime" : "receivedDateTime";
  const selectFields = folder === "sentitems"
    ? "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,sentDateTime,internetMessageId"
    : "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId";

  let url: string;
  if (deltaToken) {
    url = deltaToken;
  } else {
    const lookback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders/${folder}/messages/delta?$select=${selectFields}&$filter=${dateField} ge ${lookback}`;
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

export async function syncMailboxDelta(mailboxId: string): Promise<{ processed: number; errors: number }> {
  const mailbox = await storage.getMonitoredMailbox(mailboxId);
  if (!mailbox || !mailbox.enabled) {
    return { processed: 0, errors: 0 };
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

      const { processUserMailboxEmailForDelta } = await import("../routes/graphWebhook");

      for (const msg of messages) {
        try {
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
          processed++;
        } catch (msgErr) {
          errors++;
          log(`Delta sync message error (${folder}): ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
        }
      }

      if (folder === "inbox") inboxToken = newDeltaToken;
      else sentToken = newDeltaToken;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log(`Delta sync error for ${mailbox.email}/${folder}: ${m}`);
      errors++;
    }
  }

  await storage.updateMonitoredMailbox(mailbox.id, {
    deltaSyncToken: inboxToken,
    sentDeltaSyncToken: sentToken,
    lastSyncAt: new Date(),
    syncStatus: errors > 0 ? "partial" : "active",
    syncError: errors > 0 ? `${errors} message(s) failed` : null,
  });

  return { processed, errors };
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
