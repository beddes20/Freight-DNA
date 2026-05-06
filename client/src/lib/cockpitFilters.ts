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
import {
  rowMatchesBucket,
  type BucketEvalContext,
  type BucketEvalRow,
  type BucketKey,
} from "@shared/cockpitBuckets";
import {
  resolveOwnerScope,
  type ResolvedOwnerScope,
  type OwnerScopeToken,
  type OrgChartUser,
} from "@shared/cockpitTeams";

export interface CockpitFilterItem extends BucketEvalRow {
  opportunity: {
    id?: string;
    origin?: string | null;
    destination?: string | null;
    equipmentType?: string | null;
    pickupWindowStart?: string | null;
    coveredAt?: string | null;
    status: string;
  };
  chips: Array<{ carrierName: string }>;
  coverage: { sent: number; responded: number; covered?: boolean; stage?: string | null };
  suggestedBuy: { confidence?: string | null } | null;
  freshnessMinutes: number | null;
  owner: { id: string; name?: string | null } | null;
  // Task #875 — server stamps every owner-shaped attribution + their
  // emails so the client predicate matches the KPI strip.
  ownership?: CockpitRowOwnership | null;
}

// Task #957 — owner scope is now a multi-select. The legacy single-string
// shorthand ("mine" | "team") is still accepted so callers that pre-date
// the cockpit-hardening rollout keep working; new callers pass either an
// array of tokens (e.g. ["me", "team:northeast", "u-123"]) or a fully
// resolved `ResolvedOwnerScope` envelope.
export type OwnerScopeInput =
  | "mine"
  | "team"
  | OwnerScopeToken[]
  | ResolvedOwnerScope;

export interface CockpitViewFilters {
  ownerScope?: OwnerScopeInput;
  pickupWithinHours?: number;
  pickupAfterHours?: number;
  confidenceFlag?: "low" | "medium" | "high";
  sentNoReplyMinAgeMin?: number;
  statuses?: string[];
  // Task #957 — queue bucket chip selection. Uses the shared bucket
  // registry so the chip count and the visible row set stay in lockstep.
  bucket?: BucketKey;
  // Optional override of the today-anchor used for bucket math + pickup
  // windows. Defaults to `todayIsoInOrgTz()`. Tests pass an explicit value
  // to exercise midnight-rollover behaviour.
  todayIso?: string;
  // Optional org chart used by `my-team` token expansion. Cockpit page
  // passes the loaded users list; tests can pass a synthetic chart.
  orgChart?: OrgChartUser[] | null;
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

// Resolve an OwnerScopeInput into a single comparable shape so the runtime
// branch list stays tractable. Returns `null` when there is no narrowing.
function normalizeOwnerScope(
  input: OwnerScopeInput | undefined,
  identity: ResolvedUserIdentity | null,
  orgChart: OrgChartUser[] | null | undefined,
): { kind: "legacy-mine" | "legacy-team" | "multi"; resolved: ResolvedOwnerScope | null } | null {
  if (input === undefined) return null;
  if (input === "mine") return { kind: "legacy-mine", resolved: null };
  if (input === "team") return { kind: "legacy-team", resolved: null };
  if (Array.isArray(input)) {
    const resolved = resolveOwnerScope(input, identity?.id ?? null, orgChart ?? null);
    if (resolved.isAll) return null;
    return { kind: "multi", resolved };
  }
  // Already a resolved envelope.
  if (input.isAll) return null;
  return { kind: "multi", resolved: input };
}

function rowMatchesMultiOwnerScope(
  it: CockpitFilterItem,
  scope: ResolvedOwnerScope,
  identity: ResolvedUserIdentity | null,
): boolean {
  // Unassigned membership.
  const env = it.ownership ?? null;
  const idsOnRow: string[] = [];
  if (env?.ids) for (const id of env.ids) if (id) idsOnRow.push(id);
  if (it.owner?.id) idsOnRow.push(it.owner.id);
  if (scope.includeUnassigned && idsOnRow.length === 0) return true;
  if (scope.userIds.size === 0) return false;
  // Try each user-id-in-scope through the canonical predicate so emails
  // / username aliases stamped on the envelope still match. We also do a
  // direct id-set intersection which is the cheap fast-path.
  for (const id of idsOnRow) {
    if (scope.userIds.has(id)) return true;
  }
  // Fall back to the canonical predicate for the current user (covers
  // email/username aliasing when one of the scope ids is the current user).
  if (identity?.id && scope.userIds.has(identity.id)) {
    if (isRowOwnedByUser(env, identity, it.owner?.id ?? null)) return true;
  }
  return false;
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
  // the time of day. Callers may override the anchor via
  // `viewFilters.todayIso` to reproduce midnight-rollover edge cases.
  void now;
  const todayIso = viewFilters.todayIso ?? todayIsoInOrgTz();
  const ownerScope = normalizeOwnerScope(
    viewFilters.ownerScope,
    identity,
    viewFilters.orgChart,
  );

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

  if (ownerScope) {
    const next: T[] = [];
    const dropped: T[] = [];
    if (ownerScope.kind === "legacy-mine") {
      for (const it of current) {
        if (isRowOwnedByUser(it.ownership ?? null, identity, it.owner?.id ?? null)) {
          next.push(it);
        } else {
          dropped.push(it);
        }
      }
      recordStage("ownerScope:mine", next, dropped);
    } else if (ownerScope.kind === "legacy-team") {
      for (const it of current) {
        if (!isRowOwnedByUser(it.ownership ?? null, identity, it.owner?.id ?? null)) {
          next.push(it);
        } else {
          dropped.push(it);
        }
      }
      recordStage("ownerScope:team", next, dropped);
    } else if (ownerScope.resolved) {
      const resolved = ownerScope.resolved;
      for (const it of current) {
        if (rowMatchesMultiOwnerScope(it, resolved, identity)) next.push(it);
        else dropped.push(it);
      }
      recordStage("ownerScope:multi", next, dropped);
    }
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

  if (viewFilters.bucket && viewFilters.bucket !== "all") {
    const ctx: BucketEvalContext = {
      todayIso,
      currentUserId: identity?.id ?? null,
      // For the `team_needs_approval` bucket: caller passes the org chart
      // and we expand my-team for the current user. When no chart is
      // available the bucket falls back to "everyone in pending_approval"
      // (matches the legacy team-approval behaviour).
      myTeamUserIds:
        identity?.id && viewFilters.orgChart
          ? new Set(
              [identity.id].concat(
                viewFilters.orgChart
                  .filter((u) => u.managerId === identity.id)
                  .map((u) => u.id),
              ),
            )
          : null,
    };
    const next: T[] = [];
    const dropped: T[] = [];
    for (const it of current) {
      if (rowMatchesBucket(it, viewFilters.bucket, ctx)) next.push(it);
      else dropped.push(it);
    }
    recordStage(`bucket:${viewFilters.bucket}`, next, dropped);
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
