// Workflow OS — `useRowSelection` state-transition contract.
//
// We test the pure helpers exported from the hook module rather than
// rendering the hook itself (the project doesn't ship
// @testing-library/react). The pure functions own the actual semantics;
// the React wrapper is just `useState` + `useCallback`.

import { describe, it, expect } from "vitest";
import {
  toggleSelection,
  setSelected_,
  selectAllVisibleIds,
} from "@/hooks/workflow-os/useRowSelection";

describe("toggleSelection", () => {
  it("adds an id when missing, removes when present", () => {
    const empty = new Set<string>();
    const after = toggleSelection(empty, "a");
    expect(after.has("a")).toBe(true);
    const back = toggleSelection(after, "a");
    expect(back.has("a")).toBe(false);
  });

  it("returns a new Set instance (never mutates input)", () => {
    const prev = new Set(["a"]);
    const next = toggleSelection(prev, "b");
    expect(next).not.toBe(prev);
    expect(prev.has("b")).toBe(false);
  });
});

describe("setSelected_", () => {
  it("adds when selected=true and not already present", () => {
    const out = setSelected_(new Set(), "a", true);
    expect(out.has("a")).toBe(true);
  });

  it("removes when selected=false and present", () => {
    const out = setSelected_(new Set(["a", "b"]), "a", false);
    expect(out.has("a")).toBe(false);
    expect(out.has("b")).toBe(true);
  });

  it("returns the same reference when state already matches", () => {
    const prev = new Set(["a"]);
    expect(setSelected_(prev, "a", true)).toBe(prev);
    expect(setSelected_(prev, "b", false)).toBe(prev);
  });
});

describe("selectAllVisibleIds", () => {
  it("unions with the existing selection", () => {
    const prev = new Set(["x"]);
    const out = selectAllVisibleIds(prev, ["a", "b", "c"]);
    expect(new Set(out)).toEqual(new Set(["x", "a", "b", "c"]));
  });

  it("keeps existing ids that are not in the visible set", () => {
    const prev = new Set(["x", "y"]);
    const out = selectAllVisibleIds(prev, ["a"]);
    expect(out.has("x")).toBe(true);
    expect(out.has("y")).toBe(true);
    expect(out.has("a")).toBe(true);
  });
});
