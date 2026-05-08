// Task #1149 — Mine Only banner survives a degraded snapshot.
//
// Behaviour-level coverage for the resolver that backs the Quote
// Requests page's honesty banner + toggle warning indicator. The
// page itself can't be rendered under vitest (the repo runs vitest
// in `environment: "node"` and intentionally does not ship
// @testing-library/react — see comment at the top of
// `client/src/lib/__tests__/workflowOsRowSelection.test.ts` for the
// project-wide convention), so the page-level logic was extracted
// into the pure module under test here. Both the page and these
// tests import from the same module, so a regression in the
// resolver flips the banner on the page in lockstep.
//
// Original Task #1007 bug (May 2026): the banner only read from
// `snapshotQuery.data?.mineOnlyMeta?.warningCode`. If the snapshot
// request 500'd / timed out while the list request succeeded, the
// banner silently disappeared even though the list response was
// still un-narrowed and carrying the same `warningCode`. Reps then
// saw more than they expected with no honest signal.
//
// What this test pins (the four acceptance scenarios from the task
// brief, plus the structural co-location of the toggle indicator):
//   1. Snapshot OK + warning  → banner shows.
//   2. Snapshot DEGRADED + list OK + warning  → banner STILL shows
//      (the original bug — this is the regression guard).
//   3. List DEGRADED + snapshot OK + warning  → banner STILL shows
//      (mirror case, also called out in the task brief).
//   4. Both sides have payloads but neither carries a warning code
//      → banner stays hidden.
//   5. Snapshot precedence: a fresh snapshot's NULL warning beats a
//      stale list's stale warning (so a newly-mapped rep doesn't
//      keep seeing the banner against an old list payload).
//   6. The page wires the toggle warning indicator
//      (`data-testid="indicator-mine-only-warning"`) to the same
//      predicate, in the same `toggle-mine-only` label — pinned via
//      a small structural read of the page source so the page can't
//      drift away from the resolver without this test catching it.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resolveEffectiveMineOnlyMeta,
  shouldShowMineOnlyWarning,
  type MineOnlyMeta,
} from "../quoteRequestsMineOnlyMeta";

const WARNING: MineOnlyMeta = {
  requested: true,
  applied: false,
  myRepId: null,
  warningCode: "NO_QUOTE_REP_MAPPING",
};

const HEALTHY: MineOnlyMeta = {
  requested: true,
  applied: true,
  myRepId: "rep-123",
  warningCode: null,
};

describe("Task #1149 — Mine Only banner survives degraded snapshot", () => {
  it("snapshot OK + warning → banner shows", () => {
    const meta = resolveEffectiveMineOnlyMeta(
      { mineOnlyMeta: WARNING },
      { mineOnlyMeta: WARNING },
    );
    expect(meta).toEqual(WARNING);
    expect(shouldShowMineOnlyWarning(meta)).toBe(true);
  });

  it("snapshot DEGRADED + list OK + warning → banner STILL shows (original bug)", () => {
    // Simulates `useQuery`'s state when snapshot fetch failed:
    // `snapshotQuery.data` is undefined while `listQuery.data` still
    // carries the warning code from a successful list response.
    const snapshotData = undefined;
    const listData = {
      rows: [],
      total: 0,
      offset: 0,
      limit: 50,
      mineOnlyMeta: WARNING,
    };

    const meta = resolveEffectiveMineOnlyMeta(snapshotData, listData);
    expect(meta).toEqual(WARNING);
    expect(shouldShowMineOnlyWarning(meta)).toBe(true);
  });

  it("list DEGRADED + snapshot OK + warning → banner STILL shows (mirror case)", () => {
    const snapshotData = { mineOnlyMeta: WARNING };
    const listData = undefined;

    const meta = resolveEffectiveMineOnlyMeta(snapshotData, listData);
    expect(meta).toEqual(WARNING);
    expect(shouldShowMineOnlyWarning(meta)).toBe(true);
  });

  it("both sides have payloads but no warning → banner stays hidden", () => {
    const meta = resolveEffectiveMineOnlyMeta(
      { mineOnlyMeta: HEALTHY },
      { mineOnlyMeta: HEALTHY },
    );
    expect(shouldShowMineOnlyWarning(meta)).toBe(false);
  });

  it("both sides missing meta → banner stays hidden", () => {
    expect(shouldShowMineOnlyWarning(resolveEffectiveMineOnlyMeta(undefined, undefined))).toBe(
      false,
    );
    expect(shouldShowMineOnlyWarning(resolveEffectiveMineOnlyMeta({}, {}))).toBe(false);
  });

  it("snapshot precedence: fresh healthy snapshot outvotes a stale warning list", () => {
    // A rep was just mapped to a quote_reps row → fresh snapshot
    // returns warningCode: null, but the cached list response still
    // carries the old WARNING. The banner must defer to the snapshot
    // (Task #1007 steady state) and stay hidden.
    const meta = resolveEffectiveMineOnlyMeta(
      { mineOnlyMeta: HEALTHY },
      { mineOnlyMeta: WARNING },
    );
    expect(meta).toEqual(HEALTHY);
    expect(shouldShowMineOnlyWarning(meta)).toBe(false);
  });

  it("predicate strictly checks NO_QUOTE_REP_MAPPING — unknown codes do not light the banner", () => {
    // Future-proofing: if the server ever adds a new warningCode the
    // UI hasn't been taught about, the banner should NOT silently
    // claim the rep is unmapped. The page wires its own UI for
    // future codes; this predicate is the unmapped-only gate.
    const meta = {
      ...WARNING,
      // @ts-expect-error — intentionally simulating a forward-compat code
      warningCode: "SOME_FUTURE_CODE",
    } as MineOnlyMeta;
    expect(shouldShowMineOnlyWarning(meta)).toBe(false);
  });
});

// ---------------------------------------------------------------
// Page wiring guard — the page must use the resolver/predicate so
// the runtime tests above actually reflect what users see. This is
// the smallest structural pin needed to keep the page and the
// resolver in lockstep; the behaviour itself is exercised above.
// ---------------------------------------------------------------

describe("Task #1149 — page wires the resolver into the banner + toggle indicator", () => {
  const PAGE_SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "pages", "quote-requests.tsx"),
    "utf8",
  );

  it("imports the resolver from the shared module", () => {
    expect(PAGE_SRC).toMatch(/resolveEffectiveMineOnlyMeta/);
    expect(PAGE_SRC).toMatch(/from "@\/lib\/quoteRequestsMineOnlyMeta"/);
  });

  it("page inlines the warning-code literal at the top-level predicate (Section 1007 guardrail)", () => {
    // The guardrail at tests/code-quality-guardrails.test.ts §1007
    // pins the literal `warningCode === "NO_QUOTE_REP_MAPPING"` in
    // the page source. Keep the inline check next to the resolver.
    expect(PAGE_SRC).toMatch(
      /showMineOnlyWarning\s*=\s*\n?\s*effectiveMineOnlyMeta\?\.warningCode\s*===\s*"NO_QUOTE_REP_MAPPING"/,
    );
  });

  it("banner is gated on the predicate (not the legacy raw-snapshot expression)", () => {
    // Task #1170 widened the banner's gate from `showMineOnlyWarning`
    // to `showMineOnlyBanner` (warning AND not session-dismissed) —
    // either still satisfies the Task #1149 contract because the
    // dismiss state is computed from the same warning predicate.
    expect(PAGE_SRC).toMatch(
      /\{showMineOnlyBanner && \(\s*\n\s*<div[\s\S]{0,400}data-testid="banner-mine-only-no-rep"/,
    );
    // The original Task #1007 expression is the bug — must not
    // re-appear as a render gate.
    expect(PAGE_SRC).not.toMatch(
      /\{snapshotQuery\.data\?\.mineOnlyMeta\?\.warningCode === "NO_QUOTE_REP_MAPPING" && \(/,
    );
    // showMineOnlyBanner must only narrow the showMineOnlyWarning
    // signal — never widen it.
    expect(PAGE_SRC).toMatch(
      /showMineOnlyBanner\s*=\s*\n?\s*showMineOnlyWarning\s*&&/,
    );
  });

  it("Task #1170 — banner exposes a per-session dismiss control wired to dismissMineOnlyBanner", () => {
    expect(PAGE_SRC).toMatch(/data-testid="button-mine-only-dismiss"/);
    // The dismiss state must be persisted in sessionStorage (not
    // localStorage — it's a per-session escape hatch, not a permanent
    // hide) and keyed by the active warning code so the banner re-
    // opens automatically if the warning re-appears for a different
    // reason in the future.
    expect(PAGE_SRC).toMatch(/window\.sessionStorage\.setItem\(\s*mineOnlyBannerDismissKey/);
    expect(PAGE_SRC).toMatch(/window\.sessionStorage\.removeItem\(\s*mineOnlyBannerDismissKey/);
    expect(PAGE_SRC).not.toMatch(/localStorage\.setItem\([^)]*mineOnly/i);
  });

  it("Task #1171 — list fetch errors surface a thin retry strip with a refetch handler", () => {
    expect(PAGE_SRC).toMatch(/data-testid="strip-list-error"/);
    expect(PAGE_SRC).toMatch(/data-testid="button-list-error-retry"/);
    // The retry button must call listQuery.refetch() (NOT a window
    // reload, NOT a router navigation) so the surrounding page state
    // — filters, mineOnly toggle, drilldown chips — is preserved.
    expect(PAGE_SRC).toMatch(/onClick=\{\(\) => listQuery\.refetch\(\)\}/);
    // The strip must be gated on listQuery.isError specifically (not
    // a generic error state) so a stale-data render doesn't flash
    // the strip during a normal refetch.
    expect(PAGE_SRC).toMatch(/\{listQuery\.isError && \(/);
  });

  it("toggle warning indicator is co-located in the toggle-mine-only label and gated on the same predicate", () => {
    const toggleBlock = PAGE_SRC.match(
      /data-testid="toggle-mine-only"[\s\S]{0,1500}?<\/label>/,
    );
    expect(toggleBlock, "toggle-mine-only label block not found").toBeTruthy();
    expect(toggleBlock![0]).toMatch(/showMineOnlyWarning/);
    expect(toggleBlock![0]).toMatch(/data-testid="indicator-mine-only-warning"/);
  });
});
