/**
 * Task #472 — morning-briefing 3-state section() helper.
 *
 * Validates the rendering distinguishes:
 *   1. Has data        → bullets are echoed verbatim.
 *   2. Empty-good      → italic positive message ("All accounts are warm…").
 *   3. Source down     → italic explicit "Source unavailable" notice — NOT
 *                        the same as empty-good. Reps must be able to tell
 *                        apart "nothing to do" from "we couldn't check".
 */
import { describe, it, expect } from "vitest";
import { section } from "../agent/todaySeed";

describe("todaySeed section() — 3-state rendering", () => {
  it("renders bullets when there's data (ok=true)", () => {
    const out = section("Hot lanes", ["- a", "- b"], "no lanes", true);
    expect(out).toContain("### Hot lanes");
    expect(out).toContain("- a");
    expect(out).toContain("- b");
    expect(out).not.toContain("Source unavailable");
  });

  it("renders the empty-good message when no data and source ok", () => {
    const out = section("Hot lanes", [], "All clear here.", true);
    expect(out).toContain("_All clear here._");
    expect(out).not.toContain("Source unavailable");
  });

  it("renders an explicit unavailable notice when source is down", () => {
    const out = section("Hot lanes", [], "All clear here.", false);
    expect(out).toMatch(/Source unavailable/i);
    // Crucially, the *positive* "all clear" wording must NOT appear when
    // the underlying query failed — that would lie to the rep.
    expect(out).not.toContain("All clear here.");
  });
});
