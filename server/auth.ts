import { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { storage } from "./storage";
import { sendEmail, buildPasswordResetEmail } from "./emailService";
import type { User } from "@shared/schema";

const PgStore = connectPgSimple(session);

declare module "express-session" {
  interface SessionData {
    userId: string;
    organizationId: string;
    organizationSlug?: string;
    impersonatingAdminId?: string;
  }
}

export function setupAuth(app: any) {
  app.use(
    session({
      store: new PgStore({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET || "orgchart-crm-secret-key",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false,
        sameSite: "lax",
      },
    })
  );

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const { username, password, name } = req.body;
      if (!username || !password || !name) {
        return res.status(400).json({ error: "Username, password, and name are required" });
      }

      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ error: "Username already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const org = await storage.getDefaultOrganization();
      if (!org) return res.status(500).json({ error: "No organization configured" });
      const allUsers = await storage.getUsers(org.id);
      const role = allUsers.length === 0 ? "admin" : "account_manager";

      const user = await storage.createUser({
        organizationId: org.id,
        username,
        password: hashedPassword,
        name,
        role,
        managerId: null,
      });

      req.session.userId = user.id;
      req.session.organizationId = user.organizationId;
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      req.session.userId = user.id;
      req.session.organizationId = user.organizationId;
      const org = await storage.getOrganizationById(user.organizationId);
      req.session.organizationSlug = org?.slug ?? "";
      const now = new Date().toISOString();
      await storage.updateUser(user.id, user.organizationId, { lastLoginAt: now });
      const { password: _, ...safeUser } = user;
      res.json({ ...safeUser, lastLoginAt: now, organizationSlug: req.session.organizationSlug });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required" });
      }
      const user = await storage.getUserByUsername(email.trim().toLowerCase());
      if (!user) {
        return res.json({ success: true });
      }
      const token = crypto.randomBytes(48).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await storage.createPasswordResetToken(user.id, token, expiresAt);
      const baseUrl = (process.env.APP_URL || "https://sales-org-builder.replit.app").replace(/\/$/, "");
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      await sendEmail({
        to: user.username,
        subject: "Reset your Freight DNA password",
        html: buildPasswordResetEmail(user.name, resetUrl),
        text: `Hi ${user.name}, reset your password here: ${resetUrl} (expires in 1 hour)`,
      });
      res.json({ success: true });
    } catch (err) {
      console.error("[auth] forgot-password error:", err);
      res.status(500).json({ error: "Failed to send reset email" });
    }
  });

  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || !password || typeof token !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "Token and password are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const record = await storage.getPasswordResetToken(token);
      if (!record) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }
      if (new Date(record.expiresAt) < new Date()) {
        return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
      }
      const hashed = await bcrypt.hash(password, 10);
      const user = await storage.getUser(record.userId);
      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }
      await storage.updateUser(user.id, user.organizationId, { password: hashed });
      await storage.deletePasswordResetTokensByUser(user.id);
      res.json({ success: true });
    } catch (err) {
      console.error("[auth] reset-password error:", err);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    const { password: _, ...safeUser } = user;
    const isImpersonating = !!req.session.impersonatingAdminId;
    let impersonatingAdminName: string | null = null;
    if (isImpersonating) {
      const admin = await storage.getUser(req.session.impersonatingAdminId!);
      if (admin) impersonatingAdminName = admin.name;
    }
    res.json({ ...safeUser, isImpersonating, impersonatingAdminName, organizationSlug: req.session.organizationSlug ?? "" });
  });

  app.post("/api/admin/impersonate/:userId", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
    const adminId = req.session.impersonatingAdminId || req.session.userId;
    const admin = await storage.getUser(adminId);
    if (!admin || admin.role !== "admin") return res.status(403).json({ error: "Admin only" });

    const target = await storage.getUser(req.params.userId as string);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role === "admin") return res.status(400).json({ error: "Cannot impersonate another admin" });
    if (target.organizationId !== admin.organizationId) return res.status(403).json({ error: "Cannot impersonate user from a different organization" });

    req.session.impersonatingAdminId = adminId;
    req.session.userId = target.id;
    req.session.organizationId = target.organizationId;

    const { password: _, ...safeTarget } = target;
    res.json({ ...safeTarget, isImpersonating: true, impersonatingAdminName: admin.name });
  });

  app.post("/api/admin/stop-impersonating", async (req: Request, res: Response) => {
    if (!req.session.impersonatingAdminId) return res.status(400).json({ error: "Not impersonating" });
    req.session.userId = req.session.impersonatingAdminId;
    delete req.session.impersonatingAdminId;

    const admin = await storage.getUser(req.session.userId);
    if (!admin) return res.status(404).json({ error: "Admin not found" });
    req.session.organizationId = admin.organizationId;
    const { password: _, ...safeAdmin } = admin;
    res.json({ ...safeAdmin, isImpersonating: false, impersonatingAdminName: null });
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!req.session.organizationId) {
    const user = await storage.getUser(req.session.userId);
    if (user) {
      req.session.organizationId = user.organizationId;
    }
  }
  next();
}

export async function getCurrentUser(req: Request): Promise<User | null> {
  if (!req.session.userId) return null;
  const user = await storage.getUser(req.session.userId);
  return user || null;
}

export async function getVisibleCompanyIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;

  const allCompanies = await storage.getCompanies(user.organizationId);

  // Directors and NAMs: see their whole team's accounts (assignedTo)
  if (user.role === "director" || user.role === "national_account_manager") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    return allCompanies
      .filter(c => c.assignedTo && (teamIds.includes(c.assignedTo) || c.assignedTo === user.id))
      .map(c => c.id);
  }

  // Sales reps: see accounts where they are the linked salesperson
  if (user.role === "sales") {
    return allCompanies
      .filter(c => (c as any).salesPersonId === user.id)
      .map(c => c.id);
  }

  // Sales directors: see all accounts linked to anyone on their team as salesperson
  if (user.role === "sales_director") {
    const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
    const allIds = new Set([user.id, ...teamIds]);
    return allCompanies
      .filter(c => (c as any).salesPersonId && allIds.has((c as any).salesPersonId))
      .map(c => c.id);
  }

  // Logistics managers: see the same accounts their manager's team manages
  if (user.role === "logistics_manager") {
    if (!user.managerId) return [];
    const manager = await storage.getUser(user.managerId);
    if (!manager) return [];
    // Delegate to the manager's visibility
    return getVisibleCompanyIds(manager);
  }

  // Account managers and other roles: see only accounts assigned to them
  return allCompanies
    .filter(c => c.assignedTo === user.id)
    .map(c => c.id);
}

export async function canAccessCompany(user: User, companyId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const visibleIds = await getVisibleCompanyIds(user);
  if (visibleIds === null) return true;
  return visibleIds.includes(companyId);
}
