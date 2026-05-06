// Task #1022 — Action resolver unit tests.
//
// Pure-data tests over `resolveBlocking` and `resolveNextBestAction`.
// The cockpit row uses these to render a single primary-action button per
// row state; if the resolver disagrees with the row's actual state the
// rep sees a button that no-ops or worse, fires the wrong mutation.

import { describe, it, expect } from "vitest";
import {
  resolveBlocking,
  resolveNextBestAction,
  pickWhyBucket,
  bucketToneClass,
  type RowActionInput,
} from "@shared/cockpitRowActions";
import type { BucketEvalContext } from "@shared/cockpitBuckets";

const TODAY = "2026-04-24";
const ctx: BucketEvalContext = {
  todayIso: TODAY,
  currentUserId: "me",
  myTeamUserIds: new Set(["me", "rep1"]),
};

// Default pickup is a real future timestamp so the resolver doesn't classify
// vanilla scenarios as `import_gap` (which fires when pickupWindowStart is
// missing AND there's no carrier outreach yet). Tests that want to exercise
// the `import_gap` branch override this explicitly.
const DEFAULT_PICKUP_ISO = "2026-04-25T14:00:00Z";

function mk(over: Partial<RowActionInput> = {}): RowActionInput {
  return {
    opportunity: {
      status: "ready_to_send",
      pickupWindowStart: DEFAULT_PICKUP_ISO,
      ...over.opportunity,
    },
    coverage: { sent: 0, responded: 0, included: 5, covered: false, ...over.coverage },
    freshnessMinutes: 30,
    rankedCarrierCount: 5,
    ownership: { ids: ["me"] },
    pickupFreshness: "upcoming",
    ...over,
    // We re-set `opportunity`/`coverage` above so they merge cleanly even
    // if `over` provided them.
  };
}

describe("resolveBlocking", () => {
  it("flags covered rows as covered", () => {
    expect(resolveBlocking(mk({ coverage: { covered: true } })).state).toBe("covered");
    expect(resolveBlocking(mk({ opportunity: { status: "covered" } })).state).toBe("covered");
  });

  it("flags pending_approval", () => {
    expect(resolveBlocking(mk({ opportunity: { status: "pending_approval" } })).state)
      .toBe("pending_approval");
  });

  it("flags no_carriers when shortlist + sent are both empty", () => {
    expect(
      resolveBlocking(mk({ rankedCarrierCount: 0, coverage: { sent: 0, included: 0 } })).state,
    ).toBe("no_carriers");
  });

  it("flags ready_to_send when shortlist exists but no outreach", () => {
    expect(resolveBlocking(mk({ coverage: { sent: 0, included: 4 } })).state).toBe("ready_to_send");
  });

  it("flags awaiting_reply for fresh outreach with no replies", () => {
    expect(
      resolveBlocking(mk({
        coverage: { sent: 3, responded: 0, included: 5 },
        freshnessMinutes: 60,
      })).state,
    ).toBe("awaiting_reply");
  });

  it("upgrades to stalled_no_reply once freshness ≥ 4h", () => {
    expect(
      resolveBlocking(mk({
        coverage: { sent: 3, responded: 0, included: 5 },
        freshnessMinutes: 300,
      })).state,
    ).toBe("stalled_no_reply");
  });

  it("flags partial when replies arrived but no carrier was booked", () => {
    expect(
      resolveBlocking(mk({
        coverage: { sent: 3, responded: 2, included: 5 },
      })).state,
    ).toBe("partial");
  });

  it("flags import_gap when pickupFreshness is 'no_pickup' and no outreach", () => {
    expect(
      resolveBlocking(mk({
        opportunity: { status: "ready_to_send", pickupWindowStart: null },
        rankedCarrierCount: 0,
        coverage: { sent: 0, included: 0 },
        pickupFreshness: "no_pickup",
      })).state,
    ).toBe("import_gap");
  });

  it("flags import_gap when pickupWindowStart is missing even without explicit freshness", () => {
    expect(
      resolveBlocking(mk({
        opportunity: { status: "ready_to_send", pickupWindowStart: null },
        rankedCarrierCount: 0,
        coverage: { sent: 0, included: 0 },
        pickupFreshness: null,
      })).state,
    ).toBe("import_gap");
  });

  it("does NOT flag import_gap once outreach has started (data is patchable but rep should chase replies)", () => {
    expect(
      resolveBlocking(mk({
        opportunity: { status: "sent", pickupWindowStart: null },
        coverage: { sent: 3, responded: 0, included: 5 },
        pickupFreshness: "no_pickup",
      })).state,
    ).toBe("awaiting_reply");
  });
});

describe("resolveNextBestAction", () => {
  it("approves pending_approval rows with primary emphasis", () => {
    const a = resolveNextBestAction(mk({ opportunity: { status: "pending_approval" } }));
    expect(a.id).toBe("approve");
    expect(a.emphasis).toBe("primary");
  });

  it("returns send_top with topN payload when ready_to_send", () => {
    const a = resolveNextBestAction(mk({ coverage: { sent: 0, included: 4 } }));
    expect(a.id).toBe("send_top");
    expect(a.payload).toEqual({ topN: 3 });
  });

  it("returns pick_carriers with needsDialog when shortlist is empty", () => {
    const a = resolveNextBestAction(mk({ rankedCarrierCount: 0, coverage: { sent: 0, included: 0 } }));
    expect(a.id).toBe("pick_carriers");
    expect(a.needsDialog).toBe(true);
  });

  it("returns escalate (primary) once outreach has stalled past 4h", () => {
    const a = resolveNextBestAction(mk({
      coverage: { sent: 3, responded: 0, included: 5 },
      freshnessMinutes: 300,
    }));
    expect(a.id).toBe("escalate");
    expect(a.emphasis).toBe("primary");
  });

  it("returns escalate (secondary) while outreach is still fresh", () => {
    const a = resolveNextBestAction(mk({
      coverage: { sent: 3, responded: 0, included: 5 },
      freshnessMinutes: 60,
    }));
    expect(a.id).toBe("escalate");
    expect(a.emphasis).toBe("secondary");
  });

  it("returns mark_covered when at least one reply landed", () => {
    const a = resolveNextBestAction(mk({
      coverage: { sent: 3, responded: 1, included: 5 },
    }));
    expect(a.id).toBe("mark_covered");
    expect(a.needsDialog).toBe(true);
  });

  it("returns disabled confirm_covered when row already covered", () => {
    const a = resolveNextBestAction(mk({ coverage: { covered: true } }));
    expect(a.id).toBe("confirm_covered");
    expect(a.disabled).toBe(true);
  });

  it("returns 'Set pickup time' (primary, needsDialog) for import_gap", () => {
    const a = resolveNextBestAction(mk({
      opportunity: { status: "ready_to_send", pickupWindowStart: null },
      rankedCarrierCount: 0,
      coverage: { sent: 0, included: 0 },
      pickupFreshness: "no_pickup",
    }));
    expect(a.id).toBe("open_detail");
    expect(a.label).toBe("Set pickup time");
    expect(a.emphasis).toBe("primary");
    expect(a.needsDialog).toBe(true);
  });
});

// Task #1022 (review-rev) — Row-state snapshots. The cockpit row renders a
// terse blocking caption + primary action button derived from these
// resolver outputs, so a stable snapshot per common state is the
// closest unit-level proxy for the visual contract. If the resolver
// drifts (label, emphasis, payload), every dependent row visual
// changes too — these snapshots catch that in CI without spinning up
// jsdom for the row component itself.
describe("row state snapshots", () => {
  it("ready_to_send → Send to top 3", () => {
    const row = mk({ coverage: { sent: 0, included: 4 } });
    expect({ blocking: resolveBlocking(row), action: resolveNextBestAction(row) })
      .toMatchInlineSnapshot(`
        {
          "action": {
            "emphasis": "primary",
            "id": "send_top",
            "label": "Send to top 3",
            "payload": {
              "topN": 3,
            },
          },
          "blocking": {
            "label": "Ready to send",
            "state": "ready_to_send",
          },
        }
      `);
  });

  it("awaiting_reply → Send to next 3 (secondary)", () => {
    const row = mk({
      coverage: { sent: 3, responded: 0, included: 5 },
      freshnessMinutes: 60,
    });
    expect({ blocking: resolveBlocking(row), action: resolveNextBestAction(row) })
      .toMatchInlineSnapshot(`
        {
          "action": {
            "emphasis": "secondary",
            "id": "escalate",
            "label": "Send to next 3",
            "payload": {
              "topN": 3,
            },
          },
          "blocking": {
            "label": "Awaiting carrier reply",
            "state": "awaiting_reply",
          },
        }
      `);
  });

  it("pending_approval → Approve (primary)", () => {
    const row = mk({ opportunity: { status: "pending_approval" } });
    expect({ blocking: resolveBlocking(row), action: resolveNextBestAction(row) })
      .toMatchInlineSnapshot(`
        {
          "action": {
            "emphasis": "primary",
            "id": "approve",
            "label": "Approve",
          },
          "blocking": {
            "label": "Pending approval",
            "state": "pending_approval",
          },
        }
      `);
  });

  it("import_gap → Set pickup time (primary, needsDialog)", () => {
    const row = mk({
      opportunity: { status: "ready_to_send", pickupWindowStart: null },
      rankedCarrierCount: 0,
      coverage: { sent: 0, included: 0 },
      pickupFreshness: "no_pickup",
    });
    expect({ blocking: resolveBlocking(row), action: resolveNextBestAction(row) })
      .toMatchInlineSnapshot(`
        {
          "action": {
            "emphasis": "primary",
            "id": "open_detail",
            "label": "Set pickup time",
            "needsDialog": true,
          },
          "blocking": {
            "label": "Import gap — pickup time missing",
            "state": "import_gap",
          },
        }
      `);
  });
});

describe("pickWhyBucket", () => {
  const pickupSoon = new Date(Date.now() + 6 * 3600_000).toISOString();
  it("prefers at_risk_24h over pickup_today when both match", () => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx2: BucketEvalContext = { ...ctx, todayIso: today };
    const row = mk({
      opportunity: { status: "ready_to_send", pickupWindowStart: pickupSoon },
      coverage: { sent: 0, included: 3, covered: false },
    });
    const w = pickWhyBucket(row, ctx2);
    expect(w?.key).toBe("at_risk_24h");
  });

  it("falls back to ready_to_send when no urgency bucket fires", () => {
    // Push pickup far enough out that at_risk_24h / pickup_today /
    // pickup_tomorrow can't fire — leaves ready_to_send as the only
    // matching bucket.
    const farPickup = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const w = pickWhyBucket(
      mk({ opportunity: { status: "ready_to_send", pickupWindowStart: farPickup } }),
      ctx,
    );
    expect(w?.key).toBe("ready_to_send");
  });

  it("never returns null — falls back to the 'all' bucket so every row has a badge", () => {
    // Construct a row that intentionally doesn't match any priority
    // bucket: pickup is far out, freshness is fresh, owned by me, has
    // both outreach and replies queued (partial), so none of
    // at_risk_24h / pickup_today/tomorrow / no_response_4h /
    // ready_to_send / stale / unassigned / covered_today fires.
    const farPickup = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const w = pickWhyBucket(
      mk({
        opportunity: { status: "partially_covered", pickupWindowStart: farPickup },
        coverage: { sent: 5, responded: 2, included: 5 },
        freshnessMinutes: 30,
      }),
      ctx,
    );
    expect(w).not.toBeNull();
    expect(w.key).toBe("all");
  });

  it("surfaces covered_today as the why-bucket when no urgency bucket fires", () => {
    const w = pickWhyBucket(
      mk({ opportunity: { status: "covered", pickupWindowStart: null }, coverage: { covered: true } }),
      ctx,
    );
    expect(w?.key).toBe("covered_today");
  });
});

describe("bucketToneClass", () => {
  it("maps every tone to a non-empty class string", () => {
    for (const tone of ["critical", "warn", "ready", "info", "ok", "muted"] as const) {
      expect(bucketToneClass(tone).length).toBeGreaterThan(0);
    }
  });
});
