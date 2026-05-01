import { describe, it, expect } from "vitest";
import {
  isPickupToday,
  isPastPickup,
  isPickupWithinHours,
  isPickupAfterHours,
} from "../../shared/pickupFreshness";

// Task #875 — these helpers are the single source of truth for "today"
// and "pickup within / after N hours" used by both the cockpit server SQL
// aggregates and the client filter pipeline. Same-day pickups must never
// be classified as past-due regardless of the precise time-of-day.
describe("pickupFreshness time-window helpers", () => {
  const TODAY = "2026-04-30";

  describe("isPickupToday / isPastPickup", () => {
    it("identifies same-day bare-date pickups as today", () => {
      expect(isPickupToday("2026-04-30", TODAY)).toBe(true);
      expect(isPickupToday("2026-04-30T17:00:00Z", TODAY)).toBe(true);
      expect(isPickupToday("2026-04-29", TODAY)).toBe(false);
      expect(isPickupToday("2026-05-01", TODAY)).toBe(false);
      expect(isPickupToday(null, TODAY)).toBe(false);
    });

    it("classifies prior-day pickups as past, today as not-past", () => {
      expect(isPastPickup("2026-04-29", TODAY)).toBe(true);
      expect(isPastPickup("2026-04-30", TODAY)).toBe(false);
      expect(isPastPickup("2026-05-01", TODAY)).toBe(false);
      expect(isPastPickup(null, TODAY)).toBe(false);
    });
  });

  describe("isPickupWithinHours", () => {
    // The actual #875 regression: a "today" pickup ("2026-04-30") used to
    // get rejected by the client filter at 7am CT because UTC midnight had
    // already passed. With the day-key comparison it always passes.
    it("keeps same-day pickups regardless of stored time component", () => {
      expect(isPickupWithinHours("2026-04-30", 24, TODAY)).toBe(true);
      expect(isPickupWithinHours("2026-04-30T05:00:00Z", 24, TODAY)).toBe(true);
      expect(isPickupWithinHours("2026-04-30T22:00:00Z", 24, TODAY)).toBe(true);
    });

    it("rejects past-day pickups", () => {
      expect(isPickupWithinHours("2026-04-29", 24, TODAY)).toBe(false);
      expect(isPickupWithinHours("2026-04-29T23:00:00Z", 24, TODAY)).toBe(false);
    });

    it("uses ceil(hours/24) for the upper horizon", () => {
      // 24h ⇒ horizon = today + 1 (tomorrow)
      expect(isPickupWithinHours("2026-05-01", 24, TODAY)).toBe(true);
      expect(isPickupWithinHours("2026-05-02", 24, TODAY)).toBe(false);
      // 48h ⇒ horizon = today + 2
      expect(isPickupWithinHours("2026-05-02", 48, TODAY)).toBe(true);
      expect(isPickupWithinHours("2026-05-03", 48, TODAY)).toBe(false);
      // 12h still includes today (ceil(12/24) = 1, horizon = tomorrow)
      expect(isPickupWithinHours("2026-04-30", 12, TODAY)).toBe(true);
      expect(isPickupWithinHours("2026-05-01", 12, TODAY)).toBe(true);
    });

    it("treats null/empty pickups as out-of-window", () => {
      expect(isPickupWithinHours(null, 24, TODAY)).toBe(false);
      expect(isPickupWithinHours("", 24, TODAY)).toBe(false);
    });
  });

  describe("isPickupAfterHours", () => {
    it("uses floor(hours/24) for the lower bound", () => {
      // 24h ⇒ minDay = today + 1 (tomorrow). Today excluded; tomorrow included.
      expect(isPickupAfterHours("2026-04-30", 24, TODAY)).toBe(false);
      expect(isPickupAfterHours("2026-05-01", 24, TODAY)).toBe(true);
      expect(isPickupAfterHours("2026-05-02", 24, TODAY)).toBe(true);
    });

    it("composes with isPickupWithinHours to express 'pickup tomorrow'", () => {
      // The "Pickup tomorrow" built-in view: pickupWithinHours: 48 + pickupAfterHours: 24
      const inWindow = (iso: string) =>
        isPickupWithinHours(iso, 48, TODAY) && isPickupAfterHours(iso, 24, TODAY);
      expect(inWindow("2026-04-30")).toBe(false); // today
      expect(inWindow("2026-05-01")).toBe(true);  // tomorrow
      expect(inWindow("2026-05-02")).toBe(true);  // day after — within 48h horizon
      expect(inWindow("2026-05-03")).toBe(false); // outside horizon
    });
  });
});
