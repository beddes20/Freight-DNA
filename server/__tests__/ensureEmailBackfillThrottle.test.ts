import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldThrottleEmailBackfill,
  _resetEmailBackfillStateForTests,
} from "../services/quoteEmailIngestion";

describe("shouldThrottleEmailBackfill (Task #1146)", () => {
  beforeEach(() => {
    _resetEmailBackfillStateForTests();
  });

  it("first call runs, second call inside the window short-circuits, third call after the window runs", () => {
    const orgId = "org-throttle-test";
    const windowMs = 30_000;
    const t0 = 1_000_000_000;

    // First call records the timestamp and returns false (proceed).
    expect(shouldThrottleEmailBackfill(orgId, t0, windowMs)).toBe(false);

    // Second call inside the window short-circuits (true = throttled).
    expect(shouldThrottleEmailBackfill(orgId, t0 + 5_000, windowMs)).toBe(true);

    // Boundary: still inside the window at +29.999s.
    expect(shouldThrottleEmailBackfill(orgId, t0 + 29_999, windowMs)).toBe(true);

    // After the window elapses the call proceeds again.
    expect(shouldThrottleEmailBackfill(orgId, t0 + 30_001, windowMs)).toBe(false);

    // And the freshly-recorded timestamp re-arms the throttle.
    expect(shouldThrottleEmailBackfill(orgId, t0 + 35_000, windowMs)).toBe(true);
  });

  it("tracks throttle per-org independently", () => {
    const windowMs = 30_000;
    const t0 = 2_000_000_000;
    expect(shouldThrottleEmailBackfill("org-a", t0, windowMs)).toBe(false);
    // Different org is unaffected by org-a's recent attempt.
    expect(shouldThrottleEmailBackfill("org-b", t0, windowMs)).toBe(false);
    // Both orgs are now throttled inside the window.
    expect(shouldThrottleEmailBackfill("org-a", t0 + 1_000, windowMs)).toBe(true);
    expect(shouldThrottleEmailBackfill("org-b", t0 + 1_000, windowMs)).toBe(true);
  });
});
