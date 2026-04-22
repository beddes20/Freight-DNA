/**
 * Phase 2 — DNA Copilot Data & Tools Expansion (Task #422).
 *
 * Verifies the 8 new tools wired into the agent:
 *   1  query_pipeline               — read.pipeline
 *   2  one_on_one_history           — read.coaching (manager-only refusal)
 *   3  lane_carrier_lookup          — read.lane
 *   4  available_freight_search     — read.opportunity
 *   5  email_intelligence_search    — read.email
 *   6  next_best_actions            — read.nba
 *   7  scorecard_lookup             — read.scorecard
 *   8  recurring_freight_pattern    — read.lane
 *
 * For each tool we cover:
 *   - happy path (in-org data shows up)
 *   - cross-org leakage guard (Org B fixtures must NEVER appear)
 *   - permission/role gating where applicable
 *
 * Plus persona enumeration: every new tool must appear in the routing
 * persona so the LLM knows when to dispatch it.
 *
 * Runs against the live dev DATABASE_URL with random tagged fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../storage";
import {
  organizations, users, companies, prospects, crmOpportunities,
  oneOnOneSessions, oneOnOneTopics, awards, tasks, laneCarriers,
  freightOpportunities, emailMessages, emailSignals, nbaCards,
  recurringLanes, reportCardSnapshots,
} from "@shared/schema";
import { inArray } from "drizzle-orm";
import { TOOLS, type AgentContext } from "../agent/tools";
import { canInvoke } from "../agent/permissions";
import { DEFAULT_BASE_PERSONA } from "../agent/persona";
import type { User } from "@shared/schema";

const RUN_TAG = `phase2-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOW_ISO = new Date().toISOString();
const TODAY = NOW_ISO.slice(0, 10);

const T = (n: string) => TOOLS.find(t => t.name === n)!;
const queryPipeline = T("query_pipeline");
const oneOnOneHistory = T("one_on_one_history");
const laneCarrierLookup = T("lane_carrier_lookup");
const freightSearch = T("available_freight_search");
const emailIntel = T("email_intelligence_search");
const nba = T("next_best_actions");
const scorecard = T("scorecard_lookup");
const recurring = T("recurring_freight_pattern");

const created = {
  orgIds: [] as string[],
  userIds: [] as string[],
  companyIds: [] as string[],
  prospectIds: [] as number[],
  oppIds: [] as number[],
  sessionIds: [] as string[],
  topicIds: [] as string[],
  awardIds: [] as string[],
  taskIds: [] as string[],
  laneCarrierIds: [] as string[],
  freightIds: [] as string[],
  emailIds: [] as string[],
  signalIds: [] as string[],
  cardIds: [] as string[],
  recurringIds: [] as string[],
  scorecardIds: [] as string[],
};

let orgA = "", orgB = "";
let mgrA: User, repA: User, repA2: User;
let mgrB: User, repB: User;
let companyA = "", companyB = "";

function ctxFor(rep: User, scope: "my_team" | "everyone" = "my_team"): AgentContext {
  return { rep, organizationId: rep.organizationId, channel: "in_app", conversationRef: null, scope };
}

beforeAll(async () => {
  const [oA] = await db.insert(organizations).values({ name: `${RUN_TAG}-A`, slug: `${RUN_TAG}-a` }).returning();
  const [oB] = await db.insert(organizations).values({ name: `${RUN_TAG}-B`, slug: `${RUN_TAG}-b` }).returning();
  orgA = oA.id; orgB = oB.id;
  created.orgIds.push(oA.id, oB.id);

  const [mA] = await db.insert(users).values({ organizationId: orgA, username: `${RUN_TAG}-mA`, name: "Mgr Alpha", role: "national_account_manager" }).returning();
  const [rA] = await db.insert(users).values({ organizationId: orgA, username: `${RUN_TAG}-rA`, name: "Rep Alpha", role: "account_manager", managerId: mA.id }).returning();
  const [rA2] = await db.insert(users).values({ organizationId: orgA, username: `${RUN_TAG}-rA2`, name: "Rep AlphaTwo", role: "account_manager", managerId: mA.id }).returning();
  const [mB] = await db.insert(users).values({ organizationId: orgB, username: `${RUN_TAG}-mB`, name: "Mgr Bravo", role: "national_account_manager" }).returning();
  const [rB] = await db.insert(users).values({ organizationId: orgB, username: `${RUN_TAG}-rB`, name: "Rep Bravo", role: "account_manager", managerId: mB.id }).returning();
  mgrA = mA as User; repA = rA as User; repA2 = rA2 as User; mgrB = mB as User; repB = rB as User;
  created.userIds.push(mA.id, rA.id, rA2.id, mB.id, rB.id);

  const [cA] = await db.insert(companies).values({ organizationId: orgA, name: `${RUN_TAG}-AcmeA`, assignedTo: repA.id }).returning();
  const [cB] = await db.insert(companies).values({ organizationId: orgB, name: `${RUN_TAG}-AcmeB`, assignedTo: repB.id }).returning();
  companyA = cA.id; companyB = cB.id;
  created.companyIds.push(cA.id, cB.id);

  // Prospects + opportunities
  const [pA] = await db.insert(prospects).values({ organizationId: orgA, name: `${RUN_TAG}-pA`, stage: "qualification", ownerId: repA.id, accountStatus: "qualifying" }).returning();
  const [pB] = await db.insert(prospects).values({ organizationId: orgB, name: `${RUN_TAG}-pB`, stage: "qualification", ownerId: repB.id }).returning();
  created.prospectIds.push(pA.id, pB.id);
  const [oA2] = await db.insert(crmOpportunities).values({ organizationId: orgA, prospectId: pA.id, name: `${RUN_TAG}-oppA`, stage: "qualification", amount: "50000", createdById: repA.id }).returning();
  const [oB2] = await db.insert(crmOpportunities).values({ organizationId: orgB, prospectId: pB.id, name: `${RUN_TAG}-oppB`, stage: "qualification", amount: "99000", createdById: repB.id }).returning();
  created.oppIds.push(oA2.id, oB2.id);

  // 1:1 session for repA under mgrA
  const [sA] = await db.insert(oneOnOneSessions).values({ namId: mgrA.id, amId: repA.id, status: "active", startDate: TODAY, moraleScore: 8 }).returning();
  const [sB] = await db.insert(oneOnOneSessions).values({ namId: mgrB.id, amId: repB.id, status: "active", startDate: TODAY }).returning();
  created.sessionIds.push(sA.id, sB.id);
  const [tpA] = await db.insert(oneOnOneTopics).values({ sessionId: sA.id, addedById: mgrA.id, text: `${RUN_TAG}-topicA`, status: "pending", createdAt: NOW_ISO }).returning();
  created.topicIds.push(tpA.id);

  // Award + procurement task + lane carriers
  const [awA] = await db.insert(awards).values({ companyId: companyA, title: `${RUN_TAG}-awardA` }).returning();
  const [awB] = await db.insert(awards).values({ companyId: companyB, title: `${RUN_TAG}-awardB` }).returning();
  created.awardIds.push(awA.id, awB.id);
  const [tkA] = await db.insert(tasks).values({ title: `${RUN_TAG}-taskA`, status: "open", assignedTo: repA.id, assignedBy: mgrA.id, orgId: orgA, createdAt: NOW_ISO }).returning();
  const [tkB] = await db.insert(tasks).values({ title: `${RUN_TAG}-taskB`, status: "open", assignedTo: repB.id, assignedBy: mgrB.id, orgId: orgB, createdAt: NOW_ISO }).returning();
  created.taskIds.push(tkA.id, tkB.id);
  const [lcA] = await db.insert(laneCarriers).values({ taskId: tkA.id, awardId: awA.id, lane: "ATL→DAL", carrierName: `${RUN_TAG}-carrierA`, status: "contacted", createdAt: NOW_ISO }).returning();
  const [lcB] = await db.insert(laneCarriers).values({ taskId: tkB.id, awardId: awB.id, lane: "MIA→BOS", carrierName: `${RUN_TAG}-carrierB`, status: "contacted", createdAt: NOW_ISO }).returning();
  created.laneCarrierIds.push(lcA.id, lcB.id);

  // Freight rows (today + forward)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [fA] = await db.insert(freightOpportunities).values({
    orgId: orgA, companyId: companyA, mode: "TL", origin: "Atlanta", originState: "GA", destination: "Dallas", destinationState: "TX",
    equipmentType: "VAN", loadCount: 3, pickupWindowStart: TODAY, pickupWindowEnd: tomorrow,
    urgencyScore: 80, status: "new",
  }).returning();
  const [fB] = await db.insert(freightOpportunities).values({
    orgId: orgB, companyId: companyB, mode: "TL", origin: "Miami", originState: "FL", destination: "Boston", destinationState: "MA",
    equipmentType: "REEFER", loadCount: 2, pickupWindowStart: TODAY, pickupWindowEnd: tomorrow,
    urgencyScore: 90, status: "new",
  }).returning();
  created.freightIds.push(fA.id, fB.id);

  // Email + signals
  const [eA] = await db.insert(emailMessages).values({
    orgId: orgA, threadId: `${RUN_TAG}-thrA`, providerMessageId: `${RUN_TAG}-msgA`, fromEmail: "buyer@acmea.com",
    toEmail: "rep@us.com", subject: `${RUN_TAG}-subjA`, body: "Pricing request thread.", direction: "inbound",
    linkedAccountId: companyA,
  }).returning();
  const [eB] = await db.insert(emailMessages).values({
    orgId: orgB, threadId: `${RUN_TAG}-thrB`, providerMessageId: `${RUN_TAG}-msgB`, fromEmail: "buyer@acmeb.com",
    toEmail: "rep@us.com", subject: `${RUN_TAG}-subjB`, body: "Other org pricing.", direction: "inbound",
    linkedAccountId: companyB,
  }).returning();
  created.emailIds.push(eA.id, eB.id);
  const [sigA] = await db.insert(emailSignals).values({
    messageId: eA.id, intentType: "pricing_request", actorType: "customer", confidence: 90, linkedAccountId: companyA,
  }).returning();
  const [sigB] = await db.insert(emailSignals).values({
    messageId: eB.id, intentType: "pricing_request", actorType: "customer", confidence: 90, linkedAccountId: companyB,
  }).returning();
  created.signalIds.push(sigA.id, sigB.id);

  // NBA cards
  const [cardA] = await db.insert(nbaCards).values({
    orgId: orgA, userId: repA.id, companyId: companyA, companyName: `${RUN_TAG}-AcmeA`,
    ruleType: "at_risk_account", whyThisNow: "Cadence dropped", suggestedAction: `${RUN_TAG}-actA`,
    expectedOutcome: "save the account", urgencyScore: 88, status: "visible", createdAt: NOW_ISO,
  }).returning();
  const [cardB] = await db.insert(nbaCards).values({
    orgId: orgB, userId: repB.id, companyId: companyB, companyName: `${RUN_TAG}-AcmeB`,
    ruleType: "at_risk_account", whyThisNow: "Cadence dropped", suggestedAction: `${RUN_TAG}-actB`,
    expectedOutcome: "save the account", urgencyScore: 88, status: "visible", createdAt: NOW_ISO,
  }).returning();
  created.cardIds.push(cardA.id, cardB.id);

  // Recurring lanes
  const [recA] = await db.insert(recurringLanes).values({
    orgId: orgA, companyId: companyA, companyName: `${RUN_TAG}-AcmeA`,
    origin: "Atlanta", originState: "GA", destination: "Dallas", destinationState: "TX",
    equipmentType: "VAN", avgLoadsPerWeek: "2.5", weeksActive: 8, isEligible: true, hasPreferredCarrierProgram: false,
    laneScore: 75,
  }).returning();
  const [recB] = await db.insert(recurringLanes).values({
    orgId: orgB, companyId: companyB, companyName: `${RUN_TAG}-AcmeB`,
    origin: "Miami", originState: "FL", destination: "Boston", destinationState: "MA",
    equipmentType: "REEFER", avgLoadsPerWeek: "1.5", weeksActive: 4, isEligible: true, hasPreferredCarrierProgram: false,
    laneScore: 60,
  }).returning();
  created.recurringIds.push(recA.id, recB.id);

  // Scorecard snapshots
  const [scA] = await db.insert(reportCardSnapshots).values({
    userId: repA.id, periodType: "month", periodLabel: "April 2026", snapshotDate: TODAY,
    payload: { revenue: 12345, calls: 22 }, savedById: mgrA.id,
  }).returning();
  const [scB] = await db.insert(reportCardSnapshots).values({
    userId: repB.id, periodType: "month", periodLabel: "April 2026", snapshotDate: TODAY,
    payload: { revenue: 99999, calls: 1 }, savedById: mgrB.id,
  }).returning();
  created.scorecardIds.push(scA.id, scB.id);
});

afterAll(async () => {
  const safe = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { console.error(`[phase2 cleanup] ${label}:`, e); }
  };
  if (created.scorecardIds.length) await safe("scorecards",   () => db.delete(reportCardSnapshots).where(inArray(reportCardSnapshots.id, created.scorecardIds)));
  if (created.recurringIds.length)  await safe("recurring",    () => db.delete(recurringLanes).where(inArray(recurringLanes.id, created.recurringIds)));
  if (created.cardIds.length)       await safe("nba cards",    () => db.delete(nbaCards).where(inArray(nbaCards.id, created.cardIds)));
  if (created.signalIds.length)     await safe("email signals",() => db.delete(emailSignals).where(inArray(emailSignals.id, created.signalIds)));
  if (created.emailIds.length)      await safe("emails",       () => db.delete(emailMessages).where(inArray(emailMessages.id, created.emailIds)));
  if (created.freightIds.length)    await safe("freight",      () => db.delete(freightOpportunities).where(inArray(freightOpportunities.id, created.freightIds)));
  if (created.laneCarrierIds.length)await safe("lane carriers",() => db.delete(laneCarriers).where(inArray(laneCarriers.id, created.laneCarrierIds)));
  if (created.taskIds.length)       await safe("tasks",        () => db.delete(tasks).where(inArray(tasks.id, created.taskIds)));
  if (created.awardIds.length)      await safe("awards",       () => db.delete(awards).where(inArray(awards.id, created.awardIds)));
  if (created.topicIds.length)      await safe("1:1 topics",   () => db.delete(oneOnOneTopics).where(inArray(oneOnOneTopics.id, created.topicIds)));
  if (created.sessionIds.length)    await safe("1:1 sessions", () => db.delete(oneOnOneSessions).where(inArray(oneOnOneSessions.id, created.sessionIds)));
  if (created.oppIds.length)        await safe("opps",         () => db.delete(crmOpportunities).where(inArray(crmOpportunities.id, created.oppIds)));
  if (created.prospectIds.length)   await safe("prospects",    () => db.delete(prospects).where(inArray(prospects.id, created.prospectIds)));
  if (created.companyIds.length)    await safe("companies",    () => db.delete(companies).where(inArray(companies.id, created.companyIds)));
  if (created.userIds.length)       await safe("users",        () => db.delete(users).where(inArray(users.id, created.userIds)));
  if (created.orgIds.length)        await safe("orgs",         () => db.delete(organizations).where(inArray(organizations.id, created.orgIds)));
});

describe("query_pipeline", () => {
  it("rep sees their own prospect; cross-org prospect not leaked", async () => {
    const out = await queryPipeline.execute(ctxFor(repA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-pA`);
    expect(text).toContain(`${RUN_TAG}-oppA`);
    expect(text).not.toContain(`${RUN_TAG}-pB`);
    expect(text).not.toContain(`${RUN_TAG}-oppB`);
  });
  it("manager in everyone scope sees full org pipeline but not other org", async () => {
    const out = await queryPipeline.execute(ctxFor(mgrA, "everyone"), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-pA`);
    expect(text).not.toContain(`${RUN_TAG}-pB`);
  });
});

describe("one_on_one_history", () => {
  it("manager sees direct-report session", async () => {
    const out = await oneOnOneHistory.execute(ctxFor(mgrA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("Rep Alpha");
    expect(text).not.toContain("Rep Bravo");
  });
  it("non-manager (account_manager) is refused", async () => {
    const out = await oneOnOneHistory.execute(ctxFor(repA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    expect(text).not.toContain(`${RUN_TAG}-topicA`);
  });
  it("permissions deny coaching for account_manager by default", async () => {
    const decision = await canInvoke(repA, "read.coaching");
    expect(decision.allowed).toBe(false);
  });
  it("permissions allow coaching for managers by default", async () => {
    const decision = await canInvoke(mgrA, "read.coaching");
    expect(decision.allowed).toBe(true);
  });
});

describe("lane_carrier_lookup", () => {
  it("returns carriers for org A award; cross-org carrier not leaked", async () => {
    const out = await laneCarrierLookup.execute(ctxFor(repA), { award_title: `${RUN_TAG}-awardA`, company_name: `${RUN_TAG}-AcmeA` });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-carrierA`);
    expect(text).not.toContain(`${RUN_TAG}-carrierB`);
  });
  it("returns carriers for org A task; cross-org task not findable", async () => {
    const out = await laneCarrierLookup.execute(ctxFor(repA), { task_title: `${RUN_TAG}-taskB` });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("no procurement task");
  });
});

describe("available_freight_search", () => {
  it("rep sees own org's load; cross-org load excluded", async () => {
    const out = await freightSearch.execute(ctxFor(repA), { equipment_type: "VAN" });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-AcmeA`);
    expect(text).not.toContain(`${RUN_TAG}-AcmeB`);
  });
});

describe("email_intelligence_search", () => {
  it("returns org A signals only", async () => {
    const out = await emailIntel.execute(ctxFor(repA), { intent: "pricing_request" });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-subjA`);
    expect(text).not.toContain(`${RUN_TAG}-subjB`);
  });
});

describe("next_best_actions", () => {
  it("rep sees own NBA card; org B card excluded", async () => {
    const out = await nba.execute(ctxFor(repA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-actA`);
    expect(text).not.toContain(`${RUN_TAG}-actB`);
  });
});

describe("scorecard_lookup", () => {
  it("rep sees their own latest snapshot", async () => {
    const out = await scorecard.execute(ctxFor(repA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("April 2026");
    expect(text).toContain("12345");
  });
  it("non-manager attempting to look up another rep is refused", async () => {
    const out = await scorecard.execute(ctxFor(repA), { rep_name: "Rep AlphaTwo" });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text.toLowerCase()).toContain("manager");
    expect(text).not.toContain("99999");
  });
  it("manager can pull a teammate's snapshot in own org but not other org", async () => {
    const out = await scorecard.execute(ctxFor(mgrA), { rep_name: "Rep Alpha" });
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain("12345");
    const cross = await scorecard.execute(ctxFor(mgrA), { rep_name: "Rep Bravo" });
    const crossText = (cross as { kind: "data"; text: string }).text;
    expect(crossText.toLowerCase()).toContain("no teammate matched");
  });
});

describe("recurring_freight_pattern", () => {
  it("returns org A's recurring lanes only", async () => {
    const out = await recurring.execute(ctxFor(repA), {});
    const text = (out as { kind: "data"; text: string }).text;
    expect(text).toContain(`${RUN_TAG}-AcmeA`);
    expect(text).not.toContain(`${RUN_TAG}-AcmeB`);
  });
});

describe("persona enumeration", () => {
  // Must mention every new tool by name so the LLM knows to dispatch it.
  const expected = [
    "query_pipeline", "one_on_one_history", "lane_carrier_lookup",
    "available_freight_search", "email_intelligence_search", "next_best_actions",
    "scorecard_lookup", "recurring_freight_pattern",
  ];
  for (const name of expected) {
    it(`persona references "${name}"`, () => {
      expect(DEFAULT_BASE_PERSONA).toContain(name);
    });
  }
});
