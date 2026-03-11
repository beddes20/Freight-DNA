import { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const PgStore = connectPgSimple(session);

declare module "express-session" {
  interface SessionData {
    userId: string;
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
      const allUsers = await storage.getUsers();
      const role = allUsers.length === 0 ? "admin" : "account_manager";

      const user = await storage.createUser({
        username,
        password: hashedPassword,
        name,
        role,
        managerId: null,
      });

      req.session.userId = user.id;
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
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
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

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
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

  if (user.role === "national_account_manager") {
    const teamIds = await storage.getTeamMemberIds(user.id);
    const allCompanies = await storage.getCompanies();
    return allCompanies
      .filter(c => c.assignedTo && teamIds.includes(c.assignedTo))
      .map(c => c.id);
  }

  const allCompanies = await storage.getCompanies();
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
