import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ListTodo, Plus, Circle, PlayCircle, CheckCircle2, Calendar, Trash2,
  ChevronDown, ChevronUp, Bell, BellRing, Loader2, MessageSquare,
  List, ChevronLeft, ChevronRight as ChevronRightIcon, Plane,
  AlertTriangle, Users, User as UserIcon, StickyNote,
  Truck, Route,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useMarkNotificationsRead, TASK_NOTIFICATION_TYPES } from "@/hooks/use-notifications";
import { TaskDialog } from "@/components/task-dialog";
import { FileAttachmentList } from "@/components/file-attachment";
import type { ProcurementLaneInfo } from "@/components/carrier-procurement-workspace";
import type { Company, Task, User, PersonalAlert, LaneCarrier } from "@shared/schema";
type TaskWithCount = Task & { commentCount?: number };

type SafeUser = Omit<User, "password">;

type PtoPassoff = {
  id: string; userId: string; coveringUserId: string;
  startDate: string; endDate: string; status: string;
  coveringUser?: { name: string };
  user?: { name: string };
};

function TaskCalendarView({
  tasks,
  companies,
  teamMembers,
  currentUser,
  onTaskClick,
}: {
  tasks: TaskWithCount[];
  companies: Company[];
  teamMembers: SafeUser[];
  currentUser: { id: string; role: string } | null;
  onTaskClick: (task: TaskWithCount) => void;
}) {
  const today = new Date();
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const { data: passoffs = [] } = useQuery<PtoPassoff[]>({ queryKey: ["/api/pto-passoffs"] });

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const tasksByDay = new Map<number, TaskWithCount[]>();
  tasks.forEach(t => {
    if (!t.dueDate) return;
    const d = new Date(t.dueDate + "T00:00:00");
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!tasksByDay.has(day)) tasksByDay.set(day, []);
      tasksByDay.get(day)!.push(t);
    }
  });

  const activePassoffs = passoffs.filter(p => {
    const start = new Date(p.startDate + "T00:00:00");
    const end = new Date(p.endDate + "T00:00:00");
    const mStart = new Date(year, month, 1);
    const mEnd = new Date(year, month + 1, 0);
    return start <= mEnd && end >= mStart && (p.status === "active" || p.status === "draft");
  });

  function ptoOnDay(day: number) {
    const d = new Date(year, month, day);
    return activePassoffs.filter(p => {
      const start = new Date(p.startDate + "T00:00:00");
      const end = new Date(p.endDate + "T00:00:00");
      return d >= start && d <= end;
    });
  }

  const prevMonth = () => { setViewDate(new Date(year, month - 1, 1)); setSelectedDay(null); };
  const nextMonth = () => { setViewDate(new Date(year, month + 1, 1)); setSelectedDay(null); };

  const monthLabel = viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const selectedTasks = selectedDay ? (tasksByDay.get(selectedDay) || []) : [];

  function statusDot(status: string) {
    if (status === "completed") return "bg-green-500";
    if (status === "in_progress") return "bg-blue-500";
    return "bg-amber-500";
  }

  const getCompanyName = (id: string | null) => id ? companies.find(c => c.id === id)?.name || "" : "";

  return (
    <div className="space-y-4" data-testid="task-calendar-view">
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="p-1 rounded hover:bg-muted transition-colors" data-testid="button-prev-month">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold" data-testid="text-calendar-month">{monthLabel}</h2>
        <button onClick={nextMonth} className="p-1 rounded hover:bg-muted transition-colors" data-testid="button-next-month">
          <ChevronRightIcon className="h-5 w-5" />
        </button>
      </div>

      {activePassoffs.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-200 dark:bg-violet-900 inline-block" /> PTO Coverage</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500 inline-block" /> Open task</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500 inline-block" /> In progress</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500 inline-block" /> Completed</span>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 bg-muted/50">
          {dayNames.map(d => (
            <div key={d} className="py-2 text-center text-xs font-medium text-muted-foreground">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 divide-x divide-y border-t">
          {Array.from({ length: firstDow }).map((_, i) => (
            <div key={`pad-${i}`} className="h-24 bg-muted/20" />
          ))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const isToday = dayKey === todayKey;
            const isSelected = day === selectedDay;
            const dayTasks = tasksByDay.get(day) || [];
            const ptos = ptoOnDay(day);

            return (
              <div
                key={day}
                className={`h-24 p-1.5 cursor-pointer transition-colors relative overflow-hidden
                  ${isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : "hover:bg-muted/40"}
                  ${ptos.length > 0 ? "bg-violet-50 dark:bg-violet-950/20" : ""}
                `}
                onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                data-testid={`calendar-day-${day}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-medium w-5 h-5 flex items-center justify-center rounded-full
                    ${isToday ? "bg-primary text-primary-foreground" : "text-foreground"}`}>
                    {day}
                  </span>
                  {ptos.length > 0 && <Plane className="h-3 w-3 text-violet-500 shrink-0" />}
                </div>
                {dayTasks.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 mt-0.5">
                    {dayTasks.slice(0, 4).map(t => (
                      <span key={t.id} className={`h-1.5 w-1.5 rounded-full ${statusDot(t.status)}`} />
                    ))}
                    {dayTasks.length > 4 && (
                      <span className="text-[9px] text-muted-foreground">+{dayTasks.length - 4}</span>
                    )}
                  </div>
                )}
                {dayTasks.slice(0, 2).map(t => (
                  <p key={t.id} className="text-[10px] leading-tight text-muted-foreground truncate mt-0.5">{t.title}</p>
                ))}
                {dayTasks.length > 2 && (
                  <p className="text-[9px] text-muted-foreground">+{dayTasks.length - 2} more</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {selectedDay && (
        <Card data-testid="card-selected-day-tasks">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              {new Date(year, month, selectedDay).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              {selectedTasks.length > 0 && <Badge variant="secondary" className="font-normal">{selectedTasks.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            {selectedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No tasks due this day</p>
            ) : (
              <div className="space-y-1">
                {selectedTasks.map(task => {
                  const company = getCompanyName(task.companyId);
                  const assignee = teamMembers.find(u => u.id === task.assignedTo)?.name;
                  return (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 cursor-pointer group"
                      onClick={() => onTaskClick(task)}
                      data-testid={`calendar-task-row-${task.id}`}
                    >
                      <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot(task.status)}`} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`}>{task.title}</p>
                        {(company || assignee) && (
                          <p className="text-xs text-muted-foreground truncate">
                            {[company, assignee ? `→ ${assignee}` : ""].filter(Boolean).join(" ")}
                          </p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs capitalize shrink-0">{task.status.replace("_", " ")}</Badge>
                    </div>
                  );
                })}
              </div>
            )}
            {ptoOnDay(selectedDay).map(p => (
              <div key={p.id} className="flex items-center gap-2 p-2 rounded bg-violet-50 dark:bg-violet-950/30 mt-2">
                <Plane className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                <p className="text-xs text-violet-700 dark:text-violet-300">
                  PTO: {p.user?.name || "Rep"} — covered by {p.coveringUser?.name || "Teammate"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
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

function isOverdue(task: TaskWithCount) {
  if (!task.dueDate || task.status === "completed") return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(task.dueDate + "T00:00:00");
  return due < today;
}

const statusIcon = (status: string) => {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "in_progress") return <PlayCircle className="h-4 w-4 text-blue-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
};

const nextStatus = (s: string) => s === "open" ? "in_progress" : s === "in_progress" ? "completed" : "open";

function formatDate(dateStr: string | null) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function AlertDialog({ open, onOpenChange, companies }: { open: boolean; onOpenChange: (v: boolean) => void; companies: Company[] }) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [companyId, setCompanyId] = useState("");

  useEffect(() => {
    if (open) {
      setTitle("");
      setNotes("");
      setScheduledDate("");
      setCompanyId("");
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/alerts", {
        title,
        notes: notes || null,
        scheduledDate,
        companyId: companyId && companyId !== "none" ? companyId : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Alert created" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "Failed to create alert", variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !scheduledDate) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="text-alert-dialog-title">Create Alert</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="alert-title">Title</Label>
            <Input
              id="alert-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Follow up with shipper"
              required
              data-testid="input-alert-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="alert-notes">Notes (optional)</Label>
            <Textarea
              id="alert-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Additional details..."
              rows={2}
              data-testid="input-alert-notes"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="alert-date">Reminder Date</Label>
            <Input
              id="alert-date"
              type="date"
              value={scheduledDate}
              onChange={e => setScheduledDate(e.target.value)}
              required
              data-testid="input-alert-date"
            />
          </div>
          <div className="space-y-2">
            <Label>Link to Account (optional)</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger data-testid="select-alert-company">
                <SelectValue placeholder="No account linked" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No account linked</SelectItem>
                {companies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-alert-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !title.trim() || !scheduledDate} data-testid="button-alert-save">
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create Alert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProcurementTaskMiniSummary({ lane, taskId }: { lane: ProcurementLaneInfo; taskId: string }) {
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
    <div className="mt-1 space-y-0.5" data-testid={`procurement-summary-${taskId}`}>
      {(lane.customerName || lane.awardTitle) && (
        <div className="text-xs text-muted-foreground">
          {lane.customerName && <span className="font-medium">{lane.customerName}</span>}
          {lane.customerName && lane.awardTitle && " · "}
          {lane.awardTitle && <span>{lane.awardTitle}</span>}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Route className="h-3 w-3" />
          <span>{lane.origin} → {lane.destination}</span>
        </div>
        {lane.volume > 0 && (
          <span className="text-xs text-muted-foreground">{Number(lane.volume).toLocaleString()} loads/yr</span>
        )}
        {lane.rate && (
          <span className="text-xs text-muted-foreground">${lane.rate}/load</span>
        )}
      </div>
      <Badge className={`text-xs h-5 px-1.5 ${coverageColor}`} data-testid={`badge-proc-coverage-${taskId}`}>
        <Truck className="h-2.5 w-2.5 mr-1" />
        {committedCount}/{activeCount} committed · {activeCount}/5 contacted
      </Badge>
    </div>
  );
}

export default function TasksPage() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskWithCount | undefined>();
  const [focusComments, setFocusComments] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showAlerts, setShowAlerts] = useState(true);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [showMyTasksOnly, setShowMyTasksOnly] = useState(true);
  const markRead = useMarkNotificationsRead(TASK_NOTIFICATION_TYPES);

  const isAdminRole = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales";

  useEffect(() => {
    if (currentUser) {
      markRead.mutate();
    }
  }, [currentUser?.id]);

  useEffect(() => {
    if (window.location.hash === "#completed") {
      setShowCompleted(true);
      setTimeout(() => {
        document.getElementById("completed")?.scrollIntoView({ behavior: "smooth" });
      }, 300);
    } else if (window.location.hash === "#alerts") {
      setShowAlerts(true);
      setTimeout(() => {
        document.getElementById("alerts")?.scrollIntoView({ behavior: "smooth" });
      }, 300);
    }
  }, []);

  const { data: allTasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
    refetchInterval: 180000,
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: alerts = [], isLoading: alertsLoading } = useQuery<PersonalAlert[]>({
    queryKey: ["/api/alerts"],
  });

  // Filter tasks: admins can toggle between My Tasks / All Tasks
  const scopedTasks = (isAdminRole && !showMyTasksOnly)
    ? allTasks
    : allTasks.filter(t => t.assignedTo === currentUser?.id || t.assignedBy === currentUser?.id);

  const openTasks = scopedTasks.filter(t => t.status !== "completed");
  const overdueTasks = openTasks
    .filter(t => isOverdue(t))
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
  const onTimeTasks = openTasks
    .filter(t => !isOverdue(t))
    .sort((a, b) => {
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (a.status !== "in_progress" && b.status === "in_progress") return 1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  const completedTasks = scopedTasks
    .filter(t => t.status === "completed")
    .sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return b.createdAt.localeCompare(a.createdAt);
    });

  const pendingAlerts = alerts.filter(a => !a.fired).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  const firedAlerts = alerts.filter(a => a.fired).sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate));

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiRequest("PATCH", `/api/tasks/${id}`, { status });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      if (vars.status === "completed") {
        toast({
          title: "Task completed! ✓",
          description: "Nice work — keep it moving.",
        });
      }
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

  const bumpMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/tasks/${id}/bump`, {});
    },
    onSuccess: () => {
      toast({ title: "Reminder sent", description: "The assignee has been notified." });
    },
    onError: () => {
      toast({ title: "Could not send reminder", variant: "destructive" });
    },
  });

  const deleteAlertMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/alerts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Alert deleted" });
    },
  });

  const getUserName = (userId: string) => teamMembers.find(u => u.id === userId)?.name || "";
  const getCompanyName = (companyId: string | null) => companyId ? companies?.find(c => c.id === companyId)?.name || "" : "";

  const renderTaskRow = (task: TaskWithCount, isCompleted = false, urgent = false) => {
    const companyName = getCompanyName(task.companyId);
    const assigneeName = getUserName(task.assignedTo);
    const assignerName = getUserName(task.assignedBy);
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
        className={`flex items-start gap-3 p-3 rounded-lg border transition-all group cursor-pointer
          ${urgent
            ? "border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/10 hover:bg-red-50 dark:hover:bg-red-950/20"
            : procLane
              ? "border-primary/20 bg-primary/3 hover:border-primary/40 hover:bg-primary/5"
              : "border-transparent hover:border-border hover:bg-muted/50"}
          ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`task-row-${task.id}`}
        onClick={() => { setEditingTask(task); setFocusComments(false); setTaskDialogOpen(true); }}
      >
        {/* Quick-complete checkbox */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            const newStatus = task.status === "completed" ? "open" : "completed";
            toggleStatusMutation.mutate({ id: task.id, status: newStatus });
          }}
          className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all hover:scale-110 mt-0.5
            ${task.status === "completed"
              ? "bg-green-500 border-green-500 text-white"
              : urgent
                ? "border-red-400 hover:border-red-500 hover:bg-red-100 dark:hover:bg-red-900/20"
                : "border-muted-foreground/40 hover:border-primary hover:bg-primary/10"}`}
          title={task.status === "completed" ? "Mark as open" : "Mark as complete"}
          data-testid={`button-complete-${task.id}`}
        >
          {task.status === "completed" && <CheckCircle2 className="h-3.5 w-3.5" />}
        </button>

        {/* Status cycle button */}
        {!isCompleted && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleStatusMutation.mutate({ id: task.id, status: nextStatus(task.status) }); }}
            className="shrink-0 hover:scale-110 transition-transform mt-0.5"
            title={`Status: ${task.status}. Click to advance.`}
            data-testid={`button-toggle-status-${task.id}`}
          >
            {statusIcon(task.status)}
          </button>
        )}

        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${isCompleted ? "line-through text-muted-foreground" : ""}`}
             data-testid={`text-task-title-${task.id}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {companyName && (
              <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`} onClick={(e) => e.stopPropagation()}>
                {companyName}
              </Link>
            )}
            {isAdminRole && !showMyTasksOnly && assigneeName && (
              <span className="text-xs text-muted-foreground" data-testid={`text-task-assignee-${task.id}`}>→ {assigneeName}</span>
            )}
            {assignerName && task.assignedBy !== currentUser?.id && (
              <span className="text-xs text-muted-foreground">from {assignerName}</span>
            )}
            {isCompleted && task.createdAt && (
              <span className="text-xs text-muted-foreground" data-testid={`text-task-completed-date-${task.id}`}>
                created {formatDate(task.createdAt)}
              </span>
            )}
          </div>
          {procLane && (
            <ProcurementTaskMiniSummary lane={procLane} taskId={task.id} />
          )}
          {procLane && !isCompleted && (
            <div className="mt-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs border-primary/30 text-primary hover:bg-primary/10"
                onClick={(e) => { e.stopPropagation(); setEditingTask(task); setFocusComments(false); setTaskDialogOpen(true); }}
                data-testid={`button-open-workspace-${task.id}`}
              >
                <Truck className="h-3 w-3 mr-1" />
                Open Workspace
              </Button>
            </div>
          )}
          <FileAttachmentList entityType="task" entityIds={[task.id]} />
        </div>

        {!isCompleted && !procLane && dueDateBadge(task.dueDate)}

        {(task.commentCount ?? 0) > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditingTask(task); setFocusComments(true); setTaskDialogOpen(true); }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary shrink-0 transition-colors"
            title="View notes"
            data-testid={`badge-task-comments-${task.id}`}
          >
            <MessageSquare className="h-3 w-3" />
            {task.commentCount}
          </button>
        )}

        {/* Quick note button — visible on hover when no comments yet */}
        {(task.commentCount ?? 0) === 0 && !isCompleted && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditingTask(task); setFocusComments(true); setTaskDialogOpen(true); }}
            className="shrink-0 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
            title="Add a note"
            data-testid={`button-add-note-${task.id}`}
          >
            <StickyNote className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Bump reminder */}
        {(() => {
          if (isCompleted || task.assignedBy !== currentUser?.id || !task.dueDate) return null;
          const today = new Date(); today.setHours(0, 0, 0, 0);
          const due = new Date(task.dueDate + "T00:00:00");
          const daysOver = Math.floor((today.getTime() - due.getTime()) / 86400000);
          if (daysOver < 2) return null;
          return (
            <button
              onClick={(e) => { e.stopPropagation(); bumpMutation.mutate(task.id); }}
              className="shrink-0 text-amber-500 hover:text-amber-600 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Send overdue reminder to assignee"
              data-testid={`button-bump-task-${task.id}`}
            >
              <BellRing className="h-3.5 w-3.5" />
            </button>
          );
        })()}

        <button
          onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(task.id); }}
          className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          data-testid={`button-delete-task-${task.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const renderAlertRow = (alert: PersonalAlert) => {
    const companyName = getCompanyName(alert.companyId);
    return (
      <div
        key={alert.id}
        className={`flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${alert.fired ? "opacity-60" : ""}`}
        data-testid={`alert-row-${alert.id}`}
      >
        <div className="shrink-0">
          {alert.fired ? (
            <BellRing className="h-4 w-4 text-amber-500" />
          ) : (
            <Bell className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${alert.fired ? "text-muted-foreground" : ""}`}
             data-testid={`text-alert-title-${alert.id}`}>
            {alert.title}
          </p>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {companyName && (
              <Link href={`/companies/${alert.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-alert-company-${alert.id}`}>
                {companyName}
              </Link>
            )}
            {alert.notes && (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">{alert.notes}</span>
            )}
            {alert.fired && (
              <Badge variant="secondary" className="text-xs" data-testid={`badge-alert-fired-${alert.id}`}>Sent</Badge>
            )}
          </div>
        </div>
        {dueDateBadge(alert.scheduledDate)}
        <button
          onClick={() => deleteAlertMutation.mutate(alert.id)}
          className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          data-testid={`button-delete-alert-${alert.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex gap-0 p-4 sm:p-6 max-w-5xl mx-auto w-full">
      {/* Left vertical tab strip */}
      <div className="flex flex-col gap-1 w-36 shrink-0 pt-12 pr-3" data-testid="tasks-tab-nav">
        <button
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left
            ${viewMode === "list"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          onClick={() => setViewMode("list")}
          data-testid="button-view-list"
        >
          <List className="h-4 w-4 shrink-0" /> List
        </button>
        <button
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left
            ${viewMode === "calendar"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          onClick={() => setViewMode("calendar")}
          data-testid="button-view-calendar"
        >
          <Calendar className="h-4 w-4 shrink-0" /> Calendar
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-tasks-heading">
              <ListTodo className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              Tasks
            </h1>
            {/* My Tasks / All Tasks toggle for admin roles */}
            {isAdminRole && (
              <div className="flex items-center gap-1 mt-2 p-0.5 rounded-lg bg-muted w-fit" data-testid="toggle-task-scope">
                <button
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors
                    ${showMyTasksOnly ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => setShowMyTasksOnly(true)}
                  data-testid="button-my-tasks"
                >
                  <UserIcon className="h-3 w-3" /> My Tasks
                </button>
                <button
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors
                    ${!showMyTasksOnly ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => setShowMyTasksOnly(false)}
                  data-testid="button-all-tasks"
                >
                  <Users className="h-3 w-3" /> All Tasks
                </button>
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              className="gap-1"
              onClick={() => setAlertDialogOpen(true)}
              data-testid="button-add-alert"
            >
              <Bell className="h-4 w-4" /> Add Alert
            </Button>
            <Button
              className="gap-1"
              onClick={() => { setEditingTask(undefined); setTaskDialogOpen(true); }}
              data-testid="button-add-task-page"
            >
              <Plus className="h-4 w-4" /> Add Task
            </Button>
          </div>
        </div>

      {viewMode === "calendar" && (
        <TaskCalendarView
          tasks={scopedTasks}
          companies={companies}
          teamMembers={teamMembers}
          currentUser={currentUser ?? null}
          onTaskClick={task => { setEditingTask(task); setTaskDialogOpen(true); }}
        />
      )}
      {viewMode === "list" && (
      <>
      {/* Overdue section — urgent red card */}
      {overdueTasks.length > 0 && (
        <Card className="border-red-200 dark:border-red-900/50" data-testid="card-overdue-tasks">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              Overdue
              <Badge className="ml-1 font-normal bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">
                {overdueTasks.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {overdueTasks.map(task => renderTaskRow(task, false, true))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-open-tasks">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Circle className="h-4 w-4 text-muted-foreground" />
            {overdueTasks.length > 0 ? "Upcoming" : "Open Tasks"}
            {!tasksLoading && onTimeTasks.length > 0 && (
              <Badge variant="secondary" className="ml-1 font-normal">{onTimeTasks.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tasksLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : onTimeTasks.length > 0 ? (
            <div className="space-y-1">
              {onTimeTasks.map(task => renderTaskRow(task))}
            </div>
          ) : overdueTasks.length > 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <p className="text-sm">No upcoming tasks</p>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No open tasks</p>
              <p className="text-xs mt-1">You're all caught up!</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-completed-tasks" id="completed">
        <CardHeader className="pb-3">
          <button
            className="flex items-center justify-between w-full text-left"
            onClick={() => setShowCompleted(v => !v)}
            data-testid="button-toggle-completed-section"
          >
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Completed
              {!tasksLoading && completedTasks.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{completedTasks.length}</Badge>
              )}
            </CardTitle>
            {showCompleted ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>
        {showCompleted && (
          <CardContent>
            {tasksLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : completedTasks.length > 0 ? (
              <div className="space-y-1">
                {completedTasks.map(task => renderTaskRow(task, true))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <ListTodo className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No completed tasks yet</p>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card data-testid="card-my-alerts" id="alerts">
        <CardHeader className="pb-3">
          <button
            className="flex items-center justify-between w-full text-left"
            onClick={() => setShowAlerts(v => !v)}
            data-testid="button-toggle-alerts-section"
          >
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-amber-500" />
              My Alerts
              {!alertsLoading && alerts.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{alerts.length}</Badge>
              )}
            </CardTitle>
            {showAlerts ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>
        {showAlerts && (
          <CardContent>
            {alertsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : pendingAlerts.length > 0 || firedAlerts.length > 0 ? (
              <div className="space-y-1">
                {pendingAlerts.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-3 pt-1" data-testid="text-pending-alerts-label">Upcoming</p>
                    {pendingAlerts.map(alert => renderAlertRow(alert))}
                  </>
                )}
                {firedAlerts.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-3 pt-3" data-testid="text-fired-alerts-label">Sent</p>
                    {firedAlerts.map(alert => renderAlertRow(alert))}
                  </>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Bell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No alerts set</p>
                <p className="text-xs mt-1">Create an alert to get reminded about important follow-ups</p>
              </div>
            )}
          </CardContent>
        )}
      </Card>
      </>
      )}

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={(open) => { setTaskDialogOpen(open); if (!open) setFocusComments(false); }}
        editingTask={editingTask}
        focusComments={focusComments}
      />

      <AlertDialog
        open={alertDialogOpen}
        onOpenChange={setAlertDialogOpen}
        companies={companies}
      />
      </div>
    </div>
  );
}
