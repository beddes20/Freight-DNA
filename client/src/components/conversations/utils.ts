export function stripHtmlToText(input: string | null): string {
  if (!input) return "";
  const noStyle = input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const noTags = noStyle.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

export function looksLikeHtml(input: string | null): boolean {
  if (!input) return false;
  return /<\/?(html|body|head|div|span|table|p|br|a|img|style|meta)\b/i.test(input);
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Compact "Apr 10, 9:14 AM" style — used in the Conversations list to show
// the actual email-activity time inline (Phase 1: stop lying about freshness).
// Drops the year because the row already shows a relative-time tooltip on
// hover for the full date+year.
export function formatShortDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── Display contract for thread title + preview (Task #940) ────────────────
//
// The Conversations list and detail pane previously fell back to raw provider
// conversation IDs (Outlook `AAQkAD…` tokens) whenever the per-thread message
// query was loading, errored, or returned a row with a null subject. Preview
// snippets also leaked "CAUTION: external email" banners and quoted-reply
// chains because we only ran an HTML-strip and a hard char slice.
//
// These two helpers are the single source of truth for what a thread's
// title and preview look like. They never return a provider/transport id,
// they normalize repeated reply/forward prefixes into one optional `Re:`,
// and they suppress common disclaimer/quoted-reply boilerplate from previews.

// "AAQkAD" is the prefix Microsoft Graph emits for Outlook conversation IDs;
// also covers the related "AAMkAD" message-id prefix sometimes substituted in.
const PROVIDER_ID_PREFIX_RE = /^(?:AA[QM]kAD|AQMkAD)/;

// Generic provider-ID shape: 30+ chars with no whitespace, made up entirely
// of base64url / token characters. Catches hashed thread keys and the long
// alphanumeric tokens other providers emit when no human subject is set.
const PROVIDER_ID_TOKEN_RE = /^[A-Za-z0-9+/=_\-]{30,}$/;

export function looksLikeProviderId(input: string | null | undefined): boolean {
  if (!input) return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (PROVIDER_ID_PREFIX_RE.test(trimmed)) return true;
  if (!/\s/.test(trimmed) && trimmed.length >= 30 && PROVIDER_ID_TOKEN_RE.test(trimmed)) return true;
  return false;
}

// Reply / forward prefixes we collapse into a single optional `Re:`.
// Covers EN (Re, Fw, Fwd), DE (Aw, Wg), SE/NO (Sv, Vs), NL (Antw, Antwoord).
const REPLY_PREFIX_RE = /^\s*(?:re|fw|fwd|aw|wg|sv|vs|antw(?:oord)?)\s*(?:\[\d+\])?\s*:\s*/i;

function normalizeSubject(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  let hadReplyPrefix = false;
  // Repeatedly strip Re:/Fw:/etc. (any combo, any depth) so "Re: Re: Fwd: foo"
  // collapses to a single leading "Re: foo". A forward-only chain still gets
  // a `Re:` because the rep is looking at it from an inbox perspective.
  while (REPLY_PREFIX_RE.test(s)) {
    hadReplyPrefix = true;
    s = s.replace(REPLY_PREFIX_RE, "");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return hadReplyPrefix ? `Re: ${s}` : s;
}

export function resolveThreadSubject({
  messages,
  threadHint,
}: {
  messages: Array<{ subject: string | null }> | null | undefined;
  threadHint?: string | null;
}): string {
  // Scan latest -> earliest for the first surviving non-empty, non-id subject.
  // Server returns messages in ascending chronological order, so the latest
  // is at the end of the array.
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = messages[i]?.subject;
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (looksLikeProviderId(trimmed)) continue;
      const normalized = normalizeSubject(trimmed);
      if (normalized) return normalized;
    }
  }
  // Fall back to a cheap hint (e.g. cached subject already on the thread row)
  // — but never accept an id-shaped hint, that's exactly what we're protecting
  // against here.
  if (threadHint) {
    const trimmed = threadHint.trim();
    if (trimmed && !looksLikeProviderId(trimmed)) {
      const normalized = normalizeSubject(trimmed);
      if (normalized) return normalized;
    }
  }
  return "(no subject)";
}

// Banner-style sentence patterns we strip from the *start* of a preview.
// These are the disclaimers IT teams prepend to externally-originated mail.
// Order: leading bracketed/labelled banner, then a follow-up "do not click…"
// line that often comes with it.
const BANNER_LINE_PATTERNS: RegExp[] = [
  // Bracketed labels: "[EXTERNAL]", "[CAUTION: External Email]", etc.
  /^\s*\[[^\]]*(?:caution|external|warning)[^\]]*\]\s*[:\-—]?\s*/i,
  // "CAUTION:" / "WARNING:" sentence
  /^\s*(?:caution|warning)\b[^.!?\n]*[.!?\n]\s*/i,
  // "EXTERNAL EMAIL" / "EXTERNAL SENDER" labels
  /^\s*external(?:\s+(?:email|sender|message))?\s*[:\-—]?[^.!?\n]*[.!?\n]\s*/i,
  // "This e-mail originated from outside…" / "This message came from an external sender…"
  /^\s*this (?:e-?mail|message|email) (?:originated|came|was sent|is)\s+(?:from\s+)?(?:outside|an?\s+external|external)[^.!?\n]*[.!?\n]\s*/i,
  // "Do not click links…" follow-on
  /^\s*do not click\b[^.!?\n]*[.!?\n]\s*/i,
];

function stripLeadingBanners(text: string): string {
  let s = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of BANNER_LINE_PATTERNS) {
      const next = s.replace(re, "");
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}

// Trim an Outlook-style "From: … Sent: …" header block plus everything after,
// or a Gmail/Apple-style "On <date>, … wrote:" tail. We always cut from the
// *earliest* match so we don't accidentally keep quoted boilerplate visible.
function stripQuotedReplyTail(text: string): string {
  const candidates: number[] = [];
  // Outlook: "From: ... Sent: ..." — these often share a line or appear on
  // adjacent lines. Match them as a pair so we don't trim a legitimate
  // sentence that just happens to start with "From:".
  const outlook = text.search(/\bfrom\s*:\s*[^\n]{1,200}\s+sent\s*:\s*/i);
  if (outlook >= 0) candidates.push(outlook);
  // "On Mon, Apr 5, 2025 at 9:14 AM John Doe <…> wrote:" and shorter variants.
  const onWrote = text.search(/\bon\b[^\n]{0,300}\bwrote\s*:\s*/i);
  if (onWrote >= 0) candidates.push(onWrote);
  // "-----Original Message-----" separator some clients use.
  const origMsg = text.search(/-{2,}\s*original message\s*-{2,}/i);
  if (origMsg >= 0) candidates.push(origMsg);
  if (candidates.length === 0) return text;
  return text.slice(0, Math.min(...candidates));
}

// Strip common confidentiality / legal-disclaimer footers that always live
// at the *end* of a body. We're aggressive here: once we see one of these
// trigger phrases we drop everything from that point to EOF.
const DISCLAIMER_FOOTER_PATTERNS: RegExp[] = [
  /this (?:e-?mail|message|communication)(?:\s+and\s+any\s+attachments)?\s+(?:is|are|may be)\s+(?:confidential|privileged|intended)[\s\S]*$/i,
  /confidentiality\s+notice\b[\s\S]*$/i,
  /if you (?:are|have received)[\s\S]{0,80}\bnot\b[\s\S]{0,80}intended recipient[\s\S]*$/i,
  /the information (?:contained|in this)[\s\S]{0,80}(?:e-?mail|message|transmission)[\s\S]{0,200}(?:confidential|privileged)[\s\S]*$/i,
  /this (?:e-?mail|message)[\s\S]{0,200}solely for the use of the intended recipient[\s\S]*$/i,
];

function stripDisclaimerFooter(text: string): string {
  let s = text;
  for (const re of DISCLAIMER_FOOTER_PATTERNS) {
    s = s.replace(re, "");
  }
  return s;
}

export function resolvePreviewSnippet(
  body: string | null | undefined,
  { maxChars = 120 }: { maxChars?: number } = {},
): string {
  const stripped = stripHtmlToText(body ?? "");
  if (!stripped) return "";
  // Order matters: strip the quoted-reply tail FIRST so anything inside the
  // quoted block (which may itself contain a banner or a disclaimer) goes
  // away in one shot. Then knock off leading banners and trailing footers
  // from what's left of the actual reply body.
  let s = stripQuotedReplyTail(stripped);
  s = stripLeadingBanners(s);
  s = stripDisclaimerFooter(s);
  s = s.replace(/\s+/g, " ").trim();
  // HTML-stripping inserts a space wherever a tag used to live, which
  // leaves stray spaces before sentence-final punctuation (e.g.
  // "<b>rate</b>?" -> "rate ?"). Pull punctuation back onto its word so the
  // preview reads naturally.
  s = s.replace(/\s+([.,;:!?])/g, "$1");
  if (s.length <= maxChars) return s;
  // Truncate on a word boundary when one is near the cap, otherwise hard-cut.
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxChars - 20 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s.,;:!\-]+$/, "")}…`;
}
