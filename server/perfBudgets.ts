/**
 * Task #705 — Single source of truth for per-route p95 budgets in ms.
 *
 * Adding a row here automatically enrolls the matching path in the
 * `perfTimingMiddleware` (via `resolveRouteKey`).
 *
 * Choosing a budget: pick a number you'd be embarrassed to ship slower
 * than. The admin perf page shows current p95 alongside each budget so
 * regressions are obvious.
 */

export const ENDPOINT_BUDGETS: Record<string, number> = {
  "GET /api/today-queue": 600,
  "GET /api/nba/cards": 500,
  "GET /api/lane-inbox": 600,
  "GET /api/available-freight": 800,
  "GET /api/recurring-lanes/work-queue": 700,
  "GET /api/carrier-hub": 700,
  "GET /api/customer-quotes": 600,
  "GET /api/internal/conversations": 700,
  "GET /api/dashboard/summary": 800,
  "GET /api/calls/trendline": 600,
  "GET /api/ai-center/fleet": 700,
  "GET /api/valueiq/today": 700,
};

const KEY_PATTERNS: Array<{ method: string; prefix: string; key: string }> = Object.keys(ENDPOINT_BUDGETS).map((k) => {
  const [method, path] = k.split(" ");
  return { method, prefix: path, key: k };
});

/**
 * Map an Express request to a budget key, or null if the request isn't
 * tracked. We deliberately use prefix-match so `/api/nba/cards`,
 * `/api/nba/cards/:id`, and `/api/nba/cards?filter=…` all roll up to one
 * row in the perf overview.
 */
export function resolveRouteKey(path: string, method: string): string | null {
  for (const p of KEY_PATTERNS) {
    if (p.method !== method) continue;
    if (path === p.prefix || path.startsWith(p.prefix + "/") || path.startsWith(p.prefix + "?")) {
      return p.key;
    }
  }
  return null;
}
