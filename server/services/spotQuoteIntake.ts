/**
 * Spot Quote Intake (Task #617)
 *
 * Powers the "drop a screenshot or email" zone on the Customer Quotes page.
 * A rep drags an image, drops an `.eml`, or pastes raw email text and we
 * return a normalized `ParsedQuoteIntake` shape that the Spot Quote Search
 * form can use to pre-fill its inputs.
 *
 * Reuses the existing heuristic + GPT-4o-mini parser from
 * `quoteEmailIngestion.ts` so the mailbox-based ingestion and this manual
 * intake stay in sync. Image input goes through OpenAI's vision-capable
 * model with the same field schema, capped on size.
 */

import OpenAI from "openai";
import {
  parseQuoteEmail,
  parseQuoteEmailAi,
  stripHtml,
  type ParsedQuoteFields,
} from "./quoteEmailIngestion";

export type IntakeSource = "image" | "email" | "text";

export interface ParsedQuoteIntake {
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  equipment: string | null;
  /** ISO date string YYYY-MM-DD when present, otherwise null. */
  pickupDate: string | null;
  /** Raw shipper / customer name we read; not yet matched to a customer id. */
  customerHint: string | null;
  /** Optional rate or target rate the requester suggested. */
  rateHint: number | null;
  /** 0..1 — how confident we are in the parsed lane. */
  confidence: number;
  /** The text we extracted from the source (helpful for the "what we read" peek). */
  rawText: string;
  source: IntakeSource;
  /** Soft warnings/notes the UI can surface. */
  notes: string[];
}

/**
 * Cap inbound images at 8 MB to keep vision calls bounded and predictable.
 * 8 MB comfortably fits a screen capture or pasted Outlook screenshot.
 */
export const MAX_INTAKE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Total payload cap for raw email or .eml uploads. */
export const MAX_INTAKE_TEXT_BYTES = 1 * 1024 * 1024;

const VISION_PROMPT =
  "You are extracting freight quote-request fields from a screenshot of an " +
  "email, chat message, or quote form. Return STRICT JSON only, no prose. " +
  "Schema: {\"isQuote\": boolean, \"pickupCity\": string|null, \"pickupState\": string|null (2-letter US code), " +
  "\"deliveryCity\": string|null, \"deliveryState\": string|null (2-letter US code), " +
  "\"equipment\": one of [\"Dry Van\",\"Reefer\",\"Flatbed\",\"Power Only\",\"Step Deck\"]|null, " +
  "\"pickupDate\": string|null (YYYY-MM-DD), " +
  "\"rateHint\": number|null (USD, no $ or commas), " +
  "\"customerHint\": string|null (shipper/customer/account name if visible), " +
  "\"rawText\": string (best-effort transcription of the visible text, max 2000 chars)}. " +
  "If the image is NOT a freight quote request, set isQuote=false and leave " +
  "the rest null. Be conservative — null beats guessing.";

const VALID_EQUIPMENT = new Set(["Dry Van", "Reefer", "Flatbed", "Power Only", "Step Deck"]);

let _openaiClient: OpenAI | null | undefined;
function getOpenAi(): OpenAI | null {
  if (_openaiClient !== undefined) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  _openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
  return _openaiClient;
}

function isoDateOrNull(d: Date | null): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Heuristic confidence based on how many required fields we ended up with.
 * Caller decides whether to auto-search; we just describe what we know.
 */
function scoreConfidence(fields: {
  pickupCity: string | null; pickupState: string | null;
  deliveryCity: string | null; deliveryState: string | null;
  equipment: string | null; pickupDate: string | null;
}): number {
  let score = 0;
  if (fields.pickupCity && fields.pickupState) score += 0.4;
  if (fields.deliveryCity && fields.deliveryState) score += 0.4;
  if (fields.equipment) score += 0.1;
  if (fields.pickupDate) score += 0.1;
  return Math.min(1, score);
}

/**
 * Strip a forwarded-email subject prefix block (Fwd:, FW:, Re:) so the
 * customer-name guess doesn't include "Fwd:" tokens.
 */
function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^\s*(?:fwd?|fw|re)\s*[:\-]\s*/i, "").trim();
}

/**
 * Extract a likely customer name from the source text. Best-effort:
 *   1. Subject "from <Customer>" or "<Customer> -" patterns.
 *   2. The "From:" header in raw email text (display name before the <addr>).
 *   3. The first capitalized token group above the lane line.
 */
function extractCustomerHint(subject: string, body: string): string | null {
  const fromHeader = body.match(/^From:\s*([^<\r\n]+?)\s*<[^>]+>/im)
    ?? body.match(/^From:\s*([^\r\n]+)$/im);
  if (fromHeader && fromHeader[1]) {
    const cand = fromHeader[1].replace(/["']/g, "").trim();
    // Skip if it looks like a bare email address.
    if (cand && !/@/.test(cand) && cand.length <= 80) return cand;
  }
  const cleanSubj = stripSubjectPrefixes(subject);
  // "Quote from Acme Logistics" / "Acme Logistics — quote request"
  const m = cleanSubj.match(/(?:from|for)\s+([A-Z][A-Za-z0-9 &.'-]{2,60})/);
  if (m) return m[1].trim();
  return null;
}

/**
 * Parse text input (pasted email body, chat snippet, or `.eml` content).
 * Routes through the same heuristic-then-AI pipeline as mailbox ingestion
 * so behaviour stays identical.
 */
export async function parseQuoteIntakeFromText(input: {
  subject?: string | null;
  body?: string | null;
  rawText?: string | null;
  source?: IntakeSource;
  /**
   * Anchor for relative pickup-date phrases like "tomorrow" or
   * "next Tuesday". Defaults to "now" — callers ingesting from a stored
   * email should pass the message's send time.
   */
  referenceDate?: Date | null;
}): Promise<ParsedQuoteIntake> {
  const source: IntakeSource = input.source ?? (input.rawText ? "email" : "text");
  let subject = (input.subject ?? "").trim();
  let body = input.body ?? "";

  // If the caller handed us raw .eml content, split off the headers so the
  // parser only sees prose. Plain pasted email text without an "Subject:"
  // header just falls through to body.
  if (input.rawText && !subject && !body) {
    const split = splitEml(input.rawText);
    subject = split.subject;
    body = split.body;
  }

  const cleanBody = stripHtml(body);
  const rawText = [subject, cleanBody].filter(Boolean).join("\n").slice(0, 4000);

  // Heuristic first; AI fallback only when the heuristic returned null AND
  // the text looks like a quote candidate. This mirrors `ingestQuoteFromEmail`.
  let parsed: ParsedQuoteFields | null = parseQuoteEmail({
    subject,
    body,
    referenceDate: input.referenceDate ?? null,
  });
  let usedAi = false;
  if (!parsed) {
    const ai = await parseQuoteEmailAi({ subject, body });
    if (ai) { parsed = ai; usedAi = true; }
  }

  const customerHint = extractCustomerHint(subject, cleanBody);

  if (!parsed) {
    return {
      pickupCity: null, pickupState: null,
      deliveryCity: null, deliveryState: null,
      equipment: null, pickupDate: null,
      customerHint, rateHint: null,
      confidence: 0,
      rawText,
      source,
      notes: ["No lane found in the email text."],
    };
  }

  const fields = {
    pickupCity: parsed.originCity,
    pickupState: parsed.originState,
    deliveryCity: parsed.destCity,
    deliveryState: parsed.destState,
    equipment: parsed.equipment,
    pickupDate: isoDateOrNull(parsed.pickupDate),
  };
  const notes: string[] = [];
  if (usedAi) notes.push("Lane was extracted by AI fallback.");

  return {
    ...fields,
    customerHint,
    rateHint: parsed.quotedAmount,
    confidence: scoreConfidence(fields),
    rawText,
    source,
    notes,
  };
}

/**
 * Parse an image (screenshot of an email/chat) using OpenAI vision.
 * Falls back to a clear error result when the OpenAI key is unavailable
 * or the model can't find a lane.
 */
export async function parseQuoteIntakeFromImage(
  buffer: Buffer,
  mimeType: string,
): Promise<ParsedQuoteIntake> {
  const baseEmpty: ParsedQuoteIntake = {
    pickupCity: null, pickupState: null,
    deliveryCity: null, deliveryState: null,
    equipment: null, pickupDate: null,
    customerHint: null, rateHint: null,
    confidence: 0, rawText: "", source: "image", notes: [],
  };

  if (buffer.byteLength > MAX_INTAKE_IMAGE_BYTES) {
    return { ...baseEmpty, notes: ["Image is too large — please upload under 8 MB."] };
  }

  const client = getOpenAi();
  if (!client) {
    return { ...baseEmpty, notes: ["Image parsing is unavailable — OpenAI key is not configured."] };
  }

  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  let raw: string | null = null;
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: VISION_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the freight quote fields from this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    raw = completion.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.warn("[spotQuoteIntake] vision parse error:", err instanceof Error ? err.message : err);
    return { ...baseEmpty, notes: ["We couldn't read this image — try a clearer screenshot or paste the text instead."] };
  }
  if (!raw) {
    return { ...baseEmpty, notes: ["The image didn't return any data — try a clearer screenshot."] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...baseEmpty, notes: ["The vision model returned an unreadable response."] };
  }

  const rawText = typeof parsed.rawText === "string" ? parsed.rawText.slice(0, 4000) : "";

  if (parsed.isQuote === false) {
    return {
      ...baseEmpty,
      rawText,
      notes: ["This image doesn't look like a quote request."],
    };
  }

  const oCity = typeof parsed.pickupCity === "string" ? parsed.pickupCity.trim() : "";
  const oState = typeof parsed.pickupState === "string" ? parsed.pickupState.trim().toUpperCase() : "";
  const dCity = typeof parsed.deliveryCity === "string" ? parsed.deliveryCity.trim() : "";
  const dState = typeof parsed.deliveryState === "string" ? parsed.deliveryState.trim().toUpperCase() : "";

  const equipmentRaw = typeof parsed.equipment === "string" ? parsed.equipment.trim() : "";
  const equipment = VALID_EQUIPMENT.has(equipmentRaw) ? equipmentRaw : null;

  let rateHint: number | null = null;
  if (typeof parsed.rateHint === "number" && isFinite(parsed.rateHint)) {
    if (parsed.rateHint >= 100 && parsed.rateHint <= 100000) rateHint = Math.round(parsed.rateHint);
  }

  let pickupDate: string | null = null;
  if (typeof parsed.pickupDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(parsed.pickupDate)) {
    pickupDate = parsed.pickupDate.slice(0, 10);
  }

  const customerHint = typeof parsed.customerHint === "string" && parsed.customerHint.trim()
    ? parsed.customerHint.trim()
    : null;

  const fields = {
    pickupCity: oCity || null,
    pickupState: /^[A-Z]{2}$/.test(oState) ? oState : null,
    deliveryCity: dCity || null,
    deliveryState: /^[A-Z]{2}$/.test(dState) ? dState : null,
    equipment,
    pickupDate,
  };

  const notes: string[] = [];
  const haveLane = fields.pickupCity && fields.pickupState && fields.deliveryCity && fields.deliveryState;
  if (!haveLane) notes.push("We couldn't pin down a full lane from the image — please complete the missing fields.");

  return {
    ...fields,
    customerHint,
    rateHint,
    confidence: scoreConfidence(fields),
    rawText,
    source: "image",
    notes,
  };
}

/**
 * Split raw `.eml` content into subject + body. We don't decode MIME parts
 * here — the parser only needs prose, and `stripHtml` already handles the
 * HTML-vs-text mix.
 */
function splitEml(rawEml: string): { subject: string; body: string } {
  // Headers end at the first blank line.
  const headerEnd = rawEml.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd >= 0 ? rawEml.slice(0, headerEnd) : rawEml;
  const body = headerEnd >= 0 ? rawEml.slice(headerEnd + 2).trim() : "";
  const m = headerBlock.match(/^Subject:\s*(.+)$/im);
  const subject = m ? m[1].replace(/\r?\n\s+/g, " ").trim() : "";
  return { subject, body };
}

/**
 * Match a customer hint string against the org's customer list. Returns the
 * id when we have a confident hit so the dashboard can pre-select the
 * customer dropdown. Falls back to null otherwise (the UI then surfaces
 * the hint as an editable suggestion).
 */
export function matchCustomerByHint(
  hint: string | null,
  customers: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (!hint || customers.length === 0) return null;
  const target = normaliseName(hint);
  if (!target) return null;

  // Exact (normalised) match wins.
  const exact = customers.find(c => normaliseName(c.name) === target);
  if (exact) return exact.id;

  // Token-set match: every word of hint must appear in candidate name.
  const hintWords = target.split(" ").filter(w => w.length >= 3);
  if (hintWords.length === 0) return null;
  const candidates = customers.filter(c => {
    const n = normaliseName(c.name);
    return hintWords.every(w => n.includes(w));
  });
  if (candidates.length === 1) return candidates[0].id;

  // Substring containment as a final pass — "Acme Logistics" matches
  // "Acme Logistics Co." and vice versa when no other candidate fits.
  const containment = customers.filter(c => {
    const n = normaliseName(c.name);
    return n.includes(target) || target.includes(n);
  });
  if (containment.length === 1) return containment[0].id;

  return null;
}

function normaliseName(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|logistics|transport|trucking)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
