import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Minus, PieChart, ChevronRight } from "lucide-react";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";

interface MarketShareSummaryRow {
  companyId: string;
  companyName: string;
  amName: string | null;
  currentPct: number;
  prevPct: number | null;
  trend: "up" | "down" | "flat" | "none";
  lastPeriodLabel: string | null;
  entryCount: number;
  monthlyData: { label: string; pct: number }[];
}

function PctBadge({ pct }: { pct: number }) {
  const cls =
    pct >= 60
      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
      : pct >= 30
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold tabular-nums ${cls}`}>
      {pct}%
    </span>
  );
}

function TrendIcon({ trend, delta }: { trend: string; delta: number | null }) {
  if (trend === "up")
    return (
      <span className="flex items-center gap-0.5 text-green-600 dark:text-green-400 text-[11px] font-medium">
        <TrendingUp className="h-3 w-3" />
        {delta !== null ? `+${delta.toFixed(1)}` : ""}
      </span>
    );
  if (trend === "down")
    return (
      <span className="flex items-center gap-0.5 text-red-500 dark:text-red-400 text-[11px] font-medium">
        <TrendingDown className="h-3 w-3" />
        {delta !== null ? delta.toFixed(1) : ""}
      </span>
    );
  if (trend === "flat")
    return (
      <span className="flex items-center gap-0.5 text-muted-foreground text-[11px]">
        <Minus className="h-3 w-3" />
      </span>
    );
  return null;
}

function MiniSpark({ data }: { data: { label: string; pct: number }[] }) {
  if (data.length < 2) return null;
  const last = data[data.length - 1].pct;
  const color = last >= 60 ? "#16a34a" : last >= 30 ? "#d97706" : "#ef4444";
  return (
    <ResponsiveContainer width={64} height={28}>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          type="monotone"
          dataKey="pct"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{ fontSize: 11, padding: "2px 6px" }}
          formatter={(v: number) => [`${v}%`, ""]}
          labelFormatter={(l) => l}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function MarketSharePortlet() {
  const { data: rows = [], isLoading } = useQuery<MarketShareSummaryRow[]>({
    queryKey: ["/api/market-share/summary"],
    staleTime: 120000,
    refetchOnWindowFocus: false,
  });

  return (
    <Card data-testid="card-market-share-portlet">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PieChart className="h-4 w-4 text-primary" />
          Market Share Tracker
          {!isLoading && rows.length > 0 && (
            <Badge variant="secondary" className="ml-auto font-normal">
              {rows.length} account{rows.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <PieChart className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No market share data yet</p>
            <p className="text-xs mt-1">
              Open a company profile and add market share entries to track progress here.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row, idx) => {
              const delta =
                row.currentPct !== null && row.prevPct !== null
                  ? Math.round((row.currentPct - row.prevPct) * 10) / 10
                  : null;
              return (
                <Link key={row.companyId} href={`/companies/${row.companyId}`}>
                  <div
                    className="flex items-center gap-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer group"
                    data-testid={`market-share-row-${row.companyId}`}
                  >
                    {/* Rank */}
                    <div className="w-5 text-center shrink-0">
                      <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                        {idx + 1}
                      </span>
                    </div>

                    {/* Company name + AM */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate leading-tight">
                        {row.companyName}
                      </p>
                      {row.amName && (
                        <p className="text-xs text-muted-foreground truncate">
                          {row.amName}
                          {row.lastPeriodLabel ? ` · ${row.lastPeriodLabel}` : ""}
                        </p>
                      )}
                    </div>

                    {/* Spark chart */}
                    <div className="shrink-0">
                      <MiniSpark data={row.monthlyData} />
                    </div>

                    {/* Trend */}
                    <div className="shrink-0 w-12 text-right">
                      <TrendIcon trend={row.trend} delta={delta} />
                    </div>

                    {/* Current % badge */}
                    <div className="shrink-0">
                      <PctBadge pct={row.currentPct} />
                    </div>

                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
