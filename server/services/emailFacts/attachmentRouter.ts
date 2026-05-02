/**
 * Email Intelligence v1.5 — Tier 1.3 attachment router (Task #943).
 *
 * Classifies every attachment on an inbound message into a `kind` and routes
 * the high-value flows downstream. Today the only wired downstream is rate-con
 * extraction; POD/BOL/COI/MSA/RFP land as classification rows ready for future
 * tasks to attach handlers.
 *
 * Heuristic-first — no LLM. Filename + content-type carry 90% of the signal.
 */

import type { EmailMessage, EmailAttachmentKind, EmailAttachmentClassification, InsertEmailAttachmentClassification } from "@shared/schema";
import { upsertAttachmentClassification } from "./emailFactsStorage";

export interface AttachmentInput {
  name: string;
  contentType?: string | null;
  size?: number | null;
  contentBase64?: string | null;
}

export interface ClassifiedAttachment {
  kind: EmailAttachmentKind;
  confidence: number;
  features: Record<string, unknown>;
}

const RATE_CON_HINTS = [/rate[\s_-]?con/i, /\brate\s+confirmation\b/i, /\bcarrier\s+confirmation\b/i];
const POD_HINTS = [/\bpod\b/i, /proof[\s_-]?of[\s_-]?delivery/i, /signed[\s_-]?bol/i];
const BOL_HINTS = [/\bbol\b/i, /bill[\s_-]?of[\s_-]?lading/i];
const COI_HINTS = [/\bcoi\b/i, /certificate[\s_-]?of[\s_-]?insurance/i, /acord/i];
const MSA_HINTS = [/\bmsa\b/i, /master[\s_-]?service[\s_-]?(agreement|contract)/i, /broker[\s_-]?carrier[\s_-]?agreement/i];
const RFP_HINTS = [/\brfp\b/i, /\brfq\b/i, /\bbid\s+package\b/i, /\blane\s+award\b/i, /lane[\s_-]?bid/i];

const CT_PDF = ["application/pdf"];
const CT_SHEET = [
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
];
const CT_IMAGE_PREFIX = "image/";
const CT_DOCX = [
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function classifyAttachment(att: AttachmentInput): ClassifiedAttachment {
  const name = att.name || "";
  const lc = name.toLowerCase();
  const ct = (att.contentType || "").toLowerCase();
  const features: Record<string, unknown> = { name, contentType: ct };

  function any(hits: RegExp[]): boolean {
    const matches = hits.filter((re) => re.test(lc));
    if (matches.length === 0) return false;
    features.matchedFilenameHints = matches.map((re) => re.toString());
    return true;
  }

  if (any(RATE_CON_HINTS)) return { kind: "rate_con", confidence: 90, features };
  if (any(POD_HINTS)) return { kind: "pod", confidence: 85, features };
  if (any(BOL_HINTS)) return { kind: "bol", confidence: 75, features };
  if (any(COI_HINTS)) return { kind: "coi", confidence: 85, features };
  if (any(MSA_HINTS)) return { kind: "msa", confidence: 85, features };
  if (any(RFP_HINTS)) return { kind: "rfp_workbook", confidence: 75, features };

  // Type-only fallbacks.
  if (CT_SHEET.includes(ct) || /\.(xlsx?|csv)$/i.test(lc)) {
    features.fallback = "spreadsheet";
    return { kind: "spreadsheet", confidence: 50, features };
  }
  if (ct.startsWith(CT_IMAGE_PREFIX) || /\.(png|jpe?g|gif|tiff?|bmp|webp)$/i.test(lc)) {
    features.fallback = "image";
    return { kind: "image", confidence: 50, features };
  }
  if (CT_PDF.includes(ct) || /\.pdf$/i.test(lc) || CT_DOCX.includes(ct) || /\.docx?$/i.test(lc)) {
    features.fallback = "document";
    return { kind: "document", confidence: 40, features };
  }
  features.fallback = "generic";
  return { kind: "generic", confidence: 25, features };
}

export interface RateConRouterFn {
  (msg: EmailMessage, att: AttachmentInput): Promise<{ extractionId: string | null }>;
}

export interface RouteOptions {
  rateConRouter?: RateConRouterFn;
}

/**
 * Route a single attachment — classify, persist the row, and call the
 * downstream handler when one is wired. Idempotent on (message_id, name).
 */
export async function routeAttachment(
  msg: EmailMessage,
  att: AttachmentInput,
  opts?: RouteOptions,
): Promise<EmailAttachmentClassification> {
  const classified = classifyAttachment(att);
  let routedTo: string | null = null;
  let routedRefId: string | null = null;

  if (classified.kind === "rate_con") {
    if (opts?.rateConRouter) {
      try {
        const r = await opts.rateConRouter(msg, att);
        routedTo = "rate_con_extractor";
        routedRefId = r.extractionId;
      } catch (err) {
        routedTo = "rate_con_extractor_failed";
        classified.features.rateConError = err instanceof Error ? err.message : String(err);
      }
    } else {
      routedTo = "rate_con_extractor_unwired";
    }
  } else if (["pod", "bol", "coi", "msa", "rfp_workbook"].includes(classified.kind)) {
    routedTo = "stub";
  }

  return upsertAttachmentClassification({
    orgId: msg.orgId,
    messageId: msg.id,
    attachmentName: att.name,
    attachmentSize: att.size ?? null,
    contentType: att.contentType ?? null,
    kind: classified.kind,
    confidence: classified.confidence,
    routedTo,
    routedRefId,
    features: classified.features,
  });
}

/**
 * Live ingestion entry — classify + route every attachment on a message.
 */
export async function classifyAndRouteAttachments(
  msg: EmailMessage,
  attachments: AttachmentInput[],
  opts?: RouteOptions,
): Promise<number> {
  let count = 0;
  for (const att of attachments) {
    if (!att.name) continue;
    await routeAttachment(msg, att, opts);
    count += 1;
  }
  return count;
}
