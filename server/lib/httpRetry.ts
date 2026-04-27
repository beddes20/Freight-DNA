/**
 * Task #706 — Shared resilience helper for outbound HTTP calls.
 *
 * Wraps `fetch` with:
 *   - configurable timeout (per-source default, overridable)
 *   - exponential-backoff retry with jitter on 5xx / network errors / 429
 *   - per-source circuit breaker (threshold failures in a window → OPEN
 *     for a per-source cooldown). Some sources (SONAR) trip immediately
 *     on a specific status code (HTTP 451 — record-cap limit).
 *   - automatic Retry-After header honoring on 429 / 503
 *   - emits `recordIntegrationEvent` so the Integrations Health Console
 *     and the per-widget <IntegrationDegradedPill /> see the result
 *
 * Services should call:
 *
 *   import { resilientFetch } from "../lib/httpRetry";
 *   const res = await resilientFetch("sonar", () =>
 *     fetch(url, { headers, signal }), { timeoutMs: 8_000 });
 *
 * The supplied factory must return a fresh `fetch` Promise on each call so
 * the helper can retry. The helper returns the underlying Response (which
 * may have a non-2xx status — callers still validate the body).
 */
import { recordIntegrationEvent, type IntegrationSource } from "../integrations/probeRegistry";

export interface ResilientFetchOptions {
  timeoutMs?: number;
  retries?: number;
  retryOn?: (statusOrError: number | Error) => boolean;
  /**
   * Status codes that immediately trip the circuit breaker on first
   * occurrence (e.g. SONAR 451 record-cap). The response is still returned
   * so the caller can short-circuit with cached/fallback data.
   */
  tripImmediatelyOn?: number[];
  /**
   * Honor `Retry-After` on 429/503 responses (default `true`). Set false
   * for legacy callers that already handle the header upstream.
   */
  respectRetryAfter?: boolean;
}

export interface SourcePolicy {
  timeoutMs: number;
  retries: number;
  retryOn?: (s: number | Error) => boolean;
  breakerCooldownMs: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  tripImmediatelyOn?: number[];
  respectRetryAfter: boolean;
}

// Per-source defaults. SONAR is conservative because of the 451 record-cap;
// Webex respects Retry-After strictly; Graph is more aggressive (transient
// 503s are common during mailbox throttling).
const DEFAULT_POLICY: SourcePolicy = {
  timeoutMs: 15_000,
  retries: 2,
  breakerCooldownMs: 60_000,
  breakerThreshold: 5,
  breakerWindowMs: 60_000,
  respectRetryAfter: true,
};
const POLICIES: Record<IntegrationSource, SourcePolicy> = {
  sonar: {
    ...DEFAULT_POLICY,
    timeoutMs: 12_000,
    retries: 1,
    breakerCooldownMs: 30 * 60_000,
    tripImmediatelyOn: [451],
  },
  graph: { ...DEFAULT_POLICY, timeoutMs: 15_000, retries: 3 },
  webex: { ...DEFAULT_POLICY, timeoutMs: 15_000, retries: 4 },
  zoominfo: { ...DEFAULT_POLICY, timeoutMs: 10_000, retries: 2 },
  onedrive: { ...DEFAULT_POLICY, timeoutMs: 30_000, retries: 3 },
  trac: { ...DEFAULT_POLICY, timeoutMs: 10_000, retries: 2 },
  stripe: { ...DEFAULT_POLICY, timeoutMs: 10_000, retries: 2 },
};

export function getPolicy(source: IntegrationSource): SourcePolicy {
  return POLICIES[source];
}

interface BreakerState {
  consecutiveFailures: number;
  windowStart: number;
  openedAt: number | null;
}
const breakers = new Map<IntegrationSource, BreakerState>();

function getBreaker(source: IntegrationSource): BreakerState {
  let b = breakers.get(source);
  if (!b) {
    b = { consecutiveFailures: 0, windowStart: Date.now(), openedAt: null };
    breakers.set(source, b);
  }
  return b;
}

function breakerStateFor(source: IntegrationSource, b: BreakerState): "closed" | "open" | "half_open" {
  if (b.openedAt == null) return "closed";
  const cooldown = POLICIES[source].breakerCooldownMs;
  if (Date.now() - b.openedAt > cooldown) return "half_open";
  return "open";
}

function recordSuccess(source: IntegrationSource) {
  const b = getBreaker(source);
  b.consecutiveFailures = 0;
  b.openedAt = null;
  b.windowStart = Date.now();
  recordIntegrationEvent({ source, outcome: "success", breakerState: "closed" });
}

function recordFailure(source: IntegrationSource, err: string) {
  const b = getBreaker(source);
  const policy = POLICIES[source];
  if (Date.now() - b.windowStart > policy.breakerWindowMs) {
    b.consecutiveFailures = 0;
    b.windowStart = Date.now();
  }
  b.consecutiveFailures += 1;
  if (b.consecutiveFailures >= policy.breakerThreshold && b.openedAt == null) {
    b.openedAt = Date.now();
  }
  recordIntegrationEvent({
    source,
    outcome: "error",
    errorMessage: err,
    breakerState: breakerStateFor(source, b),
  });
}

/**
 * Manually trip the circuit breaker for a source. Used by integrations
 * that detect a "stop everything" signal outside the normal failure
 * counting (e.g. SONAR 451 record-cap response).
 */
export function tripBreaker(source: IntegrationSource, reason: string): void {
  const b = getBreaker(source);
  b.openedAt = Date.now();
  recordIntegrationEvent({
    source,
    outcome: "error",
    errorMessage: reason,
    breakerState: "open",
  });
}

/** Manually close a breaker. Test-only — never used by production code. */
export function _resetBreakerForTests(source?: IntegrationSource): void {
  if (source) {
    breakers.delete(source);
  } else {
    breakers.clear();
  }
}

/**
 * Returns the current breaker status in the legacy
 * `getSonarCircuitBreakerStatus()` shape so callers can render it without
 * caring which source they're inspecting.
 */
export function getBreakerStatus(source: IntegrationSource): {
  isOpen: boolean;
  trippedAt: string | null;
  resumesAt: string | null;
} {
  const b = breakers.get(source);
  if (!b || b.openedAt == null) {
    return { isOpen: false, trippedAt: null, resumesAt: null };
  }
  const cooldown = POLICIES[source].breakerCooldownMs;
  const isOpen = Date.now() - b.openedAt < cooldown;
  if (!isOpen) {
    // Cooldown elapsed — treat as closed and surface that to the caller
    // so the next caller can attempt the request (half-open semantics).
    b.openedAt = null;
    return { isOpen: false, trippedAt: null, resumesAt: null };
  }
  return {
    isOpen: true,
    trippedAt: new Date(b.openedAt).toISOString(),
    resumesAt: new Date(b.openedAt + cooldown).toISOString(),
  };
}

class CircuitOpenError extends Error {
  constructor(source: string) { super(`Circuit breaker OPEN for ${source}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  // HTTP-date form
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const wait = dateMs - Date.now();
    return wait > 0 ? Math.min(60_000, wait) : 0;
  }
  return null;
}

export async function resilientFetch(
  source: IntegrationSource,
  fetchFactory: () => Promise<Response>,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const policy = POLICIES[source];
  const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
  const retries = opts.retries ?? policy.retries;
  const retryOn = opts.retryOn ?? defaultRetryOn;
  const tripImmediatelyOn = opts.tripImmediatelyOn ?? policy.tripImmediatelyOn ?? [];
  const respectRetryAfter = opts.respectRetryAfter ?? policy.respectRetryAfter;

  // Half-open semantics: getBreakerStatus() resets `openedAt` to null when
  // the cooldown has elapsed, so we always read the current state via it.
  const status = getBreakerStatus(source);
  if (status.isOpen) {
    recordIntegrationEvent({
      source,
      outcome: "breaker_open",
      errorMessage: "circuit open — short-circuited",
      breakerState: "open",
    });
    throw new CircuitOpenError(source);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetchFactory(), timeoutMs);

      // Immediate-trip statuses (e.g. SONAR 451 record-cap).
      if (tripImmediatelyOn.includes(res.status)) {
        tripBreaker(source, `HTTP ${res.status} — immediate breaker trip`);
        return res;
      }

      if (res.ok) {
        recordSuccess(source);
        return res;
      }
      // 4xx other than 429 are caller errors — don't retry, don't trip breaker.
      if (res.status < 500 && res.status !== 429) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt === retries || !retryOn(res.status)) {
        recordFailure(source, lastError.message);
        return res;
      }

      // Honor Retry-After on 429/503 if the policy says so.
      if (respectRetryAfter && (res.status === 429 || res.status === 503)) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfterMs != null) {
          await sleep(retryAfterMs);
          continue;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === retries || !retryOn(lastError)) {
        recordFailure(source, lastError.message);
        throw lastError;
      }
    }
    // exponential backoff with ±20% jitter: 200ms, 600ms, 1.4s, ...
    const base = 200 * Math.pow(3, attempt);
    const jitter = base * (0.2 * (Math.random() * 2 - 1));
    await sleep(Math.max(50, Math.round(base + jitter)));
  }
  throw lastError ?? new Error("resilientFetch: exhausted retries");
}

function defaultRetryOn(s: number | Error): boolean {
  if (typeof s === "number") return s >= 500 || s === 429;
  // Network/timeout/abort
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export { CircuitOpenError };
