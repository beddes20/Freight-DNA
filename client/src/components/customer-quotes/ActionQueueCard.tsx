/**
 * Customer Quotes #2 — Action Queue card.
 *
 * Top-of-page collapsible card that shows the three categories of work
 * a rep should action right now: SLA-breaching, Needs-Review (unknown
 * customer bucket), and Expiring-Today. Each list is capped server-side
 * at 5 rows. Clicking a row opens the existing QuoteDetailDrawer in the
 * parent page.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ChevronDown, ChevronUp, Clock, UserSearch, Hourglass } from "lucide-react";
import { computeQuoteSla, formatSlaBadge } from "@shared/quoteSla";

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
  needsReview: QueueRow[];
  expiringToday: QueueRow[];
};

interface Props {
  onOpenQuote: (id: string) => void;
}

export function ActionQueueCard({ onOpenQuote }: Props): JSX.Element | null {
  const [open, setOpen] = useState(true);
  const { data, isLoading } = useQuery<ActionQueueResponse>({
    queryKey: ["/api/customer-quotes/action-queue"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/action-queue?limit=5", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load action queue");
      return res.json() as Promise<ActionQueueResponse>;
    },
    refetchInterval: 60_000,
  });

  const slaCount = data?.slaBreaching.length ?? 0;
  const needsCount = data?.needsReview.length ?? 0;
  const expiringCount = data?.expiringToday.length ?? 0;
  const total = slaCount + needsCount + expiringCount;

  // Hide entirely when there's nothing to do — keeps the dashboard tidy.
  if (!isLoading && total === 0) return null;

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
          data-testid="button-action-queue-toggle"
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="px-4 pb-4 grid grid-cols-1 md:grid-cols-3 gap-4">
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
            title="Needs review"
            icon={<UserSearch className="h-3.5 w-3.5 text-amber-500" />}
            tone="amber"
            rows={data?.needsReview ?? []}
            isLoading={isLoading}
            onOpenQuote={onOpenQuote}
            testIdRoot="needs-review"
            empty="No unclassified rows."
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
              <button
                onClick={() => onOpenQuote(r.id)}
                className="w-full text-left rounded-md border border-border/60 bg-muted/30 hover:bg-muted/60 px-2 py-1.5 transition-colors"
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
