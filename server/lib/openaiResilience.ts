/**
 * OpenAI resilience wrapper — module-level circuit breaker + throttled logging.
 *
 * Purpose
 * -------
 * Background AI flows (email intelligence extraction, quote-email AI parse,
 * lost-reason classification, …) all hit the same OpenAI API key. When the
 * key runs out of quota, every cron tick fires hundreds of requests, each
 * throwing `429 insufficient_quota` and dumping a full stack trace. The log
 * stream becomes unreadable, the upstream cost continues to accrue per-request,
 * and downstream batches that depend on these flows stall behind doomed retries.
 *
 * This module centralizes that handling without changing business logic:
 *   - Classifies OpenAI errors into quota / rate-limit / temporary buckets.
 *   - Opens an in-memory cooldown window on the first hit (15 min for quota,
 *     90 s for plain rate-limit, 60 s for temporary 5xx / network failures).
 *   - During a cooldown, calls short-circuit to a typed
 *     `{ ok: false, skipped: true, reason }` result without touching the
 *     network — callers fall back to their existing null/empty paths.
 *   - Throttles repeated cooldown logs to one summary line every 5 minutes
 *     per task name, so the log stream stays signal-rich.
 *
 * State is intentionally process-local. A multi-instance deploy will each
 * trip its own breaker on the first failure, which is fine — the cooldown
 * is short and the goal is log-spam reduction, not strict global rate
 * coordination.
 *
 * Out of scope
 * ------------
 *   - Hand-written request paths (chat routes, agent tools, etc.) that should
 *     surface 429s to the user. Those keep their existing try/catch.
 *   - Retry/backoff. The OpenAI SDK's own `maxRetries` is unchanged; this
 *     wrapper just decides whether to enter the SDK at all.
 */

const QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_COOLDOWN_MS = 90 * 1000; // 90 seconds
const TEMPORARY_COOLDOWN_MS = 60 * 1000;  // 60 seconds
const PER_TASK_LOG_THROTTLE_MS = 5 * 60 * 1000; // one summary line / 5 min / task

export type OpenAISkipReason =
  | "openai_quota_cooldown"
  | "openai_rate_limit"
  | "openai_temporarily_unavailable";

export type OpenAIResilienceResult<T> =
  | { ok: true; data: T }
  | { ok: false; skipped: true; reason: OpenAISkipReason };

interface CooldownState {
  until: number;
  reason: OpenAISkipReason;
}

let cooldown: CooldownState | null = null;
const lastLogAtByTask = new Map<string, number>();

// ── Classifiers ──────────────────────────────────────────────────────────────

function readField(err: unknown, ...keys: string[]): unknown {
  if (!err || typeof err !== "object") return undefined;
  let cur: unknown = err;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function readStatus(err: unknown): number | undefined {
  const status = readField(err, "status");
  if (typeof status === "number") return status;
  const responseStatus = readField(err, "response", "status");
  if (typeof responseStatus === "number") return responseStatus;
  return undefined;
}

function readErrorCode(err: unknown): string | undefined {
  // OpenAI SDK exposes `.code` on the top-level error and also nests the
  // upstream JSON body under `.error.code` / `.error.type`.
  const direct = readField(err, "code");
  if (typeof direct === "string") return direct;
  const nestedCode = readField(err, "error", "code");
  if (typeof nestedCode === "string") return nestedCode;
  const nestedType = readField(err, "error", "type");
  if (typeof nestedType === "string") return nestedType;
  return undefined;
}

export function isOpenAIQuotaError(err: unknown): boolean {
  if (readStatus(err) !== 429) return false;
  const code = readErrorCode(err);
  return code === "insufficient_quota";
}

export function isOpenAIRateLimitError(err: unknown): boolean {
  if (readStatus(err) !== 429) return false;
  // Anything 429 that is NOT insufficient_quota — most commonly
  // `rate_limit_exceeded` or `requests` / `tokens` per-minute caps.
  return readErrorCode(err) !== "insufficient_quota";
}

export function isOpenAITemporaryError(err: unknown): boolean {
  const status = readStatus(err);
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // Node fetch / undici network failures — no HTTP status, just a code.
  const code = readErrorCode(err);
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  ) {
    return true;
  }
  // OpenAI SDK marks "Connection error." with name "APIConnectionError" /
  // "APIConnectionTimeoutError" — treat both as temporary.
  const name = readField(err, "name");
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  return false;
}

// ── Cooldown state ───────────────────────────────────────────────────────────

function activeCooldown(now: number): CooldownState | null {
  if (cooldown && cooldown.until > now) return cooldown;
  if (cooldown) cooldown = null;
  return null;
}

function openCooldown(reason: OpenAISkipReason, durationMs: number, now: number): void {
  const until = now + durationMs;
  // If a cooldown is already active, only extend (never shorten).
  if (cooldown && cooldown.until >= until) return;
  cooldown = { until, reason };
}

function shouldEmitThrottledLog(taskName: string, now: number): boolean {
  const last = lastLogAtByTask.get(taskName) ?? 0;
  if (now - last < PER_TASK_LOG_THROTTLE_MS) return false;
  lastLogAtByTask.set(taskName, now);
  return true;
}

function describeCooldown(c: CooldownState, now: number): string {
  const remainingMs = Math.max(0, c.until - now);
  const remainingSec = Math.round(remainingMs / 1000);
  return `${c.reason} (${remainingSec}s remaining)`;
}

// ── Public wrapper ───────────────────────────────────────────────────────────

/**
 * Wrap an OpenAI-backed task with quota/rate-limit/temporary-failure handling.
 *
 * Behavior:
 *   - If a cooldown is currently open, returns `{ ok: false, skipped: true }`
 *     immediately without invoking `fn`. Emits at most one throttled log line
 *     per task name per 5 minutes.
 *   - Otherwise runs `fn()`. On success returns `{ ok: true, data }`.
 *   - On a recognized OpenAI error (quota / rate-limit / temporary) opens
 *     the appropriate cooldown, logs once at warn level (loud the first time,
 *     throttled thereafter), and returns the typed skip result.
 *   - On any other error (programmer bug, schema mismatch, etc.) re-throws
 *     so the caller's existing handling fires unchanged.
 */
export async function withOpenAIResilience<T>(
  taskName: string,
  fn: () => Promise<T>,
): Promise<OpenAIResilienceResult<T>> {
  const now = Date.now();
  const active = activeCooldown(now);
  if (active) {
    if (shouldEmitThrottledLog(taskName, now)) {
      console.warn(
        `[openai] cooldown active — skipping ${taskName}: ${describeCooldown(active, now)}`,
      );
    }
    return { ok: false, skipped: true, reason: active.reason };
  }

  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    if (isOpenAIQuotaError(err)) {
      openCooldown("openai_quota_cooldown", QUOTA_COOLDOWN_MS, now);
      if (shouldEmitThrottledLog(`${taskName}::quota`, now)) {
        console.error(
          `[openai] insufficient quota — entering cooldown for 15m (task=${taskName})`,
        );
      }
      return { ok: false, skipped: true, reason: "openai_quota_cooldown" };
    }
    if (isOpenAIRateLimitError(err)) {
      openCooldown("openai_rate_limit", RATE_LIMIT_COOLDOWN_MS, now);
      if (shouldEmitThrottledLog(`${taskName}::ratelimit`, now)) {
        console.warn(
          `[openai] rate-limited — entering cooldown for 90s (task=${taskName})`,
        );
      }
      return { ok: false, skipped: true, reason: "openai_rate_limit" };
    }
    if (isOpenAITemporaryError(err)) {
      openCooldown("openai_temporarily_unavailable", TEMPORARY_COOLDOWN_MS, now);
      if (shouldEmitThrottledLog(`${taskName}::temporary`, now)) {
        const status = readStatus(err);
        const code = readErrorCode(err);
        console.warn(
          `[openai] temporary failure — entering cooldown for 60s (task=${taskName}, status=${status ?? "n/a"}, code=${code ?? "n/a"})`,
        );
      }
      return { ok: false, skipped: true, reason: "openai_temporarily_unavailable" };
    }
    throw err;
  }
}

// ── Test / ops helpers ───────────────────────────────────────────────────────

/** Inspect the current cooldown (read-only). Returns null when inactive. */
export function getOpenAICooldown(): Readonly<CooldownState> | null {
  const active = activeCooldown(Date.now());
  return active ? { ...active } : null;
}

/** Force-clear the cooldown — for tests and operator recovery only. */
export function resetOpenAICooldown(): void {
  cooldown = null;
  lastLogAtByTask.clear();
}
