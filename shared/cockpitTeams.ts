// Task #957 — Available Freight cockpit "team" awareness.
//
// The cockpit owner combobox supports four kinds of selectable token:
//   • "me"            — the current user's owned rows (every owner-shape
//                       attribution the server stamped on the row).
//   • "my-team"       — the current user plus everyone reporting to them
//                       (resolved via users.managerId in the app DB OR a
//                       manager listed in the cockpitTeamMap).
//   • "team:<teamId>" — every user enumerated by the team in the operator-
//                       edited `shared/data/cockpitTeamMap.json` roster.
//   • "unassigned"    — rows whose ownership envelope is empty.
//   • <userId>        — a single specific dispatcher.
//
// The map lives in `shared/` so the server route, the client filter, and
// the bucket logic all see the same teams without a round-trip. Editing
// the JSON is the operator interaction — code never mutates it.

import teamMapJson from "./data/cockpitTeamMap.json";

export interface CockpitTeam {
  id: string;
  name: string;
  managerId: string | null;
  userIds: string[];
}

export interface CockpitTeamMap {
  teams: CockpitTeam[];
}

interface RawTeam {
  id?: unknown;
  name?: unknown;
  managerId?: unknown;
  userIds?: unknown;
}

interface RawTeamMap {
  teams?: unknown;
}

// Parse defensively so a malformed roster never wedges the cockpit. We
// drop teams that are missing an id/name and silently coerce non-string
// userIds out of the list.
function parseTeamMap(raw: unknown): CockpitTeamMap {
  const root = (raw ?? {}) as RawTeamMap;
  const teamsRaw = Array.isArray(root.teams) ? (root.teams as RawTeam[]) : [];
  const teams: CockpitTeam[] = [];
  const seen = new Set<string>();
  for (const t of teamsRaw) {
    if (!t || typeof t !== "object") continue;
    const id = typeof t.id === "string" ? t.id.trim() : "";
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const managerId = typeof t.managerId === "string" && t.managerId.length > 0 ? t.managerId : null;
    const userIds: string[] = Array.isArray(t.userIds)
      ? (t.userIds as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    teams.push({ id, name, managerId, userIds: Array.from(new Set(userIds)) });
  }
  return { teams };
}

const PARSED: CockpitTeamMap = parseTeamMap(teamMapJson);

export function getCockpitTeamMap(): CockpitTeamMap {
  return PARSED;
}

export function listCockpitTeams(): CockpitTeam[] {
  return PARSED.teams.slice();
}

export function getCockpitTeam(teamId: string): CockpitTeam | null {
  return PARSED.teams.find((t) => t.id === teamId) ?? null;
}

/**
 * Locate the cockpit team a given userId belongs to. Returns the first
 * team whose `userIds` (or `managerId`) contains the user, or `null` if
 * none does. Useful for surfaces that need to colour an owner badge by
 * team, or for `canAssignLane` to flag wrong-team picks. Pure lookup —
 * does not mutate the parsed roster.
 */
export function findCockpitTeamForUser(userId: string): CockpitTeam | null {
  if (!userId) return null;
  for (const team of PARSED.teams) {
    if (team.userIds.includes(userId)) return team;
    if (team.managerId === userId) return team;
  }
  return null;
}

// Direct-report lookup. Callers may pass an org-chart map (userId →
// managerId) when the app DB has authoritative manager assignments; the
// team roster's `managerId` is consulted as a fallback so a manager who
// doesn't yet have direct reports in the DB can still surface their team
// via the static roster.
export interface OrgChartUser {
  id: string;
  managerId?: string | null;
}

export function resolveDirectReports(
  managerUserId: string,
  orgChart: OrgChartUser[] | null | undefined,
): string[] {
  const reports = new Set<string>();
  if (orgChart) {
    for (const u of orgChart) {
      if (!u || typeof u.id !== "string") continue;
      if (u.managerId && u.managerId === managerUserId) {
        reports.add(u.id);
      }
    }
  }
  for (const team of PARSED.teams) {
    if (team.managerId && team.managerId === managerUserId) {
      for (const uid of team.userIds) reports.add(uid);
    }
  }
  return Array.from(reports);
}

// Resolve "my team" for the given user — the user themself plus every
// direct report. Callers who haven't loaded an org chart can pass null;
// we fall back to the static roster.
export function resolveMyTeamUserIds(
  currentUserId: string,
  orgChart: OrgChartUser[] | null | undefined,
): string[] {
  const ids = new Set<string>([currentUserId]);
  for (const r of resolveDirectReports(currentUserId, orgChart)) ids.add(r);
  return Array.from(ids);
}

// Token used in the multi-select owner combobox + ?ownerFilter URL param.
// Callers serialise to a comma-joined list (e.g. "me,unassigned,team:ne").
export type OwnerScopeToken = string;

export interface ResolvedOwnerScope {
  // Ids of specific users (incl. expanded team members and "me").
  // Empty when the only tokens are "unassigned" or no tokens at all.
  userIds: Set<string>;
  // Whether unassigned rows should be included.
  includeUnassigned: boolean;
  // True when no narrowing tokens are present (everyone).
  isAll: boolean;
  // Echoed input for diagnostics.
  tokens: OwnerScopeToken[];
}

// Task #971 — `am_book` is the canonical "rows whose customer is in the
// rep's book of business" token. AF needs it for the AM Book filter to
// match Available Loads + Carrier Intelligence. The token is recognised
// here so it round-trips through parseOwnerScopeTokens; resolution to a
// row predicate happens in the consuming route (the resolver needs the
// async `getCompaniesByNames` lookup which doesn't belong in shared/).
const SPECIAL_TOKENS = new Set(["all", "me", "my-team", "myteam", "unassigned", "am_book"]);

// Convenience predicate so callers don't need to remember the token spelling.
export function hasAmBookToken(tokens: OwnerScopeToken[]): boolean {
  return tokens.some((t) => t.toLowerCase() === "am_book");
}

export function parseOwnerScopeTokens(raw: string | null | undefined): OwnerScopeToken[] {
  if (raw === null || raw === undefined) return [];
  const parts = String(raw)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const out: OwnerScopeToken[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function serializeOwnerScopeTokens(tokens: OwnerScopeToken[]): string {
  // "all" or empty → empty string (the URL omits the param).
  const filtered = tokens.filter((t) => t.toLowerCase() !== "all");
  return filtered.join(",");
}

// Validate that a single token is one we know how to handle. Anything that
// isn't a special alias / "team:<id>" / plausible userId is rejected so a
// stray query-string param can't drive the route off-grammar.
export function isValidOwnerScopeToken(token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const lower = token.toLowerCase();
  if (SPECIAL_TOKENS.has(lower)) return true;
  if (lower.startsWith("team:")) return lower.length > "team:".length;
  // Plausible userId — same shape the legacy single-select route accepted.
  return /^[A-Za-z0-9_-]{4,64}$/.test(token);
}

export function resolveOwnerScope(
  tokens: OwnerScopeToken[],
  currentUserId: string | null | undefined,
  orgChart: OrgChartUser[] | null | undefined,
): ResolvedOwnerScope {
  const userIds = new Set<string>();
  let includeUnassigned = false;
  // "all" alone OR empty token list means "no narrowing".
  const filtered: OwnerScopeToken[] = [];
  for (const tok of tokens) {
    if (!isValidOwnerScopeToken(tok)) continue;
    filtered.push(tok);
  }
  if (filtered.length === 0 || filtered.some((t) => t.toLowerCase() === "all")) {
    return { userIds, includeUnassigned: false, isAll: true, tokens: filtered };
  }
  for (const tok of filtered) {
    const lower = tok.toLowerCase();
    if (lower === "me") {
      if (currentUserId) userIds.add(currentUserId);
      continue;
    }
    if (lower === "my-team" || lower === "myteam") {
      if (currentUserId) {
        for (const uid of resolveMyTeamUserIds(currentUserId, orgChart)) {
          userIds.add(uid);
        }
      }
      continue;
    }
    if (lower === "unassigned") {
      includeUnassigned = true;
      continue;
    }
    if (lower.startsWith("team:")) {
      const teamId = tok.slice("team:".length);
      const team = getCockpitTeam(teamId);
      if (team) {
        for (const uid of team.userIds) userIds.add(uid);
      }
      continue;
    }
    if (lower === "am_book") {
      // Task #971 — am_book needs an async company-resolver lookup that
      // doesn't belong in shared/. The consuming route detects am_book
      // via `hasAmBookToken(tokens)` and applies its own predicate after
      // the userIds-based filter; here we just keep am_book out of the
      // userIds set so it never accidentally matches a literal user id.
      continue;
    }
    // Specific userId.
    userIds.add(tok);
  }
  return { userIds, includeUnassigned, isAll: false, tokens: filtered };
}
