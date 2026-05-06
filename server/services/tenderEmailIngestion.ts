/**
 * Email→Exec 1 (Task #1052) — First-touch tender → freight_opportunities.
 *
 * When the inline classifier (server/services/inlineEmailClassifier.ts) sees an
 * inbound customer email that is clearly a load TENDER (not a quote request),
 * we auto-create one `freight_opportunities` row in `pending_approval` status,
 * linked back to the source email via:
 *
 *   sourceRef = {
 *     type: "email_tender",       // routes the cockpit "From email" badge
 *     source: "email",            // matches the task spec literal
 *     providerMessageId,          // the Outlook InternetMessageId — idempotency key
 *     messageId,                  // internal email_messages.id (deep-link convenience)
 *     threadId,                   // Outlook conversation id (deep-link to /conversations)
 *     subject,
 *     fromEmail,
 *   }
 *
 * Idempotency is enforced by a pre-insert lookup on
 * `(orgId, sourceRef->>'source'='email', sourceRef->>'providerMessageId'=ref)`.
 * The same email being re-processed (replay, delta-sync, backfill) cannot
 * create a duplicate row. We deliberately do NOT add a unique index in this
 * task to avoid a schema migration; `dispatchInlineClassification` is the
 * only writer and runs serialised per message id, so the pre-insert check is
 * sufficient.
 *
 * Carrier emails are excluded one layer up — `classifyOne` only invokes this
 * helper when `extraction.actorType !== "carrier"` AND
 * `!message.linkedCarrierId`.
 *
 * Honors the inbound email preservation contract: this helper is purely
 * additive — it inserts a new freight_opportunities row when (and only when)
 * the email has both a parseable lane and a resolvable customer companyId.
 * It never mutates or drops the underlying email_messages row.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  freightOpportunities,
  type EmailMessage,
  type FreightOpportunity,
  type InsertFreightOpportunity,
} from "@shared/schema";
import { parseQuoteEmail, parseQuoteEmailAi, stripHtml } from "./quoteEmailIngestion";

// Conservative deterministic phrases that signal "I am giving you a load to
// cover", as opposed to "give me a price" (which is a quote request and stays
// on the existing quote pipeline). Anchored as word boundaries so partial
// substrings inside other words do not match.
const TENDER_PHRASES: ReadonlyArray<RegExp> = [
  /\bplease\s+cover\b/i,
  /\bcan\s+you\s+cover\b/i,
  /\bcover(ing)?\s+this\s+load\b/i,
  /\bload\s+tender\b/i,
  /\btender(ed)?\s+(load|attached|below)\b/i,
  /\bload\s+offer\b/i,
  /\boffer(ing)?\s+(this|a|the)\s+load\b/i,
  /\bawarded\s+(this\s+)?(load|lane)\b/i,
  /\bdispatch\s+(this|the)\s+load\b/i,
  /\bbook(ed|ing)?\s+(this\s+)?load\b/i,
  /\bconfirm(ing)?\s+(this\s+)?load\b/i,
];

// Quote-request phrases that, when present, BLOCK the tender branch even if a
// tender phrase matched. Real customer mail is often mixed ("please cover…
// what's your rate?"). When the customer is asking for a price the existing
// quote pipeline owns the row.
const QUOTE_BLOCK_PHRASES: ReadonlyArray<RegExp> = [
  /\bwhat['']?s?\s+your\s+rate\b/i,
  /\bsend\s+(us\s+)?(a\s+)?quote\b/i,
  /\bneed\s+(a\s+)?(rate|quote|pricing)\b/i,
  /\bplease\s+quote\b/i,
  /\brate\s+request\b/i,
  /\bquote\s+request\b/i,
];

// PO + lane + pickup-date heuristic. A purchase-order reference next to a
// city pair is a very strong tender signal even without an explicit "please
// cover" phrase. Conservative: require all three.
const PO_RE = /\bP\.?O\.?\s*#?\s*[A-Z0-9-]{3,}\b/i;

/**
 * Returns true when the (subject, body) pair looks like a first-touch
 * customer load tender. Conservative — designed to err on the side of
 * letting things fall through to the existing quote pipeline rather than
 * over-creating freight opportunities.
 *
 * The function takes the RAW body; HTML scrubbing happens internally so
 * callers can pass through `message.body` directly.
 */
export function looksLikeTenderEmail(
  subject: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const cleanSubject = (subject ?? "").trim();
  const cleanBody = stripHtml(body ?? "");
  const text = `${cleanSubject}\n${cleanBody}`;
  if (!text.trim()) return false;

  // Quote-request language wins — let the quote pipeline own the row.
  if (QUOTE_BLOCK_PHRASES.some((re) => re.test(text))) return false;

  if (TENDER_PHRASES.some((re) => re.test(text))) return true;

  // Strong PO + lane combination (no explicit tender phrase needed).
  if (PO_RE.test(text)) {
    const lane = parseQuoteEmail({ subject: cleanSubject, body: cleanBody });
    if (lane) return true;
  }

  return false;
}

export type TenderIngestStatus =
  | "ingested"
  | "skipped_duplicate"
  | "skipped_no_company"
  | "skipped_unparseable_lane"
  | "skipped_not_tender"
  | "skipped_carrier"
  | "skipped_outbound";

export interface TenderIngestResult {
  status: TenderIngestStatus;
  opportunityId?: string;
}

/**
 * Idempotently create one freight_opportunities row in `pending_approval`
 * status from a customer tender email. Caller is responsible for the
 * carrier-exclusion gate (we double-check it here as a safety net).
 *
 * Returns a rich status so the inline classifier can decide whether to
 * fall through to the existing quote-ingest path.
 */
export async function ingestTenderFromEmail(
  message: EmailMessage,
  opts?: {
    /** AI parser is opt-in. Off by default to keep the hot path predictable;
     *  the recovery cron can re-run the same row with this on if regex misses. */
    aiFallback?: boolean;
  },
): Promise<TenderIngestResult> {
  // ── Hard exclusions ──────────────────────────────────────────────────────
  if (message.direction === "outbound") {
    return { status: "skipped_outbound" };
  }
  if (message.linkedCarrierId) {
    return { status: "skipped_carrier" };
  }

  const subject = message.subject ?? "";
  const body = message.body ?? "";

  if (!looksLikeTenderEmail(subject, body)) {
    return { status: "skipped_not_tender" };
  }

  // We only create when we can resolve a real customer companyId. Faking a
  // company would violate the "missing fields stay empty rather than being
  // faked" rule from the task spec. The PERSIST-UNKNOWN branch in
  // graphWebhook still preserves the email row itself, so a future contact
  // upsert (Email→Exec 4) can promote unknown-sender tenders later without
  // losing the message.
  if (!message.linkedAccountId) {
    return { status: "skipped_no_company" };
  }

  // ── Lane parse ───────────────────────────────────────────────────────────
  let lane = parseQuoteEmail({
    subject,
    body,
    referenceDate: message.providerSentAt ?? message.createdAt ?? null,
  });
  if (!lane && opts?.aiFallback) {
    lane = await parseQuoteEmailAi({ subject, body });
  }
  if (!lane) {
    return { status: "skipped_unparseable_lane" };
  }

  // ── Idempotency check ────────────────────────────────────────────────────
  // Pre-insert lookup on (orgId, sourceRef.source='email',
  // sourceRef.providerMessageId=<msg>). The single inline classifier
  // dispatcher serialises calls per message id, so this is race-safe in
  // production; replays from delta-sync / backfill / self-heal land here.
  const existing = await db
    .select({ id: freightOpportunities.id })
    .from(freightOpportunities)
    .where(
      and(
        eq(freightOpportunities.orgId, message.orgId),
        sql`${freightOpportunities.sourceRef}->>'source' = 'email'`,
        sql`${freightOpportunities.sourceRef}->>'providerMessageId' = ${message.providerMessageId ?? ""}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { status: "skipped_duplicate", opportunityId: existing[0].id };
  }

  // ── Pickup window ────────────────────────────────────────────────────────
  // Schema requires NOT NULL pickupWindowStart/End. When the email omits a
  // date, fall back to the email's send date (org-local close enough for a
  // pending_approval row a human will review). ISO YYYY-MM-DD matches what
  // the rest of the AF cockpit serialises into this column.
  const fallbackDate = message.providerSentAt ?? message.createdAt ?? new Date();
  const pickupDay = (lane.pickupDate ?? fallbackDate).toISOString().slice(0, 10);

  const sourceRef = {
    type: "email_tender" as const,
    source: "email" as const,
    providerMessageId: message.providerMessageId ?? null,
    messageId: message.id,
    threadId: message.threadId ?? null,
    subject: subject || null,
    fromEmail: message.fromEmail ?? null,
  };

  const insert: InsertFreightOpportunity = {
    orgId: message.orgId,
    companyId: message.linkedAccountId,
    mode: "exact_load",
    origin: lane.originCity,
    originState: lane.originState,
    destination: lane.destCity,
    destinationState: lane.destState,
    equipmentType: lane.equipment,
    pickupWindowStart: pickupDay,
    pickupWindowEnd: pickupDay,
    loadCount: 1,
    sourceRef,
    urgencyScore: 60,
    status: "pending_approval",
    awaitingApprovalSince: new Date(),
    notes: `Auto-created from inbound email tender. Subject: ${subject || "(no subject)"}`,
  };

  let created: FreightOpportunity | undefined;
  try {
    const rows = await db.insert(freightOpportunities).values(insert).returning();
    created = rows[0];
  } catch (err) {
    // Re-check idempotency in case a parallel writer beat us to it. Without
    // a unique index this is a soft race window; surfacing the duplicate
    // instead of throwing keeps the dispatcher path clean.
    const recheck = await db
      .select({ id: freightOpportunities.id })
      .from(freightOpportunities)
      .where(
        and(
          eq(freightOpportunities.orgId, message.orgId),
          sql`${freightOpportunities.sourceRef}->>'source' = 'email'`,
          sql`${freightOpportunities.sourceRef}->>'providerMessageId' = ${message.providerMessageId ?? ""}`,
        ),
      )
      .limit(1);
    if (recheck.length > 0) {
      return { status: "skipped_duplicate", opportunityId: recheck[0].id };
    }
    throw err;
  }

  if (!created) {
    return { status: "skipped_unparseable_lane" };
  }

  console.log(
    `[tender-email-ingest] created freight_opportunity=${created.id} ` +
      `org=${message.orgId} company=${message.linkedAccountId} ` +
      `lane=${lane.originCity},${lane.originState}→${lane.destCity},${lane.destState} ` +
      `pickup=${pickupDay} msgId=${message.providerMessageId ?? message.id}`,
  );

  return { status: "ingested", opportunityId: created.id };
}
