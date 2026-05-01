import {
  isRowOwnedByUser,
  resolveUserIdentity,
  type CockpitRowOwnership,
  type ResolvedUserIdentity,
} from "@shared/cockpitOwnership";
import {
  isPickupWithinHours,
  isPickupAfterHours,
} from "@shared/pickupFreshness";
import { todayIsoInOrgTz } from "@shared/orgLocalDate";

export interface CockpitFilterItem {
  opportunity: {
    origin?: string | null;
    destination?: string | null;
    equipmentType?: string | null;
    pickupWindowStart?: string | null;
    status: string;
  };
  chips: Array<{ carrierName: string }>;
  coverage: { sent: number; responded: number };
  suggestedBuy: { confidence?: string | null } | null;
  freshnessMinutes: number | null;
  owner: { id: string; name?: string | null } | null;
  // Task #875 — server stamps every owner-shaped attribution + their
  // emails so the client predicate matches the KPI strip.
  ownership?: CockpitRowOwnership | null;
}

export interface CockpitViewFilters {
  ownerScope?: "mine" | "team";
  pickupWithinHours?: number;
  pickupAfterHours?: number;
  confidenceFlag?: "low" | "medium" | "high";
  sentNoReplyMinAgeMin?: number;
  statuses?: string[];
}

// Task #875 — current-user identity used by the cockpit "mine" predicate.
// Either pass a `ResolvedUserIdentity` (preferred) or a bare user id string
// (legacy callers; will only match by id).
export type CockpitCurrentUser =
  | ResolvedUserIdentity
  | string
  | null
  | undefined;

function asIdentity(user: CockpitCurrentUser): ResolvedUserIdentity | null {
  if (!user) return null;
  if (typeof user === "string") {
    return { id: user, emailLower: null, usernameLower: null };
  }
  return user;
}

export interface CockpitFilterDiagnostics {
  // True when caller wants per-stage drop counts. Off by default — only
  // the `?debug=cockpit` debug pane on Available Freight enables it.
  enabled: boolean;
  // Mutated in-place by `applyCockpitFilters`. Each entry is `{stage, kept,
  // droppedIds}` so the debug pane can render the funnel and the ids that
  // each stage rejected.
  stages: Array<{ stage: string; kept: number; droppedIds: string[] }>;
}

export function applyCockpitFilters<T extends CockpitFilterItem>(
  items: T[],
  search: string,
  viewFilters: CockpitViewFilters,
  currentUser: CockpitCurrentUser,
  now: number,
  diagnostics?: CockpitFilterDiagnostics,
): T[] {
  const q = search.trim().toLowerCase();
  const identity = asIdentity(currentUser);
  // Anchor "today" in the org's local timezone so the client predicate
  // and the server KPI use the same day boundary (#875). `now` is still
  // accepted for backwards compat but no longer participates in the
  // pickup-window math — same-day pickups must always pass regardless of
  // the time of day.
  void now;
  const todayIso = todayIsoInOrgTz();

  const recordStage = (stage: string, kept: T[], dropped: T[]) => {
    if (!diagnostics?.enabled) return;
    diagnostics.stages.push({
      stage,
      kept: kept.length,
      droppedIds: dropped.map((it) => idOf(it)),
    });
  };

  // We split the filter into stages so the debug pane can attribute drops.
  // The runtime is identical to the previous one-pass `.filter(...)` call.
  let current: T[] = items;

  if (q) {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      const opp = it.opportunity;
      const hay = [
        opp.origin ?? "",
        opp.destination ?? "",
        opp.equipmentType ?? "",
        ...it.chips.map((c) => c.carrierName),
      ]
        .join(" ")
        .toLowerCase();
      if (hay.includes(q)) next.push(it);
      else dropped.push(it);
    }
    recordStage("search", next, dropped);
    current = next;
  }

  if (viewFilters.statuses && viewFilters.statuses.length > 0) {
    const allowed = new Set(viewFilters.statuses);
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (allowed.has(it.opportunity.status)) next.push(it);
      else dropped.push(it);
    }
    recordStage("status", next, dropped);
    current = next;
  }

  if (viewFilters.ownerScope === "mine") {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (isRowOwnedByUser(it.ownership ?? null, identity, it.owner?.id ?? null)) {
        next.push(it);
      } else {
        dropped.push(it);
      }
    }
    recordStage("ownerScope:mine", next, dropped);
    current = next;
  } else if (viewFilters.ownerScope === "team") {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (!isRowOwnedByUser(it.ownership ?? null, identity, it.owner?.id ?? null)) {
        next.push(it);
      } else {
        dropped.push(it);
      }
    }
    recordStage("ownerScope:team", next, dropped);
    current = next;
  }

  if (typeof viewFilters.pickupWithinHours === "number") {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (isPickupWithinHours(it.opportunity.pickupWindowStart, viewFilters.pickupWithinHours, todayIso)) {
        next.push(it);
      } else {
        dropped.push(it);
      }
    }
    recordStage("pickupWithinHours", next, dropped);
    current = next;
  }

  if (typeof viewFilters.pickupAfterHours === "number") {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (isPickupAfterHours(it.opportunity.pickupWindowStart, viewFilters.pickupAfterHours, todayIso)) {
        next.push(it);
      } else {
        dropped.push(it);
      }
    }
    recordStage("pickupAfterHours", next, dropped);
    current = next;
  }

  if (viewFilters.confidenceFlag) {
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (it.suggestedBuy?.confidence === viewFilters.confidenceFlag) next.push(it);
      else dropped.push(it);
    }
    recordStage("confidenceFlag", next, dropped);
    current = next;
  }

  if (typeof viewFilters.sentNoReplyMinAgeMin === "number") {
    const minAge = viewFilters.sentNoReplyMinAgeMin;
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (it.coverage.sent === 0 || it.coverage.responded > 0) {
        dropped.push(it);
        continue;
      }
      if ((it.freshnessMinutes ?? 0) < minAge) {
        dropped.push(it);
        continue;
      }
      next.push(it);
    }
    recordStage("sentNoReply", next, dropped);
    current = next;
  }

  return current;
}

function idOf(it: CockpitFilterItem): string {
  // Cockpit rows carry their primary key on `opportunity.id`. Top-level
  // `id` is also accepted so test fixtures and synthetic rows resolve too.
  const top = (it as unknown as { id?: string }).id;
  if (typeof top === "string" && top.length > 0) return top;
  const opp = it.opportunity as unknown as { id?: string };
  return opp?.id ?? "(unknown)";
}

export { resolveUserIdentity };
export type { ResolvedUserIdentity, CockpitRowOwnership } from "@shared/cockpitOwnership";
