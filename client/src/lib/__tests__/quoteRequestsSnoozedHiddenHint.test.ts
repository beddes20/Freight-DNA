// Task #1152 — pins the visibility branch for the snoozed-hidden hint.
// Repo runs vitest in `environment: "node"` and does not ship
// @testing-library/react (see workflowOsRowSelection.test.ts), so the
// page-level branch is extracted into a pure module and pinned here,
// alongside a structural co-location check matching the Task #1149
// quoteRequestsMineOnlyDegradedSnapshot pattern.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { shouldShowSnoozedHiddenHint } from "../quoteRequestsSnoozedHiddenHint";

describe("shouldShowSnoozedHiddenHint", () => {
  it("shows when includeSnoozed is off and there are snoozed rows in scope", () => {
    expect(shouldShowSnoozedHiddenHint({ includeSnoozed: false, snoozedHidden: 3 })).toBe(true);
  });

  it("hides when includeSnoozed is on", () => {
    expect(shouldShowSnoozedHiddenHint({ includeSnoozed: true, snoozedHidden: 3 })).toBe(false);
  });

  it("hides when there are no snoozed rows in scope", () => {
    expect(shouldShowSnoozedHiddenHint({ includeSnoozed: false, snoozedHidden: 0 })).toBe(false);
    expect(shouldShowSnoozedHiddenHint({ includeSnoozed: false, snoozedHidden: undefined })).toBe(false);
    expect(shouldShowSnoozedHiddenHint({ includeSnoozed: false, snoozedHidden: null })).toBe(false);
  });
});

describe("quote-requests page wiring", () => {
  const pageSource = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "pages", "quote-requests.tsx"),
    "utf8",
  );

  it("imports the resolver from the shared module", () => {
    expect(pageSource).toMatch(
      /shouldShowSnoozedHiddenHint.*from "@\/lib\/quoteRequestsSnoozedHiddenHint"/,
    );
  });

  it("renders the hint test IDs and the show button next to the include-snoozed toggle", () => {
    expect(pageSource).toContain('data-testid="toggle-include-snoozed"');
    expect(pageSource).toContain('data-testid="text-snoozed-hidden-hint"');
    expect(pageSource).toContain('data-testid="button-show-snoozed-hidden"');
  });

  it("the show button reuses setIncludeSnoozed (no separate action)", () => {
    expect(pageSource).toMatch(
      /onClick=\{\(\) => setIncludeSnoozed\(true\)\}[\s\S]{0,200}data-testid="button-show-snoozed-hidden"/,
    );
  });
});
