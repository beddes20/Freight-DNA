import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCall, ArrowUpDown } from "lucide-react";
import { useLocation } from "wouter";

type PaceRow = {
  companyId: string;
  companyName: string;
  inbound: number;
  outbound: number;
  missed: number;
  total: number;
  sparkline: number[];
};

type SortKey = "total" | "inbound" | "outbound" | "missed";

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return null;
  const max = Math.max(1, ...points);
  const w = 80;
  const h = 22;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = h - (p / max) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} className="text-blue-500 shrink-0" data-testid="sparkline-call-pace">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// `days` and `onDaysChange` allow a parent (e.g. the Call Performance Hub)
// to drive the days picker from a single shared state. When omitted, the
// card manages its own days locally so existing call sites keep working.
export function CallPaceCard({
  days: daysProp,
  onDaysChange,
}: {
  days?: number;
  onDaysChange?: (days: number) => void;
} = {}) {
  const [, navigate] = useLocation();
  const [internalDays, setInternalDays] = useState(90);
  const days = daysProp ?? internalDays;
  const setDays = (n: number) => {
    if (onDaysChange) onDaysChange(n);
    else setInternalDays(n);
  };
  const externallyControlled = daysProp !== undefined;
  const [sortKey, setSortKey] = useState<SortKey>("total");

  const { data, isLoading } = useQuery<{ days: number; rows: PaceRow[] }>({
    queryKey: ["/api/calls/pace", days],
    queryFn: async () => {
      const res = await fetch(`/api/calls/pace?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const sortedRows = useMemo(() => {
    const rows = data?.rows ?? [];
    return [...rows].sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number));
  }, [data, sortKey]);

  return (
    <Card className="p-5 space-y-4" data-testid="section-call-pace">
      <div className="flex items-center gap-2 flex-wrap">
        <PhoneCall className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Call Pace</h2>
        <span className="text-xs text-muted-foreground">Webex CDR activity per shipper</span>
        <div className="ml-auto flex items-center gap-1.5">
          {!externallyControlled && (
            <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
              <SelectTrigger className="h-7 text-xs w-[90px]" data-testid="select-pace-days"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger className="h-7 text-xs w-[120px]" data-testid="select-pace-sort"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="total">Total calls</SelectItem>
              <SelectItem value="inbound">Inbound</SelectItem>
              <SelectItem value="outbound">Outbound</SelectItem>
              <SelectItem value="missed">Missed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="h-40 animate-pulse rounded bg-muted" />
      ) : sortedRows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">No Webex call activity logged in the last {days} days.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Shipper</th>
                <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">In</th>
                <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Out</th>
                <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Missed</th>
                <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSortKey("total")} data-testid="button-sort-total">
                    Total <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="text-right py-2 text-xs font-medium text-muted-foreground">Weekly trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {sortedRows.slice(0, 25).map(row => (
                <tr key={row.companyId} className="hover:bg-muted/40 cursor-pointer" onClick={() => navigate(`/companies/${row.companyId}`)} data-testid={`row-call-pace-${row.companyId}`}>
                  <td className="py-2.5 pr-4">
                    <span className="font-medium text-foreground hover:underline">{row.companyName}</span>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-blue-600 dark:text-blue-400">{row.inbound}</td>
                  <td className="py-2.5 pr-4 text-right text-emerald-600 dark:text-emerald-400">{row.outbound}</td>
                  <td className="py-2.5 pr-4 text-right text-red-600 dark:text-red-400">{row.missed}</td>
                  <td className="py-2.5 pr-4 text-right">
                    <Badge variant="outline" className="font-semibold">{row.total}</Badge>
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex justify-end"><Sparkline points={row.sparkline} /></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sortedRows.length > 25 && (
            <p className="text-[11px] text-muted-foreground mt-2">Showing top 25 of {sortedRows.length} shippers with call activity.</p>
          )}
        </div>
      )}
    </Card>
  );
}
