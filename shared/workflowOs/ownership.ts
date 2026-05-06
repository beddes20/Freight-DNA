// Workflow OS — canonical ownership predicates and Owner-filter types.
//
// Wraps and re-exports the existing helpers in `shared/cockpitOwnership.ts`
// so legacy callers (Available Freight cockpit, server KPI aggregates) keep
// working unchanged. New code on Lane Work Queue and Available Loads
// imports from here so all three surfaces resolve "is this row mine?" and
// "is this row in my AM's book?" through one source of truth.
//
// See docs/workflow-os-spec.md sections A and B and ADR-001.

import {
  isRowOwnedByUser,
  resolveUserIdentity,
  rowOwnerKeys,
  buildRowOwnership,
  type CockpitRowOwnership,
  type ResolvedUserIdentity,
  type OwnerShapedRow,
} from "../cockpitOwnership";

export {
  isRowOwnedByUser,
  resolveUserIdentity,
  rowOwnerKeys,
  buildRowOwnership,
};
export type {
  CockpitRowOwnership,
  ResolvedUserIdentity,
  OwnerShapedRow,
};

// The canonical Owner-filter value used by every workflow surface. The spec
// permits exactly five shapes; surfaces may not invent additional ones.
//
// - "all"          — default for managers; returns every row.
// - "me"           — current user matches any id/email in the row's
//                    ownership envelope (via `isRowOwnedByUser`).
// - "am_book"      — Account Manager-aware sub-scope. Returns rows whose
//                    company (`companyId → companies.assignedTo`) is the
//                    current user OR a direct report of the current user
//                    (so a NAM sees the books of the AMs that report to
//                    them, and an AM sees their own).
// - "unassigned"   — neither `ownerUserId` nor `delegatedToUserId` set.
// - { specificUserId } — pick a specific rep from the org's "rep-ish" list.
export type OwnerFilterValue =
  | "all"
  | "me"
  | "am_book"
  | "unassigned"
  | { specificUserId: string };

// Minimal user shape consumed by the Owner-filter sub-scope predicates.
// Mirrors the columns the cockpit endpoints already serialize.
export interface WorkflowOsUser {
  id: string;
  managerId?: string | null;
  username?: string | null;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

// Minimal row shape consumed by the Owner-filter predicates. Carries both
// the ownership envelope (for "me") and the company id (for "am_book").
export interface WorkflowOsRow {
  ownership?: CockpitRowOwnership | null;
  legacyOwnerId?: string | null;
  ownerUserId?: string | null;
  delegatedToUserId?: string | null;
  companyId?: string | null;
}

// AM-aware predicate. Returns true when the row's company is assigned to
// the current user OR to a direct report of the current user.
//
// `companies.assignedTo` is the AM/NAM column (see shared/schema.ts:33).
// We accept a `companyAssignedToByCompanyId` map rather than re-fetching
// the companies table per row — callers (the surface page) hand it in.
export function isRowInUsersAmBook(
  row: WorkflowOsRow,
  user: WorkflowOsUser | null | undefined,
  orgUsers: ReadonlyArray<WorkflowOsUser>,
  companyAssignedToByCompanyId: ReadonlyMap<string, string | null | undefined>,
): boolean {
  if (!user) return false;
  if (!row.companyId) return false;
  const assignedTo = companyAssignedToByCompanyId.get(row.companyId);
  if (!assignedTo) return false;
  if (assignedTo === user.id) return true;
  // Direct reports: any org user whose `managerId === user.id` is in this
  // user's "AM book".
  for (const u of orgUsers) {
    if (u.managerId && u.managerId === user.id && u.id === assignedTo) {
      return true;
    }
  }
  return false;
}

export interface ApplyOwnerFilterContext {
  user: WorkflowOsUser | null | undefined;
  orgUsers: ReadonlyArray<WorkflowOsUser>;
  // Map of companyId → companies.assignedTo. Required for `am_book`; can
  // be empty for the other modes.
  companyAssignedToByCompanyId?: ReadonlyMap<string, string | null | undefined>;
}

// Apply an Owner-filter value to a list of rows. Surface-agnostic; the
// surface only needs to project its rows into the `WorkflowOsRow` shape.
export function applyOwnerFilter<T extends WorkflowOsRow>(
  rows: ReadonlyArray<T>,
  value: OwnerFilterValue,
  ctx: ApplyOwnerFilterContext,
): T[] {
  if (value === "all") return rows.slice();

  if (value === "unassigned") {
    return rows.filter(
      (r) => !r.ownerUserId && !r.delegatedToUserId,
    );
  }

  if (value === "me") {
    const identity = resolveUserIdentity(ctx.user ?? null);
    return rows.filter((r) =>
      isRowOwnedByUser(r.ownership ?? null, identity, r.legacyOwnerId ?? r.ownerUserId ?? null),
    );
  }

  if (value === "am_book") {
    const map = ctx.companyAssignedToByCompanyId ?? new Map();
    return rows.filter((r) => isRowInUsersAmBook(r, ctx.user ?? null, ctx.orgUsers, map));
  }

  // { specificUserId }
  const target = value.specificUserId;
  return rows.filter((r) => {
    if (r.ownerUserId === target) return true;
    if (r.delegatedToUserId === target) return true;
    if (r.ownership?.ids?.includes(target)) return true;
    return false;
  });
}

// Roles considered "rep-ish" for the Specific user… picker. Mirrors the
// canonical role list in shared/schema.ts (see ADR-001 in the spec doc).
export const WORKFLOW_OS_REP_ROLES = [
  "account_manager",
  "national_account_manager",
  "sales",
  "sales_director",
  "logistics_manager",
  "logistics_coordinator",
] as const;

export type WorkflowOsRepRole = typeof WORKFLOW_OS_REP_ROLES[number];

export function isRepLikeRole(role: string | null | undefined): role is WorkflowOsRepRole {
  if (!role) return false;
  return (WORKFLOW_OS_REP_ROLES as readonly string[]).includes(role);
}
