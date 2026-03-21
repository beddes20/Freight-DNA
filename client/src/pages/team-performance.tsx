import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Users, Building2, CheckCircle2, AlertTriangle, Clock, TrendingUp, BarChart3,
  Phone, MessageSquare, Mail, UserPlus, UserCheck, ArrowUpRight, Package, DollarSign, Percent, FileBarChart2, Info
} from "lucide-react";

type PeriodOption = "current" | "last" | "ytd";

function getPeriodLabel(period: PeriodOption): string {
  const now = new Date();
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  if (period === "current") {
    const month = monthNames[now.getMonth()];
    const day = now.getDate();
    return `${month} 1 – ${month} ${day}, ${now.getFullYear()}`;
  } else if (period === "last") {
    const lastMonthIdx = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const lastDay = new Date(lastMonthYear, lastMonthIdx + 1, 0).getDate();
    return `${monthNames[lastMonthIdx]} 1 – ${monthNames[lastMonthIdx]} ${lastDay}, ${lastMonthYear}`;
  } else {
    const month = monthNames[now.getMonth()];
    const day = now.getDate();
    return `Jan 1 – ${month} ${day}, ${now.getFullYear()}`;
  }
}

interface RepPerf {
  userId: string;
  name: string;
  role: string;
  managerId?: string;
  financialRepId?: string | null;
  openTasks: number;
  overdueTasks: number;
  completedTasks: number;
  companyCount: number;
  newContacts: number;
  callTouchpoints: number;
  textTouchpoints: number;
  emailTouchpoints: number;
  contactsTouched: number;
  baseAdvanced: number;
}

interface AccountSummaryRow {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName: string;
}

function StatPill({ value, label, color, icon }: { value: number; label: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-muted/50 min-w-[58px]">
      {icon && <div className="mb-0.5">{icon}</div>}
      <span className={`text-base font-bold leading-none ${color}`}>{value}</span>
      <span className="text-[10px] text-muted-foreground leading-tight text-center mt-0.5">{label}</span>
    </div>
  );
}

function RepCard({ rep, totalLoads, totalMargin, totalRevenue }: { rep: RepPerf; totalLoads?: number; totalMargin?: number; totalRevenue?: number }) {
  const [, navigate] = useLocation();
  const initials = rep.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-amber-500", "bg-red-500", "bg-cyan-500", "bg-pink-500", "bg-indigo-500"];
  const color = colors[rep.name.charCodeAt(0) % colors.length];
  const totalTasks = rep.openTasks + rep.completedTasks;
  const completionPct = totalTasks > 0 ? Math.round((rep.completedTasks / totalTasks) * 100) : 0;
  const marginDisplay = totalMargin != null && totalMargin >= 1000
    ? `$${(totalMargin / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`
    : totalMargin != null ? `$${totalMargin.toLocaleString()}` : null;
  const marginPct = totalRevenue != null && totalRevenue > 0 && totalMargin != null
    ? (totalMargin / totalRevenue) * 100
    : null;
  const hasFinancials = totalLoads != null || marginDisplay != null;

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      data-testid={`card-rep-${rep.userId}`}
      onClick={() => navigate(`/reps/${rep.userId}`)}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3 mb-4">
          <div className={`h-10 w-10 rounded-full shrink-0 flex items-center justify-center text-white text-sm font-semibold ${color}`}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate" data-testid={`text-rep-name-${rep.userId}`}>{rep.name}</p>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 mt-0.5 capitalize">
              {rep.role.replace(/_/g, " ")}
            </Badge>
          </div>
          {rep.overdueTasks > 0 && (
            <div className="shrink-0 flex items-center gap-1 text-red-600 text-xs font-medium" data-testid={`badge-overdue-${rep.userId}`}>
              <AlertTriangle className="h-3.5 w-3.5" />
              {rep.overdueTasks} overdue
            </div>
          )}
        </div>

        {hasFinancials && (
          <div className={`grid gap-1.5 mb-2 ${marginPct !== null ? "grid-cols-3" : "grid-cols-2"}`}>
            {totalLoads != null && (
              <div className="flex items-center gap-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-2 py-1.5">
                <Package className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-blue-600 dark:text-blue-400 leading-none">{totalLoads.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">Loads</p>
                </div>
              </div>
            )}
            {marginDisplay && (
              <div className="flex items-center gap-1.5 rounded-lg bg-green-50 dark:bg-green-900/20 px-2 py-1.5">
                <DollarSign className="h-3.5 w-3.5 text-green-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-green-600 dark:text-green-400 leading-none">{marginDisplay}</p>
                  <p className="text-[10px] text-muted-foreground">Margin</p>
                </div>
              </div>
            )}
            {marginPct !== null && (
              <div className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${marginPct < 0 ? "bg-red-50 dark:bg-red-900/20" : "bg-emerald-50 dark:bg-emerald-900/20"}`}>
                <Percent className={`h-3.5 w-3.5 shrink-0 ${marginPct < 0 ? "text-red-500" : "text-emerald-500"}`} />
                <div className="min-w-0">
                  <p className={`text-sm font-bold leading-none ${marginPct < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>{marginPct.toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">Margin %</p>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-4 gap-1.5 mb-2">
          <StatPill value={rep.openTasks} label="Open" color={rep.openTasks > 5 ? "text-amber-600" : "text-foreground"} />
          <StatPill value={rep.overdueTasks} label="Overdue" color={rep.overdueTasks > 0 ? "text-red-600" : "text-foreground"} />
          <StatPill value={rep.companyCount} label="Accounts" color="text-blue-600" />
          <StatPill value={rep.newContacts} label="New Contacts" color="text-emerald-600" icon={<UserPlus className="h-3 w-3 text-emerald-500" />} />
        </div>

        <div className="grid grid-cols-5 gap-1.5 mb-4">
          <StatPill value={rep.callTouchpoints} label="Calls" color="text-blue-600" icon={<Phone className="h-3 w-3 text-blue-500" />} />
          <StatPill value={rep.textTouchpoints} label="Texts" color="text-green-600" icon={<MessageSquare className="h-3 w-3 text-green-500" />} />
          <StatPill value={rep.emailTouchpoints} label="Emails" color="text-purple-600" icon={<Mail className="h-3 w-3 text-purple-500" />} />
          <StatPill value={rep.contactsTouched} label="Touched" color="text-cyan-600" icon={<UserCheck className="h-3 w-3 text-cyan-500" />} />
          <StatPill value={rep.baseAdvanced} label="Rel. Moved" color="text-teal-600" icon={<ArrowUpRight className="h-3 w-3 text-teal-500" />} />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Task completion</span>
            <span className="font-medium text-foreground">{completionPct}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${completionPct >= 80 ? "bg-green-500" : completionPct >= 50 ? "bg-amber-500" : "bg-red-500"}`}
              style={{ width: `${completionPct}%` }}
            />
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="w-full mt-3 text-xs h-7"
          data-testid={`button-view-report-${rep.userId}`}
          onClick={(e) => { e.stopPropagation(); navigate(`/report/${rep.userId}`); }}
        >
          <FileBarChart2 className="h-3 w-3 mr-1.5" />
          View Progress Report
        </Button>
      </CardContent>
    </Card>
  );
}

function matchRepName(repName: string, userName: string): boolean {
  const a = repName.toLowerCase().trim();
  const b = userName.toLowerCase().trim();
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  // First-name-only match: if repName is a single word, check if it matches any part of the user's name
  if (aParts.length === 1 && aParts[0].length > 1) {
    return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
  }
  return aParts.some(p => p.length > 1 && bParts.includes(p));
}

export default function TeamPerformancePage() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<PeriodOption>("current");

  const { data: reps = [], isLoading } = useQuery<RepPerf[]>({
    queryKey: ["/api/team/performance", period],
    queryFn: async () => {
      const res = await fetch(`/api/team/performance?period=${period}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch team performance: ${res.status}`);
      return res.json();
    },
  });

  const { data: accountSummary = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/account-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/account-summary?period=${period}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch account summary");
      return res.json();
    },
  });

  if (!user || user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Access denied</p>
      </div>
    );
  }

  const repLoadsMap: Record<string, { loads: number; margin: number; revenue: number }> = {};
  for (const row of accountSummary) {
    if (!row.repName) continue;
    const repNameLower = row.repName.toLowerCase().trim();
    // Try financialRepId match first (most reliable for ReplistNumbers format), then fall back to name match
    const match = reps.find(r =>
      (r.financialRepId && r.financialRepId.toLowerCase() === repNameLower) ||
      matchRepName(row.repName, r.name)
    );
    if (match) {
      if (!repLoadsMap[match.userId]) repLoadsMap[match.userId] = { loads: 0, margin: 0, revenue: 0 };
      repLoadsMap[match.userId].loads += row.totalLoads;
      repLoadsMap[match.userId].margin += row.totalMargin;
      repLoadsMap[match.userId].revenue += row.totalRevenue ?? 0;
    }
  }

  const hasSummaryData = accountSummary.length > 0;
  const totalLoadsAll = Object.values(repLoadsMap).reduce((s, v) => s + v.loads, 0);
  const totalMarginAll = Object.values(repLoadsMap).reduce((s, v) => s + v.margin, 0);
  const totalRevenueAll = Object.values(repLoadsMap).reduce((s, v) => s + v.revenue, 0);
  const totalMarginPctAll = totalRevenueAll > 0 ? (totalMarginAll / totalRevenueAll) * 100 : null;

  const ams = reps.filter(r => r.role === "account_manager" || r.role === "logistics_manager" || r.role === "logistics_coordinator");
  const nams = reps.filter(r => r.role === "national_account_manager" || r.role === "director" || r.role === "sales_director");

  const totalOpenTasks = reps.reduce((sum, r) => sum + r.openTasks, 0);
  const totalOverdue = reps.reduce((sum, r) => sum + r.overdueTasks, 0);
  const totalAccounts = reps.reduce((sum, r) => sum + r.companyCount, 0);
  const totalNewContacts = reps.reduce((sum, r) => sum + r.newContacts, 0);
  const totalCalls = reps.reduce((sum, r) => sum + r.callTouchpoints, 0);
  const totalTexts = reps.reduce((sum, r) => sum + r.textTouchpoints, 0);
  const totalEmails = reps.reduce((sum, r) => sum + r.emailTouchpoints, 0);
  const totalTouched = reps.reduce((sum, r) => sum + r.contactsTouched, 0);
  const totalBaseAdvanced = reps.reduce((sum, r) => sum + r.baseAdvanced, 0);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Team Performance</h1>
            <p className="text-sm text-muted-foreground">KPIs across your team — tasks, accounts, and activity</p>
          </div>
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1.5">
          <div className="flex items-center rounded-lg border bg-muted/40 p-0.5 gap-0.5" data-testid="toggle-period">
            {(["current", "last", "ytd"] as PeriodOption[]).map((opt) => (
              <button
                key={opt}
                data-testid={`button-period-${opt}`}
                onClick={() => setPeriod(opt)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  period === opt
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt === "current" ? "This Month" : opt === "last" ? "Last Month" : "YTD"}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="text-period-label">
            {getPeriodLabel(period)}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Open Tasks", value: totalOpenTasks, icon: <Clock className="h-4 w-4 text-amber-500" />, color: "text-amber-600" },
                { label: "Overdue", value: totalOverdue, icon: <AlertTriangle className="h-4 w-4 text-red-500" />, color: "text-red-600" },
                { label: "Total Accounts", value: totalAccounts, icon: <Building2 className="h-4 w-4 text-blue-500" />, color: "text-blue-600" },
                { label: "New Contacts", value: totalNewContacts, icon: <UserPlus className="h-4 w-4 text-emerald-500" />, color: "text-emerald-600" },
              ].map(stat => (
                <Card key={stat.label}>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      {stat.icon}
                      <span className="text-xs text-muted-foreground">{stat.label}</span>
                    </div>
                    <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Calls", value: totalCalls, icon: <Phone className="h-4 w-4 text-blue-500" />, color: "text-blue-600" },
                { label: "Texts", value: totalTexts, icon: <MessageSquare className="h-4 w-4 text-green-500" />, color: "text-green-600" },
                { label: "Emails", value: totalEmails, icon: <Mail className="h-4 w-4 text-purple-500" />, color: "text-purple-600" },
                { label: "Touched", value: totalTouched, icon: <UserCheck className="h-4 w-4 text-cyan-500" />, color: "text-cyan-600" },
                { label: "Base Advanced", value: totalBaseAdvanced, icon: <ArrowUpRight className="h-4 w-4 text-teal-500" />, color: "text-teal-600" },
              ].map(stat => (
                <Card key={stat.label}>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      {stat.icon}
                      <span className="text-xs text-muted-foreground">{stat.label}</span>
                    </div>
                    <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            {hasSummaryData && (
              <>
              <div className={`grid gap-3 ${totalMarginPctAll !== null ? "grid-cols-3" : "grid-cols-2"}`}>
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Package className="h-4 w-4 text-blue-500" />
                      <span className="text-xs text-muted-foreground">Total Loads (all reps)</span>
                    </div>
                    <p className="text-2xl font-bold text-blue-600">{totalLoadsAll.toLocaleString()}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <DollarSign className="h-4 w-4 text-green-500" />
                      <span className="text-xs text-muted-foreground">Total Margin (all reps)</span>
                    </div>
                    <p className="text-2xl font-bold text-green-600">
                      {totalMarginAll >= 1000 ? `$${(totalMarginAll / 1000).toFixed(1)}K` : `$${totalMarginAll.toLocaleString()}`}
                    </p>
                  </CardContent>
                </Card>
                {totalMarginPctAll !== null && (
                  <Card>
                    <CardContent className="pt-4 pb-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Percent className="h-4 w-4 text-emerald-500" />
                        <span className="text-xs text-muted-foreground">Avg Margin % (all reps)</span>
                      </div>
                      <p className={`text-2xl font-bold ${totalMarginPctAll < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {totalMarginPctAll.toFixed(1)}%
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1" data-testid="text-financial-note">
                <Info className="h-3 w-3 shrink-0" />
                Financial data is from the latest uploaded file, filtered to the selected period.
              </p>
              </>
            )}
          </div>

          {nams.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Directors & NAMs</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {nams.map(rep => (
                  <RepCard
                    key={rep.userId}
                    rep={rep}
                    totalLoads={repLoadsMap[rep.userId]?.loads}
                    totalMargin={repLoadsMap[rep.userId]?.margin}
                    totalRevenue={repLoadsMap[rep.userId]?.revenue}
                  />
                ))}
              </div>
            </div>
          )}

          {ams.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Account Managers</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {ams.map(rep => (
                  <RepCard
                    key={rep.userId}
                    rep={rep}
                    totalLoads={repLoadsMap[rep.userId]?.loads}
                    totalMargin={repLoadsMap[rep.userId]?.margin}
                    totalRevenue={repLoadsMap[rep.userId]?.revenue}
                  />
                ))}
              </div>
            </div>
          )}

          {reps.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-base font-medium">No team members found</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
