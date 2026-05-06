/**
 * Task #700 — Client-side AI engagement telemetry helper.
 *
 * Every AI surface in the app calls `recordAiEvent({ surface, eventType, … })`
 * when it shows / is interacted with / is dismissed. Events are queued and
 * flushed in small batches so the surface itself feels no latency.
 *
 * Failures are swallowed silently — analytics must never break a UI.
 *
 * Surface and event-type unions are sourced from `@shared/schema` so the
 * client and server share a single registry — adding a new surface in one
 * place automatically extends both producers and the ingest validator,
 * eliminating drift between client emitters and the server allow-list.
 */

import type { AiEngagementSurface, AiEngagementEventType } from "@shared/schema";

export type { AiEngagementSurface, AiEngagementEventType };

export interface AiEvent {
  surface: AiEngagementSurface;
  eventType: AiEngagementEventType;
  feature?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
}

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH = 50;

let queue: AiEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

async function flush(): Promise<void> {
  if (inFlight || queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  inFlight = true;
  try {
    await fetch("/api/ai-engagement/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      credentials: "include",
      // The endpoint always returns 200 on telemetry errors so callers don't
      // need to retry. We still keep an extra try/catch for network errors.
      keepalive: true,
    });
  } catch {
    // swallow — telemetry must never break the UI
  } finally {
    inFlight = false;
    if (queue.length > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/** Queue a single AI engagement event. Safe to call from render. */
export function recordAiEvent(event: AiEvent): void {
  if (typeof window === "undefined") return;
  queue.push(event);
  if (queue.length >= MAX_BATCH) {
    void flush();
  } else {
    scheduleFlush();
  }
}

// Best-effort flush before the tab unloads.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (queue.length === 0) return;
    try {
      const blob = new Blob(
        [JSON.stringify({ events: queue.splice(0, MAX_BATCH) })],
        { type: "application/json" },
      );
      navigator.sendBeacon?.("/api/ai-engagement/events", blob);
    } catch {
      // ignore
    }
  });
}
