import { useMemo } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ListTodo,
  Calendar,
  Bell,
  ChevronRight,
  ArrowRight,
  Briefcase,
} from "lucide-react";
import type { Task, Notification } from "@shared/schema";
import { NbaDashboardPanel } from "@/components/NbaDashboardPanel";

export interface MyWorkUrgentRfp {
  id: string;
  title?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  dueDate: string | null;
}

interface MyWorkCardProps {
  currentUserId: string | undefined;
  userRole: string;
  isAdmin: boolean;
  isAm: boolean;
  isNam: boolean;
  allTasks: Task[];
  tasksLoading: boolean;
  urgentRfps: MyWorkUrgentRfp[];
  notifications: Notification[];
}

export function MyWorkCard({
  currentUserId,
  userRole,
  isAdmin,
  isAm,
  isNam,
  allTasks,
  tasksLoading,
  urgentRfps,
  notifications,
}: MyWorkCardProps) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Mirror Today's Briefing scoping: my open tasks only.
  const mineOpenTasks = useMemo(
    () =>
      (allTasks ?? []).filter(
        (t) => t.assignedTo === currentUserId && t.status !== "completed",
      ),
    [allTasks, currentUserId],
  );

  // Mirrors `tasksDueToday` in dashboard.tsx (compact strip) — but scoped to me.
  const tasksToday = useMemo(
    () => mineOpenTasks.filter((t) => t.dueDate && t.dueDate <= todayStr),
    [mineOpenTasks, todayStr],
  );

  const tasksThisWeek = useMemo(
    () =>
      mineOpenTasks.filter((t) => {
        if (!t.dueDate) return false;
        const due = new Date(t.dueDate + "T00:00:00");
        const diffDays = Math.round(
          (due.getTime() - today.getTime()) / 86400000,
        );
        // Strictly future-this-week so Today and Week tabs don't double-count.
        return diffDays > 0 && diffDays <= 7;
      }),
    [mineOpenTasks, today],
  );

  // Mirrors `rfp7Days` filter in dashboard.tsx.
  const rfp7Days = useMemo(
    () =>
      (urgentRfps ?? []).filter((rfp) => {
        if (!rfp.dueDate) return false;
        const due = new Date(rfp.dueDate + "T00:00:00");
        const diffDays = Math.round(
          (due.getTime() - today.getTime()) / 86400000,
        );
        return diffDays >= 0 && diffDays <= 7;
      }),
    [urgentRfps, today],
  );

  const unreadCount = (notifications ?? []).filter((n) => !n.read).length;

  const todayCount = tasksToday.length + (unreadCount > 0 ? 1 : 0);
  const weekCount = rfp7Days.length + tasksThisWeek.length;

  const showNbaTab = isAm || isNam;

  const defaultTab =
    todayCount > 0
      ? "today"
      : weekCount > 0
        ? "week"
        : showNbaTab
          ? "nba"
          : "today";

  return (
    <Card data-testid="card-my-work">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-blue-500" />
          My Work
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Tabs defaultValue={defaultTab}>
          <TabsList className="w-full justify-start" data-testid="tabs-my-work">
            <TabsTrigger value="today" data-testid="tab-my-work-today">
              Today
              {todayCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 text-xs h-5 px-1.5"
                  data-testid="badge-my-work-today-count"
                >
                  {todayCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="week" data-testid="tab-my-work-week">
              This Week
              {weekCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 text-xs h-5 px-1.5"
                  data-testid="badge-my-work-week-count"
                >
                  {weekCount}
                </Badge>
              )}
            </TabsTrigger>
            {showNbaTab && (
              <TabsTrigger value="nba" data-testid="tab-my-work-nba">
                NBA
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── Today ─────────────────────────────────────────────────────── */}
          <TabsContent
            value="today"
            className="mt-3 space-y-3"
            data-testid="tabpanel-my-work-today"
          >
            {tasksLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : todayCount === 0 ? (
              <p
                className="text-sm italic text-muted-foreground py-3"
                data-testid="empty-my-work-today"
              >
                All clear — nothing on your plate for today.
              </p>
            ) : (
              <>
                {tasksToday.length > 0 && (
                  <div
                    className="space-y-1"
                    data-testid="section-my-work-tasks-today"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <ListTodo className="h-3.5 w-3.5" />
                      {tasksToday.length} task
                      {tasksToday.length !== 1 ? "s" : ""} due today / overdue
                    </div>
                    <ul className="space-y-0.5">
                      {tasksToday.slice(0, 6).map((task) => {
                        const overdue =
                          !!task.dueDate && task.dueDate < todayStr;
                        const inner = (
                          <div
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors text-sm"
                            data-testid={`my-work-task-${task.id}`}
                          >
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate flex-1">
                              {task.title}
                            </span>
                            {task.companyName && (
                              <span className="text-xs text-muted-foreground truncate shrink-0 max-w-[140px]">
                                · {task.companyName}
                              </span>
                            )}
                            {overdue && (
                              <Badge className="text-xs h-4 px-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-0">
                                overdue
                              </Badge>
                            )}
                          </div>
                        );
                        return task.companyId ? (
                          <li key={task.id}>
                            <Link href={`/companies/${task.companyId}`}>
                              {inner}
                            </Link>
                          </li>
                        ) : (
                          <li key={task.id}>
                            <Link href="/tasks">{inner}</Link>
                          </li>
                        );
                      })}
                    </ul>
                    {tasksToday.length > 6 && (
                      <Link href="/tasks">
                        <span
                          className="text-xs text-muted-foreground hover:underline cursor-pointer"
                          data-testid="link-my-work-today-more"
                        >
                          +{tasksToday.length - 6} more
                        </span>
                      </Link>
                    )}
                  </div>
                )}
                {unreadCount > 0 && (
                  <Link href="/notifications">
                    <div
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors text-sm border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20"
                      data-testid="my-work-notifications"
                    >
                      <Bell className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                      <span className="flex-1">
                        {unreadCount} unread notification
                        {unreadCount !== 1 ? "s" : ""}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </Link>
                )}
              </>
            )}
          </TabsContent>

          {/* ── This Week ────────────────────────────────────────────────── */}
          <TabsContent
            value="week"
            className="mt-3 space-y-3"
            data-testid="tabpanel-my-work-week"
          >
            {weekCount === 0 ? (
              <p
                className="text-sm italic text-muted-foreground py-3"
                data-testid="empty-my-work-week"
              >
                Nothing on the 7-day horizon.
              </p>
            ) : (
              <>
                {rfp7Days.length > 0 && (
                  <div
                    className="space-y-1"
                    data-testid="section-my-work-rfps-week"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-red-700 dark:text-red-400">
                      <Calendar className="h-3.5 w-3.5" />
                      {rfp7Days.length} RFP{rfp7Days.length !== 1 ? "s" : ""}{" "}
                      due this week
                    </div>
                    <ul className="space-y-0.5">
                      {rfp7Days.map((rfp) => {
                        const due = new Date(
                          (rfp.dueDate ?? todayStr) + "T00:00:00",
                        );
                        const diffDays = Math.round(
                          (due.getTime() - today.getTime()) / 86400000,
                        );
                        const label =
                          diffDays === 0 ? "today" : `${diffDays}d`;
                        const target = rfp.companyId
                          ? `/companies/${rfp.companyId}`
                          : `/rfp-calendar`;
                        return (
                          <li key={rfp.id}>
                            <Link href={target}>
                              <div
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors text-sm"
                                data-testid={`my-work-rfp-${rfp.id}`}
                              >
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate flex-1">
                                  {rfp.title ?? rfp.companyName ?? "RFP"}
                                </span>
                                <Badge className="text-xs h-4 px-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-0">
                                  {label}
                                </Badge>
                              </div>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {tasksThisWeek.length > 0 && (
                  <div
                    className="space-y-1"
                    data-testid="section-my-work-tasks-week"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <ListTodo className="h-3.5 w-3.5" />
                      {tasksThisWeek.length} task
                      {tasksThisWeek.length !== 1 ? "s" : ""} due this week
                    </div>
                    <ul className="space-y-0.5">
                      {tasksThisWeek.slice(0, 6).map((task) => {
                        const inner = (
                          <div
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors text-sm"
                            data-testid={`my-work-week-task-${task.id}`}
                          >
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate flex-1">
                              {task.title}
                            </span>
                            {task.dueDate && (
                              <span className="text-xs text-muted-foreground shrink-0">
                                {task.dueDate}
                              </span>
                            )}
                          </div>
                        );
                        return task.companyId ? (
                          <li key={task.id}>
                            <Link href={`/companies/${task.companyId}`}>
                              {inner}
                            </Link>
                          </li>
                        ) : (
                          <li key={task.id}>
                            <Link href="/tasks">{inner}</Link>
                          </li>
                        );
                      })}
                    </ul>
                    {tasksThisWeek.length > 6 && (
                      <Link href="/tasks">
                        <span
                          className="text-xs text-muted-foreground hover:underline cursor-pointer"
                          data-testid="link-my-work-week-more"
                        >
                          +{tasksThisWeek.length - 6} more
                        </span>
                      </Link>
                    )}
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* ── NBA — embeds the existing NbaDashboardPanel verbatim ─────── */}
          {showNbaTab && (
            <TabsContent
              value="nba"
              className="mt-3"
              data-testid="tabpanel-my-work-nba"
            >
              <NbaDashboardPanel userRole={userRole} isAdmin={isAdmin} />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}
