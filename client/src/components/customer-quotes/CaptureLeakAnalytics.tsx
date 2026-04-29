/**
 * Capture Leak Analytics — Phase 3.
 *
 * Lightweight analytics strip rendered above the CaptureLeakQueue inside
 * FreightCaptureDiagnostics. Reads the new admin-gated endpoint
 * `/api/customer-quotes/funnel-diagnostics/leaks/analytics` and renders:
 *
 *   • 4 KPI tiles — 7d resolved · 30d resolved · 30d via-create · oldest unresolved
 *   • Resolution mix bar (toggle 7d / 30d) — Not a quote · Ignored · Created quote
 *   • Aging buckets — two horizontal stacked bars (missed inbound / orphan outbound)
 *   • 30-day discovered-vs-resolved sparkline (inline SVG, two areas)
 *
 * No charts library — small CSS/SVG keeps the bundle slim. Read-only.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, BarChart3, Clock, Plus, X, Inbox, Send } from "lucide-react";

interface ResolutionMix {
  notQuote: number;
  ignored: number;
  createdQuote: number;
  /** Phase 4 — orphan_outbound rows manually attached to an existing quote. */
  attached: number;
  total: number;
}
interface AgingBuckets {
  lt1d: number;
  d1to3: number;
  d3to7: number;
  d7to14: number;
  gt14: number;
  total: number;
  oldestSentAt: string | null;
}
interface TrendPoint { date: string; discovered: number; resolved: number; }
interface AnalyticsResponse {
  agingWindowDays: number;
  trendWindowDays: number;
  generatedAt: string;
  resolutionMix: { sevenDay: ResolutionMix; thirtyDay: ResolutionMix };
  aging: { missedInbound: AgingBuckets; orphanOutbound: AgingBuckets };
  trend: TrendPoint[];
}

interface Props {
  enabled: boolean;
}

function fmtRelDays(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / (24 * 3600 * 1000));
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function MixBar({ mix }: { mix: ResolutionMix }): JSX.Element {
  const total = Math.max(mix.total, 1);
  const seg = (n: number) => `${(n / total) * 100}%`;
  if (mix.total === 0) {
    return (
      <div className="h-2 rounded-full bg-muted/60" data-testid="leak-analytics-mix-empty" />
    );
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/40" data-testid="leak-analytics-mix-bar">
      <div
        className="bg-emerald-500/80"
        style={{ width: seg(mix.createdQuote) }}
        title={`Created quote: ${mix.createdQuote}`}
        data-testid="leak-analytics-mix-created"
      />
      <div
        className="bg-sky-500/80"
        style={{ width: seg(mix.attached) }}
        title={`Attached to quote: ${mix.attached}`}
        data-testid="leak-analytics-mix-attached"
      />
      <div
        className="bg-slate-400/70 dark:bg-slate-500/70"
        style={{ width: seg(mix.notQuote) }}
        title={`Not a quote: ${mix.notQuote}`}
        data-testid="leak-analytics-mix-notquote"
      />
      <div
        className="bg-amber-500/70"
        style={{ width: seg(mix.ignored) }}
        title={`Ignored: ${mix.ignored}`}
        data-testid="leak-analytics-mix-ignored"
      />
    </div>
  );
}

function MixLegend({ mix }: { mix: ResolutionMix }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground mt-1.5">
      <span className="inline-flex items-center gap-1" data-testid="leak-analytics-legend-created">
        <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/80" />
        Created <span className="text-foreground tabular-nums">{mix.createdQuote}</span>
      </span>
      <span className="inline-flex items-center gap-1" data-testid="leak-analytics-legend-attached">
        <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/80" />
        Attached <span className="text-foreground tabular-nums">{mix.attached}</span>
      </span>
      <span className="inline-flex items-center gap-1" data-testid="leak-analytics-legend-notquote">
        <span className="inline-block h-2 w-2 rounded-sm bg-slate-400/70 dark:bg-slate-500/70" />
        Not a quote <span className="text-foreground tabular-nums">{mix.notQuote}</span>
      </span>
      <span className="inline-flex items-center gap-1" data-testid="leak-analytics-legend-ignored">
        <span className="inline-block h-2 w-2 rounded-sm bg-amber-500/70" />
        Ignored <span className="text-foreground tabular-nums">{mix.ignored}</span>
      </span>
    </div>
  );
}

const BUCKET_LABEL: Record<keyof Omit<AgingBuckets, "total" | "oldestSentAt">, string> = {
  lt1d: "<1d",
  d1to3: "1–3d",
  d3to7: "3–7d",
  d7to14: "7–14d",
  gt14: ">14d",
};
const BUCKET_COLORS: Record<keyof Omit<AgingBuckets, "total" | "oldestSentAt">, string> = {
  lt1d: "bg-emerald-500/70",
  d1to3: "bg-emerald-400/60",
  d3to7: "bg-amber-500/70",
  d7to14: "bg-orange-500/80",
  gt14: "bg-rose-500/80",
};
const BUCKET_ORDER: Array<keyof Omit<AgingBuckets, "total" | "oldestSentAt">> = [
  "lt1d", "d1to3", "d3to7", "d7to14", "gt14",
];

function AgingRow({
  label,
  icon,
  buckets,
  testIdRoot,
}: {
  label: string;
  icon: JSX.Element;
  buckets: AgingBuckets;
  testIdRoot: string;
}): JSX.Element {
  const total = Math.max(buckets.total, 1);
  return (
    <div className="space-y-1" data-testid={`${testIdRoot}-row`}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          {icon}
          {label}
        </span>
        <span className="text-muted-foreground tabular-nums" data-testid={`${testIdRoot}-total`}>
          {buckets.total}
        </span>
      </div>
      {buckets.total === 0 ? (
        <div className="h-2 rounded-full bg-muted/40" />
      ) : (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/40">
          {BUCKET_ORDER.map(k => (
            <div
              key={k}
              className={BUCKET_COLORS[k]}
              style={{ width: `${(buckets[k] / total) * 100}%` }}
              title={`${BUCKET_LABEL[k]}: ${buckets[k]}`}
              data-testid={`${testIdRoot}-bucket-${k}`}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {BUCKET_ORDER.map(k => (
          <span key={k}>
            {BUCKET_LABEL[k]} <span className="text-foreground tabular-nums">{buckets[k]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

interface SparklineProps {
  trend: TrendPoint[];
  width?: number;
  height?: number;
}
function Sparkline({ trend, width = 320, height = 60 }: SparklineProps): JSX.Element {
  const max = useMemo(() => {
    let m = 0;
    for (const p of trend) {
      if (p.discovered > m) m = p.discovered;
      if (p.resolved > m) m = p.resolved;
    }
    return Math.max(m, 1);
  }, [trend]);

  const totalDiscovered = trend.reduce((acc, p) => acc + p.discovered, 0);
  const totalResolved = trend.reduce((acc, p) => acc + p.resolved, 0);

  if (trend.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground" data-testid="leak-analytics-trend-empty">
        No trend data.
      </div>
    );
  }

  const stepX = width / Math.max(trend.length - 1, 1);
  const yFor = (v: number) => height - (v / max) * (height - 4) - 2;

  const buildPath = (key: "discovered" | "resolved"): string => {
    return trend
      .map((p, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${yFor(p[key])}`)
      .join(" ");
  };

  const buildArea = (key: "discovered" | "resolved"): string => {
    const top = trend.map((p, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${yFor(p[key])}`).join(" ");
    return `${top} L ${(trend.length - 1) * stepX} ${height} L 0 ${height} Z`;
  };

  return (
    <div className="space-y-1" data-testid="leak-analytics-sparkline">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-amber-500/80" />
            Discovered
            <span className="text-foreground tabular-nums">{totalDiscovered}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/80" />
            Resolved
            <span className="text-foreground tabular-nums">{totalResolved}</span>
          </span>
        </span>
        <span>last 30d</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
        role="img"
        aria-label="Leaks discovered vs resolved over the last 30 days"
      >
        <path d={buildArea("discovered")} className="fill-amber-500/15" />
        <path d={buildPath("discovered")} className="stroke-amber-500/80 fill-none" strokeWidth={1.5} />
        <path d={buildArea("resolved")} className="fill-emerald-500/15" />
        <path d={buildPath("resolved")} className="stroke-emerald-500/80 fill-none" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
  icon,
  testId,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: JSX.Element;
  testId: string;
}): JSX.Element {
  return (
    <div
      className="rounded border border-border bg-card px-2.5 py-2"
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="text-lg font-semibold text-foreground tabular-nums leading-tight" data-testid={`${testId}-value`}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
      )}
    </div>
  );
}

export function CaptureLeakAnalytics({ enabled }: Props): JSX.Element | null {
  const [mixWindow, setMixWindow] = useState<"sevenDay" | "thirtyDay">("sevenDay");

  const { data, isLoading, isError, error } = useQuery<AnalyticsResponse>({
    queryKey: ["/api/customer-quotes/funnel-diagnostics/leaks/analytics"] as const,
    enabled,
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/funnel-diagnostics/leaks/analytics", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Leak analytics request failed (${res.status})`);
      return res.json() as Promise<AnalyticsResponse>;
    },
    staleTime: 60_000,
  });

  if (!enabled) return null;

  return (
    <div className="rounded border border-border bg-card mt-3" data-testid="capture-leak-analytics">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" />
          Capture leak analytics
        </div>
        <div className="text-[10px] text-muted-foreground" data-testid="leak-analytics-meta">
          {data ? `Aging · last ${data.agingWindowDays}d` : ""}
        </div>
      </div>

      <div className="px-3 py-3 space-y-4">
        {isLoading && (
          <div className="space-y-3" data-testid="leak-analytics-loading">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Skeleton className="h-14 bg-muted/50" />
              <Skeleton className="h-14 bg-muted/50" />
              <Skeleton className="h-14 bg-muted/50" />
              <Skeleton className="h-14 bg-muted/50" />
            </div>
            <Skeleton className="h-16 bg-muted/50" />
            <Skeleton className="h-20 bg-muted/50" />
          </div>
        )}

        {isError && (
          <div
            className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs"
            data-testid="leak-analytics-error"
          >
            <AlertCircle className="h-4 w-4" />
            <span>Could not load analytics: {error instanceof Error ? error.message : "Unknown error"}</span>
          </div>
        )}

        {data && (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="leak-analytics-kpis">
              <KpiTile
                label="Resolved · 7d"
                value={data.resolutionMix.sevenDay.total}
                icon={<Clock className="h-3.5 w-3.5" />}
                testId="leak-analytics-kpi-resolved-7d"
              />
              <KpiTile
                label="Resolved · 30d"
                value={data.resolutionMix.thirtyDay.total}
                icon={<Clock className="h-3.5 w-3.5" />}
                testId="leak-analytics-kpi-resolved-30d"
              />
              <KpiTile
                label="Created via leak · 30d"
                value={data.resolutionMix.thirtyDay.createdQuote}
                icon={<Plus className="h-3.5 w-3.5" />}
                testId="leak-analytics-kpi-created-30d"
              />
              <KpiTile
                label="Oldest unresolved"
                value={fmtRelDays(
                  // Pick the older of the two slice maxima.
                  pickOlder(
                    data.aging.missedInbound.oldestSentAt,
                    data.aging.orphanOutbound.oldestSentAt,
                  ),
                )}
                hint={`${data.aging.missedInbound.total + data.aging.orphanOutbound.total} unresolved`}
                icon={<X className="h-3.5 w-3.5" />}
                testId="leak-analytics-kpi-oldest"
              />
            </div>

            {/* Resolution mix */}
            <div data-testid="leak-analytics-mix">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Resolution mix
                </span>
                <div className="inline-flex items-center gap-1 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setMixWindow("sevenDay")}
                    className={`px-1.5 py-0.5 rounded ${
                      mixWindow === "sevenDay"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid="leak-analytics-mix-toggle-7d"
                  >
                    7d
                  </button>
                  <button
                    type="button"
                    onClick={() => setMixWindow("thirtyDay")}
                    className={`px-1.5 py-0.5 rounded ${
                      mixWindow === "thirtyDay"
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid="leak-analytics-mix-toggle-30d"
                  >
                    30d
                  </button>
                </div>
              </div>
              <MixBar mix={data.resolutionMix[mixWindow]} />
              <MixLegend mix={data.resolutionMix[mixWindow]} />
            </div>

            {/* Aging buckets */}
            <div className="space-y-2" data-testid="leak-analytics-aging">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Aging · current unresolved
              </span>
              <AgingRow
                label="Missed inbound"
                icon={<Inbox className="h-3 w-3" />}
                buckets={data.aging.missedInbound}
                testIdRoot="leak-analytics-aging-missed"
              />
              <AgingRow
                label="Orphan outbound"
                icon={<Send className="h-3 w-3" />}
                buckets={data.aging.orphanOutbound}
                testIdRoot="leak-analytics-aging-orphan"
              />
            </div>

            {/* Trendline */}
            <div className="space-y-1" data-testid="leak-analytics-trend">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground block">
                Discovered vs resolved
              </span>
              <Sparkline trend={data.trend} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function pickOlder(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() < new Date(b).getTime() ? a : b;
}
