// Cross-tab UX (option E) — unified Lane Inbox feed.
//
// Passive read-only stream of recent events from Available Freight, Lane
// Work Queue, Customer Quotes, and Carrier Hub. Each row deep-links back
// to the source surface. Live updates piggyback on the SSE hook from
// option A — when the global `useLiveSync` invalidates a topic key, this
// page also invalidates its own list so new events appear without refresh.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBanner } from "@/components/ui/error-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { CrossTabBreadcrumb, appendCrossTabFromParam } from "@/components/freight/cross-tab-breadcrumb";
import {
  Inbox,
  Truck,
  ListFilter,
  FileBarChart2,
  Package,
  ExternalLink,
} from "lucide-react";

type Surface =
  | "available_freight"
  | "lane_work_queue"
  | "customer_quotes"
  | "carrier_hub";

interface LaneInboxRow {
  id: string;
  surface: Surface;
  kind: string;
  title: string;
  subtitle: string;
  occurredAt: string;
  deepLink: string;
  lane: string | null;
  refId: string | null;
}

interface LaneInboxResponse {
  rows: LaneInboxRow[];
  scope: string;
  surface: Surface | null;
}

const SURFACE_META: Record<Surface, { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  available_freight: { label: "Available Freight", icon: Package, tone: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30" },
  lane_work_queue: { label: "Lane Work Queue", icon: ListFilter, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  customer_quotes: { label: "Customer Quotes", icon: FileBarChart2, tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  carrier_hub: { label: "Carrier Hub", icon: Truck, tone: "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30" },
};

const SURFACE_ORDER: Array<Surface | "all"> = [
  "all",
  "available_freight",
  "lane_work_queue",
  "customer_quotes",
  "carrier_hub",
];

const SCOPE_OPTIONS: Array<{ value: "all" | "mine"; label: string }> = [
  { value: "all", label: "All org" },
  { value: "mine", label: "Mine" },
];

const formatRelative = (iso: string): string => {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMs = Date.now() - ts;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
};

export default function LaneInboxPage() {
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [surface, setSurface] = useState<Surface | "all">("all");

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (scope === "mine") params.set("scope", "mine");
    if (surface !== "all") params.set("surface", surface);
    return params.toString();
  }, [scope, surface]);

  const { data, isLoading, isError, refetch } = useQuery<LaneInboxResponse>({
    // The query key is split so the global useLiveSync hook can invalidate
    // by prefix (`["/api/lane-inbox"]`) and refetch with whatever filters
    // are currently active.
    queryKey: ["/api/lane-inbox", queryString],
    queryFn: async () => {
      const url = queryString ? `/api/lane-inbox?${queryString}` : "/api/lane-inbox";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    // Background refetch every 30s as a fallback in case an SSE event is
    // dropped — the inbox is the one place where stale data is most jarring.
    refetchInterval: 30_000,
  });

  const rows = data?.rows ?? [];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4" data-testid="page-lane-inbox">
      <CrossTabBreadcrumb current="lane-inbox" />
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Inbox className="h-6 w-6" />
            Lane Inbox
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recent activity across Available Freight, Lane Work Queue, Customer Quotes, and Carrier Hub.
          </p>
        </div>
      </div>

      {/* Filter chip rows */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Scope</span>
          {SCOPE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={scope === opt.value ? "default" : "outline"}
              onClick={() => setScope(opt.value)}
              data-testid={`button-scope-${opt.value}`}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Surface</span>
          {SURFACE_ORDER.map((s) => {
            const isAll = s === "all";
            const label = isAll ? "All" : SURFACE_META[s].label;
            const Icon = isAll ? Inbox : SURFACE_META[s].icon;
            return (
              <Button
                key={s}
                size="sm"
                variant={surface === s ? "default" : "outline"}
                onClick={() => setSurface(s)}
                data-testid={`button-surface-${s}`}
                className="gap-1.5"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Feed */}
      <div className="space-y-2">
        {isLoading && (
          <>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </>
        )}
        {isError && (
          <ErrorBanner
            message="We couldn't load the lane inbox. This is usually temporary — try again."
            onRetry={() => refetch()}
          />
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Inbox}
                title="No lane activity yet"
                description="No events match the current filters. Try a different surface chip or check back after teammates take action."
                testId="empty-lane-inbox"
              />
            </CardContent>
          </Card>
        )}
        {rows.map((row) => {
          const meta = SURFACE_META[row.surface];
          const Icon = meta.icon;
          return (
            <Tooltip key={row.id}>
              <TooltipTrigger asChild>
                <Link href={appendCrossTabFromParam(row.deepLink, "lane-inbox", typeof window !== "undefined" ? window.location.search : "")}>
                  <Card
                    className="hover-elevate active-elevate-2 cursor-pointer transition-colors"
                    data-testid={`row-inbox-${row.id}`}
                  >
                    <CardContent className="p-3 flex items-start gap-3">
                      <div className={`shrink-0 rounded-md border p-2 ${meta.tone}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate" data-testid={`text-title-${row.id}`}>
                            {row.title}
                          </span>
                          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                            {row.kind.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {row.subtitle}
                        </div>
                      </div>
                      <div className="shrink-0 text-xs text-muted-foreground flex items-center gap-1">
                        <span data-testid={`text-time-${row.id}`}>{formatRelative(row.occurredAt)}</span>
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-xs space-y-1">
                <div className="text-xs font-semibold">{meta.label}</div>
                {row.lane && <div className="text-xs">Lane: {row.lane}</div>}
                <div className="text-xs">Event: {row.kind.replace(/_/g, " ")}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(row.occurredAt).toLocaleString()}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
