/**
 * Intel Route — Admin-only market intelligence endpoint
 * GET  /api/intel          — returns Daily Insights + Bi-Weekly Scorecard + Executive Report
 *   ?userId=xxx            — filters lane scorecard/insights to a specific rep's lanes
 * GET  /api/intel/users    — returns list of reps who appear in financial data
 * POST /api/intel/send-now — triggers an immediate intel email to all org admins
 */

import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { resolveColumns, getRepFromRow, getCustomerFromRow, getStatusFromRow } from "../colResolver";
import { isExcludedRow } from "../financialHelpers";
import {
  getNationalMarketSummary,
  getMarketOtris,
  getLaneSpotRate,
  type NationalMarketSummary,
  type MarketOtri,
} from "../sonarClient";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

function logIntel(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [intel] ${msg}`);
}

// ── Bi-Weekly refresh cycle tracking ─────────────────────────────────────────

const BIWEEKLY_STAMP_FILE = join(process.cwd(), ".data", "intel_biweekly_ts.json");

function getLastBiweeklyTs(): number {
  try {
    const d = JSON.parse(readFileSync(BIWEEKLY_STAMP_FILE, "utf-8"));
    return d.ts ?? 0;
  } catch {
    return 0;
  }
}

function saveBiweeklyTs(ts: number) {
  try {
    const dir = join(process.cwd(), ".data");
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(BIWEEKLY_STAMP_FILE, JSON.stringify({ ts }), "utf-8");
  } catch {}
}

// ── Lane computation helpers ──────────────────────────────────────────────────

function normStr(s: string) {
  return (s ?? "").toString().trim().toLowerCase();
}

function getWeekKey(dateStr: string): string {
  const datePart = String(dateStr).trim().slice(0, 10);
  const d = new Date(datePart + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
}

function getRecentWeekKeys(n: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = getWeekKey(d.toISOString().split("T")[0]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.reverse();
}

interface LaneData {
  key: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string;
  companyName: string;
  byWeek: Map<string, { revenue: number; carrierPay: number; margin: number; loads: number }>;
  totalLoads: number;
  totalRevenue: number;
  totalCarrierPay: number;
  avgPayPerLoad: number;
  carrierPays: number[];
  marginPctLast6Weeks: number[];
  marginTrend: "easing" | "tightening" | "stable";
  ownerUserId: string | null;
  ownerName: string;
}

function buildLanesFromRows(
  rows: any[],
  cols: ReturnType<typeof resolveColumns>,
  sixWeekKeys: string[],
  threeWeekKeys: string[],
  allUsers: any[],
  orgId: string,
): LaneData[] {
  const laneMap = new Map<string, LaneData>();

  for (const row of rows) {
    if (isExcludedRow(row, cols)) continue;
    if (getStatusFromRow(row, cols) === "void") continue;

    const origin = normStr(row[cols.origin] ?? row[cols.shipperCity] ?? "");
    const originState = normStr(row[cols.originState] ?? row[cols.shipperState] ?? "");
    const destination = normStr(row[cols.destination] ?? row[cols.consigneeCity] ?? "");
    const destinationState = normStr(row[cols.destinationState] ?? row[cols.consigneeState] ?? "");
    const equipment = normStr(row[cols.equipmentType] ?? "");
    const customer = getCustomerFromRow(row, cols);
    const dateStr = row[cols.deliveryDate] ?? row[cols.dateOrdered] ?? "";
    const weekKey = getWeekKey(String(dateStr));

    if (!origin || !destination || !weekKey) continue;
    if (!sixWeekKeys.includes(weekKey)) continue;

    const revenue = Number(row[cols.totalCharges] ?? row[cols.revenue] ?? 0) || 0;
    const carrierPay = Number(row[cols.carrierPay] ?? row[cols.freightCharge] ?? 0) || 0;
    const marginDollar = revenue - carrierPay;

    const key = `${origin}|${destination}|${equipment}|${customer}`;

    if (!laneMap.has(key)) {
      const repName = getRepFromRow(row, cols);
      // Match by financialRepId first, then by name
      const ownerUser = allUsers.find((u: any) => {
        if (u.financialRepId && repName && u.financialRepId.toLowerCase() === repName.toLowerCase()) return true;
        return u.name && repName && (
          u.name.toLowerCase().includes(repName) || repName.includes(u.name.toLowerCase())
        );
      });

      laneMap.set(key, {
        key,
        origin,
        originState,
        destination,
        destinationState,
        equipmentType: equipment,
        companyName: customer,
        byWeek: new Map(),
        totalLoads: 0,
        totalRevenue: 0,
        totalCarrierPay: 0,
        avgPayPerLoad: 0,
        carrierPays: [],
        marginPctLast6Weeks: [],
        marginTrend: "stable",
        ownerUserId: ownerUser?.id ?? null,
        ownerName: ownerUser?.name ?? repName ?? "Unknown",
      });
    }

    const lane = laneMap.get(key)!;

    const weekData = lane.byWeek.get(weekKey) ?? { revenue: 0, carrierPay: 0, margin: 0, loads: 0 };
    weekData.revenue += revenue;
    weekData.carrierPay += carrierPay;
    weekData.margin += marginDollar;
    weekData.loads += 1;
    lane.byWeek.set(weekKey, weekData);

    lane.totalLoads += 1;
    lane.totalRevenue += revenue;
    lane.totalCarrierPay += carrierPay;

    if (threeWeekKeys.includes(weekKey) && carrierPay > 0) {
      lane.carrierPays.push(carrierPay);
    }
  }

  for (const [, lane] of laneMap) {
    lane.avgPayPerLoad = lane.totalLoads > 0 ? lane.totalRevenue / lane.totalLoads : 0;

    const weekPcts: number[] = [];
    for (const wk of sixWeekKeys) {
      const wd = lane.byWeek.get(wk);
      if (wd && wd.revenue > 0) {
        weekPcts.push((wd.margin / wd.revenue) * 100);
      } else {
        weekPcts.push(0);
      }
    }
    lane.marginPctLast6Weeks = weekPcts;

    const last3 = sixWeekKeys.slice(3);
    const prior3 = sixWeekKeys.slice(0, 3);
    let last3Pay = 0; let last3Cnt = 0;
    let prior3Pay = 0; let prior3Cnt = 0;
    for (const wk of last3) {
      const wd = lane.byWeek.get(wk);
      if (wd && wd.loads > 0) { last3Pay += wd.carrierPay; last3Cnt += wd.loads; }
    }
    for (const wk of prior3) {
      const wd = lane.byWeek.get(wk);
      if (wd && wd.loads > 0) { prior3Pay += wd.carrierPay; prior3Cnt += wd.loads; }
    }
    const avgLast = last3Cnt > 0 ? last3Pay / last3Cnt : 0;
    const avgPrior = prior3Cnt > 0 ? prior3Pay / prior3Cnt : 0;
    if (avgLast > avgPrior * 1.03) lane.marginTrend = "tightening";
    else if (avgLast < avgPrior * 0.97) lane.marginTrend = "easing";
    else lane.marginTrend = "stable";
  }

  return Array.from(laneMap.values());
}

// ── Buy rate calculation ──────────────────────────────────────────────────────

function computeBuyRateRange(
  carrierPays: number[],
  loadCount: number,
  originOtri: number,
): { low: number; high: number } {
  if (carrierPays.length === 0) return { low: 0, high: 0 };

  const sorted = [...carrierPays].sort((a, b) => a - b);
  const p25Idx = Math.floor(sorted.length * 0.25);
  const p75Idx = Math.floor(sorted.length * 0.75);
  const p25 = sorted[p25Idx] ?? sorted[0];
  const p75 = sorted[p75Idx] ?? sorted[sorted.length - 1];

  const avgMiles = 500;
  const lowPerMile = p25 / avgMiles;
  const highPerMile = p75 / avgMiles;

  let adjustment = 0;
  if (originOtri > 25) adjustment = 0.1;
  else if (originOtri > 10) adjustment = 0.05;

  return {
    low: Math.round((lowPerMile * (1 + adjustment)) * 100) / 100,
    high: Math.round((highPerMile * (1 + adjustment)) * 100) / 100,
  };
}

// ── Lane alerts ───────────────────────────────────────────────────────────────

interface LaneAlert {
  lane: string;
  signal: string;
  action: string;
  severity: "high" | "medium" | "low";
}

function computeLaneAlerts(lanes: LaneData[], marketOtris: MarketOtri[]): LaneAlert[] {
  const alerts: LaneAlert[] = [];
  const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

  for (const lane of lanes) {
    const laneDisplay = `${lane.origin} → ${lane.destination}`;

    const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
    if (originOtri > 25) {
      alerts.push({
        lane: laneDisplay,
        signal: `Origin market tight (OTRI ${originOtri.toFixed(1)}%)`,
        action: "Consider booking carriers earlier or adjusting buy rate upward.",
        severity: "high",
      });
    }

    if (lane.marginTrend === "tightening") {
      alerts.push({
        lane: laneDisplay,
        signal: "Carrier rates tightening (last 3 weeks vs prior 3 weeks)",
        action: "Review carrier relationships and consider locking in capacity now.",
        severity: "medium",
      });
    }

    const pcts = lane.marginPctLast6Weeks;
    let declineStreak = 0;
    for (let i = pcts.length - 1; i > 0; i--) {
      if (pcts[i] < pcts[i - 1]) declineStreak++;
      else break;
    }
    if (declineStreak >= 3) {
      const latestMargin = pcts[pcts.length - 1];
      alerts.push({
        lane: laneDisplay,
        signal: `Margin declining ${declineStreak} weeks in a row (now ${latestMargin.toFixed(1)}%)`,
        action: "Re-price with customer or reduce carrier cost to protect margin.",
        severity: "high",
      });
    }
  }

  return alerts.slice(0, 10);
}

// ── Spot rate opportunities ────────────────────────────────────────────────────

interface SpotOpportunity {
  lane: string;
  origin: string;
  destination: string;
  historicalCustomerRate: number;
  expectedCarrierCost: number;
  estimatedMarginGap: number;
}

async function computeSpotOpportunities(lanes: LaneData[]): Promise<SpotOpportunity[]> {
  const opportunities: SpotOpportunity[] = [];

  for (const lane of lanes.slice(0, 15)) {
    const spotRate = await getLaneSpotRate(lane.origin, lane.destination);
    if (!spotRate || spotRate.ratePerMile <= 0) continue;

    const avgCustomerRate = lane.avgPayPerLoad;
    if (avgCustomerRate <= 0) continue;

    const estimatedCarrierCost = spotRate.ratePerMile * 500;
    const marginGap = ((avgCustomerRate - estimatedCarrierCost) / avgCustomerRate) * 100;

    if (marginGap > 15) {
      opportunities.push({
        lane: `${lane.origin} → ${lane.destination}`,
        origin: lane.origin,
        destination: lane.destination,
        historicalCustomerRate: avgCustomerRate,
        expectedCarrierCost: estimatedCarrierCost,
        estimatedMarginGap: Math.round(marginGap * 10) / 10,
      });
    }
  }

  opportunities.sort((a, b) => b.estimatedMarginGap - a.estimatedMarginGap);
  return opportunities.slice(0, 3);
}

// ── Scorecard status badge ────────────────────────────────────────────────────

function getScorecardStatus(marginPct: number): { status: string; color: "green" | "blue" | "yellow" | "red" } {
  if (marginPct >= 25) return { status: "SCALE", color: "green" };
  if (marginPct >= 15) return { status: "GROW", color: "blue" };
  if (marginPct >= 8) return { status: "WATCH", color: "yellow" };
  return { status: "HOLD", color: "red" };
}

// ── Executive report computation ──────────────────────────────────────────────

function computeExecutiveReport(allLanes: LaneData[], allUsers: any[], sixWeekKeys: string[]) {
  // ─ Company (customer) breakdown ────────────────────────────────────────────
  const companyMap = new Map<string, { revenue: number; carrierPay: number; loads: number }>();
  for (const lane of allLanes) {
    const key = lane.companyName || "Unknown";
    const cur = companyMap.get(key) ?? { revenue: 0, carrierPay: 0, loads: 0 };
    cur.revenue += lane.totalRevenue;
    cur.carrierPay += lane.totalCarrierPay;
    cur.loads += lane.totalLoads;
    companyMap.set(key, cur);
  }
  const topCompanies = Array.from(companyMap.entries())
    .map(([name, d]) => ({
      name,
      revenue: Math.round(d.revenue),
      loads: d.loads,
      marginPct: d.revenue > 0 ? Math.round(((d.revenue - d.carrierPay) / d.revenue) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // ─ Rep leaderboard ─────────────────────────────────────────────────────────
  const repMap = new Map<string, { name: string; revenue: number; carrierPay: number; loads: number; userId: string | null }>();
  for (const lane of allLanes) {
    const key = lane.ownerUserId ?? lane.ownerName ?? "unassigned";
    const cur = repMap.get(key) ?? { name: lane.ownerName || "Unassigned", revenue: 0, carrierPay: 0, loads: 0, userId: lane.ownerUserId };
    cur.revenue += lane.totalRevenue;
    cur.carrierPay += lane.totalCarrierPay;
    cur.loads += lane.totalLoads;
    repMap.set(key, cur);
  }
  const repLeaderboard = Array.from(repMap.values())
    .map(r => ({
      name: r.name,
      userId: r.userId,
      revenue: Math.round(r.revenue),
      loads: r.loads,
      marginPct: r.revenue > 0 ? Math.round(((r.revenue - r.carrierPay) / r.revenue) * 1000) / 10 : 0,
    }))
    .filter(r => r.loads > 0)
    .sort((a, b) => b.marginPct - a.marginPct)
    .slice(0, 10);

  // ─ Lane health distribution ────────────────────────────────────────────────
  const distribution = { SCALE: 0, GROW: 0, WATCH: 0, HOLD: 0 };
  for (const lane of allLanes) {
    const marginPct = lane.totalRevenue > 0 ? ((lane.totalRevenue - lane.totalCarrierPay) / lane.totalRevenue) * 100 : 0;
    const { status } = getScorecardStatus(marginPct);
    (distribution as any)[status] = ((distribution as any)[status] ?? 0) + 1;
  }
  const totalLanesCount = allLanes.length || 1;
  const healthDistribution = {
    SCALE: { count: distribution.SCALE, pct: Math.round((distribution.SCALE / totalLanesCount) * 100) },
    GROW:  { count: distribution.GROW,  pct: Math.round((distribution.GROW  / totalLanesCount) * 100) },
    WATCH: { count: distribution.WATCH, pct: Math.round((distribution.WATCH / totalLanesCount) * 100) },
    HOLD:  { count: distribution.HOLD,  pct: Math.round((distribution.HOLD  / totalLanesCount) * 100) },
  };

  // ─ Equipment type breakdown ────────────────────────────────────────────────
  const equipMap = new Map<string, { revenue: number; carrierPay: number; loads: number }>();
  for (const lane of allLanes) {
    const eq = lane.equipmentType || "Unknown";
    const cur = equipMap.get(eq) ?? { revenue: 0, carrierPay: 0, loads: 0 };
    cur.revenue += lane.totalRevenue;
    cur.carrierPay += lane.totalCarrierPay;
    cur.loads += lane.totalLoads;
    equipMap.set(eq, cur);
  }
  const equipmentBreakdown = Array.from(equipMap.entries())
    .map(([type, d]) => ({
      type: type || "Unknown",
      revenue: Math.round(d.revenue),
      loads: d.loads,
      marginPct: d.revenue > 0 ? Math.round(((d.revenue - d.carrierPay) / d.revenue) * 1000) / 10 : 0,
    }))
    .filter(e => e.loads > 0)
    .sort((a, b) => b.revenue - a.revenue);

  // ─ Weekly revenue trend (org-wide) ────────────────────────────────────────
  const weeklyTrend = sixWeekKeys.map(wk => {
    let wkRev = 0; let wkCost = 0; let wkLoads = 0;
    for (const lane of allLanes) {
      const wd = lane.byWeek.get(wk);
      if (wd) { wkRev += wd.revenue; wkCost += wd.carrierPay; wkLoads += wd.loads; }
    }
    return {
      weekKey: wk,
      revenue: Math.round(wkRev),
      margin: wkRev > 0 ? Math.round(((wkRev - wkCost) / wkRev) * 1000) / 10 : 0,
      loads: wkLoads,
    };
  });

  return { topCompanies, repLeaderboard, healthDistribution, equipmentBreakdown, weeklyTrend };
}

// ── Core intel computation (shared between GET and send-now) ──────────────────

export async function computeIntelPayload(orgId: string, filterUserId?: string) {
  const allUsers = await storage.getUsers(orgId);
  const uploads = await storage.getFinancialUploadsForOrg(orgId);
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  let allRows: any[] = [];
  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as any[]) ?? [];
    allRows = allRows.concat(rows);
  }

  const cols = allRows.length > 0 ? resolveColumns(allRows) : resolveColumns([]);
  const sixWeekKeys = getRecentWeekKeys(6);
  const threeWeekKeys = getRecentWeekKeys(3);

  // All lanes — used for executive report + user roster
  const allLanes = buildLanesFromRows(allRows, cols, sixWeekKeys, threeWeekKeys, allUsers, orgId);

  // Optionally filter lanes by rep for the scorecard/insights view
  const lanes = filterUserId
    ? allLanes.filter(l => l.ownerUserId === filterUserId)
    : allLanes;

  // Sonar data
  const national = await getNationalMarketSummary();
  const uniqueMarkets = Array.from(new Set([
    ...allLanes.map(l => l.origin),
    ...allLanes.map(l => l.destination),
  ])).filter(Boolean).slice(0, 20);
  const marketOtris = await getMarketOtris(uniqueMarkets);
  const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

  // Daily insights for the (possibly filtered) lane set
  const laneAlerts = computeLaneAlerts(lanes, marketOtris);
  const spotOpportunities = await computeSpotOpportunities(lanes);

  const top5Lanes = [...lanes]
    .sort((a, b) => b.totalLoads - a.totalLoads)
    .slice(0, 5)
    .map(lane => {
      const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
      const buyRate = computeBuyRateRange(lane.carrierPays, lane.totalLoads, originOtri);
      return {
        lane: `${lane.origin} → ${lane.destination}`,
        origin: lane.origin,
        destination: lane.destination,
        equipment: lane.equipmentType,
        totalLoads: lane.totalLoads,
        buyRateLow: buyRate.low,
        buyRateHigh: buyRate.high,
        originOtri,
      };
    });

  // Bi-weekly scorecard
  const now = Date.now();
  const lastBiweeklyTs = getLastBiweeklyTs();
  const daysSinceRefresh = (now - lastBiweeklyTs) / (1000 * 60 * 60 * 24);
  const biweeklyDue = daysSinceRefresh >= 14 || lastBiweeklyTs === 0;
  if (biweeklyDue && !filterUserId) saveBiweeklyTs(now);

  const nextUpdateDays = biweeklyDue ? 14 : Math.ceil(14 - daysSinceRefresh);

  const top10Lanes = [...lanes]
    .sort((a, b) => b.totalLoads - a.totalLoads)
    .slice(0, 10)
    .map(lane => {
      const avg6WkMarginPct = lane.totalRevenue > 0
        ? ((lane.totalRevenue - lane.totalCarrierPay) / lane.totalRevenue) * 100
        : 0;
      const statusInfo = getScorecardStatus(avg6WkMarginPct);
      const originOtri = otriByMarket.get(lane.origin.toLowerCase()) ?? 15;
      const destOtri = otriByMarket.get(lane.destination.toLowerCase()) ?? 15;
      const buyRate = computeBuyRateRange(lane.carrierPays, lane.totalLoads, originOtri);
      const originSignal = originOtri > 25 ? "red" : originOtri > 10 ? "yellow" : "green";
      const destSignal = destOtri > 25 ? "red" : destOtri > 10 ? "yellow" : "green";

      return {
        lane: `${lane.origin} → ${lane.destination}`,
        origin: lane.origin,
        originState: lane.originState,
        destination: lane.destination,
        destinationState: lane.destinationState,
        equipment: lane.equipmentType,
        status: statusInfo.status,
        statusColor: statusInfo.color,
        avg6WkMarginPct: Math.round(avg6WkMarginPct * 10) / 10,
        totalLoads: lane.totalLoads,
        avgPayPerLoad: Math.round(lane.avgPayPerLoad),
        carrierRateTrend: lane.marginTrend,
        weeklyMarginPcts: lane.marginPctLast6Weeks.map(p => Math.round(p * 10) / 10),
        buyRateLow: buyRate.low,
        buyRateHigh: buyRate.high,
        originOtri,
        destOtri,
        originSignal,
        destSignal,
      };
    });

  // Overall stats for the current view
  const totalLoads6Wk = lanes.reduce((s, l) => s + l.totalLoads, 0);
  const totalRevenue6Wk = lanes.reduce((s, l) => s + l.totalRevenue, 0);
  const totalCarrierPay6Wk = lanes.reduce((s, l) => s + l.totalCarrierPay, 0);
  const overallMarginPct = totalRevenue6Wk > 0
    ? ((totalRevenue6Wk - totalCarrierPay6Wk) / totalRevenue6Wk) * 100
    : 0;

  const totalReps = allUsers.filter(u =>
    ["account_manager", "national_account_manager", "admin"].includes(u.role)
  ).length;

  let bestWeekLabel = "";
  let bestWeekMargin = 0;
  for (const wkKey of sixWeekKeys) {
    let wkRev = 0; let wkCost = 0;
    for (const lane of lanes) {
      const wd = lane.byWeek.get(wkKey);
      if (wd) { wkRev += wd.revenue; wkCost += wd.carrierPay; }
    }
    const pct = wkRev > 0 ? ((wkRev - wkCost) / wkRev) * 100 : 0;
    if (pct > bestWeekMargin) { bestWeekMargin = pct; bestWeekLabel = wkKey; }
  }

  // Who we're looking at
  const viewUser = filterUserId ? allUsers.find(u => u.id === filterUserId) : null;
  const greetingName = viewUser ? viewUser.name.split(" ")[0] : (allUsers.find(u => u.role === "admin")?.name.split(" ")[0] ?? "there");

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  // Rep roster for the dropdown (anyone who owns at least 1 lane)
  const repRoster = Array.from(
    new Map(
      allLanes
        .filter(l => l.ownerUserId)
        .map(l => [l.ownerUserId, { id: l.ownerUserId!, name: l.ownerName }])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  // Executive report (always org-wide)
  const executiveReport = computeExecutiveReport(allLanes, allUsers, sixWeekKeys);

  return {
    viewUserId: filterUserId ?? null,
    viewUserName: viewUser?.name ?? null,
    availableReps: repRoster,
    dailyInsights: {
      greeting: `Good morning, ${greetingName}`,
      date: dateStr,
      marketPulse: national,
      laneAlerts,
      spotOpportunities,
      buyRateQuickLook: top5Lanes,
      sonarTimestamp: national.timestamp,
      sonarIsStale: national.isStale,
    },
    biweeklyScorecard: {
      lastRefreshDate: new Date(lastBiweeklyTs || now).toISOString(),
      nextUpdateDays,
      overallStats: {
        totalLoads: totalLoads6Wk,
        totalRevenue: Math.round(totalRevenue6Wk),
        overallMarginPct: Math.round(overallMarginPct * 10) / 10,
        repRank: 1,
        totalReps,
        bestWeek: bestWeekLabel,
        bestWeekMarginPct: Math.round(bestWeekMargin * 10) / 10,
      },
      lanes: top10Lanes,
    },
    executiveReport,
  };
}

// ── Main route registration ───────────────────────────────────────────────────

export function registerIntelRoutes(app: Express): void {
  // ── GET /api/intel ──────────────────────────────────────────────────────────
  app.get("/api/intel", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });

      const orgId = req.session.organizationId!;
      const filterUserId = typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : undefined;

      const payload = await computeIntelPayload(orgId, filterUserId);
      logIntel(`Intel payload generated — ${filterUserId ? `user ${filterUserId}` : "all reps"}`);
      res.json(payload);
    } catch (err: any) {
      console.error("[intel] Error:", err);
      res.status(500).json({ error: "Failed to generate intel" });
    }
  });

  // ── POST /api/intel/send-now ────────────────────────────────────────────────
  app.post("/api/intel/send-now", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });

      const orgId = req.session.organizationId!;
      logIntel(`Manual intel send triggered by ${user.name}`);

      // Import the send function dynamically to avoid circular deps
      const { sendIntelNowForOrg } = await import("../intelEmailScheduler");
      await sendIntelNowForOrg(orgId);

      res.json({ ok: true, message: "Intel report sent to all admin users" });
    } catch (err: any) {
      console.error("[intel] Send-now error:", err);
      res.status(500).json({ error: "Failed to send intel report" });
    }
  });
}
