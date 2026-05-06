/**
 * Shared Microsoft Graph API authentication helper
 *
 * Uses the Client Credentials (app-only) flow to obtain an access token
 * for the Microsoft Graph API. This token is shared between Outlook email
 * and OneDrive sync functionality.
 *
 * Environment variables required:
 *   OUTLOOK_TENANT_ID      — Azure AD tenant ID
 *   OUTLOOK_CLIENT_ID      — Azure app registration client ID
 *   OUTLOOK_CLIENT_SECRET  — Azure app registration client secret
 */

import { resilientFetch } from "./lib/httpRetry";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graph] ${msg}`);
}

export function azureCredentialsConfigured(): boolean {
  return !!(
    process.env.OUTLOOK_TENANT_ID &&
    process.env.OUTLOOK_CLIENT_ID &&
    process.env.OUTLOOK_CLIENT_SECRET
  );
}

let _cachedToken: { token: string; expiresAt: number } | null = null;

export async function getGraphAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 30_000) {
    return _cachedToken.token;
  }

  if (!azureCredentialsConfigured()) {
    throw new Error(
      "Azure credentials are not configured. Set OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET."
    );
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

  const res = await resilientFetch("graph", () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }));

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get Graph access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  log("Access token obtained/refreshed");
  return _cachedToken.token;
}
