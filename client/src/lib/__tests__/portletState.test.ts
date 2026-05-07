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

describe("Trending + Margin freshness labeling — UI contract (Phase 1.5 S8)", () => {
  const ASOF_SRC = READ("components/dashboard/AsOfLabel.tsx");
  const TYPES_SRC = READ("pages/dashboard/types.ts");
  const DIR_SRC = READ("pages/dashboard/DirectorPortlets.tsx");
  const NAM_SRC = READ("pages/dashboard/NamPortlets.tsx");
  const AM_SRC = READ("pages/dashboard/AmPortlets.tsx");

  it("AsOfLabel exports a function with asOfLabel + freshness + testId props", () => {
    expect(ASOF_SRC).toMatch(/export function AsOfLabel/);
    expect(ASOF_SRC).toMatch(/asOfLabel\?:/);
    expect(ASOF_SRC).toMatch(/freshness\?:/);
    expect(ASOF_SRC).toMatch(/testId:\s*string/);
  });

  it("AsOfLabel uses the documented copy for stale + unknown branches", () => {
    expect(ASOF_SRC).toMatch(/Data may be stale — last monthly refresh/);
    expect(ASOF_SRC).toMatch(/Freshness unavailable/);
  });

  it("AsOfLabel never escalates unknown → stale (Task #1109a invariant)", () => {
    // The unknown-state tone arm must use the neutral muted tone, not amber.
    expect(ASOF_SRC).toMatch(/state === ["']unknown["']\s*\?\s*["']text-muted-foreground italic["']/);
    // Belt-and-suspenders: the unknown copy ("Freshness unavailable") must
    // be assigned alongside state='unknown', never alongside state='stale'.
    expect(ASOF_SRC).toMatch(/state\s*=\s*["']unknown["'][\s\S]*?Freshness unavailable/);
  });

  it("AsOfLabel emits data-asof-state on the rendered span for portlet specs", () => {
    expect(ASOF_SRC).toMatch(/data-asof-state=\{state\}/);
  });

  it("TrendingResponse + MarginMetrics types include optional asOfLabel + freshness", () => {
    expect(TYPES_SRC).toMatch(/TrendingResponse[^=]*=.*asOfLabel\?:\s*string\s*\|\s*null.*freshness\?:\s*PortletFreshness/);
    expect(TYPES_SRC).toMatch(/MarginMetrics[^=]*=.*asOfLabel\?:\s*string\s*\|\s*null.*freshness\?:\s*PortletFreshness/);
  });

  it("DirectorPortlets renders an AsOfLabel for trending-up, trending-down, and both margin groups", () => {
    expect(DIR_SRC).toMatch(/from\s+["']@\/components\/dashboard\/AsOfLabel["']/);
    expect(DIR_SRC).toMatch(/testId=["']trending-up-as-of-label["']/);
    expect(DIR_SRC).toMatch(/testId=["']trending-down-as-of-label["']/);
    expect(DIR_SRC).toMatch(/testId=\{`margin-\$\{group\}-as-of-label`\}/);
  });

  it("NamPortlets renders an AsOfLabel for both trending cards and the AM-margin card", () => {
    expect(NAM_SRC).toMatch(/from\s+["']@\/components\/dashboard\/AsOfLabel["']/);
    expect(NAM_SRC).toMatch(/testId=["']nam-trending-up-as-of-label["']/);
    expect(NAM_SRC).toMatch(/testId=["']nam-trending-down-as-of-label["']/);
    expect(NAM_SRC).toMatch(/testId=["']nam-margin-ams-as-of-label["']/);
  });

  it("AmPortlets renders an AsOfLabel for both trending cards", () => {
    expect(AM_SRC).toMatch(/from\s+["']@\/components\/dashboard\/AsOfLabel["']/);
    expect(AM_SRC).toMatch(/testId=["']am-trending-up-as-of-label["']/);
    expect(AM_SRC).toMatch(/testId=["']am-trending-down-as-of-label["']/);
  });
});

describe("Trending + Margin freshness labeling — server contract (Phase 1.5 S8)", () => {
  const SERVER_FRESH = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "server", "lib", "portletFreshness.ts"),
    "utf8",
  );
  const DASH_ROUTES = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "server", "routes", "dashboard.ts"),
    "utf8",
  );

  it("exports the pure financial-upload freshness derivation + label formatter", () => {
    expect(SERVER_FRESH).toMatch(/export function deriveFinancialUploadFreshness/);
    expect(SERVER_FRESH).toMatch(/export function formatAsOfUploadLabel/);
  });

  it("uses the canonical source label 'financial_uploads.uploadedAt'", () => {
    expect(SERVER_FRESH).toMatch(/["']financial_uploads\.uploadedAt["']/);
  });

  it("treats two-or-more months back as stale (1 month is the typical-cadence boundary)", () => {
    expect(SERVER_FRESH).toMatch(/monthsBack\s*>=\s*2/);
  });

  it("trending-accounts route includes asOfLabel + freshness in the response", () => {
    expect(DASH_ROUTES).toMatch(/res\.json\(\{ up, down, monthFraction, isPartialMonth, curMonthLabel, asOfLabel, freshness \}\)/);
  });

  it("trending-accounts collapses empty-rows fallback to null dataMonthKey (architect feedback) — never advertises calendar-month fallback as 'ok'", () => {
    expect(DASH_ROUTES).toMatch(/trendingDataMonthKey = sortedMonthKeys\.length > 0 \? curMonthKey : null/);
    expect(DASH_ROUTES).toMatch(/dataMonthKey: trendingDataMonthKey/);
  });

  it("margin-metrics route includes asOfLabel + freshness in the cached/returned object", () => {
    expect(DASH_ROUTES).toMatch(/const mmResult = \{ nams: namMetrics, ams: amMetrics, asOfLabel, freshness \}/);
  });

  it("trending-accounts no-upload branch still returns an honest unknown freshness", () => {
    expect(DASH_ROUTES).toMatch(/return res\.json\(\{[\s\S]*?up: \[\],[\s\S]*?freshness: deriveFinancialUploadFreshness/);
  });
});

describe("Pipeline health strip — UI contract (Phase 1.5 S9)", () => {
  const STRIP_SRC = READ("components/dashboard/PipelineHealthStrip.tsx");

  it("queries the dedicated /api/dashboard/health endpoint (does not piggyback on summary)", () => {
    expect(STRIP_SRC).toMatch(/queryKey:\s*\[["']\/api\/dashboard\/health["']\]/);
  });

  it("hides the strip for logistics roles (logistics_manager, logistics_coordinator)", () => {
    expect(STRIP_SRC).toMatch(/logistics_manager/);
    expect(STRIP_SRC).toMatch(/logistics_coordinator/);
    expect(STRIP_SRC).toMatch(/if \(isHidden\) return null/);
  });

  it("treats undefined role as hidden — closes the auth-load race (architect S9 review)", () => {
    // The gate must NOT default to visible while role is undefined,
    // otherwise logistics users briefly see + fetch the strip on first
    // paint (useAuth resolves async).
    expect(STRIP_SRC).toMatch(/if \(!role\) return true/);
  });

  it("disables the /api/dashboard/health query while hidden (no network leak for logistics)", () => {
    expect(STRIP_SRC).toMatch(/enabled:\s*!isHidden/);
  });

  it("renders the three documented per-source chips with stable testIds", () => {
    expect(STRIP_SRC).toMatch(/data-testid=\{`pipeline-health-\$\{testIdSuffix\}`\}/);
    expect(STRIP_SRC).toMatch(/testIdSuffix:\s*["']financials["']/);
    expect(STRIP_SRC).toMatch(/testIdSuffix:\s*["']nba["']/);
    expect(STRIP_SRC).toMatch(/testIdSuffix:\s*["']freight["']/);
  });

  it("encodes per-source state on each chip for downstream specs", () => {
    expect(STRIP_SRC).toMatch(/data-source-state=\{state\}/);
  });

  it("uses the rep-facing labels Financials / Recommendations / Freight", () => {
    expect(STRIP_SRC).toMatch(/label:\s*["']Financials["']/);
    expect(STRIP_SRC).toMatch(/label:\s*["']Recommendations["']/);
    expect(STRIP_SRC).toMatch(/label:\s*["']Freight["']/);
  });

  it("never paints unknown as amber — unknown uses muted/italic, stale uses amber (Task #1109a)", () => {
    // The unknown branch must NOT use amber.
    expect(STRIP_SRC).toMatch(/state === ["']unknown["']\s*\?\s*["']bg-muted-foreground\/40["']/);
    expect(STRIP_SRC).toMatch(/state === ["']unknown["']\s*\?\s*["']text-muted-foreground italic["']/);
    // The stale branch keeps amber.
    expect(STRIP_SRC).toMatch(/state === ["']stale["']\s*\?\s*["']bg-amber-500["']/);
  });

  it("dashboard.tsx mounts the strip and forwards the current user's role", () => {
    const DASH_SRC = READ("pages/dashboard.tsx");
    expect(DASH_SRC).toMatch(/from\s+["']@\/components\/dashboard\/PipelineHealthStrip["']/);
    expect(DASH_SRC).toMatch(/<PipelineHealthStrip role=\{currentUser\?\.role\}/);
  });
});

describe("Pipeline health strip — server contract (Phase 1.5 S9)", () => {
  const DASH_ROUTES = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "server", "routes", "dashboard.ts"),
    "utf8",
  );

  it("registers GET /api/dashboard/health behind requireAuth", () => {
    expect(DASH_ROUTES).toMatch(/app\.get\(["']\/api\/dashboard\/health["'],\s*requireAuth/);
  });

  it("returns the documented additive contract { financials, nba, freight }", () => {
    expect(DASH_ROUTES).toMatch(/res\.json\(\{ financials, nba, freight \}\)/);
  });

  it("each source is wrapped so one failure cannot take down the strip (per-source try/catch)", () => {
    expect(DASH_ROUTES).toMatch(/\[dashboard\/health\] financials lookup failed/);
    expect(DASH_ROUTES).toMatch(/\[dashboard\/health\] nba lookup failed/);
  });

  it("reuses the existing helpers — no new freshness derivation logic", () => {
    expect(DASH_ROUTES).toMatch(/deriveFinancialUploadFreshness\(\{[\s\S]*?uploadedAt:\s*upload\.uploadedAt/);
    expect(DASH_ROUTES).toMatch(/getFreshnessFromNbaCards\(orgId\)/);
    expect(DASH_ROUTES).toMatch(/safeLoadFactFreshness\(\)/);
  });

  it("freight unknown fallback preserves the canonical load_fact source label (no lying as ok/stale)", () => {
    expect(DASH_ROUTES).toMatch(/source: `\$\{JOB_NAMES\.loadFactImportMorning\},\$\{JOB_NAMES\.loadFactImportAfternoon\}`,\s*\n\s*status:\s*["']unknown["']/);
  });

  it("freight branch coerces safeLoadFactFreshness null → unknown (architect S9 isolation pin)", () => {
    // The route must NEVER let safeLoadFactFreshness's null escape onto
    // the wire — coerce to a unknown PortletFreshness so the per-source
    // failure isolation story is provable from the contract.
    const healthBlock = DASH_ROUTES.match(/app\.get\(["']\/api\/dashboard\/health["'][\s\S]*?res\.json\(\{ financials, nba, freight \}\)/);
    expect(healthBlock).not.toBeNull();
    expect(healthBlock![0]).toMatch(/const fr = await safeLoadFactFreshness\(\);[\s\S]*?if \(fr\) return fr;[\s\S]*?status:\s*["']unknown["']/);
  });

  it("does NOT add an emailFacts source in this slice (brief: omit if no honest signal)", () => {
    // Hard-pin: the health endpoint payload must not silently grow an
    // emailFacts field without a follow-up brief.
    const healthBlock = DASH_ROUTES.match(/app\.get\(["']\/api\/dashboard\/health["'][\s\S]*?res\.json\(\{ financials, nba, freight \}\)/);
    expect(healthBlock).not.toBeNull();
    expect(healthBlock![0]).not.toMatch(/emailFacts/);
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
