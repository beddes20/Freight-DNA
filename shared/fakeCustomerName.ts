// Phase A2 — obvious-fake customer-name detection.
//
// The Won Load Autopilot in `server/services/customerQuotes.ts` will silently
// auto-create a `companies` row using whatever string lives in
// `quote_customers.name`. That name is sometimes garbage parsed from an inbound
// email signature ("Thanks. BLAS Express Trucking"), the org's own brand
// ("Valuetruck"), or a leftover seed/test fixture. Once a fake company exists,
// every won quote on it spawns a freight opportunity that the LM has to triage
// even though no real customer is attached.
//
// This helper centralizes the "is this name obviously fake?" decision so:
//   1. producers can `if (isObviousFakeCustomerName(...).isFake) return null`
//      to refuse the auto-create, and
//   2. a one-shot strip script can use the same logic to clean up rows that
//      slipped through before the guard existed.
//
// Conservative on purpose: we only flag names a human would recognize as not a
// real customer at a glance. Carrier-name-as-customer misclassification (e.g.
// "Theeagle", "Kings Eagle") is a separate, harder problem handled by the
// email-pipeline disambiguation work and is intentionally NOT covered here.

export type ObviousFakeReason =
  | "test-prefix"
  | "self-reference"
  | "greeting-fragment"
  | "placeholder"
  | "too-short"
  | "blank";

export interface ObviousFakeResult {
  isFake: boolean;
  reason: ObviousFakeReason | null;
}

const OK: ObviousFakeResult = { isFake: false, reason: null };

const TEST_PREFIX_RX =
  /^(test|seed|demo|sample|fixture|example|fake|placeholder|foo|bar|baz|qux|tbd|tba|n\/a|na|none|unknown)\b/i;

const GREETING_FRAGMENT_RX =
  /^(thanks?|thx|regards?|cheers|sincerely|fwd|re|hi|hello|hey)[.!,:\s\-]/i;

const PLACEHOLDER_NAMES = new Set<string>([
  "unknown — needs review",
  "unknown - needs review",
  "needs review",
]);

function normalizeForCompare(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Returns whether `rawName` is an obviously-fake customer name and, if so,
 * which rule caught it. `orgBrand` (when supplied) is the brokerage's own
 * organization display name; if `rawName` normalizes to the same brand, it's
 * flagged as a self-reference (the org is not a customer of itself).
 */
export function isObviousFakeCustomerName(
  rawName: string | null | undefined,
  orgBrand?: string | null,
): ObviousFakeResult {
  if (rawName == null) return { isFake: true, reason: "blank" };
  const trimmed = String(rawName).trim();
  if (!trimmed) return { isFake: true, reason: "blank" };
  if (trimmed.length < 2) return { isFake: true, reason: "too-short" };

  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_NAMES.has(lower)) return { isFake: true, reason: "placeholder" };

  if (orgBrand && orgBrand.trim()) {
    const a = normalizeForCompare(trimmed);
    const b = normalizeForCompare(orgBrand);
    if (a && b && a === b) return { isFake: true, reason: "self-reference" };
  }

  if (TEST_PREFIX_RX.test(trimmed)) return { isFake: true, reason: "test-prefix" };
  if (GREETING_FRAGMENT_RX.test(trimmed)) return { isFake: true, reason: "greeting-fragment" };

  return OK;
}

/**
 * SQL fragments mirroring the JS rules above. Used by the one-shot strip
 * migration so the database-side scrub matches what the producer guard will
 * reject going forward. Keep these in lockstep with the regexes above.
 *
 * Each entry returns a boolean predicate against a column reference (e.g.
 * `companies.name`) and the reason label that should be recorded.
 */
export const FAKE_NAME_SQL_RULES: ReadonlyArray<{
  reason: ObviousFakeReason;
  predicate: (col: string, brandParam: string) => string;
}> = [
  {
    reason: "blank",
    predicate: (col) => `(${col} IS NULL OR btrim(${col}) = '')`,
  },
  {
    reason: "too-short",
    predicate: (col) => `(${col} IS NOT NULL AND char_length(btrim(${col})) < 2)`,
  },
  {
    reason: "placeholder",
    predicate: (col) =>
      `LOWER(btrim(${col})) IN ('unknown — needs review','unknown - needs review','needs review')`,
  },
  {
    reason: "self-reference",
    predicate: (col, brandParam) =>
      `(${brandParam} IS NOT NULL AND ${brandParam} <> '' ` +
      `AND regexp_replace(LOWER(${col}), '[^a-z0-9]', '', 'g') = ` +
      `regexp_replace(LOWER(${brandParam}), '[^a-z0-9]', '', 'g'))`,
  },
  {
    reason: "test-prefix",
    predicate: (col) =>
      `${col} ~* '^(test|seed|demo|sample|fixture|example|fake|placeholder|foo|bar|baz|qux|tbd|tba|n/a|na|none|unknown)\\M'`,
  },
  {
    reason: "greeting-fragment",
    predicate: (col) =>
      `${col} ~* '^(thanks?|thx|regards?|cheers|sincerely|fwd|re|hi|hello|hey)[.!,:[:space:]\\-]'`,
  },
];
