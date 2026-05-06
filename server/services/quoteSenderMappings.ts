/**
 * Customer Quotes #3 — Sender-Domain Learning.
 *
 * When a rep manually moves a quote out of the "Unknown — needs review"
 * bucket into a real customer, we record the sender's domain (or, for
 * free-mail senders, the full sender email) so the NEXT inbound email
 * from that sender auto-classifies into the same customer.
 *
 * Lookup precedence at ingest:
 *   1. exact (org, sender_email)  match  — wins
 *   2. exact (org, sender_domain) match  — falls back
 *   3. nothing                          — caller proceeds with the
 *                                         existing name-resolver heuristic
 *
 * Write rules at learn-time:
 *   - business-domain sender → write a domain-level row
 *   - free-mail sender       → write an email-level row (per-sender override)
 *   - skip if target customer is the Unknown bucket itself
 *   - skip if target customer is party_type='carrier' (we don't want to
 *     re-route real customer quotes to a carrier row by mistake)
 *
 * The DB enforces "exactly one of sender_email / sender_domain" via a CHECK
 * constraint and "one mapping per scope" via two partial unique indexes
 * (see server/runMigrations.ts).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteSenderMappings,
  quoteCustomers,
  emailMessages,
  type QuoteSenderMapping,
} from "@shared/schema";
import {
  UNKNOWN_CUSTOMER_NAME,
  parseFromHeader,
  isFreeMailDomain,
} from "./customerNameResolver";

export interface SenderInfo {
  email: string;
  domain: string;
  isFreeMail: boolean;
}

/**
 * Pure parser. Returns null when the input is not a usable email
 * (missing, empty, malformed, or domain-less).
 */
export function extractSenderInfo(fromEmail: string | null | undefined): SenderInfo | null {
  const parsed = parseFromHeader(fromEmail);
  if (!parsed) return null;
  if (!parsed.domain) return null;
  return {
    email: parsed.email,
    domain: parsed.domain,
    isFreeMail: isFreeMailDomain(parsed.domain),
  };
}

/**
 * Look up a learned mapping for an inbound sender. Email-level matches
 * take precedence over domain-level matches; returns null when nothing
 * is learned.
 *
 * Task #849 §3.2 — *Suppression* rows (`suppressed=true`) are excluded
 * from this query. A suppressed sender must not auto-route to a learned
 * customer (and the canonical row is `customerId=NULL` anyway). The
 * autopilot path uses `findSuppressionMapping` below to detect
 * suppressions explicitly.
 */
export async function lookupMapping(
  orgId: string,
  fromEmail: string | null | undefined,
): Promise<QuoteSenderMapping | null> {
  const info = extractSenderInfo(fromEmail);
  if (!info) return null;

  // Try exact-email match first (highest specificity).
  const [byEmail] = await db.select().from(quoteSenderMappings).where(and(
    eq(quoteSenderMappings.organizationId, orgId),
    eq(quoteSenderMappings.senderEmail, info.email),
    eq(quoteSenderMappings.suppressed, false),
  )).limit(1);
  if (byEmail) return byEmail;

  // Domain match second. Skip the lookup entirely for free-mail senders
  // because we never store domain mappings for them — they would route
  // every gmail user to whichever real customer was learned first.
  if (!info.isFreeMail) {
    const [byDomain] = await db.select().from(quoteSenderMappings).where(and(
      eq(quoteSenderMappings.organizationId, orgId),
      eq(quoteSenderMappings.senderDomain, info.domain),
      eq(quoteSenderMappings.suppressed, false),
    )).limit(1);
    if (byDomain) return byDomain;
  }

  return null;
}

/**
 * Task #849 §3.2 — Look up a suppression mapping for an inbound sender.
 * Returns the matching row when one exists with `suppressed=true`,
 * regardless of whether the sender is free-mail (suppression is
 * intentional per-sender). The autopilot path uses this to skip
 * opportunity creation entirely.
 */
export async function findSuppressionMapping(
  orgId: string,
  fromEmail: string | null | undefined,
): Promise<QuoteSenderMapping | null> {
  const info = extractSenderInfo(fromEmail);
  if (!info) return null;

  const [byEmail] = await db.select().from(quoteSenderMappings).where(and(
    eq(quoteSenderMappings.organizationId, orgId),
    eq(quoteSenderMappings.senderEmail, info.email),
    eq(quoteSenderMappings.suppressed, true),
  )).limit(1);
  if (byEmail) return byEmail;

  if (!info.isFreeMail) {
    const [byDomain] = await db.select().from(quoteSenderMappings).where(and(
      eq(quoteSenderMappings.organizationId, orgId),
      eq(quoteSenderMappings.senderDomain, info.domain),
      eq(quoteSenderMappings.suppressed, true),
    )).limit(1);
    if (byDomain) return byDomain;
  }

  return null;
}

/**
 * Increment sample_count + lastUsedAt for a mapping after we apply it.
 * Fire-and-forget at the call site — failure here is non-fatal.
 */
export async function bumpHit(mappingId: string): Promise<void> {
  await db.update(quoteSenderMappings)
    .set({
      sampleCount: sql`${quoteSenderMappings.sampleCount} + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(quoteSenderMappings.id, mappingId));
}

export interface UpsertResult {
  status: "created" | "updated" | "skipped";
  reason?: "no_email" | "unknown_target" | "carrier_target" | "missing_target";
  mappingId?: string;
}

/**
 * Record (or refresh) a learned mapping. Safe to call on every manual
 * reassign — the partial unique indexes turn duplicate writes into
 * sample-count bumps. Returns a status so callers can audit-log.
 */
export async function upsertManualMapping(
  orgId: string,
  fromEmail: string | null | undefined,
  targetCustomerId: string,
): Promise<UpsertResult> {
  const info = extractSenderInfo(fromEmail);
  if (!info) return { status: "skipped", reason: "no_email" };

  // Defensive: reject Unknown bucket / carrier rows.
  const [target] = await db.select().from(quoteCustomers).where(and(
    eq(quoteCustomers.organizationId, orgId),
    eq(quoteCustomers.id, targetCustomerId),
  )).limit(1);
  if (!target) return { status: "skipped", reason: "missing_target" };
  if (target.name === UNKNOWN_CUSTOMER_NAME) {
    return { status: "skipped", reason: "unknown_target" };
  }
  if (target.partyType === "carrier") {
    return { status: "skipped", reason: "carrier_target" };
  }

  // Atomic upsert against the partial unique indexes:
  //   - ux_qsm_org_email   ON (org_id, sender_email) WHERE sender_email IS NOT NULL
  //   - ux_qsm_org_domain  ON (org_id, sender_domain) WHERE sender_domain IS NOT NULL
  // Using INSERT ... ON CONFLICT DO UPDATE removes the
  // select-then-insert race that would otherwise drop concurrent learns
  // (two reps reassigning the same sender at the same moment) — the
  // partial indexes prevent duplicates, but without ON CONFLICT one of
  // the inserts would raise a unique-violation that `learnFromReassign`
  // would silently swallow. Status is inferred from the returned
  // sample_count: 1 ⇒ fresh insert; >1 ⇒ pre-existing row was updated.
  const setOnConflict = {
    customerId: sql`EXCLUDED.customer_id`,
    sampleCount: sql`${quoteSenderMappings.sampleCount} + 1`,
    lastUsedAt: sql`EXCLUDED.last_used_at`,
    updatedAt: sql`EXCLUDED.updated_at`,
    source: sql`EXCLUDED.source`,
  };

  const baseValues = {
    organizationId: orgId,
    senderDomain: info.isFreeMail ? null : info.domain,
    senderEmail: info.isFreeMail ? info.email : null,
    customerId: targetCustomerId,
    source: "manual" as const,
    sampleCount: 1,
    lastUsedAt: new Date(),
    updatedAt: new Date(),
  };

  const [row] = info.isFreeMail
    ? await db.insert(quoteSenderMappings).values(baseValues)
        .onConflictDoUpdate({
          target: [quoteSenderMappings.organizationId, quoteSenderMappings.senderEmail],
          targetWhere: sql`${quoteSenderMappings.senderEmail} IS NOT NULL`,
          set: setOnConflict,
        })
        .returning()
    : await db.insert(quoteSenderMappings).values(baseValues)
        .onConflictDoUpdate({
          target: [quoteSenderMappings.organizationId, quoteSenderMappings.senderDomain],
          targetWhere: sql`${quoteSenderMappings.senderDomain} IS NOT NULL`,
          set: setOnConflict,
        })
        .returning();

  if (!row) return { status: "skipped", reason: "no_email" };
  return {
    status: row.sampleCount === 1 ? "created" : "updated",
    mappingId: row.id,
  };
}

export interface MappingWithCustomer extends QuoteSenderMapping {
  customerName: string;
}

/**
 * Admin list — joins customer name for the dialog. Sorted by most-recently
 * used first so reps see active mappings.
 */
export async function listMappings(orgId: string): Promise<MappingWithCustomer[]> {
  const rows = await db
    .select({
      id: quoteSenderMappings.id,
      organizationId: quoteSenderMappings.organizationId,
      senderDomain: quoteSenderMappings.senderDomain,
      senderEmail: quoteSenderMappings.senderEmail,
      customerId: quoteSenderMappings.customerId,
      // Task #849 §3.2 — `suppressed` is part of the row shape, but the
      // existing admin UI only renders rows joined to a customer (the
      // INNER JOIN below filters suppression rows out anyway since they
      // have customerId=NULL). We still include the column so the
      // returned row shape matches `MappingWithCustomer`.
      suppressed: quoteSenderMappings.suppressed,
      source: quoteSenderMappings.source,
      sampleCount: quoteSenderMappings.sampleCount,
      lastUsedAt: quoteSenderMappings.lastUsedAt,
      createdAt: quoteSenderMappings.createdAt,
      updatedAt: quoteSenderMappings.updatedAt,
      customerName: quoteCustomers.name,
    })
    .from(quoteSenderMappings)
    .innerJoin(quoteCustomers, eq(quoteCustomers.id, quoteSenderMappings.customerId))
    .where(eq(quoteSenderMappings.organizationId, orgId))
    .orderBy(desc(quoteSenderMappings.lastUsedAt));
  return rows;
}

/**
 * Admin delete — org-scoped to prevent cross-tenant deletes via id only.
 */
export async function deleteMapping(orgId: string, id: string): Promise<{ deleted: boolean }> {
  const result = await db.delete(quoteSenderMappings).where(and(
    eq(quoteSenderMappings.organizationId, orgId),
    eq(quoteSenderMappings.id, id),
  )).returning({ id: quoteSenderMappings.id });
  return { deleted: result.length > 0 };
}

/**
 * Resolve the sender email for a quote's source reference. Mirrors
 * `loadSourceMessage` in customerQuotes.ts but returns only what the
 * learner needs — the sender's from-address. Returns null for non-email
 * sources or when the source row has been purged.
 */
export async function lookupSourceFromEmail(
  orgId: string,
  sourceReference: string | null,
): Promise<string | null> {
  if (!sourceReference) return null;
  const byProvider = await db.select({ fromEmail: emailMessages.fromEmail }).from(emailMessages).where(and(
    eq(emailMessages.orgId, orgId),
    eq(emailMessages.providerMessageId, sourceReference),
  )).limit(1);
  if (byProvider[0]?.fromEmail) return byProvider[0].fromEmail;
  const byId = await db.select({ fromEmail: emailMessages.fromEmail }).from(emailMessages).where(and(
    eq(emailMessages.orgId, orgId),
    eq(emailMessages.id, sourceReference),
  )).limit(1);
  return byId[0]?.fromEmail ?? null;
}

/**
 * Convenience wrapper for the reassign callers in `customerQuotes.ts`.
 * Looks up the source-message's sender, then upserts the mapping. All
 * failures are swallowed and logged — a learning miss must NEVER roll
 * back the underlying reassign.
 */
export async function learnFromReassign(
  orgId: string,
  sourceReference: string | null,
  targetCustomerId: string,
): Promise<UpsertResult> {
  try {
    const fromEmail = await lookupSourceFromEmail(orgId, sourceReference);
    if (!fromEmail) return { status: "skipped", reason: "no_email" };
    return await upsertManualMapping(orgId, fromEmail, targetCustomerId);
  } catch (err) {
    console.error("[quote-sender-mappings] learnFromReassign failed", err);
    return { status: "skipped", reason: "no_email" };
  }
}
