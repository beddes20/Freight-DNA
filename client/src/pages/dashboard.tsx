import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Building2, Users, MapPin, DollarSign, ChevronRight, TrendingUp,
  ShieldCheck, UserCircle, ClipboardList, Plus, Circle, PlayCircle,
  CheckCircle2, Calendar, Trash2, Crown, Send, Lightbulb,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { TaskDialog } from "@/components/task-dialog";
import { OneOnOnePortlet } from "@/components/one-on-one-portlet";
import type { Company, Contact, Task, User, FeedPost } from "@shared/schema";

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
  const [feedContent, setFeedContent] = useState("");
  const [feedCategory, setFeedCategory] = useState<"trend" | "growth" | "idea">("idea");
  const [mentionState, setMentionState] = useState<{ mentionStart: number; query: string } | null>(null);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const feedTextareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: allTasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const canSeeTeam = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales";
  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/users"],
    enabled: canSeeTeam,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: feedPosts = [], isLoading: feedLoading } = useQuery<FeedPost[]>({
    queryKey: ["/api/feed-posts"],
  });

  const createFeedPostMutation = useMutation({
    mutationFn: async (data: { content: string; category: string }) => {
      const res = await apiRequest("POST", "/api/feed-posts", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed-posts"] });
      setFeedContent("");
      toast({ title: "Posted successfully" });
    },
    onError: () => {
      toast({ title: "Failed to post", variant: "destructive" });
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

  const nams = allUsers.filter((u) => u.role === "national_account_manager" || u.role === "director" || u.role === "sales");
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

      {(currentUser?.role === "admin" || currentUser?.role === "director") && <Card data-testid="card-feed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Trends / Growth / Ideas
            {!feedLoading && feedPosts.length > 0 && (
              <Badge variant="secondary" className="ml-1 font-normal">{feedPosts.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <div className="flex gap-1 mb-2 flex-wrap">
              {(["trend", "growth", "idea"] as const).map(cat => (
                <button
                  key={cat}
                  onClick={() => setFeedCategory(cat)}
                  data-testid={`button-feed-category-${cat}`}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors capitalize ${
                    feedCategory === cat
                      ? cat === "trend" ? "bg-purple-600 text-white border-purple-600"
                        : cat === "growth" ? "bg-green-600 text-white border-green-600"
                        : "bg-blue-600 text-white border-blue-600"
                      : "bg-transparent border-border text-muted-foreground hover:border-foreground"
                  }`}
                >
                  {cat === "trend" ? "📈 Trend" : cat === "growth" ? "🚀 Growth" : "💡 Idea"}
                </button>
              ))}
            </div>
            <Textarea
              ref={feedTextareaRef}
              value={feedContent}
              onChange={handleFeedChange}
              onKeyDown={handleFeedKeyDown}
              placeholder="Share a trend, growth win, or idea… Type @ to mention someone (Ctrl+Enter to post)"
              className="resize-none text-sm min-h-[72px]"
              data-testid="textarea-feed-content"
            />
            <div className="flex items-center justify-end mt-1.5">
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

          {feedLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : feedPosts.length > 0 ? (
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {feedPosts.map(post => {
                const catColors: Record<string, string> = {
                  trend: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
                  growth: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
                  idea: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
                };
                const catIcon: Record<string, string> = { trend: "📈", growth: "🚀", idea: "💡" };
                return (
                  <div
                    key={post.id}
                    className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group"
                    data-testid={`feed-post-${post.id}`}
                  >
                    <Lightbulb className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground whitespace-pre-wrap break-words" data-testid={`text-feed-content-${post.id}`}>
                        {post.content}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium capitalize ${catColors[post.category] || "bg-muted text-muted-foreground"}`} data-testid={`badge-feed-category-${post.id}`}>
                          {catIcon[post.category]} {post.category}
                        </span>
                        <span className="text-xs text-muted-foreground">{getAuthorName(post.authorId)}</span>
                        <span className="text-xs text-muted-foreground/50">·</span>
                        <span className="text-xs text-muted-foreground">{formatTimeAgo(post.createdAt)}</span>
                      </div>
                    </div>
                    {(post.authorId === currentUser?.id || currentUser?.role === "admin") && (
                      <button
                        onClick={() => deleteFeedPostMutation.mutate(post.id)}
                        className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        data-testid={`button-delete-feed-${post.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Crown className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Nothing posted yet</p>
              <p className="text-xs mt-1">Share trends, growth wins, and ideas with your team</p>
            </div>
          )}
        </CardContent>
      </Card>}

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

      <OneOnOnePortlet
        currentUser={currentUser as SafeUser}
        allUsers={allUsers}
        teamMembers={teamMembers}
      />

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

    </div>
  );
}
