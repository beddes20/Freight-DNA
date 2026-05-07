// Phase 1.5 S6 — Portlet visibility decision contract.
//
// Two-part suite:
//  1. Pure unit tests on decidePortletState() — the helper that drives
//     the new banner branches in AwardHealthPortlet + CoverageGapsPortlet.
//  2. AST contract tests against both portlet files (vitest is wired to
//     a node environment in this repo, so we pin the JSX contract by
//     reading the source like EmptyStateRecovery.test.ts does).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { decidePortletState } from "../portletState";

const fresh = (status: "ok" | "stale" | "unknown") => ({
  source: "load_fact_import_morning",
  status,
  lastUpdatedAt: new Date().toISOString(),
  nextExpectedAt: null,
  consecutiveFailures: 0,
});

describe("decidePortletState", () => {
  it("rows: any non-zero count short-circuits, regardless of freshness", () => {
    expect(decidePortletState(5, null)).toBe("rows");
    expect(decidePortletState(1, fresh("stale"))).toBe("rows");
    expect(decidePortletState(3, fresh("unknown"))).toBe("rows");
    expect(decidePortletState(2, fresh("ok"))).toBe("rows");
  });

  it("hidden: empty + healthy upstream = legacy hide-on-empty", () => {
    expect(decidePortletState(0, fresh("ok"))).toBe("hidden");
  });

  it("hidden: empty + no freshness signal = hide (legacy / pre-S3 server)", () => {
    expect(decidePortletState(0, null)).toBe("hidden");
    expect(decidePortletState(0, undefined)).toBe("hidden");
  });

  it("stale: empty + freshness.status='stale' = degraded banner", () => {
    expect(decidePortletState(0, fresh("stale"))).toBe("stale");
  });

  it("unknown: empty + freshness.status='unknown' = neutral banner (NEVER escalate to stale)", () => {
    expect(decidePortletState(0, fresh("unknown"))).toBe("unknown");
  });
});

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, "..", "..", rel), "utf8");

const AWARD_SRC = READ("pages/dashboard/AwardHealthPortlet.tsx");
const GAPS_SRC = READ("pages/dashboard/CoverageGapsPortlet.tsx");
const HELPER_SRC = READ("lib/portletState.ts");
const BANNER_SRC = READ("components/dashboard/PortletStateBanner.tsx");
const NBA_SRC = READ("components/NbaDashboardPanel.tsx");

describe("AwardHealthPortlet — freshness banner contract", () => {
  it("imports the shared decideBannerState helper + banner component", () => {
    expect(AWARD_SRC).toMatch(/from\s+["']@\/lib\/portletState["']/);
    expect(AWARD_SRC).toMatch(/from\s+["']@\/components\/dashboard\/PortletStateBanner["']/);
  });

  it("extracts freshness from the normalized response shape", () => {
    expect(AWARD_SRC).toMatch(/freshness.*=.*data\?\.freshness/);
  });

  it("calls decidePortletState with awards.length + freshness", () => {
    expect(AWARD_SRC).toMatch(/decidePortletState\(awards\.length,\s*freshness\)/);
  });

  it("renders a stale banner with the documented copy", () => {
    expect(AWARD_SRC).toMatch(/state=["']stale["']/);
    expect(AWARD_SRC).toMatch(/Award health may be stale/);
  });

  it("renders an unknown banner with the documented copy", () => {
    expect(AWARD_SRC).toMatch(/state=["']unknown["']/);
    expect(AWARD_SRC).toMatch(/Award freshness unavailable/);
  });

  it("preserves the hide-on-empty branch for healthy upstream", () => {
    expect(AWARD_SRC).toMatch(/portletState === ["']hidden["']\)\s*return null/);
  });
});

describe("CoverageGapsPortlet — freshness banner contract", () => {
  it("imports the shared decideBannerState helper + banner component", () => {
    expect(GAPS_SRC).toMatch(/from\s+["']@\/lib\/portletState["']/);
    expect(GAPS_SRC).toMatch(/from\s+["']@\/components\/dashboard\/PortletStateBanner["']/);
  });

  it("extracts freshness from the normalized response shape", () => {
    expect(GAPS_SRC).toMatch(/freshness.*=.*data\?\.freshness/);
  });

  it("calls decidePortletState with gaps.length + freshness", () => {
    expect(GAPS_SRC).toMatch(/decidePortletState\(gaps\.length,\s*freshness\)/);
  });

  it("renders a stale banner with the documented copy", () => {
    expect(GAPS_SRC).toMatch(/state=["']stale["']/);
    expect(GAPS_SRC).toMatch(/Coverage data may be stale/);
  });

  it("renders an unknown banner with the documented copy", () => {
    expect(GAPS_SRC).toMatch(/state=["']unknown["']/);
    expect(GAPS_SRC).toMatch(/Coverage freshness unavailable/);
  });

  it("preserves the hide-on-empty branch for healthy upstream", () => {
    expect(GAPS_SRC).toMatch(/portletState === ["']hidden["']\)\s*return null/);
  });
});

describe("PortletStateBanner — shared component contract", () => {
  it("exports a PortletStateBanner function with state + testIdPrefix props", () => {
    expect(BANNER_SRC).toMatch(/export function PortletStateBanner/);
    expect(BANNER_SRC).toMatch(/state:\s*["']stale["']\s*\|\s*["']unknown["']/);
    expect(BANNER_SRC).toMatch(/testIdPrefix:\s*string/);
  });

  it("renders a stable banner testid keyed off testIdPrefix", () => {
    expect(BANNER_SRC).toMatch(/data-testid=\{`\$\{testIdPrefix\}-banner`\}/);
  });

  it("encodes the state on the rendered card for portlet specs to assert against", () => {
    expect(BANNER_SRC).toMatch(/data-portlet-state=\{state\}/);
  });
});

describe("NbaDashboardPanel — freshness banner contract (Phase 1.5 S7)", () => {
  it("imports the shared decideBannerState helper + banner component", () => {
    expect(NBA_SRC).toMatch(/from\s+["']@\/lib\/portletState["']/);
    expect(NBA_SRC).toMatch(/from\s+["']@\/components\/dashboard\/PortletStateBanner["']/);
  });

  it("normalizes both legacy bare-array and new envelope response shapes", () => {
    expect(NBA_SRC).toMatch(/Array\.isArray\(data\)\s*\?\s*data\s*:\s*\(data\?\.cards/);
    expect(NBA_SRC).toMatch(/freshness.*=.*Array\.isArray\(data\).*data\?\.freshness/);
  });

  it("calls decidePortletState with visible.length + freshness (mirrors what the rep actually sees)", () => {
    expect(NBA_SRC).toMatch(/decidePortletState\(visible\.length,\s*freshness\)/);
  });

  it("renders a stale banner with the documented copy", () => {
    expect(NBA_SRC).toMatch(/state=["']stale["']/);
    expect(NBA_SRC).toMatch(/Recommendations may be stale/);
    expect(NBA_SRC).toMatch(/recommendation refresh looks unhealthy/);
  });

  it("renders an unknown banner with the documented copy", () => {
    expect(NBA_SRC).toMatch(/state=["']unknown["']/);
    expect(NBA_SRC).toMatch(/Recommendation freshness unavailable/);
    expect(NBA_SRC).toMatch(/dashboard freshness could not be verified/);
  });

  it("preserves the hide-on-empty branch for healthy upstream and missing freshness", () => {
    expect(NBA_SRC).toMatch(/portletState === ["']hidden["']\)\s*return null/);
  });

  it("uses 'nba' as the testIdPrefix for both banner branches", () => {
    expect(NBA_SRC).toMatch(/testIdPrefix=["']nba["']/);
  });
});

describe("getFreshnessFromNbaCards — server helper contract (Phase 1.5 S7)", () => {
  const SERVER_SRC = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "server", "lib", "portletFreshness.ts"),
    "utf8",
  );

  it("exports the data-driven NBA freshness helper", () => {
    expect(SERVER_SRC).toMatch(/export async function getFreshnessFromNbaCards/);
  });

  it("uses the canonical source label 'nba_cards.createdAt'", () => {
    expect(SERVER_SRC).toMatch(/["']nba_cards\.createdAt["']/);
  });

  it("defaults the staleness threshold to 24h", () => {
    expect(SERVER_SRC).toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("derives latest timestamp via Postgres MAX on nbaCards.createdAt", () => {
    expect(SERVER_SRC).toMatch(/MAX\(\$\{nbaCards\.createdAt\}\)/);
  });

  it("collapses zero rows and DB read failure to status='unknown' (NEVER throws)", () => {
    // unknown branch on no rows
    expect(SERVER_SRC).toMatch(/if \(!latestIso\) return unknownFreshness\(NBA_FRESHNESS_SOURCE\)/);
    // try/catch around the DB read
    expect(SERVER_SRC).toMatch(/\[portletFreshness\] nba_cards read failed/);
  });

  it("nba/cards route wires freshness via the safe await-import + try/catch envelope", () => {
    const ROUTES_SRC = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "server", "routes.ts"),
      "utf8",
    );
    expect(ROUTES_SRC).toMatch(/getFreshnessFromNbaCards.*currentUser\.organizationId/);
    expect(ROUTES_SRC).toMatch(/res\.json\(\{ cards: projected, freshness \}\)/);
    // Defensive: failure path must collapse to freshness:null, not 500
    expect(ROUTES_SRC).toMatch(/\[nba\/cards GET\] freshness lookup failed/);
  });
});

describe("portletState helper — Task #1109a contract", () => {
  it("never collapses unknown into stale", () => {
    // Statically assert the unknown branch returns "unknown", not "stale".
    expect(HELPER_SRC).toMatch(/freshness\.status === ["']unknown["']\)\s*return\s+["']unknown["']/);
    // Belt-and-suspenders: behavior assertion (already covered above).
    expect(decidePortletState(0, fresh("unknown"))).not.toBe("stale");
  });
});
