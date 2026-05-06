import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, Truck } from "lucide-react";
import { useLocation } from "wouter";

type Row = {
  companyId: string;
  companyName: string;
  contactCount: number;
  inbound: number;
  outbound: number;
  missed: number;
  total: number;
};
type Rollup = {
  lane: string;
  days: number;
  rows: Row[];
  totals: { inbound: number; outbound: number; missed: number; total: number; companies: number; contacts: number };
};

export function LaneCallRollup({ lane, days = 90 }: { lane: string; days?: number }) {
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<Rollup>({
    queryKey: ["/api/calls/lane-rollup", lane, days],
    queryFn: async () => {
      const res = await fetch(`/api/calls/lane-rollup?lane=${encodeURIComponent(lane)}&days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!lane,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Card data-testid="card-lane-call-rollup">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Truck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          Lane Call Activity
          <span className="text-xs font-normal text-muted-foreground">· {lane} · {days}d</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="h-16 animate-pulse rounded bg-muted" />
        ) : !data || data.totals.total === 0 ? (
          <p className="text-xs text-muted-foreground">No Webex calls tied to contacts on this lane in the last {days} days.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="gap-1" data-testid="badge-lane-inbound">
                <PhoneIncoming className="h-3 w-3 text-blue-500" />{data.totals.inbound}
              </Badge>
              <Badge variant="outline" className="gap-1" data-testid="badge-lane-outbound">
                <PhoneOutgoing className="h-3 w-3 text-emerald-500" />{data.totals.outbound}
              </Badge>
              <Badge variant="outline" className="gap-1" data-testid="badge-lane-missed">
                <PhoneMissed className="h-3 w-3 text-red-500" />{data.totals.missed}
              </Badge>
              <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                <PhoneCall className="h-3 w-3" />
                {data.totals.total} calls · {data.totals.companies} companies · {data.totals.contacts} contacts
              </span>
            </div>
            <div className="divide-y divide-border/50">
              {data.rows.slice(0, 10).map(row => (
                <div
                  key={row.companyId}
                  className="flex items-center gap-3 py-1.5 hover:bg-muted/40 rounded px-1 cursor-pointer"
                  onClick={() => navigate(`/companies/${row.companyId}`)}
                  data-testid={`row-lane-rollup-${row.companyId}`}
                >
                  <span className="text-xs font-medium text-foreground truncate flex-1 hover:underline">{row.companyName}</span>
                  <span className="text-[11px] text-muted-foreground">{row.contactCount} contact{row.contactCount === 1 ? "" : "s"}</span>
                  <span className="text-xs text-blue-600 dark:text-blue-400 w-8 text-right">{row.inbound}</span>
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 w-8 text-right">{row.outbound}</span>
                  <span className="text-xs text-red-600 dark:text-red-400 w-8 text-right">{row.missed}</span>
                  <Badge variant="outline" className="text-[11px]">{row.total}</Badge>
                </div>
              ))}
              {data.rows.length > 10 && (
                <p className="text-[11px] text-muted-foreground mt-1 pt-1">Showing top 10 of {data.rows.length} companies.</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function LaneCallRollupPicker({ lanes, days = 90 }: { lanes: { laneStr: string; volume: number }[]; days?: number }) {
  const [selected, setSelected] = useState(lanes[0]?.laneStr ?? "");
  if (lanes.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground">Lane Call Activity for:</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="h-7 text-xs w-[320px] max-w-full" data-testid="select-lane-rollup-lane">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {lanes.map(l => (
              <SelectItem key={l.laneStr} value={l.laneStr}>
                {l.laneStr} · {Math.round(l.volume).toLocaleString()} loads/yr
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected && <LaneCallRollup lane={selected} days={days} />}
    </div>
  );
}
