// Task #973 — Pure helpers for the live-sync EventSource reconnect loop.
//
// Kept in a separate module so the math is unit-testable without standing
// up React, JSDOM, or an EventSource shim. The hook
// (`client/src/hooks/useLiveSync.ts`) imports these and threads the
// returned numbers into a `setTimeout` for the actual reconnect.
//
// Why a custom backoff instead of EventSource's built-in retry:
//   - EventSource auto-reconnect re-uses the same URL, which means an
//     expired Clerk JWT in `?token=` would 401 forever. We always tear
//     down the connection on `onerror` and re-mint a fresh URL on
//     manual reconnect.
//   - We want jitter to avoid a thundering-herd reconnect from every
//     open tab in an org when the SSE endpoint blips.
//   - We want a hard ceiling so a long outage doesn't push the next
//     attempt into 10-minute land — 30 s is enough headroom that the
//     server can recover but tight enough that a returning user sees
//     fresh data within seconds.

/** Lower bound (ms) of the very first reconnect attempt. */
export const LIVE_SYNC_RECONNECT_BASE_MS = 1_000;
/** Upper bound (ms) of any single reconnect attempt. */
export const LIVE_SYNC_RECONNECT_CAP_MS = 30_000;
/** Jitter fraction (±0.25 = ±25%). */
export const LIVE_SYNC_RECONNECT_JITTER = 0.25;

/**
 * Compute the next reconnect delay using full exponential backoff plus
 * symmetric jitter. `attempt` is 1-indexed:
 *   attempt=1 → ~1s    (base × 2^0)
 *   attempt=2 → ~2s    (base × 2^1)
 *   attempt=3 → ~4s
 *   attempt=4 → ~8s
 *   attempt=5 → ~16s
 *   attempt=6+ → ~30s  (capped)
 *
 * The jitter is multiplicative — the returned value is in
 * `[base*(1-jitter), base*(1+jitter)]`. Pass a deterministic `random`
 * (e.g. a counter) in tests to pin the output.
 */
export function computeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(attempt) || attempt < 1) attempt = 1;
  // Cap the exponent so 2^n doesn't overflow on long outages.
  const exponent = Math.min(attempt - 1, 30);
  const base = Math.min(
    LIVE_SYNC_RECONNECT_CAP_MS,
    LIVE_SYNC_RECONNECT_BASE_MS * Math.pow(2, exponent),
  );
  // jitter in [-J, +J]
  const r = random();
  const offset = (r * 2 - 1) * LIVE_SYNC_RECONNECT_JITTER;
  const jittered = base * (1 + offset);
  // Hard absolute ceiling — jitter can never push us past the cap, even
  // for long outages where base already equals the cap. The lower band
  // (`base*(1-J)`) is still our floor so a degenerate `random()` can't
  // collapse the delay to ~0 and start a thundering herd.
  const min = base * (1 - LIVE_SYNC_RECONNECT_JITTER);
  return Math.max(min, Math.min(LIVE_SYNC_RECONNECT_CAP_MS, jittered));
}

/**
 * Returns true if the previous reconnect attempt count should be reset
 * to zero because the connection has been "live" for long enough that a
 * subsequent failure deserves to start from the bottom of the ladder
 * again. We treat 30 s of being open as a successful session; anything
 * shorter is still considered the same outage.
 */
export const LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS = 30_000;

export function shouldResetAttemptCount(
  livedForMs: number,
): boolean {
  return livedForMs >= LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS;
}

/**
 * Stable per-tab id used by the server to enforce one active connection
 * per (user, tab). Lives in `sessionStorage` so a hard reload of the
 * same tab keeps its id (and the server's existing connection is the
 * one we want to replace, not a new co-tenant).
 *
 * SSR-safe: returns "" when window/sessionStorage are unavailable; the
 * caller falls back to a per-process counter so we never crash.
 */
export function ensureTabId(): string {
  if (typeof window === "undefined") return "";
  try {
    const KEY = "live-sync.tabId";
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    // crypto.randomUUID is available in every modern browser; fall back
    // to a Math.random id in the rare case it isn't (test runners,
    // very old browsers).
    const fresh =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return "";
  }
}
