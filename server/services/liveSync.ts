// Cross-tab UX (option A) — minimal in-process pub/sub for live cross-tab
// invalidation across LWQ ↔ Available Freight ↔ Carrier Hub ↔ Customer
// Quotes. Producers (write paths) call `publish(orgId, topic, key?)`;
// consumers (the SSE stream at /api/live-sync/stream) call `subscribe`.
//
// Design:
//   - In-process only — no Redis/queue. Single-instance deployments are the
//     current target; if we scale horizontally we'll swap the EventEmitter
//     for a pub/sub backend without changing the publish/subscribe surface.
//   - Org-scoped channels — every event is keyed by orgId so a subscriber
//     never sees another tenant's traffic.
//   - Best-effort, fire-and-forget — publish never throws and never blocks.
//     A dropped event is acceptable: clients periodically refetch on focus
//     anyway, this is just to make cross-tab updates feel instant.
//   - No persistence — events are not replayed on reconnect. Subscribers
//     should treat the stream as a hint to invalidate caches, not as a
//     durable log.

import { EventEmitter } from "node:events";

/**
 * Topic taxonomy. Keep this list short and stable — every new topic needs a
 * matching entry in the client hook's TOPIC_TO_QUERY_KEYS table.
 */
export type LiveSyncTopic =
  | "freight_opportunity"
  | "recurring_lane"
  | "carrier_outreach"
  | "customer_quote"
  | "customer_quote_followup"
  | "carrier"
  | "daily_workspace"
  // Task #867 — Self-healing email ingestion. Fired by every successful
  // mailbox ingest path (Graph webhook + delta-sync poll + self-heal sweep)
  // so the Conversations page updates in real time instead of waiting on
  // its 30s background refetch. `mailbox_inbound` covers inbound rep mail
  // (Inbox folder), `mailbox_outbound` covers SentItems captures.
  | "mailbox_inbound"
  | "mailbox_outbound"
  // Task #968 — bucket-change events for a thread, with prev/current
  // waitingState + ownerUserId (and optional prev/current bucket label).
  | "conversation_thread";

/** Loosely-typed payload bag — callers validate the shape they expect. */
export type LiveSyncPayload = Record<string, unknown>;

export interface LiveSyncEvent {
  topic: LiveSyncTopic;
  /** Optional row id (opp id, lane id, etc.) for clients that key on it. */
  key?: string;
  ts: number;
  /**
   * Task #967 — server-stamped row-version timestamp (epoch ms). When the
   * publish path knows the freshly-written row's mtime (or commit ts), it
   * passes it through here so the client-side `applyRowVersionGuard` can
   * drop late-arriving events that would otherwise clobber a fresher
   * cache entry. Optional and additive: legacy publish paths that don't
   * yet thread a row mtime continue to work (those events bypass the
   * guard and always apply, which is the safe direction).
   */
  rowVersionAt?: number;
  /** Task #968 — optional structured payload, JSON-serialized over SSE. */
  payload?: LiveSyncPayload;
}

const emitter = new EventEmitter();
// Some orgs may have many open tabs (each tab = one listener). Lift the
// 10-listener default so we don't spew warnings under normal use.
emitter.setMaxListeners(0);

const channelFor = (orgId: string) => `org:${orgId}`;

/** Wildcard channel — every publish is also fanned out here so server-side
 *  consumers (e.g. response caches that need to bust on related write paths)
 *  can listen to all orgs without registering N per-org subscribers. */
const ALL_CHANNEL = "__all__";

export interface LiveSyncEventWithOrg extends LiveSyncEvent {
  orgId: string;
}

/**
 * Publish an event to all subscribers for the given org.
 *
 * Safe to call from any write path — never throws, never blocks. Empty/null
 * orgId is a silent no-op so callers don't need defensive `if` checks.
 */
export function publish(
  orgId: string | null | undefined,
  topic: LiveSyncTopic,
  key?: string,
  /**
   * Optional row-version timestamp (epoch ms). Pass when the caller has
   * the freshly-written row's mtime / commit ts so the client-side
   * `applyRowVersionGuard` can suppress late-arriving events.
   */
  rowVersionAt?: number,
  /**
   * Task #968 — optional structured payload. Currently used by
   * `conversation_thread` events to carry the previous + current
   * waitingState/ownerUserId so the client can compute viewer-specific
   * bucket transitions. Pass `undefined` for topics that don't need it.
   */
  payload?: LiveSyncPayload,
): void {
  if (!orgId) return;
  try {
    const ts = Date.now();
    const evt: LiveSyncEvent = { topic, key, ts };
    if (typeof rowVersionAt === "number" && Number.isFinite(rowVersionAt)) {
      evt.rowVersionAt = rowVersionAt;
    }
    if (payload && typeof payload === "object") {
      evt.payload = payload;
    }
    emitter.emit(channelFor(orgId), evt);
    emitter.emit(ALL_CHANNEL, { ...evt, orgId } as LiveSyncEventWithOrg);
    // Health metric — record per-org per-topic last-publish-at so the
    // watchdog can detect "ingest happened but live-sync is silent" (e.g.
    // a future regression that drops the publish call from a write path).
    _lastPublishByOrgTopic.set(`${orgId}::${topic}`, ts);
  } catch {
    // Swallow — pub/sub is purely advisory and must never break a write path.
  }
}

/**
 * Subscribe to events for the given org. Returns an unsubscribe function the
 * caller MUST invoke on disconnect to avoid leaking listeners.
 */
export function subscribe(
  orgId: string,
  listener: (evt: LiveSyncEvent) => void,
): () => void {
  if (!orgId) return () => {};
  const channel = channelFor(orgId);
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}

/**
 * Subscribe to ALL org events at once. Used by server-side response caches
 * that need to invalidate on cross-org write traffic. Listeners receive the
 * `orgId` so they can bust the right partition.
 */
export function subscribeAll(
  listener: (evt: LiveSyncEventWithOrg) => void,
): () => void {
  emitter.on(ALL_CHANNEL, listener);
  return () => {
    emitter.off(ALL_CHANNEL, listener);
  };
}

// ── Health metrics (Task #951, expanded #973) ──────────────────────────────
//
// Counters consumed by `mailboxWatchdogService.runLiveSyncHealthCheck` AND
// surfaced on /admin/integrations-health via `getLiveSyncMetricsSnapshot()`.
//
// Failure modes we explicitly want to detect early:
//
//   1. `live_sync_auth_failure` — the SSE endpoint is rejecting most/all
//      connection attempts. Tracked as a process-wide rolling 60s window
//      AND per-user-fingerprint so one bad client (looped 401s from a
//      stale tab) cannot poison the org-wide signal — the watchdog
//      now uses the *median across users* as the firing trigger.
//
//   2. `live_sync_silent_stream` — mailbox ingest is happening but
//      `publish()` for the matching topic never fired. Tracked per
//      (orgId, topic).
//
// Module-scoped state — the server is a single process and the watchdog
// cron is a singleton. If we ever scale horizontally these getters move
// behind a Redis-backed counter.

interface AuthOutcomeRing {
  /** Unix-ms timestamps of recent successful connects. */
  success: number[];
  /** Unix-ms timestamps of recent rejected connects. */
  failure: number[];
}
const _liveSyncAuthRing: AuthOutcomeRing = { success: [], failure: [] };

/**
 * Per-fingerprint auth outcomes. The fingerprint is the truncated Clerk
 * user id ("abcd1234…wxyz") or "anon" when no token was supplied. We
 * key on fingerprints rather than the raw id so a leaked log line
 * cannot be reversed to identify a user.
 */
interface PerUserOutcomeRing extends AuthOutcomeRing {
  /** Most-frequent rejection label seen in the window, for diagnosis. */
  lastRejectionReason: string | null;
}
const _liveSyncAuthRingByUser: Map<string, PerUserOutcomeRing> = new Map();

/**
 * Process-wide rejection-by-reason counters (rolling 60s window). The
 * keys are the short labels from `classifyRejection()` in the route.
 */
const _liveSyncRejectionByReason: Map<string, number[]> = new Map();

const LIVE_SYNC_AUTH_WINDOW_MS = 60_000;
// Cap each ring so a long-running burst can't grow unbounded between
// watchdog ticks. 1000 events/min is far above any realistic prod rate
// (each open tab reconnects every few seconds — caps out around ~300/min
// for hundreds of tabs), and the watchdog drains it every minute anyway.
const LIVE_SYNC_AUTH_RING_CAP = 1000;
// Cap per-user rings smaller — a single user looping 401s shouldn't
// pin >100 events in memory.
const LIVE_SYNC_AUTH_PER_USER_CAP = 200;

const _lastPublishByOrgTopic: Map<string, number> = new Map();

function _pruneRing(ring: number[], now: number): void {
  const cutoff = now - LIVE_SYNC_AUTH_WINDOW_MS;
  // Timestamps are appended in monotonic order — find the first kept index
  // and slice once. Cheaper than filter() for large rings.
  let firstKept = 0;
  while (firstKept < ring.length && ring[firstKept] < cutoff) firstKept++;
  if (firstKept > 0) ring.splice(0, firstKept);
}

/**
 * Record one outcome of an SSE connection attempt against
 * `/api/live-sync/stream`. Called from the route handler after auth
 * resolution, before the response is written.
 *
 * @param userFingerprint Truncated Clerk id ("ab12cd34…wxyz") or "anon"
 *                        when the request had no token.
 * @param rejectionReason Short label from `classifyRejection()` when
 *                        the connect failed; null on success.
 */
export function recordLiveSyncAuthOutcome(
  success: boolean,
  userFingerprint: string = "anon",
  rejectionReason: string | null = null,
): void {
  const now = Date.now();
  const ring = success ? _liveSyncAuthRing.success : _liveSyncAuthRing.failure;
  ring.push(now);
  if (ring.length > LIVE_SYNC_AUTH_RING_CAP) {
    // Drop the oldest half — a hard cap keeps memory bounded under
    // pathological loops without losing the recent signal.
    ring.splice(0, ring.length - LIVE_SYNC_AUTH_RING_CAP / 2);
  }

  // Per-user bucket — the watchdog uses the median-across-users to
  // decide whether to alert, so one bad client can't blow up the global.
  let perUser = _liveSyncAuthRingByUser.get(userFingerprint);
  if (!perUser) {
    perUser = { success: [], failure: [], lastRejectionReason: null };
    _liveSyncAuthRingByUser.set(userFingerprint, perUser);
  }
  const userRing = success ? perUser.success : perUser.failure;
  userRing.push(now);
  if (userRing.length > LIVE_SYNC_AUTH_PER_USER_CAP) {
    userRing.splice(0, userRing.length - LIVE_SYNC_AUTH_PER_USER_CAP / 2);
  }
  if (!success && rejectionReason) {
    perUser.lastRejectionReason = rejectionReason;
  }

  // Process-wide rejection-by-reason histogram.
  if (!success && rejectionReason) {
    let arr = _liveSyncRejectionByReason.get(rejectionReason);
    if (!arr) {
      arr = [];
      _liveSyncRejectionByReason.set(rejectionReason, arr);
    }
    arr.push(now);
    if (arr.length > LIVE_SYNC_AUTH_RING_CAP) {
      arr.splice(0, arr.length - LIVE_SYNC_AUTH_RING_CAP / 2);
    }
  }
}

/**
 * Snapshot of the SSE auth outcomes in the last 60 seconds. Read by the
 * mailbox-health watchdog. Pure read — does not mutate the ring.
 */
export function getLiveSyncAuthStats(now: number = Date.now()): {
  success: number;
  failure: number;
  total: number;
  failureRatio: number;
  windowMs: number;
} {
  _pruneRing(_liveSyncAuthRing.success, now);
  _pruneRing(_liveSyncAuthRing.failure, now);
  const success = _liveSyncAuthRing.success.length;
  const failure = _liveSyncAuthRing.failure.length;
  const total = success + failure;
  return {
    success,
    failure,
    total,
    failureRatio: total === 0 ? 0 : failure / total,
    windowMs: LIVE_SYNC_AUTH_WINDOW_MS,
  };
}

export interface PerUserAuthStats {
  fingerprint: string;
  success: number;
  failure: number;
  failureRatio: number;
  lastRejectionReason: string | null;
}

/**
 * Per-user-fingerprint auth outcomes for the rolling 60s window.
 *
 * The watchdog uses these to compute the *median* failure ratio across
 * active users — a much more honest signal than "global failure ratio"
 * because one tab in a stuck loop can pin the global number to 100%
 * even when every other user is fine.
 */
export function getLiveSyncAuthStatsByUser(now: number = Date.now()): PerUserAuthStats[] {
  const out: PerUserAuthStats[] = [];
  for (const [fingerprint, ring] of _liveSyncAuthRingByUser.entries()) {
    _pruneRing(ring.success, now);
    _pruneRing(ring.failure, now);
    const success = ring.success.length;
    const failure = ring.failure.length;
    const total = success + failure;
    if (total === 0) continue;
    out.push({
      fingerprint,
      success,
      failure,
      failureRatio: failure / total,
      lastRejectionReason: ring.lastRejectionReason,
    });
  }
  // Drop empty rings so the map doesn't grow unbounded.
  for (const [fp, ring] of _liveSyncAuthRingByUser.entries()) {
    if (ring.success.length === 0 && ring.failure.length === 0) {
      _liveSyncAuthRingByUser.delete(fp);
    }
  }
  return out;
}

/**
 * Process-wide rejection-by-reason histogram for the rolling 60s window.
 * Returned as an array sorted descending by count for direct rendering.
 */
export function getLiveSyncRejectionByReason(
  now: number = Date.now(),
): Array<{ reason: string; count: number }> {
  const out: Array<{ reason: string; count: number }> = [];
  for (const [reason, arr] of _liveSyncRejectionByReason.entries()) {
    _pruneRing(arr, now);
    if (arr.length > 0) out.push({ reason, count: arr.length });
  }
  // Drop empty buckets.
  for (const [reason, arr] of _liveSyncRejectionByReason.entries()) {
    if (arr.length === 0) _liveSyncRejectionByReason.delete(reason);
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * Most recent publish timestamp for any mailbox topic for the given org.
 * Returns null if no mailbox publish has ever been observed for the org
 * during this process lifetime.
 */
export function getLastMailboxPublishAt(orgId: string): number | null {
  const inbound = _lastPublishByOrgTopic.get(`${orgId}::mailbox_inbound`) ?? 0;
  const outbound = _lastPublishByOrgTopic.get(`${orgId}::mailbox_outbound`) ?? 0;
  const max = Math.max(inbound, outbound);
  return max > 0 ? max : null;
}

// ── Active connection registry (Task #973) ────────────────────────────────
//
// Tracks every currently-open SSE connection so:
//   1. We can enforce one active connection per (userId, tabId) — when a
//      reconnect arrives with the same tabId, the prior socket is
//      cleanly closed (with a short reason) before the new one opens.
//      Without this the server happily holds N stranded sockets per
//      tab while EventSource's exponential reconnect runs.
//   2. We can cap per-user concurrent connections at a sane number
//      (default 8). A single user with 20 tabs open is fine; a single
//      user with 200 (browser stuck in a redirect loop) is not.
//   3. The /admin/integrations-health page can render the live count.
//
// The registry is process-wide. Memory is bounded by the per-user cap
// times the user count, and entries are removed on every disconnect.

interface ActiveConnection {
  userId: string;
  fingerprint: string;
  orgId: string;
  tabId: string;
  openedAt: number;
  /** Called by the registry when this connection should tear down. */
  close: (reason: string) => void;
}

const _activeConnections: Map<string, ActiveConnection> = new Map();
const _activeByUser: Map<string, Set<string>> = new Map();
const _activeByOrg: Map<string, Set<string>> = new Map();

/** Hard cap on concurrent SSE sockets per user. */
export const LIVE_SYNC_MAX_CONNS_PER_USER = 8;

function connKey(userId: string, tabId: string): string {
  return `${userId}::${tabId}`;
}

/**
 * Register a new active SSE connection. If the same (userId, tabId)
 * already has an active socket, that prior socket is closed first
 * with `reason="superseded-by-same-tab"`. If the user is at the
 * per-user cap, the oldest connection is closed with
 * `reason="per-user-cap"`.
 *
 * Returns a release function that the caller MUST invoke on disconnect
 * (idempotent).
 */
export function registerActiveConnection(
  conn: ActiveConnection,
): () => void {
  const key = connKey(conn.userId, conn.tabId);

  // 1. Same-tab dedup. If the caller is reconnecting from the same tab
  //    (e.g. after a transient network blip), close the prior socket so
  //    we don't accumulate phantoms while EventSource exponentially
  //    backs off. This is the durable fix for the "100 stranded sockets
  //    in prod after a CDN flap" pathology.
  const prior = _activeConnections.get(key);
  if (prior) {
    try { prior.close("superseded-by-same-tab"); } catch { /* noop */ }
    _removeFromIndex(prior);
    _activeConnections.delete(key);
  }

  // 2. Per-user cap. Bound the per-user count so a buggy client (or a
  //    hostile one) can't exhaust file descriptors.
  const userSet = _activeByUser.get(conn.userId) ?? new Set<string>();
  if (userSet.size >= LIVE_SYNC_MAX_CONNS_PER_USER) {
    // Find the oldest entry and evict it.
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const k of userSet) {
      const c = _activeConnections.get(k);
      if (c && c.openedAt < oldestAt) {
        oldestAt = c.openedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = _activeConnections.get(oldestKey);
      if (evicted) {
        try { evicted.close("per-user-cap"); } catch { /* noop */ }
        _removeFromIndex(evicted);
        _activeConnections.delete(oldestKey);
      }
    }
  }

  _activeConnections.set(key, conn);
  if (!_activeByUser.has(conn.userId)) _activeByUser.set(conn.userId, new Set());
  _activeByUser.get(conn.userId)!.add(key);
  if (!_activeByOrg.has(conn.orgId)) _activeByOrg.set(conn.orgId, new Set());
  _activeByOrg.get(conn.orgId)!.add(key);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = _activeConnections.get(key);
    if (!cur) return;
    _removeFromIndex(cur);
    _activeConnections.delete(key);
  };
}

function _removeFromIndex(c: ActiveConnection): void {
  const key = connKey(c.userId, c.tabId);
  const userSet = _activeByUser.get(c.userId);
  if (userSet) {
    userSet.delete(key);
    if (userSet.size === 0) _activeByUser.delete(c.userId);
  }
  const orgSet = _activeByOrg.get(c.orgId);
  if (orgSet) {
    orgSet.delete(key);
    if (orgSet.size === 0) _activeByOrg.delete(c.orgId);
  }
}

export interface LiveSyncMetricsSnapshot {
  activeConnections: number;
  activeByOrg: Array<{ orgId: string; count: number }>;
  topUsers: Array<{ fingerprint: string; count: number }>;
  authStats: ReturnType<typeof getLiveSyncAuthStats>;
  authStatsByUser: PerUserAuthStats[];
  rejectionsByReason: Array<{ reason: string; count: number }>;
  /** Per-user median failure ratio across the last-60s window. */
  perUserMedianFailureRatio: number;
  /** Number of users that contributed at least one outcome. */
  usersObserved: number;
}

/**
 * Combined snapshot used by the `/admin/integrations-health` Live-sync
 * tile and by the watchdog when it wants the per-user view (rather
 * than the legacy global ratio).
 *
 * Pure read — does not mutate state beyond the ring-prune side effect
 * shared with the other getters above.
 */
export function getLiveSyncMetricsSnapshot(now: number = Date.now()): LiveSyncMetricsSnapshot {
  const authStats = getLiveSyncAuthStats(now);
  const authStatsByUser = getLiveSyncAuthStatsByUser(now);
  const rejectionsByReason = getLiveSyncRejectionByReason(now);

  // Median across users — robust to one outlier client.
  let perUserMedianFailureRatio = 0;
  if (authStatsByUser.length > 0) {
    const sorted = [...authStatsByUser].map((u) => u.failureRatio).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    perUserMedianFailureRatio = sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Active-by-org breakdown.
  const activeByOrg: Array<{ orgId: string; count: number }> = [];
  for (const [orgId, set] of _activeByOrg.entries()) {
    activeByOrg.push({ orgId, count: set.size });
  }
  activeByOrg.sort((a, b) => b.count - a.count);

  // Top-failing users (by failure count, descending). Limit to 10 so
  // the admin response is bounded.
  const topUsers = [...authStatsByUser]
    .sort((a, b) => b.failure - a.failure)
    .slice(0, 10)
    .map((u) => ({ fingerprint: u.fingerprint, count: u.failure }));

  return {
    activeConnections: _activeConnections.size,
    activeByOrg,
    topUsers,
    authStats,
    authStatsByUser,
    rejectionsByReason,
    perUserMedianFailureRatio,
    usersObserved: authStatsByUser.length,
  };
}

// ── Per-fingerprint connect-attempt rate limit (Task #973) ────────────────
//
// Independent of the auth-outcome ring above. The auth ring is a *health
// metric*; this is a *defense*. A misbehaving client (stale tab in a
// retry loop, hostile script) can hit /api/live-sync/stream hundreds of
// times per second. Without this, every one of those attempts goes
// through Clerk verifyToken (rate-limited but still expensive) and DB
// resolution (definitely expensive). Worse, those failures all flow
// into the per-user auth ring and can drag the median failure ratio up
// enough to fire `live_sync_auth_failure` for the entire org — a single
// bad tab paging the on-call.
//
// Implementation: tiny per-fingerprint timestamp ring. We allow bursts
// up to `LIVE_SYNC_CONNECT_BURST` inside `LIVE_SYNC_CONNECT_WINDOW_MS`,
// matching the cap of the client backoff (a healthy reconnecting tab
// connects ~5×/min during a sustained outage, well under 30/min).

const LIVE_SYNC_CONNECT_WINDOW_MS = 60_000;
const LIVE_SYNC_CONNECT_BURST = 30;
const LIVE_SYNC_CONNECT_RING_CAP = 200;
const _liveSyncConnectAttempts: Map<string, number[]> = new Map();

export const LIVE_SYNC_CONNECT_RATE_LIMIT = {
  windowMs: LIVE_SYNC_CONNECT_WINDOW_MS,
  burst: LIVE_SYNC_CONNECT_BURST,
};

/**
 * Returns true if this fingerprint has already exceeded the connect
 * burst inside the rolling window — caller should respond 429 *and*
 * still record the outcome (so the watchdog sees rate-limited reasons
 * in the rejection histogram). Pure read.
 */
export function isConnectRateLimited(
  fingerprint: string,
  now: number = Date.now(),
): boolean {
  const ring = _liveSyncConnectAttempts.get(fingerprint);
  if (!ring || ring.length === 0) return false;
  const cutoff = now - LIVE_SYNC_CONNECT_WINDOW_MS;
  let firstKept = 0;
  while (firstKept < ring.length && ring[firstKept] < cutoff) firstKept++;
  if (firstKept > 0) ring.splice(0, firstKept);
  return ring.length >= LIVE_SYNC_CONNECT_BURST;
}

/**
 * Record a connect attempt for the given fingerprint. Always called by
 * the route, even when the request is going to be rate-limited — so
 * the burst doesn't reset by virtue of being throttled.
 */
export function recordConnectAttempt(
  fingerprint: string,
  now: number = Date.now(),
): void {
  let ring = _liveSyncConnectAttempts.get(fingerprint);
  if (!ring) {
    ring = [];
    _liveSyncConnectAttempts.set(fingerprint, ring);
  }
  ring.push(now);
  if (ring.length > LIVE_SYNC_CONNECT_RING_CAP) {
    ring.splice(0, ring.length - LIVE_SYNC_CONNECT_RING_CAP / 2);
  }
}

/** Test-only: clear all health metric state between cases. */
export function _resetLiveSyncMetricsForTests(): void {
  _liveSyncAuthRing.success.length = 0;
  _liveSyncAuthRing.failure.length = 0;
  _liveSyncAuthRingByUser.clear();
  _liveSyncRejectionByReason.clear();
  _lastPublishByOrgTopic.clear();
  _liveSyncConnectAttempts.clear();
  for (const c of _activeConnections.values()) {
    try { c.close("test-reset"); } catch { /* noop */ }
  }
  _activeConnections.clear();
  _activeByUser.clear();
  _activeByOrg.clear();
}

/** Test-only: inspect the active-connection registry. */
export function _getActiveConnectionsForTests(): ActiveConnection[] {
  return [..._activeConnections.values()];
}
