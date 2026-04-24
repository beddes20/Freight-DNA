import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Archive, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationThread } from "./types";

export function WaitingStateBadge({ state, overdue }: { state: ConversationThread["waitingState"]; overdue: boolean }) {
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
  if (state === "archived") {
    return (
      <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-700 text-xs" data-testid="badge-waiting-state">
        <Archive className="w-3 h-3 mr-1" />
        Archived
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

export function PriorityDot({ priority }: { priority: ConversationThread["responsePriority"] }) {
  const colors: Record<string, string> = {
    urgent: "bg-red-600",
    high: "bg-red-500",
    normal: "bg-gray-400",
    low: "bg-blue-300",
  };
  const labels: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-priority">
      <span className={cn("inline-block w-2 h-2 rounded-full", colors[priority] ?? "bg-gray-400")} />
      {labels[priority] ?? priority}
    </span>
  );
}
