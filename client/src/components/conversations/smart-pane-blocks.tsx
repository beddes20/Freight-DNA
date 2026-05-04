/**
 * Smarter Conversations detail-pane blocks (Task #534).
 *
 * Three drop-in cards that render at the top of the right-hand conversation
 * detail pane:
 *   • <ThreadSummaryCard>      — cached AI summary of the thread.
 *   • <ThreadSuggestionCard>   — one-click "next action" with dismiss /
 *                                "wrong suggestion" feedback.
 *   • <ThreadEventsTimeline>   — collapsible audit log, most recent first.
 *
 * All three components fetch from per-thread endpoints under
 * /api/internal/conversations/:id/{summary,suggestion,events} and render
 * a graceful loading + error state so a backend hiccup never blanks the
 * pane the rep is reading.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  ThumbsDown,
  CheckCircle2,
  Clock,
  AlertTriangle,
  History,
  UserPlus,
  UserMinus,
  ArrowRightLeft,
  Archive,
  Mail,
  Wand2,
  Pencil,
  RotateCcw,
  Flag,
} from "lucide-react";
import { formatDate } from "./utils";

// ─── Shared types (mirror the backend service shapes) ──────────────────────

export interface ThreadSummaryDTO {
  summary: string;
  generatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  cached: boolean;
  stale: boolean;
  contentHash: string;
}

export interface ThreadSuggestionDTO {
  actionType: "draft_reply" | "quote_request_reply" | "mark_resolved" | "await_response" | "none";
  actionLabel: string;
  actionReason: string;
  actionParams: Record<string, unknown>;
  contentHash: string;
  generatedAt: string;
  cached: boolean;
  dismissed: boolean;
  feedbackKind: string | null;
}

export interface ThreadEventDTO {
  id: string;
  threadId: string;
  actorUserId: string | null;
  actorName: string | null;
  eventType: string;
  description: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// ─── Summary card ──────────────────────────────────────────────────────────

export function ThreadSummaryCard({ threadRecordId }: { threadRecordId: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch, isRefetching } = useQuery<{ summary: ThreadSummaryDTO | null }>({
    queryKey: ["/api/internal/conversations", threadRecordId, "summary"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(threadRecordId)}/summary`);
      if (!res.ok) throw new Error("Failed to load summary");
      return res.json();
    },
    // Summaries are cached server-side; no need to refetch on focus.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/internal/conversations/${encodeURIComponent(threadRecordId)}/summary/regenerate`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", threadRecordId, "summary"] });
      toast({ title: "Summary regenerated" });
    },
    onError: () => toast({ title: "Couldn't regenerate summary", variant: "destructive" }),
  });

  const summary = data?.summary;
  const isBusy = regenerate.isPending || isRefetching;

  return (
    <div
      className="rounded-lg border border-indigo-200 bg-indigo-50/40 dark:bg-indigo-950/20 dark:border-indigo-900/50 px-4 py-3"
      data-testid="card-thread-summary"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
          <Sparkles className="w-3.5 h-3.5" />
          Thread summary
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 -my-1 text-xs gap-1 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40"
          onClick={() => regenerate.mutate()}
          disabled={isBusy}
          data-testid="button-regenerate-summary"
        >
          <RefreshCw className={cn("w-3 h-3", isBusy && "animate-spin")} />
          Regenerate
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="summary-skeleton">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-4/6" />
        </div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground" data-testid="summary-error">
          Couldn't load the summary. Try the regenerate button.
        </p>
      ) : !summary ? (
        <p className="text-sm text-muted-foreground" data-testid="summary-empty">
          No messages yet to summarise.
        </p>
      ) : (
        <>
          <p className="text-sm leading-snug text-foreground whitespace-pre-line" data-testid="text-thread-summary">
            {summary.summary}
          </p>
          <div className="flex items-center gap-2 mt-2 text-[11px] text-muted-foreground" data-testid="summary-meta">
            <span>Based on {summary.messageCount} message{summary.messageCount === 1 ? "" : "s"}</span>
            <span>•</span>
            <span>Updated {formatDate(summary.generatedAt)}</span>
            {summary.stale && (
              <span className="ml-1 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" data-testid="summary-stale-badge">
                <AlertTriangle className="w-3 h-3" />
                Out of date
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Suggestion card ───────────────────────────────────────────────────────

interface SuggestionHandlerArgs {
  actionType: ThreadSuggestionDTO["actionType"];
  actionParams: Record<string, unknown>;
}

export interface ThreadSuggestionCardProps {
  threadRecordId: string;
  /**
   * Called when the rep clicks the primary one-click button. The host pane
   * is responsible for the actual side effect (open draft modal, hit
   * waiting-state endpoint, etc.) so the suggestion card stays UI-agnostic.
   */
  onActOnSuggestion: (args: SuggestionHandlerArgs) => void;
}

export function ThreadSuggestionCard({ threadRecordId, onActOnSuggestion }: ThreadSuggestionCardProps) {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<{ suggestion: ThreadSuggestionDTO | null }>({
    queryKey: ["/api/internal/conversations", threadRecordId, "suggestion"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(threadRecordId)}/suggestion`);
      if (!res.ok) throw new Error("Failed to load suggestion");
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/internal/conversations/${encodeURIComponent(threadRecordId)}/suggestion/dismiss`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", threadRecordId, "suggestion"] });
    },
  });

  const feedback = useMutation({
    mutationFn: async (kind: "wrong" | "good") => {
      const res = await apiRequest("POST", `/api/internal/conversations/${encodeURIComponent(threadRecordId)}/suggestion/feedback`, { kind });
      return res.json();
    },
    onSuccess: (_data, kind) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", threadRecordId, "suggestion"] });
      toast({ title: kind === "wrong" ? "Thanks — we'll learn from this" : "Glad it helped" });
    },
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3" data-testid="card-thread-suggestion-loading">
        <Skeleton className="h-3 w-32 mb-2" />
        <Skeleton className="h-4 w-full mb-3" />
        <Skeleton className="h-8 w-32" />
      </div>
    );
  }

  if (isError) return null;

  const suggestion = data?.suggestion;
  if (!suggestion || suggestion.actionType === "none" || suggestion.dismissed) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/20 px-4 py-3"
      data-testid="card-thread-suggestion"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          <Wand2 className="w-3.5 h-3.5" />
          Suggested next action
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 -my-1 text-muted-foreground hover:text-foreground"
          onClick={() => dismiss.mutate()}
          disabled={dismiss.isPending}
          data-testid="button-dismiss-suggestion"
          aria-label="Dismiss suggestion"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <p className="text-sm text-foreground leading-snug mb-3" data-testid="text-suggestion-reason">
        {suggestion.actionReason}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="default"
          className="gap-1.5"
          onClick={() => onActOnSuggestion({
            actionType: suggestion.actionType,
            actionParams: suggestion.actionParams ?? {},
          })}
          data-testid="button-act-on-suggestion"
        >
          {iconForAction(suggestion.actionType)}
          {suggestion.actionLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-xs gap-1 text-muted-foreground hover:text-amber-700 dark:hover:text-amber-400"
          onClick={() => feedback.mutate("wrong")}
          disabled={feedback.isPending}
          data-testid="button-suggestion-wrong"
        >
          <ThumbsDown className="w-3.5 h-3.5" />
          Wrong suggestion
        </Button>
      </div>
    </div>
  );
}

function iconForAction(actionType: ThreadSuggestionDTO["actionType"]) {
  switch (actionType) {
    case "draft_reply":
    case "quote_request_reply":
      return <Sparkles className="w-3.5 h-3.5" />;
    case "mark_resolved":
      return <CheckCircle2 className="w-3.5 h-3.5" />;
    case "await_response":
      return <Clock className="w-3.5 h-3.5" />;
    default:
      return null;
  }
}

// ─── Audit timeline ────────────────────────────────────────────────────────

export function ThreadEventsTimeline({ threadRecordId }: { threadRecordId: string }) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<{ events: ThreadEventDTO[] }>({
    queryKey: ["/api/internal/conversations", threadRecordId, "events"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(threadRecordId)}/events`);
      if (!res.ok) throw new Error("Failed to load events");
      return res.json();
    },
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const events = data?.events ?? [];

  return (
    <div className="rounded-lg border bg-card" data-testid="card-thread-events">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-muted/40"
        onClick={() => setOpen(o => !o)}
        data-testid="button-toggle-events"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <History className="w-3.5 h-3.5" />
          Activity
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 max-h-72 overflow-y-auto" data-testid="events-list">
          {isLoading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : isError ? (
            <p className="text-xs text-muted-foreground py-2">Couldn't load activity for this thread.</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2" data-testid="events-empty">
              No tracked activity on this thread yet.
            </p>
          ) : (
            <ol className="space-y-2 py-1">
              {events.map(ev => (
                <li
                  key={ev.id}
                  className="flex items-start gap-2 text-xs"
                  data-testid={`event-${ev.id}`}
                >
                  <span className={cn("mt-0.5 shrink-0", iconColorForEvent(ev.eventType))}>
                    {iconForEvent(ev.eventType)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground leading-snug" data-testid={`event-description-${ev.id}`}>
                      {ev.description}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatDate(ev.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function iconForEvent(eventType: string) {
  switch (eventType) {
    case "assigned": return <UserPlus className="w-3.5 h-3.5" />;
    case "reassigned": return <ArrowRightLeft className="w-3.5 h-3.5" />;
    case "unassigned": return <UserMinus className="w-3.5 h-3.5" />;
    case "resolved": return <CheckCircle2 className="w-3.5 h-3.5" />;
    case "reopened": return <RotateCcw className="w-3.5 h-3.5" />;
    case "archived": return <Archive className="w-3.5 h-3.5" />;
    case "unarchived": return <RotateCcw className="w-3.5 h-3.5" />;
    case "priority_changed": return <Flag className="w-3.5 h-3.5" />;
    case "ai_drafted": return <Sparkles className="w-3.5 h-3.5" />;
    case "ai_corrected": return <Pencil className="w-3.5 h-3.5" />;
    case "human_sent": return <Mail className="w-3.5 h-3.5" />;
    case "capture_audit_recovery": return <RefreshCw className="w-3.5 h-3.5" />;
    // Task #968 — reuses ArrowRightLeft (already imported for "reassigned")
    // because the visual idea is the same: the thread moved from one
    // place to another. The colour ramp distinguishes it.
    case "reclassified": return <ArrowRightLeft className="w-3.5 h-3.5" />;
    default: return <History className="w-3.5 h-3.5" />;
  }
}

function iconColorForEvent(eventType: string): string {
  switch (eventType) {
    case "resolved":
    case "ai_drafted":
    case "human_sent":
      return "text-emerald-600 dark:text-emerald-400";
    case "archived":
    case "unassigned":
      return "text-muted-foreground";
    case "priority_changed":
      return "text-amber-600 dark:text-amber-400";
    case "capture_audit_recovery":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "text-indigo-600 dark:text-indigo-400";
  }
}
