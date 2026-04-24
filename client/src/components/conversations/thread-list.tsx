import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Inbox, CheckCircle2, Sparkles, AlertCircle, Mail, Archive, DollarSign } from "lucide-react";
import { ThreadRow } from "./thread-row";
import type { ConversationBucket, ConversationDensity, ConversationThread } from "./types";

interface ThreadListProps {
  threads: ConversationThread[];
  isLoading: boolean;
  density: ConversationDensity;
  bucket: ConversationBucket;
  selectedThreadId: string | null;
  onSelect: (thread: ConversationThread) => void;
  onAssignToMe: (id: string) => void;
  onChangeState: (id: string, state: ConversationThread["waitingState"]) => void;
  onArchive: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  isFetchingMore: boolean;
}

const EMPTY_STATES: Record<ConversationBucket, { icon: typeof Inbox; title: string; subtitle: string }> = {
  mine: {
    icon: CheckCircle2,
    title: "Inbox zero",
    subtitle: "Nothing waiting on you. Nice work — go grab a coffee.",
  },
  unowned: {
    icon: Sparkles,
    title: "No unassigned threads",
    subtitle: "Every conversation has an owner. The team's on it.",
  },
  quote_requests: {
    icon: DollarSign,
    title: "No open quote requests",
    subtitle: "Customers aren't asking for pricing right now.",
  },
  high_priority: {
    icon: AlertCircle,
    title: "Nothing urgent",
    subtitle: "No high-priority conversations are waiting on a response.",
  },
  all: {
    icon: Mail,
    title: "No conversations yet",
    subtitle: "Email threads will appear here as they come in.",
  },
  archived: {
    icon: Archive,
    title: "Nothing archived",
    subtitle: "Resolved threads you archive will be filed here.",
  },
};

export function ThreadList({
  threads,
  isLoading,
  density,
  bucket,
  selectedThreadId,
  onSelect,
  onAssignToMe,
  onChangeState,
  onArchive,
  hasMore,
  onLoadMore,
  isFetchingMore,
}: ThreadListProps) {
  if (isLoading) {
    return (
      <div className="divide-y" data-testid="thread-list-loading">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (threads.length === 0) {
    const meta = EMPTY_STATES[bucket];
    const Icon = meta.icon;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16 gap-3" data-testid={`empty-state-${bucket}`}>
        <Icon className="w-12 h-12 text-muted-foreground/50" />
        <div>
          <p className="text-base font-semibold">{meta.title}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs">{meta.subtitle}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="thread-list">
      {threads.map(t => (
        <ThreadRow
          key={t.id}
          thread={t}
          density={density}
          isSelected={selectedThreadId === t.threadId}
          onSelect={onSelect}
          onAssignToMe={onAssignToMe}
          onChangeState={onChangeState}
          onArchive={onArchive}
        />
      ))}
      {hasMore && (
        <div className="p-3 flex items-center justify-center">
          <Button
            size="sm"
            variant="outline"
            onClick={onLoadMore}
            disabled={isFetchingMore}
            data-testid="button-load-more"
          >
            {isFetchingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
