/**
 * Leadership Scoping — Cross-team data isolation regression (Task #538)
 *
 * The Director scoping regression suite (`directorScopingRegression.test.ts`)
 * only covers the `director` role. The same code paths also serve:
 *
 *   - `national_account_manager` (NAM) — recursive reporting tree
 *   - `sales_director`                 — org-wide oversight
 *   - `account_manager`                — self-only
 *
 * Both NAM and sales_director have been the source of cross-team leak bugs
 * in the past whenever a route forgot to thread a role check through the
 * canonical helpers (`canSeeRepUser` / `getVisibleRepUserIds`).
 *
 * Coverage:
 *   - Helper-level scoping for NAM and sales_director
 *   - NAM cannot ID-guess across NAMs or into a Director's tree on:
 *       * /api/report/rep/:userId
 *       * /api/agent/analytics/actions/by-user/:userId
 *       * /api/webex/usage-report/rep-calls
 *       * /api/1on1/session  (+ /api/1on1/archived)
 *       * /api/intel  (+ /api/intel/shell)
 *       * /api/internal/conversations (+ ?team=)
 *   - Sales Director sees the whole org (no 403s) and never accidentally
 *     hits the Director default-scoping branch on conversations or intel
 *   - account_manager hitting a per-rep endpoint with someone else's
 *     userId always gets 403
 *
 * The full registerRoutes(app) is mounted so we exercise the production
 * handlers, not local copies.
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
  oneOnOneSessions,
} from "@shared/schema";
import { inArray } from "drizzle-orm";
import { createServer } from "http";

// ── Mocks ──────────────────────────────────────────────────────────────
// requireAuth becomes a passthrough; getCurrentUser returns CURRENT_USER.
// canSeeRepUser / getVisibleRepUserIds are forwarded from the real module
// so the tests exercise the actual scoping logic.
let CURRENT_USER: any = null;

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      // /api/intel reads `req.session.organizationId` directly. Mirror the
      // session derivation done by directorScopingRegression so the auth
      // path under test isn't short-circuited by undefined.
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

const { registerRoutes } = await import("../routes");
const auth = await import("../auth");

// ── Fixture state ──────────────────────────────────────────────────────
const RUN_TAG = `lead-scoping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let admin: any, sd: any;
let d1: any, d2: any, r1a: any, r2a: any;
let nam1: any, nam2: any, am1a: any, am1b: any, am2a: any;

const created = {
  userIds: [] as string[],
  orgIds: [] as string[],
  threadIds: [] as string[],
  companyIds: [] as string[],
  touchpointIds: [] as string[],
};

let companyR1A: any, companyR2A: any, companyAM1A: any, companyAM2A: any;
let tpR1A: any, tpR2A: any, tpAM1A: any, tpAM2A: any;
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

  // Org tree:
  //   admin                                  (no manager)
  //   sd  (sales_director)                   (no manager) — root oversight
  //     ├─ d1   (director)                   ── r1a (account_manager)
  //     ├─ d2   (director)                   ── r2a (account_manager)
  //     ├─ nam1 (national_account_manager)   ── am1a, am1b (account_manager)
  //     └─ nam2 (national_account_manager)   ── am2a       (account_manager)
  //
  // sd's recursive reporting tree therefore equals every other user, which
  // is why "Sales Director sees the whole org" without needing the admin
  // null-bypass on getVisibleRepUserIds.
  admin = await mkUser("admin", "admin", null);
  sd    = await mkUser("sd",    "sales_director", null);
  d1    = await mkUser("d1",    "director", sd.id);
  d2    = await mkUser("d2",    "director", sd.id);
  nam1  = await mkUser("nam1",  "national_account_manager", sd.id);
  nam2  = await mkUser("nam2",  "national_account_manager", sd.id);
  r1a   = await mkUser("r1a",   "account_manager", d1.id);
  r2a   = await mkUser("r2a",   "account_manager", d2.id);
  am1a  = await mkUser("am1a",  "account_manager", nam1.id);
  am1b  = await mkUser("am1b",  "account_manager", nam1.id);
  am2a  = await mkUser("am2a",  "account_manager", nam2.id);

  // Seed one email conversation thread per leaf rep so we can verify
  // tree-scoping on /api/internal/conversations.
  const seedThread = async (suffix: string, ownerId: string) => {
    const [t] = await db.insert(emailConversationThreads).values({
      orgId,
      threadId: `${RUN_TAG}-thread-${suffix}`,
      ownerUserId: ownerId,
      waitingState: "waiting_on_them",
      responsePriority: "normal",
    }).returning();
    created.threadIds.push(t.id);
    return t;
  };
  await seedThread("r1a",  r1a.id);
  await seedThread("r2a",  r2a.id);
  await seedThread("am1a", am1a.id);
  await seedThread("am2a", am2a.id);

  // One company + one touchpoint dated TODAY per leaf rep so we have
  // cross-tree data on /api/touchpoints/today to filter on.
  const seedCompanyAndTp = async (suffix: string, repId: string) => {
    const [c] = await db.insert(companies).values({
      organizationId: orgId,
      name: `${RUN_TAG}-company-${suffix}`,
      salesPersonId: repId,
    }).returning();
    created.companyIds.push(c.id);
    const [tp] = await db.insert(touchpoints).values({
      companyId: c.id,
      type: "call",
      date: TODAY,
      notes: `${RUN_TAG} ${suffix} note`,
      loggedById: repId,
      createdAt: new Date().toISOString(),
    }).returning();
    created.touchpointIds.push(tp.id);
    return { company: c, tp };
  };
  ({ company: companyR1A, tp: tpR1A } = await seedCompanyAndTp("r1a", r1a.id));
  ({ company: companyR2A, tp: tpR2A } = await seedCompanyAndTp("r2a", r2a.id));
  ({ company: companyAM1A, tp: tpAM1A } = await seedCompanyAndTp("am1a", am1a.id));
  ({ company: companyAM2A, tp: tpAM2A } = await seedCompanyAndTp("am2a", am2a.id));

  // Mount the FULL production route surface so we exercise real handlers.
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
    try { await fn(); } catch (e) { console.error(`[leadership-scoping cleanup] ${label}:`, e); }
  };

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
  if (created.companyIds.length) {
    await safe("companies", () =>
      db.delete(companies).where(inArray(companies.id, created.companyIds)),
    );
  }
  if (created.userIds.length) {
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

// ── Helper-level scoping ───────────────────────────────────────────────
describe("getVisibleRepUserIds / canSeeRepUser — NAM scoping", () => {
  it("NAM1 sees only their own reporting tree (incl. self)", async () => {
    const visible = await auth.getVisibleRepUserIds(nam1);
    expect(visible).not.toBeNull();
    expect(visible!.sort()).toEqual([nam1.id, am1a.id, am1b.id].sort());
  });

  it("NAM2 sees only their own reporting tree (incl. self)", async () => {
    const visible = await auth.getVisibleRepUserIds(nam2);
    expect(visible).not.toBeNull();
    expect(visible!.sort()).toEqual([nam2.id, am2a.id].sort());
  });

  it("NAM1 cannot see the other NAM's reps", async () => {
    expect(await auth.canSeeRepUser(nam1, am2a.id)).toBe(false);
    expect(await auth.canSeeRepUser(nam1, nam2.id)).toBe(false);
  });

  it("NAM1 cannot see Directors' reps", async () => {
    expect(await auth.canSeeRepUser(nam1, r1a.id)).toBe(false);
    expect(await auth.canSeeRepUser(nam1, r2a.id)).toBe(false);
    expect(await auth.canSeeRepUser(nam1, d1.id)).toBe(false);
  });

  it("NAM1 can see their own reps and themselves", async () => {
    expect(await auth.canSeeRepUser(nam1, am1a.id)).toBe(true);
    expect(await auth.canSeeRepUser(nam1, am1b.id)).toBe(true);
    expect(await auth.canSeeRepUser(nam1, nam1.id)).toBe(true);
  });
});

describe("getVisibleRepUserIds / canSeeRepUser — Sales Director scoping", () => {
  it("Sales Director's tree spans the whole org (incl. directors and NAMs)", async () => {
    const visible = await auth.getVisibleRepUserIds(sd);
    expect(visible).not.toBeNull();
    // Every non-admin user is somewhere under sd in the managerId chain.
    const expected = [sd.id, d1.id, d2.id, nam1.id, nam2.id, r1a.id, r2a.id, am1a.id, am1b.id, am2a.id];
    expect(visible!.sort()).toEqual(expected.sort());
  });

  it("Sales Director can see every rep in the org (no false 403s)", async () => {
    for (const u of [d1, d2, nam1, nam2, r1a, r2a, am1a, am1b, am2a]) {
      expect(await auth.canSeeRepUser(sd, u.id)).toBe(true);
    }
  });
});

describe("getVisibleRepUserIds / canSeeRepUser — account_manager is self-only", () => {
  it("account_manager sees only themselves", async () => {
    const visible = await auth.getVisibleRepUserIds(am1a);
    expect(visible).not.toBeNull();
    expect(visible!).toEqual([am1a.id]);
  });

  it("account_manager cannot see any other rep", async () => {
    for (const u of [am1b, am2a, r1a, r2a, nam1, nam2, d1, sd]) {
      expect(await auth.canSeeRepUser(am1a, u.id)).toBe(false);
    }
  });
});

// ── /api/report/rep/:userId ─────────────────────────────────────────────
describe("Route 403 — /api/report/rep/:userId (NAM, Sales Director, account_manager)", () => {
  it("NAM1 → AM2A (other NAM's rep) returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/report/rep/${am2a.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → R1A (Director's rep) returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/report/rep/${r1a.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → AM1A (in-tree) allowed (200)", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/report/rep/${am1a.id}`);
    expect(res.status).toBe(200);
  });

  it("Sales Director → AM2A allowed (200, org-wide)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/report/rep/${am2a.id}`);
    expect(res.status).toBe(200);
  });

  it("Sales Director → R1A allowed (200, org-wide)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/report/rep/${r1a.id}`);
    expect(res.status).toBe(200);
  });

  it("account_manager → other account_manager returns 403", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/report/rep/${am1b.id}`);
    expect(res.status).toBe(403);
  });

  it("account_manager → self allowed (200)", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/report/rep/${am1a.id}`);
    expect(res.status).toBe(200);
  });
});

// ── /api/agent/analytics/actions/by-user/:userId ────────────────────────
describe("Route 403 — /api/agent/analytics/actions/by-user/:userId (NAM, Sales Director, account_manager)", () => {
  it("NAM1 → AM2A returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${am2a.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → R1A (Director's rep) returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${r1a.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → AM1A (in-tree) returns 200", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${am1a.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("Sales Director → R1A returns 200 (org-wide analytics bypass)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${r1a.id}`);
    expect(res.status).toBe(200);
  });

  it("Sales Director → AM2A returns 200 (org-wide analytics bypass)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${am2a.id}`);
    expect(res.status).toBe(200);
  });

  it("account_manager → other account_manager returns 403", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/agent/analytics/actions/by-user/${am1b.id}`);
    expect(res.status).toBe(403);
  });
});

// ── /api/webex/usage-report/rep-calls ──────────────────────────────────
describe("Route 403 — /api/webex/usage-report/rep-calls (NAM, Sales Director, account_manager)", () => {
  it("NAM1 → AM2A returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${am2a.id}&range=7d`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → R1A (Director's rep) returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${r1a.id}&range=7d`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → AM1A (in-tree) returns 200", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${am1a.id}&range=7d`);
    expect(res.status).toBe(200);
  });

  it("Sales Director → R1A returns 200 (org-wide)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${r1a.id}&range=7d`);
    expect(res.status).toBe(200);
  });

  it("Sales Director → AM2A returns 200 (org-wide)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${am2a.id}&range=7d`);
    expect(res.status).toBe(200);
  });

  it("account_manager is rejected as a non-leadership role (403)", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/webex/usage-report/rep-calls?userId=${am1b.id}&range=7d`);
    expect(res.status).toBe(403);
  });
});

// ── Coaching 1:1 endpoints ──────────────────────────────────────────────
describe("Route 403 — coaching 1:1 endpoints (NAM, Sales Director, account_manager)", () => {
  it("NAM1 → managerId=NAM2&repId=AM2A on /api/1on1/session returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/1on1/session?managerId=${nam2.id}&repId=${am2a.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 → managerId=D1&repId=R1A on /api/1on1/archived returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/1on1/archived?managerId=${d1.id}&repId=${r1a.id}`);
    expect(res.status).toBe(403);
  });

  it("Sales Director → managerId=D1&repId=R1A on /api/1on1/archived returns 200 (org-wide)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/1on1/archived?managerId=${d1.id}&repId=${r1a.id}`);
    expect(res.status).toBe(200);
  });

  it("account_manager → managerId=NAM2&repId=AM2A on /api/1on1/session returns 403", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/1on1/session?managerId=${nam2.id}&repId=${am2a.id}`);
    expect(res.status).toBe(403);
  });
});

// ── Intel scoping ──────────────────────────────────────────────────────
// /api/intel does a one-time SONAR bundle build on the first call of a
// test run that can take ~25s when the upstream rate-limits (HTTP 451)
// and we have to fall back to cached/null snapshots. Subsequent calls
// hit the in-process cache and return in milliseconds. Bump the per-test
// timeout to comfortably cover the cold path on the very first /api/intel
// call so the suite doesn't go red on a fresh CI worker.
describe("Intel route — NAM and Sales Director scoping", () => {
  it("Sales Director — /api/intel?userId=R1A returns 200 (org-wide, never FORBIDDEN)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/intel?userId=${r1a.id}`);
    expect(res.status).toBe(200);
  }, 60_000);

  it("Sales Director — /api/intel?userId=AM2A returns 200 (org-wide, never FORBIDDEN)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/intel?userId=${am2a.id}`);
    expect(res.status).toBe(200);
  });

  it("Sales Director — /api/intel/shell?userId=AM2A returns 200 (org-wide section endpoint)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/intel/shell?userId=${am2a.id}`);
    expect(res.status).toBe(200);
  });

  it("Sales Director — /api/intel without ?userId returns 200 (no Director-style self-default)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/intel`);
    expect(res.status).toBe(200);
  });

  // For NAM and account_manager, the resolveFilterUserIdForIntel helper
  // falls into the "All other roles: self-scoped" branch — any user-supplied
  // ?userId is silently ignored rather than 403'd. The leak prevention is
  // therefore enforced by the response (which contains only the caller's
  // own slice), not by an HTTP status. Asserting parity between "with
  // bogus userId" and "without userId" guarantees the silent-self-scope
  // hasn't been accidentally re-wired into a leak.
  it("NAM — /api/intel?userId=<other tree> returns the same payload as no userId (silent self-scope)", async () => {
    setUser(nam1);
    const r1 = await fetch(`${baseUrl}/api/intel`);
    const r2 = await fetch(`${baseUrl}/api/intel?userId=${am2a.id}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    // Same caller + same effective filterUserId => identical payload.
    expect(JSON.stringify(b2)).toBe(JSON.stringify(b1));
  });

  it("account_manager — /api/intel?userId=<someone else> returns the same payload as no userId (silent self-scope, no leak)", async () => {
    setUser(am1a);
    const r1 = await fetch(`${baseUrl}/api/intel`);
    const r2 = await fetch(`${baseUrl}/api/intel?userId=${am2a.id}`);
    const r3 = await fetch(`${baseUrl}/api/intel?userId=${r1a.id}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    const b3 = await r3.json();
    // Caller is silently scoped to their own userId — passing any other
    // ?userId must not change the payload (would otherwise mean the data
    // for someone else's slice has leaked through).
    expect(JSON.stringify(b2)).toBe(JSON.stringify(b1));
    expect(JSON.stringify(b3)).toBe(JSON.stringify(b1));
  });
});

// ── Conversations scoping ──────────────────────────────────────────────
describe("Conversations route — NAM, Sales Director, account_manager scoping", () => {
  it("NAM1 ?team=NAM2 returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/internal/conversations?team=${nam2.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 ?team=D1 returns 403", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/internal/conversations?team=${d1.id}`);
    expect(res.status).toBe(403);
  });

  it("NAM1 default scope contains only their tree's threads", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(am1a.id);
    expect(ownerIds).not.toContain(am2a.id);
    expect(ownerIds).not.toContain(r1a.id);
    expect(ownerIds).not.toContain(r2a.id);
  });

  it("Sales Director default scope is org-wide (no Director self-tree default)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(am1a.id);
    expect(ownerIds).toContain(am2a.id);
    expect(ownerIds).toContain(r1a.id);
    expect(ownerIds).toContain(r2a.id);
  });

  it("Sales Director ?team=D1 returns 200 (org-wide manager pivot is allowed)", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/internal/conversations?team=${d1.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    expect(ownerIds).toContain(r1a.id);
    expect(ownerIds).not.toContain(r2a.id);
    expect(ownerIds).not.toContain(am2a.id);
  });

  it("account_manager default scope only contains their own threads", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/internal/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ownerIds = (body.threads as any[]).map(t => t.ownerUserId);
    // Only their own thread is in the visible set; sibling AM's thread
    // (am1b has no thread) and other-tree threads are filtered out.
    expect(ownerIds).not.toContain(am2a.id);
    expect(ownerIds).not.toContain(r1a.id);
    expect(ownerIds).not.toContain(r2a.id);
  });

  it("account_manager ?team=NAM1 returns 403 (cannot pivot to manager view)", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/internal/conversations?team=${nam1.id}`);
    expect(res.status).toBe(403);
  });
});

// ── /api/touchpoints/today ──────────────────────────────────────────────
describe("/api/touchpoints/today — NAM and Sales Director scoping", () => {
  it("NAM1 only sees today's touchpoints from their reporting tree", async () => {
    setUser(nam1);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).toContain(tpAM1A.id);
    expect(tpIds).not.toContain(tpAM2A.id);
    expect(tpIds).not.toContain(tpR1A.id);
    expect(tpIds).not.toContain(tpR2A.id);
  });

  it("Sales Director sees today's touchpoints across the whole org", async () => {
    setUser(sd);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).toContain(tpAM1A.id);
    expect(tpIds).toContain(tpAM2A.id);
    expect(tpIds).toContain(tpR1A.id);
    expect(tpIds).toContain(tpR2A.id);
  });

  it("account_manager only sees their own touchpoints", async () => {
    setUser(am1a);
    const res = await fetch(`${baseUrl}/api/touchpoints/today?date=${TODAY}`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    const tpIds = list.map(t => t.id);
    expect(tpIds).toContain(tpAM1A.id);
    expect(tpIds).not.toContain(tpAM2A.id);
    expect(tpIds).not.toContain(tpR1A.id);
    expect(tpIds).not.toContain(tpR2A.id);
  });
});
