import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight, Clock, Mail, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAgo } from "./utils";
import type { ConversationGroup, ConversationThread } from "./types";

interface GroupHeaderProps {
  group: ConversationGroup;
  expanded: boolean;
  onToggleExpanded: () => void;
  selectionEnabled: boolean;
  selectedCount: number;
  onToggleSelected: (checked: boolean) => void;
}

const PRIORITY_LABEL: Record<ConversationThread["responsePriority"], string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

const PRIORITY_BADGE_CLASS: Record<ConversationThread["responsePriority"], string> = {
  urgent: "bg-red-600 text-white",
  high: "bg-red-500 text-white",
  normal: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-200",
  low: "bg-blue-200 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
};

export function GroupHeader({
  group,
  expanded,
  onToggleExpanded,
  selectionEnabled,
  selectedCount,
  onToggleSelected,
}: GroupHeaderProps) {
  const total = group.threads.length;
  // Header checkbox reflects the state of the threads in this group:
  // unchecked / indeterminate (some) / fully checked. Toggling either selects
  // all threads in the group or clears them — wired into the same bulk
  // selection model used by the per-row checkboxes.
  const allChecked = selectionEnabled && total > 0 && selectedCount === total;
  const someChecked = selectionEnabled && selectedCount > 0;
  // Only show the oldest waiting age when there's actually a thread in
  // waiting_on_us — otherwise the header would advertise a stale clock for
  // groups that are entirely waiting_on_them / resolved.
  const showOldestWaiting = !!group.oldestWaitingAt;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 bg-muted/40 border-b border-t border-t-transparent first:border-t-0 sticky top-0 z-10",
      )}
      data-testid={`group-header-${group.key}`}
    >
      {selectionEnabled && (
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <Checkbox
            checked={allChecked ? true : someChecked ? "indeterminate" : false}
            onCheckedChange={(v) => onToggleSelected(v === true)}
            aria-label={`Select all conversations in ${group.name}`}
            data-testid={`checkbox-group-${group.key}`}
          />
        </div>
      )}
      <button
        type="button"
        onClick={onToggleExpanded}
        className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-90"
        data-testid={`button-toggle-group-${group.key}`}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <span
          className="text-sm font-semibold truncate"
          data-testid={`text-group-name-${group.key}`}
        >
          {group.name}
        </span>
        <Badge
          variant="secondary"
          className="text-xs shrink-0"
          data-testid={`badge-group-open-${group.key}`}
        >
          {group.openCount} open
          {group.openCount !== total && ` / ${total}`}
        </Badge>
        {group.unreadCount > 0 && (
          <Badge
            className="text-xs bg-primary text-primary-foreground gap-1 shrink-0"
            data-testid={`badge-group-unread-${group.key}`}
          >
            <Mail className="w-3 h-3" />
            {group.unreadCount} unread
          </Badge>
        )}
        <Badge
          className={cn("text-xs shrink-0", PRIORITY_BADGE_CLASS[group.highestPriority])}
          data-testid={`badge-group-priority-${group.key}`}
          title={`Highest priority: ${PRIORITY_LABEL[group.highestPriority]}`}
        >
          {group.highestPriority === "urgent" && <AlertTriangle className="w-3 h-3 mr-1" />}
          {PRIORITY_LABEL[group.highestPriority]}
        </Badge>
        {showOldestWaiting && (
          <span
            className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0"
            data-testid={`text-group-oldest-${group.key}`}
          >
            <Clock className="w-3 h-3" />
            Oldest {formatAgo(group.oldestWaitingAt)}
          </span>
        )}
      </button>
    </div>
  );
}
