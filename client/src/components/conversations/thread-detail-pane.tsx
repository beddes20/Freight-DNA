import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail,
  ArrowLeft,
  Sparkles,
  Check,
  PenLine,
  User,
  MailOpen,
  MailQuestion,
  FileQuestion,
  FileText,
  ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DraftEmailModal } from "@/components/DraftEmailModal";
import { WaitingStateBadge, PriorityDot, AttributionBadge } from "./badges";
import { EmailBody } from "./email-body";
import { MessageHeader } from "./message-header";
import { ReplyCaptureAuditButton } from "./capture-audit-popover";
import { CorrectionDialog } from "./correction-dialog";
import { ConvertToQuoteDialog } from "./convert-to-quote-dialog";
import { ThreadSummaryCard, ThreadSuggestionCard, ThreadEventsTimeline } from "./smart-pane-blocks";
import { resolveThreadSubject } from "./utils";
import { hasQuoteSignal } from "./types";
import type { ConversationThread, EmailMessage } from "./types";
import { ContextNotePanel } from "@/components/context-notes";

interface ThreadDetailPaneProps {
  thread: ConversationThread;
  onBack?: () => void;
  onMarkUnread?: (thread: ConversationThread) => void;
  showBackButton?: boolean;
  readOnly?: boolean;
}

export function ThreadDetailPane({
  thread,
  onBack,
  onMarkUnread,
  showBackButton = false,
  readOnly = false,
}: ThreadDetailPaneProps) {
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const [draftTargetMessageId, setDraftTargetMessageId] = useState<string | null>(null);
  const [draftPlayTypeOverride, setDraftPlayTypeOverride] = useState<string | null>(null);
  const [correctionMsg, setCorrectionMsg] = useState<EmailMessage | null>(null);
  const [correctionRepliedToId, setCorrectionRepliedToId] = useState<string | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const [correctionNotes, setCorrectionNotes] = useState("");
  // Task #968 — Convert-to-quote dialog open state, gated to threads
  // linked to a customer (carrier-side threads aren't quotes).
  const [showConvertToQuote, setShowConvertToQuote] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  const canCorrect = user && ["admin", "sales_director", "director"].includes(user.role);

  const { data: correctionsData } = useQuery<{ corrections: { emailMessageId: string }[] }>({
    queryKey: ["/api/email-corrections", { threadId: thread.threadId }],
    queryFn: async () => {
      const res = await fetch(`/api/email-corrections?threadId=${encodeURIComponent(thread.threadId)}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
  const correctedMessageIds = new Set((correctionsData?.corrections ?? []).map(c => c.emailMessageId));

  // Task #969 — "This should be a quote" rep-side reprocess. Calls the
  // forced-reprocess endpoint, which routes through the same
  // ingestQuoteFromEmail path autopilot uses. We surface created /
  // duplicate / unparseable as distinct toast outcomes so the rep
  // knows whether a fresh quote landed in their queue or not.
  const forceReprocessMutation = useMutation({
    mutationFn: async ({ messageId }: { messageId: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/funnel-diagnostics/inbound/force-reprocess",
        { messageId },
      );
      const json = await res.json();
      return { httpStatus: res.status, ...json } as {
        httpStatus: number;
        status: "created" | "duplicate" | "unparseable" | "not_a_leak" | "not_found" | "wrong_direction";
        quoteId?: string;
        reason?: string;
      };
    },
    onSuccess: (result) => {
      // Build a clickable deep-link the toast can render. `created` /
      // `duplicate` both have a quoteId — link to the quote-requests
      // page with the row pre-selected. `unparseable` links to the
      // admin drops queue (so an admin can see *why* the pipeline
      // skipped it), filtered to this message reason. We use the
      // shadcn `ToastAction` element so the action satisfies the
      // `ToastActionElement` type and inherits the destructive-toast
      // styling automatically.
      const quoteHref = result.quoteId
        ? `/quote-requests?quote=${encodeURIComponent(result.quoteId)}`
        : null;
      const dropsHref = `/admin-quote-pipeline-health?reason=unparseable`;
      const linkAction = (href: string, label: string) => (
        <ToastAction
          altText={label}
          asChild
          data-testid="link-toast-action"
        >
          <a href={href}>{label}</a>
        </ToastAction>
      );
      switch (result.status) {
        case "created":
          toast({
            title: "Quote created",
            description: "This email is now a customer quote in your queue.",
            action: quoteHref ? linkAction(quoteHref, "Open quote") : undefined,
          });
          // Invalidate the customer-quotes list/snapshot so the new row
          // appears without a manual page refresh.
          queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
          queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
          break;
        case "duplicate":
          toast({
            title: "Already a quote",
            description: "This email was already converted to a customer quote.",
            action: quoteHref ? linkAction(quoteHref, "Open quote") : undefined,
          });
          break;
        case "unparseable":
          toast({
            title: "Couldn't extract a quote",
            description: result.reason ?? "The pipeline couldn't find a quote shape in this email.",
            variant: "destructive",
            action: linkAction(dropsHref, "View drops queue"),
          });
          break;
        case "wrong_direction":
          toast({
            title: "Outbound email",
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

  const correctionMutation = useMutation({
    mutationFn: async (params: { emailMessageId: string; originalText: string; correctedText: string; correctionNotes?: string; subject?: string; repliedToMessageId?: string | null }) => {
      const res = await apiRequest("POST", "/api/email-corrections", {
        emailMessageId: params.emailMessageId,
        originalText: params.originalText,
        correctedText: params.correctedText,
        correctionNotes: params.correctionNotes || undefined,
        threadId: thread.threadId,
        accountId: thread.linkedAccountId || undefined,
        carrierId: thread.linkedCarrierId || undefined,
        subject: params.subject || undefined,
        repliedToMessageId: params.repliedToMessageId || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      // Task #968 — wording tweak: explicit "Saved" + first-person framing so
      // the rep knows the rewrite landed and the AI will apply it next time.
      toast({
        title: "Correction saved — thanks for teaching the AI",
        description: "Your rewrite is now part of how we draft future replies on this account.",
      });
      setCorrectionMsg(null);
      setCorrectionRepliedToId(null);
      setCorrectedText("");
      setCorrectionNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/email-corrections"] });
    },
    onError: () => {
      toast({ title: "Failed to save correction", variant: "destructive" });
    },
  });

  const { data, isLoading } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(thread.id)}/messages`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
  });

  // Auto-mark-as-read: once messages have loaded for the open thread, fire a
  // single read event. We use a ref to ensure we only fire once per opened
  // thread, even if the messages query refetches.
  const markReadMutation = useMutation({
    mutationFn: async (threadRecordId: string) => {
      await apiRequest("POST", `/api/internal/conversations/${threadRecordId}/read`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
    },
  });

  const markUnreadMutation = useMutation({
    mutationFn: async (threadRecordId: string) => {
      await apiRequest("POST", `/api/internal/conversations/${threadRecordId}/unread`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Marked as unread" });
    },
    onError: () => toast({ title: "Couldn't mark thread unread", variant: "destructive" }),
  });

  // Smart-pane (Task #534): one-click handler invoked by <ThreadSuggestionCard>.
  // The card stays UI-agnostic and tells us what to do; we either open the
  // draft modal pre-targeted, or hit the waiting-state endpoint directly.
  // Once the side effect completes, all three smart-pane queries are
  // invalidated so the next view shows fresh state and a fresh suggestion.
  const setWaitingStateMutation = useMutation({
    mutationFn: async (waitingState: "waiting_on_them" | "resolved") => {
      await apiRequest("POST", `/api/internal/conversations/${thread.id}/waiting-state`, { waitingState });
    },
    onSuccess: (_data, waitingState) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", thread.id, "suggestion"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", thread.id, "events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", thread.id, "summary"] });
      toast({
        title: waitingState === "resolved" ? "Marked as resolved" : "Marked as waiting on them",
      });
    },
    onError: () => toast({ title: "Couldn't update conversation", variant: "destructive" }),
  });

  const handleSuggestionAct = (args: {
    actionType: string;
    actionParams: Record<string, unknown>;
  }) => {
    if (args.actionType === "draft_reply" || args.actionType === "quote_request_reply") {
      const targetId = typeof args.actionParams.targetMessageId === "string"
        ? args.actionParams.targetMessageId
        : null;
      const playType = typeof args.actionParams.playType === "string"
        ? args.actionParams.playType
        : null;
      setDraftTargetMessageId(targetId);
      setDraftPlayTypeOverride(playType);
      setShowDraftEmail(true);
      return;
    }
    if (args.actionType === "mark_resolved") {
      setWaitingStateMutation.mutate("resolved");
      return;
    }
    if (args.actionType === "await_response") {
      setWaitingStateMutation.mutate("waiting_on_them");
      return;
    }
    // Task #1056 (Email→Exec 5) — one-click confirm of the free-mail
    // attribution suggestion. Hard-attaches the thread to the suggested
    // company and dismisses the cached suggestion row server-side.
    if (args.actionType === "confirm_account_attribution") {
      const companyId = typeof args.actionParams.suggestedCompanyId === "string"
        ? args.actionParams.suggestedCompanyId
        : null;
      if (!companyId) {
        toast({ title: "Missing suggested company id", variant: "destructive" });
        return;
      }
      confirmAttributionMutation.mutate(companyId);
      return;
    }
  };

  // Task #1056 — POST handler for confirm-attribution. Invalidates the
  // thread, suggestion, and conversations list so the new link + the
  // emerald "Inferred: From contact" badge appear immediately.
  const confirmAttributionMutation = useMutation({
    mutationFn: async (companyId: string) => {
      const res = await apiRequest(
        "POST",
        `/api/internal/conversations/${encodeURIComponent(thread.id)}/confirm-attribution`,
        { companyId },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", thread.id, "suggestion"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Attribution confirmed" });
    },
    onError: () => toast({ title: "Couldn't confirm attribution", variant: "destructive" }),
  });

  const autoReadFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (autoReadFiredFor.current === thread.id) return;
    autoReadFiredFor.current = thread.id;
    if (thread.unread) {
      markReadMutation.mutate(thread.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, thread.id]);

  const messages = data?.messages ?? [];
  // Task #968 — latest inbound message body, used to pre-fill the
  // Convert-to-quote dialog's Notes field so the rep doesn't retype the
  // customer's actual ask. We pick the most recent inbound (i.e.
  // direction !== "outbound") rather than the very last message,
  // because a rep's outbound reply would otherwise overwrite the
  // customer's request.
  const latestInbound = [...messages].reverse().find(m => m.direction !== "outbound");
  const latestInboundBody = latestInbound?.body ?? null;
  // Quote signal — used to determine whether the Convert-to-quote
  // button should be primary (the thread looks like a pricing intent
  // but hasn't been converted yet) or secondary (the thread is
  // unrelated and conversion is just an option). Mirrors the same
  // hasQuoteSignal heuristic the list-view uses for its bucket chip.
  const threadHasQuoteSignal = hasQuoteSignal(thread);
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";
  // Task #940 — share the same display contract as the list rows. Never falls
  // back to thread.threadId (the Outlook AAQkAD… provider id) — a missing
  // subject renders as `(no subject)`.
  const subject = resolveThreadSubject({ messages });

  // Task #950 — anchor for context-notes panel inside thread detail pane.
  const contextNoteAnchor = { type: "conversation" as const, id: thread.threadId };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background" data-testid="thread-detail-panel">
      <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
        <div className="flex items-center min-w-0 flex-1 mr-4 gap-3">
          {showBackButton && onBack && (
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0 -ml-2"
              onClick={onBack}
              data-testid="button-back-to-list"
              aria-label="Back to list"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold truncate" data-testid="text-thread-subject">{subject}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <WaitingStateBadge state={thread.waitingState} overdue={isOverdue} />
              <PriorityDot priority={thread.responsePriority} />
              {/* Task #1056 (Email→Exec 5) — render the "Inferred from: …"
                  attribution chip so reps can see HOW this thread came to be
                  linked (or merely suggested-linked) to its account. The
                  badge hides itself when no inference was recorded. */}
              <AttributionBadge thread={thread} />
              {thread.ownerName && (
                <span className="text-xs text-muted-foreground">
                  <User className="w-3 h-3 inline mr-1" />{thread.ownerName}
                </span>
              )}
              {/* Task #968 — Reclassified breadcrumb chip. Surfaced when the
                  thread's most recent reclassification event is < 24h old.
                  See <ReclassifiedBreadcrumb /> for the toast handling. */}
              <ReclassifiedBreadcrumb threadRecordId={thread.id} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Visible to: thread owner + manager-class roles
              (admin / director / sales_director / logistics_manager).
              Backend `canManageThread` additionally allows the owner's
              direct manager and is the source of truth — anyone else
              hitting the endpoint sees a clean "no access" state. */}
          {user && (
            user.id === thread.ownerUserId ||
            ["admin", "director", "sales_director", "logistics_manager"].includes(user.role)
          ) && <ReplyCaptureAuditButton thread={thread} />}
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => {
              markUnreadMutation.mutate(thread.id);
              onMarkUnread?.(thread);
            }}
            disabled={markUnreadMutation.isPending}
            data-testid="button-mark-unread"
            title="Mark this thread as unread"
          >
            <MailQuestion className="w-3.5 h-3.5" />
            Mark unread
          </Button>
          {!readOnly && thread.linkedAccountId && (
            <Button
              size="sm"
              // Task #968 — when the thread carries a quote/pricing
              // signal but hasn't been converted yet, surface the
              // action as the primary CTA (gold) so the rep
              // immediately sees what to do next. Otherwise it stays
              // secondary so it doesn't compete with Draft Reply.
              variant={threadHasQuoteSignal ? "default" : "outline"}
              className="gap-1"
              onClick={() => setShowConvertToQuote(true)}
              data-testid="button-convert-to-quote"
              title={threadHasQuoteSignal
                ? "This thread looks like a quote request — spin up an opportunity"
                : "Spin up a quote opportunity from this thread"}
            >
              <FileText className="w-3.5 h-3.5" />
              Convert to quote
            </Button>
          )}
          {!readOnly && (
            <Button
              size="sm"
              variant="default"
              className="gap-1"
              onClick={() => setShowDraftEmail(true)}
              data-testid="button-draft-reply"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Draft Reply
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="messages-container">
        {/* Smart-pane (Task #534): summary + suggestion at the top, audit
            timeline at the bottom of the scroll region. We render them
            unconditionally — each card handles its own loading/error
            state, and the suggestion card hides itself when there's
            nothing actionable. */}
        <ThreadSummaryCard threadRecordId={thread.id} />
        <ThreadSuggestionCard threadRecordId={thread.id} onActOnSuggestion={handleSuggestionAct} />

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-24 w-full" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <Mail className="w-8 h-8" />
            <p className="font-medium">No messages found</p>
            <p className="text-sm">This thread has no associated email messages yet.</p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isOutbound = msg.direction === "outbound";
            const corrected = isOutbound && correctedMessageIds.has(msg.id);
            return (
              <div
                key={msg.id}
                className={cn(
                  // Outlook-style reading-pane card; outbound gets a gold
                  // left-border accent instead of the old indigo bubble.
                  "rounded-lg border bg-card text-card-foreground border-card-border shadow-sm overflow-hidden",
                  isOutbound && "border-l-[3px] border-l-primary",
                )}
                data-testid={`message-${msg.id}`}
              >
                <div className="px-4 py-3 border-b border-border/60 bg-muted/20">
                  <MessageHeader
                    fromEmail={msg.fromEmail}
                    toEmail={msg.toEmail}
                    ccEmail={msg.ccEmail}
                    date={msg.providerSentAt ?? msg.createdAt}
                    isOutbound={isOutbound}
                    testIdPrefix={`message-${msg.id}`}
                    legacyFromTestId={`text-from-${msg.id}`}
                    legacyDateTestId={`text-date-${msg.id}`}
                    actions={
                      <>
                        {corrected && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
                            data-testid={`badge-corrected-${msg.id}`}
                          >
                            <Check className="w-3 h-3" />
                            Corrected
                          </span>
                        )}
                        {!isOutbound && !readOnly && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-primary"
                            title="Draft an AI reply specifically to this message"
                            onClick={() => {
                              setDraftTargetMessageId(msg.id);
                              setShowDraftEmail(true);
                            }}
                            data-testid={`button-draft-reply-${msg.id}`}
                          >
                            <Sparkles className="w-3 h-3" />
                            Draft Reply
                          </Button>
                        )}
                        {/* Task #969 — rep-side "This should be a quote"
                            reprocess. Inbound messages only — outbound
                            sends are never quote candidates. The button
                            calls the forced-reprocess endpoint which
                            bypasses the missed-inbound race-guard but
                            still respects org / direction / dup-check. */}
                        {!isOutbound && !readOnly && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-primary"
                            title="Force this email through the customer-quote ingestion pipeline"
                            disabled={forceReprocessMutation.isPending}
                            onClick={() => forceReprocessMutation.mutate({ messageId: msg.id })}
                            data-testid={`button-force-quote-${msg.id}`}
                          >
                            <FileQuestion className="w-3 h-3" />
                            This should be a quote
                          </Button>
                        )}
                        {isOutbound && canCorrect && !readOnly && !corrected && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 gap-1 text-xs border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:text-amber-800 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/60"
                            title="Teach the AI — rewrite what this email should have said"
                            onClick={() => {
                              const prevInbound = [...messages.slice(0, idx)].reverse().find(m => m.direction !== "outbound");
                              setCorrectionMsg(msg);
                              setCorrectionRepliedToId(prevInbound?.id ?? null);
                              setCorrectedText(msg.body || "");
                              setCorrectionNotes("");
                            }}
                            data-testid={`button-correct-${msg.id}`}
                          >
                            <PenLine className="w-3.5 h-3.5" />
                            Teach AI
                          </Button>
                        )}
                      </>
                    }
                  />
                </div>
                <div className="px-4 py-3">
                  <EmailBody body={msg.body} testId={`text-body-${msg.id}`} />
                </div>
              </div>
            );
          })
        )}

        {/* Audit timeline lives at the bottom of the scroll region so the
            most recent email stays the first thing the rep reads. */}
        <ThreadEventsTimeline threadRecordId={thread.id} />
      </div>

      {showDraftEmail && (
        <DraftEmailModal
          open={showDraftEmail}
          onClose={() => { setShowDraftEmail(false); setDraftTargetMessageId(null); setDraftPlayTypeOverride(null); }}
          accountId={thread.linkedAccountId}
          threadId={thread.threadId}
          targetMessageId={draftTargetMessageId}
          defaultPlayType={draftPlayTypeOverride ?? (thread.linkedCarrierId ? "carrier_capacity" : "check_in")}
        />
      )}

      {showConvertToQuote && (
        <ConvertToQuoteDialog
          open={showConvertToQuote}
          onOpenChange={setShowConvertToQuote}
          sourceThreadId={thread.threadId}
          threadSubject={subject}
          prefillCustomerName={thread.accountName ?? null}
          latestInboundBody={latestInboundBody}
        />
      )}

      <CorrectionDialog
        open={!!correctionMsg}
        message={correctionMsg}
        correctedText={correctedText}
        correctionNotes={correctionNotes}
        isPending={correctionMutation.isPending}
        onCorrectedTextChange={setCorrectedText}
        onCorrectionNotesChange={setCorrectionNotes}
        onCancel={() => { setCorrectionMsg(null); setCorrectionRepliedToId(null); }}
        onSubmit={() => {
          if (!correctionMsg) return;
          correctionMutation.mutate({
            emailMessageId: correctionMsg.id,
            originalText: correctionMsg.body || "",
            correctedText: correctedText.trim(),
            correctionNotes: correctionNotes.trim() || undefined,
            subject: correctionMsg.subject || undefined,
            repliedToMessageId: correctionRepliedToId,
          });
        }}
      />

      {/* Team notes (Task #950 — Context Notes v1) */}
      <div className="border-t bg-muted/20 px-4 py-3">
        <ContextNotePanel anchor={contextNoteAnchor} title="Team notes" />
      </div>
    </div>
  );
}

// Task #968 — Reclassified breadcrumb. Renders a chip + Open action in
// the detail-pane header when the latest reclassification fired in the
// last 24h. The chip surfaces the destination bucket (from the event's
// `details.currentBucket`) and the Open button navigates the page to
// that bucket so the rep can land in the queue the thread now belongs
// in. Toasts once per new event per pane mount.
const RECLASSIFIED_FRESHNESS_MS = 24 * 60 * 60 * 1000;

const BUCKET_LABEL: Record<string, string> = {
  mine: "Mine",
  unowned: "Unowned",
  quote_requests: "Quote Requests",
  high_priority: "High priority",
  all: "All",
  snoozed: "Snoozed",
  archived: "Archived",
};

interface ReclassifiedEvent {
  id: string;
  eventType: string;
  description: string;
  createdAt: string;
  details?: { currentBucket?: unknown; previousBucket?: unknown } | null;
}

interface ReclassifiedBreadcrumbProps { threadRecordId: string }
function ReclassifiedBreadcrumb({ threadRecordId }: ReclassifiedBreadcrumbProps) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const lastSeenIdRef = useRef<string | null>(null);
  const { data } = useQuery<{ events: ReclassifiedEvent[] }>({
    queryKey: ["/api/internal/conversations", threadRecordId, "events"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(threadRecordId)}/events`);
      if (!res.ok) throw new Error("Failed to load events");
      return res.json();
    },
  });

  const latest = (data?.events ?? []).find(e => e.eventType === "reclassified");
  const isFresh = !!latest && (Date.now() - new Date(latest.createdAt).getTime() < RECLASSIFIED_FRESHNESS_MS);

  const destBucket = (latest?.details?.currentBucket as string | undefined) ?? null;
  const destLabel = destBucket && BUCKET_LABEL[destBucket]
    ? BUCKET_LABEL[destBucket]
    : null;
  const openDest = () => {
    if (!destBucket) return;
    const qs = destBucket === "mine" ? "" : `?bucket=${encodeURIComponent(destBucket)}`;
    setLocation(`/conversations${qs}`);
  };

  // First paint for a thread with a stale event must NOT toast — seed
  // the ref so we only fire on later transitions.
  useEffect(() => {
    if (!latest) return;
    if (lastSeenIdRef.current === null) {
      lastSeenIdRef.current = latest.id;
      return;
    }
    if (lastSeenIdRef.current === latest.id) return;
    lastSeenIdRef.current = latest.id;
    toast({
      title: destLabel ? `Reclassified to ${destLabel}` : "This thread was reclassified",
      description: latest.description,
      action: destBucket ? (
        <ToastAction
          altText="Open destination bucket"
          onClick={openDest}
          data-testid={`toast-action-open-reclassified-${threadRecordId}`}
        >
          Open
        </ToastAction>
      ) : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id]);

  if (!isFresh || !latest) return null;
  const chipText = destLabel ? `Reclassified to ${destLabel}` : "Reclassified";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-300"
      data-testid="badge-reclassified"
      title={latest.description}
    >
      <ArrowRightLeft className="w-3 h-3" />
      {chipText}
      {destBucket && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openDest(); }}
          className="ml-1 underline text-indigo-700 dark:text-indigo-300 hover:opacity-80"
          data-testid={`button-reclassified-open-${threadRecordId}`}
        >
          Open
        </button>
      )}
    </span>
  );
}

// Backwards-compat overlay wrapper used by other pages (email-intelligence,
// response-time-tab) that expect a slide-in modal instead of an inline pane.
// Same prop shape as the pre-refactor ThreadDetailPanel so callers don't need
// to change.
export function ThreadDetailPanel({
  thread,
  onClose,
  readOnly = false,
}: {
  thread: ConversationThread;
  onClose: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex" data-testid="thread-detail-panel">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-background border-l shadow-2xl flex flex-col animate-in slide-in-from-right-full duration-200">
        <ThreadDetailPane
          thread={thread}
          onBack={onClose}
          showBackButton
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

export function EmptyDetailPane() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3 px-8 py-12 bg-muted/10" data-testid="empty-detail-pane">
      <MailOpen className="w-12 h-12 opacity-40" />
      <div className="text-center">
        <p className="font-medium text-foreground">No conversation selected</p>
        <p className="text-sm">Pick a thread from the list to read it here.</p>
      </div>
    </div>
  );
}
