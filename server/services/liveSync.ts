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
  | "mailbox_outbound";

export interface LiveSyncEvent {
  topic: LiveSyncTopic;
  /** Optional row id (opp id, lane id, etc.) for clients that key on it. */
  key?: string;
  ts: number;
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
): void {
  if (!orgId) return;
  try {
    const ts = Date.now();
    const evt: LiveSyncEvent = { topic, key, ts };
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

// ── Health metrics (Task #951) ─────────────────────────────────────────────
//
// In-memory counters consumed by `mailboxWatchdogService.runLiveSyncHealthCheck`
// to fire admin alerts when the live-sync stream is broken. Two failure
// modes we explicitly want to detect early:
//
//   1. `live_sync_auth_failure` — the SSE endpoint is rejecting most/all
//      connection attempts (the exact prod regression that caused
//      Conversations to stop auto-updating). Tracked as a process-wide
//      rolling 60s window of (success, failure) outcomes.
//
//   2. `live_sync_silent_stream` — mailbox ingest is happening (webhook
//      or delta-sync just wrote a row) but `publish()` for the matching
//      mailbox_inbound/_outbound topic never fired. Tracked per (orgId,
//      topic) as the timestamp of the last publish.
//
// Module-scoped state — the server is a single process and the watchdog
// cron is a singleton, so this is safe. If we ever scale horizontally
// these getters move behind a Redis-backed counter.

interface AuthOutcomeRing {
  /** Unix-ms timestamps of recent successful connects. */
  success: number[];
  /** Unix-ms timestamps of recent rejected connects. */
  failure: number[];
}
const _liveSyncAuthRing: AuthOutcomeRing = { success: [], failure: [] };
const LIVE_SYNC_AUTH_WINDOW_MS = 60_000;
// Cap each ring so a long-running burst can't grow unbounded between
// watchdog ticks. 1000 events/min is far above any realistic prod rate
// (each open tab reconnects every few seconds — caps out around ~300/min
// for hundreds of tabs), and the watchdog drains it every minute anyway.
const LIVE_SYNC_AUTH_RING_CAP = 1000;

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
 */
export function recordLiveSyncAuthOutcome(success: boolean): void {
  const now = Date.now();
  const ring = success ? _liveSyncAuthRing.success : _liveSyncAuthRing.failure;
  ring.push(now);
  if (ring.length > LIVE_SYNC_AUTH_RING_CAP) {
    // Drop the oldest half — a hard cap keeps memory bounded under
    // pathological loops without losing the recent signal.
    ring.splice(0, ring.length - LIVE_SYNC_AUTH_RING_CAP / 2);
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

/** Test-only: clear all health metric state between cases. */
export function _resetLiveSyncMetricsForTests(): void {
  _liveSyncAuthRing.success.length = 0;
  _liveSyncAuthRing.failure.length = 0;
  _lastPublishByOrgTopic.clear();
}
