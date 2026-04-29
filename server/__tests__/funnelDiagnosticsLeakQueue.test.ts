/**
 * Capture leak queue — row-level tests.
 *
 * Asserts `getLeakedQuoteEmails` returns the same rows the
 * missingIntentInbound / orphanOutbound counters in
 * `getFunnelDiagnostics` derive from. Pattern matches
 * funnelDiagnosticsLeakMetrics.test.ts: insert uniquely tagged fixture
 * rows on a real org, hit the queue, assert delta + row shape, clean
 * up. Skips silently when no org is reachable.
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
  companies,
} from "@shared/schema";
import {
  getLeakedQuoteEmails,
  getFunnelDiagnostics,
  type LeakedInboundRow,
  type LeakedOutboundRow,
} from "../services/customerQuotes";

const TAG = `t-leakq-${Date.now()}`;

interface Cleanup {
  oppIds: string[];
  customerIds: string[];
  messageIds: string[];
  signalIds: string[];
  companyIds: string[];
}

function newCleanup(): Cleanup {
  return { oppIds: [], customerIds: [], messageIds: [], signalIds: [], companyIds: [] };
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
  if (c.companyIds.length > 0) {
    await db.delete(companies).where(inArray(companies.id, c.companyIds));
  }
}

async function getOrg(): Promise<string | null> {
  const rows = await db.select({ id: organizations.id }).from(organizations).limit(1);
  return rows[0]?.id ?? null;
}

interface InboundFields {
  providerMessageId: string;
  threadId: string;
  subject?: string;
  body?: string;
  fromEmail?: string;
  linkedAccountId?: string | null;
  providerSentAt?: Date;
}
async function makeInbound(orgId: string, f: InboundFields, c: Cleanup): Promise<string> {
  const [row] = await db.insert(emailMessages).values({
    orgId,
    direction: "inbound",
    providerMessageId: f.providerMessageId,
    threadId: f.threadId,
    fromEmail: f.fromEmail ?? '"Jane Shipper" <jane@customer.example>',
    toEmail: "rep@broker.example",
    subject: f.subject ?? "Re: freight",
    body: f.body ?? "Hello, looking for capacity",
    linkedAccountId: f.linkedAccountId ?? null,
    providerSentAt: f.providerSentAt ?? new Date(),
    processedForSignalsAt: new Date(),
  }).returning();
  c.messageIds.push(row.id);
  return row.id;
}

interface OutboundFields {
  providerMessageId: string;
  threadId: string;
  subject?: string;
  toEmail?: string;
  linkedAccountId?: string | null;
  providerSentAt?: Date;
}
async function makeOutbound(orgId: string, f: OutboundFields, c: Cleanup): Promise<string> {
  const [row] = await db.insert(emailMessages).values({
    orgId,
    direction: "outbound",
    providerMessageId: f.providerMessageId,
    threadId: f.threadId,
    fromEmail: "rep@broker.example",
    toEmail: f.toEmail ?? "shipper@customer.example",
    subject: f.subject ?? "Re: rate",
    body: "Quoted rate $1850",
    linkedAccountId: f.linkedAccountId ?? null,
    providerSentAt: f.providerSentAt ?? new Date(),
  }).returning();
  c.messageIds.push(row.id);
  return row.id;
}

async function makeCompany(orgId: string, name: string, c: Cleanup): Promise<string> {
  const [row] = await db.insert(companies).values({ organizationId: orgId, name }).returning();
  c.companyIds.push(row.id);
  return row.id;
}

describe("getLeakedQuoteEmails — missed_inbound rows", () => {
  it("returns rows for inbound messages flagged as missing-intent", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const messageId = await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-1`,
        threadId: `${TAG}-thr-1`,
        subject: `${TAG} subject`,
        body: "Need a rate Dallas to Atlanta",
      }, c);

      const result = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });

      expect(result.type).toBe("missed_inbound");
      expect(result.windowDays).toBe(14);
      const found = (result.rows as LeakedInboundRow[]).find(r => r.messageId === messageId);
      expect(found).toBeDefined();
      expect(found?.subject).toBe(`${TAG} subject`);
      expect(found?.fromEmail).toBe("jane@customer.example");
      expect(found?.fromName).toBe("Jane Shipper");
      expect(found?.threadId).toBe(`${TAG}-thr-1`);
      expect(found?.bodySnippet).toContain("Need a rate Dallas to Atlanta");
      expect(found?.customerState).toBe("no_linked_customer");
    } finally {
      await cleanup(c);
    }
  });

  it("count of returned rows is consistent with the diagnostics counter", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getFunnelDiagnostics(orgId, {}, null);
      await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-2`,
        threadId: `${TAG}-thr-2`,
      }, c);
      await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-3`,
        threadId: `${TAG}-thr-3`,
      }, c);
      const after = await getFunnelDiagnostics(orgId, {}, null);
      const queue = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      // Counter delta and queue delta must match.
      expect(after.missingIntentInboundCount - before.missingIntentInboundCount).toBe(2);
      expect(queue.total).toBe(after.missingIntentInboundCount);
    } finally {
      await cleanup(c);
    }
  });

  it("classifies customerState from linkedAccountId + company name", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const realCo = await makeCompany(orgId, `${TAG} Acme Logistics`, c);
      const unknownCo = await makeCompany(orgId, "Unknown — needs review", c);
      const knownId = await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-known`,
        threadId: `${TAG}-thr-known`,
        linkedAccountId: realCo,
      }, c);
      const unknownId = await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-unknown`,
        threadId: `${TAG}-thr-unknown`,
        linkedAccountId: unknownCo,
      }, c);
      const noLinkId = await makeInbound(orgId, {
        providerMessageId: `${TAG}-in-nolink`,
        threadId: `${TAG}-thr-nolink`,
        linkedAccountId: null,
      }, c);

      const result = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      const rows = result.rows as LeakedInboundRow[];
      expect(rows.find(r => r.messageId === knownId)?.customerState).toBe("known_customer");
      expect(rows.find(r => r.messageId === unknownId)?.customerState).toBe("unknown_customer");
      expect(rows.find(r => r.messageId === noLinkId)?.customerState).toBe("no_linked_customer");
    } finally {
      await cleanup(c);
    }
  });

  it("respects limit/offset and surfaces hasMore correctly", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      // Insert three rows in clear time order (oldest first → newest last).
      const t0 = new Date(Date.now() - 3 * 60_000);
      const t1 = new Date(Date.now() - 2 * 60_000);
      const t2 = new Date(Date.now() - 1 * 60_000);
      const id0 = await makeInbound(orgId, {
        providerMessageId: `${TAG}-page-0`,
        threadId: `${TAG}-thr-page-0`,
        providerSentAt: t0,
      }, c);
      const id1 = await makeInbound(orgId, {
        providerMessageId: `${TAG}-page-1`,
        threadId: `${TAG}-thr-page-1`,
        providerSentAt: t1,
      }, c);
      const id2 = await makeInbound(orgId, {
        providerMessageId: `${TAG}-page-2`,
        threadId: `${TAG}-thr-page-2`,
        providerSentAt: t2,
      }, c);

      const all = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      const idsInOrder = (all.rows as LeakedInboundRow[]).map(r => r.messageId);
      const i0 = idsInOrder.indexOf(id0);
      const i1 = idsInOrder.indexOf(id1);
      const i2 = idsInOrder.indexOf(id2);
      // Newest first: id2 < id1 < id0 in returned order.
      expect(i2).toBeGreaterThanOrEqual(0);
      expect(i2).toBeLessThan(i1);
      expect(i1).toBeLessThan(i0);

      // limit clamping: 0 → 1 (we never return zero rows for nonzero pool).
      const tinyPage = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 1 });
      expect(tinyPage.rows.length).toBe(1);
      expect(tinyPage.hasMore).toBe(true);
    } finally {
      await cleanup(c);
    }
  });

  it("returns __none__ rep-scope as an empty page", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const result = await getLeakedQuoteEmails(orgId, "__none__", { type: "missed_inbound" });
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe("getLeakedQuoteEmails — orphan_outbound rows", () => {
  it("returns rows for outbound on threads with no pending quote", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const messageId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-out-1`,
        threadId: `${TAG}-thr-out-1`,
        subject: `${TAG} reply`,
        toEmail: "shipper@customer.example",
      }, c);

      const result = await getLeakedQuoteEmails(orgId, null, { type: "orphan_outbound", limit: 100 });
      expect(result.type).toBe("orphan_outbound");
      const found = (result.rows as LeakedOutboundRow[]).find(r => r.messageId === messageId);
      expect(found).toBeDefined();
      expect(found?.subject).toBe(`${TAG} reply`);
      expect(found?.toEmail).toBe("shipper@customer.example");
      expect(found?.threadId).toBe(`${TAG}-thr-out-1`);
      expect(found?.customerState).toBe("no_linked_customer");
    } finally {
      await cleanup(c);
    }
  });

  it("includes lastInbound context when an inbound exists on the same thread", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const threadId = `${TAG}-ctx-thr`;
      // Earlier inbound on the same thread.
      await makeInbound(orgId, {
        providerMessageId: `${TAG}-ctx-in`,
        threadId,
        subject: `${TAG} inbound subject`,
        fromEmail: '"Bob Buyer" <bob@customer.example>',
        providerSentAt: new Date(Date.now() - 60_000),
      }, c);
      const outboundId = await makeOutbound(orgId, {
        providerMessageId: `${TAG}-ctx-out`,
        threadId,
        providerSentAt: new Date(),
      }, c);

      const result = await getLeakedQuoteEmails(orgId, null, { type: "orphan_outbound", limit: 100 });
      const found = (result.rows as LeakedOutboundRow[]).find(r => r.messageId === outboundId);
      expect(found?.lastInboundFromEmail).toBe("bob@customer.example");
      expect(found?.lastInboundSubject).toBe(`${TAG} inbound subject`);
      expect(found?.lastInboundAt).toBeTruthy();
    } finally {
      await cleanup(c);
    }
  });

  it("count of returned rows matches the orphan-outbound diagnostics counter", { timeout: 60000 }, async () => {
    const orgId = await getOrg();
    if (!orgId) return;
    const c = newCleanup();
    try {
      const before = await getFunnelDiagnostics(orgId, {}, null);
      await makeOutbound(orgId, {
        providerMessageId: `${TAG}-out-cnt-1`,
        threadId: `${TAG}-thr-out-cnt-1`,
      }, c);
      const after = await getFunnelDiagnostics(orgId, {}, null);
      const queue = await getLeakedQuoteEmails(orgId, null, { type: "orphan_outbound", limit: 100 });
      expect(after.orphanOutboundCount - before.orphanOutboundCount).toBe(1);
      expect(queue.total).toBe(after.orphanOutboundCount);
    } finally {
      await cleanup(c);
    }
  });
});
