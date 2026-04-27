/**
 * Task #706 — Shared resilience helper for outbound HTTP calls.
 *
 * Wraps `fetch` with:
 *   - configurable timeout (default 15s)
 *   - exponential-backoff retry on 5xx / network errors / 429 (default 2 retries)
 *   - per-source circuit breaker (5 failures in 60s → OPEN for 60s)
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
}

interface BreakerState {
  consecutiveFailures: number;
  windowStart: number;
  openedAt: number | null;
}
const breakers = new Map<IntegrationSource, BreakerState>();
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

function getBreaker(source: IntegrationSource): BreakerState {
  let b = breakers.get(source);
  if (!b) {
    b = { consecutiveFailures: 0, windowStart: Date.now(), openedAt: null };
    breakers.set(source, b);
  }
  return b;
}

function breakerStateFor(b: BreakerState): "closed" | "open" | "half_open" {
  if (b.openedAt == null) return "closed";
  if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) return "half_open";
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
  if (Date.now() - b.windowStart > BREAKER_WINDOW_MS) {
    b.consecutiveFailures = 0;
    b.windowStart = Date.now();
  }
  b.consecutiveFailures += 1;
  if (b.consecutiveFailures >= BREAKER_THRESHOLD && b.openedAt == null) {
    b.openedAt = Date.now();
  }
  recordIntegrationEvent({
    source,
    outcome: "error",
    errorMessage: err,
    breakerState: breakerStateFor(b),
  });
}

class CircuitOpenError extends Error {
  constructor(source: string) { super(`Circuit breaker OPEN for ${source}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resilientFetch(
  source: IntegrationSource,
  fetchFactory: () => Promise<Response>,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const retryOn = opts.retryOn ?? defaultRetryOn;

  const breakerCurrent = breakerStateFor(getBreaker(source));
  if (breakerCurrent === "open") {
    recordIntegrationEvent({
      source, outcome: "breaker_open",
      errorMessage: "circuit open — short-circuited",
      breakerState: "open",
    });
    throw new CircuitOpenError(source);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetchFactory(), timeoutMs);
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
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === retries || !retryOn(lastError)) {
        recordFailure(source, lastError.message);
        throw lastError;
      }
    }
    // exponential backoff: 200ms, 600ms, 1.4s
    const delay = 200 * Math.pow(3, attempt);
    await sleep(delay);
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
