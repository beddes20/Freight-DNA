/**
 * Task #1126 Phase 1 Step 3 — Admin-only user lifecycle write paths.
 *
 * These routes are the ONLY HTTP entry point that writes the user
 * lifecycle columns (is_active, is_*, deleted_at, deactivated_at, …)
 * or the user_lifecycle_events audit table. All writes go through the
 * matching storage methods, which row-lock the target user and emit
 * an audit row in the same transaction.
 *
 * IMPORTANT: this file does NOT change any read-side behavior. Auth,
 * GET /api/users defaults, dashboards, dropdowns, Stripe seats,
 * Webex, contact-jobs, etc. are all unchanged. Read-side migration
 * is Phase 1 Step 4+.
 *
 * Every route is admin-only AND org-scoped:
 *   • requireAuth                         — 401 if no session
 *   • isAdmin(viewer)                     — 403 unless role === "admin"
 *   • storage.<method>(id, viewer.organizationId, …)  — server-side
 *     org guard so a future caller cannot bypass the route.
 */

import type { Express } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import { isAdmin } from "../lib/roles";
import { pStr, qStr } from "../lib/req";
import { storage, UserLifecycleError } from "../storage";

// Map storage error codes → HTTP status. Centralized so every route
// reports the same shape for the same failure mode.
function lifecycleErrorStatus(err: UserLifecycleError): number {
  switch (err.code) {
    case "NOT_FOUND": return 404;
    case "IMPACT_BLOCK": return 409;
    case "CONFLICT": return 409;
    case "GUARD": return 400;
    default: return 400;
  }
}

function sendLifecycleError(res: any, err: unknown): void {
  if (err instanceof UserLifecycleError) {
    const status = lifecycleErrorStatus(err);
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.meta) body.meta = err.meta;
    res.status(status).json(body);
    return;
  }
  console.error("[user-lifecycle] internal error:", err);
  res.status(500).json({ error: "Internal error" });
}

const classifyBody = z.object({
  isServiceAccount: z.boolean().optional(),
  isDemo: z.boolean().optional(),
  isFixture: z.boolean().optional(),
  isQuarantined: z.boolean().optional(),
  // Allow explicit isActive=false alongside isServiceAccount=true so
  // admins can promote a live user to a service account in one call
  // (the storage guard requires this pairing).
  isActive: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
}).refine(
  (b) => b.isServiceAccount !== undefined || b.isDemo !== undefined || b.isFixture !== undefined || b.isQuarantined !== undefined || b.isActive !== undefined,
  { message: "At least one classification flag is required" },
);

const requiredReasonBody = z.object({
  reason: z.string().trim().min(1, "reason is required").max(500),
});
const optionalReasonBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

export function registerAdminUserLifecycleRoutes(app: Express) {
  // ────────────────────────────────────────────────────────────────────
  // POST /api/admin/users/:id/classify
  // ────────────────────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/classify", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const parsed = classifyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const id = pStr(req.params.id);
      const updated = await storage.classifyUser(id, viewer.organizationId, viewer.id, parsed.data);
      console.log(`[user-lifecycle] classify id=${id} actor=${viewer.id} reason=${parsed.data.reason ?? ""}`);
      const { password: _pw, ...safe } = updated as any;
      res.json(safe);
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/admin/users/:id/deactivate
  // ────────────────────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/deactivate", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const parsed = requiredReasonBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "reason is required" });

      const id = pStr(req.params.id);
      if (id === viewer.id) return res.status(400).json({ error: "Cannot deactivate yourself" });

      const result = await storage.deactivateUser(id, viewer.organizationId, viewer.id, parsed.data.reason);
      console.log(`[user-lifecycle] deactivate id=${id} actor=${viewer.id} changed=${result.changed} reason=${parsed.data.reason}`);
      const { password: _pw, ...safe } = result.user as any;
      res.json({ ...safe, _changed: result.changed });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/admin/users/:id/reactivate
  // ────────────────────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/reactivate", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const parsed = optionalReasonBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

      const id = pStr(req.params.id);
      const result = await storage.reactivateUser(id, viewer.organizationId, viewer.id, parsed.data.reason);
      console.log(`[user-lifecycle] reactivate id=${id} actor=${viewer.id} changed=${result.changed} reason=${parsed.data.reason ?? ""}`);
      const { password: _pw, ...safe } = result.user as any;
      res.json({ ...safe, _changed: result.changed });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/admin/users/:id/soft-delete?force=true
  // ────────────────────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/soft-delete", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const parsed = requiredReasonBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "reason is required" });

      const id = pStr(req.params.id);
      const force = qStr(req.query.force).toLowerCase() === "true";

      const updated = await storage.softDeleteUser(id, viewer.organizationId, viewer.id, parsed.data.reason, { force });
      console.log(`[user-lifecycle] soft_delete id=${id} actor=${viewer.id} force=${force} reason=${parsed.data.reason}`);
      const { password: _pw, ...safe } = updated as any;
      res.json(safe);
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/admin/users/:id/restore
  // ────────────────────────────────────────────────────────────────────
  app.post("/api/admin/users/:id/restore", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const parsed = optionalReasonBody.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

      const id = pStr(req.params.id);
      const result = await storage.restoreUser(id, viewer.organizationId, viewer.id, parsed.data.reason);
      console.log(`[user-lifecycle] restore id=${id} actor=${viewer.id} changed=${result.changed} reason=${parsed.data.reason ?? ""}`);
      const { password: _pw, ...safe } = result.user as any;
      // Per the design rule, restored users land in the INACTIVE state.
      // Surface that explicitly so the future admin UI doesn't have to
      // re-derive it.
      res.json({ ...safe, _changed: result.changed, _restoredToInactive: true });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/admin/users/:id/lifecycle-events
  // ────────────────────────────────────────────────────────────────────
  app.get("/api/admin/users/:id/lifecycle-events", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const id = pStr(req.params.id);
      const limitStr = qStr(req.query.limit);
      const limit = limitStr ? Math.max(1, Math.min(500, parseInt(limitStr, 10) || 100)) : 100;
      const events = await storage.listUserLifecycleEvents(id, viewer.organizationId, limit);
      res.json({ events });
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/admin/users/:id/impact
  // ────────────────────────────────────────────────────────────────────
  app.get("/api/admin/users/:id/impact", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(viewer)) return res.status(403).json({ error: "Admin only" });

      const id = pStr(req.params.id);
      const impact = await storage.getUserLifecycleImpact(id, viewer.organizationId);
      res.json(impact);
    } catch (err) {
      sendLifecycleError(res, err);
    }
  });
}
