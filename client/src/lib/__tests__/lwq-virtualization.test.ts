/**
 * Task #648 — Smoke test for the LWQ virtualization machinery.
 *
 * The LWQ "windowing" implementation lazy-mounts each `LaneRow` on
 * viewport intersection (see `LazyLaneRow` in `client/src/pages/lane-work-queue.tsx`)
 * and reads/writes per-lane row heights from a module-scoped cache so
 * placeholders for off-screen rows occupy the correct space.
 *
 * The vitest config runs in `node` and doesn't include component-level
 * tests, so this file exercises the cache and the constants the wrapper
 * relies on. The mount-on-visible behavior itself is provided by the
 * standard IntersectionObserver API and verified visually + manually
 * through the data-testid hooks the wrapper exposes
 * (`lwq-lazy-row-{laneId}` with `data-state="placeholder|mounted"`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedRowHeight,
  setCachedRowHeight,
  clearRowHeightCache,
  LWQ_VIEWPORT_MARGIN_PX,
} from "../lwq-virtualization";

describe("LWQ row-height cache (Task #648)", () => {
  beforeEach(() => clearRowHeightCache());

  it("returns a positive fallback for a never-measured lane", () => {
    expect(getCachedRowHeight("lane-unknown")).toBeGreaterThan(0);
  });

  it("respects a custom fallback when none is cached", () => {
    expect(getCachedRowHeight("lane-x", 99)).toBe(99);
  });

  it("returns the cached height once measured", () => {
    setCachedRowHeight("lane-A", 220);
    expect(getCachedRowHeight("lane-A")).toBe(220);
  });

  it("ignores invalid measurements (zero, negative, NaN, non-finite)", () => {
    setCachedRowHeight("lane-B", 0);
    setCachedRowHeight("lane-B", -5);
    setCachedRowHeight("lane-B", Number.NaN);
    setCachedRowHeight("lane-B", Number.POSITIVE_INFINITY);
    expect(getCachedRowHeight("lane-B", 140)).toBe(140);
  });

  it("scales to hundreds of independent lanes without collision", () => {
    // Mirrors the user scenario from the plan: 250+ lane rows across
    // multiple customer groups must each track their own height. If the
    // cache aliased keys we'd see incorrect placeholder sizes after
    // collapse/expand.
    for (let i = 0; i < 250; i++) {
      setCachedRowHeight(`lane-${i}`, 100 + i);
    }
    for (let i = 0; i < 250; i++) {
      expect(getCachedRowHeight(`lane-${i}`)).toBe(100 + i);
    }
  });

  it("clears all cached heights on reset", () => {
    setCachedRowHeight("lane-1", 200);
    setCachedRowHeight("lane-2", 300);
    clearRowHeightCache();
    expect(getCachedRowHeight("lane-1", 50)).toBe(50);
    expect(getCachedRowHeight("lane-2", 50)).toBe(50);
  });

  it("exposes a sane viewport margin so off-screen rows stay placeholders", () => {
    // Too small → users see blank placeholders during fast scroll.
    // Too large → defeats the purpose; nearly every row stays mounted.
    expect(LWQ_VIEWPORT_MARGIN_PX).toBeGreaterThanOrEqual(400);
    expect(LWQ_VIEWPORT_MARGIN_PX).toBeLessThanOrEqual(2000);
  });
});
