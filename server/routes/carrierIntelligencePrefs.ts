/**
 * Carrier Intelligence UI prefs (Task #370).
 *
 * Stores per-user saved views (filters, sort, columns) and per-page
 * thresholds (margin/on-time/confidence colour cutoffs) for the Carrier
 * Intelligence surfaces, plus an org-level default that admins can edit.
 *
 * Routes:
 *   GET  /api/carrier-intelligence/prefs          -> { user, defaults }
 *   PUT  /api/carrier-intelligence/prefs          -> per-user prefs (upsert)
 *   GET  /api/admin/carrier-intelligence/ui-defaults
 *   PUT  /api/admin/carrier-intelligence/ui-defaults  (admin/director)
 *
 * Persistence: serialized JSON in `app_settings` keyed by user/org. Keeping
 * this orthogonal to scoring config so admins can tune defaults without
 * touching the blend math.
 */
import type { Express, Request, Response } from "express";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";

const USER_KEY = (orgId: string, userId: string) => `carrier_intel:user_prefs:${orgId}:${userId}`;
const ORG_DEFAULTS_KEY = (orgId: string) => `carrier_intel:org_defaults:${orgId}`;

const ADMIN_ROLES = new Set(["admin", "director"]);

const DEFAULT_PREFS = {
  scorecard: {
    moveStatus: ["realized", "active"] as string[],
    minLoads: 1,
    tier: "all",
    equipment: "ALL",
    sort: "performanceScore_desc",
    savedViews: [] as Array<{ id: string; name: string; payload: Record<string, unknown> }>,
  },
  availableLoads: {
    equipment: "ALL",
    accountManager: "all",
    urgency: "all",
    sort: "pickup_asc",
    savedViews: [] as Array<{ id: string; name: string; payload: Record<string, unknown> }>,
  },
  lanePricing: {
    recent: [] as Array<{ origin: string; destination: string; equipmentType?: string; customer?: string; ts: number }>,
    savedViews: [] as Array<{ id: string; name: string; payload: Record<string, unknown> }>,
  },
  thresholds: {
    marginGreenPct: 12,
    marginYellowPct: 6,
    onTimeGreenPct: 95,
    onTimeYellowPct: 85,
    urgencyRedHours: 24,
    urgencyYellowHours: 72,
  },
};

type Prefs = typeof DEFAULT_PREFS;

function mergePrefs(base: Prefs, patch: unknown): Prefs {
  if (!patch || typeof patch !== "object") return base;
  const p = patch as Record<string, unknown>;
  const out: Prefs = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(out) as Array<keyof Prefs>) {
    const v = p[k];
    if (v && typeof v === "object") {
      (out as any)[k] = { ...(out as any)[k], ...(v as object) };
    }
  }
  return out;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await storage.getSetting(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function registerCarrierIntelligencePrefsRoutes(app: Express) {
  app.get("/api/carrier-intelligence/prefs", requireAuth, async (req: Request, res: Response) => {
    const u = await getCurrentUser(req);
    if (!u?.organizationId) return res.status(401).json({ error: "Unauthorized" });
    const [defaults, userPrefs] = await Promise.all([
      readJson(ORG_DEFAULTS_KEY(u.organizationId), DEFAULT_PREFS),
      readJson(USER_KEY(u.organizationId, u.id), {} as Partial<Prefs>),
    ]);
    return res.json({ defaults, user: mergePrefs(defaults, userPrefs) });
  });

  app.put("/api/carrier-intelligence/prefs", requireAuth, async (req: Request, res: Response) => {
    const u = await getCurrentUser(req);
    if (!u?.organizationId) return res.status(401).json({ error: "Unauthorized" });
    const defaults = await readJson(ORG_DEFAULTS_KEY(u.organizationId), DEFAULT_PREFS);
    const next = mergePrefs(defaults, req.body ?? {});
    await storage.setSetting(USER_KEY(u.organizationId, u.id), JSON.stringify(next));
    return res.json({ ok: true, user: next });
  });

  app.get("/api/admin/carrier-intelligence/ui-defaults", requireAuth, async (req: Request, res: Response) => {
    const u = await getCurrentUser(req);
    if (!u?.organizationId) return res.status(401).json({ error: "Unauthorized" });
    const defaults = await readJson(ORG_DEFAULTS_KEY(u.organizationId), DEFAULT_PREFS);
    return res.json({ defaults });
  });

  app.put("/api/admin/carrier-intelligence/ui-defaults", requireAuth, async (req: Request, res: Response) => {
    const u = await getCurrentUser(req);
    if (!u?.organizationId) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.has(u.role ?? "")) return res.status(403).json({ error: "Forbidden" });
    const next = mergePrefs(DEFAULT_PREFS, req.body ?? {});
    await storage.setSetting(ORG_DEFAULTS_KEY(u.organizationId), JSON.stringify(next));
    return res.json({ ok: true, defaults: next });
  });
}

export const CARRIER_INTEL_DEFAULT_PREFS = DEFAULT_PREFS;
