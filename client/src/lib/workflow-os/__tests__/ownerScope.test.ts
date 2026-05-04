// Task #967 — canonical owner-scope grammar.
//
// These tests pin the wire-protocol vocabulary that every ops surface
// (AF, LWQ, Available Loads, Quotes, Conversations) shares. The grammar
// is the contract between URL params, server query strings, and saved
// views — so a regression here silently widens or narrows scope on the
// next page load and we never see it. The tests below cover the
// classifier predicates, the parser's normalisation rules, and the
// `ownerScopeMatches` predicate the server uses to gate row visibility.

import { describe, it, expect } from "vitest";
import {
  CANONICAL_OWNER_SCOPE_OPTIONS,
  isOwnerScopeAll,
  isOwnerScopeMe,
  isOwnerScopeSpecificUser,
  isOwnerScopeTeam,
  isOwnerScopeUnassigned,
  ownerScopeBaseLabel,
  ownerScopeMatches,
  ownerScopeTeamId,
  parseOwnerScope,
  serializeOwnerScope,
} from "../../../../../shared/workflowOs/ownerScope";

describe("ownerScope — canonical option set", () => {
  it("exposes the three baseline options every surface must support", () => {
    const tokens = CANONICAL_OWNER_SCOPE_OPTIONS.map(o => o.token);
    expect(tokens).toEqual(["all", "me", "unassigned"]);
  });

  it("renders surface-specific 'me' labels but shares all/unassigned copy", () => {
    expect(ownerScopeBaseLabel("all", "af")).toBe("All owners");
    expect(ownerScopeBaseLabel("all", "quotes")).toBe("All owners");
    expect(ownerScopeBaseLabel("unassigned", "lwq")).toBe("Unassigned");
    expect(ownerScopeBaseLabel("me", "af")).toBe("My freight");
    expect(ownerScopeBaseLabel("me", "lwq")).toBe("My lanes");
    expect(ownerScopeBaseLabel("me", "available_loads")).toBe("My loads");
    expect(ownerScopeBaseLabel("me", "quotes")).toBe("My quotes");
    expect(ownerScopeBaseLabel("me", "conversations")).toBe("My conversations");
  });
});

describe("ownerScope — token classifiers", () => {
  it("classifies the three canonical sentinels", () => {
    expect(isOwnerScopeAll("all")).toBe(true);
    expect(isOwnerScopeMe("me")).toBe(true);
    expect(isOwnerScopeUnassigned("unassigned")).toBe(true);
    expect(isOwnerScopeAll("me")).toBe(false);
    expect(isOwnerScopeMe("all")).toBe(false);
  });

  it("classifies team tokens and extracts their id", () => {
    expect(isOwnerScopeTeam("team:north")).toBe(true);
    expect(isOwnerScopeTeam("team:")).toBe(false); // missing id
    expect(isOwnerScopeTeam("user-123")).toBe(false);
    expect(ownerScopeTeamId("team:north")).toBe("north");
    expect(ownerScopeTeamId("user-123")).toBeNull();
  });

  it("classifies fall-through tokens as specific user ids", () => {
    expect(isOwnerScopeSpecificUser("user-123")).toBe(true);
    expect(isOwnerScopeSpecificUser("uuid-with-dashes-and-stuff")).toBe(true);
    expect(isOwnerScopeSpecificUser("all")).toBe(false);
    expect(isOwnerScopeSpecificUser("me")).toBe(false);
    expect(isOwnerScopeSpecificUser("unassigned")).toBe(false);
    expect(isOwnerScopeSpecificUser("team:north")).toBe(false);
    expect(isOwnerScopeSpecificUser("")).toBe(false);
  });
});

describe("ownerScope — parser/serializer", () => {
  it("treats null/empty/whitespace as ['all']", () => {
    expect(parseOwnerScope(null)).toEqual(["all"]);
    expect(parseOwnerScope(undefined)).toEqual(["all"]);
    expect(parseOwnerScope("")).toEqual(["all"]);
    expect(parseOwnerScope("   ")).toEqual(["all"]);
  });

  it("trims and dedups while preserving first-seen order", () => {
    expect(parseOwnerScope("me, team:north, me")).toEqual(["me", "team:north"]);
    expect(parseOwnerScope(" user-1 , user-2 , user-1 ")).toEqual(["user-1", "user-2"]);
  });

  it("drops malformed empty team tokens", () => {
    expect(parseOwnerScope("team:,user-1")).toEqual(["user-1"]);
    expect(parseOwnerScope("team:")).toEqual(["all"]); // nothing valid → safe default
  });

  it("collapses 'all' mixed with other tokens to ['all']", () => {
    expect(parseOwnerScope("me,all,team:north")).toEqual(["all"]);
    expect(parseOwnerScope("all,user-1")).toEqual(["all"]);
  });

  it("serializes back to a stable comma-joined wire form", () => {
    expect(serializeOwnerScope(["all"])).toBe(""); // default scope = empty url param
    expect(serializeOwnerScope([])).toBe("");
    expect(serializeOwnerScope(["me", "team:north"])).toBe("me,team:north");
    // round-trip applies the same dedup + 'all collapses everything' rules
    expect(serializeOwnerScope(["me", "all", "user-1"])).toBe("");
  });
});

describe("ownerScope — server predicate", () => {
  const teams = (id: string) => (id === "north" ? ["u-1", "u-2"] : []);

  it("returns true for an empty scope (defaults to 'all')", () => {
    expect(
      ownerScopeMatches({
        scope: [],
        currentUserId: "me-id",
        rowOwnerIds: ["someone"],
      }),
    ).toBe(true);
  });

  it("'all' always matches", () => {
    expect(
      ownerScopeMatches({
        scope: ["all"],
        currentUserId: "me-id",
        rowOwnerIds: [],
      }),
    ).toBe(true);
  });

  it("'me' matches when the requester appears in any owner column", () => {
    expect(
      ownerScopeMatches({
        scope: ["me"],
        currentUserId: "me-id",
        rowOwnerIds: ["someone-else", "me-id"],
      }),
    ).toBe(true);
    expect(
      ownerScopeMatches({
        scope: ["me"],
        currentUserId: "me-id",
        rowOwnerIds: ["someone-else"],
      }),
    ).toBe(false);
  });

  it("'unassigned' matches only when every owner column is empty", () => {
    expect(
      ownerScopeMatches({
        scope: ["unassigned"],
        currentUserId: "me-id",
        rowOwnerIds: [null, undefined, ""],
      }),
    ).toBe(true);
    expect(
      ownerScopeMatches({
        scope: ["unassigned"],
        currentUserId: "me-id",
        rowOwnerIds: ["someone"],
      }),
    ).toBe(false);
  });

  it("'team:<id>' resolves through the supplied membership lookup", () => {
    expect(
      ownerScopeMatches({
        scope: ["team:north"],
        currentUserId: "me-id",
        rowOwnerIds: ["u-2"],
        teamMembership: teams,
      }),
    ).toBe(true);
    expect(
      ownerScopeMatches({
        scope: ["team:south"],
        currentUserId: "me-id",
        rowOwnerIds: ["u-2"],
        teamMembership: teams,
      }),
    ).toBe(false);
  });

  it("'<userId>' matches when that id is on the row", () => {
    expect(
      ownerScopeMatches({
        scope: ["u-3"],
        currentUserId: "me-id",
        rowOwnerIds: ["u-3"],
      }),
    ).toBe(true);
    expect(
      ownerScopeMatches({
        scope: ["u-3"],
        currentUserId: "me-id",
        rowOwnerIds: ["u-4"],
      }),
    ).toBe(false);
  });

  it("union scope matches when any token matches", () => {
    expect(
      ownerScopeMatches({
        scope: ["me", "team:north"],
        currentUserId: "me-id",
        rowOwnerIds: ["u-1"],
        teamMembership: teams,
      }),
    ).toBe(true);
    expect(
      ownerScopeMatches({
        scope: ["me", "team:north"],
        currentUserId: "me-id",
        rowOwnerIds: ["unrelated"],
        teamMembership: teams,
      }),
    ).toBe(false);
  });
});
