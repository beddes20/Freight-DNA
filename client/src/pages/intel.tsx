import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  LineChart, Line, ResponsiveContainer, ReferenceLine,
  Tooltip as RechartsTooltip,
} from "recharts";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangle, TrendingUp, TrendingDown, Zap, Truck, DollarSign,
  Radio, Clock, BarChart2, ArrowRight, Send, Users, Building2,
  Trophy, Package, ChevronRight, RefreshCw, CloudRain, Sparkles,
  MapPin, ThermometerSun, Activity, Target,
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
  aiNarrative?: string | null;
  votri?: number | null;
}

interface SpotOpportunity {
  lane: string;
  origin: string;
  destination: string;
  historicalCustomerRate: number;
  expectedCarrierCost: number;
  estimatedMarginGap: number;
  aiNarrative?: string | null;
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
  votri?: number | null;
  aiRationale?: string | null;
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
  votri?: number | null;
  originSignal: string;
  destSignal: string;
  aiNarrative?: string | null;
}

interface MarketContextItem {
  market: string;
  headline: string;
  summary: string;
  relevance: string;
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
  votriWoW: number | null;
  otvi: number | null;
  hai: number | null;
  signal: "hot" | "warm" | "cool";
  trendDir: "↑" | "↓" | "→";
  ibOtri: number | null;
}

interface ExecutiveReportWithBrief extends ExecutiveReport {
  executiveBrief?: string | null;
}

interface AiBrief {
  bullets: string[];
  generatedAt: string;
  isStale: boolean;
}

interface WeatherFlag {
  city: string;
  severity: "severe" | "moderate";
  description: string;
  maxCode: number;
}

interface MyLanesRow {
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

interface TracForecastDay {
  date: string;
  forecastRpm: number | null;
  forecastIndexValue: number | null;
}

interface RatePositioningEntry {
  lane: string;
  origin: string;
  destination: string;
  avgCarrierPayPerMile: number;
  marketRatePerMile: number;
  deltaPerMile: number;
  deltaPct: number;
  classification: "ABOVE_MARKET" | "AT_MARKET" | "BELOW_MARKET";
  forecastDirection: "TIGHTENING" | "EASING" | "STABLE";
  forecastWeeklyRates: Array<{ week: number; ratePerMile: number }>;
  historicalWeeklyPaidRates: Array<{ weekLabel: string; ratePerMile: number }>;
  historicalWeeklyMarketRates: Array<{ weekLabel: string; ratePerMile: number }>;
  votri: number | null;
  totalLoads: number;
  coachingCard: string | null;
  source: "lane" | "national_fallback";
  isStale: boolean;
}

interface RatePositioningSummary {
  lanes: RatePositioningEntry[];
  portfolioExposure: {
    aboveMarketCount: number;
    atMarketCount: number;
    belowMarketCount: number;
    aboveMarketPct: number;
    atMarketPct: number;
    belowMarketPct: number;
    avgDeltaPct: number;
    worstLane: string | null;
    bestLane: string | null;
    monthlyOverMarketDollars: number;
    tighteningActionLanes: string[];
  };
  repLeaderboard: Array<{
    repName: string;
    avgDeltaPct: number;
    aboveCount: number;
    belowCount: number;
    atCount: number;
    totalLanes: number;
  }>;
  generatedAt: string;
}

interface TracLaneCard {
  id: string;
  origin: string;
  originLabel: string;
  destination: string;
  destinationLabel: string;
  equipment: string;
  spotRpm: number | null;
  spotRpmHigh: number | null;
  spotRpmLow: number | null;
  spotRate: number | null;
  spotRateHigh: number | null;
  spotRateLow: number | null;
  contractRpm: number | null;
  contractRate: number | null;
  avgRpm30d: number | null;
  avgRpm90d: number | null;
  miles: number | null;
  confidenceScore: number | null;
  loadCount: number | null;
  forecastDays: TracForecastDay[];
  rateAlert: "spike" | "drop" | "reprice" | null;
  alertReason: string | null;
  driverText: string | null;
  refreshedAt: string | null;
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
    marketContext?: MarketContextItem[];
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
  executiveReport: ExecutiveReportWithBrief;
}

// ── TRAC Rate Cards ───────────────────────────────────────────────────────────

const ALERT_STYLES: Record<string, { label: string; cls: string }> = {
  spike:   { label: "⬆ Rate Spike",  cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border border-red-300 dark:border-red-700" },
  drop:    { label: "⬇ Rate Drop",   cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border border-blue-300 dark:border-blue-700" },
  reprice: { label: "↕ Reprice Opp", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300 dark:border-amber-700" },
};

function TinyForecastChart({ days }: { days: TracForecastDay[] }) {
  const data = days
    .filter(d => d.forecastRpm != null)
    .slice(0, 14)
    .map(d => ({ date: d.date.slice(5), rpm: Number(d.forecastRpm!.toFixed(3)) }));
  if (data.length < 2) return <div className="h-12 flex items-center justify-center text-[10px] text-muted-foreground">No forecast</div>;
  const minV = Math.min(...data.map(d => d.rpm));
  const maxV = Math.max(...data.map(d => d.rpm));
  const mid = ((minV + maxV) / 2);
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
        <ReferenceLine y={mid} stroke="#6b7280" strokeDasharray="3 2" strokeWidth={0.8} />
        <Line
          type="monotone"
          dataKey="rpm"
          dot={false}
          stroke="#3b82f6"
          strokeWidth={1.5}
        />
        <RechartsTooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            return (
              <div className="bg-black/80 text-white text-[10px] px-2 py-1 rounded shadow">
                {d.date}: <strong>${d.rpm.toFixed(2)}/mi</strong>
              </div>
            );
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TracRateCardsPanel({
  lanes,
  isLoading,
  onRefresh,
  isRefreshing,
}: {
  lanes: TracLaneCard[];
  isLoading: boolean;
  onRefresh: (id: string) => void;
  isRefreshing: string | null;
}) {
  if (isLoading) {
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">TRAC Market Rates</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-44 w-full rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!lanes || lanes.length === 0) return null;

  const alertLanes = lanes.filter(l => l.rateAlert != null);

  return (
    <div className="mb-6" data-testid="panel-trac-rate-cards">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-blue-500" /> TRAC Market Rates — My Assigned Lanes
        </h3>
        {alertLanes.length > 0 && (
          <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {alertLanes.length} {alertLanes.length === 1 ? "alert" : "alerts"}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {lanes.map(lane => {
          const alert = lane.rateAlert ? ALERT_STYLES[lane.rateAlert] : null;
          const spotVsContract = lane.spotRpm != null && lane.contractRpm != null
            ? ((lane.spotRpm - lane.contractRpm) / lane.contractRpm) * 100
            : null;
          const spotVsContract90 = lane.spotRpm != null && lane.avgRpm90d != null
            ? ((lane.spotRpm - lane.avgRpm90d) / lane.avgRpm90d) * 100
            : null;

          return (
            <div
              key={lane.id}
              className="rounded-xl border bg-card overflow-hidden hover:shadow-md transition-shadow"
              data-testid={`card-trac-${lane.id}`}
            >
              {/* Header */}
              <div className="px-3 py-2.5 border-b flex items-start justify-between gap-2 bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm text-foreground leading-tight">
                    {lane.originLabel || lane.origin}
                  </div>
                  <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <span>→</span>
                    {lane.destinationLabel || lane.destination}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-[10px] font-semibold uppercase bg-muted border rounded px-1.5 py-0.5 text-muted-foreground">
                    {lane.equipment}
                  </span>
                  {lane.miles && (
                    <span className="text-[9px] text-muted-foreground">{lane.miles.toLocaleString()} mi</span>
                  )}
                </div>
              </div>

              {/* Alert banner */}
              {alert && (
                <div className={`px-3 py-1.5 text-[11px] font-semibold flex items-center gap-1.5 ${alert.cls}`}>
                  <span>{alert.label}</span>
                  {lane.alertReason && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="underline decoration-dotted cursor-help truncate flex-1">{lane.alertReason}</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">{lane.alertReason}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )}

              {/* Rate grid */}
              <div className="grid grid-cols-3 gap-0 border-b">
                <div className="px-3 py-2 text-center border-r">
                  <div className="text-base font-extrabold text-foreground leading-none">
                    {lane.spotRpm != null ? `$${lane.spotRpm.toFixed(2)}` : "—"}
                  </div>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">Spot/mi</div>
                  {lane.spotRpmHigh != null && lane.spotRpmLow != null && (
                    <div className="text-[9px] text-muted-foreground">
                      ${lane.spotRpmLow.toFixed(2)}–${lane.spotRpmHigh.toFixed(2)}
                    </div>
                  )}
                </div>
                <div className="px-3 py-2 text-center border-r">
                  <div className="text-base font-extrabold text-foreground leading-none">
                    {lane.contractRpm != null ? `$${lane.contractRpm.toFixed(2)}` : "—"}
                  </div>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">Contract/mi</div>
                  {spotVsContract != null && (
                    <div className={`text-[9px] font-bold ${spotVsContract > 3 ? "text-red-500" : spotVsContract < -3 ? "text-green-500" : "text-muted-foreground"}`}>
                      {spotVsContract > 0 ? "+" : ""}{spotVsContract.toFixed(1)}% vs spt
                    </div>
                  )}
                </div>
                <div className="px-3 py-2 text-center">
                  <div className="text-base font-extrabold text-foreground leading-none">
                    {lane.avgRpm90d != null ? `$${lane.avgRpm90d.toFixed(2)}` : "—"}
                  </div>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">90d Avg/mi</div>
                  {spotVsContract90 != null && (
                    <div className={`text-[9px] font-bold ${spotVsContract90 > 5 ? "text-red-500" : spotVsContract90 < -5 ? "text-green-500" : "text-muted-foreground"}`}>
                      {spotVsContract90 > 0 ? "+" : ""}{spotVsContract90.toFixed(1)}% vs 90d
                    </div>
                  )}
                </div>
              </div>

              {/* Forecast sparkline */}
              {lane.forecastDays && lane.forecastDays.length > 0 && (
                <div className="px-2 pt-1 pb-0.5">
                  <div className="text-[9px] text-muted-foreground mb-0.5">14-day forecast</div>
                  <TinyForecastChart days={lane.forecastDays} />
                </div>
              )}

              {/* Driver text + footer */}
              <div className="px-3 pb-2.5">
                {lane.driverText && (
                  <p className="text-[10px] text-muted-foreground leading-snug mt-1.5 line-clamp-2">
                    {lane.driverText}
                  </p>
                )}
                <div className="flex items-center justify-between mt-2">
                  {lane.loadCount != null && (
                    <span className="text-[9px] text-muted-foreground">{lane.loadCount.toLocaleString()} loads</span>
                  )}
                  {lane.confidenceScore != null && (
                    <span className="text-[9px] text-muted-foreground">{lane.confidenceScore}% conf.</span>
                  )}
                  <button
                    onClick={() => onRefresh(lane.id)}
                    disabled={isRefreshing === lane.id}
                    className="text-[9px] text-blue-500 hover:text-blue-600 disabled:opacity-40 transition-colors ml-auto"
                    data-testid={`button-refresh-trac-${lane.id}`}
                  >
                    {isRefreshing === lane.id ? "Refreshing…" : "↻ Refresh"}
                  </button>
                </div>
                {lane.refreshedAt && (
                  <div className="text-[9px] text-muted-foreground/60 mt-0.5">
                    Rate as of {new Date(lane.refreshedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
      label: "Diesel/gal (EIA)",
      value: `$${pulse.dieselPerGal.toFixed(2)}`,
      delta: `${pulse.dieselMoMDelta > 0 ? "▲" : "▼"} $${Math.abs(pulse.dieselMoMDelta).toFixed(3)} WoW`,
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
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-foreground mb-0.5">{alert.lane}</div>
          <div className="text-xs text-muted-foreground mb-1">{alert.signal}</div>
          {alert.votri !== null && alert.votri !== undefined && (
            <div className="text-[10px] text-muted-foreground mb-1">Lane VOTRI: {alert.votri.toFixed(1)}%</div>
          )}
          <div className="text-xs font-medium text-foreground">→ {alert.action}</div>
          {alert.aiNarrative && (
            <div className="mt-1.5 text-xs text-muted-foreground italic border-t border-current/10 pt-1.5">
              {alert.aiNarrative}
            </div>
          )}
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
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-foreground">{opp.lane}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Hist. rate: ${opp.historicalCustomerRate.toFixed(0)} · Expected carrier: ${opp.expectedCarrierCost.toFixed(0)}
          </div>
          {opp.aiNarrative && (
            <div className="mt-1.5 text-xs text-muted-foreground italic">
              {opp.aiNarrative}
            </div>
          )}
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
            Based on your last 3 weeks · adjusted for {lane.votri !== null && lane.votri !== undefined ? `VOTRI ${lane.votri.toFixed(1)}%` : `origin OTRI ${lane.originOtri.toFixed(1)}%`}
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-3 flex-wrap">
        <OtriChip label="Origin OB" otri={lane.originOtri} signal={lane.originSignal} />
        <OtriChip label="Dest IB" otri={lane.destOtri} signal={lane.destSignal} />
        {lane.votri !== null && lane.votri !== undefined && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
            🎯 <strong>VOTRI:</strong> {lane.votri.toFixed(1)}%
          </span>
        )}
      </div>

      {lane.aiNarrative && (
        <div className="mt-3 text-xs text-muted-foreground italic bg-muted/30 rounded-lg px-3 py-2 leading-relaxed">
          {lane.aiNarrative}
        </div>
      )}
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

function ExecutiveReportSection({ report }: { report: ExecutiveReportWithBrief }) {
  const totalRevenue = report.topCompanies.reduce((s, c) => s + c.revenue, 0);

  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2" data-testid="section-executive-report">
        <Trophy className="h-5 w-5 text-amber-500" /> Executive Intel Report
      </h2>

      {report.executiveBrief && (
        <div className="mb-5 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 px-5 py-4" data-testid="text-executive-brief">
          <div className="flex items-center gap-2 mb-2">
            <Trophy className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">AI Executive Brief</span>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{report.executiveBrief}</p>
        </div>
      )}

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

// ── AI Brief Panel ────────────────────────────────────────────────────────────

function AiBriefPanel({ brief, isLoading, onRefresh, isFetchingRefresh }: {
  brief: AiBrief | undefined;
  isLoading: boolean;
  onRefresh: () => void;
  isFetchingRefresh: boolean;
}) {
  if (isLoading) {
    return (
      <div className="mb-6 rounded-xl border p-4 bg-card">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">AI Daily Brief</span>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-4 w-full" />)}
        </div>
      </div>
    );
  }

  if (!brief) return null;

  return (
    <div
      className="mb-6 rounded-xl border overflow-hidden"
      style={{ background: "linear-gradient(135deg, #1a0a2e 0%, #16213e 100%)", borderColor: "#4c1d95" }}
      data-testid="panel-ai-brief"
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-violet-900/50">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-400" />
          <span className="text-xs font-bold uppercase tracking-wider text-violet-300">AI Daily Brief</span>
          {brief.isStale && (
            <span className="text-[10px] text-amber-400 font-medium">⚠ Stale</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/30">
            {new Date(brief.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isFetchingRefresh}
            className="h-6 w-6 p-0 text-violet-400 hover:text-violet-200 hover:bg-violet-900/40"
            data-testid="button-refresh-brief"
          >
            <RefreshCw className={`h-3 w-3 ${isFetchingRefresh ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2">
        {brief.bullets.map((bullet, i) => (
          <div key={i} className="flex items-start gap-2.5" data-testid={`text-brief-bullet-${i}`}>
            <div className="mt-1 h-1.5 w-1.5 rounded-full bg-violet-400 shrink-0" />
            <p className="text-sm text-white/80 leading-relaxed">{bullet}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── My Lanes Heat Panel ───────────────────────────────────────────────────────

function MyLanesPanel({ lanes, isLoading, lastUpdated }: {
  lanes: MyLanesRow[];
  isLoading: boolean;
  lastUpdated: string | null;
}) {
  if (isLoading) {
    return (
      <div className="mb-6 rounded-xl border p-4 bg-card">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">My Lanes</span>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
        </div>
      </div>
    );
  }

  if (lanes.length === 0) return null;

  const hotLanes = lanes.filter(l => l.signal === "hot");
  const warmLanes = lanes.filter(l => l.signal === "warm");
  const coolLanes = lanes.filter(l => l.signal === "cool");

  const SignalDot = ({ signal }: { signal: "hot" | "warm" | "cool" }) => {
    const colors = { hot: "#ef4444", warm: "#f59e0b", cool: "#22c55e" };
    return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: colors[signal] }} />;
  };

  const WeatherBadge = ({ flag, label }: { flag: WeatherFlag | null; label: string }) => {
    if (!flag) return null;
    const isSevere = flag.severity === "severe";
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`inline-flex items-center gap-0.5 text-[9px] font-bold rounded px-1 py-0.5 cursor-help ${isSevere ? "text-red-300 bg-red-900/40" : "text-amber-300 bg-amber-900/40"}`}>
              <CloudRain className="h-2.5 w-2.5" />
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[200px] text-xs">
            {label}: {flag.description} (WMO {flag.maxCode})
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  return (
    <div className="mb-6" data-testid="panel-my-lanes">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <MapPin className="h-4 w-4 text-blue-500" /> My Lanes — Personalized Heat Map
        </h3>
        {lastUpdated && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(lastUpdated).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
          </span>
        )}
      </div>

      {/* Heat summary pills */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {hotLanes.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            🔴 {hotLanes.length} Hot
          </span>
        )}
        {warmLanes.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            🟡 {warmLanes.length} Warm
          </span>
        )}
        {coolLanes.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
            🟢 {coolLanes.length} Cool
          </span>
        )}
      </div>

      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm" data-testid="table-my-lanes">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground">Lane</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">VOTRI</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden sm:table-cell">WoW</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden md:table-cell">Rate vs TRAC</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">Signal</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane, i) => {
              const sigBg = lane.signal === "hot"
                ? "bg-red-50 dark:bg-red-950/10"
                : lane.signal === "warm"
                ? "bg-amber-50 dark:bg-amber-950/10"
                : "";
              const votriColor = lane.signal === "hot"
                ? "text-red-600 dark:text-red-400"
                : lane.signal === "warm"
                ? "text-amber-600 dark:text-amber-400"
                : "text-green-600 dark:text-green-400";
              const wowColor = lane.votriWoW > 0 ? "text-red-500" : lane.votriWoW < 0 ? "text-green-500" : "text-muted-foreground";
              const rateColor = lane.rateDelta === "above" ? "text-green-600 dark:text-green-400" : lane.rateDelta === "below" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";

              return (
                <tr key={lane.qualifier} className={`border-b last:border-0 ${sigBg}`} data-testid={`row-my-lane-${i}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <SignalDot signal={lane.signal} />
                      <span className="font-medium capitalize">{lane.origin}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium capitalize">{lane.destination}</span>
                      <WeatherBadge flag={lane.weatherOrigin} label="Orig" />
                      <WeatherBadge flag={lane.weatherDest} label="Dest" />
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 pl-3.5">{lane.companyName} · {lane.totalLoads} loads</div>
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono font-bold ${votriColor}`}>
                    {lane.votri.toFixed(1)}%
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs hidden sm:table-cell ${wowColor}`}>
                    {lane.votriWoW > 0 ? "+" : ""}{lane.votriWoW.toFixed(1)}pp
                  </td>
                  <td className={`px-4 py-2.5 text-right text-xs hidden md:table-cell ${rateColor}`}>
                    {lane.rateDeltaPct !== null
                      ? `${lane.rateDelta === "above" ? "▲" : "▼"} ${Math.abs(lane.rateDeltaPct).toFixed(1)}% vs TRAC`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      lane.signal === "hot"
                        ? "text-red-600 bg-red-100 border-red-300 dark:bg-red-900/30 dark:text-red-300"
                        : lane.signal === "warm"
                        ? "text-amber-600 bg-amber-100 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300"
                        : "text-green-600 bg-green-100 border-green-300 dark:bg-green-900/30 dark:text-green-300"
                    }`}>
                      {lane.signal === "hot" ? "🔴 Hot" : lane.signal === "warm" ? "🟡 Warm" : "🟢 Cool"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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

// ── Rate Positioning Panel ─────────────────────────────────────────────────────

function classificationBadge(cls: RatePositioningEntry["classification"]) {
  if (cls === "ABOVE_MARKET") return <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-700">▲ Above Market</span>;
  if (cls === "BELOW_MARKET") return <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-700">▼ Below Market</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-700">◆ At Market</span>;
}

function forecastBadge(dir: RatePositioningEntry["forecastDirection"]) {
  if (dir === "TIGHTENING") return <span className="text-[10px] font-semibold text-red-600 dark:text-red-400">📈 Tightening</span>;
  if (dir === "EASING") return <span className="text-[10px] font-semibold text-green-600 dark:text-green-400">📉 Easing</span>;
  return <span className="text-[10px] font-semibold text-muted-foreground">📊 Stable</span>;
}

/** Inline SVG sparkline for the rate trend chart */
function RateTrendSparkline({ historicalPaid, historicalMarket, forecast }: {
  historicalPaid: Array<{ weekLabel: string; ratePerMile: number }>;
  historicalMarket: Array<{ weekLabel: string; ratePerMile: number }>;
  forecast: Array<{ week: number; ratePerMile: number }>;
}) {
  const W = 220, H = 52, PAD = 6;

  // Combine historical + forecast market rates for a continuous market line
  const allPoints: Array<{ x: number; paid?: number; market: number; isForecast: boolean }> = [];
  const totalHistPoints = historicalPaid.length;
  const totalForecastPoints = forecast.length;
  const totalPoints = totalHistPoints + totalForecastPoints;
  if (totalPoints === 0) return null;

  for (let i = 0; i < totalHistPoints; i++) {
    allPoints.push({
      x: i,
      paid: historicalPaid[i]?.ratePerMile,
      market: historicalMarket[i]?.ratePerMile ?? historicalPaid[i]?.ratePerMile,
      isForecast: false,
    });
  }
  for (let i = 0; i < totalForecastPoints; i++) {
    allPoints.push({
      x: totalHistPoints + i,
      market: forecast[i].ratePerMile,
      isForecast: true,
    });
  }

  const allRates = allPoints.flatMap(p => [p.paid ?? p.market, p.market]).filter(v => v > 0);
  if (allRates.length < 2) return null;

  const minR = Math.min(...allRates) * 0.97;
  const maxR = Math.max(...allRates) * 1.03;
  const xScale = (x: number) => PAD + (x / (totalPoints - 1)) * (W - PAD * 2);
  const yScale = (v: number) => H - PAD - ((v - minR) / (maxR - minR)) * (H - PAD * 2);

  const marketPath = allPoints.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x).toFixed(1)},${yScale(p.market).toFixed(1)}`).join(" ");
  const paidPoints = allPoints.filter(p => p.paid !== undefined);
  const paidPath = paidPoints.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x).toFixed(1)},${yScale(p.paid!).toFixed(1)}`).join(" ");

  // Forecast divider x position
  const divX = xScale(totalHistPoints - 0.5);

  return (
    <svg width={W} height={H} data-testid="chart-rate-trend-sparkline" style={{ overflow: "visible" }}>
      {/* Forecast zone shading */}
      {totalForecastPoints > 0 && (
        <rect x={divX} y={PAD} width={W - PAD - divX} height={H - PAD * 2} fill="rgba(99,102,241,0.06)" rx="2" />
      )}
      {/* Market rate line */}
      <path d={marketPath} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeDasharray={totalForecastPoints > 0 ? `${(totalHistPoints * (W - PAD * 2)) / totalPoints} 4` : "none"} />
      {/* Paid rate line (solid, historical only) */}
      {paidPath && <path d={paidPath} fill="none" stroke="#dc2626" strokeWidth="2" />}
      {/* Divider line */}
      {totalForecastPoints > 0 && <line x1={divX} y1={PAD} x2={divX} y2={H - PAD} stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 2" />}
    </svg>
  );
}

function RatePositioningLaneCard({ entry }: { entry: RatePositioningEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const aboveBelow = entry.deltaPerMile >= 0 ? "above" : "below";
  const deltaColor = entry.classification === "ABOVE_MARKET"
    ? "text-red-600 dark:text-red-400"
    : entry.classification === "BELOW_MARKET"
    ? "text-green-600 dark:text-green-400"
    : "text-yellow-600 dark:text-yellow-400";

  const hasTrendData = (entry.historicalWeeklyPaidRates?.length ?? 0) > 0 || (entry.forecastWeeklyRates?.length ?? 0) > 0;

  return (
    <div className="border rounded-xl p-4 bg-card" data-testid={`card-rate-positioning-${entry.lane.replace(/\s+/g, "-").toLowerCase()}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-sm font-semibold text-foreground capitalize">
            {entry.origin} → {entry.destination}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{entry.totalLoads} loads</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {classificationBadge(entry.classification)}
          {forecastBadge(entry.forecastDirection)}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 my-3">
        <div className="text-center bg-muted/40 rounded-lg p-2">
          <div className="text-xs text-muted-foreground mb-0.5">Paid $/mi</div>
          <div className="text-sm font-bold text-foreground">${entry.avgCarrierPayPerMile.toFixed(2)}</div>
        </div>
        <div className="text-center bg-muted/40 rounded-lg p-2">
          <div className="text-xs text-muted-foreground mb-0.5">Market $/mi</div>
          <div className="text-sm font-bold text-foreground">${entry.marketRatePerMile.toFixed(2)}</div>
        </div>
        <div className="text-center bg-muted/40 rounded-lg p-2">
          <div className="text-xs text-muted-foreground mb-0.5">Delta</div>
          <div className={`text-sm font-bold ${deltaColor}`}>
            {aboveBelow === "above" ? "+" : "-"}${Math.abs(entry.deltaPerMile).toFixed(2)}
            <span className="text-[10px] font-normal ml-0.5">({Math.abs(entry.deltaPct).toFixed(1)}%)</span>
          </div>
        </div>
      </div>

      {/* Trend chart toggle */}
      {hasTrendData && (
        <div className="mb-2">
          <button
            className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
            onClick={() => setShowChart(c => !c)}
            data-testid={`button-trend-expand-${entry.lane.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <BarChart2 className="h-3 w-3" />
            {showChart ? "Hide" : "Show"} Rate Trend
          </button>
          {showChart && (
            <div className="mt-2 rounded-lg bg-muted/20 border p-3 overflow-x-auto" data-testid={`chart-rate-trend-${entry.lane.replace(/\s+/g, "-").toLowerCase()}`}>
              <div className="flex items-center gap-3 mb-2">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-0.5 bg-red-500 rounded" /> Org paid $/mi
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-0.5 bg-indigo-500 rounded" /> Market $/mi
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="inline-block w-3 h-2 bg-indigo-100 dark:bg-indigo-900/30 rounded" /> Forecast
                </div>
              </div>
              <RateTrendSparkline
                historicalPaid={entry.historicalWeeklyPaidRates ?? []}
                historicalMarket={entry.historicalWeeklyMarketRates ?? []}
                forecast={entry.forecastWeeklyRates ?? []}
              />
              <div className="flex justify-between mt-1 text-[9px] text-muted-foreground">
                <span>6 wks ago</span>
                <span>Now</span>
                <span>+3 wk forecast</span>
              </div>
            </div>
          )}
        </div>
      )}

      {entry.coachingCard && (
        <div className="mt-2">
          <button
            className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1"
            onClick={() => setExpanded(e => !e)}
            data-testid={`button-coaching-expand-${entry.lane.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <Sparkles className="h-3 w-3" />
            {expanded ? "Hide" : "Show"} Coaching Card
          </button>
          {expanded && (
            <div className="mt-2 rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-foreground/80 leading-relaxed italic">
              {entry.coachingCard}
            </div>
          )}
        </div>
      )}

      {entry.isStale && (
        <div className="mt-1 text-[10px] text-amber-500">⚠ Market data may be stale</div>
      )}
    </div>
  );
}

type RateFilter = "all" | "ABOVE_MARKET" | "AT_MARKET" | "BELOW_MARKET";

function RatePositioningPanel({ rp }: { rp: RatePositioningSummary }) {
  const [filter, setFilter] = useState<RateFilter>("all");
  const exp = rp.portfolioExposure;

  const filteredLanes = filter === "all"
    ? rp.lanes
    : rp.lanes.filter(e => e.classification === filter);

  return (
    <section className="mb-10" data-testid="section-rate-positioning">
      <h2 className="text-lg font-bold text-foreground flex items-center gap-2 mb-4">
        <Target className="h-5 w-5 text-indigo-600" /> Rate Intelligence & Positioning
      </h2>

      {/* Portfolio Exposure Summary — clickable filter tiles */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <button
          className={`rounded-xl border p-4 text-center transition-all ${filter === "ABOVE_MARKET" ? "ring-2 ring-red-500 bg-red-100 dark:bg-red-900/30" : "bg-red-50 dark:bg-red-950/20 hover:bg-red-100 dark:hover:bg-red-900/20"}`}
          onClick={() => setFilter(f => f === "ABOVE_MARKET" ? "all" : "ABOVE_MARKET")}
          data-testid="filter-above-market"
        >
          <div className="text-2xl font-black text-red-600 dark:text-red-400">{exp.aboveMarketCount}</div>
          <div className="text-xs font-semibold text-red-700 dark:text-red-300 mt-0.5">Above Market</div>
          <div className="text-[10px] text-muted-foreground">{exp.aboveMarketPct.toFixed(0)}% of lanes</div>
        </button>
        <button
          className={`rounded-xl border p-4 text-center transition-all ${filter === "AT_MARKET" ? "ring-2 ring-yellow-500 bg-yellow-100 dark:bg-yellow-900/30" : "bg-yellow-50 dark:bg-yellow-950/20 hover:bg-yellow-100 dark:hover:bg-yellow-900/20"}`}
          onClick={() => setFilter(f => f === "AT_MARKET" ? "all" : "AT_MARKET")}
          data-testid="filter-at-market"
        >
          <div className="text-2xl font-black text-yellow-600 dark:text-yellow-400">{exp.atMarketCount}</div>
          <div className="text-xs font-semibold text-yellow-700 dark:text-yellow-300 mt-0.5">At Market</div>
          <div className="text-[10px] text-muted-foreground">{exp.atMarketPct.toFixed(0)}% of lanes</div>
        </button>
        <button
          className={`rounded-xl border p-4 text-center transition-all ${filter === "BELOW_MARKET" ? "ring-2 ring-green-500 bg-green-100 dark:bg-green-900/30" : "bg-green-50 dark:bg-green-950/20 hover:bg-green-100 dark:hover:bg-green-900/20"}`}
          onClick={() => setFilter(f => f === "BELOW_MARKET" ? "all" : "BELOW_MARKET")}
          data-testid="filter-below-market"
        >
          <div className="text-2xl font-black text-green-600 dark:text-green-400">{exp.belowMarketCount}</div>
          <div className="text-xs font-semibold text-green-700 dark:text-green-300 mt-0.5">Below Market</div>
          <div className="text-[10px] text-muted-foreground">{exp.belowMarketPct.toFixed(0)}% of lanes</div>
        </button>
      </div>

      {/* Filter tab strip */}
      <div className="flex items-center gap-2 mb-4">
        {(["all", "ABOVE_MARKET", "AT_MARKET", "BELOW_MARKET"] as RateFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            data-testid={`tab-rate-filter-${f.toLowerCase()}`}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${
              filter === f
                ? f === "ABOVE_MARKET" ? "bg-red-600 text-white border-red-600"
                  : f === "AT_MARKET" ? "bg-yellow-500 text-white border-yellow-500"
                  : f === "BELOW_MARKET" ? "bg-green-600 text-white border-green-600"
                  : "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:border-foreground/50"
            }`}
          >
            {f === "all" ? `All (${rp.lanes.length})` : f === "ABOVE_MARKET" ? `Above (${exp.aboveMarketCount})` : f === "AT_MARKET" ? `At Market (${exp.atMarketCount})` : `Below (${exp.belowMarketCount})`}
          </button>
        ))}
        {filter !== "all" && (
          <span className="text-xs text-muted-foreground ml-1">Click tile or tab to clear filter</span>
        )}
      </div>

      {/* Avg delta summary bar */}
      {(exp.worstLane || exp.avgDeltaPct !== 0) && (
        <div className="rounded-xl border bg-muted/20 p-4 mb-4 flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Portfolio avg delta: </span>
            <span className={`font-bold ${exp.avgDeltaPct > 5 ? "text-red-600" : exp.avgDeltaPct < -5 ? "text-green-600" : "text-foreground"}`}>
              {exp.avgDeltaPct > 0 ? "+" : ""}{exp.avgDeltaPct.toFixed(1)}% vs market
            </span>
          </div>
          {exp.monthlyOverMarketDollars > 0 && (
            <div>
              <span className="text-muted-foreground">Est. monthly over-market spend: </span>
              <span className="font-bold text-red-600 dark:text-red-400">
                ${(exp.monthlyOverMarketDollars / 1000).toFixed(0)}K
              </span>
            </div>
          )}
          {exp.worstLane && (
            <div>
              <span className="text-muted-foreground">Worst exposure: </span>
              <span className="font-semibold text-red-600 dark:text-red-400 capitalize">{exp.worstLane}</span>
            </div>
          )}
          {exp.bestLane && (
            <div>
              <span className="text-muted-foreground">Best position: </span>
              <span className="font-semibold text-green-600 dark:text-green-400 capitalize">{exp.bestLane}</span>
            </div>
          )}
        </div>
      )}

      {/* Tightening action callout */}
      {exp.tighteningActionLanes?.length > 0 && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 p-3 mb-4 flex items-start gap-2">
          <TrendingUp className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs">
            <span className="font-semibold text-amber-700 dark:text-amber-400">Act this week — tightening markets: </span>
            <span className="text-amber-600 dark:text-amber-300 capitalize">{exp.tighteningActionLanes.join(", ")}</span>
          </div>
        </div>
      )}

      {/* Lane cards */}
      {filteredLanes.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredLanes.map((entry, i) => (
            <RatePositioningLaneCard key={i} entry={entry} />
          ))}
        </div>
      ) : rp.lanes.length > 0 ? (
        <div className="rounded-xl border bg-muted/30 p-6 text-center text-muted-foreground text-sm">
          No lanes match this filter.
        </div>
      ) : (
        <div className="rounded-xl border bg-muted/30 p-8 text-center text-muted-foreground text-sm">
          <Target className="h-8 w-8 mx-auto mb-3 opacity-30" />
          No rate positioning data available. Upload financial data to enable rate intelligence.
        </div>
      )}
    </section>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IntelPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedUserId, setSelectedUserId] = useState<string>("all");
  const [briefRefreshKey, setBriefRefreshKey] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const isAdmin = user?.role === "admin";
  const isDirector = user?.role === "director" || user?.role === "sales_director";
  const allowedRoles = ["admin", "director", "sales_director", "account_manager", "national_account_manager"];
  if (user && !allowedRoles.includes(user.role)) {
    setLocation("/");
    return null;
  }

  const queryUserId = (isAdmin || isDirector) && selectedUserId !== "all" ? selectedUserId : undefined;

  const { data, isLoading, error, isFetching, dataUpdatedAt } = useQuery<IntelPayload>({
    queryKey: ["/api/intel", queryUserId ?? "all"],
    queryFn: async () => {
      const url = queryUserId ? `/api/intel?userId=${encodeURIComponent(queryUserId)}` : "/api/intel";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load intel");
      const result = await res.json();
      setLastRefreshedAt(new Date());
      return result;
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000, // 15-minute auto-refresh
    refetchOnWindowFocus: false,
  });

  // AI Daily Brief query — per current user (not filtered by selectedUserId for main intel)
  const {
    data: aiBrief,
    isLoading: briefLoading,
    isFetching: briefFetching,
  } = useQuery<AiBrief>({
    queryKey: ["/api/intel/brief", briefRefreshKey],
    queryFn: async () => {
      const url = briefRefreshKey > 0
        ? "/api/intel/brief?refresh=true"
        : "/api/intel/brief";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load brief");
      return res.json();
    },
    staleTime: 4 * 60 * 60 * 1000, // 4 hours
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // My Lanes query — respects selectedUserId filter
  const {
    data: myLanesData,
    isLoading: myLanesLoading,
  } = useQuery<{ lanes: MyLanesRow[]; lastUpdated: string; userId: string }>({
    queryKey: ["/api/intel/my-lanes", queryUserId ?? "self"],
    queryFn: async () => {
      const url = queryUserId
        ? `/api/intel/my-lanes?userId=${encodeURIComponent(queryUserId)}`
        : "/api/intel/my-lanes";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load my lanes");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // TRAC rate cards query
  const [refreshingTracId, setRefreshingTracId] = useState<string | null>(null);
  const {
    data: tracData,
    isLoading: tracLoading,
  } = useQuery<{ lanes: TracLaneCard[] }>({
    queryKey: ["/api/intel/trac/my-lanes"],
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const handleTracRefresh = async (id: string) => {
    setRefreshingTracId(id);
    try {
      await apiRequest("POST", `/api/intel/trac/refresh/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/intel/trac/my-lanes"] });
    } catch {
      // silently ignore
    } finally {
      setRefreshingTracId(null);
    }
  };

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

  const handleManualRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/intel"] });
    queryClient.invalidateQueries({ queryKey: ["/api/intel/my-lanes"] });
    setLastRefreshedAt(new Date());
  };

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

  const { dailyInsights, biweeklyScorecard, executiveReport, availableReps, ratePositioning } = data as typeof data & { ratePositioning?: RatePositioningSummary };
  const { overallStats } = biweeklyScorecard;
  // For admins/directors: isFiltered means they've selected a specific rep in the dropdown
  // For non-admins: always showing their own data (not "filtered" in the UI sense)
  const isFiltered = (isAdmin || isDirector) && selectedUserId !== "all";
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
        {/* User Dropdown — admin only */}
        {isAdmin && (
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
        )}

        {/* Last updated + manual refresh */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0 ml-auto">
          {lastRefreshedAt && (
            <span data-testid="text-last-updated">
              Updated {lastRefreshedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
            </span>
          )}
          {!isAdmin && isFetching && <span className="animate-pulse">Loading…</span>}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleManualRefresh}
            disabled={isFetching}
            data-testid="button-manual-refresh"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            title="Refresh market data"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Send Report Now — admin only */}
        {isAdmin && (
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
        )}
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION: AI BRIEF (top of page, most prominent)
      ══════════════════════════════════════════════════════ */}
      <AiBriefPanel
        brief={aiBrief}
        isLoading={briefLoading}
        onRefresh={() => setBriefRefreshKey(k => k + 1)}
        isFetchingRefresh={briefFetching}
      />

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

        {/* ── My Lanes Heat Panel ─────────────────────────────── */}
        <MyLanesPanel
          lanes={myLanesData?.lanes ?? []}
          isLoading={myLanesLoading}
          lastUpdated={myLanesData?.lastUpdated ?? null}
        />

        {/* ── TRAC Market Rate Cards ───────────────────────────── */}
        <TracRateCardsPanel
          lanes={tracData?.lanes ?? []}
          isLoading={tracLoading}
          onRefresh={handleTracRefresh}
          isRefreshing={refreshingTracId}
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
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground">OB OTRI</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden sm:table-cell">IB OTRI</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden sm:table-cell">VOTRI</th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden lg:table-cell">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="cursor-help underline decoration-dotted">OTVI</TooltipTrigger>
                          <TooltipContent className="text-xs max-w-[200px]">
                            Outbound Tender Volume Index — measures load volume relative to capacity
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </th>
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden lg:table-cell">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="cursor-help underline decoration-dotted">HAI</TooltipTrigger>
                          <TooltipContent className="text-xs max-w-[200px]">
                            Headhaul-Backhaul Imbalance Index — higher = more headhaul demand vs. backhaul
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </th>
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
                    const wowVal = m.votriWoW ?? m.otriWoW;
                    return (
                      <tr key={m.market} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`} data-testid={`row-market-trend-${m.market}`}>
                        <td className="px-4 py-2.5 font-medium capitalize">{m.market}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{m.otri.toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted-foreground hidden sm:table-cell" data-testid={`cell-ibotri-${m.market}`}>
                          {m.ibOtri !== null ? `${m.ibOtri.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted-foreground hidden sm:table-cell">
                          {m.votri !== null ? `${m.votri.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted-foreground hidden lg:table-cell">
                          {m.otvi !== null ? m.otvi.toFixed(0) : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-muted-foreground hidden lg:table-cell">
                          {m.hai !== null ? m.hai.toFixed(2) : "—"}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono ${wowVal > 0 ? "text-red-600" : wowVal < 0 ? "text-green-600" : "text-muted-foreground"}`}>
                          {wowVal > 0 ? "+" : ""}{wowVal.toFixed(1)}pp
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
                    <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden md:table-cell">VOTRI / OTRI</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyInsights.buyRateQuickLook.map((lane, i) => (
                    <tr key={i} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/20"}`} data-testid={`row-buy-rate-${i}`}>
                      <td className="px-4 py-2.5 font-medium text-foreground">
                        <div>
                          <span className="capitalize">{lane.origin}</span>
                          <span className="text-muted-foreground mx-1">→</span>
                          <span className="capitalize">{lane.destination}</span>
                          {lane.equipment && <span className="text-muted-foreground text-xs ml-1">({lane.equipment})</span>}
                        </div>
                        {lane.aiRationale && (
                          <div className="text-[10px] text-muted-foreground italic mt-0.5 max-w-xs leading-tight">{lane.aiRationale}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{lane.totalLoads}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-foreground">
                        {lane.buyRateLow > 0
                          ? `$${lane.buyRateLow.toFixed(2)} – $${lane.buyRateHigh.toFixed(2)}`
                          : <span className="text-muted-foreground text-xs">Insufficient data</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground hidden md:table-cell">
                        {lane.votri !== null && lane.votri !== undefined
                          ? <span className="text-blue-600 dark:text-blue-400 font-medium">{lane.votri.toFixed(1)}% VOTRI</span>
                          : `${lane.originOtri.toFixed(1)}% OB`
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Perplexity Market Context ──────────────────────────────── */}
        {dailyInsights.marketContext && dailyInsights.marketContext.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Radio className="h-4 w-4 text-purple-500" /> Market Context — Real-World Freight News
            </h3>
            <div className="space-y-3">
              {dailyInsights.marketContext.map((item, i) => (
                <div key={i} className="border rounded-xl p-4 bg-card" data-testid={`card-market-context-${i}`}>
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 rounded-full shrink-0">
                      {item.market}
                    </span>
                    <span className="text-xs font-semibold text-foreground leading-snug">{item.headline}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1">{item.summary}</p>
                  <p className="text-xs text-foreground/70 italic">→ {item.relevance}</p>
                </div>
              ))}
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
          SECTION: RATE INTELLIGENCE & POSITIONING
      ══════════════════════════════════════════════════════ */}
      {ratePositioning && (
        <RatePositioningPanel rp={ratePositioning} />
      )}

      {/* ══════════════════════════════════════════════════════
          SECTION: EXECUTIVE REPORT (admin only, always org-wide)
      ══════════════════════════════════════════════════════ */}
      {isAdmin && <ExecutiveReportSection report={executiveReport} />}
    </div>
  );
}
