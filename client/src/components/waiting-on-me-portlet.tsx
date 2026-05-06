import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Mail, AlertTriangle, Clock, ChevronRight, ChevronDown, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface WaitingThread {
  id: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  accountName: string | null;
  subject: string | null;
  responsePriority: string;
  waitingSinceAt: string | null;
  overdueAt: string | null;
  updatedAt: string;
}

interface WaitingResponse {
  count: number;
  threads: WaitingThread[];
}

function formatWaitDuration(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function WaitingOnMePortlet({
  collapsed,
  onToggle,
  setLocation,
}: {
  collapsed: boolean;
  onToggle: () => void;
  setLocation: (path: string) => void;
}) {
  const { data, isLoading } = useQuery<WaitingResponse>({
    queryKey: ["/api/internal/conversations", "my-waiting"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations/my-waiting", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const threads = data?.threads ?? [];
  const now = new Date();
  const overdueCount = threads.filter(t => t.overdueAt && new Date(t.overdueAt) <= now).length;

  return (
    <Card data-testid="portlet-waiting-on-me">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            data-testid="button-toggle-waiting-on-me"
          >
            {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              Waiting on Me
            </CardTitle>
          </button>
          <div className="flex items-center gap-2">
            {(data?.count ?? 0) > 0 && (
              <Badge className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300 dark:border-amber-800" data-testid="badge-waiting-count">
                {data?.count}
              </Badge>
            )}
            {overdueCount > 0 && (
              <Badge className="text-xs bg-red-600 text-white" data-testid="badge-overdue-count">
                <AlertTriangle className="w-3 h-3 mr-1" />
                {overdueCount} overdue
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : threads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="text-no-waiting">
              No conversations waiting on you right now.
            </p>
          ) : (
            <>
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1" data-testid="waiting-thread-list">
                {threads.slice(0, 10).map(thread => {
                  const isOverdue = !!(thread.overdueAt && new Date(thread.overdueAt) <= now);
                  const waitStr = formatWaitDuration(thread.waitingSinceAt);
                  return (
                    <div
                      key={thread.id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors cursor-pointer hover:bg-muted/50",
                        isOverdue
                          ? "bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900"
                          : "border-border/50"
                      )}
                      onClick={() => setLocation(`/conversations?threadId=${thread.threadId}`)}
                      data-testid={`waiting-thread-${thread.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate" data-testid={`text-waiting-account-${thread.id}`}>
                            {thread.accountName ?? thread.threadId.slice(0, 20) + "…"}
                          </span>
                          {isOverdue && (
                            <Badge className="text-[10px] bg-red-600 text-white px-1.5 py-0" data-testid={`badge-thread-overdue-${thread.id}`}>
                              Overdue
                            </Badge>
                          )}
                          {thread.responsePriority === "high" && (
                            <Badge className="text-[10px] bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 px-1.5 py-0">
                              High
                            </Badge>
                          )}
                        </div>
                        {thread.subject && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5" data-testid={`text-waiting-subject-${thread.id}`}>
                            {thread.subject.length > 60 ? thread.subject.slice(0, 60) + "…" : thread.subject}
                          </p>
                        )}
                        {waitStr && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                            <Clock className="w-3 h-3" />
                            Waiting {waitStr}
                          </span>
                        )}
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </div>
                  );
                })}
              </div>
              {threads.length > 10 && (
                <p className="text-xs text-muted-foreground mt-2">+{threads.length - 10} more threads</p>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => setLocation("/conversations")}
                data-testid="button-view-all-conversations"
              >
                View all conversations
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
