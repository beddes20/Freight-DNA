// Workflow OS — canonical actionability + pickup-scope helpers.
//
// Wraps `shared/pickupFreshness.ts` with the surface-aware "actionable"
// predicate the spec defines (see docs/workflow-os-spec.md section B and
// ADR-002). The pre-spec default was `recent` (everything inside the
// 14-day grace window). The new default is `actionable` — future pickups
// plus soft-overdue rows that are still in an open status.

import {
  computePickupFreshness,
  PICKUP_GRACE_DAYS_DEFAULT,
  type PickupFreshness,
} from "../pickupFreshness";

// Soft-overdue window for the "actionable" pickup scope. A pickup whose
// date is in the past but inside this many hours is still considered
// actionable as long as the row's status is in
// `ACTIONABLE_OPEN_STATUSES[surface]`. Default 24 hours.
export const SOFT_OVERDUE_HOURS = 24;

export type WorkflowOsSurface = "af" | "lwq" | "available_loads";

// Per-surface canonical "still open / still cover-able" status sets.
// Surfaces may not extend these in their own files — additions land here.
export const ACTIONABLE_OPEN_STATUSES: Record<WorkflowOsSurface, ReadonlyArray<string>> = {
  af: [
    "pending_approval",
    "ready_to_send",
    "sent",
    "awaiting_carrier_reply",
    "partially_covered",
  ],
  lwq: [
    "unassigned",
    "noContactable",
    "assignedUntouched",
    "inProgress",
  ],
  available_loads: [
    "available",
    "pending",
  ],
} as const;

export const PICKUP_SCOPE_VALUES = [
  "actionable",
  "upcoming",
  "recent",
  "all",
] as const;

export type PickupScopeValue = typeof PICKUP_SCOPE_VALUES[number];

// New platform default (per ADR-002).
export const DEFAULT_PICKUP_SCOPE: PickupScopeValue = "actionable";

export function isPickupScopeValue(v: unknown): v is PickupScopeValue {
  return typeof v === "string" && (PICKUP_SCOPE_VALUES as readonly string[]).includes(v);
}

// Minimal row shape consumed by the actionability predicates. Surfaces
// project their rows into this before calling.
export interface ActionableRow {
  pickupWindowStart?: string | null;
  status?: string | null;
}

export interface ActionabilityContext {
  surface: WorkflowOsSurface;
  todayIso: string;
  // Override SOFT_OVERDUE_HOURS or PICKUP_GRACE_DAYS_DEFAULT in tests.
  softOverdueHours?: number;
  graceDays?: number;
}

// Should this row be hidden from the default "actionable" view? Returns
// true when the row is past pickup AND either:
//   - past the 24h soft-overdue window, OR
//   - in a closed / non-actionable status.
//
// `past_stale` (past the grace window) is always hidden under actionable
// regardless of status.
export function shouldHideForActionable(
  row: ActionableRow,
  ctx: ActionabilityContext,
): boolean {
  const grace = ctx.graceDays ?? PICKUP_GRACE_DAYS_DEFAULT;
  const freshness = computePickupFreshness(row.pickupWindowStart, ctx.todayIso, grace);

  if (freshness === "upcoming") return false;
  if (freshness === "no_pickup") {
    // No pickup date — surface as actionable iff the status is open. Reps
    // would otherwise lose rows that genuinely lack a pickup but are still
    // in a working state.
    const open = ACTIONABLE_OPEN_STATUSES[ctx.surface];
    if (!row.status) return true;
    return !open.includes(row.status);
  }
  if (freshness === "past_stale") return true;

  // past_recent — soft-overdue eligibility.
  const open = ACTIONABLE_OPEN_STATUSES[ctx.surface];
  if (!row.status || !open.includes(row.status)) return true;

  // Inside the soft-overdue window? `past_recent` already enforces that
  // the day is at most graceDays old; we further require that the day
  // diff in hours is within softOverdueHours.
  const softHours = ctx.softOverdueHours ?? SOFT_OVERDUE_HOURS;
  const days = pastDays(row.pickupWindowStart, ctx.todayIso);
  if (days === null) return true;
  // Convert to hours via 24h granularity (pickup is a date, not a
  // datetime, in the cockpit feed).
  const hours = days * 24;
  return hours > softHours;
}

// Compute the count of rows hidden by the actionable scope so the
// Stale-N chip can render the right number.
export function countHiddenStale<T extends ActionableRow>(
  rows: ReadonlyArray<T>,
  ctx: ActionabilityContext,
): number {
  let n = 0;
  for (const r of rows) {
    if (shouldHideForActionable(r, ctx)) n++;
  }
  return n;
}

// Apply a pickup-scope filter to a list of rows.
export function applyPickupScope<T extends ActionableRow>(
  rows: ReadonlyArray<T>,
  scope: PickupScopeValue,
  ctx: ActionabilityContext,
): T[] {
  if (scope === "all") return rows.slice();
  const grace = ctx.graceDays ?? PICKUP_GRACE_DAYS_DEFAULT;
  if (scope === "actionable") {
    return rows.filter((r) => !shouldHideForActionable(r, ctx));
  }
  if (scope === "upcoming") {
    return rows.filter((r) =>
      computePickupFreshness(r.pickupWindowStart, ctx.todayIso, grace) === "upcoming",
    );
  }
  // "recent"
  return rows.filter((r) => {
    const f = computePickupFreshness(r.pickupWindowStart, ctx.todayIso, grace);
    return f !== "past_stale";
  });
}

function pastDays(pickupIso: string | null | undefined, todayIso: string): number | null {
  if (!pickupIso) return null;
  const pickup = pickupIso.slice(0, 10);
  if (pickup.length !== 10) return null;
  const a = Date.parse(`${pickup}T00:00:00Z`);
  const b = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.round((b - a) / 86_400_000);
  return diff > 0 ? diff : 0;
}

export type { PickupFreshness };
