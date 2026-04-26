import type { Express, Request, Response } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  agentCapabilities,
  agentFacts,
  agentMemories,
  agentActivity,
  agentOrgSettings,
  agents as agentsTable,
  agentPersonas,
  agentPlays,
  agentTools as agentToolsT,
  agentUserAccess as agentUserAccessT,
  users,
  type UserRole,
} from "@shared/schema";
import {
  ensureDefaultAgent,
  invalidatePersonaCache,
  invalidateAgentRuntime,
  isChannelSlot,
  listChannelSlots,
  DEFAULT_BASE_PERSONA,
  type ChannelSlot,
} from "../agent/persona";
import {
  ROLE_DEFAULTS,
  defaultEffectFor,
  canInvoke,
  hasModuleAccess,
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
  "module.access",
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

async function getOrInitOrgSettings(orgId: string) {
  const [existing] = await db.select().from(agentOrgSettings).where(eq(agentOrgSettings.organizationId, orgId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(agentOrgSettings).values({ organizationId: orgId }).returning();
  return created;
}

export function registerAgentAdminRoutes(app: Express) {
  // ─── Module access (everyone can self-check) ──────────────────────────────
  app.get("/api/agent/me/module-access", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const result = await hasModuleAccess(user);
      res.json(result);
    } catch {
      res.status(500).json({ error: "Failed to check access" });
    }
  });

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

  // ─── Admin: Module Access roster ──────────────────────────────────────────
  // List every user with their effective module.access state.
  app.get("/api/agent/admin/module-access", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

    const orgUsers = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
      .from(users)
      .where(eq(users.organizationId, me.organizationId));

    const overrides = await db.select().from(agentCapabilities)
      .where(and(eq(agentCapabilities.organizationId, me.organizationId), eq(agentCapabilities.capability, "module.access")));
    const overrideMap = new Map(overrides.map((o) => [o.userId, o]));

    const rows = orgUsers.map((u) => {
      const def = defaultEffectFor(u.role as UserRole, "module.access");
      const ov = overrideMap.get(u.id);
      const effect = (ov?.effect ?? def) as Effect;
      return {
        id: u.id, name: u.name, email: u.username, role: u.role,
        defaultEffect: def,
        effect,
        enabled: effect !== "deny",
        hasOverride: !!ov,
        updatedAt: ov?.updatedAt ?? null,
      };
    });
    res.json(rows.sort((a, b) => a.name.localeCompare(b.name)));
  });

  const moduleToggleSchema = z.object({ enabled: z.boolean() });
  app.put("/api/agent/admin/module-access/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const targetId = String(req.params.userId);
      const [target] = await db.select().from(users).where(eq(users.id, targetId));
      if (!target || target.organizationId !== me.organizationId) {
        return res.status(404).json({ error: "User not found" });
      }
      const { enabled } = moduleToggleSchema.parse(req.body);
      const targetEffect: Effect = enabled ? "allow" : "deny";
      const def = defaultEffectFor(target.role as UserRole, "module.access");

      // If the requested state matches the role default, clear the override.
      if (targetEffect === def) {
        await db.delete(agentCapabilities).where(and(
          eq(agentCapabilities.userId, targetId),
          eq(agentCapabilities.capability, "module.access"),
        ));
        return res.json({ ok: true, effect: def, source: "default" });
      }
      const [existing] = await db.select().from(agentCapabilities).where(and(
        eq(agentCapabilities.userId, targetId),
        eq(agentCapabilities.capability, "module.access"),
      ));
      if (existing) {
        await db.update(agentCapabilities).set({ effect: targetEffect, updatedBy: me.id, updatedAt: new Date() })
          .where(eq(agentCapabilities.id, existing.id));
      } else {
        await db.insert(agentCapabilities).values({
          organizationId: target.organizationId, userId: targetId,
          capability: "module.access", effect: targetEffect, updatedBy: me.id,
        });
      }
      res.json({ ok: true, effect: targetEffect, source: "override" });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to update access" });
    }
  });

  // Bulk apply: enable/disable for everyone in a role at once.
  const bulkSchema = z.object({ role: z.string().min(1), enabled: z.boolean() });
  app.post("/api/agent/admin/module-access/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const { role, enabled } = bulkSchema.parse(req.body);
      const targets = await db.select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.organizationId, me.organizationId), eq(users.role, role as UserRole)));

      let changed = 0;
      for (const t of targets) {
        const def = defaultEffectFor(t.role as UserRole, "module.access");
        const desired: Effect = enabled ? "allow" : "deny";
        if (desired === def) {
          await db.delete(agentCapabilities).where(and(
            eq(agentCapabilities.userId, t.id),
            eq(agentCapabilities.capability, "module.access"),
          ));
        } else {
          const [existing] = await db.select().from(agentCapabilities).where(and(
            eq(agentCapabilities.userId, t.id),
            eq(agentCapabilities.capability, "module.access"),
          ));
          if (existing) {
            await db.update(agentCapabilities).set({ effect: desired, updatedBy: me.id, updatedAt: new Date() })
              .where(eq(agentCapabilities.id, existing.id));
          } else {
            await db.insert(agentCapabilities).values({
              organizationId: me.organizationId, userId: t.id,
              capability: "module.access", effect: desired, updatedBy: me.id,
            });
          }
        }
        changed++;
      }
      res.json({ ok: true, changed });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Bulk update failed" });
    }
  });

  // ─── Admin: Org-level settings (mass foundational) ────────────────────────
  app.get("/api/agent/admin/org-settings", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
    const row = await getOrInitOrgSettings(me.organizationId);
    res.json(row);
  });

  const orgSettingsSchema = z.object({
    moduleEnabled: z.boolean().optional(),
    defaultAccessForNewUsers: z.enum(["allow", "deny"]).optional(),
    defaultModel: z.string().min(1).max(100).optional(),
    autoApprovePersonalMemory: z.boolean().optional(),
    allowExternalOutreach: z.boolean().optional(),
    valueiqLandingEnabled: z.boolean().optional(),
    valueiqTodaySeedEnabled: z.boolean().optional(),
    valueiqTodayTimezone: z.string().min(1).max(64).optional(),
    notes: z.string().max(2000).nullable().optional(),
  });
  app.put("/api/agent/admin/org-settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const patch = orgSettingsSchema.parse(req.body);
      await getOrInitOrgSettings(me.organizationId); // ensure row
      await db.update(agentOrgSettings)
        .set({ ...patch, updatedBy: me.id, updatedAt: new Date() })
        .where(eq(agentOrgSettings.organizationId, me.organizationId));
      const row = await getOrInitOrgSettings(me.organizationId);
      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // ─── Admin: Persona & Playbook ────────────────────────────────────────────
  // Returns the org's DNA agent + the active persona body for every channel
  // slot. Slots with no saved row return body=null and the loader will use
  // the built-in default at runtime.
  app.get("/api/agent/admin/persona", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });

      const agentId = await ensureDefaultAgent(me.organizationId);
      const slots = listChannelSlots();

      const channels = await Promise.all(slots.map(async (slot) => {
        const [row] = await db.select().from(agentPersonas)
          .where(and(
            eq(agentPersonas.agentId, agentId),
            eq(agentPersonas.channel, slot),
            eq(agentPersonas.isActive, true),
          ))
          .orderBy(desc(agentPersonas.version))
          .limit(1);
        return {
          channel: slot,
          body: row?.body ?? null,
          version: row?.version ?? 0,
          updatedAt: row?.createdAt ?? null,
          updatedBy: row?.createdBy ?? null,
        };
      }));

      res.json({
        agentId,
        defaultBody: DEFAULT_BASE_PERSONA,
        channels,
      });
    } catch (err: any) {
      console.error("[agent-admin] persona GET:", err);
      res.status(500).json({ error: "Failed to load persona" });
    }
  });

  const personaPutSchema = z.object({
    channel: z.string().min(1),
    body: z.string().min(1).max(20000),
  });
  app.put("/api/agent/admin/persona", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const parsed = personaPutSchema.parse(req.body);
      if (!isChannelSlot(parsed.channel)) {
        return res.status(400).json({ error: "Unknown channel slot" });
      }
      const agentId = await ensureDefaultAgent(me.organizationId);

      // Compute next version, deactivate any current active rows for this slot,
      // then insert a new active row. Keeping prior rows around gives us version
      // history for free.
      const [latest] = await db.select({ version: agentPersonas.version })
        .from(agentPersonas)
        .where(and(eq(agentPersonas.agentId, agentId), eq(agentPersonas.channel, parsed.channel)))
        .orderBy(desc(agentPersonas.version))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      await db.update(agentPersonas)
        .set({ isActive: false })
        .where(and(
          eq(agentPersonas.agentId, agentId),
          eq(agentPersonas.channel, parsed.channel),
          eq(agentPersonas.isActive, true),
        ));

      await db.insert(agentPersonas).values({
        agentId,
        channel: parsed.channel,
        body: parsed.body,
        isActive: true,
        version: nextVersion,
        createdBy: me.id,
      });

      invalidatePersonaCache(agentId);
      res.json({ ok: true, version: nextVersion });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[agent-admin] persona PUT:", err);
      res.status(500).json({ error: "Failed to save persona" });
    }
  });

  const personaResetSchema = z.object({ channel: z.string().min(1) });
  app.post("/api/agent/admin/persona/reset", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const parsed = personaResetSchema.parse(req.body);
      if (!isChannelSlot(parsed.channel)) {
        return res.status(400).json({ error: "Unknown channel slot" });
      }
      const agentId = await ensureDefaultAgent(me.organizationId);
      await db.update(agentPersonas)
        .set({ isActive: false })
        .where(and(
          eq(agentPersonas.agentId, agentId),
          eq(agentPersonas.channel, parsed.channel),
          eq(agentPersonas.isActive, true),
        ));
      invalidatePersonaCache(agentId);
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to reset persona" });
    }
  });

  app.get("/api/agent/admin/persona/history", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const channel = String(req.query.channel || "base") as ChannelSlot;
      if (!isChannelSlot(channel)) return res.status(400).json({ error: "Unknown channel slot" });
      const agentId = await ensureDefaultAgent(me.organizationId);

      const rows = await db.select({
        id: agentPersonas.id,
        channel: agentPersonas.channel,
        body: agentPersonas.body,
        version: agentPersonas.version,
        isActive: agentPersonas.isActive,
        createdBy: agentPersonas.createdBy,
        createdAt: agentPersonas.createdAt,
      })
        .from(agentPersonas)
        .where(and(eq(agentPersonas.agentId, agentId), eq(agentPersonas.channel, channel)))
        .orderBy(desc(agentPersonas.version))
        .limit(10);

      const ids = Array.from(new Set(rows.map((r) => r.createdBy).filter(Boolean) as string[]));
      const nameRows = ids.length
        ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
        : [];
      const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));
      res.json(rows.map((r) => ({ ...r, createdByName: r.createdBy ? nameMap.get(r.createdBy) ?? null : null })));
    } catch (err: any) {
      console.error("[agent-admin] persona history:", err);
      res.status(500).json({ error: "Failed to load history" });
    }
  });

  const personaRestoreSchema = z.object({ versionId: z.string().min(1) });
  app.post("/api/agent/admin/persona/restore", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const parsed = personaRestoreSchema.parse(req.body);
      const agentId = await ensureDefaultAgent(me.organizationId);

      const [source] = await db.select().from(agentPersonas).where(eq(agentPersonas.id, parsed.versionId));
      if (!source || source.agentId !== agentId) {
        return res.status(404).json({ error: "Version not found" });
      }

      const [latest] = await db.select({ version: agentPersonas.version })
        .from(agentPersonas)
        .where(and(eq(agentPersonas.agentId, agentId), eq(agentPersonas.channel, source.channel)))
        .orderBy(desc(agentPersonas.version))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      await db.update(agentPersonas)
        .set({ isActive: false })
        .where(and(
          eq(agentPersonas.agentId, agentId),
          eq(agentPersonas.channel, source.channel),
          eq(agentPersonas.isActive, true),
        ));

      await db.insert(agentPersonas).values({
        agentId,
        channel: source.channel,
        body: source.body,
        isActive: true,
        version: nextVersion,
        createdBy: me.id,
      });

      invalidatePersonaCache(agentId);
      res.json({ ok: true, version: nextVersion });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to restore version" });
    }
  });

  // ─── Plays ────────────────────────────────────────────────────────────────
  app.get("/api/agent/admin/plays", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const agentId = await ensureDefaultAgent(me.organizationId);
      const rows = await db.select().from(agentPlays)
        .where(eq(agentPlays.agentId, agentId))
        .orderBy(agentPlays.sortOrder, agentPlays.createdAt);
      res.json(rows);
    } catch (err: any) {
      console.error("[agent-admin] plays GET:", err);
      res.status(500).json({ error: "Failed to load plays" });
    }
  });

  const playSchema = z.object({
    name: z.string().min(2).max(120),
    whenToUse: z.string().min(2).max(500),
    body: z.string().min(2).max(4000),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  });
  app.post("/api/agent/admin/plays", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const parsed = playSchema.parse(req.body);
      const agentId = await ensureDefaultAgent(me.organizationId);
      const [row] = await db.insert(agentPlays).values({
        agentId,
        name: parsed.name,
        whenToUse: parsed.whenToUse,
        body: parsed.body,
        enabled: parsed.enabled ?? true,
        sortOrder: parsed.sortOrder ?? 0,
        createdBy: me.id,
      }).returning();
      invalidatePersonaCache(agentId);
      res.json(row);
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to create play" });
    }
  });

  const playPatchSchema = playSchema.partial();
  app.put("/api/agent/admin/plays/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const id = String(req.params.id);
      const agentId = await ensureDefaultAgent(me.organizationId);
      const [existing] = await db.select().from(agentPlays).where(eq(agentPlays.id, id));
      if (!existing || existing.agentId !== agentId) {
        return res.status(404).json({ error: "Play not found" });
      }
      const patch = playPatchSchema.parse(req.body);
      await db.update(agentPlays)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(agentPlays.id, id));
      invalidatePersonaCache(agentId);
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      res.status(500).json({ error: "Failed to update play" });
    }
  });

  app.delete("/api/agent/admin/plays/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const id = String(req.params.id);
      const agentId = await ensureDefaultAgent(me.organizationId);
      const [existing] = await db.select().from(agentPlays).where(eq(agentPlays.id, id));
      if (!existing || existing.agentId !== agentId) {
        return res.status(404).json({ error: "Play not found" });
      }
      await db.delete(agentPlays).where(eq(agentPlays.id, id));
      invalidatePersonaCache(agentId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete play" });
    }
  });

  // ─── Agent Registry CRUD (Task #291) ──────────────────────────────────────
  // Admin-only. Org-scoped. The default DNA agent cannot be archived.
  app.get("/api/admin/agents", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const rows = await db.select().from(agentsTable)
        .where(eq(agentsTable.organizationId, me.organizationId))
        .orderBy(desc(agentsTable.isDefault), agentsTable.name);
      res.json(rows);
    } catch {
      res.status(500).json({ error: "Failed to load agents" });
    }
  });

  const agentBodySchema = z.object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
    description: z.string().max(1000).optional().nullable(),
    avatarUrl: z.string().max(500).optional().nullable(),
    model: z.string().max(80).optional().nullable(),
    accessScope: z.enum(["everyone", "roles", "specific_users"]).default("everyone"),
    allowedRoles: z.array(z.string()).optional().nullable(),
    status: z.enum(["draft", "published", "archived"]).optional(),
  });

  app.post("/api/admin/agents", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const body = agentBodySchema.parse(req.body);
      const [row] = await db.insert(agentsTable).values({
        organizationId: me.organizationId,
        slug: body.slug, name: body.name,
        description: body.description ?? null, avatarUrl: body.avatarUrl ?? null,
        ownerId: me.id, model: body.model ?? "gpt-4o",
        accessScope: body.accessScope, allowedRoles: body.allowedRoles ?? null,
        status: body.status ?? "published", createdBy: me.id, isDefault: false,
      }).returning();
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? "Invalid agent" });
    }
  });

  app.patch("/api/admin/agents/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const body = agentBodySchema.partial().parse(req.body);
      const patch: Partial<typeof agentsTable.$inferInsert> = { updatedAt: new Date() };
      if (body.slug !== undefined) patch.slug = body.slug;
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description ?? null;
      if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl ?? null;
      if (body.model !== undefined) patch.model = body.model;
      if (body.accessScope !== undefined) patch.accessScope = body.accessScope;
      if (body.allowedRoles !== undefined) patch.allowedRoles = body.allowedRoles ?? null;
      if (body.status !== undefined) patch.status = body.status;
      const [row] = await db.update(agentsTable).set(patch)
        .where(and(eq(agentsTable.id, pStr(req.params.id)), eq(agentsTable.organizationId, me.organizationId)))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      invalidateAgentRuntime(row.id);
      invalidatePersonaCache(row.id);
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? "Failed" });
    }
  });

  app.post("/api/admin/agents/:id/archive", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const [row] = await db.select().from(agentsTable)
        .where(and(eq(agentsTable.id, pStr(req.params.id)), eq(agentsTable.organizationId, me.organizationId))).limit(1);
      if (!row) return res.status(404).json({ error: "Not found" });
      if (row.isDefault) return res.status(400).json({ error: "Cannot archive the default agent" });
      const [updated] = await db.update(agentsTable).set({ status: "archived", updatedAt: new Date() })
        .where(eq(agentsTable.id, row.id)).returning();
      invalidateAgentRuntime(row.id);
      res.json(updated);
    } catch {
      res.status(500).json({ error: "Failed to archive agent" });
    }
  });

  app.post("/api/admin/agents/:id/publish", requireAuth, async (req: Request, res: Response) => {
    try {
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
      const [updated] = await db.update(agentsTable).set({ status: "published", updatedAt: new Date() })
        .where(and(eq(agentsTable.id, pStr(req.params.id)), eq(agentsTable.organizationId, me.organizationId))).returning();
      if (!updated) return res.status(404).json({ error: "Not found" });
      invalidateAgentRuntime(updated.id);
      res.json(updated);
    } catch {
      res.status(500).json({ error: "Failed to publish" });
    }
  });

  // Helper: load an agent and verify it belongs to the caller's org. Returns
  // null if missing or cross-org. Callers should 404 on null.
  async function loadOrgAgent(agentId: string, orgId: string) {
    const [row] = await db.select().from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.organizationId, orgId)))
      .limit(1);
    return row ?? null;
  }

  // Tool allowlist
  app.get("/api/admin/agents/:id/tools", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
    const agent = await loadOrgAgent(pStr(req.params.id), me.organizationId);
    if (!agent) return res.status(404).json({ error: "Not found" });
    const rows = await db.select().from(agentToolsT).where(eq(agentToolsT.agentId, agent.id));
    res.json({
      capabilities: ALL_CAPABILITIES,
      enabled: rows.map((r) => r.capability),
    });
  });
  app.put("/api/admin/agents/:id/tools", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
    const agent = await loadOrgAgent(pStr(req.params.id), me.organizationId);
    if (!agent) return res.status(404).json({ error: "Not found" });
    const caps = z.array(z.string()).parse(req.body?.capabilities ?? []);
    const valid = caps.filter((c) => (ALL_CAPABILITIES as string[]).includes(c));
    await db.delete(agentToolsT).where(eq(agentToolsT.agentId, agent.id));
    if (valid.length) {
      await db.insert(agentToolsT).values(valid.map((c) => ({ agentId: agent.id, capability: c as Capability })));
    }
    invalidateAgentRuntime(agent.id);
    res.json({ ok: true, count: valid.length });
  });

  // Per-user access
  app.get("/api/admin/agents/:id/access", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
    const agent = await loadOrgAgent(pStr(req.params.id), me.organizationId);
    if (!agent) return res.status(404).json({ error: "Not found" });
    const rows = await db.select().from(agentUserAccessT).where(eq(agentUserAccessT.agentId, agent.id));
    res.json({ userIds: rows.filter((r) => r.enabled).map((r) => r.userId) });
  });
  app.put("/api/admin/agents/:id/access", requireAuth, async (req: Request, res: Response) => {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(me.role)) return res.status(403).json({ error: "Admin only" });
    const agent = await loadOrgAgent(pStr(req.params.id), me.organizationId);
    if (!agent) return res.status(404).json({ error: "Not found" });
    const userIds = z.array(z.string()).parse(req.body?.userIds ?? []);
    // Restrict assigned users to the same org.
    const orgUsers = userIds.length
      ? await db.select({ id: users.id }).from(users)
          .where(and(eq(users.organizationId, me.organizationId), sql`${users.id} = ANY(${userIds})`))
      : [];
    const allowed = new Set(orgUsers.map((u) => u.id));
    const filtered = userIds.filter((u) => allowed.has(u));
    await db.delete(agentUserAccessT).where(eq(agentUserAccessT.agentId, agent.id));
    if (filtered.length) {
      await db.insert(agentUserAccessT).values(filtered.map((u) => ({ agentId: agent.id, userId: u })));
    }
    res.json({ ok: true, count: filtered.length });
  });
}
