/**
 * Load_fact bucketing helpers (Task #369).
 *
 * Single source of truth for the "is this row realized?" rule used both in
 * SQL aggregates and in JS-side filters. Keeping it here lets us unit-test
 * the rule and lets callers re-classify rows post-fetch without retyping
 * the predicate.
 *
 * Realized = the load actually delivered. We accept either:
 *   1. moveStatus matches Delivered (case-insensitive substring), OR
 *   2. bucket = 'realized' (importer's derived classification, used when
 *      moveStatus is missing/non-canonical).
 *
 * Available / cancelled / unknown rows are explicitly NOT realized — this is
 * the guarantee that scorecard revenue/margin/on-time never includes a load
 * that hasn't been delivered yet.
 */

export interface BucketRow {
  moveStatus?: string | null;
  bucket?: string | null;
}

export function isRealizedRow(row: BucketRow): boolean {
  const ms = (row.moveStatus ?? "").toLowerCase();
  if (ms.includes("deliver")) return true;
  if ((row.bucket ?? "").toLowerCase() === "realized") return true;
  return false;
}

export function isAvailableRow(row: BucketRow): boolean {
  if ((row.bucket ?? "").toLowerCase() === "available") return true;
  const ms = (row.moveStatus ?? "").toLowerCase();
  if (!ms) return false;
  return ms.includes("available") || ms.includes("offered") || ms.includes("open");
}

export function isCancelledRow(row: BucketRow): boolean {
  if ((row.bucket ?? "").toLowerCase() === "cancelled") return true;
  const ms = (row.moveStatus ?? "").toLowerCase();
  return ms.includes("cancel") || ms.includes("void");
}
