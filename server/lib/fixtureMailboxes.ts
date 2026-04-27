/**
 * Fixture mailbox detection — single source of truth.
 *
 * Background: the lane-work-queue test suite (and other tests) seed users
 * with addresses like `wq.test.{id}@example.com`. If those users get bulk-
 * enrolled into `monitored_mailboxes`, Microsoft Graph subscription
 * registration permanently fails (the addresses don't exist in any tenant)
 * and the Conversations Inbox shows "Webhook unhealthy" forever even though
 * every real mailbox is fine.
 *
 * We block these addresses at TWO points:
 *   1. POST + enroll-all routes in server/routes/monitoredMailboxes.ts —
 *      reject inserts at the boundary.
 *   2. Boot-time migration in server/runMigrations.ts — purge any historical
 *      pollution (idempotent).
 *
 * Both consumers MUST import from this module so the matcher can never drift
 * out of sync.
 *
 * The blocklist covers RFC 6761 / RFC 2606 reserved special-use domains plus
 * the well-known example.{com,org,net} subdomains. By RFC, **any subdomain**
 * of these reserved TLDs is also reserved (e.g. `foo.invalid`,
 * `bar.test`), so we suffix-match on `.<tld>` rather than `@<tld>`.
 */

/** Suffixes that mean "this address can never resolve in a real M365
 * tenant". Used by both route guards and boot purge. */
export const FIXTURE_MAILBOX_DOMAINS: ReadonlyArray<string> = [
  "@example.com",
  "@example.org",
  "@example.net",
  // RFC 6761 reserved special-use TLDs — match @x AND @anything.x
  "@invalid",
  ".invalid",
  "@localhost",
  ".localhost",
  "@test",
  ".test",
  "@example",
  ".example",
  // Common dev/CI overrides
  "@test.local",
  "@local.test",
];

/** SQL LIKE patterns mirroring FIXTURE_MAILBOX_DOMAINS for use in the
 * boot-time DELETE migration. Kept right next to the source list so they
 * cannot drift. */
export const FIXTURE_MAILBOX_LIKE_PATTERNS: ReadonlyArray<string> =
  FIXTURE_MAILBOX_DOMAINS.map(suffix => `%${suffix}`);

export function isFixtureMailboxAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase().trim();
  return FIXTURE_MAILBOX_DOMAINS.some(suffix => lower.endsWith(suffix));
}
