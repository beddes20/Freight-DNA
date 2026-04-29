/**
 * Capture Leak Queue (Phase 1, read-only).
 *
 * Row-level expansion of the missingIntentInbound / orphanOutbound
 * counters surfaced by the FreightCaptureDiagnostics tile. Two tabs
 * (Missed inbound default), an Open-thread link as the only row action,
 * a small customer-state chip, and a Load-more pager driven by the
 * server's `hasMore` flag. Intentionally has no create / dismiss /
 * attach actions in Phase 1.
 *
 * Mounted by FreightCaptureDiagnostics; admin-only at the parent level
 * (the route itself also 403s for non-admin).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, ExternalLink, Inbox, Send } from "lucide-react";

type LeakType = "missed_inbound" | "orphan_outbound";

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

function InboundRowView({ row }: { row: InboundRow }): JSX.Element {
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
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">{fmtRel(row.receivedAt)}</span>
          <OpenThreadLink threadId={row.threadId} />
        </div>
      </div>
    </div>
  );
}

function OutboundRowView({ row }: { row: OutboundRow }): JSX.Element {
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

  if (!enabled) return null;

  function pickType(next: LeakType): void {
    if (next === type) return;
    setType(next);
    setLimit(PAGE_SIZE);
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
              ? (data.rows as InboundRow[]).map(r => <InboundRowView key={r.messageId} row={r} />)
              : (data.rows as OutboundRow[]).map(r => <OutboundRowView key={r.messageId} row={r} />)}
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
