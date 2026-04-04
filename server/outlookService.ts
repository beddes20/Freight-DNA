/**
 * Microsoft Graph API — Outlook email sender
 *
 * Uses the Client Credentials (app-only) flow with delegated "send on behalf of"
 * semantics. The app impersonates the logged-in user's Outlook mailbox using
 * the /users/{email}/sendMail endpoint (requires Mail.Send application permission
 * in Azure, which you must grant as an admin in the Azure Portal).
 *
 * Environment variables required:
 *   OUTLOOK_TENANT_ID      — Azure AD tenant ID
 *   OUTLOOK_CLIENT_ID      — Azure app registration client ID
 *   OUTLOOK_CLIENT_SECRET  — Azure app registration client secret
 */

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [outlook] ${msg}`);
}

export function outlookEnabled(): boolean {
  return !!(
    process.env.OUTLOOK_TENANT_ID &&
    process.env.OUTLOOK_CLIENT_ID &&
    process.env.OUTLOOK_CLIENT_SECRET
  );
}

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 30_000) {
    return _cachedToken.token;
  }

  const tenantId = process.env.OUTLOOK_TENANT_ID!;
  const clientId = process.env.OUTLOOK_CLIENT_ID!;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET!;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return _cachedToken.token;
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
}

export async function sendOutlookEmail(opts: OutlookSendOptions): Promise<{ ok: boolean; error?: string }> {
  if (!outlookEnabled()) {
    return { ok: false, error: "Outlook not configured. Set OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET." };
  }

  try {
    const token = await getAccessToken();

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

    const payload = {
      message,
      saveToSentItems: opts.saveToSentItems !== false,
    };

    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.fromEmail)}/sendMail`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 202) {
      log(`Email sent from ${opts.fromEmail} to ${opts.toEmail}: "${opts.subject}"`);
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
