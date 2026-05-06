/**
 * Route-Layer IDOR Lint
 *
 * Static companion to orgScopedIdorRegression.test.ts:
 *
 *   - The regression suite proves the SCOPED storage methods
 *     (getRfpInOrg / getAwardInOrg / getPtoPassoffInOrg) actually
 *     enforce the org boundary at the SQL JOIN layer.
 *
 *   - This file proves the ROUTE LAYER doesn't quietly call the
 *     unscoped variants (getRfp / getAward / getPtoPassoff) without
 *     being gated by an explicit org/visibility check.
 *
 * Approach: pin a baseline count of unscoped calls in routes.ts. Any
 * NEW unscoped call increases the count and trips this test, forcing
 * the next dev to either:
 *   (a) switch to the *InOrg variant, OR
 *   (b) confirm the new call site is gated by verifyAwardAccess /
 *       verifyCompanyAccess / equivalent, AND bump the baseline below
 *       with a comment explaining why.
 *
 * Each baseline entry below is documented — DO NOT bump a number
 * without adding a justification line above it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROUTES_PATH = join(__dirname, "..", "routes.ts");
const ROUTES = readFileSync(ROUTES_PATH, "utf8");

/** Count occurrences of `storage.<method>(` (unscoped form, no `InOrg` suffix). */
function countUnscopedCalls(method: string): number {
  // Match `storage.METHOD(` exactly, NOT `storage.METHODInOrg(` or any
  // identifier starting with METHOD followed by other letters.
  const re = new RegExp(`storage\\.${method}\\(`, "g");
  return (ROUTES.match(re) ?? []).length;
}

describe("route-layer IDOR lint — pin unscoped storage call baselines", () => {
  it("storage.getRfp(...) — should always be the *InOrg variant in routes.ts", () => {
    // Baseline: 0. Any unscoped getRfp() in routes.ts is a bug. Use
    // storage.getRfpInOrg(id, currentUser.organizationId) instead.
    expect(countUnscopedCalls("getRfp")).toBe(0);
  });

  it("storage.getAward(...) — 3 known-safe call sites, all gated by verifyAwardAccess", () => {
    // Baseline: 3. The known sites (as of this commit):
    //   ~L8707  verifyAwardAccess() helper itself — fetches award then
    //           validates org+visibility before returning true.
    //   ~L8764  POST /api/awards/:awardId/procurement-tasks — preceded
    //           by verifyAwardAccess() at the route entry.
    //   ~L8863  POST /api/awards/:awardId/lanes/assign-lm — preceded
    //           by verifyAwardAccess() at L8852.
    // If you add a new unscoped getAward() call, either:
    //   (a) switch it to storage.getAwardInOrg(awardId, user.organizationId), OR
    //   (b) confirm it's gated by verifyAwardAccess and bump this to 4
    //       with a justification comment above.
    expect(countUnscopedCalls("getAward")).toBe(3);
  });

  it("storage.getPtoPassoff(...) — should always be the *InOrg variant in routes.ts", () => {
    // Baseline: 0. PTO passoffs are uniquely sensitive (cover-letters
    // include emergency contacts, account quirks). All routes must use
    // storage.getPtoPassoffInOrg(id, currentUser.organizationId).
    expect(countUnscopedCalls("getPtoPassoff")).toBe(0);
  });
});
