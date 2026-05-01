/**
 * QuoteFreshnessStrip — trust-visibility line above the Quote Requests KPIs.
 *
 * Renders a single muted-text line that answers "how stale is this page?"
 * Always visible; never a banner, never a modal. Two parts:
 *
 *   1. Last capture run: 9:42 AM (2 min ago)         ← always shown
 *   2. · 47 emails still being processed             ← only when material
 *
 * Triggered by the May 2026 trust regression where the page legitimately
 * showed 0 open / 0 auto-captured during the morning back-load window
 * (first quote_opportunity for the day was created at 13:40 UTC even
 * though inbound emails had been arriving since midnight). The strip
 * doesn't fix the lag — it makes the lag honest.
 *
 * Backed by GET /api/customer-quotes/freshness. Polls every 60s,
 * matching the snapshot KPI cadence.
 */
import { useQuery } from "@tanstack/react-query";
import { Clock, Loader2 } from "lucide-react";

type FreshnessResponse = {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lagSeconds: number | null;
  inboundToday: number;
  oppsToday: number;
  processingHint: { show: boolean; pendingCount: number };
};

function formatRelative(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return `${m} min ago`;
  }
  const h = Math.round(seconds / 3600);
  return `${h} hr ago`;
}

function formatLocalTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function QuoteFreshnessStrip() {
  const query = useQuery<FreshnessResponse>({
    queryKey: ["/api/customer-quotes/freshness"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/freshness", { credentials: "include" });
      if (!res.ok) throw new Error("freshness fetch failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (query.isLoading) {
    return (
      <div
        className="px-6 py-1.5 text-xs text-muted-foreground bg-muted/10 border-b border-border flex items-center gap-1.5 shrink-0"
        data-testid="strip-quote-freshness-loading"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking capture freshness…
      </div>
    );
  }

  // Failure mode: keep the strip silent rather than scaring the rep with a
  // red banner. The KPI tiles below still render, and snapshot errors have
  // their own ErrorBanner above. Quietly logging is enough.
  if (query.isError || !query.data) {
    if (query.isError) {
      console.warn("[freshness] strip hidden:", (query.error as Error)?.message);
    }
    return null;
  }

  const { lastRunAt, lagSeconds, processingHint } = query.data;

  return (
    <div
      className="px-6 py-1.5 text-xs text-muted-foreground bg-muted/10 border-b border-border flex items-center gap-1.5 shrink-0"
      data-testid="strip-quote-freshness"
    >
      <Clock className="h-3 w-3" />
      <span data-testid="text-freshness-last-run">
        {lastRunAt ? (
          <>Last capture run: {formatLocalTime(lastRunAt)} · {formatRelative(lagSeconds)}</>
        ) : (
          <>Capture run not recorded yet today</>
        )}
      </span>
      {processingHint.show ? (
        <span data-testid="text-freshness-processing-hint">
          · {processingHint.pendingCount} emails still being processed
        </span>
      ) : null}
    </div>
  );
}
