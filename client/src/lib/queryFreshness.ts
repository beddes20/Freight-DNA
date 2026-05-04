// SSE/cache ordering guard. `useLiveSync` calls `markQueryInvalidated`
// when it dispatches an invalidation; surfaces wrap their `queryFn`
// with `fetchWithFreshnessGuard` so a fetch that started before a
// later invalidation is discarded and re-run once.

const _lastInvalidatedAt = new Map<string, number>();

/**
 * Stamp `keyOrPrefix` as invalidated at `at` (defaults to Date.now()).
 * Monotonic — older timestamps are ignored so we never regress the
 * watermark.
 */
export function markQueryInvalidated(
  keyOrPrefix: string,
  at: number = Date.now(),
): void {
  if (!keyOrPrefix) return;
  const prev = _lastInvalidatedAt.get(keyOrPrefix) ?? 0;
  if (at > prev) _lastInvalidatedAt.set(keyOrPrefix, at);
}

/** Read the most-recent invalidation watermark, or null if never seen. */
export function getLastInvalidatedAt(keyOrPrefix: string): number | null {
  return _lastInvalidatedAt.get(keyOrPrefix) ?? null;
}

export interface FreshnessGuardOptions<T> {
  /** Stable key — typically the URL prefix that matches the query key. */
  cacheKey: string;
  /** The fetch function. Will be invoked once normally and (at most) once more if the first response races a stale invalidation. */
  fetcher: () => Promise<T>;
  /** Surface tag for the optional ?debug=lwq / ?debug=freshness console marker. */
  debugTag?: string;
}

/**
 * Run `fetcher`; if a query invalidation arrived AFTER we started the
 * fetch, discard the result and re-fetch once. The re-fetched response
 * is returned regardless of any further invalidations to bound the
 * recursion to a single retry.
 */
export async function fetchWithFreshnessGuard<T>(
  opts: FreshnessGuardOptions<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await opts.fetcher();
  const invAt = getLastInvalidatedAt(opts.cacheKey);
  if (invAt !== null && invAt > startedAt) {
    if (isFreshnessDebug()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[freshness-guard${opts.debugTag ? `:${opts.debugTag}` : ""}] ` +
          `dropping stale fetch cacheKey=${opts.cacheKey} startedAt=${startedAt} invalidatedAt=${invAt}`,
      );
    }
    return await opts.fetcher();
  }
  return result;
}

function isFreshnessDebug(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = new URLSearchParams(window.location.search).get("debug");
    return v === "lwq" || v === "freshness" || v === "livesync";
  } catch {
    return false;
  }
}

/** Test-only: clear the in-memory map between cases. */
export function _resetFreshnessGuardForTests(): void {
  _lastInvalidatedAt.clear();
}

/** Test-only: peek the watermark for assertions. */
export function _peekFreshnessForTests(keyOrPrefix: string): number | undefined {
  return _lastInvalidatedAt.get(keyOrPrefix);
}
