// Cross-tab UX (option A) — SSE endpoint that streams in-process pub/sub
// events (see `services/liveSync.ts`) to all open browser tabs for the
// authenticated user's org. Pairs with `client/src/hooks/useLiveSync.ts`.
//
// Important constraints:
//   - One open EventSource per (user, tab) — Task #973 enforces this on
//     the server too: a reconnect with the same tabId closes the prior
//     socket cleanly with a labeled close-reason BEFORE opening the new
//     one. Without this, EventSource's exponential reconnect strands
//     phantom connections during a CDN flap and we leak file descriptors.
//   - Org-scoped subscription — never trust query params for orgId; always
//     derive from the authenticated session/token.
//   - Vite dev proxy / nginx friendly — `Cache-Control: no-transform`,
//     `X-Accel-Buffering: no`, and an immediate `flushHeaders()` so the
//     stream starts before any reverse proxy decides to buffer.
//   - Heartbeats every 25s — comments (`:hb`) keep idle connections alive
//     past common 30-60s proxy timeouts (Cloudflare, ALB, etc.).
//
// Auth — why this route does NOT use the standard `requireAuth` middleware:
//   The browser `EventSource` API cannot set custom request headers (only
//   cookies). Production auth on this app is Clerk JWT delivered via
//   `Authorization: Bearer …` headers, which means a vanilla EventSource
//   request hits the server with no Bearer token and `requireAuth` rejects
//   it with 401 — every ~3s, forever, as EventSource auto-reconnects.
//   That broke real-time updates on the Conversations page (the page fell
//   back to its 120s background poll, so reps had to manually refresh to
//   see new email activity).
//
//   Resolution: allow the SSE endpoint to accept a Clerk session JWT
//   passed in the `?token=` query string. Verify it with Clerk's
//   `verifyToken` and look the user up by `clerkUserId` to derive an
//   org-scoped subscription. Existing session-based callers (dev cookies,
//   impersonation paths) continue to work unchanged.

import type { Express, Request, Response } from "express";
import { verifyToken } from "@clerk/express";
import {
  subscribe,
  recordLiveSyncAuthOutcome,
  registerActiveConnection,
  isConnectRateLimited,
  recordConnectAttempt,
  LIVE_SYNC_CONNECT_RATE_LIMIT,
  type LiveSyncEvent,
} from "../services/liveSync";
import { resolveClerkUserToDbUser } from "../auth";
import { qOptStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";

// Verbose per-connect diagnostic logging. Off by default — flip on with
// `LIVE_SYNC_AUTH_DEBUG=1` to capture the structured per-connect record
// without permanently logging every reconnect (the route fires several
// times per minute per open tab).
const LIVE_SYNC_AUTH_DEBUG = process.env.LIVE_SYNC_AUTH_DEBUG === "1";

function emitAuthDiag(record: Record<string, unknown>): void {
  if (LIVE_SYNC_AUTH_DEBUG) {
    console.log(`[live-sync/auth] ${JSON.stringify(record)}`);
  }
}

/**
 * Truncate a Clerk user id for log lines so we get enough signal to
 * correlate ("which user keeps 401-ing") without dumping the full id
 * into log aggregation.
 */
export function fingerprintClerkId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * Classify a `verifyToken` failure into a stable short label so the
 * watchdog log scan ("which branch dominated rejection?") doesn't have
 * to grep free-form messages.
 */
function classifyVerifyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("expired")) return "expired";
  if (lower.includes("signature")) return "bad-signature";
  if (lower.includes("issuer")) return "bad-issuer";
  if (lower.includes("audience")) return "bad-audience";
  return "other";
}

/**
 * Result of resolving the SSE connection's identity. Includes both the
 * org (for the subscription) and the user fingerprint (for per-user
 * auth-outcome bucketing) plus a labeled rejection reason on failure.
 */
export interface ResolveResult {
  orgId: string | null;
  userId: string | null;
  fingerprint: string;
  rejectionReason: string | null;
}

export async function resolveOrgId(req: Request): Promise<ResolveResult> {
  // 1) Existing session — dev cookies and any impersonation flows that
  //    have already populated `req.session.organizationId` keep working
  //    without round-tripping through Clerk.
  const sessionOrgId = (req as any).session?.organizationId as string | undefined;
  const sessionUserId = (req as any).session?.userId as string | undefined;
  if (sessionOrgId) {
    const fp = sessionUserId ? fingerprintClerkId(sessionUserId) : "session";
    emitAuthDiag({ outcome: "200", branch: "session" });
    return { orgId: sessionOrgId, userId: sessionUserId ?? null, fingerprint: fp, rejectionReason: null };
  }

  // 2) Clerk JWT in `?token=`. EventSource can include this in the URL
  //    even though it can't set headers. Cookie-based Clerk sessions
  //    (rare in this app) are not relied on here — the explicit token
  //    is unambiguous and works in every browser/proxy combo.
  const token = qOptStr(req.query.token);
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!token || !secretKey) {
    emitAuthDiag({
      outcome: "401",
      branch: "no-token-or-secret",
      hasToken: Boolean(token),
      hasSecretKey: Boolean(secretKey),
    });
    return { orgId: null, userId: null, fingerprint: "anon", rejectionReason: "no-token-or-secret" };
  }

  let claims: Awaited<ReturnType<typeof verifyToken>>;
  try {
    claims = await verifyToken(token, { secretKey });
  } catch (err) {
    // Previously this branch silently swallowed the cause. Log the verify
    // error message at warn level — it's the only signal we have when
    // Clerk's issuer/audience config drifts from what the client mints,
    // and it only fires while the auth path is actually broken.
    const message = getErrorMessage(err);
    const kind = classifyVerifyError(message);
    console.warn(`[live-sync/auth] verifyToken failed (${kind}): ${message}`);
    emitAuthDiag({ outcome: "401", branch: "verify-failed", kind, error: message });
    return { orgId: null, userId: null, fingerprint: "anon", rejectionReason: kind };
  }

  const clerkUserId = typeof claims.sub === "string" ? claims.sub : null;
  if (!clerkUserId) {
    emitAuthDiag({ outcome: "401", branch: "no-claims-sub" });
    return { orgId: null, userId: null, fingerprint: "anon", rejectionReason: "no-claims-sub" };
  }

  const fp = fingerprintClerkId(clerkUserId);

  // Use the shared Clerk → DB resolver so the SSE path inherits the same
  // email-based back-fill that `requireAuth`/`getCurrentUser` performs on
  // /api routes. Without it, any user whose `users.clerk_user_id` is
  // still NULL (typical right after they're provisioned) 401s here even
  // though their token is perfectly valid — that was the production
  // root-cause of `live_sync_auth_failure` (Task #958).
  const user = await resolveClerkUserToDbUser(clerkUserId);
  if (!user) {
    emitAuthDiag({ outcome: "401", branch: "no-db-user", clerkId: fp });
    return { orgId: null, userId: null, fingerprint: fp, rejectionReason: "no-db-user" };
  }
  if (!user.organizationId) {
    emitAuthDiag({ outcome: "401", branch: "no-org-id", clerkId: fp });
    return { orgId: null, userId: user.id, fingerprint: fp, rejectionReason: "no-org-id" };
  }
  emitAuthDiag({ outcome: "200", branch: "clerk", clerkId: fp });
  return { orgId: user.organizationId, userId: user.id, fingerprint: fp, rejectionReason: null };
}

// Per-tab counter for callers (typically tests) that don't pass tabId.
// We never want two same-key registrations to silently share one socket,
// so missing tabIds get unique synthetic ones.
let _tabIdCounter = 0;

/**
 * Coarse pre-auth rate-limit key. Derived from `req.ip` (Express's
 * trust-proxy aware accessor) plus the optional client-supplied tabId,
 * so two real users behind the same NAT can't accidentally throttle
 * each other yet a single tab in a reconnect loop is still bucketed.
 *
 * Pre-auth keying is intentionally distinct from the post-auth Clerk
 * fingerprint: reconnect storms must be rejected *before* we burn
 * `verifyToken`/DB lookup cycles for them.
 */
function buildPreAuthFingerprint(req: Request): string {
  const ip = (req.ip ?? req.socket?.remoteAddress ?? "unknown").toString();
  const tab = qOptStr(req.query.tab) ?? qOptStr(req.query.tabId) ?? "";
  return `ip:${ip}${tab ? `|tab:${tab}` : ""}`;
}

export function registerLiveSyncRoutes(app: Express): void {
  app.get("/api/live-sync/stream", async (req: Request, res: Response) => {
    // ── Pre-auth rate-limit (Task #973 review-pass-2) ───────────────────
    //
    // Reject reconnect storms BEFORE running the expensive
    // `verifyToken` + DB lookup in resolveOrgId(). The pre-auth
    // bucket is keyed on a coarse client signal (IP + optional tabId)
    // so an unauthenticated client cannot bypass the throttle by
    // never sending a token. Post-auth, the per-Clerk-fingerprint
    // bucket below is still checked as defense-in-depth (a single
    // user opening many tabs from different IPs).
    const preAuthFp = buildPreAuthFingerprint(req);
    if (isConnectRateLimited(preAuthFp)) {
      recordConnectAttempt(preAuthFp);
      recordLiveSyncAuthOutcome(false, preAuthFp, "rate-limited-preauth");
      res.setHeader(
        "Retry-After",
        String(Math.ceil(LIVE_SYNC_CONNECT_RATE_LIMIT.windowMs / 1000)),
      );
      res.status(429).json({
        error: "Too many reconnect attempts",
        retryAfterSeconds: Math.ceil(LIVE_SYNC_CONNECT_RATE_LIMIT.windowMs / 1000),
      });
      return;
    }
    recordConnectAttempt(preAuthFp);

    const resolved = await resolveOrgId(req);
    const { orgId, userId, fingerprint, rejectionReason } = resolved;

    // Per-fingerprint connect-attempt rate limit (Task #973).
    //
    // Defense — independent of the auth-outcome health ring. We check
    // the *previous* burst window before recording the current attempt
    // so a burst of N+1 requests inside the window sees N+1th and
    // beyond rejected with 429 (and Retry-After).
    if (isConnectRateLimited(fingerprint)) {
      recordConnectAttempt(fingerprint);
      recordLiveSyncAuthOutcome(false, fingerprint, "rate-limited");
      res.setHeader(
        "Retry-After",
        String(Math.ceil(LIVE_SYNC_CONNECT_RATE_LIMIT.windowMs / 1000)),
      );
      res.status(429).json({
        error: "Too many reconnect attempts",
        retryAfterSeconds: Math.ceil(LIVE_SYNC_CONNECT_RATE_LIMIT.windowMs / 1000),
      });
      return;
    }
    recordConnectAttempt(fingerprint);

    // Health metric — record every connect outcome with the per-user
    // fingerprint and labeled rejection reason. The watchdog uses the
    // *median across users* (rather than the global ratio) to decide
    // when to fire `live_sync_auth_failure`, so a single bad client
    // looping 401s doesn't poison the org-wide signal.
    recordLiveSyncAuthOutcome(orgId !== null, fingerprint, rejectionReason);
    if (!orgId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // tabId is supplied by the client (`?tab=…`) so we can dedup
    // reconnects from the same tab. Synthesize one when missing — an
    // anonymous tabId still isolates connections, just per-request
    // rather than per-tab.
    const tabId =
      qOptStr(req.query.tab) ?? qOptStr(req.query.tabId) ?? `srv-${++_tabIdCounter}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Disables buffering on common reverse proxies (nginx, ALB) so events
    // hit the browser the moment they're written.
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    // Initial hello — gives the client a deterministic signal that the
    // stream is open (handy for reconnect logic) and forces the response
    // body to start flowing through any chunked-transfer middleware.
    res.write(
      `data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`,
    );

    const onEvent = (evt: LiveSyncEvent) => {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        // Write may fail if the socket has closed mid-flight; cleanup
        // below will handle teardown.
      }
    };
    const unsubscribe = subscribe(orgId, onEvent);

    // SSE-style heartbeat (a comment line is ignored by the EventSource
    // parser). 25s is comfortably under typical 30-60s idle timeouts.
    const heartbeat = setInterval(() => {
      try {
        res.write(`:hb\n\n`);
      } catch {
        // Same as above — cleanup will tear down on the close event.
      }
    }, 25_000);

    let cleanedUp = false;
    const cleanup = (closeReason?: string) => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      releaseActive();
      try {
        if (closeReason) {
          // Send a final, parseable event so an attentive client can
          // log why the stream closed (visible only in dev tools; the
          // EventSource onerror still fires too, which triggers the
          // exp-backoff reconnect).
          res.write(
            `data: ${JSON.stringify({ type: "close", reason: closeReason, ts: Date.now() })}\n\n`,
          );
        }
      } catch { /* noop */ }
      try {
        res.end();
      } catch {
        // noop
      }
    };

    // Register in the active-connection registry. If the same (userId,
    // tabId) is already open, the registry will close the prior socket
    // (with reason="superseded-by-same-tab") before adding ours.
    const releaseActive = registerActiveConnection({
      userId: userId ?? `anon-${tabId}`,
      fingerprint,
      orgId,
      tabId,
      openedAt: Date.now(),
      close: (reason) => cleanup(reason),
    });

    req.on("close", () => cleanup());
    req.on("error", () => cleanup());
  });
}
