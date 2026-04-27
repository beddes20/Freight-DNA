/**
 * Task #723 — Pending quotes quick list with inline mark-outcome action.
 *
 * Small table embedded under the Capture Funnel page that shows the user's
 * pending quotes (newest first, capped) and gives reps a one-click way to
 * resolve each one as Won, Lost (with reason), or No-response. Powers the
 * "decisions never get recorded" failure mode the funnel is designed to
 * surface — instead of asking reps to navigate to Customer Quotes and edit
 * each row, they can clear the queue right here.
 *
 * Calls the same `/api/customer-quotes/list` endpoint with
 * `outcomeStatus=pending`; mutations hit POST `/quote/:id/mark-outcome`.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Trophy, XCircle, Clock, AlertCircle } from "lucide-react";
import type { FunnelFilters } from "./FreightCaptureFunnel";

type Row = {
  id: string;
  customerName: string;
  repName: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  quotedAmount: string | number | null;
  requestDate: string;
};

type ListResponse = {
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
};

interface Props {
  filters: FunnelFilters;
  /** Cap rows shown — keeps the page scannable while remaining a useful
   *  in-page action surface. */
  limit?: number;
}

const DEFAULT_LIMIT = 15;

// Lost-reason labels mirror the QuoteOutcomeStatus enum. Manual_won doesn't
// take a reason; manual_lost statuses are mapped to canonical reason rows
// server-side (markQuoteOutcome → CANONICAL_LOST_REASON_BY_STATUS), so the
// quick list can send `outcomeReasonId: null` and still land on a real
// reason — keeps the "Why we lose" breakdown honest. The status itself is
// the canonical bucket; the reason text is just a label.
const LOST_REASONS: Array<{ value: "lost_price" | "lost_service" | "lost_timing" | "lost_incumbent"; label: string }> = [
  { value: "lost_price", label: "Lost — price" },
  { value: "lost_service", label: "Lost — service" },
  { value: "lost_timing", label: "Lost — timing" },
  { value: "lost_incumbent", label: "Lost — incumbent" },
];

function buildQs(f: FunnelFilters, extra: Record<string, string | number>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

function fmtMoney(v: string | number | null): string {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtAge(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const ageMs = Date.now() - d.getTime();
  const days = Math.floor(ageMs / (24 * 3600 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ageMs / (3600 * 1000));
  return `${hours}h`;
}

export function PendingQuotesQuickList({ filters, limit = DEFAULT_LIMIT }: Props): JSX.Element {
  const queryKey = useMemo(
    () => ["/api/customer-quotes/list", "pending-quick-list", filters, limit] as const,
    [filters, limit],
  );

  const { data, isLoading, isError, error } = useQuery<ListResponse>({
    queryKey,
    queryFn: async () => {
      const qs = buildQs(filters, {
        outcomeStatus: "pending",
        sortKey: "requestDate",
        sortDir: "desc",
        offset: 0,
        limit,
      });
      const res = await fetch(`/api/customer-quotes/list?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Quote list request failed (${res.status})`);
      return res.json() as Promise<ListResponse>;
    },
    staleTime: 30_000,
  });

  return (
    <Card data-testid="pending-quotes-quick-list">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            Pending quotes
            {data && (
              <Badge variant="outline" className="text-[10px] tabular-nums" data-testid="pending-quotes-count">
                {data.total}
              </Badge>
            )}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">Resolve as Won / Lost so the funnel can move on.</p>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2" data-testid="pending-quotes-loading">
            <Skeleton className="h-8 w-full bg-card" />
            <Skeleton className="h-8 w-full bg-card" />
            <Skeleton className="h-8 w-full bg-card" />
          </div>
        )}
        {isError && (
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs" data-testid="pending-quotes-error">
            <AlertCircle className="h-4 w-4" />
            <span>Could not load pending quotes: {error instanceof Error ? error.message : "Unknown error"}</span>
          </div>
        )}
        {data && data.rows.length === 0 && (
          <div className="text-xs text-muted-foreground py-6 text-center" data-testid="pending-quotes-empty">
            No pending quotes in this slice — everything has a verdict.
          </div>
        )}
        {data && data.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="pending-quotes-table">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2 font-medium">Customer</th>
                  <th className="py-1.5 px-1 font-medium">Lane</th>
                  <th className="py-1.5 px-1 font-medium">Mode</th>
                  <th className="py-1.5 px-1 text-right font-medium">Quoted</th>
                  <th className="py-1.5 px-1 text-right font-medium">Age</th>
                  <th className="py-1.5 px-1 font-medium">Rep</th>
                  <th className="py-1.5 pl-1 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <PendingRow key={r.id} row={r} listQueryKey={queryKey} />
                ))}
              </tbody>
            </table>
            {data.total > data.rows.length && (
              <p className="text-[11px] text-muted-foreground mt-2" data-testid="pending-quotes-truncated">
                Showing the {data.rows.length} most recent of {data.total} pending — narrow the filters to see more.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PendingRowProps {
  row: Row;
  listQueryKey: readonly unknown[];
}
function PendingRow({ row, listQueryKey }: PendingRowProps): JSX.Element {
  const { toast } = useToast();
  const [pickingLost, setPickingLost] = useState<boolean>(false);

  const markMutation = useMutation({
    mutationFn: async (body: { outcomeStatus: string; outcomeReasonId?: string | null }) => {
      const res = await apiRequest("POST", `/api/customer-quotes/quote/${row.id}/mark-outcome`, body);
      return (await res.json()) as { status: string; outcomeStatus?: string };
    },
    onSuccess: (result) => {
      const verb = result.status === "already_terminal" ? "was already resolved" : "marked";
      toast({ title: `Quote ${verb}`, description: `${row.customerName} · ${row.originCity} → ${row.destCity}` });
      // Refresh the list (this row will fall out) and the funnel + diagnostics.
      void queryClient.invalidateQueries({ queryKey: listQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/funnel-diagnostics"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      setPickingLost(false);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to mark outcome";
      toast({ title: "Could not save", description: msg, variant: "destructive" });
    },
  });

  return (
    <tr
      className="border-b border-border/60 last:border-0 hover-elevate"
      data-testid={`pending-quote-row-${row.id}`}
    >
      <td className="py-1.5 pr-2 truncate max-w-[160px] text-foreground" data-testid={`pending-quote-customer-${row.id}`}>
        {row.customerName}
      </td>
      <td className="py-1.5 px-1 truncate max-w-[180px] text-muted-foreground">
        {row.originCity}, {row.originState} → {row.destCity}, {row.destState}
      </td>
      <td className="py-1.5 px-1 text-muted-foreground">{row.equipment}</td>
      <td className="py-1.5 px-1 text-right tabular-nums text-foreground">{fmtMoney(row.quotedAmount)}</td>
      <td className="py-1.5 px-1 text-right tabular-nums text-muted-foreground">{fmtAge(row.requestDate)}</td>
      <td className="py-1.5 px-1 truncate max-w-[120px] text-muted-foreground">{row.repName}</td>
      <td className="py-1.5 pl-1">
        {pickingLost ? (
          <div className="flex items-center gap-1">
            <Select onValueChange={(v) => markMutation.mutate({ outcomeStatus: v, outcomeReasonId: null })}>
              <SelectTrigger className="h-7 w-[150px] text-xs bg-card border-border" data-testid={`pending-quote-lost-select-${row.id}`}>
                <SelectValue placeholder="Pick reason..." />
              </SelectTrigger>
              <SelectContent>
                {LOST_REASONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
                <SelectItem value="no_response">No response</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setPickingLost(false)}
              data-testid={`pending-quote-cancel-lost-${row.id}`}
              disabled={markMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => markMutation.mutate({ outcomeStatus: "won" })}
              disabled={markMutation.isPending}
              data-testid={`pending-quote-mark-won-${row.id}`}
            >
              <Trophy className="h-3 w-3 mr-1 text-emerald-600" /> Won
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setPickingLost(true)}
              disabled={markMutation.isPending}
              data-testid={`pending-quote-mark-lost-${row.id}`}
            >
              <XCircle className="h-3 w-3 mr-1 text-rose-600" /> Lost…
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}
