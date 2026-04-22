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
let mgrA: User;
let repA1: User;
let repA2: User;
let companyA = "";
let mgrB: User;
let repB1: User;
let companyB = "";

beforeAll(async () => {
  const [oA] = await db.insert(organizations).values({ name: `${RUN_TAG}-orgA`, slug: `${RUN_TAG}-a` }).returning();
  const [oB] = await db.insert(organizations).values({ name: `${RUN_TAG}-orgB`, slug: `${RUN_TAG}-b` }).returning();
  orgA = oA.id; orgB = oB.id;
  created.orgIds.push(oA.id, oB.id);

  // Org A: manager + two reps
  const [m] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-mA`, name: "Mgr A", role: "admin",
  }).returning();
  const [r1] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r1A`, name: "Rep A1", role: "account_manager",
  }).returning();
  const [r2] = await db.insert(users).values({
    organizationId: orgA, username: `${RUN_TAG}-r2A`, name: "Rep A2", role: "account_manager",
  }).returning();
  mgrA = m as User; repA1 = r1 as User; repA2 = r2 as User;
  created.userIds.push(m.id, r1.id, r2.id);

  // Org B: manager + one rep (the cross-org foil)
  const [m2] = await db.insert(users).values({
    organizationId: orgB, username: `${RUN_TAG}-mB`, name: "Mgr B", role: "admin",
  }).returning();
  const [r3] = await db.insert(users).values({
    organizationId: orgB, username: `${RUN_TAG}-r1B`, name: "Rep B1", role: "account_manager",
  }).returning();
  mgrB = m2 as User; repB1 = r3 as User;
  created.userIds.push(m2.id, r3.id);

  const [cA] = await db.insert(companies).values({ organizationId: orgA, name: `${RUN_TAG}-coA` }).returning();
  const [cB] = await db.insert(companies).values({ organizationId: orgB, name: `${RUN_TAG}-coB` }).returning();
  companyA = cA.id; companyB = cB.id;
  created.companyIds.push(cA.id, cB.id);

  // Touchpoints: rep A1 logged 2 today, rep A2 logged 0, rep B1 logged 3 today.
  // The cross-org touchpoints from B must NOT show up in A's tally.
  const tps = await db.insert(touchpoints).values([
    { companyId: companyA, type: "call", date: TODAY, loggedById: repA1.id, createdAt: new Date().toISOString() },
    { companyId: companyA, type: "email", date: TODAY, loggedById: repA1.id, createdAt: new Date().toISOString() },
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
  it("[1] manager sees per-rep counts for their org only", async () => {
    const out = await tally.execute(ctxFor(mgrA), { date_start: TODAY });
    expect(out.kind).toBe("data");
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A1");
    expect(text).toContain("— 2");
    expect(text).toContain("Rep A2");
    expect(text).toContain("— 0");
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

  it("[3] org A's tally total matches only org A's touchpoints (3 + 0 ≠ 5)", async () => {
    const out = await tally.execute(ctxFor(mgrA), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    // Org A has rep A1=2 + rep A2=0 = 2 total. Org B's 3 must be excluded.
    expect(text).toMatch(/total 2/);
  });
});

describe("reps_missing_touchpoints", () => {
  it("[4] manager sees Rep A2 listed as missing today", async () => {
    const out = await missing.execute(ctxFor(mgrA), { date_start: TODAY });
    expect(out.kind).toBe("data");
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep A2");
    expect(text).not.toContain("Rep A1"); // logged 2 today
    // Cross-org foil — Rep B1 logged in their own org but must not appear here
    expect(text).not.toContain("Rep B1");
  });

  it("[5] non-manager is refused", async () => {
    const out = await missing.execute(ctxFor(repA1), { date_start: TODAY });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    expect(text).not.toContain("Rep A2");
  });

  it("[6] manager in 'everyone' scope still does not leak other-org reps", async () => {
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
