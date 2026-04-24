/**
 * Unit tests for the load_fact carrier-history extension to the carrier ranker.
 *
 * Covers the two pure pieces of logic introduced by the fix for empty
 * Available Freight shortlists:
 *
 *   1. mergeHistoryMaps — combines financial-upload history with load_fact
 *      history without losing tier or recency signal.
 *   2. extractCarrierHistoryFromLoadFact — when called for a lane that has
 *      no rows, returns an empty map without throwing (best-effort contract).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHistoryMaps, extractCarrierHistoryFromLoadFact } from "../carrierRankingService";

type CH = ReturnType<typeof mergeHistoryMaps> extends Map<string, infer V> ? V : never;

function ch(partial: Partial<CH> = {}): CH {
  return {
    loads: 1,
    exactLoads: 1,
    nearbyLoads: 0,
    statePairLoads: 0,
    lastUsedMonth: "2026-01",
    avgOnTimePct: null,
    totalMargin: null,
    marginRowCount: 0,
    bestMatchTier: "exact",
    ...partial,
  };
}

test("mergeHistoryMaps — sums load counts per tier across both sources", () => {
  const uploads = new Map<string, CH>([
    ["acme trucking", ch({ loads: 3, exactLoads: 3, lastUsedMonth: "2025-09" })],
  ]);
  const loadFact = new Map<string, CH>([
    ["acme trucking", ch({
      loads: 5, exactLoads: 2, nearbyLoads: 3, lastUsedMonth: "2026-02",
      bestMatchTier: "nearby",
    })],
  ]);

  const merged = mergeHistoryMaps(uploads, loadFact);
  const acme = merged.get("acme trucking")!;
  assert.equal(acme.loads, 8);
  assert.equal(acme.exactLoads, 5);
  assert.equal(acme.nearbyLoads, 3);
  // Better tier wins (exact beats nearby).
  assert.equal(acme.bestMatchTier, "exact");
  // More recent month wins.
  assert.equal(acme.lastUsedMonth, "2026-02");
});

test("mergeHistoryMaps — carriers only present in load_fact still surface", () => {
  const uploads = new Map<string, CH>();
  const loadFact = new Map<string, CH>([
    ["new carrier inc", ch({ loads: 7, exactLoads: 7, lastUsedMonth: "2026-03" })],
  ]);
  const merged = mergeHistoryMaps(uploads, loadFact);
  assert.equal(merged.size, 1);
  assert.equal(merged.get("new carrier inc")?.loads, 7);
});

test("mergeHistoryMaps — preserves on-time / margin from upload side when load_fact is null", () => {
  const uploads = new Map<string, CH>([
    ["delta logistics", ch({
      loads: 4, avgOnTimePct: 92.5, totalMargin: 1500, marginRowCount: 4,
    })],
  ]);
  const loadFact = new Map<string, CH>([
    ["delta logistics", ch({ loads: 6, lastUsedMonth: "2026-04" })],
  ]);
  const merged = mergeHistoryMaps(uploads, loadFact);
  const d = merged.get("delta logistics")!;
  assert.equal(d.loads, 10);
  // load_fact contributes null on-time, so the upload value passes through.
  assert.equal(d.avgOnTimePct, 92.5);
  assert.equal(d.totalMargin, 1500);
  assert.equal(d.marginRowCount, 4);
});

test("extractCarrierHistoryFromLoadFact — returns empty map for an unknown org without throwing", async () => {
  const fakeLane = {
    id: "lane-test",
    orgId: "org-does-not-exist-xyz",
    origin: "Macon, GA",
    destination: "Phoenix, AZ",
    originState: "GA",
    destinationState: "AZ",
    equipmentType: "V",
  } as any;

  const result = await extractCarrierHistoryFromLoadFact(fakeLane.orgId, fakeLane);
  assert.ok(result instanceof Map);
  assert.equal(result.size, 0);
});
