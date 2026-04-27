/**
 * Org-local "today" helpers.
 *
 * The Available Freight stack runs on US Central time — the importer is
 * scheduled in CT (see availableFreightImporter / freightOpportunityCockpit
 * "next import" calc) and reps triage on the CT business day. UTC midnight
 * lands at 6 PM the prior day in CT, so deriving "today" from
 * `new Date().toISOString().slice(0,10)` would hide loads that are still
 * "today" for the rep, or surface ones that have already past in CT.
 *
 * Use these helpers for any "is this date today / past / future" comparison
 * against a column stored as YYYY-MM-DD (e.g. freight_opportunities.pickup_window_start).
 */

export const ORG_LOCAL_TIMEZONE = "America/Chicago";

/**
 * Returns today's date in the org's local timezone formatted as YYYY-MM-DD,
 * suitable for lexical comparison against ISO date columns.
 */
export function todayIsoInOrgTz(now: Date = new Date(), timeZone: string = ORG_LOCAL_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find(p => p.type === "year")?.value ?? "1970";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const d = parts.find(p => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * True when an ISO date string (YYYY-MM-DD or full ISO) is strictly before
 * today in the org's local timezone. Null/empty values return false (the
 * caller decides whether unknown-date rows are kept).
 */
export function isPastOrgLocalDay(
  iso: string | null | undefined,
  now: Date = new Date(),
  timeZone: string = ORG_LOCAL_TIMEZONE,
): boolean {
  if (!iso) return false;
  const day = String(iso).slice(0, 10);
  if (!day) return false;
  return day < todayIsoInOrgTz(now, timeZone);
}
