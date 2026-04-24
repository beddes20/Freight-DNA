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

import { and, eq, inArray, sql } from "drizzle-orm";
import OpenAI from "openai";
import { db } from "../storage";
import {
  quoteOpportunities, quoteEvents, quoteCustomers, quoteReps,
  quoteOutcomeReasons, emailMessages,
  type EmailMessage, type QuoteOutcomeStatus,
} from "@shared/schema";
import {
  resolveCustomerName,
  UNKNOWN_CUSTOMER_NAME,
  isLegacyFreeMailCustomerName,
  type ResolvedCustomer,
} from "./customerNameResolver";

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
  { re: /\bpower[\s-]?only\b/i, name: "Power Only" },
  { re: /\bstep[\s-]?deck\b/i, name: "Step Deck" },
  { re: /\bdry\s*van(s)?\b|\bvans?\b/i, name: "Dry Van" },
];

// US state name → 2-letter code. Used by Pattern C below to translate
// "Dallas, Texas to Miami, Florida" style lanes into the strict (city, ST)
// shape the rest of the pipeline expects.
const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};
const US_STATE_NAMES_RE = Object.keys(STATE_NAME_TO_CODE)
  .sort((a, b) => b.length - a.length) // longest first so "New York" wins over "New"
  .map((s) => s.replace(/ /g, "\\s"))
  .join("|");

// City is one to three capitalized tokens (e.g. "Chicago", "St Louis",
// "Los Angeles"). Anchoring on capitalization avoids dragging the preceding
// sentence ("Need a rate from Chicago") into the origin capture.
const CITY = "[A-Z][A-Za-z'.-]+(?:\\s[A-Z][A-Za-z'.-]+){0,2}";

// Pattern A — strict: "City, ST → City, ST"
const LANE_RE = new RegExp(
  `\\b(${CITY}),\\s*([A-Z]{2})\\s*(?:to|→|->|-+>?|–|—|>)\\s*(${CITY}),\\s*([A-Z]{2})\\b`,
);

// Pattern B — uppercase blob with state codes, no commas required:
//   "EL PASO TX LAS VEGAS NV"  /  "DALLAS, TX MIAMI, FL"
// Each city is 1-3 ALL-CAPS tokens; followed by 2-letter state code; then dest.
const UPPER_CITY = "[A-Z][A-Z'.-]+(?:\\s[A-Z][A-Z'.-]+){0,2}";
const LANE_RE_UPPER = new RegExp(
  `\\b(${UPPER_CITY}),?\\s+([A-Z]{2})\\s+(?:to\\s+)?(${UPPER_CITY}),?\\s+([A-Z]{2})\\b`,
);

// Pattern C — full state names: "Dallas, Texas to Miami, Florida"  /
//   "Dallas Texas → Miami Florida"
const LANE_RE_STATENAME = new RegExp(
  `\\b(${CITY}),?\\s+(${US_STATE_NAMES_RE})\\s*(?:to|→|->|-+>?|–|—|>)\\s*(${CITY}),?\\s+(${US_STATE_NAMES_RE})\\b`,
  "i",
);

// Pattern D — bare "City to City" (no state info) — used SUBJECT-only as a
// last-resort regex hit; AI fallback fills in states.
const LANE_RE_BARE = new RegExp(
  `\\b(${CITY})\\s+(?:to|→|->|-+>?|–|—|>)\\s+(${CITY})\\b`,
);

const RATE_RE = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{3,6}(?:\.[0-9]{1,2})?)/;
const DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/;

function normalizeCity(city: string): string {
  // Title-case "EL PASO" → "El Paso"; preserve mixed-case input as-is.
  const cleaned = city.trim().replace(/\s+/g, " ");
  if (cleaned.toUpperCase() !== cleaned) return cleaned;
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
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

// ─── HTML scrubbing ─────────────────────────────────────────────────────────
// Real inbound mail comes through Outlook as HTML with embedded CSS, the
// "CAUTION: This email originated outside your organization" banner, and
// quoted reply chains. The regex parser only sees noise unless we strip all
// of that first.

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&rsquo;": "'", "&lsquo;": "'",
  "&rdquo;": '"', "&ldquo;": '"', "&mdash;": "—", "&ndash;": "–",
  "&hellip;": "…", "&copy;": "©", "&reg;": "®",
};

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;
  // Drop <style>/<script>/<head> entirely (CSS leaks junk tokens otherwise).
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ");
  // Strip the Outlook external-sender CAUTION banner (one-line variant).
  s = s.replace(/CAUTION:\s*This email originated outside[^<]*?(?:<\/[^>]+>|$)/gi, " ");
  // Replace block-level closers with newlines so lanes don't get glued together.
  s = s.replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, "\n");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  // Drop all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the most common entities.
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? " ");
  // Strip Outlook quoted-reply blocks ("On <date>, X wrote:" + everything after).
  s = s.replace(/On\s+\w+,\s+\w+\s+\d+,\s+20\d\d[\s\S]*$/i, "");
  // Strip MS Word style class chunks left over from Aptos/Cambria CSS.
  s = s.replace(/@font-face[\s\S]*?\}/g, " ");
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return s;
}

const NOT_A_QUOTE_SUBJECTS = [
  /^auto[\s-]?reply\b/i,
  /^out\s+of\s+office\b/i,
  /\bundeliverable\b/i,
  /\bdelivery\s+(status|notification|failure)\b/i,
  /\bread\s+receipt\b/i,
  /^unsubscribe\b/i,
];

function isObviouslyNotAQuote(subject: string | null | undefined, body: string): boolean {
  const s = (subject ?? "").trim();
  if (s && NOT_A_QUOTE_SUBJECTS.some((re) => re.test(s))) return true;
  const t = `${s}\n${body}`;
  if (t.length < 8) return true;
  return false;
}

function tryLanePattern(text: string, re: RegExp): {
  oCity: string; oState: string; dCity: string; dState: string;
} | null {
  const m = text.match(re);
  if (!m) return null;
  const [, oCity, oState, dCity, dState] = m;
  if (!oCity || !oState || !dCity || !dState) return null;
  return { oCity, oState, dCity, dState };
}

function tryStateNamePattern(text: string): {
  oCity: string; oState: string; dCity: string; dState: string;
} | null {
  const m = text.match(LANE_RE_STATENAME);
  if (!m) return null;
  const [, oCity, oStateName, dCity, dStateName] = m;
  const oState = STATE_NAME_TO_CODE[oStateName.toLowerCase().replace(/\s+/g, " ")];
  const dState = STATE_NAME_TO_CODE[dStateName.toLowerCase().replace(/\s+/g, " ")];
  if (!oState || !dState) return null;
  return { oCity, oState, dCity, dState };
}

/**
 * Parse a quote request out of an email body / subject.
 * Tries patterns in order from strict → permissive. Strips HTML from the
 * body first so the parser only sees prose. Returns null when no usable
 * lane is found.
 */
export function parseQuoteEmail(input: { subject?: string | null; body?: string | null }): ParsedQuoteFields | null {
  const subject = (input.subject ?? "").trim();
  const cleanBody = stripHtml(input.body ?? "");

  if (isObviouslyNotAQuote(subject, cleanBody)) return null;

  // Try the subject FIRST — it's the strongest signal in carrier/customer
  // mail (e.g. "Re: Load from Maryville, TN to Waterville, OH"). Body is
  // the fallback so noisy quoted replies don't poison the match.
  const candidates: string[] = [];
  if (subject) candidates.push(subject);
  if (cleanBody) candidates.push(cleanBody);

  let lane: { oCity: string; oState: string; dCity: string; dState: string } | null = null;
  for (const text of candidates) {
    lane =
      tryLanePattern(text, LANE_RE) ??
      tryLanePattern(text, LANE_RE_UPPER) ??
      tryStateNamePattern(text);
    if (lane) break;
  }
  if (!lane) return null;

  const fullText = `${subject}\n${cleanBody}`;
  let equipment = "Dry Van";
  for (const p of EQUIPMENT_PATTERNS) {
    if (p.re.test(fullText)) { equipment = p.name; break; }
  }

  const rateMatch = fullText.match(RATE_RE);
  const quotedAmount = rateMatch ? parseRate(rateMatch[1]) : null;
  const pickupDate = parseDate(fullText);

  return {
    originCity: normalizeCity(lane.oCity),
    originState: lane.oState.toUpperCase(),
    destCity: normalizeCity(lane.dCity),
    destState: lane.dState.toUpperCase(),
    equipment,
    quotedAmount,
    pickupDate,
  };
}

// ─── AI fallback (Task #557) ────────────────────────────────────────────────
// When the regex parser returns null but the email *looks* like a quote
// (has a city-to-city pattern OR quote/load/rate keywords + 2-letter state
// codes), call GPT-4o-mini to extract the structured fields. Bounded by a
// per-process counter and degrades gracefully when OPENAI_API_KEY isn't set.

const QUOTE_SIGNAL_RE = /\b(quote|rate|load|FTL|LTL|freight|haul|tender|capacity|truck|equipment|pickup|delivery|origin|destination)\b/i;

function looksLikeQuoteCandidate(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`;
  if (!text.trim()) return false;
  // Must have either a city-to-city hint OR a quote keyword.
  const hasLaneHint = LANE_RE_BARE.test(subject) || /\b[A-Z]{2}\b.*\b[A-Z]{2}\b/.test(text);
  const hasQuoteKw = QUOTE_SIGNAL_RE.test(text);
  return hasLaneHint || hasQuoteKw;
}

let _openaiClient: OpenAI | null | undefined;
function getOpenAi(): OpenAI | null {
  if (_openaiClient !== undefined) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  _openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
  return _openaiClient;
}

const AI_PARSE_PROMPT =
  "You are extracting freight quote-request fields from a single email. " +
  "Return STRICT JSON only, no prose. " +
  "Schema: {\"isQuote\": boolean, \"originCity\": string|null, \"originState\": string|null (2-letter US code), " +
  "\"destCity\": string|null, \"destState\": string|null (2-letter US code), " +
  "\"equipment\": one of [\"Dry Van\",\"Reefer\",\"Flatbed\",\"Power Only\",\"Step Deck\"]|null, " +
  "\"quotedAmount\": number|null (USD, no $/commas), " +
  "\"pickupDate\": string|null (YYYY-MM-DD)}. " +
  "If the email is NOT a freight quote request (rate confirmation, OOO, " +
  "marketing, status update with no rate ask), set isQuote=false and leave " +
  "the rest null. Be conservative — null beats guessing.";

const VALID_EQUIPMENT = new Set(["Dry Van", "Reefer", "Flatbed", "Power Only", "Step Deck"]);

export async function parseQuoteEmailAi(input: {
  subject?: string | null;
  body?: string | null;
}): Promise<ParsedQuoteFields | null> {
  const subject = (input.subject ?? "").trim();
  const cleanBody = stripHtml(input.body ?? "");
  if (isObviouslyNotAQuote(subject, cleanBody)) return null;
  if (!looksLikeQuoteCandidate(subject, cleanBody)) return null;

  const client = getOpenAi();
  if (!client) return null;

  // Cap the body length so token usage stays predictable across the backfill.
  const trimmedBody = cleanBody.length > 2000 ? cleanBody.slice(0, 2000) : cleanBody;
  const userMessage = `Subject: ${subject}\n\nBody:\n${trimmedBody}`;

  let raw: string | null = null;
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_PARSE_PROMPT },
        { role: "user", content: userMessage },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    // Network / rate-limit / quota errors must never crash the backfill.
    // Caller logs aggregate failures as `unparseable`.
    console.warn("[quoteEmailIngestion] AI parse error:", err instanceof Error ? err.message : err);
    return null;
  }
  if (!raw) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed.isQuote === false) return null;

  const oCity = typeof parsed.originCity === "string" ? parsed.originCity.trim() : "";
  const oState = typeof parsed.originState === "string" ? parsed.originState.trim().toUpperCase() : "";
  const dCity = typeof parsed.destCity === "string" ? parsed.destCity.trim() : "";
  const dState = typeof parsed.destState === "string" ? parsed.destState.trim().toUpperCase() : "";
  if (!oCity || !/^[A-Z]{2}$/.test(oState)) return null;
  if (!dCity || !/^[A-Z]{2}$/.test(dState)) return null;

  const equipmentRaw = typeof parsed.equipment === "string" ? parsed.equipment.trim() : "Dry Van";
  const equipment = VALID_EQUIPMENT.has(equipmentRaw) ? equipmentRaw : "Dry Van";

  let quotedAmount: number | null = null;
  if (typeof parsed.quotedAmount === "number" && isFinite(parsed.quotedAmount)) {
    if (parsed.quotedAmount >= 100 && parsed.quotedAmount <= 100000) {
      quotedAmount = Math.round(parsed.quotedAmount);
    }
  }

  let pickupDate: Date | null = null;
  if (typeof parsed.pickupDate === "string" && parsed.pickupDate) {
    const d = new Date(parsed.pickupDate);
    if (!isNaN(d.getTime())) pickupDate = d;
  }

  return {
    originCity: normalizeCity(oCity),
    originState: oState,
    destCity: normalizeCity(dCity),
    destState: dState,
    equipment,
    quotedAmount,
    pickupDate,
  };
}

/**
 * Find an existing quote_customers row for the org with the given name, or
 * insert a new one. Names are matched case-insensitively so a single
 * "Unknown — needs review" / "Acme Logistics" row is shared across every
 * email that resolves to the same customer.
 */
async function findOrCreateCustomer(orgId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  const existing = await db.select().from(quoteCustomers).where(and(
    eq(quoteCustomers.organizationId, orgId),
    sql`lower(${quoteCustomers.name}) = lower(${trimmed})`,
  )).limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db.insert(quoteCustomers).values({ organizationId: orgId, name: trimmed }).returning();
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

/**
 * Derive a customer display name from an inbound email message. Delegates
 * to the shared {@link resolveCustomerName} resolver so every ingestion
 * path (email, TMS sync, manual entry, backfill) produces the same name
 * for the same input.
 */
function deriveCustomerName(message: EmailMessage): ResolvedCustomer {
  return resolveCustomerName({
    fromEmail: message.fromEmail,
    subject: message.subject,
    body: message.body,
  });
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
  opts?: {
    extractedData?: Record<string, unknown> | null;
    customerName?: string;
    /** Default true. Set false to skip the GPT-4o-mini fallback (e.g. when
     * the live ingestion path is rate-limited or you want regex-only
     * behaviour for cost / latency reasons). */
    useAiFallback?: boolean;
  },
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
  let parsed = fromExtracted ?? fromHeuristic;
  if (!parsed && opts?.useAiFallback !== false) {
    parsed = await parseQuoteEmailAi({ subject: message.subject, body: message.body });
  }
  if (!parsed) return { status: "skipped_unparseable" };

  const customerName = opts?.customerName ?? deriveCustomerName(message).name;
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
  opts: {
    sinceDays?: number;
    limit?: number;
    /** Default true. Set false to skip the GPT-4o-mini fallback. */
    useAiFallback?: boolean;
    /** AI calls per batch — too high risks rate-limit, too low slows the
     * backfill. 5 is a safe middle for the 2-3k-email scale. */
    concurrency?: number;
  } = {},
): Promise<BackfillSummary> {
  const { sinceDays, limit, useAiFallback = true, concurrency = 5 } = opts;
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

  // Filter to the active window first so the limit/concurrency math is on
  // the actual workload, not the raw fetch.
  const work = sorted.filter((msg) => {
    if (!cutoff) return true;
    const ts = msg.providerSentAt ?? msg.createdAt ?? new Date(0);
    return ts >= cutoff;
  });
  const capped = limit ? work.slice(0, limit) : work;

  // Process in fixed-size parallel batches. Each ingestQuoteFromEmail call
  // is independent (idempotency keyed on sourceReference) so out-of-order
  // completion is safe.
  for (let i = 0; i < capped.length; i += concurrency) {
    const batch = capped.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((msg) => ingestQuoteFromEmail(msg, { useAiFallback })),
    );
    for (let j = 0; j < results.length; j++) {
      summary.scanned++;
      const r = results[j];
      if (r.status === "rejected") {
        summary.errors++;
        console.error("[quoteEmailIngestion] backfill error for message", batch[j].id, r.reason);
        continue;
      }
      const result = r.value;
      if (result.status === "ingested") summary.ingested++;
      else if (result.status === "skipped_duplicate") summary.duplicates++;
      else if (result.status === "skipped_unparseable") summary.unparseable++;
      else if (result.status === "skipped_outbound") summary.outbound++;
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
export interface FreeMailBackfillSummary {
  scanned: number;
  relinked: number;
  movedToUnknown: number;
  unchanged: number;
  customerRowsDeleted: number;
}

/**
 * Backfill (Task #578): re-resolve customer names for any quote_opportunity
 * whose linked customer row matches a legacy free-mail provider name
 * ("Gmail", "Yahoo", "Outlook", "Mac", "Pm", …) — the output of the old
 * domain-of-email logic.
 *
 * For each affected opportunity we re-look up the originating
 * email_messages row, run the new resolver, then either:
 *   - Re-link the opportunity to the correctly-named customer (extracted
 *     from subject/body), or
 *   - Re-link it to the single shared "Unknown — needs review" bucket when
 *     no company name can be determined.
 *
 * After re-linking, any quote_customers row that previously held a bare
 * provider name and has no remaining linked opportunities is deleted.
 *
 * Idempotent: re-running once everything has been migrated is a no-op
 * because the legacy provider-name rows no longer exist.
 */
export async function backfillFreeMailCustomerNames(
  orgId: string,
): Promise<FreeMailBackfillSummary> {
  const summary: FreeMailBackfillSummary = {
    scanned: 0, relinked: 0, movedToUnknown: 0, unchanged: 0, customerRowsDeleted: 0,
  };

  const candidates = await db
    .select({
      oppId: quoteOpportunities.id,
      customerId: quoteOpportunities.customerId,
      customerName: quoteCustomers.name,
      sourceReference: quoteOpportunities.sourceReference,
      source: quoteOpportunities.source,
    })
    .from(quoteOpportunities)
    .innerJoin(quoteCustomers, eq(quoteCustomers.id, quoteOpportunities.customerId))
    .where(eq(quoteOpportunities.organizationId, orgId));

  const affectedCustomerIds = new Set<string>();

  for (const row of candidates) {
    if (!isLegacyFreeMailCustomerName(row.customerName)) continue;
    summary.scanned++;
    affectedCustomerIds.add(row.customerId);

    let resolvedName = UNKNOWN_CUSTOMER_NAME;
    if (row.source === "email" && row.sourceReference) {
      const msgRows = await db.select().from(emailMessages).where(and(
        eq(emailMessages.orgId, orgId),
        eq(emailMessages.providerMessageId, row.sourceReference),
      )).limit(1);
      const msg = msgRows[0]
        ?? (await db.select().from(emailMessages).where(and(
          eq(emailMessages.orgId, orgId),
          eq(emailMessages.id, row.sourceReference),
        )).limit(1))[0];
      if (msg) {
        resolvedName = resolveCustomerName({
          fromEmail: msg.fromEmail,
          subject: msg.subject,
          body: msg.body,
        }).name;
      }
    }

    const newCustomerId = await findOrCreateCustomer(orgId, resolvedName);
    if (newCustomerId === row.customerId) {
      summary.unchanged++;
      continue;
    }
    await db.update(quoteOpportunities)
      .set({ customerId: newCustomerId })
      .where(eq(quoteOpportunities.id, row.oppId));
    if (resolvedName === UNKNOWN_CUSTOMER_NAME) summary.movedToUnknown++;
    else summary.relinked++;
  }

  // Drop any legacy provider-name customer rows that now have zero linked
  // opportunities. Safe because the only producer of these rows was the old
  // ingestion path we just replaced.
  for (const cid of affectedCustomerIds) {
    const remaining = await db.select({ id: quoteOpportunities.id })
      .from(quoteOpportunities)
      .where(eq(quoteOpportunities.customerId, cid))
      .limit(1);
    if (remaining.length === 0) {
      await db.delete(quoteCustomers).where(eq(quoteCustomers.id, cid));
      summary.customerRowsDeleted++;
    }
  }

  return summary;
}

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
