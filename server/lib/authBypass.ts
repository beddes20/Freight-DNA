/**
 * DEV_AUTH_BYPASS — Clerk-free auth mode for development and staging.
 *
 * Why this exists
 * ───────────────
 * Standing up a Clerk Development instance and shuttling its `pk_test_…` /
 * `sk_test_…` into the Render staging service is friction we don't want
 * for every short-lived staging spin. This mode lets `freight-dna.onrender.com`
 * boot WITHOUT any Clerk wiring at all — no `<ClerkProvider>` mounted on
 * the client, no `clerkMiddleware()` registered on the server, no
 * `verifyToken()` calls — by injecting a stable fake user instead.
 *
 * Hard production guard
 * ─────────────────────
 * `isAuthBypassEnabled()` is the SINGLE chokepoint and refuses to return
 * `true` when `resolveAppEnv()` is `"production"`, even if `DEV_AUTH_BYPASS=true`
 * is somehow set on the production service. A loud warning is emitted at
 * boot so the misconfiguration is visible. There is no way to bypass auth
 * in production via this module — that's the whole point of the gate.
 *
 * What "enabled" means downstream
 * ───────────────────────────────
 *   - `server/auth.ts`            — `clerkMiddleware()` is NOT registered;
 *                                   `requireAuth` / `requireUser` /
 *                                   `getCurrentUser` short-circuit to the
 *                                   bypass user; `/api/config/public`
 *                                   returns `authBypassEnabled: true`.
 *   - `server/routes/liveSync.ts` — SSE auth resolver returns the bypass
 *                                   org/user without calling `verifyToken`.
 *   - `client/src/App.tsx`        — `<ClerkProvider>` is NOT mounted; the
 *                                   app renders directly.
 *   - `client/src/hooks/use-auth.ts`,
 *     `client/src/hooks/useLiveSync.ts`
 *                                  — Clerk hooks (`useUser`, `useAuth`)
 *                                    are NOT called; bypass branches are
 *                                    selected at the top of the hook.
 *
 * The fake user
 * ─────────────
 * Stable, hardcoded, clearly fake (`@freightdna.local` is a non-routable
 * TLD). Bound to `orgId = da3ed822-8846-4435-bb13-3cc4bf26f71d` so all
 * org-scoped queries (companies, freight, NBA cards, etc.) hit a real
 * organization in the staging database — without that, every page would
 * show empty state and obscure real bugs.
 *
 * Caveat: this user is NOT inserted into the `users` table. Any handler
 * that does `storage.getUser(req.user.id)` will return `null`. That's
 * intentional — bypass mode is for UI smoke / staging walkthroughs, not
 * for exercising user-lifecycle write paths. If you hit a 404/500 from a
 * specific endpoint under bypass, the fix is to insert a real user with
 * id `dev-user-ben` and orgId `da3ed822-8846-4435-bb13-3cc4bf26f71d` into
 * staging's database, not to widen this helper.
 */

import type { User } from "@shared/schema";
import { resolveAppEnv, type AppEnv } from "./clerkConfig";

const FLAG_NAME = "DEV_AUTH_BYPASS";

/** Stable bypass identity. See "The fake user" note in the file header. */
export const DEV_BYPASS_USER_ID = "dev-user-ben";
export const DEV_BYPASS_ORG_ID = "da3ed822-8846-4435-bb13-3cc4bf26f71d";
export const DEV_BYPASS_EMAIL = "ben.beddes+dev@freightdna.local";
export const DEV_BYPASS_FIRST_NAME = "Ben";
export const DEV_BYPASS_LAST_NAME = "Dev";

let warnedProductionAttempt = false;

/**
 * Reads `DEV_AUTH_BYPASS` and gates it on `APP_ENV`.
 *
 * Returns `true` ONLY when ALL of:
 *   - `DEV_AUTH_BYPASS` env var is the literal string `"true"`
 *     (trimmed, case-insensitive).
 *   - `resolveAppEnv()` is `"development"` or `"staging"`.
 *
 * If `APP_ENV=production` and `DEV_AUTH_BYPASS=true`, this function emits
 * a one-time loud warning and returns `false` — the production guard.
 *
 * Read-on-every-call (not cached) so tests can flip the env without
 * needing to reset module state.
 */
export function isAuthBypassEnabled(): boolean {
  const raw = (process.env[FLAG_NAME] ?? "").trim().toLowerCase();
  if (raw !== "true") return false;

  const env: AppEnv = resolveAppEnv();
  if (env === "production") {
    if (!warnedProductionAttempt) {
      warnedProductionAttempt = true;
      console.warn(
        `[auth-bypass] REFUSED — DEV_AUTH_BYPASS=true is set but APP_ENV=production. ` +
          `Bypass is forced OFF. Remove DEV_AUTH_BYPASS from the production environment.`,
      );
    }
    return false;
  }
  return true;
}

/**
 * "clerk" | "dev-bypass" — operator-friendly mode label for boot logs.
 */
export function describeAuthMode(): "clerk" | "dev-bypass" {
  return isAuthBypassEnabled() ? "dev-bypass" : "clerk";
}

/**
 * Returns the synthetic User object injected as `req.user` and surfaced
 * by `getCurrentUser()` when bypass is on. Cast through `unknown` because
 * the User type has many lifecycle/optional columns we deliberately leave
 * defaulted — this object is for in-memory request handling, NEVER for
 * DB writes.
 */
export function getDevBypassUser(): User {
  const now = new Date();
  return {
    id: DEV_BYPASS_USER_ID,
    organizationId: DEV_BYPASS_ORG_ID,
    username: DEV_BYPASS_EMAIL,
    password: null,
    name: `${DEV_BYPASS_FIRST_NAME} ${DEV_BYPASS_LAST_NAME}`,
    role: "admin",
    managerId: null,
    lastLoginAt: null,
    financialRepId: null,
    createdAt: now.toISOString(),
    emailSignature: null,
    clerkUserId: null,
    valueiqLandingDisabled: false,
    defaultToTodayQueue: true,
    isActive: true,
    isServiceAccount: false,
    isDemo: false,
    isFixture: false,
    isQuarantined: false,
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
    userSource: "dev-bypass",
    lastActivityAt: now,
  } as unknown as User;
}
