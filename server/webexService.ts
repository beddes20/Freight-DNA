/**
 * Webex Calling API — authentication & helper methods
 *
 * Uses OAuth2 Authorization Code flow for Service Apps.
 * Admin must authorize via browser, then tokens are refreshed automatically.
 *
 * Environment variables required:
 *   WEBEX_CLIENT_ID     — Webex Service App client ID
 *   WEBEX_CLIENT_SECRET — Webex Service App client secret
 *   WEBEX_ORG_ID        — Webex organization ID
 */

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex] ${msg}`);
}

export function webexCredentialsConfigured(): boolean {
  return !!(
    process.env.WEBEX_CLIENT_ID &&
    process.env.WEBEX_CLIENT_SECRET &&
    process.env.WEBEX_ORG_ID
  );
}

export interface WebexRedirectUriInfo {
  redirectUri: string;
  source: "WEBEX_REDIRECT_URI" | "APP_URL" | "request";
  fallbackRedirectUri: string | null;
}

interface MinimalReq {
  get(name: string): string | undefined;
  protocol?: string;
}

function buildFallbackFromRequest(req?: MinimalReq): string | null {
  if (!req) return null;
  const host = req.get("host") || "localhost:5000";
  const xfProto = req.get("x-forwarded-proto");
  const protocol = (xfProto && xfProto.split(",")[0].trim()) || req.protocol || "https";
  return `${protocol}://${host}/api/webex/callback`;
}

export function getWebexRedirectUriInfo(req?: MinimalReq): WebexRedirectUriInfo {
  const explicit = process.env.WEBEX_REDIRECT_URI?.trim();
  const appUrl = process.env.APP_URL?.trim();
  const fallback = buildFallbackFromRequest(req);

  if (explicit) {
    return { redirectUri: explicit, source: "WEBEX_REDIRECT_URI", fallbackRedirectUri: fallback };
  }
  if (appUrl) {
    return {
      redirectUri: `${appUrl.replace(/\/$/, "")}/api/webex/callback`,
      source: "APP_URL",
      fallbackRedirectUri: fallback,
    };
  }
  return {
    redirectUri: fallback ?? "http://localhost:5000/api/webex/callback",
    source: "request",
    fallbackRedirectUri: null,
  };
}

export function getWebexRedirectUri(req?: MinimalReq): string {
  return getWebexRedirectUriInfo(req).redirectUri;
}

let _cachedToken: { token: string; expiresAt: number } | null = null;
let _refreshToken: string | null = null;
let _needsReauth: boolean = false;
let _lastRefreshError: string | null = null;
let _lastRefreshAt: number | null = null;
let _onRefreshTokenRotated: ((token: string) => Promise<void> | void) | null = null;
let _onNeedsReauth: ((reason: string) => Promise<void> | void) | null = null;

export function setWebexRefreshTokenRotatedHandler(
  fn: ((token: string) => Promise<void> | void) | null,
) {
  _onRefreshTokenRotated = fn;
}

export function setWebexNeedsReauthHandler(
  fn: ((reason: string) => Promise<void> | void) | null,
) {
  _onNeedsReauth = fn;
}

export function webexNeedsReauth(): boolean {
  return _needsReauth;
}

export interface WebexAuthState {
  configured: boolean;
  hasRefreshToken: boolean;
  needsReauth: boolean;
  accessTokenExpiresAt: number | null;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
}

export function getWebexAuthState(): WebexAuthState {
  return {
    configured: webexCredentialsConfigured(),
    hasRefreshToken: !!_refreshToken,
    needsReauth: _needsReauth,
    accessTokenExpiresAt: _cachedToken?.expiresAt ?? null,
    lastRefreshAt: _lastRefreshAt,
    lastRefreshError: _lastRefreshError,
  };
}

function isInvalidGrantError(status: number, body: string): boolean {
  if (status === 400 || status === 401) {
    const lower = body.toLowerCase();
    if (
      lower.includes("invalid_grant") ||
      lower.includes("invalid refresh") ||
      lower.includes("token has been revoked") ||
      lower.includes("revoked") ||
      lower.includes("expired")
    ) {
      return true;
    }
  }
  return false;
}

export function getWebexOAuthUrl(redirectUri: string): string {
  const clientId = process.env.WEBEX_CLIENT_ID!.trim();
  const scopes = "spark:calls_read spark:people_read spark:calls_write";
  const state = "webex_oauth_" + Date.now();
  return (
    `https://webexapis.com/v1/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}`
  );
}

export async function exchangeWebexCode(code: string, redirectUri: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const clientId = process.env.WEBEX_CLIENT_ID!.trim();
  const clientSecret = process.env.WEBEX_CLIENT_SECRET!.trim();

  const res = await fetch("https://webexapis.com/v1/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to exchange Webex auth code: ${res.status} ${text}`);
  }

  const data = await res.json();
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 43200) * 1000,
  };
  _refreshToken = data.refresh_token;
  _needsReauth = false;
  _lastRefreshError = null;
  _lastRefreshAt = Date.now();
  log("OAuth tokens obtained via authorization code");
  return data;
}

export function setWebexRefreshToken(token: string) {
  _refreshToken = token;
  _cachedToken = null;
  _needsReauth = false;
  _lastRefreshError = null;
}

/**
 * Force the in-memory needs-reauth flag on without firing the
 * `onNeedsReauth` handler. Used at boot to restore the disconnected state
 * from persistent storage so follow-up reminders keep firing across
 * process restarts.
 */
export function markWebexNeedsReauth(reason: string): void {
  _needsReauth = true;
  _refreshToken = null;
  _cachedToken = null;
  if (reason) {
    _lastRefreshError = reason.slice(0, 500);
  }
}

export function hasWebexTokens(): boolean {
  return !!_refreshToken && !_needsReauth;
}

export async function getWebexAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 30_000) {
    return _cachedToken.token;
  }
  return refreshWebexAccessToken();
}

export async function refreshWebexAccessToken(): Promise<string> {
  if (!webexCredentialsConfigured()) {
    throw new Error(
      "Webex credentials are not configured. Set WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET, and WEBEX_ORG_ID."
    );
  }

  if (!_refreshToken) {
    throw new Error(
      "Webex not authorized. An admin must complete the OAuth flow at /api/webex/authorize first."
    );
  }

  if (_needsReauth) {
    throw new Error(
      "Webex re-authorization required. The stored refresh token was rejected by Webex."
    );
  }

  const clientId = process.env.WEBEX_CLIENT_ID!.trim();
  const clientSecret = process.env.WEBEX_CLIENT_SECRET!.trim();

  const res = await fetch("https://webexapis.com/v1/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: _refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    _lastRefreshError = `${res.status} ${text}`.slice(0, 500);
    if (isInvalidGrantError(res.status, text)) {
      const reason = `refresh_token rejected (${res.status}): ${text.slice(0, 200)}`;
      _refreshToken = null;
      _cachedToken = null;
      const wasAlreadyNeedingReauth = _needsReauth;
      _needsReauth = true;
      log(`Refresh token rejected (${res.status}) — re-authorization required`);
      if (!wasAlreadyNeedingReauth && _onNeedsReauth) {
        try {
          await _onNeedsReauth(reason);
        } catch (e) {
          log(`onNeedsReauth handler error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error(
        `Webex re-authorization required: ${res.status} ${text}`
      );
    }
    log(`Refresh failed (transient): ${res.status} ${text}`);
    throw new Error(`Failed to refresh Webex access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 43200) * 1000,
  };
  _lastRefreshError = null;
  _lastRefreshAt = Date.now();
  if (data.refresh_token && data.refresh_token !== _refreshToken) {
    _refreshToken = data.refresh_token;
    if (_onRefreshTokenRotated) {
      try {
        await _onRefreshTokenRotated(data.refresh_token);
      } catch (e) {
        log(`onRefreshTokenRotated handler error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  log(`Access token refreshed (expires in ${Math.round(((_cachedToken.expiresAt - Date.now()) / 1000) / 60)} min)`);
  return _cachedToken.token;
}

export function getWebexAccessTokenExpiresAt(): number | null {
  return _cachedToken?.expiresAt ?? null;
}

export interface WebexCallRecord {
  id: string;
  callingNumber: string;
  calledNumber: string;
  direction: "ORIGINATING" | "TERMINATING";
  answered: boolean;
  duration: number;
  startTime: string;
  answerTime?: string;
  releaseTime?: string;
  callType: string;
  userType?: string;
  correlationId?: string;
  location?: string;
  recordingId?: string;
  voicemailLeft?: boolean;
}

export interface WebexPerson {
  id: string;
  emails: string[];
  phoneNumbers?: Array<{ type: string; value: string }>;
  displayName: string;
  status?: string;
  lastActivity?: string;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9+]/g, "").replace(/^(\+?1)/, "+1");
}

export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na === nb) return true;
  if (na.endsWith(nb) || nb.endsWith(na)) return true;
  const da = na.replace(/^\+?1/, "");
  const db = nb.replace(/^\+?1/, "");
  return da.length >= 7 && da === db;
}

export async function fetchCallHistory(
  startTime: string,
  endTime: string,
  maxRecords = 200,
): Promise<WebexCallRecord[]> {
  const token = await getWebexAccessToken();
  const orgId = process.env.WEBEX_ORG_ID!;

  const allRecords: WebexCallRecord[] = [];
  let nextUrl: string | null = null;

  const params = new URLSearchParams({
    orgId,
    startTime,
    endTime,
    max: String(Math.min(maxRecords, 50)),
  });

  let url: string = `https://webexapis.com/v1/telephony/calls/history?${params.toString()}`;

  while (url && allRecords.length < maxRecords) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      log(`Call history fetch error ${res.status}: ${text}`);
      break;
    }

    const data = await res.json();
    const items = data.items ?? [];

    for (const item of items) {
      if (allRecords.length >= maxRecords) break;

      const direction = (item.direction ?? "").toUpperCase();
      const callOutcome = (item.callResult ?? item.callOutcome ?? "").toLowerCase();
      const answered = callOutcome === "success" || callOutcome === "connected" ||
        (item.answered === true) || (item.duration > 0 && callOutcome !== "missed");

      allRecords.push({
        id: item.id ?? item.callId ?? "",
        callingNumber: item.callingNumber ?? item.callingLineId ?? "",
        calledNumber: item.calledNumber ?? item.calledLineId ?? "",
        direction: direction === "ORIGINATING" ? "ORIGINATING" : "TERMINATING",
        answered,
        duration: parseInt(item.duration ?? item.durationSeconds ?? "0", 10),
        startTime: item.startTime ?? item.time ?? "",
        answerTime: item.answerTime ?? item.answerIndicator,
        releaseTime: item.releaseTime,
        callType: item.callType ?? item.originalReason ?? "unknown",
        correlationId: item.correlationId,
        location: item.location ?? item.siteName,
        recordingId: item.recordingId,
        voicemailLeft: item.voicemailLeft === true,
      });
    }

    const linkHeader = res.headers.get("link");
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1] : "";
    } else {
      url = "";
    }
  }

  log(`Fetched ${allRecords.length} call history records`);
  return allRecords;
}

export async function fetchWebexPeople(
  phoneOrEmail: string,
): Promise<WebexPerson[]> {
  const token = await getWebexAccessToken();
  const orgId = process.env.WEBEX_ORG_ID!;

  const params = new URLSearchParams({ orgId });
  if (phoneOrEmail.includes("@")) {
    params.set("email", phoneOrEmail);
  } else {
    params.set("phoneNumber", phoneOrEmail);
  }

  const url = `https://webexapis.com/v1/people?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return [];

  const data = await res.json();
  return (data.items ?? []).map((p: any) => ({
    id: p.id,
    emails: p.emails ?? [],
    phoneNumbers: p.phoneNumbers ?? [],
    displayName: p.displayName ?? "",
    status: p.status ?? "unknown",
    lastActivity: p.lastActivity,
  }));
}

export async function fetchPersonStatus(personId: string): Promise<string> {
  const token = await getWebexAccessToken();

  const url = `https://webexapis.com/v1/people/${encodeURIComponent(personId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return "unknown";

  const data = await res.json();
  return data.status ?? "unknown";
}

export async function fetchCallRecording(recordingId: string): Promise<Buffer | null> {
  const token = await getWebexAccessToken();

  const metaUrl = `https://webexapis.com/v1/recordings/${encodeURIComponent(recordingId)}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!metaRes.ok) {
    log(`Recording metadata fetch error ${metaRes.status}`);
    return null;
  }

  const meta = await metaRes.json();
  const downloadUrl = meta.temporaryDirectDownloadLinks?.audioDownloadLink;
  if (!downloadUrl) {
    log("No audio download link available for recording");
    return null;
  }

  const audioRes = await fetch(downloadUrl);
  if (!audioRes.ok) {
    log(`Recording download error ${audioRes.status}`);
    return null;
  }

  const arrayBuffer = await audioRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function buildWebexCallDeepLink(phoneNumber: string): string {
  const cleaned = phoneNumber.replace(/[^0-9+]/g, "");
  return `webextel://${cleaned}`;
}
