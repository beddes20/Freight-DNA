/**
 * Phase 2A — DNA team-touchpoint tool wiring tests.
 *
 * Locks in the behaviour of `team_touchpoint_tally` and
 * `reps_missing_touchpoints` so future persona/permission edits cannot
 * silently regress the dodge that motivated this phase.
 *
 * Coverage:
 *   1   team_touchpoint_tally — manager sees per-rep counts (own org only)
 *   2   team_touchpoint_tally — non-manager gets refusal text
 *   3   team_touchpoint_tally — does NOT count touchpoints from another org
 *   4   reps_missing_touchpoints — lists reps with zero touchpoints
 *   5   reps_missing_touchpoints — non-manager gets refusal text
 *   6   reps_missing_touchpoints — does NOT include reps from another org
 *
 * Both tools are gated by role (admin/director/sales_director) OR
 * scope === "everyone". The "everyone" path covers the case where a manager
 * has explicitly toggled the data scope.
 *
 * Runs against the live dev DATABASE_URL with random tagged fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../storage";
import { organizations, users, companies, touchpoints } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { TOOLS, type AgentContext } from "../agent/tools";
import type { User } from "@shared/schema";

const RUN_TAG = `tp-tools-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TODAY = new Date().toISOString().slice(0, 10);

const tally = TOOLS.find((t) => t.name === "team_touchpoint_tally")!;
const missing = TOOLS.find((t) => t.name === "reps_missing_touchpoints")!;

const created = {
  orgIds: [] as string[],
  userIds: [] as string[],
  companyIds: [] as string[],
  touchpointIds: [] as string[],
};

let orgA = "";
let orgB = "";
let mgrA: User;        // admin (org-wide)
let dirA: User;        // director — manages repA1+repA2 only
let dirA2: User;       // director — manages repA3 only (separate subtree)
let namA: User;        // NAM — manages repA4
let lmA: User;         // logistics_manager — manages repA5
let repA1: User;
let repA2: User;
let repA3: User;
let repA4: User;
let repA5: User;
let companyA = "";
let mgrB: User;
let repB1: User;
let companyB = "";

beforeAll(async () => {
  const [oA] = await db.insert(organizations).values({ name: `${RUN_TAG}-orgA`, slug: `${RUN_TAG}-a` }).returning();
  const [oB] = await db.insert(organizations).values({ name: `${RUN_TAG}-orgB`, slug: `${RUN_TAG}-b` }).returning();
  orgA = oA.id; orgB = oB.id;
  created.orgIds.push(oA.id, oB.id);

  // Org A: admin at top, two parallel directors, NAM, logistics manager.
  // Subtree shape (managerId arrows ←):
  //   mgrA (admin)
  //     ├── dirA (director)  ← repA1, repA2
  //     ├── dirA2 (director) ← repA3
  //     ├── namA (NAM)       ← repA4
  //     └── lmA (LM)         ← repA5
  const [m] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-mA`, name: "Mgr A", role: "admin",
  }).returning();
  mgrA = m as User;
  const [d1] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-dA`, name: "Dir A", role: "director", managerId: mgrA.id,
  }).returning();
  const [d2] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-dA2`, name: "Dir A2", role: "director", managerId: mgrA.id,
  }).returning();
  const [n] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-namA`, name: "NAM A", role: "national_account_manager", managerId: mgrA.id,
  }).returning();
  const [lm] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-lmA`, name: "LM A", role: "logistics_manager", managerId: mgrA.id,
  }).returning();
  dirA = d1 as User; dirA2 = d2 as User; namA = n as User; lmA = lm as User;

  const [r1] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r1A`, name: "Rep A1", role: "account_manager", managerId: dirA.id,
  }).returning();
  const [r2] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r2A`, name: "Rep A2", role: "account_manager", managerId: dirA.id,
  }).returning();
  const [r3] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r3A`, name: "Rep A3", role: "account_manager", managerId: dirA2.id,
  }).returning();
  const [r4] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r4A`, name: "Rep A4", role: "account_manager", managerId: namA.id,
  }).returning();
  const [r5] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r5A`, name: "Rep A5", role: "account_manager", managerId: lmA.id,
  }).returning();
  repA1 = r1 as User; repA2 = r2 as User; repA3 = r3 as User; repA4 = r4 as User; repA5 = r5 as User;
  created.userIds.push(m.id, d1.id, d2.id, n.id, lm.id, r1.id, r2.id, r3.id, r4.id, r5.id);

  // Org B: cross-org foil
  const [m2] = await db.insert(users).values({
    organizationId: orgB, username: `${RUN_TAG}-mB`, name: "Mgr B", role: "admin",
  }).returning();
  const [rB] = await db.insert(users).values({
    organizationId: orgB, username: `${RUN_TAG}-r1B`, name: "Rep B1", role: "account_manager", managerId: m2.id,
  }).returning();
  mgrB = m2 as User; repB1 = rB as User;
  created.userIds.push(m2.id, rB.id);

  const [cA] = await db.insert(companies).values({ organizationId: orgA, name: `${RUN_TAG}-coA` }).returning();
  const [cB] = await db.insert(companies).values({ organizationId: orgB, name: `${RUN_TAG}-coB` }).returning();
  companyA = cA.id; companyB = cB.id;
  created.companyIds.push(cA.id, cB.id);

  // Touchpoints today:
  //   repA1: 2  (under dirA)
  //   repA2: 0  (under dirA)
  //   repA3: 1  (under dirA2 — separate subtree)
  //   repA4: 1  (under namA)
  //   repA5: 0  (under lmA)
  //   repB1: 3  (org B foil)
  const tps = await db.insert(touchpoints).values([
    { companyId: companyA, type: "call", date: TODAY, loggedById: repA1.id, createdAt: new Date().toISOString() },
    { companyId: companyA, type: "email", date: TODAY, loggedById: repA1.id, createdAt: new Date().toISOString() },
    { companyId: companyA, type: "call", date: TODAY, loggedById: repA3.id, createdAt: new Date().toISOString() },
    { companyId: companyA, type: "email", date: TODAY, loggedById: repA4.id, createdAt: new Date().toISOString() },
    { companyId: companyB, type: "call", date: TODAY, loggedById: repB1.id, createdAt: new Date().toISOString() },
    { companyId: companyB, type: "call", date: TODAY, loggedById: repB1.id, createdAt: new Date().toISOString() },
    { companyId: companyB, type: "call", date: TODAY, loggedById: repB1.id, createdAt: new Date().toISOString() },
  ]).returning({ id: touchpoints.id });
  created.touchpointIds.push(...tps.map((t) => t.id));
});

afterAll(async () => {
  const safeDelete = async <T,>(label: string, fn: () => Promise<T>) => {
    try { await fn(); } catch (e) { console.error(`[tp-tools cleanup] ${label} failed:`, e); }
  };
  if (created.touchpointIds.length) await safeDelete("touchpoints", () => db.delete(touchpoints).where(inArray(touchpoints.id, created.touchpointIds)));
  if (created.companyIds.length)    await safeDelete("companies",   () => db.delete(companies).where(inArray(companies.id, created.companyIds)));
  if (created.userIds.length)       await safeDelete("users",       () => db.delete(users).where(inArray(users.id, created.userIds)));
  if (created.orgIds.length)        await safeDelete("orgs",        () => db.delete(organizations).where(inArray(organizations.id, created.orgIds)));
});

function ctxFor(rep: User, scope: "my_team" | "everyone" = "my_team"): AgentContext {
  return {
    rep,
    organizationId: rep.organizationId,
    channel: "in_app",
    conversationRef: null,
    scope,
  };
}

describe("team_touchpoint_tally", () => {
  it("[1] admin sees per-rep counts for their entire org", async () => {
    const out = await tally.execute(ctxFor(mgrA, "everyone"), { date_start: TODAY });
    expect(out.kind).toBe("data");
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A1");
    expect(text).toContain("Rep A2");
    expect(text).toContain("Rep A3");
    expect(text).toContain("Rep A4");
    expect(text).toContain("Rep A5");
    // Cross-org foil must not appear
    expect(text).not.toContain("Rep B1");
    expect(text).not.toContain("Mgr B");
  });

  it("[2] non-manager (account_manager + my_team) is refused", async () => {
    const out = await tally.execute(ctxFor(repA1), { date_start: TODAY });
    expect(out.kind).toBe("data");
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    // Should not leak any rep name in the refusal
    expect(text).not.toContain("Rep A1 (");
  });

  it("[3] admin tally total matches only org A's touchpoints (cross-org foil excluded)", async () => {
    const out = await tally.execute(ctxFor(mgrA, "everyone"), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    // Org A: A1=2 + A2=0 + A3=1 + A4=1 + A5=0 = 4 total. Org B's 3 must be excluded.
    expect(text).toMatch(/total 4/);
  });
});

describe("reps_missing_touchpoints", () => {
  it("[4] admin sees Rep A2 + Rep A5 listed as missing today (org-wide)", async () => {
    const out = await missing.execute(ctxFor(mgrA, "everyone"), { date_start: TODAY });
    expect(out.kind).toBe("data");
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A2");
    expect(text).toContain("Rep A5");
    expect(text).not.toContain("Rep A1"); // logged 2 today
    expect(text).not.toContain("Rep A3"); // logged 1 today
    expect(text).not.toContain("Rep A4"); // logged 1 today
    expect(text).not.toContain("Rep B1"); // cross-org
  });

  it("[5] non-manager is refused", async () => {
    const out = await missing.execute(ctxFor(repA1), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    expect(text).not.toContain("Rep A2");
  });

  it("[6] admin in 'everyone' scope still does not leak other-org reps", async () => {
    const out = await missing.execute(ctxFor(mgrA, "everyone"), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).not.toContain("Rep B1");
    expect(text).not.toContain("Mgr B");
  });
});

// ─── Privilege-escalation guard ──────────────────────────────────────────────
// Architect-flagged: a non-manager who managed to get scope="everyone" passed
// to runAgentTurn (e.g. via a misbehaving channel adapter) must STILL be
// refused. The tool gates on role only — scope is treated as a UI filter,
// never as an auth signal.

describe("touchpoint tools — privilege escalation guard", () => {
  it("[7] non-manager with spoofed scope='everyone' is still refused (tally)", async () => {
    const out = await tally.execute(ctxFor(repA1, "everyone"), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    // Must not leak any rep names or counts despite the spoof
    expect(text).not.toContain("Rep A1 (");
    expect(text).not.toContain("Rep A2");
    expect(text).not.toContain("Rep B1");
  });

  it("[8] non-manager with spoofed scope='everyone' is still refused (missing)", async () => {
    const out = await missing.execute(ctxFor(repA1, "everyone"), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    expect(text).not.toContain("Rep A2");
    expect(text).not.toContain("Rep B1");
  });
});

// ─── Subtree restriction (non-admin managers see their pod only) ─────────────
// Confirms the rule: only admin sees the full org. Director, sales_director,
// national_account_manager, and logistics_manager see ONLY their own
// managerId subtree (transitive direct reports, including themselves).

describe("touchpoint tools — non-admin manager subtree scoping", () => {
  it("[9] director only sees their own subtree (Dir A → Rep A1 + A2)", async () => {
    const out = await tally.execute(ctxFor(dirA), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A1");
    expect(text).toContain("Rep A2");
    // Other directors' subtrees must NOT appear
    expect(text).not.toContain("Rep A3");
    expect(text).not.toContain("Rep A4");
    expect(text).not.toContain("Rep A5");
    // Cross-org foil
    expect(text).not.toContain("Rep B1");
  });

  it("[10] parallel director sees only their own subtree (Dir A2 → Rep A3)", async () => {
    const out = await tally.execute(ctxFor(dirA2), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A3");
    expect(text).not.toContain("Rep A1");
    expect(text).not.toContain("Rep A2");
    expect(text).not.toContain("Rep A4");
    expect(text).not.toContain("Rep A5");
  });

  it("[11] NAM is treated as a manager and sees their own subtree (Rep A4)", async () => {
    const out = await tally.execute(ctxFor(namA), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A4");
    expect(text).not.toContain("Rep A1");
    expect(text).not.toContain("Rep A2");
    expect(text).not.toContain("Rep A3");
    expect(text).not.toContain("Rep A5");
  });

  it("[12] logistics_manager is treated as a manager and sees their own subtree (Rep A5)", async () => {
    const out = await missing.execute(ctxFor(lmA), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A5"); // logged 0 today
    expect(text).not.toContain("Rep A1");
    expect(text).not.toContain("Rep A2");
    expect(text).not.toContain("Rep A3");
    expect(text).not.toContain("Rep A4");
  });

  it("[13] director CANNOT escalate via spoofed scope='everyone' to see other directors' reps", async () => {
    const out = await tally.execute(ctxFor(dirA, "everyone"), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    // Even with spoofed scope, dirA only sees their subtree
    expect(text).not.toContain("Rep A3");
    expect(text).not.toContain("Rep A4");
    expect(text).not.toContain("Rep A5");
  });
});
