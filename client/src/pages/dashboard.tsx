import { useState, useRef, useCallback, useEffect } from "react";
import vtLogoWhite from "@assets/value-truck-logo-white.png";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { InfoTooltip } from "@/components/info-tooltip";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Building2, Users, MapPin, DollarSign, ChevronRight, TrendingUp, TrendingDown,
  ShieldCheck, UserCircle, ClipboardList, Plus, Circle, PlayCircle,
  CheckCircle2, Calendar, Trash2, Crown, Send, Lightbulb, MessageSquare,
  PhoneCall, AlertTriangle, BellRing, X, CloudOff, Upload, Plane,
  Phone, Mail, Package, FileText, Shield, Clock, Target, ListTodo, Search, MoreHorizontal,
  Pin, PinOff, ChevronDown, ChevronUp, MessageCircle, Bell, Pencil, ArrowUpRight, ArrowDownRight,
  Activity, UserPlus, Repeat2, Trophy, Settings2,
  Truck, Route,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { TaskDialog } from "@/components/task-dialog";
import OneOnOnePortlet from "@/components/one-on-one-portlet";
import InternalCommsPortlet from "@/components/internal-comms-portlet";
import { ContactDetailSheet } from "@/components/contact-detail-sheet";
import type { Company, Contact, Task, User, FeedPost, FeedPostReaction, Touchpoint, Notification, LaneCarrier } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, fileToBase64, type PendingFile } from "@/components/file-attachment";
import { LmCareerPanel } from "@/components/lm-career-panel";
import { LmDailyCheckInPortlets } from "@/components/lm-daily-checkin-portlet";
import { TouchpointsTodayPortlet } from "@/components/touchpoints-today-portlet";
import { DashboardActivitySheet, type PortletType } from "@/components/dashboard-activity-sheet";
import { RelationshipDashboardSection } from "@/components/relationship-freight-portlet";
import { useDashboardLayout } from "@/hooks/use-dashboard-layout";
import { DashboardLayoutPanel } from "@/components/dashboard-layout-panel";
import { PortletErrorBoundary } from "@/components/portlet-error-boundary";
import { OutlookComposeDialog } from "@/components/outlook-compose-dialog";
import type { ProcurementLaneInfo } from "@/components/carrier-procurement-workspace";

type SafeUser = Omit<User, "password">;
type FeedPostWithReplies = FeedPost & { replies: FeedPost[] };

type ActionItem = {
  id: string; text: string; tag: string; status: string; createdAt: string;
  sessionId: string; addedById: string; namId: string; amId: string;
  withUserName: string; addedByName: string;
};
type TrendingAccount = { name: string; delta: number; isNew?: boolean; companyId?: string };
type TrendingResponse = { up: TrendingAccount[]; down: TrendingAccount[]; monthFraction?: number; isPartialMonth?: boolean; curMonthLabel?: string };
type StaleAccount = { id: string; name: string; daysSince: number };
type TodaysFiveItem = { id: string; name: string; daysSince: number | null; openTasks: number; hasUrgentRfp: boolean; score: number; reasons: string[] };
type AmRow = { id: string; name: string; touchesWeek: number; touchesMonth: number; coldAccounts: number; openTasks: number; companyCount: number; goalPct: number | null; goalTarget: number | null };
type TeamActivity = { touches: number; meaningful: number; newContacts: number };
type RelationshipsMovedData = { count: number };
type MarginUserMetric = {
  userId: string; name: string; role: string; margin: number;
  goal: { id: string; target: number } | null;
};
type MarginMetrics = { nams: MarginUserMetric[]; ams: MarginUserMetric[] };
type PersonalMetrics = { relationshipsMovedThisMonth: number; meaningfulToday: number; contactsAddedToday: number; touchesToday: number };
type WeeklyRep = { userId: string; name: string; total: number; call: number; email: number; text: number; site_visit: number; meaningful: number };
type OpportunityLog = { id: string; repId: string; companyId: string | null; type: string; category: string; title: string; description: string | null; estimatedLoads: number | null; estimatedValue: string | null; loggedAt: string; createdAt: string };

const METRIC_LABELS: Record<string, string> = {
  contacts_added: "New Contacts",
  touchpoints: "Touchpoints",
  meaningful_touchpoints: "Meaningful Touchpoints",
  load_count: "Load Count",
  margin: "Margin",
  custom: "Custom",
};

function getMetricLabel(metric: string, customLabel?: string | null): string {
  if (metric === "custom") return customLabel || "Custom Metric";
  return METRIC_LABELS[metric] || metric;
}

function dueDateBadge(dueDate: string | null) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);

  let color = "bg-muted text-muted-foreground";
  if (diffDays < 0) color = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  else if (diffDays === 0) color = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";

  const label = diffDays < 0 ? `${Math.abs(diffDays)}d overdue` : diffDays === 0 ? "Today" : `${diffDays}d`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium ${color}`}>
      <Calendar className="h-3 w-3" />
      {label}
    </span>
  );
}

const statusIcon = (status: string) => {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "in_progress") return <PlayCircle className="h-4 w-4 text-blue-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
};

const nextStatus = (s: string) => s === "open" ? "in_progress" : s === "in_progress" ? "completed" : "open";

function MarginGoalEditButton({ userId, goalId, currentTarget, onSave }: {
  userId: string;
  goalId: string | null;
  currentTarget: number;
  onSave: (target: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentTarget > 0 ? String(Math.round(currentTarget)) : "");

  const handleSave = () => {
    const n = parseFloat(value.replace(/,/g, ""));
    if (!isNaN(n) && n > 0) {
      onSave(n);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          title={goalId ? "Edit margin goal" : "Set margin goal"}
          data-testid={`button-edit-margin-goal-${userId}`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <p className="text-xs font-semibold mb-2">Monthly Margin Goal</p>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            step={1000}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="e.g. 50000"
            className="h-8 text-sm"
            onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setOpen(false); }}
            data-testid={`input-margin-goal-${userId}`}
            autoFocus
          />
          <Button size="sm" className="h-8 px-2" onClick={handleSave} data-testid={`button-save-margin-goal-${userId}`}>
            Save
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">Enter target margin in dollars for this month.</p>
      </PopoverContent>
    </Popover>
  );
}

function ProcurementTaskSummary({ lane, taskId }: { lane: ProcurementLaneInfo; taskId: string }) {
  const { data: carriers = [] } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/tasks", taskId, "lane-carriers"],
    staleTime: 2 * 60 * 1000,
  });
  const laneName = lane.lane;
  const activeCount = carriers.filter((c: LaneCarrier) => c.lane === laneName && c.status !== "declined").length;
  const committedCount = carriers.filter((c: LaneCarrier) => c.lane === laneName && c.status === "committed").length;

  let coverageColor = "bg-red-500/10 text-red-700 dark:text-red-400";
  if (activeCount >= 5) coverageColor = "bg-green-500/10 text-green-700 dark:text-green-400";
  else if (activeCount > 0) coverageColor = "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";

  return (
    <div className="mt-1.5 space-y-1" data-testid={`procurement-summary-${taskId}`}>
      {(lane.customerName || lane.awardTitle) && (
        <div className="flex items-center gap-2 flex-wrap">
          {lane.customerName && (
            <span className="text-xs text-muted-foreground font-medium" data-testid={`text-proc-customer-${taskId}`}>{lane.customerName}</span>
          )}
          {lane.awardTitle && (
            <span className="text-xs text-muted-foreground" data-testid={`text-proc-award-${taskId}`}>· {lane.awardTitle}</span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Route className="h-3 w-3" />
          <span data-testid={`text-proc-lane-${taskId}`}>{lane.origin} → {lane.destination}</span>
        </div>
        {lane.volume > 0 && (
          <span className="text-xs text-muted-foreground">{Number(lane.volume).toLocaleString()} loads/yr</span>
        )}
        {lane.rate && (
          <span className="text-xs text-muted-foreground">${lane.rate}/load</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={`text-xs h-5 px-1.5 ${coverageColor}`} data-testid={`badge-proc-coverage-${taskId}`}>
          <Truck className="h-2.5 w-2.5 mr-1" />
          {committedCount}/{activeCount} committed · {activeCount}/5 contacted
        </Badge>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [viewContact, setViewContact] = useState<Contact | null>(null);
  const [composeContact, setComposeContact] = useState<{ email: string; name: string; companyName: string; contactId?: string; companyId?: string } | null>(null);
  const [feedContent, setFeedContent] = useState("");
  const [feedCategory, setFeedCategory] = useState<"trend" | "growth" | "idea" | "celebrate">("idea");
  const [mentionState, setMentionState] = useState<{ mentionStart: number; query: string } | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [feedExpanded, setFeedExpanded] = useState(false);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const [feedPendingFiles, setFeedPendingFiles] = useState<PendingFile[]>([]);
  const feedTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [feedSearch, setFeedSearch] = useState("");
  const [selectedDirectorId, setSelectedDirectorId] = useState<string | null>(null);
  const [activePortlet, setActivePortlet] = useState<{ type: PortletType; personal: boolean; title: string } | null>(null);
  const [feedAuthorFilter, setFeedAuthorFilter] = useState("all");
  const [ptoBannerDismissed, setPtoBannerDismissed] = useState(false);
  const [touchpointsTodayCollapsed, setTouchpointsTodayCollapsed] = useState(() => localStorage.getItem("dash_touchpoints_today_collapsed") === "true");
  const toggleTouchpointsToday = () => {
    setTouchpointsTodayCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("dash_touchpoints_today_collapsed", String(next));
      return next;
    });
  };
  const [tasksCollapsed, setTasksCollapsed] = useState(() => localStorage.getItem("dash_tasks_collapsed") === "true");
  const [feedCollapsed, setFeedCollapsed] = useState(() => localStorage.getItem("dash_feed_collapsed") === "true");
  const [lmCheckInsGroupCollapsed, setLmCheckInsGroupCollapsed] = useState(() => localStorage.getItem("dash_lm_checkins_group_collapsed") === "true");
  const toggleLmCheckInsGroup = () => {
    setLmCheckInsGroupCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("dash_lm_checkins_group_collapsed", String(next));
      return next;
    });
  };

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: coldContacts = [] } = useQuery<Array<{ contact: Contact; company: { id: string; name: string }; daysSince: number; lastType: string | null }>>({
    queryKey: ["/api/dashboard/cold-contacts"],
  });

  const { data: meaningfulOverdue = [] } = useQuery<Array<{ contact: Contact; company: { id: string; name: string }; daysSinceLastMeaningful: number }>>({
    queryKey: ["/api/dashboard/meaningful-overdue"],
  });

  const { data: opportunityLeaderboard = [] } = useQuery<Array<{ companyId: string; companyName: string; potentialMargin: number; currentLoads: number; rfpVolume: number | null; hasRfp: boolean }>>({
    queryKey: ["/api/dashboard/opportunity-leaderboard"],
    refetchOnWindowFocus: false,
  });

  const isLmRole = currentUser?.role === "logistics_manager" || currentUser?.role === "logistics_coordinator";
  const { data: churnRisk = [] } = useQuery<Array<{ companyId: string; companyName: string; repName: string | null; curLoads: number; priorLoads: number; dropPct: number }>>({
    queryKey: ["/api/dashboard/churn-risk"],
    refetchOnWindowFocus: false,
    enabled: !isLmRole,
  });

  const { data: allTasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
    refetchInterval: 180000,
  });

  const canSeeTeam = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales" || currentUser?.role === "sales_director";

  const { data: missingMonthlyGoals = [] } = useQuery<Array<{ amId: string; amName: string }>>({
    queryKey: ["/api/goals/monthly-check"],
    enabled: canSeeTeam,
    refetchOnWindowFocus: false,
  });

  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/users"],
    enabled: canSeeTeam,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: lmDirectReports = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/lm-direct-reports"],
    enabled: currentUser?.role !== "logistics_manager" && currentUser?.role !== "logistics_coordinator",
  });

  const { data: feedPosts = [], isLoading: feedLoading } = useQuery<FeedPostWithReplies[]>({
    queryKey: ["/api/feed-posts"],
    refetchInterval: 180000,
  });

  const { data: passoffs = [] } = useQuery<any[]>({
    queryKey: ["/api/pto-passoffs"],
  });

  const { data: syncAlert } = useQuery<{ failed: boolean; month?: string; error?: string }>({
    queryKey: ["/api/sync-alert"],
    enabled: currentUser?.role === "admin",
  });

  const { data: billingInfo } = useQuery<{ billingStatus: string | null; planName: string | null } | null>({
    queryKey: ["/api/admin/billing"],
    enabled: currentUser?.role === "admin",
    staleTime: 5 * 60 * 1000,
  });
  const [billingBannerDismissed, setBillingBannerDismissed] = useState(false);
  const showBillingBanner = !billingBannerDismissed &&
    currentUser?.role === "admin" &&
    (billingInfo?.billingStatus === "trialing" || billingInfo?.billingStatus === "past_due");

  const { data: allRfps = [] } = useQuery<any[]>({
    queryKey: ["/api/rfps"],
  });

  const { data: oneOnOnePendingData } = useQuery<{ count: number }>({
    queryKey: ["/api/one-on-one/pending-count"],
    refetchInterval: 90000,
  });

  const { data: actionItems = [] } = useQuery<ActionItem[]>({
    queryKey: ["/api/one-on-one/action-items"],
    refetchInterval: 90000,
  });

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
  });

  const { data: myGoals = [] } = useQuery<any[]>({
    queryKey: ["/api/goals"],
    refetchInterval: 120000,
    enabled: !isLmRole,
  });

  const isDirector = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director";
  const isNam = currentUser?.role === "national_account_manager" || currentUser?.role === "sales";
  const isAm = currentUser?.role === "account_manager";

  const [, setLocation] = useLocation();

  // Collapsible state for director/NAM portlets
  const [trendingUpCollapsed, setTrendingUpCollapsed] = useState(false);
  const [trendingDownCollapsed, setTrendingDownCollapsed] = useState(false);
  const [namMarginCollapsed, setNamMarginCollapsed] = useState(false);
  const [amMarginCollapsed, setAmMarginCollapsed] = useState(false);
  const [namTrendingUpCollapsed, setNamTrendingUpCollapsed] = useState(false);
  const [namTrendingDownCollapsed, setNamTrendingDownCollapsed] = useState(false);
  const [amTrendingUpCollapsed, setAmTrendingUpCollapsed] = useState(false);
  const [amTrendingDownCollapsed, setAmTrendingDownCollapsed] = useState(false);

  // Collapsible state for list portlets — initialized after user loads (role-based defaults)
  const [recentWinsCollapsed, setRecentWinsCollapsed] = useState(false);
  const [coldContactsCollapsed, setColdContactsCollapsed] = useState(false);
  const [meaningfulOverdueCollapsed, setMeaningfulOverdueCollapsed] = useState(false);
  const [topOppsCollapsed, setTopOppsCollapsed] = useState(false);
  const [churnRiskCollapsed, setChurnRiskCollapsed] = useState(false);
  const [rfpDeadlineCollapsed, setRfpDeadlineCollapsed] = useState(false);
  const [goalsNudgeCollapsed, setGoalsNudgeCollapsed] = useState(false);
  const [goalsAlertCollapsed, setGoalsAlertCollapsed] = useState(false);
  const portletDefaultsApplied = useRef(false);
  const togglePortlet = (key: string, val: boolean, setter: (v: boolean) => void) => {
    setter(val);
    localStorage.setItem(key, String(val));
  };

  const isAdmin = currentUser?.role === "admin";
  const directorFilterParam = isAdmin && selectedDirectorId ? `?directorId=${encodeURIComponent(selectedDirectorId)}` : "";

  const { layout, saveLayout, isVisible, getOrder, resetLayout } = useDashboardLayout(currentUser?.id);
  const [layoutPanelOpen, setLayoutPanelOpen] = useState(false);

  // Apply role-based portlet defaults once after user loads — directors default to collapsed
  useEffect(() => {
    if (portletDefaultsApplied.current || !currentUser) return;
    portletDefaultsApplied.current = true;
    const dirDefault = isDirector;
    const lp = (key: string, setter: (v: boolean) => void) => {
      const stored = localStorage.getItem(key);
      if (stored !== null) setter(stored === "true");
      else if (dirDefault) setter(true);
    };
    lp("dash_recent_wins_collapsed", setRecentWinsCollapsed);
    lp("dash_cold_contacts_collapsed", setColdContactsCollapsed);
    lp("dash_meaningful_overdue_collapsed", setMeaningfulOverdueCollapsed);
    lp("dash_top_opps_collapsed", setTopOppsCollapsed);
    lp("dash_churn_risk_collapsed", setChurnRiskCollapsed);
    lp("dash_rfp_deadline_collapsed", setRfpDeadlineCollapsed);
    lp("dash_goals_nudge_collapsed", setGoalsNudgeCollapsed);
    lp("dash_goals_alert_collapsed", setGoalsAlertCollapsed);
  }, [currentUser, isDirector]);

  const { data: trendingAccounts, isLoading: trendingLoading } = useQuery<TrendingResponse>({
    queryKey: ["/api/dashboard/trending-accounts", selectedDirectorId],
    queryFn: async () => { const r = await fetch(`/api/dashboard/trending-accounts${directorFilterParam}`, { credentials: "include" }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    enabled: isDirector,
    refetchOnWindowFocus: false,
  });

  // NAM and AM each get their own scoped trending accounts query
  const { data: namTrendingAccounts, isLoading: namTrendingLoading } = useQuery<TrendingResponse>({
    queryKey: ["/api/dashboard/trending-accounts"],
    enabled: isNam,
    refetchOnWindowFocus: false,
  });

  const { data: amTrendingAccounts, isLoading: amTrendingLoading } = useQuery<TrendingResponse>({
    queryKey: ["/api/dashboard/trending-accounts"],
    enabled: isAm,
    refetchOnWindowFocus: false,
  });

  const { data: staleAccountsData } = useQuery<{ stale: StaleAccount[] }>({
    queryKey: ["/api/dashboard/stale-accounts"],
    enabled: isAm || isNam,
    staleTime: 300000,
  });
  const staleAccounts = staleAccountsData?.stale ?? [];

  const { data: todaysFive = [], isLoading: todaysFiveLoading } = useQuery<TodaysFiveItem[]>({
    queryKey: ["/api/dashboard/todays-five"],
    enabled: isAm,
    staleTime: 120000,
  });

  const { data: amComparison = [], isLoading: amComparisonLoading } = useQuery<AmRow[]>({
    queryKey: ["/api/dashboard/am-comparison", selectedDirectorId],
    queryFn: async () => { const r = await fetch(`/api/dashboard/am-comparison${directorFilterParam}`, { credentials: "include" }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    enabled: isNam || isDirector,
    staleTime: 120000,
  });

  const { data: teamActivity, isLoading: teamActivityLoading } = useQuery<TeamActivity>({
    queryKey: ["/api/dashboard/team-activity", selectedDirectorId],
    queryFn: async () => { const r = await fetch(`/api/dashboard/team-activity${directorFilterParam}`, { credentials: "include" }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    enabled: isDirector,
    refetchInterval: 120000,
  });

  const { data: namTeamActivity, isLoading: namTeamActivityLoading } = useQuery<TeamActivity>({
    queryKey: ["/api/dashboard/team-activity"],
    enabled: isNam,
    refetchInterval: 120000,
  });

  const { data: relationshipsMoved, isLoading: relationshipsMovedLoading } = useQuery<RelationshipsMovedData>({
    queryKey: ["/api/dashboard/relationships-moved", selectedDirectorId],
    queryFn: async () => { const r = await fetch(`/api/dashboard/relationships-moved${directorFilterParam}`, { credentials: "include" }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    enabled: isDirector,
    refetchInterval: 120000,
  });

  const { data: namRelationshipsMoved, isLoading: namRelationshipsMovedLoading } = useQuery<RelationshipsMovedData>({
    queryKey: ["/api/dashboard/relationships-moved"],
    enabled: isNam,
    refetchInterval: 120000,
  });

  const { data: marginMetrics, isLoading: marginMetricsLoading } = useQuery<MarginMetrics>({
    queryKey: ["/api/dashboard/margin-metrics", selectedDirectorId],
    queryFn: async () => { const r = await fetch(`/api/dashboard/margin-metrics${directorFilterParam}`, { credentials: "include" }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); },
    enabled: isDirector,
    refetchInterval: 120000,
  });

  const { data: namMarginMetrics, isLoading: namMarginMetricsLoading } = useQuery<MarginMetrics>({
    queryKey: ["/api/dashboard/margin-metrics"],
    enabled: isNam,
    refetchInterval: 120000,
  });

  const { data: personalMetrics, isLoading: personalMetricsLoading } = useQuery<PersonalMetrics>({
    queryKey: ["/api/dashboard/personal-metrics"],
    enabled: isNam || isAm,
    refetchInterval: 120000,
  });

  const { data: leaderboard = [], isLoading: leaderboardLoading } = useQuery<{
    metric: string;
    customLabel: string | null;
    entries: { rank: number; amId: string; amName: string; currentValue: number; target: number; pct: number }[];
  }[]>({
    queryKey: ["/api/goals/leaderboard"],
    enabled: canSeeTeam,
    refetchInterval: 120000,
  });

  const { data: weeklyData, isLoading: weeklyLoading } = useQuery<{ weekStart: string; results: WeeklyRep[] }>({
    queryKey: ["/api/leaderboard/weekly-touchpoints"],
    enabled: canSeeTeam,
    refetchInterval: 5 * 60 * 1000,
  });
  const weeklyResults = weeklyData?.results || [];

  const recentWinsStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  const { data: recentWins = [] } = useQuery<OpportunityLog[]>({
    queryKey: ["/api/opportunity-logs", "win", recentWinsStart],
    queryFn: async () => {
      const r = await fetch(`/api/opportunity-logs?type=win&startDate=${recentWinsStart}`, { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: isDirector || isNam,
    staleTime: 60000,
  });

  const [taskPrefill, setTaskPrefill] = useState<{ title?: string; companyId?: string } | undefined>();
  const [prefillDialogOpen, setPrefillDialogOpen] = useState(false);
  const [briefingDismissed, setBriefingDismissed] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return localStorage.getItem("briefing_dismissed") === today;
  });

  const { data: streakData } = useQuery<{ streak: number; goal: number; todayCount: number }>({
    queryKey: ["/api/users/streak"],
    refetchInterval: 300000,
  });

  const { data: briefingData } = useQuery<{
    skip?: boolean;
    dueTasks?: number;
    todayTouchpoints?: number;
    streak?: number;
    streakGoal?: number;
    streakToday?: number;
    goals?: { metric: string; label: string; current: number; target: number }[];
  }>({
    queryKey: ["/api/dashboard/briefing"],
    enabled: !briefingDismissed,
    staleTime: 60000,
  });

  const dismissBriefing = () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem("briefing_dismissed", today);
    setBriefingDismissed(true);
  };

  const dismissSyncAlertMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sync-alert/dismiss"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync-alert"] });
    },
  });

  const feedPostIds = feedPosts.map(p => p.id);
  const { data: feedReactions = [] } = useQuery<FeedPostReaction[]>({
    queryKey: ["/api/feed/reactions", feedPostIds.join(",")],
    queryFn: async () => {
      if (feedPostIds.length === 0) return [];
      const res = await fetch(`/api/feed/reactions?ids=${feedPostIds.join(",")}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch feed reactions");
      return res.json();
    },
    enabled: feedPostIds.length > 0,
  });

  const toggleFeedReactionMutation = useMutation({
    mutationFn: async ({ postId, emoji }: { postId: string; emoji: string }) => {
      const res = await apiRequest("POST", `/api/feed/${postId}/reactions`, { emoji });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed/reactions"] });
    },
  });

  const createFeedPostMutation = useMutation({
    mutationFn: async (data: { content: string; category: string }) => {
      const res = await apiRequest("POST", "/api/feed-posts", data);
      const post = await res.json();
      if (feedPendingFiles.length > 0) {
        try {
          await uploadPendingFiles(feedPendingFiles, "feed_post", post.id);
        } catch {
          toast({ title: "Post created but some files failed to upload", variant: "destructive" });
        }
      }
      return post;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed-posts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setFeedContent("");
      setFeedPendingFiles([]);
      toast({ title: "Posted successfully" });
    },
    onError: () => {
      toast({ title: "Failed to post", variant: "destructive" });
    },
  });

  const createReplyMutation = useMutation({
    mutationFn: async (data: { content: string; parentId: string }) => {
      const res = await apiRequest("POST", "/api/feed-posts", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed-posts"] });
      setReplyContent("");
      setReplyingTo(null);
    },
    onError: () => {
      toast({ title: "Failed to post reply", variant: "destructive" });
    },
  });

  const deleteFeedPostMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/feed-posts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed-posts"] });
      toast({ title: "Post deleted" });
    },
  });

  const canPin = ["admin", "director", "national_account_manager", "sales_director"].includes(currentUser?.role ?? "");

  const pinFeedPostMutation = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      await apiRequest("PATCH", `/api/feed-posts/${id}/pin`, { pinned });
    },
    onSuccess: (_data, { pinned }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed-posts"] });
      toast({ title: pinned ? "Post pinned to top" : "Post unpinned" });
    },
  });

  const getAuthorName = (authorId: string) => teamMembers.find(u => u.id === authorId)?.name || "Unknown";

  const detectMention = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const match = before.match(/@(\w*)$/);
    if (!match) return null;
    return { mentionStart: cursor - match[0].length, query: match[1].toLowerCase() };
  };

  const mentionableUsers: SafeUser[] = teamMembers.filter(u =>
    mentionState && u.name.toLowerCase().includes(mentionState.query)
  ).slice(0, 5);

  const handleFeedChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setFeedContent(val);
    const cursor = e.target.selectionStart ?? val.length;
    const found = detectMention(val, cursor);
    setMentionState(found);
    setSelectedMentionIdx(0);
  }, []);

  const insertMention = useCallback((user: SafeUser) => {
    if (!mentionState) return;
    const before = feedContent.slice(0, mentionState.mentionStart);
    const after = feedContent.slice(feedContent.indexOf(" ", mentionState.mentionStart + mentionState.query.length + 1));
    const tag = `@${user.name} `;
    const newVal = before + tag + (after.startsWith(" ") ? after.slice(1) : after);
    setFeedContent(newVal);
    setMentionState(null);
    setTimeout(() => feedTextareaRef.current?.focus(), 0);
  }, [feedContent, mentionState]);

  const handleFeedKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState && e.key === "Escape") { setMentionState(null); return; }
    if (mentionState && mentionableUsers.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedMentionIdx(i => Math.min(i + 1, mentionableUsers.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedMentionIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mentionableUsers[selectedMentionIdx]); return; }
    }
    if (!mentionState && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmitFeed();
    }
  }, [mentionState, mentionableUsers, selectedMentionIdx]);

  const handleSubmitFeed = () => {
    const trimmed = feedContent.trim();
    if (!trimmed) return;
    createFeedPostMutation.mutate({ content: trimmed, category: feedCategory });
  };

  const handleFeedPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const results: PendingFile[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: "Pasted image is too large (max 10MB)", variant: "destructive" });
        continue;
      }
      const namedFile = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
      const base64 = await fileToBase64(namedFile);
      results.push({ file: namedFile, base64 });
    }
    if (results.length > 0) setFeedPendingFiles(prev => [...prev, ...results]);
  }, [toast]);

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };


  const isLoading = companiesLoading || contactsLoading;

  // T004: RFP deadline warnings — within 14 days or overdue
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const urgentRfps = allRfps.filter((r: any) => {
    if (!r.dueDate || r.status === "awarded" || r.status === "partially_awarded" || r.status === "lost" || r.status === "declined") return false;
    const due = new Date(r.dueDate + "T00:00:00");
    const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
    return diffDays <= 14;
  }).sort((a: any, b: any) => a.dueDate.localeCompare(b.dueDate));

  // T005: Goals mid-month nudge — after 15th, flag active goals < 50% progress
  const dayOfMonth = new Date().getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const behindGoals = dayOfMonth >= 15
    ? myGoals.filter((g: any) => {
        // Only flag goals whose date range covers today
        if (g.startDate > todayStr || g.endDate < todayStr) return false;
        const target = parseFloat(g.target || "0");
        // Use auto-computed value (from financial data / touchpoints / contacts) when available
        const current = g.computedValue != null ? g.computedValue : parseFloat(g.currentValue || "0");
        return target > 0 && current / target < 0.5;
      })
    : [];

  // T007: 1:1 pending topics count
  const pendingTopicsCount = oneOnOnePendingData?.count ?? 0;

  // Null-safe notifications array (API may return null if session briefly 401s during restart)
  const safeNotifications = notifications ?? [];

  // Unread notification counts per portlet — drives activity badges
  const unread = {
    tasks:    safeNotifications.filter(n => !n.read && ["task_assigned","task_comment","task_completed","task_reminder"].includes(n.type)).length,
    feed:     safeNotifications.filter(n => !n.read && ["post_reply","new_post"].includes(n.type)).length,
    oneOnOne: safeNotifications.filter(n => !n.read && ["topic_added","topic_reply","session_closed"].includes(n.type)).length,
    goals:    safeNotifications.filter(n => !n.read && ["goal_set","goal_updated","goal_comment"].includes(n.type)).length,
  };

  // Map task IDs to their unread notifications so we can surface alerts inside the portlet
  const taskAssignedNotifMap = new Map(
    safeNotifications.filter(n => !n.read && n.type === "task_assigned" && n.relatedId).map(n => [n.relatedId!, n])
  );
  const taskCommentNotifIds = new Set(
    safeNotifications.filter(n => !n.read && n.type === "task_comment" && n.relatedId).map(n => n.relatedId!)
  );

  const myTasks = allTasks
    .filter(t => t.assignedTo === currentUser?.id)
    .sort((a, b) => {
      if (a.status === "completed" && b.status !== "completed") return 1;
      if (a.status !== "completed" && b.status === "completed") return -1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  const openTasks = myTasks.filter(t => t.status !== "completed");
  const completedCount = myTasks.filter(t => t.status === "completed").length;
  const displayTasks = openTasks.slice(0, 10);

  // Split open tasks into "incoming" (assigned by others, not yet acknowledged) and regular
  const incomingTasks = displayTasks.filter(t => t.assignedBy !== currentUser?.id && taskAssignedNotifMap.has(t.id));
  const regularTasks = displayTasks.filter(t => !incomingTasks.includes(t));

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiRequest("PATCH", `/api/tasks/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const markNotifReadMutation = useMutation({
    mutationFn: async (notifId: string) => {
      await apiRequest("PATCH", `/api/notifications/${notifId}/read`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Task deleted" });
    },
  });

  const setMarginGoalMutation = useMutation({
    mutationFn: async ({ userId, goalId, target }: { userId: string; goalId: string | null; target: number }) => {
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      if (goalId) {
        const res = await apiRequest("PATCH", `/api/goals/${goalId}`, { target: String(target) });
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/goals", {
          amId: userId,
          metric: "margin",
          period: "monthly",
          target: String(target),
          startDate,
          endDate,
          title: `Margin Goal – ${now.toLocaleString("default", { month: "long", year: "numeric" })}`,
        });
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/margin-metrics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      toast({ title: "Margin goal saved" });
    },
    onError: () => {
      toast({ title: "Failed to save margin goal", variant: "destructive" });
    },
  });

  const getUserName = (userId: string) => teamMembers.find(u => u.id === userId)?.name || "";
  const getCompanyName = (companyId: string | null) => companyId ? companies?.find(c => c.id === companyId)?.name || "" : "";

  const totalFreightSpend = contacts?.reduce((acc, c) => {
    return acc + (c.freightSpend ? parseFloat(c.freightSpend) : 0);
  }, 0) || 0;

  const uniqueRegions = new Set(
    contacts?.flatMap((c) => c.regions || []) || []
  );

  const stats = [
    {
      title: "Total Companies",
      value: companies?.length || 0,
      icon: Building2,
      description: "Active accounts",
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-100 dark:bg-blue-900/30",
    },
    {
      title: "Total Contacts",
      value: contacts?.length || 0,
      icon: Users,
      description: "People tracked",
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-100 dark:bg-green-900/30",
    },
    {
      title: "Regions Covered",
      value: uniqueRegions.size,
      icon: MapPin,
      description: "Geographic coverage",
      color: "text-purple-600 dark:text-purple-400",
      bg: "bg-purple-100 dark:bg-purple-900/30",
    },
    {
      title: "Total Freight Spend",
      value: `$${(totalFreightSpend / 1000000).toFixed(1)}M`,
      icon: DollarSign,
      description: "Combined annual spend",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-100 dark:bg-emerald-900/30",
    },
    ...(streakData ? [{
      title: "Touch Streak",
      value: streakData.streak > 0 ? `🔥 ${streakData.streak}d` : `${streakData.todayCount}/${streakData.goal}`,
      icon: Target,
      description: streakData.streak > 0 ? `${streakData.todayCount}/${streakData.goal} today` : "Touches today / goal",
      color: "text-orange-600 dark:text-orange-400",
      bg: "bg-orange-100 dark:bg-orange-900/30",
    }] : []),
  ];

  const nams = allUsers.filter((u) => u.role === "national_account_manager" || u.role === "director" || u.role === "sales" || u.role === "sales_director");
  const ams = allUsers.filter((u) => u.role === "account_manager" || u.role === "logistics_manager" || u.role === "logistics_coordinator");

  const companyCountFor = (userId: string) =>
    companies?.filter((c) => c.assignedTo === userId).length ?? 0;

  const managerNameFor = (managerId: string | null) => {
    if (!managerId) return null;
    return allUsers.find((u) => u.id === managerId)?.name ?? null;
  };

  const UserRow = ({ user }: { user: SafeUser }) => {
    const count = companyCountFor(user.id);
    const initials = user.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
    const manager = managerNameFor(user.managerId);
    return (
      <Link
        href={`/reps/${user.id}`}
        className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 hover:border-border border border-transparent transition-all group cursor-pointer"
        data-testid={`row-user-${user.id}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900/40 dark:to-green-900/40 text-blue-700 dark:text-blue-300 font-semibold text-sm">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-sm truncate group-hover:text-primary transition-colors" data-testid={`text-user-name-${user.id}`}>{user.name}</p>
            <p className="text-xs text-muted-foreground truncate">{user.username}</p>
            {manager && (
              <p className="text-xs text-muted-foreground/70 truncate">Reports to: {manager}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="text-right">
            <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">{count}</p>
            <p className="text-xs text-muted-foreground">{count === 1 ? "account" : "accounts"}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-3 sm:p-6">

      {/* Daily Briefing Popup — hidden for management roles via skip flag */}
      {!briefingDismissed && briefingData && !briefingData.skip && (
        <div className="flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 p-4" data-testid="banner-daily-briefing">
          <BellRing className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-indigo-800 dark:text-indigo-200">
              Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, {currentUser?.name?.split(" ")[0]}! Here's your day at a glance.
            </p>
            <div className="flex flex-wrap gap-3 mt-1.5">
              {(briefingData.dueTasks ?? 0) > 0 && (
                <span className="text-xs text-indigo-700 dark:text-indigo-300 flex items-center gap-1">
                  <ListTodo className="h-3.5 w-3.5" />
                  {briefingData.dueTasks} task{briefingData.dueTasks !== 1 ? "s" : ""} due today
                </span>
              )}
              {/* Daily streak — always shown, based on 5 touches/day goal */}
              <span className="text-xs text-indigo-700 dark:text-indigo-300 flex items-center gap-1">
                <PhoneCall className="h-3.5 w-3.5" />
                {briefingData.streakToday}/{briefingData.streakGoal} touches today
              </span>
              {/* Monthly goal metrics set by NAM — shown in addition to streak */}
              {briefingData.goals && briefingData.goals.length > 0 && (
                briefingData.goals.map(g => (
                  <span key={g.metric} className="text-xs text-indigo-700 dark:text-indigo-300 flex items-center gap-1">
                    <Target className="h-3.5 w-3.5" />
                    {g.current}/{g.target} {g.label} this month
                  </span>
                ))
              )}
              {(briefingData.streak ?? 0) > 0 && (
                <span className="text-xs text-orange-600 dark:text-orange-400 font-semibold flex items-center gap-1">
                  🔥 {briefingData.streak}-day streak!
                </span>
              )}
            </div>
          </div>
          <button onClick={dismissBriefing} className="shrink-0 text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300" data-testid="button-dismiss-briefing">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {syncAlert?.failed && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/50 p-4" data-testid="banner-sync-failed">
          <CloudOff className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-red-800 dark:text-red-300">Monthly data refresh failed</p>
            <p className="text-sm text-red-700 dark:text-red-400 mt-0.5">
              The automatic OneDrive sync for {syncAlert.month} could not complete: {syncAlert.error}
            </p>
            <Link href="/financials">
              <Button size="sm" variant="outline" className="mt-2 gap-1.5 text-red-700 border-red-300 hover:bg-red-100 dark:text-red-300 dark:border-red-800 dark:hover:bg-red-900/50" data-testid="button-upload-manually">
                <Upload className="h-3.5 w-3.5" />
                Upload manually
              </Button>
            </Link>
          </div>
          <button
            onClick={() => dismissSyncAlertMutation.mutate()}
            className="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-300"
            data-testid="button-dismiss-sync-alert"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {showBillingBanner && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-4" data-testid="banner-billing-alert">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-amber-800 dark:text-amber-200">
              {billingInfo?.billingStatus === "past_due" ? "Subscription payment past due" : "Trial period active"}
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-0.5">
              {billingInfo?.billingStatus === "past_due"
                ? "Your subscription payment could not be processed. Update your payment method to avoid service interruption."
                : `You're on a trial${billingInfo?.planName ? ` of ${billingInfo.planName}` : ""}. Visit the Admin panel to manage your subscription.`}
            </p>
            <Link href="/admin/users">
              <Button size="sm" variant="outline" className="mt-2 gap-1.5 text-amber-700 border-amber-300 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-700 dark:hover:bg-amber-900/50" data-testid="button-billing-manage">
                Manage Subscription
              </Button>
            </Link>
          </div>
          <button onClick={() => setBillingBannerDismissed(true)} className="shrink-0 text-amber-400 hover:text-amber-600 dark:hover:text-amber-300" data-testid="button-dismiss-billing-banner">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* PTO Compact Coverage Alert — top of page */}
      {!ptoBannerDismissed && currentUser && (() => {
        const covering = passoffs.filter((p: any) => p.coveringUserId === currentUser.id && p.status === "active");
        if (!covering.length) return null;
        return covering.map((passoff: any) => {
          const owner = allUsers.find((u: any) => u.id === passoff.createdById) || teamMembers.find((u: any) => u.id === passoff.createdById);
          const highCount = (passoff.items || []).filter((i: any) => i.priority === "high").length;
          return (
            <div key={passoff.id} className="flex items-center gap-3 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 px-4 py-2.5" data-testid={`banner-pto-covering-${passoff.id}`}>
              <Plane className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  You're covering for {owner?.name ?? "a teammate"}
                </span>
                <span className="text-sm text-blue-600 dark:text-blue-400 ml-2">
                  {(passoff.items || []).length} account{(passoff.items || []).length !== 1 ? "s" : ""}{highCount > 0 ? ` · ${highCount} high priority` : ""} · {passoff.startDate} – {passoff.endDate}
                </span>
              </div>
              <Link href="/pto-passoff">
                <Button size="sm" variant="ghost" className="h-7 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 shrink-0" data-testid={`button-pto-banner-view-${passoff.id}`}>
                  View →
                </Button>
              </Link>
              <button onClick={() => setPtoBannerDismissed(true)} className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 shrink-0" data-testid="button-dismiss-pto-banner">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        });
      })()}

      {/* Hero Banner */}
      <div
        className="relative overflow-hidden rounded-xl px-4 py-4 sm:px-6 sm:py-5 text-white"
        style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}
        data-testid="banner-hero"
      >
        {/* decorative gold glow circles */}
        <div className="pointer-events-none absolute -top-10 -right-10 h-48 w-48 rounded-full" style={{ background: "rgba(255,180,0,0.04)" }} />
        <div className="pointer-events-none absolute -bottom-8 -right-4 h-32 w-32 rounded-full" style={{ background: "rgba(255,180,0,0.03)" }} />

        <div className="relative flex items-center gap-4">
          {/* Left: greeting */}
          <div className="shrink-0">
            <p className="text-xs font-medium tracking-widest uppercase mb-1" style={{ color: "#ffb400" }}>
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <h2 className="text-xl font-bold leading-tight text-white">
              {(() => {
                const h = new Date().getHours();
                const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
                const first = currentUser?.name?.split(" ")[0];
                return first ? `${greeting}, ${first}` : greeting;
              })()}
            </h2>
            <p className="mt-1.5 text-sm tracking-wide" style={{ color: "#ffc333" }} data-testid="text-dna-tagline-hero">
              <span className="font-bold">DNA</span>
              <span className="mx-2" style={{ color: "#444" }}>·</span>
              <span className="font-bold">D</span>own <span className="font-bold">N</span>ot <span className="font-bold">A</span>cross
            </p>
          </div>

          {/* Center: briefing chips */}
          {briefingData && (
            <div className="flex-1 flex flex-wrap items-center justify-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                style={{ background: "rgba(255,180,0,0.12)", color: "#ffc333", border: "1px solid rgba(255,180,0,0.2)" }}
                data-testid="text-hero-touches"
              >
                <PhoneCall className="h-3 w-3" />
                {briefingData.streakToday}/{briefingData.streakGoal} touches today
              </span>
              {briefingData.dueTasks > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)", border: "1px solid rgba(255,255,255,0.12)" }}
                  data-testid="text-hero-tasks"
                >
                  <ListTodo className="h-3 w-3" />
                  {briefingData.dueTasks} task{briefingData.dueTasks !== 1 ? "s" : ""} due
                </span>
              )}
              {briefingData.streak > 0 && (
                <span
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-semibold"
                  style={{ background: "rgba(251,146,60,0.15)", color: "#fb923c", border: "1px solid rgba(251,146,60,0.25)" }}
                  data-testid="text-hero-streak"
                >
                  🔥 {briefingData.streak}-day streak
                </span>
              )}
            </div>
          )}

          {/* Right: VT logo + edit layout button */}
          <div className="shrink-0 flex items-center gap-3">
            {isDirector && (
              <button
                onClick={() => setLayoutPanelOpen(true)}
                className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all"
                title="Customize dashboard layout"
                data-testid="button-edit-dashboard-layout"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Customize
              </button>
            )}
            <div
              className="hidden sm:flex items-center justify-center h-16 w-16 rounded-full p-2.5"
              style={{ border: "2px solid #ffb400", background: "#111", boxShadow: "0 0 20px rgba(255,180,0,0.2)" }}
            >
              <img src={vtLogoWhite} alt="Value Truck" className="w-full h-full object-contain" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Outbound Touchpoints Today ──────────────────────────────────────── */}
      <TouchpointsTodayPortlet
        collapsed={touchpointsTodayCollapsed}
        onToggle={toggleTouchpointsToday}
      />

      {/* ── Dashboard Layout Editor ──────────────────────────────────────────── */}
      <DashboardLayoutPanel
        open={layoutPanelOpen}
        onClose={() => setLayoutPanelOpen(false)}
        layout={layout}
        onSave={saveLayout}
        onReset={resetLayout}
      />

      {/* ── Director/Admin Portlets ─────────────────────────────────────────── */}
      <PortletErrorBoundary label="Director metrics">
      {isDirector && (
        <>
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

            {/* Relationships Moved Up */}
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

            {/* Meaningful Conversations Today */}
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

            {/* New Contacts Added Today */}
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

            {/* Touches Today */}
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

            {/* Trending Up */}
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

            {/* Trending Down */}
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
                                  onSave={(t) => setMarginGoalMutation.mutate({ userId: m.userId, goalId: m.goal?.id ?? null, target: t })}
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
                            {win.estimatedLoads && <span className="text-xs text-muted-foreground">· {win.estimatedLoads} loads</span>}
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
      )}
      </PortletErrorBoundary>

      {/* ── NAM Dashboard Portlets ──────────────────────────────────────────── */}
      {isNam && (
        <>
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
                            <span className="text-sm font-bold tabular-nums text-green-700 dark:text-green-400">${Math.round(m.margin).toLocaleString()}</span>
                            {target > 0 && <span className="text-xs text-muted-foreground">/ ${Math.round(target).toLocaleString()}</span>}
                            <MarginGoalEditButton
                              userId={m.userId}
                              goalId={m.goal?.id ?? null}
                              currentTarget={target}
                              onSave={(t) => setMarginGoalMutation.mutate({ userId: m.userId, goalId: m.goal?.id ?? null, target: t })}
                            />
                          </div>
                          {target > 0 && (
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
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
                            {win.estimatedLoads && <span className="text-xs text-muted-foreground">· {win.estimatedLoads} loads</span>}
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

          {/* Stale Accounts Alert — accounts with no touchpoint in 21+ days */}
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
      )}

      {/* ── AM Dashboard Portlets ────────────────────────────────────────────── */}
      {isAm && (
        <>
          {/* Today's 5 — top priority accounts for this AM */}
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

          {/* Stale Accounts Alert — accounts with no touchpoint in 21+ days */}
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
      )}

      {/* LM Career Panel — operational stats + path-to-AM progress */}
      {currentUser?.role === "logistics_manager" && <LmCareerPanel />}

      {/* LM Daily Check-In Portlets */}
      {currentUser?.role === "logistics_manager" && currentUser.id && (
        <LmDailyCheckInPortlets lmUserId={currentUser.id} canEdit={false} />
      )}

      {/* LM Daily Check-In Portlets for managers — full chain visibility */}
      {(() => {
        if (!currentUser || currentUser.role === "logistics_manager") return null;
        const allLms = lmDirectReports.map(lm => ({ lm, canEdit: lm.managerId === currentUser.id }));
        if (allLms.length === 0) return null;
        return (
          <Card data-testid="card-lm-daily-checkins-group">
            <CardHeader className="pb-3">
              <button
                className="flex items-center gap-2 text-left w-full"
                onClick={toggleLmCheckInsGroup}
                data-testid="button-toggle-lm-checkins-group"
              >
                <CardTitle className="text-base">LM Daily Check-Ins</CardTitle>
                {lmCheckInsGroupCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" /> : <ChevronDown className="h-4 w-4 text-muted-foreground ml-auto" />}
              </button>
            </CardHeader>
            {!lmCheckInsGroupCollapsed && (
              <CardContent className="space-y-6 pt-0">
                {allLms.map(({ lm, canEdit }) => (
                  <div key={lm.id} className="space-y-2" data-testid={`section-lm-checkin-${lm.id}`}>
                    <h3 className="text-sm font-semibold text-muted-foreground">{lm.name}</h3>
                    <LmDailyCheckInPortlets lmUserId={lm.id} canEdit={canEdit} />
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        );
      })()}

      {/* PTO Coverage Portlet — only shown to users who are assigned as covering someone */}
      {currentUser && passoffs.filter((p: any) => p.coveringUserId === currentUser.id).map((passoff: any) => {
        const owner = allUsers.find(u => u.id === passoff.createdById);
        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        const sortedItems = [...(passoff.items || [])].sort((a: any, b: any) =>
          (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1)
        );
        const highCount = sortedItems.filter((i: any) => i.priority === "high").length;
        return (
          <Card key={passoff.id} className="border-blue-300 dark:border-blue-700 bg-blue-50/40 dark:bg-blue-950/20" data-testid={`card-pto-coverage-${passoff.id}`}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2 text-blue-700 dark:text-blue-300">
                  <Plane className="h-4 w-4" />
                  You're Covering for {owner?.name ?? "a teammate"}
                </CardTitle>
                <Link href="/pto-passoff">
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 shrink-0" data-testid={`button-view-passoff-${passoff.id}`}>
                    View Full Passoff →
                  </Button>
                </Link>
              </div>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  {passoff.startDate} – {passoff.endDate}
                </span>
                {highCount > 0 && (
                  <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 text-xs font-normal">
                    {highCount} high-priority account{highCount !== 1 ? "s" : ""}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-xs font-normal">
                  {sortedItems.length} account{sortedItems.length !== 1 ? "s" : ""}
                </Badge>
                {passoff.emergencyContact && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Phone className="h-3 w-3" />
                    Emergency: {passoff.emergencyContact}
                  </span>
                )}
              </div>
              {passoff.generalNotes && (
                <p className="text-xs text-muted-foreground mt-1 italic border-l-2 border-blue-300 dark:border-blue-700 pl-2">{passoff.generalNotes}</p>
              )}
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {sortedItems.length === 0 && (
                <p className="text-sm text-muted-foreground italic">No accounts in this passoff yet.</p>
              )}
              {sortedItems.map((item: any) => {
                const priorityColors: Record<string, string> = {
                  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200",
                  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200",
                  low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200",
                };
                return (
                  <div
                    key={item.id}
                    className="rounded-lg border bg-card p-3 space-y-2"
                    data-testid={`card-coverage-account-${item.id}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className={`text-xs font-normal border ${priorityColors[item.priority] ?? priorityColors.medium}`}>
                        {item.priority === "high" ? "🔴" : item.priority === "low" ? "🟢" : "🟡"} {item.priority}
                      </Badge>
                      <span className="font-medium text-sm">{item.companyName ?? "Account"}</span>
                      {item.acknowledged && (
                        <Badge variant="secondary" className="text-xs font-normal ml-auto">
                          <CheckCircle2 className="h-3 w-3 mr-1 text-green-500" />Acknowledged
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-muted-foreground">
                      {item.spotFreightHandler && (
                        <span className="flex items-center gap-1.5">
                          <Package className="h-3 w-3 shrink-0" />
                          <span><span className="text-foreground font-medium">Spot handler:</span> {item.spotFreightHandler}</span>
                        </span>
                      )}
                      {item.keyCustomerContact && (
                        <span className="flex items-center gap-1.5">
                          <UserCircle className="h-3 w-3 shrink-0" />
                          <span><span className="text-foreground font-medium">Key contact:</span> {item.keyCustomerContact}</span>
                        </span>
                      )}
                      {item.openItems && (
                        <span className="flex items-start gap-1.5 sm:col-span-2">
                          <FileText className="h-3 w-3 shrink-0 mt-0.5" />
                          <span><span className="text-foreground font-medium">Open items:</span> {item.openItems}</span>
                        </span>
                      )}
                      {item.activeDeals && (
                        <span className="flex items-start gap-1.5 sm:col-span-2">
                          <Shield className="h-3 w-3 shrink-0 mt-0.5" />
                          <span><span className="text-foreground font-medium">Active RFPs/bids:</span> {item.activeDeals}</span>
                        </span>
                      )}
                      {item.processNotes && (
                        <span className="flex items-start gap-1.5 sm:col-span-2 italic">
                          <Mail className="h-3 w-3 shrink-0 mt-0.5" />
                          <span><span className="text-foreground font-medium not-italic">Process notes:</span> {item.processNotes}</span>
                        </span>
                      )}
                      {(item.avgWeeklySpotLoads || item.avgWeeklyTotalLoads) && (
                        <span className="flex items-center gap-2 sm:col-span-2">
                          <TrendingUp className="h-3 w-3 shrink-0" />
                          <span className="text-foreground font-medium">Avg loads/wk:</span>
                          {item.avgWeeklySpotLoads && <span>Spot: <strong>{Number(item.avgWeeklySpotLoads).toFixed(1)}</strong></span>}
                          {item.avgWeeklyTotalLoads && <span>Total: <strong>{Number(item.avgWeeklyTotalLoads).toFixed(1)}</strong></span>}
                        </span>
                      )}
                    </div>
                    {!item.spotFreightHandler && !item.keyCustomerContact && !item.openItems && !item.processNotes && !item.activeDeals && (
                      <p className="text-xs text-muted-foreground italic">No details added yet — check the full passoff for updates.</p>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      <div style={{ order: getOrder("tasks") }} className={!isVisible("tasks") ? "hidden" : ""}>
      <Card data-testid="card-my-tasks" data-tour="tour-tasks-portlet">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <button
              className="flex items-center gap-2 text-left"
              onClick={() => { const next = !tasksCollapsed; setTasksCollapsed(next); localStorage.setItem("dash_tasks_collapsed", String(next)); }}
              data-testid="button-toggle-tasks-section"
            >
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                My Tasks
                {!tasksLoading && openTasks.length > 0 && (
                  <Badge variant="secondary" className="ml-1 font-normal">{openTasks.length}</Badge>
                )}
                {unread.tasks > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {unread.tasks} new
                  </span>
                )}
              </CardTitle>
              {tasksCollapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
            </button>
            <div className="flex items-center gap-2">
              <Link href="/tasks">
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-muted-foreground"
                  data-testid="button-open-tasks"
                >
                  <ListTodo className="h-3 w-3" /> Open Tasks
                </Button>
              </Link>
              <Link href="/tasks#completed">
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-muted-foreground"
                  data-testid="button-completed-tasks"
                >
                  <CheckCircle2 className="h-3 w-3" /> Completed
                </Button>
              </Link>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => { setEditingTask(undefined); setTaskDialogOpen(true); }}
                data-testid="button-add-task"
              >
                <Plus className="h-3 w-3" /> Add Task
              </Button>
            </div>
          </div>
        </CardHeader>
        {!tasksCollapsed && (
        <CardContent>
          {tasksLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <>
              {incomingTasks.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1.5 px-1"
                     style={{ color: "#ffb400" }}>
                    <Bell className="h-3 w-3" />
                    Incoming — needs acknowledgment
                  </p>
                  <div className="space-y-1">
                    {incomingTasks.map(task => {
                      const companyName = getCompanyName(task.companyId);
                      const assignerName = getUserName(task.assignedBy);
                      const hasNewComment = taskCommentNotifIds.has(task.id);
                      const assignedNotif = taskAssignedNotifMap.get(task.id);
                      return (
                        <div
                          key={task.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border transition-all group cursor-pointer border-amber-400/40 bg-amber-500/5 hover:bg-amber-500/10 ${task.status === "completed" ? "opacity-50" : ""}`}
                          data-testid={`task-row-${task.id}`}
                          onClick={() => { setEditingTask(task); setTaskDialogOpen(true); }}
                        >
                          <button onClick={(e) => { e.stopPropagation(); toggleStatusMutation.mutate({ id: task.id, status: nextStatus(task.status) }); }} className="shrink-0 hover:scale-110 transition-transform" title={`Status: ${task.status}`} data-testid={`button-toggle-status-${task.id}`}>{statusIcon(task.status)}</button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-task-title-${task.id}`}>{task.title}</p>
                              {hasNewComment && (
                                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.3)" }} data-testid={`badge-new-comment-${task.id}`}>
                                  <MessageCircle className="h-2.5 w-2.5" /> reply
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap mt-0.5">
                              {companyName && <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`} onClick={(e) => e.stopPropagation()}>{companyName}</Link>}
                              {assignerName && <span className="text-xs text-muted-foreground">from {assignerName}</span>}
                            </div>
                          </div>
                          {dueDateBadge(task.dueDate)}
                          {assignedNotif && (
                            <button
                              onClick={(e) => { e.stopPropagation(); markNotifReadMutation.mutate(assignedNotif.id.toString()); }}
                              className="shrink-0 px-2 py-1 rounded text-xs font-medium"
                              style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.25)" }}
                              title="Acknowledge — keeps task in open tasks"
                              data-testid={`button-acknowledge-task-${task.id}`}
                            >
                              <Bell className="h-3 w-3" />
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(task.id); }} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      );
                    })}
                  </div>
                  {regularTasks.length > 0 && <div className="border-t border-border mt-3 mb-2" />}
                </div>
              )}
              {regularTasks.length > 0 && (
                <div className="space-y-1">
                  {regularTasks.map(task => {
                    const companyName = getCompanyName(task.companyId);
                    const assignerName = getUserName(task.assignedBy);
                    const hasNewComment = taskCommentNotifIds.has(task.id);
                    const procLane = (() => {
                      if (!Array.isArray(task.attachedLaneData)) return null;
                      return (task.attachedLaneData as Array<Record<string, unknown>>).find(
                        (l): l is ProcurementLaneInfo =>
                          l != null && l.type === "carrier_procurement" && typeof l.lane === "string"
                      ) ?? null;
                    })();
                    return (
                      <div
                        key={task.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border transition-all group cursor-pointer ${procLane ? "border-primary/20 bg-primary/3 hover:border-primary/40 hover:bg-primary/5" : "border-transparent hover:border-border hover:bg-muted/50"} ${task.status === "completed" ? "opacity-50" : ""}`}
                        data-testid={`task-row-${task.id}`}
                        onClick={() => { setEditingTask(task); setTaskDialogOpen(true); }}
                      >
                        <button onClick={(e) => { e.stopPropagation(); toggleStatusMutation.mutate({ id: task.id, status: nextStatus(task.status) }); }} className="shrink-0 hover:scale-110 transition-transform mt-0.5" title={`Status: ${task.status}`} data-testid={`button-toggle-status-${task.id}`}>{statusIcon(task.status)}</button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-task-title-${task.id}`}>{task.title}</p>
                            {hasNewComment && (
                              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.3)" }} data-testid={`badge-new-comment-${task.id}`}>
                                <MessageCircle className="h-2.5 w-2.5" /> reply
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5">
                            {companyName && <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`} onClick={(e) => e.stopPropagation()}>{companyName}</Link>}
                            {assignerName && task.assignedBy !== currentUser?.id && <span className="text-xs text-muted-foreground">from {assignerName}</span>}
                          </div>
                          {procLane && (
                            <ProcurementTaskSummary lane={procLane} taskId={task.id} />
                          )}
                        </div>
                        {procLane && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 h-7 px-2 text-xs border-primary/30 text-primary hover:bg-primary/10 mt-0.5"
                            onClick={(e) => { e.stopPropagation(); setEditingTask(task); setTaskDialogOpen(true); }}
                            data-testid={`button-open-workspace-${task.id}`}
                          >
                            <Truck className="h-3 w-3 mr-1" />
                            Open Workspace
                          </Button>
                        )}
                        {!procLane && dueDateBadge(task.dueDate)}
                        <button onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(task.id); }} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" data-testid={`button-delete-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    );
                  })}
                  {completedCount > 0 && (
                    <p className="text-xs text-muted-foreground pt-2 pl-3" data-testid="text-completed-count">
                      {completedCount} completed task{completedCount !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              )}

              {actionItems.length > 0 && (
                <div className={displayTasks.length > 0 ? "mt-3 pt-3 border-t border-border" : ""} data-testid="section-action-items">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5 px-1">
                    <Users className="h-3 w-3" />
                    1:1 Action Items
                  </p>
                  <div className="space-y-1">
                    {actionItems.map(item => (
                      <Link key={item.id} href="/one-on-one">
                        <div
                          className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all cursor-pointer"
                          data-testid={`action-item-row-${item.id}`}
                        >
                          <div className="shrink-0 mt-0.5">
                            <div className="h-4 w-4 rounded-full border-2 border-violet-400 dark:border-violet-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate" data-testid={`text-action-item-${item.id}`}>
                              {item.text}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              with {item.withUserName}
                              {item.addedById !== currentUser?.id && ` · added by ${item.addedByName}`}
                            </p>
                          </div>
                          <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 h-5 border-violet-300 text-violet-600 dark:border-violet-600 dark:text-violet-400 font-medium">
                            1:1
                          </Badge>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {displayTasks.length === 0 && actionItems.length === 0 && (
                <div className="text-center py-6 text-muted-foreground">
                  <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm mb-3">No tasks yet</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => { setEditingTask(undefined); setTaskDialogOpen(true); }}
                    data-testid="button-create-first-task"
                  >
                    <Plus className="h-3.5 w-3.5" /> Create a task
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
        )}
      </Card>
      </div>{/* end tasks */}

      <div style={{ order: getOrder("cold-contacts") }} className={!isVisible("cold-contacts") ? "hidden" : ""} data-tour="tour-contacts-attention">
      {coldContacts.length > 0 && (
        <Card data-testid="card-cold-contacts">
          <CardHeader className={coldContactsCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_cold_contacts_collapsed", !coldContactsCollapsed, setColdContactsCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-cold-contacts">
              {coldContactsCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Contacts Needing Attention
                <Badge variant="secondary" className="ml-auto font-normal">{coldContacts.length}</Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!coldContactsCollapsed && <CardContent className="p-0">
            <div className="divide-y">
              {coldContacts.slice(0, 8).map(({ contact, company, daysSince, lastType }) => {
                const dotColor = daysSince >= 999 ? "bg-muted-foreground/40" : daysSince > 30 ? "bg-red-500" : "bg-amber-500";
                const typeLabel = lastType ? ({ call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" }[lastType] ?? lastType) : null;
                const daysNum = daysSince >= 999 ? null : daysSince;
                const badgeClass = daysSince >= 999 ? "bg-muted text-muted-foreground" : daysSince > 30 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400";
                return (
                  <div
                    key={contact.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors group"
                    data-testid={`cold-contact-row-${contact.id}`}
                  >
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dotColor}`} />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setViewContact(contact)}>
                      <p className="text-sm font-medium truncate">{contact.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{company.name}{contact.title ? ` · ${contact.title}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        {typeLabel && <p className="text-xs text-muted-foreground">Last: {typeLabel}</p>}
                      </div>
                      <div className={`text-right rounded-md px-2 py-0.5 ${badgeClass}`}>
                        {daysNum !== null
                          ? <p className="text-xs font-bold leading-tight">{daysNum}d</p>
                          : <p className="text-xs font-medium">Never</p>
                        }
                      </div>
                      {contact.email && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40"
                          title="Send email via Outlook"
                          data-testid={`button-email-cold-${contact.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setComposeContact({ email: contact.email!, name: contact.name, companyName: company.name, contactId: contact.id, companyId: company.id });
                          }}
                        >
                          <Send className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Create task for this contact"
                        data-testid={`button-task-cold-${contact.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTaskPrefill({ title: `Follow up with ${contact.name}`, companyId: company.id });
                          setPrefillDialogOpen(true);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>}
        </Card>
      )}
      </div>{/* end cold-contacts */}

      <div style={{ order: getOrder("meaningful-overdue") }} className={!isVisible("meaningful-overdue") ? "hidden" : ""}>
      {meaningfulOverdue.length > 0 && (
        <Card data-testid="card-meaningful-overdue">
          <CardHeader className={meaningfulOverdueCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_meaningful_overdue_collapsed", !meaningfulOverdueCollapsed, setMeaningfulOverdueCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-meaningful-overdue">
              {meaningfulOverdueCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4 text-purple-500" />
                No Meaningful Conversation in 30+ Days
                <Badge variant="secondary" className="ml-auto font-normal">{meaningfulOverdue.length}</Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!meaningfulOverdueCollapsed && <CardContent className="p-0">
            <div className="divide-y">
              {meaningfulOverdue.slice(0, 6).map(({ contact, company, daysSinceLastMeaningful }) => {
                const days = daysSinceLastMeaningful >= 999 ? null : daysSinceLastMeaningful;
                const badgeClass = daysSinceLastMeaningful >= 999 ? "bg-muted text-muted-foreground" : "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400";
                return (
                  <div key={contact.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors group" data-testid={`meaningful-overdue-row-${contact.id}`}>
                    <span className="h-2.5 w-2.5 rounded-full shrink-0 bg-purple-400" />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setViewContact(contact)}>
                      <p className="text-sm font-medium truncate">{contact.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{company.name}{contact.title ? ` · ${contact.title}` : ""}</p>
                    </div>
                    <div className={`text-right rounded-md px-2 py-0.5 ${badgeClass}`}>
                      {days !== null
                        ? <p className="text-xs font-bold leading-tight">{days}d ago</p>
                        : <p className="text-xs font-medium">Never</p>
                      }
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>}
        </Card>
      )}
      </div>{/* end meaningful-overdue */}

      <div style={{ order: getOrder("top-opportunities") }} className={!isVisible("top-opportunities") ? "hidden" : ""}>
      {opportunityLeaderboard.length > 0 && (
        <Card data-testid="card-opportunity-leaderboard">
          <CardHeader className={topOppsCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_top_opps_collapsed", !topOppsCollapsed, setTopOppsCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-top-opps">
              {topOppsCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                Top Wallet Share Opportunities
                <InfoTooltip text="Your accounts ranked by how much untapped margin potential they have. Calculated from their estimated freight spend or RFP volume vs what you're currently capturing." side="top" />
                <Badge variant="secondary" className="ml-auto font-normal">YTD</Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!topOppsCollapsed && <CardContent className="pt-0 space-y-2">
            {opportunityLeaderboard.map((item, idx) => (
              <Link key={item.companyId} href={`/companies/${item.companyId}`}>
                <div className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer" data-testid={`opportunity-row-${item.companyId}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-muted-foreground w-5 shrink-0">#{idx + 1}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{item.companyName}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.hasRfp
                          ? `${item.currentLoads.toLocaleString()} of ${item.rfpVolume!.toLocaleString()} RFP loads captured`
                          : `${item.currentLoads.toLocaleString()} loads YTD · est. spend on file`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-green-700 dark:text-green-400">+${Math.round(item.potentialMargin).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">potential margin</p>
                  </div>
                </div>
              </Link>
            ))}
          </CardContent>}
        </Card>
      )}
      </div>{/* end top-opportunities */}

      <div style={{ order: getOrder("churn-risk") }} className={!isVisible("churn-risk") ? "hidden" : ""}>
      {churnRisk.length > 0 && !isLmRole && (
        <Card className="border-l-4 border-l-orange-500 dark:border-l-orange-500 bg-orange-50/30 dark:bg-orange-950/20" data-testid="card-churn-risk">
          <CardHeader className={churnRiskCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_churn_risk_collapsed", !churnRiskCollapsed, setChurnRiskCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-churn-risk">
              {churnRiskCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base text-orange-700 dark:text-orange-400">
                <TrendingDown className="h-4 w-4" />
                Volume Drop Alert
                <InfoTooltip text="Accounts where total load volume dropped 20% or more compared to last month (minimum 5 prior loads to qualify). Could signal competitor activity, operational changes, or reduced shipping needs — worth a quick call." side="top" />
                <Badge className="ml-auto bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300 font-normal border-orange-300">
                  {churnRisk.length} account{churnRisk.length !== 1 ? "s" : ""}
                </Badge>
              </CardTitle>
            </button>
            <p className="text-xs text-muted-foreground">Loads down 20%+ vs last month — possible competitor activity</p>
          </CardHeader>
          {!churnRiskCollapsed && <CardContent className="pt-0 space-y-1">
            {churnRisk.map((item) => (
              <Link key={item.companyId} href={`/companies/${item.companyId}`}>
                <div className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer" data-testid={`churn-risk-row-${item.companyId}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.companyName}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.curLoads} loads this month vs {item.priorLoads} last month
                      {item.repName ? ` · ${item.repName}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-orange-700 border-orange-400 dark:text-orange-300 dark:border-orange-600">
                    −{Math.round(item.dropPct * 100)}%
                  </Badge>
                </div>
              </Link>
            ))}
          </CardContent>}
        </Card>
      )}
      </div>{/* end churn-risk */}

      {urgentRfps.length > 0 && (
        <Card className="border-l-4 border-l-red-500 dark:border-l-red-500 bg-red-50/30 dark:bg-red-950/20" data-testid="card-rfp-deadline-alert">
          <CardHeader className={rfpDeadlineCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_rfp_deadline_collapsed", !rfpDeadlineCollapsed, setRfpDeadlineCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-rfp-deadline">
              {rfpDeadlineCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base text-red-700 dark:text-red-400">
                <Clock className="h-4 w-4" />
                RFP Deadlines Approaching
                <Badge className="ml-auto bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300 font-normal border-red-300">
                  {urgentRfps.length} RFP{urgentRfps.length !== 1 ? "s" : ""}
                </Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!rfpDeadlineCollapsed && <CardContent className="pt-0 space-y-2">
            {urgentRfps.map((rfp: any) => {
              const due = new Date(rfp.dueDate + "T00:00:00");
              const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
              const isOverdue = diffDays < 0;
              return (
                <Link key={rfp.id} href={`/companies/${rfp.companyId}`}>
                  <div className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors cursor-pointer" data-testid={`rfp-deadline-row-${rfp.id}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{rfp.title}</p>
                      <p className="text-xs text-muted-foreground">Due {due.toLocaleDateString()}</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                      isOverdue ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                      : diffDays === 0 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                    }`}>
                      {isOverdue ? `${Math.abs(diffDays)}d overdue` : diffDays === 0 ? "Due today" : `${diffDays}d left`}
                    </span>
                  </div>
                </Link>
              );
            })}
          </CardContent>}
        </Card>
      )}

      {behindGoals.length > 0 && !isLmRole && (
        <Card className="border-l-4 border-l-amber-500 dark:border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/20" data-testid="card-goals-nudge">
          <CardHeader className={goalsNudgeCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_goals_nudge_collapsed", !goalsNudgeCollapsed, setGoalsNudgeCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-goals-nudge">
              {goalsNudgeCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
                <Target className="h-4 w-4" />
                Goals Need Attention
                <Badge className="ml-auto bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300 font-normal border-amber-300">
                  {behindGoals.length} goal{behindGoals.length !== 1 ? "s" : ""} behind
                </Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!goalsNudgeCollapsed && <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground mb-3">
              You're past the halfway point of the month and these goals are under 50% complete:
            </p>
            <div className="space-y-2">
              {behindGoals.map((g: any) => {
                const target = parseFloat(g.target || "0");
                const current = g.computedValue != null ? g.computedValue : parseFloat(g.currentValue || "0");
                const pct = target > 0 ? Math.round((current / target) * 100) : 0;
                const label = g.title || getMetricLabel(g.metric, g.customLabel);
                const amName = teamMembers.find((u: SafeUser) => u.id === g.amId)?.name;
                return (
                  <div key={g.id} className="flex items-center gap-3" data-testid={`goal-nudge-${g.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{label}</p>
                        {amName && <span className="text-xs text-muted-foreground shrink-0">· {amName}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{pct}%</span>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{current.toLocaleString()} / {target.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
            <Link href="/goals">
              <Button size="sm" variant="outline" className="h-7 text-xs mt-3" data-testid="button-go-to-goals-nudge">
                Update Progress →
              </Button>
            </Link>
          </CardContent>}
        </Card>
      )}

      <div style={{ order: getOrder("one-on-one") }} className={!isVisible("one-on-one") ? "hidden" : ""}>
      <PortletErrorBoundary label="1:1 Sessions">
      <div className="relative">
        {pendingTopicsCount > 0 && (
          <div className="absolute -top-2 -right-2 z-10">
            <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-bold" data-testid="badge-pending-topics">
              {pendingTopicsCount}
            </span>
          </div>
        )}
        <OneOnOnePortlet />
      </div>
      </PortletErrorBoundary>
      </div>{/* end one-on-one */}

      <div style={{ order: getOrder("feed") }} className={!isVisible("feed") ? "hidden" : ""}>
      <InternalCommsPortlet />
      </div>{/* end feed (comms) */}

      {canSeeTeam && missingMonthlyGoals.length > 0 && (
        <Card className="border-l-4 border-l-amber-500 dark:border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/20" data-testid="card-goal-alert">
          <CardHeader className={goalsAlertCollapsed ? "pb-2" : "pb-3"}>
            <button onClick={() => togglePortlet("dash_goals_alert_collapsed", !goalsAlertCollapsed, setGoalsAlertCollapsed)} className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity" data-testid="button-toggle-goals-alert">
              {goalsAlertCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
              <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
                <BellRing className="h-4 w-4" />
                Monthly Goals Not Set
                <Badge className="ml-auto bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300 font-normal border-amber-300">
                  {missingMonthlyGoals.length} rep{missingMonthlyGoals.length !== 1 ? "s" : ""}
                </Badge>
              </CardTitle>
            </button>
          </CardHeader>
          {!goalsAlertCollapsed && <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground mb-3">
              The following reps are missing monthly goals for{" "}
              <span className="font-medium text-foreground">
                {new Date().toLocaleString("default", { month: "long", year: "numeric" })}
              </span>:
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {missingMonthlyGoals.map(m => (
                <Badge key={m.amId} variant="secondary" className="font-normal" data-testid={`badge-missing-goal-${m.amId}`}>
                  {m.amName}
                </Badge>
              ))}
            </div>
            <Link href="/goals">
              <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="button-go-to-goals">
                Set Goals →
              </Button>
            </Link>
          </CardContent>}
        </Card>
      )}

      <div style={{ order: getOrder("feed") }} className={!isVisible("feed") ? "hidden" : ""}>
      <Card data-testid="card-feed">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <button
              className="flex items-center gap-2 text-left"
              onClick={() => { const next = !feedCollapsed; setFeedCollapsed(next); localStorage.setItem("dash_feed_collapsed", String(next)); }}
              data-testid="button-toggle-feed-section"
            >
              <CardTitle className="text-base flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                Team Feed
                {!feedLoading && feedPosts.length > 0 && (
                  <Badge variant="secondary" className="ml-1 font-normal">{feedPosts.length}</Badge>
                )}
                {unread.feed > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {unread.feed} new
                  </span>
                )}
              </CardTitle>
              {feedCollapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
            </button>
          </div>
        </CardHeader>
        {!feedCollapsed && (
        <CardContent className="space-y-4">
          <div className="relative">
            <div className="flex gap-1 mb-2 flex-wrap">
              {(["trend", "growth", "idea", "celebrate"] as const).map(cat => (
                <button
                  key={cat}
                  onClick={() => setFeedCategory(cat)}
                  data-testid={`button-feed-category-${cat}`}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors capitalize ${
                    feedCategory === cat
                      ? cat === "trend" ? "bg-purple-600 text-white border-purple-600"
                        : cat === "growth" ? "bg-green-600 text-white border-green-600"
                        : cat === "celebrate" ? "bg-amber-500 text-white border-amber-500"
                        : "bg-blue-600 text-white border-blue-600"
                      : "bg-transparent border-border text-muted-foreground hover:border-foreground"
                  }`}
                >
                  {cat === "trend" ? "📈 Trend" : cat === "growth" ? "🚀 Growth" : cat === "celebrate" ? "🎉 Celebrate" : "💡 Idea"}
                </button>
              ))}
            </div>
            {currentUser && (
              <>
                <Textarea
                  ref={feedTextareaRef}
                  value={feedContent}
                  onChange={handleFeedChange}
                  onKeyDown={handleFeedKeyDown}
                  onPaste={handleFeedPaste}
                  placeholder="Share a trend, growth win, idea, or celebrate a win… Type @ to mention someone (Ctrl+Enter to post)"
                  className="resize-none text-sm min-h-[72px]"
                  data-testid="textarea-feed-content"
                />
                <div className="flex items-center justify-between mt-1.5">
                  <FileAttachmentUpload
                    pendingFiles={feedPendingFiles}
                    onAdd={(files) => setFeedPendingFiles(prev => [...prev, ...files])}
                    onRemove={(i) => setFeedPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                    compact
                  />
                  <Button
                    size="sm"
                    className="gap-1"
                    onClick={handleSubmitFeed}
                    disabled={!feedContent.trim() || createFeedPostMutation.isPending}
                    data-testid="button-submit-feed"
                  >
                    <Send className="h-3 w-3" />
                    Post
                  </Button>
                </div>
              </>
            )}
            {mentionState && mentionableUsers.length > 0 && (
              <div className="absolute z-50 mt-1 w-56 rounded-md border bg-popover shadow-lg" style={{ bottom: "100%", left: 0 }} data-testid="mention-dropdown">
                {mentionableUsers.map((u, i) => (
                  <button
                    key={u.id}
                    onMouseDown={e => { e.preventDefault(); insertMention(u); }}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors ${i === selectedMentionIdx ? "bg-muted" : ""}`}
                    data-testid={`mention-option-${u.id}`}
                  >
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary flex-shrink-0">
                      {u.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-medium leading-tight">{u.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{u.role?.replace(/_/g, " ")}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Feed search + author filter */}
          {feedPosts.length > 0 && (
            <div className="flex gap-2 items-center">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={feedSearch}
                  onChange={e => setFeedSearch(e.target.value)}
                  placeholder="Search posts…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="input-feed-search"
                />
              </div>
              {teamMembers.length > 1 && (
                <select
                  value={feedAuthorFilter}
                  onChange={e => setFeedAuthorFilter(e.target.value)}
                  className="text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="select-feed-author"
                >
                  <option value="all">All reps</option>
                  {teamMembers.map(u => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              )}
              {(feedSearch || feedAuthorFilter !== "all") && (
                <button
                  onClick={() => { setFeedSearch(""); setFeedAuthorFilter("all"); }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-feed-filter"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          {feedLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : feedPosts.length > 0 ? (
            <div>
            {(() => {
              const filtered = feedPosts.filter(p => {
                if (feedSearch && !p.content.toLowerCase().includes(feedSearch.toLowerCase())) return false;
                if (feedAuthorFilter !== "all" && p.authorId !== feedAuthorFilter) return false;
                return true;
              }).sort((a, b) => {
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                return 0;
              });
              const visiblePosts = feedExpanded ? filtered : filtered.slice(0, 5);
              return (<>
            <div className={`space-y-2 pr-1 ${feedExpanded ? "max-h-[600px] overflow-y-auto" : ""}`}>
              {visiblePosts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No posts match your search.</p>
              ) : visiblePosts.map(post => {
                const catColors: Record<string, string> = {
                  trend: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
                  growth: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
                  idea: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
                  celebrate: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                };
                const catIcon: Record<string, string> = { trend: "📈", growth: "🚀", idea: "💡", celebrate: "🎉" };
                const isReplying = replyingTo === post.id;
                return (
                  <div key={post.id} className={`rounded-lg border bg-card ${post.pinned ? "border-blue-400/60 dark:border-blue-600/60 ring-1 ring-blue-400/20" : "border-border/50"}`} data-testid={`feed-post-${post.id}`}>
                    {post.pinned && (
                      <div className="flex items-center gap-1 px-3 pt-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium">
                        <Pin className="h-3 w-3" /> Pinned
                      </div>
                    )}
                    {/* Main post */}
                    <div className="flex items-start gap-3 p-3 group">
                      <Lightbulb className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground whitespace-pre-wrap break-words" data-testid={`text-feed-content-${post.id}`}>
                          {post.content}
                        </p>
                        <FileAttachmentList entityType="feed_post" entityIds={[post.id]} />
                        <div className="flex items-center gap-2 flex-wrap mt-1.5">
                          <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium capitalize ${catColors[post.category] || "bg-muted text-muted-foreground"}`} data-testid={`badge-feed-category-${post.id}`}>
                            {catIcon[post.category]} {post.category}
                          </span>
                          <span className="text-xs text-muted-foreground">{getAuthorName(post.authorId)}</span>
                          <span className="text-xs text-muted-foreground/50">·</span>
                          <span className="text-xs text-muted-foreground">{formatTimeAgo(post.createdAt)}</span>
                          <button
                            onClick={() => { setReplyingTo(isReplying ? null : post.id); setReplyContent(""); }}
                            className="ml-auto text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                            data-testid={`button-reply-feed-${post.id}`}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {post.replies.length > 0 ? `${post.replies.length} repl${post.replies.length === 1 ? "y" : "ies"}` : "Reply"}
                          </button>
                        </div>
                        <div className="flex items-center gap-1 mt-1.5" data-testid={`reaction-bar-${post.id}`}>
                          {(["👍", "🔥", "💡", "❤️", "✅"] as const).map(emoji => {
                            const postReactions = feedReactions.filter(r => r.feedPostId === post.id && r.emoji === emoji);
                            const count = postReactions.length;
                            const isActive = postReactions.some(r => r.userId === currentUser?.id);
                            return (
                              <button
                                key={emoji}
                                onClick={() => toggleFeedReactionMutation.mutate({ postId: post.id, emoji })}
                                className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border transition-colors ${
                                  isActive
                                    ? "bg-primary/10 border-primary/30 text-primary"
                                    : "bg-transparent border-transparent text-muted-foreground hover:bg-muted hover:border-border"
                                }`}
                                data-testid={`button-reaction-${emoji}-${post.id}`}
                              >
                                <span>{emoji}</span>
                                {count > 0 && <span className="font-medium">{count}</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {(post.authorId === currentUser?.id || currentUser?.role === "admin" || canPin) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                              data-testid={`button-menu-feed-${post.id}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canPin && !post.parentId && (
                              <DropdownMenuItem
                                onClick={() => pinFeedPostMutation.mutate({ id: post.id, pinned: !post.pinned })}
                                data-testid={`button-pin-feed-${post.id}`}
                              >
                                {post.pinned ? <PinOff className="h-3.5 w-3.5 mr-2" /> : <Pin className="h-3.5 w-3.5 mr-2" />}
                                {post.pinned ? "Unpin post" : "Pin to top"}
                              </DropdownMenuItem>
                            )}
                            {(post.authorId === currentUser?.id || currentUser?.role === "admin") && (
                              <DropdownMenuItem
                                onClick={() => deleteFeedPostMutation.mutate(post.id)}
                                className="text-destructive focus:text-destructive"
                                data-testid={`button-delete-feed-${post.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-2" />
                                Delete post
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>

                    {/* Replies thread */}
                    {post.replies.length > 0 && (
                      <div className="border-t border-border/40 mx-3 mb-1" />
                    )}
                    {post.replies.map(reply => (
                      <div key={reply.id} className="flex items-start gap-2 px-3 py-2 ml-6 group/reply" data-testid={`feed-reply-${reply.id}`}>
                        <div className="h-4 w-4 shrink-0 flex items-end justify-end">
                          <div className="h-3 w-3 border-l-2 border-b-2 border-border/50 rounded-bl-sm" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{reply.content}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted-foreground font-medium">{getAuthorName(reply.authorId)}</span>
                            <span className="text-xs text-muted-foreground/50">·</span>
                            <span className="text-xs text-muted-foreground">{formatTimeAgo(reply.createdAt)}</span>
                          </div>
                        </div>
                        {(reply.authorId === currentUser?.id || currentUser?.role === "admin") && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                                data-testid={`button-menu-reply-${reply.id}`}
                              >
                                <MoreHorizontal className="h-3 w-3" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => deleteFeedPostMutation.mutate(reply.id)}
                                className="text-destructive focus:text-destructive"
                                data-testid={`button-delete-reply-${reply.id}`}
                              >
                                <Trash2 className="h-3 w-3 mr-2" />
                                Delete reply
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    ))}

                    {/* Inline reply form */}
                    {isReplying && (
                      <div className="border-t border-border/40 p-3 flex gap-2 items-start" data-testid={`reply-form-${post.id}`}>
                        <div className="ml-6 flex-1 flex flex-col gap-1.5">
                          <Textarea
                            autoFocus
                            value={replyContent}
                            onChange={e => setReplyContent(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && replyContent.trim()) {
                                e.preventDefault();
                                createReplyMutation.mutate({ content: replyContent.trim(), parentId: post.id });
                              }
                              if (e.key === "Escape") { setReplyingTo(null); setReplyContent(""); }
                            }}
                            placeholder="Write a reply… (Ctrl+Enter to send)"
                            className="resize-none text-sm min-h-[56px]"
                            data-testid={`textarea-reply-${post.id}`}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => { setReplyingTo(null); setReplyContent(""); }}
                              data-testid={`button-cancel-reply-${post.id}`}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              className="gap-1"
                              disabled={!replyContent.trim() || createReplyMutation.isPending}
                              onClick={() => createReplyMutation.mutate({ content: replyContent.trim(), parentId: post.id })}
                              data-testid={`button-submit-reply-${post.id}`}
                            >
                              <Send className="h-3 w-3" />
                              Reply
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {filtered.length > 5 && (
              <button
                onClick={() => setFeedExpanded(v => !v)}
                className="w-full mt-2 py-1.5 text-xs text-muted-foreground hover:text-primary flex items-center justify-center gap-1.5 rounded-md hover:bg-muted/50 transition-colors"
                data-testid="button-toggle-feed-expand"
              >
                {feedExpanded ? "Show less" : `Show ${filtered.length - 5} more post${filtered.length - 5 === 1 ? "" : "s"}`}
              </button>
            )}
            </>); })()}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Crown className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Nothing posted yet</p>
              <p className="text-xs mt-1">Share trends, growth wins, and ideas with your team</p>
            </div>
          )}
        </CardContent>
        )}
      </Card>
      </div>{/* end feed */}

      <div style={{ order: getOrder("team-directory") }} className={!isVisible("team-directory") ? "hidden" : ""}>
      {canSeeTeam && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                National Account Managers
                {!usersLoading && (
                  <Badge variant="secondary" className="ml-auto font-normal">{nams.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : nams.length > 0 ? (
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {nams.map((u) => <UserRow key={u.id} user={u} />)}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <ShieldCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No national account managers</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <UserCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                Account Managers
                {!usersLoading && (
                  <Badge variant="secondary" className="ml-auto font-normal">{ams.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : ams.length > 0 ? (
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {ams.map((u) => <UserRow key={u.id} user={u} />)}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <UserCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No account managers</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              My Customers
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : companies && companies.length > 0 ? (
              <div className="space-y-2">
                {companies.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5).map((company) => {
                  const companyContacts = contacts?.filter((c) => c.companyId === company.id) || [];
                  return (
                    <Link
                      key={company.id}
                      href={`/companies/${company.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all cursor-pointer group"
                      data-testid={`card-company-${company.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold text-sm">
                          {company.name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{company.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {company.industry || "No industry"} · {companyContacts.length} contacts
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No customers yet</p>
                <p className="text-xs">Add your first company to get started</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />
              Top Contacts by Freight Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : contacts && contacts.length > 0 ? (
              <div className="space-y-2">
                {[...contacts]
                  .sort((a, b) => parseFloat(b.freightSpend || "0") - parseFloat(a.freightSpend || "0"))
                  .slice(0, 5)
                  .map((contact, index) => (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all"
                      data-testid={`card-contact-${contact.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full font-semibold text-sm ${
                          index === 0 ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400" :
                          index === 1 ? "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" :
                          "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        }`}>
                          {contact.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{contact.name}</p>
                          <p className="text-xs text-muted-foreground">{contact.title || "No title"}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-600 dark:text-green-400">
                          ${contact.freightSpend ? Number(contact.freightSpend).toLocaleString() : "0"}
                        </p>
                        <p className="text-xs text-muted-foreground">Annual</p>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No contacts yet</p>
                <p className="text-xs">Add contacts to companies to see them here</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      </div>{/* end team-directory */}


      <div style={{ order: getOrder("relationship") }} className={!isVisible("relationship") ? "hidden" : ""}>
      <PortletErrorBoundary label="Relationship Intel">
      <RelationshipDashboardSection />
      </PortletErrorBoundary>
      </div>{/* end relationship */}

      <div style={{ order: getOrder("goals-leaderboard") }} className={!isVisible("goals-leaderboard") ? "hidden" : ""}>
      {canSeeTeam && (leaderboardLoading || leaderboard.length > 0) && (
        <Card data-testid="card-leaderboard">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Crown className="h-4 w-4 text-yellow-500" />
              Goal Progress Leaderboard
              <span className="ml-auto text-xs font-normal text-muted-foreground">Top 3 per metric · goal %</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {leaderboardLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {leaderboard.map(group => {
                  const metricLabel = group.metric === "custom"
                    ? (group.customLabel || "Custom")
                    : group.metric === "contacts_added" ? "New Contacts"
                    : group.metric === "touchpoints" ? "Touchpoints"
                    : group.metric === "load_count" ? "Load Count"
                    : group.metric === "margin" ? "Margin $"
                    : group.metric;

                  const medalColors = ["text-yellow-500", "text-slate-400", "text-amber-700"];
                  const medalBg = ["bg-yellow-50 dark:bg-yellow-950/20", "bg-slate-50 dark:bg-slate-800/20", "bg-amber-50 dark:bg-amber-950/20"];
                  const medals = ["🥇", "🥈", "🥉"];

                  return (
                    <div key={`${group.metric}:${group.customLabel}`} className="rounded-lg border bg-card p-3 space-y-2" data-testid={`leaderboard-group-${group.metric}`}>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{metricLabel}</p>
                      {group.entries.map((entry, idx) => {
                        const pct = Math.min(entry.pct, 100);
                        const overGoal = entry.pct >= 100;
                        return (
                          <div key={`${entry.amId}-${idx}`} className={`rounded-md p-2 ${medalBg[idx] || ""}`} data-testid={`leaderboard-entry-${group.metric}-${entry.rank}`}>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-base leading-none">{medals[idx]}</span>
                                <span className="text-sm font-medium truncate">{entry.amName.split(" ")[0]}</span>
                              </div>
                              <span className={`text-xs font-bold tabular-nums shrink-0 ${overGoal ? "text-green-600 dark:text-green-400" : medalColors[idx]}`}>
                                {Math.round(entry.pct)}%
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${overGoal ? "bg-green-500" : idx === 0 ? "bg-yellow-500" : idx === 1 ? "bg-slate-400" : "bg-amber-700"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {group.metric === "margin"
                                ? `$${Math.round(entry.currentValue).toLocaleString()} / $${Math.round(entry.target).toLocaleString()}`
                                : `${Math.round(entry.currentValue).toLocaleString()} / ${Math.round(entry.target).toLocaleString()}`}
                            </p>
                          </div>
                        );
                      })}
                      {group.entries.length === 0 && (
                        <p className="text-xs text-muted-foreground py-2">No active goals</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </div>{/* end goals-leaderboard */}

      {/* Weekly Touchpoint Leaderboard */}
      {canSeeTeam && (weeklyLoading || weeklyResults.length > 0) && (
        <Card data-testid="card-weekly-leaderboard">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-amber-500" />
              Weekly Activity — This Week
              <InfoTooltip text="Total touchpoints logged by each rep from Monday through today — calls, emails, texts, and site visits. Meaningful conversations are counted separately." side="top" />
              {weeklyData?.weekStart && (
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  Week of {new Date(weeklyData.weekStart + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {weeklyLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full rounded" />)}</div>
            ) : (
              <div className="space-y-2">
                {weeklyResults.slice(0, 8).map((rep, idx) => {
                  const medals = ["🥇", "🥈", "🥉"];
                  return (
                    <div key={rep.userId} className="flex items-center gap-2" data-testid={`weekly-leaderboard-${rep.userId}`}>
                      <span className="text-sm w-6 shrink-0 text-center">{medals[idx] || `${idx + 1}.`}</span>
                      <span className="text-sm font-medium flex-1 truncate">{rep.name.split(" ")[0]}</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                        {rep.call > 0 && <span title="Calls">📞{rep.call}</span>}
                        {rep.email > 0 && <span title="Emails">✉️{rep.email}</span>}
                        {rep.text > 0 && <span title="Texts">💬{rep.text}</span>}
                        {rep.site_visit > 0 && <span title="Site Visits">🏢{rep.site_visit}</span>}
                        {rep.meaningful > 0 && <span className="text-green-600 dark:text-green-400 font-semibold" title="Meaningful">★{rep.meaningful}</span>}
                      </div>
                      <span className="text-sm font-bold tabular-nums w-8 text-right">{rep.total}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        editingTask={editingTask}
      />

      <TaskDialog
        open={prefillDialogOpen}
        onOpenChange={(open) => { setPrefillDialogOpen(open); if (!open) setTaskPrefill(undefined); }}
        companyId={taskPrefill?.companyId}
        prefillData={taskPrefill?.title ? { title: taskPrefill.title } : undefined}
      />

      <ContactDetailSheet
        contact={viewContact}
        open={!!viewContact}
        onClose={() => setViewContact(null)}
      />

      <DashboardActivitySheet
        portlet={activePortlet}
        onClose={() => setActivePortlet(null)}
        directorId={selectedDirectorId ?? undefined}
      />

      <OutlookComposeDialog
        open={!!composeContact}
        onClose={() => setComposeContact(null)}
        toEmail={composeContact?.email || ""}
        toName={composeContact?.name || ""}
        companyName={composeContact?.companyName || ""}
        contactId={composeContact?.contactId}
        companyId={composeContact?.companyId}
      />

    </div>
  );
}
