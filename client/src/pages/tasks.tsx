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
  ChevronDown, ChevronUp, Bell, BellRing, Loader2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { TaskDialog } from "@/components/task-dialog";
import { FileAttachmentList } from "@/components/file-attachment";
import type { Company, Task, User, PersonalAlert } from "@shared/schema";

type SafeUser = Omit<User, "password">;

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

export default function TasksPage() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [showCompleted, setShowCompleted] = useState(true);
  const [showAlerts, setShowAlerts] = useState(true);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);

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

  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "director";

  const myTasks = isAdmin
    ? allTasks
    : allTasks.filter(t => t.assignedTo === currentUser?.id);

  const openTasks = myTasks
    .filter(t => t.status !== "completed")
    .sort((a, b) => {
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (a.status !== "in_progress" && b.status === "in_progress") return 1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

  const completedTasks = myTasks
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
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

  const renderTaskRow = (task: Task, isCompleted = false) => {
    const companyName = getCompanyName(task.companyId);
    const assigneeName = getUserName(task.assignedTo);
    const assignerName = getUserName(task.assignedBy);
    return (
      <div
        key={task.id}
        className={`flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${isCompleted ? "opacity-60" : ""}`}
        data-testid={`task-row-${task.id}`}
      >
        <button
          onClick={() => toggleStatusMutation.mutate({ id: task.id, status: nextStatus(task.status) })}
          className="shrink-0 hover:scale-110 transition-transform"
          title={`Status: ${task.status}. Click to change.`}
          data-testid={`button-toggle-status-${task.id}`}
        >
          {statusIcon(task.status)}
        </button>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${isCompleted ? "line-through text-muted-foreground" : ""}`}
             data-testid={`text-task-title-${task.id}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {companyName && (
              <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`}>
                {companyName}
              </Link>
            )}
            {isAdmin && assigneeName && (
              <span className="text-xs text-muted-foreground" data-testid={`text-task-assignee-${task.id}`}>assigned to {assigneeName}</span>
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
          <FileAttachmentList entityType="task" entityIds={[task.id]} />
        </div>
        {!isCompleted && dueDateBadge(task.dueDate)}
        <button
          onClick={() => { setEditingTask(task); setTaskDialogOpen(true); }}
          className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs"
          data-testid={`button-edit-task-${task.id}`}
        >
          Edit
        </button>
        <button
          onClick={() => deleteMutation.mutate(task.id)}
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
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-tasks-heading">
            <ListTodo className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            Tasks
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-tasks-subtitle">
            {isAdmin ? "All team tasks" : "Your tasks in one place"}
          </p>
        </div>
        <div className="flex gap-2">
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

      <Card data-testid="card-open-tasks">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Circle className="h-4 w-4 text-muted-foreground" />
            Open Tasks
            {!tasksLoading && openTasks.length > 0 && (
              <Badge variant="secondary" className="ml-1 font-normal">{openTasks.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tasksLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : openTasks.length > 0 ? (
            <div className="space-y-1">
              {openTasks.map(task => renderTaskRow(task))}
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
              Completed Tasks
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

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        editingTask={editingTask}
      />

      <AlertDialog
        open={alertDialogOpen}
        onOpenChange={setAlertDialogOpen}
        companies={companies}
      />
    </div>
  );
}
