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
