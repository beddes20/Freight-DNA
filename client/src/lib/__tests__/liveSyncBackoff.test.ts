/**
 * Task #973 — Live-sync reconnect backoff math.
 *
 * Pins the exponential-backoff + jitter algorithm used by
 * `useLiveSync` so we can never accidentally regress to "instant
 * retry" (the symptom that caused the prod thundering-herd of SSE
 * connect attempts when the endpoint blipped).
 */

import { describe, it, expect } from "vitest";
import {
  computeReconnectDelayMs,
  shouldResetAttemptCount,
  LIVE_SYNC_RECONNECT_BASE_MS,
  LIVE_SYNC_RECONNECT_CAP_MS,
  LIVE_SYNC_RECONNECT_JITTER,
  LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS,
} from "../liveSyncBackoff";

describe("computeReconnectDelayMs", () => {
  // Deterministic helpers for the random argument so we can assert the
  // exact min/max/midpoint behavior without flake.
  const randMin = () => 0; // → -jitter
  const randMid = () => 0.5; // → 0 jitter (returns base)
  const randMax = () => 1; // → +jitter

  it("doubles the base for each attempt up to the cap", () => {
    expect(computeReconnectDelayMs(1, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS);
    expect(computeReconnectDelayMs(2, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS * 2);
    expect(computeReconnectDelayMs(3, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS * 4);
    expect(computeReconnectDelayMs(4, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS * 8);
    expect(computeReconnectDelayMs(5, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS * 16);
  });

  it("caps at LIVE_SYNC_RECONNECT_CAP_MS for very long outages", () => {
    expect(computeReconnectDelayMs(6, randMid)).toBe(LIVE_SYNC_RECONNECT_CAP_MS);
    expect(computeReconnectDelayMs(20, randMid)).toBe(LIVE_SYNC_RECONNECT_CAP_MS);
    // Even with attempt=Infinity the math should not explode — the
    // exponent is clamped at 30, and we always Math.min against the cap.
    expect(computeReconnectDelayMs(Number.MAX_SAFE_INTEGER, randMid)).toBe(
      LIVE_SYNC_RECONNECT_CAP_MS,
    );
  });

  it("clamps to non-negative output for malformed attempt counts", () => {
    expect(computeReconnectDelayMs(0, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS);
    expect(computeReconnectDelayMs(-5, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS);
    expect(computeReconnectDelayMs(NaN, randMid)).toBe(LIVE_SYNC_RECONNECT_BASE_MS);
  });

  it("applies symmetric jitter in [-J, +J] of the base", () => {
    // attempt=3 → base 4000ms.
    const base = LIVE_SYNC_RECONNECT_BASE_MS * 4;
    const lower = base * (1 - LIVE_SYNC_RECONNECT_JITTER);
    const upper = base * (1 + LIVE_SYNC_RECONNECT_JITTER);
    expect(computeReconnectDelayMs(3, randMin)).toBeCloseTo(lower, 5);
    expect(computeReconnectDelayMs(3, randMax)).toBeCloseTo(upper, 5);

    // The output must always sit inside that band when the random source
    // is in [0,1).
    for (let i = 0; i < 200; i++) {
      const r = Math.random();
      const v = computeReconnectDelayMs(3, () => r);
      expect(v).toBeGreaterThanOrEqual(lower - 1e-9);
      expect(v).toBeLessThanOrEqual(upper + 1e-9);
    }
  });

  it("never returns a value below base*(1-J) — the stated invariant", () => {
    // The thundering-herd guard: even with random=0 (or a buggy random
    // returning a negative-ish value), the next attempt must wait at
    // least the lower jitter band of the current base. This pins the
    // floor so we don't regress into "near-instant retry".
    const lower = LIVE_SYNC_RECONNECT_BASE_MS * (1 - LIVE_SYNC_RECONNECT_JITTER);
    expect(computeReconnectDelayMs(1, () => 0)).toBeGreaterThanOrEqual(lower);
    expect(computeReconnectDelayMs(1, () => -10)).toBeGreaterThanOrEqual(lower);
  });

  it("never exceeds the hard cap, even with max jitter on long outages", () => {
    // The original implementation clamped to `cap*(1+J)` which let the
    // delay drift up to 37.5s — past the stated 30s ceiling. The cap
    // is a contract: admins planning around "the longest possible gap
    // between reconnects" must be able to trust the constant.
    for (let attempt = 6; attempt < 30; attempt++) {
      expect(computeReconnectDelayMs(attempt, randMax)).toBeLessThanOrEqual(
        LIVE_SYNC_RECONNECT_CAP_MS,
      );
      // And a random sweep — no random() output should produce a value
      // above the cap.
      for (let i = 0; i < 50; i++) {
        const r = Math.random();
        expect(computeReconnectDelayMs(attempt, () => r)).toBeLessThanOrEqual(
          LIVE_SYNC_RECONNECT_CAP_MS,
        );
      }
    }
  });
});

describe("shouldResetAttemptCount", () => {
  it("returns true after the live-session threshold has been met", () => {
    expect(shouldResetAttemptCount(LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS)).toBe(true);
    expect(shouldResetAttemptCount(LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS + 1_000)).toBe(true);
  });

  it("returns false for a brief connection that closes again quickly", () => {
    expect(shouldResetAttemptCount(0)).toBe(false);
    expect(shouldResetAttemptCount(1_000)).toBe(false);
    expect(shouldResetAttemptCount(LIVE_SYNC_RECONNECT_RESET_AFTER_LIVE_MS - 1)).toBe(false);
  });
});
