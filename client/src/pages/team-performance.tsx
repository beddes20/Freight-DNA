import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Users, Building2, CheckCircle2, AlertTriangle, Clock, TrendingUp, TrendingDown, BarChart3,
  Phone, MessageSquare, Mail, UserPlus, UserCheck, ArrowUpRight, Package, DollarSign, Percent, FileBarChart2, Info, Truck, Heart, ArrowUpDown,
  Send, Loader2, XCircle, Star, Award, ChevronDown, ChevronUp, CalendarClock, ShieldAlert, Download,
  Target, LayoutGrid, List, StickyNote, Lightbulb, Trophy,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { matchRepName, fmtMoney } from "@/lib/rep-utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
  createdAt?: string | null;
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
  meaningfulTouchpoints: number;
  prevCallTouchpoints?: number;
  prevTextTouchpoints?: number;
  prevEmailTouchpoints?: number;
  prevMeaningfulTouchpoints?: number;
}

interface AccountSummaryRow {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName: string;
}

interface PromotionCriteria {
  id: string;
  fromRole: string;
  toRole: string;
  minLoadCount: number | null;
  minMarginPct: string | null;
  minTouchpoints: number | null;
  minTenureMonths: number | null;
  notes: string | null;
}

interface PromotionNomination {
  id: string;
  nomineeId: string;
  nominatedById: string;
  notes: string | null;
  nominatedAt: string;
  status: string;
  nominee?: { id: string; name: string; role: string } | null;
  nominatedBy?: { id: string; name: string } | null;
}

function nextLevelRole(role: string): { fromRole: string; toRole: string; label: string } | null {
  if (role === "logistics_manager") return { fromRole: "logistics_manager", toRole: "account_manager", label: "Account Manager" };
  if (role === "account_manager") return { fromRole: "account_manager", toRole: "national_account_manager", label: "National Account Manager" };
  return null;
}

function PromotionReadinessCard({ rep, criteria, totalLoads, totalMargin, totalRevenue, nominations }: {
  rep: RepPerf;
  criteria: PromotionCriteria[];
  totalLoads?: number;
  totalMargin?: number;
  totalRevenue?: number;
  nominations: PromotionNomination[];
}) {
  const next = nextLevelRole(rep.role);
  if (!next) return null;
  const c = criteria.find(cr => cr.fromRole === next.fromRole && cr.toRole === next.toRole);
  if (!c) return null;

  const hasAnyCriteria = c.minLoadCount != null || c.minMarginPct != null || c.minTouchpoints != null || c.minTenureMonths != null;
  if (!hasAnyCriteria) return null;

  const marginPct = totalRevenue && totalRevenue > 0 && totalMargin != null ? (totalMargin / totalRevenue) * 100 : null;
  const totalTouchpoints = rep.callTouchpoints + rep.textTouchpoints + rep.emailTouchpoints;
  const isNominated = nominations.some(n => n.nomineeId === rep.userId && n.status === "active");

  const checks: { label: string; current: string; required: string; pass: boolean }[] = [];
  if (c.minLoadCount != null) checks.push({
    label: "Load Count",
    current: (totalLoads ?? 0).toString(),
    required: c.minLoadCount.toString(),
    pass: (totalLoads ?? 0) >= c.minLoadCount,
  });
  if (c.minMarginPct != null) checks.push({
    label: "Margin %",
    current: marginPct != null ? `${marginPct.toFixed(1)}%` : "N/A",
    required: `${c.minMarginPct}%`,
    pass: marginPct != null && marginPct >= parseFloat(c.minMarginPct),
  });
  if (c.minTouchpoints != null) checks.push({
    label: "Touchpoints",
    current: totalTouchpoints.toString(),
    required: c.minTouchpoints.toString(),
    pass: totalTouchpoints >= c.minTouchpoints,
  });
  if (c.minTenureMonths != null) {
    const tenureMonths = rep.createdAt ? Math.floor((Date.now() - new Date(rep.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44)) : null;
    checks.push({
      label: "Tenure",
      current: tenureMonths != null ? `${tenureMonths} mo` : "N/A",
      required: `${c.minTenureMonths} mo`,
      pass: tenureMonths != null && tenureMonths >= c.minTenureMonths,
    });
  }

  const passCount = checks.filter(ch => ch.pass).length;

  return (
    <div className={`mt-3 rounded-lg border p-3 ${isNominated ? "border-amber-400 bg-amber-50 dark:bg-amber-950/20" : "border-border bg-muted/30"}`} data-testid={`promotion-readiness-${rep.userId}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-semibold">Next Level: {next.label}</span>
          {isNominated && <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 text-[10px] px-1.5 py-0">Nominated</Badge>}
        </div>
        <span className="text-[10px] text-muted-foreground">{passCount}/{checks.length} met</span>
      </div>
      <div className="space-y-1">
        {checks.map(ch => (
          <div key={ch.label} className="flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1">
              {ch.pass
                ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                : <XCircle className="h-3 w-3 text-muted-foreground shrink-0" />}
              <span className={ch.pass ? "text-foreground" : "text-muted-foreground"}>{ch.label}</span>
            </div>
            <span className={ch.pass ? "text-green-600 dark:text-green-400 font-medium" : "text-muted-foreground"}>
              {ch.current} / {ch.required}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NominateDialog({ rep, onClose }: { rep: RepPerf; onClose: () => void }) {
  const [notes, setNotes] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/promotion/nominations", { nomineeId: rep.userId, notes: notes || null });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/promotion/nominations"] });
      toast({ title: "Nomination submitted!", description: `${rep.name} has been marked as promotion ready.` });
      onClose();
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        You are marking <strong>{rep.name}</strong> as promotion ready. Optionally add a note explaining your recommendation.
      </p>
      <div className="space-y-2">
        <Textarea
          placeholder="Add a note (optional)..."
          value={notes}
          onChange={e => setNotes(e.target.value)}
          data-testid="textarea-nomination-notes"
          className="min-h-[80px]"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          data-testid="button-confirm-nominate"
          className="gap-1.5"
        >
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
          Mark as Promotion Ready
        </Button>
      </div>
    </div>
  );
}

function StatPill({ value, label, color, icon, note }: { value: number; label: string; color: string; icon?: React.ReactNode; note?: string }) {
  return (
    <div className="flex flex-col items-center px-2 py-2 rounded-lg bg-muted/50 min-w-[58px]">
      {icon && <div className="mb-0.5">{icon}</div>}
      <span className={`text-base font-bold leading-none ${color}`}>{value}</span>
      <span className="text-[10px] text-muted-foreground leading-tight text-center mt-0.5">{label}</span>
      {note && <span className="text-[9px] text-muted-foreground/70 leading-tight text-center">{note}</span>}
    </div>
  );
}

function TrendBadge({ current, prev }: { current: number; prev: number }) {
  const delta = current - prev;
  if (delta === 0 || prev === 0) return null;
  const isUp = delta > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[9px] font-semibold leading-none ${isUp ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
      {isUp ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
      {isUp ? "+" : ""}{delta}
    </span>
  );
}

function RepCard({ rep, totalLoads, totalMargin, totalRevenue, criteria, nominations, canNominate, onNominate, period, goalAttainment, repeatCarrierLoads, opportunityCount, winCount }: {
  rep: RepPerf;
  totalLoads?: number;
  totalMargin?: number;
  totalRevenue?: number;
  criteria?: PromotionCriteria[];
  nominations?: PromotionNomination[];
  canNominate?: boolean;
  onNominate?: (rep: RepPerf) => void;
  period?: string;
  goalAttainment?: { onTrack: number; total: number };
  repeatCarrierLoads?: number;
  opportunityCount?: number;
  winCount?: number;
}) {
  const [, navigate] = useLocation();
  const [showNote, setShowNote] = useState(false);
  const [noteText, setNoteText] = useState(() => {
    try { return localStorage.getItem(`coaching-note-${rep.userId}`) || ""; } catch { return ""; }
  });

  function saveNote(val: string) {
    setNoteText(val);
    try { localStorage.setItem(`coaching-note-${rep.userId}`, val); } catch {}
  }

  const isLmRole = rep.role === "logistics_manager" || rep.role === "logistics_coordinator";
  const initials = rep.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["bg-blue-500", "bg-green-500", "bg-purple-500", "bg-amber-500", "bg-red-500", "bg-cyan-500", "bg-pink-500", "bg-indigo-500"];
  const color = colors[rep.name.charCodeAt(0) % colors.length];
  const totalTasks = rep.openTasks + rep.completedTasks;
  const completionPct = totalTasks > 0 ? Math.round((rep.completedTasks / totalTasks) * 100) : 0;
  const totalRepTouchpoints = rep.callTouchpoints + rep.textTouchpoints + rep.emailTouchpoints;
  const meaningfulPct = totalRepTouchpoints > 0 ? Math.round(((rep.meaningfulTouchpoints ?? 0) / totalRepTouchpoints) * 100) : 0;
  const meaningfulNote = totalRepTouchpoints > 0 ? `of ${totalRepTouchpoints} (${meaningfulPct}%)` : undefined;
  const marginDisplay = totalMargin != null ? fmtMoney(totalMargin) : null;
  const marginPct = totalRevenue != null && totalRevenue > 0 && totalMargin != null
    ? (totalMargin / totalRevenue) * 100
    : null;
  const hasFinancials = totalLoads != null || marginDisplay != null;

  // Coaching priority: lagging on 2+ metrics (LMs don't track overdue/new contacts)
  const laggingMetrics: string[] = [];
  if (rep.callTouchpoints < 5) laggingMetrics.push("calls");
  if ((rep.meaningfulTouchpoints ?? 0) < 3) laggingMetrics.push("meaningful");
  if (!isLmRole && rep.overdueTasks >= 3) laggingMetrics.push("overdue tasks");
  if (!isLmRole && rep.newContacts === 0) laggingMetrics.push("new contacts");
  const needsAttention = laggingMetrics.length >= 2;

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      data-testid={`card-rep-${rep.userId}`}
      onClick={() => navigate(`/reps/${rep.userId}${period ? `?period=${period}` : ""}`)}
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
          <div className="shrink-0 flex flex-col items-end gap-1">
            {!isLmRole && rep.overdueTasks > 0 && (
              <div className="flex items-center gap-1 text-red-600 text-xs font-medium" data-testid={`badge-overdue-${rep.userId}`}>
                <AlertTriangle className="h-3.5 w-3.5" />
                {rep.overdueTasks} overdue
              </div>
            )}
            {needsAttention && (
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400 text-[10px] font-semibold bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-full px-1.5 py-0.5" title={`Lagging: ${laggingMetrics.join(", ")}`} data-testid={`badge-coaching-${rep.userId}`}>
                <Lightbulb className="h-2.5 w-2.5" /> Needs Coaching
              </div>
            )}
          </div>
        </div>
        {goalAttainment !== undefined && goalAttainment.total > 0 && (
          <div className="flex items-center gap-1.5 mb-3 px-0.5" data-testid={`goal-attainment-${rep.userId}`}>
            <Target className="h-3 w-3 text-muted-foreground shrink-0" />
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${goalAttainment.onTrack === goalAttainment.total ? "bg-green-500" : goalAttainment.onTrack >= goalAttainment.total / 2 ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${goalAttainment.total > 0 ? Math.round((goalAttainment.onTrack / goalAttainment.total) * 100) : 0}%` }}
              />
            </div>
            <span className={`text-[10px] font-semibold ${goalAttainment.onTrack === goalAttainment.total ? "text-green-700 dark:text-green-400" : goalAttainment.onTrack >= goalAttainment.total / 2 ? "text-amber-700 dark:text-amber-400" : "text-red-700 dark:text-red-400"}`}>
              {goalAttainment.onTrack}/{goalAttainment.total} goals on track
            </span>
          </div>
        )}

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

        {!isLmRole && (
          <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5 mb-2">
            <StatPill value={rep.openTasks} label="Open" color={rep.openTasks > 5 ? "text-amber-600" : "text-foreground"} />
            <StatPill value={rep.overdueTasks} label="Overdue" color={rep.overdueTasks > 0 ? "text-red-600" : "text-foreground"} />
            <StatPill value={rep.companyCount} label="Accounts" color="text-blue-600" />
            <StatPill value={rep.newContacts} label="New Contacts" color="text-emerald-600" icon={<UserPlus className="h-3 w-3 text-emerald-500" />} />
            <StatPill value={rep.baseAdvanced} label="Rel. Moved" color="text-teal-600" icon={<ArrowUpRight className="h-3 w-3 text-teal-500" />} />
          </div>
        )}
        {isLmRole && repeatCarrierLoads != null && (
          <div className="flex items-center gap-1.5 mb-2 px-1 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-900/20" data-testid={`repeat-carriers-${rep.userId}`}>
            <Truck className="h-3.5 w-3.5 text-violet-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-bold text-violet-600 dark:text-violet-400">{repeatCarrierLoads.toLocaleString()}</span>
              <span className="text-[10px] text-muted-foreground ml-1.5">repeat carrier loads</span>
            </div>
            <span className="text-[10px] text-muted-foreground">same carrier, same lane</span>
          </div>
        )}
        {!isLmRole && (opportunityCount != null || winCount != null) && (
          <div className="grid grid-cols-2 gap-1.5 mb-2" data-testid={`opp-wins-${rep.userId}`}>
            <div className="flex items-center gap-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-2 py-1.5">
              <Lightbulb className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-blue-600 dark:text-blue-400 leading-none">{opportunityCount ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">Opps Logged</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5">
              <Trophy className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-600 dark:text-amber-400 leading-none">{winCount ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">Wins Logged</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5 mb-1.5">
          <StatPill value={rep.callTouchpoints} label="Calls" color="text-blue-600" icon={<Phone className="h-3 w-3 text-blue-500" />} />
          <StatPill value={rep.textTouchpoints} label="Texts" color="text-green-600" icon={<MessageSquare className="h-3 w-3 text-green-500" />} />
          <StatPill value={rep.emailTouchpoints} label="Emails" color="text-purple-600" icon={<Mail className="h-3 w-3 text-purple-500" />} />
          <StatPill value={rep.contactsTouched} label="Touched" color="text-cyan-600" icon={<UserCheck className="h-3 w-3 text-cyan-500" />} />
          <StatPill value={rep.meaningfulTouchpoints ?? 0} label="Meaningful" color="text-rose-600" icon={<Heart className="h-3 w-3 text-rose-500" />} note={meaningfulNote} />
        </div>
        {(rep.prevCallTouchpoints != null || rep.prevTextTouchpoints != null) && (
          <div className="flex items-center gap-2 px-1 mb-3">
            <span className="text-[10px] text-muted-foreground/60">
              {period === "last" ? "vs. prior mo." : period === "ytd" ? "vs. last yr." : "vs. last mo."}
            </span>
            <TrendBadge current={rep.callTouchpoints} prev={rep.prevCallTouchpoints ?? 0} />
            <TrendBadge current={rep.textTouchpoints} prev={rep.prevTextTouchpoints ?? 0} />
            <TrendBadge current={rep.emailTouchpoints} prev={rep.prevEmailTouchpoints ?? 0} />
            <TrendBadge current={rep.meaningfulTouchpoints ?? 0} prev={rep.prevMeaningfulTouchpoints ?? 0} />
          </div>
        )}

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

        <div className="flex gap-1.5 mt-3">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 text-xs h-7"
            data-testid={`button-view-report-${rep.userId}`}
            onClick={(e) => { e.stopPropagation(); navigate(`/report/${rep.userId}`); }}
          >
            <FileBarChart2 className="h-3 w-3 mr-1.5" />
            View Report
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`text-xs h-7 gap-1 ${noteText ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
            data-testid={`button-coaching-note-${rep.userId}`}
            onClick={(e) => { e.stopPropagation(); setShowNote(v => !v); }}
            title="Coaching note (saved locally)"
          >
            <StickyNote className="h-3 w-3" />
          </Button>
          {canNominate && nextLevelRole(rep.role) && onNominate && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7 gap-1 text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-950/30"
              data-testid={`button-nominate-${rep.userId}`}
              onClick={(e) => { e.stopPropagation(); onNominate(rep); }}
            >
              <Star className="h-3 w-3" />
              Nominate
            </Button>
          )}
        </div>

        {showNote && (
          <div className="mt-2" onClick={e => e.stopPropagation()}>
            <Textarea
              placeholder="Private coaching notes for this rep (saved locally on this device)…"
              value={noteText}
              onChange={e => saveNote(e.target.value)}
              className="text-xs min-h-0 h-20 resize-none"
              data-testid={`textarea-coaching-note-${rep.userId}`}
            />
          </div>
        )}

        {criteria && nominations && (
          <PromotionReadinessCard
            rep={rep}
            criteria={criteria}
            totalLoads={totalLoads}
            totalMargin={totalMargin}
            totalRevenue={totalRevenue}
            nominations={nominations}
          />
        )}
      </CardContent>
    </Card>
  );
}

type SortOption = "alpha" | "calls" | "meaningful" | "overdue" | "accounts";

function sortReps(arr: RepPerf[], by: SortOption): RepPerf[] {
  return [...arr].sort((a, b) => {
    switch (by) {
      case "alpha": return a.name.localeCompare(b.name);
      case "calls": return (b.callTouchpoints + b.textTouchpoints + b.emailTouchpoints) - (a.callTouchpoints + a.textTouchpoints + a.emailTouchpoints);
      case "meaningful": return (b.meaningfulTouchpoints ?? 0) - (a.meaningfulTouchpoints ?? 0);
      case "overdue": return b.overdueTasks - a.overdueTasks;
      case "accounts": return b.companyCount - a.companyCount;
      default: return 0;
    }
  });
}

type BulkSendResult = { sent: number; failed: number; total: number; results: { name: string; email: string | null; ok: boolean }[] };
type DispatcherSummaryRow = { dispatcherName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
type RepeatCarrierRow = { dispatcherName: string; totalLoads: number; repeatCarrierLoads: number; repeatCarrierPct: number };
type SalespersonSummaryRow = { salespersonName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
type GapEntry = { name: string; loads: number; column: string };
type GoalShape = { id: string; amId: string; metric: string; startDate: string; endDate: string; currentValue: string | null; target: string };
type CadenceAlert = { companyId: string; companyName: string; repName: string; repId: string; daysSinceTouch: number; orgId: string };

function CadenceAccountabilitySection() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "director";
  const [expanded, setExpanded] = useState(false);

  const { data: alerts = [], isLoading } = useQuery<CadenceAlert[]>({
    queryKey: ["/api/team/cadence-alerts"],
    enabled: isAdmin,
  });

  if (!isAdmin) return null;
  if (isLoading) return null;
  if (alerts.length === 0) return null;

  const preview = expanded ? alerts : alerts.slice(0, 5);

  return (
    <div
      className="border rounded-xl p-5 space-y-4 bg-red-50/30 dark:bg-red-950/10 border-red-200 dark:border-red-800"
      data-testid="section-cadence-alerts"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-red-600 dark:text-red-400" />
          <h2 className="font-semibold text-sm">Cadence Accountability</h2>
          <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 text-[10px] px-1.5 py-0">
            {alerts.length} account{alerts.length !== 1 ? "s" : ""} overdue
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">No touchpoints in 30+ days</span>
      </div>

      <div className="space-y-2">
        {preview.map(alert => (
          <div
            key={`${alert.repId}-${alert.companyId}`}
            className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-background hover:bg-muted/30 transition-colors"
            data-testid={`row-cadence-alert-${alert.companyId}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">{alert.companyName}</span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground">
                  {alert.repName}
                </Badge>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
              {alert.daysSinceTouch}d ago
            </div>
          </div>
        ))}
      </div>

      {alerts.length > 5 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-cadence-expand"
        >
          {expanded ? <><ChevronUp className="w-3 h-3" /> Show less</> : <><ChevronDown className="w-3 h-3" /> Show {alerts.length - 5} more</>}
        </button>
      )}
    </div>
  );
}

export default function TeamPerformancePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const urlPeriod = new URLSearchParams(search).get("period") as PeriodOption | null;
  const [period, setPeriod] = useState<PeriodOption>(urlPeriod || "current");
  const [sortBy, setSortBy] = useState<SortOption>("alpha");

  useEffect(() => {
    const p = new URLSearchParams(search).get("period") as PeriodOption | null;
    if (p && p !== period) setPeriod(p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const [showBulkSend, setShowBulkSend] = useState(false);
  const [bulkPeriod, setBulkPeriod] = useState<"weekly" | "monthly">("monthly");
  const [bulkResult, setBulkResult] = useState<BulkSendResult | null>(null);
  const [nominationTarget, setNominationTarget] = useState<RepPerf | null>(null);

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

  const { data: dispatcherSummary = [] } = useQuery<DispatcherSummaryRow[]>({
    queryKey: ["/api/financials/dispatcher-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/dispatcher-summary?period=${period}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: repeatCarriersData = [] } = useQuery<RepeatCarrierRow[]>({
    queryKey: ["/api/financials/repeat-carriers", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/repeat-carriers?period=${period}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: salespersonSummary = [] } = useQuery<SalespersonSummaryRow[]>({
    queryKey: ["/api/financials/salesperson-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/salesperson-summary?period=${period}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: lastUploadInfo } = useQuery<{ uploadedAt: string | null; fileName: string | null }>({
    queryKey: ["/api/financials/last-upload-info"],
  });

  const [showGaps, setShowGaps] = useState(false);
  const { data: attributionGaps } = useQuery<{
    opsUserGaps: GapEntry[];
    dispatcherGaps: GapEntry[];
    salespersonGaps: GapEntry[];
    usersMissingId: { id: string; name: string; role: string }[];
  }>({
    queryKey: ["/api/financials/attribution-gaps"],
    enabled: user?.role === "admin",
  });

  const { data: bulkPreview, isLoading: previewLoading } = useQuery<{ recipients: { id: string; name: string; role: string; email: string }[]; total: number }>({
    queryKey: ["/api/report/bulk-preview"],
    enabled: showBulkSend && !bulkResult,
  });

  const { data: promotionCriteria = [] } = useQuery<PromotionCriteria[]>({
    queryKey: ["/api/promotion/criteria"],
  });

  const canNominateRole = ["national_account_manager", "director", "admin", "sales_director"].includes(user?.role || "");
  const { data: nominations = [] } = useQuery<PromotionNomination[]>({
    queryKey: ["/api/promotion/nominations"],
    enabled: canNominateRole,
  });

  const [viewMode, setViewMode] = useState<"grid" | "leaderboard">("grid");

  const { data: goals = [] } = useQuery<GoalShape[]>({
    queryKey: ["/api/goals"],
    staleTime: 60000,
  });

  // Opportunity / Win summary for current period
  const oppPeriodStart = (() => {
    const now = new Date();
    if (period === "last") { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return d.toISOString().split("T")[0]; }
    if (period === "ytd") { return `${now.getFullYear()}-01-01`; }
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();
  const oppPeriodEnd = period === "last"
    ? (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split("T")[0]; })()
    : new Date().toISOString().split("T")[0];

  const repIdsParam = reps.map(r => r.userId).join(",");
  const { data: oppSummary = [] } = useQuery<Array<{ repId: string; opportunities: number; wins: number }>>({
    queryKey: ["/api/opportunity-logs/summary", repIdsParam, oppPeriodStart, oppPeriodEnd],
    queryFn: async () => {
      if (!repIdsParam) return [];
      const res = await fetch(`/api/opportunity-logs/summary?repIds=${repIdsParam}&startDate=${oppPeriodStart}&endDate=${oppPeriodEnd}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: reps.length > 0,
    staleTime: 60000,
  });
  const oppSummaryMap: Record<string, { opportunities: number; wins: number }> = {};
  for (const s of oppSummary) oppSummaryMap[s.repId] = s;

  // Per-rep goal attainment: count active goals on track
  const goalAttainmentMap: Record<string, { onTrack: number; total: number }> = {};
  const nowStr2 = new Date().toISOString().slice(0, 10);
  for (const g of goals) {
    if (g.startDate > nowStr2 || g.endDate < nowStr2) continue;
    if (!goalAttainmentMap[g.amId]) goalAttainmentMap[g.amId] = { onTrack: 0, total: 0 };
    goalAttainmentMap[g.amId].total++;
    const cur = parseFloat(g.currentValue || "0");
    const tgt = parseFloat(g.target || "1");
    const pct = tgt > 0 ? Math.round((cur / tgt) * 100) : 0;
    const start = new Date(g.startDate); const end = new Date(g.endDate); const now3 = new Date();
    const totalDays2 = Math.max(1, (end.getTime() - start.getTime()) / 86400000);
    const daysPassed2 = Math.max(0, (now3.getTime() - start.getTime()) / 86400000);
    const expectedPct2 = Math.min(100, Math.round((daysPassed2 / totalDays2) * 100));
    if (pct >= expectedPct2 - 10) goalAttainmentMap[g.amId].onTrack++;
  }

  const bulkSendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/report/bulk-send", { period: bulkPeriod });
      return res.json() as Promise<BulkSendResult>;
    },
    onSuccess: (data) => {
      setBulkResult(data);
      toast({ title: `Reports sent`, description: `${data.sent} of ${data.total} emails delivered successfully.` });
    },
    onError: () => {
      toast({ title: "Send failed", description: "Could not send bulk reports. Check email configuration.", variant: "destructive" });
    },
  });

  if (!user || user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator") {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Access denied</p>
      </div>
    );
  }

  const canNominate = ["national_account_manager", "director", "admin", "sales_director"].includes(user.role);
  const isDirector = user.role === "director" || user.role === "admin";
  const activeNominations = nominations.filter(n => n.status === "active");

  const repLoadsMap: Record<string, { loads: number; margin: number; revenue: number }> = {};
  for (const row of accountSummary) {
    if (!row.repName) continue;
    const repNameLower = row.repName.toLowerCase().trim();
    const match =
      reps.find(r => r.financialRepId && r.financialRepId.toLowerCase() === repNameLower) ||
      reps.find(r => matchRepName(row.repName, r.name));
    if (match) {
      if (!repLoadsMap[match.userId]) repLoadsMap[match.userId] = { loads: 0, margin: 0, revenue: 0 };
      repLoadsMap[match.userId].loads += row.totalLoads;
      repLoadsMap[match.userId].margin += row.totalMargin;
      repLoadsMap[match.userId].revenue += row.totalRevenue ?? 0;
    }
  }

  // Build a separate map for logistics managers — keyed by their financialRepId or name,
  // matched against the Dispatcher column (not opsUser).
  const lmLoadsMap: Record<string, { loads: number; margin: number; revenue: number }> = {};
  const lmReps = reps.filter(r => r.role === "logistics_manager" || r.role === "logistics_coordinator");
  for (const row of dispatcherSummary) {
    if (!row.dispatcherName) continue;
    const dispLower = row.dispatcherName.toLowerCase().trim();
    const match =
      lmReps.find(r => r.financialRepId && r.financialRepId.toLowerCase() === dispLower) ||
      lmReps.find(r => matchRepName(row.dispatcherName, r.name));
    if (match) {
      if (!lmLoadsMap[match.userId]) lmLoadsMap[match.userId] = { loads: 0, margin: 0, revenue: 0 };
      lmLoadsMap[match.userId].loads += row.totalLoads;
      lmLoadsMap[match.userId].margin += row.totalMargin;
      lmLoadsMap[match.userId].revenue += row.totalRevenue ?? 0;
    }
  }

  // Build repeat-carrier map for LMs — keyed by userId
  const lmRepeatCarrierMap: Record<string, { repeatCarrierLoads: number; repeatCarrierPct: number }> = {};
  for (const row of repeatCarriersData) {
    if (!row.dispatcherName) continue;
    const dispLower = row.dispatcherName.toLowerCase().trim();
    const match =
      lmReps.find(r => r.financialRepId && r.financialRepId.toLowerCase() === dispLower) ||
      lmReps.find(r => matchRepName(row.dispatcherName, r.name));
    if (match) {
      if (!lmRepeatCarrierMap[match.userId]) lmRepeatCarrierMap[match.userId] = { repeatCarrierLoads: 0, repeatCarrierPct: 0 };
      lmRepeatCarrierMap[match.userId].repeatCarrierLoads += row.repeatCarrierLoads;
    }
  }

  // Build financial map for sales roles — keyed by the Salesperson column (not opsUser).
  const spReps = reps.filter(r => r.role === "sales_director" || r.role === "sales");
  const salesLoadsMap: Record<string, { loads: number; margin: number; revenue: number; spotLoads: number }> = {};
  for (const row of salespersonSummary) {
    if (!row.salespersonName) continue;
    const spLower = row.salespersonName.toLowerCase().trim();
    const match =
      spReps.find(r => r.financialRepId && r.financialRepId.toLowerCase() === spLower) ||
      spReps.find(r => matchRepName(row.salespersonName, r.name));
    if (match) {
      if (!salesLoadsMap[match.userId]) salesLoadsMap[match.userId] = { loads: 0, margin: 0, revenue: 0, spotLoads: 0 };
      salesLoadsMap[match.userId].loads += row.totalLoads;
      salesLoadsMap[match.userId].margin += row.totalMargin;
      salesLoadsMap[match.userId].revenue += row.totalRevenue ?? 0;
      salesLoadsMap[match.userId].spotLoads += row.spotLoads;
    }
  }

  const hasSummaryData = accountSummary.length > 0 || dispatcherSummary.length > 0 || salespersonSummary.length > 0;
  const totalLoadsAll = Object.values(repLoadsMap).reduce((s, v) => s + v.loads, 0);
  const totalMarginAll = Object.values(repLoadsMap).reduce((s, v) => s + v.margin, 0);
  const totalRevenueAll = Object.values(repLoadsMap).reduce((s, v) => s + v.revenue, 0);
  const totalMarginPctAll = totalRevenueAll > 0 ? (totalMarginAll / totalRevenueAll) * 100 : null;

  const ams = sortReps(reps.filter(r => r.role === "account_manager"), sortBy);
  const logisticsManagers = sortReps(reps.filter(r => r.role === "logistics_manager"), sortBy);
  const logisticsCoords = sortReps(reps.filter(r => r.role === "logistics_coordinator"), sortBy);
  const nams = sortReps(reps.filter(r => r.role === "national_account_manager" || r.role === "director"), sortBy);
  const salesReps = sortReps(reps.filter(r => r.role === "sales_director" || r.role === "sales"), sortBy);

  const totalOpenTasks = reps.reduce((sum, r) => sum + r.openTasks, 0);
  const totalOverdue = reps.reduce((sum, r) => sum + r.overdueTasks, 0);
  const totalAccounts = reps.reduce((sum, r) => sum + r.companyCount, 0);
  const totalNewContacts = reps.reduce((sum, r) => sum + r.newContacts, 0);
  const totalCalls = reps.reduce((sum, r) => sum + r.callTouchpoints, 0);
  const totalTexts = reps.reduce((sum, r) => sum + r.textTouchpoints, 0);
  const totalEmails = reps.reduce((sum, r) => sum + r.emailTouchpoints, 0);
  const totalTouched = reps.reduce((sum, r) => sum + r.contactsTouched, 0);
  const totalBaseAdvanced = reps.reduce((sum, r) => sum + r.baseAdvanced, 0);
  const totalMeaningful = reps.reduce((sum, r) => sum + (r.meaningfulTouchpoints ?? 0), 0);
  const totalAllTouchpoints = totalCalls + totalTexts + totalEmails;
  const totalMeaningfulPct = totalAllTouchpoints > 0 ? Math.round((totalMeaningful / totalAllTouchpoints) * 100) : 0;

  const handleExportCsv = () => {
    const headers = ["Name", "Role", "Accounts", "Calls", "Texts", "Emails", "Meaningful", "New Contacts", "Touched", "Loads", "Margin ($)"];
    const allReps = [...ams, ...nams, ...logisticsManagers, ...logisticsCoords, ...salesReps];
    const rows = allReps.map(r => {
      const isLm = r.role === "logistics_manager" || r.role === "logistics_coordinator";
      const isSales = r.role === "sales_director" || r.role === "sales";
      const fin = isLm ? lmLoadsMap[r.userId] : isSales ? salesLoadsMap[r.userId] : repLoadsMap[r.userId];
      return [
        r.name,
        r.role.replace(/_/g, " "),
        r.companyCount,
        r.callTouchpoints,
        r.textTouchpoints,
        r.emailTouchpoints,
        r.meaningfulTouchpoints ?? 0,
        r.newContacts,
        r.contactsTouched,
        fin?.loads ?? "",
        fin?.margin != null ? Math.round(fin.margin) : "",
      ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
    });
    const csv = [headers.map(h => `"${h}"`).join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `team-performance-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-6xl mx-auto">
      <div className="relative overflow-hidden rounded-xl px-6 py-5 text-white" style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}>
        <div className="pointer-events-none absolute -top-10 -right-10 h-48 w-48 rounded-full" style={{ background: "rgba(255,180,0,0.04)" }} />
        <div className="pointer-events-none absolute -bottom-8 -right-4 h-32 w-32 rounded-full" style={{ background: "rgba(255,180,0,0.03)" }} />
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2" data-testid="text-page-title">
              <BarChart3 className="h-5 w-5" style={{ color: "#ffb400" }} />
              Team Performance
            </h1>
            <p className="text-white/60 text-sm mt-1">KPIs across your team — tasks, accounts, and activity</p>
          </div>
        <div className="flex flex-col items-start sm:items-end gap-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-white/15 bg-white/5 p-0.5 gap-0.5" data-testid="toggle-view-mode">
              <button
                onClick={() => setViewMode("grid")}
                data-testid="button-view-grid"
                className={`p-1.5 rounded-md transition-all ${viewMode === "grid" ? "bg-white/15 text-white shadow-sm" : "text-white/60 hover:text-white hover:bg-white/10"}`}
                title="Card grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setViewMode("leaderboard")}
                data-testid="button-view-leaderboard"
                className={`p-1.5 rounded-md transition-all ${viewMode === "leaderboard" ? "bg-white/15 text-white shadow-sm" : "text-white/60 hover:text-white hover:bg-white/10"}`}
                title="Leaderboard view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5 border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              onClick={handleExportCsv}
              data-testid="button-export-csv"
            >
              <Download className="h-3 w-3" />
              Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5 border-blue-400/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100"
              onClick={() => { setBulkResult(null); setShowBulkSend(true); }}
              data-testid="button-send-all-reports"
            >
              <Send className="h-3 w-3" />
              Email All Reports
            </Button>
            <Select value={sortBy} onValueChange={v => setSortBy(v as SortOption)}>
              <SelectTrigger className="h-8 w-44 text-xs border-white/20 bg-white/5 text-white hover:bg-white/10 [&>svg]:text-white/70" data-testid="select-sort-by">
                <ArrowUpDown className="h-3 w-3 mr-1 text-white/70 shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alpha">Alphabetical</SelectItem>
                <SelectItem value="calls">Most Activity</SelectItem>
                <SelectItem value="meaningful">Most Meaningful</SelectItem>
                <SelectItem value="overdue">Most Overdue</SelectItem>
                <SelectItem value="accounts">Most Accounts</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center rounded-lg border border-white/15 bg-white/5 p-0.5 gap-0.5" data-testid="toggle-period">
              {(["current", "last", "ytd"] as PeriodOption[]).map((opt) => (
                <button
                  key={opt}
                  data-testid={`button-period-${opt}`}
                  onClick={() => { setPeriod(opt); navigate(`/team-performance?period=${opt}`, { replace: true }); }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    period === opt
                      ? "bg-white/15 text-white shadow-sm"
                      : "text-white/60 hover:text-white hover:bg-white/10"
                  }`}
                >
                  {opt === "current" ? "This Month" : opt === "last" ? "Last Month" : "YTD"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-xs text-white/70" data-testid="text-period-label">
              {getPeriodLabel(period)}
            </p>
            {lastUploadInfo?.uploadedAt && (
              <span className="flex items-center gap-1 text-[11px] text-white/70 border border-dashed border-white/30 rounded px-1.5 py-0.5" data-testid="text-data-as-of">
                <CalendarClock className="h-3 w-3" />
                Data as of {new Date(lastUploadInfo.uploadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
        </div>
      </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Open Tasks", value: totalOpenTasks, icon: <Clock className="h-4 w-4 text-amber-500" />, color: "text-amber-600", metric: "open_tasks" },
                { label: "Overdue", value: totalOverdue, icon: <AlertTriangle className="h-4 w-4 text-red-500" />, color: "text-red-600", metric: "overdue" },
                { label: "Total Accounts", value: totalAccounts, icon: <Building2 className="h-4 w-4 text-blue-500" />, color: "text-blue-600", metric: "total_accounts" },
                { label: "New Contacts", value: totalNewContacts, icon: <UserPlus className="h-4 w-4 text-emerald-500" />, color: "text-emerald-600", metric: "new_contacts" },
                { label: "Relationships Moved", value: totalBaseAdvanced, icon: <ArrowUpRight className="h-4 w-4 text-teal-500" />, color: "text-teal-600", metric: "relationships_moved" },
              ].map(stat => (
                <Card
                  key={stat.label}
                  className="cursor-pointer hover:shadow-md hover:border-primary/30 transition-all"
                  onClick={() => navigate(`/team-performance/detail/${stat.metric}?period=${period}`)}
                  data-testid={`portlet-${stat.metric}`}
                >
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
                { label: "Calls", value: totalCalls, icon: <Phone className="h-4 w-4 text-blue-500" />, color: "text-blue-600", sub: null, metric: "calls" },
                { label: "Texts", value: totalTexts, icon: <MessageSquare className="h-4 w-4 text-green-500" />, color: "text-green-600", sub: null, metric: "texts" },
                { label: "Emails", value: totalEmails, icon: <Mail className="h-4 w-4 text-purple-500" />, color: "text-purple-600", sub: null, metric: "emails" },
                { label: "Touched", value: totalTouched, icon: <UserCheck className="h-4 w-4 text-cyan-500" />, color: "text-cyan-600", sub: null, metric: "touched" },
                { label: "Meaningful", value: totalMeaningful, icon: <Heart className="h-4 w-4 text-rose-500" />, color: "text-rose-600", sub: totalAllTouchpoints > 0 ? `of ${totalAllTouchpoints} (${totalMeaningfulPct}%)` : null, metric: "meaningful" },
              ].map(stat => (
                <Card
                  key={stat.label}
                  className="cursor-pointer hover:shadow-md hover:border-primary/30 transition-all"
                  onClick={() => navigate(`/team-performance/detail/${stat.metric}?period=${period}`)}
                  data-testid={`portlet-${stat.metric}`}
                >
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      {stat.icon}
                      <span className="text-xs text-muted-foreground">{stat.label}</span>
                    </div>
                    <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                    {stat.sub && <p className="text-xs text-muted-foreground mt-0.5">{stat.sub}</p>}
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
                      {fmtMoney(totalMarginAll)}
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

          {viewMode === "leaderboard" && (() => {
            const allSortedReps = sortReps([...ams, ...nams, ...logisticsManagers, ...logisticsCoords], sortBy);
            const getFinancials = (r: RepPerf) => {
              const isLm = r.role === "logistics_manager" || r.role === "logistics_coordinator";
              return isLm ? lmLoadsMap[r.userId] : repLoadsMap[r.userId];
            };
            return (
              <div className="rounded-lg border overflow-hidden" data-testid="leaderboard-view">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground w-6">#</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Rep</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Calls</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Meaningful</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Accounts</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Overdue</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Loads</th>
                      <th className="text-center px-2 py-2 text-xs font-semibold text-muted-foreground">Goals</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {allSortedReps.map((rep, idx) => {
                      const fin = getFinancials(rep);
                      const ga = goalAttainmentMap[rep.userId];
                      const isLagging = (() => {
                        let lc = 0;
                        if (rep.callTouchpoints < 5) lc++;
                        if ((rep.meaningfulTouchpoints ?? 0) < 3) lc++;
                        if (rep.overdueTasks >= 3) lc++;
                        if (rep.newContacts === 0) lc++;
                        return lc >= 2;
                      })();
                      return (
                        <tr
                          key={rep.userId}
                          className="hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => {
                            window.location.href = `/reps/${rep.userId}${period ? `?period=${period}` : ""}`;
                          }}
                          data-testid={`leaderboard-row-${rep.userId}`}
                        >
                          <td className="px-3 py-2 text-xs text-muted-foreground font-mono">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{rep.name}</span>
                              {isLagging && <span title="Needs coaching attention"><Lightbulb className="h-3 w-3 text-amber-500 shrink-0" /></span>}
                            </div>
                            <span className="text-[10px] text-muted-foreground capitalize">{rep.role.replace(/_/g, " ")}</span>
                          </td>
                          <td className="px-2 py-2 text-center text-sm font-semibold text-blue-600 dark:text-blue-400">{rep.callTouchpoints}</td>
                          <td className="px-2 py-2 text-center text-sm font-semibold text-rose-600 dark:text-rose-400">{rep.meaningfulTouchpoints ?? 0}</td>
                          <td className="px-2 py-2 text-center text-sm text-muted-foreground">{(rep.role === "logistics_manager" || rep.role === "logistics_coordinator") ? "—" : rep.companyCount}</td>
                          <td className={`px-2 py-2 text-center text-sm font-semibold ${rep.overdueTasks > 0 && rep.role !== "logistics_manager" && rep.role !== "logistics_coordinator" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{(rep.role === "logistics_manager" || rep.role === "logistics_coordinator") ? "—" : rep.overdueTasks}</td>
                          <td className="px-2 py-2 text-center text-sm">{fin ? fin.loads.toLocaleString() : "—"}</td>
                          <td className="px-2 py-2 text-center">
                            {ga && ga.total > 0 ? (
                              <span className={`text-xs font-semibold ${ga.onTrack === ga.total ? "text-green-600" : ga.onTrack >= ga.total / 2 ? "text-amber-600" : "text-red-600"}`}>
                                {ga.onTrack}/{ga.total}
                              </span>
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {viewMode === "grid" && nams.length > 0 && (
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
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
                    period={period}
                    goalAttainment={goalAttainmentMap[rep.userId]}
                    opportunityCount={oppSummaryMap[rep.userId]?.opportunities ?? 0}
                    winCount={oppSummaryMap[rep.userId]?.wins ?? 0}
                  />
                ))}
              </div>
            </div>
          )}

          {viewMode === "grid" && ams.length > 0 && (
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
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
                    period={period}
                    goalAttainment={goalAttainmentMap[rep.userId]}
                    opportunityCount={oppSummaryMap[rep.userId]?.opportunities ?? 0}
                    winCount={oppSummaryMap[rep.userId]?.wins ?? 0}
                  />
                ))}
              </div>
            </div>
          )}

          {viewMode === "grid" && logisticsManagers.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Logistics Managers</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {logisticsManagers.map(rep => (
                  <RepCard
                    key={rep.userId}
                    rep={rep}
                    totalLoads={lmLoadsMap[rep.userId]?.loads}
                    totalMargin={lmLoadsMap[rep.userId]?.margin}
                    totalRevenue={lmLoadsMap[rep.userId]?.revenue}
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
                    period={period}
                    goalAttainment={goalAttainmentMap[rep.userId]}
                    repeatCarrierLoads={lmRepeatCarrierMap[rep.userId]?.repeatCarrierLoads}
                  />
                ))}
              </div>
            </div>
          )}

          {viewMode === "grid" && logisticsCoords.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Logistics Coordinators</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {logisticsCoords.map(rep => (
                  <RepCard
                    key={rep.userId}
                    rep={rep}
                    totalLoads={lmLoadsMap[rep.userId]?.loads}
                    totalMargin={lmLoadsMap[rep.userId]?.margin}
                    totalRevenue={lmLoadsMap[rep.userId]?.revenue}
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
                    period={period}
                    goalAttainment={goalAttainmentMap[rep.userId]}
                    repeatCarrierLoads={lmRepeatCarrierMap[rep.userId]?.repeatCarrierLoads}
                  />
                ))}
              </div>
            </div>
          )}

          {viewMode === "grid" && salesReps.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Sales</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {salesReps.map(rep => {
                  const fin = salesLoadsMap[rep.userId];
                  const marginPct = fin && fin.revenue > 0 ? (fin.margin / fin.revenue) * 100 : null;
                  const initials = rep.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
                  return (
                    <Card
                      key={rep.userId}
                      className="hover:shadow-md transition-shadow cursor-pointer"
                      onClick={() => navigate(`/reps/${rep.userId}${period ? `?period=${period}` : ""}`)}
                      data-testid={`card-sales-rep-${rep.userId}`}
                    >
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-center gap-3 mb-4">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900/40 dark:to-green-900/40 text-blue-700 dark:text-blue-300 font-bold text-sm">
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm truncate">{rep.name}</p>
                            <p className="text-xs text-muted-foreground capitalize">{rep.role.replace(/_/g, " ")}</p>
                          </div>
                        </div>

                        {fin ? (
                          <div className="grid gap-2">
                            <div className={`grid gap-2 ${marginPct !== null ? "grid-cols-3" : "grid-cols-2"}`}>
                              <div className="flex flex-col items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-900/20 px-2 py-3">
                                <Package className="h-4 w-4 text-blue-500 mb-1" />
                                <p className="text-lg font-bold text-blue-600 dark:text-blue-400 leading-none">{fin.loads.toLocaleString()}</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Loads</p>
                              </div>
                              <div className="flex flex-col items-center justify-center rounded-lg bg-green-50 dark:bg-green-900/20 px-2 py-3">
                                <DollarSign className="h-4 w-4 text-green-500 mb-1" />
                                <p className="text-lg font-bold text-green-600 dark:text-green-400 leading-none">{fmtMoney(fin.margin)}</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">Margin</p>
                              </div>
                              {marginPct !== null && (
                                <div className={`flex flex-col items-center justify-center rounded-lg px-2 py-3 ${marginPct < 0 ? "bg-red-50 dark:bg-red-900/20" : "bg-emerald-50 dark:bg-emerald-900/20"}`}>
                                  <Percent className={`h-4 w-4 mb-1 ${marginPct < 0 ? "text-red-500" : "text-emerald-500"}`} />
                                  <p className={`text-lg font-bold leading-none ${marginPct < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>{marginPct.toFixed(1)}%</p>
                                  <p className="text-[10px] text-muted-foreground mt-0.5">Margin %</p>
                                </div>
                              )}
                            </div>
                            {fin.spotLoads > 0 && (
                              <div className="flex items-center justify-center gap-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/20 px-2 py-1.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                                <Package className="h-3 w-3" />
                                {fin.spotLoads} spot {fin.spotLoads === 1 ? "load" : "loads"}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-center py-4 text-muted-foreground text-xs">
                            No financial data for this period
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
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

      {/* Promotion Nominations Panel (Directors & Admins) */}
      {isDirector && activeNominations.length > 0 && (
        <div className="border rounded-xl p-5 space-y-4 bg-amber-50/50 dark:bg-amber-950/10 border-amber-200 dark:border-amber-800" data-testid="section-nominations">
          <div className="flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-600" />
            <h2 className="font-semibold text-sm">Promotion Nominations</h2>
            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 text-[10px] px-1.5 py-0">{activeNominations.length}</Badge>
          </div>
          <div className="space-y-3">
            {activeNominations.map(n => {
              const repData = reps.find(r => r.userId === n.nomineeId);
              const loadsData = n.nomineeId ? repLoadsMap[n.nomineeId] : null;
              const marginPct = loadsData && loadsData.revenue > 0 ? (loadsData.margin / loadsData.revenue) * 100 : null;
              return (
                <div key={n.id} className="rounded-lg border bg-card p-4" data-testid={`nomination-card-${n.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{n.nominee?.name ?? "Unknown"}</p>
                        <Badge variant="outline" className="text-[10px] capitalize">{n.nominee?.role?.replace(/_/g, " ")}</Badge>
                        <span className="text-xs text-muted-foreground">→ {n.nominee?.role ? nextLevelRole(n.nominee.role)?.label ?? "" : ""}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Nominated by {n.nominatedBy?.name ?? "Unknown"} · {new Date(n.nominatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                      {n.notes && <p className="text-xs text-foreground mt-1.5 italic">"{n.notes}"</p>}
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {loadsData && loadsData.loads > 0 && (
                        <div className="flex items-center gap-3 text-xs text-right">
                          <span className="text-muted-foreground">{loadsData.loads} loads</span>
                          {marginPct !== null && <span className={marginPct >= 0 ? "text-green-600" : "text-red-500"}>{marginPct.toFixed(1)}% margin</span>}
                        </div>
                      )}
                      {repData && (
                        <div className="text-xs text-muted-foreground">
                          {repData.callTouchpoints + repData.textTouchpoints + repData.emailTouchpoints} touchpoints this period
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Attribution Gaps (Admin only) */}
      {user?.role === "admin" && attributionGaps && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            onClick={() => setShowGaps(v => !v)}
            data-testid="button-toggle-attribution-gaps"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">Financial Attribution Gaps</span>
              {(attributionGaps.opsUserGaps.length + attributionGaps.dispatcherGaps.length + attributionGaps.salespersonGaps.length) > 0 && (
                <Badge className="bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200 text-[10px] px-1.5">
                  {attributionGaps.opsUserGaps.length + attributionGaps.dispatcherGaps.length + attributionGaps.salespersonGaps.length} unmatched
                </Badge>
              )}
            </div>
            {showGaps ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
          {showGaps && (
            <div className="px-4 pb-4 space-y-4">
              <p className="text-xs text-muted-foreground">Names from the financial upload that couldn't be matched to any CRM user. Set their Financial Rep ID in User Management to fix attribution.</p>
              {[
                { label: "OpsUser column (NAMs / AMs)", gaps: attributionGaps.opsUserGaps },
                { label: "Dispatcher column (Logistics Managers)", gaps: attributionGaps.dispatcherGaps },
                { label: "Salesperson column (Sales roles)", gaps: attributionGaps.salespersonGaps },
              ].map(({ label, gaps }) => gaps.length > 0 && (
                <div key={label}>
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1.5">{label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gaps.map(g => (
                      <span key={g.name} className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-[11px] px-2 py-0.5 font-medium">
                        {g.name}
                        <span className="text-amber-500 dark:text-amber-400">({g.loads} loads)</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {attributionGaps.usersMissingId.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">Users missing Financial Rep ID</p>
                  <div className="flex flex-wrap gap-1.5">
                    {attributionGaps.usersMissingId.map(u => (
                      <span key={u.id} className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground text-[11px] px-2 py-0.5">
                        {u.name} <span className="opacity-60 capitalize">({u.role.replace(/_/g, " ")})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(attributionGaps.opsUserGaps.length + attributionGaps.dispatcherGaps.length + attributionGaps.salespersonGaps.length) === 0 && (
                <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> All financial rows are matched to CRM users.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Cadence Accountability */}
      <CadenceAccountabilitySection />

      {/* Nominate Dialog */}
      <Dialog open={!!nominationTarget} onOpenChange={(open) => { if (!open) setNominationTarget(null); }}>
        <DialogContent data-testid="dialog-nominate">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              Mark as Promotion Ready
            </DialogTitle>
            <DialogDescription>
              Formally nominate this rep for their next level. Directors will be able to see this nomination.
            </DialogDescription>
          </DialogHeader>
          {nominationTarget && (
            <NominateDialog rep={nominationTarget} onClose={() => setNominationTarget(null)} />
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk Send Dialog */}
      <Dialog open={showBulkSend} onOpenChange={(open) => { setShowBulkSend(open); if (!open) setBulkResult(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-bulk-send">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4 text-blue-600" />
              Email All Report Cards
            </DialogTitle>
            <DialogDescription>
              {bulkResult
                ? "Send complete. Here's a summary of what was delivered."
                : "Select a period and send report card emails to your entire team at once."}
            </DialogDescription>
          </DialogHeader>

          {bulkResult ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-green-50 dark:bg-green-900/20 p-3">
                  <p className="text-2xl font-bold text-green-700 dark:text-green-400">{bulkResult.sent}</p>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">Sent</p>
                </div>
                <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3">
                  <p className="text-2xl font-bold text-red-700 dark:text-red-400">{bulkResult.failed}</p>
                  <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">Failed</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-2xl font-bold">{bulkResult.total}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Total</p>
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto space-y-1 rounded-lg border p-2">
                {bulkResult.results.map((r, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1 px-1.5 rounded hover:bg-muted/40">
                    <div className="flex items-center gap-2">
                      {r.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                      <span className="font-medium">{r.name}</span>
                    </div>
                    <span className="text-muted-foreground truncate ml-2">{r.email ?? "—"}</span>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setShowBulkSend(false)} data-testid="button-bulk-send-close">Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Report Period</p>
                <div className="flex gap-2">
                  {(["monthly", "weekly"] as const).map(opt => (
                    <button
                      key={opt}
                      onClick={() => setBulkPeriod(opt)}
                      data-testid={`button-bulk-period-${opt}`}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        bulkPeriod === opt
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      {opt === "monthly" ? "Monthly" : "Weekly"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Recipients</p>
                {previewLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading recipient list…
                  </div>
                ) : bulkPreview && bulkPreview.recipients.length > 0 ? (
                  <div className="rounded-lg border overflow-hidden">
                    <div className="max-h-44 overflow-y-auto divide-y divide-border/60">
                      {bulkPreview.recipients.map(r => (
                        <div key={r.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/30">
                          <span className="font-medium">{r.name}</span>
                          <Badge variant="outline" className="text-[10px] h-4 capitalize">
                            {r.role.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 border-t">
                      {bulkPreview.total} recipient{bulkPreview.total !== 1 ? "s" : ""} will receive an email
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-1">No team members found to email.</p>
                )}
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowBulkSend(false)} data-testid="button-bulk-send-cancel">Cancel</Button>
                <Button
                  size="sm"
                  onClick={() => bulkSendMutation.mutate()}
                  disabled={bulkSendMutation.isPending || !bulkPreview || bulkPreview.total === 0}
                  className="gap-1.5"
                  data-testid="button-bulk-send-confirm"
                >
                  {bulkSendMutation.isPending
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</>
                    : <><Send className="h-3.5 w-3.5" /> Send {bulkPreview?.total ?? 0} Emails</>}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
