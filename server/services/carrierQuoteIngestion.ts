/**
 * Task #1054 — Email→Exec sub-task 3: Carrier Quote Ingestion
 *
 * A dedicated branch for capturing structured carrier rate offers (e.g.
 * "$1850 all-in ATL→DAL Tuesday") into `carrier_quote_events`. Lives
 * separately from the customer-facing `quote_opportunities` ingestion
 * (`quoteEmailIngestion.ts`) so a carrier reply can never accidentally
 * surface in the rep's customer-quote queue.
 *
 * Pipeline (regex-only by design):
 *   1. Deterministic regex extraction (lane + amount + qualifier + equipment).
 *   2. Idempotent insert keyed on (orgId, sourceReference) — replayed
 *      Graph webhooks and replay/backfill runs are no-ops.
 *
 * No LLM call is made on this path. Carrier rate replies follow a small set
 * of well-known shapes ("$1,850 all-in", "flat 2100 linehaul", etc.) and
 * the deterministic parser catches them; spending tokens on misses would
 * create non-determinism on a hot ingest path. The AI hook was intentionally
 * removed (review feedback on Task #1054) so the source of every row is
 * unambiguous (`extractionSource = 'regex'`).
 *
 * Caller contract: only invoke for INBOUND messages whose actor classifies
 * as "carrier" (or that came in on a known-carrier sender). The customer
 * pricing-request path stays untouched.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  carrierQuoteEvents,
  type EmailMessage,
  type CarrierQuoteEvent,
  type InsertCarrierQuoteEvent,
} from "@shared/schema";
import { db } from "../storage";
import {
  parseQuoteEmail,
  stripHtml,
  isObviouslyNotAQuote,
  type ParsedQuoteFields,
} from "./quoteEmailIngestion";

// ─── Rate / qualifier extraction ───────────────────────────────────────────

// Reuse-friendly amount regex. Matches "$1,850", "$1850", "1850 all-in",
// "rate 2,100", "we can do 1850". Bounded plausible cents amount (100..100000)
// so an invoice number "#5" or year "2024" doesn't qualify as a rate.
const AMOUNT_RE =
  /(?:\$\s*|(?:rate|all[\s-]?in|flat|firm|asking|our\s+number|we\s+can\s+(?:do|run)\s+(?:it\s+)?(?:for\s+)?|can\s+do\s+(?:it\s+)?(?:for\s+)?|book\s+(?:it\s+)?(?:at\s+|for\s+))\s*\$?\s*)([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{3,6}(?:\.[0-9]{1,2})?)\b/i;

const QUALIFIER_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\ball[\s-]?in\b/i, name: "all_in" },
  { re: /\bflat\b/i, name: "flat" },
  { re: /\bline[\s-]?haul\b/i, name: "linehaul" },
  { re: /\bfirm\b/i, name: "firm" },
];

function parseAmountToCents(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,$\s]/g, "");
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  if (n < 100 || n > 100000) return null;
  return Math.round(n * 100);
}

export interface ParsedCarrierQuote {
  amountCents: number | null;
  qualifier: string | null;
  lane: ParsedQuoteFields | null;
  rawSnippet: string | null;
}

/**
 * Pure deterministic extractor. Returns lane (via reused customer-side
 * lane parser), amount-in-cents, qualifier, and the snippet around the
 * matched amount. Exposed for unit tests.
 */
export function extractCarrierRateOffer(input: {
  subject?: string | null;
  body?: string | null;
  referenceDate?: Date | null;
}): ParsedCarrierQuote {
  const subject = (input.subject ?? "").trim();
  const cleanBody = stripHtml(input.body ?? "");
  const fullText = `${subject}\n${cleanBody}`;

  if (isObviouslyNotAQuote(subject, cleanBody)) {
    return { amountCents: null, qualifier: null, lane: null, rawSnippet: null };
  }

  // Lane via the customer-side regex stack — same heuristic, different
  // downstream consumer. Carriers often quote on the SAME lane shapes
  // (ATL, GA → DAL, TX) so we deliberately reuse the proven parser.
  const lane = parseQuoteEmail({
    subject,
    body: cleanBody,
    referenceDate: input.referenceDate ?? null,
  });

  const amountMatch = fullText.match(AMOUNT_RE);
  const amountCents = amountMatch ? parseAmountToCents(amountMatch[1]) : null;

  let qualifier: string | null = null;
  for (const p of QUALIFIER_PATTERNS) {
    if (p.re.test(fullText)) { qualifier = p.name; break; }
  }

  let rawSnippet: string | null = null;
  if (amountMatch && typeof amountMatch.index === "number") {
    const start = Math.max(0, amountMatch.index - 60);
    const end = Math.min(fullText.length, amountMatch.index + amountMatch[0].length + 60);
    rawSnippet = fullText.slice(start, end).replace(/\s+/g, " ").trim();
  }

  return { amountCents, qualifier, lane, rawSnippet };
}

/**
 * Carrier-quote persistence gate. The whole point of `carrier_quote_events`
 * is to capture **rate offers** ("$1,850 all-in", "flat 2100"), not generic
 * carrier chatter or truck-availability emails. A lane mention by itself
 * (e.g. "have a reefer empty Chicago to Atlanta Monday") is NOT a quote
 * and would pollute downstream rate-intel / procurement consumers.
 *
 * Therefore: persistence requires a numeric rate (`amountCents !== null`).
 * The lane is optional metadata enriching the row when present.
 *
 * (Review feedback on Task #1054 — the earlier `amount OR lane` gate let
 * non-pricing carrier emails through.)
 */
export function looksLikeCarrierQuote(parsed: ParsedCarrierQuote): boolean {
  return parsed.amountCents !== null;
}

function buildLaneKey(lane: ParsedQuoteFields | null): string | null {
  if (!lane) return null;
  return `${lane.originCity},${lane.originState}->${lane.destCity},${lane.destState}`;
}

// ─── Ingest entrypoint ─────────────────────────────────────────────────────

export type CarrierQuoteIngestStatus =
  | "ingested"
  | "skipped_duplicate"
  | "skipped_outbound"
  | "skipped_no_signal";

export interface CarrierQuoteIngestResult {
  status: CarrierQuoteIngestStatus;
  eventId?: string;
}

/**
 * Idempotently persist a carrier rate offer extracted from `message`.
 *
 * Idempotency key: (orgId, sourceReference) where sourceReference is the
 * provider message id when present, otherwise the internal email id.
 *
 * Never writes to `quote_opportunities`. The customer-quote pipeline is
 * the only writer for that table — keeping the carrier path on a separate
 * insert site is half of how this task prevents pollution.
 */
export async function ingestCarrierQuoteFromEmail(
  message: EmailMessage,
  opts?: {
    carrierId?: string | null;
    contactId?: string | null;
  },
): Promise<CarrierQuoteIngestResult> {
  if (message.direction !== "inbound") {
    return { status: "skipped_outbound" };
  }

  const ref = message.providerMessageId ?? message.id;

  // Dedup on (orgId, sourceReference). The unique index on the table
  // would also reject a duplicate, but a SELECT-first keeps the happy
  // path quiet and lets us return the existing eventId.
  const dup = await db.select({ id: carrierQuoteEvents.id })
    .from(carrierQuoteEvents)
    .where(and(
      eq(carrierQuoteEvents.orgId, message.orgId),
      eq(carrierQuoteEvents.sourceReference, ref),
    ))
    .limit(1);
  if (dup.length > 0) {
    return { status: "skipped_duplicate", eventId: dup[0].id };
  }

  const referenceDate = message.providerSentAt ?? message.createdAt ?? new Date();
  const parsed = extractCarrierRateOffer({
    subject: message.subject,
    body: message.body,
    referenceDate,
  });

  if (!looksLikeCarrierQuote(parsed)) {
    return { status: "skipped_no_signal" };
  }

  const insertRow: InsertCarrierQuoteEvent = {
    orgId: message.orgId,
    carrierId: opts?.carrierId ?? message.linkedCarrierId ?? null,
    contactId: opts?.contactId ?? null,
    emailMessageId: message.id,
    laneKey: buildLaneKey(parsed.lane),
    originCity: parsed.lane?.originCity ?? null,
    originState: parsed.lane?.originState ?? null,
    destCity: parsed.lane?.destCity ?? null,
    destState: parsed.lane?.destState ?? null,
    equipment: parsed.lane?.equipment ?? null,
    amountCents: parsed.amountCents,
    currency: "USD",
    qualifier: parsed.qualifier,
    pickupDate: parsed.lane?.pickupDate
      ? parsed.lane.pickupDate.toISOString().slice(0, 10)
      : null,
    sourceReference: ref,
    extractionSource: "regex",
    rawSnippet: parsed.rawSnippet,
  };

  // Defensive: race on the unique index — another worker could have
  // inserted between our SELECT and INSERT. Treat the 23505 collision
  // as the same outcome as the SELECT dup hit.
  try {
    const [row] = await db.insert(carrierQuoteEvents).values(insertRow).returning();
    return { status: "ingested", eventId: row.id };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      const [existing] = await db.select({ id: carrierQuoteEvents.id })
        .from(carrierQuoteEvents)
        .where(and(
          eq(carrierQuoteEvents.orgId, message.orgId),
          eq(carrierQuoteEvents.sourceReference, ref),
        ))
        .limit(1);
      if (existing) return { status: "skipped_duplicate", eventId: existing.id };
    }
    throw err;
  }
}

// ─── Storage readers ───────────────────────────────────────────────────────

export async function getCarrierQuoteEventsByLane(
  orgId: string,
  laneKey: string,
  limit = 50,
): Promise<CarrierQuoteEvent[]> {
  return db.select().from(carrierQuoteEvents)
    .where(and(
      eq(carrierQuoteEvents.orgId, orgId),
      eq(carrierQuoteEvents.laneKey, laneKey),
    ))
    .orderBy(desc(carrierQuoteEvents.extractedAt))
    .limit(limit);
}

export async function getCarrierQuoteEventsByCarrier(
  orgId: string,
  carrierId: string,
  limit = 50,
): Promise<CarrierQuoteEvent[]> {
  return db.select().from(carrierQuoteEvents)
    .where(and(
      eq(carrierQuoteEvents.orgId, orgId),
      eq(carrierQuoteEvents.carrierId, carrierId),
    ))
    .orderBy(desc(carrierQuoteEvents.extractedAt))
    .limit(limit);
}
