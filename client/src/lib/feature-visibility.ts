/**
 * Feature-visibility helpers — frontend-only.
 *
 * Centralizes the rules that decide which sidebar entries a given user
 * can see and click. Composes with the existing `roles?: string[]` gate
 * on each `NavItem`; does NOT replace it.
 *
 *   - "active"         visible + clickable for everyone whose role
 *                      satisfies the entry's `roles` gate (today's
 *                      behavior). The default if `status` is omitted.
 *
 *   - "admin_preview"  hidden for non-admin users (regardless of the
 *                      entry's `roles` gate); visible-but-disabled for
 *                      admins, with a small "In development" tag so
 *                      the surface stays discoverable while we iterate
 *                      on it. Reserved for incubating product surfaces;
 *                      working admin tools should stay "active".
 *
 *   - "hidden"         not rendered for anyone. Reserved for future use
 *                      (e.g. retiring a surface without deleting it).
 *
 * Admin = `user.role === "admin"`. Other elevated roles (director,
 * sales_director, etc.) are intentionally treated as non-admin for
 * visibility purposes — they see only "active" items, matching the
 * "sales floor only sees what's shipped" UX goal.
 *
 * No backend coupling. No effect on routes, page behavior, or the
 * underlying `NavItem` `roles` array — just the sidebar's render
 * decisions.
 */

import { useAuth } from "@/hooks/use-auth";

export type FeatureStatus = "active" | "admin_preview" | "hidden";

/**
 * Structural shape this module reasons about. Kept structural rather
 * than importing `NavItem` from `./nav-items` so the dependency runs
 * one way: `nav-items.ts` imports `FeatureStatus` from here.
 */
export type FeatureGated = {
  roles?: string[];
  status?: FeatureStatus;
};

/** Admin = role === "admin". Anything else is non-admin for visibility. */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "admin";
}

/**
 * Should this entry render in the sidebar for the given role?
 *
 *   - "hidden"         → never
 *   - admin user       → "active" + "admin_preview" (admin sees both)
 *   - non-admin user   → only "active", AND must satisfy the entry's
 *                        `roles` gate (existing behavior preserved)
 */
export function isFeatureVisibleFor(
  item: FeatureGated,
  role: string | undefined | null,
): boolean {
  const status = item.status ?? "active";
  if (status === "hidden") return false;

  if (isAdminRole(role)) {
    return status === "active" || status === "admin_preview";
  }

  if (status !== "active") return false;
  if (!item.roles) return true;
  if (!role) return false;
  return item.roles.includes(role);
}

/**
 * True only when the entry should render greyed/disabled — i.e. an
 * admin viewing an "admin_preview" entry. Non-admin users never see
 * disabled entries (those are hidden entirely).
 */
export function isFeatureDisabledFor(
  item: FeatureGated,
  role: string | undefined | null,
): boolean {
  const status = item.status ?? "active";
  return isAdminRole(role) && status === "admin_preview";
}

/** The small tag rendered next to a disabled (admin_preview) entry. */
export function featurePreviewLabel(status: FeatureStatus | undefined): string | null {
  if (status === "admin_preview") return "In development";
  return null;
}

/** Convenience hook for components that just need the admin boolean. */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return isAdminRole(user?.role ?? null);
}
