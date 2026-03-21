import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  TrendingUp, TrendingDown, Minus, Phone, Mail, MessageSquare, Building2,
  Users, CheckSquare, AlertCircle, Target, ChevronRight, Zap, Trophy, Flame,
  Clock, ArrowLeft, Send, Loader2, ExternalLink, BookOpen, ChevronDown, ChevronUp, Save,
  Package, DollarSign,
} from "lucide-react";

interface AccountSummaryRow {
  customerName: string;
  totalLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName: string;
}

function matchRepName(repName: string, userName: string): boolean {
  const a = repName.toLowerCase().trim();
  const b = userName.toLowerCase().trim();
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  if (aParts.length === 1 && aParts[0].length > 1) {
    return bParts.some(p => p.startsWith(aParts[0]) || aParts[0].startsWith(p));
  }
  return aParts.some(p => p.length > 1 && bParts.includes(p));
}

interface TeamMemberSummary {
  id: string;
  name: string;
  role: string;
  touchpoints: number;
  newContacts: number;
  tasks: { completed: number; open: number; overdue: number };
  goalsAvgPct: number;
  hasActiveGoals: boolean;
  accountsNeedingAttention: number;
}

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
  teamMembers: TeamMemberSummary[];
}

interface ReportCardSnapshot {
  id: string;
  userId: string;
  periodType: string;
  periodLabel: string;
  snapshotDate: string;
  payload: RepReportData;
  savedById: string;
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

function formatDateTime(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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

function SnapshotCard({ snapshot }: { snapshot: ReportCardSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const p = snapshot.payload;
  const tp = p.touchpoints;

  return (
    <div className="rounded-xl border bg-card overflow-hidden" data-testid={`snapshot-card-${snapshot.id}`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid={`snapshot-toggle-${snapshot.id}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{snapshot.periodLabel}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary capitalize">{snapshot.periodType}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Saved {formatDateTime(snapshot.snapshotDate)}</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-center">
            <p className="text-sm font-bold text-foreground">{tp.total}</p>
            <p className="text-xs text-muted-foreground">Touches</p>
          </div>
          <div className="text-center">
            <p className="text-sm font-bold text-foreground">{p.contacts.newThisPeriod}</p>
            <p className="text-xs text-muted-foreground">Contacts</p>
          </div>
          <div className="text-center">
            <p className="text-sm font-bold text-foreground">{p.tasks.completed}</p>
            <p className="text-xs text-muted-foreground">Tasks</p>
          </div>
          {expanded
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />
          }
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-4 space-y-4 bg-muted/10">
          {p.goals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Goals</p>
              <div className="space-y-2">
                {p.goals.map((g) => {
                  const pc = pct(g.current, g.target);
                  const isMoney = g.metric === "margin" || g.metric === "revenue";
                  const fmt = (v: number) => isMoney ? `$${v.toLocaleString()}` : String(Math.round(v));
                  const color = pc >= 80 ? "text-green-600 dark:text-green-400" : pc >= 50 ? "text-amber-600" : "text-red-500";
                  return (
                    <div key={g.id} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-foreground truncate">{g.label}</span>
                          <span className={`text-xs font-semibold ${color}`}>{fmt(g.current)} / {fmt(g.target)}</span>
                        </div>
                        <PctBar p={pc} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Touchpoints</p>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Calls", count: tp.call },
                { label: "Emails", count: tp.email },
                { label: "Texts", count: tp.text },
                { label: "Visits", count: tp.site_visit },
              ].map(({ label, count }) => (
                <div key={label} className="text-center bg-background rounded-lg p-2 border border-border/50">
                  <p className="text-sm font-bold text-foreground">{count}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {p.tasks && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Tasks</p>
              <div className="flex items-center gap-4 text-sm">
                <span className="text-green-600 dark:text-green-400">{p.tasks.completed} done</span>
                <span className="text-muted-foreground">{p.tasks.open} open</span>
                {p.tasks.overdue > 0 && <span className="text-red-500">{p.tasks.overdue} overdue</span>}
              </div>
            </div>
          )}

          {p.topAccounts.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Top Accounts</p>
              <div className="space-y-1">
                {p.topAccounts.slice(0, 5).map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-4 h-4 rounded bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0 text-[10px]">{a.name[0]}</span>
                    <span className="flex-1 truncate text-foreground">{a.name}</span>
                    <span className="text-muted-foreground">{a.touches} touches</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {p.wins.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Wins</p>
              <div className="space-y-1">
                {p.wins.map((w) => (
                  <div key={w.id} className="text-xs text-foreground bg-background rounded-lg px-3 py-2 border border-border/50">
                    <span className="text-amber-600 dark:text-amber-400 font-medium">{winCategoryLabel(w.category)} </span>
                    {w.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RepReportPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");
  const { toast } = useToast();

  const targetId = (!userId || userId === "me") ? user?.id : userId;

  const sendEmailMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/report/rep/${targetId}/send-email`, { period });
      return res.json();
    },
    onSuccess: (d) => {
      toast({
        title: d.success ? "Email sent!" : "Could not send email",
        description: d.success && d.sentTo ? `Delivered to ${d.sentTo}` : d.message,
        variant: d.success ? "default" : "destructive",
      });
    },
    onError: () => {
      toast({ title: "Send failed", description: "Check SMTP configuration or try again.", variant: "destructive" });
    },
  });

  const saveSnapshotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/report/rep/${targetId}/snapshot`, { period });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved to history!", description: "This report card has been saved." });
      queryClient.invalidateQueries({ queryKey: ["/api/report/rep", targetId, "snapshots"] });
    },
    onError: () => {
      toast({ title: "Save failed", description: "Could not save snapshot.", variant: "destructive" });
    },
  });

  const { data, isLoading, error } = useQuery<RepReportData>({
    queryKey: ["/api/report/rep", targetId, period],
    queryFn: async () => {
      const res = await fetch(`/api/report/rep/${targetId}?period=${period}`);
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!targetId,
  });

  const { data: snapshots } = useQuery<ReportCardSnapshot[]>({
    queryKey: ["/api/report/rep", targetId, "snapshots"],
    queryFn: async () => {
      const res = await fetch(`/api/report/rep/${targetId}/snapshots`);
      if (!res.ok) throw new Error("Failed to load snapshots");
      return res.json();
    },
    enabled: !!targetId,
  });

  const { data: accountSummary = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/account-summary", "current"],
    queryFn: async () => {
      const res = await fetch(`/api/financials/account-summary?period=current`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch financial data");
      return res.json();
    },
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

  const { rep, period: p, goals, touchpoints: tp, contacts, tasks, topAccounts, accountsNeedingAttention, wins, teamMembers } = data;

  // Compute financial totals for this rep from account-summary data
  const repFinancials = accountSummary
    .filter(row => row.repName && matchRepName(row.repName, rep.name))
    .reduce((acc, row) => ({ loads: acc.loads + row.totalLoads, margin: acc.margin + row.totalMargin }), { loads: 0, margin: 0 });
  const hasFinancials = accountSummary.length > 0;
  const marginDisplay = repFinancials.margin >= 1000
    ? `$${(repFinancials.margin / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`
    : `$${repFinancials.margin.toLocaleString()}`;
  const initials = rep.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
  const roleLabel = rep.role.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

  const managerLine = [rep.manager, rep.director].filter(Boolean).join(" · ");
  const tasksDoneLabel = `${tasks.completed} of ${tasks.completed + tasks.open} tasks`;

  const isManager = user?.role === "admin" || user?.role === "director" ||
    user?.role === "national_account_manager" || user?.role === "sales_director";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-foreground font-sans" data-testid="page-rep-report">
      {/* ── Dark hero header ── */}
      <div
        className="relative px-6 pt-6 pb-10 md:px-8 md:pt-8"
        style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)" }}
      >
        <div className="max-w-5xl mx-auto">
          {/* Back button */}
          {isManager && (
            <button
              onClick={() => navigate("/reports")}
              className="flex items-center gap-1.5 text-white/60 hover:text-white text-sm mb-4 transition-colors"
              data-testid="button-back-team"
            >
              <ArrowLeft className="h-4 w-4" />
              All Report Cards
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

            {/* Period toggle + actions */}
            <div className="flex flex-col items-start md:items-end gap-2">
              <div className="flex items-center gap-2 flex-wrap">
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
                <button
                  onClick={() => saveSnapshotMutation.mutate()}
                  disabled={saveSnapshotMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-medium transition-all disabled:opacity-50"
                  data-testid="button-save-history"
                  title="Save a snapshot to history"
                >
                  {saveSnapshotMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Save className="h-3.5 w-3.5" />}
                  Save to History
                </button>
                <button
                  onClick={() => sendEmailMutation.mutate()}
                  disabled={sendEmailMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-medium transition-all disabled:opacity-50"
                  data-testid="button-send-email"
                  title="Send this report by email"
                >
                  {sendEmailMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Send className="h-3.5 w-3.5" />}
                  Email Report
                </button>
              </div>
              <p className="text-white/50 text-xs px-1">{p.label}</p>
            </div>
          </div>

          {/* KPI quick-stats */}
          <div className={`grid gap-3 mt-8 ${hasFinancials ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2 md:grid-cols-4"}`}>
            {[
              { label: "Touchpoints", value: String(tp.total), sub: `this ${period === "weekly" ? "week" : "month"}`, trend: 0, icon: Zap },
              { label: "New Contacts", value: String(contacts.newThisPeriod), sub: `this ${period === "weekly" ? "week" : "month"}`, trend: 0, icon: Users },
              { label: "Tasks Done", value: tasksDoneLabel, sub: `${tasks.overdue} overdue`, trend: tasks.overdue > 0 ? -1 : 0, icon: CheckSquare },
              { label: "Need Attention", value: String(accountsNeedingAttention), sub: "14+ days quiet", trend: accountsNeedingAttention > 0 ? -1 : 0, icon: AlertCircle },
              ...(hasFinancials ? [
                { label: "Loads", value: repFinancials.loads.toLocaleString(), sub: "this month", trend: 0, icon: Package },
                { label: "Margin", value: marginDisplay, sub: "this month", trend: 0, icon: DollarSign },
              ] : []),
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

        {/* Your Team section */}
        {teamMembers && teamMembers.length > 0 && (
          <section data-testid="section-your-team">
            <div className="flex items-center gap-2 mb-3">
              <Users className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Your Team</h2>
              <span className="text-xs text-muted-foreground ml-auto">{teamMembers.length} direct report{teamMembers.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {teamMembers.map((member) => {
                const memberInitials = member.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
                const memberRoleLabel = member.role.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                const goalsColor = member.goalsAvgPct >= 80
                  ? "text-green-600 dark:text-green-400"
                  : member.goalsAvgPct >= 50
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-500";
                return (
                  <div
                    key={member.id}
                    className="rounded-xl border bg-card p-4 space-y-3 hover:bg-muted/30 transition-colors"
                    data-testid={`team-member-card-${member.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                          {memberInitials}
                        </div>
                        <div>
                          <p className="text-sm font-semibold leading-tight">{member.name}</p>
                          <p className="text-xs text-muted-foreground">{memberRoleLabel}</p>
                        </div>
                      </div>
                      <a
                        href={`/report/${member.id}`}
                        className="text-muted-foreground/50 hover:text-primary transition-colors"
                        title="View full report"
                        data-testid={`link-team-member-report-${member.id}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <Zap className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Touchpoints</span>
                        <span className="ml-auto font-semibold text-foreground">{member.touchpoints}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">New Contacts</span>
                        <span className="ml-auto font-semibold text-foreground">{member.newContacts}</span>
                      </div>
                      <div className="flex items-center gap-1.5 col-span-2">
                        <CheckSquare className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground">Tasks</span>
                        <span className="ml-auto font-semibold text-foreground">
                          <span className="text-green-600 dark:text-green-400">{member.tasks.completed} done</span>
                          {member.tasks.open > 0 && <span className="text-muted-foreground"> · {member.tasks.open} open</span>}
                          {member.tasks.overdue > 0 && <span className="text-red-500"> · {member.tasks.overdue} overdue</span>}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 col-span-2">
                        <AlertCircle className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground">Accounts Needing Attention</span>
                        <span className={`ml-auto font-semibold ${member.accountsNeedingAttention > 0 ? "text-amber-600" : "text-foreground"}`}>
                          {member.accountsNeedingAttention}
                        </span>
                      </div>
                    </div>

                    {member.hasActiveGoals && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-1.5">
                            <Target className="h-3 w-3 text-muted-foreground" />
                            <span className="text-muted-foreground">Goals Avg</span>
                          </div>
                          <span className={`font-semibold ${member.goalsAvgPct === 0 ? "text-muted-foreground" : goalsColor}`}>
                            {member.goalsAvgPct}%
                          </span>
                        </div>
                        <PctBar p={member.goalsAvgPct} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Report Card History ── */}
        <section data-testid="section-history">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Report Card History</h2>
            {snapshots && snapshots.length > 0 && (
              <span className="text-xs text-muted-foreground ml-auto">{snapshots.length} saved</span>
            )}
          </div>
          {!snapshots ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : snapshots.length === 0 ? (
            <div className="rounded-xl border bg-card px-4 py-8 text-center">
              <BookOpen className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">No saved snapshots yet.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Click "Save to History" to capture the current report card.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {snapshots.map((s) => (
                <SnapshotCard key={s.id} snapshot={s} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
