import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TrendingUp } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip,
  ResponsiveContainer, ComposedChart, Line, Legend,
} from "recharts";
import type { TrendsData } from "../types";

interface TrendsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyName: string;
  financialAlias?: string | null;
}

export function TrendsDialog({
  open,
  onOpenChange,
  companyId,
  companyName,
  financialAlias,
}: TrendsDialogProps) {
  const { data: trendsData, isLoading: trendsLoading } = useQuery<TrendsData>({
    queryKey: ["/api/companies", companyId, "historical-trends"],
    enabled: open,
  });

  const { data: customerNames = [] } = useQuery<string[]>({
    queryKey: ["/api/financials/customer-names"],
    enabled: open,
  });

  const trendAliasSuggestions = (() => {
    if (customerNames.length === 0) return [];
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const crmNorm = normalize(companyName);
    return customerNames
      .filter(n => {
        const norm = normalize(n);
        const shorter = crmNorm.length <= norm.length ? crmNorm : norm;
        const longer  = crmNorm.length <= norm.length ? norm : crmNorm;
        return shorter.length >= 4 && longer.includes(shorter);
      })
      .slice(0, 5);
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Historical Freight Trends — {companyName}
          </DialogTitle>
        </DialogHeader>

        {trendsLoading ? (
          <div className="py-12 text-center text-muted-foreground">Loading trends data…</div>
        ) : !trendsData || trendsData.totalLoads === 0 ? (
          <div className="py-12 text-center">
            <TrendingUp className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No freight history found for this account.</p>
            <p className="text-xs text-muted-foreground mt-1">Make sure a financial alias is set if the customer name differs in the uploaded data.</p>
            {trendAliasSuggestions.length > 0 && (
              <div className="mt-4 text-left max-w-sm mx-auto">
                <p className="text-xs font-medium text-muted-foreground mb-2">Possible matches in uploaded data:</p>
                <div className="flex flex-wrap gap-1.5">
                  {trendAliasSuggestions.map(name => (
                    <span key={name} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                      {name}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Set one of these as the Financial Alias on the account page to link the data.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total Loads", value: trendsData.totalLoads.toLocaleString() },
                { label: "Spot Loads", value: `${trendsData.spotLoads.toLocaleString()} (${trendsData.totalLoads > 0 ? Math.round((trendsData.spotLoads / trendsData.totalLoads) * 100) : 0}%)` },
                { label: "Total Margin", value: `$${trendsData.totalMargin.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` },
              ].map(kpi => (
                <div key={kpi.label} className="rounded-lg border bg-muted/40 px-4 py-3 text-center">
                  <div className="text-lg font-semibold">{kpi.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{kpi.label}</div>
                </div>
              ))}
            </div>

            {trendsData.months.length > 1 && (
              <div>
                <h3 className="text-sm font-semibold mb-3">Monthly Trend</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={[...trendsData.months].map(m => {
                    const [y, mo] = m.monthKey.split("-");
                    return {
                      month: new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" }),
                      loads: m.totalLoads,
                      spot: m.spotLoads,
                      margin: Math.round(m.totalMargin),
                    };
                  })} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="loads" tick={{ fontSize: 11 }} width={35} />
                    <YAxis yAxisId="margin" orientation="right" tick={{ fontSize: 11 }} width={55} tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(0)}K` : `$${v}`} />
                    <RechartTooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(value: number, name: string) => {
                        if (name === "margin") return [`$${value.toLocaleString()}`, "Margin"];
                        return [value, name === "loads" ? "Total Loads" : "Spot Loads"];
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="loads" dataKey="loads" fill="#3b82f6" name="Loads" radius={[2,2,0,0]} />
                    <Bar yAxisId="loads" dataKey="spot" fill="#f59e0b" name="Spot" radius={[2,2,0,0]} />
                    <Line yAxisId="margin" type="monotone" dataKey="margin" stroke="#10b981" strokeWidth={2} dot={false} name="Margin" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {trendsData.months.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">Monthly Breakdown</h3>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Month</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Spot</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Margin</th>
                        <th className="text-right px-3 py-2 font-medium text-muted-foreground">Avg/Load</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {[...trendsData.months].reverse().map(m => {
                        const [y, mo] = m.monthKey.split("-");
                        const label = new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
                        const avg = m.totalLoads > 0 ? m.totalMargin / m.totalLoads : 0;
                        return (
                          <tr key={m.monthKey} className="hover:bg-muted/30 transition-colors">
                            <td className="px-3 py-2 font-medium">{label}</td>
                            <td className="px-3 py-2 text-right">{m.totalLoads}</td>
                            <td className="px-3 py-2 text-right text-muted-foreground">{m.spotLoads}</td>
                            <td className="px-3 py-2 text-right">{m.totalMargin > 0 ? `$${m.totalMargin.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—"}</td>
                            <td className="px-3 py-2 text-right text-muted-foreground">{avg > 0 ? `$${avg.toFixed(0)}` : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {(trendsData.topDestinations ?? []).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">Top Delivery Destinations</h3>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Destination</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(trendsData.topDestinations ?? []).map((d, i) => (
                          <tr key={i} className="hover:bg-muted/30 transition-colors">
                            <td className="px-3 py-1.5">{d.city}{d.state ? `, ${d.state}` : ""}</td>
                            <td className="px-3 py-1.5 text-right font-medium">{d.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {(trendsData.topCorridors ?? []).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">Top Lane Corridors</h3>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Lane</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(trendsData.topCorridors ?? []).map((c, i) => (
                          <tr key={i} className="hover:bg-muted/30 transition-colors">
                            <td className="px-3 py-1.5 text-xs">
                              <span className="font-medium">{c.origin}</span>
                              <span className="text-muted-foreground mx-1">→</span>
                              <span>{c.destination}</span>
                            </td>
                            <td className="px-3 py-1.5 text-right font-medium">{c.loads}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
