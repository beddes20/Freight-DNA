import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Bell, X, BellRing, ListTodo, MessageSquare, CheckCircle2,
  Target, Users, Megaphone, CornerDownRight, ExternalLink,
  Building2, CalendarOff, SquareCheck,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Notification } from "@shared/schema";

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; accent: string; label: string }> = {
  task_assigned:   { icon: <ListTodo className="h-4 w-4" />,       accent: "text-blue-500",   label: "Task Assigned" },
  task_completed:  { icon: <CheckCircle2 className="h-4 w-4" />,   accent: "text-green-500",  label: "Task Done" },
  task_comment:    { icon: <MessageSquare className="h-4 w-4" />,  accent: "text-blue-400",   label: "Task Comment" },
  task_reminder:   { icon: <BellRing className="h-4 w-4" />,       accent: "text-red-500",    label: "Reminder" },
  goal_set:        { icon: <Target className="h-4 w-4" />,         accent: "text-orange-500", label: "New Goal" },
  goal_updated:    { icon: <Target className="h-4 w-4" />,         accent: "text-orange-400", label: "Goal Updated" },
  goal_comment:    { icon: <MessageSquare className="h-4 w-4" />,  accent: "text-orange-400", label: "Goal Comment" },
  topic_added:     { icon: <MessageSquare className="h-4 w-4" />,  accent: "text-purple-500", label: "1:1 Topic" },
  topic_reply:     { icon: <CornerDownRight className="h-4 w-4" />, accent: "text-purple-400", label: "1:1 Reply" },
  session_closed:  { icon: <Users className="h-4 w-4" />,          accent: "text-purple-400", label: "Session Closed" },
  post_reply:      { icon: <MessageSquare className="h-4 w-4" />,  accent: "text-green-500",  label: "Feed Reply" },
  new_post:        { icon: <Megaphone className="h-4 w-4" />,      accent: "text-indigo-500", label: "New Post" },
  account_assigned: { icon: <Building2 className="h-4 w-4" />,    accent: "text-blue-500",   label: "Account Assigned" },
  pto_covering:    { icon: <CalendarOff className="h-4 w-4" />,   accent: "text-amber-500",  label: "PTO Cover Request" },
  pto_acknowledged: { icon: <SquareCheck className="h-4 w-4" />,  accent: "text-green-500",  label: "PTO Acknowledged" },
};

function timeAgo(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface ToastCard {
  notif: Notification;
  id: string;
}

export function NotificationToasts() {
  const [, navigate] = useLocation();
  const [toasts, setToasts] = useState<ToastCard[]>([]);
  const seenIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
    refetchInterval: 45000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  useEffect(() => {
    if (!notifications.length && !initialized.current) return;

    if (!initialized.current) {
      notifications.forEach(n => seenIds.current.add(n.id));
      initialized.current = true;
      return;
    }

    const newOnes = notifications.filter(n => !seenIds.current.has(n.id) && !n.read);
    if (newOnes.length === 0) return;

    newOnes.forEach(n => seenIds.current.add(n.id));

    setToasts(prev => {
      const incoming = newOnes.map(n => ({ notif: n, id: n.id }));
      const combined = [...prev, ...incoming];
      return combined.slice(-5);
    });
  }, [notifications]);

  const dismiss = (id: string) => {
    markRead.mutate(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const handleView = (toast: ToastCard) => {
    dismiss(toast.id);
    if (toast.notif.link) navigate(toast.notif.link);
  };

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 items-end pointer-events-none"
      data-testid="notification-toasts"
    >
      {toasts.map((t, i) => {
        const cfg = TYPE_CONFIG[t.notif.type] ?? { icon: <Bell className="h-4 w-4" />, accent: "text-muted-foreground", label: "Alert" };
        return (
          <div
            key={t.id}
            style={{ transitionDelay: `${i * 30}ms` }}
            className="pointer-events-auto w-80 rounded-xl border border-border bg-background shadow-2xl ring-1 ring-black/5 dark:ring-white/10 animate-in slide-in-from-right-8 fade-in duration-300"
            data-testid={`toast-notif-${t.id}`}
          >
            {/* Coloured top accent strip */}
            <div className={`h-1 w-full rounded-t-xl ${cfg.accent.replace("text-", "bg-").replace("-500", "-400").replace("-400", "-400")}`} />

            <div className="px-4 py-3">
              <div className="flex items-start gap-3">
                {/* Icon circle */}
                <div className={`mt-0.5 h-8 w-8 shrink-0 rounded-full bg-muted flex items-center justify-center ${cfg.accent}`}>
                  {cfg.icon}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.accent}`}>{cfg.label}</span>
                    <button
                      onClick={() => dismiss(t.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      aria-label="Dismiss"
                      data-testid={`btn-dismiss-toast-${t.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-sm font-medium leading-snug mt-0.5">{t.notif.title}</p>
                  {t.notif.body && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.notif.body}</p>
                  )}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-muted-foreground">{timeAgo(t.notif.createdAt as unknown as string)}</span>
                    {t.notif.link && (
                      <button
                        onClick={() => handleView(t)}
                        className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        data-testid={`btn-view-toast-${t.id}`}
                      >
                        View <ExternalLink className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
