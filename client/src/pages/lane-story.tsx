// Task #873 — Lane Story page (`/lanes/story/:laneSignature`).
//
// One home per recurring lane. The page is divided into three regions:
//   1. Header strip — lane identity, owner, lane score / health, freshness
//      and live AF count snapshot.
//   2. Timeline — chronological cross-surface event feed grouped by day,
//      filterable by surface chip. Lazy loads with a cursor.
//   3. Outcomes 30d — covers + GM, quote won/lost, outreach waves,
//      replies, distinct carriers contacted.
//
// When the signature does not map to a recurring lane in the user's org
// the API returns 404 with a `prefill` payload — we render a friendly
// "Make this recurring" CTA that deep-links into the LWQ Build Lane
// dialog (Task #653 contract).

import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBanner } from "@/components/ui/error-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { IntelligenceCardsList } from "@/components/dna-copilot/intelligence-cards-list";
import {
  ArrowLeft,
  Truck,
  ListFilter,
  FileBarChart2,
  Package,
  Route as RouteIcon,
  Calendar,
  TrendingUp,
  Users,
  MessageSquare,
  ExternalLink,
} from "lucide-react";

type Surface =
  | "available_freight"
  | "lane_work_queue"
  | "customer_quotes"
  | "carrier_hub";

interface LaneStoryHeader {
  laneSignature: string;
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyName: string | null;
  ownerName: string | null;
  laneScore: number | null;
  laneHealth: "healthy" | "warming" | "leaking" | "unknown";
  carriersContactedCount: number;
  contactableCount: number;
  liveOppCount: number;
  freshnessMinutes: number | null;
}

interface LaneStoryEvent {
  id: string;
  surface: Surface;
  kind: string;
  title: string;
  detail: string;
  occurredAt: string;
  actor: string | null;
  refId: string | null;
}

interface LaneStoryPayload {
  header: LaneStoryHeader;
  timeline: { events: LaneStoryEvent[]; nextCursor: string | null };
  outcomes30d: {
    windowStart: string;
    windowEnd: string;
    covers: { count: number; combinedGrossMargin: number };
    quotes: { won: number; lost: number };
    outreachWaves: number;
    carrierReplies: number;
    distinctCarriersContacted: number;
  };
}

interface LaneStoryNotRecurring {
  recurring: false;
  prefill: {
    originCity: string;
    originState: string;
    destCity: string;
    destState: string;
    equipment: string;
  };
}

const SURFACE_META: Record<Surface, { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  available_freight: { label: "Available Freight", icon: Package, tone: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30" },
  lane_work_queue: { label: "Lane Work Queue", icon: ListFilter, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  customer_quotes: { label: "Customer Quotes", icon: FileBarChart2, tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  carrier_hub: { label: "Carrier Hub", icon: Truck, tone: "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30" },
};

const HEALTH_TONE: Record<LaneStoryHeader["laneHealth"], string> = {
  healthy: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warming: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  leaking: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30",
  unknown: "bg-muted text-muted-foreground border-border",
};

const SURFACE_FILTERS: Array<{ value: Surface | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "available_freight", label: "AF" },
  { value: "lane_work_queue", label: "LWQ" },
  { value: "customer_quotes", label: "Quotes" },
  { value: "carrier_hub", label: "Carrier" },
];

const fmtCurrency = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const fmtFreshness = (m: number | null): string => {
  if (m === null) return "no live opps";
  if (m < 60) return `freshest ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `freshest ${h}h ago`;
  return `freshest ${Math.round(h / 24)}d ago`;
};

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
};

const dayLabel = (key: string): string => {
  if (key === "unknown") return "Unknown date";
  const d = new Date(`${key}T00:00:00Z`);
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const yest = new Date(today.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  if (key === todayKey) return "Today";
  if (key === yest) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

export default function LaneStoryPage() {
  const params = useParams<{ laneSignature: string }>();
  const signature = params.laneSignature ?? "";
  const [surfaceFilter, setSurfaceFilter] = useState<Surface | "all">("all");

  const { data, isLoading, isError, error, refetch } = useQuery<LaneStoryPayload, Error & { status?: number; payload?: LaneStoryNotRecurring }>({
    queryKey: ["/api/lanes/story", signature],
    queryFn: async () => {
      const res = await fetch(`/api/lanes/story/${encodeURIComponent(signature)}`, { credentials: "include" });
      if (res.status === 404) {
        const payload = (await res.json()) as LaneStoryNotRecurring;
        const err = new Error("Not recurring") as Error & { status?: number; payload?: LaneStoryNotRecurring };
        err.status = 404;
        err.payload = payload;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    retry: false,
  });

  const filteredEvents = useMemo(() => {
    const events = data?.timeline.events ?? [];
    if (surfaceFilter === "all") return events;
    return events.filter((e) => e.surface === surfaceFilter);
  }, [data?.timeline.events, surfaceFilter]);

  const groupedByDay = useMemo(() => {
    const map = new Map<string, LaneStoryEvent[]>();
    for (const e of filteredEvents) {
      const k = dayKey(e.occurredAt);
      const list = map.get(k);
      if (list) list.push(e);
      else map.set(k, [e]);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filteredEvents]);

  // ── Not-recurring CTA ─────────────────────────────────────────────────
  if (isError && (error as any)?.status === 404 && (error as any).payload) {
    const p = (error as any).payload as LaneStoryNotRecurring;
    const params = new URLSearchParams({
      createLane: "1",
      originCity: p.prefill.originCity,
      originState: p.prefill.originState,
      destCity: p.prefill.destCity,
      destState: p.prefill.destState,
      equipment: p.prefill.equipment,
    });
    const lwqHref = `/lanes/work-queue?${params.toString()}`;
    const laneLabel = `${p.prefill.originCity || "?"}, ${p.prefill.originState || "?"} → ${p.prefill.destCity || "?"}, ${p.prefill.destState || "?"}`;
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4" data-testid="page-lane-story-not-recurring">
        <Link href="/lane-inbox">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="link-back-inbox">
            <ArrowLeft className="h-4 w-4" /> Lane Inbox
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-md border bg-muted p-2"><RouteIcon className="h-5 w-5" /></div>
              <div className="space-y-1">
                <h1 className="text-xl font-semibold" data-testid="text-lane-not-recurring">{laneLabel}</h1>
                <p className="text-sm text-muted-foreground">
                  This lane is not yet a recurring lane in the work queue, so there's no story to show.
                  Make it recurring to start tracking outreach, replies, and outcomes here.
                </p>
              </div>
            </div>
            <Link href={lwqHref}>
              <Button size="lg" className="w-full sm:w-auto" data-testid="button-make-recurring">
                Make this recurring
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4" data-testid="page-lane-story">
      <Link href="/lane-inbox">
        <Button variant="ghost" size="sm" className="gap-1" data-testid="link-back-inbox">
          <ArrowLeft className="h-4 w-4" /> Lane Inbox
        </Button>
      </Link>

      {/* Header strip */}
      {isLoading && <Skeleton className="h-32 w-full" />}
      {isError && (error as any)?.status !== 404 && (
        <ErrorBanner
          message="We couldn't load this lane's story. This is usually temporary — try again."
          onRetry={() => refetch()}
        />
      )}
      {data && (
        <Card data-testid="card-lane-story-header">
          <CardContent className="p-4 sm:p-6 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-lane-label">
                  <RouteIcon className="h-6 w-6" />
                  {data.header.origin}{data.header.originState ? `, ${data.header.originState}` : ""}
                  <span className="text-muted-foreground">→</span>
                  {data.header.destination}{data.header.destinationState ? `, ${data.header.destinationState}` : ""}
                </h1>
                <div className="text-sm text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
                  {data.header.equipmentType && <Badge variant="outline">{data.header.equipmentType}</Badge>}
                  {data.header.companyName && <span>{data.header.companyName}</span>}
                  {data.header.ownerName && <span>• Owner: {data.header.ownerName}</span>}
                </div>
              </div>
              <Badge className={`${HEALTH_TONE[data.header.laneHealth]} border`} data-testid={`badge-health-${data.header.laneHealth}`}>
                {data.header.laneHealth.toUpperCase()}
                {data.header.laneScore !== null && ` • ${data.header.laneScore}`}
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t">
              <HeaderStat icon={Truck} label="Carriers contacted" value={String(data.header.carriersContactedCount)} testId="stat-carriers-contacted" />
              <HeaderStat
                icon={Users}
                label="Contactable"
                value={data.header.contactableCount === 0 ? "none" : String(data.header.contactableCount)}
                tone={data.header.contactableCount === 0 ? "warn" : undefined}
                testId="stat-contactable"
              />
              <HeaderStat icon={Package} label="Live AF opps" value={String(data.header.liveOppCount)} testId="stat-live-opps" />
              <HeaderStat icon={Calendar} label="Freshness" value={fmtFreshness(data.header.freshnessMinutes)} testId="stat-freshness" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Task #912 — Copilot Fit & Intelligence Cards anchored to this lane. */}
      {data && (
        <IntelligenceCardsList anchor={{ kind: "lane", laneSignature: data.header.laneSignature }} />
      )}

      {/* Outcomes 30d */}
      {data && (
        <Card data-testid="card-outcomes-30d">
          <CardContent className="p-4 sm:p-6 space-y-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Outcomes — last 30 days</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              <OutcomeStat label="Covers" value={String(data.outcomes30d.covers.count)} testId="outcome-covers-count" />
              <OutcomeStat label="Combined GM" value={fmtCurrency(data.outcomes30d.covers.combinedGrossMargin)} testId="outcome-covers-gm" />
              <OutcomeStat label="Quotes won / lost" value={`${data.outcomes30d.quotes.won} / ${data.outcomes30d.quotes.lost}`} testId="outcome-quotes" />
              <OutcomeStat label="Outreach waves" value={String(data.outcomes30d.outreachWaves)} testId="outcome-waves" />
              <OutcomeStat label="Replies" value={`${data.outcomes30d.carrierReplies} (${data.outcomes30d.distinctCarriersContacted} carriers)`} testId="outcome-replies" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      {data && (
        <Card data-testid="card-timeline">
          <CardContent className="p-4 sm:p-6 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                <h2 className="text-lg font-semibold">Timeline</h2>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {SURFACE_FILTERS.map((f) => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={surfaceFilter === f.value ? "default" : "outline"}
                    onClick={() => setSurfaceFilter(f.value)}
                    data-testid={`button-timeline-filter-${f.value}`}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>
            {filteredEvents.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No events yet"
                description="No timeline activity matches the current filter."
                testId="empty-timeline"
              />
            ) : (
              <div className="space-y-4">
                {groupedByDay.map(([day, evts]) => (
                  <div key={day} className="space-y-1">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground sticky top-0 bg-background py-1">
                      {dayLabel(day)}
                    </div>
                    {evts.map((e) => {
                      const meta = SURFACE_META[e.surface];
                      const Icon = meta.icon;
                      return (
                        <div
                          key={e.id}
                          className="flex items-start gap-3 p-2 rounded-md hover-elevate"
                          data-testid={`row-timeline-${e.id}`}
                        >
                          <div className={`shrink-0 rounded-md border p-1.5 ${meta.tone}`}>
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{e.title}</div>
                            {e.detail && (
                              <div className="text-xs text-muted-foreground truncate">{e.detail}</div>
                            )}
                          </div>
                          <div className="shrink-0 text-xs text-muted-foreground flex items-center gap-1">
                            {new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HeaderStat({
  icon: Icon, label, value, tone, testId,
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone?: "warn"; testId?: string }) {
  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />
      <div className="min-w-0">
        <div className={`text-sm font-medium truncate ${tone === "warn" ? "text-amber-700 dark:text-amber-300" : ""}`}>{value}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function OutcomeStat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}
