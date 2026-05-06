/**
 * Funnel diagnostics — leak counter tests.
 *
 * Asserts the three additive fields on `FunnelDiagnostics`:
 *   - missingIntentInboundCount  (inbound message processed but no quote
 *                                  intent + no quote opportunity)
 *   - orphanOutboundCount         (outbound message on a thread with no
 *                                  pending quote opportunity)
 *   - hasWebhookSecret            (mirrors process.env.OUTLOOK_WEBHOOK_SECRET)
 *
 * Pattern mirrors quoteAutopilot.test.ts: each test creates uniquely
 * tagged fixture rows on a real organization, exercises
 * `getFunnelDiagnostics`, asserts the relevant count *increased* by the
 * expected delta (so concurrent fixture rows from other tests don't make
 * us flake), and cleans up its own artifacts. Skips silently when no
 * org is reachable.
 */
import { describe, it, expect } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../storage";
import {
  emailMessages,
  emailSignals,
  organizations,
  quoteCustomers,
  quoteEvents,
  quoteOpportunities,
} from "@shared/schema";
import { getFunnelDiagnostics } from "../services/customerQuotes";

const TAG = `t-leak-${Date.now()}`;

interface Cleanup {
  oppIds: string[];
  customerIds: string[];
  messageIds: string[];
  signalIds: string[];
}

function newCleanup(): Cleanup {
  return { oppIds: [], customerIds: [], messageIds: [], signalIds: [] };
}

async function cleanup(c: Cleanup): Promise<void> {
  if (c.signalIds.length > 0) {
    await db.delete(emailSignals).where(inArray(emailSignals.id, c.signalIds));
  }
  if (c.oppIds.length > 0) {
    await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, c.oppIds));
    await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, c.oppIds));
  }
  if (c.messageIds.length > 0) {
    await db.delete(emailMessages).where(inArray(emailMessages.id, c.messageIds));
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
    .values({ organizationId: orgId, name })
    .returning();
  c.customerIds.push(row.id);
  return row.id;
}

async function makeInboundMessage(
  orgId: string,
  fields: { providerMessageId: string; threadId: string; subject?: string; body?: string },
  c: Cleanup,
): Promise<string> {
  const [row] = await db
    .insert(emailMessages)
    .values({
      orgId,
      direction: "inbound",
      providerMessageId: fields.providerMessageId,
      threadId: fields.threadId,
      fromEmail: "shipper@customer.example",
      toEmail: "rep@broker.example",
      subject: fields.subject ?? "Re: freight",
      body: fields.body ?? "Hello, looking for capacity",
      providerSentAt: new Date(),
      processedForSignalsAt: new Date(),
    })
    .returning();
  c.messageIds.push(row.id);
  return row.id;
}

async function makeOutboundMessage(
  orgId: string,
  fields: { providerMessageId: string; threadId: string; subject?: string },
  c: Cleanup,
): Promise<string> {
  const [row] = await db
    .insert(emailMessages)
    .values({
      orgId,
      direction: "outbound",
      providerMessageId: fields.providerMessageId,
      threadId: fields.threadId,
      fromEmail: "rep@broker.example",
      toEmail: "shipper@customer.example",
      subject: fields.subject ?? "Re: rate",
      body: "Quoted rate $1850",
      providerSentAt: new Date(),
    })
    .returning();
  c.messageIds.push(row.id);
  return row.id;
}

async function getCounts(orgId: string): Promise<{
  missingIntentInboundCount: number;
  orphanOutboundCount: number;
  hasWebhookSecret: boolean;
}> {
  const d = await getFunnelDiagnostics(orgId, {}, null);
  return {
    missingIntentInboundCount: d.missingIntentInboundCount,
    orphanOutboundCount: d.orphanOutboundCount,
    hasWebhookSecret: d.hasWebhookSecret,
  };
}

describe("getFunnelDiagnostics — missingIntentInboundCount", () => {
  it("counts inbound processed messages with no quote intent and no quote opportunity", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getCounts(orgId);

      // (a) Inbound + processed + no quote intent + no opportunity → SHOULD count.
      await makeInboundMessage(
        orgId,
        { providerMessageId: `${TAG}-miss-1`, threadId: `${TAG}-thr-miss-1`, subject: `${TAG} hello` },
        c,
      );
      // (b) Inbound + processed + has a quote-intent signal → should NOT count.
      const m2 = await makeInboundMessage(
        orgId,
        { providerMessageId: `${TAG}-miss-2`, threadId: `${TAG}-thr-miss-2` },
        c,
      );
      const [s] = await db
        .insert(emailSignals)
        .values({ messageId: m2, intentType: "pricing_request", actorType: "customer" })
        .returning();
      c.signalIds.push(s.id);

      // (c) Inbound + processed + linked to a quote opportunity → should NOT count.
      const m3 = await makeInboundMessage(
        orgId,
        { providerMessageId: `${TAG}-miss-3`, threadId: `${TAG}-thr-miss-3` },
        c,
      );
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-miss-3`, c);
      const [opp] = await db
        .insert(quoteOpportunities)
        .values({
          organizationId: orgId,
          customerId,
          requestDate: new Date(),
          originCity: "Chicago",
          originState: "IL",
          destCity: "Atlanta",
          destState: "GA",
          equipment: "Dry Van",
          outcomeStatus: "pending",
          source: "email",
          sourceReference: m3,
          validThrough: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        })
        .returning();
      c.oppIds.push(opp.id);

      const after = await getCounts(orgId);
      // Only fixture (a) should bump the counter — others are excluded.
      expect(after.missingIntentInboundCount).toBe(before.missingIntentInboundCount + 1);
    } finally {
      await cleanup(c);
    }
  });

  it("does not count inbound messages whose providerSentAt is older than the window", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getCounts(orgId);
      const oldDate = new Date(Date.now() - 90 * 24 * 3600 * 1000);
      const [row] = await db
        .insert(emailMessages)
        .values({
          orgId,
          direction: "inbound",
          providerMessageId: `${TAG}-old`,
          threadId: `${TAG}-thr-old`,
          fromEmail: "shipper@customer.example",
          toEmail: "rep@broker.example",
          subject: `${TAG} stale`,
          body: "Old message",
          providerSentAt: oldDate,
          processedForSignalsAt: oldDate,
        })
        .returning();
      c.messageIds.push(row.id);
      const after = await getCounts(orgId);
      expect(after.missingIntentInboundCount).toBe(before.missingIntentInboundCount);
    } finally {
      await cleanup(c);
    }
  });

  it("does not count inbound messages that have not been processed", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getCounts(orgId);
      const [row] = await db
        .insert(emailMessages)
        .values({
          orgId,
          direction: "inbound",
          providerMessageId: `${TAG}-unproc`,
          threadId: `${TAG}-thr-unproc`,
          fromEmail: "shipper@customer.example",
          toEmail: "rep@broker.example",
          subject: `${TAG} unprocessed`,
          body: "Awaiting extraction",
          providerSentAt: new Date(),
          processedForSignalsAt: null,
        })
        .returning();
      c.messageIds.push(row.id);
      const after = await getCounts(orgId);
      expect(after.missingIntentInboundCount).toBe(before.missingIntentInboundCount);
    } finally {
      await cleanup(c);
    }
  });
});

describe("getFunnelDiagnostics — orphanOutboundCount", () => {
  it("counts outbound messages on threads with no pending quote opportunity", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getCounts(orgId);

      // (a) Outbound on a thread with NO quote opportunity → SHOULD count.
      await makeOutboundMessage(
        orgId,
        { providerMessageId: `${TAG}-orphan-1`, threadId: `${TAG}-thr-orphan-1` },
        c,
      );

      // (b) Outbound on a thread with a PENDING quote opportunity → should NOT count.
      const customerId = await ensureCustomer(orgId, `${TAG}-cust-orphan-2`, c);
      const inboundB = await makeInboundMessage(
        orgId,
        { providerMessageId: `${TAG}-orphan-2-in`, threadId: `${TAG}-thr-orphan-2` },
        c,
      );
      const [oppB] = await db
        .insert(quoteOpportunities)
        .values({
          organizationId: orgId,
          customerId,
          requestDate: new Date(),
          originCity: "Chicago",
          originState: "IL",
          destCity: "Atlanta",
          destState: "GA",
          equipment: "Dry Van",
          outcomeStatus: "pending",
          source: "email",
          sourceReference: inboundB,
          validThrough: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        })
        .returning();
      c.oppIds.push(oppB.id);
      await makeOutboundMessage(
        orgId,
        { providerMessageId: `${TAG}-orphan-2-out`, threadId: `${TAG}-thr-orphan-2` },
        c,
      );

      // (c) Inbound (not outbound) on a no-pending thread → should NOT count.
      await makeInboundMessage(
        orgId,
        { providerMessageId: `${TAG}-orphan-3-in`, threadId: `${TAG}-thr-orphan-3` },
        c,
      );

      const after = await getCounts(orgId);
      // Only fixture (a) should bump the counter.
      expect(after.orphanOutboundCount).toBe(before.orphanOutboundCount + 1);
    } finally {
      await cleanup(c);
    }
  });

  it("does not count outbound messages outside the window", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getCounts(orgId);
      const oldDate = new Date(Date.now() - 90 * 24 * 3600 * 1000);
      const [row] = await db
        .insert(emailMessages)
        .values({
          orgId,
          direction: "outbound",
          providerMessageId: `${TAG}-orphan-old`,
          threadId: `${TAG}-thr-orphan-old`,
          fromEmail: "rep@broker.example",
          toEmail: "shipper@customer.example",
          subject: `${TAG} stale outbound`,
          body: "Old reply",
          providerSentAt: oldDate,
        })
        .returning();
      c.messageIds.push(row.id);
      const after = await getCounts(orgId);
      expect(after.orphanOutboundCount).toBe(before.orphanOutboundCount);
    } finally {
      await cleanup(c);
    }
  });
});

describe("getFunnelDiagnostics — hasWebhookSecret", () => {
  it("mirrors process.env.OUTLOOK_WEBHOOK_SECRET", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const original = process.env.OUTLOOK_WEBHOOK_SECRET;
    try {
      process.env.OUTLOOK_WEBHOOK_SECRET = "test-secret-value";
      const onCounts = await getCounts(orgId);
      expect(onCounts.hasWebhookSecret).toBe(true);

      delete process.env.OUTLOOK_WEBHOOK_SECRET;
      const offCounts = await getCounts(orgId);
      expect(offCounts.hasWebhookSecret).toBe(false);

      process.env.OUTLOOK_WEBHOOK_SECRET = "   ";
      const whitespaceCounts = await getCounts(orgId);
      expect(whitespaceCounts.hasWebhookSecret).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.OUTLOOK_WEBHOOK_SECRET;
      } else {
        process.env.OUTLOOK_WEBHOOK_SECRET = original;
      }
    }
  });

  it("is also returned in the __none__ shortcut payload", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const original = process.env.OUTLOOK_WEBHOOK_SECRET;
    try {
      process.env.OUTLOOK_WEBHOOK_SECRET = "test-secret-shortcut";
      const d = await getFunnelDiagnostics(orgId, {}, "__none__");
      expect(d.hasWebhookSecret).toBe(true);
      expect(d.missingIntentInboundCount).toBe(0);
      expect(d.orphanOutboundCount).toBe(0);
    } finally {
      if (original === undefined) {
        delete process.env.OUTLOOK_WEBHOOK_SECRET;
      } else {
        process.env.OUTLOOK_WEBHOOK_SECRET = original;
      }
    }
  });
});
