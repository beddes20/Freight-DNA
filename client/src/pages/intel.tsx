import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle, TrendingUp, TrendingDown, Zap, Truck, DollarSign,
  Radio, Clock, BarChart2, ArrowRight, Send, Users, Building2,
  Trophy, Package, ChevronRight,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketPulse {
  otri: number;
  otriWoWDelta: number;
  ntiPerMove: number;   // NTI.USA $/move (spot, national)
  ntiPerMile: number;   // VCRPM1.USA $/mile (contract)
  ntiWoWDelta: number;
  flatbedOtri: number;
  flatbedSignal: "hot" | "cool" | "neutral";
  dieselPerGal: number;
  dieselMoMDelta: number;
  timestamp: string;
  isStale: boolean;
}

interface LaneAlert {
  lane: string;
  signal: string;
  action: string;
  severity: "high" | "medium" | "low";
}

interface SpotOpportunity {
  lane: string;
  origin: string;
  destination: string;
  historicalCustomerRate: number;
  expectedCarrierCost: number;
  estimatedMarginGap: number;
}

interface BuyRateLane {
  lane: string;
  origin: string;
  destination: string;
  equipment: string;
  totalLoads: number;
  buyRateLow: number;
  buyRateHigh: number;
  originOtri: number;
}

interface ScorecardLane {
  lane: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipment: string;
  status: string;
  statusColor: "green" | "blue" | "yellow" | "red";
  avg6WkMarginPct: number;
  totalLoads: number;
  avgPayPerLoad: number;
  carrierRateTrend: string;
  weeklyMarginPcts: number[];
  buyRateLow: number;
  buyRateHigh: number;
  originOtri: number;
  destOtri: number;
  originSignal: string;
  destSignal: string;
}

interface RepEntry {
  id: string;
  name: string;
}

interface ExecutiveReport {
  topCompanies: Array<{ name: string; revenue: number; loads: number; marginPct: number }>;
  repLeaderboard: Array<{ name: string; userId: string | null; revenue: number; loads: number; marginPct: number }>;
  healthDistribution: {
    SCALE: { count: number; pct: number };
    GROW:  { count: number; pct: number };
    WATCH: { count: number; pct: number };
    HOLD:  { count: number; pct: number };
  };
  equipmentBreakdown: Array<{ type: string; revenue: number; loads: number; marginPct: number }>;
  weeklyTrend: Array<{ weekKey: string; revenue: number; margin: number; loads: number }>;
}

interface SonarMarketTrend {
  market: string;
  otri: number;
  otriWoW: number;
  votri: number | null;
  signal: "hot" | "warm" | "cool";
  trendDir: "↑" | "↓" | "→";
}

interface IntelPayload {
  viewUserId: string | null;
  viewUserName: string | null;
  availableReps: RepEntry[];
  sonarMarketTrends?: SonarMarketTrend[];
  dailyInsights: {
    greeting: string;
    date: string;
    marketPulse: MarketPulse;
    laneAlerts: LaneAlert[];
    spotOpportunities: SpotOpportunity[];
    buyRateQuickLook: BuyRateLane[];
    sonarTimestamp: string;
    sonarIsStale: boolean;
  };
  biweeklyScorecard: {
    lastRefreshDate: string;
    nextUpdateDays: number;
    overallStats: {
      totalLoads: number;
      totalRevenue: number;
      overallMarginPct: number;
      repRank: number;
      totalReps: number;
      bestWeek: string;
      bestWeekMarginPct: number;
    };
    lanes: ScorecardLane[];
  };
  executiveReport: ExecutiveReport;
}

// ── Market Pulse Strip ────────────────────────────────────────────────────────

function MarketPulseStrip({ pulse, isStale, timestamp }: { pulse: MarketPulse; isStale: boolean; timestamp: string }) {
  const metrics = [
    {
      label: "Nat'l OTRI",
      value: `${pulse.otri.toFixed(2)}%`,
      delta: `${pulse.otriWoWDelta > 0 ? "▲" : "▼"} ${Math.abs(pulse.otriWoWDelta).toFixed(1)}% WoW`,
      deltaColor: pulse.otriWoWDelta > 0 ? "text-red-400" : "text-green-400",
    },
    {
      label: "NTI Spot/move",
      value: pulse.ntiPerMove > 100
        ? `$${Math.round(pulse.ntiPerMove).toLocaleString()}`
        : `$${(pulse.ntiPerMile ?? 2.28).toFixed(2)}/mi`,
      delta: `${pulse.ntiWoWDelta > 0 ? "↑" : "↓"} ${Math.abs(pulse.ntiWoWDelta).toFixed(0)} WoW`,
      deltaColor: pulse.ntiWoWDelta > 0 ? "text-amber-400" : "text-green-400",
    },
    {
      label: "Contract $/mi",
      value: `$${(pulse.ntiPerMile ?? 2.28).toFixed(2)}`,
      delta: "VCRPM1",
      deltaColor: "text-white/40",
    },
    {
      label: "Flatbed OTRI",
      value: `${pulse.flatbedOtri.toFixed(1)}%`,
      delta: pulse.flatbedSignal === "hot" ? "⚠ Very hot" : pulse.flatbedSignal === "cool" ? "✓ Cool" : "Neutral",
      deltaColor: pulse.flatbedSignal === "hot" ? "text-red-400" : pulse.flatbedSignal === "cool" ? "text-green-400" : "text-amber-400",
    },
    {
      label: "Diesel/gal",
      value: `$${pulse.dieselPerGal.toFixed(2)}`,
      delta: `${pulse.dieselMoMDelta > 0 ? "▲" : "▼"} $${Math.abs(pulse.dieselMoMDelta).toFixed(2)} MoM`,
      deltaColor: pulse.dieselMoMDelta > 0 ? "text-red-400" : "text-green-400",
    },
  ];

  return (
    <div className="rounded-xl overflow-hidden mb-6" style={{ background: "#0a1628" }}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-white/60">
            Market Pulse — Sonar Live Data
          </span>
          {isStale && <span className="text-xs text-amber-400 font-medium">⚠ Stale</span>}
        </div>
        <span className="text-xs text-white/40" data-testid="text-sonar-timestamp">
          As of {new Date(timestamp).toLocaleString()}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-0">
        {metrics.map((m, i) => (
          <div
            key={m.label}
            className={`px-4 py-3 text-center ${i < metrics.length - 1 ? "border-r border-white/8" : ""}`}
            data-testid={`metric-${m.label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}
          >
            <div className="text-lg font-extrabold text-white leading-none">{m.value}</div>
            <div className="text-[9px] uppercase tracking-widest text-white/40 mt-1">{m.label}</div>
            <div className={`text-[10px] mt-1 ${m.deltaColor}`}>{m.delta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  green:  "bg-green-600 text-white",
  blue:   "bg-blue-600 text-white",
  yellow: "bg-yellow-500 text-black",
  red:    "bg-red-700 text-white",
};

function StatusBadge({ status, color }: { status: string; color: string }) {
  return (
    <span className={`inline-block text-[10px] font-extrabold px-2.5 py-1 rounded-full tracking-wider ${STATUS_STYLES[color] ?? "bg-gray-200 text-black"}`}>
      {status}
    </span>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function MarginSparkline({ values }: { values: number[] }) {
  if (!values || values.length === 0) return null;
  const getColor = (v: number) => v >= 15 ? "#22c55e" : v >= 8 ? "#eab308" : "#ef4444";
  const max = Math.max(...values, 1);
  const BAR_HEIGHT = 32;

  return (
    <div className="flex items-end gap-0.5 h-9" data-testid="sparkline-margin">
      {values.map((v, i) => {
        const height = Math.max(4, (Math.abs(v) / max) * BAR_HEIGHT);
        return (
          <div key={i} className="flex flex-col items-center gap-0.5 flex-1">
            <div style={{ height: `${height}px`, background: getColor(v) }} className="w-full rounded-sm min-h-1" title={`W${i + 1}: ${v.toFixed(1)}%`} />
            <span className="text-[8px] text-muted-foreground">W{i + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── OTRI Chip ─────────────────────────────────────────────────────────────────

function OtriChip({ label, otri, signal }: { label: string; otri: number; signal: string }) {
  const bg = signal === "red" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
    : signal === "yellow" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
    : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  const dot = signal === "red" ? "🔴" : signal === "yellow" ? "🟡" : "🟢";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold ${bg}`}>
      {dot} <strong>{label}:</strong> {otri.toFixed(1)}%
    </span>
  );
}

// ── Lane Alert Card ───────────────────────────────────────────────────────────

function AlertCard({ alert }: { alert: LaneAlert }) {
  const sev = alert.severity === "high" ? "border-red-500 bg-red-50 dark:bg-red-950/20"
    : alert.severity === "medium" ? "border-amber-400 bg-amber-50 dark:bg-amber-950/20"
    : "border-blue-400 bg-blue-50 dark:bg-blue-950/20";
  const icon = alert.severity === "high" ? <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
    : alert.severity === "medium" ? <TrendingUp className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
    : <Zap className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />;
  return (
    <div className={`border-l-4 rounded-r-lg px-3 py-3 ${sev}`} data-testid={`alert-card-${alert.severity}`}>
      <div className="flex items-start gap-2">
        {icon}
        <div>
          <div className="text-xs font-bold text-foreground mb-0.5">{alert.lane}</div>
          <div className="text-xs text-muted-foreground mb-1">{alert.signal}</div>
          <div className="text-xs font-medium text-foreground">→ {alert.action}</div>
        </div>
      </div>
    </div>
  );
}

// ── Spot Opportunity Card ─────────────────────────────────────────────────────

function SpotCard({ opp }: { opp: SpotOpportunity }) {
  return (
    <div className="border rounded-lg p-3 bg-card" data-testid="card-spot-opportunity">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-bold text-foreground">{opp.lane}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Hist. rate: ${opp.historicalCustomerRate.toFixed(0)} · Expected carrier: ${opp.expectedCarrierCost.toFixed(0)}
          </div>
        </div>
        <Badge className="bg-green-600 text-white text-xs ml-2 shrink-0">
          {opp.estimatedMarginGap.toFixed(1)}% est. margin
        </Badge>
      </div>
    </div>
  );
}

// ── Lane Scorecard Card ───────────────────────────────────────────────────────

function LaneScorecardCard({ lane, idx }: { lane: ScorecardLane; idx: number }) {
  const trendIcon = lane.carrierRateTrend === "tightening"
    ? <TrendingUp className="h-3 w-3 text-red-500" />
    : lane.carrierRateTrend === "easing"
    ? <TrendingDown className="h-3 w-3 text-green-500" />
    : <ArrowRight className="h-3 w-3 text-muted-foreground" />;

  return (
    <div className="border rounded-xl p-4 bg-card" data-testid={`card-scorecard-lane-${idx}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Lane #{idx + 1}</div>
          <div className="text-base font-extrabold text-foreground leading-tight capitalize">{lane.origin}</div>
          <div className="text-sm text-muted-foreground font-medium mt-0.5 capitalize">→ {lane.destination}</div>
          {lane.equipment && <div className="text-xs text-muted-foreground mt-0.5">{lane.equipment}</div>}
        </div>
        <div className="text-right">
          <StatusBadge status={lane.status} color={lane.statusColor} />
          <div className="text-2xl font-black mt-1.5 leading-none"
            style={{ color: lane.avg6WkMarginPct >= 15 ? "#16a34a" : lane.avg6WkMarginPct >= 8 ? "#ca8a04" : "#dc2626" }}
          >
            {lane.avg6WkMarginPct.toFixed(1)}%
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">6-wk margin</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="rounded-lg bg-muted/50 px-2 py-2 text-center">
          <div className="text-base font-extrabold text-foreground">{lane.totalLoads}</div>
          <div className="text-[10px] text-muted-foreground">Loads</div>
        </div>
        <div className="rounded-lg bg-muted/50 px-2 py-2 text-center">
          <div className="text-base font-extrabold text-foreground">${lane.avgPayPerLoad.toLocaleString()}</div>
          <div className="text-[10px] text-muted-foreground">Avg Pay</div>
        </div>
        <div className="rounded-lg bg-muted/50 px-2 py-2 text-center flex flex-col items-center justify-center">
          <div className="flex items-center gap-1">{trendIcon}<span className="text-xs font-semibold capitalize">{lane.carrierRateTrend}</span></div>
          <div className="text-[10px] text-muted-foreground">Carrier Rate</div>
        </div>
      </div>

      <MarginSparkline values={lane.weeklyMarginPcts} />

      {(lane.buyRateLow > 0 || lane.buyRateHigh > 0) && (
        <div className="rounded-lg mt-3 px-3 py-2.5" style={{ background: "linear-gradient(135deg,#0a1628,#1e3a5f)" }}>
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/50 mb-1">Expected Carrier Rate Today</div>
          <div className="text-xl font-black text-white leading-none">
            ${lane.buyRateLow.toFixed(2)} – ${lane.buyRateHigh.toFixed(2)}
            <span className="text-xs font-normal text-white/50 ml-1">/mile</span>
          </div>
          <div className="text-[10px] text-white/50 mt-1">
            Based on your last 3 weeks · adjusted for origin OTRI {lane.originOtri.toFixed(1)}%
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-3 flex-wrap">
        <OtriChip label="Origin" otri={lane.originOtri} signal={lane.originSignal} />
        <OtriChip label="Dest" otri={lane.destOtri} signal={lane.destSignal} />
      </div>
    </div>
  );
}

// ── Executive Report ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  SCALE: "#16a34a",
  GROW:  "#2563eb",
  WATCH: "#ca8a04",
  HOLD:  "#dc2626",
};

function HealthBar({ label, count, pct, color }: { label: string; count: number; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-14 shrink-0 text-right">
        <span className="text-[10px] font-extrabold uppercase tracking-wider" style={{ color }}>{label}</span>
      </div>
      <div className="flex-1 h-5 rounded-full bg-muted/50 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
      </div>
      <div className="w-20 shrink-0 text-xs text-muted-foreground">{count} lane{count !== 1 ? "s" : ""} ({pct}%)</div>
    </div>
  );
}

function ExecutiveReportSection({ report }: { report: ExecutiveReport }) {
  const totalRevenue = report.topCompanies.reduce((s, c) => s + c.revenue, 0);

  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2" data-testid="section-executive-report">
        <Trophy className="h-5 w-5 text-amber-500" /> Executive Intel Report
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Lane Health Distribution ─────────────────────────────── */}
        <div className="border rounded-xl p-4 bg-card">
          <h3 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-blue-500" /> Lane Health Distribution
          </h3>
          <div className="space-y-3">
            {Object.entries(report.healthDistribution).map(([label, { count, pct }]) => (
              <HealthBar key={label} label={label} count={count} pct={pct} color={STATUS_COLORS[label] ?? "#6b7280"} />
            ))}
          </div>
          <div className="mt-4 pt-3 border-t flex gap-2 flex-wrap">
            {Object.entries(report.healthDistribution).map(([label, { count, pct }]) => (
              <div key={label} className="text-center px-3 py-1.5 rounded-lg bg-muted/30">
                <div className="text-base font-extrabold" style={{ color: STATUS_COLORS[label] }}>{count}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Weekly Revenue Trend ──────────────────────────────────── */}
        <div className="border rounded-xl p-4 bg-card">
          <h3 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" /> 6-Week Revenue Trend
          </h3>
          {report.weeklyTrend.length > 0 ? (
            <div className="space-y-2">
              {report.weeklyTrend.map((wk, i) => {
                const maxRev = Math.max(...report.weeklyTrend.map(w => w.revenue), 1);
                const pct = Math.round((wk.revenue / maxRev) * 100);
                const mColor = wk.margin >= 15 ? "#16a34a" : wk.margin >= 8 ? "#ca8a04" : "#dc2626";
                return (
                  <div key={wk.weekKey} className="flex items-center gap-3">
                    <div className="w-16 shrink-0 text-[10px] text-muted-foreground">{wk.weekKey}</div>
                    <div className="flex-1 h-5 rounded-full bg-muted/50 overflow-hidden">
                      <div className="h-full rounded-full bg-green-500/70 transition-all" style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                    <div className="w-28 shrink-0 text-right">
                      <span className="text-xs font-bold text-foreground">${(wk.revenue / 1000).toFixed(0)}K</span>
                      <span className="text-[10px] ml-2 font-semibold" style={{ color: mColor }}>{wk.margin.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No weekly trend data available.</p>
          )}
        </div>

        {/* ── Rep Leaderboard ───────────────────────────────────────── */}
        <div className="border rounded-xl p-4 bg-card">
          <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-purple-500" /> Rep Margin Leaderboard
          </h3>
          {report.repLeaderboard.length > 0 ? (
            <div className="space-y-2">
              {report.repLeaderboard.map((rep, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
                const mColor = rep.marginPct >= 15 ? "#16a34a" : rep.marginPct >= 8 ? "#ca8a04" : "#dc2626";
                return (
                  <div key={rep.name + i} className="flex items-center justify-between py-1.5 border-b last:border-0"
                    data-testid={`row-rep-leaderboard-${i}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm w-6 text-center">{medal}</span>
                      <div>
                        <div className="text-sm font-semibold text-foreground">{rep.name}</div>
                        <div className="text-[10px] text-muted-foreground">{rep.loads} loads · ${(rep.revenue / 1000).toFixed(0)}K rev</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-extrabold" style={{ color: mColor }}>{rep.marginPct.toFixed(1)}%</div>
                      <div className="text-[10px] text-muted-foreground">margin</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No rep data available. Financial data needed.</p>
          )}
        </div>

        {/* ── Top Companies ─────────────────────────────────────────── */}
        <div className="border rounded-xl p-4 bg-card">
          <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-500" /> Top Companies by Revenue
          </h3>
          {report.topCompanies.length > 0 ? (
            <div className="space-y-1.5">
              {report.topCompanies.map((co, i) => {
                const revPct = totalRevenue > 0 ? Math.round((co.revenue / totalRevenue) * 100) : 0;
                const mColor = co.marginPct >= 15 ? "#16a34a" : co.marginPct >= 8 ? "#ca8a04" : "#dc2626";
                return (
                  <div key={co.name + i} className="flex items-center gap-2 py-1 border-b last:border-0"
                    data-testid={`row-top-company-${i}`}
                  >
                    <div className="text-xs text-muted-foreground w-5 text-center">{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-foreground truncate capitalize">{co.name}</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <div className="flex-1 h-1.5 rounded-full bg-muted/50">
                          <div className="h-full rounded-full bg-blue-400/70" style={{ width: `${Math.max(revPct, 2)}%` }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{revPct}%</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-foreground">${(co.revenue / 1000).toFixed(0)}K</div>
                      <div className="text-[10px] font-semibold" style={{ color: mColor }}>{co.marginPct.toFixed(1)}% margin</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No company data available. Upload financial data to see company analysis.</p>
          )}
        </div>

        {/* ── Equipment Breakdown ───────────────────────────────────── */}
        {report.equipmentBreakdown.length > 0 && (
          <div className="border rounded-xl p-4 bg-card lg:col-span-2">
            <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-orange-500" /> Equipment Type Breakdown
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {report.equipmentBreakdown.map((eq, i) => {
                const mColor = eq.marginPct >= 15 ? "#16a34a" : eq.marginPct >= 8 ? "#ca8a04" : "#dc2626";
                return (
                  <div key={eq.type + i} className="rounded-lg bg-muted/30 px-3 py-3 text-center" data-testid={`card-equipment-${i}`}>
                    <div className="text-xs font-bold text-foreground mb-1 truncate capitalize">{eq.type || "Unknown"}</div>
                    <div className="text-lg font-extrabold" style={{ color: mColor }}>{eq.marginPct.toFixed(1)}%</div>
                    <div className="text-[10px] text-muted-foreground">{eq.loads} loads</div>
                    <div className="text-[10px] text-muted-foreground">${(eq.revenue / 1000).toFixed(0)}K rev</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function IntelSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IntelPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedUserId, setSelectedUserId] = useState<string>("all");

  if (user && user.role !== "admin") {
    setLocation("/");
    return null;
  }

  const queryUserId = selectedUserId !== "all" ? selectedUserId : undefined;

  const { data, isLoading, error, isFetching } = useQuery<IntelPayload>({
    queryKey: ["/api/intel", queryUserId ?? "all"],
    queryFn: async () => {
      const url = queryUserId ? `/api/intel?userId=${encodeURIComponent(queryUserId)}` : "/api/intel";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load intel");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const sendNowMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/intel/send-now"),
    onSuccess: () => {
      toast({
        title: "Report sent!",
        description: "Daily intel + scorecard emailed to all admin users now.",
      });
    },
    onError: () => {
      toast({
        title: "Send failed",
        description: "Could not send the report. Check email configuration.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <IntelSkeleton />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 p-6 text-center">
          <AlertTriangle className="h-8 w-8 text-red-500 mx-auto mb-3" />
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            Failed to load Intel data. Please try again.
          </p>
        </div>
      </div>
    );
  }

  const { dailyInsights, biweeklyScorecard, executiveReport, availableReps } = data;
  const { overallStats } = biweeklyScorecard;
  const isFiltered = selectedUserId !== "all";
  const viewLabel = isFiltered ? (availableReps.find(r => r.id === selectedUserId)?.name ?? "Rep") : null;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">

      {/* ── Page Header ─────────────────────────────────────────── */}
      <div
        className="rounded-2xl mb-6 p-6 md:p-8"
        style={{ background: "linear-gradient(135deg,#0d5c34 0%,#0a7a5c 100%)" }}
        data-testid="header-intel"
      >
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold tracking-widest uppercase text-white/60 mb-2">
              Value Truck · Daily Intelligence
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-white leading-tight" data-testid="text-greeting">
              {dailyInsights.greeting}.
            </h1>
            <p className="text-sm text-white/65 mt-1">{dailyInsights.date}</p>
            {isFiltered && viewLabel && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white">
                <Users className="h-3 w-3" /> Viewing: {viewLabel}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-white/25 bg-white/15 px-5 py-3 text-center shrink-0">
            <div className="text-[10px] font-bold tracking-wider uppercase text-white/60">
              {isFiltered ? "Rep Margin" : "6-Wk Margin"}
            </div>
            <div
              className="text-3xl font-black mt-1"
              style={{ color: overallStats.overallMarginPct >= 15 ? "#4ade80" : overallStats.overallMarginPct >= 8 ? "#facc15" : "#f87171" }}
              data-testid="text-overall-margin"
            >
              {overallStats.overallMarginPct.toFixed(1)}%
            </div>
            <div className="text-[10px] text-white/50 mt-0.5">
              {isFiltered ? `${overallStats.totalLoads} loads` : `#${overallStats.repRank} of ${overallStats.totalReps} reps`}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-black/25 px-4 py-2 text-xs text-white/60 flex flex-wrap gap-4">
          <span>📦 <strong className="text-white">{overallStats.totalLoads.toLocaleString()} loads</strong> last 6 wks</span>
          <span>💰 <strong className="text-white">${(overallStats.totalRevenue / 1000).toFixed(0)}K</strong> revenue</span>
          {overallStats.bestWeekMarginPct > 0 && (
            <span>🔥 <strong style={{ color: "#4ade80" }}>{overallStats.bestWeek}: {overallStats.bestWeekMarginPct.toFixed(1)}%</strong> best week</span>
          )}
        </div>
      </div>

      {/* ── Controls Bar ────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-6">
        {/* User Dropdown */}
        <div className="flex items-center gap-2 flex-1">
          <Users className="h-4 w-4 text-muted-foreground shrink-0" />
          <Select value={selectedUserId} onValueChange={setSelectedUserId}>
            <SelectTrigger className="w-56" data-testid="select-rep-filter" disabled={isFetching}>
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Reps (Org-Wide)</SelectItem>
              {availableReps.map(rep => (
                <SelectItem key={rep.id} value={rep.id} data-testid={`option-rep-${rep.id}`}>
                  {rep.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isFetching && <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>}
        </div>

        {/* Send Report Now */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => sendNowMutation.mutate()}
          disabled={sendNowMutation.isPending}
          data-testid="button-send-now"
          className="flex items-center gap-2 shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
          {sendNowMutation.isPending ? "Sending…" : "Send Report Now"}
        </Button>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION: DAILY INSIGHTS
      ══════════════════════════════════════════════════════ */}
      <section className="mb-10">
        <h2 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2" data-testid="section-daily-insights">
          <Radio className="h-5 w-5 text-blue-500" /> Daily Insights
        </h2>

        <MarketPulseStrip
          pulse={dailyInsights.marketPulse}
          isStale={dailyInsights.sonarIsStale}
          timestamp={dailyInsights.sonarTimestamp}
        />

        {/* ── Sonar Market Trend Table (top-20 org markets) ───── */}
        {data.sonarMarketTrends && data.sonarMarketTrends.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Radio className="h-4 w-4 text-blue-500" /> Market Trends — Your Top Corridors
            </h3>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm" data-testid="table-market-trends">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground">Market</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">OTRI</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden sm:table-cell">VOTRI</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">WoW</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden sm:table-cell">Trend</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sonarMarketTrends.map((m, i) => {
                    const sigCls = m.signal === "hot"
                      ? "text-red-600 bg-red-100 dark:bg-red-900/30 border-red-300"
                      : m.signal === "warm"
                      ? "text-amber-600 bg-amber-100 dark:bg-amber-900/30 border-amber-300"
                      : "text-green-600 bg-green-100 dark:bg-green-900/30 border-green-300";
                    return (
                      <tr key={m.market} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`} data-testid={`row-market-trend-${m.market}`}>
                        <td className="px-4 py-2.5 font-medium capitalize">{m.market}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{m.otri.toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted-foreground hidden sm:table-cell">
                          {m.votri !== null ? `${m.votri.toFixed(1)}%` : "—"}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono ${m.otriWoW > 0 ? "text-red-600" : m.otriWoW < 0 ? "text-green-600" : "text-muted-foreground"}`}>
                          {m.otriWoW > 0 ? "+" : ""}{m.otriWoW.toFixed(1)}pp
                        </td>
                        <td className="px-4 py-2.5 text-right text-base hidden sm:table-cell">{m.trendDir}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full border ${sigCls}`}>
                            {m.signal === "hot" ? "🔴 Hot" : m.signal === "warm" ? "🟡 Warm" : "🟢 Cool"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {dailyInsights.laneAlerts.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Lane Alerts
            </h3>
            <div className="space-y-2">
              {dailyInsights.laneAlerts.map((alert, i) => <AlertCard key={i} alert={alert} />)}
            </div>
          </div>
        )}

        {dailyInsights.spotOpportunities.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-green-500" /> Spot Rate Opportunities
            </h3>
            <div className="space-y-2">
              {dailyInsights.spotOpportunities.map((opp, i) => <SpotCard key={i} opp={opp} />)}
            </div>
          </div>
        )}

        {dailyInsights.buyRateQuickLook.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <DollarSign className="h-4 w-4 text-blue-500" /> Today's Buy Rate Quick-Look
            </h3>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm" data-testid="table-buy-rate">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground">Lane</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Loads (6wk)</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Buy Rate $/mi</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden md:table-cell">Origin OTRI</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyInsights.buyRateQuickLook.map((lane, i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`} data-testid={`row-buy-rate-${i}`}>
                      <td className="px-4 py-2.5 font-medium text-foreground">
                        <span className="capitalize">{lane.origin}</span>
                        <span className="text-muted-foreground mx-1">→</span>
                        <span className="capitalize">{lane.destination}</span>
                        {lane.equipment && <span className="text-muted-foreground text-xs ml-1">({lane.equipment})</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{lane.totalLoads}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-foreground">
                        {lane.buyRateLow > 0
                          ? `$${lane.buyRateLow.toFixed(2)} – $${lane.buyRateHigh.toFixed(2)}`
                          : <span className="text-muted-foreground text-xs">Insufficient data</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground hidden md:table-cell">
                        {lane.originOtri.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {dailyInsights.laneAlerts.length === 0 && dailyInsights.spotOpportunities.length === 0 && dailyInsights.buyRateQuickLook.length === 0 && (
          <div className="rounded-xl border bg-muted/30 p-8 text-center text-muted-foreground text-sm">
            <Truck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            {isFiltered ? `No lane data for ${viewLabel} in the last 6 weeks.` : "No financial data loaded yet. Upload financial data to see lane insights."}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION: LANE SCORECARD
      ══════════════════════════════════════════════════════ */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2" data-testid="section-scorecard">
            <BarChart2 className="h-5 w-5 text-green-600" /> Bi-Weekly Lane Scorecard
            {isFiltered && viewLabel && (
              <Badge variant="outline" className="text-xs font-normal ml-1">
                {viewLabel}
              </Badge>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs" data-testid="badge-next-update">
              <Clock className="h-3 w-3 mr-1" />
              Next update in {biweeklyScorecard.nextUpdateDays}d
            </Badge>
            <span className="text-xs text-muted-foreground" data-testid="text-last-refresh">
              Last: {new Date(biweeklyScorecard.lastRefreshDate).toLocaleDateString()}
            </span>
          </div>
        </div>

        {biweeklyScorecard.lanes.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {biweeklyScorecard.lanes.map((lane, i) => (
              <LaneScorecardCard key={i} lane={lane} idx={i} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border bg-muted/30 p-8 text-center text-muted-foreground text-sm">
            <BarChart2 className="h-8 w-8 mx-auto mb-3 opacity-30" />
            {isFiltered
              ? `No lane scorecard data for ${viewLabel}. This rep may not have lanes in the last 6 weeks.`
              : "No lane data available yet. Upload financial data to generate your scorecard."
            }
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION: EXECUTIVE REPORT (always org-wide)
      ══════════════════════════════════════════════════════ */}
      <ExecutiveReportSection report={executiveReport} />
    </div>
  );
}
