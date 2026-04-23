import { Request, Response, NextFunction } from "express";
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import type { User, Company, SharedRep } from "@shared/schema";

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

// In-memory impersonation tracker: adminClerkUserId -> targetDbUserId
const impersonationMap = new Map<string, string>();

export function setupAuth(app: any) {
  // Clerk middleware validates the session token / JWT on every request
  app.use(clerkMiddleware());

  // Public endpoint — exposes the Clerk publishable key to the frontend
  app.get("/api/config/public", (_req: Request, res: Response) => {
    res.json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? "" });
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
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { userId: clerkUserId } = getAuth(req);
      const isImpersonating = clerkUserId ? impersonationMap.has(clerkUserId) : !!req.session?.impersonatingAdminId;

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

    const target = await storage.getUser(req.params.userId);
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

export async function getCurrentUser(req: Request): Promise<User | null> {
  // Return cached value if requireAuth already resolved it
  if ((req as any)[RESOLVED_USER]) return (req as any)[RESOLVED_USER];

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
    // Check impersonation map
    const impersonatedDbUserId = impersonationMap.get(clerkUserId);
    if (impersonatedDbUserId) return (await storage.getUser(impersonatedDbUserId)) ?? null;

    // Look up by Clerk ID, auto-syncing on first login
    const byClerkId = await storage.getUserByClerkId(clerkUserId);
    if (byClerkId) return byClerkId;

    // First sign-in: try to link by email
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
      console.error("[getCurrentUser] Clerk user fetch failed:", err);
    }
    return null;
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

export async function getVisibleCompanyIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;

  const allCompanies = await storage.getCompanies(user.organizationId);

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

  if (user.role === "director" || user.role === "national_account_manager") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    return allCompanies
      .filter(c => (c.assignedTo && (teamIds.includes(c.assignedTo) || c.assignedTo === user.id)) || isSharedRep(c))
      .map(c => c.id);
  }

  if (user.role === "sales") {
    return allCompanies
      .filter(c => (c as any).salesPersonId === user.id || isSharedRep(c))
      .map(c => c.id);
  }

  if (user.role === "sales_director") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    const allIds = new Set([user.id, ...teamIds]);
    return allCompanies
      .filter(c => ((c as any).salesPersonId && allIds.has((c as any).salesPersonId)) || isSharedRep(c))
      .map(c => c.id);
  }

  if (user.role === "logistics_manager") {
    if (!user.managerId) return [];
    const manager = await storage.getUser(user.managerId);
    if (!manager) return [];
    return getVisibleCompanyIds(manager);
  }

  return allCompanies
    .filter(c => c.assignedTo === user.id || isSharedRep(c))
    .map(c => c.id);
}

export async function canAccessCompany(user: User, companyId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const visibleIds = await getVisibleCompanyIds(user);
  if (visibleIds === null) return true;
  return visibleIds.includes(companyId);
}
