import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react";

type WeekBucket = { weekStart: string; inbound: number; outbound: number; missed: number };
type RepBucket = { repId: string; repName: string; inbound: number; outbound: number; missed: number; total: number };
type Trendline = {
  companyId: string;
  days: number;
  totals: { inbound: number; outbound: number; missed: number; total: number };
  weeks: WeekBucket[];
  byRep: RepBucket[];
};

type Direction = "all" | "inbound" | "outbound" | "missed";

const DIR_COLORS: Record<Exclude<Direction, "all">, string> = {
  inbound: "bg-blue-500",
  outbound: "bg-emerald-500",
  missed: "bg-red-500",
};

export function CallActivityTrendline({ companyId }: { companyId: string }) {
  const [days, setDays] = useState(90);
  const [direction, setDirection] = useState<Direction>("all");
  const [repFilter, setRepFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<Trendline>({
    queryKey: ["/api/calls/trendline/company", companyId, days, repFilter],
    queryFn: async () => {
      const qs = new URLSearchParams({ days: String(days) });
      if (repFilter !== "all") qs.set("repId", repFilter);
      const res = await fetch(`/api/calls/trendline/company/${companyId}?${qs.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load call trendline");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  // Always-unfiltered query purely to populate the rep dropdown, so selecting
  // a rep (which scopes the main query server-side) doesn't cause other reps
  // to disappear from the list.
  const { data: allRepsData } = useQuery<Trendline>({
    queryKey: ["/api/calls/trendline/company", companyId, days, "__allReps"],
    queryFn: async () => {
      const res = await fetch(`/api/calls/trendline/company/${companyId}?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load rep list");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  // When repFilter changes we refetch the server-side rep-scoped trendline,
  // so the weekly buckets already reflect the selected rep.
  const filteredWeeks = useMemo(() => data?.weeks ?? ([] as WeekBucket[]), [data]);

  const maxWeekTotal = useMemo(() => {
    if (filteredWeeks.length === 0) return 1;
    let max = 0;
    for (const w of filteredWeeks) {
      const v = direction === "all" ? (w.inbound + w.outbound + w.missed)
        : direction === "inbound" ? w.inbound
        : direction === "outbound" ? w.outbound
        : w.missed;
      if (v > max) max = v;
    }
    return Math.max(1, max);
  }, [filteredWeeks, direction]);

  if (isLoading) {
    return (
      <Card data-testid="card-call-activity-trendline">
        <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><PhoneCall className="h-4 w-4 text-blue-600 dark:text-blue-400" />Call Activity</CardTitle></CardHeader>
        <CardContent className="pt-0"><div className="h-32 animate-pulse rounded bg-muted" /></CardContent>
      </Card>
    );
  }

  if (!data || data.totals.total === 0) {
    return (
      <Card data-testid="card-call-activity-trendline">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Call Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">No Webex calls recorded in the last {days} days.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-call-activity-trendline">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Call Activity
            <span className="text-xs text-muted-foreground font-normal">({days}d · weekly)</span>
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
              <SelectTrigger className="h-7 text-xs w-[90px]" data-testid="select-call-trend-days"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
            <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
              <SelectTrigger className="h-7 text-xs w-[110px]" data-testid="select-call-trend-direction"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
                <SelectItem value="missed">Missed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Totals chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="gap-1" data-testid="badge-inbound-total">
            <PhoneIncoming className="h-3 w-3 text-blue-500" />
            {data.totals.inbound} in
          </Badge>
          <Badge variant="outline" className="gap-1" data-testid="badge-outbound-total">
            <PhoneOutgoing className="h-3 w-3 text-emerald-500" />
            {data.totals.outbound} out
          </Badge>
          <Badge variant="outline" className="gap-1" data-testid="badge-missed-total">
            <PhoneMissed className="h-3 w-3 text-red-500" />
            {data.totals.missed} missed
          </Badge>
          <span className="text-xs text-muted-foreground ml-auto">{data.totals.total} total calls</span>
        </div>

        {/* Weekly stacked bars */}
        <div className="flex items-end gap-1 h-28" data-testid="chart-weekly-trendline">
          {filteredWeeks.map((w) => {
            const inPct = (w.inbound / maxWeekTotal) * 100;
            const outPct = (w.outbound / maxWeekTotal) * 100;
            const missedPct = (w.missed / maxWeekTotal) * 100;
            const showIn = direction === "all" || direction === "inbound";
            const showOut = direction === "all" || direction === "outbound";
            const showMissed = direction === "all" || direction === "missed";
            const total = w.inbound + w.outbound + w.missed;
            return (
              <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1 group relative" data-testid={`bar-week-${w.weekStart}`}>
                <div className="w-full flex-1 flex flex-col-reverse justify-start">
                  {showIn && w.inbound > 0 && (
                    <div className={`${DIR_COLORS.inbound} rounded-t-sm`} style={{ height: `${inPct}%`, minHeight: "2px" }} />
                  )}
                  {showOut && w.outbound > 0 && (
                    <div className={`${DIR_COLORS.outbound}`} style={{ height: `${outPct}%`, minHeight: "2px" }} />
                  )}
                  {showMissed && w.missed > 0 && (
                    <div className={`${DIR_COLORS.missed}`} style={{ height: `${missedPct}%`, minHeight: "2px" }} />
                  )}
                </div>
                <div className="absolute -top-7 hidden group-hover:block bg-popover text-popover-foreground text-[10px] rounded px-1.5 py-0.5 shadow-md border whitespace-nowrap z-10">
                  {new Date(w.weekStart + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}: {total} ({w.inbound}/{w.outbound}/{w.missed})
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${DIR_COLORS.inbound}`} />Inbound</span>
          <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${DIR_COLORS.outbound}`} />Outbound</span>
          <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${DIR_COLORS.missed}`} />Missed</span>
        </div>

        {/* Per-rep breakdown */}
        {data.byRep.length > 0 && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">By Rep</p>
              <Select value={repFilter} onValueChange={setRepFilter}>
                <SelectTrigger className="h-6 text-[11px] w-[130px]" data-testid="select-call-trend-rep"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All reps</SelectItem>
                  {(allRepsData?.byRep ?? data.byRep).map(r => (
                    <SelectItem key={r.repId} value={r.repId}>{r.repName || "Unknown"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              {(repFilter === "all" ? data.byRep : data.byRep.filter(r => r.repId === repFilter)).map(r => {
                const inPct = r.total > 0 ? (r.inbound / r.total) * 100 : 0;
                const outPct = r.total > 0 ? (r.outbound / r.total) * 100 : 0;
                const missedPct = r.total > 0 ? (r.missed / r.total) * 100 : 0;
                return (
                  <div key={r.repId} className="space-y-1" data-testid={`row-rep-${r.repId}`}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate">{r.repName || "Unknown"}</span>
                      <span className="text-muted-foreground">{r.total} ({r.inbound}/{r.outbound}/{r.missed})</span>
                    </div>
                    <div className="flex h-1.5 rounded-full overflow-hidden bg-muted">
                      <div className={DIR_COLORS.inbound} style={{ width: `${inPct}%` }} />
                      <div className={DIR_COLORS.outbound} style={{ width: `${outPct}%` }} />
                      <div className={DIR_COLORS.missed} style={{ width: `${missedPct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
