/**
 * Sonar Market Pulse Portlet
 *
 * Displays live FreightWaves Sonar data with role-specific intelligence.
 * - AM: top 3 markets affecting their accounts (tightest/loosening most), with account counts
 * - NAM: org-wide city exposure — cities across all accounts, account counts per city
 * - Director: portfolio heat summary (hot/warm/cool lane counts) + NTI vs VCRPM1 spread
 * - LM: Capacity Urgency list — assigned LWQ lanes ranked by VOTRI
 * Fetches from GET /api/sonar/market-pulse?role=<role> (1-hour cache on backend).
 */

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio, TrendingUp, TrendingDown, Minus, AlertCircle, Building2 } from "lucide-react";

interface MarketEntry {
  city: string;
  loads: number;
  companyCount: number;
  otri: number | null;
  otriWoW: number | null;
  signal: "hot" | "warm" | "cool" | null;
}

interface UrgencyLane {
  origin: string;
  destination: string;
  votri: number;
  votriWoW: number;
  signal: "hot" | "warm" | "cool";
  companyName: string;
}

interface AmRolePayload {
  role: "am";
  markets: MarketEntry[];
  myAccountCount: number;
}

interface NamRolePayload {
  role: "nam";
  markets: MarketEntry[];
}

interface DirectorRolePayload {
  role: "director";
  heatSummary: { hot: number; warm: number; cool: number; total: number };
  ntiPerMove: number;
  ntiPerMile: number;
  spread: number | null;
  topMovingMarkets: Array<{ city: string; otri: number; otriWoW: number; signal: "hot" | "warm" | "cool" }>;
}

interface LmRolePayload {
  role: "logistics_manager";
  urgencyLanes: UrgencyLane[];
}

interface MarketPulse {
  otri: number;
  otriWoWDelta: number;
  ntiPerMove: number;
  ntiWoWDelta: number;
  ntiPerMile: number;
  flatbedOtri: number;
  flatbedSignal: "hot" | "cool" | "neutral";
  dieselPerGal: number;
  dieselMoMDelta: number;
  timestamp: string;
  isStale: boolean;
  marketDataLimited?: boolean;
  marketDataResumesAt?: string;
  rolePayload?: AmRolePayload | NamRolePayload | DirectorRolePayload | LmRolePayload;
}

type DashboardRole = "am" | "nam" | "director" | "logistics_manager";

function signalColor(otri: number) {
  if (otri >= 20) return { label: "Hot", cls: "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700" };
  if (otri >= 8)  return { label: "Warm", cls: "text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700" };
  return { label: "Cool", cls: "text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700" };
}

function signalBadge(signal: "hot" | "warm" | "cool" | null, otri?: number | null) {
  if (signal === "hot" || (otri !== undefined && otri !== null && otri >= 20)) {
    return <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-red-600 bg-red-100 border-red-300">🔴 Hot</Badge>;
  }
  if (signal === "warm" || (otri !== undefined && otri !== null && otri >= 8)) {
    return <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-amber-600 bg-amber-100 border-amber-300">🟡 Warm</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-green-600 bg-green-100 border-green-300">🟢 Cool</Badge>;
}

function DeltaIcon({ delta }: { delta: number }) {
  if (delta > 0.05) return <TrendingUp className="h-3 w-3 text-red-500" />;
  if (delta < -0.05) return <TrendingDown className="h-3 w-3 text-green-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

interface PulseMetricProps {
  label: string;
  value: string;
  delta?: string;
  deltaPositiveBad?: boolean;
  deltaValue?: number;
  testId?: string;
}

function PulseMetric({ label, value, delta, deltaPositiveBad, deltaValue, testId }: PulseMetricProps) {
  const deltaColor = deltaValue === undefined ? ""
    : deltaValue > 0.05 ? (deltaPositiveBad ? "text-red-500" : "text-green-500")
    : deltaValue < -0.05 ? (deltaPositiveBad ? "text-green-500" : "text-red-500")
    : "text-muted-foreground";

  return (
    <div className="flex flex-col items-center text-center" data-testid={testId}>
      <div className="text-base font-bold leading-none">{value}</div>
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground mt-1">{label}</div>
      {delta && (
        <div className={`text-[9px] mt-0.5 ${deltaColor}`}>{delta}</div>
      )}
    </div>
  );
}

/** Role-specific coaching insight beneath the metrics panel */
function roleInsight(role: DashboardRole | undefined, otri: number): string {
  const isHot  = otri >= 20;
  const isWarm = otri >= 8 && otri < 20;

  switch (role) {
    case "am":
      if (isHot)  return "Market is tight — lead with capacity security in every carrier call. Frequency and reliability are your top value props right now.";
      if (isWarm) return "Moderate conditions — keep outreach consistent. Watch for spot-rate spikes on your top lanes.";
      return "Loose market — great time to lock in buy rates. Focus on converting spot shippers to contract.";

    case "nam":
      if (isHot)  return "OTRI elevated — coach your AMs to emphasize capacity reliability over price. Target accounts with upcoming RFP exposure.";
      if (isWarm) return "Balanced market — push contract conversion pipeline. Identify accounts still on spot and build urgency.";
      return "Capacity is available — prioritize rate leverage conversations. Help your team negotiate stronger buy rates.";

    case "director":
      if (isHot)  return "Market tightness may compress margins. Review your team's awarded lane coverage vs. spot exposure across key accounts.";
      if (isWarm) return "Stable conditions — good opportunity to strengthen contract penetration across the portfolio.";
      return "Soft market — capacity surplus favors shippers. Evaluate buy-rate refresh opportunities across A and B accounts.";

    case "logistics_manager":
      if (isHot)  return "Carrier capacity is tight — book early and confirm coverage on recurring loads. Flag any gaps immediately.";
      if (isWarm) return "Moderate market — maintain carrier relationships and stay proactive on load coverage.";
      return "Capacity is widely available — good time to shop alternate carriers on tough lanes.";

    default:
      if (isHot)  return "Tight market — carriers rejecting frequently. Lock in capacity and position as reliable broker.";
      if (isWarm) return "Moderate market — balanced conditions. Watch for tightening in high-volume corridors.";
      return "Loose market — capacity abundant. Good leverage to negotiate buy rates.";
  }
}

// ── Role-specific content blocks ─────────────────────────────────────────────

function AmMarketBlock({ payload }: { payload: AmRolePayload }) {
  if (!payload.markets.length) {
    return (
      <p className="text-xs text-muted-foreground mt-2" data-testid="text-am-no-markets">
        No financial corridor data found for your accounts. Upload financial data to see market signals.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1" data-testid="block-am-markets">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Your Top Markets This Week</p>
      {payload.markets.map(m => (
        <div key={m.city} className="flex items-center justify-between text-xs" data-testid={`row-market-${m.city}`}>
          <span className="font-medium">{m.city}</span>
          <div className="flex items-center gap-2">
            {m.otriWoW !== null && (
              <span className={`text-[10px] ${m.otriWoW > 0 ? "text-red-500" : "text-green-500"}`}>
                {m.otriWoW > 0 ? "+" : ""}{m.otriWoW.toFixed(1)}pp WoW
              </span>
            )}
            {signalBadge(m.signal, m.otri)}
            <span className="text-muted-foreground text-[10px]">{m.companyCount} acct{m.companyCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function NamMarketBlock({ payload }: { payload: NamRolePayload }) {
  if (!payload.markets.length) {
    return (
      <p className="text-xs text-muted-foreground mt-2">
        No corridor data. Upload financial data to see org-wide market exposure.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1" data-testid="block-nam-markets">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Org-Wide Market Exposure</p>
      {payload.markets.slice(0, 6).map(m => (
        <div key={m.city} className="flex items-center justify-between text-xs" data-testid={`row-market-${m.city}`}>
          <span className="font-medium">{m.city}</span>
          <div className="flex items-center gap-2">
            {m.otriWoW !== null && (
              <span className={`text-[10px] ${m.otriWoW > 0 ? "text-red-500" : "text-green-500"}`}>
                {m.otriWoW > 0 ? "+" : ""}{m.otriWoW.toFixed(1)}pp
              </span>
            )}
            {signalBadge(m.signal, m.otri)}
            <span className="text-muted-foreground text-[10px] flex items-center gap-0.5">
              <Building2 className="h-2.5 w-2.5" />{m.companyCount}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DirectorHeatBlock({ payload }: { payload: DirectorRolePayload }) {
  const { heatSummary, spread, topMovingMarkets } = payload;
  return (
    <div className="mt-2 space-y-2" data-testid="block-director-heat">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-2 text-center" data-testid="stat-hot-lanes">
          <div className="text-lg font-bold text-red-600">{heatSummary.hot}</div>
          <div className="text-[10px] text-muted-foreground">🔴 Hot</div>
        </div>
        <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-2 text-center" data-testid="stat-warm-lanes">
          <div className="text-lg font-bold text-amber-600">{heatSummary.warm}</div>
          <div className="text-[10px] text-muted-foreground">🟡 Warm</div>
        </div>
        <div className="rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-2 text-center" data-testid="stat-cool-lanes">
          <div className="text-lg font-bold text-green-600">{heatSummary.cool}</div>
          <div className="text-[10px] text-muted-foreground">🟢 Cool</div>
        </div>
      </div>
      {spread !== null && (
        <div className="flex items-center justify-between text-xs bg-muted/40 rounded px-2 py-1.5" data-testid="stat-rate-spread">
          <span className="text-muted-foreground">Spot vs Contract spread</span>
          <span className={`font-semibold ${spread > 0 ? "text-red-600" : "text-green-600"}`}>
            {spread > 0 ? "+" : ""}{spread.toFixed(2)}/mi
          </span>
        </div>
      )}
      {topMovingMarkets.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Most Active Markets</p>
          {topMovingMarkets.slice(0, 3).map(m => (
            <div key={m.city} className="flex items-center justify-between text-xs mb-0.5" data-testid={`row-moving-${m.city}`}>
              <span>{m.city}</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] ${m.otriWoW > 0 ? "text-red-500" : "text-green-500"}`}>
                  {m.otriWoW > 0 ? "+" : ""}{m.otriWoW.toFixed(1)}pp
                </span>
                {signalBadge(m.signal)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LmUrgencyBlock({ payload }: { payload: LmRolePayload }) {
  if (!payload.urgencyLanes.length) {
    return (
      <p className="text-xs text-muted-foreground mt-2" data-testid="text-lm-no-lanes">
        No assigned lanes found. Lanes will appear here once you have active recurring lanes in the queue.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1" data-testid="block-lm-urgency">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Capacity Urgency — Your Lanes</p>
      {payload.urgencyLanes.slice(0, 6).map((lane, i) => (
        <div
          key={`${lane.origin}-${lane.destination}-${i}`}
          className="flex items-center justify-between text-xs"
          data-testid={`row-urgency-lane-${i}`}
        >
          <span className="font-medium truncate max-w-[120px]">{lane.origin} → {lane.destination}</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">{lane.votri.toFixed(1)}%</span>
            <span className={`text-[10px] ${lane.votriWoW > 0 ? "text-red-500" : "text-green-500"}`}>
              {lane.votriWoW > 0 ? "+" : ""}{lane.votriWoW.toFixed(1)}pp
            </span>
            {signalBadge(lane.signal)}
          </div>
        </div>
      ))}
    </div>
  );
}

interface SonarMarketPulsePortletProps {
  role?: DashboardRole;
}

export function SonarMarketPulsePortlet({ role }: SonarMarketPulsePortletProps = {}) {
  const queryKey = role ? ["/api/sonar/market-pulse", role] : ["/api/sonar/market-pulse"];
  const url = role ? `/api/sonar/market-pulse?role=${role}` : "/api/sonar/market-pulse";

  const { data: pulse, isLoading } = useQuery<MarketPulse>({
    queryKey,
    staleTime: 55 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: () => fetch(url, { credentials: "include" }).then(r => r.json()),
  });

  if (isLoading) {
    return (
      <Card data-testid="portlet-market-pulse">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-500" /> Market Pulse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-12 w-full rounded-lg" />
          {role && <Skeleton className="h-20 w-full rounded-lg mt-2" />}
        </CardContent>
      </Card>
    );
  }

  if (!pulse) return null;

  const signal = signalColor(pulse.otri);

  return (
    <Card data-testid={`portlet-market-pulse${role ? `-${role}` : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-500" />
            {role === "logistics_manager" ? "Capacity Urgency" : "Market Pulse"}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {pulse.isStale && (
              <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 py-0">
                Stale
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`text-[10px] py-0 px-1.5 ${signal.cls}`}
              data-testid="badge-market-signal"
            >
              {signal.label}
            </Badge>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5" data-testid="text-sonar-timestamp">
          Sonar · {new Date(pulse.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        {pulse.marketDataLimited && (
          <div className="flex items-center gap-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-2.5 py-1.5 mb-2" data-testid="banner-market-data-limited">
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-[11px] text-amber-700 dark:text-amber-300">Market data temporarily limited — showing cached values</span>
          </div>
        )}
        {/* National metrics bar */}
        <div className="rounded-lg overflow-hidden" style={{ background: "#0a1628" }}>
          <div className="grid grid-cols-3 divide-x divide-white/10 py-3 px-1">
            <PulseMetric
              label="OTRI"
              value={`${pulse.otri.toFixed(1)}%`}
              delta={`${pulse.otriWoWDelta > 0 ? "+" : ""}${pulse.otriWoWDelta.toFixed(1)} pp WoW`}
              deltaValue={pulse.otriWoWDelta}
              deltaPositiveBad={true}
              testId="metric-otri"
            />
            <PulseMetric
              label="NTI Spot"
              value={pulse.ntiPerMove > 100
                ? `$${Math.round(pulse.ntiPerMove).toLocaleString()}`
                : `$${pulse.ntiPerMove.toFixed(2)}/mi`}
              delta={pulse.ntiWoWDelta !== 0
                ? `${pulse.ntiWoWDelta > 0 ? "+" : ""}${Math.round(pulse.ntiWoWDelta)} WoW`
                : undefined}
              deltaValue={pulse.ntiWoWDelta}
              testId="metric-nti"
            />
            <PulseMetric
              label="Contract $/mi"
              value={`$${pulse.ntiPerMile.toFixed(2)}`}
              testId="metric-contract"
            />
          </div>
        </div>

        {/* Role-specific block */}
        {pulse.rolePayload?.role === "am" && <AmMarketBlock payload={pulse.rolePayload as AmRolePayload} />}
        {pulse.rolePayload?.role === "nam" && <NamMarketBlock payload={pulse.rolePayload as NamRolePayload} />}
        {pulse.rolePayload?.role === "director" && <DirectorHeatBlock payload={pulse.rolePayload as DirectorRolePayload} />}
        {pulse.rolePayload?.role === "logistics_manager" && <LmUrgencyBlock payload={pulse.rolePayload as LmRolePayload} />}

        {/* Fallback coaching text when no role-specific block rendered */}
        {!pulse.rolePayload && (
          <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed" data-testid="text-market-insight">
            {roleInsight(role, pulse.otri)}
          </p>
        )}

        {/* Role coaching text below role-specific block */}
        {pulse.rolePayload && (
          <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed" data-testid="text-market-insight">
            {roleInsight(role, pulse.otri)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Compact inline Market Pulse strip for dashboard headers.
 */
export function SonarMarketPulseStrip() {
  const { data: pulse } = useQuery<MarketPulse>({
    queryKey: ["/api/sonar/market-pulse"],
    staleTime: 55 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (!pulse) return null;

  const signal = signalColor(pulse.otri);

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-xs border"
      style={{ background: "#0a1628", borderColor: "#1e3a5f" }}
      data-testid="strip-market-pulse"
    >
      <span className="text-white/50 flex items-center gap-1">
        <Radio className="h-3 w-3 text-blue-400" />
        <span className="text-[10px] uppercase tracking-wider">Sonar</span>
      </span>
      <span className="text-white font-semibold">OTRI {pulse.otri.toFixed(1)}%</span>
      <Badge
        variant="outline"
        className={`text-[10px] py-0 px-1.5 border ${signal.cls}`}
        data-testid="badge-strip-signal"
      >
        {signal.label}
      </Badge>
      <span className="text-white/70">
        NTI {pulse.ntiPerMove > 100 ? `$${Math.round(pulse.ntiPerMove).toLocaleString()}/move` : `$${pulse.ntiPerMove.toFixed(2)}/mi`}
      </span>
      {pulse.isStale && <span className="text-amber-400 text-[10px]">⚠ Stale</span>}
    </div>
  );
}
