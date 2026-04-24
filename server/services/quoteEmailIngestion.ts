/**
 * Inbound Quote Email Ingestion (Task #470)
 *
 * Parses inbound emails from monitored mailboxes and writes a row into
 * `quote_opportunities` + a "requested" entry in `quote_events` so the
 * Customer Quotes dashboards reflect real activity instead of demo seed data.
 *
 * The parser is intentionally heuristic-based (regex over the cleaned email
 * body + subject). It is good enough to capture the standard customer quote
 * request shape — origin city/ST → destination city/ST + equipment + optional
 * target rate — without pulling the full LLM extraction stack into the hot
 * path. When `extractedData` from `email_signals` already carries structured
 * lane/quote fields, those win over the regex fallback.
 *
 * The function is idempotent per email message: if a quote opportunity already
 * exists with `source = "email"` and `sourceReference = <message providerId>`,
 * the call is a no-op.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteOpportunities, quoteEvents, quoteCustomers, quoteReps,
  quoteOutcomeReasons, emailMessages,
  type EmailMessage, type QuoteOutcomeStatus,
} from "@shared/schema";

export interface ParsedQuoteFields {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  quotedAmount: number | null;
  pickupDate: Date | null;
}

const EQUIPMENT_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\breefer(s)?\b|\brefrigerated\b|\btemp[\s-]?control(led)?\b/i, name: "Reefer" },
  { re: /\bflat[\s-]?bed(s)?\b|\bflats?\b\s*(load)?/i, name: "Flatbed" },
  { re: /\bdry\s*van(s)?\b|\bvans?\b/i, name: "Dry Van" },
  { re: /\bpower[\s-]?only\b/i, name: "Power Only" },
  { re: /\bstep[\s-]?deck\b/i, name: "Step Deck" },
];

// City is one to three capitalized tokens (e.g. "Chicago", "St Louis",
// "Los Angeles"). Anchoring on capitalization avoids dragging the preceding
// sentence ("Need a rate from Chicago") into the origin capture.
const CITY = "[A-Z][A-Za-z'.-]+(?:\\s[A-Z][A-Za-z'.-]+){0,2}";
const LANE_RE = new RegExp(
  `\\b(${CITY}),\\s*([A-Z]{2})\\s*(?:to|→|->|-+>?|–|—|>)\\s*(${CITY}),\\s*([A-Z]{2})\\b`,
);
const RATE_RE = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{3,6}(?:\.[0-9]{1,2})?)/;
const DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/;

function normalizeCity(city: string): string {
  return city.trim().replace(/\s+/g, " ");
}

function parseRate(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,$]/g, "");
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  if (n < 100 || n > 100000) return null;
  return Math.round(n);
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(DATE_RE);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a quote request out of an email body / subject.
 * Returns null when no usable lane is found.
 */
export function parseQuoteEmail(input: { subject?: string | null; body?: string | null }): ParsedQuoteFields | null {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  if (!text.trim()) return null;

  const laneMatch = text.match(LANE_RE);
  if (!laneMatch) return null;
  const [, oCity, oState, dCity, dState] = laneMatch;

  let equipment = "Dry Van";
  for (const p of EQUIPMENT_PATTERNS) {
    if (p.re.test(text)) { equipment = p.name; break; }
  }

  const rateMatch = text.match(RATE_RE);
  const quotedAmount = rateMatch ? parseRate(rateMatch[1]) : null;
  const pickupDate = parseDate(text);

  return {
    originCity: normalizeCity(oCity),
    originState: oState.toUpperCase(),
    destCity: normalizeCity(dCity),
    destState: dState.toUpperCase(),
    equipment,
    quotedAmount,
    pickupDate,
  };
}

async function findOrCreateCustomer(orgId: string, name: string): Promise<string> {
  const existing = await db.select().from(quoteCustomers)
    .where(and(eq(quoteCustomers.organizationId, orgId), eq(quoteCustomers.name, name)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db.insert(quoteCustomers).values({ organizationId: orgId, name }).returning();
  return row.id;
}

async function findOrCreateRep(orgId: string, email: string): Promise<string | null> {
  if (!email) return null;
  const existing = await db.select().from(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.email, email)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const [row] = await db.insert(quoteReps).values({ organizationId: orgId, name, email }).returning();
  return row.id;
}

function deriveCustomerName(message: EmailMessage): string {
  const from = (message.fromEmail ?? "").trim();
  if (!from) return "Unknown Customer";
  const m = from.match(/^([^<]+)<([^>]+)>$/);
  const addr = (m ? m[2] : from).toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  if (!domain) return "Unknown Customer";
  const root = domain.split(".").slice(0, -1).join(".") || domain;
  return root.split(/[.\-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

export interface IngestionResult {
  status: "ingested" | "skipped_duplicate" | "skipped_unparseable" | "skipped_outbound";
  quoteId?: string;
}

/**
 * Ingest a single inbound email as a quote_opportunity.
 *
 * Idempotent: if a quote with the same (org, source=email, sourceReference)
 * already exists, returns `skipped_duplicate`.
 */
export async function ingestQuoteFromEmail(
  message: EmailMessage,
  opts?: { extractedData?: Record<string, unknown> | null; customerName?: string },
): Promise<IngestionResult> {
  if (message.direction !== "inbound") return { status: "skipped_outbound" };

  const ref = message.providerMessageId ?? message.id;

  const dup = await db.select({ id: quoteOpportunities.id }).from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, message.orgId),
    eq(quoteOpportunities.source, "email"),
    eq(quoteOpportunities.sourceReference, ref),
  )).limit(1);
  if (dup.length > 0) return { status: "skipped_duplicate", quoteId: dup[0].id };

  const fromExtracted = mergeExtractedFields(opts?.extractedData ?? null);
  const fromHeuristic = parseQuoteEmail({ subject: message.subject, body: message.body });
  const parsed = fromExtracted ?? fromHeuristic;
  if (!parsed) return { status: "skipped_unparseable" };

  const customerName = opts?.customerName ?? deriveCustomerName(message);
  const customerId = await findOrCreateCustomer(message.orgId, customerName);
  const repId = await findOrCreateRep(
    message.orgId,
    (message.toEmail ?? "").split(/[,;]/)[0]?.trim().toLowerCase() ?? "",
  );

  const requestDate = message.providerSentAt ?? message.createdAt ?? new Date();
  const validThrough = new Date(requestDate.getTime() + 7 * 24 * 3600 * 1000);

  const [opp] = await db.insert(quoteOpportunities).values({
    organizationId: message.orgId,
    customerId,
    repId: repId ?? null,
    laneGroupId: null,
    carrierId: null,
    outcomeReasonId: null,
    requestDate,
    originCity: parsed.originCity,
    originState: parsed.originState,
    destCity: parsed.destCity,
    destState: parsed.destState,
    equipment: parsed.equipment,
    quotedAmount: parsed.quotedAmount !== null ? String(parsed.quotedAmount) : null,
    validThrough,
    outcomeStatus: "pending",
    carrierPaid: null,
    responseTimeHours: null,
    source: "email",
    sourceReference: ref,
    notes: message.subject ?? null,
    score: null,
  }).returning();

  await db.insert(quoteEvents).values({
    quoteId: opp.id,
    eventType: "requested",
    occurredAt: requestDate,
    actor: customerName,
    payload: {
      source: "email",
      messageId: message.id,
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      pickupDate: parsed.pickupDate ? parsed.pickupDate.toISOString() : null,
    },
  });

  return { status: "ingested", quoteId: opp.id };
}

function mergeExtractedFields(data: Record<string, unknown> | null): ParsedQuoteFields | null {
  if (!data) return null;
  const oCity = pickStr(data, ["originCity", "origin_city", "pickupCity", "pickup_city"]);
  const oState = pickStr(data, ["originState", "origin_state", "pickupState"]);
  const dCity = pickStr(data, ["destCity", "destination_city", "destinationCity", "deliveryCity"]);
  const dState = pickStr(data, ["destState", "destination_state", "destinationState"]);
  if (!oCity || !oState || !dCity || !dState) return null;
  const equipmentRaw = pickStr(data, ["equipment", "equipmentType", "equipment_type"]) ?? "Dry Van";
  let equipment = equipmentRaw;
  for (const p of EQUIPMENT_PATTERNS) {
    if (p.re.test(equipmentRaw)) { equipment = p.name; break; }
  }
  const quoted = pickStr(data, ["quotedAmount", "rate", "targetRate", "price", "quoted"]);
  const pickup = pickStr(data, ["pickupDate", "pickup_date"]);
  return {
    originCity: oCity, originState: oState.toUpperCase(),
    destCity: dCity, destState: dState.toUpperCase(),
    equipment,
    quotedAmount: quoted ? parseRate(quoted) : null,
    pickupDate: pickup ? parseDate(pickup) : null,
  };
}

// ─── Task #482: closed_lost_indicator → flip pending quote to lost ───────────

export interface LostReason {
  code: "lost_price" | "lost_timing" | "lost_incumbent" | "lost_service";
  label: string;
  status: Extract<QuoteOutcomeStatus, "lost_price" | "lost_timing" | "lost_incumbent" | "lost_service">;
}

const LOST_INCUMBENT: LostReason = { code: "lost_incumbent", label: "Customer covered with another carrier", status: "lost_incumbent" };
const LOST_PRICE: LostReason     = { code: "lost_price",     label: "Lost on price",                          status: "lost_price" };
const LOST_TIMING: LostReason    = { code: "lost_timing",    label: "Load cancelled or no longer needed",     status: "lost_timing" };
const LOST_SERVICE: LostReason   = { code: "lost_service",   label: "Lost on service / fit",                  status: "lost_service" };

/**
 * Pure mapping from the customer's loss-language phrase to a reason code.
 * Defaults to lost_incumbent ("they went with someone else") because that is
 * the dominant pattern behind a "load is covered" reply on a quote thread.
 * Exposed for unit testing.
 */
export function decideLostReason(language: string | null | undefined): LostReason {
  const s = (language ?? "").toLowerCase();
  if (!s) return LOST_INCUMBENT;
  if (/\b(cancel(l?ed)?|no longer needed|don't need|pulled|on hold)\b/.test(s)) return LOST_TIMING;
  if (/\b(too high|cheaper|lower rate|price|rate is too|found cheaper)\b/.test(s)) return LOST_PRICE;
  if (/\b(service|transit|fit|equipment|reliability)\b/.test(s)) return LOST_SERVICE;
  return LOST_INCUMBENT;
}

async function findOrCreateLostReason(orgId: string, reason: LostReason): Promise<string> {
  const existing = await db.select().from(quoteOutcomeReasons).where(and(
    eq(quoteOutcomeReasons.organizationId, orgId),
    eq(quoteOutcomeReasons.code, reason.code),
  )).limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db.insert(quoteOutcomeReasons).values({
    organizationId: orgId,
    code: reason.code,
    label: reason.label,
    category: "lost",
  }).returning();
  return row.id;
}

export interface CloseLostResult {
  status:
    | "closed_lost"
    | "skipped_outbound"
    | "skipped_no_thread"
    | "skipped_no_open_quote"
    | "skipped_already_closed";
  quoteId?: string;
  reasonCode?: LostReason["code"];
}

/**
 * When a closed_lost_indicator signal is detected on an inbound customer
 * email, flip the matching pending quote opportunity on the same thread to
 * a lost_* outcome and record the loss as a `email_lost` quote_event.
 *
 * Idempotent: a quote already in a terminal status is not re-closed; a
 * second loss signal on the same thread is a no-op.
 */
export async function applyClosedLostToOpenQuote(
  message: EmailMessage,
  opts?: { extractedData?: Record<string, unknown> | null; intentSubtype?: string | null },
): Promise<CloseLostResult> {
  if (message.direction !== "inbound") return { status: "skipped_outbound" };
  if (!message.threadId) return { status: "skipped_no_thread" };

  // All sourceReference values that quote_opportunities could have been
  // created with for messages on this thread (providerMessageId fallback to
  // internal id, mirroring `ingestQuoteFromEmail`).
  const threadMsgs = await db.select({
    id: emailMessages.id,
    providerMessageId: emailMessages.providerMessageId,
  }).from(emailMessages).where(and(
    eq(emailMessages.orgId, message.orgId),
    eq(emailMessages.threadId, message.threadId),
  ));
  if (threadMsgs.length === 0) return { status: "skipped_no_open_quote" };

  const refs = Array.from(new Set(
    threadMsgs.flatMap(m => [m.providerMessageId, m.id]).filter((v): v is string => !!v),
  ));
  if (refs.length === 0) return { status: "skipped_no_open_quote" };

  const candidates = await db.select().from(quoteOpportunities).where(and(
    eq(quoteOpportunities.organizationId, message.orgId),
    eq(quoteOpportunities.source, "email"),
    inArray(quoteOpportunities.sourceReference, refs),
  ));
  if (candidates.length === 0) return { status: "skipped_no_open_quote" };

  // Deterministic selection: when multiple pending quotes share the same
  // thread (rare, but possible when a customer sends two RFQs in the same
  // chain), close the most recently requested one — the customer's "we're
  // covered" reply almost always references the latest ask.
  const pending = candidates
    .filter(c => c.outcomeStatus === "pending")
    .sort((a, b) => b.requestDate.getTime() - a.requestDate.getTime());
  const open = pending[0];
  if (!open) return { status: "skipped_already_closed", quoteId: candidates[0].id };

  const lossLanguage = pickStr(opts?.extractedData ?? {}, ["lossLanguage", "loss_language"]);
  const reason = decideLostReason(lossLanguage);
  const reasonId = await findOrCreateLostReason(message.orgId, reason);

  await db.update(quoteOpportunities).set({
    outcomeStatus: reason.status,
    outcomeReasonId: reasonId,
  }).where(eq(quoteOpportunities.id, open.id));

  const occurredAt = message.providerSentAt ?? message.createdAt ?? new Date();
  await db.insert(quoteEvents).values({
    quoteId: open.id,
    eventType: "email_lost",
    occurredAt,
    actor: message.fromEmail ?? "customer",
    payload: {
      source: "email",
      messageId: message.id,
      providerMessageId: message.providerMessageId,
      threadId: message.threadId,
      lossLanguage: lossLanguage ?? null,
      intentSubtype: opts?.intentSubtype ?? null,
      reasonCode: reason.code,
    },
  });

  return { status: "closed_lost", quoteId: open.id, reasonCode: reason.code };
}

function pickStr(data: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && isFinite(v)) return String(v);
  }
  return null;
}

// ─── Task #526: one-shot backfill of quote_opportunities from email_messages ──

export interface BackfillSummary {
  scanned: number;
  ingested: number;
  duplicates: number;
  unparseable: number;
  outbound: number;
  errors: number;
}

/**
 * Walk every inbound email_message for the given org and try to ingest a
 * quote opportunity from it, in chronological order.
 *
 * Idempotent: each call to `ingestQuoteFromEmail` is keyed on
 * (org, source=email, sourceReference) so re-running this backfill on the
 * same dataset is a no-op for already-ingested messages.
 *
 * Use this to seed `quote_opportunities` from the historical mailbox after
 * a customer enrolls a mailbox or after the live ingestion path has been
 * paused for any length of time.
 */
export async function backfillQuotesFromEmails(
  orgId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<BackfillSummary> {
  const { sinceDays, limit } = opts;
  const summary: BackfillSummary = {
    scanned: 0, ingested: 0, duplicates: 0, unparseable: 0, outbound: 0, errors: 0,
  };

  const rows = await db.select().from(emailMessages).where(and(
    eq(emailMessages.orgId, orgId),
    eq(emailMessages.direction, "inbound"),
  ));
  const cutoff = sinceDays && sinceDays > 0
    ? new Date(Date.now() - sinceDays * 24 * 3600 * 1000)
    : null;
  const sorted = rows.sort((a, b) => {
    const aT = (a.providerSentAt ?? a.createdAt ?? new Date(0)).getTime();
    const bT = (b.providerSentAt ?? b.createdAt ?? new Date(0)).getTime();
    return aT - bT;
  });

  for (const msg of sorted) {
    if (limit && summary.scanned >= limit) break;
    if (cutoff) {
      const ts = msg.providerSentAt ?? msg.createdAt ?? new Date(0);
      if (ts < cutoff) continue;
    }
    summary.scanned++;
    try {
      const result = await ingestQuoteFromEmail(msg);
      if (result.status === "ingested") summary.ingested++;
      else if (result.status === "skipped_duplicate") summary.duplicates++;
      else if (result.status === "skipped_unparseable") summary.unparseable++;
      else if (result.status === "skipped_outbound") summary.outbound++;
    } catch (err) {
      summary.errors++;
      console.error("[quoteEmailIngestion] backfill error for message", msg.id, err);
    }
  }

  return summary;
}

// Per-process guard so the auto-backfill below runs at most once per (org,
// process). We don't need a persistent marker — `ingestQuoteFromEmail` is
// idempotent on (org, source=email, sourceReference) so the worst case after
// a restart is a single no-op rescan of inbound mail (every message hits the
// dedup index and is reported as a duplicate).
const _emailBackfillAttempted = new Set<string>();

// Per-org observability for the most-recent auto-backfill. Surfaced via
// /api/customer-quotes/email-backfill-status so ops can confirm completion.
type EmailBackfillStatus =
  | { state: "pending"; startedAt: string }
  | { state: "complete"; startedAt: string; finishedAt: string; summary: BackfillSummary }
  | { state: "failed"; startedAt: string; finishedAt: string; error: string };
const _emailBackfillStatus = new Map<string, EmailBackfillStatus>();

export function getEmailBackfillStatus(orgId: string): EmailBackfillStatus | null {
  return _emailBackfillStatus.get(orgId) ?? null;
}

/**
 * Lazy, one-time-per-process auto-backfill: the first time any customer-quotes
 * API call lands for an org, walk the org's full inbound email_messages history
 * through the quote-ingestion pipeline so every historical quote opportunity
 * appears alongside live ones.
 *
 * Always processes the full history (not gated on any pre-existing quote)
 * because partially-ingested orgs need to be brought to completeness too.
 * `ingestQuoteFromEmail` deduplicates on (org, source=email, sourceReference),
 * so re-walking already-ingested messages is cheap and safe.
 *
 * Runs as a background task (fire-and-forget) so it never blocks request
 * latency. Progress is recorded in `_emailBackfillStatus` for observability.
 */
export async function ensureEmailBackfill(orgId: string): Promise<void> {
  if (!orgId) return;
  if (_emailBackfillAttempted.has(orgId)) return;
  _emailBackfillAttempted.add(orgId);

  const startedAt = new Date().toISOString();
  _emailBackfillStatus.set(orgId, { state: "pending", startedAt });

  // No `sinceDays`/`limit` cap — walk the entire inbound history. Idempotency
  // is guaranteed by the per-message dedup inside `ingestQuoteFromEmail`.
  void backfillQuotesFromEmails(orgId, {})
    .then((summary) => {
      _emailBackfillStatus.set(orgId, {
        state: "complete",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary,
      });
      if (summary.scanned > 0) {
        console.log("[quoteEmailIngestion] auto-backfill complete", { orgId, ...summary });
      }
    })
    .catch((err) => {
      _emailBackfillStatus.set(orgId, {
        state: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      // Clear the per-process attempt guard on failure so the next API call
      // for this org will retry the backfill rather than be silently skipped.
      _emailBackfillAttempted.delete(orgId);
      console.error("[quoteEmailIngestion] auto-backfill failed (will retry on next request)", orgId, err);
    });
}
