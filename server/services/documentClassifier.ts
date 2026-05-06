/**
 * Task #910 — Pre-classifier for ingested documents.
 *
 * Two-tier policy:
 *   1. Deterministic signals (mime type, filename regex, first-page keyword
 *      scan) — covers the common cases at ~zero latency / cost.
 *   2. Small-model fallback (gpt-4o-mini) — only when the deterministic
 *      tier returns `unknown` AND we have at least 80 chars of text to
 *      look at. Capped to 2k chars of input.
 *
 * The label vocabulary lives in `shared/schema.ts` (`DOCUMENT_CLASSES`).
 * This module is pure-ish: deterministic tier is sync + side-effect free
 * so unit tests can lock the regexes down without an LLM stub.
 */
import { DOCUMENT_CLASSES, type DocumentClass } from "@shared/schema";
import { getAgentOpenAI, AGENT_MODELS } from "../agent/openai";

export interface ClassificationInput {
  filename: string;
  mimeType: string;
  // Concatenated first-page text (already trimmed by the ingestion layer).
  firstPageText: string;
  // Optional: the originating email subject when source = email_forward.
  emailSubject?: string | null;
}

export interface ClassificationResult {
  label: DocumentClass;
  confidence: number; // 0..1
  method: "filename" | "mime" | "keyword" | "model" | "default";
  reason: string;
}

// ─── Deterministic patterns ───────────────────────────────────────────────
// Order matters — the first match wins. Patterns are intentionally narrow;
// false positives are worse than falling through to the model.
const FILENAME_PATTERNS: Array<{ re: RegExp; label: DocumentClass; reason: string }> = [
  { re: /\b(rate[\s_-]*con(firmation)?|ratecon)\b/i, label: "rate_con", reason: "Filename matches rate confirmation" },
  { re: /\b(rfp|bid[\s_-]*sheet|rfq)\b/i, label: "rfp_bid_sheet", reason: "Filename matches RFP/bid sheet" },
  { re: /\b(routing[\s_-]*guide)\b/i, label: "routing_guide", reason: "Filename matches routing guide" },
  // BOL/POD — explicit boundaries that allow underscores ("signed_BOL_12345.pdf")
  // since `\b` doesn't match between letters and underscores.
  { re: /(?:^|[^a-z0-9])(bol|bill[\s_-]*of[\s_-]*lading|pod|proof[\s_-]*of[\s_-]*delivery)(?:[^a-z0-9]|$)/i, label: "bol", reason: "Filename matches BOL/POD" },
  { re: /\b(tariff)\b/i, label: "tariff", reason: "Filename matches tariff" },
  { re: /\b(accessorial(s)?|fee[\s_-]*schedule)\b/i, label: "accessorial_schedule", reason: "Filename matches accessorial schedule" },
  { re: /\b(scorecard|carrier[\s_-]*report)\b/i, label: "scorecard", reason: "Filename matches scorecard" },
  { re: /\b(contract|msa|nda|service[\s_-]*agreement)\b/i, label: "contract", reason: "Filename matches contract" },
];

const KEYWORD_PATTERNS: Array<{ re: RegExp; label: DocumentClass; reason: string }> = [
  { re: /\brate\s*confirmation\b/i, label: "rate_con", reason: "First page contains 'rate confirmation'" },
  { re: /\bload\s*confirmation\b/i, label: "rate_con", reason: "First page contains 'load confirmation'" },
  { re: /\b(bill\s*of\s*lading|signed\s*bol|proof\s*of\s*delivery)\b/i, label: "bol", reason: "First page contains BOL/POD phrase" },
  { re: /\brouting\s*guide\b/i, label: "routing_guide", reason: "First page contains 'routing guide'" },
  { re: /\b(request\s*for\s*proposal|bid\s*lane|annual\s*bid)\b/i, label: "rfp_bid_sheet", reason: "First page contains RFP phrase" },
  { re: /\b(carrier\s*scorecard|on[-\s]?time\s*delivery|otd)\b/i, label: "scorecard", reason: "First page contains scorecard phrase" },
  { re: /\b(accessorial\s*charge|detention|layover|tonu)\b/i, label: "accessorial_schedule", reason: "First page contains accessorial phrase" },
  { re: /\b(master\s*service\s*agreement|broker[/\s-]carrier\s*agreement|terms\s*and\s*conditions)\b/i, label: "contract", reason: "First page contains contract phrase" },
];

function classifyByMime(mimeType: string, filename: string): ClassificationResult | null {
  const m = (mimeType || "").toLowerCase();
  if (m === "message/rfc822" || /\.(eml|msg)$/i.test(filename)) {
    return { label: "email_thread", confidence: 0.95, method: "mime", reason: "MIME = message/rfc822" };
  }
  if (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel" ||
    m === "text/csv" ||
    /\.(xlsx|xls|csv)$/i.test(filename)
  ) {
    // Spreadsheets default to spreadsheet_lanes — most of what reps drop in
    // from carriers/customers is a lane list. Filename overrides below.
    return { label: "spreadsheet_lanes", confidence: 0.6, method: "mime", reason: "Spreadsheet MIME type" };
  }
  return null;
}

function classifyByFilename(filename: string): ClassificationResult | null {
  for (const p of FILENAME_PATTERNS) {
    if (p.re.test(filename)) {
      return { label: p.label, confidence: 0.92, method: "filename", reason: p.reason };
    }
  }
  return null;
}

function classifyByKeyword(text: string): ClassificationResult | null {
  if (!text) return null;
  for (const p of KEYWORD_PATTERNS) {
    if (p.re.test(text)) {
      return { label: p.label, confidence: 0.85, method: "keyword", reason: p.reason };
    }
  }
  return null;
}

/**
 * Cheap deterministic pass. Returns `unknown` only when nothing matched —
 * the ingestion layer can then choose to escalate to the model tier.
 */
export function classifyDeterministic(input: ClassificationInput): ClassificationResult {
  // Filename takes precedence over a generic mime label so e.g.
  // "Acme RFP.xlsx" routes to rfp_bid_sheet, not spreadsheet_lanes.
  const byFilename = classifyByFilename(input.filename);
  if (byFilename) return byFilename;
  const byEmailSubject = input.emailSubject ? classifyByFilename(input.emailSubject) : null;
  if (byEmailSubject) return { ...byEmailSubject, method: "filename", reason: `Email subject — ${byEmailSubject.reason}` };
  const byMime = classifyByMime(input.mimeType, input.filename);
  if (byMime) return byMime;
  const byKeyword = classifyByKeyword(input.firstPageText);
  if (byKeyword) return byKeyword;
  return { label: "unknown", confidence: 0.0, method: "default", reason: "No deterministic signal matched" };
}

const MODEL_LABELS = DOCUMENT_CLASSES.filter((l) => l !== "unknown").join(", ");

// Minimal subset of the OpenAI chat-completions surface we touch. Lets the
// test suite inject a stub without pulling in the full openai type tree, and
// keeps the production callsite type-safe (no `any[]`).
export interface ChatCompletionLike {
  choices?: Array<{ message?: { content?: string | null } | null } | undefined>;
}
export interface ChatCompletionRequest {
  model: string;
  temperature?: number;
  max_tokens?: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}
export interface ClassifierOpenAIClient {
  chat: {
    completions: {
      create(req: ChatCompletionRequest): Promise<ChatCompletionLike>;
    };
  };
}

/**
 * Small-model fallback. Cap input to 2k chars and ask for a single label.
 * `openaiOverride` lets the test suite inject a fake.
 */
export async function classifyWithModel(
  input: ClassificationInput,
  openaiOverride?: ClassifierOpenAIClient,
): Promise<ClassificationResult> {
  const text = (input.firstPageText || "").slice(0, 2000).trim();
  if (text.length < 80) {
    return { label: "unknown", confidence: 0.1, method: "default", reason: "Not enough extractable text for model classification" };
  }
  try {
    const client = openaiOverride ?? getAgentOpenAI();
    const completion = await client.chat.completions.create({
      model: AGENT_MODELS.fast,
      temperature: 0,
      max_tokens: 50,
      messages: [
        {
          role: "system",
          content:
            "You classify freight documents. Respond with EXACTLY one label from this list and nothing else: " +
            MODEL_LABELS +
            ". If none clearly fits, respond `unknown`.",
        },
        {
          role: "user",
          content: `Filename: ${input.filename}\nMIME: ${input.mimeType}\nFirst page text:\n${text}`,
        },
      ],
    });
    const raw = completion?.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "unknown";
    const matched = (DOCUMENT_CLASSES as readonly string[]).includes(raw)
      ? (raw as DocumentClass)
      : "unknown";
    return {
      label: matched,
      confidence: matched === "unknown" ? 0.2 : 0.7,
      method: "model",
      reason: `Model returned "${raw}"`,
    };
  } catch (err) {
    console.warn("[documentClassifier] model fallback failed:", err);
    return { label: "unknown", confidence: 0.0, method: "default", reason: "Model classifier error" };
  }
}

/**
 * Single entry point — deterministic first, model fallback when nothing
 * matched. Returns the deterministic result on a positive match so we
 * never spend a model call when we already know the answer.
 */
export async function classifyDocument(
  input: ClassificationInput,
  openaiOverride?: Parameters<typeof classifyWithModel>[1],
): Promise<ClassificationResult> {
  const det = classifyDeterministic(input);
  if (det.label !== "unknown") return det;
  return classifyWithModel(input, openaiOverride);
}
