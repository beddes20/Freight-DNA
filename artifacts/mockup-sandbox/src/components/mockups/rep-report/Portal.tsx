import { useState } from "react";
import {
  TrendingUp, TrendingDown, Minus, Phone, Mail, MessageSquare, Building2,
  Users, CheckSquare, AlertCircle, Target, Star, ChevronRight,
  Calendar, BarChart3, Zap, Trophy, Flame, ArrowUpRight, Clock,
} from "lucide-react";

const rep = {
  name: "Adan Castaneda",
  role: "Account Manager",
  manager: "Danny Beddes",
  director: "Chris Merritt",
  avatar: "AC",
};

const weeks = ["Mar 17–23, 2026", "Mar 10–16, 2026", "Mar 3–9, 2026"];
const months = ["March 2026", "February 2026", "January 2026"];

const goals = [
  { label: "Monthly Margin", target: 25000, current: 18420, unit: "$", metric: "margin", period: "monthly" },
  { label: "Weekly Touchpoints", target: 25, current: 19, unit: "", metric: "touchpoints", period: "weekly" },
  { label: "Contacts Added", target: 8, current: 3, unit: "", metric: "contacts_added", period: "monthly" },
  { label: "Load Count", target: 40, current: 31, unit: "", metric: "loads", period: "monthly" },
];

const touchpoints = [
  { type: "Call", icon: Phone, count: 9, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/40" },
  { type: "Email", icon: Mail, count: 6, color: "text-violet-600 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950/40" },
  { type: "Text", icon: MessageSquare, count: 3, color: "text-green-600 dark:text-green-400", bg: "bg-green-50 dark:bg-green-950/40" },
  { type: "Site Visit", icon: Building2, count: 1, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/40" },
];

const accounts = [
  { name: "Acuity Brands", touches: 4, last: "Today", tag: "Hot", tagColor: "bg-red-100 text-red-700" },
  { name: "Dewell Container", touches: 3, last: "Yesterday", tag: "Active", tagColor: "bg-green-100 text-green-700" },
  { name: "JCI Laredo", touches: 2, last: "Mar 20", tag: "RFP Due", tagColor: "bg-amber-100 text-amber-700" },
  { name: "Pacific Foods", touches: 2, last: "Mar 19", tag: "Active", tagColor: "bg-green-100 text-green-700" },
  { name: "Atlas Logistics", touches: 1, last: "Mar 18", tag: "", tagColor: "" },
];

const newContacts = [
  { name: "Sarah Hensley", company: "Acuity Brands", role: "Logistics Manager" },
  { name: "Marcus Webb", company: "Dewell Container", role: "VP Supply Chain" },
  { name: "Linda Tran", company: "Pacific Foods", role: "Transportation Dir." },
];

const weeklyTrend = [11, 14, 9, 17, 12, 19];

function pct(current: number, target: number) {
  return Math.min(100, Math.round((current / target) * 100));
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
  const max = Math.max(...values);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v, i) => (
        <div
          key={i}
          className={`flex-1 rounded-sm transition-all ${i === values.length - 1 ? "bg-primary" : "bg-primary/30"}`}
          style={{ height: `${Math.round((v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function Portal() {
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");
  const [selectedPeriod, setSelectedPeriod] = useState(0);

  const periodOptions = period === "weekly" ? weeks : months;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-foreground font-sans">
      {/* Header */}
      <div
        className="relative px-8 pt-8 pb-10"
        style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)" }}
      >
        <div className="max-w-5xl mx-auto">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                {rep.avatar}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">{rep.name}</h1>
                <p className="text-slate-300 text-sm mt-0.5">{rep.role} · Reports to {rep.manager} · {rep.director}</p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-1 bg-white/10 rounded-xl p-1">
                <button
                  onClick={() => setPeriod("weekly")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${period === "weekly" ? "bg-white text-slate-900" : "text-white/70 hover:text-white"}`}
                >
                  Weekly
                </button>
                <button
                  onClick={() => setPeriod("monthly")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${period === "monthly" ? "bg-white text-slate-900" : "text-white/70 hover:text-white"}`}
                >
                  Monthly
                </button>
              </div>
              <div className="flex items-center gap-1">
                {periodOptions.map((p, i) => (
                  <button
                    key={i}
                    onClick={() => setSelectedPeriod(i)}
                    className={`px-3 py-1 rounded-lg text-xs transition-all ${i === selectedPeriod ? "bg-white/20 text-white font-medium" : "text-white/50 hover:text-white/80"}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Quick stats in header */}
          <div className="grid grid-cols-4 gap-3 mt-8">
            {[
              { label: "Touchpoints", value: "19", sub: "this week", trend: 7, icon: Zap },
              { label: "New Contacts", value: "3", sub: "this week", trend: 1, icon: Users },
              { label: "Tasks Done", value: "7", sub: "of 9 open", trend: 0, icon: CheckSquare },
              { label: "Accts Needing Attention", value: "2", sub: "overdue 14+ days", trend: -1, icon: AlertCircle },
            ].map(({ label, value, sub, trend, icon: Icon }) => (
              <div key={label} className="bg-white/10 rounded-xl p-3 border border-white/10 backdrop-blur-sm">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-3.5 w-3.5 text-white/60" />
                  <span className="text-xs text-white/60">{label}</span>
                </div>
                <div className="flex items-end gap-2">
                  <span className="text-2xl font-bold text-white">{value}</span>
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

      {/* Body */}
      <div className="max-w-5xl mx-auto px-8 py-6 space-y-6">

        {/* Goals Progress */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Target className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Goals Progress</h2>
            <span className="text-xs text-muted-foreground">Set by {rep.manager}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {goals.map((g) => {
              const p = pct(g.current, g.target);
              const statusColor = p >= 80 ? "text-green-600 dark:text-green-400" : p >= 50 ? "text-amber-600 dark:text-amber-400" : "text-red-500";
              const vs = p >= 80 ? "On track" : p >= 50 ? "In progress" : "Needs attention";
              const vsColor = p >= 80 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" : p >= 50 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
              return (
                <div key={g.label} className="rounded-xl border bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{g.label}</p>
                      <p className="text-xs text-muted-foreground capitalize">{g.period}</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${vsColor}`}>{vs}</span>
                  </div>
                  <div className="flex items-end gap-2">
                    <span className={`text-3xl font-bold ${statusColor}`}>
                      {g.unit === "$" ? `$${g.current.toLocaleString()}` : g.current}
                    </span>
                    <span className="text-sm text-muted-foreground mb-1">
                      / {g.unit === "$" ? `$${g.target.toLocaleString()}` : `${g.target} ${g.metric === "touchpoints" ? "touches" : g.metric === "loads" ? "loads" : ""}`}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <PctBar p={p} />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{p}% complete</span>
                      <span>{g.unit === "$" ? `$${(g.target - g.current).toLocaleString()} to go` : `${g.target - g.current} to go`}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid grid-cols-3 gap-6">
          {/* Left: Touchpoint breakdown + accounts */}
          <div className="col-span-2 space-y-6">
            {/* Touchpoint breakdown */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Touchpoint Breakdown</h2>
                <span className="text-xs text-muted-foreground ml-auto">19 total this week</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {touchpoints.map(({ type, icon: Icon, count, color, bg }) => (
                  <div key={type} className={`rounded-xl ${bg} p-3 text-center space-y-1`}>
                    <Icon className={`h-5 w-5 mx-auto ${color}`} />
                    <p className={`text-2xl font-bold ${color}`}>{count}</p>
                    <p className="text-xs text-muted-foreground">{type}s</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 p-3 rounded-xl border bg-card space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                  <span className="font-medium text-foreground">4-Week Trend</span>
                  <span>Touchpoints per week</span>
                </div>
                <SparkBar values={weeklyTrend} />
                <div className="flex justify-between text-xs text-muted-foreground pt-1">
                  <span>Feb 24</span>
                  <span>Mar 17</span>
                </div>
              </div>
            </section>

            {/* Account highlights */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Building2 className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Account Activity</h2>
                <span className="text-xs text-muted-foreground ml-auto">This week</span>
              </div>
              <div className="rounded-xl border bg-card divide-y divide-border/50">
                {accounts.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 group hover:bg-muted/30 transition-colors">
                    <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                      {a.name[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      <p className="text-xs text-muted-foreground">{a.touches} touch{a.touches !== 1 ? "es" : ""} · Last: {a.last}</p>
                    </div>
                    {a.tag && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${a.tagColor}`}>{a.tag}</span>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Right column */}
          <div className="space-y-6">
            {/* New contacts */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Users className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">New Contacts</h2>
              </div>
              <div className="space-y-2">
                {newContacts.map((c, i) => (
                  <div key={i} className="rounded-xl border bg-card p-3 flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                      {c.name.split(" ").map(n => n[0]).join("")}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{c.role}</p>
                      <p className="text-xs text-primary truncate">{c.company}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Wins */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Trophy className="h-4 w-4 text-amber-500" />
                <h2 className="text-sm font-semibold">Wins This Week</h2>
              </div>
              <div className="space-y-2">
                {[
                  { text: "Booked 6 loads with Acuity Brands after site visit", tag: "🚀 Growth" },
                  { text: "Converted spot shipper Pacific Foods to contract", tag: "🎉 Win" },
                ].map((w, i) => (
                  <div key={i} className="rounded-xl border bg-card p-3 space-y-1.5">
                    <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{w.tag}</span>
                    <p className="text-xs text-foreground">{w.text}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Open RFPs */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">RFP Deadlines</h2>
              </div>
              <div className="space-y-2">
                {[
                  { company: "JCI Laredo", due: "Apr 1", urgent: true },
                  { company: "Acuity Brands", due: "Apr 15", urgent: false },
                ].map((r, i) => (
                  <div key={i} className={`rounded-xl border p-3 flex items-center justify-between ${r.urgent ? "border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20" : "bg-card"}`}>
                    <div>
                      <p className="text-xs font-medium">{r.company}</p>
                      <p className="text-xs text-muted-foreground">Due {r.due}</p>
                    </div>
                    {r.urgent && <Flame className="h-4 w-4 text-amber-500" />}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
