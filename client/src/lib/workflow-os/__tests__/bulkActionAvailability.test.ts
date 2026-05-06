// Task #970 — unit tests for the BulkActionBar availability descriptor.
// Covers the three states (available / partial / unavailable) plus the
// selection-aware context shape — eligibility derived from the actual
// selected ids, not just the count.

import { describe, it, expect } from "vitest";
import {
  resolveAvailability,
  type BulkAction,
  type BulkActionAvailability,
} from "@/components/workflow-os/BulkActionBar";

const ctx = (selectedIds: string[]) => ({
  selectedCount: selectedIds.length,
  selectedIds,
});

describe("BulkActionBar availability descriptor", () => {
  it("defaults to available when omitted", () => {
    const action: BulkAction = {
      id: "x",
      label: "X",
      onSelect: () => undefined,
    };
    expect(resolveAvailability(action, ctx(["a", "b", "c"]))).toEqual({
      state: "available",
    });
  });

  it("returns the static descriptor verbatim", () => {
    const av: BulkActionAvailability = { state: "unavailable", reason: "no perms" };
    const action: BulkAction = {
      id: "x",
      label: "X",
      onSelect: () => undefined,
      availability: av,
    };
    expect(resolveAvailability(action, ctx(["a"]))).toBe(av);
  });

  it("derives the descriptor from the function form using selectedCount", () => {
    const action: BulkAction = {
      id: "x",
      label: "X",
      onSelect: () => undefined,
      availability: ({ selectedCount }) =>
        selectedCount > 5
          ? { state: "partial", eligibleCount: 5, totalCount: selectedCount }
          : { state: "available" },
    };
    expect(resolveAvailability(action, ctx(["1","2","3","4","5","6","7"]))).toEqual({
      state: "partial",
      eligibleCount: 5,
      totalCount: 7,
    });
    expect(resolveAvailability(action, ctx(["1","2"]))).toEqual({
      state: "available",
    });
  });

  it("derives availability from the actual selected ids", () => {
    // Simulates LWQ's "lanes outside the candidate's team" check —
    // an availability fn that filters selectedIds against an
    // eligibility set rather than just counting them.
    const eligible = new Set(["lane-a", "lane-b", "lane-d"]);
    const action: BulkAction = {
      id: "assign-team-x",
      label: "Reassign to Team X",
      onSelect: () => undefined,
      availability: ({ selectedIds }) => {
        const okIds = selectedIds.filter(id => eligible.has(id));
        if (okIds.length === selectedIds.length) return { state: "available" };
        if (okIds.length === 0) {
          return { state: "unavailable", reason: "No selected lanes are eligible" };
        }
        return {
          state: "partial",
          eligibleCount: okIds.length,
          totalCount: selectedIds.length,
          reason: `${selectedIds.length - okIds.length} outside Team X scope`,
        };
      },
    };

    expect(resolveAvailability(action, ctx(["lane-a", "lane-b"]))).toEqual({
      state: "available",
    });

    expect(
      resolveAvailability(action, ctx(["lane-a", "lane-c", "lane-d"])),
    ).toEqual({
      state: "partial",
      eligibleCount: 2,
      totalCount: 3,
      reason: "1 outside Team X scope",
    });

    expect(resolveAvailability(action, ctx(["lane-c", "lane-e"]))).toEqual({
      state: "unavailable",
      reason: "No selected lanes are eligible",
    });
  });

  it("partial descriptor preserves both counts and optional reason", () => {
    const action: BulkAction = {
      id: "assign",
      label: "Reassign",
      onSelect: () => undefined,
      availability: {
        state: "partial",
        eligibleCount: 3,
        totalCount: 5,
        reason: "2 lanes outside scope",
      },
    };
    const r = resolveAvailability(action, ctx(["1","2","3","4","5"]));
    expect(r.state).toBe("partial");
    if (r.state === "partial") {
      expect(r.eligibleCount).toBe(3);
      expect(r.totalCount).toBe(5);
      expect(r.reason).toBe("2 lanes outside scope");
    }
  });

  it("unavailable descriptor requires a reason that survives passthrough", () => {
    const action: BulkAction = {
      id: "snooze",
      label: "Snooze",
      onSelect: () => undefined,
      availability: { state: "unavailable", reason: "Snooze not supported here" },
    };
    const r = resolveAvailability(action, ctx(["1","2","3","4"]));
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") {
      expect(r.reason).toBe("Snooze not supported here");
    }
  });
});
