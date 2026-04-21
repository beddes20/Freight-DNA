import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronRight, ChevronDown, TrendingUp, TrendingDown,
  Repeat2, MessageSquare, UserPlus, Activity, Trophy,
  ShieldCheck, UserCircle, ArrowUpRight, ArrowDownRight, Target, ExternalLink,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { MarginGoalEditButton } from "./MarginGoalEditButton";
import type { SafeUser, TeamActivity, RelationshipsMovedData, TrendingResponse, MarginMetrics, MarginUserMetric, OpportunityLog } from "./types";
import type { PortletType } from "@/components/dashboard-activity-sheet";
import { SonarMarketPulsePortlet } from "@/components/sonar-market-pulse";
import { TeamOverdueConversationsPortlet } from "@/components/team-overdue-conversations-portlet";
import { NbaTeamRollupPortlet } from "@/components/NbaTeamRollupPortlet";
import { NbaRulePerformancePanel } from "@/components/NbaRulePerformancePanel";

function DirectorRulePerformanceWrapper() {
  const [collapsed, setCollapsed] = useState(true);
  return <NbaRulePerformancePanel collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />;
}

// ── Rate Exposure Portlet ──────────────────────────────────────────────────────

interface PortfolioExposure {
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
}

interface RepRateEntry {
  repName: string;
  avgDeltaPct: number;
  aboveCount: number;
  belowCount: number;
  atCount: number;
  totalLanes: number;
}

interface RatePositioningSummary {
  portfolioExposure: PortfolioExposure;
  repLeaderboard: RepRateEntry[];
  generatedAt: string;
}

interface IntelData {
  ratePositioning?: RatePositioningSummary;
}

function RateExposurePortlet() {
  const [showRepBoard, setShowRepBoard] = useState(false);
  const { data, isLoading } = useQuery<IntelData>({
    queryKey: ["/api/intel", "all"],
    queryFn: async () => {
      const res = await fetch("/api/intel", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load intel");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const exp = data?.ratePositioning?.portfolioExposure;
  const repLeaderboard = data?.ratePositioning?.repLeaderboard ?? [];

  return (
    <Card data-testid="portlet-rate-exposure">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="h-4 w-4 text-indigo-600" />
          Portfolio Rate Exposure
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !exp ? (
          <p className="text-xs text-muted-foreground">Upload financial data to enable rate intelligence.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center rounded-lg bg-red-50 dark:bg-red-950/20 p-2" data-testid="exposure-above-market">
                <div className="text-lg font-black text-red-600 dark:text-red-400">{exp.aboveMarketCount}</div>
                <div className="text-[10px] text-red-700 dark:text-red-300 font-semibold">Above Mkt</div>
                <div className="text-[10px] text-muted-foreground">{exp.aboveMarketPct.toFixed(0)}%</div>
              </div>
              <div className="text-center rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-2" data-testid="exposure-at-market">
                <div className="text-lg font-black text-yellow-600 dark:text-yellow-400">{exp.atMarketCount}</div>
                <div className="text-[10px] text-yellow-700 dark:text-yellow-300 font-semibold">At Market</div>
                <div className="text-[10px] text-muted-foreground">{exp.atMarketPct.toFixed(0)}%</div>
              </div>
              <div className="text-center rounded-lg bg-green-50 dark:bg-green-950/20 p-2" data-testid="exposure-below-market">
                <div className="text-lg font-black text-green-600 dark:text-green-400">{exp.belowMarketCount}</div>
                <div className="text-[10px] text-green-700 dark:text-green-300 font-semibold">Below Mkt</div>
                <div className="text-[10px] text-muted-foreground">{exp.belowMarketPct.toFixed(0)}%</div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground space-y-1 mb-3">
              <div>
                Avg delta:{" "}
                <span className={`font-semibold ${exp.avgDeltaPct > 5 ? "text-red-600" : exp.avgDeltaPct < -5 ? "text-green-600" : "text-foreground"}`}>
                  {exp.avgDeltaPct > 0 ? "+" : ""}{exp.avgDeltaPct.toFixed(1)}% vs market
                </span>
              </div>
              {exp.monthlyOverMarketDollars > 0 && (
                <div data-testid="exposure-monthly-over-market">
                  Est. monthly over-market spend:{" "}
                  <span className="font-semibold text-red-600 dark:text-red-400">
                    ${(exp.monthlyOverMarketDollars / 1000).toFixed(0)}K
                  </span>
                </div>
              )}
              {exp.worstLane && (
                <div>Worst: <span className="font-medium text-red-600 dark:text-red-400 capitalize">{exp.worstLane}</span></div>
              )}
              {exp.bestLane && (
                <div>Best: <span className="font-medium text-green-600 dark:text-green-400 capitalize">{exp.bestLane}</span></div>
              )}
              {exp.tighteningActionLanes.length > 0 && (
                <div className="text-amber-600 dark:text-amber-400">
                  ⚡ Act now: <span className="capitalize">{exp.tighteningActionLanes.slice(0, 2).join(", ")}</span>
                </div>
              )}
            </div>

            {/* Rep leaderboard toggle */}
            {repLeaderboard.length > 0 && (
              <>
                <button
                  className="text-[11px] font-semibold text-primary hover:underline flex items-center gap-1 mb-2"
                  onClick={() => setShowRepBoard(b => !b)}
                  data-testid="button-toggle-rep-leaderboard"
                >
                  {showRepBoard ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Rep Rate Positioning ({repLeaderboard.length})
                </button>
                {showRepBoard && (
                  <div className="space-y-1" data-testid="portlet-rep-rate-leaderboard">
                    {repLeaderboard.slice(0, 8).map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-border/40 last:border-0">
                        <span className="font-medium text-foreground truncate max-w-[110px]" title={r.repName}>{r.repName}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`font-bold text-[11px] ${r.avgDeltaPct > 5 ? "text-red-600" : r.avgDeltaPct < -5 ? "text-green-600" : "text-foreground"}`}>
                            {r.avgDeltaPct > 0 ? "+" : ""}{r.avgDeltaPct.toFixed(1)}%
                          </span>
                          {r.aboveCount > 0 && <span className="text-[9px] bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-1 rounded">{r.aboveCount}↑</span>}
                          {r.belowCount > 0 && <span className="text-[9px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-1 rounded">{r.belowCount}↓</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Link-through to full Intel Rate Positioning panel */}
            <div className="mt-3 pt-2 border-t border-border/40">
              <Link
                href="/intel"
                className="flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                data-testid="link-view-full-rate-intel"
              >
                <ExternalLink className="h-3 w-3" />
                View Full Rate Intelligence Panel
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface DirectorPortletsProps {
  isAdmin: boolean;
  allUsers: SafeUser[];
  selectedDirectorId: string | null;
  setSelectedDirectorId: (id: string | null) => void;
  teamActivity: TeamActivity | undefined;
  teamActivityLoading: boolean;
  relationshipsMoved: RelationshipsMovedData | undefined;
  relationshipsMovedLoading: boolean;
  trendingAccounts: TrendingResponse | undefined;
  trendingLoading: boolean;
  trendingUpCollapsed: boolean;
  setTrendingUpCollapsed: (v: boolean) => void;
  trendingDownCollapsed: boolean;
  setTrendingDownCollapsed: (v: boolean) => void;
  marginMetrics: MarginMetrics | undefined;
  marginMetricsLoading: boolean;
  namMarginCollapsed: boolean;
  setNamMarginCollapsed: (v: boolean) => void;
  amMarginCollapsed: boolean;
  setAmMarginCollapsed: (v: boolean) => void;
  onSaveMarginGoal: (userId: string, goalId: string | null, target: number) => void;
  recentWins: OpportunityLog[];
  teamMembers: SafeUser[];
  recentWinsCollapsed: boolean;
  setRecentWinsCollapsed: (v: boolean) => void;
  isVisible: (key: string) => boolean;
  getOrder: (key: string) => number;
  setActivePortlet: (v: { type: PortletType; personal: boolean; title: string }) => void;
  togglePortlet: (key: string, val: boolean, setter: (v: boolean) => void) => void;
  setLocation: (path: string) => void;
  teamOverdueCollapsed: boolean;
  setTeamOverdueCollapsed: (v: boolean) => void;
  // Task #374
  nbaRollupCollapsed: boolean;
  onToggleNbaRollup: () => void;
}

export function DirectorPortlets({
  isAdmin, allUsers, selectedDirectorId, setSelectedDirectorId,
  teamActivity, teamActivityLoading,
  relationshipsMoved, relationshipsMovedLoading,
  trendingAccounts, trendingLoading,
  trendingUpCollapsed, setTrendingUpCollapsed,
  trendingDownCollapsed, setTrendingDownCollapsed,
  marginMetrics, marginMetricsLoading,
  namMarginCollapsed, setNamMarginCollapsed,
  amMarginCollapsed, setAmMarginCollapsed,
  onSaveMarginGoal,
  recentWins, teamMembers,
  recentWinsCollapsed, setRecentWinsCollapsed,
  isVisible, getOrder, setActivePortlet, togglePortlet, setLocation,
  teamOverdueCollapsed, setTeamOverdueCollapsed,
  nbaRollupCollapsed, onToggleNbaRollup,
}: DirectorPortletsProps) {
  return (
    <>
      {/* ── Market Pulse ────────────────────────────────────────────────────── */}
      <SonarMarketPulsePortlet role="director" />

      {/* ── Team NBA rollup (Task #374) — director inherits NAM portlet ─────── */}
      <NbaTeamRollupPortlet
        collapsed={nbaRollupCollapsed}
        onToggle={onToggleNbaRollup}
        setLocation={setLocation}
      />

      {/* ── NBA rule performance (Task #374) — engine learning visibility ───── */}
      <DirectorRulePerformanceWrapper />

      {/* ── Team Overdue Conversations (Task #223) ────────────────────────────── */}
      <TeamOverdueConversationsPortlet
        collapsed={teamOverdueCollapsed}
        onToggle={() => setTeamOverdueCollapsed(!teamOverdueCollapsed)}
        setLocation={setLocation}
      />

      {/* ── Rate Exposure Summary ──────────────────────────────────────────── */}
      <RateExposurePortlet />

      {/* Director filter toggle — admin only */}
      {isAdmin && (() => {
        const directors = allUsers.filter(u => u.role === "director");
        if (directors.length === 0) return null;
        return (
          <div className="flex items-center gap-2" data-testid="director-filter-toggle">
            <span className="text-sm text-muted-foreground font-medium">View:</span>
            <div className="inline-flex rounded-lg border border-border bg-muted p-1 gap-1">
              <button
                onClick={() => setSelectedDirectorId(null)}
                className={`px-3 py-1 text-sm rounded-md font-medium transition-colors ${selectedDirectorId === null ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                data-testid="director-filter-both"
              >
                All
              </button>
              {directors.map(d => (
                <button
                  key={d.id}
                  onClick={() => setSelectedDirectorId(d.id)}
                  className={`px-3 py-1 text-sm rounded-md font-medium transition-colors ${selectedDirectorId === d.id ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  data-testid={`director-filter-${d.id}`}
                >
                  {d.name.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Row 1: Small activity count portlets */}
      <div style={{ order: getOrder("dir-activity") }} className={!isVisible("dir-activity") ? "hidden" : ""}>
      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4" data-testid="director-activity-row" data-tour="tour-kpi-tiles">

        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="portlet-relationships-moved" onClick={() => setActivePortlet({ type: "relationships", personal: false, title: "Relationships Moved Up This Month" })}>
          <CardContent className="p-4">
            {relationshipsMovedLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                    <Repeat2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="stat-relationships-moved">{relationshipsMoved?.count ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Relationships moved up this month</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="portlet-meaningful-conversations" onClick={() => setActivePortlet({ type: "meaningful", personal: false, title: "Meaningful Conversations Today" })}>
          <CardContent className="p-4">
            {teamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  </div>
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="stat-meaningful-conversations">{teamActivity?.meaningful ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Meaningful conversations today</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="portlet-new-contacts" onClick={() => setActivePortlet({ type: "contacts", personal: false, title: "New Contacts Added Today" })}>
          <CardContent className="p-4">
            {teamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="stat-new-contacts">{teamActivity?.newContacts ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">New contacts added today</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="portlet-touches-today" onClick={() => setActivePortlet({ type: "touches", personal: false, title: "Touches Today" })}>
          <CardContent className="p-4">
            {teamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                    <Activity className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="stat-touches-today">{teamActivity?.touches ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Touches today (all types)</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      </div>{/* end dir-activity */}

      {/* Row 2: Trending accounts up & down */}
      <div style={{ order: getOrder("dir-trending") }} className={!isVisible("dir-trending") ? "hidden" : ""}>
      <div className="grid gap-4 md:grid-cols-2" data-testid="director-trending-row">

        <Card data-testid="portlet-trending-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setTrendingUpCollapsed(!trendingUpCollapsed)}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                data-testid="button-toggle-trending-up"
              >
                {trendingUpCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                  Trending Accounts Up
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {trendingAccounts?.isPartialMonth ? `ahead of pace · ${Math.round((trendingAccounts.monthFraction ?? 1) * 100)}% through ${trendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
          </CardHeader>
          {!trendingUpCollapsed && (
            <CardContent className="pt-0">
              {trendingLoading ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : (trendingAccounts?.up?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              ) : (
                <>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {trendingAccounts!.up.map((acct, idx) => (
                      <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`trending-up-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                        <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                        <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                        {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                        <span className="flex items-center gap-0.5 text-sm font-semibold text-green-600 dark:text-green-400 shrink-0">
                          <ArrowUpRight className="h-3.5 w-3.5" />
                          ${Math.round(acct.delta).toLocaleString()} ahead
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between pt-2 mt-2 border-t">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{trendingAccounts!.up.length} accounts</span>
                    <span className="text-sm font-bold text-green-600 dark:text-green-400">+${Math.round(trendingAccounts!.up.reduce((s, a) => s + a.delta, 0)).toLocaleString()} total</span>
                  </div>
                </>
              )}
            </CardContent>
          )}
        </Card>

        <Card data-testid="portlet-trending-down">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setTrendingDownCollapsed(!trendingDownCollapsed)}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                data-testid="button-toggle-trending-down"
              >
                {trendingDownCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500 dark:text-red-400" />
                  Trending Accounts Down
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {trendingAccounts?.isPartialMonth ? `behind pace · ${Math.round((trendingAccounts.monthFraction ?? 1) * 100)}% through ${trendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
          </CardHeader>
          {!trendingDownCollapsed && (
            <CardContent className="pt-0">
              {trendingLoading ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              ) : (trendingAccounts?.down?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              ) : (
                <>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {trendingAccounts!.down.map((acct, idx) => (
                      <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`trending-down-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                        <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                        <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                        {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                        <span className="flex items-center gap-0.5 text-sm font-semibold text-red-600 dark:text-red-400 shrink-0">
                          <ArrowDownRight className="h-3.5 w-3.5" />
                          ${Math.round(Math.abs(acct.delta)).toLocaleString()} behind
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between pt-2 mt-2 border-t">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{trendingAccounts!.down.length} accounts</span>
                    <span className="text-sm font-bold text-red-600 dark:text-red-400">-${Math.round(Math.abs(trendingAccounts!.down.reduce((s, a) => s + a.delta, 0))).toLocaleString()} total</span>
                  </div>
                </>
              )}
            </CardContent>
          )}
        </Card>
      </div>
      </div>{/* end dir-trending */}

      {/* Row 3: NAM & AM Margin Metrics */}
      <div style={{ order: getOrder("dir-margin") }} className={!isVisible("dir-margin") ? "hidden" : ""}>
      <div className="grid gap-4 md:grid-cols-2" data-testid="director-margin-row">
        {(["nams", "ams"] as const).map(group => {
          const label = group === "nams" ? "NAM Margin Metrics" : "AM Margin Metrics";
          const members: MarginUserMetric[] = (marginMetrics?.[group] ?? []) as MarginUserMetric[];
          const iconColor = group === "nams" ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400";
          const Icon = group === "nams" ? ShieldCheck : UserCircle;
          const monthLabel = new Date().toLocaleString("default", { month: "long", year: "numeric" });
          const collapsed = group === "nams" ? namMarginCollapsed : amMarginCollapsed;
          const setCollapsed = group === "nams" ? setNamMarginCollapsed : setAmMarginCollapsed;

          return (
            <Card key={group} data-testid={`portlet-margin-${group}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                    data-testid={`button-toggle-margin-${group}`}
                  >
                    {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    <CardTitle className="text-base flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${iconColor}`} />
                      {label}
                    </CardTitle>
                  </button>
                  <span className="text-xs font-normal text-muted-foreground">{monthLabel}</span>
                </div>
              </CardHeader>
              {!collapsed && (
              <CardContent className="pt-0">
                {marginMetricsLoading ? (
                  <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
                ) : members.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3">No {group === "nams" ? "NAMs" : "AMs"} found.</p>
                ) : (
                  <div className="space-y-3">
                    {members.map(m => {
                      const target = m.goal?.target ?? 0;
                      const pct = target > 0 ? Math.min(Math.round((m.margin / target) * 100), 100) : 0;
                      return (
                        <div key={m.userId} className="space-y-1" data-testid={`margin-metric-${m.userId}`}>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium flex-1 truncate">{m.name}</span>
                            <span className="text-sm font-bold tabular-nums text-green-700 dark:text-green-400">
                              ${Math.round(m.margin).toLocaleString()}
                            </span>
                            {target > 0 && (
                              <span className="text-xs text-muted-foreground">/ ${Math.round(target).toLocaleString()}</span>
                            )}
                            <MarginGoalEditButton
                              userId={m.userId}
                              goalId={m.goal?.id ?? null}
                              currentTarget={target}
                              onSave={(t) => onSaveMarginGoal(m.userId, m.goal?.id ?? null, t)}
                            />
                          </div>
                          {target > 0 && (
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : pct >= 50 ? "bg-blue-500" : "bg-amber-500"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
              )}
            </Card>
          );
        })}
      </div>
      </div>{/* end dir-margin */}

      {/* Recent Wins (Director view - MTD) */}
      <div style={{ order: getOrder("dir-recent-wins") }} className={!isVisible("dir-recent-wins") ? "hidden" : ""}>
      {recentWins.length > 0 && (
        <Card data-testid="portlet-director-recent-wins">
          <CardHeader className="pb-3">
            <button onClick={() => togglePortlet("dash_recent_wins_collapsed", !recentWinsCollapsed, setRecentWinsCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-recent-wins">
              {recentWinsCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="text-base flex items-center gap-2">
                <Trophy className="h-4 w-4 text-amber-500" />
                Recent Wins — {new Date().toLocaleString("default", { month: "long" })}
                <Badge className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-semibold text-xs">{recentWins.length}</Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!recentWinsCollapsed && <CardContent className="pt-0">
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {recentWins.slice(0, 15).map(win => {
                const rep = teamMembers.find(m => m.id === win.repId);
                return (
                  <div key={win.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40" data-testid={`director-win-${win.id}`}>
                    <Trophy className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{win.title}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {rep && <span className="text-xs text-muted-foreground">{rep.name}</span>}
                        {win.estimatedLoads != null && <span className="text-xs text-muted-foreground">· {win.estimatedLoads} loads</span>}
                        {win.estimatedValue && <span className="text-xs text-green-700 dark:text-green-400 font-medium">· ${Number(win.estimatedValue).toLocaleString()}</span>}
                        <span className="text-xs text-muted-foreground ml-auto">{new Date(win.loggedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>}
        </Card>
      )}
      </div>{/* end dir-recent-wins */}
    </>
  );
}
