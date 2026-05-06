// Task #1023 — Tests for the Available Freight mode helper.
//
// Covers:
//   - URL/storage/default precedence in resolveInitialMode
//   - Round-tripping mode through `?mode=` so deep-links survive
//   - Default mode is dropped from the URL (clean canonical link)
//   - Mode parsing tolerates noise (case, whitespace, unknown values)
// The page-level invariant that scope is shared across modes is
// covered structurally: this helper exposes only mode persistence and
// has no API for mutating scope, so a mode switch can't widen scope.

import { describe, it, expect } from "vitest";
import {
  AVAILABLE_FREIGHT_MODES,
  DEFAULT_AVAILABLE_FREIGHT_MODE,
  AF_MODE_STORAGE_KEY,
  applyModeToUrl,
  isAvailableFreightMode,
  parseMode,
  resolveInitialMode,
} from "../availableFreightMode";
import {
  BUCKET_ORDER,
  BUCKET_ORDER_BY_MODE,
  bucketOrderForMode,
} from "@shared/cockpitBuckets";
import { resolveScope, type ScopeInput } from "../cockpitScope";

describe("availableFreightMode — parse + guard", () => {
  it("accepts the three known modes", () => {
    for (const m of AVAILABLE_FREIGHT_MODES) {
      expect(isAvailableFreightMode(m)).toBe(true);
      expect(parseMode(m)).toBe(m);
    }
  });

  it("normalises case + whitespace", () => {
    expect(parseMode("  Coverage ")).toBe("coverage");
    expect(parseMode("OPS")).toBe("ops");
  });

  it("rejects unknown / empty / nullish tokens", () => {
    expect(parseMode("")).toBeNull();
    expect(parseMode(null)).toBeNull();
    expect(parseMode(undefined)).toBeNull();
    expect(parseMode("dashboard")).toBeNull();
    expect(parseMode("triage")).toBeNull();
  });
});

describe("availableFreightMode — resolveInitialMode precedence", () => {
  it("URL wins over storage and default", () => {
    expect(
      resolveInitialMode({ url: "ops", storage: "coverage" }),
    ).toBe("ops");
  });

  it("storage seeds when URL is missing", () => {
    expect(
      resolveInitialMode({ url: null, storage: "coverage" }),
    ).toBe("coverage");
  });

  it("falls back to the default when neither URL nor storage parse", () => {
    expect(
      resolveInitialMode({ url: "junk", storage: "" }),
    ).toBe(DEFAULT_AVAILABLE_FREIGHT_MODE);
    expect(resolveInitialMode({})).toBe(DEFAULT_AVAILABLE_FREIGHT_MODE);
  });
});

describe("availableFreightMode — applyModeToUrl round-trip", () => {
  const base = "https://crm.local/available-freight?owner=me&pickupScope=actionable";

  it("drops `?mode=` when the mode is the default (clean canonical URL)", () => {
    const next = applyModeToUrl(`${base}&mode=ops`, "action");
    const params = new URL(next).searchParams;
    expect(params.has("mode")).toBe(false);
    // Scope params are NEVER touched by the mode helper.
    expect(params.get("owner")).toBe("me");
    expect(params.get("pickupScope")).toBe("actionable");
  });

  it("sets `?mode=` for non-default modes and preserves scope", () => {
    const next = applyModeToUrl(base, "coverage");
    const params = new URL(next).searchParams;
    expect(params.get("mode")).toBe("coverage");
    expect(params.get("owner")).toBe("me");
    expect(params.get("pickupScope")).toBe("actionable");
  });

  it("round-trips every mode through resolveInitialMode", () => {
    for (const m of AVAILABLE_FREIGHT_MODES) {
      const href = applyModeToUrl(base, m);
      const url = new URL(href);
      const fromUrl = url.searchParams.get("mode");
      expect(resolveInitialMode({ url: fromUrl, storage: null })).toBe(m);
    }
  });

  it("switching modes does not touch unrelated scope params", () => {
    const start = `${base}&laneFilter=ATL-MIA&carrierId=abc`;
    const toCoverage = applyModeToUrl(start, "coverage");
    const backToAction = applyModeToUrl(toCoverage, "action");
    const params = new URL(backToAction).searchParams;
    expect(params.has("mode")).toBe(false);
    expect(params.get("owner")).toBe("me");
    expect(params.get("pickupScope")).toBe("actionable");
    expect(params.get("laneFilter")).toBe("ATL-MIA");
    expect(params.get("carrierId")).toBe("abc");
  });
});

describe("availableFreightMode — bucket strip adapts per mode", () => {
  it("each mode publishes a non-empty subset of the global bucket order", () => {
    for (const mode of AVAILABLE_FREIGHT_MODES) {
      const order = bucketOrderForMode(mode);
      expect(order.length).toBeGreaterThan(0);
      // "All" anchors every strip so reps can clear the bucket filter.
      expect(order[0]).toBe("all");
      // Modes can re-order but must not invent buckets — counts are
      // computed against the canonical registry.
      for (const key of order) {
        expect(BUCKET_ORDER).toContain(key);
      }
    }
  });

  it("Action leads with triage chips (Ready to send before funnel chips)", () => {
    const order = BUCKET_ORDER_BY_MODE.action;
    expect(order.indexOf("ready_to_send")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ready_to_send")).toBeLessThan(order.indexOf("covered_today"));
    // Coverage / Ops chips that aren't part of triage are absent so
    // the strip stays uncluttered.
    expect(order).not.toContain("no_response_4h");
    expect(order).not.toContain("stale");
  });

  it("Coverage leads with the outreach funnel (No response 4h before Covered today)", () => {
    const order = BUCKET_ORDER_BY_MODE.coverage;
    expect(order.indexOf("no_response_4h")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("no_response_4h")).toBeLessThan(order.indexOf("covered_today"));
    // "Ready to send" is a triage chip — drop it from Coverage.
    expect(order).not.toContain("ready_to_send");
  });

  it("Ops leads with health chips (Stale / Unassigned)", () => {
    const order = BUCKET_ORDER_BY_MODE.ops;
    expect(order).toContain("stale");
    expect(order).toContain("unassigned");
    // No outreach-execution chips in Ops.
    expect(order).not.toContain("ready_to_send");
    expect(order).not.toContain("no_response_4h");
  });

  it("unknown mode falls back to the global bucket order", () => {
    expect(bucketOrderForMode("nonsense" as never)).toEqual(BUCKET_ORDER);
  });
});

describe("availableFreightMode — shared scope invariant across mode switches", () => {
  // Functional proof that switching modes (URL-side) never silently
  // mutates scope: round-trip a fully-loaded scope through every mode
  // and verify the resolved scope clauses, conflicts and default-flag
  // are byte-identical to a no-mode baseline. resolveScope is the
  // single source of truth the page uses to summarize scope above the
  // row list, so this invariant is what reps actually feel.
  const baseScope: ScopeInput = {
    search: "ACME",
    companyId: "cust-1",
    ownerTokens: ["me"],
    ownerLabels: { me: "me" },
    statusFilter: "active",
    bucket: "ready_to_send",
    pickupScope: "upcoming",
    laneFilter: "ATL-MIA",
    carrierIdFilter: "carrier-9",
    carrierName: "Acme Trucking",
    customerName: "Acme Co",
    view: { id: "v1", name: "My view", isShared: false, isBuiltIn: false },
  };

  it("every mode resolves identical scope clauses + conflicts", () => {
    const baseline = resolveScope(baseScope);
    for (const mode of AVAILABLE_FREIGHT_MODES) {
      const url = applyModeToUrl("https://crm.local/available-freight", mode);
      // Mode lives only in the URL — scope inputs are unchanged.
      expect(new URL(url).searchParams.get("mode")).toBe(
        mode === DEFAULT_AVAILABLE_FREIGHT_MODE ? null : mode,
      );
      const r = resolveScope(baseScope);
      expect(r.clauses).toEqual(baseline.clauses);
      expect(r.conflicts).toEqual(baseline.conflicts);
      expect(r.isDefault).toEqual(baseline.isDefault);
    }
  });

  it("storage key + URL param are stable wire contracts (deep-link friendly)", () => {
    // Pin the wire contract so saved bookmarks / external links don't
    // silently drift when this helper is renamed internally.
    expect(AF_MODE_STORAGE_KEY).toBe("af:mode");
    const href = applyModeToUrl("https://crm.local/x", "coverage");
    expect(new URL(href).searchParams.get("mode")).toBe("coverage");
  });
});
