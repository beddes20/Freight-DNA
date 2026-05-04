// Task #967 — Shared trust layer: row-version guard.
//
// Ops surfaces (Customer Quotes, Conversations, LWQ, Available Freight)
// receive live-sync events that trigger React Query cache invalidations.
// In rare reorder windows — server fan-out racing against an out-of-band
// HTTP refetch, or two write paths publishing the same row in quick
// succession — a *stale* event can arrive after a fresher snapshot has
// already been written into the cache. Replaying it would briefly flash
// the older row before the next fetch corrects it.
//
// `applyRowVersionGuard` keeps a tiny per-(topic, key) memory of the
// most-recent `rowVersionAt` we've actually applied. When a new event
// arrives:
//
//   • if it carries no rowVersionAt          → apply (legacy behaviour;
//                                                publish paths roll out
//                                                rowVersionAt
//                                                incrementally)
//   • if no key is on the event              → apply (topic-wide fan-out
//                                                isn't tied to a specific
//                                                row)
//   • if rowVersionAt > stored               → record + apply
//   • if rowVersionAt ≤ stored               → DROP (the cache is fresher)
//
// The guard is purposefully tiny (no LRU eviction, no cross-tab
// synchronization). The bounded growth comes from the natural lifecycle
// of rows in the ops surfaces — a long-lived browser session sees on the
// order of thousands of distinct row keys, well within the multi-MB
// budget of an in-memory Map. If that ever becomes a concern, an LRU
// wrapper drops in transparently behind this same export.

export interface RowVersionEvent {
  topic: string;
  key?: string | null;
  /**
   * Server-stamped row version. Epoch ms. Optional so legacy publish
   * paths that haven't been migrated to thread a row mtime continue to
   * work unchanged (those events bypass the guard and always apply).
   */
  rowVersionAt?: number | null;
}

const _versionByKey = new Map<string, number>();

function makeKey(topic: string, key: string): string {
  return `${topic}::${key}`;
}

/**
 * Returns true when the event should be applied (cache invalidated /
 * UI updated). Returns false when the event is older than something
 * we've already applied for the same (topic, key).
 *
 * Logs a console.warn when an out-of-order event is dropped AND the
 * page URL contains `?debug=livesync` so QA can reproduce ordering bugs
 * without filling production consoles with chatter.
 */
export function applyRowVersionGuard(evt: RowVersionEvent): boolean {
  if (!evt || !evt.topic) return true;
  const ver = evt.rowVersionAt;
  if (ver == null || !Number.isFinite(ver)) return true;
  const key = evt.key;
  if (!key) return true;

  const composite = makeKey(evt.topic, key);
  const prev = _versionByKey.get(composite);

  if (prev !== undefined && ver <= prev) {
    if (isDebugLiveSync()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live-sync] dropping out-of-order event topic=${evt.topic} key=${key} ` +
        `rowVersionAt=${ver} prev=${prev}`,
      );
    }
    return false;
  }

  _versionByKey.set(composite, ver);
  return true;
}

/**
 * QA escape hatch — `?debug=livesync` in the URL turns on the "dropped
 * an event" console.warn. Cheap to compute on every event because we
 * only read window.location, but guarded behind a typeof check so SSR
 * / unit-test environments don't crash.
 */
function isDebugLiveSync(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const sp = new URLSearchParams(window.location.search);
    return sp.get("debug") === "livesync";
  } catch {
    return false;
  }
}

/** Test-only: clear the in-memory map between cases. */
export function _resetRowVersionGuardForTests(): void {
  _versionByKey.clear();
}

/** Test-only: read the cached version for a (topic, key) pair. */
export function _peekRowVersionForTests(topic: string, key: string): number | undefined {
  return _versionByKey.get(makeKey(topic, key));
}
