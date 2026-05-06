import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ListTodo, Users, AlertTriangle, Bell, ChevronRight, Sun, ChevronDown, ChevronUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Task, Notification } from "@shared/schema";

interface TodaysBriefingPortletProps {
  collapsed: boolean;
  onToggle: () => void;
  allTasks: Task[];
  tasksLoading: boolean;
  notifications: Notification[];
  currentUserId: string | undefined;
}

function Section({ icon, label, count, color, children, testId }: {
  icon: React.ReactNode;
  label: string;
  count: number;
  color: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg ${color}`} data-testid={testId}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Badge variant="secondary" className="text-xs h-5 px-1.5">{count}</Badge>
        </div>
        {children}
      </div>
    </div>
  );
}

export function TodaysBriefingPortlet({
  collapsed,
  onToggle,
  allTasks,
  tasksLoading,
  notifications,
  currentUserId,
}: TodaysBriefingPortletProps) {
  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: companiesHealth = [], isLoading: healthLoading } = useQuery<Array<{
    id: string;
    name: string;
    growthBand?: string;
    growthScore?: number;
    momentum?: string;
    needsAttention?: boolean;
  }>>({
    queryKey: ["/api/dashboard/briefing-health"],
    staleTime: 120_000,
  });

  const dueTodayTasks = allTasks.filter(
    t => t.assignedTo === currentUserId && t.status !== "completed" && t.dueDate && t.dueDate <= todayStr
  );

  const atRiskAccounts = companiesHealth.filter(c =>
    c.growthBand === "at_risk" || c.growthBand === "declining"
  );

  const needsAttentionContacts = companiesHealth.filter(c => c.needsAttention);

  const unreadNotifications = (notifications ?? []).filter(n => !n.read);

  const totalUrgent = dueTodayTasks.length + atRiskAccounts.length + needsAttentionContacts.length + unreadNotifications.length;

  const isLoading = tasksLoading || healthLoading;

  return (
    <Card data-testid="portlet-todays-briefing">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Sun className="h-4 w-4 text-amber-500" />
          Today's Briefing
          {totalUrgent > 0 && (
            <Badge className="ml-1 text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-0">
              {totalUrgent} item{totalUrgent !== 1 ? "s" : ""}
            </Badge>
          )}
          <button
            onClick={onToggle}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-toggle-todays-briefing"
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </CardTitle>
      </CardHeader>

      {!collapsed && (
        <CardContent className="pt-0 space-y-2">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : totalUrgent === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <Sun className="h-8 w-8 text-amber-400/60" />
              <p className="text-sm text-muted-foreground font-medium">All clear — nothing urgent today!</p>
              <p className="text-xs text-muted-foreground/70">Tasks due, at-risk accounts, and unread notifications will appear here.</p>
            </div>
          ) : (
            <>
              {dueTodayTasks.length > 0 && (
                <Section
                  icon={<ListTodo className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
                  label="Tasks Due Today"
                  count={dueTodayTasks.length}
                  color="bg-amber-50 dark:bg-amber-950/30"
                  testId="briefing-tasks-section"
                >
                  <div className="mt-1.5 space-y-1">
                    {dueTodayTasks.slice(0, 3).map(task => (
                      task.companyId ? (
                        <Link key={task.id} href={`/companies/${task.companyId}`}>
                          <div className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300 hover:underline cursor-pointer" data-testid={`briefing-task-${task.id}`}>
                            <ChevronRight className="h-3 w-3 shrink-0" />
                            <span className="truncate">{task.title}</span>
                            {task.companyName && <span className="text-amber-600 dark:text-amber-500 shrink-0">· {task.companyName}</span>}
                          </div>
                        </Link>
                      ) : (
                        <div key={task.id} className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300" data-testid={`briefing-task-${task.id}`}>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          <span className="truncate">{task.title}</span>
                        </div>
                      )
                    ))}
                    {dueTodayTasks.length > 3 && (
                      <Link href="/tasks">
                        <p className="text-xs text-amber-600 dark:text-amber-500 hover:underline cursor-pointer">+{dueTodayTasks.length - 3} more</p>
                      </Link>
                    )}
                  </div>
                </Section>
              )}

              {atRiskAccounts.length > 0 && (
                <Section
                  icon={<AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />}
                  label="At-Risk Accounts"
                  count={atRiskAccounts.length}
                  color="bg-red-50 dark:bg-red-950/30"
                  testId="briefing-at-risk-section"
                >
                  <div className="mt-1.5 space-y-1">
                    {atRiskAccounts.slice(0, 3).map(company => (
                      <Link key={company.id} href={`/companies/${company.id}`}>
                        <div className="flex items-center gap-1.5 text-xs text-red-800 dark:text-red-300 hover:underline cursor-pointer" data-testid={`briefing-atrisk-${company.id}`}>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          <span className="truncate">{company.name}</span>
                        </div>
                      </Link>
                    ))}
                    {atRiskAccounts.length > 3 && (
                      <p className="text-xs text-red-600 dark:text-red-500">+{atRiskAccounts.length - 3} more</p>
                    )}
                  </div>
                </Section>
              )}

              {needsAttentionContacts.length > 0 && (
                <Section
                  icon={<Users className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                  label="Contacts Needing Attention"
                  count={needsAttentionContacts.length}
                  color="bg-blue-50 dark:bg-blue-950/30"
                  testId="briefing-contacts-section"
                >
                  <div className="mt-1.5 space-y-1">
                    {needsAttentionContacts.slice(0, 3).map(company => (
                      <Link key={company.id} href={`/companies/${company.id}`}>
                        <div className="flex items-center gap-1.5 text-xs text-blue-800 dark:text-blue-300 hover:underline cursor-pointer" data-testid={`briefing-contact-attn-${company.id}`}>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          <span className="truncate">{company.name}</span>
                        </div>
                      </Link>
                    ))}
                    {needsAttentionContacts.length > 3 && (
                      <p className="text-xs text-blue-600 dark:text-blue-500">+{needsAttentionContacts.length - 3} more</p>
                    )}
                  </div>
                </Section>
              )}

              {unreadNotifications.length > 0 && (
                <Link href="/notifications">
                  <div data-testid="briefing-notifications-section" className="flex items-start gap-3 p-3 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors cursor-pointer">
                    <div className="shrink-0 mt-0.5">
                      <Bell className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Unread Notifications</span>
                        <Badge variant="secondary" className="text-xs h-5 px-1.5">{unreadNotifications.length}</Badge>
                        <ChevronRight className="h-3.5 w-3.5 text-indigo-500 ml-auto" />
                      </div>
                    </div>
                  </div>
                </Link>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
