// Workflow OS — actionability + pickup-scope predicates.
//
// Locks the contract that "Actionable" is the platform default and
// soft-overdue is gated on both the SOFT_OVERDUE_HOURS window AND the
// per-surface ACTIONABLE_OPEN_STATUSES set (ADR-002).

import { describe, it, expect } from "vitest";
import {
  shouldHideForActionable,
  countHiddenStale,
  applyPickupScope,
  DEFAULT_PICKUP_SCOPE,
  ACTIONABLE_OPEN_STATUSES,
  SOFT_OVERDUE_HOURS,
  type ActionableRow,
} from "@shared/workflowOs/actionability";

const TODAY = "2026-05-01";

describe("shouldHideForActionable", () => {
  const ctx = { surface: "af" as const, todayIso: TODAY };

  it("never hides upcoming pickups", () => {
    const r: ActionableRow = { pickupWindowStart: "2026-05-02", status: "ready_to_send" };
    expect(shouldHideForActionable(r, ctx)).toBe(false);
  });

  it("hides past_stale rows regardless of status", () => {
    const r: ActionableRow = { pickupWindowStart: "2026-04-01", status: "ready_to_send" };
    expect(shouldHideForActionable(r, ctx)).toBe(true);
  });

  it("keeps soft-overdue rows that are still in an actionable status", () => {
    // 1 day past pickup = 24h, equal to the SOFT_OVERDUE_HOURS boundary.
    const r: ActionableRow = { pickupWindowStart: "2026-04-30", status: "ready_to_send" };
    expect(SOFT_OVERDUE_HOURS).toBeGreaterThanOrEqual(24);
    expect(shouldHideForActionable(r, ctx)).toBe(false);
  });

  it("hides past_recent rows whose status is closed", () => {
    const r: ActionableRow = { pickupWindowStart: "2026-04-30", status: "covered" };
    expect(shouldHideForActionable(r, ctx)).toBe(true);
  });

  it("hides past_recent rows that are past the soft-overdue hour window", () => {
    // 3 days past = 72h, well outside the default 24h soft-overdue window.
    const r: ActionableRow = { pickupWindowStart: "2026-04-28", status: "ready_to_send" };
    expect(shouldHideForActionable(r, ctx)).toBe(true);
  });

  it("uses per-surface ACTIONABLE_OPEN_STATUSES sets", () => {
    const r: ActionableRow = { pickupWindowStart: "2026-04-30", status: "inProgress" };
    // 'inProgress' is open for LWQ but not AF.
    expect(shouldHideForActionable(r, { surface: "lwq", todayIso: TODAY })).toBe(false);
    expect(shouldHideForActionable(r, { surface: "af", todayIso: TODAY })).toBe(true);
  });

  it("treats no-pickup rows as actionable when status is open", () => {
    const open: ActionableRow = { pickupWindowStart: null, status: "ready_to_send" };
    expect(shouldHideForActionable(open, ctx)).toBe(false);
    const closed: ActionableRow = { pickupWindowStart: null, status: "covered" };
    expect(shouldHideForActionable(closed, ctx)).toBe(true);
  });
});

describe("countHiddenStale", () => {
  it("returns the count of rows that the actionable scope would hide", () => {
    const rows: ActionableRow[] = [
      { pickupWindowStart: "2026-05-02", status: "ready_to_send" }, // visible
      { pickupWindowStart: "2026-04-01", status: "ready_to_send" }, // hidden (stale)
      { pickupWindowStart: "2026-04-28", status: "ready_to_send" }, // hidden (past soft-overdue)
      { pickupWindowStart: "2026-04-30", status: "covered" },        // hidden (closed status)
    ];
    expect(countHiddenStale(rows, { surface: "af", todayIso: TODAY })).toBe(3);
  });
});

describe("applyPickupScope", () => {
  const rows: ActionableRow[] = [
    { pickupWindowStart: "2026-05-02", status: "ready_to_send" },
    { pickupWindowStart: "2026-04-30", status: "ready_to_send" }, // soft-overdue, 1 day
    { pickupWindowStart: "2026-04-01", status: "ready_to_send" }, // past_stale
    { pickupWindowStart: "2026-04-30", status: "covered" },        // past_recent + closed
  ];
  const ctx = { surface: "af" as const, todayIso: TODAY };

  it("DEFAULT_PICKUP_SCOPE is 'actionable'", () => {
    expect(DEFAULT_PICKUP_SCOPE).toBe("actionable");
  });

  it("'actionable' returns upcoming + soft-overdue-open rows only", () => {
    const out = applyPickupScope(rows, "actionable", ctx);
    expect(out).toHaveLength(2);
  });

  it("'upcoming' is strict — only future pickups", () => {
    const out = applyPickupScope(rows, "upcoming", ctx);
    expect(out).toHaveLength(1);
  });

  it("'recent' keeps past_recent rows regardless of status", () => {
    const out = applyPickupScope(rows, "recent", ctx);
    // upcoming + 2 past_recent = 3
    expect(out).toHaveLength(3);
  });

  it("'all' returns everything", () => {
    expect(applyPickupScope(rows, "all", ctx)).toHaveLength(rows.length);
  });
});

describe("ACTIONABLE_OPEN_STATUSES is fully populated", () => {
  it("has the documented status sets per surface", () => {
    expect(ACTIONABLE_OPEN_STATUSES.af).toContain("ready_to_send");
    expect(ACTIONABLE_OPEN_STATUSES.af).toContain("partially_covered");
    expect(ACTIONABLE_OPEN_STATUSES.lwq).toContain("inProgress");
    expect(ACTIONABLE_OPEN_STATUSES.available_loads).toContain("available");
  });
});
