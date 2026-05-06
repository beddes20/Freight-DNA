/**
 * Task #768 — Available Freight: always show ≥30 carriers.
 *
 * Locks in two regression points behind the detail-page UX fix:
 *
 *   1. The "Ranking carriers…" spinner can never spin indefinitely.
 *      The detail endpoint decides `rankingInFlight` from the audit
 *      log: any `lazy_shortlist_rank` row (success / zero / error)
 *      means the rank attempt has completed. We verify that
 *      `storage.appendFreightOpportunityAudit` + `listFreightOpportunityAudit`
 *      preserve `payload.kind` round-trip — that contract is what the
 *      route handler in `server/routes/proactiveOpportunities.ts`
 *      relies on (`audit.some(a => a.payload?.kind === "lazy_shortlist_rank")`).
 *
 *   2. The carrier-pool endpoint enforces a floor of 30 carriers (cap 50)
 *      whenever the org's eligible catalog is large enough. A small org
 *      with <30 eligible carriers gets all of them. We exercise the
 *      same slice formula the route uses against a real seeded org of
 *      35 active carriers, plus a degenerate org of 5 carriers, and
 *      pin the math for inputs at the boundary.
 *
 * Run with: npx tsx tests/freight-opps-spinner-pool.test.ts
 *
 * Prerequisites: DATABASE_URL must be set and the schema must be migrated.
 */

import { storage, db } from "../server/storage";
import {
  organizations,
  users,
  companies,
  carriers,
  freightOpportunities,
  freightOpportunityAudit,
} from "../shared/schema";
import { eq } from "drizzle-orm";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failed++;
  }
}

const orgIdsToCleanup: string[] = [];

async function seedOrg(suffix: string): Promise<{ id: string }> {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `768 ${suffix} ${ts}`, slug: `t768-${suffix.toLowerCase()}-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);
  return org;
}

async function seedCompany(orgId: string, suffix: string): Promise<{ id: string }> {
  const [c] = await db
    .insert(companies)
    .values({
      organizationId: orgId,
      name: `Acme ${suffix}`,
      industry: "logistics",
    })
    .returning();
  return c;
}

async function seedOpp(orgId: string, companyId: string): Promise<{ id: string }> {
  const [opp] = await db
    .insert(freightOpportunities)
    .values({
      orgId,
      companyId,
      mode: "exact_load",
      origin: "Macon, GA",
      originState: "GA",
      destination: "Atlanta, GA",
      destinationState: "GA",
      equipmentType: "DRY_VAN",
      pickupWindowStart: "2026-04-30",
      pickupWindowEnd: "2026-04-30",
      loadCount: 1,
      urgencyScore: 50,
      confidenceFlag: "normal",
      status: "new",
    })
    .returning();
  return opp;
}

async function seedCarrier(
  orgId: string,
  i: number,
  status: "active" | "inactive" | "do_not_use" | "flagged" = "active",
): Promise<{ id: string }> {
  const [c] = await db
    .insert(carriers)
    .values({
      orgId,
      name: `Carrier ${i}`,
      status,
      city: "Macon",
      state: "GA",
      statesServed: ["GA", "FL"],
      equipmentTypes: ["DRY_VAN"],
      primaryEmail: `c${i}@example.com`,
      phone: "555-0000",
    })
    .returning();
  return c;
}

async function cleanup(): Promise<void> {
  for (const orgId of orgIdsToCleanup) {
    // freight_opportunities cascade-deletes audit + foc rows on org delete.
    await db.delete(freightOpportunities).where(eq(freightOpportunities.orgId, orgId));
    await db.delete(carriers).where(eq(carriers.orgId, orgId));
    await db.delete(companies).where(eq(companies.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
}

// ── The same predicate the detail route uses to decide rankingInFlight. ──
function deriveRankingInFlight(
  carrierCount: number,
  audit: { payload: unknown }[],
): { rankAttempted: boolean; rankingInFlight: boolean } {
  const rankAttempted = audit.some(a => {
    const payload = a.payload as { kind?: string } | null;
    return payload?.kind === "lazy_shortlist_rank";
  });
  const rankingInFlight = carrierCount === 0 && !rankAttempted;
  return { rankAttempted, rankingInFlight };
}

// ── The exact slice formula the carrier-pool route uses. ──
const POOL_FLOOR = 30;
const POOL_CAP = 50;
function poolSliceLen(scoredLen: number): number {
  return Math.max(POOL_FLOOR, Math.min(POOL_CAP, scoredLen));
}

(async () => {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Task #768 — Available Freight ≥30 carriers / spinner audit");
  console.log("══════════════════════════════════════════════════════════════");

  try {
    // ── 1. Spinner never spins forever once a rank attempt is recorded ────────
    console.log("\n── 1. lazy_shortlist_rank audit gate ──");
    const orgA = await seedOrg("A");
    const compA = await seedCompany(orgA.id, "A");
    const oppA = await seedOpp(orgA.id, compA.id);

    // Empty shortlist + no audit row => spinner WOULD start (rankingInFlight=true)
    {
      const audit = await storage.listFreightOpportunityAudit(oppA.id);
      const { rankAttempted, rankingInFlight } = deriveRankingInFlight(0, audit);
      assert("fresh opp has no audit rows", audit.length === 0);
      assert("fresh opp + zero carriers ⇒ rankAttempted=false", rankAttempted === false);
      assert("fresh opp + zero carriers ⇒ rankingInFlight=true (spinner kicks rank)", rankingInFlight === true);
    }

    // Append a successful zero-result audit row (the case that previously made
    // the spinner spin forever — the ranker completed but persisted nothing).
    await storage.appendFreightOpportunityAudit({
      opportunityId: oppA.id,
      eventType: "generated",
      actorUserId: null,
      payload: { kind: "lazy_shortlist_rank", result: "zero" },
    });
    {
      const audit = await storage.listFreightOpportunityAudit(oppA.id);
      const { rankAttempted, rankingInFlight } = deriveRankingInFlight(0, audit);
      assert("audit row persisted", audit.length === 1);
      assert(
        "zero-result audit row's payload.kind === lazy_shortlist_rank",
        (audit[0].payload as { kind?: string }).kind === "lazy_shortlist_rank",
      );
      assert("after zero-result audit ⇒ rankAttempted=true", rankAttempted === true);
      assert(
        "after zero-result audit + zero carriers ⇒ rankingInFlight=false (spinner stops)",
        rankingInFlight === false,
      );
    }

    // Error-result audit row (written by runOrJoinRank's catch block) also
    // counts — a thrown rank must not make the spinner loop.
    const oppA2 = await seedOpp(orgA.id, compA.id);
    await storage.appendFreightOpportunityAudit({
      opportunityId: oppA2.id,
      eventType: "generated",
      actorUserId: null,
      payload: { kind: "lazy_shortlist_rank", result: "error", error: "ranker timeout" },
    });
    {
      const audit = await storage.listFreightOpportunityAudit(oppA2.id);
      const { rankAttempted, rankingInFlight } = deriveRankingInFlight(0, audit);
      assert("error-result audit row also flips rankAttempted=true", rankAttempted === true);
      assert(
        "after error audit + zero carriers ⇒ rankingInFlight=false (no infinite spinner on rank failure)",
        rankingInFlight === false,
      );
    }

    // Audit rows of other kinds (e.g. snooze, manual edits) must NOT satisfy
    // the gate — only `lazy_shortlist_rank` payloads stop the spinner.
    const oppA3 = await seedOpp(orgA.id, compA.id);
    await storage.appendFreightOpportunityAudit({
      opportunityId: oppA3.id,
      eventType: "snoozed",
      actorUserId: null,
      payload: { kind: "snooze", until: "2026-05-01T00:00:00Z" },
    });
    {
      const audit = await storage.listFreightOpportunityAudit(oppA3.id);
      const { rankAttempted, rankingInFlight } = deriveRankingInFlight(0, audit);
      assert("non-rank audit kinds do NOT count as rankAttempted", rankAttempted === false);
      assert(
        "non-rank audit + zero carriers still triggers rankingInFlight=true",
        rankingInFlight === true,
      );
    }

    // Once any carriers exist, rankingInFlight is false regardless of audit.
    {
      const { rankingInFlight } = deriveRankingInFlight(5, []);
      assert("carriers > 0 ⇒ rankingInFlight=false even with no audit", rankingInFlight === false);
    }

    // ── 2. Pool slice formula ────────────────────────────────────────────────
    console.log("\n── 2. Carrier pool slice formula (floor=30, cap=50) ──");
    assert("0 scored ⇒ slice 30 (returns whatever exists, ≤30)", poolSliceLen(0) === 30);
    assert("5 scored ⇒ slice 30 (slice(0,30) on 5 items returns all 5)", poolSliceLen(5) === 30);
    assert("29 scored ⇒ slice 30", poolSliceLen(29) === 30);
    assert("30 scored ⇒ slice 30", poolSliceLen(30) === 30);
    assert("35 scored ⇒ slice 35 (above floor)", poolSliceLen(35) === 35);
    assert("50 scored ⇒ slice 50 (at cap)", poolSliceLen(50) === 50);
    assert("100 scored ⇒ slice 50 (capped)", poolSliceLen(100) === 50);

    // ── 3. Real seed: org with 35 active carriers returns ≥30 eligible ───────
    console.log("\n── 3. Real seed: 35 eligible carriers ⇒ pool ≥ 30 ──");
    const orgB = await seedOrg("B");
    const compB = await seedCompany(orgB.id, "B");
    await seedOpp(orgB.id, compB.id);
    for (let i = 0; i < 35; i++) await seedCarrier(orgB.id, i, "active");
    const orgBCarriers = await storage.getCarriers(orgB.id);
    const orgBEligible = orgBCarriers.filter(c => c.status !== "do_not_use" && c.status !== "inactive");
    assert("seeded 35 active carriers", orgBCarriers.length === 35);
    assert("all 35 are eligible (active, not do_not_use)", orgBEligible.length === 35);
    const orgBSlice = poolSliceLen(orgBEligible.length);
    assert("pool slice on 35-carrier org = 35 (≥ 30 floor)", orgBSlice === 35);
    assert("pool slice on 35-carrier org meets 30-carrier floor", orgBSlice >= 30);

    // ── 4. Real seed: org with only 5 carriers returns all 5 (no padding) ───
    console.log("\n── 4. Real seed: tiny org (5 carriers) returns whatever it has ──");
    const orgC = await seedOrg("C");
    const compC = await seedCompany(orgC.id, "C");
    await seedOpp(orgC.id, compC.id);
    for (let i = 0; i < 5; i++) await seedCarrier(orgC.id, i, "active");
    const orgCCarriers = await storage.getCarriers(orgC.id);
    const orgCEligible = orgCCarriers.filter(c => c.status !== "do_not_use" && c.status !== "inactive");
    assert("seeded 5 active carriers in tiny org", orgCEligible.length === 5);
    // poolSliceLen returns 30 but slice(0, 30) on a 5-element array yields 5 elements.
    const tinyTaken = Math.min(poolSliceLen(orgCEligible.length), orgCEligible.length);
    assert(
      "tiny org returns all 5 eligible carriers (no padding, no fewer)",
      tinyTaken === 5,
    );

    // ── 5. Status filter excludes inactive + do_not_use, keeps flagged ──────
    console.log("\n── 5. Pool filter: do_not_use + inactive excluded; flagged kept ──");
    const orgD = await seedOrg("D");
    const compD = await seedCompany(orgD.id, "D");
    await seedOpp(orgD.id, compD.id);
    for (let i = 0; i < 30; i++) await seedCarrier(orgD.id, i, "active");
    await seedCarrier(orgD.id, 30, "flagged");
    await seedCarrier(orgD.id, 31, "inactive");
    await seedCarrier(orgD.id, 32, "do_not_use");
    const orgDAll = await storage.getCarriers(orgD.id);
    const orgDEligible = orgDAll.filter(c => c.status !== "do_not_use" && c.status !== "inactive");
    assert("seeded 33 carriers total", orgDAll.length === 33);
    assert("eligible = 31 (30 active + 1 flagged); excludes inactive + do_not_use", orgDEligible.length === 31);
    assert("eligible pool ≥ 30 floor", orgDEligible.length >= 30);
    const orgDFlaggedKept = orgDEligible.some(c => c.status === "flagged");
    assert("flagged carriers remain in the pool (only de-prioritized via score)", orgDFlaggedKept === true);
  } catch (err) {
    console.error("Unexpected error:", err);
    failed++;
  } finally {
    await cleanup();
  }

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
})();
