import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Inbox, CheckCircle2, Sparkles, AlertCircle, Mail, Archive, DollarSign, Clock } from "lucide-react";
import { ThreadRow } from "./thread-row";
import { GroupHeader } from "./group-header";
import type {
  ConversationBucket,
  ConversationDensity,
  ConversationGroup,
  ConversationGroupBy,
  ConversationThread,
} from "./types";

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
  onSnooze?: (id: string, until: Date) => void | Promise<void>;
  onUnsnooze?: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  isFetchingMore: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
  // ── Grouping (Task #535) ────────────────────────────────────────────────
  groupBy?: ConversationGroupBy;
  groups?: ConversationGroup[];
  collapsedGroupKeys?: Set<string>;
  onToggleGroupCollapsed?: (key: string) => void;
  onToggleGroupSelected?: (group: ConversationGroup, checked: boolean) => void;
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
  snoozed: {
    icon: Clock,
    title: "Nothing snoozed",
    subtitle: "Threads you snooze will land here until they wake up.",
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
  onSnooze,
  onUnsnooze,
  hasMore,
  onLoadMore,
  isFetchingMore,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  groupBy = "none",
  groups,
  collapsedGroupKeys,
  onToggleGroupCollapsed,
  onToggleGroupSelected,
}: ThreadListProps) {
  const selectionEnabled = !!onToggleSelected;
  const allChecked = selectionEnabled && threads.length > 0 && threads.every(t => selectedIds?.has(t.id));
  const someChecked = selectionEnabled && threads.some(t => selectedIds?.has(t.id));
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

  const isGrouped = groupBy !== "none" && Array.isArray(groups) && groups.length > 0;

  const renderRow = (t: ConversationThread) => (
    <ThreadRow
      key={t.id}
      thread={t}
      density={density}
      isSelected={selectedThreadId === t.threadId}
      onSelect={onSelect}
      onAssignToMe={onAssignToMe}
      onChangeState={onChangeState}
      onArchive={onArchive}
      onSnooze={onSnooze}
      onUnsnooze={onUnsnooze}
      isChecked={selectedIds?.has(t.id)}
      onToggleChecked={onToggleSelected}
    />
  );

  return (
    <div className="flex flex-col" data-testid="thread-list">
      {selectionEnabled && (
        <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/20 text-xs text-muted-foreground">
          <Checkbox
            checked={allChecked ? true : someChecked ? "indeterminate" : false}
            onCheckedChange={(v) => onToggleAll?.(v === true)}
            aria-label="Select all visible conversations"
            data-testid="checkbox-select-all"
          />
          <span data-testid="text-selection-summary">
            {someChecked
              ? `${threads.filter(t => selectedIds?.has(t.id)).length} selected`
              : `Select all ${threads.length} visible`}
          </span>
        </div>
      )}

      {isGrouped ? (
        groups!.map(group => {
          const collapsed = !!collapsedGroupKeys?.has(group.key);
          const selectedInGroup = selectionEnabled
            ? group.threads.filter(t => selectedIds?.has(t.id)).length
            : 0;
          return (
            <div key={group.key} data-testid={`group-${group.key}`}>
              <GroupHeader
                group={group}
                expanded={!collapsed}
                onToggleExpanded={() => onToggleGroupCollapsed?.(group.key)}
                selectionEnabled={selectionEnabled}
                selectedCount={selectedInGroup}
                onToggleSelected={(checked) => onToggleGroupSelected?.(group, checked)}
              />
              {!collapsed && group.threads.map(renderRow)}
            </div>
          );
        })
      ) : (
        threads.map(renderRow)
      )}

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
