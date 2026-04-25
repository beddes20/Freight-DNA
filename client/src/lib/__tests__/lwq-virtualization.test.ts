import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedRowHeight,
  setCachedRowHeight,
  clearRowHeightCache,
  LWQ_VIEWPORT_MARGIN_PX,
} from "../lwq-virtualization";

describe("LWQ row-height cache", () => {
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

  it("exposes a sane viewport margin", () => {
    expect(LWQ_VIEWPORT_MARGIN_PX).toBeGreaterThanOrEqual(400);
    expect(LWQ_VIEWPORT_MARGIN_PX).toBeLessThanOrEqual(2000);
  });
});
