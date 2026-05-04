// Cross-tab UX (option A) — SSE endpoint that streams in-process pub/sub
// events (see `services/liveSync.ts`) to all open browser tabs for the
// authenticated user's org. Pairs with `client/src/hooks/useLiveSync.ts`.
//
// Important constraints:
//   - One open EventSource per tab — listener cleanup on disconnect is
//     mandatory to avoid leaks. Both `req.on("close")` and `req.on("error")`
//     run the same cleanup so a flaky network can't strand subscribers.
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
function fingerprintClerkId(id: string): string {
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

export async function resolveOrgId(req: Request): Promise<string | null> {
  // 1) Existing session — dev cookies and any impersonation flows that
  //    have already populated `req.session.organizationId` keep working
  //    without round-tripping through Clerk.
  const sessionOrgId = (req as any).session?.organizationId as string | undefined;
  if (sessionOrgId) {
    emitAuthDiag({ outcome: "200", branch: "session" });
    return sessionOrgId;
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
    return null;
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
    return null;
  }

  const clerkUserId = typeof claims.sub === "string" ? claims.sub : null;
  if (!clerkUserId) {
    emitAuthDiag({ outcome: "401", branch: "no-claims-sub" });
    return null;
  }

  // Use the shared Clerk → DB resolver so the SSE path inherits the same
  // email-based back-fill that `requireAuth`/`getCurrentUser` performs on
  // /api routes. Without it, any user whose `users.clerk_user_id` is
  // still NULL (typical right after they're provisioned) 401s here even
  // though their token is perfectly valid — that was the production
  // root-cause of `live_sync_auth_failure` (Task #958).
  const user = await resolveClerkUserToDbUser(clerkUserId);
  const fp = fingerprintClerkId(clerkUserId);
  if (!user) {
    emitAuthDiag({ outcome: "401", branch: "no-db-user", clerkId: fp });
    return null;
  }
  if (!user.organizationId) {
    emitAuthDiag({ outcome: "401", branch: "no-org-id", clerkId: fp });
    return null;
  }
  emitAuthDiag({ outcome: "200", branch: "clerk", clerkId: fp });
  return user.organizationId;
}

export function registerLiveSyncRoutes(app: Express): void {
  app.get("/api/live-sync/stream", async (req: Request, res: Response) => {
    const orgId = await resolveOrgId(req);
    // Health metric — record every connect outcome (success or 401) so
    // the mailbox-health watchdog can fire `live_sync_auth_failure` when
    // the endpoint starts rejecting most/all attempts (the exact prod
    // regression that caused Conversations to stop auto-updating).
    recordLiveSyncAuthOutcome(orgId !== null);
    if (!orgId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

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
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // noop
      }
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });
}
