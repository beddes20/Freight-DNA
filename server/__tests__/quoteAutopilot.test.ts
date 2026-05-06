/**
 * Task #803 — Quote Lifecycle Autopilot tests.
 *
 * DB-integration tests covering the three autopilot paths and the
 * new-contact-review queue helpers. Each test creates its own ephemeral
 * organization + customer + email-message rows tagged with a unique key,
 * exercises the unit, then cleans up its own artifacts. Skips silently
 * when no organization is reachable (clean envs) — same pattern as
 * quoteEmailIngestion.test.ts.
 *
 * Behaviours under test:
 *   (B) Outbound auto-quote
 *       - confident extract → outcomeStatus flips to "quoted",
 *         auto:outbound_reply event written
 *       - duplicate providerMessageId is a no-op (idempotent)
 *   (C) No-response sweep
 *       - pending opp older than the org timeout closes with
 *         outcomeStatus=no_response + auto:no_response_timeout event
 *       - pending opp with a fresh inbound reply is skipped
 *       - re-opened opp is skipped for one timeout window
 *   New-contact-review helpers
 *       - listNewContactReviews returns pending prompts
 *       - resolveNewContactReview('dismiss') clears the JSONB flag and
 *         writes an auto:new_sender event
 */
import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  emailMessages,
  organizations,
  quoteCustomers,
  quoteEvents,
  quoteOpportunities,
  quoteSenderMappings,
} from "@shared/schema";
import { lookupMapping } from "../services/quoteSenderMappings";
import { applyOutboundReplyToOpenQuote } from "../services/outboundQuoteAutoQuote";
import { runQuoteNoResponseSweep } from "../services/quoteNoResponseSweep";
import { applyClosedWonToOpenQuote } from "../services/quoteEmailIngestion";
import {
  listNewContactReviews,
  markQuoteOutcome,
  resolveNewContactReview,
} from "../services/customerQuotes";

const TAG = `t803-${Date.now()}`;

interface Cleanup {
  oppIds: string[];
  customerIds: string[];
  messageIds: string[];
  senderMappingIds: string[];
}

function newCleanup(): Cleanup {
  return { oppIds: [], customerIds: [], messageIds: [], senderMappingIds: [] };
}

async function cleanup(c: Cleanup): Promise<void> {
  if (c.oppIds.length > 0) {
    await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, c.oppIds));
    await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, c.oppIds));
  }
  if (c.messageIds.length > 0) {
    await db.delete(emailMessages).where(inArray(emailMessages.id, c.messageIds));
  }
  if (c.senderMappingIds.length > 0) {
    await db.delete(quoteSenderMappings).where(inArray(quoteSenderMappings.id, c.senderMappingIds));
  }
  if (c.customerIds.length > 0) {
    await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, c.customerIds));
  }
}

async function getOrg(): Promise<string | null> {
  const rows = await db.select({ id: organizations.id }).from(organizations).limit(1);
  return rows[0]?.id ?? null;
}

async function ensureCustomer(orgId: string, name: string, c: Cleanup): Promise<string> {
  const [row] = await db
    .insert(quoteCustomers)
    .values({ organizationId: orgId, name, partyType: "shipper" })
    .returning();
  c.customerIds.push(row.id);
  return row.id;
}

async function makePendingOpp(
  orgId: string,
  customerId: string,
  ref: { messageId: string | null; threadId: string | null },
  c: Cleanup,
  opts: { needsNewContactReview?: any; requestDateOffsetMs?: number } = {},
): Promise<string> {
  const requestDate = new Date(Date.now() + (opts.requestDateOffsetMs ?? 0));
  const [opp] = await db
    .insert(quoteOpportunities)
    .values({
      organizationId: orgId,
      customerId,
      requestDate,
      originCity: "Chicago",
      originState: "IL",
      destCity: "Atlanta",
      destState: "GA",
      equipment: "Dry Van",
      outcomeStatus: "pending",
      source: "email",
      sourceReference: ref.messageId,
      validThrough: new Date(requestDate.getTime() + 7 * 24 * 3600 * 1000),
      needsNewContactReview: opts.needsNewContactReview ?? null,
    })
    .returning();
  c.oppIds.push(opp.id);
  return opp.id;
}

async function makeMessage(
  orgId: string,
  fields: {
    direction: "inbound" | "outbound";
    threadId: string;
    providerMessageId: string;
    fromEmail?: string;
    subject?: string;
    body?: string;
    providerSentAt?: Date;
  },
  c: Cleanup,
): Promise<string> {
  const [m] = await db
    .insert(emailMessages)
    .values({
      orgId,
      direction: fields.direction,
      threadId: fields.threadId,
      providerMessageId: fields.providerMessageId,
      fromEmail: fields.fromEmail ?? "rep@broker.example",
      toEmail: "shipper@customer.example",
      subject: fields.subject ?? "Re: Quote",
      body: fields.body ?? "",
      providerSentAt: fields.providerSentAt ?? new Date(),
    })
    .returning();
  c.messageIds.push(m.id);
  return m.id;
}

describe("quote autopilot — outbound auto-quote (B)", () => {
  it("flips a pending opp to quoted on a confident outbound rate, and is idempotent on providerMessageId", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-B1`, c);
      const threadId = `${TAG}-thread-B1`;
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-B1`, subject: `${TAG} RFQ`, body: "Quote please" },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);

      const sentAt = new Date();
      const outboundMsgId = await makeMessage(
        orgId,
        {
          direction: "outbound",
          threadId,
          providerMessageId: `${TAG}-out-B1`,
          subject: `${TAG} Re: RFQ`,
          body: "Hi — we can cover Chicago→Atlanta dry van for $1850 all-in. Valid 7 days.",
          providerSentAt: sentAt,
        },
        c,
      );
      const outbound = (await db.select().from(emailMessages).where(eq(emailMessages.id, outboundMsgId)).limit(1))[0];

      // Inject a deterministic extractor so the test never depends on a
      // live OpenAI call.
      const stubExtract = async () => ({ isQuote: true, quotedAmount: 1850, confidence: "high" as const, equipment: null, validityDays: null });

      const r1 = await applyOutboundReplyToOpenQuote(outbound, { extract: stubExtract });
      expect(r1.status).toBe("quoted");
      expect(r1.quoteId).toBe(oppId);

      const [updated] = await db
        .select({
          outcomeStatus: quoteOpportunities.outcomeStatus,
          quotedAmount: quoteOpportunities.quotedAmount,
        })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(updated.outcomeStatus).toBe("quoted");
      expect(Number(updated.quotedAmount)).toBe(1850);

      const events = await db
        .select({ actor: quoteEvents.actor, eventType: quoteEvents.eventType })
        .from(quoteEvents)
        .where(eq(quoteEvents.quoteId, oppId));
      expect(events.some(e => e.actor === "auto:outbound_reply" && e.eventType === "quoted")).toBe(true);

      // Idempotent: replaying the same outbound message does nothing
      // new — either short-circuits on the providerMessageId duplicate
      // event or finds no pending quote left on the thread (because the
      // first call already flipped it to quoted). Both outcomes mean
      // "no double-write". Critically, no SECOND `auto:outbound_reply`
      // event should appear.
      const r2 = await applyOutboundReplyToOpenQuote(outbound, { extract: stubExtract });
      expect(["skipped_duplicate_event", "skipped_no_pending_quote"]).toContain(r2.status);
      const eventsAfter = await db
        .select({ id: quoteEvents.id })
        .from(quoteEvents)
        .where(and(
          eq(quoteEvents.quoteId, oppId),
          eq(quoteEvents.actor, "auto:outbound_reply"),
        ));
      expect(eventsAfter.length).toBe(1);
    } finally {
      await cleanup(c);
    }
  }, 30_000);

  it("drops a note (not a quote) when the AI extractor is uncertain", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-B2`, c);
      const threadId = `${TAG}-thread-B2`;
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-B2` },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);
      const outboundMsgId = await makeMessage(
        orgId,
        { direction: "outbound", threadId, providerMessageId: `${TAG}-out-B2`, body: "Working on it." },
        c,
      );
      const outbound = (await db.select().from(emailMessages).where(eq(emailMessages.id, outboundMsgId)).limit(1))[0];

      const stubExtract = async () => ({ isQuote: false, quotedAmount: null, confidence: "low" as const, equipment: null, validityDays: null });
      const r = await applyOutboundReplyToOpenQuote(outbound, { extract: stubExtract });
      expect(r.status).toBe("noted");

      const [updated] = await db
        .select({ outcomeStatus: quoteOpportunities.outcomeStatus })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(updated.outcomeStatus).toBe("pending");
    } finally {
      await cleanup(c);
    }
  }, 30_000);
});

describe("quote autopilot — no-response sweep (C)", () => {
  it("auto-closes a pending opp whose last event is older than the org timeout", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-C1`, c);
      const threadId = `${TAG}-thread-C1`;
      // Inbound message must be older than the synthetic last-event below;
      // otherwise the sweep correctly treats it as a fresh customer reply
      // and skips the close.
      const inboundSentAt = new Date(Date.now() - 5 * 3600 * 1000);
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-C1`, providerSentAt: inboundSentAt },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);
      const oldEventAt = new Date(Date.now() - 3 * 3600 * 1000); // 3h ago
      await db.insert(quoteEvents).values({
        quoteId: oppId,
        eventType: "requested",
        occurredAt: oldEventAt,
        actor: `${TAG}-cust-C1`,
        payload: { source: "email", providerMessageId: `${TAG}-in-C1` },
      });

      // Forward-only gate: pretend autopilot was activated at epoch so the
      // test's freshly-seeded events all count as "post-activation".
      const stats = await runQuoteNoResponseSweep(new Date(), { activatedAtOverride: new Date(0) });
      expect(stats.closed).toBeGreaterThanOrEqual(1);

      const [updated] = await db
        .select({ outcomeStatus: quoteOpportunities.outcomeStatus })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(updated.outcomeStatus).toBe("no_response");

      const evs = await db
        .select({ actor: quoteEvents.actor })
        .from(quoteEvents)
        .where(eq(quoteEvents.quoteId, oppId));
      expect(evs.some(e => e.actor === "auto:no_response_timeout")).toBe(true);
    } finally {
      await cleanup(c);
    }
  }, 30_000);

  it("skips a pending opp whose customer has replied since the last event", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-C2`, c);
      const threadId = `${TAG}-thread-C2`;
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-C2-orig`, providerSentAt: new Date(Date.now() - 4 * 3600 * 1000) },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);
      const oldEventAt = new Date(Date.now() - 3 * 3600 * 1000);
      await db.insert(quoteEvents).values({
        quoteId: oppId,
        eventType: "requested",
        occurredAt: oldEventAt,
        actor: `${TAG}-cust-C2`,
        payload: { source: "email" },
      });
      // Fresh inbound reply on same thread, AFTER the last event.
      await makeMessage(
        orgId,
        {
          direction: "inbound",
          threadId,
          providerMessageId: `${TAG}-in-C2-reply`,
          providerSentAt: new Date(Date.now() - 30 * 60 * 1000),
        },
        c,
      );

      await runQuoteNoResponseSweep(new Date(), { activatedAtOverride: new Date(0) });
      const [updated] = await db
        .select({ outcomeStatus: quoteOpportunities.outcomeStatus })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(updated.outcomeStatus).toBe("pending");
    } finally {
      await cleanup(c);
    }
  }, 30_000);

  it("skips a previously auto-closed opp that was just re-opened (one timeout window)", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-C3`, c);
      const threadId = `${TAG}-thread-C3`;
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-C3` },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);
      const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
      const recentReopen = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      // Simulate history: requested → auto-closed → reopened (a fresh
      // pending event from a rep). Last event is the reopen, and it's
      // newer than cutoff (2h default). Should defer regardless.
      await db.insert(quoteEvents).values([
        { quoteId: oppId, eventType: "requested", occurredAt: longAgo, actor: `${TAG}-cust-C3` },
        { quoteId: oppId, eventType: "auto_lost", occurredAt: new Date(Date.now() - 6 * 3600 * 1000), actor: "auto:no_response_timeout" },
        { quoteId: oppId, eventType: "note", occurredAt: recentReopen, actor: "manual_reopen" },
      ]);

      const stats = await runQuoteNoResponseSweep(new Date(), { activatedAtOverride: new Date(0) });
      const [updated] = await db
        .select({ outcomeStatus: quoteOpportunities.outcomeStatus })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(updated.outcomeStatus).toBe("pending");
      expect(stats.scannedOrgs).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(c);
    }
  }, 30_000);
});

describe("quote autopilot — new-contact-review helpers (A)", () => {
  it("lists pending prompts and clears them on dismiss with an auto:new_sender event", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-A1`, c);
      const oppId = await makePendingOpp(
        orgId,
        customerId,
        { messageId: null, threadId: null },
        c,
        {
          needsNewContactReview: {
            senderEmail: `newrep+${TAG}@known-customer.example`,
            senderName: "New Rep",
            customerId,
            customerName: `${TAG}-cust-A1`,
            detectedAt: new Date().toISOString(),
          },
        },
      );

      const items = await listNewContactReviews(orgId);
      const ours = items.find(i => i.quoteId === oppId);
      expect(ours).toBeDefined();
      expect(ours!.senderEmail).toBe(`newrep+${TAG}@known-customer.example`);

      const result = await resolveNewContactReview(orgId, oppId, "dismiss", "user-test");
      expect(result.status).toBe("dismissed");

      const [after] = await db
        .select({ flag: quoteOpportunities.needsNewContactReview })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(after.flag).toBeNull();

      const evs = await db
        .select({ actor: quoteEvents.actor, eventType: quoteEvents.eventType })
        .from(quoteEvents)
        .where(and(eq(quoteEvents.quoteId, oppId), eq(quoteEvents.actor, "auto:new_sender")));
      expect(evs.length).toBe(1);
      expect(evs[0].eventType).toBe("note");
    } finally {
      await cleanup(c);
    }
  }, 30_000);

  // Task #803 (A) review fix — suppression persistence. After a dismiss, an
  // email-level row must exist in quote_sender_mappings so a re-lookup of
  // the same sender returns it (and its presence short-circuits the
  // domain-only "new sender" novelty check on subsequent inbounds).
  it("dismiss writes an email-level sender_mapping that persists and short-circuits future prompts", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-A2`, c);
      const senderEmail = `dismiss-rep+${TAG}@known-customer-a2.example`;
      const oppId = await makePendingOpp(
        orgId,
        customerId,
        { messageId: null, threadId: null },
        c,
        {
          needsNewContactReview: {
            senderEmail,
            senderName: "Dismiss Rep",
            customerId,
            customerName: `${TAG}-cust-A2`,
            detectedAt: new Date().toISOString(),
          },
        },
      );

      const result = await resolveNewContactReview(orgId, oppId, "dismiss", "user-test");
      expect(result.status).toBe("dismissed");

      // The mapping must exist email-level, NOT domain-level — the DB
      // CHECK constraint enforces XOR; a violating insert would have
      // been swallowed and the row absent.
      const rows = await db
        .select()
        .from(quoteSenderMappings)
        .where(and(
          eq(quoteSenderMappings.organizationId, orgId),
          eq(quoteSenderMappings.senderEmail, senderEmail.toLowerCase()),
        ));
      expect(rows.length).toBe(1);
      expect(rows[0].senderEmail).toBe(senderEmail.toLowerCase());
      expect(rows[0].senderDomain).toBeNull();
      expect(rows[0].customerId).toBe(customerId);
      c.senderMappingIds.push(rows[0].id);

      // The lookupMapping path used by quoteEmailIngestion must now return
      // the email-level row for this sender — that's what causes the
      // novelty-flagger (which only triggers when learned.senderEmail is
      // null) to skip flagging this sender on future inbounds.
      const looked = await lookupMapping(orgId, senderEmail);
      expect(looked).not.toBeNull();
      expect(looked!.senderEmail).toBe(senderEmail.toLowerCase());

      // Repeat dismiss must be idempotent (no new prompt to clear, but
      // also no DB error from a duplicate insert thanks to
      // onConflictDoUpdate).
      const second = await resolveNewContactReview(orgId, oppId, "dismiss", "user-test");
      expect(second.status).toBe("no_pending_prompt");
      const rowsAfter2 = await db
        .select()
        .from(quoteSenderMappings)
        .where(eq(quoteSenderMappings.id, rows[0].id));
      expect(rowsAfter2.length).toBe(1);
    } finally {
      await cleanup(c);
    }
  }, 30_000);
});

// Task #803 review fix v6 — lifecycle regression coverage. The autopilot
// flips `pending` → `quoted` (intermediate state); the existing won/lost
// auto-detectors and the manual close path must continue to work on
// rows in that state. These tests guard against regressions where a
// hard `outcomeStatus === "pending"` filter silently strands quoted rows.
describe("quote autopilot — quoted lifecycle (B continuation)", () => {
  it("applyClosedWonToOpenQuote treats `quoted` rows as still-open and flips them to `won`", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-LW1`, c);
      const threadId = `${TAG}-thread-LW1`;
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-LW1`, body: "Quote please" },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId }, c);

      // Simulate the (B) auto-quote flip having already happened: row is
      // now `quoted`, not `pending`.
      await db
        .update(quoteOpportunities)
        .set({ outcomeStatus: "quoted" })
        .where(eq(quoteOpportunities.id, oppId));

      // Customer follow-up: "sounds good, book it." Older code returned
      // skipped_already_closed because of the `pending`-only filter.
      const replyMsgId = await makeMessage(
        orgId,
        { direction: "inbound", threadId, providerMessageId: `${TAG}-in-LW1-2`, body: "Sounds good, book it." },
        c,
      );
      const reply = (await db.select().from(emailMessages).where(eq(emailMessages.id, replyMsgId)).limit(1))[0];

      // intentSubtype hint short-circuits the won-language regex path so
      // the test doesn't depend on the exact phrase regex set.
      const r = await applyClosedWonToOpenQuote(reply, { intentSubtype: "closed_won_indicator" });
      expect(r.status).toBe("closed_won");

      const [final] = await db
        .select({ outcomeStatus: quoteOpportunities.outcomeStatus })
        .from(quoteOpportunities)
        .where(eq(quoteOpportunities.id, oppId));
      expect(final.outcomeStatus).toBe("won");
    } finally {
      await cleanup(c);
    }
  }, 30_000);

  it("markQuoteOutcome accepts a `quoted` row and transitions it to a terminal status", async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-LM1`, c);
      const inboundId = await makeMessage(
        orgId,
        { direction: "inbound", threadId: `${TAG}-thread-LM1`, providerMessageId: `${TAG}-in-LM1` },
        c,
      );
      const oppId = await makePendingOpp(orgId, customerId, { messageId: inboundId, threadId: `${TAG}-thread-LM1` }, c);

      await db
        .update(quoteOpportunities)
        .set({ outcomeStatus: "quoted" })
        .where(eq(quoteOpportunities.id, oppId));

      // Older code rejected with `already_terminal` because the guard was
      // `outcomeStatus !== "pending"`. The fix accepts both pending and
      // quoted as non-terminal.
      const r = await markQuoteOutcome(orgId, oppId, "won", null, "user-test");
      expect(r.status).toBe("updated");
      expect(r.outcomeStatus).toBe("won");

      // True terminal rows are still rejected (idempotency contract).
      const r2 = await markQuoteOutcome(orgId, oppId, "lost_price", null, "user-test");
      expect(r2.status).toBe("already_terminal");
    } finally {
      await cleanup(c);
    }
  }, 30_000);
});
