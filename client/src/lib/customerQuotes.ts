/**
 * Task #969 — Customer Quotes trust hardening (defect 3).
 *
 * Canonical helpers for the Customer Quotes UI surface. Today the only
 * thing exported here is `formatQuoteConfidence` — every place that
 * renders a "confidence" number for a quote (action queue, list rows,
 * detail drawer, admin pipeline-health drops table) goes through this
 * formatter so the rep never sees `0.97`, `1.42`, or `-0.1`.
 *
 * Rules:
 *   - `null` / `undefined` / `NaN` → `"—"`
 *   - numeric input is clamped to `[0, 1]`
 *   - rendered as `Math.round(clamped * 100)` followed by `%`
 *
 * The clamp is defensive — degenerate parser outputs occasionally
 * produced values >1 or <0; the original Customer Quotes audit found
 * one path that returned `1.42` and the rep stopped trusting the
 * column entirely.
 */
export function formatQuoteConfidence(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return "—";
  const clamped = Math.max(0, Math.min(1, num));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Task #1153 — `_handoff` → `handoff` rename for the won-quote toast.
 *
 * `PATCH /api/customer-quotes/quote/:id` returns a quote-detail payload
 * with a routing-decision side-channel. Originally that field was named
 * `_handoff` (an underscore-prefixed implicit contract piggybacking on
 * the detail payload). Task #1153 renames it to `handoff` and keeps
 * `_handoff` as a compatibility alias for one release.
 *
 * Resolution rule: prefer the canonical `handoff`; fall back to
 * `_handoff` only when `handoff` is missing/undefined. Both an old
 * server + new client and a new server + old client must continue to
 * branch the markWon toast correctly.
 *
 * Returned shape mirrors `UpdateQuoteHandoffMeta` in
 * `server/services/customerQuotes.ts`:
 *   { state: "auto" | "pending_approval" | "none", opportunityId: string | null }
 *
 * `null` is returned when neither field is present so callers can fall
 * through to the generic "Quote updated" toast.
 */
export type MarkWonHandoffState = "auto" | "pending_approval" | "none";

export type MarkWonHandoff = {
  state: MarkWonHandoffState;
  opportunityId: string | null;
};

export function resolveMarkWonHandoff(resp: unknown): MarkWonHandoff | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as {
    handoff?: { state?: string; opportunityId?: string | null };
    _handoff?: { state?: string; opportunityId?: string | null };
  };
  const raw = r.handoff ?? r._handoff;
  if (!raw || typeof raw !== "object") return null;
  const state = raw.state;
  if (state !== "auto" && state !== "pending_approval" && state !== "none") {
    return null;
  }
  const opportunityId =
    typeof raw.opportunityId === "string" && raw.opportunityId.length > 0
      ? raw.opportunityId
      : null;
  return { state, opportunityId };
}
