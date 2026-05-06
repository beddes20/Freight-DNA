/**
 * AI helper status collector — Task #4 ("level up" honesty pass).
 *
 * Why this exists
 * ───────────────
 * Every helper in `server/aiHelpers.ts` (and a few siblings) historically
 * returned `null` on three completely different failure modes:
 *   1. The relevant API key isn't configured for this environment
 *      (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY` missing).
 *   2. The upstream call threw — rate limit, timeout, 500, parse error.
 *   3. The model returned a genuinely empty response (rare, but real).
 *
 * The Intel page consumes those `null`s by *hiding* the affected card.
 * From a rep's perspective that means "the AI summary just disappeared"
 * with no signal whether it's broken, unconfigured, or simply had nothing
 * useful to say. That's the honesty gap we're closing.
 *
 * How this works
 * ──────────────
 * AsyncLocalStorage gives us a per-request "bag" that helpers can write to
 * without changing any of their existing return-type signatures (which
 * would force a 7-call-site refactor across a 2,272-line route file). The
 * route handler wraps the compute call in `withAiStatusContext` and reads
 * the bag from `getAiStatusBag()` *after* awaiting all helpers. The bag is
 * attached to the JSON response under the `_aiStatus` key.
 *
 * The same pattern is already used elsewhere in the codebase
 * (`server/sonarClient.ts` uses ALS for caller-tag propagation), so this
 * isn't introducing a new primitive.
 *
 * Outside an `aiStatusContext` (cron jobs, background workers, etc) the
 * `recordAiStatus` call is a silent no-op — it only collects when there's
 * a bag in scope, so the helpers stay safe to call from any code path.
 */

import { AsyncLocalStorage } from "async_hooks";

/**
 * Categories map to the visible UI sections on the Intel page so the
 * frontend can attach the right banner to the right card. Keep this
 * union narrow — adding a new category means adding a new place to render
 * the banner.
 */
export type AiHelperCategory =
  | "alert_narrative"
  | "spot_opportunity"
  | "buy_rate_rationale"
  | "lane_narrative"
  | "executive_brief"
  | "market_context"
  | "coaching_card";

/**
 * Failure modes. We deliberately distinguish `unconfigured` from `failed`
 * because the user-facing copy and the resolution path are different:
 *   - `unconfigured` → an admin must set an API key
 *   - `failed`       → a transient outage; retry will likely succeed
 *   - `empty`        → the model returned nothing; not a defect
 *   - `ok`           → at least one call in this category succeeded
 */
export type AiHelperStatus = "ok" | "unconfigured" | "failed" | "empty";

export interface AiStatusEntry {
  status: AiHelperStatus;
  /** Optional human-readable reason — used in tooltips. Never includes secrets. */
  reason?: string;
  /** How many calls in this category landed on this status during the request. */
  count: number;
}

export type AiStatusBag = Partial<Record<AiHelperCategory, AiStatusEntry>>;

const storage = new AsyncLocalStorage<AiStatusBag>();

/**
 * Run `fn` inside a fresh AI-status collection scope. Helper calls made
 * (transitively) inside `fn` will record into the returned bag. The bag is
 * also passed to `fn` as a convenience so route handlers don't need to
 * call `getAiStatusBag` themselves.
 */
export async function withAiStatusContext<T>(
  fn: (bag: AiStatusBag) => Promise<T>,
): Promise<{ result: T; aiStatus: AiStatusBag }> {
  const bag: AiStatusBag = {};
  const result = await storage.run(bag, () => fn(bag));
  return { result, aiStatus: bag };
}

/** Return the bag in scope, or `undefined` if no context is active. */
export function getAiStatusBag(): AiStatusBag | undefined {
  return storage.getStore();
}

/**
 * Record a status for a category. The "best" status wins per category for
 * a request — i.e. if any call in a category succeeded we report `ok`
 * even if a peer call also failed, because the section will have at
 * least *some* AI output to render. This mirrors the existing per-card
 * UI behavior (a single non-null narrative is enough to show the card).
 *
 * Severity ordering (best → worst): ok > empty > failed > unconfigured.
 * The bag stores the *worst* observed status for a category that has not
 * yet seen an `ok`. Once a category has seen `ok`, subsequent failures
 * don't downgrade it.
 */
export function recordAiStatus(
  category: AiHelperCategory,
  status: AiHelperStatus,
  reason?: string,
): void {
  const bag = storage.getStore();
  if (!bag) return; // Outside a context — no-op (cron jobs, etc).
  const existing = bag[category];
  if (!existing) {
    bag[category] = { status, reason, count: 1 };
    return;
  }
  existing.count += 1;
  // Once we've seen any success, lock the category in as ok.
  if (existing.status === "ok") return;
  if (status === "ok") {
    existing.status = "ok";
    existing.reason = undefined;
    return;
  }
  // For non-ok statuses, prefer the more actionable signal.
  // unconfigured (admin must act) > failed (transient) > empty (model returned nothing)
  const rank: Record<AiHelperStatus, number> = {
    ok: 0,
    empty: 1,
    failed: 2,
    unconfigured: 3,
  };
  if (rank[status] > rank[existing.status]) {
    existing.status = status;
    existing.reason = reason;
  }
}

/**
 * Convenience helper: `true` if any category in the bag is non-ok.
 * Used by tests and routes that want a single boolean to short-circuit.
 */
export function isAnyDegraded(bag: AiStatusBag | undefined): boolean {
  if (!bag) return false;
  return Object.values(bag).some(e => e && e.status !== "ok");
}
