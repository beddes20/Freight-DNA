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
        org_id: "org-1", matched_carrier_id: "car-1",
        origin: "Chicago", origin_state: "IL",
        destination: "Dallas", destination_state: "TX",
        equipment_type: "Dry Van",
        sent_at: new Date("2026-01-01T00:00:00Z"),
        reply_received_at: new Date("2026-01-02T00:00:00Z"),
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
  it("emits a DELETE before any source SELECT (clear-then-rebuild)", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    expect(lastSqlText(0)).toContain("delete from carrier_lane_outcomes");
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
  //   - carrier_outreach_logs row:           { sent_at, reply_received_at } → ["sent","reply"]
  //   - lane_carrier_interest available_now: → ["yes"]
  //   - freight_opportunity_responses interested_now + quoted_rate:
  //                                          → ["reply","yes","quote"]
  //   - freight_opportunity_audit covered:   → ["cover"]
  it("emits the exact set of event types live producers would for the same source rows", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);

    const events = recordMock.mock.calls.map(c => {
      const a = c[0] as { orgId: string; carrierId: string; event: string };
      return { orgId: a.orgId, carrierId: a.carrierId, event: a.event };
    }).sort((a, b) => a.event.localeCompare(b.event));

    expect(events).toEqual([
      // outreach_logs.sent_at + reply_received_at
      { orgId: "org-1", carrierId: "car-1", event: "sent" },
      { orgId: "org-1", carrierId: "car-1", event: "reply" },
      // lane_carrier_interest interest_status=available_now
      { orgId: "org-1", carrierId: "car-1", event: "yes" },
      // PAFOE response interested_now + quoted_rate
      { orgId: "org-1", carrierId: "car-1", event: "reply" },
      { orgId: "org-1", carrierId: "car-1", event: "yes" },
      { orgId: "org-1", carrierId: "car-1", event: "quote" },
      // freight_opportunity_audit kind=covered
      { orgId: "org-1", carrierId: "car-1", event: "cover" },
    ].sort((a, b) => a.event.localeCompare(b.event)));
  });

  it("never emits an open or unknown event type the live producers don't emit", async () => {
    const { runBackfill } = await import("../../scripts/backfillCarrierLaneOutcomes");
    await runBackfill(null);
    const ALLOWED = new Set(["sent", "reply", "yes", "quote", "cover", "loss"]);
    for (const c of recordMock.mock.calls) {
      const ev = (c[0] as { event: string }).event;
      expect(ALLOWED.has(ev)).toBe(true);
    }
  });
});
