/**
 * Task #752 — Freight Capture Rep Audit service.
 *
 * Backs the admin-only "Freight Capture rep audit" page. Surfaces every
 * `quote_reps` row that has at least one quote in a configurable lookback
 * window, with the metadata an admin needs to act on it: linked-user info,
 * suppression flag, quote count, last quote date, and a computed status
 * (OK / wrong role / unlinked / suppressed).
 *
 * Provides four mutating operations:
 *   - linkRepToUser    set or clear a rep's `user_id` (also updates email)
 *   - setRepSuppressed flip the admin-controlled suppression flag
 *   - mergeReps        reassign every quote from `sourceId` to `targetId`
 *                      and delete the source rep
 *
 * Every mutation is org-scoped — a rep that doesn't belong to the caller's
 * org returns `not_found` so a leaked id can't be operated on.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteOpportunities,
  quoteReps,
  users,
  type UserRole,
} from "@shared/schema";
import {
  classifyRepAuditStatus,
  type FunnelRepAuditStatus,
} from "@shared/quoteOpportunitiesRoles";

export const REP_AUDIT_LOOKBACK_DAYS = 90;

export type RepAuditRow = {
  repId: string;
  name: string;
  email: string | null;
  suppressed: boolean;
  linkedUserId: string | null;
  linkedUserName: string | null;
  linkedUserRole: UserRole | null;
  quoteCount: number;
  lastQuoteAt: string | null; // ISO
  status: FunnelRepAuditStatus;
};

export type RepAuditSummary = {
  total: number;
  ok: number;
  wrongRole: number;
  unlinked: number;
  suppressed: number;
};

export type RepAuditResult = {
  rows: RepAuditRow[];
  summary: RepAuditSummary;
  lookbackDays: number;
};

/**
 * Returns every rep that appears as the `repId` on at least one quote
 * within the lookback window, joined to the linked user (if any) and the
 * raw `quote_reps` row (for the suppression flag + email).
 */
export async function getFreightCaptureRepAudit(
  orgId: string,
  opts: { lookbackDays?: number } = {},
): Promise<RepAuditResult> {
  const lookbackDays = opts.lookbackDays ?? REP_AUDIT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

  // Aggregate rep-id usage from the quote_opportunities table in the window.
  const usage = await db
    .select({
      repId: quoteOpportunities.repId,
      quoteCount: sql<number>`COUNT(*)::int`.as("quote_count"),
      lastQuoteAt: sql<Date | null>`MAX(${quoteOpportunities.requestDate})`.as("last_quote_at"),
    })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      gte(quoteOpportunities.requestDate, since),
    ))
    .groupBy(quoteOpportunities.repId);

  // Filter out the "no rep on quote" bucket — the audit page only lists
  // reps the system has actually attributed.
  const repIds = usage
    .map(u => u.repId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (repIds.length === 0) {
    return {
      rows: [],
      summary: { total: 0, ok: 0, wrongRole: 0, unlinked: 0, suppressed: 0 },
      lookbackDays,
    };
  }

  // Pull the rep + linked user metadata. Org-scoped so a leaked rep id from
  // another org (theoretically impossible since `repId` came from this org's
  // quotes, but defense-in-depth) can't slip through.
  const repsJoined = await db
    .select({
      id: quoteReps.id,
      organizationId: quoteReps.organizationId,
      userId: quoteReps.userId,
      name: quoteReps.name,
      email: quoteReps.email,
      suppressed: quoteReps.suppressed,
      linkedUserId: users.id,
      linkedUserName: users.name,
      linkedUserRole: users.role,
    })
    .from(quoteReps)
    .leftJoin(users, eq(users.id, quoteReps.userId))
    .where(and(
      eq(quoteReps.organizationId, orgId),
      inArray(quoteReps.id, repIds),
    ));

  const usageById = new Map(usage.map(u => [u.repId ?? "", u]));

  const rows: RepAuditRow[] = repsJoined.map(r => {
    const u = usageById.get(r.id);
    const status = classifyRepAuditStatus({
      linkedUserRole: r.linkedUserRole,
      suppressed: r.suppressed,
      hasLinkedUser: r.linkedUserId !== null,
    });
    return {
      repId: r.id,
      name: r.name,
      email: r.email,
      suppressed: r.suppressed,
      linkedUserId: r.linkedUserId,
      linkedUserName: r.linkedUserName,
      linkedUserRole: r.linkedUserRole as UserRole | null,
      quoteCount: u ? Number(u.quoteCount) : 0,
      lastQuoteAt: u?.lastQuoteAt ? new Date(u.lastQuoteAt).toISOString() : null,
      status,
    };
  });

  // Sort: actionable items first (wrong_role, unlinked, suppressed) then OK,
  // descending by quote count within each bucket so the loudest offenders
  // are at the top of the list.
  const statusOrder: Record<FunnelRepAuditStatus, number> = {
    wrong_role: 0,
    unlinked: 1,
    suppressed: 2,
    ok: 3,
  };
  rows.sort((a, b) => {
    const sd = statusOrder[a.status] - statusOrder[b.status];
    if (sd !== 0) return sd;
    return b.quoteCount - a.quoteCount;
  });

  const summary: RepAuditSummary = {
    total: rows.length,
    ok: rows.filter(r => r.status === "ok").length,
    wrongRole: rows.filter(r => r.status === "wrong_role").length,
    unlinked: rows.filter(r => r.status === "unlinked").length,
    suppressed: rows.filter(r => r.status === "suppressed").length,
  };

  return { rows, summary, lookbackDays };
}

export type MutateResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

/**
 * Set or clear the linked user on a rep. Pass `userId: null` to unlink.
 * The linked user must belong to the caller's org. When linking, we also
 * copy the user's username (which is their email) onto the rep row so the
 * email column is consistent — admins typically link based on email match
 * and overwriting it removes a class of "rep with stale email" bugs.
 */
export async function linkRepToUser(
  orgId: string,
  repId: string,
  userId: string | null,
): Promise<MutateResult> {
  const [rep] = await db.select().from(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, repId)))
    .limit(1);
  if (!rep) return { status: "not_found" };

  if (userId === null) {
    await db.update(quoteReps)
      .set({ userId: null })
      .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, repId)));
    return { status: "ok" };
  }

  const [user] = await db.select({ id: users.id, username: users.username })
    .from(users)
    .where(and(eq(users.organizationId, orgId), eq(users.id, userId)))
    .limit(1);
  if (!user) return { status: "invalid", message: "User not found in this organization" };

  // Refuse to link two different reps to the same user — the rep list would
  // then double-count that person. The admin should merge instead.
  const [conflict] = await db.select({ id: quoteReps.id }).from(quoteReps)
    .where(and(
      eq(quoteReps.organizationId, orgId),
      eq(quoteReps.userId, userId),
    ))
    .limit(1);
  if (conflict && conflict.id !== repId) {
    return { status: "invalid", message: "Another rep is already linked to that user — merge instead" };
  }

  await db.update(quoteReps)
    .set({ userId, email: user.username })
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, repId)));
  return { status: "ok" };
}

export async function setRepSuppressed(
  orgId: string,
  repId: string,
  suppressed: boolean,
): Promise<MutateResult> {
  const result = await db.update(quoteReps)
    .set({ suppressed })
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, repId)))
    .returning({ id: quoteReps.id });
  if (result.length === 0) return { status: "not_found" };
  return { status: "ok" };
}

/**
 * Reassign every quote from `sourceRepId` to `targetRepId` and delete the
 * source. Both reps must be in the caller's org. Returns the count of
 * quotes reassigned so the UI can show "moved 47 quotes from X to Y".
 */
export async function mergeReps(
  orgId: string,
  sourceRepId: string,
  targetRepId: string,
): Promise<MutateResult & { reassigned?: number }> {
  if (sourceRepId === targetRepId) {
    return { status: "invalid", message: "Source and target must differ" };
  }

  const reps = await db.select().from(quoteReps)
    .where(and(
      eq(quoteReps.organizationId, orgId),
      inArray(quoteReps.id, [sourceRepId, targetRepId]),
    ));
  if (reps.length !== 2) return { status: "not_found" };

  // Reassign quotes, then delete the source rep. Drizzle in this codebase
  // doesn't expose a transaction helper everywhere, so we do this in two
  // steps; the worst case (delete fails after reassign) leaves the source
  // rep with zero quotes attributed, which is recoverable from the UI.
  const reassignedRows = await db.update(quoteOpportunities)
    .set({ repId: targetRepId })
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.repId, sourceRepId),
    ))
    .returning({ id: quoteOpportunities.id });

  await db.delete(quoteReps)
    .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.id, sourceRepId)));

  return { status: "ok", reassigned: reassignedRows.length };
}

/**
 * Lightweight user-search helper for the link-rep dropdown. Filters to
 * the caller's org and (optionally) by a name/email substring. Capped at
 * 50 results so the dropdown stays usable.
 */
export async function searchOrgUsers(
  orgId: string,
  query: string,
  limit = 50,
): Promise<Array<{ id: string; name: string; username: string; role: UserRole }>> {
  const q = query.trim().toLowerCase();
  const rows = await db.select({
    id: users.id,
    name: users.name,
    username: users.username,
    role: users.role,
  })
    .from(users)
    .where(eq(users.organizationId, orgId))
    .orderBy(desc(users.name));

  const filtered = q
    ? rows.filter(r =>
        (r.name ?? "").toLowerCase().includes(q)
        || (r.username ?? "").toLowerCase().includes(q),
      )
    : rows;
  return filtered.slice(0, limit) as Array<{ id: string; name: string; username: string; role: UserRole }>;
}
