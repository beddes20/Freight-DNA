// Task #1003 — Honest zero-state on the Customer Quotes page.
//
// vitest is wired to a node environment in this repo (no React-DOM
// rendering harness), so this is a static-AST/text-pin test that
// fixates the *contract* of the empty-state subtitle. The behaviour-
// level happy paths are exercised by the e2e Playwright runs.
//
// The three states the task pins:
//   (a) today has activity                              → no subtitle
//   (b) today empty + 7d empty                          → no subtitle
//   (c) today empty + 7d non-zero (and age = "today")   → subtitle + button
//
// We assert each branch by pinning the predicate the page uses to
// gate the subtitle, plus the test-ids and copy a future filter-
// default change would need to update before regressing the zero-
// state experience.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PAGE = path.resolve(
  __dirname,
  "..",
  "..",
  "pages",
  "quote-requests.tsx",
);
const SERVICE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "server",
  "services",
  "customerQuotes.ts",
);

const PAGE_SRC = fs.readFileSync(PAGE, "utf8");
const SERVICE_SRC = fs.readFileSync(SERVICE, "utf8");

describe("Customer Quotes — honest zero-state subtitle (Task #1003)", () => {
  it("server snapshot exposes pendingLast7d on kpis", () => {
    // The Snapshot.kpis type must declare pendingLast7d so the page
    // can read it without falling back to optional-chaining + 0 in
    // perpetuity.
    expect(SERVICE_SRC).toMatch(/pendingLast7d:\s*number/);
    // And the getSnapshot return must populate it.
    expect(SERVICE_SRC).toMatch(/pendingLast7d,/);
  });

  it("server pendingLast7d is computed from allOpps post the customer-only chokepoint", () => {
    // Pin the computation site: it must be derived from `allOpps`
    // (org-wide) and gated through `nonCustomerIds` so the new
    // empty-state line never depends on the active page filter.
    expect(SERVICE_SRC).toMatch(
      /const\s+pendingLast7d\s*=\s*allOpps\.filter\(/,
    );
    expect(SERVICE_SRC).toMatch(/!nonCustomerIds\.has\(o\.customerId\)/);
    expect(SERVICE_SRC).toMatch(/o\.outcomeStatus === "pending"/);
    // 7-day rolling window, not a today-clamp.
    expect(SERVICE_SRC).toMatch(/sevenDaysAgo\s*=\s*now\.getTime\(\)\s*-\s*7\s*\*\s*dayMs/);
  });

  it("page Snapshot type declares pendingLast7d on kpis", () => {
    expect(PAGE_SRC).toMatch(/pendingLast7d\?:\s*number/);
  });

  it("ZeroState gates the subtitle on the documented 4-part predicate", () => {
    // (c) — show only when age=today, openCount=0, autoCapturedToday=0,
    // pendingLast7d>0, and a setter is wired. This predicate is the
    // single source of truth for the three-state contract:
    //   (a) any activity → fails (openCount or autoCapturedToday > 0)
    //   (b) 7d empty → fails (pendingLast7d > 0 condition)
    //   (c) all match  → passes
    expect(PAGE_SRC).toMatch(/const\s+showHonestSubtitle\s*=/);
    expect(PAGE_SRC).toMatch(/age === "today"/);
    expect(PAGE_SRC).toMatch(/\(openCount \?\? 0\) === 0/);
    expect(PAGE_SRC).toMatch(/\(autoCapturedToday \?\? 0\) === 0/);
    expect(PAGE_SRC).toMatch(/\(pendingLast7d \?\? 0\) > 0/);
    expect(PAGE_SRC).toMatch(/!!onShowLast7Days/);
  });

  it("renders the honest-subtitle block with the documented copy and test ids", () => {
    // The subtitle node + count node carry stable test-ids so
    // downstream e2e selectors don't drift.
    expect(PAGE_SRC).toContain('data-testid="zero-state-honest-subtitle"');
    expect(PAGE_SRC).toContain('data-testid="zero-state-pending-7d-count"');
    // Copy is pinned because the trust contract is "this line is the
    // honest one" — silently changing it during a refactor would
    // regress the zero-state experience.
    expect(PAGE_SRC).toContain("No requests received today");
    expect(PAGE_SRC).toContain("pending in the last 7 days");
  });

  it("Show last 7 days button calls the existing setters and resets offset", () => {
    // The button label + test-id are the contract surface; the
    // onShowLast7Days callback is wired at the page level to call
    // setAge("7d") and reset offset, mirroring the chip behaviour.
    expect(PAGE_SRC).toContain('data-testid="button-show-last-7-days"');
    expect(PAGE_SRC).toContain("Show last 7 days");
    expect(PAGE_SRC).toMatch(
      /onShowLast7Days=\{\(\) => \{\s*setAge\("7d"\);\s*setOffset\(0\);\s*\}\}/,
    );
  });

  it("subtitle never renders inside the filtered-empty branch", () => {
    // Defensive: the filtered-empty branch returns the shared
    // <EmptyStateRecovery /> pane and must short-circuit *before*
    // showHonestSubtitle is reached. We pin the structural ordering
    // by checking that the subtitle predicate appears after the
    // filtered-empty early-return.
    const filteredReturn = PAGE_SRC.indexOf(
      "if (activeFilterLabels && activeFilterLabels.length > 0)",
    );
    const subtitlePredicate = PAGE_SRC.indexOf("const showHonestSubtitle =");
    expect(filteredReturn).toBeGreaterThan(-1);
    expect(subtitlePredicate).toBeGreaterThan(filteredReturn);
  });
});
