/**
 * load_fact parity harness (Task #368).
 *
 * Computes side-by-side aggregates from the legacy reads
 * (`financial_uploads.rows` + `freight_opportunities`) and the new
 * `load_fact` substrate, and returns a drift report. The cutover gate uses
 * this to refuse flipping `load_fact_active` ON if drift is excessive.
 *
 * The harness reports both global aggregates AND per-page/per-metric
 * breakdowns (per carrier, per month, per account manager) so admins can
 * pinpoint exactly where a difference comes from before they cut over.
 */

import { sql } from "drizzle-orm";
import { storage, db } from "./storage";
import { readTmsField, parseCarrierName } from "./carrierRankingService";
import { bucketForMoveStatus } from "./carrierIntelligenceService";

export interface ParityMetricRow {
  realizedLoads: number;
  availableLoads: number;
  realizedRevenue: number;
  realizedCost: number;
  realizedMargin: number;
}

export interface ParityBreakdownRow {
  key: string;
  legacy: ParityMetricRow;
  loadFact: ParityMetricRow;
  drift: {
    realizedLoadsDelta: number;
    availableLoadsDelta: number;
    revenueDelta: number;
    marginDelta: number;
    maxAbsPct: number;
  };
  withinTolerance: boolean;
}

export interface ParityReport {
  generatedAt: string;
  global: {
    legacy: ParityMetricRow & { rowsScanned: number; distinctOrderIds: number };
    loadFact: ParityMetricRow & { totalRows: number };
    drift: {
      realizedLoadsDelta: number;
      realizedLoadsDeltaPct: number;
      availableLoadsDelta: number;
      availableLoadsDeltaPct: number;
      revenueDelta: number;
      revenueDeltaPct: number;
      marginDelta: number;
      marginDeltaPct: number;
      maxAbsPct: number;
    };
    withinTolerance: boolean;
  };
  byCarrier: ParityBreakdownRow[];
  byMonth: ParityBreakdownRow[];
  byAccountManager: ParityBreakdownRow[];
  withinTolerance: boolean;
  tolerancePct: number;
  notes: string[];
}

function pct(delta: number, base: number): number {
  if (base === 0) return delta === 0 ? 0 : 100;
  return (delta / base) * 100;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function emptyMetric(): ParityMetricRow {
  return { realizedLoads: 0, availableLoads: 0, realizedRevenue: 0, realizedCost: 0, realizedMargin: 0 };
}

interface LegacyAggregateState {
  global: ParityMetricRow & { rowsScanned: number; distinctOrderIds: number };
  byCarrier: Map<string, ParityMetricRow>;
  byMonth: Map<string, ParityMetricRow>;
  byAccountManager: Map<string, ParityMetricRow>;
}

async function legacyAggregates(orgId: string): Promise<LegacyAggregateState> {
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const state: LegacyAggregateState = {
    global: { ...emptyMetric(), rowsScanned: 0, distinctOrderIds: 0 },
    byCarrier: new Map(), byMonth: new Map(), byAccountManager: new Map(),
  };
  const orderIds = new Set<string>();

  function bump(map: Map<string, ParityMetricRow>, key: string, patch: Partial<ParityMetricRow>): void {
    const cur = map.get(key) ?? emptyMetric();
    cur.realizedLoads += patch.realizedLoads ?? 0;
    cur.availableLoads += patch.availableLoads ?? 0;
    cur.realizedRevenue += patch.realizedRevenue ?? 0;
    cur.realizedCost += patch.realizedCost ?? 0;
    cur.realizedMargin += patch.realizedMargin ?? 0;
    map.set(key, cur);
  }

  for (const upload of uploads) {
    const rows = Array.isArray(upload.rows) ? (upload.rows as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      state.global.rowsScanned++;
      const orderId = readTmsField(row, "Order ID", "OrderID", "orderId", "Order #", "Load ID");
      if (orderId) orderIds.add(orderId);
      const moveStatus = readTmsField(row, "Move Status", "MoveStatus", "Status", "status");
      const bucket = bucketForMoveStatus(moveStatus);
      // Legacy financial_uploads were monthly post-mortem exports — every row
      // counted as realized when Move Status was missing. Preserve that to
      // make the parity comparison fair against the old read path.
      const treatAsRealized = bucket === "realized" || (!moveStatus && bucket === "unknown");
      if (!treatAsRealized) continue;
      const rev = parseFloat(String(readTmsField(row, "Revenue", "revenue", "Linehaul Revenue") || "").replace(/[$,]/g, "")) || 0;
      const cost = parseFloat(String(readTmsField(row, "Cost", "cost", "Carrier Cost", "Linehaul Cost") || "").replace(/[$,]/g, "")) || 0;
      const margin = parseFloat(String(readTmsField(row, "Margin", "margin", "Profit", "GM", "Gross Margin") || "").replace(/[$,]/g, "")) || (rev - cost);
      const carrier = parseCarrierName(readTmsField(row, "Carrier", "Carrier Name", "carrier") || "") || "(unknown)";
      const month = readTmsField(row, "Month", "month") || (readTmsField(row, "Pickup Date", "pickupDate") || "").slice(0, 7) || "(no month)";
      const am = readTmsField(row, "Account Manager", "accountManager", "AM") || "(unassigned)";
      const patch: Partial<ParityMetricRow> = {
        realizedLoads: 1, realizedRevenue: rev, realizedCost: cost, realizedMargin: margin,
      };
      state.global.realizedLoads += 1;
      state.global.realizedRevenue += rev;
      state.global.realizedCost += cost;
      state.global.realizedMargin += margin;
      bump(state.byCarrier, carrier, patch);
      bump(state.byMonth, month, patch);
      bump(state.byAccountManager, am, patch);
    }
  }

  // Available = open freight_opportunities (legacy "Available Freight" path).
  const opps = await storage.listFreightOpportunities(orgId, {
    status: ["new", "ready_to_send", "sent", "partially_covered"],
    limit: 10000, offset: 0,
  });
  state.global.availableLoads = opps.length;
  state.global.distinctOrderIds = orderIds.size;
  return state;
}

interface LoadFactAggregateState {
  global: ParityMetricRow & { totalRows: number };
  byCarrier: Map<string, ParityMetricRow>;
  byMonth: Map<string, ParityMetricRow>;
  byAccountManager: Map<string, ParityMetricRow>;
}

async function loadFactAggregates(orgId: string): Promise<LoadFactAggregateState> {
  // Single grouped query covering all the breakdown dimensions at once.
  const result = await db.execute<{
    carrier: string | null;
    month: string | null;
    account_manager: string | null;
    bucket: string;
    n: string | number;
    revenue: string | number | null;
    cost: string | number | null;
    margin: string | number | null;
  }>(sql`
    SELECT carrier_name AS carrier, month, account_manager, bucket,
           COUNT(*) AS n,
           COALESCE(SUM(revenue), 0) AS revenue,
           COALESCE(SUM(cost), 0)    AS cost,
           COALESCE(SUM(margin), 0)  AS margin
      FROM load_fact
     WHERE org_id = ${orgId}
     GROUP BY carrier_name, month, account_manager, bucket
  `);
  const rows = Array.isArray(result)
    ? (result as Array<{ carrier: string | null; month: string | null; account_manager: string | null; bucket: string; n: string | number; revenue: string | number | null; cost: string | number | null; margin: string | number | null }>)
    : ((result as { rows: Array<{ carrier: string | null; month: string | null; account_manager: string | null; bucket: string; n: string | number; revenue: string | number | null; cost: string | number | null; margin: string | number | null }> }).rows ?? []);

  const state: LoadFactAggregateState = {
    global: { ...emptyMetric(), totalRows: 0 },
    byCarrier: new Map(), byMonth: new Map(), byAccountManager: new Map(),
  };

  function bump(map: Map<string, ParityMetricRow>, key: string, patch: Partial<ParityMetricRow>): void {
    const cur = map.get(key) ?? emptyMetric();
    cur.realizedLoads += patch.realizedLoads ?? 0;
    cur.availableLoads += patch.availableLoads ?? 0;
    cur.realizedRevenue += patch.realizedRevenue ?? 0;
    cur.realizedCost += patch.realizedCost ?? 0;
    cur.realizedMargin += patch.realizedMargin ?? 0;
    map.set(key, cur);
  }

  for (const r of rows) {
    const n = Number(r.n) || 0;
    const rev = Number(r.revenue) || 0;
    const cost = Number(r.cost) || 0;
    const margin = Number(r.margin) || 0;
    const isRealized = r.bucket === "realized";
    const isAvailable = r.bucket === "available" || r.bucket === "unknown";
    state.global.totalRows += n;
    const patch: Partial<ParityMetricRow> = {
      realizedLoads: isRealized ? n : 0,
      availableLoads: isAvailable ? n : 0,
      realizedRevenue: isRealized ? rev : 0,
      realizedCost: isRealized ? cost : 0,
      realizedMargin: isRealized ? margin : 0,
    };
    state.global.realizedLoads += patch.realizedLoads ?? 0;
    state.global.availableLoads += patch.availableLoads ?? 0;
    state.global.realizedRevenue += patch.realizedRevenue ?? 0;
    state.global.realizedCost += patch.realizedCost ?? 0;
    state.global.realizedMargin += patch.realizedMargin ?? 0;
    bump(state.byCarrier, r.carrier ?? "(unknown)", patch);
    bump(state.byMonth, r.month ?? "(no month)", patch);
    bump(state.byAccountManager, r.account_manager ?? "(unassigned)", patch);
  }
  return state;
}

function diffRow(legacy: ParityMetricRow, lf: ParityMetricRow, tolerancePct: number): ParityBreakdownRow["drift"] & { withinTolerance: boolean } {
  const realizedLoadsDelta = lf.realizedLoads - legacy.realizedLoads;
  const availableLoadsDelta = lf.availableLoads - legacy.availableLoads;
  const revenueDelta = lf.realizedRevenue - legacy.realizedRevenue;
  const marginDelta = lf.realizedMargin - legacy.realizedMargin;
  const maxAbsPct = Math.max(
    Math.abs(pct(realizedLoadsDelta, legacy.realizedLoads)),
    Math.abs(pct(availableLoadsDelta, legacy.availableLoads)),
    Math.abs(pct(revenueDelta, legacy.realizedRevenue)),
    Math.abs(pct(marginDelta, legacy.realizedMargin)),
  );
  return {
    realizedLoadsDelta,
    availableLoadsDelta,
    revenueDelta: round2(revenueDelta),
    marginDelta: round2(marginDelta),
    maxAbsPct: round2(maxAbsPct),
    withinTolerance: maxAbsPct <= tolerancePct,
  };
}

function buildBreakdown(
  legacyMap: Map<string, ParityMetricRow>,
  lfMap: Map<string, ParityMetricRow>,
  tolerancePct: number,
): ParityBreakdownRow[] {
  const keys = new Set<string>([...legacyMap.keys(), ...lfMap.keys()]);
  const out: ParityBreakdownRow[] = [];
  for (const key of keys) {
    const legacy = legacyMap.get(key) ?? emptyMetric();
    const lf = lfMap.get(key) ?? emptyMetric();
    const drift = diffRow(legacy, lf, tolerancePct);
    out.push({ key, legacy, loadFact: lf, drift, withinTolerance: drift.withinTolerance });
  }
  // Sort by largest drift first so admins see the worst offenders at the top.
  out.sort((a, b) => b.drift.maxAbsPct - a.drift.maxAbsPct);
  return out;
}

export async function runParityHarness(orgId: string, tolerancePct = 5): Promise<ParityReport> {
  const [legacy, lf] = await Promise.all([
    legacyAggregates(orgId),
    loadFactAggregates(orgId),
  ]);

  const realizedLoadsDelta = lf.global.realizedLoads - legacy.global.realizedLoads;
  const availableLoadsDelta = lf.global.availableLoads - legacy.global.availableLoads;
  const revenueDelta = lf.global.realizedRevenue - legacy.global.realizedRevenue;
  const marginDelta = lf.global.realizedMargin - legacy.global.realizedMargin;
  const realizedLoadsDeltaPct = pct(realizedLoadsDelta, legacy.global.realizedLoads);
  const availableLoadsDeltaPct = pct(availableLoadsDelta, legacy.global.availableLoads);
  const revenueDeltaPct = pct(revenueDelta, legacy.global.realizedRevenue);
  const marginDeltaPct = pct(marginDelta, legacy.global.realizedMargin);
  const maxAbsPct = Math.max(
    Math.abs(realizedLoadsDeltaPct),
    Math.abs(availableLoadsDeltaPct),
    Math.abs(revenueDeltaPct),
    Math.abs(marginDeltaPct),
  );

  const byCarrier = buildBreakdown(legacy.byCarrier, lf.byCarrier, tolerancePct).slice(0, 50);
  const byMonth = buildBreakdown(legacy.byMonth, lf.byMonth, tolerancePct);
  const byAccountManager = buildBreakdown(legacy.byAccountManager, lf.byAccountManager, tolerancePct).slice(0, 50);

  const allWithinTolerance =
    maxAbsPct <= tolerancePct &&
    byCarrier.every(r => r.withinTolerance) &&
    byMonth.every(r => r.withinTolerance) &&
    byAccountManager.every(r => r.withinTolerance);

  const notes: string[] = [];
  if (lf.global.totalRows === 0) notes.push("load_fact is empty for this org — run backfill before measuring parity.");
  if (legacy.global.rowsScanned === 0) notes.push("No legacy financial_uploads rows found — parity comparison is trivially zero.");
  if (!allWithinTolerance) notes.push(`Drift exceeds ${tolerancePct}% tolerance somewhere — investigate before flipping load_fact_active.`);

  return {
    generatedAt: new Date().toISOString(),
    global: {
      legacy: {
        ...legacy.global,
        realizedRevenue: round2(legacy.global.realizedRevenue),
        realizedCost: round2(legacy.global.realizedCost),
        realizedMargin: round2(legacy.global.realizedMargin),
      },
      loadFact: {
        ...lf.global,
        realizedRevenue: round2(lf.global.realizedRevenue),
        realizedCost: round2(lf.global.realizedCost),
        realizedMargin: round2(lf.global.realizedMargin),
      },
      drift: {
        realizedLoadsDelta,
        realizedLoadsDeltaPct: round2(realizedLoadsDeltaPct),
        availableLoadsDelta,
        availableLoadsDeltaPct: round2(availableLoadsDeltaPct),
        revenueDelta: round2(revenueDelta),
        revenueDeltaPct: round2(revenueDeltaPct),
        marginDelta: round2(marginDelta),
        marginDeltaPct: round2(marginDeltaPct),
        maxAbsPct: round2(maxAbsPct),
      },
      withinTolerance: maxAbsPct <= tolerancePct,
    },
    byCarrier,
    byMonth,
    byAccountManager,
    withinTolerance: allWithinTolerance,
    tolerancePct,
    notes,
  };
}
