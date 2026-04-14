import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, AlertTriangle, User, Users, MessageSquare, CheckCircle2, ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { DraftEmailModal } from "@/components/DraftEmailModal";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConversationThread {
  id: string;
  orgId: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingState: "waiting_on_us" | "waiting_on_them" | "resolved";
  responsePriority: "high" | "normal" | "low";
  lastMessageId: string | null;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  waitingSinceAt: string | null;
  overdueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadsResponse {
  count: number;
  threads: ConversationThread[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function WaitingStateBadge({ state, overdue }: { state: ConversationThread["waitingState"]; overdue: boolean }) {
  if (state === "waiting_on_us") {
    return (
      <Badge
        className={cn(
          "text-xs font-medium",
          overdue
            ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200 border-red-300 dark:border-red-800"
            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300 dark:border-amber-800"
        )}
        data-testid="badge-waiting-state"
      >
        {overdue && <AlertTriangle className="w-3 h-3 mr-1" />}
        Waiting on us
      </Badge>
    );
  }
  if (state === "waiting_on_them") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 border-blue-300 dark:border-blue-800 text-xs" data-testid="badge-waiting-state">
        Waiting on them
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 border-green-300 dark:border-green-800 text-xs" data-testid="badge-waiting-state">
      <CheckCircle2 className="w-3 h-3 mr-1" />
      Resolved
    </Badge>
  );
}

function PriorityDot({ priority }: { priority: ConversationThread["responsePriority"] }) {
  const colors = {
    high: "bg-red-500",
    normal: "bg-gray-400",
    low: "bg-blue-300",
  };
  const labels = { high: "High", normal: "Normal", low: "Low" };
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-priority">
      <span className={cn("inline-block w-2 h-2 rounded-full", colors[priority])} />
      {labels[priority]}
    </span>
  );
}

// ── Thread Row ────────────────────────────────────────────────────────────────

function ThreadRow({
  thread,
  onAssignToMe,
  onChangeState,
}: {
  thread: ConversationThread;
  onAssignToMe: (id: string) => void;
  onChangeState: (id: string, state: ConversationThread["waitingState"]) => void;
}) {
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";

  return (
    <div
      className={cn(
        "flex items-center gap-4 px-4 py-3 border-b last:border-0 hover:bg-muted/40 transition-colors",
        isOverdue && "bg-red-50/50 dark:bg-red-950/20"
      )}
      data-testid={`row-conversation-${thread.id}`}
    >
      {/* Priority indicator */}
      <PriorityDot priority={thread.responsePriority} />

      {/* Thread info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-foreground truncate" data-testid={`text-thread-id-${thread.id}`}>
            {thread.threadId.slice(0, 24)}…
          </span>
          <WaitingStateBadge state={thread.waitingState} overdue={isOverdue} />
          {isOverdue && (
            <Badge className="text-xs bg-red-600 text-white" data-testid={`badge-overdue-${thread.id}`}>
              Overdue
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {thread.linkedAccountId && (
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" /> Account
            </span>
          )}
          {thread.linkedCarrierId && (
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" /> Carrier
            </span>
          )}
          {thread.waitingSinceAt && thread.waitingState === "waiting_on_us" && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <Clock className="w-3 h-3" />
              Since {formatAgo(thread.waitingSinceAt)}
            </span>
          )}
          <span>Updated {formatAgo(thread.updatedAt)}</span>
        </div>
      </div>

      {/* Owner */}
      <div className="text-sm text-muted-foreground min-w-24 text-right" data-testid={`text-owner-${thread.id}`}>
        {thread.ownerName ? (
          <span className="font-medium text-foreground">{thread.ownerName}</span>
        ) : (
          <span className="italic text-muted-foreground">Unowned</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {!thread.ownerName && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onAssignToMe(thread.id)}
            data-testid={`button-assign-me-${thread.id}`}
          >
            Assign to me
          </Button>
        )}
        {thread.waitingState !== "resolved" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => onChangeState(thread.id, "resolved")}
            data-testid={`button-resolve-${thread.id}`}
          >
            Resolve
          </Button>
        )}
        {thread.waitingState === "resolved" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => onChangeState(thread.id, "waiting_on_us")}
            data-testid={`button-reopen-${thread.id}`}
          >
            Reopen
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs gap-1 text-indigo-600 dark:text-indigo-400"
          onClick={() => setShowDraftEmail(true)}
          data-testid={`button-draft-email-thread-${thread.id}`}
        >
          <Sparkles className="w-3 h-3" />
          Draft
        </Button>
      </div>

      {showDraftEmail && (
        <DraftEmailModal
          open={showDraftEmail}
          onClose={() => setShowDraftEmail(false)}
          accountId={thread.linkedAccountId}
          threadId={thread.threadId}
          defaultPlayType={thread.linkedCarrierId ? "carrier_capacity" : "check_in"}
        />
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ConversationsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<"mine" | "unowned" | "high_priority" | "all">("mine");
  const [filterState, setFilterState] = useState<string>("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [filterOverdue, setFilterOverdue] = useState(false);

  // Build query params for custom "all" tab
  function buildParams(): string {
    const p = new URLSearchParams();
    if (activeTab === "mine" && user?.id) {
      p.set("ownerUserId", user.id);
      p.set("waitingState", "waiting_on_us");
    } else if (activeTab === "unowned") {
      p.set("unowned", "true");
      p.set("waitingState", "waiting_on_us");
    } else if (activeTab === "high_priority") {
      p.set("responsePriority", "high");
      p.set("waitingState", "waiting_on_us");
    } else {
      // "all" tab
      if (filterState !== "all") p.set("waitingState", filterState);
      if (filterPriority !== "all") p.set("responsePriority", filterPriority);
      if (filterOverdue) p.set("overdue", "true");
    }
    return p.toString();
  }

  const { data, isLoading } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", activeTab, filterState, filterPriority, filterOverdue],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?${buildParams()}`);
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
  });

  // Quick-view counts (always fetched for badge display)
  const { data: mineData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "mine-count", user?.id],
    queryFn: async () => {
      const p = new URLSearchParams({ waitingState: "waiting_on_us" });
      if (user?.id) p.set("ownerUserId", user.id);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!user?.id,
  });

  const { data: unownedData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "unowned-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?unowned=true&waitingState=waiting_on_us");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const { data: highPriData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "high-priority-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?responsePriority=high&waitingState=waiting_on_us");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const assignToMeMutation = useMutation({
    mutationFn: async (threadId: string) => {
      if (!user?.id) throw new Error("Not logged in");
      return apiRequest("POST", `/api/internal/conversations/${threadId}/owner`, { ownerUserId: user.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation assigned to you" });
    },
    onError: () => toast({ title: "Failed to assign conversation", variant: "destructive" }),
  });

  const changeStateMutation = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: ConversationThread["waitingState"] }) => {
      return apiRequest("POST", `/api/internal/conversations/${id}/waiting-state`, { waitingState: state });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation updated" });
    },
    onError: () => toast({ title: "Failed to update conversation", variant: "destructive" }),
  });

  const threads = data?.threads ?? [];

  // Sort: overdue first, then by waitingSinceAt asc, then by updatedAt desc
  const sorted = [...threads].sort((a, b) => {
    const aOverdue = !!a.overdueAt;
    const bOverdue = !!b.overdueAt;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.waitingSinceAt && b.waitingSinceAt) {
      return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <MessageSquare className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <Badge className="text-xs" data-testid="badge-total-count">{data?.count ?? "—"}</Badge>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-4" data-testid="tabs-quick-views">
          <TabsTrigger value="mine" data-testid="tab-waiting-on-me">
            Waiting on me
            {(mineData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs bg-amber-600 text-white">{mineData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="unowned" data-testid="tab-unowned">
            Unowned
            {(unownedData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs">{unownedData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="high_priority" data-testid="tab-high-priority">
            High priority
            {(highPriData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs bg-red-600 text-white">{highPriData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
        </TabsList>

        {/* Filter controls (only on "all" tab) */}
        {activeTab === "all" && (
          <div className="flex items-center gap-3 mb-4" data-testid="filters-container">
            <Select value={filterState} onValueChange={setFilterState}>
              <SelectTrigger className="w-44" data-testid="select-filter-state">
                <SelectValue placeholder="Waiting state" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="waiting_on_us">Waiting on us</SelectItem>
                <SelectItem value="waiting_on_them">Waiting on them</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filterPriority} onValueChange={setFilterPriority}>
              <SelectTrigger className="w-40" data-testid="select-filter-priority">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant={filterOverdue ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterOverdue(!filterOverdue)}
              data-testid="button-filter-overdue"
            >
              <AlertTriangle className="w-3.5 h-3.5 mr-1" />
              Overdue only
            </Button>
          </div>
        )}

        {/* Thread list */}
        <div className="border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="divide-y">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-16" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2" data-testid="empty-state">
              <CheckCircle2 className="w-8 h-8" />
              <p className="font-medium">No conversations found</p>
              <p className="text-sm">
                {activeTab === "mine"
                  ? "You have no conversations waiting on you."
                  : activeTab === "unowned"
                  ? "All conversations have an assigned owner."
                  : "No conversations match the selected filters."}
              </p>
            </div>
          ) : (
            <div className="divide-y" data-testid="conversation-list">
              {sorted.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  onAssignToMe={(id) => assignToMeMutation.mutate(id)}
                  onChangeState={(id, state) => changeStateMutation.mutate({ id, state })}
                />
              ))}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
