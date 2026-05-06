import { describe, it, expect } from "vitest";
import {
  shouldHideForPickup,
  computePickupFreshness,
  daysSincePickup,
  ACTIONABLE_OPEN_STATUSES,
  type PickupHideContext,
} from "../../shared/pickupFreshness";

// Task #957 follow-up — Available Freight uses a STRICT past definition:
// any pickup whose freshness is `past_recent` or `past_stale` is hidden
// regardless of status. These tests pin that contract so the legacy soft-
// overdue carve-out cannot regress in.

const TODAY = "2026-04-30"; // CT
const YESTERDAY = "2026-04-29";
const TODAY_PICKUP = "2026-04-30";
const TOMORROW = "2026-05-01";
const STALE = "2026-04-10"; // > grace days past

function ctxFor(pickupIso: string, status: string): PickupHideContext {
  return {
    status,
    daysSincePickup: daysSincePickup(pickupIso, TODAY),
  };
}

describe("shouldHideForPickup — actionable (strict past)", () => {
  it("yesterday + open status (ready_to_send) is EXCLUDED from Available Freight", () => {
    const freshness = computePickupFreshness(YESTERDAY, TODAY);
    expect(freshness).toBe("past_recent");
    expect(
      shouldHideForPickup(freshness, "actionable", ctxFor(YESTERDAY, "ready_to_send")),
    ).toBe(true);
  });

  it("yesterday + every actionable open status is EXCLUDED (status no longer keeps it visible)", () => {
    const freshness = computePickupFreshness(YESTERDAY, TODAY);
    for (const status of ACTIONABLE_OPEN_STATUSES) {
      expect(
        shouldHideForPickup(freshness, "actionable", ctxFor(YESTERDAY, status)),
      ).toBe(true);
    }
  });

  it("yesterday + closed status (covered, dismissed) is also EXCLUDED", () => {
    const freshness = computePickupFreshness(YESTERDAY, TODAY);
    expect(shouldHideForPickup(freshness, "actionable", ctxFor(YESTERDAY, "covered"))).toBe(true);
    expect(shouldHideForPickup(freshness, "actionable", ctxFor(YESTERDAY, "dismissed"))).toBe(true);
  });

  it("today + any status is INCLUDED", () => {
    const freshness = computePickupFreshness(TODAY_PICKUP, TODAY);
    expect(freshness).toBe("upcoming");
    expect(
      shouldHideForPickup(freshness, "actionable", ctxFor(TODAY_PICKUP, "ready_to_send")),
    ).toBe(false);
    expect(
      shouldHideForPickup(freshness, "actionable", ctxFor(TODAY_PICKUP, "covered")),
    ).toBe(false);
  });

  it("tomorrow + any status is INCLUDED", () => {
    const freshness = computePickupFreshness(TOMORROW, TODAY);
    expect(freshness).toBe("upcoming");
    expect(
      shouldHideForPickup(freshness, "actionable", ctxFor(TOMORROW, "sent")),
    ).toBe(false);
  });

  it("no-pickup rows are INCLUDED (date does not hide them)", () => {
    const freshness = computePickupFreshness(null, TODAY);
    expect(freshness).toBe("no_pickup");
    expect(shouldHideForPickup(freshness, "actionable", { status: "ready_to_send" })).toBe(false);
  });

  it("strictly stale (>14d past) is EXCLUDED", () => {
    const freshness = computePickupFreshness(STALE, TODAY);
    expect(freshness).toBe("past_stale");
    expect(
      shouldHideForPickup(freshness, "actionable", ctxFor(STALE, "ready_to_send")),
    ).toBe(true);
  });
});

describe("shouldHideForPickup — other scopes preserve their behavior", () => {
  it("'all' shows yesterday + open status (history view)", () => {
    const freshness = computePickupFreshness(YESTERDAY, TODAY);
    // Same exact row visible when pickupScope === "all".
    expect(
      shouldHideForPickup(freshness, "all", ctxFor(YESTERDAY, "ready_to_send")),
    ).toBe(false);
  });

  it("'all' even shows strictly stale rows", () => {
    const freshness = computePickupFreshness(STALE, TODAY);
    expect(shouldHideForPickup(freshness, "all", ctxFor(STALE, "sent"))).toBe(false);
  });

  it("'recent' shows yesterday (within grace) but hides strictly stale", () => {
    const yFreshness = computePickupFreshness(YESTERDAY, TODAY);
    expect(shouldHideForPickup(yFreshness, "recent", ctxFor(YESTERDAY, "sent"))).toBe(false);
    const sFreshness = computePickupFreshness(STALE, TODAY);
    expect(shouldHideForPickup(sFreshness, "recent", ctxFor(STALE, "sent"))).toBe(true);
  });

  it("'upcoming' is strict future-only — yesterday hidden, today/future shown", () => {
    expect(
      shouldHideForPickup(computePickupFreshness(YESTERDAY, TODAY), "upcoming", ctxFor(YESTERDAY, "sent")),
    ).toBe(true);
    expect(
      shouldHideForPickup(computePickupFreshness(TODAY_PICKUP, TODAY), "upcoming", ctxFor(TODAY_PICKUP, "sent")),
    ).toBe(false);
    expect(
      shouldHideForPickup(computePickupFreshness(TOMORROW, TODAY), "upcoming", ctxFor(TOMORROW, "sent")),
    ).toBe(false);
  });
});

describe("shouldHideForPickup — midnight rollover (CT)", () => {
  // At 23:55 CT on 2026-04-29 the org-local date is still 2026-04-29 ⇒ the
  // 2026-04-29 pickup is "today" (upcoming), visible. At 00:05 CT on
  // 2026-04-30 the org-local date rolls to 2026-04-30 ⇒ the SAME 2026-04-29
  // pickup is now "yesterday" (past_recent) and must be excluded.
  const beforeRollover = "2026-04-29";
  const afterRollover = "2026-04-30";
  const pickupOn29 = "2026-04-29";

  it("at 23:55 CT 2026-04-29 the 2026-04-29 pickup is INCLUDED (today)", () => {
    const freshness = computePickupFreshness(pickupOn29, beforeRollover);
    expect(freshness).toBe("upcoming");
    expect(
      shouldHideForPickup(freshness, "actionable", {
        status: "ready_to_send",
        daysSincePickup: daysSincePickup(pickupOn29, beforeRollover),
      }),
    ).toBe(false);
  });

  it("at 00:05 CT 2026-04-30 the same 2026-04-29 pickup becomes EXCLUDED (yesterday)", () => {
    const freshness = computePickupFreshness(pickupOn29, afterRollover);
    expect(freshness).toBe("past_recent");
    expect(
      shouldHideForPickup(freshness, "actionable", {
        status: "ready_to_send",
        daysSincePickup: daysSincePickup(pickupOn29, afterRollover),
      }),
    ).toBe(true);
  });

  it("the same 2026-04-29 row remains VISIBLE under pickupScope='all' on 2026-04-30 (history view)", () => {
    const freshness = computePickupFreshness(pickupOn29, afterRollover);
    expect(
      shouldHideForPickup(freshness, "all", {
        status: "ready_to_send",
        daysSincePickup: daysSincePickup(pickupOn29, afterRollover),
      }),
    ).toBe(false);
  });
});
