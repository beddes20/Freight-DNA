/**
 * Unit tests for the role helpers in server/lib/roles.ts.
 *
 * The role taxonomy is the single most-leaned-on access-control primitive
 * in the codebase. Two helpers in particular were added in this round
 * (`canEditOtherUsers`, `isAdminOrDirector`) to absorb compound role
 * checks that were inlined in routes.ts; both have non-obvious "WHY this
 * specific set" semantics that we want pinned.
 */

import { describe, it, expect } from "vitest";
import {
  isAdmin,
  isLeadership,
  isSalesRep,
  isAccountSide,
  isLogistics,
  isManagerial,
  canReassignAccounts,
  canAccessAiCenter,
  canEditOtherUsers,
  isAdminOrDirector,
} from "../lib/roles";

const u = (role: string | null | undefined) => ({ role: role as any });

const ALL_ROLES = [
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "sales",
  "account_manager",
  "logistics_manager",
  "logistics_coordinator",
];

describe("role helpers — null/undefined safety", () => {
  it("every helper returns false for null user", () => {
    expect(isAdmin(null)).toBe(false);
    expect(isLeadership(null)).toBe(false);
    expect(isSalesRep(null)).toBe(false);
    expect(isAccountSide(null)).toBe(false);
    expect(isLogistics(null)).toBe(false);
    expect(isManagerial(null)).toBe(false);
    expect(canReassignAccounts(null)).toBe(false);
    expect(canAccessAiCenter(null)).toBe(false);
    expect(canEditOtherUsers(null)).toBe(false);
    expect(isAdminOrDirector(null)).toBe(false);
  });

  it("every helper returns false for undefined user", () => {
    expect(canEditOtherUsers(undefined)).toBe(false);
    expect(isAdminOrDirector(undefined)).toBe(false);
  });

  it("every helper returns false for user with no role", () => {
    expect(canEditOtherUsers(u(null))).toBe(false);
    expect(canEditOtherUsers(u(undefined))).toBe(false);
    expect(isAdminOrDirector(u(null))).toBe(false);
  });
});

describe("canEditOtherUsers — locks in the 5-role set", () => {
  // The original inline check at routes.ts:1006 admitted exactly:
  //   admin, director, national_account_manager, sales, sales_director
  // Anything else (account_manager, logistics_*) is denied. This test
  // pins that set so a future refactor can't silently widen it.
  const ALLOWED = new Set([
    "admin",
    "director",
    "national_account_manager",
    "sales",
    "sales_director",
  ]);

  it.each(ALL_ROLES)("role=%s matches the original inline rule", (role) => {
    expect(canEditOtherUsers(u(role))).toBe(ALLOWED.has(role));
  });

  it("denies a fabricated/unknown role", () => {
    expect(canEditOtherUsers(u("intern"))).toBe(false);
    expect(canEditOtherUsers(u(""))).toBe(false);
  });
});

describe("isAdminOrDirector — admin OR director, NOT sales_director", () => {
  // The original inline check at routes.ts:6090 (internal_post attachment
  // gate) intentionally EXCLUDED sales_director. This test pins that
  // exclusion so nobody "fixes" it by reaching for isLeadership.
  it("admits admin", () => expect(isAdminOrDirector(u("admin"))).toBe(true));
  it("admits director", () => expect(isAdminOrDirector(u("director"))).toBe(true));
  it("REJECTS sales_director (intentional)", () =>
    expect(isAdminOrDirector(u("sales_director"))).toBe(false));
  it("rejects everyone else", () => {
    for (const r of ALL_ROLES) {
      if (r === "admin" || r === "director") continue;
      expect(isAdminOrDirector(u(r))).toBe(false);
    }
  });

  it("is strictly NARROWER than isLeadership (regression guard)", () => {
    // sales_director is in isLeadership but NOT in isAdminOrDirector.
    expect(isLeadership(u("sales_director"))).toBe(true);
    expect(isAdminOrDirector(u("sales_director"))).toBe(false);
  });
});

describe("existing helpers — sanity (locks in current behavior)", () => {
  it("isAdmin only matches admin", () => {
    for (const r of ALL_ROLES) expect(isAdmin(u(r))).toBe(r === "admin");
  });

  it("isLeadership = {admin, director, sales_director}", () => {
    const expected = new Set(["admin", "director", "sales_director"]);
    for (const r of ALL_ROLES) expect(isLeadership(u(r))).toBe(expected.has(r));
  });

  it("isManagerial = isLeadership + national_account_manager", () => {
    const expected = new Set([
      "admin",
      "director",
      "sales_director",
      "national_account_manager",
    ]);
    for (const r of ALL_ROLES) expect(isManagerial(u(r))).toBe(expected.has(r));
  });
});
