/**
 * Task #1126 Phase 1 — unit tests for the lifecycle predicate helpers.
 *
 * These tests pin the policy refinement: deactivated vs quarantined
 * vs service vs deleted vs demo/fixture are all distinct states with
 * distinct downstream effects. The helpers themselves are pure, so
 * the tests run without a DB.
 */

import { describe, it, expect } from "vitest";
import {
  canInteractivelyLogIn,
  isVisibleAssignee,
  isCountedForSeat,
  isVisibleInDefaultRoster,
  formatUserAttribution,
  type UserLifecycleFields,
} from "../lib/userLifecycle";

const baseRealEmployee: UserLifecycleFields = {
  name: "Jane Doe",
  isActive: true,
  isServiceAccount: false,
  isDemo: false,
  isFixture: false,
  isQuarantined: false,
  deletedAt: null,
};

describe("canInteractivelyLogIn", () => {
  it("allows a real, active employee", () => {
    expect(canInteractivelyLogIn(baseRealEmployee)).toBe(true);
  });

  it("denies soft-deleted users", () => {
    expect(canInteractivelyLogIn({ ...baseRealEmployee, deletedAt: new Date() })).toBe(false);
  });

  it("denies deactivated users (real employee who left)", () => {
    expect(canInteractivelyLogIn({ ...baseRealEmployee, isActive: false })).toBe(false);
  });

  it("denies service accounts even when active", () => {
    expect(canInteractivelyLogIn({ ...baseRealEmployee, isServiceAccount: true })).toBe(false);
  });

  it("allows quarantined users — admins must still be able to triage them", () => {
    expect(canInteractivelyLogIn({ ...baseRealEmployee, isQuarantined: true })).toBe(true);
  });

  it("treats missing flags as the safe default (active true / service false)", () => {
    expect(canInteractivelyLogIn({ name: "x" })).toBe(true);
  });
});

describe("isVisibleAssignee", () => {
  it("includes the base real employee", () => {
    expect(isVisibleAssignee(baseRealEmployee)).toBe(true);
  });

  it.each([
    ["soft-deleted", { deletedAt: new Date() }],
    ["deactivated", { isActive: false }],
    ["service account", { isServiceAccount: true }],
    ["quarantined", { isQuarantined: true }],
    ["demo", { isDemo: true }],
    ["fixture", { isFixture: true }],
  ])("excludes %s users", (_label, overrides) => {
    expect(isVisibleAssignee({ ...baseRealEmployee, ...overrides })).toBe(false);
  });
});

describe("isCountedForSeat", () => {
  it("counts a real, active employee", () => {
    expect(isCountedForSeat(baseRealEmployee)).toBe(true);
  });

  it("still counts a quarantined employee — they're occupying a seat until classified", () => {
    expect(isCountedForSeat({ ...baseRealEmployee, isQuarantined: true })).toBe(true);
  });

  it.each([
    ["soft-deleted", { deletedAt: new Date() }],
    ["deactivated", { isActive: false }],
    ["service account", { isServiceAccount: true }],
    ["demo", { isDemo: true }],
    ["fixture", { isFixture: true }],
  ])("does not count %s users", (_label, overrides) => {
    expect(isCountedForSeat({ ...baseRealEmployee, ...overrides })).toBe(false);
  });
});

describe("isVisibleInDefaultRoster", () => {
  it("matches isVisibleAssignee for the base case", () => {
    expect(isVisibleInDefaultRoster(baseRealEmployee)).toBe(true);
  });

  it("excludes deactivated users from the default roster", () => {
    expect(isVisibleInDefaultRoster({ ...baseRealEmployee, isActive: false })).toBe(false);
  });
});

describe("formatUserAttribution", () => {
  it("returns the bare name for a real, active employee", () => {
    expect(formatUserAttribution(baseRealEmployee)).toBe("Jane Doe");
  });

  it("prefers (deleted) over every other suffix", () => {
    expect(
      formatUserAttribution({
        ...baseRealEmployee,
        deletedAt: new Date(),
        isActive: false,
        isQuarantined: true,
        isServiceAccount: true,
        isDemo: true,
      }),
    ).toBe("Jane Doe (deleted)");
  });

  it("prefers (inactive) over quarantined / service / demo", () => {
    expect(
      formatUserAttribution({
        ...baseRealEmployee,
        isActive: false,
        isQuarantined: true,
        isServiceAccount: true,
      }),
    ).toBe("Jane Doe (inactive)");
  });

  it("falls back to (quarantined) when only quarantine is set", () => {
    expect(formatUserAttribution({ ...baseRealEmployee, isQuarantined: true })).toBe(
      "Jane Doe (quarantined)",
    );
  });

  it("labels service accounts", () => {
    expect(formatUserAttribution({ ...baseRealEmployee, isServiceAccount: true })).toBe(
      "Jane Doe (service)",
    );
  });

  it("labels demo and fixture rows", () => {
    expect(formatUserAttribution({ ...baseRealEmployee, isDemo: true })).toBe("Jane Doe (demo)");
    expect(formatUserAttribution({ ...baseRealEmployee, isFixture: true })).toBe(
      "Jane Doe (fixture)",
    );
  });

  it("falls back to 'Unknown user' when name is missing", () => {
    expect(formatUserAttribution({})).toBe("Unknown user");
    expect(formatUserAttribution({ name: "   " })).toBe("Unknown user");
  });
});
