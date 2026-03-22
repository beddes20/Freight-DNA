import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Users, Building2, CheckCircle2, AlertTriangle, Clock, TrendingUp, BarChart3,
  Phone, MessageSquare, Mail, UserPlus, UserCheck, ArrowUpRight, Package, DollarSign, Percent, FileBarChart2, Info, Truck, Heart, ArrowUpDown,
  Send, Loader2, XCircle, Star, Award
} from "lucide-react";
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

function RepCard({ rep, totalLoads, totalMargin, totalRevenue, criteria, nominations, canNominate, onNominate }: {
  rep: RepPerf;
  totalLoads?: number;
  totalMargin?: number;
  totalRevenue?: number;
  criteria?: PromotionCriteria[];
  nominations?: PromotionNomination[];
  canNominate?: boolean;
  onNominate?: (rep: RepPerf) => void;
}) {
  const [, navigate] = useLocation();
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

        <div className="grid grid-cols-5 gap-1.5 mb-2">
          <StatPill value={rep.openTasks} label="Open" color={rep.openTasks > 5 ? "text-amber-600" : "text-foreground"} />
          <StatPill value={rep.overdueTasks} label="Overdue" color={rep.overdueTasks > 0 ? "text-red-600" : "text-foreground"} />
          <StatPill value={rep.companyCount} label="Accounts" color="text-blue-600" />
          <StatPill value={rep.newContacts} label="New Contacts" color="text-emerald-600" icon={<UserPlus className="h-3 w-3 text-emerald-500" />} />
          <StatPill value={rep.baseAdvanced} label="Rel. Moved" color="text-teal-600" icon={<ArrowUpRight className="h-3 w-3 text-teal-500" />} />
        </div>

        <div className="grid grid-cols-5 gap-1.5 mb-4">
          <StatPill value={rep.callTouchpoints} label="Calls" color="text-blue-600" icon={<Phone className="h-3 w-3 text-blue-500" />} />
          <StatPill value={rep.textTouchpoints} label="Texts" color="text-green-600" icon={<MessageSquare className="h-3 w-3 text-green-500" />} />
          <StatPill value={rep.emailTouchpoints} label="Emails" color="text-purple-600" icon={<Mail className="h-3 w-3 text-purple-500" />} />
          <StatPill value={rep.contactsTouched} label="Touched" color="text-cyan-600" icon={<UserCheck className="h-3 w-3 text-cyan-500" />} />
          <StatPill value={rep.meaningfulTouchpoints ?? 0} label="Meaningful" color="text-rose-600" icon={<Heart className="h-3 w-3 text-rose-500" />} note={meaningfulNote} />
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

export default function TeamPerformancePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodOption>("current");
  const [sortBy, setSortBy] = useState<SortOption>("alpha");
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

  type DispatcherSummaryRow = { dispatcherName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };
  const { data: dispatcherSummary = [] } = useQuery<DispatcherSummaryRow[]>({
    queryKey: ["/api/financials/dispatcher-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/dispatcher-summary?period=${period}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
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

  // Build a separate map for logistics managers — keyed by their financialRepId or name,
  // matched against the Dispatcher column (not opsUser).
  const lmLoadsMap: Record<string, { loads: number; margin: number; revenue: number }> = {};
  const lmReps = reps.filter(r => r.role === "logistics_manager" || r.role === "logistics_coordinator");
  for (const row of dispatcherSummary) {
    if (!row.dispatcherName) continue;
    const dispLower = row.dispatcherName.toLowerCase().trim();
    const match = lmReps.find(r =>
      (r.financialRepId && r.financialRepId.toLowerCase() === dispLower) ||
      matchRepName(row.dispatcherName, r.name)
    );
    if (match) {
      if (!lmLoadsMap[match.userId]) lmLoadsMap[match.userId] = { loads: 0, margin: 0, revenue: 0 };
      lmLoadsMap[match.userId].loads += row.totalLoads;
      lmLoadsMap[match.userId].margin += row.totalMargin;
      lmLoadsMap[match.userId].revenue += row.totalRevenue ?? 0;
    }
  }

  const hasSummaryData = accountSummary.length > 0 || dispatcherSummary.length > 0;
  const totalLoadsAll = Object.values(repLoadsMap).reduce((s, v) => s + v.loads, 0);
  const totalMarginAll = Object.values(repLoadsMap).reduce((s, v) => s + v.margin, 0);
  const totalRevenueAll = Object.values(repLoadsMap).reduce((s, v) => s + v.revenue, 0);
  const totalMarginPctAll = totalRevenueAll > 0 ? (totalMarginAll / totalRevenueAll) * 100 : null;

  const ams = sortReps(reps.filter(r => r.role === "account_manager"), sortBy);
  const logistics = sortReps(reps.filter(r => r.role === "logistics_manager" || r.role === "logistics_coordinator"), sortBy);
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
        <div className="flex flex-col items-start sm:items-end gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/30"
              onClick={() => { setBulkResult(null); setShowBulkSend(true); }}
              data-testid="button-send-all-reports"
            >
              <Send className="h-3 w-3" />
              Email All Reports
            </Button>
            <Select value={sortBy} onValueChange={v => setSortBy(v as SortOption)}>
              <SelectTrigger className="h-8 w-44 text-xs" data-testid="select-sort-by">
                <ArrowUpDown className="h-3 w-3 mr-1 text-muted-foreground shrink-0" />
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
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Open Tasks", value: totalOpenTasks, icon: <Clock className="h-4 w-4 text-amber-500" />, color: "text-amber-600" },
                { label: "Overdue", value: totalOverdue, icon: <AlertTriangle className="h-4 w-4 text-red-500" />, color: "text-red-600" },
                { label: "Total Accounts", value: totalAccounts, icon: <Building2 className="h-4 w-4 text-blue-500" />, color: "text-blue-600" },
                { label: "New Contacts", value: totalNewContacts, icon: <UserPlus className="h-4 w-4 text-emerald-500" />, color: "text-emerald-600" },
                { label: "Relationships Moved", value: totalBaseAdvanced, icon: <ArrowUpRight className="h-4 w-4 text-teal-500" />, color: "text-teal-600" },
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
                { label: "Calls", value: totalCalls, icon: <Phone className="h-4 w-4 text-blue-500" />, color: "text-blue-600", sub: null },
                { label: "Texts", value: totalTexts, icon: <MessageSquare className="h-4 w-4 text-green-500" />, color: "text-green-600", sub: null },
                { label: "Emails", value: totalEmails, icon: <Mail className="h-4 w-4 text-purple-500" />, color: "text-purple-600", sub: null },
                { label: "Touched", value: totalTouched, icon: <UserCheck className="h-4 w-4 text-cyan-500" />, color: "text-cyan-600", sub: null },
                { label: "Meaningful", value: totalMeaningful, icon: <Heart className="h-4 w-4 text-rose-500" />, color: "text-rose-600", sub: totalAllTouchpoints > 0 ? `of ${totalAllTouchpoints} (${totalMeaningfulPct}%)` : null },
              ].map(stat => (
                <Card key={stat.label}>
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
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
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
                    criteria={promotionCriteria}
                    nominations={nominations}
                    canNominate={canNominate}
                    onNominate={setNominationTarget}
                  />
                ))}
              </div>
            </div>
          )}

          {logistics.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Logistics Managers</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {logistics.map(rep => (
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
                  />
                ))}
              </div>
            </div>
          )}

          {salesReps.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Sales</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {salesReps.map(rep => (
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
