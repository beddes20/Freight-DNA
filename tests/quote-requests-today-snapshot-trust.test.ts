/**
 * Quote Requests "Today" snapshot trust — regression coverage.
 *
 * BACKGROUND (May 2026 trust regression):
 *   The Quote Requests page on age=today was reported showing
 *   "0 open requests / 0 auto-captured today" while inbound quote-request
 *   emails were known to be arriving. End-to-end investigation found:
 *
 *     - Ingestion (3,351 inbound emails today) — HEALTHY
 *     - Classification (930 quote_opportunities today) — HEALTHY
 *     - Customer-only chokepoint left 500 surviving rows (86 pending) — HEALTHY
 *     - getSnapshot() called directly returned pending=86, autoCapturedToday=500
 *     - The /api/customer-quotes/snapshot HTTP route returned the same numbers
 *
 *   Root cause was operational, not code: today's first quote_opportunity
 *   was not created until 13:40 UTC (≈9:40am ET) because the email→opp
 *   pipeline runs in 2-minute batches and back-loaded the morning's mail
 *   in a 14:00 UTC burst. Anyone who checked the page before 9:40am ET
 *   correctly saw 0/0.
 *
 * WHAT THIS TEST PINS DOWN:
 *   The capture+display contract that, IF the database holds today's
 *   email-sourced opportunities tagged party_type=customer with a name
 *   that doesn't match the carrier-token regex, then getSnapshot must
 *   surface them in BOTH `kpis.pending` (when outcome_status='pending')
 *   AND `kpis.autoCapturedToday`. A future refactor that drops today's
 *   data from either field — for any reason (bad applyFilters predicate,
 *   chokepoint over-filter, dayStart timezone slip, source-tag mismatch)
 *   — will fail this test with a clear diff.
 *
 * The test seeds an isolated org so it's deterministic and parallel-safe
 * with respect to live tenant data.
 *
 * Run with: npx tsx tests/quote-requests-today-snapshot-trust.test.ts
 *
 * Requires DATABASE_URL.
 */

import { db } from "../server/storage";
import {
  organizations, users,
  quoteCustomers, quoteOpportunities,
} from "../shared/schema";
import { eq } from "drizzle-orm";
import { getSnapshot } from "../server/services/customerQuotes";

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
    await db.delete(quoteOpportunities).where(eq(quoteOpportunities.organizationId, orgId));
    await db.delete(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
}

async function seedOrgWithTodayEmailOpps() {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Snapshot Trust ${ts}`, slug: `snapshot-trust-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);

  // One non-customer-facing user is enough; getSnapshot doesn't need a rep
  // mapping when the filter doesn't pass mineOnly.
  await db.insert(users).values({
    organizationId: org.id,
    name: "Admin",
    username: `admin-${ts}@example.com`,
    role: "admin",
    password: "x",
    managerId: null,
  });

  // Four customers:
  //   custA, custB, custC — party_type='customer' with NON-carrier-token
  //   names. The chokepoint must keep all three.
  //   custCarrierToken — party_type='customer' but the NAME contains a
  //   carrier token ("Logistics"), so the runtime chokepoint regex in
  //   server/services/customerOnlyChokepoint.ts must DROP it from every
  //   customer-only surface, including kpis.autoCapturedToday and
  //   kpis.pending. This pins the regex's role inside the contract.
  const [custA, custB, custC, custCarrierToken] = await db
    .insert(quoteCustomers)
    .values([
      { organizationId: org.id, name: "Acme Foods", partyType: "customer" },
      { organizationId: org.id, name: "Globex Industries", partyType: "customer" },
      { organizationId: org.id, name: "Initech Manufacturing", partyType: "customer" },
      // party_type stale-mislabeled — real signal is the carrier-token
      // suffix. Note the SPACE before "Logistics" — the chokepoint regex
      // requires a word boundary, so concatenated names like
      // "Pumalogistics" intentionally slip through (this is documented
      // behavior in customerNameResolver.ts CARRIER_TOKEN_RE).
      { organizationId: org.id, name: "Puma Logistics LLC", partyType: "customer" },
    ])
    .returning();

  // Today's instant in UTC (matches getSnapshot's dayStart computation
  // when run on a UTC-tz server, which is the prod / Replit case).
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  // Pick a request_date that's safely "today" in BOTH UTC and local TZ.
  const earlyToday = new Date(todayMid.getTime() + 60 * 60 * 1000); // +1h
  const midToday = new Date(todayMid.getTime() + 6 * 60 * 60 * 1000); // +6h
  const lateToday = new Date(todayMid.getTime() + 12 * 60 * 60 * 1000); // +12h

  // Seed shape:
  //   5 email-sourced opps with request_date=today (THE ONES THAT MATTER):
  //     - 3 pending  (outcome_status='pending')
  //     - 1 won
  //     - 1 lost
  //   1 email-sourced opp dated yesterday (must NOT count toward
  //     autoCapturedToday).
  //   1 manual-source opp dated today (must NOT count toward
  //     autoCapturedToday — wrong source).
  const dayMs = 24 * 60 * 60 * 1000;
  const yesterday = new Date(midToday.getTime() - dayMs);

  const baseEmail = (
    customerId: string,
    requestDate: Date,
    outcome: "pending" | "won" | "lost",
  ) => ({
    organizationId: org.id,
    customerId,
    requestDate,
    originCity: "Atlanta",
    originState: "GA",
    destCity: "Dallas",
    destState: "TX",
    equipment: "Dry Van",
    source: "email" as const,
    outcomeStatus: outcome,
    quotedAmount: outcome === "won" ? "1500.00" : null,
    carrierPaid: outcome === "won" ? "1200.00" : null,
  });

  await db.insert(quoteOpportunities).values([
    baseEmail(custA.id, earlyToday, "pending"),
    baseEmail(custA.id, midToday, "pending"),
    baseEmail(custB.id, midToday, "pending"),
    baseEmail(custB.id, lateToday, "won"),
    baseEmail(custC.id, lateToday, "lost"),
    // Yesterday — should drop from autoCapturedToday but stay in total when
    // the snapshot window includes it.
    baseEmail(custC.id, yesterday, "pending"),
    // Manual-source today — should drop from autoCapturedToday.
    {
      ...baseEmail(custA.id, midToday, "pending"),
      source: "manual",
    },
    // Today email opp on the carrier-token customer — must be DROPPED by
    // the runtime chokepoint regex (CARRIER_TOKEN_RE matches "Logistics")
    // so it must NOT count toward kpis.autoCapturedToday or kpis.pending
    // even though party_type='customer'.
    baseEmail(custCarrierToken.id, midToday, "pending"),
    baseEmail(custCarrierToken.id, midToday, "pending"),
  ]);

  return { org, todayMid };
}

async function main() {
  console.log("\n=== Quote Requests 'Today' snapshot trust — regression test ===\n");
  console.log("Seeds 5 email-sourced opps dated today (3 pending, 1 won, 1 lost),");
  console.log("plus 3 decoys: 1 yesterday email-opp, 1 today manual-source opp,");
  console.log("and 2 today email-opps on a carrier-token-named customer (chokepoint).\n");

  const { org, todayMid } = await seedOrgWithTodayEmailOpps();
  console.log(`Seeded org: ${org.id}\n`);

  // Window = today midnight → now, mirroring what the page sends for age=today.
  const filters = {
    startDate: todayMid.toISOString(),
    endDate: new Date().toISOString(),
  };

  const snap = await getSnapshot(org.id, filters as any);

  console.log("getSnapshot returned:");
  console.log(`  total            : ${snap.kpis.total}`);
  console.log(`  pending          : ${snap.kpis.pending}`);
  console.log(`  won              : ${snap.kpis.won}`);
  console.log(`  lost             : ${snap.kpis.lost}`);
  console.log(`  autoCapturedToday: ${snap.kpis.autoCapturedToday}\n`);

  // ── 1. The page's "Open requests" tile must NOT show 0 when DB has pending ──
  assert(
    "kpis.pending > 0 when today has pending email-sourced opps",
    snap.kpis.pending > 0,
    `expected pending > 0, got ${snap.kpis.pending}`,
  );
  // pending counts ALL pending opps in the window regardless of source
  // (3 today email pending + 1 today manual pending = 4).
  assert(
    "kpis.pending === 4 (3 today email pending + 1 today manual pending)",
    snap.kpis.pending === 4,
    `expected 4, got ${snap.kpis.pending}`,
  );

  // ── 2. The page's "Auto-captured today" tile must reflect ALL email-sourced ──
  // opps with request_date>=today, regardless of outcome_status.
  assert(
    "kpis.autoCapturedToday > 0 when today has email-sourced opps",
    snap.kpis.autoCapturedToday > 0,
    `expected autoCapturedToday > 0, got ${snap.kpis.autoCapturedToday}`,
  );
  assert(
    "kpis.autoCapturedToday === 5 (3 pending + 1 won + 1 lost, all email-sourced today)",
    snap.kpis.autoCapturedToday === 5,
    `expected 5, got ${snap.kpis.autoCapturedToday}`,
  );

  // ── 3. The decoys must NOT pollute autoCapturedToday ──
  // Yesterday's email opp: out (date guard).
  // Today's manual opp: out (source guard).
  // Today's carrier-token customer email opps (x2): out (chokepoint guard).
  // If autoCapturedToday >= 6 one of the three guards has regressed.
  assert(
    "autoCapturedToday excludes yesterday + manual + carrier-token decoys",
    snap.kpis.autoCapturedToday === 5,
    `regression: count is ${snap.kpis.autoCapturedToday} (decoys leaked in)`,
  );

  // ── 3b. Carrier-token chokepoint must also drop those rows from pending ──
  // The chokepoint applies to BOTH applyFilters (for total/pending) and
  // the autoCapturedToday tally. With 3 today email pending + 1 today
  // manual pending + 2 today carrier-token pending all under the today
  // window, pending must be 4 (NOT 6) — the carrier-token rows are
  // suppressed by the runtime regex despite their stored party_type.
  assert(
    "kpis.pending excludes carrier-token-named customer's today opps",
    snap.kpis.pending === 4,
    `regression: pending=${snap.kpis.pending}; chokepoint may have stopped dropping carrier-token names`,
  );

  // ── 4. Won today shows up correctly ──
  assert(
    "kpis.won === 1 (the single won opp today)",
    snap.kpis.won === 1,
    `expected 1, got ${snap.kpis.won}`,
  );

  // ── 5. total within the today-window ──
  assert(
    "kpis.total === 6 (5 today email + 1 today manual; yesterday excluded by window)",
    snap.kpis.total === 6,
    `expected 6, got ${snap.kpis.total}`,
  );

  await cleanup();

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.error("\nFailures:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log("\n\u2713 All trust assertions passed.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
