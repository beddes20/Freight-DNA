// Task #967 — row-version guard.
//
// The guard is the safety net for the live-sync envelope's `rowVersionAt`
// field. The contract is small but easy to break by accident:
//
//   • events without rowVersionAt always apply (legacy publish paths)
//   • events without a key always apply (topic-wide fan-out)
//   • newer rowVersionAt wins; older drops
//   • the in-memory map is keyed (topic, key) so two topics naming the
//     same id don't fight each other
//
// These tests pin every branch.

import { afterEach, describe, expect, it } from "vitest";
import {
  _peekRowVersionForTests,
  _resetRowVersionGuardForTests,
  applyRowVersionGuard,
} from "../applyRowVersionGuard";

afterEach(() => {
  _resetRowVersionGuardForTests();
});

describe("applyRowVersionGuard", () => {
  it("applies events that carry no rowVersionAt (legacy publish path)", () => {
    expect(
      applyRowVersionGuard({ topic: "customer_quote.updated", key: "q-1" }),
    ).toBe(true);
    // No version recorded — subsequent versioned events should still
    // win without being clobbered by the legacy event.
    expect(_peekRowVersionForTests("customer_quote.updated", "q-1")).toBeUndefined();
  });

  it("applies events that have no key (topic-wide fan-out)", () => {
    expect(
      applyRowVersionGuard({ topic: "customer_quote.bulk", rowVersionAt: 1000 }),
    ).toBe(true);
  });

  it("records and applies the first versioned event for a (topic, key)", () => {
    expect(
      applyRowVersionGuard({
        topic: "customer_quote.updated",
        key: "q-1",
        rowVersionAt: 1_000,
      }),
    ).toBe(true);
    expect(_peekRowVersionForTests("customer_quote.updated", "q-1")).toBe(1_000);
  });

  it("applies a newer event and updates the stored version", () => {
    applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 1_000 });
    expect(
      applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 1_500 }),
    ).toBe(true);
    expect(_peekRowVersionForTests("t", "k")).toBe(1_500);
  });

  it("DROPS strictly older events", () => {
    applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 2_000 });
    expect(
      applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 1_500 }),
    ).toBe(false);
    // Stored version unchanged.
    expect(_peekRowVersionForTests("t", "k")).toBe(2_000);
  });

  it("DROPS equal-version replays (idempotency)", () => {
    applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 2_000 });
    expect(
      applyRowVersionGuard({ topic: "t", key: "k", rowVersionAt: 2_000 }),
    ).toBe(false);
  });

  it("keys are namespaced by topic — same key in two topics doesn't clash", () => {
    applyRowVersionGuard({ topic: "topic-a", key: "shared", rowVersionAt: 9_000 });
    expect(
      applyRowVersionGuard({ topic: "topic-b", key: "shared", rowVersionAt: 1_000 }),
    ).toBe(true);
    expect(_peekRowVersionForTests("topic-a", "shared")).toBe(9_000);
    expect(_peekRowVersionForTests("topic-b", "shared")).toBe(1_000);
  });

  it("rejects non-finite rowVersionAt by treating as 'no version'", () => {
    expect(
      applyRowVersionGuard({
        topic: "t",
        key: "k",
        rowVersionAt: Number.NaN,
      }),
    ).toBe(true);
    expect(
      applyRowVersionGuard({
        topic: "t",
        key: "k",
        rowVersionAt: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
    expect(_peekRowVersionForTests("t", "k")).toBeUndefined();
  });

  it("returns true for malformed event objects (best-effort, never blocks)", () => {
    expect(applyRowVersionGuard({ topic: "" } as never)).toBe(true);
  });
});
