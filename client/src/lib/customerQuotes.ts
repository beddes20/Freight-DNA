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
