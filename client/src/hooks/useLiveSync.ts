// Cross-tab UX (option A) — opens a single SSE connection to
// /api/live-sync/stream and invalidates the matching React Query keys when
// events arrive. Pairs with `server/services/liveSync.ts` and
// `server/routes/liveSync.ts`.
//
// Mount this once near the top of the authenticated app shell. Calling it
// from multiple components is harmless (it just opens multiple
// connections), but wasteful — one mount is enough.
//
// Auth — why this hook fetches a Clerk JWT before each connect:
//   The browser `EventSource` API can't set custom request headers, only
//   cookies. In production this app authenticates via Clerk's
//   `Authorization: Bearer …` header, which means a naive EventSource
//   request reaches the server with no credentials and gets 401-ed. The
//   server-side route therefore also accepts a Clerk session JWT in
//   `?token=`; we fetch one via Clerk's `getToken()` immediately before
//   each connection (and re-fetch on every reconnect because Clerk's
//   default session token lifetime is ~60s — the URL we used last time
//   may already be expired by the time the browser reconnects).
//
// Topic → query-key invalidation map:
//   The values are PREFIXES — TanStack Query's `invalidateQueries` matches
//   any cached query whose key starts with the same array. That keeps the
//   table tiny while still catching keys like
//   `["/api/customer-quotes/list", filterQs]` or
//   `["/api/carrier-hub", carrierId]`.
//
// Task #967 — health-status singleton:
//   In addition to invalidating queries, every connection lifecycle event
//   (connect, disconnect, message) updates a tiny module-scoped state
//   store. `useLiveSyncStatus()` is a React-friendly selector that
//   subscribes to that store so the shared <LiveSyncPill /> can render
//   "live / connecting / stale" without each surface having to re-derive
//   the signal. Topics seen during the session are tracked in a Set so
//   per-tab "is my data being kept fresh?" diagnostics are honest.

import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth as useClerkAuth } from "@clerk/clerk-react";
import {
  applyRowVersionGuard,
  type RowVersionEvent,
} from "@/lib/applyRowVersionGuard";

// Every topic also invalidates `/api/lane-inbox` so the unified feed updates
// in real time without per-page wiring. The inbox endpoint is cheap and
// already capped, so we don't worry about thundering-herd refreshes.
const LANE_INBOX_KEY = ["/api/lane-inbox"] as const;

// Today's Priorities (the daily workspace) is sensitive to almost every
// signal-producing surface — quotes answered, lanes claimed, carrier outreach
// completed, freight opportunities resolved. Including it in each topic's
// invalidation list keeps the page live without adding per-write hooks.
const DAILY_WORKSPACE_KEY = ["/api/nba/daily-workspace"] as const;

const TOPIC_TO_QUERY_KEYS: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {
  freight_opportunity: [
    ["/api/freight-opportunities/cockpit"],
    ["/api/freight-opportunities"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  recurring_lane: [
    ["/api/recurring-lanes/work-queue"],
    ["/api/recurring-lanes"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  carrier_outreach: [
    ["/api/carrier-hub"],
    ["/api/recurring-lanes/work-queue"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  customer_quote: [
    ["/api/customer-quotes/snapshot"],
    ["/api/customer-quotes/list"],
    ["/api/customer-quotes/action-queue"],
    // A quote outcome edit can also drop a quote out of (or back into) the
    // stale-followup window, so refresh the badge + page list on every
    // customer_quote event without waiting for the dedicated topic to fire.
    ["/api/customer-quotes/stale-followups"],
    ["/api/customer-quotes/stale-followups/count"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  // Task #690 — fires when the per-org stale-followup membership changes
  // (a quote ages into the window, gets decided, or is reassigned). Keeps
  // the sidebar badge and the open Customer Quotes page in sync without
  // either side polling aggressively. The Customer Quotes page renders
  // its stale-followups module from the snapshot endpoint (not the list
  // endpoint), so include the snapshot key here as well.
  customer_quote_followup: [
    ["/api/customer-quotes/stale-followups"],
    ["/api/customer-quotes/stale-followups/count"],
    ["/api/customer-quotes/snapshot"],
    DAILY_WORKSPACE_KEY,
  ],
  carrier: [
    ["/api/carrier-hub"],
    ["/api/carriers"],
  ],
  daily_workspace: [
    DAILY_WORKSPACE_KEY,
  ],
  // Task #867 — fired by every successful mailbox ingestion so the
  // Conversations page (and its sidebar bucket counts) updates instantly
  // instead of waiting on its background refetch interval. Both topics
  // bust the same key set because the inbox feed mixes inbound + outbound
  // messages on the same row (a thread surfaces a new outbound rep reply
  // exactly the same way as a new inbound customer email).
  mailbox_inbound: [
    ["/api/internal/conversations"],
  ],
  mailbox_outbound: [
    ["/api/internal/conversations"],
  ],
};

// Topics that ship a per-company `key` and need per-company caches
// refreshed in addition to the topic-wide prefixes above. Touchpoint POSTs
// respond before background AI/growth-score work finishes; the trailing
// `daily_workspace` event is what surfaces those updates per company.
const PER_COMPANY_TOPICS: ReadonlySet<string> = new Set(["daily_workspace"]);
const buildPerCompanyKeys = (companyId: string): ReadonlyArray<ReadonlyArray<string>> => [
  ["/api/companies", companyId, "growth-score"],
  ["/api/companies", companyId, "next-best-action"],
  ["/api/companies", companyId, "touchpoints"],
  ["/api/companies", companyId, "touch-logs"],
  ["/api/nba/company", companyId, "card"],
  ["/api/tasks"],
  ["/api/tasks/company", companyId],
];

interface LiveSyncEvent {
  type?: string;
  topic?: string;
  key?: string;
  ts?: number;
  /**
   * Task #967 — server-stamped row-version timestamp (epoch ms). Used by
   * `applyRowVersionGuard` to drop late-arriving events that would clobber
   * a fresher cache entry. Optional because not every publish path threads
   * a per-row mtime yet (older topics will continue to invalidate
   * unconditionally — that's the safe direction).
   */
  rowVersionAt?: number;
}

// In dev with the local-auth bypass enabled, no <ClerkProvider> is mounted
// (see `client/src/App.tsx`). The Clerk auth hooks would crash if called
// in that mode, so we mirror the split used by `useAuth` and pick the
// implementation at module load.
const DEV_BYPASS =
  import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

// ── Live-sync health store (Task #967) ─────────────────────────────────────
//
// Module-scoped singleton state. `useLiveSyncStatus()` is a tiny
// `useSyncExternalStore` selector that lets the shared <LiveSyncPill />
// render the same "live / connecting / stale" signal across every tab
// without each surface having to re-derive it from scratch.
//
// State machine:
//   idle        → before the first connect attempt
//   connecting  → an EventSource is being opened (or has errored and is
//                 awaiting a reconnect timer)
//   live        → onmessage has fired at least once on the current
//                 connection (we treat the SSE "hello" frame as proof of
//                 a working server-side stream)
//   stale       → live, but no event has arrived in STALE_THRESHOLD_MS
//                 (computed lazily by the consumer; see status snapshot)
//   disabled    → the bootstrapper decided not to open a connection
//                 (e.g. signed-out Clerk session or no EventSource shim)

export type LiveSyncConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "stale"
  | "disabled";

export interface LiveSyncStatus {
  state: LiveSyncConnectionState;
  /** Wall-clock ms of the most recent inbound event (any topic). */
  lastEventAt: number | null;
  /** Wall-clock ms of the most recent successful EventSource open. */
  lastConnectAt: number | null;
  /** Topics observed at least once during this session. */
  topicsSeen: ReadonlySet<string>;
}

/**
 * Default freshness window. A live connection that hasn't received a
 * frame in this many ms is reported as "stale" without tearing down. The
 * window is generous (5 min) because most topics are bursty: a quiet
 * stretch is normal in the middle of the night, but >5 min of nothing
 * during the working day is a useful "are we still really connected?"
 * tell.
 */
export const LIVE_SYNC_STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface MutableLiveSyncStatus {
  state: LiveSyncConnectionState;
  lastEventAt: number | null;
  lastConnectAt: number | null;
  topicsSeen: Set<string>;
}

const _status: MutableLiveSyncStatus = {
  state: "idle",
  lastEventAt: null,
  lastConnectAt: null,
  topicsSeen: new Set<string>(),
};

const _listeners = new Set<() => void>();
let _snapshot: LiveSyncStatus = freezeStatus(_status);

function freezeStatus(s: MutableLiveSyncStatus): LiveSyncStatus {
  return {
    state: s.state,
    lastEventAt: s.lastEventAt,
    lastConnectAt: s.lastConnectAt,
    topicsSeen: new Set(s.topicsSeen),
  };
}

function emit(): void {
  _snapshot = freezeStatus(_status);
  for (const l of _listeners) {
    try { l(); } catch { /* listener errors must not break the store */ }
  }
}

function subscribeStatus(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

function setState(next: LiveSyncConnectionState): void {
  if (_status.state === next) return;
  _status.state = next;
  emit();
}

function recordConnect(now: number): void {
  _status.state = "live";
  _status.lastConnectAt = now;
  emit();
}

function recordEvent(now: number, topic: string | undefined): void {
  _status.lastEventAt = now;
  if (topic) _status.topicsSeen.add(topic);
  if (_status.state !== "live") _status.state = "live";
  emit();
}

/**
 * React hook returning the current live-sync health snapshot. Re-renders
 * the consumer when any field changes. The `state` field is computed at
 * read time so a long-quiet-but-still-open stream flips to "stale"
 * without anyone having to schedule a periodic re-render.
 *
 * Pass `now` (defaults to Date.now()) to make tests deterministic.
 */
export function useLiveSyncStatus(now: number = Date.now()): LiveSyncStatus {
  const raw = useSyncExternalStore(
    subscribeStatus,
    () => _snapshot,
    () => _snapshot,
  );
  // Layer the staleness check on top of the raw snapshot. We only flip
  // "live" → "stale"; transient states (idle / connecting / disabled)
  // pass through unchanged.
  if (raw.state === "live" && raw.lastEventAt !== null) {
    if (now - raw.lastEventAt > LIVE_SYNC_STALE_THRESHOLD_MS) {
      return { ...raw, state: "stale" };
    }
  }
  return raw;
}

/** Test-only: reset the singleton between cases. */
export function _resetLiveSyncStatusForTests(): void {
  _status.state = "idle";
  _status.lastEventAt = null;
  _status.lastConnectAt = null;
  _status.topicsSeen = new Set<string>();
  emit();
}

export function useLiveSync(topics?: ReadonlyArray<string>): void {
  if (DEV_BYPASS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useLiveSyncCookies(topics);
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useLiveSyncClerk(topics);
}

function applyEvent(
  evt: LiveSyncEvent,
  topics: ReadonlyArray<string> | undefined,
  invalidate: (key: ReadonlyArray<string>) => void,
): void {
  if (!evt) return;
  // The "hello" frame proves the stream is open end-to-end; record it as
  // a connect event so the pill flips out of "connecting" even when the
  // org has zero traffic.
  if (evt.type === "hello") {
    recordConnect(Date.now());
    return;
  }
  if (!evt.topic) return;
  recordEvent(Date.now(), evt.topic);
  if (topics && !topics.includes(evt.topic)) return;

  const keyPrefixes = TOPIC_TO_QUERY_KEYS[evt.topic];
  if (!keyPrefixes) return;
  // Task #967 — drop late-arriving events that would clobber a fresher
  // cache entry. Returns true when this event should be *applied*. The
  // guard is a no-op for topics that don't yet thread `rowVersionAt`.
  const guardEvt: RowVersionEvent = {
    topic: evt.topic,
    key: evt.key,
    rowVersionAt: evt.rowVersionAt,
  };
  if (!applyRowVersionGuard(guardEvt)) return;

  for (const prefix of keyPrefixes) invalidate(prefix);

  if (evt.key && PER_COMPANY_TOPICS.has(evt.topic)) {
    for (const prefix of buildPerCompanyKeys(evt.key)) invalidate(prefix);
  }
}

/**
 * Connect-loop shared by both auth modes. `getStreamUrl` is awaited on
 * every (re)connect so the Clerk-powered variant can mint a fresh JWT
 * each time — Clerk's default session-token lifetime is ~60s, and an
 * EventSource auto-reconnect with a stale token would just 401 again.
 */
function useStreamConnection(
  topics: ReadonlyArray<string> | undefined,
  enabled: boolean,
  getStreamUrl: () => Promise<string | null>,
  // Anything that should force a teardown + reconnect (e.g. signed-in
  // state flipping). Stringified for stable identity in the dep array.
  resetKey: string,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      setState("disabled");
      return;
    }
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setState("disabled");
      return;
    }

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const invalidate = (prefix: ReadonlyArray<string>) =>
      queryClient.invalidateQueries({ queryKey: prefix as unknown as unknown[] });

    const open = async () => {
      if (!mounted) return;
      setState("connecting");
      let url: string | null;
      try {
        url = await getStreamUrl();
      } catch {
        url = null;
      }
      if (!mounted) return;
      if (!url) {
        // Couldn't build a URL right now (e.g. Clerk getToken returned
        // null transiently). Back off and try again.
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          open();
        }, 2_000);
        return;
      }

      // EventSource sends the session cookie automatically when same-origin,
      // which is the case in dev and prod. `withCredentials` is only needed
      // for cross-origin streams; setting it here is harmless either way.
      es = new EventSource(url, { withCredentials: true });

      es.onmessage = (msg) => {
        let evt: LiveSyncEvent;
        try {
          evt = JSON.parse(msg.data);
        } catch {
          return;
        }
        applyEvent(evt, topics, invalidate);
      };

      es.onerror = () => {
        // Always force a clean teardown + manual reconnect so we mint a
        // fresh token (the previous one may have expired). Without this,
        // EventSource's built-in retry would re-issue the request with
        // the original — now expired — `?token=` and 401 again.
        const current = es;
        es = null;
        try { current?.close(); } catch { /* noop */ }
        setState("connecting");
        if (mounted && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
          }, 2_000);
        }
      };
    };

    open();

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { es?.close(); } catch { /* noop */ }
    };
    // The topics array is intentionally not in the dep list — callers pass
    // a static array and we want one connection per mount, not per render.
    // `resetKey` is the explicit signal for "tear down and reconnect".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, resetKey]);
}

/** Dev-bypass path: cookies are sent automatically; no token needed. */
function useLiveSyncCookies(topics?: ReadonlyArray<string>): void {
  useStreamConnection(topics, true, async () => "/api/live-sync/stream", "cookies");
}

/** Production path: fetch a fresh Clerk JWT and pass it in the URL. */
function useLiveSyncClerk(topics?: ReadonlyArray<string>): void {
  const { isLoaded, isSignedIn, getToken } = useClerkAuth();

  useStreamConnection(
    topics,
    Boolean(isLoaded && isSignedIn),
    async () => {
      const token = await getToken();
      if (!token) return null;
      return `/api/live-sync/stream?token=${encodeURIComponent(token)}`;
    },
    // Tear down + reopen whenever sign-in state changes so a fresh-login
    // tab doesn't keep its anonymous (failing) connection.
    `clerk:${isLoaded ? 1 : 0}:${isSignedIn ? 1 : 0}`,
  );
}
