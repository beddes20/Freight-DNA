/**
 * Signature Contact Parser — Task #1055 (Email→Exec 4)
 *
 * Deterministic, regex-only parser that extracts contact-shaped data from
 * the trailing signature block of an inbound email body:
 *   - name (Person Name shape, 2-3 capitalised tokens)
 *   - title (line containing a known job-title keyword)
 *   - phone (10-digit US-shaped pattern, first match)
 *   - mobile (second phone match flagged with mobile/cell label)
 *   - company (delegated to `extractCompanyFromText`)
 *
 * Contract:
 *   - Returns *null* fields rather than guesses. Callers MUST treat any
 *     null field as "no signal" and never fabricate.
 *   - Stateless and tenant-agnostic — string-in / fields-out only. The
 *     caller is responsible for cross-org / cross-tenant scoping when
 *     persisting.
 *   - Never throws. A malformed body collapses to all-nulls.
 *
 * Used by `signatureContactSweep.ts` to decide whether to enrich/create
 * a CRM contact under a known org+company.
 */

import { extractCompanyFromText } from "./customerNameResolver";

export interface ParsedSignature {
  name: string | null;
  title: string | null;
  phone: string | null;
  mobile: string | null;
  company: string | null;
  /**
   * Confidence floor used by the sweep helper to decide whether a
   * deterministic upsert is justified vs. a soft suggestion. "high" means
   * we have a person-shaped name AND at least one of (phone | title).
   * "medium" means name only, or phone-only with no name. "low" means we
   * pulled out fragments that could be junk. "none" means nothing usable.
   */
  confidence: "high" | "medium" | "low" | "none";
}

const NULL_RESULT: ParsedSignature = {
  name: null,
  title: null,
  phone: null,
  mobile: null,
  company: null,
  confidence: "none",
};

const SIGNATURE_BREAK_PATTERNS: RegExp[] = [
  /\n--\s*\n/,
  /\n_{3,}/,
  /\n-{3,}\n/,
  /\n(Best|Thanks|Thank you|Regards|Cheers|Sincerely|Best regards|Kind regards)[\s,!.]*\n/i,
  /\nSent from\b/i,
  /\nGet Outlook\b/i,
  /\nOn .{5,120}wrote:/,
  /\nFrom:\s*\S+@\S+/,
];

const PHONE_RE = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const PHONE_RE_GLOBAL = new RegExp(PHONE_RE.source, "g");
const MOBILE_LABEL_RE = /\b(m|mob|mobile|cell|c)\b\s*[:.\-]?/i;

const TITLE_KEYWORDS_RE =
  /\b(director|manager|vp|vice president|president|coordinator|analyst|specialist|associate|representative|rep|executive|lead|officer|head|chief|cfo|ceo|coo|cto|owner|founder|partner|principal|consultant|supervisor|controller|broker|dispatcher|planner|buyer|sourcing|procurement|logistics|supply chain|operations|operations manager|account manager|customer service)\b/i;

const PERSON_NAME_RE = /^[A-Z][a-zA-Z'\-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-zA-Z'\-]+){1,2}$/;

function stripHtml(raw: string): string {
  return raw
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'");
}

function isolateSignatureBlock(body: string): string {
  for (const pattern of SIGNATURE_BREAK_PATTERNS) {
    const idx = body.search(pattern);
    if (idx >= 0) return body.slice(idx);
  }
  // No explicit break — fall back to the last 8 non-empty lines.
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.slice(-8).join("\n");
}

function dedupePhone(raw: string): string {
  return raw.replace(/[^0-9+]/g, "");
}

function extractPhones(sigLines: string[]): { phone: string | null; mobile: string | null } {
  let phone: string | null = null;
  let mobile: string | null = null;
  const seen = new Set<string>();
  for (const line of sigLines) {
    const matches = line.match(PHONE_RE_GLOBAL);
    if (!matches) continue;
    const isMobileLine = MOBILE_LABEL_RE.test(line);
    for (const m of matches) {
      const norm = dedupePhone(m);
      if (norm.length < 10) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (isMobileLine && !mobile) {
        mobile = m.trim();
      } else if (!phone) {
        phone = m.trim();
      } else if (!mobile) {
        mobile = m.trim();
      }
    }
  }
  return { phone, mobile };
}

function extractTitle(sigLines: string[]): string | null {
  for (const line of sigLines) {
    if (line.includes("@")) continue;
    if (PHONE_RE.test(line)) continue;
    if (TITLE_KEYWORDS_RE.test(line)) {
      // Keep the line as-is, capped at 120 chars.
      return line.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return null;
}

function extractName(sigLines: string[], senderEmail: string): string | null {
  const localPart = senderEmail.split("@")[0]?.toLowerCase() ?? "";
  for (const line of sigLines) {
    const trimmed = line.trim();
    if (!PERSON_NAME_RE.test(trimmed)) continue;
    if (trimmed.includes("@") || trimmed.includes("http")) continue;
    if (PHONE_RE.test(trimmed)) continue;
    // Reject lines that obviously echo the email local part as a single
    // token (e.g. local "support" → display "Support Team").
    const lower = trimmed.toLowerCase();
    if (localPart && lower.replace(/\s+/g, "") === localPart) continue;
    return trimmed.slice(0, 80);
  }
  return null;
}

export function parseSignatureBlock(
  body: string | null | undefined,
  senderEmail: string,
  subject?: string | null,
): ParsedSignature {
  if (!body) return NULL_RESULT;
  const plain = stripHtml(body);
  if (!plain.trim()) return NULL_RESULT;

  const block = isolateSignatureBlock(plain);
  const sigLines = block
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 1 && l.length < 160)
    .slice(0, 14);

  const name = extractName(sigLines, senderEmail);
  const title = extractTitle(sigLines);
  const { phone, mobile } = extractPhones(sigLines);
  // Company extraction reuses the resolver so every ingestion path
  // produces the same canonical company name for the same input.
  const company = extractCompanyFromText(subject ?? null, block);

  let confidence: ParsedSignature["confidence"];
  if (name && (phone || title)) confidence = "high";
  else if (name || (phone && title)) confidence = "medium";
  else if (phone || title || company) confidence = "low";
  else confidence = "none";

  return { name, title, phone, mobile, company, confidence };
}
