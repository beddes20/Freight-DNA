/**
 * Per-user Webex OAuth token service (Task #261).
 *
 * Each rep can connect their own Webex account. We persist their refresh
 * token in `webex_user_tokens` and cache the minted access token in memory
 * for the duration of its lifetime.
 *
 * Task #265 extends this with a scheduled reminder: reps whose token was
 * revoked/expired (`needsReauth = true`) receive an email nudging them to
 * reconnect from /profile, throttled to at most once every 24h via the
 * `lastReauthEmailAt` column.
 */
import { storage } from "./storage";
import {
  refreshWebexAccessTokenWith,
  exchangeWebexCodeStateless,
  fetchWebexMe,
  WebexRefreshRevokedError,
  WEBEX_OAUTH_SCOPES,
  type WebexTokenResponse,
} from "./webexService";
import { sendEmail, emailEnabled, baseEmailTemplate } from "./emailService";
import type {
  WebexUserToken,
  InsertWebexUserToken,
  InsertWebexUserMapping,
} from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-user-token] ${msg}`);
}

interface CachedAccess {
  token: string;
  expiresAt: number;
}
const _accessCache = new Map<string, CachedAccess>();

export function invalidateUserAccessCache(userId: string) {
  _accessCache.delete(userId);
}

/**
 * Flag a user's Webex connection as needing re-authorization. Clears the
 * email-reminder cooldown (via `lastReauthEmailAt = null`) so the next
 * scheduler tick emails the rep, and stamps `disconnectedAt`. Safe to call
 * when no token row exists (no-op).
 */
export async function markWebexUserNeedsReauth(
  userId: string,
  reason: string,
): Promise<void> {
  const existing = await storage.getWebexUserToken(userId);
  if (!existing) return;
  _accessCache.delete(userId);
  const updates: Partial<InsertWebexUserToken> = {
    needsReauth: true,
    reauthReason: reason.slice(0, 500),
    lastRefreshError: reason.slice(0, 500),
    lastReauthEmailAt: null,
    disconnectedAt: new Date(),
  };
  await storage.updateWebexUserToken(userId, updates);
  if (!existing.needsReauth) {
    log(`Marked user ${userId} as needs-reauth: ${reason}`);
  }
}

/**
 * Clear the re-auth flag for this rep after a successful (re)connect and
 * stamp `connectedAt` so the UI can show when they most recently linked.
 * Also clears the reminder-email fields so the hourly emailer stops
 * nudging this rep.
 */
export async function clearWebexUserNeedsReauth(userId: string): Promise<void> {
  const existing = await storage.getWebexUserToken(userId);
  if (!existing) return;
  await storage.updateWebexUserToken(userId, {
    needsReauth: false,
    reauthReason: null,
    lastRefreshError: null,
    lastReauthEmailAt: null,
    disconnectedAt: null,
    connectedAt: new Date(),
  } as any);
}

/**
 * Resolve a usable access token for the given user, refreshing if needed.
 * Returns null if the user has no stored token or is flagged for re-auth.
 */
export async function getUserWebexAccessToken(userId: string): Promise<{ token: string; record: WebexUserToken } | null> {
  const record = await storage.getWebexUserToken(userId);
  if (!record || record.needsReauth) return null;

  const cached = _accessCache.get(userId);
  if (cached && Date.now() < cached.expiresAt - 30_000) {
    return { token: cached.token, record };
  }

  try {
    const data = await refreshWebexAccessTokenWith(record.refreshToken);
    const expiresAt = Date.now() + (data.expires_in ?? 43200) * 1000;
    _accessCache.set(userId, { token: data.access_token, expiresAt });

    const updates: Partial<InsertWebexUserToken> = {
      accessTokenExpiresAt: new Date(expiresAt),
      lastRefreshAt: new Date(),
      lastRefreshError: null,
      needsReauth: false,
    };
    if (data.refresh_token && data.refresh_token !== record.refreshToken) {
      updates.refreshToken = data.refresh_token;
    }
    const updated = await storage.updateWebexUserToken(userId, updates);
    return { token: data.access_token, record: updated ?? { ...record, ...updates } as WebexUserToken };
  } catch (err) {
    if (err instanceof WebexRefreshRevokedError) {
      await markWebexUserNeedsReauth(userId, err.message || "refresh_token_revoked");
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log(`User ${userId} token refresh failed (transient): ${msg}`);
    const errUpdates: Partial<InsertWebexUserToken> = {
      lastRefreshError: msg.slice(0, 500),
    };
    await storage.updateWebexUserToken(userId, errUpdates);
    throw err;
  }
}

/**
 * Exchange an auth code (from the per-user OAuth flow) and persist the
 * refresh token against the given internal user. Also captures the Webex
 * person id, email, and display name via /v1/people/me.
 */
export async function connectUserWebex(
  orgId: string,
  userId: string,
  code: string,
  redirectUri: string,
): Promise<WebexUserToken> {
  const tokens: WebexTokenResponse = await exchangeWebexCodeStateless(code, redirectUri);
  const expiresAt = Date.now() + (tokens.expires_in ?? 43200) * 1000;

  let personId: string | null = null;
  let email: string | null = null;
  let displayName: string | null = null;
  try {
    const me = await fetchWebexMe(tokens.access_token);
    if (me) {
      personId = me.id || null;
      email = (me.emails?.[0] ?? "").toLowerCase() || null;
      displayName = me.displayName || null;
    }
  } catch (e) {
    log(`fetchWebexMe failed for user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const insert: InsertWebexUserToken = {
    orgId,
    userId,
    webexPersonId: personId,
    webexEmail: email,
    webexDisplayName: displayName,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: new Date(expiresAt),
    needsReauth: false,
    reauthReason: null,
    lastReauthEmailAt: null,
    lastRefreshAt: new Date(),
    lastRefreshError: null,
    scopes: tokens.scope ?? WEBEX_OAUTH_SCOPES,
    disconnectedAt: null,
  };
  let record = await storage.upsertWebexUserToken(insert);

  // Stamp connectedAt + fully clear any stale needs-reauth state on every
  // (re)connect so /profile shows the latest linkage time and the hourly
  // reminder emailer stops nudging this rep.
  await clearWebexUserNeedsReauth(userId);
  const refreshed = await storage.getWebexUserToken(userId);
  if (refreshed) record = refreshed;

  _accessCache.set(userId, { token: tokens.access_token, expiresAt });

  // Opportunistically confirm the matching webexUserMappings row so that
  // fallback org-token syncs also route calls to this rep.
  try {
    const mapping: InsertWebexUserMapping = {
      orgId,
      webexPersonId: personId,
      webexEmail: email,
      webexDisplayName: displayName,
      userId,
      status: "confirmed",
      matchSource: "self_oauth",
    };
    await storage.upsertWebexUserMapping(mapping);
  } catch (e) {
    log(`Mapping confirmation failed for user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(`Connected Webex for user ${userId} (person=${personId ?? "?"}, email=${email ?? "?"})`);
  return record;
}

export async function disconnectUserWebex(userId: string): Promise<boolean> {
  _accessCache.delete(userId);
  return storage.deleteWebexUserToken(userId);
}

// ---------------------------------------------------------------------------
// Needs-reauth email reminder (Task #265)
// ---------------------------------------------------------------------------

const REAUTH_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function buildReauthEmailHtml(
  userName: string,
  appUrl: string,
  reason: string | null,
): string {
  const link = `${appUrl.replace(/\/$/, "")}/profile`;
  const safeReason = (reason ?? "authorization expired or was revoked")
    .replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"))
    .slice(0, 300);
  const body = `
    <p>Hi ${userName || "there"},</p>
    <p>Your personal <strong>Webex Calling</strong> connection to Freight DNA has
    stopped working, so your calls aren't syncing to the CRM right now. Until you
    reconnect, inbound/outbound calls won't appear in your activity feed, and
    missed-call follow-ups won't be generated for you.</p>
    <div class="item">
      <div class="item-title">What to do</div>
      <div class="item-meta">Open your profile and click
      <strong>Reconnect Webex</strong>. It takes about 30 seconds.</div>
    </div>
    <p><a class="cta" href="${link}">Reconnect Webex</a></p>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Reason reported by Webex: <code>${safeReason}</code></p>
    <p style="font-size:12px;color:#6b7280">We'll send one reminder per day until your connection is restored.</p>
  `;
  return baseEmailTemplate("Reconnect your Webex to keep calls syncing", body);
}

/**
 * Scheduled job: emails each rep whose Webex connection needs re-authorization,
 * at most once every 24 hours per user. Safe to invoke hourly — it self-throttles
 * via the `lastReauthEmailAt` column.
 */
export async function sendPendingWebexUserReauthEmails(): Promise<void> {
  if (!emailEnabled()) return;

  let tokens: WebexUserToken[];
  try {
    tokens = await storage.getWebexUserTokensNeedingReauthEmail(
      new Date(Date.now() - REAUTH_EMAIL_INTERVAL_MS),
    );
  } catch (err) {
    log(`Failed to load reauth email candidates: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (tokens.length === 0) return;

  const appUrl = process.env.APP_URL?.trim() || "";
  let sent = 0;

  for (const token of tokens) {
    try {
      const user = await storage.getUser(token.userId);
      if (!user || !user.username || !user.username.includes("@")) continue;

      const ok = await sendEmail({
        to: user.username,
        subject: "[Freight DNA] Reconnect your Webex to keep calls syncing",
        html: buildReauthEmailHtml(
          user.name || user.username,
          appUrl,
          token.reauthReason ?? token.lastRefreshError ?? null,
        ),
      });
      if (!ok) continue;

      await storage.updateWebexUserToken(token.userId, {
        lastReauthEmailAt: new Date(),
      });
      sent++;
    } catch (err) {
      log(`Failed reauth email for user ${token.userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (sent > 0) {
    log(`Sent ${sent} per-user Webex re-auth reminder email(s)`);
  }
}
