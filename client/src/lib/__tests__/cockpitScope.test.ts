// Task #1020 — Available Freight: One scope, one truth.
//
// Pure-data tests over the `resolveScope` / `detectScopeConflicts` /
// `summarizeScope` helpers that drive the visible Scope Summary above the
// row list. Page rendering is covered separately by the e2e suite; these
// tests pin the contracts the page leans on.

import { describe, it, expect } from "vitest";
import {
  resolveScope,
  detectScopeConflicts,
  summarizeScope,
  type ScopeInput,
} from "../cockpitScope";
import {
  applyCockpitFilters,
  type CockpitFilterItem,
} from "../cockpitFilters";
import {
  countBuckets,
  kpisFromFiltered,
  type BucketEvalContext,
  type BucketEvalRow,
} from "@shared/cockpitBuckets";

function baseInput(over: Partial<ScopeInput> = {}): ScopeInput {
  return {
    search: "",
    companyId: "all",
    ownerTokens: [],
    ownerLabels: {},
    statusFilter: "active",
    bucket: "all",
    pickupScope: "actionable",
    laneFilter: null,
    carrierIdFilter: null,
    carrierName: null,
    customerName: null,
    view: null,
    ...over,
  };
}

describe("resolveScope — operational default", () => {
  it("flags the operational default with a single pickup-scope clause", () => {
    const r = resolveScope(baseInput());
    expect(r.isDefault).toBe(true);
    expect(r.clauses.map((c) => c.dimension)).toEqual(["pickupScope"]);
    expect(r.clauses[0].clearable).toBe(false); // can't clear the default
    expect(r.conflicts).toEqual([]);
  });

  it("summarizeScope returns the friendly default sentence", () => {
    const r = resolveScope(baseInput());
    expect(summarizeScope(r)).toMatch(/operational default/i);
  });
});

describe("resolveScope — page clauses", () => {
  it("emits a removable clause per page-level filter", () => {
    const r = resolveScope(
      baseInput({
        search: "atlanta",
        companyId: "cust-1",
        customerName: "Acme",
        ownerTokens: ["me", "team:east"],
        ownerLabels: { me: "me", "team:east": "East team" },
        statusFilter: "ready_to_send",
        bucket: "ready_to_send",
        pickupScope: "recent",
        laneFilter: "ATL→DAL",
        carrierIdFilter: "carr-1",
        carrierName: "Acme Logistics",
      }),
    );
    const dims = r.clauses.map((c) => c.dimension);
    expect(dims).toEqual([
      "pickupScope",
      "search",
      "customer",
      "owner",
      "owner",
      "status",
      "bucket",
      "lane",
      "carrier",
    ]);
    for (const c of r.clauses) {
      expect(c.source).toBe("page");
      expect(c.clearable).toBe(true);
    }
    expect(r.isDefault).toBe(false);
  });

  it("renders the customer/carrier display names when provided", () => {
    const r = resolveScope(
      baseInput({
        companyId: "cust-1",
        customerName: "Acme",
        carrierIdFilter: "carr-1",
        carrierName: "Acme Logistics",
      }),
    );
    const labels = r.clauses.map((c) => c.label);
    expect(labels).toContain("Customer: Acme");
    expect(labels).toContain("Carrier: Acme Logistics");
  });
});

describe("resolveScope — saved view (replace vs merge)", () => {
  const base: ScopeInput = baseInput({
    view: {
      id: "v-mft",
      name: "My freight today",
      mergeMode: "replace",
      extras: {
        pickupWithinHours: 24,
        sentNoReplyMinAgeMin: 240,
      },
    },
  });

  it("replace mode shows just the view header (no extras-as-clauses)", () => {
    const r = resolveScope(base);
    const viewClause = r.clauses.find((c) => c.dimension === "view");
    expect(viewClause).toBeDefined();
    expect(viewClause!.label).toBe("View: My freight today");
    // None of the view's extras render as separate clauses in replace mode.
    expect(r.clauses.find((c) => c.dimension === "viewExtra")).toBeUndefined();
  });

  it("merge mode renders 'Merged with view: …' + a clause per view extra", () => {
    const r = resolveScope({ ...base, view: { ...base.view!, mergeMode: "merge" } });
    const viewClause = r.clauses.find((c) => c.dimension === "view");
    expect(viewClause!.label).toBe("Merged with view: My freight today");
    const extraDims = r.clauses.filter((c) => c.dimension === "viewExtra").map((c) => c.label);
    expect(extraDims).toContain("View rule: pickup ≤24h");
    expect(extraDims).toContain("View rule: sent ≥240m, no reply");
  });

  it("merge-mode extras carry view provenance and are NOT clearable individually", () => {
    const r = resolveScope({ ...base, view: { ...base.view!, mergeMode: "merge" } });
    for (const c of r.clauses.filter((c) => c.dimension === "viewExtra")) {
      expect(c.source).toBe("view");
      expect(c.viewName).toBe("My freight today");
      expect(c.clearable).toBe(false);
    }
  });
});

describe("detectScopeConflicts", () => {
  it("flags pickup_today + pickupAfterHours≥24 as page-wins", () => {
    const conflicts = detectScopeConflicts(
      baseInput({
        bucket: "pickup_today",
        view: {
          id: "v-tomorrow",
          name: "Pickup tomorrow",
          mergeMode: "merge",
          extras: { pickupAfterHours: 24 },
        },
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].resolution).toBe("page-wins");
    expect(conflicts[0].dimension).toBe("bucket");
  });

  it("flags pickup_tomorrow + pickupWithinHours≤24 as page-wins", () => {
    const conflicts = detectScopeConflicts(
      baseInput({
        bucket: "pickup_tomorrow",
        view: {
          id: "v-today",
          name: "My freight today",
          mergeMode: "merge",
          extras: { pickupWithinHours: 24 },
        },
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].key).toBe("bucket-vs-pickupWithinHours");
  });

  it("ignores conflicts in replace mode (extras are dropped)", () => {
    const conflicts = detectScopeConflicts(
      baseInput({
        bucket: "pickup_today",
        view: {
          id: "v-tomorrow",
          name: "Pickup tomorrow",
          mergeMode: "replace",
          extras: { pickupAfterHours: 24 },
        },
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("returns no conflicts when bucket and view extras agree", () => {
    const conflicts = detectScopeConflicts(
      baseInput({
        bucket: "ready_to_send",
        view: {
          id: "v-mft",
          name: "My freight today",
          mergeMode: "merge",
          extras: { pickupWithinHours: 24 },
        },
      }),
    );
    expect(conflicts).toEqual([]);
  });
});

describe("ResolvedScope clause provenance", () => {
  it("a saved-view + page-bucket scope renders both clauses with distinct sources", () => {
    const r = resolveScope(
      baseInput({
        bucket: "ready_to_send",
        view: {
          id: "v-mft",
          name: "My freight today",
          mergeMode: "merge",
          extras: { pickupWithinHours: 24 },
        },
      }),
    );
    const view = r.clauses.find((c) => c.dimension === "view")!;
    const bucket = r.clauses.find((c) => c.dimension === "bucket")!;
    expect(view.source).toBe("view");
    expect(bucket.source).toBe("page");
    expect(view.label).toMatch(/Merged with view/);
    expect(bucket.label).toMatch(/ready_to_send|Ready/);
  });
});

// ------------------------------------------------------------------
// Counts-agree invariant (Task #1020 §2 + §6)
//
// The page contract is that KPIs / bucket-counts / row count all derive
// from the SAME post-filter collection. We re-prove the contract here at
// the helper level by piping the same input through every consumer and
// asserting they line up.
// ------------------------------------------------------------------

const TODAY = "2026-04-24";

function mkRow(overrides: Partial<BucketEvalRow["opportunity"]> = {}, extras: Partial<BucketEvalRow> = {}): BucketEvalRow & CockpitFilterItem {
  return {
    opportunity: {
      id: Math.random().toString(36).slice(2),
      origin: "Chicago, IL",
      destination: "Atlanta, GA",
      equipmentType: "DRY",
      status: "ready_to_send",
      pickupWindowStart: null,
      coveredAt: null,
      ...overrides,
    } as CockpitFilterItem["opportunity"],
    coverage: { sent: 0, responded: 0, covered: false },
    freshnessMinutes: 0,
    ownership: { ids: ["me-id"], emails: [] },
    owner: { id: "me-id" },
    chips: [],
    suggestedBuy: null,
    ...extras,
  } as BucketEvalRow & CockpitFilterItem;
}

describe("counts-agree invariant: KPIs / bucket counts / row count come from one filtered collection", () => {
  it("for an arbitrary scope, kpisFromFiltered(filtered).total === filtered.length === countBuckets(filtered).all", () => {
    const ctx: BucketEvalContext = {
      todayIso: TODAY,
      currentUserId: "me-id",
      myTeamUserIds: new Set(["me-id"]),
    };
    const rows = [
      mkRow({ status: "ready_to_send", pickupWindowStart: `${TODAY}T18:00:00Z` }),
      mkRow({ status: "ready_to_send" }),
      mkRow({ status: "new" }),
      mkRow({ status: "covered", coveredAt: `${TODAY}T01:00:00Z` }, { coverage: { sent: 1, responded: 1, covered: true } }),
      mkRow({ status: "pending_approval" }),
    ] as Array<BucketEvalRow & CockpitFilterItem>;

    // "filtered" collection: status=active + bucket=ready_to_send.
    const filtered = applyCockpitFilters(
      rows as unknown as CockpitFilterItem[],
      "",
      { bucket: "ready_to_send", statuses: ["ready_to_send", "new", "pending_approval", "sent"] },
      null,
      Date.now(),
    );

    const kpis = kpisFromFiltered(filtered as unknown as BucketEvalRow[], ctx);
    const counts = countBuckets(filtered as unknown as BucketEvalRow[], ctx);

    expect(kpis.total).toBe(filtered.length);
    expect(counts.all).toBe(filtered.length);
    // Filter narrowed to ready_to_send → kpis.readyToSend === filtered.length.
    expect(kpis.readyToSend).toBe(filtered.length);
  });
});

describe("resolveScope — per-clause view removal preserves other clauses", () => {
  // Task #1020 — clearing the saved-view clause from the Scope Summary
  // (or hitting the conflict "Drop view" action) must ONLY deactivate the
  // view. Unrelated page filters (search, customer, owner, status, bucket,
  // lane, carrier, pickup) must remain intact. The page wires this to
  // `deactivateViewOnly` (sets activeViewId=null + viewMergeMode=replace);
  // here we pin the data contract by asserting that re-resolving with
  // `view: null` while every other input is preserved yields an identical
  // non-view clause set.
  it("drops only view clauses when view is removed; page filters survive", () => {
    const withView = baseInput({
      search: "frozen",
      companyId: "cust-1",
      ownerTokens: ["user-1"],
      ownerLabels: { "user-1": "Alex" },
      statusFilter: "all",
      bucket: "ready_to_send",
      pickupScope: "today",
      view: {
        id: "v1",
        name: "My freight today",
        mergeMode: "merge",
        extras: { confidenceFlag: "high" },
      },
    });
    const before = resolveScope(withView);
    const viewKeys = before.clauses.filter((c) => c.source === "view").map((c) => c.key);
    expect(viewKeys.length).toBeGreaterThan(0);

    // Simulate `deactivateViewOnly`: view goes away, every other input
    // is byte-for-byte identical.
    const after = resolveScope({ ...withView, view: null });

    // No view-origin clauses remain.
    expect(after.clauses.every((c) => c.source !== "view")).toBe(true);
    // Every non-view clause from `before` survives, in the same order.
    const beforeNonView = before.clauses.filter((c) => c.source !== "view").map((c) => c.key);
    const afterKeys = after.clauses.map((c) => c.key);
    expect(afterKeys).toEqual(beforeNonView);
  });
});

describe("resolveScope — URL-derived filters combine with bucket", () => {
  // Task #1020 — when reps land via deep links the cockpit hydrates
  // `laneFilter` / `carrierIdFilter` from URL params and may also pin a
  // bucket (e.g. /available-freight?lane=ATL-DAL&bucket=ready_to_send).
  // The Scope Summary must surface BOTH dimensions as independent,
  // independently-clearable clauses, and `summarizeScope` must mention
  // both so the rep can see exactly why the queue is constrained.
  it("renders lane + carrier + bucket from URL together with independent clears", () => {
    const r = resolveScope(
      baseInput({
        bucket: "ready_to_send",
        laneFilter: { originState: "GA", destState: "TX" },
        carrierIdFilter: "carrier-9",
        carrierName: "Acme Carriers",
      }),
    );
    const byDim = (d: string) => r.clauses.filter((c) => c.dimension === d);
    expect(byDim("lane")).toHaveLength(1);
    expect(byDim("carrier")).toHaveLength(1);
    expect(byDim("bucket")).toHaveLength(1);
    // All three URL/page-derived clauses are clearable independently.
    expect(byDim("lane")[0].clearable).toBe(true);
    expect(byDim("carrier")[0].clearable).toBe(true);
    expect(byDim("bucket")[0].clearable).toBe(true);
    // Summary mentions all three dimensions (lane, carrier, bucket).
    const sentence = summarizeScope(r);
    expect(sentence.toLowerCase()).toMatch(/lane/);
    expect(sentence).toMatch(/Acme Carriers/);
    expect(sentence.toLowerCase()).toMatch(/ready/);
    // No spurious conflicts when URL filters and bucket coexist without a view.
    expect(r.conflicts).toEqual([]);
  });
});
