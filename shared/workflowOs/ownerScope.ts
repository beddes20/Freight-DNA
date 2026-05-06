// Workflow OS — canonical owner-scope vocabulary (Task #967).
//
// Every ops surface (Available Freight, Lane Work Queue, Available Loads,
// Customer Quotes, Conversations) needs to answer the same question:
// "whose work is this row?". Today each tab encodes that grammar slightly
// differently:
//
//   • AF / LWQ / Available Loads  →  `me` | `team:<id>` | `unassigned`
//                                    | `<userId>` | `all`
//                                    (multi-token; comma-joined)
//   • Customer Quotes              → `mineOnly` boolean (a special-case
//                                    of `me`)
//   • Conversations                → `mine` bucket + `team:<id>` /
//                                    specific-rep filter
//
// This module is the single source of truth for the *wire-protocol*
// grammar — the value that goes in a URL param, server query string, or
// saved-view JSON. It exists alongside the older `OwnerFilterValue` in
// `shared/workflowOs/ownership.ts` (which the AF/LWQ/AL `OwnerFilterSelect`
// already uses) — that type stays as the front-end render contract for
// those three surfaces. New surfaces (and the eventual cross-surface
// migration in #968 / #969) consume this module so the parser, serializer
// and option set match exactly across every tab.
//
// Backwards-compatibility note: existing surfaces continue to ship their
// own picker — this module DOES NOT replace `OwnerFilterSelect`. The
// future `<OwnerScopePicker />` (in `client/src/components/workflow-os/`)
// is the recommended choice for *new* surfaces; the audit in #918's
// follow-up will migrate the existing ones.

/**
 * Canonical token shapes accepted by the owner-scope grammar. Always a
 * flat string so it round-trips cleanly through URL params, JSON, and
 * SQL.
 *
 *   "all"            → no scope filter
 *   "me"             → rows owned by the requesting user
 *   "unassigned"     → rows whose ownership envelope is empty
 *   "team:<teamId>"  → rows owned by any user in that team (managed via
 *                       `shared/data/cockpitTeamMap.json`)
 *   "<userId>"       → a single specific user
 *
 * Multiple tokens may be combined for tabs that allow union scopes
 * (e.g. AF lets "me" + a teammate at the same time). Tabs that only
 * allow a single token (Customer Quotes today, Conversations) call the
 * single-value helpers below.
 */
export type OwnerScopeToken =
  | "all"
  | "me"
  | "unassigned"
  | `team:${string}`
  | string; // userId fallback

export const CANONICAL_OWNER_SCOPE_OPTIONS = [
  { token: "all",        labelKey: "all" as const,        testId: "owner-scope-all" },
  { token: "me",         labelKey: "me" as const,         testId: "owner-scope-me" },
  { token: "unassigned", labelKey: "unassigned" as const, testId: "owner-scope-unassigned" },
] as const;

export type OwnerScopeBaseLabelKey =
  (typeof CANONICAL_OWNER_SCOPE_OPTIONS)[number]["labelKey"];

/**
 * Surface vocabulary — only the "me" label varies per surface (e.g.
 * "My freight" vs "My quotes"). Every other base label is shared.
 */
export type OwnerScopeSurface =
  | "af"
  | "lwq"
  | "available_loads"
  | "quotes"
  | "conversations";

const ME_LABEL_BY_SURFACE: Record<OwnerScopeSurface, string> = {
  af: "My freight",
  lwq: "My lanes",
  available_loads: "My loads",
  quotes: "My quotes",
  conversations: "My conversations",
};

export function ownerScopeBaseLabel(
  key: OwnerScopeBaseLabelKey,
  surface: OwnerScopeSurface,
): string {
  switch (key) {
    case "all":         return "All owners";
    case "me":          return ME_LABEL_BY_SURFACE[surface];
    case "unassigned":  return "Unassigned";
  }
}

/** True for the literal "all" sentinel. */
export function isOwnerScopeAll(token: OwnerScopeToken): boolean {
  return token === "all";
}

/** True for the literal "me" sentinel. */
export function isOwnerScopeMe(token: OwnerScopeToken): boolean {
  return token === "me";
}

/** True for the literal "unassigned" sentinel. */
export function isOwnerScopeUnassigned(token: OwnerScopeToken): boolean {
  return token === "unassigned";
}

/** True for any `team:<id>` token. */
export function isOwnerScopeTeam(token: OwnerScopeToken): boolean {
  return typeof token === "string" && token.startsWith("team:") && token.length > "team:".length;
}

/** Extract `<id>` from a `team:<id>` token, or null if not a team token. */
export function ownerScopeTeamId(token: OwnerScopeToken): string | null {
  if (!isOwnerScopeTeam(token)) return null;
  return token.slice("team:".length);
}

/**
 * Anything else (after canonical / team filtering) is treated as a
 * specific user id. We don't validate the shape of the id here — the
 * caller knows what their org's user ids look like (uuid, snowflake,
 * etc.). An empty string is rejected to avoid silently widening scope
 * when a UI element forgets to clear its value.
 */
export function isOwnerScopeSpecificUser(token: OwnerScopeToken): boolean {
  if (!token || typeof token !== "string") return false;
  if (
    token === "all" ||
    token === "me" ||
    token === "unassigned" ||
    token.startsWith("team:")
  ) {
    return false;
  }
  return token.length > 0;
}

/**
 * Parse a comma-separated owner-scope string from a URL param into a
 * normalised token list. Empty/whitespace tokens are dropped. Duplicates
 * are dedup-ed (preserving first-seen order). Leading/trailing whitespace
 * is trimmed. Unknown shapes pass through as user-id tokens — the caller
 * decides whether to validate the id against an org user list.
 *
 * Returns ["all"] when input is null/empty or every token is rejected,
 * because "no filter" is the safest default and matches the URL-absent
 * case across every existing surface.
 */
export function parseOwnerScope(raw: string | null | undefined): OwnerScopeToken[] {
  if (raw == null) return ["all"];
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return ["all"];
  const seen = new Set<string>();
  const out: OwnerScopeToken[] = [];
  for (const part of trimmed.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    // Reject obviously-malformed team tokens (`team:` with no id).
    if (t === "team:") continue;
    seen.add(t);
    out.push(t);
  }
  if (out.length === 0) return ["all"];
  // "all" mixed with other tokens collapses to ["all"] — the broader
  // scope wins, matching the expectation that selecting "All owners"
  // clears every other selection.
  if (out.includes("all")) return ["all"];
  return out;
}

/**
 * Inverse of `parseOwnerScope`. Always returns a stable, comma-joined
 * string suitable for URL params and saved-view JSON. The "all" token
 * is serialized as the empty string so the URL stays clean for the
 * default scope (matches what every existing surface already does
 * through ad-hoc code).
 */
export function serializeOwnerScope(tokens: ReadonlyArray<OwnerScopeToken>): string {
  if (!tokens || tokens.length === 0) return "";
  // Re-parse to apply the same dedup + "all collapses everything" rules
  // so callers can't accidentally serialize an inconsistent state.
  const parsed = parseOwnerScope(tokens.join(","));
  if (parsed.length === 1 && parsed[0] === "all") return "";
  return parsed.join(",");
}

/**
 * Predicate the *server* uses to decide whether a row matches the
 * supplied scope. Pure function over identity tokens — keeps the
 * grammar identical wherever it's evaluated. Surface-specific
 * predicates (e.g. AM-book widening) layer on top of this.
 *
 * `currentUserId` is the requester. `rowOwnerIds` is the union of every
 * ownership-shaped column on the row (ownerUserId, delegatedToUserId,
 * customer.assignedTo, … depending on the surface). `teamMembership`
 * resolves a `team:<id>` token to the set of user ids in that team —
 * leave undefined when the surface doesn't yet support teams.
 */
export function ownerScopeMatches(args: {
  scope: ReadonlyArray<OwnerScopeToken>;
  currentUserId: string | null | undefined;
  rowOwnerIds: ReadonlyArray<string | null | undefined>;
  teamMembership?: (teamId: string) => ReadonlyArray<string>;
}): boolean {
  const tokens = args.scope.length > 0 ? args.scope : ["all"];
  if (tokens.includes("all")) return true;
  const owners = new Set(
    args.rowOwnerIds.filter((x): x is string => typeof x === "string" && x.length > 0),
  );
  for (const t of tokens) {
    if (t === "me") {
      if (args.currentUserId && owners.has(args.currentUserId)) return true;
      continue;
    }
    if (t === "unassigned") {
      if (owners.size === 0) return true;
      continue;
    }
    if (isOwnerScopeTeam(t)) {
      const teamId = ownerScopeTeamId(t)!;
      const members = args.teamMembership?.(teamId) ?? [];
      for (const m of members) if (owners.has(m)) return true;
      continue;
    }
    if (isOwnerScopeSpecificUser(t)) {
      if (owners.has(t)) return true;
      continue;
    }
  }
  return false;
}
