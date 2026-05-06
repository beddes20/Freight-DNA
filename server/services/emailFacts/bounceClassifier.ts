/**
 * Email Intelligence v1.5 — Tier 1.1 bounce / DSN / OOO classifier (Task #943).
 *
 * Heuristic, deterministic, no LLM call. Looks at sender + subject + body of an
 * inbound message and produces zero or more `email_bounce_events` rows.
 *
 * - Hard / soft bounces are extracted from RFC 3464 DSN bodies (Status: 5.x.x
 *   = hard, 4.x.x = soft) AND from SMTP-style "address not found" prose in
 *   mailer-daemon messages.
 * - Out-of-office replies are detected via subject + body markers and any
 *   parsed "until <date>" phrasing populates `oooUntil`.
 * - "Other" auto-replies (vacation responders without a return date, generic
 *   "automatic reply" messages) get `auto_reply_other`.
 *
 * Affected recipient extraction:
 *   - For bounces, the failed recipient is read from the DSN body
 *     ("Final-Recipient: rfc822; jane@acme.com") or from `Original-Recipient`.
 *   - For OOO / auto-reply, the affected recipient is the message sender
 *     (the OOO reply IS from the dead/away inbox).
 */

import type { EmailMessage } from "@shared/schema";
import { upsertBounceEvent, getActiveBouncesForEmail } from "./emailFactsStorage";

const MAILER_DAEMON_SENDERS = [
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^microsoftexchange[^@]*@/i,
  /^bounce[^@]*@/i,
];

const BOUNCE_SUBJECT_MARKERS = [
  /^undeliverable[:\s]/i,
  /\bdelivery\s+status\s+notification\b/i,
  /\bmail\s+delivery\s+(failed|failure)\b/i,
  /\bdelivery\s+failure\b/i,
  /\breturned\s+mail\b/i,
];

const OOO_SUBJECT_MARKERS = [
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bautomatic\s+reply\b/i,
  /\bauto[-\s]?reply\b/i,
  /\bvacation\s+responder\b/i,
  /\bautoresponder\b/i,
];

const OOO_BODY_MARKERS = [
  /\bI(?:'m| am)\s+(?:currently\s+)?(?:out|away)\b/i,
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bon\s+(?:vacation|leave|pto|holiday)\b/i,
  /\bwill\s+(?:be\s+)?(?:back|return)/i,
];

const ALTERNATE_CONTACT_PATTERNS = [
  /(?:please|kindly)?\s*(?:contact|reach\s+out\s+to|email)\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)?)\s*(?:at|@|<)?\s*([\w.+-]+@[\w.-]+\.[a-z]{2,})/i,
  /(?:in\s+my\s+absence|while\s+I[' ]?m?\s+away|backup)[\s\S]{0,80}?([\w.+-]+@[\w.-]+\.[a-z]{2,})/i,
];

const SMTP_STATUS_RE = /\b(?:Status|status)\s*:\s*([245])\.(\d+)\.(\d+)/;
const HARD_BOUNCE_BODY_MARKERS = [
  /\baddress\s+(?:not\s+found|does\s+not\s+exist|rejected|unknown)\b/i,
  /\bno\s+such\s+(?:user|recipient|address|mailbox)\b/i,
  /\bunknown\s+(?:user|recipient)\b/i,
  /\buser\s+unknown\b/i,
  /\bmailbox\s+(?:unavailable|not\s+available|disabled)\b/i,
  /\brecipient\s+(?:address\s+)?rejected\b/i,
  /5\.\d\.\d/,
];
const SOFT_BOUNCE_BODY_MARKERS = [
  /\bmailbox\s+full\b/i,
  /\bquota\s+exceeded\b/i,
  /\btemporarily\s+(?:unavailable|deferred)\b/i,
  /\btry\s+again\s+later\b/i,
  /4\.\d\.\d/,
];

const FINAL_RECIPIENT_RE = /(?:Final-Recipient|Original-Recipient)\s*:\s*(?:rfc822\s*;\s*)?<?([\w.+-]+@[\w.-]+\.[a-z]{2,})>?/i;

const UNTIL_DATE_RE = /\buntil\s+(?:the\s+)?(?:end\s+of\s+)?(?:[A-Z][a-z]+(?:day)?,?\s+)?(\w+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|next\s+\w+|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

export interface ClassifiedBounce {
  bounceType: "hard_bounce" | "soft_bounce" | "auto_reply_ooo" | "auto_reply_other";
  contactEmail: string;
  diagnosticCode: string | null;
  oooUntil: Date | null;
  alternateContactEmail: string | null;
  alternateContactName: string | null;
}

/**
 * Pure classifier — given the message fields, return zero or more classifications.
 * Used by the live ingestion path AND by tests.
 */
export function classifyBounceFromMessage(input: {
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  body: string | null;
}): ClassifiedBounce[] {
  const from = (input.fromEmail || "").trim().toLowerCase();
  const subject = (input.subject || "").trim();
  const body = (input.body || "").trim();

  const isMailerDaemon = MAILER_DAEMON_SENDERS.some((re) => re.test(from));
  const isBounceSubject = BOUNCE_SUBJECT_MARKERS.some((re) => re.test(subject));
  const isOooSubject = OOO_SUBJECT_MARKERS.some((re) => re.test(subject));
  const hasOooBody = OOO_BODY_MARKERS.some((re) => re.test(body));

  // ── DSN / mailer-daemon path ──
  if (isMailerDaemon || isBounceSubject) {
    const failedRecipient = extractFailedRecipient(body) || input.toEmail;
    if (!failedRecipient) return [];

    const statusMatch = body.match(SMTP_STATUS_RE);
    let bounceType: "hard_bounce" | "soft_bounce" = "hard_bounce";
    let diagnosticCode: string | null = null;

    if (statusMatch) {
      diagnosticCode = `${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}`;
      bounceType = statusMatch[1] === "5" ? "hard_bounce" : "soft_bounce";
    } else if (HARD_BOUNCE_BODY_MARKERS.some((re) => re.test(body))) {
      bounceType = "hard_bounce";
    } else if (SOFT_BOUNCE_BODY_MARKERS.some((re) => re.test(body))) {
      bounceType = "soft_bounce";
    }

    return [{
      bounceType,
      contactEmail: failedRecipient.toLowerCase(),
      diagnosticCode,
      oooUntil: null,
      alternateContactEmail: null,
      alternateContactName: null,
    }];
  }

  // ── OOO path ──
  if (isOooSubject || hasOooBody) {
    if (!from) return [];

    const oooUntil = parseUntilDate(body);
    const alt = extractAlternateContact(body);
    const isExplicitOoo = isOooSubject || OOO_BODY_MARKERS.some((re) => re.test(body) && !/\bautomatic\s+reply\b/i.test(subject));
    const bounceType: "auto_reply_ooo" | "auto_reply_other" =
      isExplicitOoo ? "auto_reply_ooo" : "auto_reply_other";

    return [{
      bounceType,
      contactEmail: from,
      diagnosticCode: null,
      oooUntil,
      alternateContactEmail: alt?.email ?? null,
      alternateContactName: alt?.name ?? null,
    }];
  }

  return [];
}

function extractFailedRecipient(body: string): string | null {
  const m = body.match(FINAL_RECIPIENT_RE);
  if (m) return m[1].toLowerCase();
  // Fallback — common Microsoft Exchange form: "Recipients: jane@acme.com"
  const fallback = body.match(/Recipient[s]?:\s*<?([\w.+-]+@[\w.-]+\.[a-z]{2,})>?/i);
  return fallback ? fallback[1].toLowerCase() : null;
}

function extractAlternateContact(body: string): { email: string; name: string | null } | null {
  for (const pattern of ALTERNATE_CONTACT_PATTERNS) {
    const m = body.match(pattern);
    if (m) {
      const groups = m.slice(1);
      const email = groups.find((g) => g && g.includes("@"));
      const name = groups.find((g) => g && !g.includes("@") && /^[A-Z]/.test(g));
      if (email) return { email: email.toLowerCase(), name: name ?? null };
    }
  }
  return null;
}

function parseUntilDate(body: string): Date | null {
  const m = body.match(UNTIL_DATE_RE);
  if (!m) return null;
  const raw = m[1].trim();
  const now = new Date();
  // Weekday lookup
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const wd = weekdays.indexOf(raw.toLowerCase());
  if (wd >= 0) {
    const day = new Date(now);
    const diff = (wd + 7 - now.getDay()) % 7 || 7;
    day.setDate(now.getDate() + diff);
    return day;
  }
  if (/^tomorrow$/i.test(raw)) {
    const d = new Date(now); d.setDate(now.getDate() + 1); return d;
  }
  if (/^next\s+/i.test(raw)) {
    const word = raw.replace(/^next\s+/i, "").toLowerCase();
    const idx = weekdays.indexOf(word);
    if (idx >= 0) {
      const d = new Date(now);
      const diff = ((idx + 7 - now.getDay()) % 7) + 7;
      d.setDate(now.getDate() + diff);
      return d;
    }
  }
  // Try ISO / numeric / month-name parsing
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    // If no year was supplied and the parsed year is < this year, bump one year.
    if (!/\d{4}/.test(raw) && parsed.getFullYear() < now.getFullYear()) {
      parsed.setFullYear(now.getFullYear());
    }
    return parsed;
  }
  return null;
}

/**
 * Live ingestion entry point — classifies the message and persists rows.
 * Idempotent (the storage helper upserts on (message_id, contact_email)).
 */
export async function classifyAndPersistBounces(msg: EmailMessage): Promise<number> {
  if (msg.direction !== "inbound") return 0;
  const classifications = classifyBounceFromMessage({
    fromEmail: msg.fromEmail,
    toEmail: msg.toEmail,
    subject: msg.subject,
    body: msg.body,
  });
  if (classifications.length === 0) return 0;
  for (const c of classifications) {
    await upsertBounceEvent({
      orgId: msg.orgId,
      messageId: msg.id,
      contactEmail: c.contactEmail,
      contactId: null,
      bounceType: c.bounceType,
      diagnosticCode: c.diagnosticCode,
      oooUntil: c.oooUntil,
      alternateContactEmail: c.alternateContactEmail,
      alternateContactName: c.alternateContactName,
      rawHeaders: null,
    });
  }
  return classifications.length;
}

/**
 * Read-side: should automation be suppressed for this address?
 *   - Active hard bounce within the last 90 days → yes.
 *   - Active OOO whose oooUntil is in the future → yes.
 *   - Soft bounce alone → no (transient).
 */
export async function isContactSuppressed(orgId: string, email: string): Promise<{ suppressed: boolean; reason: string | null; activeUntil: Date | null }> {
  const events = await getActiveBouncesForEmail(orgId, email);
  if (events.length === 0) return { suppressed: false, reason: null, activeUntil: null };

  const now = Date.now();
  const NINETY_DAYS = 90 * 86400 * 1000;

  for (const e of events) {
    if (e.bounceType === "hard_bounce" && now - e.detectedAt.getTime() < NINETY_DAYS) {
      return { suppressed: true, reason: "hard_bounce", activeUntil: null };
    }
    if (e.bounceType === "auto_reply_ooo") {
      if (e.oooUntil && e.oooUntil.getTime() > now) {
        return { suppressed: true, reason: "ooo", activeUntil: e.oooUntil };
      }
      // Recent OOO (last 7 days) without a known return date — treat as OOO too.
      if (!e.oooUntil && now - e.detectedAt.getTime() < 7 * 86400 * 1000) {
        return { suppressed: true, reason: "ooo_no_return_date", activeUntil: null };
      }
    }
  }
  return { suppressed: false, reason: null, activeUntil: null };
}
