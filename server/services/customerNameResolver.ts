/**
 * Customer name resolver (Task #578).
 *
 * Replaces the naive "name from email domain" logic that produced "Gmail",
 * "Yahoo", "Outlook", etc. as customer names on the Customer Quotes
 * dashboard. Used by every quote ingestion path (email, TMS sync, manual
 * entry helpers) so the same business rules drive every customer row that
 * appears in the dashboard.
 *
 * Resolution order:
 *   1. Business-domain sender (anything not in FREE_MAIL_PROVIDERS) →
 *      cleaned, Title-Cased company derived from the domain root.
 *   2. Free-mail sender (gmail/yahoo/outlook/etc.):
 *      a. Company name extracted from the email subject + body
 *         (signature blocks, "on behalf of X", "<Company> Logistics", …).
 *         Person-name-only matches are rejected.
 *      b. The display name from the From header, if present and not equal
 *         to the local part of the email and not equal to the provider
 *         name itself.
 *      c. Falls back to UNKNOWN_CUSTOMER_NAME (single shared bucket per
 *         organization).
 *
 * Always trims, collapses whitespace, and caps the resulting name at
 * NAME_MAX_LENGTH characters so a runaway signature can't blow out the UI.
 */

export const UNKNOWN_CUSTOMER_NAME = "Unknown — needs review";
export const NAME_MAX_LENGTH = 80;

/**
 * Centralized free-mail provider list (case-insensitive). Any sender whose
 * email domain matches one of these is treated as a free-mail sender — the
 * domain root is meaningless as a business identifier so the resolver falls
 * through to subject/body extraction → display name → unknown bucket.
 */
export const FREE_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
  "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.us",
  "mail.com",
  "zoho.com",
]);

/**
 * Tokens that should keep their canonical capitalization when they appear
 * as a standalone token in a domain root (e.g. "abc-llc.com" →
 * "Abc LLC", not "Abc Llc"). Compared case-insensitively.
 */
const ACRONYM_TOKENS: Record<string, string> = {
  llc: "LLC",
  inc: "Inc",
  co: "Co",
  corp: "Corp",
  usa: "USA",
  us: "US",
  hq: "HQ",
};

const COMPANY_SUFFIX = "Logistics|Logistic|Transport|Transportation|Freight|Trucking|Carriers?|Express|Lines?|Shipping|Distribution|Group|Holdings|Enterprises|Industries|Foods|Brands|Solutions|Services|Supply|LLC|L\\.L\\.C\\.|Inc|Inc\\.|Incorporated|Corp|Corp\\.|Corporation|Co|Co\\.|Company|Ltd|Ltd\\.|Limited|LP|LLP|PLLC";

const COMPANY_SUFFIX_RE = new RegExp(`\\b(?:${COMPANY_SUFFIX})\\b`, "i");

// Task #597 — tokens that strongly imply a row is a CARRIER (truck/asset
// company), not a shipper/customer. Matched against the customer's name and
// the email-domain root used to create it. The "Logistics" / "Express"
// classification is intentionally fuzzy — Yes, some shippers have those
// words too — which is why the dashboard always shows a manual override
// button next to the auto-classification in the drawer.
const CARRIER_TOKEN = "Carrier|Carriers|Freight|Logistics|Logistic|Transport|Transportation|Trucking|Lines|Express|Haulage|Hauling|Cartage|Dispatch";
const CARRIER_TOKEN_RE = new RegExp(`\\b(?:${CARRIER_TOKEN})\\b`, "i");

/**
 * Heuristic classifier for a `quote_customers` row. Returns:
 *   "carrier"  — name OR email-domain root contains a carrier-suffix token
 *                ("Freight", "Logistics", "Trucking", etc.) OR the name
 *                appears in the org's `quote_carriers` table (passed in
 *                via `knownCarrierNames`, lowercased) OR the from-email's
 *                domain matches one of the org's known carrier email
 *                domains (passed in via `knownCarrierDomains`).
 *   "customer" — looks like a real shipper (no carrier signals) AND has a
 *                concrete name (not the placeholder UNKNOWN_CUSTOMER_NAME).
 *   "unknown"  — empty/whitespace name, the shared UNKNOWN_CUSTOMER_NAME
 *                bucket, OR a free-mail sender with no other signals.
 *
 * Auto-classification is conservative: when in doubt we emit "unknown" so
 * the row stays visible until a rep flips it manually from the drawer.
 */
export function classifyPartyType(input: {
  name?: string | null;
  fromEmail?: string | null;
  knownCarrierNames?: ReadonlySet<string>;
  knownCarrierDomains?: ReadonlySet<string>;
}): "customer" | "carrier" | "unknown" {
  const name = (input.name ?? "").trim();
  const lower = name.toLowerCase();
  if (input.knownCarrierNames && lower && input.knownCarrierNames.has(lower)) {
    return "carrier";
  }
  if (name && CARRIER_TOKEN_RE.test(name)) return "carrier";
  const from = parseFromHeader(input.fromEmail);
  if (from) {
    // Task #597 — domain-based carrier matching from the org's carriers
    // catalog wins over heuristics. This catches carriers whose company
    // names don't include a carrier-suffix token (e.g. "Acme Express LLC"
    // is obvious, "Patriot Holdings" is not — but we still know the domain).
    if (input.knownCarrierDomains && input.knownCarrierDomains.has(from.domain.toLowerCase())) {
      return "carrier";
    }
    if (!isFreeMailDomain(from.domain)) {
      const domainName = nameFromBusinessDomain(from.domain);
      if (domainName && CARRIER_TOKEN_RE.test(domainName)) return "carrier";
    }
  }
  // Task #597 — preserve the shared "Unknown — needs review" bucket.
  // Without this, the row would silently graduate to "customer" and the
  // dashboard's needs-review chip / Triage filter would lose its target.
  if (!name || lower === UNKNOWN_CUSTOMER_NAME.toLowerCase()) return "unknown";
  // Task #597 — when the only signal we have is a free-mail sender (gmail/
  // yahoo/etc.) AND the row name lacks a real company suffix, stay
  // conservative and emit "unknown". This avoids silently bucketing
  // free-mail-derived rows into the customer feed without evidence.
  if (from && isFreeMailDomain(from.domain) && !COMPANY_SUFFIX_RE.test(name)) {
    return "unknown";
  }
  return "customer";
}

// Up to 3 capitalized tokens followed by a company suffix on the SAME line
// (so "Marcus\nPatriot Haulers LLC" matches only "Patriot Haulers LLC", not
// the leading first-name).
const SIGNATURE_COMPANY_RE = new RegExp(
  `\\b((?:[A-Z][A-Za-z0-9&'.\\-]*[ \\t]+){0,3}[A-Z][A-Za-z0-9&'.\\-]*[ \\t]+(?:${COMPANY_SUFFIX}))\\b`,
  "g",
);

// "on behalf of X" — capture only the contiguous capitalized words after
// "of" (stops at the first lowercase token like "for"/"to"/"with"). The
// "on behalf of" prefix is matched case-insensitively but the capture group
// is case-sensitive — must NOT use the global `i` flag here or words like
// "for" / "and" would be treated as capitalized and absorbed.
const ON_BEHALF_RE = /\b[Oo][Nn]\s+[Bb][Ee][Hh][Aa][Ll][Ff]\s+[Oo][Ff]\s+((?:[A-Z][A-Za-z0-9&'.\-]*)(?:\s+[A-Z][A-Za-z0-9&'.\-]*)*)/g;

// Person-name shape: 2-3 capitalized words, optional middle initial.
// Used to *reject* signature matches that are clearly a human name with no
// company suffix attached.
const PERSON_NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){1,2}$/;

/** Strip embedded HTML tags and entities to a single-line plain string. */
function stripHtmlLite(html: string): string {
  if (!html) return "";
  let s = html;
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, "\n");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;|&#160;/gi, " ");
  s = s.replace(/&amp;/gi, "&");
  s = s.replace(/&lt;/gi, "<");
  s = s.replace(/&gt;/gi, ">");
  s = s.replace(/&quot;|&#34;/gi, '"');
  s = s.replace(/&(?:apos|#39);/gi, "'");
  return s;
}

function clean(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= NAME_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, NAME_MAX_LENGTH).trim();
}

function titleToken(token: string): string {
  if (!token) return token;
  const lower = token.toLowerCase();
  const acronym = ACRONYM_TOKENS[lower];
  if (acronym) return acronym;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

interface FromHeader {
  email: string;
  domain: string;
  localPart: string;
  displayName: string | null;
}

/**
 * Parse the canonical "Display Name <email@domain>" form OR a bare email.
 * Returns null when the input doesn't contain a usable email address.
 */
export function parseFromHeader(fromEmail: string | null | undefined): FromHeader | null {
  if (!fromEmail) return null;
  const trimmed = fromEmail.trim();
  if (!trimmed) return null;

  let email: string;
  let displayName: string | null = null;
  const m = trimmed.match(/^"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    email = m[2].trim().toLowerCase();
    const dn = m[1].trim().replace(/^['"]|['"]$/g, "").trim();
    displayName = dn || null;
  } else {
    email = trimmed.toLowerCase();
  }
  const at = email.indexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return {
    email,
    localPart: email.slice(0, at),
    domain: email.slice(at + 1),
    displayName,
  };
}

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return FREE_MAIL_PROVIDERS.has(domain.toLowerCase());
}

/**
 * Derive a display name from a business-domain root.
 *   "uzbfreight.com"          → "Uzbfreight"
 *   "northwest-logistics.com" → "Northwest Logistics"
 *   "abc.co.uk"               → "Abc"
 *   "abc-llc.com"             → "Abc LLC"
 */
export function nameFromBusinessDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length === 0) return "";
  let coreParts: string[];
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
    // ccTLD like ".co.uk" / ".com.au" — strip both trailing pieces.
    coreParts = parts.slice(0, -2);
  } else if (parts.length >= 2) {
    coreParts = parts.slice(0, -1);
  } else {
    coreParts = parts;
  }
  if (coreParts.length === 0) coreParts = parts.slice(0, 1);
  // Join multi-segment domains with "-" so they tokenize together.
  const core = coreParts.join("-");
  const tokens = core.split(/[.\-_]+/).filter(Boolean);
  return clean(tokens.map(titleToken).join(" "));
}

function looksLikePersonName(s: string): boolean {
  return PERSON_NAME_RE.test(s.trim());
}

function hasCompanySuffix(s: string): boolean {
  return COMPANY_SUFFIX_RE.test(s);
}

/**
 * Scan subject + body for a company name. Returns the first plausible
 * candidate or null.
 */
export function extractCompanyFromText(
  subject: string | null | undefined,
  body: string | null | undefined,
): string | null {
  const subjStr = (subject ?? "").trim();
  const bodyStr = stripHtmlLite(body ?? "");
  const haystack = `${subjStr}\n${bodyStr}`;
  if (!haystack.trim()) return null;

  // 1. "on behalf of X" — strongest signal.
  const obhMatches = Array.from(haystack.matchAll(ON_BEHALF_RE));
  for (const m of obhMatches) {
    const candidate = m[1].split(/[\n.,;]/)[0].trim();
    if (!candidate || candidate.length < 2) continue;
    if (looksLikePersonName(candidate) && !hasCompanySuffix(candidate)) continue;
    return clean(candidate);
  }

  // 2. Signature company-suffix patterns ("Acme Logistics", "Foo Freight LLC").
  const sigMatches = Array.from(haystack.matchAll(SIGNATURE_COMPANY_RE));
  for (const m of sigMatches) {
    const candidate = m[1].trim();
    if (!candidate) continue;
    if (looksLikePersonName(candidate)) continue;
    return clean(candidate);
  }

  return null;
}

export interface ResolvedCustomer {
  name: string;
  /**
   * "high"     — business domain
   * "medium"   — free-mail sender, name pulled from subject/body
   * "low"      — free-mail sender, name from From-header display name
   * "unknown"  — fell through to UNKNOWN_CUSTOMER_NAME bucket
   */
  confidence: "high" | "medium" | "low" | "unknown";
}

export interface ResolverInput {
  fromEmail?: string | null;
  /** Optional explicit display name (e.g. parsed from Graph payload). */
  fromName?: string | null;
  subject?: string | null;
  body?: string | null;
}

export function resolveCustomerName(input: ResolverInput): ResolvedCustomer {
  const from = parseFromHeader(input.fromEmail);
  if (!from) return { name: UNKNOWN_CUSTOMER_NAME, confidence: "unknown" };

  if (!isFreeMailDomain(from.domain)) {
    const name = nameFromBusinessDomain(from.domain);
    return { name: name || UNKNOWN_CUSTOMER_NAME, confidence: name ? "high" : "unknown" };
  }

  // Free-mail sender — fall through the resolver chain.
  const fromBody = extractCompanyFromText(input.subject, input.body);
  if (fromBody) return { name: fromBody, confidence: "medium" };

  const explicitDisplay = (input.fromName ?? "").trim();
  const headerDisplay = explicitDisplay || from.displayName || "";
  if (headerDisplay) {
    const dnLower = headerDisplay.toLowerCase();
    if (
      dnLower !== from.localPart &&
      dnLower !== from.email &&
      // Reject ANY free-mail provider name (full domain like "gmail.com" OR
      // bare provider root like "gmail"/"yahoo"/"outlook") regardless of
      // which provider the sender uses — otherwise a "Gmail" display name
      // on a yahoo.com sender (or vice versa) would leak the legacy bug
      // back into the dashboard.
      !FREE_MAIL_PROVIDERS.has(dnLower) &&
      !isLegacyFreeMailCustomerName(headerDisplay)
    ) {
      return { name: clean(headerDisplay), confidence: "low" };
    }
  }

  return { name: UNKNOWN_CUSTOMER_NAME, confidence: "unknown" };
}

/**
 * Returns true when `name` matches one of the bare free-mail provider names
 * the legacy `deriveCustomerName` produced (e.g. "Gmail", "Yahoo", "Mac",
 * "Pm"). Used by the backfill to detect rows that need re-resolving.
 */
export function isLegacyFreeMailCustomerName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  for (const provider of FREE_MAIL_PROVIDERS) {
    const root = provider.split(".")[0].toLowerCase();
    if (lower === root) return true;
  }
  return false;
}

/**
 * Task #753 — broader sibling of `isLegacyFreeMailCustomerName`. Returns
 * true for ANY string that's effectively a free-mail provider as a
 * customer name:
 *   - Bare provider root: "Gmail", "yahoo", "Outlook", "Mac", "Pm" …
 *   - Full provider domain: "gmail.com", "icloud.com", "Proton.me" …
 *   - Decorated provider: "Gmail Mail", "Yahoo Inc", "Hotmail.com LLC" …
 *
 * Used as the safety net at every customer-creation chokepoint
 * (`findOrCreateCustomer` for email ingestion, `createQuoteCustomer` for
 * manual entry) and by the broadened cleanup in
 * `backfillFreeMailCustomerNames`.
 */
export function isFreeMailProviderName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  // Direct full-domain hit ("gmail.com", "icloud.com", …).
  if (FREE_MAIL_PROVIDERS.has(lower)) return true;

  // Bare provider root ("gmail", "yahoo", "outlook", …).
  if (isLegacyFreeMailCustomerName(trimmed)) return true;

  // Decorated provider — strip generic suffix tokens ("mail", "com",
  // "inc", "llc", "corp", "co") and re-check the remainder. Catches
  // "Gmail Mail", "Yahoo Inc", "Outlook.com Co", etc. that the simpler
  // checks above would miss. The token list intentionally excludes
  // freight-business tokens ("logistics", "freight", "express", …) so
  // a real shipper named e.g. "Gmail Logistics" is NOT silently
  // rebucketed.
  const stripped = lower
    .replace(/[.,]/g, " ")
    .replace(/\b(mail|com|inc|llc|corp|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== lower) {
    if (FREE_MAIL_PROVIDERS.has(stripped)) return true;
    if (isLegacyFreeMailCustomerName(stripped)) return true;
  }

  return false;
}

/**
 * Task #753 — final safety net at every customer-creation chokepoint.
 * Returns the trimmed input, or the shared `UNKNOWN_CUSTOMER_NAME`
 * bucket when the input is empty or matches a free-mail provider name.
 *
 * Centralizes the "no provider names on the funnel" rule so every
 * ingestion path (email, manual entry, future bulk-import paths) lands
 * the same way without each call site having to remember the rule.
 */
export function sanitizeCustomerName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return UNKNOWN_CUSTOMER_NAME;
  if (isFreeMailProviderName(trimmed)) return UNKNOWN_CUSTOMER_NAME;
  return trimmed;
}
