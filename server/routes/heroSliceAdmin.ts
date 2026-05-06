/**
 * Hero Slice admin routes (Task #1073).
 *
 * Admin-only CRUD for the `hero_slice_auto_assign:<orgId>` setting that
 * drives the email→quote→won→load auto-assignment loop. Backed by
 * `server/services/heroSliceAutoAssign.ts`'s get/set helpers so the
 * write contract stays in one place.
 *
 *   GET  /api/admin/hero-slices                   list slices + LM picker
 *   PUT  /api/admin/hero-slices                   replace the slice list
 *   GET  /api/admin/hero-slices/auto-handoff      read on/off toggle
 *   PUT  /api/admin/hero-slices/auto-handoff      flip on/off toggle
 *
 * The slice payload mirrors `HeroSliceConfig` exactly. We never accept a
 * partial update — the UI always re-PUTs the full list — so a buggy
 * client cannot silently drop a slice.
 */

import type { Express } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../storage";
import { users } from "@shared/schema";
import {
  getHeroSlices,
  setHeroSlices,
  type HeroSliceConfig,
} from "../services/heroSliceAutoAssign";
import {
  getAutoWonQuoteAfHandoffEnabled,
  setAutoWonQuoteAfHandoffEnabled,
} from "../services/customerQuotes";

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ orgId: string; userId: string } | null> {
  const user = req.user;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return null; }
  return { orgId: user.organizationId, userId: user.id };
}

// Single source of truth for the slice payload shape. `id` and `lmUserId`
// are required; the three pattern fields are optional and may be empty
// strings (treated as "no gate" by the matcher).
const heroSliceSchema = z.object({
  id: z.string().min(1).max(120),
  customerNamePattern: z.string().min(1).max(200),
  originStatePattern: z.string().max(200).nullable().optional(),
  destinationStatePattern: z.string().max(200).nullable().optional(),
  equipmentPattern: z.string().max(200).nullable().optional(),
  lmUserId: z.string().min(1),
});

const updateSchema = z.object({
  slices: z.array(heroSliceSchema).max(50),
});

const handoffSchema = z.object({
  enabled: z.boolean(),
});

export function registerHeroSliceAdminRoutes(app: Express): void {
  // GET — slices + the candidate LM list (logistics_manager users in the
  // org) so the page can render a friendly LM picker without a second
  // round trip.
  app.get("/api/admin/hero-slices", async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const [slices, autoHandoffEnabled] = await Promise.all([
        getHeroSlices(ctx.orgId),
        getAutoWonQuoteAfHandoffEnabled(ctx.orgId),
      ]);

      // Roles that legitimately cover loads. We surface logistics_manager
      // first (the canonical hero target) but include logistics_coordinator
      // and admin so a small org without a dedicated LM can still wire
      // the loop up.
      const lmUsers = await db
        .select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(and(
          eq(users.organizationId, ctx.orgId),
          inArray(users.role, ["logistics_manager", "logistics_coordinator", "admin"]),
        ));

      return res.json({
        ok: true,
        slices,
        autoHandoffEnabled,
        lmUsers,
      });
    } catch (err) {
      console.error("[admin/hero-slices GET]", err);
      return res.status(500).json({ error: "Failed to read hero slice config" });
    }
  });

  // PUT — replace the slice list. Validates that every lmUserId belongs
  // to this org so a typo can't silently route loads to a foreign user.
  app.put("/api/admin/hero-slices", async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      }

      // Cross-org-leak guard: every referenced LM must live in this org.
      const lmIds = Array.from(new Set(parsed.data.slices.map(s => s.lmUserId)));
      if (lmIds.length > 0) {
        const found = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.organizationId, ctx.orgId), inArray(users.id, lmIds)));
        const foundSet = new Set(found.map(r => r.id));
        const missing = lmIds.filter(id => !foundSet.has(id));
        if (missing.length > 0) {
          return res.status(400).json({
            error: "One or more lmUserId values are not users in this org",
            missing,
          });
        }
      }

      // Slice ids must be unique inside the list — duplicate ids would
      // make the audit log and "first matching slice wins" rule confusing.
      const ids = parsed.data.slices.map(s => s.id);
      if (new Set(ids).size !== ids.length) {
        return res.status(400).json({ error: "Slice ids must be unique" });
      }

      // Normalize empty optional pattern fields back to null so the
      // matcher's `if (!pattern) return true` short-circuit is taken.
      const normalized: HeroSliceConfig[] = parsed.data.slices.map(s => ({
        id: s.id.trim(),
        customerNamePattern: s.customerNamePattern.trim(),
        originStatePattern: s.originStatePattern?.trim() || null,
        destinationStatePattern: s.destinationStatePattern?.trim() || null,
        equipmentPattern: s.equipmentPattern?.trim() || null,
        lmUserId: s.lmUserId,
      }));

      await setHeroSlices(ctx.orgId, normalized);
      return res.json({ ok: true, slices: normalized });
    } catch (err) {
      console.error("[admin/hero-slices PUT]", err);
      return res.status(500).json({ error: "Failed to update hero slice config" });
    }
  });

  // GET — global on/off for the entire converter (kept distinct from the
  // slice list so disabling the loop never destroys configured slices).
  app.get("/api/admin/hero-slices/auto-handoff", async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const enabled = await getAutoWonQuoteAfHandoffEnabled(ctx.orgId);
      return res.json({ ok: true, enabled });
    } catch (err) {
      console.error("[admin/hero-slices/auto-handoff GET]", err);
      return res.status(500).json({ error: "Failed to read auto-handoff toggle" });
    }
  });

  app.put("/api/admin/hero-slices/auto-handoff", async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const parsed = handoffSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      }
      await setAutoWonQuoteAfHandoffEnabled(ctx.orgId, parsed.data.enabled);
      return res.json({ ok: true, enabled: parsed.data.enabled });
    } catch (err) {
      console.error("[admin/hero-slices/auto-handoff PUT]", err);
      return res.status(500).json({ error: "Failed to update auto-handoff toggle" });
    }
  });
}
