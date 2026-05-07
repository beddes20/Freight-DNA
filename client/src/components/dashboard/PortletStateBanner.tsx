// Phase 1.5 S6 — Shared dashboard portlet state banner.
//
// Used in place of the legacy `return null` empty-render when an upstream
// freshness signal indicates the empty list cannot be trusted as truly
// empty. Renders an amber "degraded" treatment for stale upstreams and a
// neutral grey "unknown" treatment for unverifiable freshness — never
// escalating unknown to amber (Task #1109a).
import { AlertTriangle, HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface PortletStateBannerProps {
  state: "stale" | "unknown";
  title: string;
  body: string;
  /** Optional ISO-8601 timestamp from freshness.lastUpdatedAt. */
  lastUpdatedAt?: string | null;
  /** Optional job/source label from freshness.source. */
  source?: string | null;
  /** Stable testid prefix so portlet specs can target the right banner. */
  testIdPrefix: string;
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const ageMs = Date.now() - then;
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function PortletStateBanner({
  state,
  title,
  body,
  lastUpdatedAt,
  source,
  testIdPrefix,
}: PortletStateBannerProps) {
  const isStale = state === "stale";
  const Icon = isStale ? AlertTriangle : HelpCircle;
  const tone = isStale
    ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
    : "bg-muted/40 border-border text-muted-foreground";

  return (
    <Card data-testid={`${testIdPrefix}-banner`} data-portlet-state={state}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon className={`w-4 h-4 ${isStale ? "text-amber-400" : "text-muted-foreground"}`} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`rounded-md border px-3 py-2 text-xs ${tone}`}>
          <p data-testid={`${testIdPrefix}-banner-body`}>{body}</p>
          {(lastUpdatedAt || source) && (
            <p
              className="mt-1 text-[11px] opacity-75"
              data-testid={`${testIdPrefix}-banner-meta`}
            >
              {lastUpdatedAt && <>Last refresh: {formatRelative(lastUpdatedAt)}</>}
              {lastUpdatedAt && source && <span> · </span>}
              {source && <>Source: {source}</>}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
