/**
 * Per-user Webex OAuth token service (Task #261).
 *
 * Each rep can connect their own Webex account. We persist their refresh
 * token in `webex_user_tokens` and cache the minted access token in memory
 * for the duration of its lifetime.
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
import type { WebexUserToken, InsertWebexUserToken, InsertWebexUserMapping } from "@shared/schema";

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
      log(`User ${userId} refresh token rejected — flagging needs_reauth`);
      _accessCache.delete(userId);
      const reauthUpdates: Partial<InsertWebexUserToken> = {
        needsReauth: true,
        lastRefreshError: err.message.slice(0, 500),
      };
      await storage.updateWebexUserToken(userId, reauthUpdates);
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
    lastRefreshAt: new Date(),
    lastRefreshError: null,
    scopes: tokens.scope ?? WEBEX_OAUTH_SCOPES,
  };
  const record = await storage.upsertWebexUserToken(insert);

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
