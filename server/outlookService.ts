/**
 * Microsoft Graph API — Outlook email sender
 *
 * Uses the Client Credentials (app-only) flow with Mail.Send application permission.
 * Sends from the logged-in user's own Outlook mailbox via /users/{userEmail}/messages
 * so the email appears to come from them natively (shows in their Sent Items, etc.).
 * A Reply-To header pointing at OUTLOOK_REPLY_EMAIL funnels all carrier replies to
 * one central monitored mailbox for reply-tracking regardless of who sent the email.
 *
 * Environment variables required:
 *   OUTLOOK_TENANT_ID      — Azure AD tenant ID
 *   OUTLOOK_CLIENT_ID      — Azure app registration client ID
 *   OUTLOOK_CLIENT_SECRET  — Azure app registration client secret
 *   OUTLOOK_REPLY_EMAIL    — Central mailbox watched for inbound replies (webhook)
 */

import { getGraphAccessToken, azureCredentialsConfigured } from "./graphService";
import { isEmailLiveModeOn } from "./emailGate";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [outlook] ${msg}`);
}

export function outlookEnabled(): boolean {
  return azureCredentialsConfigured();
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
}

export interface OutlookSendResult {
  ok: boolean;
  error?: string;
  internetMessageId?: string;
}

export async function sendOutlookEmail(opts: OutlookSendOptions): Promise<OutlookSendResult> {
  if (!outlookEnabled()) {
    return { ok: false, error: "Outlook not configured. Set OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET." };
  }

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

    // Send via /sendMail — only requires Mail.Send (no Mail.ReadWrite needed).
    const sendMailUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.fromEmail)}/sendMail`;
    const sendRes = await fetch(sendMailUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (sendRes.status !== 202) {
      const errorText = await sendRes.text();
      log(`Graph API error ${sendRes.status} sending to ${opts.toEmail}: ${errorText}`);
      return { ok: false, error: `Graph API error ${sendRes.status}: ${errorText}` };
    }

    log(`Email sent from ${opts.fromEmail} to ${opts.toEmail}: "${opts.subject}"`);

    // After a successful send, query SentItems to retrieve the internetMessageId for
    // reply tracking. This uses Mail.Read (already required for reply tracking) and
    // avoids the Mail.ReadWrite permission that create-draft would require.
    // The time-bound filter (sentDateTime in the last 60s) prevents mis-association
    // with older messages sharing the same recipient/subject.
    // If the query fails (e.g. Mail.Read not yet granted), degrade gracefully.
    let internetMessageId: string | undefined;
    try {
      // Bound the search to messages sent from 5s before this call to allow for
      // slight clock skew — Graph typically makes sent messages available within seconds.
      const windowStart = new Date(Date.now() - 5_000).toISOString();
      // OData string literals use single-quote escaping ('' for '); do NOT
      // URI-encode individual predicate values — only encode the final $filter once.
      const odataRecipient = opts.toEmail.replace(/'/g, "''");
      const odataSubject = opts.subject.replace(/'/g, "''");
      const filter = [
        `toRecipients/any(r:r/emailAddress/address eq '${odataRecipient}')`,
        `subject eq '${odataSubject}'`,
        `sentDateTime ge ${windowStart}`,
      ].join(" and ");
      const sentQuery = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.fromEmail)}/mailFolders/sentitems/messages` +
        `?$filter=${encodeURIComponent(filter)}&$orderby=sentDateTime desc&$top=1&$select=internetMessageId`;
      const sentRes = await fetch(sentQuery, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (sentRes.ok) {
        const sentData = await sentRes.json() as { value: Array<{ internetMessageId?: string }> };
        const raw = sentData.value?.[0]?.internetMessageId;
        if (raw) {
          internetMessageId = raw.replace(/[<>]/g, "");
          log(`Captured internetMessageId for outbound email to ${opts.toEmail}: ${internetMessageId}`);
        }
      }
    } catch {
      // Non-fatal — outbound send succeeded; reply tracking will fall back to subject matching
    }

    return { ok: true, internetMessageId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Exception sending email: ${msg}`);
    return { ok: false, error: msg };
  }
}
