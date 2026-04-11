import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Bell, CheckCheck, ListTodo, MessageSquare, Loader2, Target, CheckCircle2, Users, BellRing, Building2, CalendarOff, SquareCheck, Lightbulb, Star, Truck, TrendingDown, BarChart2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { Notification } from "@shared/schema";
import { formatTimeAgo } from "@/lib/utils";

const typeIcon: Record<string, React.ReactNode> = {
  task_reminder: <BellRing className="h-3.5 w-3.5 text-red-500" />,
  task_assigned: <ListTodo className="h-3.5 w-3.5 text-blue-500" />,
  task_comment: <MessageSquare className="h-3.5 w-3.5 text-blue-400" />,
  task_completed: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  goal_set: <Target className="h-3.5 w-3.5 text-orange-500" />,
  goal_updated: <Target className="h-3.5 w-3.5 text-orange-400" />,
  goal_comment: <MessageSquare className="h-3.5 w-3.5 text-orange-400" />,
  topic_added: <MessageSquare className="h-3.5 w-3.5 text-purple-500" />,
  topic_reply: <MessageSquare className="h-3.5 w-3.5 text-purple-400" />,
  session_closed: <Users className="h-3.5 w-3.5 text-purple-400" />,
  post_reply: <MessageSquare className="h-3.5 w-3.5 text-green-500" />,
  new_post: <MessageSquare className="h-3.5 w-3.5 text-indigo-500" />,
  account_assigned: <Building2 className="h-3.5 w-3.5 text-blue-500" />,
  pto_covering: <CalendarOff className="h-3.5 w-3.5 text-amber-500" />,
  pto_acknowledged: <SquareCheck className="h-3.5 w-3.5 text-green-500" />,
  app_suggestion: <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />,
  promotion_nomination: <Star className="h-3.5 w-3.5 text-amber-400" />,
  lane_assigned:          <Truck className="h-3.5 w-3.5 text-amber-500" />,
  momentum_drop:          <TrendingDown className="h-3.5 w-3.5 text-red-500" />,
  momentum_weekly_digest: <BarChart2 className="h-3.5 w-3.5 text-blue-500" />,
};


export function NotificationBell({ navBar }: { navBar?: boolean }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
    refetchInterval: 180000,
  });

  const safeNotifications = notifications ?? [];
  const unreadCount = safeNotifications.filter(n => !n.read).length;

  const markRead = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/notifications/read-all", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const handleNotifClick = (notif: Notification) => {
    if (!notif.read) markRead.mutate(notif.id);
    const destination = notif.link || (notif.type === "app_suggestion" ? "/feedback-inbox" : null);
    if (destination) navigate(destination);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`relative h-8 w-8 ${navBar ? "text-white/80 hover:text-white hover:bg-white/10" : ""}`}
          data-testid="button-notification-bell"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1 leading-none" data-testid="badge-notification-count">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="notification-popover">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="text-sm font-semibold">Notifications</p>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              data-testid="button-mark-all-read"
            >
              <CheckCheck className="h-3.5 w-3.5 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : safeNotifications.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>No notifications yet</p>
            </div>
          ) : (
            safeNotifications.map(notif => (
              <button
                key={notif.id}
                onClick={() => handleNotifClick(notif)}
                className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors border-b last:border-0 ${!notif.read ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}
                data-testid={`notification-item-${notif.id}`}
              >
                <div className="shrink-0 mt-0.5 h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                  {typeIcon[notif.type] ?? <Bell className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-snug ${!notif.read ? "font-medium" : ""}`}>{notif.title}</p>
                  {notif.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-4 whitespace-pre-line">{notif.body}</p>}
                  <p className="text-xs text-muted-foreground mt-1">{formatTimeAgo(notif.createdAt as unknown as string)}</p>
                </div>
                {!notif.read && (
                  <div className="shrink-0 h-2 w-2 rounded-full bg-blue-500 mt-1.5" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
