/**
 * Task #673 — Freight Capture Funnel service tests.
 *
 * Validates the funnel aggregator at the service layer (not via HTTP) so the
 * test stays fast and self-contained. Seeds an isolated org with controlled
 * quote opportunities + events and verifies stage counts, conversion rates,
 * loss-reason breakdown, performer aggregation, and rep-scoping.
 *
 * Run with: npx tsx tests/freight-capture-funnel.test.ts
 *
 * Requires DATABASE_URL.
 */

import { db } from "../server/storage";
import {
  organizations, users,
  quoteCustomers, quoteReps, quoteOutcomeReasons,
  quoteOpportunities, quoteEvents,
} from "../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { getFunnel, resolveFunnelRepScope } from "../server/services/customerQuotes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

const orgIdsToCleanup: string[] = [];

async function cleanup(): Promise<void> {
  for (const orgId of orgIdsToCleanup) {
    // quote_opportunities cascades to quote_events; users + customers + reps
    // cascade from organizations.
    await db.delete(quoteOpportunities).where(eq(quoteOpportunities.organizationId, orgId));
    await db.delete(quoteOutcomeReasons).where(eq(quoteOutcomeReasons.organizationId, orgId));
    await db.delete(quoteReps).where(eq(quoteReps.organizationId, orgId));
    await db.delete(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
}

async function seed() {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Funnel Test ${ts}`, slug: `funnel-test-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);

  const [adminUser, repUserA, repUserB] = await db
    .insert(users)
    .values([
      { organizationId: org.id, name: "Admin", username: `admin-${ts}@example.com`, role: "admin", password: "x", managerId: null },
      { organizationId: org.id, name: "Rep A", username: `repa-${ts}@example.com`, role: "account_manager", password: "x", managerId: null },
      { organizationId: org.id, name: "Rep B", username: `repb-${ts}@example.com`, role: "account_manager", password: "x", managerId: null },
    ])
    .returning();

  const [cust1, cust2, carrierBucket] = await db
    .insert(quoteCustomers)
    .values([
      { organizationId: org.id, name: "Acme Foods", partyType: "customer" },
      { organizationId: org.id, name: "Globex Logistics", partyType: "customer" },
      // Should be filtered out by nonCustomer guard.
      { organizationId: org.id, name: "Bad Carrier Inc", partyType: "carrier" },
    ])
    .returning();

  const [repA, repB] = await db
    .insert(quoteReps)
    .values([
      { organizationId: org.id, name: "Rep A", userId: repUserA.id },
      { organizationId: org.id, name: "Rep B", userId: repUserB.id },
    ])
    .returning();

  const [reasonPrice, reasonService] = await db
    .insert(quoteOutcomeReasons)
    .values([
      { organizationId: org.id, code: "lost_price", label: "Price too high", category: "lost" },
      { organizationId: org.id, code: "lost_service", label: "Service mismatch", category: "lost" },
    ])
    .returning();

  const now = new Date();
  const dayMs = 24 * 3600 * 1000;
  const recent = (daysAgo: number) => new Date(now.getTime() - daysAgo * dayMs);

  // Seed shape:
  //   10 quotes total in scope.
  //   - 8 have a quotedAmount (Quoted)
  //   - 2 are pending without a quote yet (counted in Received only)
  //   - 4 have a follow-up event (Follow-up Sent)
  //   - 3 won (Booked)
  //   - 2 lost  (1 price, 1 service)
  //   - 1 no_response, 1 pending >14 days → Stale = 2
  //
  // Plus 1 carrier-bucket row (must be filtered out of every count).
  const opps = await db
    .insert(quoteOpportunities)
    .values([
      // Won by Rep A
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(2), originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", equipment: "Van", quotedAmount: "1500.00", outcomeStatus: "won", carrierPaid: "1200.00", responseTimeHours: "1.5", source: "email" },
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(3), originCity: "Houston", originState: "TX", destCity: "Atlanta", destState: "GA", equipment: "Van", quotedAmount: "1700.00", outcomeStatus: "won_low_margin", carrierPaid: "1600.00", responseTimeHours: "2.0", source: "email" },
      // Won by Rep B
      { organizationId: org.id, customerId: cust2.id, repId: repB.id, requestDate: recent(1), originCity: "Chicago", originState: "IL", destCity: "Memphis", destState: "TN", equipment: "Reefer", quotedAmount: "2200.00", outcomeStatus: "won", carrierPaid: "1800.00", responseTimeHours: "0.5", source: "email" },
      // Lost (price) by Rep A
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(5), originCity: "Dallas", originState: "TX", destCity: "Memphis", destState: "TN", equipment: "Van", quotedAmount: "1300.00", outcomeStatus: "lost_price", outcomeReasonId: reasonPrice.id, responseTimeHours: "3.0", source: "email" },
      // Lost (service) by Rep B
      { organizationId: org.id, customerId: cust2.id, repId: repB.id, requestDate: recent(4), originCity: "Chicago", originState: "IL", destCity: "Atlanta", destState: "GA", equipment: "Reefer", quotedAmount: "2400.00", outcomeStatus: "lost_service", outcomeReasonId: reasonService.id, responseTimeHours: "4.0", source: "email" },
      // Pending (recent) — counts as Received + Quoted, not stale
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(2), originCity: "Dallas", originState: "TX", destCity: "Phoenix", destState: "AZ", equipment: "Van", quotedAmount: "1600.00", outcomeStatus: "pending", responseTimeHours: "1.0", source: "email" },
      // Pending stale (>14d) — counts as Stale
      { organizationId: org.id, customerId: cust2.id, repId: repB.id, requestDate: recent(20), originCity: "Chicago", originState: "IL", destCity: "Phoenix", destState: "AZ", equipment: "Reefer", quotedAmount: "2100.00", outcomeStatus: "pending", responseTimeHours: "1.0", source: "email" },
      // no_response — counts as Stale
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(8), originCity: "Houston", originState: "TX", destCity: "Phoenix", destState: "AZ", equipment: "Van", quotedAmount: "1900.00", outcomeStatus: "no_response", responseTimeHours: "5.0", source: "email" },
      // Pending without a quote — counts as Received only (NOT Quoted)
      { organizationId: org.id, customerId: cust1.id, repId: repA.id, requestDate: recent(1), originCity: "Dallas", originState: "TX", destCity: "Denver", destState: "CO", equipment: "Van", quotedAmount: null, outcomeStatus: "pending", responseTimeHours: "0.0", source: "email" },
      // Pending without a quote, no rep — counts as Received only
      { organizationId: org.id, customerId: cust2.id, repId: null, requestDate: recent(2), originCity: "Chicago", originState: "IL", destCity: "Denver", destState: "CO", equipment: "Reefer", quotedAmount: null, outcomeStatus: "pending", responseTimeHours: "0.0", source: "email" },
      // Carrier-bucket — must be filtered
      { organizationId: org.id, customerId: carrierBucket.id, repId: repA.id, requestDate: recent(2), originCity: "Dallas", originState: "TX", destCity: "Houston", destState: "TX", equipment: "Van", quotedAmount: "900.00", outcomeStatus: "won", source: "email" },
    ])
    .returning();

  // Add follow-up events to 4 of the quoted rows: 2 won (idx 0, 2), 1 lost (idx 3), 1 stale (idx 6).
  const followupRowIds = [opps[0].id, opps[2].id, opps[3].id, opps[6].id];
  await db.insert(quoteEvents).values(
    followupRowIds.map(id => ({ quoteId: id, eventType: "revised", occurredAt: now, actor: "test", payload: null })),
  );

  return { org, adminUser, repUserA, repUserB, repA, repB, cust1, cust2, opps, reasonPrice, reasonService };
}

async function main(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Freight Capture Funnel — Service Tests (Task #673)");
  console.log("══════════════════════════════════════════════════════════════");

  const ctx = await seed();

  // ── 1. Unfiltered, admin scope ────────────────────────────────────────────
  console.log("\n── 1. Unfiltered (admin scope) ──");
  {
    const result = await getFunnel(ctx.org.id, {}, null);
    const stages = Object.fromEntries(result.stages.map(s => [s.key, s]));
    assert("received = 10 (carrier-bucket excluded)", stages.received.count === 10, `got ${stages.received.count}`);
    assert("quoted = 8", stages.quoted.count === 8, `got ${stages.quoted.count}`);
    assert("followup = 4", stages.followup.count === 4, `got ${stages.followup.count}`);
    assert("won = 3", stages.won.count === 3, `got ${stages.won.count}`);
    assert("lost = 2", stages.lost.count === 2, `got ${stages.lost.count}`);
    assert("stale = 2", stages.stale.count === 2, `got ${stages.stale.count}`);
    assert("conversion: quoted/received = 80%", Math.round(stages.quoted.conversionPct ?? 0) === 80, `got ${stages.quoted.conversionPct}`);
    assert("conversion: followup/quoted = 50%", Math.round(stages.followup.conversionPct ?? 0) === 50, `got ${stages.followup.conversionPct}`);
    assert("conversion: won/quoted = 37.5%", Math.abs((stages.won.conversionPct ?? 0) - 37.5) < 0.01, `got ${stages.won.conversionPct}`);
    // Both exit paths share the same denominator (quoted) so the UI label "of quoted" is accurate for each.
    assert("conversion: lost/quoted = 25%", Math.round(stages.lost.conversionPct ?? 0) === 25, `got ${stages.lost.conversionPct}`);
    assert("conversion: stale/quoted = 25%", Math.round(stages.stale.conversionPct ?? 0) === 25, `got ${stages.stale.conversionPct}`);
    assert("received conversion is null", stages.received.conversionPct === null);

    assert("summary.totalReceived = 10", result.summary.totalReceived === 10);
    assert("summary.totalWon = 3", result.summary.totalWon === 3);
    // Quote → Book = 3/10 = 30%
    assert("summary.quoteToBookPct = 30%", Math.round(result.summary.quoteToBookPct) === 30, `got ${result.summary.quoteToBookPct}`);
    // Win rate = 3/(3+2) = 60%
    assert("summary.winRatePct = 60%", Math.round(result.summary.winRatePct) === 60, `got ${result.summary.winRatePct}`);
    // Follow-up compliance = 4/8 = 50%
    assert("summary.followUpCompliancePct = 50%", Math.round(result.summary.followUpCompliancePct) === 50, `got ${result.summary.followUpCompliancePct}`);
    assert("summary.avgResponseTimeHours > 0", result.summary.avgResponseTimeHours > 0);

    // Loss reasons
    const reasonLabels = result.lossReasons.map(r => r.label).sort();
    assert("lossReasons includes Price too high", reasonLabels.includes("Price too high"));
    assert("lossReasons includes Service mismatch", reasonLabels.includes("Service mismatch"));
    assert("lossReasons each have count 1", result.lossReasons.every(r => r.count === 1));

    // Performers
    const repLabels = result.performers.reps.best.map(r => r.label).sort();
    assert("performers.reps.best includes Rep A and Rep B", repLabels.includes("Rep A") && repLabels.includes("Rep B"));
    const repA = result.performers.reps.best.find(r => r.label === "Rep A");
    assert("Rep A has 2 wins", repA?.won === 2, `got ${repA?.won}`);
    assert("Rep A has 1 loss", repA?.lost === 1, `got ${repA?.lost}`);

    const customerLabels = result.performers.customers.best.map(c => c.label);
    assert("performers.customers.best excludes carrier bucket", !customerLabels.includes("Bad Carrier Inc"));
    assert("performers.customers.best includes Acme Foods", customerLabels.includes("Acme Foods"));

    // Performer ranking: Best should be sorted by win rate descending.
    // Rep A = 2W/1L = 67%, Rep B = 1W/1L = 50% → Rep A first in best.
    assert(
      "performers.reps.best sorted by winRate desc — Rep A first",
      result.performers.reps.best[0]?.label === "Rep A",
      `got ${result.performers.reps.best[0]?.label}`,
    );
    // Worst sort is the inverse — lowest winRate first. With only 2 decided
    // reps in the seed (Rep A 67%, Rep B 50%), worst[0] should be Rep B.
    assert(
      "performers.reps.worst sorted by winRate asc — Rep B first",
      result.performers.reps.worst[0]?.label === "Rep B",
      `got ${result.performers.reps.worst[0]?.label}`,
    );

    assert("scopedToRepId is null for admin", result.scopedToRepId === null);
  }

  // ── 2. Customer filter ────────────────────────────────────────────────────
  console.log("\n── 2. Filtered by customer Acme Foods ──");
  {
    const result = await getFunnel(ctx.org.id, { customerId: ctx.cust1.id }, null);
    const stages = Object.fromEntries(result.stages.map(s => [s.key, s]));
    // Acme has: 2 won (rows 0,1) + 1 lost_price (row 3) + 1 pending (row 5) + 1 no_response (row 7) + 1 pending no-quote (row 8) = 6
    assert("Acme received = 6", stages.received.count === 6, `got ${stages.received.count}`);
    assert("Acme won = 2", stages.won.count === 2, `got ${stages.won.count}`);
    assert("Acme lost = 1", stages.lost.count === 1, `got ${stages.lost.count}`);
  }

  // ── 3. Date filter ────────────────────────────────────────────────────────
  console.log("\n── 3. Filtered by startDate (last 7 days) ──");
  {
    const today = new Date();
    const sevenAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);
    const startDate = sevenAgo.toISOString().slice(0, 10);
    const result = await getFunnel(ctx.org.id, { startDate }, null);
    // Excludes the 20-day-old stale row and the 8-day-old no_response row.
    // 10 total - 2 = 8 received.
    assert("startDate=−7d received = 8", result.summary.totalReceived === 8, `got ${result.summary.totalReceived}`);
    assert("startDate=−7d stale = 0", result.summary.totalStale === 0, `got ${result.summary.totalStale}`);
  }

  // ── 4. Rep scope (account_manager viewer) ─────────────────────────────────
  console.log("\n── 4. Rep scope — Rep A as viewer ──");
  {
    const scope = await resolveFunnelRepScope(ctx.org.id, { id: ctx.repUserA.id, role: "account_manager" });
    assert("scope resolves to repA.id for Rep A user", scope === ctx.repA.id, `got ${scope}`);
    const result = await getFunnel(ctx.org.id, {}, scope);
    // Rep A's rows: 0 (won), 1 (won), 3 (lost_price), 5 (pending recent), 7 (no_response), 8 (pending no-quote) = 6
    assert("Rep A received = 6", result.summary.totalReceived === 6, `got ${result.summary.totalReceived}`);
    assert("Rep A won = 2", result.summary.totalWon === 2, `got ${result.summary.totalWon}`);
    assert("Rep A lost = 1", result.summary.totalLost === 1, `got ${result.summary.totalLost}`);
    assert("Rep A scopedToRepId echoed", result.scopedToRepId === ctx.repA.id);
    // Performers should never include Rep B for a Rep A viewer.
    const allRepLabels = [...result.performers.reps.best, ...result.performers.reps.worst].map(r => r.label);
    assert("Rep A scope excludes Rep B from performers", !allRepLabels.includes("Rep B"));
  }

  // ── 5. Rep scope with no mapping → empty result ───────────────────────────
  console.log("\n── 5. Rep scope — orphan account_manager (no QuoteRep mapping) ──");
  {
    // Create an orphan user that is NOT in quote_reps.
    const orphan = (await db
      .insert(users)
      .values({ organizationId: ctx.org.id, name: "Orphan", username: `orphan-${Date.now()}@example.com`, role: "account_manager", password: "x", managerId: null })
      .returning())[0];
    const scope = await resolveFunnelRepScope(ctx.org.id, { id: orphan.id, role: "account_manager" });
    assert("scope resolves to __none__ for orphan", scope === "__none__", `got ${scope}`);
    const result = await getFunnel(ctx.org.id, {}, scope);
    assert("orphan funnel is empty", result.summary.totalReceived === 0);
    assert("orphan funnel has 6 stages", result.stages.length === 6);
    assert("orphan funnel scopedToRepId is null in echo", result.scopedToRepId === null);
  }

  // ── 6. Admin role bypasses scoping ────────────────────────────────────────
  console.log("\n── 6. Admin role bypasses scoping ──");
  {
    const scope = await resolveFunnelRepScope(ctx.org.id, { id: ctx.adminUser.id, role: "admin" });
    assert("admin scope = null (no auto-scoping)", scope === null, `got ${scope}`);
  }

  // ── 6b. Manager-style roles see the org-wide funnel (RBAC regression) ────
  // national_account_manager / sales / director / sales_director are treated
  // as managerRoles elsewhere in the codebase. They MUST NOT be auto-scoped
  // to a QuoteRep mapping (which would silently hide org data when no
  // mapping exists). See server/services/customerQuotes.ts > resolveFunnelRepScope.
  console.log("\n── 6b. Manager-style roles see org-wide funnel ──");
  {
    const ts = Date.now();
    const [namUser] = await db
      .insert(users)
      .values({
        organizationId: ctx.org.id,
        name: "NAM No Map",
        username: `nam-${ts}@example.com`,
        role: "national_account_manager",
        password: "x",
        managerId: null,
      })
      .returning();
    const namScope = await resolveFunnelRepScope(ctx.org.id, { id: namUser.id, role: "national_account_manager" });
    assert("NAM scope = null (org-wide, NOT __none__)", namScope === null, `got ${namScope}`);
    const namResult = await getFunnel(ctx.org.id, {}, namScope);
    assert(
      "NAM sees full org funnel (10 received)",
      namResult.summary.totalReceived === 10,
      `got ${namResult.summary.totalReceived}`,
    );

    const directorScope = await resolveFunnelRepScope(ctx.org.id, { id: namUser.id, role: "director" });
    assert("director scope = null", directorScope === null);
    const salesDirScope = await resolveFunnelRepScope(ctx.org.id, { id: namUser.id, role: "sales_director" });
    assert("sales_director scope = null", salesDirScope === null);
    const salesScope = await resolveFunnelRepScope(ctx.org.id, { id: namUser.id, role: "sales" });
    assert("sales scope = null", salesScope === null);
  }

  // ── 7. Empty org → empty result ───────────────────────────────────────────
  console.log("\n── 7. Org with no quotes ──");
  {
    const ts = Date.now();
    const [org2] = await db
      .insert(organizations)
      .values({ name: `Empty Org ${ts}`, slug: `empty-org-${ts}` })
      .returning();
    orgIdsToCleanup.push(org2.id);
    const result = await getFunnel(org2.id, {}, null);
    assert("empty org received = 0", result.summary.totalReceived === 0);
    assert("empty org returns 6 stages with zero counts", result.stages.length === 6 && result.stages.every(s => s.count === 0));
  }

  // ── 8. Worst-performer correctness with >TOP_N customer buckets ──────────
  // Regression for the bug where toRows() pre-truncated to top-N by winRate
  // and the UI sliced "worst" from the truncated list — meaning when there
  // were more than TOP_N decided buckets the worst bucket would be excluded.
  // We seed 7 customer buckets with distinct winRates and verify the worst
  // returned by getFunnel matches the bucket with the lowest actual winRate.
  console.log("\n── 8. Worst performer is true bottom across >5 buckets ──");
  {
    const ts = Date.now();
    const [bigOrg] = await db
      .insert(organizations)
      .values({ name: `Big Org ${ts}`, slug: `big-org-${ts}` })
      .returning();
    orgIdsToCleanup.push(bigOrg.id);

    // 7 customers with hand-picked W/L distributions:
    //   c0: 5W/0L  → 100%
    //   c1: 4W/1L  →  80%
    //   c2: 3W/2L  →  60%
    //   c3: 2W/3L  →  40%
    //   c4: 1W/4L  →  20%
    //   c5: 0W/5L  →   0%   ← lowest, MUST be worst[0]
    //   c6: 1W/9L  →  10%   ← second-lowest
    const dist = [
      { wins: 5, losses: 0 },
      { wins: 4, losses: 1 },
      { wins: 3, losses: 2 },
      { wins: 2, losses: 3 },
      { wins: 1, losses: 4 },
      { wins: 0, losses: 5 },
      { wins: 1, losses: 9 },
    ];
    const [rep] = await db
      .insert(quoteReps)
      .values({ organizationId: bigOrg.id, name: "Solo Rep" })
      .returning();
    for (let i = 0; i < dist.length; i++) {
      const [cust] = await db
        .insert(quoteCustomers)
        .values({ organizationId: bigOrg.id, name: `Cust ${i}`, partyType: "customer" })
        .returning();
      const total = dist[i].wins + dist[i].losses;
      const rows: Array<typeof quoteOpportunities.$inferInsert> = [];
      for (let j = 0; j < total; j++) {
        const isWin = j < dist[i].wins;
        const now = new Date();
        rows.push({
          organizationId: bigOrg.id,
          customerId: cust.id,
          repId: rep.id,
          requestDate: now,
          equipment: "Van",
          originCity: "Chicago",
          originState: "IL",
          destCity: "Atlanta",
          destState: "GA",
          quotedAmount: "1500",
          outcomeStatus: isWin ? "won" : "lost_price",
        });
      }
      await db.insert(quoteOpportunities).values(rows);
    }

    const result = await getFunnel(bigOrg.id, {}, null);
    const cust = result.performers.customers;
    assert("8: customers.best returns at most 5", cust.best.length <= 5);
    assert("8: customers.worst returns at most 5", cust.worst.length <= 5);
    assert(
      "8: customers.best[0] is c0 (100%)",
      cust.best[0]?.label === "Cust 0",
      `got ${cust.best[0]?.label} (winRate ${cust.best[0]?.winRate})`,
    );
    assert(
      "8: customers.worst[0] is c5 (0%) — true bottom, not bottom-of-top",
      cust.worst[0]?.label === "Cust 5",
      `got ${cust.worst[0]?.label} (winRate ${cust.worst[0]?.winRate})`,
    );
    assert(
      "8: customers.worst[1] is c6 (10%)",
      cust.worst[1]?.label === "Cust 6",
      `got ${cust.worst[1]?.label} (winRate ${cust.worst[1]?.winRate})`,
    );
    // The buckets that were "above the cut" but still low (c4 at 20%, c3 at
    // 40%) should appear in worst BEFORE any best entries do — proving the
    // worst list is computed independently from best.
    const worstLabels = cust.worst.map(r => r.label);
    assert(
      "8: customers.worst includes c4 (20%) within the top-5 worst",
      worstLabels.includes("Cust 4"),
      `worst labels: ${worstLabels.join(", ")}`,
    );
  }

  await cleanup();

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
