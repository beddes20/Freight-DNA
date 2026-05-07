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
import { eq, inArray, and } from "drizzle-orm";
import {
  getFunnel,
  getSnapshot,
  resolveFunnelRepScope,
  markQuoteOutcome,
} from "../server/services/customerQuotes";
import {
  getFreightCaptureRepAudit,
  setRepSuppressed,
  linkRepToUser,
  mergeReps,
  searchOrgUsers,
  REP_AUDIT_LOOKBACK_DAYS,
} from "../server/services/freightCaptureRepAudit";
import {
  classifyRepAuditStatus,
  isFunnelEligibleRep,
} from "../shared/quoteOpportunitiesRoles";

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
      { organizationId: org.id, name: "Globex Industries", partyType: "customer" },
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

  // ── 9. Customer-facing rep filter (Task #714 + Task #752) ──────────────
  // The rep dropdown / pickers / funnel rep ranking is restricted to the
  // strict "customer-facing rep" universe — currently national_account_manager
  // and account_manager. Carrier-facing roles (logistics_manager,
  // logistics_coordinator, generic "sales") AND management roles
  // (admin, director, sales_director) are hidden from the public rep list
  // returned by `getSnapshot` and from the funnel performers.reps ranking.
  //
  // Task #752 — Reps with a NULL `user_id` (typically email-signature
  // extractions like "Brianna Adams") and reps with the admin-controlled
  // `suppressed=true` flag are now ALSO excluded from the funnel display
  // surface. Their underlying quotes are still counted in stage totals so
  // attribution is preserved; the rep buckets themselves just disappear.
  console.log("\n── 9. Customer-facing rep filter (Task #714 + #752) ──");
  {
    const ts = Date.now();
    const [org9] = await db
      .insert(organizations)
      .values({ name: `Rep Filter ${ts}`, slug: `rep-filter-${ts}` })
      .returning();
    orgIdsToCleanup.push(org9.id);

    // Seed users covering the full role taxonomy that the rep filter
    // touches: 2 customer-facing reps (NAM / AM), 3 management roles
    // that retain page access but are NOT in the rep universe
    // (admin / director / sales_director), and 3 carrier-facing
    // (logistics_manager / logistics_coordinator / generic "sales").
    const roleUsers = await db
      .insert(users)
      .values([
        { organizationId: org9.id, name: "AM User",       username: `am-${ts}@x.com`,    role: "account_manager",         password: "x", managerId: null },
        { organizationId: org9.id, name: "NAM User",      username: `nam-${ts}@x.com`,   role: "national_account_manager", password: "x", managerId: null },
        { organizationId: org9.id, name: "Admin User",    username: `adm-${ts}@x.com`,   role: "admin",                    password: "x", managerId: null },
        { organizationId: org9.id, name: "Director User", username: `dir-${ts}@x.com`,   role: "director",                 password: "x", managerId: null },
        { organizationId: org9.id, name: "SalesDir User", username: `sd-${ts}@x.com`,    role: "sales_director",           password: "x", managerId: null },
        { organizationId: org9.id, name: "LM User",       username: `lm-${ts}@x.com`,    role: "logistics_manager",        password: "x", managerId: null },
        { organizationId: org9.id, name: "LC User",       username: `lc-${ts}@x.com`,    role: "logistics_coordinator",    password: "x", managerId: null },
        { organizationId: org9.id, name: "Sales User",    username: `sales-${ts}@x.com`, role: "sales",                    password: "x", managerId: null },
      ])
      .returning();
    const [amUser, namUser, adminUser, dirUser, sdUser, lmUser, lcUser, salesUser] = roleUsers;

    // 2 customer-facing reps + 3 management reps + 3 carrier-facing reps
    // + 1 legacy rep with no linked user (must still appear).
    const repsRows = await db
      .insert(quoteReps)
      .values([
        { organizationId: org9.id, name: "Rep AM",       userId: amUser.id },
        { organizationId: org9.id, name: "Rep NAM",      userId: namUser.id },
        { organizationId: org9.id, name: "Rep Admin",    userId: adminUser.id },
        { organizationId: org9.id, name: "Rep Dir",      userId: dirUser.id },
        { organizationId: org9.id, name: "Rep SalesDir", userId: sdUser.id },
        { organizationId: org9.id, name: "Rep LM",       userId: lmUser.id },
        { organizationId: org9.id, name: "Rep LC",       userId: lcUser.id },
        { organizationId: org9.id, name: "Rep Sales",    userId: salesUser.id },
        { organizationId: org9.id, name: "Rep Legacy",   userId: null },
      ])
      .returning();
    const [repAM, repNAM, repAdmin, repDir, repSalesDir, repLM, repLC, repSales, repLegacy] = repsRows;

    const [cust9] = await db
      .insert(quoteCustomers)
      .values({ organizationId: org9.id, name: "Acme 9", partyType: "customer" })
      .returning();

    // One won + one lost per rep so every rep is "decided" and would
    // otherwise show up in the best/worst rep ranking.
    const oppRows: Array<typeof quoteOpportunities.$inferInsert> = [];
    for (const rep of repsRows) {
      const now = new Date();
      oppRows.push({
        organizationId: org9.id, customerId: cust9.id, repId: rep.id, requestDate: now,
        equipment: "Van", originCity: "Dallas", originState: "TX",
        destCity: "Atlanta", destState: "GA", quotedAmount: "1500",
        outcomeStatus: "won", carrierPaid: "1200",
      });
      oppRows.push({
        organizationId: org9.id, customerId: cust9.id, repId: rep.id, requestDate: now,
        equipment: "Van", originCity: "Dallas", originState: "TX",
        destCity: "Memphis", destState: "TN", quotedAmount: "1400",
        outcomeStatus: "lost_price",
      });
    }
    await db.insert(quoteOpportunities).values(oppRows);

    // (a) Snapshot's public rep list keeps strictly customer-facing reps
    //     (NAM/AM) and the legacy unlinked rep, and excludes both
    //     carrier-facing reps AND management roles.
    const snap = await getSnapshot(org9.id, {});
    const snapRepNames = snap.reps.map(r => r.name).sort();
    assert(
      "9a: snapshot.reps includes Rep AM and Rep NAM",
      ["Rep AM", "Rep NAM"].every(n => snapRepNames.includes(n)),
      `got ${snapRepNames.join(", ")}`,
    );
    assert(
      "9a: snapshot.reps excludes Rep Admin (manager)",
      !snapRepNames.includes("Rep Admin"),
      `got ${snapRepNames.join(", ")}`,
    );
    assert(
      "9a: snapshot.reps excludes Rep Dir (manager)",
      !snapRepNames.includes("Rep Dir"),
      `got ${snapRepNames.join(", ")}`,
    );
    assert(
      "9a: snapshot.reps excludes Rep SalesDir (manager)",
      !snapRepNames.includes("Rep SalesDir"),
      `got ${snapRepNames.join(", ")}`,
    );
    assert(
      "9a: snapshot.reps excludes Rep LM (logistics_manager)",
      !snapRepNames.includes("Rep LM"),
      `got ${snapRepNames.join(", ")}`,
    );
    assert(
      "9a: snapshot.reps excludes Rep LC (logistics_coordinator)",
      !snapRepNames.includes("Rep LC"),
    );
    assert(
      "9a: snapshot.reps excludes Rep Sales (generic sales)",
      !snapRepNames.includes("Rep Sales"),
    );
    // Task #752 — unlinked reps (NULL user_id) are now EXCLUDED from the
    // funnel display surface. Their underlying quote rows still count
    // toward stage totals (asserted below in 9d).
    assert(
      "9c: snapshot.reps EXCLUDES Rep Legacy (null user_id) — Task #752",
      !snapRepNames.includes("Rep Legacy"),
      `got ${snapRepNames.join(", ")}`,
    );

    // (b) Funnel performers.reps ranking is restricted the same way:
    //     keeps customer-facing reps + legacy, drops managers + carrier-side.
    const funnel = await getFunnel(org9.id, {}, null);
    const perfLabels = [...funnel.performers.reps.best, ...funnel.performers.reps.worst]
      .map(r => r.label);
    assert(
      "9b: performers.reps excludes Rep Admin / Rep Dir / Rep SalesDir (managers)",
      !perfLabels.includes("Rep Admin")
        && !perfLabels.includes("Rep Dir")
        && !perfLabels.includes("Rep SalesDir"),
      `got ${perfLabels.join(", ")}`,
    );
    assert(
      "9b: performers.reps excludes Rep LM",
      !perfLabels.includes("Rep LM"),
      `got ${perfLabels.join(", ")}`,
    );
    assert(
      "9b: performers.reps excludes Rep LC",
      !perfLabels.includes("Rep LC"),
    );
    assert(
      "9b: performers.reps excludes Rep Sales",
      !perfLabels.includes("Rep Sales"),
    );
    assert(
      "9b: performers.reps includes a customer-facing rep (Rep AM)",
      perfLabels.includes("Rep AM"),
      `got ${perfLabels.join(", ")}`,
    );
    // Task #752 — strict funnel filter now drops unlinked reps from
    // performers.reps too. Their quotes still feed the stage totals
    // asserted below (9d).
    assert(
      "9c: performers.reps EXCLUDES Rep Legacy (null user_id) — Task #752",
      !perfLabels.includes("Rep Legacy"),
      `got ${perfLabels.join(", ")}`,
    );
    // Task #1042 / #1048 — `applyFilters` now drops rows whose `repId` is
    // attributed to a non-customer-facing rep (managers, logistics_*,
    // generic-sales) from EVERY aggregate including stage totals, not just
    // rankings. Visible reps in this seed: AM, NAM, and Legacy (null
    // user_id, accepted by `isCustomerFacingQuoteRep`). 3 reps × 2 quotes
    // = 6 received, 3 won, 3 lost. (Pre-#1042 expectation was 18/9/9 —
    // updated here to match the intentional production behavior.)
    assert(
      "9d: stage totals reflect Task #1042 rep-role gate (visible reps' quotes only)",
      funnel.summary.totalReceived === 6 && funnel.summary.totalWon === 3,
      `received=${funnel.summary.totalReceived} won=${funnel.summary.totalWon}`,
    );

    // Touch references so unused-binding lints don't fire on the destructure.
    void repAM; void repNAM; void repAdmin; void repDir; void repSalesDir;
    void repLM; void repLC; void repSales; void repLegacy;
  }

  // ── 10. Task #723 — quietBreakdown is always populated ───────────────────
  // The "Why we lose" portlet falls back to "Why they go quiet" when there
  // are no decided losses; the client needs the breakdown unconditionally,
  // so the field must be present on every funnel response.
  console.log("\n── 10. quietBreakdown is always present ──");
  {
    const result = await getFunnel(ctx.org.id, {}, null);
    assert("quietBreakdown is defined", result.quietBreakdown != null);
    assert(
      "quietBreakdown has stale + expired + noResponse + total fields",
      typeof result.quietBreakdown.stale === "number"
        && typeof result.quietBreakdown.expired === "number"
        && typeof result.quietBreakdown.noResponse === "number"
        && typeof result.quietBreakdown.total === "number",
    );
    assert(
      "quietBreakdown.total = stale + expired + noResponse",
      result.quietBreakdown.total
        === result.quietBreakdown.stale + result.quietBreakdown.expired + result.quietBreakdown.noResponse,
    );
    // The seed has 1 row 20+ days old that is "stale by age" + 1 explicit
    // no_response status row → quietBreakdown.total should be at least 1.
    assert(
      "quietBreakdown.total >= 1 with seeded stale/no-response rows",
      result.quietBreakdown.total >= 1,
      `got ${result.quietBreakdown.total}`,
    );
  }

  // ── 11. Task #723 — performers volumeFallback when no decisions ──────────
  // A brand-new org with only pending quotes (no won/lost) should return
  // performers with volumeFallback=true and a non-empty `best` ranked by
  // total quote count, so the UI can still surface "Most active" customers
  // / lanes / reps instead of an empty card.
  console.log("\n── 11. Performers volume fallback (no decisions yet) ──");
  {
    const ts = Date.now();
    const [pendingOrg] = await db
      .insert(organizations)
      .values({ name: `Pending Org ${ts}`, slug: `pending-org-${ts}` })
      .returning();
    orgIdsToCleanup.push(pendingOrg.id);

    const [pendingRep] = await db
      .insert(quoteReps)
      .values({ organizationId: pendingOrg.id, name: "Pending Rep", isPrimary: true, userId: null })
      .returning();
    const [pendingCustHigh, pendingCustLow] = await db
      .insert(quoteCustomers)
      .values([
        { organizationId: pendingOrg.id, name: "High Volume Co", partyType: "customer" },
        { organizationId: pendingOrg.id, name: "Low Volume Co", partyType: "customer" },
      ])
      .returning();

    // 5 pending quotes for High Volume, 1 for Low Volume — none decided.
    const today = new Date();
    const baseRow = {
      organizationId: pendingOrg.id,
      repId: pendingRep.id,
      originCity: "Dallas", originState: "TX",
      destCity: "Atlanta", destState: "GA",
      equipment: "Van",
      requestDate: today,
      validThrough: new Date(today.getTime() + 7 * 24 * 3600 * 1000),
      outcomeStatus: "pending" as const,
      quotedAmount: "1000",
      source: "email" as const,
    };
    await db.insert(quoteOpportunities).values([
      { ...baseRow, customerId: pendingCustHigh.id },
      { ...baseRow, customerId: pendingCustHigh.id },
      { ...baseRow, customerId: pendingCustHigh.id },
      { ...baseRow, customerId: pendingCustHigh.id },
      { ...baseRow, customerId: pendingCustHigh.id },
      { ...baseRow, customerId: pendingCustLow.id },
    ]);

    const result = await getFunnel(pendingOrg.id, {}, null);
    assert(
      "pending-only org: customers.volumeFallback = true",
      result.performers.customers.volumeFallback === true,
    );
    assert(
      "pending-only org: customers.best is non-empty (ranked by volume)",
      result.performers.customers.best.length > 0,
      `got ${result.performers.customers.best.length}`,
    );
    assert(
      "pending-only org: highest-volume customer is first",
      result.performers.customers.best[0]?.label === "High Volume Co",
      `got ${result.performers.customers.best[0]?.label}`,
    );
    assert(
      "pending-only org: customers.worst is empty in fallback mode",
      result.performers.customers.worst.length === 0,
    );
    assert(
      "pending-only org: reps.volumeFallback = true",
      result.performers.reps.volumeFallback === true,
    );

    // Sanity: the existing seeded org (which has decisions) should NOT be in
    // fallback mode for customers. Guards against accidentally setting the
    // flag on every result.
    const seededResult = await getFunnel(ctx.org.id, {}, null);
    assert(
      "seeded org with decisions: customers.volumeFallback = false",
      seededResult.performers.customers.volumeFallback === false,
    );
  }

  // ── 12. Task #723 — markQuoteOutcome service ──────────────────────────────
  // Reps need an inline "mark as won/lost" affordance on the pending list.
  // The service must flip status, write a manual_won/manual_lost event, and
  // be idempotent on already-terminal rows.
  console.log("\n── 12. markQuoteOutcome service ──");
  {
    const ts = Date.now();
    const [markOrg] = await db
      .insert(organizations)
      .values({ name: `Mark Org ${ts}`, slug: `mark-org-${ts}` })
      .returning();
    orgIdsToCleanup.push(markOrg.id);

    const [markRep] = await db
      .insert(quoteReps)
      .values({ organizationId: markOrg.id, name: "Mark Rep", isPrimary: true, userId: null })
      .returning();
    const [markCust] = await db
      .insert(quoteCustomers)
      .values({ organizationId: markOrg.id, name: "Mark Cust", partyType: "customer" })
      .returning();
    const [markReason] = await db
      .insert(quoteOutcomeReasons)
      .values({ organizationId: markOrg.id, code: "lost_price", label: "Price too high", category: "lost" })
      .returning();

    const baseRow = {
      organizationId: markOrg.id,
      customerId: markCust.id,
      repId: markRep.id,
      originCity: "Dallas", originState: "TX",
      destCity: "Atlanta", destState: "GA",
      equipment: "Van",
      requestDate: new Date(),
      outcomeStatus: "pending" as const,
      quotedAmount: "1500",
      source: "email" as const,
    };
    const [pendingOpp1, pendingOpp2, alreadyTerminalOpp] = await db
      .insert(quoteOpportunities)
      .values([baseRow, baseRow, { ...baseRow, outcomeStatus: "won" }])
      .returning();

    // 12a. Pending → won writes a manual_won event.
    const wonResult = await markQuoteOutcome(markOrg.id, pendingOpp1.id, "won", null, "rep@example.com");
    assert("12a: markQuoteOutcome won returns updated", wonResult.status === "updated", `got ${wonResult.status}`);
    assert("12a: outcomeStatus echoed in result", wonResult.outcomeStatus === "won");

    const [reloadedWon] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, pendingOpp1.id)).limit(1);
    assert("12a: row outcomeStatus = won in DB", reloadedWon.outcomeStatus === "won", `got ${reloadedWon.outcomeStatus}`);

    const wonEvents = await db.select().from(quoteEvents)
      .where(and(eq(quoteEvents.quoteId, pendingOpp1.id), eq(quoteEvents.eventType, "manual_won")));
    assert("12a: exactly one manual_won event written", wonEvents.length === 1, `got ${wonEvents.length}`);
    assert("12a: event actor recorded", wonEvents[0]?.actor === "rep@example.com");

    // 12b. Pending → lost_price with a reason writes manual_lost + records reason.
    const lostResult = await markQuoteOutcome(markOrg.id, pendingOpp2.id, "lost_price", markReason.id, "rep@example.com");
    assert("12b: markQuoteOutcome lost_price returns updated", lostResult.status === "updated");

    const [reloadedLost] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, pendingOpp2.id)).limit(1);
    assert("12b: row outcomeStatus = lost_price", reloadedLost.outcomeStatus === "lost_price");
    assert("12b: outcomeReasonId persisted on row", reloadedLost.outcomeReasonId === markReason.id, `got ${reloadedLost.outcomeReasonId}`);

    const lostEvents = await db.select().from(quoteEvents)
      .where(and(eq(quoteEvents.quoteId, pendingOpp2.id), eq(quoteEvents.eventType, "manual_lost")));
    assert("12b: exactly one manual_lost event written", lostEvents.length === 1, `got ${lostEvents.length}`);

    // 12c. Idempotent on already-terminal — no overwrite, no second event.
    const idempotent = await markQuoteOutcome(markOrg.id, alreadyTerminalOpp.id, "lost_price", markReason.id, "rep@example.com");
    assert("12c: already-terminal returns 'already_terminal'", idempotent.status === "already_terminal", `got ${idempotent.status}`);
    const [stillWon] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, alreadyTerminalOpp.id)).limit(1);
    assert("12c: terminal row not overwritten", stillWon.outcomeStatus === "won", `got ${stillWon.outcomeStatus}`);
    const overwriteEvents = await db.select().from(quoteEvents)
      .where(eq(quoteEvents.quoteId, alreadyTerminalOpp.id));
    assert("12c: no event written for already-terminal row", overwriteEvents.length === 0, `got ${overwriteEvents.length}`);

    // 12d. Re-marking a now-won row is also a no-op (full idempotency).
    const reMark = await markQuoteOutcome(markOrg.id, pendingOpp1.id, "won", null, "rep@example.com");
    assert("12d: re-marking a won row returns 'already_terminal'", reMark.status === "already_terminal");
    const wonEventsAfter = await db.select().from(quoteEvents)
      .where(and(eq(quoteEvents.quoteId, pendingOpp1.id), eq(quoteEvents.eventType, "manual_won")));
    assert("12d: still exactly one manual_won event after re-mark", wonEventsAfter.length === 1, `got ${wonEventsAfter.length}`);

    // 12e. Cross-org isolation — wrong org id MUST return not_found.
    const otherOrgResult = await markQuoteOutcome(ctx.org.id, pendingOpp2.id, "won", null, "rep@example.com");
    assert("12e: cross-org markQuoteOutcome returns not_found", otherOrgResult.status === "not_found", `got ${otherOrgResult.status}`);

    // 12f. Per-rep scoping (Task #723 review fix). When the route enforces
    // a rep scope and the row belongs to a different rep, the service must
    // bail with status="forbidden" before any write — that's how the route
    // returns 403. Build a third rep + their own pending row, then try to
    // mark a row that doesn't belong to them.
    const [otherRep] = await db.insert(quoteReps)
      .values({ organizationId: markOrg.id, name: "Other Rep", isPrimary: false, userId: null })
      .returning();
    const [otherRepOpp] = await db.insert(quoteOpportunities)
      .values({ ...baseRow, repId: otherRep.id })
      .returning();
    const scopedToOther = await markQuoteOutcome(
      markOrg.id, otherRepOpp.id, "won", null, "scoped@example.com",
      { enforceRepScope: markRep.id },
    );
    assert("12f: cross-rep scoped mark returns 'forbidden'",
      scopedToOther.status === "forbidden", `got ${scopedToOther.status}`);
    const [stillPending] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, otherRepOpp.id)).limit(1);
    assert("12f: forbidden bail does NOT mutate the row",
      stillPending.outcomeStatus === "pending", `got ${stillPending.outcomeStatus}`);
    const noEvents = await db.select().from(quoteEvents)
      .where(eq(quoteEvents.quoteId, otherRepOpp.id));
    assert("12f: forbidden bail writes no event",
      noEvents.length === 0, `got ${noEvents.length}`);

    // 12f.2. Same scope, scoped user marking their *own* row works.
    const ownRepOpp = await db.insert(quoteOpportunities)
      .values({ ...baseRow, repId: markRep.id })
      .returning();
    const scopedToOwn = await markQuoteOutcome(
      markOrg.id, ownRepOpp[0].id, "won", null, "scoped@example.com",
      { enforceRepScope: markRep.id },
    );
    assert("12f: in-scope mark on own row returns 'updated'",
      scopedToOwn.status === "updated", `got ${scopedToOwn.status}`);

    // 12g. Lost-status reason auto-resolution (Task #723 review fix). When
    // the caller passes outcomeReasonId=null with a lost_* status, the
    // service must auto-resolve to a canonical LOST_* reason row so the
    // "Why we lose" breakdown gets a real bucket instead of "Reason not set".
    // We test all four canonical mappings + verify the reason row's code
    // matches the LOST_* constant exported from quoteEmailIngestion.
    const autoResolveCases: Array<{ status: "lost_price" | "lost_service" | "lost_timing" | "lost_incumbent"; expectedCode: string }> = [
      { status: "lost_price", expectedCode: "lost_price" },
      { status: "lost_service", expectedCode: "lost_service" },
      { status: "lost_timing", expectedCode: "lost_timing" },
      { status: "lost_incumbent", expectedCode: "lost_incumbent" },
    ];
    for (const tc of autoResolveCases) {
      const [opp] = await db.insert(quoteOpportunities).values(baseRow).returning();
      const result = await markQuoteOutcome(markOrg.id, opp.id, tc.status, null, "auto@example.com");
      assert(`12g: ${tc.status} with null reasonId returns 'updated'`,
        result.status === "updated", `got ${result.status}`);
      assert(`12g: ${tc.status} echoes resolved outcomeReasonId`,
        typeof result.outcomeReasonId === "string" && result.outcomeReasonId !== null,
        `got ${result.outcomeReasonId}`);
      const [row] = await db.select().from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, opp.id)).limit(1);
      assert(`12g: ${tc.status} row outcomeReasonId is non-null`,
        row.outcomeReasonId !== null, `got ${row.outcomeReasonId}`);
      const [reasonRow] = await db.select().from(quoteOutcomeReasons)
        .where(eq(quoteOutcomeReasons.id, row.outcomeReasonId!)).limit(1);
      assert(`12g: ${tc.status} resolves to canonical code "${tc.expectedCode}"`,
        reasonRow?.code === tc.expectedCode, `got ${reasonRow?.code}`);
      assert(`12g: ${tc.status} reason row scoped to org`,
        reasonRow?.organizationId === markOrg.id, `got ${reasonRow?.organizationId}`);
    }

    // 12g.2. no_response is *not* a lost_* status — null reasonId stays null
    // (no_response has its own funnel stage, no canonical reason needed).
    const [noRespOpp] = await db.insert(quoteOpportunities).values(baseRow).returning();
    const noRespResult = await markQuoteOutcome(markOrg.id, noRespOpp.id, "no_response", null, "auto@example.com");
    assert("12g.2: no_response returns 'updated'", noRespResult.status === "updated");
    const [noRespRow] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, noRespOpp.id)).limit(1);
    assert("12g.2: no_response row outcomeReasonId remains null",
      noRespRow.outcomeReasonId === null, `got ${noRespRow.outcomeReasonId}`);

    // 12h. Invalid outcomeReasonId returns 'invalid_reason' instead of
    // silently writing a dangling FK or 500ing.
    const [bogusOpp] = await db.insert(quoteOpportunities).values(baseRow).returning();
    const bogusResult = await markQuoteOutcome(
      markOrg.id, bogusOpp.id, "lost_price",
      "00000000-0000-0000-0000-000000000000", "auto@example.com",
    );
    assert("12h: bogus reasonId returns 'invalid_reason'",
      bogusResult.status === "invalid_reason", `got ${bogusResult.status}`);
    const [bogusReloaded] = await db.select().from(quoteOpportunities)
      .where(eq(quoteOpportunities.id, bogusOpp.id)).limit(1);
    assert("12h: invalid_reason bail does NOT mutate the row",
      bogusReloaded.outcomeStatus === "pending", `got ${bogusReloaded.outcomeStatus}`);

    // 12h.2. Cross-org reasonId — passing a reason that exists but in a
    // different org must also be rejected (otherwise it's a tenant-isolation
    // hole). Use ctx.org's reason set vs markOrg's row.
    const [otherOrgReason] = await db.select().from(quoteOutcomeReasons)
      .where(eq(quoteOutcomeReasons.organizationId, ctx.org.id)).limit(1);
    if (otherOrgReason) {
      const [crossOrgOpp] = await db.insert(quoteOpportunities).values(baseRow).returning();
      const crossOrgResult = await markQuoteOutcome(
        markOrg.id, crossOrgOpp.id, "lost_price", otherOrgReason.id, "auto@example.com",
      );
      assert("12h.2: cross-org reasonId rejected as 'invalid_reason'",
        crossOrgResult.status === "invalid_reason", `got ${crossOrgResult.status}`);
    }
  }

  // ── 13. Task #752 — Freight Capture rep audit + suppression ────────────
  // Covers the new admin surface end-to-end at the service layer:
  //   13a — pure status classifier + funnel-eligibility predicate
  //   13b — getFreightCaptureRepAudit returns a row per rep with the
  //         right status/quote count and a sane summary
  //   13c — `suppressed=true` removes a rep from snapshot.reps and
  //         performers.reps, but the rep's quotes still feed stage totals
  //   13d — linkRepToUser flips status from "wrong_role" to "ok"
  //   13e — mergeReps reassigns quotes and deletes the source rep
  console.log("\n── 13. Freight Capture rep audit (Task #752) ──");
  {
    // 13a — pure helpers, no DB needed.
    assert(
      "13a: classifyRepAuditStatus(suppressed) → 'suppressed'",
      classifyRepAuditStatus({ linkedUserRole: "account_manager", suppressed: true, hasLinkedUser: true }) === "suppressed",
    );
    assert(
      "13a: classifyRepAuditStatus(unlinked) → 'unlinked'",
      classifyRepAuditStatus({ linkedUserRole: null, suppressed: false, hasLinkedUser: false }) === "unlinked",
    );
    assert(
      "13a: classifyRepAuditStatus(linked + AM role) → 'ok'",
      classifyRepAuditStatus({ linkedUserRole: "account_manager", suppressed: false, hasLinkedUser: true }) === "ok",
    );
    assert(
      "13a: classifyRepAuditStatus(linked + admin role) → 'wrong_role'",
      classifyRepAuditStatus({ linkedUserRole: "admin", suppressed: false, hasLinkedUser: true }) === "wrong_role",
    );
    assert(
      "13a: isFunnelEligibleRep(suppressed AM) === false",
      isFunnelEligibleRep({ linkedUserRole: "account_manager", suppressed: true }) === false,
    );
    assert(
      "13a: isFunnelEligibleRep(unlinked) === false",
      isFunnelEligibleRep({ linkedUserRole: null, suppressed: false }) === false,
    );
    assert(
      "13a: isFunnelEligibleRep(linked AM, not suppressed) === true",
      isFunnelEligibleRep({ linkedUserRole: "account_manager", suppressed: false }) === true,
    );

    assert(
      "13a: REP_AUDIT_LOOKBACK_DAYS = 90",
      REP_AUDIT_LOOKBACK_DAYS === 90,
    );

    // 13b/c/d/e — seed a fresh org so we can mutate freely.
    const ts = Date.now();
    const [org13] = await db
      .insert(organizations)
      .values({ name: `Rep Audit ${ts}`, slug: `rep-audit-${ts}` })
      .returning();
    orgIdsToCleanup.push(org13.id);

    const [amU, adminU, otherAmU] = await db
      .insert(users)
      .values([
        { organizationId: org13.id, name: "Audit AM",       username: `audit-am-${ts}@x.com`,    role: "account_manager", password: "x", managerId: null },
        { organizationId: org13.id, name: "Audit Admin",    username: `audit-adm-${ts}@x.com`,   role: "admin",           password: "x", managerId: null },
        { organizationId: org13.id, name: "Audit AM Other", username: `audit-am2-${ts}@x.com`,   role: "account_manager", password: "x", managerId: null },
      ])
      .returning();

    // Three reps:
    //  - repOk     → linked to an AM (status=ok)
    //  - repWrong  → linked to admin (status=wrong_role)
    //  - repUn     → unlinked (status=unlinked)
    // Suppression is exercised in 13c by flipping repOk.
    const [repOk, repWrong, repUn] = await db
      .insert(quoteReps)
      .values([
        { organizationId: org13.id, name: "Rep OK",      userId: amU.id },
        { organizationId: org13.id, name: "Rep Wrong",   userId: adminU.id },
        { organizationId: org13.id, name: "Rep Unliked", userId: null },
      ])
      .returning();

    const [cust13] = await db
      .insert(quoteCustomers)
      .values({ organizationId: org13.id, name: "Acme 13", partyType: "customer" })
      .returning();

    // Recent quotes (well within 90d window) — 2 for repOk, 3 for repWrong,
    // 1 for repUn. quoteCount in 13b is asserted against these.
    const now = new Date();
    await db.insert(quoteOpportunities).values([
      { organizationId: org13.id, customerId: cust13.id, repId: repOk.id, requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1000", outcomeStatus: "won", carrierPaid: "800" },
      { organizationId: org13.id, customerId: cust13.id, repId: repOk.id, requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1100", outcomeStatus: "lost_price" },
      { organizationId: org13.id, customerId: cust13.id, repId: repWrong.id, requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1200", outcomeStatus: "won", carrierPaid: "900" },
      { organizationId: org13.id, customerId: cust13.id, repId: repWrong.id, requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1300", outcomeStatus: "won", carrierPaid: "950" },
      { organizationId: org13.id, customerId: cust13.id, repId: repWrong.id, requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1400", outcomeStatus: "lost_price" },
      { organizationId: org13.id, customerId: cust13.id, repId: repUn.id,    requestDate: now, equipment: "Van", originCity: "Dallas", originState: "TX", destCity: "Atlanta", destState: "GA", quotedAmount: "1500", outcomeStatus: "lost_price" },
    ]);

    // 13b — getFreightCaptureRepAudit happy path.
    const audit = await getFreightCaptureRepAudit(org13.id);
    const byName = new Map(audit.rows.map(r => [r.name, r]));
    assert(
      "13b: audit returns one row per rep with quotes in window",
      audit.rows.length === 3 && byName.has("Rep OK") && byName.has("Rep Wrong") && byName.has("Rep Unliked"),
      `got ${audit.rows.map(r => r.name).join(", ")}`,
    );
    assert(
      "13b: Rep OK status === 'ok' with quoteCount=2",
      byName.get("Rep OK")?.status === "ok" && byName.get("Rep OK")?.quoteCount === 2,
      `got status=${byName.get("Rep OK")?.status} count=${byName.get("Rep OK")?.quoteCount}`,
    );
    assert(
      "13b: Rep Wrong status === 'wrong_role' with quoteCount=3",
      byName.get("Rep Wrong")?.status === "wrong_role" && byName.get("Rep Wrong")?.quoteCount === 3,
      `got status=${byName.get("Rep Wrong")?.status} count=${byName.get("Rep Wrong")?.quoteCount}`,
    );
    assert(
      "13b: Rep Unliked status === 'unlinked' with quoteCount=1",
      byName.get("Rep Unliked")?.status === "unlinked" && byName.get("Rep Unliked")?.quoteCount === 1,
      `got status=${byName.get("Rep Unliked")?.status} count=${byName.get("Rep Unliked")?.quoteCount}`,
    );
    assert(
      "13b: summary counts match per-row tallies",
      audit.summary.total === 3 && audit.summary.ok === 1 && audit.summary.wrongRole === 1 && audit.summary.unlinked === 1 && audit.summary.suppressed === 0,
      JSON.stringify(audit.summary),
    );
    // Sort: actionable buckets (wrong_role, unlinked) come before ok.
    assert(
      "13b: rows sorted with actionable items first",
      audit.rows[0].status !== "ok",
      `first row status was ${audit.rows[0].status}`,
    );

    // 13c — Suppressing the only customer-facing rep removes it from
    // snapshot.reps + performers.reps but leaves stage totals intact.
    const snapBefore = await getSnapshot(org13.id, {});
    assert(
      "13c: pre-suppress snapshot.reps includes Rep OK",
      snapBefore.reps.some(r => r.name === "Rep OK"),
      `got ${snapBefore.reps.map(r => r.name).join(", ")}`,
    );

    const supRes = await setRepSuppressed(org13.id, repOk.id, true);
    assert("13c: setRepSuppressed returns ok", supRes.status === "ok", JSON.stringify(supRes));

    const snapAfter = await getSnapshot(org13.id, {});
    assert(
      "13c: post-suppress snapshot.reps EXCLUDES Rep OK",
      !snapAfter.reps.some(r => r.name === "Rep OK"),
      `got ${snapAfter.reps.map(r => r.name).join(", ")}`,
    );
    const funnelAfter = await getFunnel(org13.id, {}, null);
    const funnelLabels = [
      ...funnelAfter.performers.reps.best,
      ...funnelAfter.performers.reps.worst,
    ].map(r => r.label);
    assert(
      "13c: post-suppress performers.reps EXCLUDES Rep OK",
      !funnelLabels.includes("Rep OK"),
      `got ${funnelLabels.join(", ")}`,
    );
    // Task #1042 / #1048 — stage totals reflect the rep-role gate. After
    // suppressing Rep OK, only Rep Unliked (null user_id, accepted by
    // `isCustomerFacingQuoteRep`) remains visible. Rep Wrong (admin role)
    // is excluded by the universe filter. So received=1, won=0.
    // (Pre-#1042 expectation was 6/3 — updated to match production.)
    assert(
      "13c: stage totals reflect Task #1042 rep-role gate (only unsuppressed visible reps)",
      funnelAfter.summary.totalReceived === 1 && funnelAfter.summary.totalWon === 0,
      `received=${funnelAfter.summary.totalReceived} won=${funnelAfter.summary.totalWon}`,
    );

    // 13c.2 — audit row reports status='suppressed' after the flip.
    const audit2 = await getFreightCaptureRepAudit(org13.id);
    assert(
      "13c: audit row for Rep OK now status === 'suppressed'",
      audit2.rows.find(r => r.name === "Rep OK")?.status === "suppressed",
    );

    // 13d — linkRepToUser flips Rep Wrong from wrong_role → ok by linking
    // it to a customer-facing user. Also exercise the "user must be in
    // org" guard and the "no two reps to one user" conflict.
    const linkRes = await linkRepToUser(org13.id, repWrong.id, otherAmU.id);
    assert("13d: linkRepToUser to AM returns ok", linkRes.status === "ok", JSON.stringify(linkRes));

    const audit3 = await getFreightCaptureRepAudit(org13.id);
    assert(
      "13d: post-link Rep Wrong status === 'ok'",
      audit3.rows.find(r => r.name === "Rep Wrong")?.status === "ok",
    );

    const conflictRes = await linkRepToUser(org13.id, repUn.id, otherAmU.id);
    assert(
      "13d: linking a second rep to the same user returns invalid",
      conflictRes.status === "invalid",
      JSON.stringify(conflictRes),
    );

    const notFoundRes = await linkRepToUser(org13.id, "00000000-0000-0000-0000-000000000000", otherAmU.id);
    assert(
      "13d: link with bogus repId returns not_found",
      notFoundRes.status === "not_found",
    );

    // 13d.2 — searchOrgUsers basic behaviour (used by the link dropdown).
    const searched = await searchOrgUsers(org13.id, "audit-am2");
    assert(
      "13d: searchOrgUsers filters by username substring",
      searched.length === 1 && searched[0].id === otherAmU.id,
      `got ${searched.map(s => s.username).join(", ")}`,
    );

    // 13e — mergeReps moves quotes from source → target and deletes source.
    // Pre-state: Rep Unliked has 1 quote, Rep OK has 2 quotes.
    const mergeRes = await mergeReps(org13.id, repUn.id, repOk.id);
    assert(
      "13e: mergeReps returns ok with reassigned=1",
      mergeRes.status === "ok" && (mergeRes as { reassigned?: number }).reassigned === 1,
      JSON.stringify(mergeRes),
    );
    const remaining = await db.select({ id: quoteReps.id })
      .from(quoteReps)
      .where(and(eq(quoteReps.organizationId, org13.id), eq(quoteReps.id, repUn.id)));
    assert(
      "13e: source rep deleted after merge",
      remaining.length === 0,
    );
    const repOkQuotes = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, org13.id),
        eq(quoteOpportunities.repId, repOk.id),
      ));
    assert(
      "13e: target rep absorbed source's quote (now has 3)",
      repOkQuotes.length === 3,
      `got ${repOkQuotes.length}`,
    );

    const sameRes = await mergeReps(org13.id, repOk.id, repOk.id);
    assert(
      "13e: mergeReps with source === target returns invalid",
      sameRes.status === "invalid",
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
