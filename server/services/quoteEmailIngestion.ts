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

import { and, eq } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteOpportunities, quoteEvents, quoteCustomers, quoteReps,
  type EmailMessage,
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

function pickStr(data: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && isFinite(v)) return String(v);
  }
  return null;
}
