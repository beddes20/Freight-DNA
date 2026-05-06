/**
 * Task #911 — Rate-Con Extractor (slice 2 of DNA Copilot doc pipeline).
 *
 * Pulls page text from `document_pages` (slice 1), prompts the reasoning
 * model with a strict JSON-Schema-shaped contract anchored to
 * `rateConExtractionSchema`, validates the response with Zod, and persists
 * to `document_extractions_typed`. Idempotent: re-running on the same
 * document overwrites the prior payload only when the version increments.
 *
 * The extractor never silently degrades: if Zod parse fails, we mark the
 * extraction `failed` with a reason so the admin queue can retry. Partial
 * payloads are NOT written.
 */
import OpenAI from "openai";
import { storage } from "../storage";
import { getAgentOpenAI, AGENT_MODELS } from "../agent/openai";
import {
  rateConExtractionSchema,
  RATE_CON_FIELD_PATHS,
  type RateConExtraction,
  type Document,
  type DocumentPage,
  type DocumentExtractionTyped,
  type FieldConfidenceOverride,
} from "@shared/schema";

const RATE_CON_PAYLOAD_VERSION = 1;
const MAX_PAGE_TEXT_CHARS = 6000;
const MAX_PAGES_FOR_PROMPT = 4;

const EXTRACTOR_SYSTEM_PROMPT = `You extract rate-confirmation (rate con) data from freight broker PDFs and emails.
You return STRICT JSON matching the supplied schema. Every leaf field is an object
{ value, confidence, source } where:
- "value" is the extracted value or null when not present in the document.
- "confidence" is a number 0..1 reflecting how certain you are. Use 0.95+ only when
  the value is unambiguous and copied verbatim from the document. Use 0.5..0.7 when
  the value required minor inference. Use < 0.4 when you are guessing — prefer null.
- "source" is { page: <1-based page number>, bbox: { x, y, w, h } | null }. Use null
  bbox if the document text was not laid out (plain email body, etc.). Page must
  refer to the page where you found the value.

Normalisation rules:
- Dates / windows: ISO-8601 ("2025-04-21T08:00:00-05:00" or "2025-04-21" if no time).
- Money: numeric dollars (1950, not "$1,950.00"). If both line haul + fuel are
  present, populate lineHaulRate AND fuelSurcharge AND allInRate. If only the
  total is given, only fill allInRate (others null).
- Weight: pounds as a number.
- MC / DOT: digits only (strip "MC#", "MC-", "DOT", commas).
- Accessorials: itemise. {description, amount, confidence, source}. amount may be null
  if the line is "TBD" / "as incurred". If no accessorials are listed, return
  { items: [], confidence: 0.9 }.
- Pay terms: short canonical strings ("Net 30", "Quickpay 2%/7", "Factoring OK"...).

Never fabricate carrier names, MC numbers, or load references not present in the text.
Return null with low confidence instead.`;

interface ExtractRateConArgs {
  documentId: string;
  organizationId: string;
  /** Override for tests + admin retry. */
  openaiOverride?: OpenAI;
  /** Override page rows for tests (skips DB read). */
  pagesOverride?: DocumentPage[];
  /** Skip OpenAI and use this payload — for tests. */
  payloadOverride?: RateConExtraction;
  /** Allow forcing a re-extract even if payload already at current version. */
  force?: boolean;
}

export interface ExtractRateConResult {
  extraction: DocumentExtractionTyped | null;
  status: "extracted" | "needs_review" | "failed" | "skipped";
  reason: string | null;
  payload: RateConExtraction | null;
}

/**
 * Run extraction for a single document. Returns the persisted row + status.
 * Safe to call concurrently — last write wins per-document via the unique
 * (documentId) constraint on document_extractions_typed.
 */
export async function extractRateCon(args: ExtractRateConArgs): Promise<ExtractRateConResult> {
  const doc = await storage.getDocumentInOrg(args.documentId, args.organizationId);
  if (!doc) {
    return { extraction: null, status: "failed", reason: "document_not_found_or_wrong_org", payload: null };
  }
  if (doc.classLabel !== "rate_con") {
    return { extraction: null, status: "skipped", reason: `class is "${doc.classLabel}", not rate_con`, payload: null };
  }
  if (doc.status !== "parsed") {
    return { extraction: null, status: "failed", reason: `document status is ${doc.status}, expected parsed`, payload: null };
  }

  // Idempotency — skip if already at current version unless forced.
  const existing = await storage.getDocumentExtraction(doc.id);
  if (existing && existing.payloadVersion >= RATE_CON_PAYLOAD_VERSION && existing.extractionStatus === "extracted" && !args.force) {
    const parsed = rateConExtractionSchema.safeParse(existing.payload);
    return {
      extraction: existing,
      status: "extracted",
      reason: "already_extracted_at_current_version",
      payload: parsed.success ? parsed.data : null,
    };
  }

  // 1. Build the prompt input from page text. We cap pages + chars so the
  //    model context stays bounded — multi-page rate cons usually have all
  //    the fields on page 1, with terms & conditions on subsequent pages.
  const pages = args.pagesOverride ?? await storage.getDocumentPages(doc.id);
  if (pages.length === 0) {
    await markFailed(doc, args.organizationId, "no_pages_indexed");
    return { extraction: null, status: "failed", reason: "no_pages_indexed", payload: null };
  }

  // 2. Extract via model OR test override.
  let payload: RateConExtraction;
  let modelLabel = "test_override";
  if (args.payloadOverride) {
    payload = args.payloadOverride;
  } else {
    try {
      const result = await callExtractor(doc, pages, args.openaiOverride);
      payload = result.payload;
      modelLabel = result.model;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await markFailed(doc, args.organizationId, `extractor_error: ${reason.slice(0, 200)}`);
      return { extraction: null, status: "failed", reason, payload: null };
    }
  }

  // 3. Validate. Reject the whole payload on parse failure.
  const parsed = rateConExtractionSchema.safeParse(payload);
  if (!parsed.success) {
    const summary = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    await markFailed(doc, args.organizationId, `zod_validation_failed: ${summary}`);
    return { extraction: null, status: "failed", reason: `zod_validation_failed: ${summary}`, payload: null };
  }

  // 4. Apply confidence calibration overrides (slice 2 step 8).
  const overrides = await storage.listFieldConfidenceOverrides(args.organizationId, "rate_con");
  const calibrated = applyConfidenceOverrides(parsed.data, overrides);

  // 5. Persist.
  const row = await storage.upsertDocumentExtraction({
    documentId: doc.id,
    organizationId: args.organizationId,
    classLabel: "rate_con",
    payloadVersion: RATE_CON_PAYLOAD_VERSION,
    payload: calibrated as unknown as Record<string, unknown>,
    extractionStatus: "extracted",
    needsReviewReason: null,
    extractorModel: modelLabel,
  });

  return { extraction: row, status: "extracted", reason: null, payload: calibrated };
}

async function markFailed(doc: Document, organizationId: string, reason: string): Promise<void> {
  // Upsert a stub failed row so the admin queue can show the reason and
  // schedule a retry. Payload is `{}` — readers must check
  // extractionStatus before reading fields.
  await storage.upsertDocumentExtraction({
    documentId: doc.id,
    organizationId,
    classLabel: doc.classLabel,
    payloadVersion: RATE_CON_PAYLOAD_VERSION,
    payload: {} as Record<string, unknown>,
    extractionStatus: "failed",
    needsReviewReason: reason,
    extractorModel: null,
  });
}

interface CallExtractorResult {
  payload: RateConExtraction;
  model: string;
}

async function callExtractor(
  doc: Document,
  pages: DocumentPage[],
  openaiOverride: OpenAI | undefined,
): Promise<CallExtractorResult> {
  const ai = openaiOverride ?? getAgentOpenAI();
  const model = AGENT_MODELS.reasoning;
  const limited = pages.slice(0, MAX_PAGES_FOR_PROMPT);
  const pagesText = limited.map((p) => {
    const text = (p.text ?? "").slice(0, MAX_PAGE_TEXT_CHARS);
    return `--- PAGE ${p.pageNumber} ---\n${text}`;
  }).join("\n\n");

  const userPrompt = [
    `Document: ${doc.filename} (${doc.mimeType ?? "?"})`,
    doc.forwardedSubject ? `Forwarded subject: ${doc.forwardedSubject}` : null,
    "",
    "Extract the rate-confirmation fields and return STRICT JSON matching the schema.",
    "",
    pagesText,
  ].filter(Boolean).join("\n");

  const completion = await ai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error("model_returned_empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`model_returned_non_json: ${(err as Error).message}`);
  }
  // We don't validate here — caller runs Zod after applying calibration.
  return { payload: parsed as RateConExtraction, model };
}

function applyConfidenceOverrides(
  payload: RateConExtraction,
  overrides: FieldConfidenceOverride[],
): RateConExtraction {
  if (overrides.length === 0) return payload;
  const byPath = new Map(overrides.map((o) => [o.fieldPath, Number(o.confidenceMultiplier)]));
  // Shallow clone — only fields that have an override get touched.
  const out: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) };
  for (const path of RATE_CON_FIELD_PATHS) {
    const mult = byPath.get(path);
    if (mult == null || !Number.isFinite(mult) || mult >= 1) continue;
    const field = out[path] as { value: unknown; confidence: number; source?: unknown } | undefined;
    if (!field || typeof field.confidence !== "number") continue;
    out[path] = { ...field, confidence: Math.max(0, Math.min(1, field.confidence * mult)) };
  }
  return out as unknown as RateConExtraction;
}

/** Surface the current payload version for tests / admin pages. */
export const CURRENT_RATE_CON_PAYLOAD_VERSION = RATE_CON_PAYLOAD_VERSION;
