/**
 * Task #1152 — Snoozed-row count visible without flipping the toggle.
 *
 * Pins the visibility logic for the "N snoozed hidden — show" hint that
 * renders next to the Include Snoozed toggle on /quote-requests.
 *
 * The hint reads `snapshot.kpis.snoozedHidden` and shows when:
 *   - includeSnoozed is OFF (default), AND
 *   - snoozedHidden > 0 (rows in scope are currently snoozed).
 *
 * This test pins the SERVER side of that contract — the only piece that
 * varies with data — by seeding three opps:
 *   (a) pending, not snoozed         → counted in pending, NOT in snoozedHidden
 *   (b) pending, snoozed (future)    → hidden by default; COUNTS in snoozedHidden
 *   (c) pending, snoozed-but-expired → already past now; NOT in snoozedHidden
 *
 * Then toggles `filters.includeSnoozed` and asserts:
 *   - default snapshot reports snoozedHidden=1 (only (b))
 *   - includeSnoozed:true snapshot reports snoozedHidden=0 (hint hides)
 *
 * Run with: npx tsx tests/quote-requests-snoozed-hidden-hint.test.ts
 * Requires DATABASE_URL.
 */

import { db } from "../server/storage";
import {
  organizations, users,
  quoteCustomers, quoteOpportunities,
} from "../shared/schema";
import { eq } from "drizzle-orm";
import { getSnapshot, type QuoteFilters } from "../server/services/customerQuotes";

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

async function seed() {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Snoozed Hint ${ts}`, slug: `snoozed-hint-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);

  await db.insert(users).values({
    organizationId: org.id,
    name: "Admin",
    username: `admin-${ts}@example.com`,
    role: "admin",
    password: "x",
    managerId: null,
  });

  // Customer name avoids carrier-token regex so the chokepoint keeps it.
  const [cust] = await db
    .insert(quoteCustomers)
    .values([{ organizationId: org.id, name: "Acme Foods", partyType: "customer" }])
    .returning();

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const requestDate = new Date(now - 60 * 60 * 1000); // 1h ago
  const futureSnooze = new Date(now + 2 * 60 * 60 * 1000); // +2h
  const pastSnooze = new Date(now - 60 * 60 * 1000); // -1h

  const base = {
    organizationId: org.id,
    customerId: cust.id,
    requestDate,
    originCity: "Atlanta",
    originState: "GA",
    destCity: "Dallas",
    destState: "TX",
    equipment: "Dry Van",
    source: "email" as const,
    outcomeStatus: "pending" as const,
    quotedAmount: null,
    carrierPaid: null,
  };

  await db.insert(quoteOpportunities).values([
    { ...base, snoozedUntil: null },          // (a) not snoozed
    { ...base, snoozedUntil: futureSnooze },   // (b) currently snoozed
    { ...base, snoozedUntil: pastSnooze },     // (c) snooze expired
  ]);

  return { org, requestDate, dayMs };
}

async function main() {
  console.log("\n=== Quote Requests — snoozed-hidden hint visibility ===\n");
  const { org, requestDate, dayMs } = await seed();

  const filters: QuoteFilters = {
    startDate: new Date(requestDate.getTime() - dayMs).toISOString(),
    endDate: new Date(Date.now() + dayMs).toISOString(),
  };

  // Default: includeSnoozed undefined/false → snoozedHidden should count (b)
  // and only (b). Active queue (pending) should be (a) + (c) = 2.
  const snapDefault = await getSnapshot(org.id, filters);
  console.log("Default snapshot (includeSnoozed=false):");
  console.log(`  pending       : ${snapDefault.kpis.pending}`);
  console.log(`  snoozedHidden : ${snapDefault.kpis.snoozedHidden}\n`);

  assert(
    "kpis.snoozedHidden === 1 when one in-scope row is currently snoozed",
    snapDefault.kpis.snoozedHidden === 1,
    `expected 1, got ${snapDefault.kpis.snoozedHidden}`,
  );
  assert(
    "kpis.pending === 2 — currently-snoozed row hidden, expired-snooze row visible",
    snapDefault.kpis.pending === 2,
    `expected 2, got ${snapDefault.kpis.pending}`,
  );

  // Flipped on: snoozedHidden must collapse to 0 (so the UI hint hides).
  const snapWithSnoozed = await getSnapshot(org.id, { ...filters, includeSnoozed: true });
  console.log("Snapshot with includeSnoozed=true:");
  console.log(`  pending       : ${snapWithSnoozed.kpis.pending}`);
  console.log(`  snoozedHidden : ${snapWithSnoozed.kpis.snoozedHidden}\n`);

  assert(
    "kpis.snoozedHidden === 0 when includeSnoozed is on (hint hides)",
    snapWithSnoozed.kpis.snoozedHidden === 0,
    `expected 0, got ${snapWithSnoozed.kpis.snoozedHidden}`,
  );
  assert(
    "kpis.pending === 3 when includeSnoozed is on — snoozed row no longer hidden",
    snapWithSnoozed.kpis.pending === 3,
    `expected 3, got ${snapWithSnoozed.kpis.pending}`,
  );

  await cleanup();

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.error("\nFailures:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log("\n\u2713 All snoozed-hidden hint assertions passed.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
