import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyCockpitFilters,
  type CockpitFilterItem,
  type CockpitFilterDiagnostics,
} from "../cockpitFilters";
import { resolveUserIdentity } from "@shared/cockpitOwnership";

const NOW = new Date("2026-04-24T12:00:00Z").getTime(); // 7am CT, 4/24

beforeEach(() => {
  // Pin the wall clock so todayIsoInOrgTz() returns 2026-04-24 (CT)
  // regardless of where the test runs.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function mk(overrides: Partial<CockpitFilterItem> & { id: string }): CockpitFilterItem & { id: string } {
  return {
    opportunity: {
      origin: "Chicago, IL",
      destination: "Atlanta, GA",
      equipmentType: "DRY",
      pickupWindowStart: null,
      status: "ready_to_send",
      ...(overrides.opportunity ?? {}),
    },
    chips: overrides.chips ?? [{ carrierName: "Acme Logistics" }],
    coverage: { sent: 0, responded: 0, ...(overrides.coverage ?? {}) },
    suggestedBuy: overrides.suggestedBuy ?? null,
    freshnessMinutes: overrides.freshnessMinutes ?? 0,
    owner: overrides.owner ?? null,
    ownership: overrides.ownership ?? null,
    id: overrides.id,
  };
}

describe("applyCockpitFilters", () => {
  it("matches search across origin/destination/equipment/carrier names", () => {
    const items = [
      mk({ id: "a" }),
      mk({ id: "b", opportunity: { origin: "Dallas, TX", destination: "Houston, TX", status: "new" } }),
      mk({ id: "c", chips: [{ carrierName: "Bravo Trucking" }] }),
    ];
    expect(applyCockpitFilters(items, "atlanta", {}, null, NOW).map(i => i.id)).toEqual(["a", "c"]);
    expect(applyCockpitFilters(items, "bravo", {}, null, NOW).map(i => i.id)).toEqual(["c"]);
    expect(applyCockpitFilters(items, "dallas", {}, null, NOW).map(i => i.id)).toEqual(["b"]);
  });

  it("statuses filter restricts to listed statuses", () => {
    const items = [
      mk({ id: "a", opportunity: { status: "ready_to_send" } }),
      mk({ id: "b", opportunity: { status: "new" } }),
      mk({ id: "c", opportunity: { status: "pending_approval" } }),
    ];
    expect(applyCockpitFilters(items, "", { statuses: ["new", "pending_approval"] }, null, NOW).map(i => i.id)).toEqual(["b", "c"]);
  });

  it("ownerScope=mine returns only items owned by currentUser; team excludes them", () => {
    const items = [
      mk({ id: "a", owner: { id: "u1", name: "Me" } }),
      mk({ id: "b", owner: { id: "u2", name: "Other" } }),
      mk({ id: "c", owner: null }),
    ];
    expect(applyCockpitFilters(items, "", { ownerScope: "mine" }, "u1", NOW).map(i => i.id)).toEqual(["a"]);
    expect(applyCockpitFilters(items, "", { ownerScope: "team" }, "u1", NOW).map(i => i.id)).toEqual(["b", "c"]);
    expect(applyCockpitFilters(items, "", { ownerScope: "mine" }, null, NOW)).toEqual([]);
    expect(
      applyCockpitFilters(items, "", { ownerScope: "team" }, null, NOW).map(i => i.id),
    ).toEqual(["a", "b", "c"]);
  });

  // Task #875 — the canonical regression: a row delegated from Jared to an LM
  // has `owner.id = lmId`, but Jared still owns it via `ownership.ids`. The
  // pre-#875 strict-equality predicate dropped it; the shared one keeps it.
  it("ownerScope=mine respects every owner-shaped attribution (id, delegated, creator, approver)", () => {
    const jared = resolveUserIdentity({ id: "jared", username: "jared@arrive.com" });
    const items = [
      // Direct owner — obviously mine.
      mk({ id: "owner", owner: { id: "jared" }, ownership: { ids: ["jared"], emails: ["jared@arrive.com"] } }),
      // Delegated to an LM. owner.id is the LM, but Jared is the original
      // owner. The KPI strip counts this as Jared's; so must we.
      mk({ id: "delegated", owner: { id: "lm" }, ownership: { ids: ["lm", "jared"], emails: ["lm@arrive.com", "jared@arrive.com"] } }),
      // Created by Jared but assigned out — still attributable.
      mk({ id: "created", owner: { id: "other" }, ownership: { ids: ["other", "jared"], emails: [] } }),
      // Email-only match (id mismatch, e.g. legacy/imported rows).
      mk({ id: "email", owner: { id: "stranger" }, ownership: { ids: ["stranger"], emails: ["jared@arrive.com"] } }),
      // Truly someone else's row.
      mk({ id: "other", owner: { id: "stranger" }, ownership: { ids: ["stranger"], emails: ["stranger@arrive.com"] } }),
    ];
    expect(
      applyCockpitFilters(items, "", { ownerScope: "mine" }, jared, NOW).map(i => i.id),
    ).toEqual(["owner", "delegated", "created", "email"]);
  });

  it("pickupWithinHours: a same-day pickup is never classified as past-due", () => {
    // Reproduces the #875 bug: pickupWindowStart stored as a bare
    // YYYY-MM-DD string used to parse as UTC midnight, so by 7am CT it
    // looked "1 hour ago" and the strict `dt < now` check would drop it.
    // The new helper compares day-keys against todayIsoInOrgTz(), so a
    // same-day pickup always passes a positive within-hours window.
    const items = [
      mk({ id: "today-bare", opportunity: { pickupWindowStart: "2026-04-24" } }),
      mk({ id: "today-iso", opportunity: { pickupWindowStart: "2026-04-24T17:00:00Z" } }),
      mk({ id: "yesterday", opportunity: { pickupWindowStart: "2026-04-23" } }),
      mk({ id: "tomorrow", opportunity: { pickupWindowStart: "2026-04-25" } }),
      mk({ id: "in-3-days", opportunity: { pickupWindowStart: "2026-04-27" } }),
      mk({ id: "none", opportunity: { pickupWindowStart: null } }),
    ];
    // 24h window ⇒ ceil(24/24) = 1, horizon = today + 1 = tomorrow.
    expect(
      applyCockpitFilters(items, "", { pickupWithinHours: 24 }, null, NOW).map(i => i.id),
    ).toEqual(["today-bare", "today-iso", "tomorrow"]);
  });

  it("pickupAfterHours keeps only pickups beyond the day threshold", () => {
    const items = [
      mk({ id: "today", opportunity: { pickupWindowStart: "2026-04-24" } }),
      mk({ id: "tomorrow", opportunity: { pickupWindowStart: "2026-04-25" } }),
      mk({ id: "later", opportunity: { pickupWindowStart: "2026-04-27" } }),
    ];
    // 24h ⇒ floor(24/24) = 1, dayKey >= today+1 = 2026-04-25.
    expect(
      applyCockpitFilters(items, "", { pickupAfterHours: 24 }, null, NOW).map(i => i.id),
    ).toEqual(["tomorrow", "later"]);
  });

  it("confidenceFlag matches suggestedBuy.confidence exactly", () => {
    const items = [
      mk({ id: "low", suggestedBuy: { confidence: "low" } }),
      mk({ id: "med", suggestedBuy: { confidence: "medium" } }),
      mk({ id: "none", suggestedBuy: null }),
    ];
    expect(applyCockpitFilters(items, "", { confidenceFlag: "low" }, null, NOW).map(i => i.id)).toEqual(["low"]);
  });

  it("sentNoReplyMinAgeMin requires sent>0, responded=0, and freshness ≥ threshold", () => {
    const items = [
      mk({ id: "stale", coverage: { sent: 3, responded: 0 }, freshnessMinutes: 240 }),
      mk({ id: "fresh", coverage: { sent: 3, responded: 0 }, freshnessMinutes: 60 }),
      mk({ id: "replied", coverage: { sent: 3, responded: 1 }, freshnessMinutes: 240 }),
      mk({ id: "unsent", coverage: { sent: 0, responded: 0 }, freshnessMinutes: 240 }),
    ];
    expect(applyCockpitFilters(items, "", { sentNoReplyMinAgeMin: 240 }, null, NOW).map(i => i.id)).toEqual(["stale"]);
  });

  it("filters compose (statuses + ownerScope + pickupWithinHours)", () => {
    const items = [
      mk({
        id: "match",
        opportunity: { status: "ready_to_send", pickupWindowStart: "2026-04-24" },
        owner: { id: "u1" },
        ownership: { ids: ["u1"], emails: [] },
      }),
      mk({
        id: "wrongStatus",
        opportunity: { status: "covered", pickupWindowStart: "2026-04-24" },
        owner: { id: "u1" },
        ownership: { ids: ["u1"], emails: [] },
      }),
      mk({
        id: "wrongOwner",
        opportunity: { status: "ready_to_send", pickupWindowStart: "2026-04-24" },
        owner: { id: "u2" },
        ownership: { ids: ["u2"], emails: [] },
      }),
    ];
    expect(
      applyCockpitFilters(
        items,
        "",
        { statuses: ["ready_to_send"], ownerScope: "mine", pickupWithinHours: 24 },
        "u1",
        NOW,
      ).map(i => i.id),
    ).toEqual(["match"]);
  });

  it("emits per-stage diagnostics when enabled", () => {
    const diagnostics: CockpitFilterDiagnostics = { enabled: true, stages: [] };
    const items = [
      mk({ id: "kept", owner: { id: "u1" }, ownership: { ids: ["u1"], emails: [] }, opportunity: { pickupWindowStart: "2026-04-24" } }),
      mk({ id: "wrongStatus", owner: { id: "u1" }, ownership: { ids: ["u1"], emails: [] }, opportunity: { status: "covered", pickupWindowStart: "2026-04-24" } }),
      mk({ id: "wrongOwner", owner: { id: "u2" }, ownership: { ids: ["u2"], emails: [] }, opportunity: { status: "ready_to_send", pickupWindowStart: "2026-04-24" } }),
    ];
    applyCockpitFilters(
      items,
      "",
      { statuses: ["ready_to_send"], ownerScope: "mine", pickupWithinHours: 24 },
      "u1",
      NOW,
      diagnostics,
    );
    const stages = diagnostics.stages.map((s) => ({ stage: s.stage, kept: s.kept, droppedIds: s.droppedIds }));
    expect(stages).toEqual([
      { stage: "status", kept: 2, droppedIds: ["wrongStatus"] },
      { stage: "ownerScope:mine", kept: 1, droppedIds: ["wrongOwner"] },
      { stage: "pickupWithinHours", kept: 1, droppedIds: [] },
    ]);
  });
});
