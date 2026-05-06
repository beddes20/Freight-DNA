/**
 * Hero Loop end-to-end runtime test (Task #1074).
 *
 * Walks a synthetic won quote through `createFreightOpportunityFromWonQuote`
 * — the convergence point that BOTH `createQuote` and `updateQuote` call
 * when a quote enters a won status — and asserts:
 *
 *   1. With a matching hero slice configured, the resulting
 *      `freight_opportunities` row is `status='ready_to_send'`,
 *      `delegatedToUserId=lmUserId`, `approvedAt!=null`,
 *      `awaitingApprovalSince=null`, and the source carries
 *      `sourceRef.type='won_quote'` so the LWQ aggregator counts it.
 *
 *   2. The default branch (no slice match) seeds the legacy
 *      `pending_approval` + `awaitingApprovalSince=now` shape so the
 *      NAM/AM popup gate is preserved for every customer outside the
 *      hero slice.
 *
 *   3. `buildOpenOppContextByLaneSig` reports `wonQuoteCount >= 1` for
 *      the matching lane signature so the LWQ row's "Active won" chip
 *      lights up for the LM.
 *
 * Section 1052 of `tests/code-quality-guardrails.test.ts` already locks
 * the static contract (matcher exports, converter wiring shape, LWQ chip
 * render). This file adds the runtime walk so a future change that
 * passes the static regex but breaks the actual SQL still fails loudly.
 *
 * Run with: npx tsx tests/hero-loop-email-to-load.test.ts
 *
 * Prerequisites: DATABASE_URL must point at a writable Postgres with the
 * schema migrated.
 */

import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { storage, db } from "../server/storage";
import {
  organizations,
  users,
  companies,
  quoteCustomers,
  quoteReps,
  quoteOpportunities,
  freightOpportunities,
  type QuoteOpportunity,
} from "../shared/schema";
import {
  createFreightOpportunityFromWonQuote,
  setAutoWonQuoteAfHandoffEnabled,
} from "../server/services/customerQuotes";
import {
  setHeroSlices,
  type HeroSliceConfig,
} from "../server/services/heroSliceAutoAssign";
import {
  buildOpenOppContextByLaneSig,
  laneSig,
} from "../server/laneCrossLinkService";

// ── Test bookkeeping ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(description: string, condition: boolean, detail?: string): void {
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

// ── Seed helpers ──────────────────────────────────────────────────────────────

const HERO_CUSTOMER_NAME = "ACME LOGISTICS LLC";
const NON_HERO_CUSTOMER_NAME = "ZZZ UNKNOWN CO";
const HERO_ORIGIN_CITY = "Chicago";
const HERO_ORIGIN_STATE = "IL";
const HERO_DEST_CITY = "Atlanta";
const HERO_DEST_STATE = "GA";
const HERO_EQUIPMENT = "Van";

async function seedOrg(): Promise<string> {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Hero Loop Test ${ts}`, slug: `hero-loop-test-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);
  return org.id;
}

async function seedUser(orgId: string, role: string, suffix: string): Promise<string> {
  const ts = Date.now();
  const [u] = await db
    .insert(users)
    .values({
      organizationId: orgId,
      name: `Hero Loop ${suffix}`,
      username: `hero-loop-${suffix.toLowerCase()}-${ts}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role,
      password: "hashed_test_password",
    })
    .returning({ id: users.id });
  return u.id;
}

async function seedCompany(orgId: string, name: string): Promise<string> {
  const [c] = await db
    .insert(companies)
    .values({ organizationId: orgId, name })
    .returning({ id: companies.id });
  return c.id;
}

async function seedQuoteCustomer(orgId: string, name: string): Promise<string> {
  const [c] = await db
    .insert(quoteCustomers)
    .values({ organizationId: orgId, name })
    .returning({ id: quoteCustomers.id });
  return c.id;
}

async function seedQuoteRep(orgId: string, userId: string, name: string): Promise<string> {
  const [r] = await db
    .insert(quoteReps)
    .values({
      organizationId: orgId,
      userId,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}-${Date.now()}@example.com`,
    })
    .returning({ id: quoteReps.id });
  return r.id;
}

async function seedWonQuote(opts: {
  orgId: string;
  customerId: string;
  repId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
}): Promise<QuoteOpportunity> {
  const requestDate = new Date();
  requestDate.setUTCDate(requestDate.getUTCDate() + 1); // pickup tomorrow
  const [q] = await db
    .insert(quoteOpportunities)
    .values({
      organizationId: opts.orgId,
      customerId: opts.customerId,
      repId: opts.repId,
      requestDate,
      originCity: opts.originCity,
      originState: opts.originState,
      destCity: opts.destCity,
      destState: opts.destState,
      equipment: opts.equipment,
      quotedAmount: "2500.00",
      outcomeStatus: "won",
      source: "email",
      sourceReference: `hero-loop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    .returning();
  return q;
}

async function cleanup(): Promise<void> {
  for (const orgId of orgIdsToCleanup) {
    try {
      // companies.organization_id does NOT cascade on org delete in this
      // schema, but freight_opportunities.company_id cascades on company
      // delete, and freight_opportunities.org_id cascades on org delete.
      // So we explicitly clear freight_opportunities + companies first so
      // the final organization delete doesn't trip the FK guard.
      await db.delete(freightOpportunities).where(eq(freightOpportunities.orgId, orgId));
      await db.delete(companies).where(eq(companies.organizationId, orgId));
      await db.delete(users).where(eq(users.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    } catch (err) {
      console.error(`[cleanup] failed to delete org=${orgId}:`, err);
    }
  }
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function testHeroSliceMatch(): Promise<void> {
  console.log("\n  ── Hero-slice match: won quote → ready_to_send + LM delegated ──\n");
  const orgId = await seedOrg();

  // LM the slice points at, plus a NAM owner the rep maps to.
  const lmUserId = await seedUser(orgId, "logistics_manager", "LM");
  const namUserId = await seedUser(orgId, "account_manager", "NAM");

  // Both customer pickers (CRM company + quote customer) need to resolve
  // by the same case-insensitive name so the converter's company lookup
  // doesn't auto-create a stub mid-test.
  await seedCompany(orgId, HERO_CUSTOMER_NAME);
  const customerId = await seedQuoteCustomer(orgId, HERO_CUSTOMER_NAME);
  const repId = await seedQuoteRep(orgId, namUserId, "NAM Rep");

  // Hero slice config + auto-handoff explicitly ON (default is on, but
  // we set it so the test is hermetic against a future default flip).
  await setAutoWonQuoteAfHandoffEnabled(orgId, true);
  const slice: HeroSliceConfig = {
    id: "test-hero-slice",
    customerNamePattern: "ACME LOGISTICS",
    originStatePattern: "IL|IN|OH",
    destinationStatePattern: "GA|FL|NC",
    equipmentPattern: "VAN",
    lmUserId,
  };
  await setHeroSlices(orgId, [slice]);

  const won = await seedWonQuote({
    orgId,
    customerId,
    repId,
    originCity: HERO_ORIGIN_CITY,
    originState: HERO_ORIGIN_STATE,
    destCity: HERO_DEST_CITY,
    destState: HERO_DEST_STATE,
    equipment: HERO_EQUIPMENT,
  });

  const handoff = await createFreightOpportunityFromWonQuote(orgId, won, namUserId);
  check(
    "converter returned an id for the hero-slice quote",
    !!handoff && !!handoff.id,
    handoff ? `id=${handoff.id} created=${handoff.created}` : "handoff was null",
  );
  check(
    "converter reports created=true on first conversion",
    !!handoff?.created,
  );
  if (!handoff) return;

  const [opp] = await db
    .select()
    .from(freightOpportunities)
    .where(and(eq(freightOpportunities.id, handoff.id), eq(freightOpportunities.orgId, orgId)))
    .limit(1);

  check("freight_opportunities row exists for hero conversion", !!opp);
  if (!opp) return;

  check(
    "hero row status is 'ready_to_send'",
    opp.status === "ready_to_send",
    `actual status=${opp.status}`,
  );
  check(
    "hero row delegatedToUserId equals slice LM user",
    opp.delegatedToUserId === lmUserId,
    `actual delegatedToUserId=${opp.delegatedToUserId}, expected=${lmUserId}`,
  );
  check(
    "hero row approvedAt is set (not null)",
    opp.approvedAt !== null,
  );
  check(
    "hero row awaitingApprovalSince is null (no SLA clock for hero rows)",
    opp.awaitingApprovalSince === null,
    `actual awaitingApprovalSince=${opp.awaitingApprovalSince}`,
  );
  check(
    "hero row approvedById defaults to actor (NAM) when slice matches",
    opp.approvedById === namUserId,
    `actual approvedById=${opp.approvedById}`,
  );
  // Source provenance — the LWQ "Active won" chip aggregator splits these
  // rows out by `sourceRef->>'type'='won_quote'`. If the converter ever
  // stops stamping that discriminator the chip silently goes dark for
  // every hero row, so pin it here.
  const sourceRef = opp.sourceRef as { type?: string; quoteId?: string } | null;
  check(
    "hero row sourceRef.type is 'won_quote' (LWQ chip aggregator key)",
    sourceRef?.type === "won_quote",
    `actual sourceRef=${JSON.stringify(sourceRef)}`,
  );
  check(
    "hero row sourceRef.quoteId points back to the source quote",
    sourceRef?.quoteId === won.id,
  );
  check(
    "hero row ownerUserId resolves through quote_reps.userId (CQ-3 canonical owner)",
    opp.ownerUserId === namUserId,
    `actual ownerUserId=${opp.ownerUserId}, expected=${namUserId}`,
  );

  // ── LWQ "Active won" chip — the per-lane aggregator must count this row.
  console.log("\n  ── LWQ Active-won chip: aggregator surfaces wonQuoteCount ──\n");
  const ctxMap = await buildOpenOppContextByLaneSig(db as unknown as { select: any }, orgId, {
    now: new Date(),
  });
  const sig = laneSig(
    HERO_ORIGIN_CITY,
    HERO_ORIGIN_STATE,
    HERO_DEST_CITY,
    HERO_DEST_STATE,
    // Equipment in freight_opportunities is normalized; equipmentType on the
    // row is what laneSig sees. Use that exact value to match.
    opp.equipmentType,
  );
  const ctx = ctxMap.get(sig);
  check(
    `LWQ open-opp context exists for the hero lane signature (${sig})`,
    !!ctx,
    ctx ? undefined : `available signatures: ${[...ctxMap.keys()].join(" | ")}`,
  );
  check(
    "LWQ context.wonQuoteCount >= 1 for the hero lane (Active won chip will render)",
    !!ctx && ctx.wonQuoteCount >= 1,
    ctx ? `wonQuoteCount=${ctx.wonQuoteCount} count=${ctx.count}` : undefined,
  );
  check(
    "LWQ context.count includes the hero row (open-opp aggregate)",
    !!ctx && ctx.count >= 1,
  );
}

async function testDefaultBranch(): Promise<void> {
  console.log("\n  ── Default branch: non-hero quote → pending_approval + SLA clock ──\n");
  const orgId = await seedOrg();

  const lmUserId = await seedUser(orgId, "logistics_manager", "LM");
  const namUserId = await seedUser(orgId, "account_manager", "NAM");

  // Slice list is configured but the customer name does NOT match the
  // pattern — exercises the negative branch of `matchHeroSlice`.
  await seedCompany(orgId, NON_HERO_CUSTOMER_NAME);
  const customerId = await seedQuoteCustomer(orgId, NON_HERO_CUSTOMER_NAME);
  const repId = await seedQuoteRep(orgId, namUserId, "NAM Rep");

  await setAutoWonQuoteAfHandoffEnabled(orgId, true);
  await setHeroSlices(orgId, [
    {
      id: "test-default-branch-slice",
      customerNamePattern: "ACME LOGISTICS", // intentionally won't match
      lmUserId,
    },
  ]);

  const won = await seedWonQuote({
    orgId,
    customerId,
    repId,
    originCity: "Dallas",
    originState: "TX",
    destCity: "Phoenix",
    destState: "AZ",
    equipment: "Van",
  });

  const handoff = await createFreightOpportunityFromWonQuote(orgId, won, namUserId);
  check("converter returned an id for the non-hero quote", !!handoff?.id);
  if (!handoff) return;

  const [opp] = await db
    .select()
    .from(freightOpportunities)
    .where(and(eq(freightOpportunities.id, handoff.id), eq(freightOpportunities.orgId, orgId)))
    .limit(1);

  check("freight_opportunities row exists for default-branch conversion", !!opp);
  if (!opp) return;

  check(
    "default-branch row status is 'pending_approval'",
    opp.status === "pending_approval",
    `actual status=${opp.status}`,
  );
  check(
    "default-branch row delegatedToUserId is null (no auto-assign)",
    opp.delegatedToUserId === null,
    `actual delegatedToUserId=${opp.delegatedToUserId}`,
  );
  check(
    "default-branch row approvedAt is null (no auto-approval)",
    opp.approvedAt === null,
  );
  check(
    "default-branch row awaitingApprovalSince is set (SLA clock running for NAM/AM popup)",
    opp.awaitingApprovalSince !== null,
  );
  check(
    "default-branch row approvedById is null",
    opp.approvedById === null,
  );
}

async function testIdempotency(): Promise<void> {
  console.log("\n  ── Idempotency: re-running the converter does not duplicate or downgrade ──\n");
  const orgId = await seedOrg();

  const lmUserId = await seedUser(orgId, "logistics_manager", "LM");
  const namUserId = await seedUser(orgId, "account_manager", "NAM");
  await seedCompany(orgId, HERO_CUSTOMER_NAME);
  const customerId = await seedQuoteCustomer(orgId, HERO_CUSTOMER_NAME);
  const repId = await seedQuoteRep(orgId, namUserId, "NAM Rep");

  await setAutoWonQuoteAfHandoffEnabled(orgId, true);
  await setHeroSlices(orgId, [
    {
      id: "test-idem-slice",
      customerNamePattern: "ACME LOGISTICS",
      lmUserId,
    },
  ]);

  const won = await seedWonQuote({
    orgId,
    customerId,
    repId,
    originCity: HERO_ORIGIN_CITY,
    originState: HERO_ORIGIN_STATE,
    destCity: HERO_DEST_CITY,
    destState: HERO_DEST_STATE,
    equipment: HERO_EQUIPMENT,
  });

  const first = await createFreightOpportunityFromWonQuote(orgId, won, namUserId);
  const second = await createFreightOpportunityFromWonQuote(orgId, won, namUserId);

  check(
    "first conversion reports created=true",
    !!first?.created,
  );
  check(
    "second conversion reports created=false (idempotent re-save)",
    second !== null && !second.created,
  );
  check(
    "both conversions return the same freight_opportunities.id",
    !!first && !!second && first.id === second.id,
    first && second ? `first=${first.id} second=${second.id}` : undefined,
  );

  // The re-save branch must not downgrade ready_to_send back to
  // pending_approval (would re-introduce the NAM/AM popup mid-flight).
  const [after] = await db
    .select()
    .from(freightOpportunities)
    .where(and(eq(freightOpportunities.id, first!.id), eq(freightOpportunities.orgId, orgId)))
    .limit(1);
  check(
    "idempotent re-save preserves status='ready_to_send' (no downgrade)",
    after?.status === "ready_to_send",
    `actual status=${after?.status}`,
  );
  check(
    "idempotent re-save preserves delegatedToUserId",
    after?.delegatedToUserId === lmUserId,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Hero Loop e2e — Email → Won → Ready-to-send → LWQ chip (Task #1074)");
  console.log("══════════════════════════════════════════════════════════════");

  try {
    await testHeroSliceMatch();
    await testDefaultBranch();
    await testIdempotency();
  } finally {
    await cleanup();
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unexpected error:", err);
  cleanup().finally(() => process.exit(1));
});
