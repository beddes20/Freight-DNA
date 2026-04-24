/**
 * Customer Quotes #2 — SLA helper math.
 *
 * Locks the four state transitions (ok → warning → breached) plus the
 * two `na` paths (non-pending status, missing/invalid date) and the
 * label formatter so the badge stays in sync between server and client.
 */
import { describe, it, expect } from "vitest";
import {
  computeQuoteSla,
  formatSlaBadge,
  DEFAULT_QUOTE_SLA_MINUTES,
  DEFAULT_QUOTE_SLA_WARNING_MINUTES,
} from "../../shared/quoteSla";

const NOW = Date.parse("2026-04-24T12:00:00.000Z");
const minutesAgo = (m: number): Date => new Date(NOW - m * 60_000);

describe("computeQuoteSla", () => {
  it("returns ok when well within the SLA window", () => {
    const sla = computeQuoteSla(minutesAgo(1), "pending", { now: NOW });
    expect(sla.state).toBe("ok");
    expect(sla.minutesSinceRequest).toBe(1);
    expect(sla.remainingMs).toBeGreaterThan(0);
    expect(sla.slaMinutes).toBe(DEFAULT_QUOTE_SLA_MINUTES);
  });

  it("flips to warning when remaining drops to <= warningMinutes", () => {
    // 5 min ago = 2 min remaining (== warning threshold) → warning
    const sla = computeQuoteSla(minutesAgo(5), "pending", { now: NOW });
    expect(sla.state).toBe("warning");
    expect(sla.minutesSinceRequest).toBe(5);
  });

  it("stays ok one second before the warning band", () => {
    // 4m 59s ago → just over 2 min remaining → still ok
    const sla = computeQuoteSla(new Date(NOW - (4 * 60 + 59) * 1000), "pending", { now: NOW });
    expect(sla.state).toBe("ok");
  });

  it("flips to breached at the SLA threshold", () => {
    const sla = computeQuoteSla(minutesAgo(DEFAULT_QUOTE_SLA_MINUTES), "pending", { now: NOW });
    expect(sla.state).toBe("breached");
    expect(sla.remainingMs).toBeLessThanOrEqual(0);
  });

  it("reports overdue minutes once breached", () => {
    const sla = computeQuoteSla(minutesAgo(DEFAULT_QUOTE_SLA_MINUTES + 12), "pending", { now: NOW });
    expect(sla.state).toBe("breached");
    expect(sla.minutesSinceRequest).toBe(DEFAULT_QUOTE_SLA_MINUTES + 12);
  });

  it.each(["won", "won_low_margin", "lost", "expired", "ignored"])(
    "is na for non-pending status %s",
    (status) => {
      const sla = computeQuoteSla(minutesAgo(60), status, { now: NOW });
      expect(sla.state).toBe("na");
    },
  );

  it("is na for missing requestDate", () => {
    expect(computeQuoteSla(null, "pending", { now: NOW }).state).toBe("na");
    expect(computeQuoteSla(undefined, "pending", { now: NOW }).state).toBe("na");
  });

  it("is na for invalid requestDate", () => {
    expect(computeQuoteSla("not-a-date", "pending", { now: NOW }).state).toBe("na");
  });

  it("clamps future-dated requests to age 0 (still ok)", () => {
    const sla = computeQuoteSla(new Date(NOW + 5 * 60_000), "pending", { now: NOW });
    expect(sla.state).toBe("ok");
    expect(sla.ageMs).toBe(0);
    expect(sla.minutesSinceRequest).toBe(0);
  });

  it("respects custom slaMinutes / warningMinutes overrides", () => {
    const sla = computeQuoteSla(minutesAgo(15), "pending", {
      now: NOW,
      slaMinutes: 30,
      warningMinutes: 10,
    });
    expect(sla.state).toBe("ok");
    expect(sla.slaMinutes).toBe(30);
    expect(sla.remainingMs).toBe(15 * 60_000);
  });

  it("default warning band matches DEFAULT_QUOTE_SLA_WARNING_MINUTES", () => {
    expect(DEFAULT_QUOTE_SLA_WARNING_MINUTES).toBeGreaterThan(0);
  });
});

describe("formatSlaBadge", () => {
  it("shows minutes remaining for ok state", () => {
    // 1 min elapsed of a 7 min SLA → 6 min remaining
    const sla = computeQuoteSla(minutesAgo(1), "pending", { now: NOW });
    expect(formatSlaBadge(sla)).toBe("6m");
  });

  it("shows +Nm overdue for breached state", () => {
    const sla = computeQuoteSla(minutesAgo(DEFAULT_QUOTE_SLA_MINUTES + 4), "pending", { now: NOW });
    expect(formatSlaBadge(sla)).toBe("+4m");
  });

  it("clamps overdue display to a minimum of +1m", () => {
    // 7m1s ago → just barely breached → still surfaces +1m, never +0m.
    const sla = computeQuoteSla(new Date(NOW - (DEFAULT_QUOTE_SLA_MINUTES * 60 + 1) * 1000), "pending", { now: NOW });
    expect(formatSlaBadge(sla)).toBe("+1m");
  });

  it("returns empty string for na", () => {
    const sla = computeQuoteSla(minutesAgo(0), "won", { now: NOW });
    expect(formatSlaBadge(sla)).toBe("");
  });

  it("shows <1m for sub-minute remaining", () => {
    // 6m30s ago → 30s remaining → warning, formatter yields "<1m"
    const sla = computeQuoteSla(new Date(NOW - (6 * 60 + 30) * 1000), "pending", { now: NOW });
    expect(sla.state).toBe("warning");
    expect(formatSlaBadge(sla)).toBe("<1m");
  });
});
