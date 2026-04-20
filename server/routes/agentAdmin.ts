import type { Express, Request, Response } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  agentCapabilities,
  agentFacts,
  agentMemories,
  agentActivity,
  users,
  type UserRole,
} from "@shared/schema";
import {
  ROLE_DEFAULTS,
  defaultEffectFor,
  canInvoke,
  type Capability,
  type Effect,
} from "../agent/permissions";
import { addFact, deleteFact, deleteMemory } from "../agent/memory";

/**
 * All capability keys, in the order they should appear in the admin UI.
 * Mirrors the union in permissions.ts but as a runtime array for dropdowns.
 */
const ALL_CAPABILITIES: Capability[] = [
  "read.account", "read.contact", "read.touchpoint", "read.task", "read.rfp",
  "read.award", "read.opportunity", "read.lane", "read.carrier", "read.market",
  "read.financial", "read.memory", "read.nba", "navigate.crm",
  "write.touchpoint", "write.task", "write.task.complete",
  "write.touchpoint.meaningful", "write.account", "write.opportunity",
  "write.memory", "write.email.draft",
  "write.sms.driver", "write.voice.driver", "write.email.external",
];

const ALL_ROLES: UserRole[] = [
  "admin", "director", "sales_director",
  "national_account_manager", "account_manager", "sales",
  "logistics_manager", "logistics_coordinator",
];

function isAdmin(role: string | null | undefined) {
  return role === "admin";
}
function isManagerOrAbove(role: string | null | undefined) {
  return role === "admin" || role === "director" || role === "sales_director" || role === "national_account_manager";
}

export function registerAgentAdminRoutes(app: Express) {
  // ─── Self-service: AI Assistant settings ──────────────────────────────────

  // List my effective capabilities (defaults + per-user overrides resolved).
  app.get("/api/agent/me/capabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const overrides = await db.select().from(agentCapabilities).where(eq(agentCapabilities.userId, user.id));
      const overrideMap = new Map(overrides.map((o) => [o.capability, o.effect]));

      const rows = ALL_CAPABILITIES.map((cap) => {
        const def = defaultEffectFor(user.role as UserRole, cap);
        const override = overrideMap.get(cap);
        return {
          capability: cap,
          defaultEffect: def,
          effect: (override ?? def) as Effect,
          hasOverride: overrideMap.has(cap),
        };
      });
      res.json(rows);
    } catch (err: any) {
      console.error("[agent-admin] me/capabilities:", err);
      res.status(500).json({ error: "Failed to load capabilities" });
    }
  });

  // List my standing facts.
  app.get("/api/agent/me/facts", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const rows = await db.select().from(agentFacts)
        .where(eq(agentFacts.userId, user.id))
        .orderBy(desc(agentFacts.pinned), desc(agentFacts.createdAt));
      res.json(rows);
    } catch {
      res.status(500).json({ error: "Failed to load facts" });
    }
  });

  const factSchema = z.object({
    fact: z.string().min(2).max(500),
    pinned: z.boolean().optional(),
  });
  app.post("/api/agent/me/facts", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const parsed = factSchema.parse(req.body);
      const row = await addFact({
        organizationId: user.organizationId,
        userId: user.id,
        fact: parsed.fact,
        pinned: parsed.pinned ?? false,
        source: "rep",
      });
      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to add fact" });
    }
  });

  app.delete("/api/agent/me/facts/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const ok = await deleteFact(user.id, String(req.params.id), user.organizationId);
      if (!ok) return res.status(404).json({ error: "Fact not found" });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Failed to delete fact" });
    }
  });

  // List my memories (most recent first).
  app.get("/api/agent/me/memories", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
      const rows = await db.select({
        id: agentMemories.id,
        kind: agentMemories.kind,
        content: agentMemories.content,
        importance: agentMemories.importance,
        relatedCompanyId: agentMemories.relatedCompanyId,
        createdAt: agentMemories.createdAt,
      })
        .from(agentMemories)
        .where(eq(agentMemories.userId, user.id))
        .orderBy(desc(agentMemories.createdAt))
        .limit(limit);
      res.json(rows);
    } catch {
      res.status(500).json({ error: "Failed to load memories" });
    }
  });

  app.delete("/api/agent/me/memories/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const ok = await deleteMemory(user.id, String(req.params.id), user.organizationId);
      if (!ok) return res.status(404).json({ error: "Memory not found" });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "Failed to delete memory" });
    }
  });

  // ─── Activity timeline (scope: me | team | org) ───────────────────────────
  app.get("/api/agent/activity", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const scope = String(req.query.scope || "me") as "me" | "team" | "org";
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
      const before = req.query.before ? new Date(String(req.query.before)) : null;

      // Resolve target user IDs by scope.
      let userIds: string[] = [user.id];
      if (scope === "team") {
        if (!isManagerOrAbove(user.role)) {
          // Reps fall back to "me" silently.
          userIds = [user.id];
        } else {
          // Team = users this manager directly manages, plus self.
          const reports = await db.select({ id: users.id })
            .from(users)
            .where(and(eq(users.organizationId, user.organizationId), eq(users.managerId, user.id)));
          userIds = [user.id, ...reports.map((r) => r.id)];
        }
      } else if (scope === "org") {
        if (!isAdmin(user.role)) return res.status(403).json({ error: "Admin only" });
        const orgUsers = await db.select({ id: users.id })
          .from(users)
          .where(eq(users.organizationId, user.organizationId));
        userIds = orgUsers.map((u) => u.id);
      }

      const conditions = [
        eq(agentActivity.organizationId, user.organizationId),
        sql`${agentActivity.userId} = ANY(${userIds})`,
      ];
      if (before && !isNaN(before.getTime())) {
        conditions.push(sql`${agentActivity.createdAt} < ${before.toISOString()}`);
      }

      const rows = await db.select({
        id: agentActivity.id,
        userId: agentActivity.userId,
        channel: agentActivity.channel,
        direction: agentActivity.direction,
        tool: agentActivity.tool,
        capability: agentActivity.capability,
        summary: agentActivity.summary,
        model: agentActivity.model,
        latencyMs: agentActivity.latencyMs,
        outcome: agentActivity.outcome,
        errorMessage: agentActivity.errorMessage,
        relatedCompanyId: agentActivity.relatedCompanyId,
        createdAt: agentActivity.createdAt,
      })
        .from(agentActivity)
        .where(and(...conditions))
        .orderBy(desc(agentActivity.createdAt))
        .limit(limit);

      // Attach user names in one extra query.
      const ids = Array.from(new Set(rows.map((r) => r.userId)));
      const nameRows = ids.length
        ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} = ANY(${ids})`)
        : [];
      const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));

      res.json(rows.map((r) => ({ ...r, userName: nameMap.get(r.userId) ?? "Unknown" })));
    } catch (err: any) {
      console.error("[agent-admin] activity:", err);
      res.status(500).json({ error: "Failed to load activity" });
    }
  });

  // ─── Admin: AI Permissions ────────────────────────────────────────────────

  // Capability + role default catalog used to render the admin grid.
  app.get("/api/agent/admin/catalog", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(user.role)) return res.status(403).json({ error: "Admin only" });

    const matrix: Record<string, Record<string, Effect>> = {};
    for (const role of ALL_ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) matrix[role][cap] = ROLE_DEFAULTS[role][cap];
    }
    res.json({ capabilities: ALL_CAPABILITIES, roles: ALL_ROLES, defaults: matrix });
  });

  // Read overrides for a specific user.
  app.get("/api/agent/admin/users/:userId/capabilities", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

    const targetId = String(req.params.userId);
    const [target] = await db.select().from(users).where(eq(users.id, targetId));
    if (!target || target.organizationId !== me.organizationId) {
      return res.status(404).json({ error: "User not found" });
    }

    const overrides = await db.select().from(agentCapabilities).where(eq(agentCapabilities.userId, targetId));
    const overrideMap = new Map(overrides.map((o) => [o.capability, o]));

    const rows = ALL_CAPABILITIES.map((cap) => {
      const def = defaultEffectFor(target.role as UserRole, cap);
      const ov = overrideMap.get(cap);
      return {
        capability: cap,
        defaultEffect: def,
        effect: (ov?.effect ?? def) as Effect,
        hasOverride: !!ov,
        note: ov?.note ?? null,
        updatedBy: ov?.updatedBy ?? null,
        updatedAt: ov?.updatedAt ?? null,
      };
    });
    res.json({
      user: { id: target.id, name: target.name, role: target.role },
      rows,
    });
  });

  const upsertSchema = z.object({
    capability: z.string().min(1),
    effect: z.enum(["allow", "deny", "auto"]).nullable(),
    note: z.string().max(500).optional(),
  });
  app.put("/api/agent/admin/users/:userId/capabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const targetId = String(req.params.userId);
      const [target] = await db.select().from(users).where(eq(users.id, targetId));
      if (!target || target.organizationId !== me.organizationId) {
        return res.status(404).json({ error: "User not found" });
      }
      const parsed = upsertSchema.parse(req.body);
      if (!ALL_CAPABILITIES.includes(parsed.capability as Capability)) {
        return res.status(400).json({ error: "Unknown capability" });
      }

      // effect=null → clear the override (revert to role default).
      if (parsed.effect === null) {
        await db.delete(agentCapabilities).where(and(
          eq(agentCapabilities.userId, targetId),
          eq(agentCapabilities.capability, parsed.capability),
        ));
        return res.json({ ok: true, cleared: true });
      }

      // Upsert.
      const [existing] = await db.select().from(agentCapabilities).where(and(
        eq(agentCapabilities.userId, targetId),
        eq(agentCapabilities.capability, parsed.capability),
      ));
      if (existing) {
        await db.update(agentCapabilities).set({
          effect: parsed.effect,
          note: parsed.note ?? null,
          updatedBy: me.id,
          updatedAt: new Date(),
        }).where(eq(agentCapabilities.id, existing.id));
      } else {
        await db.insert(agentCapabilities).values({
          organizationId: target.organizationId,
          userId: targetId,
          capability: parsed.capability,
          effect: parsed.effect,
          note: parsed.note ?? null,
          updatedBy: me.id,
        });
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[agent-admin] upsert capability:", err);
      res.status(500).json({ error: "Failed to update capability" });
    }
  });
}
