/**
 * Task #773 — Priorities feed cross-account leak regression
 *
 * Reproduces the Mohawk/Ezra Stafford "Missed Call" leak on Jared Reynolds'
 * dashboard and asserts the fix:
 *
 *   - A rep cannot receive an NBA card whose `companyId` falls outside
 *     `getVisibleCompanyIds(rep)`, even when `nbaCards.userId === rep.id`.
 *   - Org-level cards (no `companyId`) are still returned.
 *   - The `webex_missed_call` rule type is exercised explicitly because
 *     that's the path that originally minted leaking cards (the call rang
 *     on the rep's extension, but the company belonged to another rep).
 *   - Admins still see every card via the org-wide portfolio fetch.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { db, storage } from "../storage";
import {
  organizations,
  users,
  companies,
  contacts,
  nbaCards,
  missedInboundCalls,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import { createServer } from "http";

let CURRENT_USER: any = null;

// Routes used by this test go through requireUser, which internally
// calls the real requireAuth — and requireAuth calls Clerk's getAuth(req)
// unconditionally. Stub @clerk/express so getAuth returns "no Clerk
// session" instead of throwing about clerkMiddleware not being mounted.
// requireAuth then falls through to its session-based path.
vi.mock("@clerk/express", async () => {
  const actual = await vi.importActual<typeof import("@clerk/express")>("@clerk/express");
  return {
    ...actual,
    getAuth: () => ({ userId: null, sessionId: null, orgId: null }),
    clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
  };
});

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
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

const RUN_TAG = `nba-vis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let admin: any, jared: any, owner: any;
let jaredCompany: any, ownerCompany: any;

// Second org used to verify the missed-call callback re-routing helper.
// Has a director (portfolio viewer) but NO admin so we exercise the
// "no admin in org" fallback branch as well as the standard owner re-route.
let org2Id = "";
let dir2: any, rep2: any, outsider2: any;
let rep2Company: any;       // assigned to rep2 → re-routes to owner
let unownedSharedCompany: any; // no owner; dir2 is a sharedRep → director fallback
let missedCallOwnedId = "";
let missedCallUnownedId = "";

const created = {
  userIds: [] as string[],
  orgIds: [] as string[],
  companyIds: [] as string[],
  nbaCardIds: [] as string[],
  missedCallIds: [] as string[],
  contactIds: [] as string[],
};

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

  const mkUser = async (suffix: string, role: string) => {
    const [u] = await db.insert(users).values({
      organizationId: orgId,
      username: `${RUN_TAG}-${suffix}@test.local`,
      name: `Test ${suffix}`,
      role,
    }).returning();
    created.userIds.push(u.id);
    return u;
  };

  admin = await mkUser("admin", "admin");
  // Jared is a NAM whose visibility is gated to the team he leads
  // (which, here, is just himself — he has no reports).
  jared = await mkUser("jared", "national_account_manager");
  owner = await mkUser("owner", "account_manager");

  // Two companies: one assigned to Jared (in his book), one assigned to
  // someone else (the leak case — Mohawk in the original bug report).
  const [cJ] = await db.insert(companies).values({
    organizationId: orgId,
    name: `${RUN_TAG}-jared-co`,
    assignedTo: jared.id,
  }).returning();
  const [cO] = await db.insert(companies).values({
    organizationId: orgId,
    name: `${RUN_TAG}-owner-co`,
    assignedTo: owner.id,
  }).returning();
  jaredCompany = cJ;
  ownerCompany = cO;
  created.companyIds.push(cJ.id, cO.id);

  // Three cards minted on Jared (userId = jared.id):
  //   1. Card on his own company    → must surface for Jared
  //   2. Card on the other rep's company → MUST NOT surface for Jared
  //      (this is the Mohawk/Ezra Stafford leak)
  //   3. Org-level card with no companyId → must still surface
  // We mint #2 as a `webex_missed_call` because that's the rule type
  // the original bug report singled out.
  const baseCard = {
    orgId,
    outcomeType: "protect",
    confidence: "high",
    signalCount: 1,
    signalSummary: [`${RUN_TAG} signal`],
    whyThisNow: `${RUN_TAG} why`,
    suggestedAction: `${RUN_TAG} action`,
    expectedOutcome: `${RUN_TAG} outcome`,
    urgencyScore: 90,
    status: "visible" as const,
    createdAt: new Date().toISOString(),
  };
  const cardOwn = await storage.createNbaCard({
    ...baseCard,
    userId: jared.id,
    companyId: jaredCompany.id,
    companyName: jaredCompany.name,
    ruleType: "overdue_next_action",
  });
  const cardLeak = await storage.createNbaCard({
    ...baseCard,
    userId: jared.id,
    companyId: ownerCompany.id,
    companyName: ownerCompany.name,
    ruleType: "webex_missed_call",
  });
  const cardOrgLevel = await storage.createNbaCard({
    ...baseCard,
    userId: jared.id,
    companyId: null,
    companyName: null,
    ruleType: "weekly_focus",
  });
  created.nbaCardIds.push(cardOwn.id, cardLeak.id, cardOrgLevel.id);

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  // Inject CURRENT_USER as the session user so the real requireAuth's
  // session-based path resolves the user without needing Clerk.
  app.use((req: any, _res, next) => {
    if (CURRENT_USER) {
      req.session = req.session ?? {};
      req.session.userId = CURRENT_USER.id;
      req.session.organizationId = CURRENT_USER.organizationId;
    }
    next();
  });
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

  // ── Second org: no admin, but a director exists. Used to verify the
  // missed-call callback re-routing helper (a) re-routes to the actual
  // company owner when one exists, and (b) falls back to a director
  // portfolio viewer when no admin exists and the company has no owner —
  // never silently dropping the card on a rep who can't see it.
  const [org2] = await db.insert(organizations).values({
    name: `${RUN_TAG}-org2`,
    slug: `${RUN_TAG}-org2`,
  }).returning();
  org2Id = org2.id;
  created.orgIds.push(org2.id);

  const mkUser2 = async (suffix: string, role: string) => {
    const [u] = await db.insert(users).values({
      organizationId: org2Id,
      username: `${RUN_TAG}-${suffix}@test.local`,
      name: `Test ${suffix}`,
      role,
    }).returning();
    created.userIds.push(u.id);
    return u;
  };
  dir2 = await mkUser2("dir2", "director");
  rep2 = await mkUser2("rep2", "account_manager");
  outsider2 = await mkUser2("outsider2", "logistics_coordinator");
  // rep2 reports to dir2 so the director's getVisibleCompanyIds tree
  // includes any account assigned to rep2.
  await db.update(users).set({ managerId: dir2.id }).where(eq(users.id, rep2.id));
  rep2 = (await db.select().from(users).where(eq(users.id, rep2.id)))[0];

  // Company A: assigned to rep2. Outsider can't see it, but dir2 and
  // rep2 both can. Re-routing should pick rep2 (the owner) directly.
  const [cA] = await db.insert(companies).values({
    organizationId: org2Id,
    name: `${RUN_TAG}-rep2-co`,
    assignedTo: rep2.id,
  }).returning();
  rep2Company = cA;
  created.companyIds.push(cA.id);

  // Company B: NO owner, but dir2 is on its sharedReps so the director
  // does see it. With no admin in this org, the portfolio-viewer
  // fallback must pick dir2 — exercising the new findPortfolioFallbackOwner
  // branch.
  const [cB] = await db.insert(companies).values({
    organizationId: org2Id,
    name: `${RUN_TAG}-unowned-co`,
    assignedTo: null,
    salesPersonId: null,
    sharedReps: [{ userId: dir2.id, role: "shared" }] as any,
  }).returning();
  unownedSharedCompany = cB;
  created.companyIds.push(cB.id);

  // Contacts on each company so missed-call rows have a contactId
  // and trigger pickAccountOwnerOrSelf in the callback.
  const [contactA] = await db.insert(contacts).values({
    companyId: cA.id,
    name: `${RUN_TAG}-contact-a`,
    phone: "+15555550101",
  }).returning();
  created.contactIds.push(contactA.id);

  const [contactB] = await db.insert(contacts).values({
    companyId: cB.id,
    name: `${RUN_TAG}-contact-b`,
    phone: "+15555550102",
  }).returning();
  created.contactIds.push(contactB.id);

  const [mOwned] = await db.insert(missedInboundCalls).values({
    orgId: org2Id,
    cdrId: `${RUN_TAG}-cdr-owned`,
    callingNumber: "+15555550101",
    calledNumber: "+15555550100",
    ringDurationSeconds: 30,
    voicemailLeft: false,
    startTime: new Date().toISOString(),
    contactId: contactA.id,
    companyId: cA.id,
    attributedUserId: outsider2.id,
    afterHours: false,
    createdAt: new Date().toISOString(),
  }).returning();
  missedCallOwnedId = mOwned.id;
  created.missedCallIds.push(mOwned.id);

  const [mUnowned] = await db.insert(missedInboundCalls).values({
    orgId: org2Id,
    cdrId: `${RUN_TAG}-cdr-unowned`,
    callingNumber: "+15555550102",
    calledNumber: "+15555550100",
    ringDurationSeconds: 30,
    voicemailLeft: false,
    startTime: new Date().toISOString(),
    contactId: contactB.id,
    companyId: cB.id,
    attributedUserId: outsider2.id,
    afterHours: false,
    createdAt: new Date().toISOString(),
  }).returning();
  missedCallUnownedId = mUnowned.id;
  created.missedCallIds.push(mUnowned.id);
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));

  const safe = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { console.error(`[nba-priorities cleanup] ${label}:`, e); }
  };

  if (created.missedCallIds.length) {
    await safe("missed_inbound_calls", () =>
      db.delete(missedInboundCalls).where(inArray(missedInboundCalls.id, created.missedCallIds)),
    );
  }
  if (created.nbaCardIds.length) {
    await safe("nba_cards", () =>
      db.delete(nbaCards).where(inArray(nbaCards.id, created.nbaCardIds)),
    );
  }
  if (created.contactIds.length) {
    await safe("contacts", () =>
      db.delete(contacts).where(inArray(contacts.id, created.contactIds)),
    );
  }
  if (created.companyIds.length) {
    await safe("companies", () =>
      db.delete(companies).where(inArray(companies.id, created.companyIds)),
    );
  }
  if (created.userIds.length) {
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

describe("/api/nba/cards — visible-company guard (Task #773)", () => {
  it("Jared sees his own-company card", async () => {
    setUser(jared);
    const res = await fetch(`${baseUrl}/api/nba/cards?limit=50`);
    expect(res.status).toBe(200);
    const cards: any[] = await res.json();
    const ids = cards.map(c => c.id);
    expect(ids).toContain(created.nbaCardIds[0]);
  });

  it("Jared does NOT see the leaked webex_missed_call card on another rep's company", async () => {
    setUser(jared);
    const res = await fetch(`${baseUrl}/api/nba/cards?limit=50`);
    const cards: any[] = await res.json();
    const ids = cards.map(c => c.id);
    expect(ids).not.toContain(created.nbaCardIds[1]);
    // And specifically, no card linked to the other rep's company should
    // surface, regardless of rule type.
    expect(cards.some(c => c.companyId === ownerCompany.id)).toBe(false);
  });

  it("Jared still sees org-level cards (no companyId)", async () => {
    setUser(jared);
    const res = await fetch(`${baseUrl}/api/nba/cards?limit=50`);
    const cards: any[] = await res.json();
    const ids = cards.map(c => c.id);
    expect(ids).toContain(created.nbaCardIds[2]);
  });

  it("Admin (org-wide portfolio) still sees every card, including the one Jared can't", async () => {
    setUser(admin);
    const res = await fetch(`${baseUrl}/api/nba/cards?limit=200`);
    expect(res.status).toBe(200);
    const cards: any[] = await res.json();
    const ids = cards.map(c => c.id);
    for (const id of created.nbaCardIds) {
      expect(ids).toContain(id);
    }
  });
});

// ── Webex missed-call callback re-routing (Task #773) ─────────────────
// Exercises pickAccountOwnerOrSelf via the actual HTTP endpoint. The
// outsider rep gets attributed to a missed call for an account they
// can't see; the new card MUST land on someone who can see the company,
// never the outsider — even in an org with no admin user.
describe("/api/webex/missed-inbound/:id/callback — owner re-routing (Task #773)", () => {
  it("re-routes the new card from the attributed outsider to the actual company owner", async () => {
    setUser(outsider2);
    const res = await fetch(
      `${baseUrl}/api/webex/missed-inbound/${missedCallOwnedId}/callback`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nbaCardId).toBeTruthy();

    // Sanity: card now exists, is bound to the company, and was assigned
    // to rep2 (the owner) — NOT outsider2 (the attributed rep) and NOT
    // dir2 (would only be picked if the owner branch missed).
    const [card] = await db.select().from(nbaCards).where(eq(nbaCards.id, body.nbaCardId));
    expect(card).toBeDefined();
    created.nbaCardIds.push(card.id);
    expect(card.userId).toBe(rep2.id);
    expect(card.userId).not.toBe(outsider2.id);
    expect(card.companyId).toBe(rep2Company.id);
    expect(card.ruleType).toBe("webex_missed_call");
  });

  it("falls back to a director portfolio viewer when the company has no owner and the org has no admin", async () => {
    setUser(outsider2);
    const res = await fetch(
      `${baseUrl}/api/webex/missed-inbound/${missedCallUnownedId}/callback`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nbaCardId).toBeTruthy();

    const [card] = await db.select().from(nbaCards).where(eq(nbaCards.id, body.nbaCardId));
    expect(card).toBeDefined();
    created.nbaCardIds.push(card.id);
    // Most importantly: NOT silently assigned back to the outsider rep
    // (which would re-introduce the leak), and NOT to rep2 (this account
    // has no owner). It must land on dir2 — the only portfolio viewer
    // (director) who actually has visibility into the unowned company
    // via sharedReps, since this org has no admin.
    expect(card.userId).not.toBe(outsider2.id);
    expect(card.userId).toBe(dir2.id);
    expect(card.companyId).toBe(unownedSharedCompany.id);
  });
});
