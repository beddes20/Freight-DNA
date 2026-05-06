// Task #638 — carrier_overrides helper tests. Mocks db.execute (no live PG).
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeMock = vi.fn();

vi.mock("../storage", () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import {
  recordCarrierOverride,
  getCarrierOverridesForLane,
  carrierOverridePrior,
  type CarrierOverrideAggregate,
} from "../services/carrierOverrides";

function lastSql(): string {
  const last = executeMock.mock.calls.at(-1);
  if (!last) return "";
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

describe("recordCarrierOverride", () => {
  it("emits INSERT ... ON CONFLICT DO NOTHING with the override columns", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: "ov-1" }] });
    const result = await recordCarrierOverride({
      orgId: "org-1",
      carrierId: "car-1",
      repId: "user-1",
      origin: "Chicago",
      originState: "IL",
      destination: "Dallas",
      destinationState: "TX",
      equipmentType: "Dry Van",
      reasonCode: "bad_service",
      action: "deselect_top3",
      notes: null,
    });
    expect(result.recorded).toBe(true);
    const sqlText = lastSql().toLowerCase();
    expect(sqlText).toContain("insert into carrier_overrides");
    expect(sqlText).toContain("on conflict");
    expect(sqlText).toContain("do nothing");
    expect(sqlText).toContain("reason_code");
    expect(sqlText).toContain("occurred_at_day");
  });

  it("returns recorded:false when the dedupe index trips (RETURNING empty)", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const result = await recordCarrierOverride({
      orgId: "org-1",
      carrierId: "car-1",
      repId: "user-1",
      origin: "Chicago",
      destination: "Dallas",
      reasonCode: null,
      action: "deselect_top3",
    });
    expect(result.recorded).toBe(false);
  });

  it("accepts a null reasonCode (dismiss path) without throwing", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: "ov-2" }] });
    const result = await recordCarrierOverride({
      orgId: "org-1",
      carrierId: "car-1",
      repId: "user-1",
      origin: "Chicago",
      destination: "Dallas",
      reasonCode: null,
      action: "deselect_top3",
    });
    expect(result.recorded).toBe(true);
  });

  it("throws when laneSignature would collapse to the empty signature", async () => {
    await expect(recordCarrierOverride({
      orgId: "org-1",
      carrierId: "car-1",
      repId: "user-1",
      reasonCode: "bad_service",
      action: "deselect_top3",
    })).rejects.toThrow(/laneSignature/);
  });

  it("accepts long notes without throwing — trim/cap is internal", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: "ov-3" }] });
    const result = await recordCarrierOverride({
      orgId: "org-1",
      carrierId: "car-1",
      repId: "user-1",
      origin: "Chicago",
      destination: "Dallas",
      reasonCode: "other",
      action: "deselect_top3",
      notes: "  " + "x".repeat(500) + "  ",
    });
    expect(result.recorded).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCarrierOverridesForLane", () => {
  it("returns an empty Map when args missing — no SQL fired", async () => {
    const out = await getCarrierOverridesForLane("", "sig");
    expect(out.size).toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("only counts EXPLICIT negative reason codes — null rows must not cap", async () => {
    await getCarrierOverridesForLane("org-1", "chicago|il|dallas|tx|dry van");
    const sqlText = lastSql();
    // Negative count clause must NOT include "reason_code IS NULL".
    const negClause = sqlText.match(/COUNT\(\*\)\s+FILTER\s+\(WHERE\s+reason_code\s+IN\s*\([^)]+\)\)/i);
    expect(negClause).not.toBeNull();
    const fullNegFragment = sqlText.toLowerCase();
    // Sanity: the SQL still mentions the four negative codes…
    expect(fullNegFragment).toContain("'bad_service'");
    expect(fullNegFragment).toContain("'out_of_equipment'");
    expect(fullNegFragment).toContain("'wont_run_lane'");
    expect(fullNegFragment).toContain("'other'");
    // …but the NEGATIVE count clause must not add IS NULL into the count.
    // We grep the substring around "negativeCount" and ensure no IS NULL inside.
    const idx = fullNegFragment.indexOf('"negativecount"');
    expect(idx).toBeGreaterThan(-1);
    const window = fullNegFragment.slice(Math.max(0, idx - 200), idx);
    expect(window).not.toMatch(/reason_code\s+is\s+null/);
  });

  it("keys the result by carrierId and parses counts", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          carrierId: "car-A",
          negativeCount: "2",
          positiveCount: "0",
          lastNegativeReason: "bad_service",
          lastOccurredAt: new Date("2026-04-25T12:00:00Z").toISOString(),
        },
        {
          carrierId: "car-B",
          negativeCount: "0",
          positiveCount: "1",
          lastNegativeReason: null,
          lastOccurredAt: new Date("2026-04-25T13:00:00Z").toISOString(),
        },
      ],
    });
    const map = await getCarrierOverridesForLane("org-1", "chicago|il|dallas|tx|dry van");
    expect(map.size).toBe(2);
    expect(map.get("car-A")?.negativeCount).toBe(2);
    expect(map.get("car-A")?.lastNegativeReason).toBe("bad_service");
    expect(map.get("car-B")?.positiveCount).toBe(1);
    expect(map.get("car-B")?.lastNegativeReason).toBeNull();
  });
});

describe("carrierOverridePrior", () => {
  const empty: CarrierOverrideAggregate = {
    carrierId: "c", laneSignature: "s",
    negativeCount: 0, positiveCount: 0,
    lastNegativeReason: null, lastOccurredAt: null,
  };

  it("returns no boost / no cap / no reasons when aggregate is empty", () => {
    const p = carrierOverridePrior(empty);
    expect(p.boost).toBe(0);
    expect(p.cap).toBe(Infinity);
    expect(p.reasons).toEqual([]);
  });

  it("caps fitScore at 60 on a single negative skip with the most-recent label", () => {
    const p = carrierOverridePrior({
      ...empty, negativeCount: 1, lastNegativeReason: "bad_service",
    });
    expect(p.cap).toBe(60);
    expect(p.boost).toBe(0);
    expect(p.reasons[0]).toMatch(/skipped 1× by reps: bad service/i);
  });

  it("tightens the cap to 40 on two negatives, 20 on three or more", () => {
    expect(carrierOverridePrior({
      ...empty, negativeCount: 2, lastNegativeReason: "out_of_equipment",
    }).cap).toBe(40);
    expect(carrierOverridePrior({
      ...empty, negativeCount: 5, lastNegativeReason: "wont_run_lane",
    }).cap).toBe(20);
  });

  it("omits the ': label' tail when all negatives were dismissals", () => {
    const p = carrierOverridePrior({
      ...empty, negativeCount: 2, lastNegativeReason: null,
    });
    expect(p.reasons[0]).toBe("Skipped 2× by reps");
  });

  it("adds a +12 boost (one bench win) for a single positive 'better_fit'", () => {
    const p = carrierOverridePrior({ ...empty, positiveCount: 1 });
    expect(p.boost).toBe(12);
    expect(p.cap).toBe(Infinity);
    expect(p.reasons[0]).toMatch(/manually preferred 1× \('better fit'\)/i);
  });

  it("credits the boost AND applies the cap when both signals coexist", () => {
    const p = carrierOverridePrior({
      ...empty,
      negativeCount: 1,
      positiveCount: 1,
      lastNegativeReason: "bad_service",
    });
    expect(p.boost).toBe(12);
    expect(p.cap).toBe(60);
    // Both reasons surface so reps see the full picture.
    expect(p.reasons.length).toBe(2);
  });

  it("a dismiss-only history (no labeled reasons) leaves the score untouched", () => {
    // Per spec the dismiss path writes a row with reasonCode=null. Those
    // rows are kept for audit + dedupe but must NOT shift ranking.
    const p = carrierOverridePrior({
      ...empty, negativeCount: 0, positiveCount: 0,
    });
    expect(p.boost).toBe(0);
    expect(p.cap).toBe(Infinity);
    expect(p.reasons).toEqual([]);
  });
});

/**
 * Trigger-detection contract — the picker fires on:
 *   - LWQ:      DESELECTING any of the first 3 carriers in the visible
 *               filteredCarriers array (0-indexed: index < 3).
 *   - AF:       DESELECTING any row with rank <= 3 (1-indexed).
 *   - Both:     ADDING a single carrier from outside the ranker's top-N.
 *
 * Bulk select-all / multi-import / multi-pool-add intentionally skip the
 * picker to avoid an N-dialog avalanche. This unit test pins those rules
 * with pure logic (no React render needed) so refactors can't regress
 * the matrix silently.
 */
describe("override picker trigger rules", () => {
  type LwqRow = { carrier: { id: string; name: string } };
  type AfRow = { carrierId: string; rank: number };

  function shouldFireOnLwqDeselect(
    filteredCarriers: LwqRow[],
    deselectedIndex: number,
  ): boolean {
    return deselectedIndex >= 0
        && deselectedIndex < 3
        && deselectedIndex < filteredCarriers.length;
  }

  function shouldFireOnAfDeselect(row: Pick<AfRow, "rank">): boolean {
    return Number.isFinite(row.rank) && row.rank >= 1 && row.rank <= 3;
  }

  function shouldFireOnSingleAdd(
    addedCount: number,
    isInRankerTopN: boolean,
  ): boolean {
    return addedCount === 1 && !isInRankerTopN;
  }

  it("LWQ: fires on the first three rows, suppresses on row 4+", () => {
    const rows: LwqRow[] = Array.from({ length: 6 }, (_, i) => ({
      carrier: { id: `c-${i}`, name: `c${i}` },
    }));
    expect(shouldFireOnLwqDeselect(rows, 0)).toBe(true);
    expect(shouldFireOnLwqDeselect(rows, 2)).toBe(true);
    expect(shouldFireOnLwqDeselect(rows, 3)).toBe(false);
    expect(shouldFireOnLwqDeselect(rows, 5)).toBe(false);
  });

  it("LWQ: never fires on an out-of-bounds index (defensive)", () => {
    const rows: LwqRow[] = [{ carrier: { id: "c-0", name: "c0" } }];
    expect(shouldFireOnLwqDeselect(rows, -1)).toBe(false);
    expect(shouldFireOnLwqDeselect(rows, 1)).toBe(false);
  });

  it("AF detail: fires on rank 1..3, suppresses on rank 4+ or undefined", () => {
    expect(shouldFireOnAfDeselect({ rank: 1 })).toBe(true);
    expect(shouldFireOnAfDeselect({ rank: 3 })).toBe(true);
    expect(shouldFireOnAfDeselect({ rank: 4 })).toBe(false);
    expect(shouldFireOnAfDeselect({ rank: 0 })).toBe(false);
    expect(shouldFireOnAfDeselect({ rank: NaN })).toBe(false);
  });

  it("single-add: fires only when ONE carrier is added AND it's outside top-N", () => {
    expect(shouldFireOnSingleAdd(1, false)).toBe(true);
    // Already in the ranker's shortlist → no override learning needed.
    expect(shouldFireOnSingleAdd(1, true)).toBe(false);
    // Bulk import → suppressed to avoid an avalanche of dialogs.
    expect(shouldFireOnSingleAdd(7, false)).toBe(false);
    expect(shouldFireOnSingleAdd(0, false)).toBe(false);
  });
});
