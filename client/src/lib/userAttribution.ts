/**
 * Task #1143 — Client-side helper that mirrors the server's
 * `formatUserAttribution` (server/lib/userLifecycle.ts) so the
 * Customers tab (and any future surface) can render historical owners
 * with a small, neutral lifecycle marker instead of collapsing them to
 * "Unassigned" once the rep has been deactivated, soft-deleted,
 * quarantined, etc.
 *
 * Kept on the client (rather than imported from `@server/...`) because
 * Vite cannot reach into server code. The helper accepts a structural
 * subset of the `User` row so callers can pass partial projections
 * (e.g. the `Omit<User, "password">` returned by `/api/team-members`)
 * without widening their query types.
 */

import { useQuery } from "@tanstack/react-query";
import type { User } from "@shared/schema";

export interface UserAttributionFields {
  name?: string | null;
  isActive?: boolean | null;
  isServiceAccount?: boolean | null;
  isDemo?: boolean | null;
  isFixture?: boolean | null;
  isQuarantined?: boolean | null;
  deletedAt?: Date | string | null;
}

function bool(v: boolean | null | undefined, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Returns `{ name, lifecycleHint? }`. `lifecycleHint` is `undefined`
 * for live, fully-active users (so the Customers card just shows the
 * bare name). Order of precedence (most informative wins):
 *   deleted > inactive > quarantined > service > demo/fixture
 */
export function formatUserAttribution(
  user: UserAttributionFields | null | undefined,
): { name: string; lifecycleHint?: string } {
  if (!user) return { name: "Unknown user" };
  const name = (user.name ?? "").trim() || "Unknown user";
  if (user.deletedAt != null) return { name, lifecycleHint: "deleted" };
  if (!bool(user.isActive, true)) return { name, lifecycleHint: "inactive" };
  if (bool(user.isQuarantined, false)) return { name, lifecycleHint: "quarantined" };
  if (bool(user.isServiceAccount, false)) return { name, lifecycleHint: "service" };
  if (bool(user.isDemo, false)) return { name, lifecycleHint: "demo" };
  if (bool(user.isFixture, false)) return { name, lifecycleHint: "fixture" };
  return { name };
}

/**
 * Fetches a single user by id from `GET /api/users/:id` (org-scoped,
 * lifecycle-agnostic) and caches the result via react-query so the
 * Customers tab only pays one network round-trip per missing rep id
 * across re-renders. `enabled` is gated on `id` so callers can pass
 * `null`/`undefined` without an extra check.
 */
export function useUserAttribution(id: string | null | undefined) {
  return useQuery<Omit<User, "password">>({
    queryKey: ["/api/users", id],
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
