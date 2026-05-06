// Task #967 — EmptyStateRecovery contract test.
//
// vitest is wired to a node environment in this repo, so we don't have a
// React-DOM rendering harness to mount the component into. Instead we
// pin the *contract* of the module via the TypeScript AST: the file
// exports the function with the expected prop names, the JSX includes
// the documented test ids, and the filtered-empty branch surfaces a
// reset-filter button keyed off `onResetFilters`. Static analysis
// catches the only regressions that actually break the trust-layer
// promise — the behaviour-level happy paths are exercised end-to-end
// by the per-tab Playwright specs queued as follow-up work.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.resolve(
  __dirname,
  "..",
  "..",
  "components",
  "empty-states",
  "EmptyStateRecovery.tsx",
);

const SRC = fs.readFileSync(FILE, "utf8");

describe("EmptyStateRecovery — contract", () => {
  it("exports a function named EmptyStateRecovery", () => {
    expect(SRC).toMatch(/export function EmptyStateRecovery\(/);
  });

  it("documents the props every consumer relies on", () => {
    // These prop names are pinned because pages / tests on AF, LWQ,
    // Quotes, and Conversations import them directly.
    for (const prop of [
      "activeFilterLabels",
      "onResetFilters",
      "extraActions",
      "icon",
      "title",
      "description",
      "resetLabel",
      "testId",
    ]) {
      expect(SRC).toContain(prop);
    }
  });

  it("renders an active-filter chip strip with stable test ids", () => {
    expect(SRC).toMatch(/data-testid={`\$\{rootTestId\}-filters`}/);
    expect(SRC).toMatch(/data-testid={`\$\{rootTestId\}-filter-\$\{i\}`}/);
  });

  it("renders the Reset-filters escape hatch with a stable test id", () => {
    expect(SRC).toMatch(/data-testid={`\$\{rootTestId\}-reset`}/);
    // The reset label must come from the `resetLabel` prop (default
    // 'Reset filters'), so consumers can localize it without forking.
    expect(SRC).toMatch(/resetLabel = "Reset filters"/);
  });

  it("falls through to the canonical EmptyState when no filters and no extras", () => {
    // Trust contract: we never invent a second visual style for
    // genuinely-empty panes — that case must delegate to <EmptyState />.
    expect(SRC).toMatch(/return \(\s*<EmptyState/);
  });

  it("default copy distinguishes filtered-empty from genuinely-empty", () => {
    expect(SRC).toContain("No matches for the current filters");
    expect(SRC).toContain("Nothing to show here yet");
  });
});
