/**
 * AttachLeakToQuoteDialog — Phase 4.
 *
 * Picker dialog for the Capture Leak Queue's Orphan Outbound rows.
 * Lists candidate quote_opportunities scoped to the leak row's linked
 * customer (default: open quotes; toggle: recent terminal quotes within
 * the last 14d), with a small substring search to narrow long lists.
 *
 * Server contract — see `/api/customer-quotes/funnel-diagnostics/leaks/
 * attach-candidates` and `…/leaks/attach`. The picker scope mirrors the
 * server-side rule: when the row has no `linkedAccountId`, no candidates
 * are returned and the dialog explains why.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Search, Link2, AlertTriangle } from "lucide-react";

interface AttachCandidateQuote {
  quoteId: string;
  customerId: string;
  customerName: string;
  lane: string;
  equipment: string;
  outcomeStatus: string;
  requestDate: string;
  quotedAmount: string | null;
}

interface ListAttachCandidatesResult {
  customerScoped: boolean;
  customerId: string | null;
  customerName: string | null;
  scope: "open" | "closed";
  quotes: AttachCandidateQuote[];
}

export type AttachStatus =
  | "attached"
  | "already_attached"
  | "not_a_leak"
  | "not_found"
  | "wrong_leak_type"
  | "invalid_quote";

interface AttachResponse {
  status: AttachStatus;
  quoteId?: string;
}

interface Props {
  open: boolean;
  messageId: string | null;
  /** Display only — used in the dialog header so the rep knows what
   *  outbound email they're attaching. */
  rowSubject: string | null;
  customerNameHint: string | null;
  onOpenChange: (open: boolean) => void;
  /** Fired with the attach result so the parent can invalidate caches,
   *  toast, and update the live-region announcement. */
  onAttached: (result: AttachResponse) => void;
}

function fmtCurrency(amount: string | null): string {
  if (!amount) return "—";
  const n = parseFloat(amount);
  if (Number.isNaN(n)) return amount;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

function statusChipClass(status: string): string {
  switch (status) {
    case "pending":  return "border-amber-500/40 text-amber-700 dark:text-amber-300";
    case "quoted":   return "border-sky-500/40 text-sky-700 dark:text-sky-300";
    case "won":      return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300";
    case "won_low_margin": return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300";
    default:         return "border-rose-500/40 text-rose-700 dark:text-rose-300";
  }
}

export function AttachLeakToQuoteDialog({
  open, messageId, rowSubject, customerNameHint, onOpenChange, onAttached,
}: Props): JSX.Element {
  const [closed, setClosed] = useState(false);
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { toast } = useToast();

  const { data, isLoading, isError, error } = useQuery<ListAttachCandidatesResult>({
    // Include closed + q in the queryKey so toggling either refetches
    // without colliding cache entries between dialog opens for different
    // messageIds.
    queryKey: [
      "/api/customer-quotes/funnel-diagnostics/leaks/attach-candidates",
      messageId,
      closed,
      q,
    ] as const,
    enabled: !!messageId && open,
    queryFn: async () => {
      const params = new URLSearchParams({ messageId: messageId! });
      if (closed) params.set("closed", "true");
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(
        `/api/customer-quotes/funnel-diagnostics/leaks/attach-candidates?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Attach candidates request failed (${res.status})`);
      return res.json() as Promise<ListAttachCandidatesResult>;
    },
    staleTime: 30_000,
  });

  const attachMutation = useMutation({
    mutationFn: async (input: { messageId: string; targetQuoteId: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/funnel-diagnostics/leaks/attach",
        input,
      );
      return (await res.json()) as AttachResponse;
    },
    onSuccess: (result) => {
      onAttached(result);
      onOpenChange(false);
      // Reset transient state so a future open of the dialog starts fresh.
      setSelectedId(null);
      setQ("");
      setClosed(false);
    },
    onError: (err) => {
      toast({
        title: "Could not attach to quote",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  function handleAttach(): void {
    if (!messageId || !selectedId) return;
    attachMutation.mutate({ messageId, targetQuoteId: selectedId });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      onOpenChange(next);
      if (!next) {
        setSelectedId(null);
        setQ("");
        setClosed(false);
      }
    }}>
      <DialogContent
        className="sm:max-w-[640px] max-h-[80vh] flex flex-col"
        data-testid="attach-leak-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4" />
            Attach this email to an existing quote
          </DialogTitle>
          <DialogDescription className="text-xs">
            {rowSubject ? (
              <>
                <span className="text-foreground font-medium">{rowSubject}</span>
                {customerNameHint ? <> · {customerNameHint}</> : null}
              </>
            ) : (
              "Pick the quote this outbound message belongs to."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              placeholder="Filter by lane, equipment, notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 pl-7 text-xs"
              data-testid="attach-leak-search"
            />
          </div>
          <div className="inline-flex items-center gap-1 text-[10px] rounded border border-border p-0.5">
            <button
              type="button"
              onClick={() => setClosed(false)}
              className={`px-2 py-0.5 rounded ${
                !closed ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="attach-leak-toggle-open"
            >
              Open
            </button>
            <button
              type="button"
              onClick={() => setClosed(true)}
              className={`px-2 py-0.5 rounded ${
                closed ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="attach-leak-toggle-closed"
            >
              Recent terminal · 14d
            </button>
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto rounded border border-border"
          data-testid="attach-leak-list-scroll"
        >
          {isLoading && (
            <div className="p-3 space-y-2" data-testid="attach-leak-loading">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full bg-muted/40" />)}
            </div>
          )}

          {isError && (
            <div
              className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs p-3"
              data-testid="attach-leak-error"
            >
              <AlertTriangle className="h-4 w-4" />
              <span>Could not load candidate quotes: {error instanceof Error ? error.message : "Unknown error"}</span>
            </div>
          )}

          {data && !data.customerScoped && (
            <div
              className="flex flex-col items-center text-center gap-2 p-6"
              data-testid="attach-leak-no-customer"
            >
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <div className="text-xs font-medium text-foreground">No linked customer on this row</div>
              <div className="text-[11px] text-muted-foreground max-w-[40ch]">
                We can only suggest quotes when the email is linked to a known
                customer. Open the thread to triage manually, or mark the row
                as not a quote.
              </div>
            </div>
          )}

          {data && data.customerScoped && data.quotes.length === 0 && (
            <div
              className="flex flex-col items-center text-center gap-2 p-6"
              data-testid="attach-leak-empty"
            >
              <div className="text-xs font-medium text-foreground">
                No {closed ? "recent terminal" : "open"} quotes for {data.customerName ?? "this customer"}
              </div>
              {!closed && (
                <button
                  type="button"
                  onClick={() => setClosed(true)}
                  className="text-[11px] text-foreground underline"
                  data-testid="attach-leak-empty-toggle-closed"
                >
                  Try recent terminal quotes
                </button>
              )}
            </div>
          )}

          {data && data.customerScoped && data.quotes.length > 0 && (
            <ul role="radiogroup" aria-label="Attach candidate quotes" data-testid="attach-leak-list">
              {data.quotes.map((qrow) => {
                const isSelected = selectedId === qrow.quoteId;
                return (
                  <li
                    key={qrow.quoteId}
                    className={`border-b border-border/60 last:border-0 ${
                      isSelected ? "bg-amber-500/5 dark:bg-amber-500/10" : ""
                    }`}
                  >
                    <label
                      className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                      data-testid={`attach-leak-option-${qrow.quoteId}`}
                    >
                      <input
                        type="radio"
                        name="attach-target"
                        value={qrow.quoteId}
                        checked={isSelected}
                        onChange={() => setSelectedId(qrow.quoteId)}
                        className="h-3 w-3 accent-amber-500"
                        data-testid={`attach-leak-radio-${qrow.quoteId}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium text-foreground truncate" title={qrow.lane}>
                            {qrow.lane}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-medium ${statusChipClass(qrow.outcomeStatus)}`}
                          >
                            {qrow.outcomeStatus}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {qrow.equipment} · {fmtCurrency(qrow.quotedAmount)} · req {fmtDate(qrow.requestDate)}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="mt-2 flex items-center sm:justify-between gap-2">
          <span className="text-[10px] text-muted-foreground" data-testid="attach-leak-footer-meta">
            {data && data.customerScoped
              ? `${data.quotes.length} ${closed ? "terminal" : "open"} quote${data.quotes.length === 1 ? "" : "s"}${data.customerName ? ` for ${data.customerName}` : ""}`
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="attach-leak-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleAttach}
              disabled={!selectedId || attachMutation.isPending}
              data-testid="attach-leak-confirm"
            >
              {attachMutation.isPending ? "Attaching…" : "Attach to quote"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
