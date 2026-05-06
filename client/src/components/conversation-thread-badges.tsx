/**
 * ConversationThreadBadges (Task #202)
 *
 * Inline indicator chips shown on email thread rows in carrier / account email views.
 * Accepts a threadId (email thread ID) or a conversationThread object directly.
 *
 * Usage:
 *   <ConversationThreadBadges threadId={row.threadId} />
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, CheckCircle2, Clock, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

export interface ConversationThread {
  id: string;
  threadId: string;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingState: "waiting_on_us" | "waiting_on_them" | "resolved";
  responsePriority: "high" | "normal" | "low";
  waitingSinceAt: string | null;
  overdueAt: string | null;
  updatedAt: string;
}

function formatAgo(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PRIORITY_DOT: Record<ConversationThread["responsePriority"], string> = {
  high: "bg-red-500",
  normal: "bg-gray-400",
  low: "bg-blue-300",
};

interface Props {
  threadId: string;
  thread?: ConversationThread;
}

export function ConversationThreadBadges({ threadId, thread: initialThread }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ count: number; threads: ConversationThread[] }>({
    queryKey: ["/api/internal/conversations", "by-thread", threadId],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?threadId=${encodeURIComponent(threadId)}`);
      if (!res.ok) return { count: 0, threads: [] };
      return res.json();
    },
    enabled: !initialThread,
    staleTime: 30_000,
  });

  const thread = initialThread ?? data?.threads?.[0];

  const assignMutation = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      apiRequest("POST", `/api/internal/conversations/${thread!.id}/owner`, { ownerUserId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Owner updated" });
    },
    onError: () => toast({ title: "Failed to update owner", variant: "destructive" }),
  });

  const stateMutation = useMutation({
    mutationFn: (waitingState: ConversationThread["waitingState"]) =>
      apiRequest("POST", `/api/internal/conversations/${thread!.id}/waiting-state`, { waitingState }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Waiting state updated" });
    },
    onError: () => toast({ title: "Failed to update state", variant: "destructive" }),
  });

  const priorityMutation = useMutation({
    mutationFn: (responsePriority: ConversationThread["responsePriority"]) =>
      apiRequest("POST", `/api/internal/conversations/${thread!.id}/priority`, { responsePriority }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Priority updated" });
    },
    onError: () => toast({ title: "Failed to update priority", variant: "destructive" }),
  });

  if (isLoading && !initialThread) {
    return <span className="inline-flex gap-1.5 items-center" />;
  }

  if (!thread) return null;

  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <span
          className="inline-flex items-center gap-1.5 cursor-pointer"
          data-testid={`conversation-badges-${threadId}`}
        >
          {/* Priority dot */}
          <span
            className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", PRIORITY_DOT[thread.responsePriority])}
            title={`Priority: ${thread.responsePriority}`}
            data-testid={`dot-priority-${thread.responsePriority}`}
          />

          {/* Waiting state badge */}
          {thread.waitingState === "waiting_on_us" && (
            <Badge
              className={cn(
                "text-[10px] py-0 px-1.5 h-4",
                isOverdue
                  ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200 border-red-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300"
              )}
              data-testid="badge-waiting-us"
            >
              {isOverdue && <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />}
              {isOverdue ? "Overdue" : "On us"}
            </Badge>
          )}
          {thread.waitingState === "waiting_on_them" && (
            <Badge className="text-[10px] py-0 px-1.5 h-4 bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 border-blue-300" data-testid="badge-waiting-them">
              On them
            </Badge>
          )}
          {thread.waitingState === "resolved" && (
            <Badge className="text-[10px] py-0 px-1.5 h-4 bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 border-green-300" data-testid="badge-resolved">
              <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />
              Done
            </Badge>
          )}

          {/* Owner chip */}
          <Badge
            variant="outline"
            className="text-[10px] py-0 px-1.5 h-4 max-w-20 truncate"
            data-testid="badge-owner"
          >
            <User className="w-2.5 h-2.5 mr-0.5 flex-shrink-0" />
            {thread.ownerName ?? "Unowned"}
          </Badge>
        </span>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-3 space-y-3" data-testid="popover-conversation-controls">
        <p className="text-xs font-semibold text-foreground">Conversation Controls</p>

        {isOverdue && thread.waitingState === "waiting_on_us" && (
          <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-2 py-1.5 rounded">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            Overdue since {formatAgo(thread.overdueAt)}
          </div>
        )}

        {/* Waiting state */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Waiting state</label>
          <Select
            value={thread.waitingState}
            onValueChange={(v) => stateMutation.mutate(v as ConversationThread["waitingState"])}
          >
            <SelectTrigger className="h-7 text-xs" data-testid="select-waiting-state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="waiting_on_us">Waiting on us</SelectItem>
              <SelectItem value="waiting_on_them">Waiting on them</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Priority */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Priority</label>
          <Select
            value={thread.responsePriority}
            onValueChange={(v) => priorityMutation.mutate(v as ConversationThread["responsePriority"])}
          >
            <SelectTrigger className="h-7 text-xs" data-testid="select-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Owner */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Owner</label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-foreground flex-1 truncate" data-testid="text-owner-name">
              {thread.ownerName ?? <em className="text-muted-foreground">Unowned</em>}
            </span>
            {user && thread.ownerUserId !== user.id && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2"
                onClick={() => assignMutation.mutate(user.id)}
                data-testid="button-assign-to-me"
              >
                Assign to me
              </Button>
            )}
            {user && thread.ownerUserId === user.id && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px] px-2"
                onClick={() => assignMutation.mutate(null)}
                data-testid="button-unassign"
              >
                Unassign
              </Button>
            )}
          </div>
        </div>

        {thread.waitingSinceAt && thread.waitingState === "waiting_on_us" && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" />
            Waiting since {formatAgo(thread.waitingSinceAt)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
