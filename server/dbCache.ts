/**
 * Generic DB-backed JSON cache wrapper around storage.getCachedApiResponse /
 * setCachedApiResponse. Adds a small in-memory L1 layer so repeated hits within
 * the same request avoid an extra DB round-trip.
 *
 * Used by aiHelpers (Claude/OpenAI/Perplexity narratives) and the intel route
 * (lane build cache, rate positioning cache).
 */

import type { Request } from "express";
import { storage } from "./storage";
import { markCacheHint } from "./lib/perfHints";

interface MemEntry<T> {
  value: T;
  fetchedAt: number;
  ttlMs: number;
}

const mem = new Map<string, MemEntry<unknown>>();

export async function getDbCached<T>(key: string, req?: Request): Promise<T | null> {
  const m = mem.get(key);
  if (m && Date.now() - m.fetchedAt < m.ttlMs) {
    if (req) markCacheHint(req, "warm");
    return m.value as T;
  }

  try {
    const row = await storage.getCachedApiResponse(key);
    if (!row) {
      if (req) markCacheHint(req, "cold");
      return null;
    }
    const value = row.response as T;
    const ttlMs = row.ttlSeconds * 1000;
    const fetchedAt = new Date(row.fetchedAt).getTime();
    mem.set(key, { value, fetchedAt, ttlMs });
    if (Date.now() - fetchedAt >= ttlMs) {
      if (req) markCacheHint(req, "cold");
      return null;
    }
    if (req) markCacheHint(req, "warm");
    return value;
  } catch {
    if (req) markCacheHint(req, "cold");
    return null;
  }
}

export function setDbCached<T>(
  key: string,
  value: T,
  ttlSeconds: number,
  source: string,
): void {
  mem.set(key, { value, fetchedAt: Date.now(), ttlMs: ttlSeconds * 1000 });
  storage.setCachedApiResponse(key, value as unknown, ttlSeconds, source).catch(() => {
    /* non-blocking */
  });
}

/** Drop a key from the in-memory L1 layer (DB row remains until TTL). */
export function invalidateMemDbCache(key: string): void {
  mem.delete(key);
}
