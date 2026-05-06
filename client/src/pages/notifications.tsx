import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bell, CheckCheck, ListTodo, MessageSquare, Target, CheckCircle2,
  Users, BellRing, Building2, CalendarOff, SquareCheck, Lightbulb,
  Star, Inbox, AtSign, MessageCircle,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Notification } from "@shared/schema";
import { formatTimeAgo } from "@/lib/utils";
import { ContextNotesInbox } from "@/components/context-notes";

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  task_reminder:         { icon: <BellRing className="h-4 w-4" />,      label: "Task Reminder",     color: "text-red-500" },
  task_assigned:         { icon: <ListTodo className="h-4 w-4" />,       label: "Task Assigned",     color: "text-blue-500" },
  task_comment:          { icon: <MessageSquare className="h-4 w-4" />,  label: "Task Comment",      color: "text-blue-400" },
  task_completed:        { icon: <CheckCircle2 className="h-4 w-4" />,   label: "Task Completed",    color: "text-green-500" },
  goal_set:              { icon: <Target className="h-4 w-4" />,         label: "Goal Set",          color: "text-orange-500" },
  goal_updated:          { icon: <Target className="h-4 w-4" />,         label: "Goal Updated",      color: "text-orange-400" },
  goal_comment:          { icon: <MessageSquare className="h-4 w-4" />,  label: "Goal Comment",      color: "text-orange-400" },
  topic_added:           { icon: <MessageSquare className="h-4 w-4" />,  label: "1:1 Topic",         color: "text-purple-500" },
  topic_reply:           { icon: <MessageSquare className="h-4 w-4" />,  label: "1:1 Reply",         color: "text-purple-400" },
  session_closed:        { icon: <Users className="h-4 w-4" />,          label: "Session Closed",    color: "text-purple-400" },
  post_reply:            { icon: <MessageSquare className="h-4 w-4" />,  label: "Post Reply",        color: "text-green-500" },
  new_post:              { icon: <MessageSquare className="h-4 w-4" />,  label: "New Post",          color: "text-indigo-500" },
  account_assigned:      { icon: <Building2 className="h-4 w-4" />,     label: "Account Assigned",  color: "text-blue-500" },
  pto_covering:          { icon: <CalendarOff className="h-4 w-4" />,    label: "PTO Coverage",      color: "text-amber-500" },
  pto_acknowledged:      { icon: <SquareCheck className="h-4 w-4" />,   label: "PTO Acknowledged",  color: "text-green-500" },
  app_suggestion:        { icon: <Lightbulb className="h-4 w-4" />,      label: "Suggestion",        color: "text-yellow-500" },
  promotion_nomination:  { icon: <Star className="h-4 w-4" />,           label: "Nomination",        color: "text-amber-400" },
  context_note_mention:  { icon: <AtSign className="h-4 w-4" />,         label: "Mention",           color: "text-amber-500" },
  context_note_reply:    { icon: <MessageSquare className="h-4 w-4" />,  label: "Note Reply",        color: "text-amber-400" },
};

const DEFAULT_CONFIG = { icon: <Bell className="h-4 w-4" />, label: "Notification", color: "text-muted-foreground" };


const ALL_TYPES = [
  "task_assigned", "task_reminder", "task_comment", "task_completed",
  "goal_set", "goal_updated", "goal_comment",
  "topic_added", "topic_reply", "session_closed",
  "post_reply", "new_post",
  "account_assigned", "pto_covering", "pto_acknowledged",
  "app_suggestion", "promotion_nomination",
  "context_note_mention", "context_note_reply",
];

type Filter = "all" | "unread" | string;
type Tab = "notifications" | "context_notes";

export default function NotificationsPage() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("notifications");
  const [filter, setFilter] = useState<Filter>("all");

  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/notifications/${id}/read`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/notifications/read-all", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const handleClick = (notif: Notification) => {
    if (!notif.read) markReadMutation.mutate(notif.id);
    if (notif.link) navigate(notif.link);
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  const filtered = notifications.filter(n => {
    if (filter === "unread") return !n.read;
    if (filter === "all") return true;
    return n.type === filter;
  });

  const typesPresent = [...new Set(notifications.map(n => n.type))].filter(t => ALL_TYPES.includes(t));

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Inbox className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Inbox</h1>
            <p className="text-sm text-muted-foreground">
              {tab === "notifications"
                ? (unreadCount > 0 ? `${unreadCount} unread` : "All caught up")
                : "Team notes you’re mentioned in"}
            </p>
          </div>
        </div>
        {tab === "notifications" && unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending}
            data-testid="btn-mark-all-read"
          >
            <CheckCheck className="h-4 w-4" />
            Mark all read
          </Button>
        )}
      </div>

      {/* Top-level: Notifications vs Context Notes */}
      <div className="flex gap-1.5 border-b">
        <button
          onClick={() => setTab("notifications")}
          data-testid="tab-section-notifications"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "notifications"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Bell className="h-4 w-4" /> Notifications
        </button>
        <button
          onClick={() => setTab("context_notes")}
          data-testid="tab-section-context-notes"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "context_notes"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <MessageCircle className="h-4 w-4" /> Context Notes
        </button>
      </div>

      {tab === "context_notes" ? (
        <ContextNotesInbox />
      ) : (
        <NotificationsList
          isLoading={isLoading}
          notifications={notifications}
          filter={filter}
          setFilter={setFilter}
          unreadCount={unreadCount}
          handleClick={handleClick}
          filtered={filtered}
        />
      )}
    </div>
  );
}

interface NotificationsListProps {
  isLoading: boolean;
  notifications: Notification[];
  filter: Filter;
  setFilter: (f: Filter) => void;
  unreadCount: number;
  handleClick: (n: Notification) => void;
  filtered: Notification[];
}

function NotificationsList({
  isLoading, notifications, filter, setFilter, unreadCount, handleClick, filtered,
}: NotificationsListProps) {
  const typesPresent = [...new Set(notifications.map(n => n.type))].filter(t => ALL_TYPES.includes(t));
  return (
    <>
      {/* Filter tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {(["all", "unread", ...typesPresent] as Filter[]).map(f => {
          const cfg = f === "all" || f === "unread" ? null : TYPE_CONFIG[f];
          const label = f === "all" ? "All" : f === "unread" ? `Unread (${unreadCount})` : (cfg?.label ?? f);
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              data-testid={`filter-${f}`}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                filter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {cfg && <span className={cfg.color}>{cfg.icon}</span>}
              {label}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <Bell className="h-10 w-10 opacity-30" />
            <p className="text-sm">
              {filter === "unread" ? "No unread notifications" : "No notifications yet"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(notif => {
            const cfg = TYPE_CONFIG[notif.type] ?? DEFAULT_CONFIG;
            return (
              <button
                key={notif.id}
                data-testid={`notification-row-${notif.id}`}
                className={`w-full text-left flex items-start gap-3 p-3.5 rounded-lg border transition-colors hover:bg-accent ${
                  !notif.read ? "bg-primary/5 border-primary/20" : "bg-background border-border"
                }`}
                onClick={() => handleClick(notif)}
              >
                <div className={`mt-0.5 shrink-0 ${cfg.color}`}>{cfg.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm leading-snug ${!notif.read ? "font-medium" : ""}`} data-testid={`text-notif-title-${notif.id}`}>
                      {notif.title}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!notif.read && (
                        <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
                      )}
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimeAgo(notif.createdAt?.toString() ?? "")}
                      </span>
                    </div>
                  </div>
                  {notif.body && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2" data-testid={`text-notif-body-${notif.id}`}>
                      {notif.body}
                    </p>
                  )}
                  <Badge variant="outline" className={`mt-1.5 text-[10px] px-1.5 py-0 ${cfg.color} border-current/30`}>
                    {cfg.label}
                  </Badge>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
