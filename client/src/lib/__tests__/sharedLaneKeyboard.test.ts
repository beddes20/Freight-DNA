// Task #871 — Shared lane-surface keyboard registry.
//
// Locks the contract that LWQ + AF cannot ship a silent keymap conflict:
//   • No two bindings claim the same key or the same id.
//   • The shared cheat sheet renders exactly the keys the dispatcher fires.
//   • Adding a new binding requires picking a free key.

import { describe, it, expect } from "vitest";
import {
  LANE_KEY_BINDINGS,
  assertNoDuplicateBindings,
  dispatchLaneKey,
  makeChordDispatcherState,
  CHORD_WINDOW_MS,
  type LaneKeyBinding,
} from "@/hooks/useSharedLaneKeyboard";

describe("LANE_KEY_BINDINGS registry", () => {
  it("loads with no duplicate keys or ids", () => {
    expect(() => assertNoDuplicateBindings(LANE_KEY_BINDINGS)).not.toThrow();
  });

  it("includes every required Task #871 binding (j/k/Enter/L/w/c/n/?)", () => {
    const keys = LANE_KEY_BINDINGS.map(b => b.key);
    for (const k of ["j", "k", "Enter", "L", "w", "c", "n", "?"]) {
      expect(keys).toContain(k);
    }
  });

  it("uses a CASE-SENSITIVE 'L' for the cockpit (not 'l')", () => {
    const cockpit = LANE_KEY_BINDINGS.find(b => b.id === "openCockpit");
    expect(cockpit?.key).toBe("L");
  });

  it("renames legacy openWorkQueue binding to swapSurface (w)", () => {
    expect(LANE_KEY_BINDINGS.some(b => (b as LaneKeyBinding).id === ("openWorkQueue" as never))).toBe(false);
    const swap = LANE_KEY_BINDINGS.find(b => b.id === "swapSurface");
    expect(swap?.key).toBe("w");
  });
});

describe("assertNoDuplicateBindings", () => {
  it("throws when two bindings share the same key", () => {
    const bad: LaneKeyBinding[] = [
      { id: "next", key: "j", label: "Next row",         shared: true },
      { id: "prev", key: "j", label: "Previous (BAD)",   shared: true },
    ];
    expect(() => assertNoDuplicateBindings(bad)).toThrow(/Duplicate key "j"/);
  });

  it("throws when two bindings share the same id", () => {
    const bad: LaneKeyBinding[] = [
      { id: "next", key: "j", label: "Next row",     shared: true },
      { id: "next", key: "k", label: "Next AGAIN",   shared: true },
    ];
    expect(() => assertNoDuplicateBindings(bad)).toThrow(/Duplicate binding id "next"/);
  });

  it("accepts a bindings list with all-unique keys and ids", () => {
    const ok: LaneKeyBinding[] = [
      { id: "next", key: "j", label: "Next row",     shared: true },
      { id: "prev", key: "k", label: "Previous row", shared: true },
    ];
    expect(() => assertNoDuplicateBindings(ok)).not.toThrow();
  });
});

describe("dispatchLaneKey — single keys", () => {
  it("returns the binding whose key matches the event", () => {
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "j" });
    expect(hit?.id).toBe("next");
  });

  it("returns null when no binding matches", () => {
    const miss = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "z" });
    expect(miss).toBeNull();
  });

  it("treats lowercase 'l' as a miss because cockpit binds uppercase 'L'", () => {
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "l" })).toBeNull();
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "L" })?.id).toBe("openCockpit");
  });
});

describe("dispatchLaneKey — chord sequences (g o, g p)", () => {
  it("fires `jumpOwnerFilter` after `g` then `o` within the chord window", () => {
    const state = makeChordDispatcherState();
    const t0 = 1000;
    // First keystroke arms the prefix; nothing fires yet.
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "g" }, state, t0)).toBeNull();
    expect(state.pendingPrefix).toBe("g");
    // Second keystroke completes the chord.
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "o" }, state, t0 + 100);
    expect(hit?.id).toBe("jumpOwnerFilter");
    expect(state.pendingPrefix).toBeNull();
  });

  it("fires `jumpPickupScope` after `g` then `p`", () => {
    const state = makeChordDispatcherState();
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "g" }, state, 0)).toBeNull();
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "p" }, state, 50);
    expect(hit?.id).toBe("jumpPickupScope");
  });

  it("expires the prefix after the chord window and treats the next key as fresh", () => {
    const state = makeChordDispatcherState();
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "g" }, state, 0)).toBeNull();
    // After CHORD_WINDOW_MS+1, the prefix is stale — `o` should NOT fire jumpOwnerFilter.
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "o" }, state, CHORD_WINDOW_MS + 1);
    expect(hit).toBeNull();
    expect(state.pendingPrefix).toBeNull();
  });

  it("falls through to a single-key match when the chord doesn't exist", () => {
    const state = makeChordDispatcherState();
    expect(dispatchLaneKey(LANE_KEY_BINDINGS, { key: "g" }, state, 0)).toBeNull();
    // `g j` is not a chord. The dispatcher clears the prefix and tries
    // `j` as a single-key — which is `next`.
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "j" }, state, 50);
    expect(hit?.id).toBe("next");
    expect(state.pendingPrefix).toBeNull();
  });

  it("never matches `g` alone (it is purely a chord prefix)", () => {
    const state = makeChordDispatcherState();
    const hit = dispatchLaneKey(LANE_KEY_BINDINGS, { key: "g" }, state, 0);
    expect(hit).toBeNull();
  });
});

describe("KeyboardShortcutsPopover registry coverage", () => {
  // The popover derives every cheat-sheet row from LANE_KEY_BINDINGS,
  // so registering a binding (chord or single) automatically advertises
  // it. We assert the chord rows are present in the registry; the
  // popover's split-on-space then renders `g` then `o` as two kbd
  // elements with a "then" between them.
  it("includes the g o / g p chord rows so the cheat sheet picks them up", () => {
    const labels = LANE_KEY_BINDINGS.map((b) => b.label);
    expect(labels).toContain("Jump to Owner filter");
    expect(labels).toContain("Jump to Pickup scope");
  });
});
