// Cross-tab UX (option A) — SSE endpoint that streams in-process pub/sub
// events (see `services/liveSync.ts`) to all open browser tabs for the
// authenticated user's org. Pairs with `client/src/hooks/useLiveSync.ts`.
//
// Important constraints:
//   - One open EventSource per tab — listener cleanup on disconnect is
//     mandatory to avoid leaks. Both `req.on("close")` and `req.on("error")`
//     run the same cleanup so a flaky network can't strand subscribers.
//   - Org-scoped subscription — never trust query params for orgId; always
//     read from session via `requireAuth`.
//   - Vite dev proxy / nginx friendly — `Cache-Control: no-transform`,
//     `X-Accel-Buffering: no`, and an immediate `flushHeaders()` so the
//     stream starts before any reverse proxy decides to buffer.
//   - Heartbeats every 25s — comments (`:hb`) keep idle connections alive
//     past common 30-60s proxy timeouts (Cloudflare, ALB, etc.).

import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { subscribe, type LiveSyncEvent } from "../services/liveSync";

export function registerLiveSyncRoutes(app: Express): void {
  app.get("/api/live-sync/stream", requireAuth, async (req: Request, res: Response) => {
    const orgId = (req as any).session?.organizationId as string | undefined;
    if (!orgId) {
      res.status(403).json({ error: "no_org" });
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
