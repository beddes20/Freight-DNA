import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2, Users, MapPin, DollarSign, ChevronRight, TrendingUp,
  ShieldCheck, UserCircle, ClipboardList, Plus, Circle, PlayCircle,
  CheckCircle2, Calendar, Trash2, Megaphone, MessageSquare, ChevronDown,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { TaskDialog } from "@/components/task-dialog";
import { CalloutDialog } from "@/components/callout-dialog";
import type { Company, Contact, Task, User, Callout } from "@shared/schema";

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

export default function Dashboard() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [calloutDialogOpen, setCalloutDialogOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; title: string } | undefined>();
  const [expandedCallouts, setExpandedCallouts] = useState<Set<string>>(new Set());

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: allTasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const canSeeTeam = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager";
  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/users"],
    enabled: canSeeTeam,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: allCallouts = [], isLoading: calloutsLoading } = useQuery<Callout[]>({
    queryKey: ["/api/callouts"],
  });

  const deleteCalloutMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/callouts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/callouts"] });
      toast({ title: "Callout deleted" });
    },
  });

  const topLevelCallouts = allCallouts
    .filter(c => !c.parentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  const repliesFor = (parentId: string) =>
    allCallouts
      .filter(c => c.parentId === parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const toggleExpanded = (id: string) => {
    setExpandedCallouts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const getAuthorName = (authorId: string) => teamMembers.find(u => u.id === authorId)?.name || "Unknown";

  const tagColors: Record<string, string> = {
    Trend: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    Callout: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    Idea: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  };

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
  ];

  const nams = allUsers.filter((u) => u.role === "national_account_manager" || u.role === "director");
  const ams = allUsers.filter((u) => u.role === "account_manager");

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
    <div className="flex flex-col gap-6 p-4 sm:p-6">

      <Card data-testid="card-my-tasks">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              My Tasks
              {!tasksLoading && openTasks.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{openTasks.length}</Badge>
              )}
            </CardTitle>
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
        </CardHeader>
        <CardContent>
          {tasksLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : displayTasks.length > 0 ? (
            <div className="space-y-1">
              {displayTasks.map(task => {
                const companyName = getCompanyName(task.companyId);
                const assignerName = getUserName(task.assignedBy);
                return (
                  <div
                    key={task.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${task.status === "completed" ? "opacity-50" : ""}`}
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
                      <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`}
                         data-testid={`text-task-title-${task.id}`}>
                        {task.title}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        {companyName && (
                          <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`}>
                            {companyName}
                          </Link>
                        )}
                        {assignerName && task.assignedBy !== currentUser?.id && (
                          <span className="text-xs text-muted-foreground">from {assignerName}</span>
                        )}
                      </div>
                    </div>
                    {dueDateBadge(task.dueDate)}
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
              })}
              {completedCount > 0 && (
                <p className="text-xs text-muted-foreground pt-2 pl-3" data-testid="text-completed-count">
                  {completedCount} completed task{completedCount !== 1 ? "s" : ""}
                </p>
              )}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No tasks yet</p>
              <p className="text-xs mt-1">Click "Add Task" to create your first one</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-callouts">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              Callouts
              {!calloutsLoading && topLevelCallouts.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{topLevelCallouts.length}</Badge>
              )}
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => { setReplyTo(undefined); setCalloutDialogOpen(true); }}
              data-testid="button-add-callout"
            >
              <Plus className="h-3 w-3" /> Add Callout
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {calloutsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : topLevelCallouts.length > 0 ? (
            <div className="space-y-1">
              {topLevelCallouts.map(callout => {
                const replies = repliesFor(callout.id);
                const isExpanded = expandedCallouts.has(callout.id);
                const companyName = callout.companyId ? companies?.find(c => c.id === callout.companyId)?.name : null;
                return (
                  <div key={callout.id} data-testid={`callout-row-${callout.id}`}>
                    <div className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group">
                      <Megaphone className="h-4 w-4 mt-0.5 text-orange-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium" data-testid={`text-callout-title-${callout.id}`}>{callout.title}</p>
                          {callout.tag && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${tagColors[callout.tag] || "bg-muted text-muted-foreground"}`} data-testid={`badge-callout-tag-${callout.id}`}>
                              {callout.tag}
                            </span>
                          )}
                        </div>
                        {callout.body && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{callout.body}</p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                          <span className="text-xs text-muted-foreground">{getAuthorName(callout.authorId)}</span>
                          <span className="text-xs text-muted-foreground/50">·</span>
                          <span className="text-xs text-muted-foreground">{formatTimeAgo(callout.createdAt)}</span>
                          {companyName && (
                            <>
                              <span className="text-xs text-muted-foreground/50">·</span>
                              <Link href={`/companies/${callout.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-callout-company-${callout.id}`}>
                                {companyName}
                              </Link>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {replies.length > 0 && (
                          <button
                            onClick={() => toggleExpanded(callout.id)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                            data-testid={`button-toggle-replies-${callout.id}`}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {replies.length}
                            <ChevronDown className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </button>
                        )}
                        <button
                          onClick={() => { setReplyTo({ id: callout.id, title: callout.title }); setCalloutDialogOpen(true); }}
                          className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1"
                          data-testid={`button-reply-callout-${callout.id}`}
                        >
                          Reply
                        </button>
                        {(callout.authorId === currentUser?.id || currentUser?.role === "admin") && (
                          <button
                            onClick={() => deleteCalloutMutation.mutate(callout.id)}
                            className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            data-testid={`button-delete-callout-${callout.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && replies.length > 0 && (
                      <div className="ml-7 pl-3 border-l-2 border-muted space-y-1 mb-2">
                        {replies.map(reply => (
                          <div key={reply.id} className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/30 transition-all group/reply" data-testid={`callout-reply-${reply.id}`}>
                            <MessageSquare className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium">{reply.title}</p>
                              {reply.body && <p className="text-xs text-muted-foreground mt-0.5">{reply.body}</p>}
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-muted-foreground">{getAuthorName(reply.authorId)}</span>
                                <span className="text-xs text-muted-foreground/50">·</span>
                                <span className="text-xs text-muted-foreground">{formatTimeAgo(reply.createdAt)}</span>
                              </div>
                            </div>
                            {(reply.authorId === currentUser?.id || currentUser?.role === "admin") && (
                              <button
                                onClick={() => deleteCalloutMutation.mutate(reply.id)}
                                className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/reply:opacity-100 transition-opacity"
                                data-testid={`button-delete-reply-${reply.id}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No callouts yet</p>
              <p className="text-xs mt-1">Share trends, callouts, and ideas with your team</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="overflow-hidden">
            <CardContent className="p-4 sm:p-6">
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.bg}`}>
                      <stat.icon className={`h-4 w-4 ${stat.color}`} />
                    </div>
                    <TrendingUp className="h-3 w-3 text-green-500" />
                  </div>
                  <div>
                    <div className="text-xl sm:text-2xl font-bold" data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s/g, "-")}`}>
                      {stat.value}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {stat.description}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

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

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        editingTask={editingTask}
      />

      <CalloutDialog
        open={calloutDialogOpen}
        onOpenChange={setCalloutDialogOpen}
        parentId={replyTo?.id}
        parentTitle={replyTo?.title}
      />
    </div>
  );
}
