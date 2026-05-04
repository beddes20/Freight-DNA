// Task #970 — unit tests for the inline assignability diagnostic.
//
// The picker calls `canAssignLane` per candidate and surfaces the
// "Assign anyway?" override row when the verdict is `{ ok: false }`.
// `summarizeBulkAssign` aggregates the per-lane verdicts so the
// `BulkActionBar` count chip can advertise "5 of 7 eligible".

import { describe, it, expect } from "vitest";
import {
  canAssignLane,
  summarizeBulkAssign,
  ASSIGNABLE_OUTREACH_ROLES,
} from "@/lib/workflow-os/canAssignLane";

const lane = (id: string, ownerUserId: string | null = null) => ({ laneId: id, ownerUserId });

describe("canAssignLane", () => {
  it("approves an account_manager", () => {
    const r = canAssignLane(lane("L1"), { id: "u1", name: "Sara", role: "account_manager" });
    expect(r.ok).toBe(true);
  });

  it("approves every role on the canonical outreach list", () => {
    for (const role of ASSIGNABLE_OUTREACH_ROLES) {
      const r = canAssignLane(lane("L1"), { id: "u1", name: "X", role });
      expect(r.ok, `role=${role}`).toBe(true);
    }
  });

  it("rejects an admin with a non_outreach_role reason", () => {
    const r = canAssignLane(lane("L1"), { id: "u1", name: "Bex", role: "admin" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("non_outreach_role");
      expect(r.reason.toLowerCase()).toContain("admin");
      expect(r.reason).toContain("Bex");
    }
  });

  it("rejects a director", () => {
    const r = canAssignLane(lane("L1"), { id: "u1", name: "Pat", role: "director" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("non_outreach_role");
  });

  it("rejects a self-redundant assignment", () => {
    const r = canAssignLane(lane("L1", "u1"), { id: "u1", name: "Sara", role: "account_manager" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("self_redundant");
      expect(r.reason.toLowerCase()).toContain("already owns");
    }
  });

  it("self-redundant beats non-outreach (current owner check first)", () => {
    // A non-outreach role that's already the owner should still report
    // self-redundant rather than the role-based rejection — picking the
    // most actionable diagnostic for the rep.
    const r = canAssignLane(lane("L1", "u1"), { id: "u1", name: "Bex", role: "admin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("self_redundant");
  });

  it("flags wrong_team when both sides have known, mismatched teams", () => {
    const r = canAssignLane(
      { laneId: "L1", teamId: "west", teamLabel: "West" },
      { id: "u2", name: "Sara", role: "account_manager", teamId: "northeast", teamLabel: "Northeast" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("wrong_team");
      expect(r.reason).toContain("Northeast");
      expect(r.reason).toContain("West");
      expect(r.reason).toContain("Sara");
    }
  });

  it("falls back to the team id when no human label is supplied", () => {
    const r = canAssignLane(
      { laneId: "L1", teamId: "west" },
      { id: "u2", name: "Sara", role: "account_manager", teamId: "northeast" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("wrong_team");
      expect(r.reason).toContain("northeast");
      expect(r.reason).toContain("west");
    }
  });

  it("approves when teams match", () => {
    const r = canAssignLane(
      { laneId: "L1", teamId: "west", teamLabel: "West" },
      { id: "u2", name: "Sara", role: "account_manager", teamId: "west", teamLabel: "West" },
    );
    expect(r.ok).toBe(true);
  });

  it("skips the team check when the lane has no team configured", () => {
    // Early-rollout reality: most orgs haven't seeded cockpitTeamMap yet.
    // The predicate must NOT emit a false-positive "wrong team" warning
    // — fall through to the role check.
    const r = canAssignLane(
      { laneId: "L1" },
      { id: "u2", name: "Sara", role: "account_manager", teamId: "west" },
    );
    expect(r.ok).toBe(true);
  });

  it("skips the team check when the candidate has no team configured", () => {
    const r = canAssignLane(
      { laneId: "L1", teamId: "west" },
      { id: "u2", name: "Sara", role: "account_manager" },
    );
    expect(r.ok).toBe(true);
  });

  it("self-redundant beats wrong_team (most-actionable diagnostic wins)", () => {
    const r = canAssignLane(
      { laneId: "L1", ownerUserId: "u1", teamId: "west" },
      { id: "u1", name: "Sara", role: "account_manager", teamId: "northeast" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("self_redundant");
  });

  it("wrong_team beats non_outreach_role (team mismatch is more specific)", () => {
    const r = canAssignLane(
      { laneId: "L1", teamId: "west" },
      { id: "u2", name: "Bex", role: "admin", teamId: "northeast" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wrong_team");
  });
});

describe("summarizeBulkAssign", () => {
  const candidate = { id: "u1", name: "Sara", role: "account_manager" };

  it("returns fully eligible when no lane is owned by the candidate", () => {
    const s = summarizeBulkAssign([lane("L1"), lane("L2"), lane("L3")], candidate);
    expect(s).toEqual({ totalCount: 3, eligibleCount: 3, ineligibleCount: 0, firstReason: null });
  });

  it("counts partial eligibility and surfaces the first reason", () => {
    const s = summarizeBulkAssign(
      [lane("L1"), lane("L2", "u1"), lane("L3")],
      candidate,
    );
    expect(s.totalCount).toBe(3);
    expect(s.eligibleCount).toBe(2);
    expect(s.ineligibleCount).toBe(1);
    expect(s.firstReason).toMatch(/already owns/);
  });

  it("counts fully ineligible when the candidate is non-outreach", () => {
    const admin = { id: "uA", name: "Bex", role: "admin" };
    const s = summarizeBulkAssign([lane("L1"), lane("L2")], admin);
    expect(s.eligibleCount).toBe(0);
    expect(s.ineligibleCount).toBe(2);
    expect(s.firstReason).toMatch(/admin/i);
  });

  it("handles an empty selection without throwing", () => {
    const s = summarizeBulkAssign([], candidate);
    expect(s).toEqual({ totalCount: 0, eligibleCount: 0, ineligibleCount: 0, firstReason: null });
  });
});
