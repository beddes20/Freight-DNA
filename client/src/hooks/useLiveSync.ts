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
import {
  computeReconnectDelayMs,
  ensureTabId,
  shouldResetAttemptCount,
  LIVE_SYNC_RECONNECT_BASE_MS,
} from "@/lib/liveSyncBackoff";

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
  // Task #968 — bucket-change events. Bust the list + bucket counts so
  // sidebar badges + the reclassification breadcrumb refetch.
  conversation_thread: [
    ["/api/internal/conversations"],
    ["/api/internal/conversations", "counts"],
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

export interface LiveSyncEvent {
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
  /** Task #968 — optional structured payload (e.g. bucket-change details). */
  payload?: Record<string, unknown>;
}

// Task #968 — per-topic event subscribers. Used by surfaces (e.g. the
// conversations page) that need the raw event payload for reacting,
// not just the cache-invalidation that TOPIC_TO_QUERY_KEYS handles.
type LiveSyncEventListener = (evt: LiveSyncEvent) => void;
const _topicListeners = new Map<string, Set<LiveSyncEventListener>>();

export function subscribeLiveSyncEvents(
  topic: string,
  listener: LiveSyncEventListener,
): () => void {
  let bucket = _topicListeners.get(topic);
  if (!bucket) {
    bucket = new Set();
    _topicListeners.set(topic, bucket);
  }
  bucket.add(listener);
  return () => {
    const b = _topicListeners.get(topic);
    if (!b) return;
    b.delete(listener);
    if (b.size === 0) _topicListeners.delete(topic);
  };
}

function dispatchTopicListeners(evt: LiveSyncEvent): void {
  if (!evt.topic) return;
  const bucket = _topicListeners.get(evt.topic);
  if (!bucket || bucket.size === 0) return;
  for (const l of bucket) {
    try { l(evt); } catch { /* listener errors must not break other subscribers */ }
  }
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
  /**
   * Task #968 — set when a surface (e.g. the Conversations page) has
   * decided that the SSE connection has been offline long enough that
   * it switched to a polled fallback. The pill surfaces this in its
   * tooltip so reps trust that the screen is still being kept fresh
   * even when the green "Live" dot is missing.
   */
  polledFallbackActive: boolean;
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
  polledFallbackActive: boolean;
}

const _status: MutableLiveSyncStatus = {
  state: "idle",
  lastEventAt: null,
  lastConnectAt: null,
  topicsSeen: new Set<string>(),
  polledFallbackActive: false,
};

const _listeners = new Set<() => void>();
let _snapshot: LiveSyncStatus = freezeStatus(_status);

function freezeStatus(s: MutableLiveSyncStatus): LiveSyncStatus {
  return {
    state: s.state,
    lastEventAt: s.lastEventAt,
    lastConnectAt: s.lastConnectAt,
    topicsSeen: new Set(s.topicsSeen),
    polledFallbackActive: s.polledFallbackActive,
  };
}

/**
 * Task #968 — surfaces flag the polled-fallback state to the shared
 * LiveSyncPill tooltip. Called by any page that's running its own
 * polled refetch loop while SSE is degraded; the pill reads
 * `polledFallbackActive` from the status snapshot.
 */
export function setPolledFallbackActive(active: boolean): void {
  if (_status.polledFallbackActive === active) return;
  _status.polledFallbackActive = active;
  emit();
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
  _status.polledFallbackActive = false;
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
  // Task #968 — fan out to per-topic listeners before the topic-filter
  // check so subscribers fire even when the page didn't register the
  // topic in its `useLiveSync(topics)` array.
  dispatchTopicListeners(evt);
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

// ── Module-scoped subscriber registry (Task #973) ─────────────────────────
//
// `useLiveSync` is mounted once near the top of the authenticated app
// shell *and* by individual pages that pass topic filters. The naive
// implementation opened one EventSource per mount — that contributed
// to the "rejecting connections" alert during reload storms.
//
// The original singleton-lock fix was wrong: it gated on "first mount
// wins" without a real refcount. In React, child effects run before
// parent effects, so a page mounted under <App> would acquire the
// lock first; when the user navigated away the lock was released and
// the App-level mount — whose effect had already run and was sitting
// in a no-op cleanup — never re-opened. The result was a *silently
// disabled* live-sync for the rest of the session.
//
// The correct model: a module-scoped "connection manager" with a
// subscriber list. Each `useLiveSync()` mount registers a demand
// (enabled flag, getStreamUrl factory, resetKey, topics, invalidator)
// and gets back an unsubscribe. The manager owns exactly one
// EventSource at a time and keeps it alive for as long as *any*
// enabled demand is registered. Demands going from N→0 close the
// stream; 0→N opens it. Topic filtering is per-demand: each subscriber
// only reacts to the topics it cares about.

interface LiveSyncDemand {
  id: number;
  enabled: boolean;
  getStreamUrl: () => Promise<string | null>;
  resetKey: string;
  topics?: ReadonlyArray<string>;
  invalidate: (key: ReadonlyArray<string>) => void;
}

interface LiveSyncManagerDeps {
  // Indirected so the regression test can inject a fake EventSource
  // (Vitest runs in a node environment with no real EventSource).
  EventSourceCtor: typeof EventSource | null;
  scheduleTimeout: (fn: () => void, ms: number) => unknown;
  clearScheduledTimeout: (handle: unknown) => void;
  now: () => number;
  ensureTabId: () => string;
}

const _defaultDeps: LiveSyncManagerDeps = {
  EventSourceCtor:
    typeof window !== "undefined" && typeof EventSource !== "undefined"
      ? EventSource
      : null,
  scheduleTimeout: (fn, ms) => setTimeout(fn, ms),
  clearScheduledTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  ensureTabId,
};
let _deps: LiveSyncManagerDeps = _defaultDeps;

const _demands = new Map<number, LiveSyncDemand>();
let _demandSeq = 0;
let _es: EventSource | null = null;
let _reconnectTimer: unknown = null;
let _attempt = 0;
let _openedAt: number | null = null;
let _activeResetKey: string | null = null;
let _connecting = false;
// Bumped whenever the demand set changes in a way that could
// invalidate an in-flight `openConnection()` (subscribe/unsubscribe
// or a resetKey shift). The in-flight open captures the generation
// before awaiting `getStreamUrl()`; on resume it bails out if the
// generation has moved, so a stale Clerk JWT minted under the prior
// session can't end up wired into the new EventSource.
let _openGeneration = 0;

function pickDemand(): LiveSyncDemand | null {
  // Insertion-order iteration → deterministic pick. We need *any*
  // enabled demand; they are functionally equivalent in this app
  // (same Clerk session per tab) so it doesn't matter which one
  // supplies the URL.
  for (const d of _demands.values()) {
    if (d.enabled) return d;
  }
  return null;
}

function dispatchEvent(evt: LiveSyncEvent): void {
  // Each subscriber filters independently — the page-mount with
  // ["customer_quote", "email_thread"] and the global App mount with
  // no filter both see the same raw event and apply their own rules.
  for (const d of _demands.values()) {
    if (!d.enabled) continue;
    applyEvent(evt, d.topics, d.invalidate);
  }
}

function teardownConnection(): void {
  if (_reconnectTimer) {
    _deps.clearScheduledTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  const current = _es;
  _es = null;
  _openedAt = null;
  _connecting = false;
  try { current?.close(); } catch { /* noop */ }
}

function scheduleReconnect(): void {
  if (_reconnectTimer || _connecting) return;
  if (!pickDemand()) return;
  _attempt += 1;
  const delay = computeReconnectDelayMs(_attempt);
  _reconnectTimer = _deps.scheduleTimeout(() => {
    _reconnectTimer = null;
    void openConnection();
  }, delay);
}

async function openConnection(): Promise<void> {
  if (_es || _connecting) return;
  const demand = pickDemand();
  if (!demand) return;
  if (!_deps.EventSourceCtor) {
    setState("disabled");
    return;
  }
  _connecting = true;
  setState("connecting");
  _activeResetKey = demand.resetKey;
  const myGen = ++_openGeneration;
  let url: string | null;
  try {
    url = await demand.getStreamUrl();
  } catch {
    url = null;
  }
  _connecting = false;
  // Race: subscribe/unsubscribe happened during the await. The new
  // demand set may carry a different resetKey (Clerk session flipped),
  // so the URL we just minted is stale. Drop it; if an enabled demand
  // still exists, kick off a fresh open with the up-to-date factory.
  if (myGen !== _openGeneration) {
    if (pickDemand() && !_es && !_reconnectTimer) void openConnection();
    return;
  }
  if (!pickDemand()) {
    _activeResetKey = null;
    return;
  }
  if (!url) {
    scheduleReconnect();
    return;
  }
  // Append the per-tab id so the server can dedup reconnects from
  // the same tab (Task #973 server-side single-conn enforcement).
  const tabId = _deps.ensureTabId();
  const tabSep = url.includes("?") ? "&" : "?";
  const fullUrl = tabId ? `${url}${tabSep}tab=${encodeURIComponent(tabId)}` : url;
  const es = new _deps.EventSourceCtor(fullUrl, { withCredentials: true });
  _es = es;
  _openedAt = _deps.now();

  es.onmessage = (msg: MessageEvent) => {
    let evt: LiveSyncEvent;
    try {
      evt = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (
      _openedAt !== null &&
      shouldResetAttemptCount(_deps.now() - _openedAt)
    ) {
      _attempt = 0;
    }
    dispatchEvent(evt);
  };

  es.onerror = () => {
    const livedFor = _openedAt !== null ? _deps.now() - _openedAt : 0;
    teardownConnection();
    setState("connecting");
    if (shouldResetAttemptCount(livedFor)) _attempt = 0;
    scheduleReconnect();
  };
}

/**
 * Register a connection demand. Returns an unsubscribe function. The
 * manager opens the underlying EventSource lazily (on the first
 * enabled demand) and tears it down when the last enabled demand
 * unsubscribes — this is the refcount the original singleton lock
 * lacked. Mount/unmount order between sibling/parent components is
 * therefore irrelevant: as long as one mount remains, the stream
 * stays alive.
 *
 * If the new demand has a different `resetKey` than the active
 * connection (e.g. Clerk sign-in state flipped), the existing stream
 * is torn down and re-opened so the next URL build picks up fresh
 * credentials.
 */
export function subscribeLiveSyncDemand(
  demand: Omit<LiveSyncDemand, "id">,
): () => void {
  const id = ++_demandSeq;
  _demands.set(id, { id, ...demand });
  // Any demand-set change invalidates an in-flight openConnection's
  // captured generation; the in-flight call will see the mismatch on
  // resume and either abort or hand off to a fresh open.
  _openGeneration += 1;

  if (!demand.enabled) {
    if (!pickDemand()) {
      teardownConnection();
      setState("disabled");
    }
  } else {
    if (
      _activeResetKey !== null &&
      _activeResetKey !== demand.resetKey
    ) {
      // Stale credentials — tear down any open connection so the next
      // open() re-fetches a URL via the freshest demand's factory.
      // (The generation bump above forces any in-flight open to bail
      // out, so we don't need to special-case `_connecting` here.)
      teardownConnection();
      _attempt = 0;
    }
    if (!_es && !_reconnectTimer && !_connecting) void openConnection();
  }

  return () => {
    _demands.delete(id);
    _openGeneration += 1;
    if (!pickDemand()) {
      teardownConnection();
      setState("disabled");
      _attempt = 0;
      _activeResetKey = null;
    }
  };
}

/**
 * React effect that registers the calling component with the manager.
 * Re-registers whenever `enabled` or `resetKey` changes (Clerk session
 * flips, dev/prod auth bypass, etc).
 */
function useStreamConnection(
  topics: ReadonlyArray<string> | undefined,
  enabled: boolean,
  getStreamUrl: () => Promise<string | null>,
  resetKey: string,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (prefix: ReadonlyArray<string>) =>
      queryClient.invalidateQueries({ queryKey: prefix as unknown as unknown[] });
    const unsubscribe = subscribeLiveSyncDemand({
      enabled,
      getStreamUrl,
      resetKey,
      topics,
      invalidate,
    });
    return unsubscribe;
    // The topics array is intentionally not in the dep list — callers
    // pass a static array and we don't want re-subscription per render.
    // `resetKey` is the explicit signal for "tear down and re-open".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, resetKey]);

  // Reference the constant so dead-code-elimination doesn't drop it.
  void LIVE_SYNC_RECONNECT_BASE_MS;
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

/** Test-only: clear all demands and tear down any active connection. */
export function _resetLiveSyncMountLockForTests(): void {
  _demands.clear();
  teardownConnection();
  _attempt = 0;
  _activeResetKey = null;
  _deps = _defaultDeps;
}

/** Test-only: inject a fake EventSource / timer / clock for the manager. */
export function _setLiveSyncManagerDepsForTests(
  patch: Partial<LiveSyncManagerDeps>,
): void {
  _deps = { ..._defaultDeps, ..._deps, ...patch };
}

/** Test-only: read the current demand count + active connection state. */
export function _getLiveSyncManagerStateForTests(): {
  demandCount: number;
  enabledCount: number;
  hasConnection: boolean;
  activeResetKey: string | null;
} {
  let enabledCount = 0;
  for (const d of _demands.values()) if (d.enabled) enabledCount += 1;
  return {
    demandCount: _demands.size,
    enabledCount,
    hasConnection: _es !== null,
    activeResetKey: _activeResetKey,
  };
}
