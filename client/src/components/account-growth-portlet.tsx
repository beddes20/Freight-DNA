import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, AlertTriangle, ChevronDown, ChevronUp, Zap } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type GrowthScoreDriver = { label: string; points: number; positive: boolean };

type GrowthScoreEntry = {
  id: number;
  companyId: string;
  organizationId: string;
  score: number;
  band: "at_risk" | "stable" | "growth_ready" | "high_expansion";
  bandLabel: string;
  bandColor: "red" | "amber" | "blue" | "green";
  drivers: GrowthScoreDriver[];
  calculatedAt: string;
  // joined on frontend via companyMap
  companyName?: string;
  repName?: string;
};

// ── Band styling ──────────────────────────────────────────────────────────────

export const GROWTH_BAND_STYLES: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  high_expansion: {
    bg:     "bg-green-50 dark:bg-green-950/30",
    text:   "text-green-700 dark:text-green-300",
    border: "border-green-200 dark:border-green-800/50",
    dot:    "bg-green-500",
  },
  growth_ready: {
    bg:     "bg-blue-50 dark:bg-blue-950/30",
    text:   "text-blue-700 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800/50",
    dot:    "bg-blue-500",
  },
  stable: {
    bg:     "bg-amber-50 dark:bg-amber-950/30",
    text:   "text-amber-700 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-800/50",
    dot:    "bg-amber-500",
  },
  at_risk: {
    bg:     "bg-red-50 dark:bg-red-950/30",
    text:   "text-red-700 dark:text-red-300",
    border: "border-red-200 dark:border-red-800/50",
    dot:    "bg-red-500",
  },
};

// ── Inline score badge (reused in customers list + company detail) ─────────────

export function GrowthScoreBadge({
  score,
  band,
  bandLabel,
  size = "sm",
}: {
  score: number;
  band: string;
  bandLabel: string;
  size?: "sm" | "md";
}) {
  const style = GROWTH_BAND_STYLES[band] ?? GROWTH_BAND_STYLES.stable;
  const textSize = size === "md" ? "text-sm" : "text-xs";

  return (
    <span
      className={`inline-flex items-center gap-1 font-semibold px-2 py-0.5 rounded-full border ${textSize} ${style.bg} ${style.text} ${style.border}`}
      title={`Account Growth Score: ${score}/100 — ${bandLabel}`}
      data-testid="badge-growth-score"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot} shrink-0`} />
      {score} · {bandLabel}
    </span>
  );
}

// ── Individual score row ──────────────────────────────────────────────────────

function ScoreRow({ entry, companyName }: { entry: GrowthScoreEntry; companyName: string }) {
  const [, navigate] = useLocation();
  const style = GROWTH_BAND_STYLES[entry.band] ?? GROWTH_BAND_STYLES.stable;
  const topDriver = (entry.drivers as GrowthScoreDriver[]).find(d => Math.abs(d.points) > 0);

  return (
    <button
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors text-left group"
      onClick={() => navigate(`/companies/${entry.companyId}`)}
      data-testid={`row-growth-score-${entry.companyId}`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-bold text-sm ${style.bg} ${style.text}`}>
        {entry.score}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
          {companyName}
        </p>
        {topDriver && (
          <p className={`text-xs truncate ${topDriver.positive ? "text-muted-foreground" : "text-red-500 dark:text-red-400"}`}>
            {topDriver.positive ? "↑" : "↓"} {topDriver.label}
          </p>
        )}
      </div>
      <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${style.bg} ${style.text}`}>
        {entry.bandLabel}
      </span>
    </button>
  );
}

// ── Main portlet ──────────────────────────────────────────────────────────────

interface AccountGrowthPortletProps {
  companies: Array<{ id: string; name: string; assignedTo?: string | null }>;
  collapsed: boolean;
  onToggle: () => void;
}

export function AccountGrowthPortlet({ companies, collapsed, onToggle }: AccountGrowthPortletProps) {
  const [, navigate] = useLocation();

  const { data: scores = [], isLoading } = useQuery<GrowthScoreEntry[]>({
    queryKey: ["/api/growth-scores"],
    staleTime: 10 * 60 * 1000, // 10 min — scores recalc server-side every 6h
  });

  const companyMap = new Map(companies.map(c => [c.id, c.name]));

  const enriched = scores
    .filter(s => companyMap.has(s.companyId))
    .map(s => ({ ...s, companyName: companyMap.get(s.companyId) ?? "Unknown" }));

  const atRisk         = enriched.filter(s => s.band === "at_risk").sort((a, b) => a.score - b.score).slice(0, 5);
  const highExpansion  = enriched.filter(s => s.band === "high_expansion" || s.band === "growth_ready")
                                 .sort((a, b) => b.score - a.score).slice(0, 5);

  const atRiskCount    = enriched.filter(s => s.band === "at_risk").length;
  const primedCount    = enriched.filter(s => s.band === "high_expansion").length;

  return (
    <Card data-testid="portlet-account-growth">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-account-growth"
      >
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Account Growth</span>
          {!isLoading && (
            <div className="flex items-center gap-1.5">
              {atRiskCount > 0 && (
                <Badge variant="destructive" className="text-xs px-1.5" data-testid="badge-at-risk-count">
                  {atRiskCount} at risk
                </Badge>
              )}
              {primedCount > 0 && (
                <Badge className="text-xs px-1.5 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-0" data-testid="badge-primed-count">
                  {primedCount} primed
                </Badge>
              )}
            </div>
          )}
        </div>
        {collapsed
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronUp   className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {isLoading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-11 w-full" />)}
            </div>
          ) : scores.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground" data-testid="empty-growth-scores">
              <Zap className="h-8 w-8 opacity-30" />
              <p className="text-sm text-center">No scores yet — open any account page to generate the first score.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">

              {/* At Risk panel */}
              {atRisk.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                    <span className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">Needs Attention</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {atRisk.map(entry => (
                      <ScoreRow key={entry.companyId} entry={entry} companyName={entry.companyName!} />
                    ))}
                  </div>
                </div>
              )}

              {/* Divider */}
              {atRisk.length > 0 && highExpansion.length > 0 && (
                <div className="border-t border-border" />
              )}

              {/* Growth/Expansion panel */}
              {highExpansion.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <TrendingUp className="h-3.5 w-3.5 text-green-500" />
                    <span className="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wide">Primed to Grow</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {highExpansion.map(entry => (
                      <ScoreRow key={entry.companyId} entry={entry} companyName={entry.companyName!} />
                    ))}
                  </div>
                </div>
              )}

              {atRisk.length === 0 && highExpansion.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
                  <TrendingDown className="h-6 w-6 opacity-30" />
                  <p className="text-sm">All accounts are in the Stable band.</p>
                </div>
              )}

              <button
                onClick={() => navigate("/customers")}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors self-start"
                data-testid="link-view-all-accounts"
              >
                View all accounts →
              </button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
