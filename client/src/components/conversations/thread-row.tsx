import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ToastAction } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Clock,
  User,
  Users,
  ChevronRight,
  Sparkles,
  Archive,
  DollarSign,
  BellOff,
  Check,
  Inbox,
  MoreHorizontal,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DraftEmailModal } from "@/components/DraftEmailModal";
import { WaitingStateBadge, PriorityDot } from "./badges";
import { SnoozePopover } from "./snooze-popover";
import {
  formatAgo,
  formatDate,
  formatShortDateTime,
  resolvePreviewSnippet,
  resolveThreadSubject,
} from "./utils";
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
  // Snooze popover lives behind the overflow menu so the action is reachable
  // by keyboard/touch users; keep its open state local so the menu can pop
  // it open without nesting popovers in the trigger.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";
  const isUnread = !!thread.unread;
  const isCompact = density === "compact";

  const { toast } = useToast();
  // Task #969 — rep-side "This should be a quote" reprocess from the
  // thread-list overflow. Calls the new force-reprocess endpoint with
  // `threadId`; the server resolves to the latest inbound message.
  // Toast deep-links to the created quote on success and to the drops
  // queue when the pipeline can't extract a quote.
  const forceReprocessMutation = useMutation({
    mutationFn: async (vars: { threadId: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/funnel-diagnostics/inbound/force-reprocess",
        { threadId: vars.threadId },
      );
      const json = await res.json();
      return json as {
        status: "created" | "duplicate" | "unparseable" | "not_a_leak" | "not_found" | "wrong_direction";
        quoteId?: string;
        reason?: string;
      };
    },
    onSuccess: (result) => {
      const linkAction = (href: string, label: string) => (
        <ToastAction altText={label} asChild data-testid="link-toast-action">
          <a href={href}>{label}</a>
        </ToastAction>
      );
      const quoteHref = result.quoteId
        ? `/quote-requests?quote=${encodeURIComponent(result.quoteId)}`
        : null;
      const dropsHref = `/admin-quote-pipeline-health?reason=unparseable`;
      switch (result.status) {
        case "created":
          toast({
            title: "Quote created",
            description: "This thread is now a customer quote.",
            action: quoteHref ? linkAction(quoteHref, "Open quote") : undefined,
          });
          queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
          queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
          break;
        case "duplicate":
          toast({
            title: "Already a quote",
            description: "This thread was already converted to a customer quote.",
            action: quoteHref ? linkAction(quoteHref, "Open quote") : undefined,
          });
          break;
        case "unparseable":
          toast({
            title: "Couldn't extract a quote",
            description: result.reason ?? "The pipeline couldn't find a quote shape.",
            variant: "destructive",
            action: linkAction(dropsHref, "View drops queue"),
          });
          break;
        case "wrong_direction":
          toast({
            title: "No inbound to reprocess",
            description: "Only inbound customer emails can become quotes.",
            variant: "destructive",
          });
          break;
        default:
          toast({
            title: "Couldn't reprocess",
            description: `Status: ${result.status}`,
            variant: "destructive",
          });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Reprocess failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const { data: msgData } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(thread.id)}/messages`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    staleTime: 60_000,
  });

  const msgCount = msgData?.messages?.length ?? 0;
  const lastMsg = msgData?.messages?.[msgData.messages.length - 1];
  // Task #940 — single source of truth for the row's title + preview.
  // The helper rejects provider-id-shaped fallbacks (Outlook AAQkAD…
  // tokens), collapses Re:/Fw: chains, and never returns a `threadId`.
  // We pass NO threadHint here because `thread.threadId` is exactly the
  // id-shaped string we're guarding against.
  const displaySubject = resolveThreadSubject({ messages: msgData?.messages ?? [] });
  const previewBody = resolvePreviewSnippet(lastMsg?.body ?? "");

  const canResolve = thread.waitingState !== "resolved" && thread.waitingState !== "archived";
  const canReopen = thread.waitingState === "resolved";
  const canArchive = thread.waitingState === "resolved" && !!onArchive;
  const canUnsnooze = thread.waitingState === "snoozed" && !!onUnsnooze;
  const canSnooze = !!onSnooze && thread.waitingState !== "archived" && thread.waitingState !== "snoozed";
  const canAssignToMe = !thread.ownerName;

  return (
    <div
      className={cn(
        // `group` enables the per-row hover affordance: action buttons
        // appear on hover while the row's primary content (sender,
        // subject, badges, timestamp) stays fully visible at rest.
        "group relative flex items-start gap-3 border-b last:border-0 hover:bg-muted/40 transition-colors cursor-pointer",
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
          {/* Phase 1 — "Stop lying about freshness."
              Show two precise email-activity timestamps tied to actual
              email events (provider_sent_at). We deliberately do NOT
              read the row-touched-at clock here — it gets bumped by
              background workers (archive sweep, denormalization sweeps,
              signal rewrites) and routinely drifts hours/days off the
              actual conversation activity. A guardrail in
              tests/code-quality-guardrails.test.ts fails the build if
              that label is ever re-introduced in this file. */}
          {thread.lastIncomingAt && (
            <span title={formatDate(thread.lastIncomingAt)} data-testid={`text-last-inbound-${thread.id}`}>
              Customer replied {formatShortDateTime(thread.lastIncomingAt)}
            </span>
          )}
          {thread.lastOutgoingAt && (
            <span title={formatDate(thread.lastOutgoingAt)} data-testid={`text-last-outbound-${thread.id}`}>
              You replied {formatShortDateTime(thread.lastOutgoingAt)}
            </span>
          )}
          {!thread.lastIncomingAt && !thread.lastOutgoingAt && thread.lastEmailAt && (
            <span title={formatDate(thread.lastEmailAt)} data-testid={`text-last-email-${thread.id}`}>
              Last email {formatShortDateTime(thread.lastEmailAt)}
            </span>
          )}
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
            {previewBody}
          </p>
        )}
      </div>

      {/* Per-row actions — Resolve / Snooze / Draft are hidden by default
          and revealed on hover so the row reads as content first, controls
          second. The overflow menu next to them is always visible so
          keyboard and touch users still have a stable, reachable target
          for every action. */}
      <div
        className="flex items-center gap-1 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
          data-testid={`row-actions-${thread.id}`}
        >
          {canResolve && (
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
          {canSnooze && (
            <SnoozePopover
              onSnooze={(until) => onSnooze!(thread.id, until)}
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
        </div>

        {/* Overflow menu — keyboard/touch entry to every action plus the
            ones that don't fit in the inline row (assign-to-me, reopen,
            archive, wake-now). Always visible so it's reachable without
            hover. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              data-testid={`button-row-overflow-${thread.id}`}
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
            data-testid={`menu-row-overflow-${thread.id}`}
          >
            {/* Each menu item carries the legacy `button-X-${id}` testid
                so existing tests that drove the old inline buttons keep
                working — the action is the same, just reached through the
                overflow menu now. */}
            <DropdownMenuItem
              onClick={() => setShowDraftEmail(true)}
              data-testid={`menu-draft-${thread.id}`}
            >
              <Sparkles className="w-3.5 h-3.5 mr-2" />
              Draft reply
            </DropdownMenuItem>
            {canAssignToMe && (
              <DropdownMenuItem
                onClick={() => onAssignToMe(thread.id)}
                data-testid={`button-assign-me-${thread.id}`}
              >
                <UserPlus className="w-3.5 h-3.5 mr-2" />
                Assign to me
              </DropdownMenuItem>
            )}
            {canResolve && (
              <DropdownMenuItem
                onClick={() => onChangeState(thread.id, "resolved")}
                data-testid={`menu-resolve-${thread.id}`}
              >
                <Check className="w-3.5 h-3.5 mr-2" />
                Mark resolved
              </DropdownMenuItem>
            )}
            {canReopen && (
              <DropdownMenuItem
                onClick={() => onChangeState(thread.id, "waiting_on_us")}
                data-testid={`button-reopen-${thread.id}`}
              >
                <Inbox className="w-3.5 h-3.5 mr-2" />
                Reopen
              </DropdownMenuItem>
            )}
            {canSnooze && (
              <DropdownMenuItem
                onClick={() => setSnoozeOpen(true)}
                data-testid={`menu-snooze-${thread.id}`}
              >
                <Clock className="w-3.5 h-3.5 mr-2" />
                Snooze…
              </DropdownMenuItem>
            )}
            {canUnsnooze && (
              <DropdownMenuItem
                onClick={() => onUnsnooze!(thread.id)}
                data-testid={`button-unsnooze-${thread.id}`}
              >
                <BellOff className="w-3.5 h-3.5 mr-2" />
                Wake now
              </DropdownMenuItem>
            )}
            {/* Task #969 — rep-side "This should be a quote" reprocess
                in the thread-list overflow. Only offer it when the
                thread has at least one inbound message (otherwise the
                forced-reprocess endpoint will return wrong_direction).
                We pass `threadId` (the provider thread id) so the
                endpoint resolves to the latest inbound on its own. */}
            {!!thread.lastIncomingAt && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => forceReprocessMutation.mutate({ threadId: thread.threadId })}
                  disabled={forceReprocessMutation.isPending}
                  data-testid={`menu-force-quote-${thread.id}`}
                >
                  <Sparkles className="w-3.5 h-3.5 mr-2" />
                  This should be a quote
                </DropdownMenuItem>
              </>
            )}
            {canArchive && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onArchive!(thread.id)}
                  data-testid={`button-archive-${thread.id}`}
                >
                  <Archive className="w-3.5 h-3.5 mr-2" />
                  Archive
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Hidden snooze popover — anchored off-screen so the
            DropdownMenu's "Snooze…" item can open it without
            nesting popovers in the trigger. The popover renders its
            content in a portal so the off-screen trigger doesn't
            affect layout. */}
        {canSnooze && (
          <SnoozePopover
            onSnooze={(until) => { setSnoozeOpen(false); return onSnooze!(thread.id, until); }}
            open={snoozeOpen}
            onOpenChange={setSnoozeOpen}
            trigger={
              <span
                className="absolute opacity-0 pointer-events-none"
                aria-hidden
                tabIndex={-1}
              />
            }
          />
        )}

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
