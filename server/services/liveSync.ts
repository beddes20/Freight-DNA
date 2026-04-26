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
  | "daily_workspace";

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
    const evt: LiveSyncEvent = { topic, key, ts: Date.now() };
    emitter.emit(channelFor(orgId), evt);
    emitter.emit(ALL_CHANNEL, { ...evt, orgId } as LiveSyncEventWithOrg);
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
