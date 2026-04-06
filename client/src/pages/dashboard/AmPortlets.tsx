import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  ChevronRight, ChevronDown, TrendingUp, TrendingDown,
  Repeat2, MessageSquare, UserPlus, Activity, AlertTriangle, Clock, Target,
  ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import type { TrendingResponse, StaleAccount, PersonalMetrics, TodaysFiveItem } from "./types";
import type { PortletType } from "@/components/dashboard-activity-sheet";

interface AmPortletsProps {
  todaysFive: TodaysFiveItem[];
  todaysFiveLoading: boolean;
  staleAccounts: StaleAccount[];
  setLocation: (path: string) => void;
  amTrendingAccounts: TrendingResponse | undefined;
  amTrendingLoading: boolean;
  amTrendingUpCollapsed: boolean;
  setAmTrendingUpCollapsed: (v: boolean) => void;
  amTrendingDownCollapsed: boolean;
  setAmTrendingDownCollapsed: (v: boolean) => void;
  personalMetrics: PersonalMetrics | undefined;
  personalMetricsLoading: boolean;
  myGoals: any[];
  todayStr: string;
  setActivePortlet: (v: { type: PortletType; personal: boolean; title: string }) => void;
}

export function AmPortlets({
  todaysFive, todaysFiveLoading,
  staleAccounts, setLocation,
  amTrendingAccounts, amTrendingLoading,
  amTrendingUpCollapsed, setAmTrendingUpCollapsed,
  amTrendingDownCollapsed, setAmTrendingDownCollapsed,
  personalMetrics, personalMetricsLoading,
  myGoals, todayStr, setActivePortlet,
}: AmPortletsProps) {
  return (
    <>
      {/* Today's 5 */}
      <Card data-testid="card-todays-five">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-blue-500 shrink-0" />
              <CardTitle className="text-sm font-semibold">Today's 5</CardTitle>
            </div>
            <span className="text-xs text-muted-foreground">Your highest-priority accounts right now</span>
          </div>
        </CardHeader>
        <CardContent className="pt-0 px-4 pb-4">
          {todaysFiveLoading ? (
            <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : todaysFive.length === 0 ? (
            <p className="text-sm text-muted-foreground italic text-center py-4">All caught up — no priority accounts flagged.</p>
          ) : (
            <div className="space-y-1.5">
              {todaysFive.map((acct, idx) => (
                <Link key={acct.id} href={`/companies/${acct.id}`}>
                  <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60 transition-colors cursor-pointer" data-testid={`todays-five-${acct.id}`}>
                    <span className="text-xs font-bold text-muted-foreground w-4 shrink-0">{idx + 1}</span>
                    <span className="flex-1 text-sm font-medium truncate">{acct.name}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {acct.reasons.slice(0, 2).map((r, i) => (
                        <span key={i} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${r.includes("RFP") ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300" : r.includes("task") ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300" : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"}`}>
                          {r}
                        </span>
                      ))}
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stale Accounts Alert */}
      {staleAccounts.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-stale-accounts-am">
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
                  data-testid={`stale-account-am-${acct.id}`}
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

      {/* Row 1: Trending accounts */}
      <div className="grid gap-4 md:grid-cols-2" data-testid="am-trending-row">
        <Card data-testid="am-portlet-trending-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button onClick={() => setAmTrendingUpCollapsed(!amTrendingUpCollapsed)} className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="button-toggle-am-trending-up">
                {amTrendingUpCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                  My Trending Accounts Up
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {amTrendingAccounts?.isPartialMonth ? `ahead of pace · ${Math.round((amTrendingAccounts.monthFraction ?? 1) * 100)}% through ${amTrendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
          </CardHeader>
          {!amTrendingUpCollapsed && (
            <CardContent className="pt-0">
              {amTrendingLoading ? <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              : (amTrendingAccounts?.up?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              : <>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">{amTrendingAccounts!.up.map((acct, idx) => (
                  <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`am-trending-up-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                    <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                    {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                    <span className="flex items-center gap-0.5 text-sm font-semibold text-green-600 dark:text-green-400 shrink-0">
                      <ArrowUpRight className="h-3.5 w-3.5" />${Math.round(acct.delta).toLocaleString()} ahead
                    </span>
                  </div>
                ))}</div>
                <div className="flex items-center justify-between pt-2 mt-2 border-t">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{amTrendingAccounts!.up.length} accounts</span>
                  <span className="text-sm font-bold text-green-600 dark:text-green-400">+${Math.round(amTrendingAccounts!.up.reduce((s, a) => s + a.delta, 0)).toLocaleString()} total</span>
                </div>
              </>}
            </CardContent>
          )}
        </Card>
        <Card data-testid="am-portlet-trending-down">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <button onClick={() => setAmTrendingDownCollapsed(!amTrendingDownCollapsed)} className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="button-toggle-am-trending-down">
                {amTrendingDownCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500 dark:text-red-400" />
                  My Trending Accounts Down
                </CardTitle>
              </button>
              <span className="text-xs font-normal text-muted-foreground">
                {amTrendingAccounts?.isPartialMonth ? `behind pace · ${Math.round((amTrendingAccounts.monthFraction ?? 1) * 100)}% through ${amTrendingAccounts.curMonthLabel}` : "vs. 3-mo avg"}
              </span>
            </div>
          </CardHeader>
          {!amTrendingDownCollapsed && (
            <CardContent className="pt-0">
              {amTrendingLoading ? <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
              : (amTrendingAccounts?.down?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground py-3">No trending data yet — upload financial data to see trends.</p>
              : <>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">{amTrendingAccounts!.down.map((acct, idx) => (
                  <div key={acct.name} className={`flex items-center gap-2${acct.companyId ? " cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}`} data-testid={`am-trending-down-${idx}`} onDoubleClick={() => acct.companyId && setLocation(`/companies/${acct.companyId}`)}>
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0 text-center">#{idx + 1}</span>
                    <span className="text-sm flex-1 truncate font-medium">{acct.name}</span>
                    {acct.isNew && <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 rounded shrink-0">New</span>}
                    <span className="flex items-center gap-0.5 text-sm font-semibold text-red-600 dark:text-red-400 shrink-0">
                      <ArrowDownRight className="h-3.5 w-3.5" />${Math.round(Math.abs(acct.delta)).toLocaleString()} behind
                    </span>
                  </div>
                ))}</div>
                <div className="flex items-center justify-between pt-2 mt-2 border-t">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{amTrendingAccounts!.down.length} accounts</span>
                  <span className="text-sm font-bold text-red-600 dark:text-red-400">-${Math.round(Math.abs(amTrendingAccounts!.down.reduce((s, a) => s + a.delta, 0))).toLocaleString()} total</span>
                </div>
              </>}
            </CardContent>
          )}
        </Card>
      </div>

      {/* Row 2: Personal metrics */}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-0.5">My Activity</h3>
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4" data-testid="am-personal-metrics-row" data-tour="tour-kpi-tiles">
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="am-personal-relationships" onClick={() => setActivePortlet({ type: "relationships", personal: true, title: "My Relationships Moved Up This Month" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                    <Repeat2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="am-personal-stat-relationships">{personalMetrics?.relationshipsMovedThisMonth ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">Relationships moved up this month</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="am-personal-meaningful" onClick={() => setActivePortlet({ type: "meaningful", personal: true, title: "My Meaningful Conversations Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="am-personal-stat-meaningful">{personalMetrics?.meaningfulToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">Meaningful conversations today</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="am-personal-contacts" onClick={() => setActivePortlet({ type: "contacts", personal: true, title: "My New Contacts Added Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <UserPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="am-personal-stat-contacts">{personalMetrics?.contactsAddedToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">New contacts added today</p>
                  </div>
                  {(() => {
                    const goal = myGoals.find((g: any) => g.metric === "contacts_added" && g.startDate <= todayStr && g.endDate >= todayStr && !g.companyId);
                    if (!goal) return null;
                    const target = parseFloat(goal.target || "0");
                    const current = goal.computedValue != null ? goal.computedValue : parseFloat(goal.currentValue || "0");
                    const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0;
                    return (
                      <div className="space-y-0.5 mt-0.5" data-testid="am-contacts-goal-progress">
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
          <Card className="overflow-hidden cursor-pointer hover:bg-muted/40 transition-colors" data-testid="am-personal-touches" onClick={() => setActivePortlet({ type: "touches", personal: true, title: "My Touches Today" })}>
            <CardContent className="p-4">
              {personalMetricsLoading ? <Skeleton className="h-16 w-full" /> : (
                <div className="flex flex-col gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                    <Activity className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <div className="text-2xl font-bold" data-testid="am-personal-stat-touches">{personalMetrics?.touchesToday ?? 0}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">Touches today (all types)</p>
                  </div>
                  {(() => {
                    const goal = myGoals.find((g: any) => g.metric === "touchpoints" && g.startDate <= todayStr && g.endDate >= todayStr && !g.companyId);
                    if (!goal) return null;
                    const target = parseFloat(goal.target || "0");
                    const current = goal.computedValue != null ? goal.computedValue : parseFloat(goal.currentValue || "0");
                    const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0;
                    return (
                      <div className="space-y-0.5 mt-0.5" data-testid="am-touches-goal-progress">
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
