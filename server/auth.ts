import { Request, Response, NextFunction } from "express";
import { pStr, qStr, qOptStr } from "./lib/req";
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import type { User, Company, SharedRep } from "@shared/schema";
import { getCanonicalCompanyOwnerId } from "./lib/companyOwner";
import { notifyAdminsOfUnprovisionedSignIn } from "./unprovisionedSignInNotifications";
import { getClerkPublishableKey } from "./lib/clerkConfig";
import {
  isAuthBypassEnabled,
  getDevBypassUser,
  DEV_BYPASS_USER_ID,
  DEV_BYPASS_ORG_ID,
} from "./lib/authBypass";

const PgStore = connectPgSimple(session);
const IS_PROD = process.env.NODE_ENV === "production";

// Dev-only auth bypass: when DEV_AUTH_BYPASS_USER_ID is set and we are not in
// production, every request is automatically authenticated as that DB user.
const DEV_AUTH_BYPASS_USER_ID = !IS_PROD ? (process.env.DEV_AUTH_BYPASS_USER_ID ?? null) : null;

// Session type augmentation (used in dev/test mode only)
declare module "express-session" {
  interface SessionData {
    userId: string;
    organizationId: string;
    impersonatingAdminId?: string;
  }
}

// Express request augmentation: requireUser attaches the resolved User
// to req.user so handlers can stop repeating the
//   const user = await getCurrentUser(req); if (!user) return res.status(401)…
// boilerplate.
declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

// In-memory impersonation tracker: adminClerkUserId -> targetDbUserId
const impersonationMap = new Map<string, string>();

/**
 * Resolved impersonation context for a request.
 *
 * Task #972 — single source of truth for "is this request happening under
 * an admin's view-as session, and if so, who is being viewed?". The
 * Available Freight cockpit (and any future scope-tightened endpoint)
 * reads this via `getImpersonationContext(req)` so the rule for
 * impersonation lives in exactly one place.
 *
 *   - `isImpersonating`     — true when an admin is viewing as another user.
 *   - `impersonatedUserId`  — the DB user id of the impersonated rep, or null
 *                             when the admin is signed in as themself.
 *   - `adminId`             — best-effort identifier of the acting admin.
 *                             In Clerk mode this is the admin's Clerk user
 *                             id (the key in `impersonationMap`); in dev
 *                             session mode this is the admin's DB user id
 *                             (`req.session.impersonatingAdminId`).
 */
export interface ImpersonationContext {
  isImpersonating: boolean;
  impersonatedUserId: string | null;
  adminId: string | null;
}

export function getImpersonationContext(req: Request): ImpersonationContext {
  // Clerk-mode impersonation: the admin's Clerk user id is the key in
  // `impersonationMap` and the value is the target DB user id.
  const { userId: clerkUserId } = getAuth(req);
  if (clerkUserId) {
    const target = impersonationMap.get(clerkUserId);
    if (target) {
      return { isImpersonating: true, impersonatedUserId: target, adminId: clerkUserId };
    }
    return { isImpersonating: false, impersonatedUserId: null, adminId: null };
  }
  // Dev session-mode impersonation: `req.session.userId` has been swapped
  // to the target's DB id and `req.session.impersonatingAdminId` carries
  // the admin's DB id (see `/api/admin/impersonate/:userId`).
  const adminDbId = req.session?.impersonatingAdminId;
  if (adminDbId && req.session?.userId) {
    return {
      isImpersonating: true,
      impersonatedUserId: req.session.userId,
      adminId: adminDbId,
    };
  }
  return { isImpersonating: false, impersonatedUserId: null, adminId: null };
}

export function setupAuth(app: any) {
  // DEV_AUTH_BYPASS mode skips Clerk wiring entirely (see
  // server/lib/authBypass.ts). When enabled, clerkMiddleware() is NOT
  // registered — both because it would crash without CLERK_SECRET_KEY
  // configured and because we want to guarantee zero Clerk SDK calls in
  // bypass mode. requireAuth / requireUser / getCurrentUser handle the
  // injection further down.
  const bypassed = isAuthBypassEnabled();
  if (!bypassed) {
    // Clerk middleware validates the session token / JWT on every request
    app.use(clerkMiddleware());
  }

  // Public endpoint — exposes the Clerk publishable key to the frontend.
  // Goes through `getClerkPublishableKey()` so staging always sees pk_test_…
  // and production always sees pk_live_… based on APP_ENV (see
  // server/lib/clerkConfig.ts).
  //
  // `clerkPublishableKey` is the resolved per-env key REGARDLESS of bypass
  // mode. It is a config readback — what the server thinks the key is — and
  // matches the boot log line `[boot] APP_ENV=… clerk.publishable=…`. The
  // publishable key is non-secret by Clerk's design (see
  // https://clerk.com/docs/references/javascript/clerk/publishable-key)
  // so returning it under bypass leaks nothing.
  //
  // `authBypassEnabled` is the separate signal the client uses to decide
  // whether to mount <ClerkProvider>. When true, the client renders
  // without Clerk and ignores `clerkPublishableKey` for provider mounting
  // — but the key is still surfaced here so the debug page / readback
  // tooling matches the server's view.
  app.get("/api/config/public", (_req: Request, res: Response) => {
    res.json({
      clerkPublishableKey: getClerkPublishableKey(),
      authBypassEnabled: bypassed,
    });
  });

  // ── Development / Testing: session-based auth (NOT used in production) ──
  // This keeps the automated test suite working while Clerk handles production auth.
  if (!IS_PROD) {
    app.use(
      session({
        store: new PgStore({
          conString: process.env.DATABASE_URL,
          createTableIfMissing: true,
        }),
        secret: process.env.SESSION_SECRET || "dev-only-secret",
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
          maxAge: 30 * 24 * 60 * 60 * 1000,
          httpOnly: true,
          secure: false,
          sameSite: "lax",
        },
      })
    );

    app.post("/api/auth/login", async (req: Request, res: Response) => {
      try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
        const user = await storage.getUserByUsername(username);
        if (!user || !user.password) return res.status(401).json({ error: "Invalid credentials" });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: "Invalid credentials" });
        req.session.userId = user.id;
        req.session.organizationId = user.organizationId;
        const { password: _, ...safeUser } = user;
        res.json(safeUser);
      } catch (err) {
        res.status(500).json({ error: "Login failed" });
      }
    });

    app.post("/api/auth/logout", (req: Request, res: Response) => {
      req.session.destroy(() => res.json({ success: true }));
    });
  } else {
    // Production: logout is a no-op on the server (Clerk handles it client-side)
    app.post("/api/auth/logout", (_req: Request, res: Response) => {
      res.json({ success: true });
    });
  }

  // GET /api/auth/me — returns the current user's app-level profile
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      // DEV_AUTH_BYPASS — clerkMiddleware() is NOT registered in bypass mode
      // (see setupAuth above), so calling getAuth(req) would throw
      // "clerkMiddleware should be registered before using getAuth". Skip
      // every Clerk SDK touch when bypassed; the synthetic dev user already
      // came back from getCurrentUser, and impersonation is a Clerk-only
      // concept that does not apply here.
      const bypassed = isAuthBypassEnabled();
      const clerkUserId = bypassed ? null : getAuth(req).userId;
      if (!user) {
        // Distinguish "signed into Clerk but no DB row" from "not signed in".
        if (clerkUserId) {
          let email: string | null = null;
          try {
            const clerkUser = await clerkClient.users.getUser(clerkUserId);
            email = clerkUser.emailAddresses[0]?.emailAddress?.toLowerCase() ?? null;
          } catch (err) {
            console.error("[auth/me] Clerk user fetch failed:", err);
          }
          // Fire-and-forget: alert admins so they can provision this user.
          // Dedup + email/in-app fan-out are handled inside the helper.
          void notifyAdminsOfUnprovisionedSignIn(email, storage);
          return res.status(200).json({ unprovisioned: true, email });
        }
        return res.status(401).json({ error: "Not authenticated" });
      }
      // Task #972 — single source of truth for impersonation state. Mirrors
      // exactly what the cockpit route reads via `getImpersonationContext`,
      // so the client `currentUser.isImpersonating` flag and the server-
      // side base owner scope can never disagree about who is being viewed.
      // In DEV_AUTH_BYPASS mode there is no Clerk session and impersonation
      // is unreachable; skip the helper because it calls getAuth(req).
      const { isImpersonating } = bypassed
        ? { isImpersonating: false }
        : getImpersonationContext(req);

      let impersonatingAdminName: string | null = null;
      if (isImpersonating) {
        const adminId = clerkUserId || req.session?.impersonatingAdminId;
        if (adminId) {
          const admin = clerkUserId ? await storage.getUserByClerkId(clerkUserId) : await storage.getUser(adminId!);
          if (admin) impersonatingAdminName = admin.name;
        }
      }

      // Refresh lastLoginAt at most once per hour
      const now = new Date();
      const lastLogin = (user as any).lastLoginAt ? new Date((user as any).lastLoginAt) : null;
      const hoursSince = lastLogin ? (now.getTime() - lastLogin.getTime()) / 3_600_000 : Infinity;
      let freshLoginAt = (user as any).lastLoginAt as string | undefined;
      if (!isImpersonating && hoursSince >= 1) {
        freshLoginAt = now.toISOString();
        try {
          await storage.updateUser(user.id, user.organizationId, { lastLoginAt: freshLoginAt });
        } catch {
          freshLoginAt = (user as any).lastLoginAt;
        }
      }

      const { password: _, ...safeUser } = user as any;
      const org = await storage.getOrganizationById(user.organizationId);
      return res.json({
        ...safeUser,
        lastLoginAt: freshLoginAt,
        isImpersonating,
        impersonatingAdminName,
        organizationSlug: org?.slug ?? "",
      });
    } catch (err) {
      console.error("[auth/me] error:", err);
      return res.status(500).json({ error: "Failed to retrieve session" });
    }
  });

  // Impersonation — admin switches their view to another user (Clerk mode)
  app.post("/api/admin/impersonate/:userId", async (req: Request, res: Response) => {
    const { userId: clerkUserId } = getAuth(req);
    const sessionUserId = req.session?.userId;
    const actingId = clerkUserId || sessionUserId;
    if (!actingId) return res.status(401).json({ error: "Not authenticated" });

    const admin = clerkUserId
      ? await storage.getUserByClerkId(clerkUserId)
      : await storage.getUser(actingId);
    if (!admin || admin.role !== "admin") return res.status(403).json({ error: "Admin only" });

    const target = await storage.getUser(pStr(req.params.userId));
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role === "admin") return res.status(400).json({ error: "Cannot impersonate another admin" });
    if (target.organizationId !== admin.organizationId) return res.status(403).json({ error: "Cross-org impersonation denied" });

    if (clerkUserId) {
      impersonationMap.set(clerkUserId, target.id);
    } else if (req.session) {
      req.session.impersonatingAdminId = admin.id;
      req.session.userId = target.id;
      req.session.organizationId = target.organizationId;
    }

    const { password: _, ...safeTarget } = target as any;
    return res.json({ ...safeTarget, isImpersonating: true, impersonatingAdminName: admin.name });
  });

  // Stop impersonation
  app.post("/api/admin/stop-impersonating", async (req: Request, res: Response) => {
    const { userId: clerkUserId } = getAuth(req);

    if (clerkUserId) {
      if (!impersonationMap.has(clerkUserId)) return res.status(400).json({ error: "Not impersonating" });
      impersonationMap.delete(clerkUserId);
      const admin = await storage.getUserByClerkId(clerkUserId);
      if (!admin) return res.status(404).json({ error: "Admin not found" });
      const { password: _, ...safeAdmin } = admin as any;
      return res.json({ ...safeAdmin, isImpersonating: false, impersonatingAdminName: null });
    }

    // Session-based impersonation (dev only)
    if (!req.session?.impersonatingAdminId) return res.status(400).json({ error: "Not impersonating" });
    const adminId = req.session.impersonatingAdminId;
    req.session.userId = adminId;
    delete req.session.impersonatingAdminId;
    const admin = await storage.getUser(adminId);
    if (!admin) return res.status(404).json({ error: "Admin not found" });
    req.session.organizationId = admin.organizationId;
    const { password: _, ...safeAdmin } = admin as any;
    return res.json({ ...safeAdmin, isImpersonating: false, impersonatingAdminName: null });
  });
}

// Symbol used to cache the resolved user on the request object so routes that
// call getCurrentUser() after requireAuth() don't pay a second DB round-trip.
const RESOLVED_USER = Symbol("resolvedUser");

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // DEV_AUTH_BYPASS — skip Clerk entirely, inject the synthetic user (see
  // server/lib/authBypass.ts). Refused by the helper when APP_ENV=production.
  if (isAuthBypassEnabled()) {
    const user = getDevBypassUser();
    (req as any)[RESOLVED_USER] = user;
    if (!req.session) {
      (req as any).session = { organizationId: user.organizationId, userId: user.id };
    } else {
      req.session.organizationId = req.session.organizationId || user.organizationId;
      req.session.userId = req.session.userId || user.id;
    }
    return next();
  }

  // Dev-only bypass: auto-attach the bypass user so the route handler just works.
  // BUT: an active session (from /api/auth/login or impersonation) takes precedence
  // so dev login as a different user actually works.
  if (DEV_AUTH_BYPASS_USER_ID && !req.session?.userId && !getAuth(req).userId) {
    const user = await storage.getUser(DEV_AUTH_BYPASS_USER_ID);
    if (user) {
      (req as any)[RESOLVED_USER] = user;
      if (!req.session) {
        (req as any).session = { organizationId: user.organizationId, userId: user.id };
      } else {
        req.session.organizationId = req.session.organizationId || user.organizationId;
        req.session.userId = req.session.userId || user.id;
      }
      return next();
    }
    // If the bypass user ID doesn't exist in DB, fall through to normal auth
    console.warn(`[DEV_AUTH_BYPASS] User ${DEV_AUTH_BYPASS_USER_ID} not found in DB — falling through to Clerk auth`);
  }

  // Primary: Clerk JWT auth
  const { userId } = getAuth(req);
  if (userId) {
    // Resolve the user now and cache it on the request.  This also back-fills
    // req.session so the many existing routes that read req.session.organizationId
    // continue to work whether a real express-session is present or not.
    const user = await getCurrentUser(req);
    if (user) {
      (req as any)[RESOLVED_USER] = user;
      if (!req.session) {
        (req as any).session = { organizationId: user.organizationId, userId: user.id };
      } else {
        req.session.organizationId = req.session.organizationId || user.organizationId;
        req.session.userId = req.session.userId || user.id;
      }
    }
    return next();
  }

  // Secondary (dev/test only): session-based auth
  if (!IS_PROD && req.session?.userId) return next();

  return res.status(401).json({ error: "Authentication required" });
}

/**
 * Stronger variant of `requireAuth` that also resolves the DB user and
 * attaches it to `req.user` (typed via the `Request` augmentation above),
 * so handlers can write `req.user!.id` instead of repeating the
 * `getCurrentUser(req)` + null-check + 401 boilerplate.
 *
 * Use this on routes that always need a User. For routes that just need
 * "is authenticated", `requireAuth` is still fine.
 */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  // Run requireAuth first so that the resolved User is cached on the request
  // (under the file-local RESOLVED_USER symbol) and 401s are returned for
  // unauthenticated callers without us having to duplicate the logic.
  let nextCalled = false;
  await requireAuth(req, res, () => {
    nextCalled = true;
  });
  if (!nextCalled) return; // requireAuth already sent a 401

  // requireAuth caches the user on req[RESOLVED_USER] when it can. Read it
  // back via getCurrentUser, which falls through to a direct lookup if needed.
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  return next();
}

/**
 * Resolve a Clerk user id to the matching DB user.
 *
 * This is the canonical Clerk → DB user resolver. It implements the
 * "auto-link on first sign-in" semantics that `requireAuth`/`getCurrentUser`
 * have always relied on:
 *
 *   1. Honour any active impersonation mapping (admin → target).
 *   2. Direct lookup by `users.clerk_user_id` — the steady-state path.
 *   3. **Email back-fill** — fetch the Clerk user, look up the matching
 *      `users` row by lowercased email, write `clerk_user_id` so future
 *      lookups skip Clerk entirely. This is the path that lets a
 *      provisioned-by-email user actually authenticate the first time
 *      they sign in (their DB row starts with `clerk_user_id = NULL`).
 *
 * Extracted from `getCurrentUser` (Task #958) so the SSE auth resolver in
 * `server/routes/liveSync.ts` can share the exact same back-fill semantics
 * — without it the SSE endpoint 401s for every user whose DB row has not
 * yet been linked to a Clerk id, even with a perfectly valid token. That
 * was the root cause of the `live_sync_auth_failure` watchdog alert.
 */
export async function resolveClerkUserToDbUser(clerkUserId: string): Promise<User | null> {
  // 1. Impersonation
  const impersonatedDbUserId = impersonationMap.get(clerkUserId);
  if (impersonatedDbUserId) return (await storage.getUser(impersonatedDbUserId)) ?? null;

  // 2. Direct lookup
  const byClerkId = await storage.getUserByClerkId(clerkUserId);
  if (byClerkId) return byClerkId;

  // 3. Email back-fill
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const email = clerkUser.emailAddresses[0]?.emailAddress?.toLowerCase();
    if (email) {
      const dbUser = await storage.getUserByUsername(email);
      if (dbUser) {
        await storage.updateUser(dbUser.id, dbUser.organizationId, { clerkUserId });
        return { ...dbUser, clerkUserId };
      }
    }
  } catch (err) {
    console.error("[resolveClerkUserToDbUser] Clerk user fetch failed:", err);
  }
  return null;
}

export async function getCurrentUser(req: Request): Promise<User | null> {
  // Return cached value if requireAuth already resolved it
  if ((req as any)[RESOLVED_USER]) return (req as any)[RESOLVED_USER];

  // DEV_AUTH_BYPASS — handlers that call getCurrentUser() without first
  // going through requireAuth() (a small minority of routes) still get
  // the bypass user.
  if (isAuthBypassEnabled()) {
    const user = getDevBypassUser();
    (req as any)[RESOLVED_USER] = user;
    return user;
  }

  // An active session (dev /api/auth/login) takes precedence over the dev bypass
  // so logging in as a different user in dev actually changes who you are.
  if (!IS_PROD && req.session?.userId) {
    const sessionUser = await storage.getUser(req.session.userId);
    if (sessionUser) return sessionUser;
  }

  // Check Clerk before falling back to the dev bypass — a real Clerk session
  // should also win over the bypass.
  const { userId: clerkUserId } = getAuth(req);
  if (clerkUserId) {
    return resolveClerkUserToDbUser(clerkUserId);
  }

  // Dev/test: session-based (already handled at the top, kept for impersonation clarity)
  if (!IS_PROD && req.session?.userId) {
    return (await storage.getUser(req.session.userId)) ?? null;
  }

  // Final fallback: dev bypass user (only when no session and no Clerk auth)
  if (DEV_AUTH_BYPASS_USER_ID) {
    const user = await storage.getUser(DEV_AUTH_BYPASS_USER_ID);
    if (user) return user;
  }

  return null;
}

type UserMinimal = Pick<User, "id" | "role" | "managerId" | "organizationId">;

/**
 * Optional flags that opt into a NARROWER widening of visibility for a
 * specific surface. Each flag defaults to `false`, is role-gated, and only
 * affects the function when explicitly passed by an opted-in route. The
 * `getVisibleCompanyIds` function still returns the legacy result for every
 * caller that omits the option (the ~60 existing call sites).
 *
 * Launchpad L1.1 — Routing Visibility (2026-05-18):
 *   `includeUnroutedEmailDerived` lets the Launchpad "Needs Routing" inbox
 *   show managers (and admins, which already see everything) the unowned,
 *   `is_email_derived=true` rows that would otherwise be invisible to non-
 *   admins. The flag is a no-op for `sales` / `logistics_manager` /
 *   `logistics_coordinator` / `account_manager` roles — they still cannot
 *   see unowned accounts via this code path. The contract lives at
 *   `docs/launchpad-routing-visibility-contract.md`.
 */
export type CompanyVisibilityOptions = {
  includeUnroutedEmailDerived?: boolean;
};

const ROUTING_VISIBILITY_ROLES = new Set([
  "director",
  "national_account_manager",
  "sales_director",
]);

export async function getVisibleCompanyIds(
  user: UserMinimal,
  options: CompanyVisibilityOptions = {},
): Promise<string[] | null> {
  if (user.role === "admin") return null;

  const allCompanies = await storage.getCompanies(user.organizationId);

  // L1.1 — when the routing surface opts in AND the caller holds a manager
  // seat, build the set of unowned email-derived company IDs in this org.
  // Unioned into the role-specific result below so it strictly widens
  // (never narrows) the legacy visible set.
  const unroutedEmailDerivedIds: Set<string> =
    options.includeUnroutedEmailDerived && user.role && ROUTING_VISIBILITY_ROLES.has(user.role)
      ? new Set(
          allCompanies
            .filter(c => c.isEmailDerived === true)
            .filter(c => getCanonicalCompanyOwnerId(c) === null)
            .filter(c => !c.archivedAt)
            .map(c => c.id),
        )
      : new Set<string>();

  // Account-level Collaborators (manual sharing) — these company IDs are
  // unioned into every role's visible set so a collaborator can drill into
  // shared accounts (detail page, lane outreach, conversations, etc.) and
  // not just see them in their LWQ.
  const collaboratorCompanyIds = new Set(
    await storage.getCollaboratorCompanyIds(user.id, user.organizationId),
  );

  const isSharedRep = (c: Company) => {
    if (collaboratorCompanyIds.has(c.id)) return true;
    const reps = (c.sharedReps || []) as SharedRep[];
    return reps.some(r => r.userId === user.id);
  };

  // Canonical Customers-tab ownership rule (read-side coalesce, no writes):
  // ownerRepId ?? assignedTo ?? salesPersonId. Single source of truth lives
  // in `server/lib/companyOwner.ts` and is also consumed by the
  // GET /api/companies payload (which attaches `ownerUserId` so the client
  // never re-derives the rule). Behavior is monotone non-decreasing per
  // user: anyone who saw an account before still sees it.
  const ownerOf = (c: Company): string | null => getCanonicalCompanyOwnerId(c);

  if (user.role === "director" || user.role === "national_account_manager") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    return allCompanies
      .filter(c => {
        const oid = ownerOf(c);
        return (oid && (teamIds.includes(oid) || oid === user.id)) || isSharedRep(c) || unroutedEmailDerivedIds.has(c.id);
      })
      .map(c => c.id);
  }

  if (user.role === "sales") {
    return allCompanies
      .filter(c => ownerOf(c) === user.id || isSharedRep(c))
      .map(c => c.id);
  }

  if (user.role === "sales_director") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    const allIds = new Set([user.id, ...teamIds]);
    return allCompanies
      .filter(c => {
        const oid = ownerOf(c);
        return (oid && allIds.has(oid)) || isSharedRep(c) || unroutedEmailDerivedIds.has(c.id);
      })
      .map(c => c.id);
  }

  if (user.role === "logistics_manager") {
    if (!user.managerId) return [];
    const manager = await storage.getUser(user.managerId);
    if (!manager) return [];
    // L1.1 — `includeUnroutedEmailDerived` does NOT cascade through the
    // logistics_manager → manager resolution. Logistics coordinators are
    // intentionally out of scope for the Routing inbox; widening here
    // would expose unowned accounts in their LWQ/dashboards too.
    return getVisibleCompanyIds(manager);
  }

  return allCompanies
    .filter(c => ownerOf(c) === user.id || isSharedRep(c))
    .map(c => c.id);
}

export async function canAccessCompany(
  user: UserMinimal,
  companyId: string,
  options: CompanyVisibilityOptions = {},
): Promise<boolean> {
  if (user.role === "admin") return true;
  const visibleIds = await getVisibleCompanyIds(user, options);
  if (visibleIds === null) return true;
  return visibleIds.includes(companyId);
}

/**
 * Returns the set of user IDs whose rep-level data the viewer is allowed to
 * see across the platform. This is the canonical source of truth for any
 * "which reps can this user see" question (touchpoint history, today list,
 * company touchpoint summary, rep pickers, per-rep coaching/report URLs, …).
 *
 *   - Admin                      → null   (means "all users in org")
 *   - Director / Sales Director  → recursive reporting tree (incl. self)
 *   - National Account Manager   → recursive reporting tree (incl. self)
 *   - Sales / Logistics Manager  → recursive reporting tree (incl. self)
 *     (these roles often have direct reports too; team helper handles the
 *     no-reports case correctly by returning [self])
 *   - Everyone else              → [user.id]
 *
 * Use this with `canSeeRepUser(user, targetUserId)` to harden direct-fetch
 * endpoints against ID guessing. For listing endpoints, intersect the set
 * with the rows' owner/loggedBy field (null means no filter).
 */
export async function getVisibleRepUserIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;
  if (
    user.role === "director" ||
    user.role === "sales_director" ||
    user.role === "national_account_manager" ||
    user.role === "sales" ||
    user.role === "logistics_manager"
  ) {
    return storage.getTeamMemberIds(user.id, user.organizationId);
  }
  return [user.id];
}

/** Convenience predicate built on top of `getVisibleRepUserIds`. */
export async function canSeeRepUser(user: User, targetUserId: string): Promise<boolean> {
  if (user.id === targetUserId) return true;
  const visible = await getVisibleRepUserIds(user);
  if (visible === null) return true;
  return visible.includes(targetUserId);
}
