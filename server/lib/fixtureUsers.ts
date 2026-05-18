/**
 * Fixture User Cleanup — operational-surface exclusion predicate.
 *
 * Task #1179 (FUC-P1-S1). Composes the two pre-existing pattern
 * sources (`fixtureMailboxes.ts` + `userRosterClassification.ts`)
 * with the durable lifecycle flags shipped in Task #1126 Phase 1.
 *
 * Use this helper to hide fixture / demo / quarantined / soft-deleted
 * / inactive users from operational dashboard surfaces (e.g. AM
 * Margin Metrics). NOT to be used in:
 *   - Customer Quotes / financial-uploads / leaderboards / NBA / RFP
 *     scheduler / Top Opportunities / `server/auth.ts` (historical
 *     attribution surfaces rely on the legacy "every user" view).
 *   - The default `GET /api/users` filter (that is governed by the
 *     `UserListFilter` chokepoint in `storage.getUsers`, Section
 *     1126.4-API, and the read-time junk filter in Section 1400).
 *
 * Pure — no DB calls, no side effects. Pattern sources are imported,
 * never duplicated, so the read-time view and the write-time
 * `assertNotFixtureEmail` guard cannot drift.
 *
 * See `docs/fixture-user-cleanup-contract.md`.
 */

import {
  FIXTURE_MAILBOX_DOMAINS,
  isFixtureMailboxAddress,
} from "./fixtureMailboxes";
import {
  JUNK_DOMAIN_SUFFIXES,
  SEED_NAME_PATTERNS,
} from "./userRosterClassification";

export interface FixtureUserInput {
  username?: string | null;
  name?: string | null;
  isFixture?: boolean | null;
  isDemo?: boolean | null;
  isQuarantined?: boolean | null;
  isServiceAccount?: boolean | null;
  isActive?: boolean | null;
  deletedAt?: Date | string | null;
}

export function isFixtureUser(u: FixtureUserInput | null | undefined): boolean {
  if (!u) return false;

  // Lifecycle flags (Task #1126 Phase 1).
  if (u.isFixture === true) return true;
  if (u.isDemo === true) return true;
  if (u.isQuarantined === true) return true;
  if (u.isServiceAccount === true) return true;
  if (u.isActive === false) return true;
  if (u.deletedAt != null && u.deletedAt !== "") return true;

  // Username / email pattern checks — composed from the two canonical
  // pattern sources. Lowercased once.
  const username = (u.username ?? "").toLowerCase().trim();
  if (username) {
    if (isFixtureMailboxAddress(username)) return true;
    if (JUNK_DOMAIN_SUFFIXES.some((s) => username.endsWith(s))) return true;
    if (SEED_NAME_PATTERNS.some((p) => p.test(username))) return true;
  }

  // Display-name seed pattern (catches `WQTest XXXXXX`-style synthetic
  // identities whose username also matches FIXTURE_MAILBOX_DOMAINS but
  // gives a second line of defense if the email column is empty).
  const name = (u.name ?? "").trim();
  if (name && SEED_NAME_PATTERNS.some((p) => p.test(name))) return true;

  return false;
}

// Re-export the composed pattern sources so the guardrail can assert
// the helper is built from them (no duplication).
export { FIXTURE_MAILBOX_DOMAINS, JUNK_DOMAIN_SUFFIXES, SEED_NAME_PATTERNS };
