/**
 * Backfill (Task #722): Reconnect legacy `quote_reps` rows to their `users.id`.
 *
 * Many `quote_reps` rows have a NULL `user_id` because they were created from
 * inbound email signatures (see `quoteEmailIngestion.ts`) before the user
 * system existed or before the rep had logged in. Task #714 keeps unlinked
 * reps visible so historical attribution survives, but that means logistics
 * users who happen to appear in a `quote_reps` row still slip into the
 * Quote Opportunities pickers and rep ranking — even though their linked
 * user, if discovered, would be filtered out by the customer-facing role
 * gate (`isCustomerFacingQuoteRep`).
 *
 * This script does a one-time, idempotent backfill, scoped per organization:
 *   1. Match by email — `lower(quote_reps.email) = lower(users.username)`.
 *      `users.username` is the canonical email per repo convention
 *      (see emailResponseTimeAnalyticsService comments). Email match is the
 *      primary path because it is the most precise.
 *   2. Fall back to a normalized name match — only when the rep row has no
 *      email at all. We collapse whitespace, lowercase, and strip
 *      non-alphanumeric characters before comparing `quote_reps.name` to
 *      `users.name`.
 *   3. Both passes only update when the match is unambiguous (exactly one
 *      candidate user). Multiple matches are skipped and counted.
 *
 * Idempotent: only `quote_reps` rows where `user_id IS NULL` are touched, so
 * re-running is a no-op for previously linked rows.
 *
 * No `quote_reps` rows are deleted and no quote opportunities are reassigned
 * — the existing rep filter (`isCustomerFacingQuoteRep`) automatically hides
 * the newly linked rows whose linked user is non-customer-facing.
 *
 * Per-org summary is printed to stdout: linked count (by-email + by-name),
 * ambiguous-skipped count, still-unlinked count, and the count of newly
 * linked reps that resolve to a non-customer-facing role (i.e., the reps
 * that will now disappear from the Quote Opportunities pickers / ranking).
 *
 * Usage:
 *   # default — every org on the configured DATABASE_URL
 *   npx tsx scripts/backfill-quote-rep-user-links.ts
 *
 *   # one org only
 *   npx tsx scripts/backfill-quote-rep-user-links.ts \
 *     --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 *   # dry run — report what would change without writing
 *   npx tsx scripts/backfill-quote-rep-user-links.ts --dry-run
 *
 *   # against production
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/backfill-quote-rep-user-links.ts
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../server/storage";
import { organizations, quoteReps, users, type User } from "@shared/schema";
import { isCustomerFacingQuoteRep } from "@shared/quoteOpportunitiesRoles";

type OrgSummary = {
  orgId: string;
  scanned: number;
  linkedByEmail: number;
  linkedByName: number;
  ambiguousEmail: number;
  ambiguousName: number;
  stillUnlinked: number;
  nonCustomerFacingNewlyLinked: number;
};

type Args = { orgId: string | null; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let orgId: string | null = null;
  let dryRun = false;
  for (const a of argv.slice(2)) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    else if (a === "--dry-run" || a === "--dryRun") dryRun = true;
  }
  return { orgId, dryRun };
}

function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeEmail(s: string | null | undefined): string {
  if (!s) return "";
  return s.trim().toLowerCase();
}

function fmt(s: OrgSummary): string {
  return [
    `scanned=${s.scanned}`,
    `linkedByEmail=${s.linkedByEmail}`,
    `linkedByName=${s.linkedByName}`,
    `ambiguousEmail=${s.ambiguousEmail}`,
    `ambiguousName=${s.ambiguousName}`,
    `ambiguousSkipped=${s.ambiguousEmail + s.ambiguousName}`,
    `stillUnlinked=${s.stillUnlinked}`,
    `newlyLinkedNonCustomerFacing=${s.nonCustomerFacingNewlyLinked}`,
  ].join(" ");
}

async function backfillForOrg(orgId: string, dryRun: boolean): Promise<OrgSummary> {
  const summary: OrgSummary = {
    orgId,
    scanned: 0,
    linkedByEmail: 0,
    linkedByName: 0,
    ambiguousEmail: 0,
    ambiguousName: 0,
    stillUnlinked: 0,
    nonCustomerFacingNewlyLinked: 0,
  };

  // Pull all unlinked reps for this org.
  const unlinkedReps = await db
    .select({ id: quoteReps.id, name: quoteReps.name, email: quoteReps.email })
    .from(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), isNull(quoteReps.userId)));

  summary.scanned = unlinkedReps.length;
  if (unlinkedReps.length === 0) return summary;

  // Pull all users for this org once — small relative to quote_reps and lets
  // us do all matching in memory without N round trips per rep.
  const orgUsers: Pick<User, "id" | "username" | "name" | "role">[] = await db
    .select({ id: users.id, username: users.username, name: users.name, role: users.role })
    .from(users)
    .where(eq(users.organizationId, orgId));

  // Build lookup maps. A single normalized key may map to multiple users
  // (ambiguous) — we use arrays so we can detect that.
  const usersByEmail = new Map<string, typeof orgUsers>();
  const usersByName = new Map<string, typeof orgUsers>();
  for (const u of orgUsers) {
    const emailKey = normalizeEmail(u.username);
    if (emailKey) {
      const list = usersByEmail.get(emailKey) ?? [];
      list.push(u);
      usersByEmail.set(emailKey, list);
    }
    const nameKey = normalizeName(u.name);
    if (nameKey) {
      const list = usersByName.get(nameKey) ?? [];
      list.push(u);
      usersByName.set(nameKey, list);
    }
  }

  for (const rep of unlinkedReps) {
    const repEmail = normalizeEmail(rep.email);
    let matchedUser: (typeof orgUsers)[number] | null = null;
    let matchedBy: "email" | "name" | null = null;

    if (repEmail) {
      const candidates = usersByEmail.get(repEmail) ?? [];
      if (candidates.length === 1) {
        matchedUser = candidates[0];
        matchedBy = "email";
      } else if (candidates.length > 1) {
        summary.ambiguousEmail += 1;
      }
      // If email present but no user matches, do NOT fall back to name —
      // the email is a stronger signal of identity, and a name collision
      // between two real people is more likely than between two emails.
    } else {
      const repName = normalizeName(rep.name);
      if (repName) {
        const candidates = usersByName.get(repName) ?? [];
        if (candidates.length === 1) {
          matchedUser = candidates[0];
          matchedBy = "name";
        } else if (candidates.length > 1) {
          summary.ambiguousName += 1;
        }
      }
    }

    if (matchedUser && matchedBy) {
      if (!dryRun) {
        await db
          .update(quoteReps)
          .set({ userId: matchedUser.id })
          .where(eq(quoteReps.id, rep.id));
      }
      if (matchedBy === "email") summary.linkedByEmail += 1;
      else summary.linkedByName += 1;
      if (!isCustomerFacingQuoteRep(matchedUser.role)) {
        summary.nonCustomerFacingNewlyLinked += 1;
      }
    } else {
      summary.stillUnlinked += 1;
    }
  }

  return summary;
}

async function main() {
  const { orgId, dryRun } = parseArgs(process.argv);
  const tag = `[backfill-quote-rep-user-links${dryRun ? " DRY-RUN" : ""}]`;

  let orgIds: string[];
  if (orgId) {
    orgIds = [orgId];
  } else {
    const rows = await db.select({ id: organizations.id }).from(organizations);
    orgIds = rows.map((r) => r.id);
    console.log(`${tag} processing ${orgIds.length} org(s)`);
  }

  const totals: OrgSummary = {
    orgId: "TOTAL",
    scanned: 0,
    linkedByEmail: 0,
    linkedByName: 0,
    ambiguousEmail: 0,
    ambiguousName: 0,
    stillUnlinked: 0,
    nonCustomerFacingNewlyLinked: 0,
  };

  let hadOrgFailure = false;
  for (const id of orgIds) {
    try {
      const s = await backfillForOrg(id, dryRun);
      console.log(`${tag} org=${id} ${fmt(s)}`);
      totals.scanned += s.scanned;
      totals.linkedByEmail += s.linkedByEmail;
      totals.linkedByName += s.linkedByName;
      totals.ambiguousEmail += s.ambiguousEmail;
      totals.ambiguousName += s.ambiguousName;
      totals.stillUnlinked += s.stillUnlinked;
      totals.nonCustomerFacingNewlyLinked += s.nonCustomerFacingNewlyLinked;
    } catch (err) {
      hadOrgFailure = true;
      console.error(`${tag} org=${id} FAILED`, err);
    }
  }

  console.log(`${tag} totals ${fmt(totals)}`);
  // Exit non-zero if any per-org run failed so automation/CI surfaces the
  // partial failure instead of treating the run as fully successful.
  process.exit(hadOrgFailure ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-quote-rep-user-links] fatal", err);
  process.exit(1);
});
