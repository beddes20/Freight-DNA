// Task #957 — shared/cockpitTeams unit tests.
//
// Pure-data module tests; no React, no DB. Run via vitest as part of the
// cockpit-hardening test bundle (or directly with `npx vitest run
// shared/__tests__/cockpitTeams.test.ts`).

import { describe, it, expect } from "vitest";
import {
  parseOwnerScopeTokens,
  serializeOwnerScopeTokens,
  isValidOwnerScopeToken,
  resolveOwnerScope,
  resolveDirectReports,
  resolveMyTeamUserIds,
  listCockpitTeams,
  getCockpitTeam,
} from "../cockpitTeams";

describe("parseOwnerScopeTokens", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseOwnerScopeTokens(null)).toEqual([]);
    expect(parseOwnerScopeTokens(undefined)).toEqual([]);
    expect(parseOwnerScopeTokens("")).toEqual([]);
    expect(parseOwnerScopeTokens("   ")).toEqual([]);
  });

  it("splits on commas, trims, and dedupes case-insensitively", () => {
    expect(parseOwnerScopeTokens("me,unassigned, me ,UNASSIGNED")).toEqual([
      "me",
      "unassigned",
    ]);
  });

  it("preserves order of first appearance", () => {
    expect(parseOwnerScopeTokens("team:northeast,me,team:northeast")).toEqual([
      "team:northeast",
      "me",
    ]);
  });
});

describe("serializeOwnerScopeTokens", () => {
  it("joins on comma and drops 'all'", () => {
    expect(serializeOwnerScopeTokens(["all"])).toBe("");
    expect(serializeOwnerScopeTokens(["me", "unassigned"])).toBe("me,unassigned");
    expect(serializeOwnerScopeTokens(["all", "me"])).toBe("me");
  });
});

describe("isValidOwnerScopeToken", () => {
  it("accepts the special aliases", () => {
    for (const t of ["all", "me", "my-team", "myteam", "unassigned"]) {
      expect(isValidOwnerScopeToken(t)).toBe(true);
    }
  });
  it("accepts team:<id>", () => {
    expect(isValidOwnerScopeToken("team:northeast")).toBe(true);
    expect(isValidOwnerScopeToken("team:")).toBe(false);
  });
  it("accepts plausible userIds and rejects junk", () => {
    expect(isValidOwnerScopeToken("user-1234")).toBe(true);
    expect(isValidOwnerScopeToken("ab")).toBe(false);
    expect(isValidOwnerScopeToken("with space")).toBe(false);
    expect(isValidOwnerScopeToken("with,comma")).toBe(false);
    expect(isValidOwnerScopeToken("")).toBe(false);
  });
});

describe("listCockpitTeams + getCockpitTeam (static roster)", () => {
  it("loads the four named teams", () => {
    const ids = listCockpitTeams().map((t) => t.id).sort();
    expect(ids).toEqual(["midwest", "northeast", "southeast", "west"]);
  });
  it("returns null for an unknown team id", () => {
    expect(getCockpitTeam("does-not-exist")).toBeNull();
  });
  it("returns the team for a known id", () => {
    const t = getCockpitTeam("northeast");
    expect(t?.name).toBe("Northeast");
  });
});

describe("resolveDirectReports + resolveMyTeamUserIds", () => {
  it("includes direct reports from the org chart", () => {
    const orgChart = [
      { id: "manager", managerId: null },
      { id: "rep1", managerId: "manager" },
      { id: "rep2", managerId: "manager" },
      { id: "rep3", managerId: "other" },
    ];
    expect(resolveDirectReports("manager", orgChart).sort()).toEqual([
      "rep1",
      "rep2",
    ]);
  });
  it("falls back to the team roster's managerId", () => {
    // No org chart provided — resolveMyTeamUserIds still includes the
    // current user himself.
    expect(resolveMyTeamUserIds("manager", null)).toEqual(["manager"]);
  });
  it("includes the manager themself in their team", () => {
    const orgChart = [
      { id: "manager", managerId: null },
      { id: "rep1", managerId: "manager" },
    ];
    const team = resolveMyTeamUserIds("manager", orgChart).sort();
    expect(team).toEqual(["manager", "rep1"]);
  });
});

describe("resolveOwnerScope", () => {
  it("returns isAll for an empty list", () => {
    const r = resolveOwnerScope([], "me-id", null);
    expect(r.isAll).toBe(true);
    expect(r.userIds.size).toBe(0);
    expect(r.includeUnassigned).toBe(false);
  });

  it("returns isAll if 'all' is anywhere in the list", () => {
    const r = resolveOwnerScope(["me", "all"], "me-id", null);
    expect(r.isAll).toBe(true);
  });

  it("expands 'me' to the current user", () => {
    const r = resolveOwnerScope(["me"], "me-id", null);
    expect(r.userIds.has("me-id")).toBe(true);
    expect(r.includeUnassigned).toBe(false);
  });

  it("expands 'my-team' to the current user + direct reports (org chart)", () => {
    const orgChart = [
      { id: "me-id", managerId: null },
      { id: "rep1", managerId: "me-id" },
      { id: "rep2", managerId: "me-id" },
    ];
    const r = resolveOwnerScope(["my-team"], "me-id", orgChart);
    expect(Array.from(r.userIds).sort()).toEqual(["me-id", "rep1", "rep2"]);
  });

  it("expands 'team:<id>' to the team's userIds", () => {
    // The default roster's teams are empty, so 'team:northeast' resolves
    // to no userIds — but isAll must be false.
    const r = resolveOwnerScope(["team:northeast"], "me-id", null);
    expect(r.isAll).toBe(false);
    expect(r.userIds.size).toBe(0);
    expect(r.includeUnassigned).toBe(false);
  });

  it("handles 'unassigned' alongside specific users (multi-select union)", () => {
    const r = resolveOwnerScope(["me", "unassigned"], "me-id", null);
    expect(r.isAll).toBe(false);
    expect(r.userIds.has("me-id")).toBe(true);
    expect(r.includeUnassigned).toBe(true);
  });

  it("ignores invalid tokens silently", () => {
    const r = resolveOwnerScope(["__nope__", "me"], "me-id", null);
    expect(r.userIds.has("me-id")).toBe(true);
    expect(r.tokens).toEqual(["me"]);
  });
});
