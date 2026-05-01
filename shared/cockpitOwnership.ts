// Task #875 — Centralized "is this freight row mine?" predicate.
//
// Before this helper, the Available Freight cockpit had two parallel
// definitions of "mine":
//   1. Server-side KPI aggregates and "Total in queue" used per-row SQL
//      against ownerUserId / delegatedToUserId.
//   2. Client-side `applyCockpitFilters` and the local mine-only filter
//      used `it.owner?.id === currentUser.id` strict equality against a
//      single resolved owner id (delegatedToUserId ?? ownerUserId).
//
// That meant a freight row whose ownerUserId was Jared but which had been
// delegated to a load-mover would have `owner.id === lmId`, so when Jared
// selected "My freight today" the row evaporated even though the KPI strip
// counted it as one of his.
//
// Both sides now route through `isRowOwnedByUser` and look at every
// owner-shaped attribution we know about — owner id, delegated id,
// uploader id, approver id, and the resolved owner's email/username.

export interface ResolvedUserIdentity {
  id: string;
  emailLower: string | null;
  usernameLower: string | null;
}

// Per-row ownership envelope emitted by the cockpit server payload. We
// surface every user id we could plausibly attribute the row to AND the
// lowercased emails/usernames of the resolved users so the client can
// match against any of them. Callers SHOULD always go through
// `rowOwnerKeys` so legacy `owner.id` payloads keep working when
// `ownership` is missing (older response shape during a deploy window).
export interface CockpitRowOwnership {
  ids: string[];
  emails: string[];
}

function lower(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = String(value).trim().toLowerCase();
  return t.length > 0 ? t : null;
}

export function resolveUserIdentity(
  user:
    | {
        id?: string | null;
        username?: string | null;
        email?: string | null;
      }
    | null
    | undefined,
): ResolvedUserIdentity | null {
  if (!user || !user.id) return null;
  return {
    id: user.id,
    emailLower: lower(user.email),
    usernameLower: lower(user.username),
  };
}

// Collapse the ownership envelope (and the legacy `owner.id` field that
// pre-#875 payloads carried) into deduplicated id/email sets.
export function rowOwnerKeys(
  ownership: CockpitRowOwnership | null | undefined,
  legacyOwnerId?: string | null,
): { ids: Set<string>; emails: Set<string> } {
  const ids = new Set<string>();
  const emails = new Set<string>();
  if (legacyOwnerId) ids.add(legacyOwnerId);
  if (ownership) {
    for (const id of ownership.ids ?? []) {
      if (id) ids.add(id);
    }
    for (const e of ownership.emails ?? []) {
      const v = lower(e);
      if (v) emails.add(v);
    }
  }
  return { ids, emails };
}

export function isRowOwnedByUser(
  ownership: CockpitRowOwnership | null | undefined,
  identity: ResolvedUserIdentity | null,
  legacyOwnerId?: string | null,
): boolean {
  if (!identity) return false;
  const { ids, emails } = rowOwnerKeys(ownership, legacyOwnerId);
  if (ids.has(identity.id)) return true;
  if (identity.emailLower && emails.has(identity.emailLower)) return true;
  if (identity.usernameLower && emails.has(identity.usernameLower)) return true;
  return false;
}

// Build the server-side ownership envelope from the freight_opportunities
// row + a user-resolution callback. Callers (the cockpit endpoint) pass
// in a cached user lookup so we don't N+1 across the feed.
export interface OwnerShapedRow {
  ownerUserId?: string | null;
  delegatedToUserId?: string | null;
  createdById?: string | null;
  approvedById?: string | null;
}

export function buildRowOwnership(
  row: OwnerShapedRow,
  resolveUsername: (userId: string) => string | null | undefined,
): CockpitRowOwnership {
  const idCandidates = [
    row.ownerUserId,
    row.delegatedToUserId,
    row.createdById,
    row.approvedById,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const ids: string[] = [];
  const emails: string[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const id of idCandidates) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      ids.push(id);
    }
    const username = lower(resolveUsername(id));
    if (username && !seenEmails.has(username)) {
      seenEmails.add(username);
      emails.push(username);
    }
  }
  return { ids, emails };
}
