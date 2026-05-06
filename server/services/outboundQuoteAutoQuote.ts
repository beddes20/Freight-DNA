/**
 * Task #803 — Quote Lifecycle Autopilot (B): Outbound rep-reply ingest.
 *
 * When the mailbox-sync pipeline observes a SENT email from a rep on a
 * thread that already produced a `pending` quote opportunity, parse the
 * outbound body for a confirmable rate. If we extract a confident
 * (rate $, validThrough) pair, flip the quote to `quoted` and write a
 * `quote_event` with `actor='auto:outbound_reply'`. Less-confident
 * outbounds drop a `note` event onto the timeline so the rep can still
 * see autopilot looked at it.
 *
 * Idempotency: a quote_event whose `payload->>'providerMessageId'`
 * already equals this message's providerMessageId short-circuits the
 * whole flow. That keeps backfills + delta replays from double-quoting
 * the same opp.
 *
 * Scope guard: we never touch a quote that isn't `pending`. Re-quoting a
 * won/lost row would silently rewind the funnel and erase rep work.
 */
import { and, eq, sql } from "drizzle-orm";
import OpenAI from "openai";
import {
  emailMessages,
  quoteEvents,
  quoteOpportunities,
  type EmailMessage,
} from "@shared/schema";
import { db } from "../storage";

// Mirrors parseQuoteEmailAi() in quoteEmailIngestion.ts — same model so
// extraction cost / latency / behaviour are consistent across the
// inbound and outbound autopilot paths.
const MODEL = "gpt-4o-mini";

let _client: OpenAI | null = null;
function getOpenAi(): OpenAI | null {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key });
  return _client;
}

export interface OutboundAutoQuoteResult {
  status:
    | "skipped_not_outbound"
    | "skipped_no_thread"
    | "skipped_no_pending_quote"
    | "skipped_duplicate_event"
    | "skipped_unparseable"
    | "noted"
    | "quoted";
  quoteId?: string;
  quotedAmount?: number;
}

/**
 * Confident-rate extraction prompt. Conservative: when in doubt, return
 * isQuote=false / quotedAmount=null so we drop a note instead of a fake
 * confirm.
 */
const RATE_PROMPT =
  "You are reading an outbound brokerage email a rep just sent to a " +
  "shipper, in reply to a quote request. Extract whether this is a rate " +
  "confirmation (the rep is offering a price) and the offered rate. " +
  "Return JSON: " +
  '{ "isQuote": boolean, "quotedAmount": number|null, ' +
  '"confidence": "high"|"medium"|"low", ' +
  '"equipment": string|null, "validityDays": number|null }. ' +
  "Set isQuote=true ONLY when the email clearly offers a single all-in " +
  "rate for ONE shipment. Round trips, capacity-only replies, " +
  "follow-up questions, internal forwards, or vague \"working on " +
  "it\" replies must return isQuote=false. Cap quotedAmount in [100, " +
  "100000]. confidence=high requires the rate to be unambiguous AND " +
  "tied to the lane in the prior thread; medium is a reasonable but " +
  "not certain match; low means the email mentions a number but it " +
  "may not be the offered rate. " +
  "equipment: short canonical type the rep confirmed in the reply " +
  "(e.g. \"Dry Van\", \"Reefer\", \"Flatbed\", \"Power Only\") or null " +
  "if the reply doesn't restate it. validityDays: integer 1..30 if " +
  "the rep states an explicit validity window (\"good for 48 hours\", " +
  "\"valid through Friday\", etc.); null if not stated. Return null " +
  "for everything when isQuote=false.";

interface ExtractedRate {
  isQuote: boolean;
  quotedAmount: number | null;
  confidence: "high" | "medium" | "low";
  // Task #803 (B) — optional fields. Equipment is overwritten on the opp
  // only when the rep explicitly restates it (so we don't blow away a
  // good inbound-derived value with a vague reply). validityDays
  // overrides the default 7-day window when the rep gave one.
  equipment: string | null;
  validityDays: number | null;
}

function stripHtmlBasic(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractOutboundRateAi(
  subject: string,
  body: string,
): Promise<ExtractedRate | null> {
  const client = getOpenAi();
  if (!client) return null;
  const trimmed = body.length > 2000 ? body.slice(0, 2000) : body;
  let raw: string | null = null;
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RATE_PROMPT },
        { role: "user", content: `Subject: ${subject}\n\nBody:\n${trimmed}` },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.warn(
      "[outboundQuoteAutoQuote] AI extract error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const isQuote = parsed.isQuote === true;
  const conf = parsed.confidence;
  const confidence: ExtractedRate["confidence"] =
    conf === "high" || conf === "medium" || conf === "low" ? conf : "low";
  let quotedAmount: number | null = null;
  if (
    typeof parsed.quotedAmount === "number" &&
    isFinite(parsed.quotedAmount) &&
    parsed.quotedAmount >= 100 &&
    parsed.quotedAmount <= 100000
  ) {
    quotedAmount = Math.round(parsed.quotedAmount);
  }
  let equipment: string | null = null;
  if (typeof parsed.equipment === "string") {
    const eq = parsed.equipment.trim();
    if (eq && eq.length <= 64) equipment = eq;
  }
  let validityDays: number | null = null;
  if (
    typeof parsed.validityDays === "number" &&
    isFinite(parsed.validityDays) &&
    parsed.validityDays >= 1 &&
    parsed.validityDays <= 30
  ) {
    validityDays = Math.round(parsed.validityDays);
  }
  return { isQuote, quotedAmount, confidence, equipment, validityDays };
}

/**
 * Validity-window default — mirrors the inbound ingestion path which
 * also stamps requestDate + 7 days. Keeps the funnel's "expiring soon"
 * widget consistent across both ingest sources.
 */
const VALID_THROUGH_DAYS = 7;

/**
 * Apply an outbound rep email to any pending quote on the same thread.
 *
 * Called from the mailbox sync pipeline (graphWebhook) after the
 * upsertInboundEmailMessage write. Best-effort: every failure path is
 * caught and turned into a `skipped_*` status so it never breaks the
 * larger ingestion run.
 */
export async function applyOutboundReplyToOpenQuote(
  message: EmailMessage,
  // Optional dependency-injection seam used by tests so the AI extractor
  // can be stubbed without spinning up a live OpenAI call. Production
  // callers always omit it; the default uses `extractOutboundRateAi`.
  opts?: { extract?: (subject: string, body: string) => Promise<ExtractedRate | null> },
): Promise<OutboundAutoQuoteResult> {
  if (message.direction !== "outbound") return { status: "skipped_not_outbound" };
  if (!message.threadId) return { status: "skipped_no_thread" };
  if (!message.providerMessageId) return { status: "skipped_no_thread" };

  // Org-scoped idempotency guard (Task #803 review fix). The previous
  // version checked dedup AFTER candidate selection (`where quoteId =
  // oppId`). Replay scenario: pass 1 flips quote A → "quoted"; on pass 2
  // candidate selection only looks at *pending* opps so it can pick up
  // another older pending quote B on the same thread and double-process
  // the same sent email. Doing the dedup at org scope first means any
  // prior `auto:outbound_reply` (or any other event) carrying this
  // providerMessageId — anywhere in the org — short-circuits the run.
  const orgDup = await db
    .select({ id: quoteEvents.id })
    .from(quoteEvents)
    .innerJoin(
      quoteOpportunities,
      eq(quoteOpportunities.id, quoteEvents.quoteId),
    )
    .where(
      and(
        eq(quoteOpportunities.organizationId, message.orgId),
        sql`${quoteEvents.payload}->>'providerMessageId' = ${message.providerMessageId}`,
      ),
    )
    .limit(1);
  if (orgDup.length > 0) return { status: "skipped_duplicate_event" };

  // Find the most recent pending quote on this thread. Quotes are linked
  // to email threads via sourceReference (== inbound message id) +
  // emailMessages.threadId. We join through emailMessages.
  //
  // Why "most recent": a single thread can spawn multiple opps over time
  // (e.g. follow-ups quarter after quarter). Always target the freshest
  // pending one — older pending rows are presumed orphans and shouldn't
  // be retroactively quoted by a brand-new reply.
  const pendingRows = await db
    .select({
      oppId: quoteOpportunities.id,
      requestDate: quoteOpportunities.requestDate,
    })
    .from(quoteOpportunities)
    .innerJoin(
      emailMessages,
      and(
        eq(emailMessages.orgId, message.orgId),
        eq(emailMessages.id, quoteOpportunities.sourceReference),
      ),
    )
    .where(
      and(
        eq(quoteOpportunities.organizationId, message.orgId),
        eq(quoteOpportunities.outcomeStatus, "pending"),
        eq(quoteOpportunities.source, "email"),
        eq(emailMessages.threadId, message.threadId),
      ),
    );

  // Fall back to providerMessageId join — when the inbound row was keyed
  // by Graph's internetMessageId rather than the internal id.
  let candidate = pendingRows.sort(
    (a, b) =>
      (b.requestDate?.getTime() ?? 0) - (a.requestDate?.getTime() ?? 0),
  )[0];
  if (!candidate) {
    const altRows = await db
      .select({
        oppId: quoteOpportunities.id,
        requestDate: quoteOpportunities.requestDate,
      })
      .from(quoteOpportunities)
      .innerJoin(
        emailMessages,
        and(
          eq(emailMessages.orgId, message.orgId),
          eq(emailMessages.providerMessageId, quoteOpportunities.sourceReference),
        ),
      )
      .where(
        and(
          eq(quoteOpportunities.organizationId, message.orgId),
          eq(quoteOpportunities.outcomeStatus, "pending"),
          eq(quoteOpportunities.source, "email"),
          eq(emailMessages.threadId, message.threadId),
        ),
      );
    candidate = altRows.sort(
      (a, b) =>
        (b.requestDate?.getTime() ?? 0) - (a.requestDate?.getTime() ?? 0),
    )[0];
  }
  if (!candidate) return { status: "skipped_no_pending_quote" };
  const oppId = candidate.oppId;

  // (org-scoped dedup already short-circuited above, no per-quote re-check needed)

  const subject = (message.subject ?? "").trim();
  const cleanBody = stripHtmlBasic(message.body ?? "");
  const extract = opts?.extract ?? extractOutboundRateAi;
  const extracted = await extract(subject, cleanBody);
  const sentAt = message.providerSentAt ?? message.createdAt ?? new Date();

  // Confident path → flip to "quoted".
  if (
    extracted &&
    extracted.isQuote &&
    extracted.quotedAmount !== null &&
    (extracted.confidence === "high" || extracted.confidence === "medium")
  ) {
    // validity: prefer the rep's stated window when available, else fall
    // back to the canonical 7-day default so this stays consistent with
    // the inbound ingestion path's "expiring soon" widget.
    const effectiveValidityDays =
      extracted.validityDays ?? VALID_THROUGH_DAYS;
    const validThrough = new Date(
      sentAt.getTime() + effectiveValidityDays * 24 * 3600 * 1000,
    );
    // equipment: only overwrite when the rep explicitly restated it.
    // Otherwise we'd silently clobber the inbound-derived value with
    // whatever the model guessed from a thin reply.
    const update: Record<string, unknown> = {
      outcomeStatus: "quoted",
      quotedAmount: String(extracted.quotedAmount),
      validThrough,
    };
    if (extracted.equipment) update.equipment = extracted.equipment;
    await db
      .update(quoteOpportunities)
      .set(update)
      .where(eq(quoteOpportunities.id, oppId));
    await db.insert(quoteEvents).values({
      quoteId: oppId,
      eventType: "quoted",
      occurredAt: sentAt,
      actor: "auto:outbound_reply",
      payload: {
        source: "outbound_reply",
        providerMessageId: message.providerMessageId,
        messageId: message.id,
        threadId: message.threadId,
        subject,
        quotedAmount: extracted.quotedAmount,
        validThrough: validThrough.toISOString(),
        validityDays: effectiveValidityDays,
        validityFromExtract: extracted.validityDays !== null,
        equipment: extracted.equipment,
        confidence: extracted.confidence,
      },
    });
    return { status: "quoted", quoteId: oppId, quotedAmount: extracted.quotedAmount };
  }

  // Uncertain path → drop a timeline note so the rep can see we looked.
  await db.insert(quoteEvents).values({
    quoteId: oppId,
    eventType: "note",
    occurredAt: sentAt,
    actor: "auto:outbound_reply",
    payload: {
      source: "outbound_reply",
      providerMessageId: message.providerMessageId,
      messageId: message.id,
      threadId: message.threadId,
      subject,
      reason: extracted
        ? `Outbound reply not confident enough to auto-quote (isQuote=${extracted.isQuote}, confidence=${extracted.confidence})`
        : "Outbound reply could not be parsed for a rate",
      extracted,
    },
  });
  return { status: "noted", quoteId: oppId };
}
