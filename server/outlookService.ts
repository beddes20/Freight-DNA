/**
 * Microsoft Graph API — Outlook email sender
 *
 * Uses the Client Credentials (app-only) flow with delegated "send on behalf of"
 * semantics. The app impersonates the logged-in user's Outlook mailbox using
 * either:
 *   (a) Two-step: POST /users/{email}/messages → POST .../send  (captures messageId + conversationId)
 *   (b) One-step: POST /users/{email}/sendMail                  (HTTP 202, no body — legacy fallback)
 *
 * Reply routing model: by default carrier replies hit the sending rep's own
 * monitored M365 mailbox (per-rep model). Callers may also pass an
 * `outlookReplyTo` to override the Reply-To header on a per-send basis,
 * but that path is gated upstream on `replyTrackingEnabled()` so a stale
 * shared mailbox cannot silently swallow replies (Task #959).
 *
 * Environment variables required:
 *   OUTLOOK_TENANT_ID      — Azure AD tenant ID
 *   OUTLOOK_CLIENT_ID      — Azure app registration client ID
 *   OUTLOOK_CLIENT_SECRET  — Azure app registration client secret
 */

import { getGraphAccessToken, azureCredentialsConfigured } from "./graphService";
import { isEmailLiveModeOn } from "./emailGate";
import { resilientFetch } from "./lib/httpRetry";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [outlook] ${msg}`);
}

export function outlookEnabled(): boolean {
  return azureCredentialsConfigured();
}

export interface OutlookFileAttachment {
  name: string;
  contentType: string;
  /** Base64-encoded file contents (matches Microsoft Graph `contentBytes`). */
  contentBase64: string;
}

export interface OutlookSendOptions {
  fromEmail: string;
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
  isHtml?: boolean;
  ccEmails?: string[];
  saveToSentItems?: boolean;
  /** If set, adds a Reply-To header so carrier replies go to this central mailbox
   *  rather than back to the individual sender's inbox. Used for reply tracking. */
  replyToEmail?: string;
  /**
   * File attachments. Inline-attached on the draft (Graph supports up to ~3MB
   * per attachment this way; larger attachments require an upload session and
   * are intentionally not supported here — the POD intake pipeline rejects
   * attachments above 3MB and surfaces them in the admin UI for manual handling).
   */
  attachments?: OutlookFileAttachment[];
}

export interface OutlookSendResult {
  ok: boolean;
  error?: string;
  internetMessageId?: string;
  providerMessageId?: string;
  conversationId?: string;
}

/**
 * Send an email via Microsoft Graph and return the message + conversation IDs.
 *
 * Strategy: two-step create-then-send so we can read the Graph-assigned
 * messageId and conversationId from the created draft before sending.
 * Falls back to the simpler one-step sendMail if the draft create fails.
 */
export async function sendOutlookEmail(opts: OutlookSendOptions): Promise<OutlookSendResult> {
  if (!isEmailLiveModeOn()) {
    log(`[SUPPRESSED] Live mode is OFF — Outlook email to ${opts.toEmail} ("${opts.subject}") was blocked. Enable Email Live Mode in Admin to send for real.`);
    return { ok: true };
  }


  try {
    const token = await getGraphAccessToken();

    const toRecipients = [
      {
        emailAddress: {
          address: opts.toEmail,
          name: opts.toName || opts.toEmail,
        },
      },
    ];

    const ccRecipients = (opts.ccEmails || []).map(addr => ({
      emailAddress: { address: addr },
    }));

    const message: Record<string, unknown> = {
      subject: opts.subject,
      body: {
        contentType: opts.isHtml !== false ? "HTML" : "Text",
        content: opts.body,
      },
      toRecipients,
    };

    if (ccRecipients.length > 0) {
      message.ccRecipients = ccRecipients;
    }

    // Reply-To: funnels carrier replies to the central monitored mailbox so
    // reply tracking works regardless of which team member sent the email.
    if (opts.replyToEmail) {
      message.replyTo = [{ emailAddress: { address: opts.replyToEmail } }];
    }

    // Inline file attachments (≤3MB each). Anything larger should be uploaded
    // through Graph's chunked upload session — caller is expected to filter.
    if (opts.attachments && opts.attachments.length > 0) {
      message.attachments = opts.attachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBase64,
      }));
    }

    const encodedFrom = encodeURIComponent(opts.fromEmail);

    // ── Two-step: create draft → read IDs → send ──────────────────────────
    try {
      const createUrl = `https://graph.microsoft.com/v1.0/users/${encodedFrom}/messages`;
      const createRes = await resilientFetch("graph", () => fetch(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      }));

      if (createRes.ok) {
        const draft = await createRes.json() as { id?: string; conversationId?: string; internetMessageId?: string };
        const draftId = draft.id;
        const conversationId = draft.conversationId;
        const internetMessageId = draft.internetMessageId ? draft.internetMessageId.replace(/[<>]/g, "") : undefined;

        if (!draftId) {
          throw new Error("Graph createMessage returned no id");
        }

        // Send the draft
        const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodedFrom}/messages/${encodeURIComponent(draftId)}/send`;
        const sendRes = await resilientFetch("graph", () => fetch(sendUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }));

        if (sendRes.status === 202) {
          log(`Email sent (two-step) from ${opts.fromEmail} to ${opts.toEmail}: "${opts.subject}" [msgId=${draftId}]`);
          return { ok: true, providerMessageId: draftId, conversationId, internetMessageId };
        }

        const errText = await sendRes.text();
        log(`Graph send error ${sendRes.status} for draft ${draftId}: ${errText}`);
        // Fall through to one-step sendMail
      } else {
        const errText = await createRes.text();
        log(`Graph createMessage error ${createRes.status}: ${errText} — falling back to sendMail`);
        // Fall through to one-step sendMail
      }
    } catch (draftErr) {
      log(`Two-step send failed: ${draftErr instanceof Error ? draftErr.message : String(draftErr)} — falling back to sendMail`);
    }

    // ── Fallback: one-step sendMail (HTTP 202, no IDs returned) ──────────
    const url = `https://graph.microsoft.com/v1.0/users/${encodedFrom}/sendMail`;
    const res = await resilientFetch("graph", () => fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: opts.saveToSentItems !== false }),
    }));

    if (res.status === 202) {
      log(`Email sent (one-step) from ${opts.fromEmail} to ${opts.toEmail}: "${opts.subject}"`);
      return { ok: true };
    }

    const errorText = await res.text();
    log(`Graph API error ${res.status} sending to ${opts.toEmail}: ${errorText}`);
    return { ok: false, error: `Graph API error ${res.status}: ${errorText}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Exception sending email: ${msg}`);
    return { ok: false, error: msg };
  }
}
