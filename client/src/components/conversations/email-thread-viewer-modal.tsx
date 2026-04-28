import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownLeft,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmailBody } from "./email-body";
import { formatDate } from "./utils";
import type { EmailMessage } from "./types";

// Task #809: read-only "peek" viewer for an email thread that layers on top
// of the Customer Quotes drawer. Source links inside the drawer used to
// navigate the whole page to /conversations, blowing away drawer state,
// filters, and scroll position. This modal lets reps read the source
// thread context without leaving the load they're working on.
//
// Accepts either a provider `threadId` (preferred — fetches the entire
// surrounding thread) or a message-row `messageId` (backend resolves to
// the thread, or falls back to the single message if no thread row
// exists). The "Open in Conversations" affordance opens the full inbox
// in a new tab so the originating drawer is preserved.

interface EmailThreadViewerModalProps {
  open: boolean;
  onClose: () => void;
  // Provider conversation id (Outlook conversationId / Gmail threadId).
  // When present we always prefer it over `messageId` because it gives
  // the modal the entire thread context.
  threadId: string | null;
  // email_messages row id. Used when the source only knows the message
  // (auto-flip context payloads sometimes drop threadId).
  messageId: string | null;
  // Portal target so the modal renders inside the Customer Quotes
  // overlay wrapper and stacks correctly above the drawer.
  container?: HTMLElement | null;
  // Optional subject hint shown immediately while messages are loading
  // — avoids a "loading…" header jump for callers that already know it.
  subjectHint?: string | null;
}

interface MessagesResponse {
  messages: EmailMessage[];
}

export function EmailThreadViewerModal({
  open,
  onClose,
  threadId,
  messageId,
  container,
  subjectHint,
}: EmailThreadViewerModalProps): JSX.Element {
  // Accessibility: capture the element that had focus when the modal
  // opened (typically the "View email thread" / "View triggering email"
  // button inside the drawer) so we can return focus to it on close.
  // Radix's auto-restore can be defeated when the trigger element is
  // mounted inside a portaled drawer; storing the ref ourselves makes
  // the contract deterministic.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    } else if (lastFocusedRef.current) {
      // Defer until after the dialog finishes its close animation /
      // unmount so the focus call lands on the still-mounted trigger.
      const target = lastFocusedRef.current;
      lastFocusedRef.current = null;
      requestAnimationFrame(() => {
        try { target.focus(); } catch { /* trigger may have unmounted */ }
      });
    }
  }, [open]);

  // Resolve which lookup key to send to the messages endpoint. We prefer
  // the provider threadId (fetches the entire thread); fall back to a
  // message-id resolver the backend supports (Task #809 server change).
  const lookupKey = useMemo(() => {
    if (threadId) return `thread:${threadId}`;
    if (messageId) return `message:${messageId}`;
    return null;
  }, [threadId, messageId]);

  const { data, isLoading, isError, refetch } = useQuery<MessagesResponse>({
    // Keyed only on the lookup so reopening the same thread re-uses the
    // cached fetch.
    queryKey: ["/api/internal/conversations", "thread-viewer", lookupKey],
    queryFn: async () => {
      if (!lookupKey) throw new Error("No thread reference");
      const res = await fetch(
        `/api/internal/conversations/${encodeURIComponent(lookupKey)}/messages`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load thread");
      return res.json() as Promise<MessagesResponse>;
    },
    // Only fire when the modal is actually open — keeps the network
    // graph quiet when the rep is just browsing the drawer.
    enabled: open && !!lookupKey,
    staleTime: 30_000,
  });

  const messages = data?.messages ?? [];
  const subject = messages[0]?.subject ?? subjectHint ?? "Email thread";
  // Participants: union of every from/to address across the thread, in
  // first-seen order. Mirrors how Conversations' detail header presents
  // who's in the loop without us re-implementing the whole pane.
  const participants = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of messages) {
      for (const addr of [m.fromEmail, m.toEmail].filter((x): x is string => !!x)) {
        // toEmail can be a comma-separated string when there are multiple
        // recipients; split so each address becomes its own chip.
        for (const piece of addr.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
          const k = piece.toLowerCase();
          if (!seen.has(k)) {
            seen.add(k);
            out.push(piece);
          }
        }
      }
    }
    return out;
  }, [messages]);

  // External link target — threadId wins (Conversations page understands
  // it); fall back to a messageId param even though the page doesn't deep-
  // link by message yet, so future improvements upgrade automatically.
  const conversationsHref = threadId
    ? `/conversations?threadId=${encodeURIComponent(threadId)}`
    : messageId
      ? `/conversations?messageId=${encodeURIComponent(messageId)}`
      : "/conversations";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        container={container}
        className="bg-background border-border text-foreground max-w-3xl w-[95vw] sm:w-full p-0 gap-0 max-h-[85vh] flex flex-col"
        data-testid="email-thread-viewer-modal"
      >
        <DialogHeader className="px-5 py-4 border-b border-border space-y-2">
          <div className="flex items-start justify-between gap-3 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle
                className="text-base font-semibold truncate"
                data-testid="text-thread-viewer-subject"
              >
                {subject}
              </DialogTitle>
              {participants.length > 0 && (
                <div
                  className="text-xs text-muted-foreground mt-1 truncate"
                  data-testid="text-thread-viewer-participants"
                  title={participants.join(", ")}
                >
                  {participants.join(", ")}
                </div>
              )}
            </div>
            <a
              href={conversationsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 hover:underline shrink-0 mt-0.5"
              data-testid="link-open-in-conversations"
              title="Open this thread in the full Conversations inbox (new tab)"
            >
              Open in Conversations
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </DialogHeader>

        <div
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          data-testid="thread-viewer-messages"
        >
          {isLoading ? (
            <div className="space-y-4" data-testid="thread-viewer-loading">
              {[0, 1, 2].map(i => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ))}
            </div>
          ) : isError ? (
            <div
              className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2"
              data-testid="thread-viewer-error"
            >
              <AlertTriangle className="w-7 h-7 text-amber-500" />
              <p className="font-medium text-foreground">
                Couldn&apos;t load this email thread
              </p>
              <p className="text-sm text-center max-w-sm">
                The thread may have been removed or you may not have access.
                You can try again, or open it in the full Conversations inbox.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => refetch()}
                  data-testid="button-thread-viewer-retry"
                >
                  Try again
                </Button>
                <a
                  href={conversationsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 hover:underline"
                  data-testid="link-thread-viewer-fallback"
                >
                  Open in Conversations
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2"
              data-testid="thread-viewer-empty"
            >
              <Mail className="w-7 h-7" />
              <p className="font-medium text-foreground">No messages found</p>
              <p className="text-sm">
                This thread has no email messages stored yet.
              </p>
            </div>
          ) : (
            messages.map(msg => {
              const isOutbound = msg.direction === "outbound";
              return (
                <div
                  key={msg.id}
                  className={cn(
                    "rounded-lg border px-3 py-2",
                    isOutbound
                      ? "bg-indigo-50/60 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-900/50 ml-6"
                      : "bg-white dark:bg-muted/30 border-border mr-6",
                  )}
                  data-testid={`thread-viewer-message-${msg.id}`}
                >
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          "flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0",
                          isOutbound
                            ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
                            : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
                        )}
                      >
                        {isOutbound ? (
                          <ArrowUpRight className="w-3 h-3" />
                        ) : (
                          <ArrowDownLeft className="w-3 h-3" />
                        )}
                        {isOutbound ? "Sent" : "Received"}
                      </span>
                      <span
                        className="text-xs text-muted-foreground font-medium truncate"
                        data-testid={`text-thread-viewer-from-${msg.id}`}
                      >
                        {msg.fromEmail ?? "Unknown sender"}
                      </span>
                    </div>
                    <span
                      className="text-xs text-muted-foreground shrink-0"
                      data-testid={`text-thread-viewer-date-${msg.id}`}
                    >
                      {formatDate(msg.providerSentAt ?? msg.createdAt)}
                    </span>
                  </div>
                  {msg.toEmail && (
                    <div className="text-xs text-muted-foreground mb-2 break-words">
                      To: {msg.toEmail}
                    </div>
                  )}
                  <EmailBody
                    body={msg.body}
                    testId={`text-thread-viewer-body-${msg.id}`}
                  />
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
