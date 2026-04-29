/**
 * Capture Leak Queue.
 *
 * Row-level expansion of the missingIntentInbound / orphanOutbound
 * counters surfaced by the FreightCaptureDiagnostics tile. Two tabs
 * (Missed inbound default), an Open-thread link, a small customer-state
 * chip, and a Load-more pager driven by the server's `hasMore` flag.
 *
 * Phase 2A — adds two admin triage actions on every row:
 *   • Not a quote   → records `decision="not_quote"`
 *   • Ignore for now → records `decision="ignored"`
 * Both reads and writes invalidate the diagnostics counts so the leak
 * count and the queue list stay in lock-step (no client-side hiding).
 *
 * Phase 2B — adds a third action on Missed Inbound rows ONLY:
 *   • Create quote → reuses the autopilot ingestion path to make a real
 *     quote_opportunity from the email, then deep-links the user to it
 *     via `?quote=<id>` on the customer-quotes page. Orphan Outbound
 *     rows have no inbound payload to parse, so the action is omitted
 *     there. No bulk; no AI auto-create.
 *
 * Mounted by FreightCaptureDiagnostics; admin-only at the parent level
 * (the route itself also 403s for non-admin).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AlertCircle, ExternalLink, Inbox, Send, X, Clock, Plus } from "lucide-react";

type LeakType = "missed_inbound" | "orphan_outbound";
type LeakDecision = "not_quote" | "ignored";

type CustomerState = "known_customer" | "unknown_customer" | "no_linked_customer";

interface BaseRow {
  messageId: string;
  threadId: string | null;
  subject: string | null;
  bodySnippet: string | null;
  linkedCustomerId: string | null;
  linkedCustomerName: string | null;
  customerState: CustomerState;
}

interface InboundRow extends BaseRow {
  fromEmail: string | null;
  fromName: string | null;
  receivedAt: string;
}

interface OutboundRow extends BaseRow {
  threadId: string;
  toEmail: string | null;
  sentAt: string;
  lastInboundFromEmail: string | null;
  lastInboundSubject: string | null;
  lastInboundAt: string | null;
}

interface QueueResponse {
  type: LeakType;
  windowDays: number;
  total: number;
  hasMore: boolean;
  rows: InboundRow[] | OutboundRow[];
}

interface ReviewLeakResponse {
  status: "ok";
  review: { id: string; decision: LeakDecision; messageId: string };
}

interface CreateQuoteResponse {
  status: "created" | "duplicate" | "unparseable" | "not_a_leak" | "not_found" | "wrong_direction";
  quoteId?: string;
  reason?: string;
}

const PAGE_SIZE = 50;

function fmtRel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function CustomerChip({ state, name }: { state: CustomerState; name: string | null }): JSX.Element {
  if (state === "known_customer") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-medium border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
        data-testid={`leak-customer-chip-known`}
      >
        {name ?? "Known customer"}
      </Badge>
    );
  }
  if (state === "unknown_customer") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-medium border-amber-500/40 text-amber-700 dark:text-amber-300"
        data-testid={`leak-customer-chip-unknown`}
      >
        Unknown customer
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] font-medium border-border text-muted-foreground"
      data-testid={`leak-customer-chip-nolink`}
    >
      No linked customer
    </Badge>
  );
}

function OpenThreadLink({ threadId }: { threadId: string | null }): JSX.Element {
  if (!threadId) {
    return (
      <span
        className="text-[11px] text-muted-foreground/60"
        title="This message is not associated with a thread"
        data-testid="leak-open-thread-disabled"
      >
        no thread
      </span>
    );
  }
  return (
    <a
      href={`/conversations?threadId=${encodeURIComponent(threadId)}`}
      className="inline-flex items-center gap-1 text-[11px] text-foreground hover:underline"
      data-testid={`leak-open-thread-${threadId}`}
    >
      Open thread <ExternalLink className="h-3 w-3" />
    </a>
  );
}

interface RowActionsProps {
  messageId: string;
  leakType: LeakType;
  isReviewing: boolean;
  isCreating: boolean;
  onReview: (decision: LeakDecision) => void;
  onCreateQuote?: () => void;
}

function RowActions({
  messageId,
  leakType,
  isReviewing,
  isCreating,
  onReview,
  onCreateQuote,
}: RowActionsProps): JSX.Element {
  const busy = isReviewing || isCreating;
  return (
    <div
      className="flex flex-wrap items-center gap-1 mt-1.5"
      data-testid={`leak-row-actions-${messageId}`}
    >
      {onCreateQuote && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onCreateQuote}
          className="h-6 px-2 text-[11px] gap-1 border-emerald-600/40 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
          data-testid={`leak-action-create-quote-${messageId}`}
          aria-label="Create a quote from this email"
        >
          <Plus className="h-3 w-3" />
          {isCreating ? "Creating…" : "Create quote"}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => onReview("not_quote")}
        className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
        data-testid={`leak-action-not-quote-${messageId}`}
        aria-label="Mark this row as not a quote"
      >
        <X className="h-3 w-3" />
        Not a quote
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => onReview("ignored")}
        className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
        data-testid={`leak-action-ignore-${messageId}`}
        aria-label="Hide this row from the queue"
      >
        <Clock className="h-3 w-3" />
        Ignore for now
      </Button>
      <span className="sr-only">Type: {leakType}</span>
    </div>
  );
}

interface InboundRowViewProps {
  row: InboundRow;
  reviewingId: string | null;
  creatingId: string | null;
  onReview: (messageId: string, decision: LeakDecision) => void;
  onCreateQuote: (messageId: string) => void;
}

function InboundRowView({
  row,
  reviewingId,
  creatingId,
  onReview,
  onCreateQuote,
}: InboundRowViewProps): JSX.Element {
  const sender = row.fromName
    ? `${row.fromName} <${row.fromEmail ?? "?"}>`
    : row.fromEmail ?? "Unknown sender";
  return (
    <div
      className="border-b border-border/60 last:border-0 py-2 px-1"
      data-testid={`leak-row-${row.messageId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-medium text-foreground truncate" title={sender}>
              {sender}
            </span>
            <CustomerChip state={row.customerState} name={row.linkedCustomerName} />
          </div>
          <div className="text-xs text-foreground truncate" title={row.subject ?? ""}>
            {row.subject ?? <span className="italic text-muted-foreground">(no subject)</span>}
          </div>
          {row.bodySnippet && (
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2" title={row.bodySnippet}>
              {row.bodySnippet}
            </div>
          )}
          <RowActions
            messageId={row.messageId}
            leakType="missed_inbound"
            isReviewing={reviewingId === row.messageId}
            isCreating={creatingId === row.messageId}
            onReview={(d) => onReview(row.messageId, d)}
            onCreateQuote={() => onCreateQuote(row.messageId)}
          />
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">{fmtRel(row.receivedAt)}</span>
          <OpenThreadLink threadId={row.threadId} />
        </div>
      </div>
    </div>
  );
}

interface OutboundRowViewProps {
  row: OutboundRow;
  reviewingId: string | null;
  onReview: (messageId: string, decision: LeakDecision) => void;
}

function OutboundRowView({
  row,
  reviewingId,
  onReview,
}: OutboundRowViewProps): JSX.Element {
  return (
    <div
      className="border-b border-border/60 last:border-0 py-2 px-1"
      data-testid={`leak-row-${row.messageId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-medium text-foreground truncate" title={row.toEmail ?? ""}>
              To: {row.toEmail ?? "Unknown recipient"}
            </span>
            <CustomerChip state={row.customerState} name={row.linkedCustomerName} />
          </div>
          <div className="text-xs text-foreground truncate" title={row.subject ?? ""}>
            {row.subject ?? <span className="italic text-muted-foreground">(no subject)</span>}
          </div>
          {row.bodySnippet && (
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2" title={row.bodySnippet}>
              {row.bodySnippet}
            </div>
          )}
          {row.lastInboundFromEmail && (
            <div className="text-[11px] text-muted-foreground/80 mt-1 italic truncate" title={row.lastInboundSubject ?? ""}>
              ↳ replying to {row.lastInboundFromEmail}
              {row.lastInboundSubject ? ` · ${row.lastInboundSubject}` : ""}
              {row.lastInboundAt ? ` · ${fmtRel(row.lastInboundAt)}` : ""}
            </div>
          )}
          {/* Phase 2B intentionally omits "Create quote" on Orphan Outbound:
              there's no inbound email payload to parse. */}
          <RowActions
            messageId={row.messageId}
            leakType="orphan_outbound"
            isReviewing={reviewingId === row.messageId}
            isCreating={false}
            onReview={(d) => onReview(row.messageId, d)}
          />
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">{fmtRel(row.sentAt)}</span>
          <OpenThreadLink threadId={row.threadId} />
        </div>
      </div>
    </div>
  );
}

interface Props {
  /** Caller-controlled visibility — typically only mounted when the
   *  parent diagnostics panel is open and the user is admin. */
  enabled: boolean;
}

export function CaptureLeakQueue({ enabled }: Props): JSX.Element | null {
  const [type, setType] = useState<LeakType>("missed_inbound");
  const [limit, setLimit] = useState<number>(PAGE_SIZE);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const { data, isLoading, isError, error, isFetching } = useQuery<QueueResponse>({
    queryKey: ["/api/customer-quotes/funnel-diagnostics/leaks", type, limit] as const,
    enabled,
    queryFn: async () => {
      const qs = new URLSearchParams({ type, limit: String(limit), offset: "0" });
      const res = await fetch(`/api/customer-quotes/funnel-diagnostics/leaks?${qs.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Leak queue request failed (${res.status})`);
      return res.json() as Promise<QueueResponse>;
    },
    staleTime: 30_000,
  });

  // Both writes need to invalidate BOTH the queue and the funnel-diagnostics
  // counts so the badge total drops in lock-step with the queue row.
  function invalidateLeakViews(): void {
    qc.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel-diagnostics/leaks"] });
    qc.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel-diagnostics"] });
  }

  const reviewMutation = useMutation({
    mutationFn: async (input: { messageId: string; decision: LeakDecision; leakType: LeakType }) => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/funnel-diagnostics/leaks/review",
        input,
      );
      return (await res.json()) as ReviewLeakResponse;
    },
    onMutate: ({ messageId }) => setReviewingId(messageId),
    onSuccess: (_data, vars) => {
      invalidateLeakViews();
      toast({
        title: vars.decision === "not_quote" ? "Marked as not a quote" : "Hidden from queue",
        description: vars.decision === "not_quote"
          ? "This row will no longer appear in the leak queue."
          : "Use the funnel diagnostics later to re-review.",
      });
    },
    onError: (err) => {
      toast({
        title: "Could not record decision",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
    onSettled: () => setReviewingId(null),
  });

  const createMutation = useMutation({
    mutationFn: async (input: { messageId: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/funnel-diagnostics/leaks/create-quote",
        input,
      );
      return (await res.json()) as CreateQuoteResponse;
    },
    onMutate: ({ messageId }) => setCreatingId(messageId),
    onSuccess: (data) => {
      invalidateLeakViews();
      // Also invalidate the customer-quotes list/drawer so the new row
      // shows up if the user navigates to the page.
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes"] });
      switch (data.status) {
        case "created":
          toast({
            title: "Quote created",
            description: "Opening the new quote…",
          });
          if (data.quoteId) {
            navigate(`/customer-quotes?quote=${encodeURIComponent(data.quoteId)}`);
          }
          break;
        case "duplicate":
          toast({
            title: "Quote already exists",
            description: data.quoteId
              ? "Opening the existing quote…"
              : "A quote for this email already exists.",
          });
          if (data.quoteId) {
            navigate(`/customer-quotes?quote=${encodeURIComponent(data.quoteId)}`);
          }
          break;
        case "unparseable":
          toast({
            title: "Could not extract a quote",
            description: data.reason ?? "The email body didn't yield a usable quote shape. Try Open thread to handle it manually.",
            variant: "destructive",
          });
          break;
        case "not_a_leak":
          toast({
            title: "Row no longer in queue",
            description: "Another reviewer or the autopilot resolved this row already.",
          });
          break;
        case "not_found":
          toast({
            title: "Email not found",
            description: "This row no longer exists in your organization.",
            variant: "destructive",
          });
          break;
        case "wrong_direction":
          toast({
            title: "Cannot create from outbound",
            description: "Manual create is only available on inbound emails.",
            variant: "destructive",
          });
          break;
      }
    },
    onError: (err) => {
      toast({
        title: "Could not create quote",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
    onSettled: () => setCreatingId(null),
  });

  if (!enabled) return null;

  function pickType(next: LeakType): void {
    if (next === type) return;
    setType(next);
    setLimit(PAGE_SIZE);
  }

  function handleReview(messageId: string, decision: LeakDecision): void {
    reviewMutation.mutate({ messageId, decision, leakType: type });
  }

  function handleCreateQuote(messageId: string): void {
    createMutation.mutate({ messageId });
  }

  return (
    <div className="rounded border border-border bg-card mt-3" data-testid="capture-leak-queue">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Capture leak review
        </div>
        <div className="text-[10px] text-muted-foreground">
          {data ? `Last ${data.windowDays} days` : ""}
        </div>
      </div>

      <div className="px-3 pt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => pickType("missed_inbound")}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-t border-b-2 transition-colors ${
            type === "missed_inbound"
              ? "border-amber-500 text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="leak-tab-missed-inbound"
        >
          <Inbox className="h-3.5 w-3.5" />
          Missed inbound
          {type === "missed_inbound" && data && (
            <span className="text-[10px] tabular-nums text-muted-foreground">({data.total})</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => pickType("orphan_outbound")}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-t border-b-2 transition-colors ${
            type === "orphan_outbound"
              ? "border-amber-500 text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="leak-tab-orphan-outbound"
        >
          <Send className="h-3.5 w-3.5" />
          Orphan outbound
          {type === "orphan_outbound" && data && (
            <span className="text-[10px] tabular-nums text-muted-foreground">({data.total})</span>
          )}
        </button>
      </div>

      <div className="px-2 pb-2">
        {isLoading && (
          <div className="space-y-2 px-1 py-2" data-testid="leak-queue-loading">
            <Skeleton className="h-12 w-full bg-card" />
            <Skeleton className="h-12 w-full bg-card" />
            <Skeleton className="h-12 w-full bg-card" />
          </div>
        )}

        {isError && (
          <div
            className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs px-1 py-3"
            data-testid="leak-queue-error"
          >
            <AlertCircle className="h-4 w-4" />
            <span>Could not load leak queue: {error instanceof Error ? error.message : "Unknown error"}</span>
          </div>
        )}

        {data && data.rows.length === 0 && (
          <div className="px-1 py-6 text-center text-xs text-muted-foreground" data-testid="leak-queue-empty">
            Nothing to review — your capture pipeline is healthy for the last {data.windowDays} days.
          </div>
        )}

        {data && data.rows.length > 0 && (
          <div data-testid={`leak-queue-list-${type}`}>
            {type === "missed_inbound"
              ? (data.rows as InboundRow[]).map(r => (
                  <InboundRowView
                    key={r.messageId}
                    row={r}
                    reviewingId={reviewingId}
                    creatingId={creatingId}
                    onReview={handleReview}
                    onCreateQuote={handleCreateQuote}
                  />
                ))
              : (data.rows as OutboundRow[]).map(r => (
                  <OutboundRowView
                    key={r.messageId}
                    row={r}
                    reviewingId={reviewingId}
                    onReview={handleReview}
                  />
                ))}
          </div>
        )}

        {data && data.hasMore && (
          <div className="flex items-center justify-center pt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit(l => Math.min(l + PAGE_SIZE, 100))}
              disabled={isFetching || limit >= 100}
              className="h-7 text-xs"
              data-testid="leak-queue-load-more"
            >
              {limit >= 100 ? "Showing maximum (100)" : isFetching ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}

        {data && !data.hasMore && data.rows.length > 0 && (
          <div className="text-[10px] text-center text-muted-foreground pt-2" data-testid="leak-queue-page-info">
            Showing {data.rows.length} of {data.total}
          </div>
        )}
      </div>
    </div>
  );
}
