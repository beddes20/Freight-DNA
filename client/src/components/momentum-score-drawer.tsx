import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GROWTH_BAND_STYLES } from "@/components/account-growth-portlet";
import { AlertTriangle, TrendingUp, TrendingDown, Minus, BarChart2, RefreshCw } from "lucide-react";

// ── Types (mirror of server MomentumBreakdown) ────────────────────────────────

export type MomentumBreakdown = {
  touchpointHealth: {
    points: number;
    max: number;
    recency: { points: number; max: number; daysSinceLastTouch: number | null };
    frequency30d: { points: number; max: number; count: number };
    meaningful30d: { points: number; max: number; count: number };
  };
  momentum: {
    points: number;
    max: number;
    recent30: number;
    prior30: number;
    trendLabel: "up" | "flat" | "down" | "reengaging";
  };
  relationshipDepth: {
    points: number;
    max: number;
    hasHomeRun: boolean;
    hasThirdBase: boolean;
    multiBaseContacts: number;
    totalContacts: number;
  };
  volumeSignal: {
    points: number;
    max: number;
    hasFinancialData: boolean;
    ytdLoads: number;
  };
  laneBreadth: {
    points: number;
    max: number;
    corridorCount: number;
  };
  rfpOpportunity: {
    points: number;
    max: number;
    hasActiveRfp: boolean;
    rfpTitle: string | null;
  };
  penalties: {
    totalPenalty: number;
    noTouch45Days: number;
    noMeaningfulConversation90Days: number;
    noThirdOrHomeRun: number;
    overdueTask: number;
  };
};

export type MomentumScore = {
  score: number;
  band: "at_risk" | "stable" | "growth_ready" | "high_expansion";
  bandLabel: string;
  bandColor: string;
  drivers: { label: string; points: number; positive: boolean }[];
  breakdown?: MomentumBreakdown;
  calculatedAt?: string;
};

// ── Band text ─────────────────────────────────────────────────────────────────

const BAND_SUMMARIES: Record<string, string> = {
  high_expansion: "High activity, strong relationships, and room to win more lanes.",
  growth_ready:   "Healthy base with room to increase activity and depth.",
  stable:         "Not in trouble, but activity and depth need work.",
  at_risk:        "Sparse activity or weak relationships. Needs immediate attention.",
};

// ── Mini progress bar ─────────────────────────────────────────────────────────

function ScoreBar({ points, max, colorClass }: { points: number; max: number; colorClass: string }) {
  const pct = max > 0 ? Math.round((points / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 flex-1" data-testid="score-bar">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground w-12 text-right shrink-0">
        {points} / {max}
      </span>
    </div>
  );
}

// ── Single bucket row ─────────────────────────────────────────────────────────

function BucketRow({
  label,
  points,
  max,
  barColor,
  children,
}: {
  label: string;
  points: number;
  max: number;
  barColor: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5" data-testid={`bucket-row-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground w-40 shrink-0">{label}</span>
        <ScoreBar points={points} max={max} colorClass={barColor} />
      </div>
      {children && (
        <ul className="ml-40 pl-2 space-y-0.5 border-l border-border">
          {children}
        </ul>
      )}
    </div>
  );
}

function DriverBullet({ text, positive }: { text: string; positive?: boolean }) {
  return (
    <li className={`text-xs leading-relaxed ${positive === false ? "text-red-500 dark:text-red-400" : "text-muted-foreground"}`}>
      {positive === false ? "▼ " : "• "}{text}
    </li>
  );
}

// ── Recency helper ────────────────────────────────────────────────────────────

function recencyLabel(days: number | null): string {
  if (days === null) return "Never contacted";
  if (days === 0) return "Contacted today";
  if (days === 1) return "1 business day ago";
  return `${days} days ago`;
}

// ── Trend icon ────────────────────────────────────────────────────────────────

function TrendIcon({ label }: { label: "up" | "flat" | "down" | "reengaging" }) {
  if (label === "up") return <TrendingUp className="h-3 w-3 text-green-500 shrink-0" />;
  if (label === "down") return <TrendingDown className="h-3 w-3 text-red-500 shrink-0" />;
  if (label === "reengaging") return <RefreshCw className="h-3 w-3 text-blue-500 shrink-0" />;
  return <Minus className="h-3 w-3 text-amber-500 shrink-0" />;
}

// ── Main drawer ───────────────────────────────────────────────────────────────

interface MomentumScoreDrawerProps {
  open: boolean;
  onClose: () => void;
  companyName: string;
  scoreData: MomentumScore | null | undefined;
  isLoading?: boolean;
}

export function MomentumScoreDrawer({
  open,
  onClose,
  companyName,
  scoreData,
  isLoading,
}: MomentumScoreDrawerProps) {
  const style = scoreData ? (GROWTH_BAND_STYLES[scoreData.band] ?? GROWTH_BAND_STYLES.stable) : null;
  const bd = scoreData?.breakdown;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] overflow-y-auto flex flex-col gap-0 p-0"
        data-testid="drawer-momentum-score"
      >
        {/* ── Header ── */}
        <SheetHeader className="px-6 py-5 border-b bg-muted/30 shrink-0">
          <SheetTitle className="text-base font-semibold flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-muted-foreground" />
            Momentum Score Breakdown
          </SheetTitle>
          <p className="text-sm text-muted-foreground truncate">{companyName}</p>
        </SheetHeader>

        <div className="flex-1 px-6 py-5 space-y-6">

          {/* ── Loading ── */}
          {isLoading && (
            <div className="space-y-3" data-testid="skeleton-momentum">
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {/* ── No score fallback ── */}
          {!isLoading && !scoreData && (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm" data-testid="empty-momentum-score">
              <AlertTriangle className="h-8 w-8 opacity-40" />
              <p>Momentum Score not yet calculated for this account.</p>
            </div>
          )}

          {/* ── Score header ── */}
          {!isLoading && scoreData && style && (
            <>
              <div className="flex items-center gap-4">
                <div
                  className={`flex h-16 w-16 items-center justify-center rounded-xl font-black text-2xl border ${style.bg} ${style.text} ${style.border}`}
                  data-testid="text-momentum-score"
                >
                  {scoreData.score}
                </div>
                <div className="space-y-1">
                  <Badge
                    className={`text-sm px-3 py-1 font-semibold border ${style.bg} ${style.text} ${style.border} hover:${style.bg}`}
                    data-testid="badge-momentum-band"
                  >
                    <span className={`mr-1.5 h-2 w-2 rounded-full inline-block ${style.dot}`} />
                    {scoreData.bandLabel}
                  </Badge>
                  {scoreData.calculatedAt && (
                    <p className="text-xs text-muted-foreground">
                      Updated {new Date(scoreData.calculatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  )}
                </div>
              </div>

              {/* ── Section 1: Summary ── */}
              <div className="rounded-lg bg-muted/40 border px-4 py-3 space-y-1">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Momentum Score is a 0–100 signal based on touchpoint health, relationship depth, freight volume, lane breadth, RFPs, and behavioral momentum.
                </p>
                <p className="text-sm font-medium" data-testid="text-band-summary">
                  {BAND_SUMMARIES[scoreData.band]}
                </p>
              </div>

              {/* ── Section 2: Bucket breakdown ── */}
              <div className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">Score Breakdown</h3>

                {bd ? (
                  <div className="space-y-4">
                    {/* Touchpoint Health */}
                    <BucketRow
                      label="Touchpoint Health"
                      points={bd.touchpointHealth.points}
                      max={bd.touchpointHealth.max}
                      barColor="bg-blue-500"
                    >
                      <DriverBullet
                        text={`Last touch: ${recencyLabel(bd.touchpointHealth.recency.daysSinceLastTouch)} (${bd.touchpointHealth.recency.points}/${bd.touchpointHealth.recency.max} pts)`}
                        positive={bd.touchpointHealth.recency.points > 0}
                      />
                      <DriverBullet
                        text={`${bd.touchpointHealth.frequency30d.count} touches in last 30 days (${bd.touchpointHealth.frequency30d.points}/${bd.touchpointHealth.frequency30d.max} pts)`}
                        positive={bd.touchpointHealth.frequency30d.count > 0}
                      />
                      <DriverBullet
                        text={`${bd.touchpointHealth.meaningful30d.count} meaningful conversation${bd.touchpointHealth.meaningful30d.count !== 1 ? "s" : ""} in last 30 days (${bd.touchpointHealth.meaningful30d.points}/${bd.touchpointHealth.meaningful30d.max} pts)`}
                        positive={bd.touchpointHealth.meaningful30d.count > 0}
                      />
                    </BucketRow>

                    {/* Momentum trend */}
                    <BucketRow
                      label="Activity Trend"
                      points={bd.momentum.points}
                      max={bd.momentum.max}
                      barColor="bg-indigo-500"
                    >
                      <li className="text-xs leading-relaxed text-muted-foreground flex items-center gap-1.5">
                        <TrendIcon label={bd.momentum.trendLabel} />
                        {bd.momentum.trendLabel === "reengaging"
                          ? "Re-engaging — touches this period with none prior"
                          : `${bd.momentum.recent30} touches this month vs ${bd.momentum.prior30} prior month (${bd.momentum.trendLabel})`}
                      </li>
                    </BucketRow>

                    {/* Relationship Depth */}
                    <BucketRow
                      label="Relationship Depth"
                      points={bd.relationshipDepth.points}
                      max={bd.relationshipDepth.max}
                      barColor="bg-purple-500"
                    >
                      <DriverBullet
                        text={bd.relationshipDepth.hasHomeRun ? "Home Run contact on file" : "No Home Run contact"}
                        positive={bd.relationshipDepth.hasHomeRun}
                      />
                      <DriverBullet
                        text={bd.relationshipDepth.hasThirdBase ? "3rd Base contact on file" : "No 3rd Base contact"}
                        positive={bd.relationshipDepth.hasThirdBase}
                      />
                      <DriverBullet
                        text={`${bd.relationshipDepth.multiBaseContacts} contact${bd.relationshipDepth.multiBaseContacts !== 1 ? "s" : ""} with relationship base assigned`}
                        positive={bd.relationshipDepth.multiBaseContacts >= 2}
                      />
                      <DriverBullet
                        text={`${bd.relationshipDepth.totalContacts} total contact${bd.relationshipDepth.totalContacts !== 1 ? "s" : ""} on file`}
                        positive={bd.relationshipDepth.totalContacts >= 3}
                      />
                    </BucketRow>

                    {/* Volume Signal */}
                    <BucketRow
                      label="Volume Signal"
                      points={bd.volumeSignal.points}
                      max={bd.volumeSignal.max}
                      barColor="bg-green-500"
                    >
                      {bd.volumeSignal.hasFinancialData ? (
                        <DriverBullet
                          text={`${bd.volumeSignal.ytdLoads.toLocaleString()} YTD loads on record`}
                          positive={bd.volumeSignal.ytdLoads > 0}
                        />
                      ) : (
                        <DriverBullet
                          text="No freight data uploaded yet — upload financials to improve this score"
                          positive={false}
                        />
                      )}
                    </BucketRow>

                    {/* Lane Breadth */}
                    <BucketRow
                      label="Lane Breadth"
                      points={bd.laneBreadth.points}
                      max={bd.laneBreadth.max}
                      barColor="bg-amber-500"
                    >
                      <DriverBullet
                        text={bd.laneBreadth.corridorCount > 0
                          ? `${bd.laneBreadth.corridorCount} lane corridor${bd.laneBreadth.corridorCount !== 1 ? "s" : ""} attributed`
                          : "No lane corridors attributed yet"}
                        positive={bd.laneBreadth.corridorCount > 0}
                      />
                    </BucketRow>

                    {/* RFP & Opportunity */}
                    <BucketRow
                      label="RFP & Opportunity"
                      points={bd.rfpOpportunity.points}
                      max={bd.rfpOpportunity.max}
                      barColor="bg-orange-500"
                    >
                      {bd.rfpOpportunity.hasActiveRfp ? (
                        <DriverBullet
                          text={`Active RFP: ${bd.rfpOpportunity.rfpTitle ?? "Untitled"}`}
                          positive={true}
                        />
                      ) : (
                        <DriverBullet
                          text="No active RFP on file"
                          positive={false}
                        />
                      )}
                    </BucketRow>

                    {/* Penalties */}
                    {bd.penalties.totalPenalty < 0 && (
                      <div className="space-y-1.5" data-testid="bucket-row-penalties">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-red-600 dark:text-red-400 w-40 shrink-0">Risk Penalties</span>
                          <span className="text-sm font-mono font-semibold text-red-600 dark:text-red-400">
                            {bd.penalties.totalPenalty} pts
                          </span>
                        </div>
                        <ul className="ml-40 pl-2 space-y-0.5 border-l border-red-200 dark:border-red-800">
                          {bd.penalties.noTouch45Days > 0 && (
                            <DriverBullet text={`−${bd.penalties.noTouch45Days}: No touch in 45+ days`} positive={false} />
                          )}
                          {bd.penalties.noMeaningfulConversation90Days > 0 && (
                            <DriverBullet text={`−${bd.penalties.noMeaningfulConversation90Days}: No meaningful conversation in 90+ days`} positive={false} />
                          )}
                          {bd.penalties.noThirdOrHomeRun > 0 && (
                            <DriverBullet text={`−${bd.penalties.noThirdOrHomeRun}: No contacts at 3rd Base or Home Run level`} positive={false} />
                          )}
                          {bd.penalties.overdueTask > 0 && (
                            <DriverBullet text={`−${bd.penalties.overdueTask}: Overdue task(s) pending`} positive={false} />
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  // Score exists but no breakdown (legacy cached score)
                  <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-testid="empty-breakdown">
                    Detailed breakdown not available. Click refresh or revisit this page to generate a full breakdown.
                  </div>
                )}
              </div>

              {/* ── Section 3: Top drivers summary ── */}
              {scoreData.drivers.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Top Signals</h3>
                  <ul className="space-y-1.5">
                    {scoreData.drivers.map((d, i) => (
                      <li key={i} className={`flex items-start gap-2 text-sm ${d.positive ? "text-foreground" : "text-red-500 dark:text-red-400"}`}
                        data-testid={`driver-item-${i}`}>
                        <span className="shrink-0 mt-0.5">{d.positive ? "↑" : "↓"}</span>
                        <span>{d.label}</span>
                        <span className={`ml-auto shrink-0 text-xs font-mono ${d.positive ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                          {d.points > 0 ? "+" : ""}{d.points}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
