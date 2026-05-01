// Phase B1 — pickup freshness semantics for the Available Freight cockpit.
//
// Operator question this answers: "Is this lane hidden because it is truly
// no longer actionable, or just because the current pickup-date logic is too
// blunt?" Before B1 the cockpit hid every row whose pickup date was in the
// past, regardless of status. Reps lost rows that were still very much open
// (e.g. "ready_to_send" with yesterday's pickup — still cover-able tonight).
// B1 separates "stale by date" from "actually closed by status" and lets the
// rep pick which view they want.

export const PICKUP_GRACE_DAYS_DEFAULT = 14;

export const PICKUP_FRESHNESS_VALUES = [
  "no_pickup",
  "upcoming",
  "past_recent",
  "past_stale",
] as const;
export type PickupFreshness = typeof PICKUP_FRESHNESS_VALUES[number];

export const PICKUP_SCOPES = ["upcoming", "recent", "all"] as const;
export type PickupScope = typeof PICKUP_SCOPES[number];

// 'recent' is the new default: status-driven scope that keeps past-pickup
// rows visible until they cross the grace window. 'upcoming' preserves the
// pre-B1 strict behavior for callers (or operators) that want it back. 'all'
// is the explicit escape hatch for the empty-state recovery chip.
export const DEFAULT_PICKUP_SCOPE: PickupScope = "recent";

export function isPickupScope(value: unknown): value is PickupScope {
  return typeof value === "string" && (PICKUP_SCOPES as readonly string[]).includes(value);
}

// Pickup is stored as text in the DB (YYYY-MM-DD or full ISO). We compare
// the first 10 chars lexicographically, same convention used everywhere
// else in the cockpit so we don't drift on timezone math.
export function pickupDayKey(pickupIso: string | null | undefined): string | null {
  if (!pickupIso) return null;
  const key = String(pickupIso).slice(0, 10);
  return key.length === 10 ? key : null;
}

// Returns whole days between pickup and today; positive = pickup is in the
// past, negative = pickup is in the future, 0 = today. Returns null when
// either input is missing or unparseable.
export function daysSincePickup(
  pickupIso: string | null | undefined,
  todayIso: string,
): number | null {
  const pickup = pickupDayKey(pickupIso);
  if (!pickup) return null;
  const a = Date.parse(`${pickup}T00:00:00Z`);
  const b = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function computePickupFreshness(
  pickupIso: string | null | undefined,
  todayIso: string,
  graceDays: number = PICKUP_GRACE_DAYS_DEFAULT,
): PickupFreshness {
  const days = daysSincePickup(pickupIso, todayIso);
  if (days === null) return "no_pickup";
  if (days <= 0) return "upcoming";
  if (days <= graceDays) return "past_recent";
  return "past_stale";
}

// Should this row be hidden from the cockpit purely because of pickup date?
// Status filtering is handled separately — this function only answers the
// pickup-date question.
export function shouldHideForPickup(
  freshness: PickupFreshness,
  scope: PickupScope,
): boolean {
  if (scope === "all") return false;
  if (scope === "upcoming") return freshness === "past_recent" || freshness === "past_stale";
  // 'recent' (default): only hide rows older than the grace window.
  return freshness === "past_stale";
}

// Task #875 — Centralized "today / pickup window" comparisons.
//
// Before #875 the client compared `new Date(pickupWindowStart).getTime()`
// against `Date.now()` (UTC), and `pickupWindowStart` is stored as a bare
// `YYYY-MM-DD` string. Parsing that as UTC midnight meant a "today" pickup
// was already 6+ hours in the past for a CT rep at 6 AM local. The "pickup
// within 24h" predicate then rejected every same-day row even though the
// KPI strip — which compares against `todayIso` in the org's local
// timezone — happily counted them.
//
// All cockpit time-window comparisons MUST go through these helpers and
// pass `todayIso` from `todayIsoInOrgTz()` (or the equivalent client
// helper) so the server SQL aggregates and the client filter cannot drift.

function addDaysIso(todayIso: string, days: number): string {
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(t)) return todayIso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export function isPickupToday(
  pickupIso: string | null | undefined,
  todayIso: string,
): boolean {
  return pickupDayKey(pickupIso) === todayIso;
}

export function isPastPickup(
  pickupIso: string | null | undefined,
  todayIso: string,
): boolean {
  const dayKey = pickupDayKey(pickupIso);
  if (!dayKey) return false;
  return dayKey < todayIso;
}

// True when the pickup day is in the inclusive horizon
// `[today, today + ceil(hours / 24)]` in the org's local timezone.
// Same-day pickups always pass (a 5pm-local pickup is "within today",
// not past-due) regardless of the precise time-of-day.
export function isPickupWithinHours(
  pickupIso: string | null | undefined,
  hours: number,
  todayIso: string,
): boolean {
  const dayKey = pickupDayKey(pickupIso);
  if (!dayKey) return false;
  if (dayKey < todayIso) return false;
  if (hours <= 0) return dayKey === todayIso;
  const daysAhead = Math.ceil(hours / 24);
  const horizonDay = addDaysIso(todayIso, daysAhead);
  return dayKey <= horizonDay;
}

// True when the pickup day is at least `floor(hours / 24)` days ahead
// of today (org-local). Mirrors the pre-#875 `pickupAfterHours` chip used
// by the "Pickup tomorrow" built-in view (within 48h AND after 24h ⇒
// dayKey ≥ today+1, dayKey ≤ today+2).
export function isPickupAfterHours(
  pickupIso: string | null | undefined,
  hours: number,
  todayIso: string,
): boolean {
  const dayKey = pickupDayKey(pickupIso);
  if (!dayKey) return false;
  if (hours <= 0) return dayKey >= todayIso;
  const daysAhead = Math.floor(hours / 24);
  const minDay = addDaysIso(todayIso, daysAhead);
  return dayKey >= minDay;
}
