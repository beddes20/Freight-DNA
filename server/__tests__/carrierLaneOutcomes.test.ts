/**
 * Task #637 — carrier_lane_outcomes helper tests.
 *
 * Covers:
 *   1. recordCarrierLaneOutcome upserts with the right counter column and
 *      lane signature on first insert.
 *   2. Subsequent events on the same (org, carrier, lane) increment the
 *      same row instead of creating duplicates.
 *   3. Missing orgId / carrierId / signature dropped silently (warn).
 *   4. summarizeCarrierLaneOutcome builds the expected reason strings.
 *   5. getCarrierLaneOutcomesForLane keys returned rows by carrierId.
 *
 * Strategy: stub `db.execute` so no real PostgreSQL is required. The test
 * shapes are intentionally narrow — the helper's contract is "build the
 * right SQL and degrade gracefully on errors", not the DB engine itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const executeMock = vi.fn();

vi.mock("../storage", () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import {
  recordCarrierLaneOutcome,
  getCarrierLaneOutcomesForLane,
  summarizeCarrierLaneOutcome,
} from "../services/carrierLaneOutcomes";

function lastSql(): string {
  const last = executeMock.mock.calls.at(-1);
  if (!last) return "";
  // db.execute is called with a drizzle SQL chunk. The chunks expose a
  // `queryChunks` array of interleaved string fragments + parameter
  // sentinels; we only need the string fragments to assert on column
  // names / SQL keywords, so recursively flatten.
  const chunk: any = last[0];
  const parts: string[] = [];
  const visit = (node: any): void => {
    if (node == null) return;
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { for (const c of node) visit(c); return; }
    if (typeof node === "object" && Array.isArray(node.value)) { visit(node.value); return; }
    if (typeof node === "object" && Array.isArray(node.queryChunks)) { visit(node.queryChunks); return; }
  };
  visit(chunk);
  return parts.join(" ");
}

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [] });
});

describe("recordCarrierLaneOutcome", () => {
  it("emits an INSERT … ON CONFLICT upsert with the matching counter column", async () => {
    await recordCarrierLaneOutcome({
      orgId: "org-1",
      carrierId: "car-1",
      origin: "Chicago",
      originState: "IL",
      destination: "Dallas",
      destinationState: "TX",
      equipmentType: "Dry Van",
      event: "cover",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const sqlText = lastSql().toLowerCase();
    expect(sqlText).toContain("insert into carrier_lane_outcomes");
    expect(sqlText).toContain("on conflict");
    expect(sqlText).toContain("cover_count");
    expect(sqlText).toContain("greatest");
  });

  it("drops the event with a warning when orgId is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordCarrierLaneOutcome({
      orgId: "",
      carrierId: "car-1",
      laneSignature: "chicago|il|dallas|tx|dry van",
      event: "sent",
    });
    expect(executeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("drops the event when no lane parts produce a non-empty signature", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordCarrierLaneOutcome({
      orgId: "org-1",
      carrierId: "car-1",
      origin: null,
      destination: null,
      event: "sent",
    });
    expect(executeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("never throws when the underlying execute rejects (informational write)", async () => {
    executeMock.mockRejectedValueOnce(new Error("connection terminated"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      recordCarrierLaneOutcome({
        orgId: "org-1",
        carrierId: "car-1",
        laneSignature: "chicago|il|dallas|tx|dry van",
        event: "sent",
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses the correct counter column for each event type", async () => {
    const events = ["sent", "open", "reply", "yes", "quote", "cover", "loss"] as const;
    for (const event of events) {
      executeMock.mockClear();
      await recordCarrierLaneOutcome({
        orgId: "org-1",
        carrierId: "car-1",
        laneSignature: "chicago|il|dallas|tx|dry van",
        event,
      });
      const sqlText = lastSql().toLowerCase();
      expect(sqlText).toContain(`${event}_count`);
    }
  });
});

describe("getCarrierLaneOutcomesForLane", () => {
  it("returns an empty map when orgId or signature is missing", async () => {
    const result = await getCarrierLaneOutcomesForLane("", "sig");
    expect(result.size).toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns an empty map when the underlying query throws", async () => {
    executeMock.mockRejectedValueOnce(new Error("read failure"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await getCarrierLaneOutcomesForLane("org-1", "chicago|il|dallas|tx|dry van");
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keys returned rows by carrierId", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        { carrierId: "car-1", coverCount: 2, yesCount: 0, replyCount: 1 },
        { carrierId: "car-2", coverCount: 0, yesCount: 3, replyCount: 4 },
      ],
    });
    const result = await getCarrierLaneOutcomesForLane("org-1", "chicago|il|dallas|tx|dry van");
    expect(result.size).toBe(2);
    expect(result.get("car-1")?.coverCount).toBe(2);
    expect(result.get("car-2")?.yesCount).toBe(3);
  });
});

describe("summarizeCarrierLaneOutcome", () => {
  function row(overrides: Record<string, number> = {}) {
    return {
      id: "x",
      orgId: "org-1",
      carrierId: "car-1",
      laneSignature: "sig",
      origin: null,
      originState: null,
      destination: null,
      destinationState: null,
      equipmentType: null,
      sentCount: 0,
      openCount: 0,
      replyCount: 0,
      yesCount: 0,
      quoteCount: 0,
      coverCount: 0,
      lossCount: 0,
      firstEventAt: new Date(),
      lastEventAt: new Date(),
      ...overrides,
    } as any;
  }

  it("returns null when no material counters are set", () => {
    expect(summarizeCarrierLaneOutcome(null)).toBeNull();
    expect(summarizeCarrierLaneOutcome(row())).toBeNull();
  });

  it("prefers covers, then yes/quote, over reply/loss/sent text", () => {
    expect(summarizeCarrierLaneOutcome(row({ coverCount: 2, yesCount: 1, replyCount: 5 })))
      .toBe("Lane history: 2 covers + 1 yes");
  });

  it("singularizes counts of one", () => {
    expect(summarizeCarrierLaneOutcome(row({ coverCount: 1 })))
      .toBe("Lane history: 1 cover");
    expect(summarizeCarrierLaneOutcome(row({ replyCount: 1 })))
      .toBe("Lane history: 1 reply");
  });

  it("falls back to reply/loss/sent text when no positive engagement exists", () => {
    expect(summarizeCarrierLaneOutcome(row({ replyCount: 4 })))
      .toBe("Lane history: 4 replies");
    expect(summarizeCarrierLaneOutcome(row({ lossCount: 2 })))
      .toBe("Lane history: 2 prior losses");
    expect(summarizeCarrierLaneOutcome(row({ sentCount: 3 })))
      .toBe("Lane history: 3 prior touches (no reply)");
  });
});
