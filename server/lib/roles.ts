/**
 * Canonical role helpers.
 *
 * The codebase has ~50 places that ad-hoc check `user.role === "admin" || …`.
 * The combinations drifted over time — `sales_director` is sometimes folded
 * into "admin-like" checks and sometimes silently omitted — which is a
 * common source of "feature works for me but not for that role" tickets.
 *
 * New code MUST use the helpers below. Older sites are being migrated
 * incrementally.
 */

export type Role =
  | "admin"
  | "director"
  | "sales_director"
  | "national_account_manager"
  | "sales"
  | "account_manager"
  | "logistics_manager"
  | "logistics_coordinator"
  | string; // schema is text; tolerate unknown roles defensively

interface RoleBearer {
  role?: Role | null;
}

/** Org-wide superuser — sees and edits everything. */
export function isAdmin(u: RoleBearer | null | undefined): boolean {
  return u?.role === "admin";
}

/** Org leadership: admin OR director OR sales_director. The canonical
 *  "leadership view" role group used by reassignment, audit panels,
 *  global override toggles, etc. */
export function isLeadership(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return u.role === "admin" || u.role === "director" || u.role === "sales_director";
}

/** Sales-side seller roles. */
export function isSalesRep(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return u.role === "sales" || u.role === "sales_director";
}

/** Account-management seller roles. */
export function isAccountSide(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return u.role === "national_account_manager" || u.role === "account_manager";
}

/** Logistics-execution seller roles. */
export function isLogistics(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return u.role === "logistics_manager" || u.role === "logistics_coordinator";
}

/** Anyone with a managerial seat (admin, director, sales_director,
 *  national_account_manager). Used for "can see team" checks and the
 *  manager-scoped data fetches. */
export function isManagerial(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return (
    u.role === "admin" ||
    u.role === "director" ||
    u.role === "sales_director" ||
    u.role === "national_account_manager"
  );
}

/** Can reassign account ownership. */
export function canReassignAccounts(u: RoleBearer | null | undefined): boolean {
  return isManagerial(u) || u?.role === "sales";
}

/** Allowed to access AI Center admin surfaces (personas, plays, fleet). */
export function canAccessAiCenter(u: RoleBearer | null | undefined): boolean {
  if (!u?.role) return false;
  return (
    u.role === "admin" ||
    u.role === "director" ||
    u.role === "sales_director" ||
    u.role === "national_account_manager" ||
    u.role === "logistics_manager"
  );
}
