import { describe, it, expect, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  extractCarrierRateOffer,
  ingestCarrierQuoteFromEmail,
  getCarrierQuoteEventsByLane,
  getCarrierQuoteEventsByCarrier,
} from "../services/carrierQuoteIngestion";
import {
  ingestQuoteFromEmail,
  backfillQuotesFromEmails,
} from "../services/quoteEmailIngestion";
import { db, storage } from "../storage";
import {
  carrierQuoteEvents,
  emailMessages,
  organizations,
  carriers,
  quoteOpportunities,
  quoteEvents,
} from "@shared/schema";

// ─── Pure regex extractor ──────────────────────────────────────────────────

describe("extractCarrierRateOffer (Task #1054)", () => {
  it("extracts $1850 all-in with lane Atlanta, GA → Dallas, TX", () => {
    const out = extractCarrierRateOffer({
      subject: "RE: Atlanta, GA to Dallas, TX",
      body: "We can do it for $1,850 all-in. Truck available Tuesday.",
    });
    expect(out.amountCents).toBe(185000);
    expect(out.qualifier).toBe("all_in");
    expect(out.lane).not.toBeNull();
    expect(out.lane!.originCity).toBe("Atlanta");
    expect(out.lane!.originState).toBe("GA");
    expect(out.lane!.destCity).toBe("Dallas");
    expect(out.lane!.destState).toBe("TX");
    expect(out.rawSnippet).toContain("1,850");
  });

  it("extracts amount + qualifier even when lane info is absent (subject-only ATL->DAL)", () => {
    const out = extractCarrierRateOffer({
      subject: "RE: ATL->DAL",
      body: "We can do it for $1,850 all-in.",
    });
    expect(out.amountCents).toBe(185000);
    expect(out.qualifier).toBe("all_in");
    // Bare 3-letter codes don't satisfy the "City, ST -> City, ST" parser;
    // amount alone is still enough to capture a carrier_quote_event.
    expect(out.lane).toBeNull();
  });

  it("captures lane via city,ST → city,ST and qualifier=flat", () => {
    const out = extractCarrierRateOffer({
      subject: "Quote",
      body: "Atlanta, GA to Dallas, TX — $2,100 flat. Pickup tomorrow.",
    });
    expect(out.amountCents).toBe(210000);
    expect(out.qualifier).toBe("flat");
    expect(out.lane!.originState).toBe("GA");
    expect(out.lane!.destState).toBe("TX");
  });

  it("returns null amount when no plausible rate is present", () => {
    const out = extractCarrierRateOffer({
      subject: "Truck available",
      body: "Have a reefer empty Chicago, IL to Atlanta, GA Monday.",
    });
    expect(out.amountCents).toBeNull();
    expect(out.lane).not.toBeNull();
    expect(out.lane!.equipment).toBe("Reefer");
  });

  it("rejects implausible rates (year, invoice number)", () => {
    const out = extractCarrierRateOffer({
      subject: "Re: load",
      body: "Memphis, TN to St Louis, MO — invoice #5 from 2024.",
    });
    expect(out.amountCents).toBeNull();
  });

  it("returns no signal for OOO / undeliverable subjects", () => {
    const out = extractCarrierRateOffer({
      subject: "Out of Office",
      body: "I will be back Monday. Atlanta, GA to Dallas, TX $1850.",
    });
    expect(out.lane).toBeNull();
    expect(out.amountCents).toBeNull();
  });
});

// ─── DB integration ────────────────────────────────────────────────────────
//
// Mirrors the "shared Unknown bucket" pattern from
// quoteEmailIngestion.test.ts: skip silently when no org exists, otherwise
// exercise the full path against real Postgres and clean up afterward.

describe("ingestCarrierQuoteFromEmail — DB integration", () => {
  let orgId: string | null = null;
  let backfillOrgId: string | null = null;
  let carrierId: string | null = null;
  let backfillCarrierId: string | null = null;
  const tag = `t1054-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messageIds: string[] = [];
  const backfillMessageIds: string[] = [];

  beforeAll(async () => {
    const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRow.length === 0) return;
    orgId = orgRow[0].id;

    // Create a carrier scoped to this org so we can assert linkage on read.
    const [c] = await db.insert(carriers).values({
      orgId,
      name: `${tag}-Carrier`,
    }).returning();
    carrierId = c.id;

    // Dedicated isolated org for the backfill test so the SQL scan only
    // sees our two seeded messages — the shared org has 10k+ inbound rows
    // which would blow past any reasonable test timeout.
    const [bOrg] = await db.insert(organizations).values({
      name: `${tag}-backfill-org`,
      slug: `${tag}-backfill-org`,
    }).returning();
    backfillOrgId = bOrg.id;
    const [bCarrier] = await db.insert(carriers).values({
      orgId: backfillOrgId,
      name: `${tag}-Backfill-Carrier`,
    }).returning();
    backfillCarrierId = bCarrier.id;
  });

  it("captures one carrier_quote_event for a rate email and writes nothing to quote_opportunities", async () => {
    if (!orgId || !carrierId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-rate-1`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Re: ATL to DAL`,
      body: "Atlanta, GA to Dallas, TX. We can do it for $1,850 all-in, Tuesday pickup.",
      linkedCarrierId: carrierId,
    }).returning();
    messageIds.push(msg.id);

    const result = await ingestCarrierQuoteFromEmail(msg);
    expect(result.status).toBe("ingested");
    expect(result.eventId).toBeTruthy();

    const rows = await db.select().from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, orgId),
        eq(carrierQuoteEvents.emailMessageId, msg.id),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].amountCents).toBe(185000);
    expect(rows[0].qualifier).toBe("all_in");
    expect(rows[0].laneKey).toBe("Atlanta,GA->Dallas,TX");
    expect(rows[0].carrierId).toBe(carrierId);
    expect(rows[0].sourceReference).toBe(msg.providerMessageId);
    expect(rows[0].extractionSource).toBe("regex");

    // Critical contract: NOTHING in quote_opportunities for this email.
    const opps = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        eq(quoteOpportunities.sourceReference, msg.providerMessageId!),
      ));
    expect(opps.length).toBe(0);
  });

  it("is idempotent on (orgId, sourceReference) — replay returns skipped_duplicate", async () => {
    if (!orgId || !carrierId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-rate-2`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Spot quote`,
      body: "Houston, TX to Boston, MA — rate $2400 flat.",
      linkedCarrierId: carrierId,
    }).returning();
    messageIds.push(msg.id);

    const first = await ingestCarrierQuoteFromEmail(msg);
    expect(first.status).toBe("ingested");

    const second = await ingestCarrierQuoteFromEmail(msg);
    expect(second.status).toBe("skipped_duplicate");
    expect(second.eventId).toBe(first.eventId);

    const count = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, orgId),
        eq(carrierQuoteEvents.sourceReference, msg.providerMessageId!),
      ));
    expect(count.length).toBe(1);
  });

  it("skipped_no_signal for lane-only carrier emails (truck-availability is NOT a quote)", async () => {
    if (!orgId || !carrierId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-truck-avail`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Truck available`,
      body: "Have a reefer empty Chicago, IL to Atlanta, GA Monday. Anything you can use?",
      linkedCarrierId: carrierId,
    }).returning();
    messageIds.push(msg.id);

    const result = await ingestCarrierQuoteFromEmail(msg);
    expect(result.status).toBe("skipped_no_signal");

    // Critical: lane-only carrier email must NOT create a carrier_quote_event.
    const rows = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, orgId),
        eq(carrierQuoteEvents.sourceReference, msg.providerMessageId!),
      ));
    expect(rows.length).toBe(0);
  });

  it("skipped_no_signal when neither lane nor amount can be extracted", async () => {
    if (!orgId || !carrierId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-noise`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} hello`,
      body: "Just touching base, talk later.",
      linkedCarrierId: carrierId,
    }).returning();
    messageIds.push(msg.id);

    const result = await ingestCarrierQuoteFromEmail(msg);
    expect(result.status).toBe("skipped_no_signal");
  });

  it("skipped_outbound for outbound messages", async () => {
    if (!orgId || !carrierId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-out`,
      direction: "outbound",
      fromEmail: "ops@example.com",
      toEmail: "dispatch@example-carrier.com",
      subject: `${tag} Our offer`,
      body: "Atlanta, GA to Dallas, TX — $1800 all-in.",
      linkedCarrierId: carrierId,
    }).returning();
    messageIds.push(msg.id);

    const result = await ingestCarrierQuoteFromEmail(msg);
    expect(result.status).toBe("skipped_outbound");
  });

  it("storage readers return events by lane and by carrier", async () => {
    if (!orgId || !carrierId) return;

    const byLane = await getCarrierQuoteEventsByLane(orgId, "Atlanta,GA->Dallas,TX");
    expect(byLane.length).toBeGreaterThanOrEqual(1);
    expect(byLane.every(r => r.orgId === orgId)).toBe(true);
    expect(byLane.every(r => r.laneKey === "Atlanta,GA->Dallas,TX")).toBe(true);

    const byCarrier = await getCarrierQuoteEventsByCarrier(orgId, carrierId);
    expect(byCarrier.length).toBeGreaterThanOrEqual(1);
    expect(byCarrier.every(r => r.carrierId === carrierId)).toBe(true);

    // IStorage interface methods mirror the same readers.
    const viaStorage = await storage.getCarrierQuoteEventsByCarrier(orgId, carrierId);
    expect(viaStorage.length).toBe(byCarrier.length);
  });

  it("customer pricing-request emails still flow to quote_opportunities (no regression)", async () => {
    if (!orgId) return;

    const [msg] = await db.insert(emailMessages).values({
      orgId,
      providerMessageId: `${tag}-cust`,
      direction: "inbound",
      fromEmail: "buyer@uzbfreight.com",
      toEmail: "ops@example.com",
      subject: `${tag} Need a rate`,
      body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday.",
    }).returning();
    messageIds.push(msg.id);

    const result = await ingestQuoteFromEmail(msg);
    expect(result.status).toBe("ingested");
    expect(result.quoteId).toBeTruthy();

    // And the carrier-quote table did NOT pick this up (we never called
    // the carrier ingest for a customer message; double-check no row).
    const rows = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, orgId),
        eq(carrierQuoteEvents.sourceReference, msg.providerMessageId!),
      ));
    expect(rows.length).toBe(0);

    // Cleanup the opp + events created by this customer-side test.
    if (result.quoteId) {
      await db.delete(quoteEvents).where(eq(quoteEvents.quoteId, result.quoteId));
      await db.delete(quoteOpportunities).where(eq(quoteOpportunities.id, result.quoteId));
    }
  });

  it("backfill routes auto_carrier emails to carrier_quote_events, never to quote_opportunities", { timeout: 30000 }, async () => {
    if (!backfillOrgId || !backfillCarrierId) return;

    // Seed an inbound rate email that LOOKS like a carrier quote and is
    // already linked to a carrier (mirrors what the inline classifier
    // persists). Critically, we never route this through the inline
    // classifier — it goes straight into the historical mailbox like a
    // record loaded by an ops backfill — and then we run the backfill
    // function and assert routing. Uses an isolated org so the SQL scan
    // only sees these two seeded messages.
    const now = new Date();
    const [carrierMsg] = await db.insert(emailMessages).values({
      orgId: backfillOrgId,
      providerMessageId: `${tag}-backfill-carrier-1`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Backfill ATL to DAL`,
      body: "Atlanta, GA to Dallas, TX. Can do $1,750 all-in, Wed pickup.",
      linkedCarrierId: backfillCarrierId,
      providerSentAt: now,
    }).returning();
    backfillMessageIds.push(carrierMsg.id);

    // And a parallel customer message in the same backfill window so we
    // also prove the customer path is not regressed by the new branch.
    const [custMsg] = await db.insert(emailMessages).values({
      orgId: backfillOrgId,
      providerMessageId: `${tag}-backfill-cust-1`,
      direction: "inbound",
      fromEmail: "buyer@example-shipper.com",
      toEmail: "ops@example.com",
      subject: `${tag} Backfill Need a rate`,
      body: "Need a rate from Memphis, TN to Nashville, TN next Monday.",
      providerSentAt: now,
    }).returning();
    backfillMessageIds.push(custMsg.id);

    const summary = await backfillQuotesFromEmails(backfillOrgId, {
      useAiFallback: false,
      concurrency: 4,
      sinceDays: 1,
    });
    expect(summary.scanned).toBeGreaterThanOrEqual(2);

    // Carrier message → exactly one row in carrier_quote_events,
    // ZERO rows in quote_opportunities.
    const carrierRows = await db.select().from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, backfillOrgId),
        eq(carrierQuoteEvents.sourceReference, carrierMsg.providerMessageId!),
      ));
    expect(carrierRows.length).toBe(1);
    expect(carrierRows[0].amountCents).toBe(175000);
    expect(carrierRows[0].laneKey).toBe("Atlanta,GA->Dallas,TX");

    const carrierOpps = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, backfillOrgId),
        eq(quoteOpportunities.sourceReference, carrierMsg.providerMessageId!),
      ));
    expect(carrierOpps.length).toBe(0);

    // Customer message → exactly one row in quote_opportunities,
    // ZERO rows in carrier_quote_events.
    const custOpps = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, backfillOrgId),
        eq(quoteOpportunities.sourceReference, custMsg.providerMessageId!),
      ));
    expect(custOpps.length).toBe(1);

    const custCarrier = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, backfillOrgId),
        eq(carrierQuoteEvents.sourceReference, custMsg.providerMessageId!),
      ));
    expect(custCarrier.length).toBe(0);

    // Cleanup the customer-side opp + events created by this backfill
    // (the isolated org itself is dropped in [cleanup]).
    for (const opp of custOpps) {
      await db.delete(quoteEvents).where(eq(quoteEvents.quoteId, opp.id));
      await db.delete(quoteOpportunities).where(eq(quoteOpportunities.id, opp.id));
    }
  });

  // Task #1054 review hardening — backfill must include rows where
  // providerSentAt is NULL (historical imports / certain graph-sync
  // paths leave it unset) but createdAt still falls inside the window.
  it("backfill includes inbound rows with null providerSentAt", async () => {
    if (!backfillOrgId || !backfillCarrierId) return;

    const { backfillQuotesFromEmails } = await import("../services/quoteEmailIngestion");

    const [nullPsaMsg] = await db.insert(emailMessages).values({
      orgId: backfillOrgId,
      providerMessageId: `${tag}-null-psa-${Date.now()}`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Backfill ATL to MIA null providerSentAt`,
      body: "Atlanta, GA to Miami, FL. $2,100 all-in for Thursday pickup.",
      linkedCarrierId: backfillCarrierId,
      providerSentAt: null,
    }).returning();
    backfillMessageIds.push(nullPsaMsg.id);

    await backfillQuotesFromEmails(backfillOrgId, { sinceDays: 7 });

    const events = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, backfillOrgId),
        eq(carrierQuoteEvents.sourceReference, nullPsaMsg.providerMessageId!),
      ));
    expect(events.length).toBe(1);

    const opps = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, backfillOrgId),
        eq(quoteOpportunities.sourceReference, nullPsaMsg.providerMessageId!),
      ));
    expect(opps.length).toBe(0);
  });

  // Task #1054 review hardening — defense-in-depth guard inside
  // `ingestQuoteFromEmail`. Even if a future caller (or the recovery
  // scheduler) forgets the explicit routing branch, an inbound message
  // with a non-null `linkedCarrierId` (or explicit
  // `routingStatus: "auto_carrier"`) MUST be redirected to
  // `carrier_quote_events` and must NOT create a `quote_opportunities`
  // row. This test calls `ingestQuoteFromEmail` directly to simulate a
  // mis-routed caller and asserts the guard catches it.
  it("ingestQuoteFromEmail defense-in-depth: linked-carrier email never creates quote_opportunities", async () => {
    if (!backfillOrgId || !backfillCarrierId) return;

    const [carrierMsg] = await db.insert(emailMessages).values({
      orgId: backfillOrgId,
      providerMessageId: `${tag}-guard-${Date.now()}`,
      direction: "inbound",
      fromEmail: "dispatch@example-carrier.com",
      toEmail: "ops@example.com",
      subject: `${tag} Guard ATL to ORD`,
      body: "Atlanta, GA to Chicago, IL. $1,975 all-in for Friday pickup.",
      linkedCarrierId: backfillCarrierId,
      providerSentAt: new Date(),
    }).returning();
    backfillMessageIds.push(carrierMsg.id);

    // Simulate a caller (scheduler/recovery path) that forgot to mirror
    // the routing decision and called the customer ingest directly.
    const result = await ingestQuoteFromEmail(carrierMsg);
    expect(result.status).toBe("skipped_carrier_routed");

    const opps = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, backfillOrgId),
        eq(quoteOpportunities.sourceReference, carrierMsg.providerMessageId!),
      ));
    expect(opps.length).toBe(0);

    const events = await db.select({ id: carrierQuoteEvents.id })
      .from(carrierQuoteEvents)
      .where(and(
        eq(carrierQuoteEvents.orgId, backfillOrgId),
        eq(carrierQuoteEvents.sourceReference, carrierMsg.providerMessageId!),
      ));
    expect(events.length).toBe(1);
  });

  // Cleanup at the end of the suite.
  it("[cleanup]", async () => {
    if (messageIds.length > 0) {
      await db.delete(carrierQuoteEvents).where(inArray(carrierQuoteEvents.emailMessageId, messageIds));
      await db.delete(emailMessages).where(inArray(emailMessages.id, messageIds));
    }
    if (carrierId) {
      await db.delete(carriers).where(eq(carriers.id, carrierId));
    }
    if (backfillMessageIds.length > 0) {
      await db.delete(carrierQuoteEvents).where(inArray(carrierQuoteEvents.emailMessageId, backfillMessageIds));
      await db.delete(emailMessages).where(inArray(emailMessages.id, backfillMessageIds));
    }
    if (backfillCarrierId) {
      await db.delete(carriers).where(eq(carriers.id, backfillCarrierId));
    }
    if (backfillOrgId) {
      await db.delete(organizations).where(eq(organizations.id, backfillOrgId));
    }
  });
});
