/**
 * In-memory cache for `buildLanesFromRows` output keyed by the sorted set
 * of source financial upload IDs. Lane rebuilds are pure CPU work over the
 * raw row arrays, so caching them eliminates redundant work across the
 * `/api/intel`, `/api/intel/brief`, and `/api/intel/my-lanes` endpoints
 * that each iterate the same uploads.
 *
 * Entries auto-expire after TTL_MS to bound memory and stay loosely fresh
 * with the underlying `getFinancialUploadsForOrg` cache (which has its own
 * shorter TTL inside storage).
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 24;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, Entry<unknown>>();

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

export function makeLanesCacheKey(orgId: string, uploadIds: string[], suffix: string): string {
  const sorted = [...uploadIds].sort().join(",");
  return `${orgId}::${suffix}::${sorted}`;
}

export function getLanesCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setLanesCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  evictIfNeeded();
}
