import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronRight, ChevronDown, TrendingUp, TrendingDown,
  Repeat2, MessageSquare, UserPlus, Activity, Trophy,
  UserCircle, ArrowUpRight, ArrowDownRight, AlertTriangle, Clock,
} from "lucide-react";
import { MarginGoalEditButton } from "./MarginGoalEditButton";
import { AsOfLabel } from "@/components/dashboard/AsOfLabel";
import type { SafeUser, TeamActivity, RelationshipsMovedData, TrendingResponse, MarginMetrics, OpportunityLog, AmRow, StaleAccount, PersonalMetrics } from "./types";
import type { PortletType } from "@/components/dashboard-activity-sheet";
import { SonarMarketPulsePortlet } from "@/components/sonar-market-pulse";
import { WaitingOnMePortlet } from "@/components/waiting-on-me-portlet";
import { TeamOverdueConversationsPortlet } from "@/components/team-overdue-conversations-portlet";
import { NbaTeamRollupPortlet } from "@/components/NbaTeamRollupPortlet";

interface NamPortletsProps {
  namRelationshipsMoved: RelationshipsMovedData | undefined;
  namRelationshipsMovedLoading: boolean;
  namTeamActivity: TeamActivity | undefined;
  namTeamActivityLoading: boolean;
  setActivePortlet: (v: { type: PortletType; personal: boolean; title: string }) => void;
  namTrendingUpCollapsed: boolean;
  setNamTrendingUpCollapsed: (v: boolean) => void;
  namTrendingDownCollapsed: boolean;
  setNamTrendingDownCollapsed: (v: boolean) => void;
  namTrendingAccounts: TrendingResponse | undefined;
  namTrendingLoading: boolean;
  setLocation: (path: string) => void;
  amMarginCollapsed: boolean;
  setAmMarginCollapsed: (v: boolean) => void;
  namMarginMetrics: MarginMetrics | undefined;
  namMarginMetricsLoading: boolean;
  onSaveMarginGoal: (userId: string, goalId: string | null, target: number) => void;
  recentWins: OpportunityLog[];
  teamMembers: SafeUser[];
  amComparison: AmRow[];
  amComparisonLoading: boolean;
  staleAccounts: StaleAccount[];
  personalMetrics: PersonalMetrics | undefined;
  personalMetricsLoading: boolean;
  myGoals: any[];
  todayStr: string;
  waitingOnMeCollapsed: boolean;
  setWaitingOnMeCollapsed: (v: boolean) => void;
  teamOverdueCollapsed: boolean;
  setTeamOverdueCollapsed: (v: boolean) => void;
  // Task #374
  nbaRollupCollapsed: boolean;
  onToggleNbaRollup: () => void;
}

export function NamPortlets({
  namRelationshipsMoved, namRelationshipsMovedLoading,
  namTeamActivity, namTeamActivityLoading,
  setActivePortlet,
  namTrendingUpCollapsed, setNamTrendingUpCollapsed,
  namTrendingDownCollapsed, setNamTrendingDownCollapsed,
  namTrendingAccounts, namTrendingLoading,
  setLocation,
  amMarginCollapsed, setAmMarginCollapsed,
  namMarginMetrics, namMarginMetricsLoading,
  onSaveMarginGoal,
  recentWins, teamMembers,
  amComparison, amComparisonLoading,
  staleAccounts,
  personalMetrics, personalMetricsLoading,
  myGoals, todayStr,
  waitingOnMeCollapsed, setWaitingOnMeCollapsed,
  teamOverdueCollapsed, setTeamOverdueCollapsed,
  nbaRollupCollapsed, onToggleNbaRollup,
}: NamPortletsProps) {
  return (
    <>
      {/* ── Market Pulse ────────────────────────────────────────────────────── */}
      <SonarMarketPulsePortlet role="nam" />

      {/* ── Team NBA rollup (Task #374) ───────────────────────────────────────── */}
      <NbaTeamRollupPortlet
        collapsed={nbaRollupCollapsed}
        onToggle={onToggleNbaRollup}
        setLocation={setLocation}
      />

      {/* ── Waiting on Me (Task #223) ────────────────────────────────────────── */}
      <WaitingOnMePortlet
        collapsed={waitingOnMeCollapsed}
        onToggle={() => setWaitingOnMeCollapsed(!waitingOnMeCollapsed)}
        setLocation={setLocation}
      />

      {/* ── Team Overdue Conversations (Task #223) ────────────────────────────── */}
      <TeamOverdueConversationsPortlet
        collapsed={teamOverdueCollapsed}
        onToggle={() => setTeamOverdueCollapsed(!teamOverdueCollapsed)}
        setLocation={setLocation}
      />

      {/* Row 1: Team activity metrics */}
      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4" data-testid="nam-activity-row" data-tour="tour-kpi-tiles">
        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-portlet-relationships-moved" onClick={() => setActivePortlet({ type: "relationships", personal: false, title: "Team Relationships Moved Up This Month" })}>
          <CardContent className="p-4">
            {namRelationshipsMovedLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                  <Repeat2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="nam-stat-relationships-moved">{namRelationshipsMoved?.count ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Team relationships moved up this month</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-portlet-meaningful" onClick={() => setActivePortlet({ type: "meaningful", personal: false, title: "Team Meaningful Conversations Today" })}>
          <CardContent className="p-4">
            {namTeamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                  <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="nam-stat-meaningful">{namTeamActivity?.meaningful ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Team meaningful conversations today</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-portlet-contacts" onClick={() => setActivePortlet({ type: "contacts", personal: false, title: "Team New Contacts Added Today" })}>
          <CardContent className="p-4">
            {namTeamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                  <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="nam-stat-contacts">{namTeamActivity?.newContacts ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Team new contacts added today</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-portlet-touches" onClick={() => setActivePortlet({ type: "touches", personal: false, title: "Team Touches Today" })}>
          <CardContent className="p-4">
            {namTeamActivityLoading ? <Skeleton className="h-16 w-full" /> : (
              <div className="flex flex-col gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                  <Activity className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="nam-stat-touches">{namTeamActivity?.touches ?? 0}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">Team touches today (all types)</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Trending accounts */}
      <div className="grid gap-4 md:grid-cols-2" data-testid="nam-trending-row">
        <Card data-testid="nam-portlet-trending-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button onClick={() => setNamTrendingUpCollapsed(!namTrendingUpCollapsed)} className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="button-toggle-nam-trending-up">
                {namTrendingUpCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                  Trending Accounts Up
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {namTrendingAccounts?.isPartialMonth ? `ahead of pace · ${Math.round((namTrendingAccounts.monthFraction ?? 1) * 100)}% through ${namTrendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
            <div className="mt-1">
              <AsOfLabel asOfLabel={namTrendingAccounts?.asOfLabel} freshness={namTrendingAccounts?.freshness} testId="nam-trending-up-as-of-label" />
            </div>
          </CardHeader>
          {!namTrendingUpCollapsed && (
            <CardContent className="pt-0">
              {namTrendingLoading ? <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              : (namTrendingAccounts?.up?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              : <>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">{namTrendingAccounts!.up.map((acct, idx) => (
                  <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`nam-trending-up-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                    <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                    {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                    <span className="flex items-center gap-0.5 text-sm font-semibold text-green-600 dark:text-green-400 shrink-0">
                      <ArrowUpRight className="h-3.5 w-3.5" />${Math.round(acct.delta).toLocaleString()} ahead
                    </span>
                  </div>
                ))}</div>
                <div className="flex items-center justify-between pt-2 mt-2 border-t">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{namTrendingAccounts!.up.length} accounts</span>
                  <span className="text-sm font-bold text-green-600 dark:text-green-400">+${Math.round(namTrendingAccounts!.up.reduce((s, a) => s + a.delta, 0)).toLocaleString()} total</span>
                </div>
              </>}
            </CardContent>
          )}
        </Card>
        <Card data-testid="nam-portlet-trending-down">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button onClick={() => setNamTrendingDownCollapsed(!namTrendingDownCollapsed)} className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="button-toggle-nam-trending-down">
                {namTrendingDownCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500 dark:text-red-400" />
                  Trending Accounts Down
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {namTrendingAccounts?.isPartialMonth ? `behind pace · ${Math.round((namTrendingAccounts.monthFraction ?? 1) * 100)}% through ${namTrendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
            <div className="mt-1">
              <AsOfLabel asOfLabel={namTrendingAccounts?.asOfLabel} freshness={namTrendingAccounts?.freshness} testId="nam-trending-down-as-of-label" />
            </div>
          </CardHeader>
          {!namTrendingDownCollapsed && (
            <CardContent className="pt-0">
              {namTrendingLoading ? <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              : (namTrendingAccounts?.down?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              : <>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">{namTrendingAccounts!.down.map((acct, idx) => (
                  <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`nam-trending-down-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                    <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                    {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                    <span className="flex items-center gap-0.5 text-sm font-semibold text-red-600 dark:text-red-400 shrink-0">
                      <ArrowDownRight className="h-3.5 w-3.5" />${Math.round(Math.abs(acct.delta)).toLocaleString()} behind
                    </span>
                  </div>
                ))}</div>
                <div className="flex items-center justify-between pt-2 mt-2 border-t">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{namTrendingAccounts!.down.length} accounts</span>
                  <span className="text-sm font-bold text-red-600 dark:text-red-400">-${Math.round(Math.abs(namTrendingAccounts!.down.reduce((s, a) => s + a.delta, 0))).toLocaleString()} total</span>
                </div>
              </>}
            </CardContent>
          )}
        </Card>
      </div>

      {/* Row 3: AM Margin Metrics (NAM's team) */}
      <Card data-testid="nam-portlet-margin-ams">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <button onClick={() => setAmMarginCollapsed(!amMarginCollapsed)} className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="button-toggle-nam-am-margin">
              {amMarginCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              <CardTitle className="text-base flex items-center gap-2">
                <UserCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                My Team — AM Margin Metrics
              </CardTitle>
            </button>
            <span className="text-xs font-normal text-muted-foreground">{new Date().toLocaleString("default", { month: "long", year: "numeric" })}</span>
          </div>
          <div className="mt-1">
            <AsOfLabel asOfLabel={namMarginMetrics?.asOfLabel} freshness={namMarginMetrics?.freshness} testId="nam-margin-ams-as-of-label" />
          </div>
        </CardHeader>
        {!amMarginCollapsed && (
          <CardContent className="pt-0">
            {namMarginMetricsLoading ? (
              <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (namMarginMetrics?.ams?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-3">No AMs found on your team.</p>
            ) : (
              <div className="space-y-3">
                {(namMarginMetrics?.ams ?? []).map(m => {
                  const target = m.goal?.target ?? 0;
                  const pct = target > 0 ? Math.min(Math.round((m.margin / target) * 100), 100) : 0;
                  return (
                    <div key={m.userId} className="space-y-1" data-testid={`nam-margin-metric-${m.userId}`}>
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

      {/* Recent Wins (MTD) */}
      {recentWins.length > 0 && (
        <Card data-testid="portlet-recent-wins">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500" />
              Recent Wins — {new Date().toLocaleString("default", { month: "long" })}
              <Badge className="ml-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-semibold text-xs">{recentWins.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {recentWins.slice(0, 15).map(win => {
                const rep = teamMembers.find(m => m.id === win.repId);
                return (
                  <div key={win.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40" data-testid={`recent-win-${win.id}`}>
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
          </CardContent>
        </Card>
      )}

      {/* AM Comparison Table */}
      <Card data-testid="card-am-comparison">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500 shrink-0" />
            <CardTitle className="text-sm font-semibold">AM Activity Snapshot</CardTitle>
            <span className="text-xs text-muted-foreground ml-2">This week vs. month · cold accounts · open tasks</span>
          </div>
        </CardHeader>
        <CardContent className="pt-0 px-4 pb-4 overflow-x-auto">
          {amComparisonLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : amComparison.length === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center py-4">No AM data available.</p>
          ) : (
            <table className="w-full text-xs min-w-[520px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left pb-2 font-medium text-muted-foreground pr-3">Rep</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground px-2">Accts</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground px-2">Wk Touches</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground px-2">Mo Touches</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground px-2">Cold</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground px-2">Tasks</th>
                  <th className="text-right pb-2 font-medium text-muted-foreground pl-2">Goal %</th>
                </tr>
              </thead>
              <tbody>
                {amComparison.map((row, idx) => {
                  const goalPct = row.goalPct ?? null;
                  const goalColor = goalPct == null ? "" : goalPct >= 90 ? "text-emerald-600 dark:text-emerald-400 font-bold" : goalPct >= 60 ? "text-amber-500 dark:text-amber-400" : "text-red-500 dark:text-red-400";
                  return (
                    <tr key={row.id} className={`border-b border-border/40 hover:bg-muted/40 transition-colors ${idx % 2 === 0 ? "" : "bg-muted/20"}`} data-testid={`am-comparison-row-${row.id}`}>
                      <td className="py-2 pr-3 font-medium text-foreground truncate max-w-[140px]">{row.name}</td>
                      <td className="py-2 px-2 text-right text-muted-foreground">{row.companyCount}</td>
                      <td className="py-2 px-2 text-right">{row.touchesWeek}</td>
                      <td className="py-2 px-2 text-right">{row.touchesMonth}</td>
                      <td className={`py-2 px-2 text-right ${row.coldAccounts > 0 ? "text-amber-600 dark:text-amber-400 font-semibold" : "text-muted-foreground"}`}>{row.coldAccounts}</td>
                      <td className={`py-2 px-2 text-right ${row.openTasks > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}>{row.openTasks}</td>
                      <td className={`py-2 pl-2 text-right ${goalColor}`}>{goalPct != null ? `${goalPct}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Stale Accounts Alert */}
      {staleAccounts.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-stale-accounts-nam">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              <CardTitle className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Accounts Needing Attention
              </CardTitle>
              <Badge variant="outline" className="ml-auto text-xs text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                {staleAccounts.length} account{staleAccounts.length !== 1 ? "s" : ""} · 21+ days no touch
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0 px-4 pb-4">
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-36 overflow-y-auto">
              {staleAccounts.slice(0, 12).map(acct => (
                <div
                  key={acct.id}
                  className="flex items-center gap-2 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/30 rounded px-1.5 py-1 -mx-0.5"
                  onDoubleClick={() => setLocation(`/companies/${acct.id}`)}
                  data-testid={`stale-account-nam-${acct.id}`}
                >
                  <Clock className="h-3 w-3 text-amber-500 shrink-0" />
                  <span className="text-xs flex-1 truncate text-amber-900 dark:text-amber-200 font-medium">{acct.name}</span>
                  <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">{acct.daysSince >= 90 ? "90+" : acct.daysSince}d</span>
                </div>
              ))}
            </div>
            {staleAccounts.length > 12 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">+{staleAccounts.length - 12} more accounts need attention</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Row 4: My Personal Metrics */}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-0.5">My Activity</h3>
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4" data-testid="nam-personal-metrics-row">
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-personal-relationships" onClick={() => setActivePortlet({ type: "relationships", personal: true, title: "My Relationships Moved Up This Month" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                    <Repeat2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="nam-personal-stat-relationships">{personalMetrics?.relationshipsMovedThisMonth ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">My relationships moved up this month</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-personal-meaningful" onClick={() => setActivePortlet({ type: "meaningful", personal: true, title: "My Meaningful Conversations Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="nam-personal-stat-meaningful">{personalMetrics?.meaningfulToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">My meaningful conversations today</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-personal-contacts" onClick={() => setActivePortlet({ type: "contacts", personal: true, title: "My New Contacts Added Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="nam-personal-stat-contacts">{personalMetrics?.contactsAddedToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">My new contacts added today</p>
                  </div>
                  {(() => {
                    const goal = myGoals.find((g: any) => g.metric === "contacts_added" && g.startDate <= todayStr && g.endDate >= todayStr && !g.companyId);
                    if (!goal) return null;
                    const target = parseFloat(goal.target || "0");
                    const current = goal.computedValue != null ? goal.computedValue : parseFloat(goal.currentValue || "0");
                    const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0;
                    return (
                      <div className="space-y-0.5 mt-0.5" data-testid="nam-contacts-goal-progress">
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>{Math.round(current)} / {Math.round(target)} this month</span>
                          <span>{pct}%</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="nam-personal-touches" onClick={() => setActivePortlet({ type: "touches", personal: true, title: "My Touches Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                    <Activity className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="nam-personal-stat-touches">{personalMetrics?.touchesToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">My touches today (all types)</p>
                  </div>
                  {(() => {
                    const goal = myGoals.find((g: any) => g.metric === "touchpoints" && g.startDate <= todayStr && g.endDate >= todayStr && !g.companyId);
                    if (!goal) return null;
                    const target = parseFloat(goal.target || "0");
                    const current = goal.computedValue != null ? goal.computedValue : parseFloat(goal.currentValue || "0");
                    const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0;
                    return (
                      <div className="space-y-0.5 mt-0.5" data-testid="nam-touches-goal-progress">
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-green-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>{Math.round(current)} / {Math.round(target)} this month</span>
                          <span>{pct}%</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
