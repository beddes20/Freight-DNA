/**
 * Task #700 — AI Engagement admin page.
 *
 * Single page that reads the per-surface aggregates and lets an admin see
 * which AI surfaces are pulling their weight and which are dark.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ShieldAlert, Eye, MousePointerClick, X as XIcon, Activity } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import { STALE_5MIN } from "@/lib/queryClient";

interface SurfaceRow {
  surface: string;
  impressions: number;
  clicks: number;
  accepts: number;
  applies: number;
  copies: number;
  dismisses: number;
  thumbsUp: number;
  thumbsDown: number;
  uniqueUsers: number;
  ctr: number;
  acceptRate: number;
  dismissRate: number;
}
interface TopUser {
  userId: string;
  name: string;
  impressions: number;
  accepts: number;
  total: number;
  acceptRate: number;
}
interface FeatureBucket {
  surface: string;
  feature: string;
  impressions: number;
  accepts: number;
  dismisses: number;
  acceptRate: number;
  dismissRate: number;
}
interface SeriesPoint {
  day: string;
  impressions: number;
  accepts: number;
  total: number;
}
interface OverviewResponse {
  days: number;
  surface: string | null;
  availableSurfaces: string[];
  surfaces: SurfaceRow[];
  topUsers: TopUser[];
  featureLeaderboard: { most: FeatureBucket[]; least: FeatureBucket[] };
  timeSeries: SeriesPoint[];
}

const SURFACE_LABEL: Record<string, string> = {
  nba_card: "NBA cards",
  daily_priorities: "Daily Priorities",
  valueiq: "ValueIQ",
  ai_center: "AI Center",
  ai_intelligence_hub: "AI Intelligence Hub",
  proactive_nudge: "Proactive nudges",
  talking_points: "Talking points",
  health_narrative: "Health narratives",
  touchpoint_summary: "Touchpoint summaries",
  meeting_brief: "Meeting briefs",
  weekly_account_review: "Weekly account reviews",
  ai_email_draft: "AI email drafts",
  ready_to_act: "Ready to Act",
  carrier_recommendation: "Carrier recommendations",
  spot_quote_intel: "Spot quote intel",
};

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function AdminAiEngagementPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [surfaceFilter, setSurfaceFilter] = useState<string>("__all__");
  const canView = user && ["admin", "director", "sales_director"].includes(user.role);

  const { data, isLoading, isError, refetch } = useQuery<OverviewResponse>({
    queryKey: ["/api/ai-engagement/overview", { days, surface: surfaceFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days) });
      if (surfaceFilter !== "__all__") params.set("surface", surfaceFilter);
      const r = await fetch(`/api/ai-engagement/overview?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!canView,
    staleTime: STALE_5MIN,
  });

  if (!user) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="p-8">
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
            <p className="font-semibold">Restricted</p>
            <p className="text-sm text-muted-foreground">
              AI engagement analytics are available to admins, directors, and sales directors.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const surfaces = data?.surfaces ?? [];
  const dark = surfaces.filter((s) => s.impressions === 0);
  const top = surfaces.filter((s) => s.impressions > 0);

  const totalImpressions = top.reduce((sum, s) => sum + s.impressions, 0);
  const totalClicks = top.reduce((sum, s) => sum + s.clicks, 0);
  const totalAccepts = top.reduce((sum, s) => sum + s.accepts + s.applies, 0);
  const totalDismisses = top.reduce((sum, s) => sum + s.dismisses, 0);

  return (
    <div className="p-6 space-y-6" data-testid="page-ai-engagement">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">AI Engagement</h1>
          <p className="text-sm text-muted-foreground">
            Which AI surfaces reps actually use. Use this to decide what to keep, merge, or retire.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={surfaceFilter} onValueChange={setSurfaceFilter}>
            <SelectTrigger className="w-[200px]" data-testid="select-surface">
              <SelectValue placeholder="All surfaces" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All surfaces</SelectItem>
              {(data?.availableSurfaces ?? []).map((s) => (
                <SelectItem key={s} value={s}>{SURFACE_LABEL[s] ?? s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-[160px]" data-testid="select-window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError && (
        <ErrorBanner
          message="Couldn't load engagement data — try again in a moment, or check the server logs."
          onRetry={() => refetch()}
        />
      )}
      {isLoading && (
        <Card><CardContent className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground inline-block" /></CardContent></Card>
      )}

      {!isLoading && !isError && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard icon={<Eye className="h-4 w-4" />} label="Impressions" value={totalImpressions.toLocaleString()} testId="kpi-impressions" />
            <KpiCard icon={<MousePointerClick className="h-4 w-4" />} label="Clicks" value={totalClicks.toLocaleString()} sub={fmtPct(totalImpressions ? totalClicks / totalImpressions : 0) + " CTR"} testId="kpi-clicks" />
            <KpiCard icon={<Activity className="h-4 w-4" />} label="Accepts / applies" value={totalAccepts.toLocaleString()} sub={fmtPct(totalImpressions ? totalAccepts / totalImpressions : 0) + " accept rate"} testId="kpi-accepts" />
            <KpiCard icon={<XIcon className="h-4 w-4" />} label="Dismisses" value={totalDismisses.toLocaleString()} sub={fmtPct(totalImpressions ? totalDismisses / totalImpressions : 0) + " dismiss rate"} testId="kpi-dismisses" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Per-surface engagement</CardTitle>
            </CardHeader>
            <CardContent>
              {top.length === 0 ? (
                <EmptyState
                  title="No engagement data yet"
                  description="Once reps start interacting with AI surfaces, the breakdown will appear here. New surfaces start emitting events as soon as they're wired with the telemetry helper."
                  testId="empty-engagement"
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-2 pr-3">Surface</th>
                        <th className="text-right py-2 px-3">Impressions</th>
                        <th className="text-right py-2 px-3">CTR</th>
                        <th className="text-right py-2 px-3">Accept rate</th>
                        <th className="text-right py-2 px-3">Dismiss rate</th>
                        <th className="text-right py-2 pl-3">Unique users</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.map((s) => (
                        <tr key={s.surface} className="border-b hover-elevate" data-testid={`row-surface-${s.surface}`}>
                          <td className="py-2 pr-3 font-medium">{SURFACE_LABEL[s.surface] ?? s.surface}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{s.impressions.toLocaleString()}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{fmtPct(s.ctr)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{fmtPct(s.acceptRate)}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{fmtPct(s.dismissRate)}</td>
                          <td className="text-right py-2 pl-3 tabular-nums">{s.uniqueUsers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Impressions over time</CardTitle>
              </CardHeader>
              <CardContent>
                <Sparkline points={data?.timeSeries ?? []} testId="ai-engagement-sparkline" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top users</CardTitle>
              </CardHeader>
              <CardContent>
                {(data?.topUsers ?? []).length === 0 ? (
                  <EmptyState
                    title="No user activity yet"
                    description="When reps start engaging with AI surfaces, the most-active users will surface here."
                    testId="empty-top-users"
                    compact
                  />
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-2 pr-3">User</th>
                        <th className="text-right py-2 px-3">Events</th>
                        <th className="text-right py-2 px-3">Accepts</th>
                        <th className="text-right py-2 pl-3">Accept rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.topUsers ?? []).map((u) => (
                        <tr key={u.userId} className="border-b hover-elevate" data-testid={`row-top-user-${u.userId}`}>
                          <td className="py-2 pr-3 font-medium">{u.name}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{u.total.toLocaleString()}</td>
                          <td className="text-right py-2 px-3 tabular-nums">{u.accepts.toLocaleString()}</td>
                          <td className="text-right py-2 pl-3 tabular-nums">{fmtPct(u.acceptRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <FeatureLeaderboard
              title="Most engaged features"
              rows={data?.featureLeaderboard?.most ?? []}
              metric="acceptRate"
              testId="leaderboard-most"
            />
            <FeatureLeaderboard
              title="Least engaged features"
              rows={data?.featureLeaderboard?.least ?? []}
              metric="acceptRate"
              testId="leaderboard-least"
            />
          </div>

          {dark.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  Zero-engagement surfaces <Badge variant="outline">{dark.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  These AI surfaces emitted zero impressions in the last {data?.days ?? days} days.
                  Strong candidates to merge or retire.
                </p>
                <div className="flex flex-wrap gap-2">
                  {dark.map((s) => (
                    <Badge key={s.surface} variant="secondary" data-testid={`badge-dark-${s.surface}`}>
                      {SURFACE_LABEL[s.surface] ?? s.surface}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function KpiCard({ icon, label, value, sub, testId }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          {icon}<span>{label}</span>
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function FeatureLeaderboard({ title, rows, metric, testId }: {
  title: string;
  rows: FeatureBucket[];
  metric: "acceptRate" | "dismissRate";
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            title="No feature data yet"
            description="Features start appearing here once they emit at least one impression."
            compact
            testId={`${testId}-empty`}
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2 pr-3">Feature</th>
                <th className="text-right py-2 px-3">Impr.</th>
                <th className="text-right py-2 pl-3">{metric === "acceptRate" ? "Accept rate" : "Dismiss rate"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.surface}::${r.feature}`} className="border-b hover-elevate"
                    data-testid={`row-feature-${r.surface}-${r.feature}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{r.feature}</div>
                    <div className="text-xs text-muted-foreground">{SURFACE_LABEL[r.surface] ?? r.surface}</div>
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">{r.impressions.toLocaleString()}</td>
                  <td className="text-right py-2 pl-3 tabular-nums">{fmtPct(r[metric])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function Sparkline({ points, testId }: { points: SeriesPoint[]; testId?: string }) {
  if (points.length === 0) {
    return (
      <EmptyState
        title="No activity in window"
        description="Pick a wider time window or wait for usage to accumulate."
        compact
        testId={`${testId}-empty`}
      />
    );
  }
  const W = 600, H = 80, P = 6;
  const max = Math.max(1, ...points.map((p) => p.impressions));
  const step = points.length > 1 ? (W - 2 * P) / (points.length - 1) : 0;
  const path = points
    .map((p, i) => {
      const x = P + i * step;
      const y = H - P - (p.impressions / max) * (H - 2 * P);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const totalImpr = points.reduce((s, p) => s + p.impressions, 0);
  return (
    <div data-testid={testId}>
      <div className="text-xs text-muted-foreground mb-2">
        {totalImpr.toLocaleString()} impressions across {points.length} day{points.length === 1 ? "" : "s"}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-500" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
        <span>{points[0]?.day}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </div>
  );
}
