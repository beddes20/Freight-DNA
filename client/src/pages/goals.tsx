import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  BarChart, Bar, ResponsiveContainer, Cell, Tooltip, XAxis,
} from "recharts";
import {
  Target, Plus, MessageSquare, Trash2, ChevronDown, ChevronUp,
  TrendingUp, Users, Truck, DollarSign, CalendarDays, Pencil, Send,
  CheckCircle2, BarChart3, BellRing, X, Sliders, Percent, Heart, RefreshCw,
} from "lucide-react";
import { useConfetti } from "@/components/confetti";
import type { Goal, GoalComment } from "@shared/schema";

const METRICS = [
  { value: "contacts_added",        label: "New Contacts",                        icon: Users,       color: "bg-blue-500",    unit: "contacts" },
  { value: "touchpoints",           label: "Touchpoints",                         icon: TrendingUp,  color: "bg-cyan-500",    unit: "touches" },
  { value: "meaningful_touchpoints",label: "Meaningful Conversations (auto-tracked)", icon: Heart, color: "bg-rose-500",    unit: "convos" },
  { value: "load_count",            label: "Load Count",                          icon: Truck,       color: "bg-green-500",   unit: "loads" },
  { value: "loads_booked",          label: "Loads Booked (auto-tracked)",         icon: Truck,       color: "bg-teal-500",    unit: "loads" },
  { value: "margin",                label: "Margin ($)",                          icon: DollarSign,  color: "bg-violet-500",  unit: "$" },
  { value: "margin_pct",            label: "Margin %",                            icon: Percent,     color: "bg-emerald-500", unit: "%" },
  { value: "custom",                label: "Custom",                              icon: Sliders,     color: "bg-orange-500",  unit: "units" },
];

const PERIODS = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function getMetric(value: string) {
  return METRICS.find(m => m.value === value) ?? METRICS[0];
}

function formatValue(metric: string, value: number) {
  if (metric === "margin") return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  if (metric === "margin_pct") return `${value}%`;
  return value.toLocaleString();
}

function progressPct(current: number, target: number) {
  if (target <= 0) return 0;
  return Math.min(100, Math.round((current / target) * 100));
}

function fmtDate(iso: string) {
  try {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

interface GoalCardProps {
  goal: Goal;
  currentUserId: string;
  userRole: string;
  allUsers: Array<{ id: string; name: string }>;
  onEdit: (goal: Goal) => void;
  onDelete: (id: string) => void;
}

function GoalCard({ goal, currentUserId, userRole, allUsers, onEdit, onDelete }: GoalCardProps) {
  const { toast } = useToast();
  const [showComments, setShowComments] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [updatingValue, setUpdatingValue] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [confettiFired, setConfettiFired] = useState(false);
  const { fire: fireConfetti, ConfettiOverlay } = useConfetti();

  const metric = getMetric(goal.metric);
  const MetricIcon = metric.icon;
  const current = parseFloat(goal.currentValue || "0");
  const target = parseFloat(goal.target || "0");
  const pct = progressPct(current, target);
  const isAutoTracked = goal.metric === "contacts_added" || goal.metric === "touchpoints" || goal.metric === "meaningful_touchpoints" || goal.metric === "margin" || goal.metric === "loads_booked" || goal.metric === "margin_pct";
  const isFinancialTracked = goal.metric === "margin";

  const { data: autoProgress } = useQuery<{ autoValue: number | null; currentValue: number }>({
    queryKey: ["/api/goals", goal.id, "progress"],
    enabled: isAutoTracked,
  });

  const { data: comments = [] } = useQuery<GoalComment[]>({
    queryKey: ["/api/goals", goal.id, "comments"],
    enabled: showComments,
    staleTime: 120000,
  });

  const { data: marginTrend } = useQuery<{ months: { key: string; label: string; margin: number }[] }>({
    queryKey: ["/api/goals", goal.id, "margin-trend"],
    enabled: isFinancialTracked,
  });

  const amName = allUsers.find(u => u.id === goal.amId)?.name ?? "Unknown";
  const namName = allUsers.find(u => u.id === goal.namId)?.name ?? "Unknown";

  const displayCurrent = isAutoTracked && autoProgress?.autoValue != null
    ? autoProgress.autoValue
    : current;
  const displayPct = progressPct(displayCurrent, target);

  const updateProgress = useMutation({
    mutationFn: (value: string) => apiRequest("PATCH", `/api/goals/${goal.id}`, { currentValue: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      setUpdatingValue(false);
      setNewValue("");
      toast({ description: "Progress updated." });
    },
    onError: () => toast({ variant: "destructive", description: "Failed to update progress." }),
  });

  const postComment = useMutation({
    mutationFn: () => apiRequest("POST", `/api/goals/${goal.id}/comments`, { body: commentBody }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals", goal.id, "comments"] });
      setCommentBody("");
    },
    onError: () => toast({ variant: "destructive", description: "Failed to post comment." }),
  });

  const deleteComment = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/goal-comments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/goals", goal.id, "comments"] }),
    onError: () => toast({ variant: "destructive", description: "Failed to delete comment." }),
  });

  const canDelete = userRole === "admin" || goal.namId === currentUserId;
  const canUpdateProgress = userRole !== "admin" ? (goal.namId === currentUserId || goal.amId === currentUserId) : true;

  useEffect(() => {
    if (displayPct >= 100 && !confettiFired) {
      fireConfetti();
      setConfettiFired(true);
    }
  }, [displayPct, confettiFired, fireConfetti]);

  return (
    <>
    {ConfettiOverlay && <ConfettiOverlay />}
    <Card className="border border-border" data-testid={`goal-card-${goal.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`h-7 w-7 rounded-full ${metric.color} flex items-center justify-center shrink-0`}>
              <MetricIcon className="h-3.5 w-3.5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">{goal.title || (goal.metric === "custom" ? (goal.customLabel || "Custom Goal") : metric.label)}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <Badge variant="secondary" className="text-xs font-normal capitalize">{goal.metric === "custom" ? (goal.customLabel || "Custom") : metric.label}</Badge>
                <Badge variant="outline" className="text-xs font-normal capitalize">{goal.period}</Badge>
                {isAutoTracked ? (
                  <Badge className="text-[10px] font-normal gap-0.5 px-1.5 py-0 h-4 bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-400 border border-sky-200 dark:border-sky-800">
                    <RefreshCw className="h-2 w-2" /> Auto
                  </Badge>
                ) : goal.metric !== "custom" ? (
                  <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 h-4 text-muted-foreground">Manual</Badge>
                ) : null}
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" />
                  {fmtDate(goal.startDate)} – {fmtDate(goal.endDate)}
                </span>
                {goal.amId !== currentUserId && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <span className="text-muted-foreground/40">·</span>
                    <span className="font-medium text-foreground/70">{amName}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canDelete && (
              <>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(goal)} data-testid={`button-edit-goal-${goal.id}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => onDelete(goal.id)} data-testid={`button-delete-goal-${goal.id}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>

        {goal.notes && (
          <p className="text-xs text-muted-foreground mb-3 italic">{goal.notes}</p>
        )}

        <div className="space-y-1.5 mb-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-semibold tabular-nums">
              {formatValue(goal.metric, displayCurrent)} <span className="text-muted-foreground font-normal">/ {formatValue(goal.metric, target)}</span>
            </span>
          </div>
          <Progress value={displayPct} className="h-2" data-testid={`progress-goal-${goal.id}`} />
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium ${displayPct >= 100 ? "text-green-600 dark:text-green-400" : displayPct >= 70 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
              {displayPct >= 100 ? (
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Goal reached!</span>
              ) : (
                `${displayPct}% of goal`
              )}
            </span>
            {isAutoTracked && (
              <span className="text-xs text-muted-foreground">
                {isFinancialTracked ? "From financial data" : "Auto-tracked"}
              </span>
            )}
          </div>
        </div>

        {isFinancialTracked && marginTrend && marginTrend.months.length > 0 && (() => {
          const goalMonthKey = goal.startDate ? goal.startDate.slice(0, 7) : null;
          const maxMargin = Math.max(...marginTrend.months.map(m => m.margin), 1);
          return (
            <div className="mb-3 pt-2 border-t" data-testid={`margin-trend-${goal.id}`}>
              <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                <BarChart3 className="h-3 w-3" /> 6-month trend
              </p>
              <ResponsiveContainer width="100%" height={64}>
                <BarChart data={marginTrend.months} barCategoryGap="20%">
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: "currentColor" }} axisLine={false} tickLine={false} className="text-muted-foreground" />
                  <Tooltip
                    formatter={(val: number) => [`$${val.toLocaleString()}`, "Margin"]}
                    contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                    cursor={{ fill: "transparent" }}
                  />
                  <Bar dataKey="margin" radius={[2, 2, 0, 0]}>
                    {marginTrend.months.map((entry) => (
                      <Cell
                        key={entry.key}
                        fill={entry.key === goalMonthKey ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.3)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          );
        })()}

        {!isAutoTracked && canUpdateProgress && (
          <div className="mb-3">
            {updatingValue ? (
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="Enter current value..."
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  className="h-8 text-sm"
                  data-testid={`input-update-progress-${goal.id}`}
                />
                <Button size="sm" className="h-8" onClick={() => updateProgress.mutate(newValue)} disabled={!newValue || updateProgress.isPending} data-testid={`button-save-progress-${goal.id}`}>Save</Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => { setUpdatingValue(false); setNewValue(""); }}>Cancel</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => { setUpdatingValue(true); setNewValue(String(current)); }} data-testid={`button-update-progress-${goal.id}`}>
                <BarChart3 className="h-3 w-3" /> Update Progress
              </Button>
            )}
          </div>
        )}

        <div className="border-t pt-2">
          <button
            onClick={() => setShowComments(v => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
            data-testid={`button-toggle-comments-${goal.id}`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Comments{comments.length > 0 ? ` (${comments.length})` : ""}</span>
            {showComments ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
          </button>

          {showComments && (
            <div className="mt-2 space-y-2">
              {comments.map(c => {
                const author = allUsers.find(u => u.id === c.authorId);
                const canDeleteComment = userRole === "admin" || c.authorId === currentUserId;
                return (
                  <div key={c.id} className="flex gap-2 group" data-testid={`goal-comment-${c.id}`}>
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                      {(author?.name ?? "?")[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">{author?.name ?? "Unknown"}</span>
                        <span className="text-xs text-muted-foreground">{fmtDate(c.createdAt)}</span>
                        {canDeleteComment && (
                          <button onClick={() => deleteComment.mutate(c.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity" data-testid={`button-delete-comment-${c.id}`}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-foreground mt-0.5">{c.body}</p>
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-2 pt-1">
                <Textarea
                  placeholder="Add a comment..."
                  value={commentBody}
                  onChange={e => setCommentBody(e.target.value)}
                  className="text-xs min-h-0 h-16 resize-none"
                  data-testid={`input-goal-comment-${goal.id}`}
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentBody.trim()) {
                      e.preventDefault();
                      postComment.mutate();
                    }
                  }}
                />
                <Button size="icon" className="h-8 w-8 shrink-0 self-end" onClick={() => postComment.mutate()} disabled={!commentBody.trim() || postComment.isPending} data-testid={`button-post-comment-${goal.id}`}>
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
    </>
  );
}

interface GoalFormData {
  metric: string;
  period: string;
  target: string;
  title: string;
  customLabel: string;
  notes: string;
  startDate: string;
  endDate: string;
  amId: string;
}

function toLocalDateString(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMonthDefaults() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    startDate: toLocalDateString(first),
    endDate: toLocalDateString(last),
  };
}

const defaultForm: GoalFormData = {
  metric: "contacts_added",
  period: "monthly",
  target: "",
  title: "",
  customLabel: "",
  notes: "",
  ...getMonthDefaults(),
  amId: "",
};

const defaultBulkForm = {
  metric: "contacts_added",
  period: "monthly",
  target: "",
  notes: "",
  ...(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { startDate: fmt(first), endDate: fmt(last) };
  })(),
};

export default function GoalsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [form, setForm] = useState<GoalFormData>(defaultForm);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState(defaultBulkForm);

  const [newMilestoneText, setNewMilestoneText] = useState("");

  const isNam = user?.role === "national_account_manager" || user?.role === "director" || user?.role === "sales" || user?.role === "admin" || user?.role === "sales_director";
  const isAm = user?.role === "account_manager" || user?.role === "logistics_manager" || user?.role === "logistics_coordinator";
  const isAmRole = user?.role === "account_manager";

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["/api/goals"],
    refetchInterval: 120000,
    staleTime: 60000,
  });

  const { data: pairings = [] } = useQuery<Array<{ namId: string; amId: string; namName: string; amName: string }>>({
    queryKey: ["/api/one-on-one/pairings"],
    enabled: user?.role !== "account_manager",
  });

  const { data: allUsers = [] } = useQuery<Array<{ id: string; name: string; role: string; managerId: string | null }>>({
    queryKey: ["/api/team-members"],
  });

  const { data: missingMonthlyGoals = [] } = useQuery<Array<{ amId: string; amName: string }>>({
    queryKey: ["/api/goals/monthly-check"],
    enabled: isNam,
    refetchOnWindowFocus: false,
  });

  // LM milestone management
  const activeTabUser = allUsers.find(u => u.id === activeTab);
  const isLmTab = activeTabUser?.role === "logistics_manager";
  const canManageMilestones = isLmTab && (isNam || isAmRole || user?.role === "admin" || user?.role === "director");
  const isOwnLmGoals = user?.role === "logistics_manager";
  // For LMs viewing their own goals page, use their own id; for managers, use the activeTab LM id
  const milestoneTargetId = isOwnLmGoals ? user?.id : (isLmTab ? activeTab : null);

  const { data: milestonesData } = useQuery<{ milestones: Array<{ id: string; text: string; completed: boolean }> }>({
    queryKey: ["/api/lm-milestones", milestoneTargetId],
    queryFn: async () => {
      const res = await fetch(`/api/lm-milestones/${milestoneTargetId}`, { credentials: "include" });
      if (!res.ok) return { milestones: [] };
      return res.json();
    },
    enabled: !!milestoneTargetId,
  });
  const currentMilestones = milestonesData?.milestones || [];

  const saveMilestonesMutation = useMutation({
    mutationFn: (milestones: Array<{ id: string; text: string; completed: boolean }>) =>
      apiRequest("PUT", `/api/lm-milestones/${milestoneTargetId}`, { milestones }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lm-milestones", milestoneTargetId] }),
    onError: () => toast({ variant: "destructive", description: "Failed to save milestones." }),
  });

  function addMilestone() {
    const text = newMilestoneText.trim();
    if (!text) return;
    const newM = { id: Math.random().toString(36).slice(2), text, completed: false };
    saveMilestonesMutation.mutate([...currentMilestones, newM]);
    setNewMilestoneText("");
  }

  function toggleMilestone(id: string) {
    const updated = currentMilestones.map(m => m.id === id ? { ...m, completed: !m.completed } : m);
    saveMilestonesMutation.mutate(updated);
  }

  function deleteMilestone(id: string) {
    saveMilestonesMutation.mutate(currentMilestones.filter(m => m.id !== id));
  }

  const createGoal = useMutation({
    mutationFn: (data: object) => apiRequest("POST", "/api/goals", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals/monthly-check"] });
      setDialogOpen(false);
      setForm(defaultForm);
      toast({ description: "Goal created." });
    },
    onError: () => toast({ variant: "destructive", description: "Failed to create goal." }),
  });

  const updateGoalMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: object }) => apiRequest("PATCH", `/api/goals/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      setDialogOpen(false);
      setEditingGoal(null);
      toast({ description: "Goal updated." });
    },
  });

  const deleteGoalMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      toast({ description: "Goal deleted." });
    },
  });

  const bulkGoalMutation = useMutation({
    mutationFn: (data: object) => apiRequest("POST", "/api/goals/bulk", data),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals/monthly-check"] });
      setBulkOpen(false);
      setBulkForm(defaultBulkForm);
      toast({ description: res?.created ? `${res.created} goals created for your team.` : "Goals created for your team." });
    },
    onError: () => toast({ variant: "destructive", description: "Failed to create bulk goals." }),
  });

  // LM direct reports of this AM (AMs can set goals for their LM reports)
  const amLmReports = isAmRole
    ? allUsers.filter(u => u.managerId === user?.id && u.role === "logistics_manager")
        .map(u => ({ amId: u.id, amName: u.name }))
        .sort((a, b) => a.amName.localeCompare(b.amName))
    : [];
  const amCanSetGoals = isAmRole && amLmReports.length > 0;

  const uniqueAms: { amId: string; amName: string }[] = isNam
    ? user?.role === "admin"
      // Admins: derive from pairings (full cross-team view)
      ? Array.from(new Map(pairings.map(p => [p.amId, { amId: p.amId, amName: p.amName }])).values())
          .sort((a, b) => a.amName.localeCompare(b.amName))
      // Directors/NAMs: everyone downstream — full recursive team, excluding
      // the current user, their manager above them, and admins
      : allUsers
          .filter(u =>
            u.id !== user?.id &&
            u.role !== "admin" &&
            u.id !== user?.managerId
          )
          .map(u => ({ amId: u.id, amName: u.name }))
          .sort((a, b) => a.amName.localeCompare(b.amName))
    : amLmReports;

  const filteredGoals = activeTab === "all"
    ? goals
    : goals.filter(g => g.amId === activeTab);

  function openCreate(amId?: string) {
    setEditingGoal(null);
    const defaultAmId = amId || (isNam ? uniqueAms[0]?.amId : amLmReports[0]?.amId) || "";
    const defaultMetric = amCanSetGoals && !isNam ? "loads_booked" : "contacts_added";
    setForm({ ...defaultForm, ...getMonthDefaults(), amId: defaultAmId, metric: defaultMetric });
    setDialogOpen(true);
  }

  function openEdit(goal: Goal) {
    setEditingGoal(goal);
    setForm({
      metric: goal.metric,
      period: goal.period,
      target: goal.target,
      title: goal.title || "",
      customLabel: goal.customLabel || "",
      notes: goal.notes || "",
      startDate: goal.startDate,
      endDate: goal.endDate,
      amId: goal.amId,
    });
    setDialogOpen(true);
  }

  function handleSubmit() {
    if (!form.target || !form.amId) {
      toast({ variant: "destructive", description: "Please fill in target and select an AM." });
      return;
    }
    if (form.metric === "custom" && !form.customLabel.trim()) {
      toast({ variant: "destructive", description: "Please enter a name for your custom metric." });
      return;
    }
    if (editingGoal) {
      updateGoalMutation.mutate({ id: editingGoal.id, data: form });
    } else {
      createGoal.mutate(form);
    }
  }

  const goalsByMetric = METRICS.map(m => ({
    ...m,
    count: filteredGoals.filter(g => g.metric === m.value).length,
    avgPct: (() => {
      const gs = filteredGoals.filter(g => g.metric === m.value);
      if (gs.length === 0) return 0;
      return Math.round(gs.reduce((acc, g) => acc + progressPct(parseFloat(g.currentValue || "0"), parseFloat(g.target || "1")), 0) / gs.length);
    })(),
  }));

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            Goals
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isAm ? "Track your performance goals and progress" : "Set and track goals for your team"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(user?.role === "admin" || user?.role === "director" || user?.role === "national_account_manager") && uniqueAms.length > 1 && (
            <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-goals">
              <Users className="h-4 w-4 mr-2" />
              Set for All AMs
            </Button>
          )}
          {(isNam || amCanSetGoals) && (
            <Button onClick={() => openCreate()} data-testid="button-create-goal">
              <Plus className="h-4 w-4 mr-2" />
              New Goal
            </Button>
          )}
        </div>
      </div>

      {isNam && !alertDismissed && missingMonthlyGoals.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-4" data-testid="banner-monthly-goal-alert">
          <BellRing className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Monthly goals not yet set for {new Date().toLocaleString("default", { month: "long" })}
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
              The following reps are missing monthly goals:{" "}
              <span className="font-medium">
                {missingMonthlyGoals.map(m => m.amName).join(", ")}
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-xs border-amber-400 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
              onClick={() => openCreate(missingMonthlyGoals[0]?.amId)}
              data-testid="button-set-missing-goals"
            >
              <Plus className="h-3 w-3 mr-1" />
              Set Goals
            </Button>
          </div>
          <button
            onClick={() => setAlertDismissed(true)}
            className="shrink-0 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
            data-testid="button-dismiss-goal-alert"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {goalsByMetric.map(m => {
          const Icon = m.icon;
          return (
            <Card key={m.value} className="border" data-testid={`stat-card-${m.value}`}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`h-7 w-7 rounded-full ${m.color} flex items-center justify-center`}>
                    <Icon className="h-3.5 w-3.5 text-white" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">{m.label}</span>
                </div>
                <p className="text-2xl font-bold">{m.count}</p>
                <p className="text-xs text-muted-foreground">active goal{m.count !== 1 ? "s" : ""}</p>
                {m.count > 0 && (
                  <div className="mt-2">
                    <Progress value={m.avgPct} className="h-1.5" />
                    <p className="text-xs text-muted-foreground mt-1">{m.avgPct}% avg progress</p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isNam && uniqueAms.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setActiveTab("all")}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${activeTab === "all" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"}`}
            data-testid="tab-all-ams"
          >
            All AMs ({goals.length})
          </button>
          {uniqueAms.map(p => {
            const count = goals.filter(g => g.amId === p.amId).length;
            return (
              <button
                key={p.amId}
                onClick={() => setActiveTab(p.amId)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${activeTab === p.amId ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"}`}
                data-testid={`tab-am-${p.amId}`}
              >
                {p.amName} {count > 0 && `(${count})`}
              </button>
            );
          })}
        </div>
      )}

      {filteredGoals.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 flex flex-col items-center justify-center text-center">
            <Target className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No goals yet</p>
            {isNam && (
              <>
                <p className="text-xs text-muted-foreground mt-1 mb-4">Create goals to track new contacts, load counts, and margin targets</p>
                <Button onClick={() => openCreate(activeTab !== "all" ? activeTab : undefined)} variant="outline" size="sm" data-testid="button-create-first-goal">
                  <Plus className="h-4 w-4 mr-2" /> Create First Goal
                </Button>
              </>
            )}
            {isAm && <p className="text-xs text-muted-foreground mt-1">Your NAM will set goals for your review</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredGoals.map(goal => (
            <GoalCard
              key={goal.id}
              goal={goal}
              currentUserId={user!.id}
              userRole={user!.role}
              allUsers={allUsers}
              onEdit={openEdit}
              onDelete={id => deleteGoalMutation.mutate(id)}
            />
          ))}
          {isNam && activeTab !== "all" && (
            <Button variant="outline" className="w-full" onClick={() => openCreate(activeTab)} data-testid="button-add-goal-for-am">
              <Plus className="h-4 w-4 mr-2" /> Add Goal for {uniqueAms.find(p => p.amId === activeTab)?.amName}
            </Button>
          )}
        </div>
      )}

      {/* Development Milestones — shown for manager viewing LM tab, or LM viewing their own goals */}
      {(canManageMilestones || user?.role === "logistics_manager") && (
        <Card className="border-blue-200 dark:border-blue-800">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Target className="h-4 w-4 text-blue-500" />
                Development Milestones
                {canManageMilestones && (
                  <span className="text-xs font-normal text-muted-foreground">
                    — for {activeTabUser?.name}
                  </span>
                )}
              </CardTitle>
              {currentMilestones.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {currentMilestones.filter(m => m.completed).length}/{currentMilestones.length} complete
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {canManageMilestones
                ? "Qualitative milestones for this LM's path to Account Manager."
                : "Qualitative milestones set by your manager for your development path."}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {currentMilestones.length === 0 && !canManageMilestones && (
              <p className="text-xs text-muted-foreground py-2">Your manager hasn't set any milestones yet.</p>
            )}
            {currentMilestones.map(m => (
              <div key={m.id} className="flex items-start gap-2 group">
                <button
                  onClick={() => toggleMilestone(m.id)}
                  className={`shrink-0 mt-0.5 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors ${m.completed ? "border-green-500 bg-green-500" : "border-muted-foreground/40 hover:border-primary"}`}
                  data-testid={`button-milestone-toggle-${m.id}`}
                  disabled={saveMilestonesMutation.isPending}
                >
                  {m.completed && <CheckCircle2 className="h-3 w-3 text-white" />}
                </button>
                <span className={`flex-1 text-sm leading-relaxed ${m.completed ? "line-through text-muted-foreground" : ""}`}>
                  {m.text}
                </span>
                {canManageMilestones && (
                  <button
                    onClick={() => deleteMilestone(m.id)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                    data-testid={`button-milestone-delete-${m.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            {canManageMilestones && (
              <div className="flex gap-2 pt-1">
                <Input
                  placeholder="Add a milestone… (e.g. Complete TMS training, Shadow AM call)"
                  value={newMilestoneText}
                  onChange={e => setNewMilestoneText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addMilestone(); } }}
                  className="text-sm h-8"
                  data-testid="input-new-milestone"
                />
                <Button
                  size="sm"
                  onClick={addMilestone}
                  disabled={!newMilestoneText.trim() || saveMilestonesMutation.isPending}
                  className="h-8 shrink-0"
                  data-testid="button-add-milestone"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={v => { if (!v) { setDialogOpen(false); setEditingGoal(null); } }}>
        <DialogContent className="max-w-md" data-testid="dialog-goal-form">
          <DialogHeader>
            <DialogTitle>{editingGoal ? "Edit Goal" : "Create Goal"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {((isNam && !isAm) || amCanSetGoals) && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Team Member</label>
                <Select value={form.amId} onValueChange={v => setForm(f => ({ ...f, amId: v }))}>
                  <SelectTrigger data-testid="select-goal-am">
                    <SelectValue placeholder="Select team member..." />
                  </SelectTrigger>
                  <SelectContent>
                    {uniqueAms.map(p => (
                      <SelectItem key={p.amId} value={p.amId}>{p.amName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Metric</label>
              <Select value={form.metric} onValueChange={v => setForm(f => ({ ...f, metric: v, customLabel: "" }))}>
                <SelectTrigger data-testid="select-goal-metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}{m.value === "custom" ? " — must be actionable & measurable" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.metric === "custom" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Metric Name <span className="text-red-500">*</span></label>
                <Input
                  placeholder="e.g. Site Visits, QBRs, New Lanes Quoted"
                  value={form.customLabel}
                  onChange={e => setForm(f => ({ ...f, customLabel: e.target.value }))}
                  data-testid="input-goal-custom-label"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Goal Title <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input
                placeholder="e.g. Q2 Contacts Push"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                data-testid="input-goal-title"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Period</label>
                <Select value={form.period} onValueChange={v => setForm(f => ({ ...f, period: v }))}>
                  <SelectTrigger data-testid="select-goal-period">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIODS.map(p => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {form.metric === "custom" ? "Target (#)" : form.metric === "margin" ? "Target ($)" : `Target (${getMetric(form.metric).unit})`}
                </label>
                <Input
                  type="number"
                  placeholder={form.metric === "margin" ? "e.g. 50000" : "e.g. 10"}
                  value={form.target}
                  onChange={e => setForm(f => ({ ...f, target: e.target.value }))}
                  data-testid="input-goal-target"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Start Date</label>
                <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} data-testid="input-goal-start" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">End Date</label>
                <Input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} data-testid="input-goal-end" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Textarea
                placeholder="Context, expectations, or strategy..."
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="resize-none h-20"
                data-testid="input-goal-notes"
              />
            </div>
            {form.metric === "contacts_added" && (
              <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3">
                <p className="text-xs text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                  New Contacts are automatically tracked from the CRM — no manual updates needed.
                </p>
              </div>
            )}
            {form.metric === "meaningful_touchpoints" && (
              <div className="rounded-md bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 p-3">
                <p className="text-xs text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                  Meaningful Touchpoints are automatically tracked — counts conversations flagged as meaningful (freight needs, rates, real opportunity, strategy).
                </p>
              </div>
            )}
            {form.metric === "margin" && (
              <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3">
                <p className="text-xs text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                  Margin $ is automatically pulled from the latest financial data upload — no manual updates needed.
                </p>
              </div>
            )}
            {form.metric === "loads_booked" && (
              <div className="rounded-md bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 p-3">
                <p className="text-xs text-teal-700 dark:text-teal-300 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                  Loads Booked is automatically counted from the financial upload using the Dispatcher column — no manual updates needed.
                </p>
              </div>
            )}
            {form.metric === "margin_pct" && (
              <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3">
                <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                  Margin % is automatically calculated from the financial upload (Margin ÷ Total Charges) — no manual updates needed. Set target as a whole number (e.g. 15 for 15%).
                </p>
              </div>
            )}
            {form.metric === "custom" && (
              <div className="rounded-md bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 p-3">
                <p className="text-xs text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
                  <Sliders className="h-3.5 w-3.5 shrink-0" />
                  Progress is updated manually — make sure this goal is specific, measurable, and agreed upon.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); setEditingGoal(null); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={createGoal.isPending || updateGoalMutation.isPending} data-testid="button-save-goal">
              {editingGoal ? "Save Changes" : "Create Goal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Goal Dialog */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-bulk-goals">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Set Goal for All AMs
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              This will create the same goal for all {uniqueAms.length} members on your team. Existing goals are not overwritten.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Metric</label>
              <Select value={bulkForm.metric} onValueChange={(v) => setBulkForm(f => ({ ...f, metric: v }))}>
                <SelectTrigger data-testid="select-bulk-metric"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METRICS.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Period</label>
              <Select value={bulkForm.period} onValueChange={(v) => setBulkForm(f => ({ ...f, period: v }))}>
                <SelectTrigger data-testid="select-bulk-period"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERIODS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Start Date</label>
                <Input type="date" value={bulkForm.startDate} onChange={(e) => setBulkForm(f => ({ ...f, startDate: e.target.value }))} data-testid="input-bulk-start" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">End Date</label>
                <Input type="date" value={bulkForm.endDate} onChange={(e) => setBulkForm(f => ({ ...f, endDate: e.target.value }))} data-testid="input-bulk-end" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Target ({getMetric(bulkForm.metric).unit})</label>
              <Input
                type="number"
                placeholder="e.g. 50"
                value={bulkForm.target}
                onChange={(e) => setBulkForm(f => ({ ...f, target: e.target.value }))}
                data-testid="input-bulk-target"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Notes (optional)</label>
              <Input placeholder="Context or instructions..." value={bulkForm.notes} onChange={(e) => setBulkForm(f => ({ ...f, notes: e.target.value }))} data-testid="input-bulk-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button
              disabled={!bulkForm.target || bulkGoalMutation.isPending}
              onClick={() => {
                if (!bulkForm.target) { toast({ variant: "destructive", description: "Enter a target value." }); return; }
                if (bulkForm.startDate && bulkForm.endDate && bulkForm.endDate < bulkForm.startDate) {
                  toast({ variant: "destructive", description: "End date must be after start date." }); return;
                }
                if (bulkForm.metric === "custom" && !(bulkForm as any).customLabel?.trim()) {
                  toast({ variant: "destructive", description: "Enter a name for your custom metric." }); return;
                }
                bulkGoalMutation.mutate({
                  ...bulkForm,
                  amIds: uniqueAms.map(a => a.amId),
                });
              }}
              data-testid="button-confirm-bulk-goals"
            >
              {bulkGoalMutation.isPending ? "Creating..." : `Create for ${uniqueAms.length} people`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
