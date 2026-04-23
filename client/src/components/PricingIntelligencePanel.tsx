import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, AlertCircle, Sparkles } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid, ReferenceLine, Cell,
} from "recharts";

export type PricingIntelInput = {
  customerId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment?: string;
  laneGroupId?: string;
};

type PriceBin = { label: string; lo: number; hi: number; total: number; won: number; winRate: number };
type Suggestion = {
  low: number; high: number;
  positionLow: number; positionHigh: number;
  binWinRate: number; binSample: number; rationale: string;
};
type HistoryRow = {
  id: string; requestDate: string;
  quotedAmount: number; sonarBenchmark: number | null; pricePosition: number | null;
  outcomeStatus: string; outcomeLabel: string;
  carrierPaid: number | null; marginDollar: number | null; marginPct: number | null;
  scope: "same_lane" | "same_lane_group";
};
type Intel = {
  customerId: string; customerName: string | null;
  lane: { originCity: string; originState: string; destCity: string; destState: string };
  equipment: string | null;
  scope: "same_lane" | "same_lane_group" | "none";
  totalConsidered: number; decidedSample: number;
  sonarBenchmark: number | null;
  benchmarkSource: "stored_recent" | "stored_avg" | "none";
  bins: PriceBin[];
  history: HistoryRow[];
  suggestion: Suggestion | null;
  confidence: "high" | "medium" | "low" | "insufficient_history" | "no_benchmark";
  message: string;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending", won: "Won", won_low_margin: "Won (low)",
  lost_price: "Lost — price", lost_service: "Lost — svc",
  lost_timing: "Lost — timing", lost_incumbent: "Lost — inc",
  no_response: "No response", expired: "Expired",
};

function fmt$(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtPct(n: number): string { return `${n.toFixed(1)}%`; }
function fmtPosition(p: number | null): string {
  if (p === null) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${(p * 100).toFixed(1)}%`;
}

function statusColor(status: string): string {
  if (status === "won" || status === "won_low_margin") return "text-emerald-300";
  if (status.startsWith("lost_")) return "text-red-300";
  if (status === "pending") return "text-amber-300";
  return "text-zinc-400";
}

function buildQuery(input: PricingIntelInput): string {
  const p = new URLSearchParams();
  p.set("customerId", input.customerId);
  p.set("originCity", input.originCity);
  p.set("originState", input.originState);
  p.set("destCity", input.destCity);
  p.set("destState", input.destState);
  if (input.equipment) p.set("equipment", input.equipment);
  if (input.laneGroupId) p.set("laneGroupId", input.laneGroupId);
  return p.toString();
}

export function PricingIntelligencePanel({
  input, onUsePrice,
}: {
  input: PricingIntelInput | null;
  /** When provided, renders a "Use this price" button that returns the suggested midpoint. */
  onUsePrice?: (price: number) => void;
}): JSX.Element | null {
  const enabled = !!input?.customerId && !!input?.originCity && !!input?.destCity;
  const qs = input && enabled ? buildQuery(input) : "";
  const query = useQuery<Intel>({
    queryKey: ["/api/customer-quotes/pricing-intelligence", qs],
    queryFn: async (): Promise<Intel> => {
      const res = await fetch(`/api/customer-quotes/pricing-intelligence?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load pricing intelligence");
      return res.json() as Promise<Intel>;
    },
    enabled,
  });

  if (!enabled) return null;

  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="pricing-intelligence-panel">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm text-zinc-100 flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-amber-400" />
          Pricing Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {query.isLoading || !query.data ? (
          <div className="space-y-2">
            <Skeleton className="h-16 bg-zinc-800" />
            <Skeleton className="h-32 bg-zinc-800" />
          </div>
        ) : (
          <PanelBody intel={query.data} onUsePrice={onUsePrice} />
        )}
      </CardContent>
    </Card>
  );
}

function PanelBody({ intel, onUsePrice }: { intel: Intel; onUsePrice?: (price: number) => void }): JSX.Element {
  const hasBins = intel.bins.some(b => b.total > 0);
  const midpoint = intel.suggestion ? Math.round((intel.suggestion.low + intel.suggestion.high) / 2) : null;

  return (
    <>
      {/* Suggestion / empty state */}
      {intel.suggestion ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3" data-testid="pricing-suggestion">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-amber-300 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Suggested range
                <span className={`ml-1 px-1 rounded text-[9px] border ${
                  intel.confidence === "high" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : intel.confidence === "medium" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                  : "bg-zinc-700/40 text-zinc-300 border-zinc-700"
                }`} data-testid="pricing-confidence">{intel.confidence}</span>
              </div>
              <div className="text-base font-semibold text-zinc-100 mt-0.5 tabular-nums" data-testid="pricing-suggested-range">
                {fmt$(intel.suggestion.low)} – {fmt$(intel.suggestion.high)}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1">{intel.suggestion.rationale}</div>
              {intel.sonarBenchmark !== null && (
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  SONAR benchmark: <span className="text-zinc-300">{fmt$(intel.sonarBenchmark)}</span>
                  {intel.benchmarkSource === "stored_avg" && <span className="text-zinc-600"> (avg of recent stored)</span>}
                </div>
              )}
            </div>
            {onUsePrice && midpoint !== null && (
              <Button
                size="sm"
                onClick={() => onUsePrice(midpoint)}
                className="shrink-0 bg-amber-500 hover:bg-amber-400 text-zinc-950 h-7 text-xs"
                data-testid="button-use-suggested-price"
              >
                Use {fmt$(midpoint)}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400 flex gap-2" data-testid="pricing-empty-state">
          <AlertCircle className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
          <span>{intel.message}</span>
        </div>
      )}

      {/* Win-rate by price-position curve */}
      {hasBins && (
        <div data-testid="pricing-bins">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Win rate by price position vs SONAR
          </div>
          <div className="h-[140px] -ml-2">
            <ResponsiveContainer>
              <BarChart data={intel.bins.filter(b => b.total > 0)}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: "#a1a1aa", fontSize: 10 }} />
                <YAxis tick={{ fill: "#71717a", fontSize: 10 }} domain={[0, 100]} unit="%" />
                <RTooltip
                  contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }}
                  formatter={(v: number, _n: string, props: { payload?: PriceBin }) =>
                    [`${v.toFixed(0)}% (n=${props.payload?.total ?? 0}, won=${props.payload?.won ?? 0})`, "Win rate"]}
                />
                {intel.suggestion && (
                  <ReferenceLine
                    x={intel.bins.find(b => b.lo === intel.suggestion!.positionLow)?.label}
                    stroke="#f59e0b" strokeDasharray="2 2"
                  />
                )}
                <Bar dataKey="winRate" radius={[3, 3, 0, 0]}>
                  {intel.bins.filter(b => b.total > 0).map((b, i) => (
                    <Cell
                      key={i}
                      fill={
                        intel.suggestion && b.lo === intel.suggestion.positionLow ? "#f59e0b"
                          : b.winRate >= 60 ? "#10b981"
                          : b.winRate >= 30 ? "#84cc16"
                          : "#ef4444"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Recent history table */}
      {intel.history.length > 0 ? (
        <div data-testid="pricing-history">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center justify-between">
            <span>Recent quotes ({intel.scope === "same_lane_group" ? "lane group" : "same lane"})</span>
            <span className="text-zinc-600">{intel.history.length} of {intel.totalConsidered}</span>
          </div>
          <div className="rounded border border-zinc-800 overflow-hidden">
            <table className="w-full text-[11px]">
              <thead className="bg-zinc-950/60 text-zinc-500">
                <tr>
                  <th className="text-left px-2 py-1 font-normal">Date</th>
                  <th className="text-right px-2 py-1 font-normal">Quoted</th>
                  <th className="text-right px-2 py-1 font-normal">vs SONAR</th>
                  <th className="text-left px-2 py-1 font-normal">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {intel.history.map(h => (
                  <tr key={h.id} className="border-t border-zinc-800" data-testid={`pricing-history-row-${h.id}`}>
                    <td className="px-2 py-1 text-zinc-400 tabular-nums">{new Date(h.requestDate).toLocaleDateString()}</td>
                    <td className="px-2 py-1 text-right text-zinc-200 tabular-nums">{fmt$(h.quotedAmount)}</td>
                    <td className="px-2 py-1 text-right text-zinc-300 tabular-nums">{fmtPosition(h.pricePosition)}</td>
                    <td className={`px-2 py-1 ${statusColor(h.outcomeStatus)}`}>{STATUS_LABELS[h.outcomeStatus] ?? h.outcomeStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-zinc-500" data-testid="pricing-no-history">
          No prior quotes for this customer + lane.
        </div>
      )}
    </>
  );
}
