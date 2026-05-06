/**
 * Task #705 — Per-request perf hints.
 *
 * Tiny dependency-free helper so cache layers (`server/cache.ts`,
 * `server/dbCache.ts`) can tag the current Express request as warm/cold
 * without pulling in the routes layer (which would create a circular
 * import).  The timing middleware in `server/routes/endpointPerf.ts`
 * reads the hint off the request object when the response finishes.
 */
import type { Request } from "express";

export type CacheHint = "cold" | "warm" | "miss" | "hit";

interface RequestWithPerfHint {
  __perfCacheHint?: CacheHint;
}

export function markCacheHint(req: Request, hint: CacheHint): void {
  (req as Request & RequestWithPerfHint).__perfCacheHint = hint;
}

export function getCacheHint(req: Request): CacheHint | undefined {
  return (req as Request & RequestWithPerfHint).__perfCacheHint;
}
