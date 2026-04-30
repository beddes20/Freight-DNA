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
 *   - "admin_preview"  visible to BOTH admins and non-admins (still
 *                      subject to the entry's `roles` gate), rendered
 *                      with a small "In development" tag so the surface
 *                      stays discoverable while we iterate. Non-admins
 *                      see it as disabled (clicks are no-ops). Admins
 *                      get full click-through and active-route
 *                      highlighting — same greyed visual, but real
 *                      navigation. Reserved for incubating product
 *                      surfaces; working admin tools should stay
 *                      "active".
 *
 *   - "hidden"         not rendered for anyone. Reserved for future use
 *                      (e.g. retiring a surface without deleting it).
 *
 * Admin = `user.role === "admin"`. Other elevated roles (director,
 * sales_director, etc.) are intentionally treated as non-admin for the
 * preview-bypass — they see the same greyed/blocked treatment as
 * regular sales reps so the "in development" cue is consistent across
 * the sales floor.
 *
 * No backend coupling. No effect on routes, page behavior, or the
 * underlying `NavItem` `roles` array — just the sidebar's render
 * decisions. Page-level role guards remain the security boundary.
 *
 * NOTE: This admin role check is the single chokepoint that the
 * eventual feature-flag system will swap. Keep it here — do NOT
 * sprinkle `user.role === "admin"` checks at call sites.
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
 *   - "admin_preview"  → visible to everyone whose role satisfies the
 *                        entry's `roles` gate (admin always sees it,
 *                        non-admins see it as long as they pass the
 *                        gate). Non-admins get the disabled treatment
 *                        via `isFeatureDisabledFor`.
 *   - "active"         → visible to everyone whose role satisfies the
 *                        entry's `roles` gate (existing behavior).
 */
export function isFeatureVisibleFor(
  item: FeatureGated,
  role: string | undefined | null,
): boolean {
  const status = item.status ?? "active";
  if (status === "hidden") return false;

  // Admins always see "active" + "admin_preview" entries regardless
  // of an entry's `roles` gate.
  if (isAdminRole(role)) return true;

  // Non-admins must satisfy the entry's `roles` gate (if any) for both
  // "active" and "admin_preview" entries.
  if (!item.roles) return true;
  if (!role) return false;
  return item.roles.includes(role);
}

/**
 * True when the entry should render greyed and have its clicks
 * intercepted — i.e. a non-admin viewing an "admin_preview" entry.
 * Admins viewing "admin_preview" entries are NOT disabled: they get
 * full click-through and active-route highlighting (only the badge +
 * greyed visual remain to signal the surface is still in development).
 */
export function isFeatureDisabledFor(
  item: FeatureGated,
  role: string | undefined | null,
): boolean {
  const status = item.status ?? "active";
  return status === "admin_preview" && !isAdminRole(role);
}

/** The small tag rendered next to an "admin_preview" entry (for both roles). */
export function featurePreviewLabel(status: FeatureStatus | undefined): string | null {
  if (status === "admin_preview") return "In development";
  return null;
}

/**
 * Tooltip text for an "admin_preview" entry. Returns null for entries
 * that don't have a preview label (i.e. plain "active" entries — the
 * caller should fall back to the normal title/description tooltip).
 *
 *   - non-admin: `"<Title> — In development"`
 *   - admin:     `"<Title> — In development — admin access enabled"`
 *
 * Single helper so call sites don't repeat the role check — when the
 * preview-bypass swaps from a role check to a feature-flag check, this
 * is the only place that needs to change.
 */
export function featurePreviewTooltip(
  title: string,
  status: FeatureStatus | undefined,
  role: string | undefined | null,
): string | null {
  const label = featurePreviewLabel(status);
  if (!label) return null;
  if (isAdminRole(role)) return `${title} — ${label} — admin access enabled`;
  return `${title} — ${label}`;
}

/** Convenience hook for components that just need the admin boolean. */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return isAdminRole(user?.role ?? null);
}
