/**
 * Customer Quotes #2 — Action Queue card.
 *
 * Top-of-page collapsible card that shows the categories of work a rep
 * should action right now: SLA-breaching and Expiring-Today. Each list
 * is capped server-side at 5 rows. Clicking a row opens the existing
 * QuoteDetailDrawer in the parent page.
 *
 * Task #615 — the historical "Needs review" column has been retired
 * along with the rest of the unknown-customer surface area; that
 * triage workflow now lives outside the customer-only Quote
 * Opportunities feed.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ChevronDown, ChevronUp, Clock, Hourglass } from "lucide-react";
import { computeQuoteSla, formatSlaBadge } from "@shared/quoteSla";

// localStorage key for the collapsed/expanded preference. Default is
// expanded so existing users see no behavior change on first load.
const OPEN_LS_KEY = "cq.actionQueue.open";

function readOpenPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(OPEN_LS_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeOpenPref(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPEN_LS_KEY, open ? "1" : "0");
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

type QueueRow = {
  id: string;
  customerName: string;
  originCity: string; originState: string;
  destCity: string; destState: string;
  equipment: string;
  requestDate: string;
  validThrough: string | null;
  outcomeStatus: string;
  slaState: "ok" | "warning" | "breached" | "na";
};

type ActionQueueResponse = {
  slaBreaching: QueueRow[];
  expiringToday: QueueRow[];
};

interface Props {
  onOpenQuote: (id: string) => void;
}

export function ActionQueueCard({ onOpenQuote }: Props): JSX.Element | null {
  const [open, setOpen] = useState<boolean>(() => readOpenPref());
  useEffect(() => { writeOpenPref(open); }, [open]);
  // Gate the network call on the user-controlled collapse state — when
  // the section is collapsed we pause both the initial fetch and the
  // 60s polling so reps who never expand the queue pay no cost.
  const { data, isLoading } = useQuery<ActionQueueResponse>({
    queryKey: ["/api/customer-quotes/action-queue"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/action-queue?limit=5", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load action queue");
      return res.json() as Promise<ActionQueueResponse>;
    },
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  const slaCount = data?.slaBreaching.length ?? 0;
  const expiringCount = data?.expiringToday.length ?? 0;
  const total = slaCount + expiringCount;

  // Hide entirely only when EXPANDED, fetched, and empty — keeps the
  // dashboard tidy without trapping the user. When the card is
  // collapsed (`!open`) the network query is paused, so `total` is 0
  // by definition; we must still render the header/toggle so the
  // user can re-expand. Without this guard the early-return removes
  // the toggle and the localStorage-persisted collapsed state
  // becomes a permanent hidden state across sessions.
  if (open && !isLoading && total === 0) return null;

  return (
    <Card className="bg-card border-border" data-testid="action-queue-card">
      <CardHeader className="py-2.5 px-4 flex flex-row items-center justify-between">
        <CardTitle className="text-sm text-foreground flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Action Queue
          {total > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5" data-testid="badge-action-queue-total">
              {total}
            </Badge>
          )}
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setOpen(o => !o)}
          aria-label={open ? "Collapse action queue" : "Expand action queue"}
          aria-expanded={open}
          aria-controls="action-queue-body"
          data-testid="button-action-queue-toggle"
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </CardHeader>
      {open && (
        <CardContent id="action-queue-body" className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <ActionSection
            title="SLA breaching"
            icon={<Clock className="h-3.5 w-3.5 text-red-500" />}
            tone="red"
            rows={data?.slaBreaching ?? []}
            isLoading={isLoading}
            onOpenQuote={onOpenQuote}
            testIdRoot="sla-breaching"
            empty="No SLA breaches."
          />
          <ActionSection
            title="Expiring today"
            icon={<Hourglass className="h-3.5 w-3.5 text-blue-500" />}
            tone="blue"
            rows={data?.expiringToday ?? []}
            isLoading={isLoading}
            onOpenQuote={onOpenQuote}
            testIdRoot="expiring-today"
            empty="None expiring today."
          />
        </CardContent>
      )}
    </Card>
  );
}

function ActionSection({
  title, icon, tone, rows, isLoading, onOpenQuote, testIdRoot, empty,
}: {
  title: string;
  icon: JSX.Element;
  tone: "red" | "amber" | "blue";
  rows: QueueRow[];
  isLoading: boolean;
  onOpenQuote: (id: string) => void;
  testIdRoot: string;
  empty: string;
}): JSX.Element {
  const headerToneClass = {
    red: "text-red-700 dark:text-red-300",
    amber: "text-amber-700 dark:text-amber-300",
    blue: "text-blue-700 dark:text-blue-300",
  }[tone];

  return (
    <div data-testid={`section-${testIdRoot}`}>
      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium ${headerToneClass} mb-2`}>
        {icon}
        {title}
        <span className="ml-auto text-muted-foreground tabular-nums" data-testid={`count-${testIdRoot}`}>
          {rows.length}
        </span>
      </div>
      {isLoading && rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">{empty}</div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(r => (
            <li key={r.id}>
              <div className="rounded-md border border-border/60 bg-muted/30 hover:bg-muted/60 px-2 py-1.5 transition-colors">
                <button
                  type="button"
                  onClick={() => onOpenQuote(r.id)}
                  className="w-full text-left"
                  data-testid={`row-${testIdRoot}-${r.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground truncate">{r.customerName}</span>
                    <SlaBadge requestDate={r.requestDate} status={r.outcomeStatus} testId={`sla-${testIdRoot}-${r.id}`} />
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {r.originCity}, {r.originState} → {r.destCity}, {r.destState}
                    <span className="ml-1.5 uppercase">{r.equipment}</span>
                  </div>
                </button>
                {/* Task #969 — "Why this rep?" trigger so reps in the
                    action queue can audit attribution without first
                    opening the detail drawer. Dispatches the same
                    page-level CustomEvent the table-cell trigger uses
                    so a single AttributionDrawer instance handles all
                    open requests. Stops propagation so a click on the
                    link doesn't double-fire onOpenQuote. */}
                <button
                  type="button"
                  className="mt-1 text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  title="Why was this rep assigned?"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (typeof window === "undefined") return;
                    window.dispatchEvent(
                      new CustomEvent("customer-quotes:show-attribution", { detail: { quoteId: r.id } }),
                    );
                  }}
                  data-testid={`button-why-rep-action-queue-${r.id}`}
                >
                  why this rep?
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SlaBadge({ requestDate, status, testId }: {
  requestDate: string; status: string; testId: string;
}): JSX.Element | null {
  // Recompute on the client so the badge ticks even between refetches.
  const sla = computeQuoteSla(requestDate, status);
  if (sla.state === "na") return null;
  const tone = sla.state === "breached"
    ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
    : sla.state === "warning"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-medium border rounded px-1 py-0.5 tabular-nums ${tone}`}
      data-testid={testId}
    >
      <Clock className="h-2.5 w-2.5" />
      {formatSlaBadge(sla)}
    </span>
  );
}
