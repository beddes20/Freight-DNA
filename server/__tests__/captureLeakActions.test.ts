/**
 * Capture Leak Queue — Phase 2A (review/dismiss) + Phase 2B (manual create)
 * regression tests for the service layer.
 *
 * Mirrors the fixture/cleanup pattern used by
 * `funnelDiagnosticsLeakQueue.test.ts`: insert uniquely tagged rows on a
 * real organization, exercise the service, assert behavior, clean up.
 * Skips silently when no organization is reachable.
 *
 * What's covered:
 *   2A — reviewLeakRow:
 *     • Records `not_quote` and removes the row from the queue (lock-step
 *       with the diagnostics counter).
 *     • Records `ignored` likewise.
 *     • Idempotent: re-reviewing the same (messageId, leakType) updates the
 *       existing row instead of inserting a duplicate.
 *     • Cross-tenant: foreign-org messageId returns `not_found` and writes
 *       nothing.
 *
 *   2B — manuallyCreateQuoteFromLeakRow:
 *     • On a parseable inbound row, creates a `quote_opportunities` row,
 *       writes one `quote_events` audit row with `actor=manual_leak_create`,
 *       and removes the row from the leak queue.
 *     • Diagnostics counter and the queue both decrement together (no
 *       separate `capture_leak_reviews` row required — the new quote is
 *       the resolution evidence).
 *     • Returns `wrong_direction` for outbound, `not_found` for foreign-org,
 *       `not_a_leak` when the row is no longer a candidate (e.g. already
 *       reviewed via Phase 2A).
 *     • Returns `duplicate` when called twice for the same email and the
 *       second call surfaces the same quote id.
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
  manuallyCreateQuoteFromLeakRow,
  _isManualLeakCreateInFlightForTests,
  _resetManualLeakCreateInFlightForTests,
  type LeakedInboundRow,
} from "../services/customerQuotes";

const TAG = `t-leakact-${Date.now()}`;

/**
 * `capture_leak_reviews.decided_by_user_id` has an FK on `users.id`, so we
 * can't fabricate a synthetic actor — fetch any real user. Tests skip if
 * none exists, mirroring the org-skip pattern used elsewhere.
 */
async function getActorId(): Promise<string | null> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows[0]?.id ?? null;
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
    // capture_leak_reviews is FK'd to email_messages, so remove leftover rows
    // for any leftover (untracked) review created mid-test.
    await db.delete(captureLeakReviews).where(inArray(captureLeakReviews.messageId, c.messageIds));
    await db.delete(emailMessages).where(inArray(emailMessages.id, c.messageIds));
  }
  if (c.customerIds.length > 0) {
    await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, c.customerIds));
  }
}

async function getOrgs(): Promise<string[]> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .limit(2);
  return rows.map(r => r.id);
}

interface InboundFields {
  providerMessageId: string;
  threadId: string;
  subject?: string;
  body?: string;
  fromEmail?: string;
  direction?: "inbound" | "outbound";
}
async function makeMessage(orgId: string, f: InboundFields, c: Cleanup): Promise<string> {
  const direction = f.direction ?? "inbound";
  const [row] = await db.insert(emailMessages).values({
    orgId,
    direction,
    providerMessageId: f.providerMessageId,
    threadId: f.threadId,
    fromEmail: direction === "inbound"
      ? (f.fromEmail ?? '"Jane Shipper" <jane@customer.example>')
      : "rep@broker.example",
    toEmail: direction === "inbound" ? "rep@broker.example" : "shipper@customer.example",
    subject: f.subject ?? "Re: freight",
    body: f.body ?? "Hello, looking for capacity",
    linkedAccountId: null,
    providerSentAt: new Date(),
    processedForSignalsAt: direction === "inbound" ? new Date() : null,
  }).returning();
  c.messageIds.push(row.id);
  return row.id;
}

// Body that the heuristic LANE_RE will parse cleanly:
//   "Dallas, TX to Atlanta, GA"  → ParsedQuoteFields with full lane.
const PARSEABLE_BODY =
  "Hi team, please quote a load from Dallas, TX to Atlanta, GA picking up tomorrow. Thanks.";

describe("reviewLeakRow — Phase 2A", () => {
  it("not_quote removes the row from the leak queue and decrements the counter", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-rv-nq`,
        threadId: `${TAG}-thr-rv-nq`,
        subject: `${TAG} review-nq`,
      }, c);

      const before = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      const beforeDiag = await getFunnelDiagnostics(orgId, {}, null);
      expect((before.rows as LeakedInboundRow[]).some(r => r.messageId === messageId)).toBe(true);

      const result = await reviewLeakRow(orgId, actorId, {
        messageId,
        leakType: "missed_inbound",
        decision: "not_quote",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") c.reviewIds.push(result.review.id);

      const after = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      const afterDiag = await getFunnelDiagnostics(orgId, {}, null);
      expect((after.rows as LeakedInboundRow[]).some(r => r.messageId === messageId)).toBe(false);
      // Lock-step: queue row vanished AND counter dropped by exactly 1
      // (any concurrent inserts cancel because we use deltas).
      expect(beforeDiag.missingIntentInboundCount - afterDiag.missingIntentInboundCount).toBe(1);
      expect(after.total).toBe(afterDiag.missingIntentInboundCount);
    } finally {
      await cleanup(c);
    }
  });

  it("ignored decision likewise removes the row from the queue", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-rv-ig`,
        threadId: `${TAG}-thr-rv-ig`,
      }, c);

      const beforeDiag = await getFunnelDiagnostics(orgId, {}, null);
      const result = await reviewLeakRow(orgId, actorId, {
        messageId,
        leakType: "missed_inbound",
        decision: "ignored",
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") c.reviewIds.push(result.review.id);

      const afterDiag = await getFunnelDiagnostics(orgId, {}, null);
      const after = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      expect((after.rows as LeakedInboundRow[]).some(r => r.messageId === messageId)).toBe(false);
      expect(beforeDiag.missingIntentInboundCount - afterDiag.missingIntentInboundCount).toBe(1);
    } finally {
      await cleanup(c);
    }
  });

  it("is idempotent — second review of the same row updates instead of inserting", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-rv-idem`,
        threadId: `${TAG}-thr-rv-idem`,
      }, c);

      const r1 = await reviewLeakRow(orgId, actorId, {
        messageId, leakType: "missed_inbound", decision: "not_quote",
      });
      const r2 = await reviewLeakRow(orgId, actorId, {
        messageId, leakType: "missed_inbound", decision: "ignored",
      });
      expect(r1.status).toBe("ok");
      expect(r2.status).toBe("ok");
      if (r1.status === "ok") c.reviewIds.push(r1.review.id);
      if (r2.status === "ok" && r2.review.id !== (r1.status === "ok" ? r1.review.id : "")) {
        c.reviewIds.push(r2.review.id);
      }

      // Only one persisted review row for this (messageId, leakType).
      const persisted = await db.select().from(captureLeakReviews).where(
        and(
          eq(captureLeakReviews.messageId, messageId),
          eq(captureLeakReviews.leakType, "missed_inbound"),
        ),
      );
      expect(persisted).toHaveLength(1);
      // Decision was updated to the latest value.
      expect(persisted[0].decision).toBe("ignored");
    } finally {
      await cleanup(c);
    }
  });

  it("cross-tenant: foreign-org messageId returns not_found with no DB write", { timeout: 60000 }, async () => {
    const orgs = await getOrgs();
    const actorId = await getActorId();
    if (orgs.length < 2 || !actorId) return;
    const [ownerOrg, attackerOrg] = orgs;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(ownerOrg, {
        providerMessageId: `${TAG}-rv-xtenant`,
        threadId: `${TAG}-thr-rv-xtenant`,
      }, c);

      const result = await reviewLeakRow(attackerOrg, actorId, {
        messageId,
        leakType: "missed_inbound",
        decision: "not_quote",
      });
      expect(result.status).toBe("not_found");

      // Owner org's queue still surfaces the row — nothing was written.
      const stillThere = await getLeakedQuoteEmails(ownerOrg, null, { type: "missed_inbound", limit: 100 });
      expect((stillThere.rows as LeakedInboundRow[]).some(r => r.messageId === messageId)).toBe(true);
      const reviewRows = await db.select().from(captureLeakReviews).where(eq(captureLeakReviews.messageId, messageId));
      expect(reviewRows).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });
});

describe("manuallyCreateQuoteFromLeakRow — Phase 2B", () => {
  it("creates a quote, writes audit event, and removes the row from the queue", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-ok`,
        threadId: `${TAG}-thr-mc-ok`,
        subject: `${TAG} please quote`,
        body: PARSEABLE_BODY,
      }, c);

      const beforeDiag = await getFunnelDiagnostics(orgId, {}, null);

      const result = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(result.status).toBe("created");
      if (result.status !== "created") return;
      const quoteId = result.quoteId;
      c.oppIds.push(quoteId);

      // Quote row exists.
      const opp = await db.select().from(quoteOpportunities).where(eq(quoteOpportunities.id, quoteId));
      expect(opp).toHaveLength(1);
      // Track customer for cleanup.
      if (opp[0].customerId) c.customerIds.push(opp[0].customerId);

      // Exactly one quote_events row with actor=manual_leak_create exists.
      const events = await db.select().from(quoteEvents).where(eq(quoteEvents.quoteId, quoteId));
      const manualEvents = events.filter(e => e.actor === "manual_leak_create");
      expect(manualEvents).toHaveLength(1);

      // Queue + counter both drop in lock-step.
      const afterDiag = await getFunnelDiagnostics(orgId, {}, null);
      const after = await getLeakedQuoteEmails(orgId, null, { type: "missed_inbound", limit: 100 });
      expect((after.rows as LeakedInboundRow[]).some(r => r.messageId === messageId)).toBe(false);
      expect(beforeDiag.missingIntentInboundCount - afterDiag.missingIntentInboundCount).toBe(1);
      expect(after.total).toBe(afterDiag.missingIntentInboundCount);
    } finally {
      await cleanup(c);
    }
  });

  it("second call for the same email returns duplicate with the same quote id", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-dup`,
        threadId: `${TAG}-thr-mc-dup`,
        subject: `${TAG} dup quote`,
        body: PARSEABLE_BODY,
      }, c);

      const first = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(first.status).toBe("created");
      if (first.status !== "created") return;
      c.oppIds.push(first.quoteId);

      const second = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(second.status).toBe("duplicate");
      if (second.status === "duplicate") {
        expect(second.quoteId).toBe(first.quoteId);
      }

      const opp = await db.select().from(quoteOpportunities).where(eq(quoteOpportunities.id, first.quoteId));
      if (opp[0]?.customerId) c.customerIds.push(opp[0].customerId);
    } finally {
      await cleanup(c);
    }
  });

  it("returns wrong_direction for an outbound message", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-out`,
        threadId: `${TAG}-thr-mc-out`,
        direction: "outbound",
      }, c);

      const result = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(result.status).toBe("wrong_direction");
    } finally {
      await cleanup(c);
    }
  });

  it("returns not_found for a foreign-org messageId", { timeout: 60000 }, async () => {
    const orgs = await getOrgs();
    const actorId = await getActorId();
    if (orgs.length < 2 || !actorId) return;
    const [ownerOrg, attackerOrg] = orgs;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(ownerOrg, {
        providerMessageId: `${TAG}-mc-xtenant`,
        threadId: `${TAG}-thr-mc-xtenant`,
        body: PARSEABLE_BODY,
      }, c);

      const result = await manuallyCreateQuoteFromLeakRow(attackerOrg, actorId, messageId);
      expect(result.status).toBe("not_found");

      // No quote was created for the owner org either.
      const opps = await db.select().from(quoteOpportunities)
        .where(eq(quoteOpportunities.sourceReference, `${TAG}-mc-xtenant`));
      expect(opps).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });

  it("returns not_a_leak after the row has been reviewed via Phase 2A", { timeout: 60000 }, async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-nal`,
        threadId: `${TAG}-thr-mc-nal`,
        body: PARSEABLE_BODY,
      }, c);

      // Phase 2A first — marks the row as reviewed; the candidate filter
      // now excludes it.
      const rev = await reviewLeakRow(orgId, actorId, {
        messageId, leakType: "missed_inbound", decision: "not_quote",
      });
      expect(rev.status).toBe("ok");
      if (rev.status === "ok") c.reviewIds.push(rev.review.id);

      // Phase 2B should now refuse to create.
      const result = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(result.status).toBe("not_a_leak");

      // No quote row was created.
      const opps = await db.select().from(quoteOpportunities)
        .where(eq(quoteOpportunities.sourceReference, `${TAG}-mc-nal`));
      expect(opps).toHaveLength(0);
    } finally {
      await cleanup(c);
    }
  });

  // Race-safety: two concurrent admin clicks on the same row must
  // converge to a single quote row, not two. Guards against the
  // ingestQuoteFromEmail SELECT-then-INSERT window having no DB unique
  // constraint on (organization_id, source, source_reference). The
  // in-process per-(orgId, messageId) mutex inside
  // `manuallyCreateQuoteFromLeakRow` is what makes this safe.
  it("serializes concurrent create calls on the same (orgId, messageId)", async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;

    _resetManualLeakCreateInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-race`,
        threadId: `${TAG}-thr-mc-race`,
        body: PARSEABLE_BODY,
      }, c);

      // Fire both calls before awaiting — without the mutex, both pass
      // the SELECT dup-check inside ingestQuoteFromEmail and both INSERT.
      const [a, b] = await Promise.all([
        manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId),
        manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId),
      ]);

      // Mutex is released after both promises resolve.
      expect(_isManualLeakCreateInFlightForTests(orgId, messageId)).toBe(false);

      // Exactly one quote row exists for this messageId — never two.
      const opps = await db.select().from(quoteOpportunities)
        .where(eq(quoteOpportunities.sourceReference, `${TAG}-mc-race`));
      expect(opps).toHaveLength(1);
      const quoteId = opps[0].id;
      c.oppIds.push(quoteId);

      // Both callers see the same quoteId. Statuses converge: both
      // calls return the *same* in-flight promise, so both report
      // "created" with the same id (single insert, single resolution).
      // (Not "created"+"duplicate" — that would imply two DB calls.)
      expect(a.status).toBe("created");
      expect(b.status).toBe("created");
      if (a.status === "created" && b.status === "created") {
        expect(a.quoteId).toBe(quoteId);
        expect(b.quoteId).toBe(quoteId);
      }

      // Audit row is also written exactly once (matches the single
      // create path, even though two callers were waiting on it).
      const events = await db.select().from(quoteEvents).where(and(
        eq(quoteEvents.quoteId, quoteId),
        eq(quoteEvents.actor, "manual_leak_create"),
      ));
      expect(events).toHaveLength(1);
    } finally {
      await cleanup(c);
    }
  });

  // After the in-flight promise resolves, a *subsequent* call lands in
  // the dup-check path and returns `duplicate` with the same quoteId —
  // proving the mutex doesn't stick around past completion.
  it("after-the-fact second call returns duplicate with same quoteId", async () => {
    const [orgId] = await getOrgs();
    const actorId = await getActorId();
    if (!orgId || !actorId) return;

    _resetManualLeakCreateInFlightForTests();
    const c = newCleanup();
    try {
      const messageId = await makeMessage(orgId, {
        providerMessageId: `${TAG}-mc-aft`,
        threadId: `${TAG}-thr-mc-aft`,
        body: PARSEABLE_BODY,
      }, c);

      const first = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(first.status).toBe("created");
      if (first.status !== "created") return;
      c.oppIds.push(first.quoteId);

      // Mutex must have been released after the first call resolved.
      expect(_isManualLeakCreateInFlightForTests(orgId, messageId)).toBe(false);

      // Second call now goes through the candidate-set check, finds
      // the row missing (because the new quote's sourceReference filters
      // it out), and resolves to the existing quote via the duplicate path.
      const second = await manuallyCreateQuoteFromLeakRow(orgId, actorId, messageId);
      expect(second.status).toBe("duplicate");
      if (second.status === "duplicate") {
        expect(second.quoteId).toBe(first.quoteId);
      }
    } finally {
      await cleanup(c);
    }
  });
});
