/**
 * Capture Leak Queue — Phase 4 (Orphan Outbound attach) regression tests.
 *
 * Covers `attachOrphanOutboundToQuote`: the only Phase 4 write path. The
 * service layer is the chokepoint — the route is a thin admin-gated
 * wrapper so anything we miss here will show up as a UI bug, not a data
 * leak.
 *
 * What's covered:
 *   • Happy path — capture_leak_reviews row written with
 *     `decision='attached'`, quote_events row written with
 *     `actor='manual_leak_attach'` + `eventType='email_attached'`, and
 *     the row drops out of the orphan_outbound queue + diagnostics
 *     counter in lock-step (the chokepoint is the review row, never the
 *     audit event).
 *   • Re-click after success returns `already_attached` with the
 *     previously attached quoteId, and writes NO additional rows
 *     (review row count stays 1, audit event count stays 1).
 *   • Concurrent attach to the same (orgId, messageId) — both calls
 *     converge via the per-row mutex to a single review row + single
 *     audit event; both return `attached` with the same quoteId.
 *   • wrong_leak_type — inbound message rejected.
 *   • not_found — cross-tenant messageId rejected; no rows written.
 *   • invalid_quote — bogus / cross-tenant quoteId rejected; no rows
 *     written.
 *   • not_a_leak — row already reviewed via Phase 2A (decision='ignored')
 *     no longer attachable (and we DON'T overwrite the existing decision).
 */
import { describe, it, expect } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db } from "../storage";
import {
  emailMessages,
  organizations,
  quoteCustomers,
  quoteEvents,
  quoteOpportunities,
  captureLeakReviews,
  users,
} from "@shared/schema";
import {
  getLeakedQuoteEmails,
  getFunnelDiagnostics,
  reviewLeakRow,
  attachOrphanOutboundToQuote,
  _isLeakAttachInFlightForTests,
  _resetLeakAttachInFlightForTests,
  type LeakedOutboundRow,
} from "../services/customerQuotes";

const TAG = `t-leakatt-${Date.now()}`;

async function getActorId(): Promise<string | null> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows[0]?.id ?? null;
}

async function getOrgs(): Promise<string[]> {
  const rows = await db.select({ id: organizations.id }).from(organizations).limit(2);
  return rows.map(r => r.id);
}

interface Cleanup {
  oppIds: string[];
  customerIds: string[];
  messageIds: string[];
  reviewIds: string[];
}
function newCleanup(): Cleanup {
  return { oppIds: [], customerIds: [], messageIds: [], reviewIds: [] };
}
async function cleanup(c: Cleanup): Promise<void> {
  if (c.reviewIds.length > 0) {
    await db.delete(captureLeakReviews).where(inArray(captureLeakReviews.id, c.reviewIds));
  }
  if (c.oppIds.length > 0) {
    await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, c.oppIds));
    await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, c.oppIds));
  }
  if (c.messageIds.length > 0) {
    // Reviews FK to email_messages — clear any leftover rows the test
    // may have written (e.g. attempted ignore + attach paths).
    await db.delete(captureLeakReviews).where(inArray(captureLeakReviews.messageId, c.messageIds));
    await db.delete(emailMessages).where(inArray(emailMessages.id, c.messageIds));
  }
  if (c.customerIds.length > 0) {
    await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, c.customerIds));
  }
}

interface OutboundFields {
  providerMessageId: string;
  threadId: string;
  subject?: string;
  direction?: "inbound" | "outbound";
}
async function makeOutbound(orgId: string, f: OutboundFields, c: Cleanup): Promise<string> {
  const direction = f.direction ?? "outbound";
  const [row] = await db.insert(emailMessages).values({
    orgId,
    direction,
    providerMessageId: f.providerMessageId,
    threadId: f.threadId,
    fromEmail: direction === "outbound" ? "rep@broker.example" : '"Jane Shipper" <jane@customer.example>',
    toEmail: direction === "outbound" ? "shipper@customer.example" : "rep@broker.example",
    subject: f.subject ?? "Re: capacity",
    body: "Following up on your shipment — please advise.",
    linkedAccountId: null,
    providerSentAt: new Date(),
    processedForSignalsAt: direction === "inbound" ? new Date() : null,
  }).returning();
  c.messageIds.push(row.id);
  return row.id;
}

/**
 * Insert a real `quote_opportunities` row + its required `quote_customers`
 * parent so the attach service's cross-tenant check against
 * `quote_opportunities.organizationId` finds a real target. The customer
 * doesn't need to match the email — attach intentionally doesn't enforce
 * customer alignment (the picker scopes the candidate list, but the
 * server allows any quote in the org).
 */
async function makeQuote(orgId: string, label: string, c: Cleanup): Promise<string> {
  const [customer] = await db.insert(quoteCustomers).values({
    organizationId: orgId,
    name: `${TAG}-cust-${label}`,
  }).returning();
  c.customerIds.push(customer.id);

  const [opp] = await db.insert(quoteOpportunities).values({
    organizationId: orgId,
    customerId: customer.id,
    source: "manual",
    sourceReference: `${TAG}-quote-${label}`,
    requestDate: new Date(),
    originCity: "Dallas",
    originState: "TX",
    destCity: "Atlanta",
    destState: "GA",
    equipment: "Dry Van",
    outcomeStatus: "pending",
  }).returning();
  c.oppIds.push(opp.id);
  return opp.id;
}

describe("attachOrphanOutboundToQuote — Phase 4", () => {
  it("attaches an orphan outbound row and removes it from the queue + counter", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-att-ok`,
        threadId: `${TAG}-thr-att-ok`,
        subject: `${TAG} attach happy`,
      }, c);
      const targetQuoteId = await makeQuote(orgId, "ok", c);

      // Pre: row IS in the orphan_outbound queue.
      const before = await getLeakedQuoteEmails(orgId, null, { type: "orphan_outbound", limit: 100 });
      const beforeDiag = await getFunnelDiagnostics(orgId, {}, null);
      expect((before.rows as LeakedOutboundRow[]).some(r => r.messageId === messageId)).toBe(true);

      const result = await attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId);
      expect(result.status).toBe("attached");
      if (result.status !== "attached") return;
      expect(result.quoteId).toBe(targetQuoteId);

      // Review row exists with decision='attached' and note carries the qid.
      const reviews = await db.select().from(captureLeakReviews).where(and(
        eq(captureLeakReviews.messageId, messageId),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ));
      expect(reviews).toHaveLength(1);
      expect(reviews[0].decision).toBe("attached");
      expect((reviews[0].note ?? "").includes(targetQuoteId)).toBe(true);

      // Audit event written exactly once on the target quote.
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, targetQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("email_attached");

      // Lock-step chokepoint: queue row vanished AND counter dropped by
      // exactly 1 (delta absorbs any concurrent inserts).
      const after = await getLeakedQuoteEmails(orgId, null, { type: "orphan_outbound", limit: 100 });
      const afterDiag = await getFunnelDiagnostics(orgId, {}, null);
      expect((after.rows as LeakedOutboundRow[]).some(r => r.messageId === messageId)).toBe(false);
      expect(beforeDiag.orphanOutboundCount - afterDiag.orphanOutboundCount).toBe(1);
      expect(after.total).toBe(afterDiag.orphanOutboundCount);
    } finally {
      await cleanup(c);
    }
  });

  it("re-click after attach returns already_attached and writes nothing new", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-att-re`,
        threadId: `${TAG}-thr-att-re`,
      }, c);
      const targetQuoteId = await makeQuote(orgId, "re", c);

      const first = await attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId);
      expect(first.status).toBe("attached");

      // Mutex released after first call resolved.
      expect(_isLeakAttachInFlightForTests(orgId, messageId)).toBe(false);

      const second = await attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId);
      expect(second.status).toBe("already_attached");
      if (second.status === "already_attached") {
        expect(second.quoteId).toBe(targetQuoteId);
      }

      // No new review row, no new audit event.
      const reviews = await db.select().from(captureLeakReviews).where(and(
        eq(captureLeakReviews.messageId, messageId),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ));
      expect(reviews).toHaveLength(1);
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, targetQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(1);
    } finally {
      await cleanup(c);
    }
  });

  // Race-safety: two concurrent admin clicks on the same row converge to
  // exactly one review row + one audit event via the per-(orgId,messageId)
  // mutex — without the mutex, both pass the candidate-set check and
  // both attempt the INSERT (the unique idx would catch the second, but
  // the audit event would race and could write twice).
  it("serializes concurrent attach calls on the same (orgId, messageId)", async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-att-race`,
        threadId: `${TAG}-thr-att-race`,
      }, c);
      const targetQuoteId = await makeQuote(orgId, "race", c);

      const [a, b] = await Promise.all([
        attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId),
        attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId),
      ]);

      // Mutex released after both promises resolved.
      expect(_isLeakAttachInFlightForTests(orgId, messageId)).toBe(false);

      // Both callers receive the same in-flight promise → both report
      // 'attached' with the same quoteId (single insert, single resolution).
      expect(a.status).toBe("attached");
      expect(b.status).toBe("attached");
      if (a.status === "attached" && b.status === "attached") {
        expect(a.quoteId).toBe(targetQuoteId);
        expect(b.quoteId).toBe(targetQuoteId);
      }

      // Exactly ONE review row and ONE audit event.
      const reviews = await db.select().from(captureLeakReviews).where(and(
        eq(captureLeakReviews.messageId, messageId),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ));
      expect(reviews).toHaveLength(1);
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, targetQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(1);
    } finally {
      await cleanup(c);
    }
  });

  it("returns wrong_leak_type for an inbound message", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-att-wrong`,
        threadId: `${TAG}-thr-att-wrong`,
        direction: "inbound",
      }, c);
      const targetQuoteId = await makeQuote(orgId, "wrong", c);

      const result = await attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId);
      expect(result.status).toBe("wrong_leak_type");

      // Nothing written.
      const reviews = await db.select().from(captureLeakReviews).where(eq(captureLeakReviews.messageId, messageId));
      expect(reviews).toHaveLength(0);
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, targetQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });

  it("returns not_found for a cross-tenant messageId with no DB write", { timeout: 60000 }, async () => {
    const orgs = await getOrgs();
    const actorId = await getActorId();
    if (orgs.length < 2 || !actorId) return;
    const [ownerOrg, attackerOrg] = orgs;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(ownerOrg, {
        providerMessageId: `${TAG}-att-xtenant-msg`,
        threadId: `${TAG}-thr-att-xtenant-msg`,
      }, c);
      // Target quote also lives in the owner org — the attacker is just
      // probing with their own orgId in the call, hoping to reach the
      // owner's email.
      const targetQuoteId = await makeQuote(ownerOrg, "xtenant-q", c);

      const result = await attachOrphanOutboundToQuote(attackerOrg, actorId, messageId, targetQuoteId);
      expect(result.status).toBe("not_found");

      // Owner org's queue still surfaces the row — nothing was written.
      const stillThere = await getLeakedQuoteEmails(ownerOrg, null, { type: "orphan_outbound", limit: 100 });
      expect((stillThere.rows as LeakedOutboundRow[]).some(r => r.messageId === messageId)).toBe(true);
      const reviews = await db.select().from(captureLeakReviews).where(eq(captureLeakReviews.messageId, messageId));
      expect(reviews).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });

  it("returns invalid_quote for a bogus / cross-tenant quoteId with no DB write", { timeout: 60000 }, async () => {
    const orgs = await getOrgs();
    const actorId = await getActorId();
    if (orgs.length < 2 || !actorId) return;
    const [ownerOrg, otherOrg] = orgs;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(ownerOrg, {
        providerMessageId: `${TAG}-att-badq`,
        threadId: `${TAG}-thr-att-badq`,
      }, c);
      // Quote belongs to the OTHER org — owner shouldn't be able to
      // attach their email to it.
      const otherOrgQuoteId = await makeQuote(otherOrg, "badq", c);

      const result = await attachOrphanOutboundToQuote(ownerOrg, actorId, messageId, otherOrgQuoteId);
      expect(result.status).toBe("invalid_quote");

      // Owner org's queue still surfaces the row — nothing was written.
      const stillThere = await getLeakedQuoteEmails(ownerOrg, null, { type: "orphan_outbound", limit: 100 });
      expect((stillThere.rows as LeakedOutboundRow[]).some(r => r.messageId === messageId)).toBe(true);
      const reviews = await db.select().from(captureLeakReviews).where(eq(captureLeakReviews.messageId, messageId));
      expect(reviews).toHaveLength(0);
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, otherOrgQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });

  // Once a row is reviewed via Phase 2A (any decision), the chokepoint
  // filters it out of the candidate set — attach surfaces `not_a_leak`
  // and DOES NOT overwrite the previous review (preserves audit trail).
  it("returns not_a_leak after the row was already reviewed via Phase 2A", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    _resetLeakAttachInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-att-nal`,
        threadId: `${TAG}-thr-att-nal`,
      }, c);
      const targetQuoteId = await makeQuote(orgId, "nal", c);

      // Phase 2A first: mark as 'ignored'.
      const rev = await reviewLeakRow(orgId, actorId, {
        messageId,
        leakType: "orphan_outbound",
        decision: "ignored",
      });
      expect(rev.status).toBe("ok");
      if (rev.status === "ok") c.reviewIds.push(rev.review.id);

      // Phase 4 should now refuse — and importantly should NOT report
      // already_attached (that's reserved for the decision='attached'
      // path, which preserves a deep-link target quote id).
      const result = await attachOrphanOutboundToQuote(orgId, actorId, messageId, targetQuoteId);
      expect(result.status).toBe("not_a_leak");

      // Existing review row was NOT overwritten — decision still 'ignored'.
      const reviews = await db.select().from(captureLeakReviews).where(and(
        eq(captureLeakReviews.messageId, messageId),
        eq(captureLeakReviews.leakType, "orphan_outbound"),
      ));
      expect(reviews).toHaveLength(1);
      expect(reviews[0].decision).toBe("ignored");

      // No audit event written.
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, targetQuoteId),
        eq(quoteEvents.actor, "manual_leak_attach"),
      ));
      expect(events).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });
});
