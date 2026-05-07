// Task #1109 — Tiny "Updated Xh ago" + "Stale" pill rendered immediately
// above each AI-recompute card on the Company Profile. Reads from the
// shared /api/companies/:id/data-freshness payload.

import { Clock, AlertTriangle } from "lucide-react";
import {
  useCompanyDataFreshness,
  formatAgo,
  isStale,
  type FreshnessSource,
} from "@/hooks/useCompanyDataFreshness";

interface Props {
  companyId: string;
  source: FreshnessSource;
  label: string;
  testIdSuffix?: string;
}

const STALE_HINT: Record<FreshnessSource, string> = {
  nba:        "The Next Best Action engine has not recomputed in over 24h. Treat the recommendation as a stale snapshot — the underlying signals may have moved.",
  growth:     "The Growth/Momentum score has not been recomputed in over 7 days. The band shown may not reflect this account's current trajectory.",
  // Task #1109a — health freshness reads `touchpoints.date` (user-entered,
  // can be backdated). Wording reflects that this is a "last touchpoint"
  // signal rather than a job-ran-recently signal.
  health:     "The most recent logged touchpoint is over 7 days old. Note: touchpoint dates are user-entered and can be backdated.",
  financials: "Financial freight rows for this customer are over 7 days old. Performance numbers may be missing recent loads.",
};

export function FreshnessLine({ companyId, source, label, testIdSuffix }: Props) {
  const { data, isLoading, isError } = useCompanyDataFreshness(companyId);
  const id = testIdSuffix ?? source;

  const ts = data?.[source] ?? null;
  // Task #1109a — distinguish three states: loading, unavailable (fetch
  // failed → neutral grey, NOT stale), and stale (real upstream age).
  const unavailable = !isLoading && isError;
  const stale = !isLoading && !unavailable && isStale(ts, source);
  const ago = formatAgo(ts);

  return (
    <div
      className="flex items-center gap-2 text-[11px] text-muted-foreground px-3 pt-2"
      data-testid={`freshness-line-${id}`}
      data-freshness-state={isLoading ? "loading" : unavailable ? "unavailable" : stale ? "stale" : "fresh"}
    >
      <Clock className="h-3 w-3 shrink-0" />
      <span data-testid={`freshness-line-${id}-text`}>
        {isLoading
          ? `${label}: checking…`
          : unavailable
          ? `${label}: freshness unavailable`
          : ts
          ? `${label}: updated ${ago}`
          : `${label}: never recomputed`}
      </span>
      {unavailable && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium"
          title="Could not reach the freshness endpoint. This is a transient network/availability issue — it does not mean the underlying data is old."
          data-testid={`freshness-line-${id}-unavailable`}
        >
          <Clock className="h-2.5 w-2.5" />
          Unavailable
        </span>
      )}
      {stale && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium"
          title={STALE_HINT[source]}
          data-testid={`freshness-line-${id}-stale`}
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          Stale
        </span>
      )}
    </div>
  );
}
