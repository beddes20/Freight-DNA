/**
 * Quote Requests freshness strip — trust-visibility regression coverage
 * (Task #923 follow-up to the May 2026 "0/0 in the morning" report).
 *
 * What this pins down:
 *   getQuoteFreshness(orgId) is the contract that powers the strip above
 *   the Quote Requests KPI tiles. It must answer three questions honestly:
 *
 *     1. When did the email-intelligence batch last run?    → lastRunAt
 *     2. How many inbound emails have we received today?    → inboundToday
 *     3. How many quote opportunities have we created today? → oppsToday
 *
 *   And it must surface the conditional processing hint ONLY when the gap
 *   between #2 and #3 is material (>= 20). Steady-state should be silent;
 *   morning back-load should show the count.
 *
 * The seed mirrors the May 2026 incident shape:
 *   - 50 inbound emails received today
 *   - 5 quote_opportunities created today (gap = 45, well over threshold)
 *   - 1 inbound email from yesterday (date guard)
 *   - 1 outbound email today (direction guard)
 *   - cron heartbeat row for email_intelligence_batch with a recent finish
 *
 * Run with: npx tsx tests/quote-freshness-strip-trust.test.ts
 *
 * Requires DATABASE_URL.
 */

import { db } from "../server/storage";
import {
  organizations, users,
  quoteCustomers, quoteOpportunities,
  emailMessages, cronHeartbeats,
} from "../shared/schema";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { getQuoteFreshness } from "../server/services/customerQuotes";
import { JOB_NAMES } from "../server/lib/cronHeartbeat";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    const msg = detail ? `  \u2717 ${description}\n    ${detail}` : `  \u2717 ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` \u2014 ${detail}` : ""));
    failed++;
  }
}

const orgIdsToCleanup: string[] = [];

async function cleanup(): Promise<void> {
  for (const orgId of orgIdsToCleanup) {
    await db.delete(emailMessages).where(eq(emailMessages.orgId, orgId));
    await db.delete(quoteOpportunities).where(eq(quoteOpportunities.organizationId, orgId));
    await db.delete(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  // Heartbeat row is global (no org scope). Delete and re-insert is too
  // intrusive on a shared dev db — instead, snapshot+restore around the
  // test in the runner below.
}

async function seed() {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Freshness Trust ${ts}`, slug: `freshness-trust-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);

  const [customer] = await db
    .insert(quoteCustomers)
    .values({ organizationId: org.id, name: "Freshness Test Customer", partyType: "customer" })
    .returning();

  const now = new Date();
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const yesterday = new Date(dayStart.getTime() - 12 * 3600 * 1000);
  const todayMid = new Date(dayStart.getTime() + 6 * 3600 * 1000);

  // 50 inbound emails today (the "morning surge")
  const inboundTodayRows = Array.from({ length: 50 }, (_, i) => ({
    orgId: org.id,
    direction: "inbound",
    fromEmail: `sender${i}@example.com`,
    toEmail: "ops@valuetruck.com",
    subject: `Quote request ${i}`,
    body: "Need a quote",
    providerSentAt: new Date(todayMid.getTime() + i * 1000),
  }));
  // Date guard: 1 inbound from yesterday — must NOT count
  inboundTodayRows.push({
    orgId: org.id,
    direction: "inbound",
    fromEmail: "yesterday@example.com",
    toEmail: "ops@valuetruck.com",
    subject: "Old request",
    body: "stale",
    providerSentAt: yesterday,
  });
  // Direction guard: 1 OUTBOUND today — must NOT count
  inboundTodayRows.push({
    orgId: org.id,
    direction: "outbound",
    fromEmail: "rep@valuetruck.com",
    toEmail: "customer@example.com",
    subject: "Reply",
    body: "Quoted at $1500",
    providerSentAt: todayMid,
  });
  await db.insert(emailMessages).values(inboundTodayRows);

  // 5 quote_opportunities today (the back-loaded subset that's been
  // captured so far). Gap = 50 - 5 = 45 → above HINT_MIN_GAP=20.
  const opps = Array.from({ length: 5 }, (_, i) => ({
    organizationId: org.id,
    customerId: customer.id,
    requestDate: new Date(todayMid.getTime() + i * 60_000),
    originCity: "Chicago",
    originState: "IL",
    destCity: "Dallas",
    destState: "TX",
    equipment: "DRY",
    source: "email",
    outcomeStatus: "pending",
  }));
  // Date guard for opps: 1 from yesterday — must NOT count
  opps.push({
    organizationId: org.id,
    customerId: customer.id,
    requestDate: yesterday,
    originCity: "Chicago",
    originState: "IL",
    destCity: "Dallas",
    destState: "TX",
    equipment: "DRY",
    source: "email",
    outcomeStatus: "pending",
  });
  await db.insert(quoteOpportunities).values(opps as any);

  return { org };
}

async function ensureHeartbeatRow(): Promise<{ existed: boolean; previous: any }> {
  const [existing] = await db
    .select()
    .from(cronHeartbeats)
    .where(eq(cronHeartbeats.jobName, JOB_NAMES.emailIntelligenceBatch))
    .limit(1);

  const fakeFinish = new Date(Date.now() - 3 * 60_000); // 3 minutes ago
  if (existing) {
    await db
      .update(cronHeartbeats)
      .set({ lastFinishedAt: fakeFinish, lastStatus: "success" })
      .where(eq(cronHeartbeats.jobName, JOB_NAMES.emailIntelligenceBatch));
    return { existed: true, previous: existing };
  }
  await db.insert(cronHeartbeats).values({
    jobName: JOB_NAMES.emailIntelligenceBatch,
    expectedIntervalMs: 120_000,
    lastStartedAt: fakeFinish,
    lastFinishedAt: fakeFinish,
    lastStatus: "success",
    nextExpectedAt: new Date(fakeFinish.getTime() + 120_000),
  });
  return { existed: false, previous: null };
}

async function restoreHeartbeat(snap: { existed: boolean; previous: any }) {
  if (snap.existed && snap.previous) {
    await db
      .update(cronHeartbeats)
      .set({
        lastStartedAt: snap.previous.lastStartedAt,
        lastFinishedAt: snap.previous.lastFinishedAt,
        lastStatus: snap.previous.lastStatus,
        lastError: snap.previous.lastError,
        nextExpectedAt: snap.previous.nextExpectedAt,
        consecutiveFailures: snap.previous.consecutiveFailures,
      })
      .where(eq(cronHeartbeats.jobName, JOB_NAMES.emailIntelligenceBatch));
  } else {
    await db
      .delete(cronHeartbeats)
      .where(eq(cronHeartbeats.jobName, JOB_NAMES.emailIntelligenceBatch));
  }
}

async function main(): Promise<void> {
  console.log("Seeds an org with 50 inbound emails today + 5 captured opps,");
  console.log("plus date- and direction-guard decoys, then asserts the");
  console.log("getQuoteFreshness contract powering /quote-requests strip.\n");

  const hbSnap = await ensureHeartbeatRow();
  try {
    const { org } = await seed();
    console.log(`Seeded org: ${org.id}\n`);

    const fresh = await getQuoteFreshness(org.id);
    console.log("getQuoteFreshness returned:");
    console.log(`  lastRunAt        : ${fresh.lastRunAt}`);
    console.log(`  lagSeconds       : ${fresh.lagSeconds}`);
    console.log(`  inboundToday     : ${fresh.inboundToday}`);
    console.log(`  oppsToday        : ${fresh.oppsToday}`);
    console.log(`  processingHint   : ${JSON.stringify(fresh.processingHint)}\n`);

    assert(
      "lastRunAt is set when heartbeat row exists",
      fresh.lastRunAt !== null,
      `got ${fresh.lastRunAt}`,
    );
    assert(
      "lagSeconds is a small non-negative number (heartbeat ~3min ago)",
      fresh.lagSeconds !== null && fresh.lagSeconds >= 0 && fresh.lagSeconds < 600,
      `got ${fresh.lagSeconds}`,
    );
    assert(
      "inboundToday excludes yesterday + outbound (50 today inbound seeded)",
      fresh.inboundToday === 50,
      `expected 50, got ${fresh.inboundToday}`,
    );
    assert(
      "oppsToday excludes yesterday opp (5 today seeded)",
      fresh.oppsToday === 5,
      `expected 5, got ${fresh.oppsToday}`,
    );
    assert(
      "processingHint.show=true when gap=45 >= threshold(20)",
      fresh.processingHint.show === true,
      `got show=${fresh.processingHint.show}`,
    );
    assert(
      "processingHint.pendingCount equals the gap (50-5=45)",
      fresh.processingHint.pendingCount === 45,
      `expected 45, got ${fresh.processingHint.pendingCount}`,
    );

    // Steady-state subtest: drop 30 of the inbound-today rows → gap shrinks
    // to 15, below the 20 threshold → hint must hide. Scoped explicitly to
    // direction='inbound' AND providerSentAt >= dayStart with a stable
    // ORDER BY id LIMIT 30 so the second branch is deterministic.
    const dayStartForDelete = new Date();
    dayStartForDelete.setUTCHours(0, 0, 0, 0);
    const inboundTodayOnly = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, org.id),
        eq(emailMessages.direction, "inbound"),
        gte(emailMessages.providerSentAt, dayStartForDelete),
      ))
      .orderBy(asc(emailMessages.id))
      .limit(30);
    const idsToDelete = inboundTodayOnly.map(r => r.id);
    if (idsToDelete.length !== 30) {
      throw new Error(
        `Steady-state subtest setup invariant broken: expected to find 30 inbound-today rows to delete, got ${idsToDelete.length}`,
      );
    }
    await db.delete(emailMessages).where(inArray(emailMessages.id, idsToDelete));

    const fresh2 = await getQuoteFreshness(org.id);
    console.log("\nAfter shrinking gap to ~15:");
    console.log(`  inboundToday     : ${fresh2.inboundToday}`);
    console.log(`  oppsToday        : ${fresh2.oppsToday}`);
    console.log(`  processingHint   : ${JSON.stringify(fresh2.processingHint)}`);

    assert(
      "processingHint.show=false when gap < threshold (steady state)",
      fresh2.processingHint.show === false,
      `got show=${fresh2.processingHint.show} for gap=${fresh2.inboundToday - fresh2.oppsToday}`,
    );
    assert(
      "processingHint.pendingCount=0 when hidden",
      fresh2.processingHint.pendingCount === 0,
      `got ${fresh2.processingHint.pendingCount}`,
    );
  } finally {
    await cleanup();
    await restoreHeartbeat(hbSnap);
  }

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n\u2713 All freshness-strip trust assertions passed.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await cleanup(); } catch {}
  process.exit(1);
});
