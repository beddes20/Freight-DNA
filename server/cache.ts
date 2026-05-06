/**
 * Tiny in-memory key/value cache used by hot read paths (mostly
 * `/api/dashboard/summary`, lane build, and a few others).
 *
 * Optional `req` argument on `cacheGet`: pass the live Express request
 * and the cache will tag it as `warm` (hit) or `cold` (miss/expired) via
 * `markCacheHint`. The Task #705 perf middleware reads this hint when
 * the response finishes so cache regressions are visible on the admin
 * Endpoint Performance page.
 */
import type { Request } from "express";
import { markCacheHint } from "./lib/perfHints";

interface CacheEntry {
  data: unknown;
  expires: number;
}

const store = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function cacheGet<T>(key: string, req?: Request): T | undefined {
  const entry = store.get(key);
  if (!entry) {
    if (req) markCacheHint(req, "cold");
    return undefined;
  }
  if (Date.now() > entry.expires) {
    store.delete(key);
    if (req) markCacheHint(req, "cold");
    return undefined;
  }
  if (req) markCacheHint(req, "warm");
  return entry.data as T;
}

export function cacheSet(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): void {
  store.set(key, { data, expires: Date.now() + ttlMs });
}

export function cacheInvalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheInvalidateKey(key: string): void {
  store.delete(key);
}
