import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, TrendingDown, Minus, Phone, Mail, MessageSquare, Building2,
  Users, CheckSquare, AlertCircle, Target, ChevronRight, Zap, Trophy, Flame,
  Clock, ArrowLeft,
} from "lucide-react";

interface RepReportData {
  rep: { id: string; name: string; role: string; manager: string | null; director: string | null };
  period: { type: string; label: string; start: string; end: string };
  goals: Array<{ id: string; label: string; metric: string; period: string; current: number; target: number; pct: number }>;
  touchpoints: { total: number; call: number; email: number; text: number; site_visit: number; weeklyTrend: number[] };
  contacts: { newThisPeriod: number };
  tasks: { completed: number; open: number; overdue: number };
  topAccounts: Array<{ name: string; touches: number; lastTouch: string }>;
  accountsNeedingAttention: number;
  wins: Array<{ id: string; text: string; category: string }>;
}

function pct(current: number, target: number) {
  return Math.min(100, target > 0 ? Math.round((current / target) * 100) : 0);
}

function PctBar({ p }: { p: number }) {
  const color = p >= 80 ? "bg-green-500" : p >= 50 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
      <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

function TrendIcon({ v }: { v: number }) {
  if (v > 0) return <TrendingUp className="h-3.5 w-3.5 text-green-500" />;
  if (v < 0) return <TrendingDown className="h-3.5 w-3.5 text-red-500" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

function SparkBar({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v, i) => (
        <div
          key={i}
          className={`flex-1 rounded-sm transition-all ${i === values.length - 1 ? "bg-primary" : "bg-primary/30"}`}
          style={{ height: `${Math.round((v / max) * 100)}%`, minHeight: v > 0 ? 2 : 0 }}
        />
      ))}
    </div>
  );
}

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (iso === today) return "Today";
  if (iso === yesterday) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function winCategoryLabel(cat: string) {
  if (cat === "growth") return "🚀 Growth";
  if (cat === "celebrate") return "🎉 Win";
  if (cat === "callout") return "📣 Callout";
  return "⭐ Highlight";
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="h-64 bg-slate-800 animate-pulse" />
      <div className="max-w-5xl mx-auto px-8 py-6 space-y-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export default function RepReportPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");

  const targetId = (!userId || userId === "me") ? user?.id : userId;

  const { data, isLoading, error } = useQuery<RepReportData>({
    queryKey: ["/api/report/rep", targetId, period],
    queryFn: async () => {
      const res = await fetch(`/api/report/rep/${targetId}?period=${period}`);
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!targetId,
  });

  if (isLoading) return <LoadingSkeleton />;

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-muted-foreground">Could not load report.</p>
        <Button variant="outline" onClick={() => navigate("/team-performance")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  const { rep, period: p, goals, touchpoints: tp, contacts, tasks, topAccounts, accountsNeedingAttention, wins } = data;
  const initials = rep.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
  const roleLabel = rep.role.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

  const managerLine = [rep.manager, rep.director].filter(Boolean).join(" · ");
  const tasksDoneLabel = `${tasks.completed} of ${tasks.completed + tasks.open} tasks`;

  const canGoBack = user?.role === "admin" || user?.role === "director" ||
    user?.role === "national_account_manager" || user?.role === "sales_director";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-foreground font-sans" data-testid="page-rep-report">
      {/* ── Dark hero header ── */}
      <div
        className="relative px-6 pt-6 pb-10 md:px-8 md:pt-8"
        style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)" }}
      >
        <div className="max-w-5xl mx-auto">
          {/* Back button for managers */}
          {canGoBack && (
            <button
              onClick={() => navigate("/team-performance")}
              className="flex items-center gap-1.5 text-white/60 hover:text-white text-sm mb-4 transition-colors"
              data-testid="button-back-team"
            >
              <ArrowLeft className="h-4 w-4" />
              Team Performance
            </button>
          )}

          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
            {/* Rep info */}
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center text-white font-bold text-lg shadow-lg shrink-0">
                {initials}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white" data-testid="text-rep-name">{rep.name}</h1>
                <p className="text-slate-300 text-sm mt-0.5">
                  {roleLabel}{managerLine ? ` · ${managerLine}` : ""}
                </p>
              </div>
            </div>

            {/* Period toggle */}
            <div className="flex flex-col items-start md:items-end gap-2">
              <div className="flex items-center gap-1 bg-white/10 rounded-xl p-1">
                <button
                  onClick={() => setPeriod("weekly")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${period === "weekly" ? "bg-white text-slate-900" : "text-white/70 hover:text-white"}`}
                  data-testid="button-period-weekly"
                >
                  Weekly
                </button>
                <button
                  onClick={() => setPeriod("monthly")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${period === "monthly" ? "bg-white text-slate-900" : "text-white/70 hover:text-white"}`}
                  data-testid="button-period-monthly"
                >
                  Monthly
                </button>
              </div>
              <p className="text-white/50 text-xs px-1">{p.label}</p>
            </div>
          </div>

          {/* KPI quick-stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-8">
            {[
              { label: "Touchpoints", value: String(tp.total), sub: `this ${period === "weekly" ? "week" : "month"}`, trend: 0, icon: Zap },
              { label: "New Contacts", value: String(contacts.newThisPeriod), sub: `this ${period === "weekly" ? "week" : "month"}`, trend: 0, icon: Users },
              { label: "Tasks Done", value: tasksDoneLabel, sub: `${tasks.overdue} overdue`, trend: tasks.overdue > 0 ? -1 : 0, icon: CheckSquare },
              { label: "Need Attention", value: String(accountsNeedingAttention), sub: "14+ days quiet", trend: accountsNeedingAttention > 0 ? -1 : 0, icon: AlertCircle },
            ].map(({ label, value, sub, trend, icon: Icon }) => (
              <div key={label} className="bg-white/10 rounded-xl p-3 border border-white/10 backdrop-blur-sm" data-testid={`stat-${label.toLowerCase().replace(/\s/g, "-")}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-3.5 w-3.5 text-white/60" />
                  <span className="text-xs text-white/60">{label}</span>
                </div>
                <div className="flex items-end gap-2">
                  <span className="text-xl font-bold text-white leading-tight">{value}</span>
                  <div className="flex items-center gap-1 mb-0.5">
                    <TrendIcon v={trend} />
                  </div>
                </div>
                <p className="text-xs text-white/40 mt-0.5">{sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Page body ── */}
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6 md:px-8">

        {/* Goals Progress */}
        {goals.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Target className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Goals Progress</h2>
              {rep.manager && <span className="text-xs text-muted-foreground">Set by {rep.manager}</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {goals.map((g) => {
                const p = pct(g.current, g.target);
                const statusColor = p >= 80 ? "text-green-600 dark:text-green-400" : p >= 50 ? "text-amber-600 dark:text-amber-400" : "text-red-500";
                const vs = p >= 80 ? "On track" : p >= 50 ? "In progress" : "Needs attention";
                const vsColor = p >= 80
                  ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                  : p >= 50
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
                const isMoney = g.metric === "margin" || g.metric === "revenue";
                const fmt = (v: number) => isMoney ? `$${v.toLocaleString()}` : String(Math.round(v));
                return (
                  <div key={g.id} className="rounded-xl border bg-card p-4 space-y-3" data-testid={`goal-card-${g.id}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{g.label}</p>
                        <p className="text-xs text-muted-foreground capitalize">{g.period}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${vsColor}`}>{vs}</span>
                    </div>
                    <div className="flex items-end gap-2">
                      <span className={`text-3xl font-bold ${statusColor}`}>{fmt(g.current)}</span>
                      <span className="text-sm text-muted-foreground mb-1">/ {fmt(g.target)}</span>
                    </div>
                    <div className="space-y-1">
                      <PctBar p={p} />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{p}% complete</span>
                        <span>{fmt(g.target - g.current)} to go</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* 2-col layout */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Left col: touchpoints + accounts */}
          <div className="md:col-span-2 space-y-6">
            {/* Touchpoint breakdown */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Touchpoint Breakdown</h2>
                <span className="text-xs text-muted-foreground ml-auto">{tp.total} total</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { type: "Calls", icon: Phone, count: tp.call, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/40" },
                  { type: "Emails", icon: Mail, count: tp.email, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950/40" },
                  { type: "Texts", icon: MessageSquare, count: tp.text, color: "text-green-600 dark:text-green-400", bg: "bg-green-50 dark:bg-green-950/40" },
                  { type: "Site Visits", icon: Building2, count: tp.site_visit, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/40" },
                ].map(({ type, icon: Icon, count, color, bg }) => (
                  <div key={type} className={`rounded-xl ${bg} p-3 text-center space-y-1`} data-testid={`tp-card-${type.toLowerCase()}`}>
                    <Icon className={`h-5 w-5 mx-auto ${color}`} />
                    <p className={`text-2xl font-bold ${color}`}>{count}</p>
                    <p className="text-xs text-muted-foreground">{type}</p>
                  </div>
                ))}
              </div>

              {/* 4-week trend */}
              {tp.weeklyTrend.length > 0 && (
                <div className="mt-3 p-3 rounded-xl border bg-card space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                    <span className="font-medium text-foreground">4-Week Trend</span>
                    <span>Touchpoints per week</span>
                  </div>
                  <SparkBar values={tp.weeklyTrend} />
                </div>
              )}
            </section>

            {/* Account activity */}
            {topAccounts.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Building2 className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Account Activity</h2>
                  <span className="text-xs text-muted-foreground ml-auto">Most engaged</span>
                </div>
                <div className="rounded-xl border bg-card divide-y divide-border/50">
                  {topAccounts.map((a, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-muted/30 transition-colors" data-testid={`account-row-${i}`}>
                      <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                        {a.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {a.touches} touch{a.touches !== 1 ? "es" : ""} · Last: {formatDate(a.lastTouch)}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Right col */}
          <div className="space-y-6">
            {/* Wins */}
            {wins.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Trophy className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-semibold">Wins This Period</h2>
                </div>
                <div className="space-y-2">
                  {wins.map((w) => (
                    <div key={w.id} className="rounded-xl border bg-card p-3 space-y-1.5" data-testid={`win-card-${w.id}`}>
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{winCategoryLabel(w.category)}</span>
                      <p className="text-xs text-foreground line-clamp-3">{w.text}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Open tasks reminder */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Tasks</h2>
              </div>
              <div className="rounded-xl border bg-card divide-y divide-border/50">
                {[
                  { label: "Completed", value: tasks.completed, color: "text-green-600 dark:text-green-400" },
                  { label: "Open", value: tasks.open, color: tasks.open > 5 ? "text-amber-600" : "text-foreground" },
                  { label: "Overdue", value: tasks.overdue, color: tasks.overdue > 0 ? "text-red-600" : "text-muted-foreground" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm text-muted-foreground">{label}</span>
                    <span className={`text-sm font-semibold ${color}`}>{value}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Accounts needing attention */}
            {accountsNeedingAttention > 0 && (
              <section>
                <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800/40 px-4 py-3">
                  <Flame className="h-4 w-4 text-amber-500 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                      {accountsNeedingAttention} account{accountsNeedingAttention !== 1 ? "s" : ""} need attention
                    </p>
                    <p className="text-xs text-amber-700/70 dark:text-amber-400/70">No touchpoint in 14+ days</p>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
