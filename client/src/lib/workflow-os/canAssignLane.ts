// Task #970 — inline assignability diagnostic for the LWQ assignee picker.
//
// The bulk-reassign select and the per-row "Assign to…" dropdown both
// list every team member the org returns, regardless of whether the
// candidate is structurally a sensible owner for the lane in question.
// Picking a director or someone from a different geography "succeeds"
// server-side but is almost never what the rep meant — the row promptly
// gets re-routed by the next team standup.
//
// `canAssignLane` is a tiny pure predicate the picker calls per
// candidate. When the predicate returns `{ ok: false }`, the picker
// shows an inline confirmation row ("Sara isn't on the West team —
// assign anyway?"). The "Assign anyway?" path posts the same endpoint
// with `assignAnyway: true` and an `overrideReason`, which the server
// records on the carrier outreach log so the override is visible in
// audit/replay.
//
// IMPORTANT: this predicate ONLY surfaces the *structural* warning the
// picker shows the rep. It is not authz — server-side gates
// (manager-only assign-to-other, hierarchy visibility, org membership)
// continue to apply unconditionally. The "Assign anyway?" override
// path bypasses ONLY this client-side warning, not server authz.
//
// Reasons surfaced today:
//   * `self_redundant`   — picker chose the same user already on the lane.
//   * `wrong_team`       — picker chose someone whose canonical team
//                          (per `shared/data/cockpitTeamMap.json`) is
//                          different from the lane's current team scope.
//                          Skipped silently when either side has no
//                          team membership configured (the most common
//                          case in early-rollout orgs).
//   * `non_outreach_role`— picker chose a role outside the outreach
//                          ladder (admin, director, etc).

/** Roles considered "outreach owners" — i.e. the people who actually
 *  work a recurring lane day-to-day. Mirrors the assignable-set used by
 *  AssignToDropdown in client/src/pages/lane-work-queue.tsx and the
 *  hierarchy check in server/routes/laneCarrierOutreach.ts. */
export const ASSIGNABLE_OUTREACH_ROLES = [
  "account_manager",
  "logistics_manager",
  "logistics_coordinator",
  "sales",
] as const;

export type AssignableOutreachRole = (typeof ASSIGNABLE_OUTREACH_ROLES)[number];

export interface AssignCandidate {
  id: string;
  name: string;
  role: string;
  /** Canonical team id from `shared/data/cockpitTeamMap.json`. Optional
   *  — when undefined, the team-mismatch check is skipped (matches the
   *  early-rollout reality where most users have no team configured). */
  teamId?: string | null;
  /** Human label used in the "wrong team" reason string. Defaults to
   *  the team id when omitted. */
  teamLabel?: string | null;
}

export interface AssignLaneShape {
  laneId: string;
  ownerUserId?: string | null;
  /** Canonical team id the lane currently belongs to — typically the
   *  team of the current `ownerUserId`/`overseerUserId`, resolved by
   *  the caller via the canonical owner-scope module. */
  teamId?: string | null;
  /** Human label for the lane's team, surfaced in the reason string. */
  teamLabel?: string | null;
}

export type CanAssignReasonCode =
  | "non_outreach_role"
  | "self_redundant"
  | "wrong_team";

export type CanAssignResult =
  | { ok: true }
  | { ok: false; reason: string; code: CanAssignReasonCode };

/**
 * Decide whether `candidate` is a plausible owner for `lane`.
 *
 * Returns `{ ok: true }` when the assignment is structurally sensible.
 * Returns `{ ok: false, reason, code }` when the picker should surface
 * the "Assign anyway?" override path.
 *
 * Order of checks (first failure wins so the picker shows the most
 * specific diagnostic):
 *   1. self-redundant  — already owns this lane
 *   2. wrong team      — both sides have a known team and they differ
 *   3. non-outreach    — role outside the outreach ladder
 */
export function canAssignLane(
  lane: AssignLaneShape,
  candidate: AssignCandidate,
): CanAssignResult {
  if (lane.ownerUserId && lane.ownerUserId === candidate.id) {
    return {
      ok: false,
      code: "self_redundant",
      reason: `${candidate.name} already owns this lane.`,
    };
  }

  // Team-mismatch check. Only fires when BOTH sides have a known team
  // — otherwise we'd emit false-positive warnings for every org that
  // hasn't seeded `cockpitTeamMap.json` yet. The label falls back to
  // the team id so the message is at least readable when the operator
  // hasn't named the team.
  if (
    lane.teamId &&
    candidate.teamId &&
    lane.teamId !== candidate.teamId
  ) {
    const laneTeam = lane.teamLabel ?? lane.teamId;
    const candTeam = candidate.teamLabel ?? candidate.teamId;
    return {
      ok: false,
      code: "wrong_team",
      reason:
        `${candidate.name} is on the ${candTeam} team, but this lane is on ${laneTeam}. ` +
        `Assign anyway?`,
    };
  }

  if (!ASSIGNABLE_OUTREACH_ROLES.includes(candidate.role as AssignableOutreachRole)) {
    return {
      ok: false,
      code: "non_outreach_role",
      reason: `${candidate.name} is a ${formatRoleLabel(candidate.role)} — outreach is usually owned by AM / LM / Coordinator / Sales. Assign anyway?`,
    };
  }

  return { ok: true };
}

/**
 * Aggregate predicate for bulk assign. Returns counts so the
 * `BulkActionBar` count chip can advertise "5 of 7 eligible" and the
 * tooltip can explain the gap.
 */
export interface BulkAssignSummary {
  totalCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  /** First reason encountered, suitable for a single-line tooltip. */
  firstReason: string | null;
}

export function summarizeBulkAssign(
  lanes: ReadonlyArray<AssignLaneShape>,
  candidate: AssignCandidate,
): BulkAssignSummary {
  let eligible = 0;
  let firstReason: string | null = null;
  for (const lane of lanes) {
    const r = canAssignLane(lane, candidate);
    if (r.ok) {
      eligible += 1;
    } else if (firstReason === null) {
      firstReason = r.reason;
    }
  }
  return {
    totalCount: lanes.length,
    eligibleCount: eligible,
    ineligibleCount: lanes.length - eligible,
    firstReason,
  };
}

function formatRoleLabel(role: string): string {
  switch (role) {
    case "admin":
      return "admin";
    case "director":
      return "director";
    case "national_account_manager":
      return "national account manager";
    case "logistics_manager":
      return "logistics manager";
    case "logistics_coordinator":
      return "logistics coordinator";
    case "account_manager":
      return "account manager";
    case "sales":
      return "salesperson";
    default:
      return role.replace(/_/g, " ");
  }
}
