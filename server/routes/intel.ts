/**
 * Intel Route — Admin-only market intelligence endpoint
 * GET  /api/intel          — returns Daily Insights + Bi-Weekly Scorecard + Executive Report
 *   ?userId=xxx            — filters lane scorecard/insights to a specific rep's lanes
 * GET  /api/intel/users    — returns list of reps who appear in financial data
 * GET  /api/intel/brief    — AI-generated personalized daily brief (4-hour cache)
 * GET  /api/intel/my-lanes — personalized heat panel for the current user's lanes
 * POST /api/intel/send-now — triggers an immediate intel email to all org admins
 */

import type { Express, Request, Response } from "express";
import { db, storage } from "../storage";
import { eq, and, gte } from "drizzle-orm";
import { intelTrackedLanes, intelLaneRates, recurringLanes } from "../../shared/schema";
import { requireAuth, getCurrentUser } from "../auth";
import { cityToKma, toTracEquipment } from "../kmaMapping";
import { fetchFullLaneBatch } from "../tracService";
import { generateAlert, generateDriverText } from "../tracAlertEngine";
import { resolveColumns, getRepFromRow, getCustomerFromRow, getStatusFromRow } from "../colResolver";
import { isExcludedRow } from "../financialHelpers";
import {
  getNationalMarketSummary,
  getMarketOtris,
  getMarketOtrisExtended,
  getLaneSpotRate,
  getLaneVotrisBatch,
  buildVotriQualifier,
  type NationalMarketSummary,
  type MarketOtri,
  type MarketExtended,
  type LaneVotri,
} from "../sonarClient";
import {
  getAlertNarrative,
  getSpotOpportunityNarrative,
  getBuyRateRationale,
  getLaneNarrativesBatch,
  getExecutiveBrief,
  getPerplexityMarketContext,
  type MarketContextItem,
} from "../aiHelpers";
import { getWeatherFlagsForCities, type WeatherFlag } from "../weatherService";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import OpenAI from "openai";

function logIntel(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [intel] ${msg}`);
}

// ── OpenAI client (lazy-initialized) ─────────────────────────────────────────

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (!apiKey) {
      throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY is not configured — AI brief unavailable");
    }
    _openai = new OpenAI({ apiKey, baseURL });
  }
  return _openai;
}

// ── AI Brief cache (4-hour TTL per user) ─────────────────────────────────────

interface AiBriefResult {
  bullets: string[];
  generatedAt: string;
  isStale: boolean;
}

const aiBriefCache = new Map<string, { result: AiBriefResult; fetchedAt: number }>();
const AI_BRIEF_TTL = 4 * 60 * 60 * 1000; // 4 hours

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

/**
 * Compute buy rate range using lane-level VOTRI when available,
 * falling back to origin market OTRI.
 * VOTRI (van tender rejection index) at the lane level is more precise
 * than origin market OTRI for determining carrier availability pressure.
 */
function computeBuyRateRange(
  carrierPays: number[],
  loadCount: number,
  votriOrOtri: number,  // prefer lane VOTRI, fall back to origin OTRI
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

  // Use VOTRI (or OTRI fallback) for adjustment — hot market = higher buy rate
  let adjustment = 0;
  if (votriOrOtri > 25) adjustment = 0.1;
  else if (votriOrOtri > 10) adjustment = 0.05;

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
  aiNarrative?: string | null;
  votri?: number | null;
}

/**
 * Compute lane alerts using lane-level VOTRI for alert severity when available,
 * with origin market OTRI as fallback for lanes where VOTRI is stale/unavailable.
 */
function computeLaneAlerts(
  lanes: LaneData[],
  marketOtris: MarketOtri[],
  votriByQualifier: Map<string, LaneVotri>,
): LaneAlert[] {
  const alerts: LaneAlert[] = [];
  const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m.otri]));

  for (const lane of lanes) {
    const laneDisplay = `${lane.origin} → ${lane.destination}`;
    const qualifier = buildVotriQualifier(lane.origin, lane.destination);
    const laneVotri = votriByQualifier.get(qualifier);

    // Prefer lane-level VOTRI for alert severity; fall back to origin market OTRI
    const effectiveRejectionRate = (laneVotri && !laneVotri.isStale)
      ? laneVotri.votri
      : (otriByMarket.get(lane.origin.toLowerCase()) ?? 15);
    const votriValue = (laneVotri && !laneVotri.isStale) ? laneVotri.votri : null;

    if (effectiveRejectionRate > 25) {
      const signalLabel = laneVotri && !laneVotri.isStale
        ? `Lane VOTRI tight (${effectiveRejectionRate.toFixed(1)}%)`
        : `Origin market tight (OTRI ${effectiveRejectionRate.toFixed(1)}%)`;
      alerts.push({
        lane: laneDisplay,
        signal: signalLabel,
        action: "Consider booking carriers earlier or adjusting buy rate upward.",
        severity: "high",
        votri: votriValue,
      });
    }

    if (lane.marginTrend === "tightening") {
      alerts.push({
        lane: laneDisplay,
        signal: "Carrier rates tightening (last 3 weeks vs prior 3 weeks)",
        action: "Review carrier relationships and consider locking in capacity now.",
        severity: "medium",
        votri: votriValue,
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
        votri: votriValue,
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
  aiNarrative?: string | null;
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

// ── AI Daily Brief generation ─────────────────────────────────────────────────

async function generateAiBrief(
  userId: string,
  userName: string,
  orgId: string,
  topAccounts: Array<{ name: string; revenue: number }>,
  topLanes: Array<{ origin: string; destination: string; votri?: number; votriWoW?: number; marketOtri?: number; marketOtriWoW?: number }>,
  national: NationalMarketSummary,
): Promise<AiBriefResult> {
  const cacheKey = `${orgId}:${userId}`;
  const cached = aiBriefCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AI_BRIEF_TTL) {
    return cached.result;
  }

  const accountNames = topAccounts.slice(0, 10).map(a => `${a.name} ($${Math.round(a.revenue / 1000)}K)`).join(", ");
  const lanesText = topLanes.slice(0, 15).map(l => {
    const votriStr = l.votri !== undefined ? ` VOTRI=${l.votri?.toFixed(1)}% (WoW ${l.votriWoW !== undefined ? (l.votriWoW! >= 0 ? "+" : "") + l.votriWoW?.toFixed(1) : "n/a"}pp)` : "";
    const otriStr = l.marketOtri !== undefined ? `, market OTRI=${l.marketOtri.toFixed(1)}% (WoW ${l.marketOtriWoW !== undefined ? (l.marketOtriWoW >= 0 ? "+" : "") + l.marketOtriWoW.toFixed(1) : "n/a"}pp)` : "";
    return `${l.origin} → ${l.destination}${votriStr}${otriStr}`;
  }).join("\n");

  const prompt = `You are a freight intelligence analyst briefing ${userName}, a freight sales rep.

Today's national market conditions:
- National OTRI: ${national.otri.toFixed(2)}% (WoW: ${national.otriWoWDelta >= 0 ? "+" : ""}${national.otriWoWDelta.toFixed(1)}pp)
- NTI Spot Rate: $${Math.round(national.ntiPerMove).toLocaleString()}/move (WoW: ${national.ntiWoWDelta >= 0 ? "+" : ""}$${Math.abs(national.ntiWoWDelta).toFixed(0)})
- Contract Rate: $${national.ntiPerMile.toFixed(2)}/mi
- Diesel: $${national.dieselPerGal.toFixed(2)}/gal (WoW: ${national.dieselMoMDelta >= 0 ? "+" : ""}$${Math.abs(national.dieselMoMDelta).toFixed(3)})

${userName}'s top accounts (by revenue): ${accountNames || "No account data available"}

${userName}'s active lanes with market signals (VOTRI = van tender rejection rate; market OTRI = overall tender rejection rate for the origin market):
${lanesText || "No lane data available"}

Write 3-5 concise, plain-English action bullets that ${userName} can act on TODAY. Each bullet should:
- Be specific to their accounts or lanes (not generic market commentary)
- Connect a market signal to a concrete sales action
- Be 1-2 sentences max
- Start with a verb (e.g. "Call...", "Lock in...", "Flag...", "Consider...")

Format: Return ONLY the bullet list, one bullet per line, starting each with "• ".`;

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.7,
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const bullets = rawText
      .split("\n")
      .map(line => line.replace(/^[•\-\*]\s*/, "").trim())
      .filter(line => line.length > 20)
      .slice(0, 5);

    const result: AiBriefResult = {
      bullets: bullets.length > 0 ? bullets : ["Market data loaded — no specific insights generated at this time."],
      generatedAt: new Date().toISOString(),
      isStale: false,
    };
    aiBriefCache.set(cacheKey, { result, fetchedAt: Date.now() });
    logIntel(`AI brief generated for user ${userId} (${bullets.length} bullets)`);
    return result;
  } catch (err: any) {
    logIntel(`AI brief error for user ${userId}: ${err.message}`);
    const fallback: AiBriefResult = {
      bullets: ["Market intelligence brief temporarily unavailable. SONAR data is live — check market pulse below."],
      generatedAt: new Date().toISOString(),
      isStale: true,
    };
    aiBriefCache.set(cacheKey, { result: fallback, fetchedAt: Date.now() - AI_BRIEF_TTL + 15 * 60 * 1000 }); // retry in 15min
    return fallback;
  }
}

// ── Awarded RFP lane extraction ───────────────────────────────────────────────

/**
 * Parse an award lane string like "Atlanta, GA → Chicago, IL (500 loads)"
 * into { origin, destination } using the "→" separator as the split point.
 * Returns null if unparseable.
 */
function parseAwardLane(laneStr: string): { origin: string; destination: string } | null {
  const sep = "→";
  const arrowIdx = laneStr.indexOf(sep);
  if (arrowIdx < 0) return null;
  let origin = laneStr.slice(0, arrowIdx).trim();
  let dest = laneStr.slice(arrowIdx + sep.length).trim();
  // Strip trailing "(NNN loads)" from destination
  dest = dest.replace(/\s*\(\d+\s+loads?\)\s*$/i, "").trim();
  // Normalize: take just the city name before the comma (if "City, ST" format)
  const originCity = origin.split(",")[0].trim().toLowerCase();
  const destCity = dest.split(",")[0].trim().toLowerCase();
  if (!originCity || !destCity) return null;
  return { origin: originCity, destination: destCity };
}

/**
 * Returns a deduplicated list of { origin, destination } pairs from awarded RFPs
 * for the given user (via company salesPersonId ownership).
 * Awards with empty lanes arrays are skipped.
 */
async function getAwardedRfpLanesForUser(
  orgId: string,
  userId: string,
): Promise<Array<{ origin: string; destination: string; companyName: string }>> {
  try {
    // Load org companies owned by this user and all org awards
    const [allCompanies, allAwards] = await Promise.all([
      storage.getCompanies(orgId),
      storage.getAwards(),
    ]);
    const userCompanyIds = new Set(
      allCompanies
        .filter((c: any) => c.salesPersonId === userId)
        .map((c: any) => c.id),
    );
    const companyNameById = new Map<string, string>(allCompanies.map((c: any) => [c.id, c.name]));

    const lanes: Array<{ origin: string; destination: string; companyName: string }> = [];
    const seen = new Set<string>();
    for (const award of allAwards) {
      if (!userCompanyIds.has(award.companyId)) continue;
      if (!award.lanes || award.lanes.length === 0) continue;
      const companyName = companyNameById.get(award.companyId) ?? "Unknown";
      for (const laneStr of award.lanes) {
        const parsed = parseAwardLane(laneStr);
        if (!parsed) continue;
        const key = `${parsed.origin}|${parsed.destination}|${companyName}`;
        if (!seen.has(key)) {
          seen.add(key);
          lanes.push({ ...parsed, companyName });
        }
      }
    }
    return lanes;
  } catch {
    return []; // non-blocking
  }
}

// ── My Lanes personalized heat panel ─────────────────────────────────────────

export interface MyLanesRow {
  origin: string;
  destination: string;
  qualifier: string;
  votri: number;
  votriWoW: number;
  signal: "hot" | "warm" | "cool";
  avgCustomerRate: number | null;
  tracSpotRpm: number | null;
  rateDelta: "above" | "below" | "unknown";
  rateDeltaPct: number | null;
  weatherOrigin: WeatherFlag | null;
  weatherDest: WeatherFlag | null;
  totalLoads: number;
  companyName: string;
}

async function computeMyLanes(
  lanes: LaneData[],
  national: NationalMarketSummary,
  orgId: string,
): Promise<MyLanesRow[]> {
  if (lanes.length === 0) return [];

  const dedupedLanes = Array.from(
    new Map(lanes.map(l => [`${l.origin}|${l.destination}|${l.companyName}`, l])).values()
  );

  const uniqueOdPairs = Array.from(
    new Map(dedupedLanes.map(l => [`${l.origin}|${l.destination}`, { origin: l.origin, destination: l.destination }])).values()
  );
  const votriMap = await getLaneVotrisBatch(uniqueOdPairs);

  const allCities = Array.from(new Set([
    ...dedupedLanes.map(l => l.origin),
    ...dedupedLanes.map(l => l.destination),
  ])).filter(Boolean);

  let weatherMap = new Map<string, WeatherFlag>();
  try {
    weatherMap = await getWeatherFlagsForCities(allCities);
  } catch {
    // weather failure is non-blocking
  }

  // Build TRAC lane-specific rate lookup from cached intel_lane_rates
  const tracRateMap = new Map<string, number>(); // "ORIG_KMA|DEST_KMA" → spotRpm
  try {
    const tracRows = await db
      .select({
        origin: intelTrackedLanes.origin,
        destination: intelTrackedLanes.destination,
        spotRpm: intelLaneRates.spotRpm,
        avgRpm90d: intelLaneRates.avgRpm90d,
      })
      .from(intelLaneRates)
      .innerJoin(intelTrackedLanes, eq(intelLaneRates.trackedLaneId, intelTrackedLanes.id))
      .where(
        and(
          eq(intelTrackedLanes.orgId, orgId),
          eq(intelTrackedLanes.active, true),
        )
      );
    for (const r of tracRows) {
      const key = `${r.origin}|${r.destination}`;
      const rate = r.spotRpm ? parseFloat(r.spotRpm) : (r.avgRpm90d ? parseFloat(r.avgRpm90d) : null);
      if (rate && rate > 0) tracRateMap.set(key, rate);
    }
  } catch (err) {
    console.log("[intel] TRAC rate lookup for My Lanes failed (non-blocking):", err);
  }

  const rows: MyLanesRow[] = dedupedLanes.map(lane => {
    const qualifier = buildVotriQualifier(lane.origin, lane.destination);
    const votriData = votriMap.get(qualifier);
    const votri = votriData?.votri ?? 0;
    const votriWoW = votriData?.votriWoW ?? 0;
    const signal = votriData?.signal ?? "cool";

    const avgMiles = 500;
    const avgCustomerRatePerMile = lane.avgPayPerLoad > 0 ? lane.avgPayPerLoad / avgMiles : null;
    let rateDelta: "above" | "below" | "unknown" = "unknown";
    let rateDeltaPct: number | null = null;

    // Look up TRAC lane-specific spot rate by mapping city to KMA
    const origKma = cityToKma(lane.origin);
    const destKma = cityToKma(lane.destination);
    const tracKey = origKma && destKma ? `${origKma.kma}|${destKma.kma}` : null;
    const tracSpot = tracKey ? (tracRateMap.get(tracKey) ?? null) : null;

    if (avgCustomerRatePerMile !== null && tracSpot !== null && tracSpot > 0) {
      const delta = ((avgCustomerRatePerMile - tracSpot) / tracSpot) * 100;
      rateDelta = delta >= 0 ? "above" : "below";
      rateDeltaPct = Math.round(delta * 10) / 10;
    }

    const weatherOrigin = weatherMap.get(lane.origin.toLowerCase().trim()) ?? null;
    const weatherDest = weatherMap.get(lane.destination.toLowerCase().trim()) ?? null;

    return {
      origin: lane.origin,
      destination: lane.destination,
      qualifier,
      votri,
      votriWoW,
      signal,
      avgCustomerRate: avgCustomerRatePerMile !== null ? Math.round(avgCustomerRatePerMile * 100) / 100 : null,
      tracSpotRpm: tracSpot !== null ? Math.round(tracSpot * 100) / 100 : null,
      rateDelta,
      rateDeltaPct,
      weatherOrigin,
      weatherDest,
      totalLoads: lane.totalLoads,
      companyName: lane.companyName,
    };
  });

  rows.sort((a, b) => b.votri !== a.votri ? b.votri - a.votri : b.totalLoads - a.totalLoads);
  return rows;
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

  // ── Sonar data ────────────────────────────────────────────────────────────
  const national = await getNationalMarketSummary();

  // Collect all unique origin and destination markets across all lanes (for OTRI lookup used by scorecard/alerts)
  const uniqueOrigins = Array.from(new Set(allLanes.map(l => l.origin))).filter(Boolean);
  const uniqueDestinations = Array.from(new Set(allLanes.map(l => l.destination))).filter(Boolean);
  const allUniqueMarkets = Array.from(new Set([...uniqueOrigins, ...uniqueDestinations]));

  // Fetch OTRI for all markets — used by computeLaneAlerts, scorecard, buy rate
  const marketOtris = await getMarketOtris(allUniqueMarkets).catch(() => [] as MarketOtri[]);
  const otriByMarket = new Map(marketOtris.map(m => [m.market.toLowerCase(), m]));

  // VOTRI: fetch for ALL lanes owned by the user (not capped at top N)
  const allLanePairs = lanes.map(l => ({ origin: l.origin, destination: l.destination }));
  let votriByQualifier = new Map<string, LaneVotri>();
  if (allLanePairs.length > 0) {
    votriByQualifier = await getLaneVotrisBatch(allLanePairs);
    logIntel(`VOTRI fetched for ${votriByQualifier.size} lanes`);
  }

  // Market trend table: scope to the active lane set (filtered by rep if applicable).
  // Rank markets by load count so the rep's highest-volume markets appear first,
  // then cap at top 10. Also fetch OTVI/HAI extended indices for the trend table.
  const marketLoadCount = new Map<string, number>();
  for (const l of lanes) {
    marketLoadCount.set(l.origin, (marketLoadCount.get(l.origin) ?? 0) + l.totalLoads);
    marketLoadCount.set(l.destination, (marketLoadCount.get(l.destination) ?? 0) + l.totalLoads);
  }
  const top10PersonalizedMarkets = Array.from(marketLoadCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m)
    .filter(Boolean)
    .slice(0, 10);

  const extendedMarkets = await getMarketOtrisExtended(top10PersonalizedMarkets).catch(() => [] as MarketExtended[]);

  // ── Sonar Market Trends table ──────────────────────────────────────────────
  // Sorted by OTRI descending. ibOtri populated for any market used as a destination.
  const destinationSet = new Set(uniqueDestinations);
  const sonarMarketTrends = extendedMarkets
    .sort((a, b) => b.otri - a.otri)
    .slice(0, 20)
    .map(m => {
      const trendSource = m.votriWoW ?? m.otriWoW;
      return {
        market:   m.market,
        otri:     m.otri,
        otriWoW:  m.otriWoW,
        votri:    m.votri,
        votriWoW: m.votriWoW,
        otvi:     m.otvi,
        hai:      m.hai,
        signal:   m.signal,
        trendDir: trendSource > 0.5 ? "↑" : trendSource < -0.5 ? "↓" : "→",
        // ibOtri: always set for any market that is used as a destination (IB = inbound)
        ibOtri: destinationSet.has(m.market) ? m.otri : null,
      };
    });

  // Daily insights for the (possibly filtered) lane set
  const laneAlerts = computeLaneAlerts(lanes, marketOtris, votriByQualifier);
  const spotOpportunities = await computeSpotOpportunities(lanes);

  // ── AI: generate narratives in parallel (OpenAI) ──────────────────────────
  // Alert narratives
  const alertsWithNarratives = await Promise.all(
    laneAlerts.map(async (alert) => {
      const qualifier = buildVotriQualifier(
        alert.lane.split(" → ")[0]?.trim() ?? "",
        alert.lane.split(" → ")[1]?.trim() ?? "",
      );
      const laneVotri = votriByQualifier.get(qualifier);
      const originOtri = otriByMarket.get((alert.lane.split(" → ")[0]?.trim() ?? "").toLowerCase())?.otri ?? 15;
      const narrative = await getAlertNarrative(
        alert.lane,
        alert.signal,
        alert.action,
        alert.severity,
        originOtri,
        laneVotri && !laneVotri.isStale ? laneVotri.votri : null,
      );
      return { ...alert, aiNarrative: narrative };
    }),
  );

  // Spot opportunity narratives
  const spotWithNarratives = await Promise.all(
    spotOpportunities.map(async (opp) => {
      const narrative = await getSpotOpportunityNarrative(
        opp.lane,
        opp.historicalCustomerRate,
        opp.expectedCarrierCost,
        opp.estimatedMarginGap,
      );
      return { ...opp, aiNarrative: narrative };
    }),
  );

  // Buy rate quick-look (top 5 lanes by load count)
  const top5LanesData = [...lanes]
    .sort((a, b) => b.totalLoads - a.totalLoads)
    .slice(0, 5);

  const top5Lanes = await Promise.all(
    top5LanesData.map(async (lane) => {
      const qualifier = buildVotriQualifier(lane.origin, lane.destination);
      const laneVotri = votriByQualifier.get(qualifier);
      const votriVal = (laneVotri && !laneVotri.isStale) ? laneVotri.votri : null;
      const originMarketOtri = otriByMarket.get(lane.origin.toLowerCase())?.otri ?? 15;
      // Use lane VOTRI for buy rate adjustment if available; otherwise use origin market OTRI
      const effectiveRate = votriVal !== null ? votriVal : originMarketOtri;
      const buyRate = computeBuyRateRange(lane.carrierPays, lane.totalLoads, effectiveRate);

      const rationale = await getBuyRateRationale(
        `${lane.origin} → ${lane.destination}`,
        buyRate.low,
        buyRate.high,
        originMarketOtri,
        votriVal,
      );

      return {
        lane: `${lane.origin} → ${lane.destination}`,
        origin: lane.origin,
        destination: lane.destination,
        equipment: lane.equipmentType,
        totalLoads: lane.totalLoads,
        buyRateLow: buyRate.low,
        buyRateHigh: buyRate.high,
        originOtri: originMarketOtri,
        votri: votriVal,
        aiRationale: rationale,
      };
    }),
  );

  // ── Perplexity market context ─────────────────────────────────────────────
  // Query using top 3–5 origin markets by load count
  const topOriginMarkets = [...uniqueOrigins]
    .map(m => ({ market: m, loads: lanes.filter(l => l.origin === m).reduce((s, l) => s + l.totalLoads, 0) }))
    .sort((a, b) => b.loads - a.loads)
    .slice(0, 5)
    .map(m => m.market);

  const perplexityContext = await getPerplexityMarketContext(topOriginMarkets).catch(() => null);

  // ── Bi-weekly scorecard ───────────────────────────────────────────────────
  const now = Date.now();
  const lastBiweeklyTs = getLastBiweeklyTs();
  const daysSinceRefresh = (now - lastBiweeklyTs) / (1000 * 60 * 60 * 24);
  const biweeklyDue = daysSinceRefresh >= 14 || lastBiweeklyTs === 0;
  if (biweeklyDue && !filterUserId) saveBiweeklyTs(now);

  const nextUpdateDays = biweeklyDue ? 14 : Math.ceil(14 - daysSinceRefresh);

  // All recurring lanes for the scorecard (no top-N cap; show all user lanes)
  const allScorecardLanesData = [...lanes].sort((a, b) => b.totalLoads - a.totalLoads);

  // Build deterministic scorecard data first (VOTRI, buy rates, signals)
  const scorecardBase = allScorecardLanesData.map((lane) => {
    const avg6WkMarginPct = lane.totalRevenue > 0
      ? ((lane.totalRevenue - lane.totalCarrierPay) / lane.totalRevenue) * 100
      : 0;
    const statusInfo = getScorecardStatus(avg6WkMarginPct);

    const qualifier = buildVotriQualifier(lane.origin, lane.destination);
    const laneVotri = votriByQualifier.get(qualifier);
    const votriVal = (laneVotri && !laneVotri.isStale) ? laneVotri.votri : null;

    const originMarketOtri = otriByMarket.get(lane.origin.toLowerCase())?.otri ?? 15;
    const destMarketOtri = otriByMarket.get(lane.destination.toLowerCase())?.otri ?? 15;

    const effectiveRate = votriVal !== null ? votriVal : originMarketOtri;
    const buyRate = computeBuyRateRange(lane.carrierPays, lane.totalLoads, effectiveRate);

    const originSignal = originMarketOtri > 25 ? "red" : originMarketOtri > 10 ? "yellow" : "green";
    const destSignal = destMarketOtri > 25 ? "red" : destMarketOtri > 10 ? "yellow" : "green";

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
      originOtri: originMarketOtri,
      destOtri: destMarketOtri,
      votri: votriVal,
      originSignal,
      destSignal,
      // narrative placeholder; filled below via bounded-concurrency batch
      aiNarrative: null as string | null,
      // kept for AI call
      _marginTrend: lane.marginTrend,
      _marginPcts: lane.marginPctLast6Weeks,
    };
  });

  // Claude: 2–3 sentence strategic lane narratives with bounded concurrency
  // (MAX_CLAUDE_CONCURRENCY cap prevents rate-limit errors on large lane sets)
  const narrativeInputs = scorecardBase.map(e => ({
    lane: e.lane,
    avg6WkMarginPct: e.avg6WkMarginPct,
    marginTrend: e._marginTrend,
    weeklyMarginPcts: e._marginPcts,
    totalLoads: e.totalLoads,
    votri: e.votri,
    destOtri: e.destOtri,
  }));
  const narratives = await getLaneNarrativesBatch(narrativeInputs);

  const scorecardEntries = scorecardBase.map((e, i) => {
    const { _marginTrend: _mt, _marginPcts: _mp, ...rest } = e;
    return { ...rest, aiNarrative: narratives[i] ?? null };
  });

  // ── Overall stats for the current view ───────────────────────────────────
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

  // ── Claude: executive brief ───────────────────────────────────────────────
  const executiveReport = computeExecutiveReport(allLanes, allUsers, sixWeekKeys);
  const healthDistFlat = {
    SCALE: executiveReport.healthDistribution.SCALE.count,
    GROW:  executiveReport.healthDistribution.GROW.count,
    WATCH: executiveReport.healthDistribution.WATCH.count,
    HOLD:  executiveReport.healthDistribution.HOLD.count,
  };
  const topCompanyForBrief = executiveReport.topCompanies[0]?.name ?? "";

  const executiveBrief = await getExecutiveBrief(
    totalLoads6Wk,
    totalRevenue6Wk,
    overallMarginPct,
    healthDistFlat,
    topCompanyForBrief,
    bestWeekLabel,
  );

  // ── Who we're looking at ──────────────────────────────────────────────────
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

  return {
    viewUserId: filterUserId ?? null,
    viewUserName: viewUser?.name ?? null,
    availableReps: repRoster,
    sonarMarketTrends,
    dailyInsights: {
      greeting: `Good morning, ${greetingName}`,
      date: dateStr,
      marketPulse: national,
      laneAlerts: alertsWithNarratives,
      spotOpportunities: spotWithNarratives,
      buyRateQuickLook: top5Lanes,
      sonarTimestamp: national.timestamp,
      sonarIsStale: national.isStale,
      marketContext: perplexityContext ?? undefined,
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
      lanes: scorecardEntries,
    },
    executiveReport: {
      ...executiveReport,
      executiveBrief,
    },
  };
}

// ── Main route registration ───────────────────────────────────────────────────

export function registerIntelRoutes(app: Express): void {
  // ── GET /api/intel ──────────────────────────────────────────────────────────
  // Admins: full org-wide view, can filter by ?userId
  // account_manager / national_account_manager: self-scoped view (userId param ignored)
  app.get("/api/intel", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowedRoles = ["admin", "account_manager", "national_account_manager"];
      if (!allowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });

      const orgId = req.session.organizationId!;
      // Non-admins are always scoped to their own data
      let filterUserId: string | undefined;
      if (user.role === "admin") {
        filterUserId = typeof req.query.userId === "string" && req.query.userId.trim()
          ? req.query.userId.trim()
          : undefined;
      } else {
        filterUserId = user.id;
      }

      const payload = await computeIntelPayload(orgId, filterUserId);
      logIntel(`Intel payload generated — ${filterUserId ? `user ${filterUserId}` : "all reps"}`);
      res.json(payload);
    } catch (err: any) {
      console.error("[intel] Error:", err);
      res.status(500).json({ error: "Failed to generate intel" });
    }
  });

  // ── GET /api/intel/brief ────────────────────────────────────────────────────
  // AI-generated personalized daily brief for the requesting user.
  // 4-hour cache per user. Can be force-refreshed with ?refresh=true.
  // Accessible to admin, account_manager, and national_account_manager roles.
  app.get("/api/intel/brief", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowedRoles = ["admin", "account_manager", "national_account_manager"];
      if (!allowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });

      const orgId = req.session.organizationId!;
      const forceRefresh = req.query.refresh === "true";
      if (forceRefresh) {
        const cacheKey = `${orgId}:${user.id}`;
        aiBriefCache.delete(cacheKey);
      }

      // Build context for AI brief
      const allUsers = await storage.getUsers(orgId);
      const uploads = await storage.getFinancialUploadsForOrg(orgId);
      const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      let allRows: any[] = [];
      for (const upload of sorted.slice(0, 3)) {
        allRows = allRows.concat((upload.rows as any[]) ?? []);
      }

      const cols = allRows.length > 0 ? resolveColumns(allRows) : resolveColumns([]);
      const sixWeekKeys = getRecentWeekKeys(6);
      const threeWeekKeys = getRecentWeekKeys(3);
      const userLanes = buildLanesFromRows(allRows, cols, sixWeekKeys, threeWeekKeys, allUsers, orgId)
        .filter(l => l.ownerUserId === user.id);

      // Top accounts by revenue
      const companyRevMap = new Map<string, number>();
      for (const l of userLanes) {
        companyRevMap.set(l.companyName, (companyRevMap.get(l.companyName) ?? 0) + l.totalRevenue);
      }
      const topAccounts = Array.from(companyRevMap.entries())
        .map(([name, revenue]) => ({ name, revenue }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      // Top lanes with VOTRI signals — ranked by load count (frequency) descending before dedup+slice
      // Aggregate total loads per origin→destination pair for ranking
      const laneLoadCounts = new Map<string, number>();
      for (const l of userLanes) {
        const key = `${l.origin}|${l.destination}`;
        laneLoadCounts.set(key, (laneLoadCounts.get(key) ?? 0) + (l.totalLoads ?? 1));
      }
      const uniqueUserLanes = Array.from(
        new Map(
          [...userLanes]
            .sort((a, b) => {
              const keyA = `${a.origin}|${a.destination}`;
              const keyB = `${b.origin}|${b.destination}`;
              return (laneLoadCounts.get(keyB) ?? 0) - (laneLoadCounts.get(keyA) ?? 0);
            })
            .map(l => [`${l.origin}|${l.destination}`, l])
        ).values()
      ).slice(0, 10);

      // Also pull RFP lanes and merge into lane context (new lanes only, deduped)
      const rfpBriefLanes = await getAwardedRfpLanesForUser(orgId, user.id);
      const existingLaneKeys = new Set(uniqueUserLanes.map(l => `${l.origin}|${l.destination}`));
      const rfpOnlyBrief = rfpBriefLanes
        .filter(r => !existingLaneKeys.has(`${r.origin}|${r.destination}`))
        .slice(0, 5); // limit supplementary RFP lanes so prompt stays concise

      const allBriefLanes = [
        ...uniqueUserLanes.map(l => ({ origin: l.origin, destination: l.destination })),
        ...rfpOnlyBrief.map(r => ({ origin: r.origin, destination: r.destination })),
      ];

      // Fetch VOTRI and per-market OTRI in parallel for all relevant lane corridors
      const originMarkets = Array.from(new Set(allBriefLanes.map(l => l.origin.toLowerCase().trim())));
      const [national, votriMap, marketOtriData] = await Promise.all([
        getNationalMarketSummary(),
        getLaneVotrisBatch(allBriefLanes),
        getMarketOtrisExtended(originMarkets.slice(0, 5)).catch(() => [] as MarketExtended[]),
      ]);

      const topLanes = allBriefLanes.map(l => {
        const qualifier = buildVotriQualifier(l.origin, l.destination);
        const votri = votriMap.get(qualifier);
        return {
          origin: l.origin,
          destination: l.destination,
          votri: votri?.votri,
          votriWoW: votri?.votriWoW,
          // Per-market OTRI for origin market context
          marketOtri: marketOtriData.find(m => m.market.toLowerCase().trim() === l.origin.toLowerCase().trim())?.otri,
          marketOtriWoW: marketOtriData.find(m => m.market.toLowerCase().trim() === l.origin.toLowerCase().trim())?.otriWoW,
        };
      });

      const brief = await generateAiBrief(user.id, user.name, orgId, topAccounts, topLanes, national);
      res.json(brief);
    } catch (err: any) {
      console.error("[intel] Brief error:", err);
      res.status(500).json({ error: "Failed to generate brief" });
    }
  });

  // ── GET /api/intel/my-lanes ─────────────────────────────────────────────────
  // Personalized lane heat panel for the requesting user.
  // Accessible to admin, account_manager, and national_account_manager.
  // Non-admin users are always scoped to their own lanes.
  app.get("/api/intel/my-lanes", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allowedRoles = ["admin", "account_manager", "national_account_manager"];
      if (!allowedRoles.includes(user.role)) return res.status(403).json({ error: "Not authorized" });

      const orgId = req.session.organizationId!;
      // Non-admins are always scoped to their own lanes; admins can filter by userId param
      const filterUserId = user.role === "admin" && typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : user.id;

      const allUsers = await storage.getUsers(orgId);
      const uploads = await storage.getFinancialUploadsForOrg(orgId);
      const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      let allRows: any[] = [];
      for (const upload of sorted.slice(0, 3)) {
        allRows = allRows.concat((upload.rows as any[]) ?? []);
      }

      const cols = allRows.length > 0 ? resolveColumns(allRows) : resolveColumns([]);
      const sixWeekKeys = getRecentWeekKeys(6);
      const threeWeekKeys = getRecentWeekKeys(3);
      const userLanes = buildLanesFromRows(allRows, cols, sixWeekKeys, threeWeekKeys, allUsers, orgId)
        .filter(l => l.ownerUserId === filterUserId);

      // Merge awarded RFP lanes as supplementary entries (non-blocking)
      const [rfpLaneItems, national] = await Promise.all([
        getAwardedRfpLanesForUser(orgId, filterUserId),
        getNationalMarketSummary(),
      ]);
      const myLanes = await computeMyLanes(userLanes, national, orgId);

      // Compute VOTRI for RFP lanes not already covered by financial lanes
      const existingKeys = new Set(myLanes.map(r => `${r.origin}|${r.destination}|${r.companyName}`));
      const rfpOnly = rfpLaneItems.filter(r => !existingKeys.has(`${r.origin}|${r.destination}|${r.companyName}`));

      let rfpRows: MyLanesRow[] = [];
      if (rfpOnly.length > 0) {
        const rfpVotriMap = await getLaneVotrisBatch(rfpOnly.map(r => ({ origin: r.origin, destination: r.destination })));
        const rfpCities = Array.from(new Set([...rfpOnly.map(r => r.origin), ...rfpOnly.map(r => r.destination)]));
        let rfpWeatherMap = new Map<string, WeatherFlag>();
        try { rfpWeatherMap = await getWeatherFlagsForCities(rfpCities); } catch { /* non-blocking */ }

        // Reuse TRAC rate map from computeMyLanes context for RFP lanes
        let rfpTracMap = new Map<string, number>();
        try {
          const tracRows = await db
            .select({
              origin: intelTrackedLanes.origin,
              destination: intelTrackedLanes.destination,
              spotRpm: intelLaneRates.spotRpm,
              avgRpm90d: intelLaneRates.avgRpm90d,
            })
            .from(intelLaneRates)
            .innerJoin(intelTrackedLanes, eq(intelLaneRates.trackedLaneId, intelTrackedLanes.id))
            .where(
              and(
                eq(intelTrackedLanes.orgId, orgId),
                eq(intelTrackedLanes.active, true),
              )
            );
          for (const r of tracRows) {
            const key = `${r.origin}|${r.destination}`;
            const rate = r.spotRpm ? parseFloat(r.spotRpm) : (r.avgRpm90d ? parseFloat(r.avgRpm90d) : null);
            if (rate && rate > 0) rfpTracMap.set(key, rate);
          }
        } catch { /* non-blocking */ }

        rfpRows = rfpOnly.map(lane => {
          const qualifier = buildVotriQualifier(lane.origin, lane.destination);
          const votriData = rfpVotriMap.get(qualifier);
          const origKma = cityToKma(lane.origin);
          const destKma = cityToKma(lane.destination);
          const tracKey = origKma && destKma ? `${origKma.kma}|${destKma.kma}` : null;
          const tracSpot = tracKey ? (rfpTracMap.get(tracKey) ?? null) : null;
          return {
            origin: lane.origin,
            destination: lane.destination,
            qualifier,
            votri: votriData?.votri ?? 0,
            votriWoW: votriData?.votriWoW ?? 0,
            signal: votriData?.signal ?? "cool",
            avgCustomerRate: null,
            tracSpotRpm: tracSpot !== null ? Math.round(tracSpot * 100) / 100 : null,
            rateDelta: "unknown" as const,
            rateDeltaPct: null,
            weatherOrigin: rfpWeatherMap.get(lane.origin.toLowerCase().trim()) ?? null,
            weatherDest: rfpWeatherMap.get(lane.destination.toLowerCase().trim()) ?? null,
            totalLoads: 0,
            companyName: lane.companyName,
          };
        });
      }

      const allMyLanes = [...myLanes, ...rfpRows];
      allMyLanes.sort((a, b) => b.votri !== a.votri ? b.votri - a.votri : b.totalLoads - a.totalLoads);

      res.json({
        lanes: allMyLanes,
        lastUpdated: new Date().toISOString(),
        userId: filterUserId,
      });
    } catch (err: any) {
      console.error("[intel] My-lanes error:", err);
      res.status(500).json({ error: "Failed to load my lanes" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TRAC RATE INTELLIGENCE
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/intel/trac/my-lanes ────────────────────────────────────────
  // Returns TRAC rate cards for the current user's assigned LWQ lanes.
  // Auto-syncs tracked lanes from recurring_lanes on first call.
  // Uses a daily cache — live-fetches when stale.
  app.get("/api/intel/trac/my-lanes", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgId = req.session.organizationId!;

      // 1. Pull user's assigned recurring lanes
      const lwqLanes = await db
        .select({
          id: recurringLanes.id,
          origin: recurringLanes.origin,
          originState: recurringLanes.originState,
          destination: recurringLanes.destination,
          destinationState: recurringLanes.destinationState,
          equipmentType: recurringLanes.equipmentType,
        })
        .from(recurringLanes)
        .where(
          and(
            eq(recurringLanes.orgId, orgId),
            eq(recurringLanes.ownerUserId, user.id),
            eq(recurringLanes.isEligible, true),
          ),
        )
        .limit(20);

      // 2. Map to KMA codes — skip lanes we can't map
      type MappedLane = { laneId: string; origin: string; originLabel: string; destination: string; destinationLabel: string; equipment: "VAN" | "REEFER" | "FLATBED"; cityOrigin: string; cityDest: string };
      const mapped: MappedLane[] = [];
      for (const lane of lwqLanes) {
        const originKma = cityToKma(lane.origin, lane.originState);
        const destKma = cityToKma(lane.destination, lane.destinationState);
        if (!originKma || !destKma) continue;
        if (originKma.kma === destKma.kma) continue; // same market = skip
        const equipment = toTracEquipment(lane.equipmentType);
        const key = `${originKma.kma}|${destKma.kma}|${equipment}`;
        if (mapped.some((m) => `${m.origin}|${m.destination}|${m.equipment}` === key)) continue; // dedup
        mapped.push({
          laneId: lane.id,
          origin: originKma.kma,
          originLabel: originKma.label,
          destination: destKma.kma,
          destinationLabel: destKma.label,
          equipment,
          cityOrigin: lane.origin,
          cityDest: lane.destination,
        });
        if (mapped.length >= 12) break;
      }

      if (!mapped.length) {
        return res.json({ lanes: [], source: "empty", reason: "No mapped lanes" });
      }

      // 3. Upsert tracked lane records
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const trackedRows: Array<{ id: string; origin: string; destination: string; equipment: string; originLabel: string | null; destinationLabel: string | null }> = [];

      for (const m of mapped) {
        const existing = await db
          .select({ id: intelTrackedLanes.id, origin: intelTrackedLanes.origin, destination: intelTrackedLanes.destination, equipment: intelTrackedLanes.equipmentType, originLabel: intelTrackedLanes.originLabel, destinationLabel: intelTrackedLanes.destinationLabel })
          .from(intelTrackedLanes)
          .where(
            and(
              eq(intelTrackedLanes.userId, user.id),
              eq(intelTrackedLanes.origin, m.origin),
              eq(intelTrackedLanes.destination, m.destination),
              eq(intelTrackedLanes.equipmentType, m.equipment),
            ),
          )
          .limit(1);

        if (existing.length) {
          trackedRows.push(existing[0]);
        } else {
          const [inserted] = await db
            .insert(intelTrackedLanes)
            .values({
              userId: user.id,
              orgId,
              laneId: m.laneId,
              origin: m.origin,
              originLabel: m.originLabel,
              destination: m.destination,
              destinationLabel: m.destinationLabel,
              equipmentType: m.equipment,
              source: "lwq",
            })
            .returning({ id: intelTrackedLanes.id, origin: intelTrackedLanes.origin, destination: intelTrackedLanes.destination, equipment: intelTrackedLanes.equipmentType, originLabel: intelTrackedLanes.originLabel, destinationLabel: intelTrackedLanes.destinationLabel });
          if (inserted) trackedRows.push(inserted);
        }
      }

      // 4. Check cache freshness — fetch stale ones
      const staleIds: string[] = [];
      const cachedRates = new Map<string, typeof intelLaneRates.$inferSelect>();

      for (const t of trackedRows) {
        const rate = await db
          .select()
          .from(intelLaneRates)
          .where(
            and(
              eq(intelLaneRates.trackedLaneId, t.id),
              gte(intelLaneRates.refreshedAt, today),
            ),
          )
          .limit(1);
        if (rate.length) {
          cachedRates.set(t.id, rate[0]);
        } else {
          staleIds.push(t.id);
        }
      }

      // 5. Live-fetch stale lanes from TRAC
      if (staleIds.length) {
        const staleTracked = trackedRows.filter((t) => staleIds.includes(t.id));
        const inputs = staleTracked.map((t) => ({
          origin: t.origin,
          destination: t.destination,
          equipment: t.equipment as "VAN" | "REEFER" | "FLATBED",
          laneId: t.id,
        }));

        const fullData = await fetchFullLaneBatch(inputs).catch((err: Error) => {
          logIntel(`TRAC batch fetch error: ${err.message}`);
          return [];
        });

        for (const d of fullData) {
          const alertResult = generateAlert(
            d.spot.rpm,
            d.forecast,
            d.contract.contractRpm,
            d.stats.avgRpm90d,
          );
          const driver = generateDriverText(d.forecast, d.spot.rpm, d.stats.avgRpm90d);

          // Upsert rate record (delete old + insert new for simplicity)
          await db.delete(intelLaneRates).where(eq(intelLaneRates.trackedLaneId, d.laneId));
          const [newRate] = await db
            .insert(intelLaneRates)
            .values({
              trackedLaneId: d.laneId,
              spotRpm: d.spot.rpm?.toString() ?? null,
              spotRpmHigh: d.spot.rpmHigh?.toString() ?? null,
              spotRpmLow: d.spot.rpmLow?.toString() ?? null,
              spotRate: d.spot.rate?.toString() ?? null,
              spotRateHigh: d.spot.rateHigh?.toString() ?? null,
              spotRateLow: d.spot.rateLow?.toString() ?? null,
              contractRpm: d.contract.contractRpm?.toString() ?? null,
              contractRate: d.contract.contractRate?.toString() ?? null,
              contractFscRpm: d.contract.contractFscRpm?.toString() ?? null,
              confidenceScore: d.spot.confidenceScore?.toString() ?? null,
              loadCount: d.spot.totalLoadCount ?? null,
              miles: d.spot.miles ?? null,
              avgRpm30d: d.stats.avgRpm30d?.toString() ?? null,
              avgRpm90d: d.stats.avgRpm90d?.toString() ?? null,
              forecastJson: d.forecast as unknown as Record<string, unknown>[],
              rateAlert: alertResult.alert,
              alertReason: alertResult.reason,
              driverText: driver,
            })
            .returning();
          if (newRate) cachedRates.set(d.laneId, newRate);
        }
      }

      // 6. Build response
      const responseCards = trackedRows.map((t) => {
        const r = cachedRates.get(t.id);
        const n = (v: string | null | undefined) => v !== null && v !== undefined ? parseFloat(v) : null;
        return {
          id: t.id,
          origin: t.origin,
          originLabel: t.originLabel ?? t.origin,
          destination: t.destination,
          destinationLabel: t.destinationLabel ?? t.destination,
          equipment: t.equipment,
          spotRpm: r ? n(r.spotRpm) : null,
          spotRpmHigh: r ? n(r.spotRpmHigh) : null,
          spotRpmLow: r ? n(r.spotRpmLow) : null,
          spotRate: r ? n(r.spotRate) : null,
          spotRateHigh: r ? n(r.spotRateHigh) : null,
          spotRateLow: r ? n(r.spotRateLow) : null,
          contractRpm: r ? n(r.contractRpm) : null,
          contractRate: r ? n(r.contractRate) : null,
          avgRpm30d: r ? n(r.avgRpm30d) : null,
          avgRpm90d: r ? n(r.avgRpm90d) : null,
          miles: r?.miles ?? null,
          confidenceScore: r ? n(r.confidenceScore) : null,
          loadCount: r?.loadCount ?? null,
          forecastDays: (r?.forecastJson as unknown as Array<{ date: string; forecastRpm: number | null; forecastIndexValue: number | null }>) ?? [],
          rateAlert: r?.rateAlert ?? null,
          alertReason: r?.alertReason ?? null,
          driverText: r?.driverText ?? null,
          refreshedAt: r?.refreshedAt?.toISOString() ?? null,
        };
      });

      res.json({ lanes: responseCards, source: staleIds.length ? "live" : "cache" });
    } catch (err: unknown) {
      console.error("[intel] TRAC my-lanes error:", err);
      res.status(500).json({ error: "Failed to load TRAC lane rates" });
    }
  });

  // ── POST /api/intel/trac/lookup ──────────────────────────────────────────
  // On-demand TRAC rate lookup for any KMA pair (no DB persistence).
  app.post("/api/intel/trac/lookup", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { origin, destination, equipment = "VAN" } = req.body as {
        origin: string;
        destination: string;
        equipment?: string;
      };

      if (!origin || !destination) {
        return res.status(400).json({ error: "origin and destination required" });
      }

      const equip = toTracEquipment(equipment) as "VAN" | "REEFER" | "FLATBED";
      const laneId = `lookup-${origin}-${destination}-${equip}`;
      const data = await fetchFullLaneBatch([{ origin: origin.toUpperCase(), destination: destination.toUpperCase(), equipment: equip, laneId }]);
      if (!data.length) return res.status(404).json({ error: "No data returned from TRAC" });

      const d = data[0];
      const alertResult = generateAlert(d.spot.rpm, d.forecast, d.contract.contractRpm, d.stats.avgRpm90d);
      const driver = generateDriverText(d.forecast, d.spot.rpm, d.stats.avgRpm90d);
      const n = (v: number | null) => v;

      res.json({
        origin: origin.toUpperCase(),
        destination: destination.toUpperCase(),
        equipment: equip,
        spotRpm: n(d.spot.rpm),
        spotRpmHigh: n(d.spot.rpmHigh),
        spotRpmLow: n(d.spot.rpmLow),
        spotRate: n(d.spot.rate),
        spotRateHigh: n(d.spot.rateHigh),
        spotRateLow: n(d.spot.rateLow),
        contractRpm: n(d.contract.contractRpm),
        contractRate: n(d.contract.contractRate),
        contractFscRpm: n(d.contract.contractFscRpm),
        avgRpm30d: n(d.stats.avgRpm30d),
        avgRpm90d: n(d.stats.avgRpm90d),
        miles: d.spot.miles,
        confidenceScore: d.spot.confidenceScore,
        loadCount: d.spot.totalLoadCount,
        forecastDays: d.forecast,
        rateAlert: alertResult.alert,
        alertReason: alertResult.reason,
        driverText: driver,
      });
    } catch (err: unknown) {
      console.error("[intel] TRAC lookup error:", err);
      res.status(500).json({ error: "TRAC lookup failed" });
    }
  });

  // ── POST /api/intel/trac/refresh ─────────────────────────────────────────
  // Force-refresh TRAC rates for a specific tracked lane.
  app.post("/api/intel/trac/refresh/:trackedLaneId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { trackedLaneId } = req.params;
      const [tracked] = await db
        .select()
        .from(intelTrackedLanes)
        .where(and(eq(intelTrackedLanes.id, trackedLaneId), eq(intelTrackedLanes.userId, user.id)))
        .limit(1);

      if (!tracked) return res.status(404).json({ error: "Lane not found" });

      const equip = tracked.equipmentType as "VAN" | "REEFER" | "FLATBED";
      const inputs = [{ origin: tracked.origin, destination: tracked.destination, equipment: equip, laneId: tracked.id }];
      const [d] = await fetchFullLaneBatch(inputs);
      if (!d) return res.status(502).json({ error: "TRAC returned no data" });

      const alertResult = generateAlert(d.spot.rpm, d.forecast, d.contract.contractRpm, d.stats.avgRpm90d);
      const driver = generateDriverText(d.forecast, d.spot.rpm, d.stats.avgRpm90d);

      await db.delete(intelLaneRates).where(eq(intelLaneRates.trackedLaneId, tracked.id));
      await db.insert(intelLaneRates).values({
        trackedLaneId: tracked.id,
        spotRpm: d.spot.rpm?.toString() ?? null,
        spotRpmHigh: d.spot.rpmHigh?.toString() ?? null,
        spotRpmLow: d.spot.rpmLow?.toString() ?? null,
        spotRate: d.spot.rate?.toString() ?? null,
        spotRateHigh: d.spot.rateHigh?.toString() ?? null,
        spotRateLow: d.spot.rateLow?.toString() ?? null,
        contractRpm: d.contract.contractRpm?.toString() ?? null,
        contractRate: d.contract.contractRate?.toString() ?? null,
        contractFscRpm: d.contract.contractFscRpm?.toString() ?? null,
        confidenceScore: d.spot.confidenceScore?.toString() ?? null,
        loadCount: d.spot.totalLoadCount ?? null,
        miles: d.spot.miles ?? null,
        avgRpm30d: d.stats.avgRpm30d?.toString() ?? null,
        avgRpm90d: d.stats.avgRpm90d?.toString() ?? null,
        forecastJson: d.forecast as unknown as Record<string, unknown>[],
        rateAlert: alertResult.alert,
        alertReason: alertResult.reason,
        driverText: driver,
      });

      res.json({ ok: true, message: `Refreshed ${tracked.origin} → ${tracked.destination}` });
    } catch (err: unknown) {
      console.error("[intel] TRAC refresh error:", err);
      res.status(500).json({ error: "Refresh failed" });
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
