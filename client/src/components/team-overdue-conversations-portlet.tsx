import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronRight, ChevronDown, ArrowRight, Clock, User } from "lucide-react";

interface OverdueThread {
  id: string;
  threadId: string;
  accountName: string | null;
  responsePriority: string;
  overdueAt: string | null;
  waitingSinceAt: string | null;
}

interface TeamOverdueResponse {
  totalOverdue: number;
  byOwner: Record<string, { ownerName: string; threads: OverdueThread[] }>;
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

export function TeamOverdueConversationsPortlet({
  collapsed,
  onToggle,
  setLocation,
}: {
  collapsed: boolean;
  onToggle: () => void;
  setLocation: (path: string) => void;
}) {
  const { data, isLoading } = useQuery<TeamOverdueResponse>({
    queryKey: ["/api/internal/conversations", "team-overdue"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations/team-overdue", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const totalOverdue = data?.totalOverdue ?? 0;
  const owners = Object.entries(data?.byOwner ?? {});

  return (
    <Card className={totalOverdue > 0 ? "border-red-200 dark:border-red-900" : ""} data-testid="portlet-team-overdue-conversations">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            data-testid="button-toggle-team-overdue"
          >
            {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Overdue Conversations
            </CardTitle>
          </button>
          {totalOverdue > 0 && (
            <Badge className="text-xs bg-red-600 text-white" data-testid="badge-team-overdue-count">
              {totalOverdue} overdue
            </Badge>
          )}
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : totalOverdue === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="text-no-team-overdue">
              No overdue conversations across the team.
            </p>
          ) : (
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1" data-testid="team-overdue-list">
              {owners.map(([ownerId, { ownerName, threads }]) => (
                <div key={ownerId} className="space-y-1" data-testid={`team-overdue-owner-${ownerId}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{ownerName}</span>
                    <Badge variant="outline" className="text-[10px] text-red-600 dark:text-red-400 border-red-300 dark:border-red-700">
                      {threads.length}
                    </Badge>
                  </div>
                  {threads.slice(0, 3).map(thread => (
                    <div
                      key={thread.id}
                      className="flex items-center gap-2 pl-5 text-xs text-muted-foreground"
                      data-testid={`team-overdue-thread-${thread.id}`}
                    >
                      <span className="flex-1 truncate">
                        {thread.accountName ?? thread.threadId.slice(0, 20) + "…"}
                      </span>
                      {thread.responsePriority === "high" && (
                        <Badge className="text-[9px] bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 px-1 py-0">
                          High
                        </Badge>
                      )}
                      <span className="flex items-center gap-0.5 shrink-0 text-red-600 dark:text-red-400">
                        <Clock className="w-2.5 h-2.5" />
                        {formatWaitDuration(thread.waitingSinceAt)}
                      </span>
                    </div>
                  ))}
                  {threads.length > 3 && (
                    <p className="pl-5 text-[10px] text-muted-foreground">+{threads.length - 3} more</p>
                  )}
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => setLocation("/conversations")}
                data-testid="button-view-overdue-conversations"
              >
                View all conversations
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
