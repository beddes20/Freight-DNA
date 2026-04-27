/**
 * Task #700 — Client-side AI engagement telemetry helper.
 *
 * Every AI surface in the app calls `recordAiEvent({ surface, eventType, … })`
 * when it shows / is interacted with / is dismissed. Events are queued and
 * flushed in small batches so the surface itself feels no latency.
 *
 * Failures are swallowed silently — analytics must never break a UI.
 */

export type AiEngagementSurface =
  | "nba_card"
  | "daily_priorities"
  | "valueiq"
  | "ai_center"
  | "ai_intelligence_hub"
  | "proactive_nudge"
  | "talking_points"
  | "health_narrative"
  | "touchpoint_summary"
  | "meeting_brief"
  | "weekly_account_review"
  | "ai_email_draft"
  | "ready_to_act"
  | "carrier_recommendation"
  | "spot_quote_intel";

export type AiEngagementEventType =
  | "impression"
  | "click"
  | "accept"
  | "apply"
  | "copy"
  | "dismiss"
  | "thumbs_up"
  | "thumbs_down";

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
