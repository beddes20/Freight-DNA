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

/**
 * Resilient Webex fetch wrapper (Task #466). Honors `Retry-After` on 429s,
 * uses exponential backoff (250ms → 500ms → 1s → 2s capped at 10s) on
 * transient 5xx, and surfaces a normalized result so callers can fail per
 * record instead of breaking the whole sync loop.
 *
 * Returns `{ ok, status, data, error, retried }`. `data` is `null` if the
 * response wasn't JSON. Auth (401) is treated as terminal — caller decides
 * whether to mark a token as needs-reauth.
 */
export interface WebexFetchResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  retried: number;
  /** Raw response so callers can read pagination headers etc. */
  response: Response | null;
}

export async function webexFetch<T = any>(
  url: string,
  init: RequestInit & { token?: string; maxRetries?: number } = {},
): Promise<WebexFetchResult<T>> {
  const { token, maxRetries = 4, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    ...(headers as Record<string, string> | undefined),
  };
  if (token && !finalHeaders.Authorization) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }

  let attempt = 0;
  let lastError = "";
  let lastStatus = 0;
  let lastResponse: Response | null = null;
  while (attempt <= maxRetries) {
    let res: Response;
    try {
      res = await fetch(url, { ...rest, headers: finalHeaders });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = 0;
      const wait = Math.min(10_000, 250 * 2 ** attempt);
      attempt++;
      if (attempt > maxRetries) break;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    lastResponse = res;
    lastStatus = res.status;

    if (res.ok) {
      let data: T | null = null;
      try {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("json")) data = (await res.json()) as T;
      } catch {
        data = null;
      }
      return { ok: true, status: res.status, data, error: null, retried: attempt, response: res };
    }

    // 401 is terminal — caller should refresh token / mark reauth.
    if (res.status === 401 || res.status === 403) {
      const text = await safeReadText(res);
      return { ok: false, status: res.status, data: null, error: text || `HTTP ${res.status}`, retried: attempt, response: res };
    }

    // 429: honor Retry-After (seconds, optionally HTTP date).
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = parseRetryAfter(retryAfter) ?? Math.min(30_000, 1_000 * 2 ** attempt);
      lastError = `429 rate limited (retry-after ${retryAfter ?? "unknown"})`;
      attempt++;
      if (attempt > maxRetries) break;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // 5xx: exponential backoff.
    if (res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      const wait = Math.min(10_000, 250 * 2 ** attempt);
      attempt++;
      if (attempt > maxRetries) break;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // 4xx other than 401/403/429: terminal client error.
    const text = await safeReadText(res);
    return { ok: false, status: res.status, data: null, error: text || `HTTP ${res.status}`, retried: attempt, response: res };
  }

  return { ok: false, status: lastStatus, data: null, error: lastError || "fetch failed", retried: attempt, response: lastResponse };
}

async function safeReadText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500); } catch { return ""; }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.max(0, Math.min(60_000, sec * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(60_000, date - Date.now()));
  return null;
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

/**
 * Bumped whenever WEBEX_OAUTH_SCOPES changes. Stored on each per-user token
 * row so the boot reconciler can mark older grants as `needs_reauth` and
 * force a one-time reconnect that grants the new analytics-enabled scopes.
 */
export const WEBEX_SCOPES_VERSION = 2;

/**
 * Full analytics-enabled scope set (Task #466). Personal tokens that lack
 * admin grants will silently 403 on org-only endpoints — callers must
 * degrade gracefully (handled inside webexFetch + sync_state.last_error).
 *
 * Scope reference: https://developer.webex.com/docs/integrations#scopes
 */
export const WEBEX_OAUTH_SCOPES = [
  // Original (Task #261)
  "spark:calls_read",
  "spark:people_read",
  "spark:calls_write",
  // Analytics + admin telephony (Task #466)
  "analytics:read_all",
  "spark-admin:telephony_config_read",
  "spark-admin:people_read",
  "spark-admin:devices_read",
  "spark-admin:workspaces_read",
  "spark-admin:locations_read",
  "spark:recordings_read",
  "spark:voicemails_read",
  "spark:voicemail_write",
].join(" ");

export function getWebexOAuthUrl(redirectUri: string, state?: string): string {
  const clientId = process.env.WEBEX_CLIENT_ID!.trim();
  const s = state ?? "webex_oauth_" + Date.now();
  return (
    `https://webexapis.com/v1/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(WEBEX_OAUTH_SCOPES)}` +
    `&state=${encodeURIComponent(s)}`
  );
}

export interface WebexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

/**
 * Stateless Webex auth-code exchange used for per-user OAuth connections
 * (Task #261). Does NOT mutate the module-level org token cache.
 */
export async function exchangeWebexCodeStateless(code: string, redirectUri: string): Promise<WebexTokenResponse> {
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
  return res.json() as Promise<WebexTokenResponse>;
}

export class WebexRefreshRevokedError extends Error {
  constructor(public status: number, public body: string) {
    super(`Webex refresh token rejected (${status}): ${body.slice(0, 200)}`);
    this.name = "WebexRefreshRevokedError";
  }
}

/**
 * Stateless refresh for a per-user token (Task #261). Throws
 * `WebexRefreshRevokedError` on invalid_grant so callers can flag the user's
 * token as needing re-authorization.
 */
export async function refreshWebexAccessTokenWith(refreshToken: string): Promise<WebexTokenResponse> {
  if (!webexCredentialsConfigured()) {
    throw new Error("Webex credentials are not configured.");
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
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    if (isInvalidGrantError(res.status, text)) {
      throw new WebexRefreshRevokedError(res.status, text);
    }
    throw new Error(`Failed to refresh Webex access token: ${res.status} ${text}`);
  }
  return res.json() as Promise<WebexTokenResponse>;
}

/**
 * Fetch the authenticated Webex user's own profile (Task #261) using a
 * per-user access token. Used to capture personId/email/displayName when a
 * rep connects their account.
 */
export async function fetchWebexMe(accessToken: string): Promise<WebexPerson | null> {
  const res = await fetch("https://webexapis.com/v1/people/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    log(`fetchWebexMe error ${res.status}`);
    return null;
  }
  const p = await res.json();
  return {
    id: p.id,
    emails: p.emails ?? [],
    phoneNumbers: p.phoneNumbers ?? [],
    displayName: p.displayName ?? (p.emails?.[0] ?? ""),
    status: p.status ?? "unknown",
    lastActivity: p.lastActivity,
  };
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

export interface WebexDevice {
  id: string;
  name?: string;
  displayName?: string;
  type?: string;
  mac?: string;
  serial?: string;
  personId?: string;
  workspaceId?: string;
  orgId?: string;
  ipAddress?: string;
  product?: string;
  productType?: string;
  software?: string;
  connectionStatus?: string;
  lastConnectionTime?: string;
  lastConnectionAt?: string;
  created?: string;
  deviceId?: string;
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
  /** Webex internal person id of the user that placed/received this call. */
  webexPersonId?: string;
  /** Webex email of the user that placed/received this call (when available). */
  webexUserEmail?: string;
  // ── Device metadata fields (HEAD) ──────────────────────────────────
  /** Raw Webex client type — e.g., WXC_CLIENT, WXC_DEVICE, WXC_THIRD_PARTY. */
  clientType?: string;
  /** Raw Webex OS type — e.g., IOS, ANDROID, WINDOWS, MAC, LINUX, OTHER. */
  osType?: string;
  /** Hardware MAC of the device used (when reported), e.g. for desk phones. */
  deviceMac?: string;
  /** Vendor model of the device, e.g. "Cisco 8865". */
  deviceModel?: string;
  /** Headset/accessory model when the call was placed via a paired headset. */
  headsetModel?: string;
  /** Headset/accessory vendor name when reported. */
  headsetMake?: string;
  // ── Detailed analytics fields (Task #315) ────────────────────────────
  /** Talk time in seconds (time with both legs off-hold). Optional: only
   *  present when the Webex response exposes talk-time analytics fields. */
  talkTimeSeconds?: number;
  /** Total seconds this call was put on hold by the rep. */
  holdTimeSeconds?: number;
  /** "Dead air" / silence window in seconds, when Webex exposes it. */
  silenceSeconds?: number;
  /** Ring duration before answer (in seconds). */
  ringTimeSeconds?: number;
  /** Mean Opinion Score (1.0–5.0 scale) when Webex reports it. */
  mosScore?: number;
  /** Average jitter in milliseconds. */
  jitterMs?: number;
  /** Packet loss percentage (0–100). */
  packetLossPct?: number;
}

/**
 * Best-effort extraction of detailed call-quality/talk-time metrics from
 * any of the shapes Webex returns across CDR, detailed-call, and analytics
 * responses. All fields are optional — missing metrics stay undefined and
 * downstream code is expected to degrade gracefully.
 */
function extractCallAnalyticsFromItem(item: any): {
  talkTimeSeconds?: number;
  holdTimeSeconds?: number;
  silenceSeconds?: number;
  ringTimeSeconds?: number;
  mosScore?: number;
  jitterMs?: number;
  packetLossPct?: number;
} {
  const num = (v: any): number | undefined => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const quality = item?.callQuality ?? item?.quality ?? item?.mediaQuality ?? {};
  const talk = num(item.talkTime ?? item.talkTimeSeconds ?? item.talkDuration ?? item.conversationDuration);
  const hold = num(item.holdTime ?? item.holdTimeSeconds ?? item.holdDuration ?? item.totalHoldTime);
  const silence = num(item.silenceTime ?? item.silenceSeconds ?? item.deadAir ?? item.deadAirSeconds);
  const ring = num(item.ringTime ?? item.ringTimeSeconds ?? item.ringDuration ?? item.alertingDuration);
  const mos = num(item.averageMOS ?? item.avgMos ?? item.mos ?? quality.averageMos ?? quality.mos);
  const jitter = num(item.averageJitter ?? item.avgJitter ?? item.jitter ?? quality.averageJitter ?? quality.jitter);
  const packetLoss = num(
    item.packetLoss ?? item.packetLossPercent ?? item.averagePacketLoss ?? quality.packetLoss ?? quality.averagePacketLoss,
  );
  return {
    talkTimeSeconds: talk !== undefined ? Math.round(talk) : undefined,
    holdTimeSeconds: hold !== undefined ? Math.round(hold) : undefined,
    silenceSeconds: silence !== undefined ? Math.round(silence) : undefined,
    ringTimeSeconds: ring !== undefined ? Math.round(ring) : undefined,
    mosScore: mos,
    jitterMs: jitter,
    packetLossPct: packetLoss,
  };
}

/**
 * Compute a coarse letter grade from raw quality metrics. Returns null when
 * no quality signal is available so the UI can show "—".
 *
 * Thresholds roughly follow Webex Control Hub's quality buckets:
 *   A: MOS ≥ 4.2, jitter ≤ 30ms, loss ≤ 1%
 *   B: MOS ≥ 3.8, jitter ≤ 50ms, loss ≤ 2%
 *   C: MOS ≥ 3.3, jitter ≤ 80ms, loss ≤ 4%
 *   D: anything worse
 */
export function gradeCallQuality(metrics: {
  mosScore?: number | null;
  jitterMs?: number | null;
  packetLossPct?: number | null;
}): string | null {
  const { mosScore, jitterMs, packetLossPct } = metrics;
  if (mosScore == null && jitterMs == null && packetLossPct == null) return null;
  const mos = mosScore ?? 4.3;
  const jit = jitterMs ?? 0;
  const loss = packetLossPct ?? 0;
  if (mos >= 4.2 && jit <= 30 && loss <= 1) return "A";
  if (mos >= 3.8 && jit <= 50 && loss <= 2) return "B";
  if (mos >= 3.3 && jit <= 80 && loss <= 4) return "C";
  return "D";
}

/**
 * Fetch detailed per-call analytics for a specific Webex call id.
 * Used as a best-effort enrichment; returns null if the detail endpoint
 * isn't available (e.g. missing analytics scope on the org token).
 */
export async function fetchCallDetail(
  callId: string,
  accessToken?: string,
  onFailure?: WebexHttpOptions["onFailure"],
): Promise<{
  talkTimeSeconds?: number;
  holdTimeSeconds?: number;
  silenceSeconds?: number;
  ringTimeSeconds?: number;
  mosScore?: number;
  jitterMs?: number;
  packetLossPct?: number;
} | null> {
  if (!callId) return null;
  const url = `https://webexapis.com/v1/telephony/calls/${encodeURIComponent(callId)}`;
  const r = await webexFetch<any>(url, { accessToken, onFailure });
  if (!r.ok || !r.data) return null;
  return extractCallAnalyticsFromItem(r.data);
}

export interface WebexPerson {
  id: string;
  emails: string[];
  phoneNumbers?: Array<{ type: string; value: string }>;
  displayName: string;
  status?: string;
  lastActivity?: string;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9+]/g, "").replace(/^(\+?1)/, "+1");
}

/**
 * Returns the last 10 digits of a phone number, used as a loose E.164-insensitive
 * match key for North American numbers. Falls back to the full digit string
 * (without country code prefix) if the number is shorter than 10 digits.
 */
export function phoneMatchKey(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.slice(-10);
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
  opts?: { accessToken?: string; scope?: "org" | "user"; onFailure?: WebexHttpOptions["onFailure"] },
): Promise<WebexCallRecord[]> {
  const scope = opts?.scope ?? (opts?.accessToken ? "user" : "org");

  const allRecords: WebexCallRecord[] = [];

  const params = new URLSearchParams({
    startTime,
    endTime,
    max: String(Math.min(maxRecords, 50)),
  });
  if (scope === "org") {
    params.set("orgId", process.env.WEBEX_ORG_ID!);
  }

  let url: string = `https://webexapis.com/v1/telephony/calls/history?${params.toString()}`;
  let consecutiveFailures = 0;

  while (url && allRecords.length < maxRecords) {
    const r = await webexFetch<any>(url, {
      accessToken: opts?.accessToken,
      onFailure: opts?.onFailure,
    });
    if (!r.ok) {
      log(`Call history fetch error ${r.status}: ${r.error ?? ""}`);
      // Continue past transient page failures up to a safety bound rather
      // than collapsing the entire sync loop on a single page error.
      consecutiveFailures++;
      if (consecutiveFailures >= 3) break;
      // Without a Link header we have nowhere to continue from, so stop.
      break;
    }
    consecutiveFailures = 0;
    const data = r.data ?? {};
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
        webexPersonId: item.userId ?? item.personId ?? item.user?.id ?? undefined,
        webexUserEmail: item.userEmail ?? item.user?.email ?? undefined,
        // Device metadata (HEAD)
        clientType: item.clientType ?? item.deviceType ?? item.device?.type ?? undefined,
        osType: item.osType ?? item.clientOsType ?? item.device?.os ?? undefined,
        deviceMac: item.deviceMac ?? item.deviceMacAddress ?? item.device?.mac ?? undefined,
        deviceModel: item.deviceModel ?? item.deviceProduct ?? undefined,
        headsetModel: item.headsetModel ?? item.accessoryModel ?? undefined,
        headsetMake: item.headsetMake ?? item.accessoryMake ?? item.accessoryType ?? undefined,
        // Analytics (Task #315)
        ...extractCallAnalyticsFromItem(item),
      });
    }

    const linkHeader = r.headers?.get("link") ?? null;
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

/**
 * Fetch all Webex people in the configured org. Paginates through the
 * `link: rel="next"` header. Returns id, emails, and displayName for each.
 */
export async function listWebexPeople(maxResults = 1000): Promise<WebexPerson[]> {
  const token = await getWebexAccessToken();
  const orgId = process.env.WEBEX_ORG_ID!;

  const all: WebexPerson[] = [];
  const params = new URLSearchParams({ orgId, max: "100" });
  let url: string = `https://webexapis.com/v1/people?${params.toString()}`;

  while (url && all.length < maxResults) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      log(`listWebexPeople error ${res.status}: ${text}`);
      break;
    }
    const data = await res.json();
    for (const p of data.items ?? []) {
      all.push({
        id: p.id,
        emails: p.emails ?? [],
        phoneNumbers: p.phoneNumbers ?? [],
        displayName: p.displayName ?? "",
        status: p.status ?? "unknown",
        lastActivity: p.lastActivity,
      });
    }
    const linkHeader = res.headers.get("link");
    if (linkHeader) {
      const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : "";
    } else {
      url = "";
    }
  }
  log(`listWebexPeople fetched ${all.length} people`);
  return all;
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

/**
 * List provisioned Webex devices in the configured organization. Used by the
 * admin Device Usage panel to surface unused/last-connected devices.
 */
export async function listWebexDevices(
  maxResults = 1000,
  onFailure?: WebexHttpOptions["onFailure"],
): Promise<WebexDevice[]> {
  const orgId = process.env.WEBEX_ORG_ID!;
  const params = new URLSearchParams({ orgId, max: "100" });
  const url = `https://webexapis.com/v1/devices?${params.toString()}`;
  const r = await webexFetchAllPages<any>(url, { maxItems: maxResults, onFailure });
  const all: WebexDevice[] = (r.items ?? []).map((d: any) => ({
    id: d.id ?? "",
    displayName: d.displayName ?? d.product ?? "Unnamed device",
    product: d.product ?? null,
    productType: d.productType ?? null,
    type: d.type ?? null,
    mac: d.mac ?? null,
    serial: d.serial ?? null,
    personId: d.personId ?? null,
    workspaceId: d.workspaceId ?? null,
    connectionStatus: d.connectionStatus ?? null,
    lastConnectionAt: d.lastSeen ?? d.lastConnectionTime ?? d.firstSeen ?? null,
    created: d.created ?? null,
  }));
  log(`listWebexDevices fetched ${all.length} devices (failed=${r.failed})`);
  return all;
}

export type DeviceCategory = "desk_app" | "mobile" | "desk_phone" | "other";

/**
 * Bucketize a Webex CDR into a coarse device category for analytics. Falls
 * back to "other" when the API doesn't report enough hints to classify.
 */
export function categorizeWebexCallDevice(record: {
  clientType?: string;
  osType?: string;
  deviceModel?: string;
}): DeviceCategory {
  const ct = (record.clientType ?? "").toUpperCase();
  const os = (record.osType ?? "").toUpperCase();
  if (ct.includes("WXC_DEVICE") || ct.includes("IP_PHONE") || ct.includes("MPP")) return "desk_phone";
  if (os === "IOS" || os === "ANDROID") return "mobile";
  if (ct.includes("MOBILE")) return "mobile";
  if (ct.includes("WXC_CLIENT") || ct.includes("WEBEX_APP") || ct.includes("CLIENT")) return "desk_app";
  if (os === "WINDOWS" || os === "MAC" || os === "LINUX") return "desk_app";
  return "other";
}

export function buildWebexCallDeepLink(phoneNumber: string): string {
  const cleaned = phoneNumber.replace(/[^0-9+]/g, "");
  return `webextel://${cleaned}`;
}

// ─── Webex Full Coverage (Task #466) — paginated org inventory pulls ────────

/**
 * Generic paginated GET — follows `Link: rel=next` headers, applies the
 * resilient webexFetch retry policy, and yields each item back. Bails on
 * the first terminal failure (returns whatever it accumulated so far).
 */
async function paginateWebex<T = any>(
  initialUrl: string,
  token: string,
  itemsKey: string = "items",
  max: number = 5_000,
): Promise<{ items: T[]; lastError: string | null; failed: boolean }> {
  const out: T[] = [];
  let url: string | null = initialUrl;
  let lastError: string | null = null;
  while (url && out.length < max) {
    const r = await webexFetch<{ [k: string]: any }>(url, { token });
    if (!r.ok || !r.data) {
      lastError = r.error;
      break;
    }
    const items = (r.data as any)?.[itemsKey] ?? [];
    for (const it of items) {
      if (out.length >= max) break;
      out.push(it as T);
    }
    const link = r.response?.headers.get("link") ?? "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return { items: out, lastError, failed: !!lastError };
}

export type WebexListResult = { items: any[]; lastError: string | null; failed: boolean };

export async function listWebexWorkspaces(maxResults = 1000, accessToken?: string): Promise<WebexListResult> {
  const token = accessToken ?? (await getWebexAccessToken());
  const orgId = process.env.WEBEX_ORG_ID!;
  const url = `https://webexapis.com/v1/workspaces?orgId=${encodeURIComponent(orgId)}&max=100`;
  return paginateWebex(url, token, "items", maxResults);
}

export async function listWebexLocations(maxResults = 1000, accessToken?: string): Promise<WebexListResult> {
  const token = accessToken ?? (await getWebexAccessToken());
  const orgId = process.env.WEBEX_ORG_ID!;
  const url = `https://webexapis.com/v1/locations?orgId=${encodeURIComponent(orgId)}&max=100`;
  return paginateWebex(url, token, "items", maxResults);
}

export async function listWebexCallQueues(maxResults = 1000, accessToken?: string): Promise<WebexListResult> {
  const token = accessToken ?? (await getWebexAccessToken());
  const orgId = process.env.WEBEX_ORG_ID!;
  const url = `https://webexapis.com/v1/telephony/config/queues?orgId=${encodeURIComponent(orgId)}&max=100`;
  return paginateWebex(url, token, "queues", maxResults);
}

export async function listWebexHuntGroups(maxResults = 1000, accessToken?: string): Promise<WebexListResult> {
  const token = accessToken ?? (await getWebexAccessToken());
  const orgId = process.env.WEBEX_ORG_ID!;
  const url = `https://webexapis.com/v1/telephony/config/huntGroups?orgId=${encodeURIComponent(orgId)}&max=100`;
  return paginateWebex(url, token, "huntGroups", maxResults);
}

/**
 * List voicemails for a per-user token. Webex exposes voicemail under
 * `/v1/telephony/voiceMessages` for the authenticated user; admin scopes
 * surface org-wide voicemail summaries via reports.
 */
export async function listWebexVoicemails(accessToken: string, maxResults = 200): Promise<WebexListResult> {
  const url = `https://webexapis.com/v1/telephony/voiceMessages?max=${Math.min(100, maxResults)}`;
  return paginateWebex(url, accessToken, "items", maxResults);
}

/**
 * Per-user voicemail listing wrapper. Same shape as listWebexVoicemails — the
 * routes layer prefers this name for clarity (per-user vs org-wide).
 */
export async function fetchUserVoicemails(accessToken: string, maxResults = 500): Promise<WebexListResult> {
  return listWebexVoicemails(accessToken, maxResults);
}

/**
 * Org-wide admin reports (usage / call quality summaries). Requires
 * `analytics:read_all` scope; non-admin tokens will get 403 and `failed=true`.
 */
export async function listWebexAdminReports(accessToken?: string, maxResults = 200): Promise<WebexListResult> {
  const token = accessToken ?? (await getWebexAccessToken());
  const url = `https://webexapis.com/v1/devices/reports?max=${Math.min(100, maxResults)}`;
  return paginateWebex(url, token, "items", maxResults);
}

/**
 * Download voicemail audio bytes for a given voicemailId. Returns null on
 * any failure so callers can mark transcription_status='failed' and move on.
 */
export async function downloadWebexVoicemailAudio(voicemailId: string, accessToken: string): Promise<Buffer | null> {
  if (!voicemailId) return null;
  const url = `https://webexapis.com/v1/telephony/voiceMessages/${encodeURIComponent(voicemailId)}/audio`;
  const res = await webexFetch(url, { token: accessToken });
  if (!res.ok || !res.response) return null;
  try {
    const ab = await res.response.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/**
 * Download voicemail audio with a structured shape that surfaces the
 * content-type for downstream Whisper transcription. Invokes `onFailure`
 * with request metadata so callers can persist into webex_api_failures.
 */
export async function fetchVoicemailAudio(
  accessToken: string,
  voicemailId: string,
  onFailure?: (info: { url: string; status: number; body: string }) => void,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!voicemailId) return null;
  const url = `https://webexapis.com/v1/telephony/voiceMessages/${encodeURIComponent(voicemailId)}/audio`;
  const res = await webexFetch(url, { token: accessToken });
  if (!res.ok || !res.response) {
    onFailure?.({ url, status: res.status, body: res.error ?? "" });
    return null;
  }
  try {
    const ab = await res.response.arrayBuffer();
    const contentType = res.response.headers.get("content-type") ?? "audio/wav";
    return { buffer: Buffer.from(ab), contentType };
  } catch (err) {
    onFailure?.({ url, status: res.status, body: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
