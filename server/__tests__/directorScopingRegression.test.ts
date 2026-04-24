/**
 * Director Scoping — Cross-team data isolation regression (Task #528)
 *
 * Seeds two Director sub-trees inside the same organization and asserts
 * that each Director can only see their own team's data through the
 * canonical scoping helpers (getVisibleRepUserIds / canSeeRepUser) AND
 * through the actual HTTP routes that gate sensitive per-rep payloads.
 *
 * The full registerRoutes(app) is mounted so we exercise the production
 * handlers, not local copies.
 *
 * Coverage:
 *   - Helper-level: getVisibleRepUserIds + canSeeRepUser for both directors
 *     vs. each other's tree, themselves, their reps, and the admin bypass.
 *
 *   - Route ID-guessing 403s on the named endpoints in Task #528:
 *       * /api/report/rep/:userId
 *       * /api/agent/analytics/actions/by-user/:userId
 *       * /api/webex/usage-report/rep-calls   (the canonical route — the task
 *         description's "/api/webex/rep-calls" abbreviates this; there is no
 *         separate `/api/webex/rep-calls` endpoint in the codebase)
 *       * /api/1on1/session  (+ /api/1on1/archived)
 *
 *   - Data-scoping at the HTTP layer:
 *       * /api/internal/conversations — Director default-scope to own tree
 *         and `?team=<other_director>` returns 403 (Task #525)
 *       * /api/touchpoints/today      — Director sees only own-tree touchpoints
 *       * /api/pto-passoffs           — Director sees only own-tree passoffs
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { db, storage } from "../storage";
import {
  organizations,
  users,
  companies,
  touchpoints,
  emailConversationThreads,
  ptoPassoffs,
  oneOnOneSessions,
} from "@shared/schema";
import { inArray } from "drizzle-orm";
import { createServer } from "http";

// ── Mocks ──────────────────────────────────────────────────────────────
//
// requireAuth becomes a passthrough; getCurrentUser returns a settable
// CURRENT_USER value. canSeeRepUser / getVisibleRepUserIds are forwarded
// from the real module so the tests exercise the actual scoping logic.
let CURRENT_USER: any = null;

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      // Some routes (notably /api/intel) read `req.session.organizationId`
      // directly. Attach a session derived from the current mock user so
      // the auth code path under test isn't short-circuited by undefined.
      if (CURRENT_USER) {
        req.session = req.session ?? {};
        req.session.organizationId = CURRENT_USER.organizationId;
        req.session.userId = CURRENT_USER.id;
      }
      next();
    },
    getCurrentUser: vi.fn(async () => CURRENT_USER),
  };
});

// Mount the full route surface — we exercise the actual /api/report/rep,
// /api/pto-passoffs, /api/touchpoints/today, and /api/internal/conversations
// handlers as defined in production, not local copies.
const { registerRoutes } = await import("../routes");
const auth = await import("../auth");

// ── Fixture state ──────────────────────────────────────────────────────
const RUN_TAG = `dir-scoping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let admin: any, d1: any, d2: any, r1a: any, r1b: any, r2a: any, r2b: any;

const created = {
  userIds: [] as string[],
  orgIds: [] as string[],
  threadIds: [] as string[],
  ptoIds: [] as string[],
  companyIds: [] as string[],
  touchpointIds: [] as string[],
};

let company1: any, company2: any;
let tp1: any, tp2: any;
const TODAY = new Date().toISOString().slice(0, 10);

let server: import("http").Server | null = null;
let baseUrl = "";

const setUser = (u: any) => { CURRENT_USER = u; };

beforeAll(async () => {
  const [org] = await db.insert(organizations).values({
    name: `${RUN_TAG}-org`,
    slug: `${RUN_TAG}-org`,
  }).returning();
  orgId = org.id;
  created.orgIds.push(org.id);

  const mkUser = async (suffix: string, role: string, managerId: string | null) => {
    const [u] = await db.insert(users).values({
      organizationId: orgId,
      username: `${RUN_TAG}-${suffix}@test.local`,
      name: `Test ${suffix}`,
      role,
      managerId,
    }).returning();
    created.userIds.push(u.id);
    return u;
  };

  admin = await mkUser("admin", "admin", null);
  d1 = await mkUser("d1", "director", null);
  d2 = await mkUser("d2", "director", null);
  r1a = await mkUser("r1a", "account_manager", d1.id);
  r1b = await mkUser("r1b", "account_manager", d1.id);
  r2a = await mkUser("r2a", "account_manager", d2.id);
  r2b = await mkUser("r2b", "account_manager", d2.id);

  // Seed one email conversation thread per tree so we can verify scoping.
  const [t1] = await db.insert(emailConversationThreads).values({
    orgId,
    threadId: `${RUN_TAG}-thread-r1a`,
    ownerUserId: r1a.id,
    waitingState: "waiting_on_them",
    responsePriority: "normal",
  }).returning();
  const [t2] = await db.insert(emailConversationThreads).values({
    orgId,
    threadId: `${RUN_TAG}-thread-r2a`,
    ownerUserId: r2a.id,
    waitingState: "waiting_on_them",
    responsePriority: "normal",
  }).returning();
  created.threadIds.push(t1.id, t2.id);

  // Seed one PTO passoff per tree.
  const [p1] = await db.insert(ptoPassoffs).values({
    createdById: r1a.id,
    startDate: "2026-05-01",
    endDate: "2026-05-05",
    status: "draft",
    createdAt: new Date().toISOString(),
  }).returning();
  const [p2] = await db.insert(ptoPassoffs).values({
    createdById: r2a.id,
    startDate: "2026-05-01",
    endDate: "2026-05-05",
    status: "draft",
    createdAt: new Date().toISOString(),
  }).returning();
  created.ptoIds.push(p1.id, p2.id);

  // Seed one company + one touchpoint dated TODAY per tree so the
  // /api/touchpoints/today endpoint has cross-tree data to filter.
  const [c1] = await db.insert(companies).values({
    organizationId: orgId,
    name: `${RUN_TAG}-company-1`,
    salesPersonId: r1a.id,
  }).returning();
  const [c2] = await db.insert(companies).values({
    organizationId: orgId,
    name: `${RUN_TAG}-company-2`,
    salesPersonId: r2a.id,
  }).returning();
  company1 = c1; company2 = c2;
  created.companyIds.push(c1.id, c2.id);

  const [tpA] = await db.insert(touchpoints).values({
    companyId: c1.id,
    type: "call",
    date: TODAY,
    notes: `${RUN_TAG} R1A note`,
    loggedById: r1a.id,
    createdAt: new Date().toISOString(),
  }).returning();
  const [tpB] = await db.insert(touchpoints).values({
    companyId: c2.id,
    type: "call",
    date: TODAY,
    notes: `${RUN_TAG} R2A note`,
    loggedById: r2a.id,
    createdAt: new Date().toISOString(),
  }).returning();
  tp1 = tpA; tp2 = tpB;
  created.touchpointIds.push(tpA.id, tpB.id);

  // Mount the FULL production route surface so we exercise real handlers
  // for /api/report/rep, /api/pto-passoffs, /api/touchpoints/today, etc.
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const httpSrv = createServer(app);
  await registerRoutes(httpSrv, app);

  await new Promise<void>((resolve) => {
    const s = app.listen(0, () => {
      const addr = s.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      server = s;
      resolve();
    });
  });
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));

  const safe = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { console.error(`[director-scoping cleanup] ${label}:`, e); }
  };

  // Child-table cleanup first (most cascade on user/company delete, but
  // explicit is safer if someone changes the FK rules later).
  if (created.touchpointIds.length) {
    await safe("touchpoints", () =>
      db.delete(touchpoints).where(inArray(touchpoints.id, created.touchpointIds)),
    );
  }
  if (created.threadIds.length) {
    await safe("threads", () =>
      db.delete(emailConversationThreads).where(inArray(emailConversationThreads.id, created.threadIds)),
    );
  }
  if (created.ptoIds.length) {
    await safe("pto", () =>
      db.delete(ptoPassoffs).where(inArray(ptoPassoffs.id, created.ptoIds)),
    );
  }
  if (created.companyIds.length) {
    await safe("companies", () =>
      db.delete(companies).where(inArray(companies.id, created.companyIds)),
    );
  }
  if (created.userIds.length) {
    // Any sessions accidentally created by route hits get cascaded by FK.
    await safe("sessions", () =>
      db.delete(oneOnOneSessions).where(inArray(oneOnOneSessions.namId, created.userIds)),
    );
    await safe("users", () =>
      db.delete(users).where(inArray(users.id, created.userIds)),
    );
  }
  if (created.orgIds.length) {
    await safe("orgs", () =>
      db.delete(organizations).where(inArray(organizations.id, created.orgIds)),
    );
  }
}, 30_000);

// ── Helper-level scoping (covers touchpoints, intel, agent analytics,
//    rep reports, PTO — every route funnels through these helpers). ─────
describe("getVisibleRepUserIds / canSeeRepUser — Director sub-tree scoping", () => {
  it("D1 sees only their own reporting tree (incl. self)", async () => {
    const visible = await auth.getVisibleRepUserIds(d1);
    expect(visible).not.toBeNull();
    expect(visible!.sort()).toEqual([d1.id, r1a.id, r1b.id].sort());
  });

  it("D2 sees only their own reporting tree (incl. self)", async () => {
    const visible = await auth.getVisibleRepUserIds(d2);
    expect(visible).not.toBeNull();
    expect(visible!.sort()).toEqual([d2.id, r2a.id, r2b.id].sort());
  });

  it("Admin gets null (org-wide visibility)", async () => {
    const visible = await auth.getVisibleRepUserIds(admin);
    expect(visible).toBeNull();
  });

  it("D1 cannot see R2A or R2B (other Director's reps)", async () => {
    expect(await auth.canSeeRepUser(d1, r2a.id)).toBe(false);
    expect(await auth.canSeeRepUser(d1, r2b.id)).toBe(false);
  });

  it("D1 cannot see D2 (the other Director themselves)", async () => {
    expect(await auth.canSeeRepUser(d1, d2.id)).toBe(false);
  });

  it("D1 can see their own reps and themselves", async () => {
    expect(await auth.canSeeRepUser(d1, r1a.id)).toBe(true);
    expect(await auth.canSeeRepUser(d1, r1b.id)).toBe(true);
    expect(await auth.canSeeRepUser(d1, d1.id)).toBe(true);
  });

  it("Admin can see anyone in the org (incl. both trees)", async () => {
    expect(await auth.canSeeRepUser(admin, r1a.id)).toBe(true);
    expect(await auth.canSeeRepUser(admin, r2a.id)).toBe(true);
  });
});

// ── Route-level ID-guessing 403s ───────────────────────────────────────
describe("Route 403 — /api/report/rep/:userId", () => {
  it("D1 → R2A returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/report/rep/${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("D1 → R1A allowed (200, in-tree)", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/report/rep/${r1a.id}`);
    expect(res.status).toBe(200);
  });

  it("D2 → R1A returns 403 (mirror)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/report/rep/${r1a.id}`);
    expect(res.status).toBe(403);
  });

  it("Admin → R2A allowed (200, org-wide)", async () => {
    setUser(admin);
    const res = await fetch(`${baseUrl}/api/report/rep/${r2a.id}`);
    expect(res.status).toBe(200);
  });
});

describe("Route 403 — /api/agent/analytics/actions/by-user/:userId", () => {
  it("D1 → R2A returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("D1 → R1A returns 200 (in-tree, empty array)", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${r1a.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("D2 → R1B returns 403 (other tree)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${r1b.id}`);
    expect(res.status).toBe(403);
  });
});

describe("Route 403 — /api/webex/usage-report/rep-calls", () => {
  it("D1 → R2A returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${r2a.id}&range=7d`);
    expect(res.status).toBe(403);
  });

  it("D1 → R1A returns 200 (in-tree)", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${r1a.id}&range=7d`);
    expect(res.status).toBe(200);
  });

  it("D2 → R1A returns 403 (mirror)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${r1a.id}&range=7d`);
    expect(res.status).toBe(403);
  });
});

describe("Route 403 — coaching 1:1 endpoints", () => {
  it("D1 → managerId=D2&repId=R2A on /api/1on1/session returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/1on1/session?managerId=${d2.id}&repId=${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("D1 → managerId=D2&repId=R2A on /api/1on1/archived returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/1on1/archived?managerId=${d2.id}&repId=${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("D2 → managerId=D1&repId=R1A on /api/1on1/archived returns 403 (mirror)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/1on1/archived?managerId=${d1.id}&repId=${r1a.id}`);
    expect(res.status).toBe(403);
  });
});

// ── Intel scoping (resolveFilterUserIdForIntel → FORBIDDEN sentinel) ───
describe("Intel route — Director scoping", () => {
  it("/api/intel?userId=R2A as D1 returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/intel?userId=${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("/api/intel/shell?userId=R2A as D1 returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/intel/shell?userId=${r2a.id}`);
    expect(res.status).toBe(403);
  });

  it("/api/intel?userId=R1B as D2 returns 403 (mirror)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/intel?userId=${r1b.id}`);
    expect(res.status).toBe(403);
  });
});

// ── Conversations scoping (data + ?team= 403) ──────────────────────────
describe("Conversations route — Director scoping", () => {
  it("?team=<other Director> returns 403", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/internal/conversations?team=${d2.id}`);
    expect(res.status).toBe(403);
  });

  it("D1 sees only their team's threads (no team param)", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(r1a.id);
    expect(ownerIds).not.toContain(r2a.id);
  });

  it("D2 sees only their team's threads (no team param)", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(r2a.id);
    expect(ownerIds).not.toContain(r1a.id);
  });

  it("Admin sees both teams' threads (org-wide)", async () => {
    setUser(admin);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(r1a.id);
    expect(ownerIds).toContain(r2a.id);
  });
});

// ── PTO passoff list — exercises the real /api/pto-passoffs handler. ───
describe("/api/pto-passoffs — Director scoping", () => {
  it("D1 only sees PTO passoffs whose creator/coverer is in their tree", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/pto-passoffs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body as any[]).map(p => p.id);
    expect(ids).toContain(created.ptoIds[0]);     // R1A's passoff
    expect(ids).not.toContain(created.ptoIds[1]); // R2A's (other tree)
  });

  it("D2 only sees PTO passoffs whose creator/coverer is in their tree", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/pto-passoffs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body as any[]).map(p => p.id);
    expect(ids).not.toContain(created.ptoIds[0]);
    expect(ids).toContain(created.ptoIds[1]);
  });

  it("Admin sees both teams' passoffs", async () => {
    setUser(admin);
    const res = await fetch(`${baseUrl}/api/pto-passoffs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body as any[]).map(p => p.id);
    expect(ids).toContain(created.ptoIds[0]);
    expect(ids).toContain(created.ptoIds[1]);
  });
});

// ── Touchpoints — exercises the real /api/touchpoints/today handler. ───
describe("/api/touchpoints/today — Director scoping", () => {
  it("D1 only sees today's touchpoints from their reporting tree", async () => {
    setUser(d1);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).toContain(tp1.id);
    expect(tpIds).not.toContain(tp2.id);
  });

  it("D2 only sees today's touchpoints from their reporting tree", async () => {
    setUser(d2);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).not.toContain(tp1.id);
    expect(tpIds).toContain(tp2.id);
  });

  it("Admin sees both teams' touchpoints", async () => {
    setUser(admin);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).toContain(tp1.id);
    expect(tpIds).toContain(tp2.id);
  });
});
