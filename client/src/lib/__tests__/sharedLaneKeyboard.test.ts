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

describe("dispatchLaneKey", () => {
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
