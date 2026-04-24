import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Clock, User, Users, ChevronRight, Sparkles, Archive, DollarSign, BellOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { DraftEmailModal } from "@/components/DraftEmailModal";
import { WaitingStateBadge, PriorityDot } from "./badges";
import { SnoozePopover } from "./snooze-popover";
import { stripHtmlToText, formatAgo } from "./utils";
import { hasQuoteSignal } from "./types";
import type { ConversationThread, EmailMessage, ConversationDensity } from "./types";

export function ThreadRow({
  thread,
  density,
  onAssignToMe,
  onChangeState,
  onArchive,
  onSnooze,
  onUnsnooze,
  onSelect,
  isSelected,
  isChecked,
  onToggleChecked,
}: {
  thread: ConversationThread;
  density: ConversationDensity;
  onAssignToMe: (id: string) => void;
  onChangeState: (id: string, state: ConversationThread["waitingState"]) => void;
  onArchive?: (id: string) => void;
  onSnooze?: (id: string, until: Date) => void | Promise<void>;
  onUnsnooze?: (id: string) => void;
  onSelect: (thread: ConversationThread) => void;
  isSelected: boolean;
  isChecked?: boolean;
  onToggleChecked?: (id: string, checked: boolean) => void;
}) {
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";
  const isUnread = !!thread.unread;
  const isCompact = density === "compact";

  const { data: msgData } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(thread.id)}/messages`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    staleTime: 60_000,
  });

  const firstMsg = msgData?.messages?.[0];
  const msgCount = msgData?.messages?.length ?? 0;
  const displaySubject = firstMsg?.subject ?? thread.threadId.slice(0, 24) + "…";
  const lastMsg = msgData?.messages?.[msgData.messages.length - 1];
  const previewBody = stripHtmlToText(lastMsg?.body ?? "").slice(0, 120);

  return (
    <div
      className={cn(
        "relative flex items-start gap-3 border-b last:border-0 hover:bg-muted/40 transition-colors cursor-pointer",
        isCompact ? "px-3 py-2" : "px-4 py-3",
        isOverdue && "bg-red-50/50 dark:bg-red-950/20",
        isSelected && "bg-muted/60 dark:bg-muted/40 border-l-2 border-l-primary -ml-px"
      )}
      onClick={() => onSelect(thread)}
      data-testid={`row-conversation-${thread.id}`}
      data-unread={isUnread ? "true" : "false"}
    >
      {/* Unread accent stripe — visually distinct without being noisy.
          Shows when the user hasn't viewed the thread since its most recent
          inbound message. Auto-clears on open. */}
      {isUnread && (
        <span
          className="absolute left-0 top-0 bottom-0 w-1 bg-primary"
          aria-hidden
          data-testid={`unread-indicator-${thread.id}`}
        />
      )}

      {onToggleChecked && (
        <div className="pt-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={!!isChecked}
            onCheckedChange={(v) => onToggleChecked(thread.id, v === true)}
            data-testid={`checkbox-thread-${thread.id}`}
            aria-label="Select conversation"
          />
        </div>
      )}

      <div className="pt-1 shrink-0">
        <PriorityDot priority={thread.responsePriority} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span
            className={cn(
              "text-sm truncate max-w-md",
              isUnread ? "font-bold text-foreground" : "font-medium text-foreground"
            )}
            data-testid={`text-thread-id-${thread.id}`}
          >
            {displaySubject}
          </span>
          <WaitingStateBadge state={thread.waitingState} overdue={isOverdue} />
          {isOverdue && (
            <Badge className="text-xs bg-red-600 text-white" data-testid={`badge-overdue-${thread.id}`}>
              Overdue
            </Badge>
          )}
          {!isCompact && msgCount > 0 && (
            <Badge variant="outline" className="text-xs">{msgCount} msg{msgCount !== 1 ? "s" : ""}</Badge>
          )}
          {hasQuoteSignal(thread) && (
            <Badge
              className="text-xs bg-emerald-600 text-white gap-1"
              data-testid={`badge-quote-request-${thread.id}`}
            >
              <DollarSign className="w-3 h-3" />
              Quote request
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
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
          {thread.ownerName ? (
            <span className="font-medium text-foreground" data-testid={`text-owner-${thread.id}`}>{thread.ownerName}</span>
          ) : (
            <span className="italic">Unowned</span>
          )}
        </div>
        {!isCompact && previewBody && (
          <p className={cn(
            "text-xs mt-1 truncate max-w-xl",
            isUnread ? "text-foreground" : "text-muted-foreground italic"
          )}>
            {previewBody}{previewBody.length >= 120 ? "…" : ""}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
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
        {thread.waitingState !== "resolved" && thread.waitingState !== "archived" && (
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
        {thread.waitingState === "resolved" && onArchive && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1"
            onClick={() => onArchive(thread.id)}
            data-testid={`button-archive-${thread.id}`}
          >
            <Archive className="w-3 h-3" />
            Archive
          </Button>
        )}
        {thread.waitingState === "snoozed" && onUnsnooze && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1"
            onClick={() => onUnsnooze(thread.id)}
            data-testid={`button-unsnooze-${thread.id}`}
          >
            <BellOff className="w-3 h-3" />
            Wake now
          </Button>
        )}
        {onSnooze && thread.waitingState !== "archived" && thread.waitingState !== "snoozed" && (
          <SnoozePopover
            onSnooze={(until) => onSnooze(thread.id, until)}
            testId={`button-snooze-${thread.id}`}
            trigger={
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                data-testid={`button-snooze-${thread.id}`}
              >
                <Clock className="w-3 h-3" />
                Snooze
              </Button>
            }
          />
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
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
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
