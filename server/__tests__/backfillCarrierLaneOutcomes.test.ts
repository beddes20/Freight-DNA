/**
 * Task #637 — backfill idempotence guard.
 *
 * The backfill script must be safely re-runnable. Strategy chosen:
 * DELETE every in-scope `carrier_lane_outcomes` row first, then rebuild
 * from the legacy sources. This test asserts that contract by replaying
 * the orchestration twice with stubbed source rows and verifying:
 *
 *   1. The first SQL emitted is the DELETE statement (clear-then-rebuild).
 *   2. After two consecutive runs, the cumulative state is identical
 *      (same number of recordCarrierLaneOutcome invocations and same
 *      call shape) — i.e. one rerun does not double-count.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const executeMock = vi.fn();
const recordMock = vi.fn(async () => undefined);

vi.mock("../../server/storage", () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

vi.mock("../../server/services/carrierLaneOutcomes", () => ({
  recordCarrierLaneOutcome: (...args: unknown[]) => recordMock(...args),
  getCarrierLaneOutcomesForLane: vi.fn(async () => new Map()),
  summarizeCarrierLaneOutcome: vi.fn(() => null),
}));

function flatten(node: any, parts: string[] = []): string[] {
  if (node == null) return parts;
  if (typeof node === "string") { parts.push(node); return parts; }
  if (Array.isArray(node)) { for (const c of node) flatten(c, parts); return parts; }
  if (typeof node === "object" && Array.isArray(node.value)) return flatten(node.value, parts);
  if (typeof node === "object" && Array.isArray(node.queryChunks)) return flatten(node.queryChunks, parts);
  return parts;
}

function lastSqlText(callIndex: number): string {
  const c = executeMock.mock.calls[callIndex];
  if (!c) return "";
  return flatten(c[0]).join(" ").toLowerCase();
}

beforeEach(() => {
  executeMock.mockReset();
  recordMock.mockClear();
  // Default: every source SELECT returns the same one-row fixture so the
  // helper is invoked deterministically. The DELETE call returns an
  // empty result-set with `rows: []`.
  executeMock.mockImplementation(async (chunk: any) => {
    const text = flatten(chunk).join(" ").toLowerCase();
    if (text.includes("delete from carrier_lane_outcomes")) {
      return { rows: [] };
    }
    if (text.includes("from carrier_outreach_logs")) {
      return { rows: [{
        id: "log-1",
        org_id: "org-1", matched_carrier_id: "car-1",
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
        sent_at: new Date("2026-01-01T00:00:00Z"),
        reply_received_at: new Date("2026-01-02T00:00:00Z"),
        delivery_status: "opened",
      }] };
    }
    if (text.includes("from email_signals")) {
      return { rows: [{
        id: "sig-1",
        org_id: "org-1",
        intent_type: "lane_decline",
        linked_carrier_id: "car-1",
        created_at: new Date("2026-01-06T00:00:00Z"),
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
      }] };
    }
    if (text.includes("from lane_carrier_interest")) {
      return { rows: [{
        org_id: "org-1", carrier_id: "car-1",
        interest_status: "available_now",
        classified_at: new Date("2026-01-03T00:00:00Z").toISOString(),
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
      }] };
    }
    if (text.includes("from freight_opportunity_responses")) {
      return { rows: [{
        org_id: "org-1", carrier_id: "car-1",
        outcome: "interested_now", quoted_rate: "1500.00",
        created_at: new Date("2026-01-04T00:00:00Z"),
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
      }] };
    }
    if (text.includes("from freight_opportunity_audit")) {
      return { rows: [{
        org_id: "org-1",
        payload: { kind: "covered", carrierId: "car-1" },
        created_at: new Date("2026-01-05T00:00:00Z"),
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
      }] };
    }
    return { rows: [] };
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("backfill carrier_lane_outcomes — idempotence contract", () => {
  it("clears the event-key ledger AND the outcomes table before any source SELECT", async () => {
    // Both DELETEs must run before sources, in either order, otherwise
    // the dedupe ledger left over from a previous run silently
    // suppresses every keyed re-insert during the rebuild.
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const firstTwoSql = [lastSqlText(0), lastSqlText(1)].join(" || ");
    expect(firstTwoSql).toContain("delete from carrier_lane_outcomes");
    expect(firstTwoSql).toContain("delete from carrier_lane_outcome_event_keys");

    // After the two DELETEs, the next call should be a SELECT (a source),
    // not another DELETE — confirms we don't accidentally clear anything
    // mid-replay.
    expect(lastSqlText(2)).toContain("select");
  });

  it("produces identical helper-call counts across two consecutive runs", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const firstRunCount = recordMock.mock.calls.length;
    expect(firstRunCount).toBeGreaterThan(0);

    recordMock.mockClear();
    await runBackfill(null);
    const secondRunCount = recordMock.mock.calls.length;

    expect(secondRunCount).toBe(firstRunCount);
  });
});

describe("backfill carrier_lane_outcomes — backfill ≡ live parity", () => {
  // For each row a legacy source returns, the backfill must emit the same
  // set of `event` bumps that the live producer for that same source row
  // would emit. This guards the contract "wipe + backfill leaves the
  // ranker prior in the same shape as live wiring would produce".
  //
  // Producer mappings under test (mirrors of the live wiring in
  // freightOpportunityOutreachService / coverFreightOpportunity /
  // laneCarrierOutreach):
  //   - carrier_outreach_logs row:                    { sent_at, reply_received_at,
  //                                                     delivery_status='opened' } → ["sent","reply","open"]
  //   - lane_carrier_interest available_now:          → ["yes"]
  //   - freight_opportunity_responses interested_now + quoted_rate:
  //                                                   → ["reply","yes","quote"]
  //   - freight_opportunity_audit covered:            → ["cover"]
  //   - email_signals lane_decline (carrier+lane linked, inbound):
  //                                                   → ["reply","loss"]
  it("emits the exact set of event types live producers would for the same source rows", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);

    const events = recordMock.mock.calls.map(c => {
      const a = c[0] as { orgId: string; carrierId: string; event: string };
      return { orgId: a.orgId, carrierId: a.carrierId, event: a.event };
    }).sort((a, b) => a.event.localeCompare(b.event));

    expect(events).toEqual([
      // outreach_logs.sent_at + reply_received_at + delivery_status='opened'
      { orgId: "org-1", carrierId: "car-1", event: "sent" },
      { orgId: "org-1", carrierId: "car-1", event: "reply" },
      { orgId: "org-1", carrierId: "car-1", event: "open" },
      // lane_carrier_interest interest_status=available_now
      { orgId: "org-1", carrierId: "car-1", event: "yes" },
      // PAFOE response interested_now + quoted_rate
      { orgId: "org-1", carrierId: "car-1", event: "reply" },
      { orgId: "org-1", carrierId: "car-1", event: "yes" },
      { orgId: "org-1", carrierId: "car-1", event: "quote" },
      // freight_opportunity_audit kind=covered
      { orgId: "org-1", carrierId: "car-1", event: "cover" },
      // email_signals lane_decline → reply + loss
      { orgId: "org-1", carrierId: "car-1", event: "reply" },
      { orgId: "org-1", carrierId: "car-1", event: "loss" },
    ].sort((a, b) => a.event.localeCompare(b.event)));
  });

  it("only emits known event types defined in CarrierLaneOutcomeEventType", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const ALLOWED = new Set(["sent", "open", "reply", "yes", "quote", "cover", "loss"]);
    for (const c of recordMock.mock.calls) {
      const ev = (c[0] as { event: string }).event;
      expect(ALLOWED.has(ev)).toBe(true);
    }
  });

  it("emits an open event for outreach logs with delivery_status='opened'", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const opens = recordMock.mock.calls.filter(c => (c[0] as { event: string }).event === "open");
    expect(opens.length).toBe(1);
    expect((opens[0][0] as { eventKey?: string }).eventKey).toBe("outreach-log:log-1:open");
  });

  it("replays an inbound email signal as a reply event keyed by signal id", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const sigReplies = recordMock.mock.calls.filter(c => {
      const a = c[0] as { event: string; eventKey?: string };
      return a.event === "reply" && a.eventKey === "email-signal:sig-1:reply";
    });
    expect(sigReplies.length).toBe(1);
    const sigLosses = recordMock.mock.calls.filter(c => {
      const a = c[0] as { event: string; eventKey?: string };
      return a.event === "loss" && a.eventKey === "email-signal:sig-1:loss";
    });
    expect(sigLosses.length).toBe(1);
  });
});
