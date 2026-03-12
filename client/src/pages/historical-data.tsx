import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin, Flame, TrendingUp, Package, Search } from "lucide-react";
import { useState } from "react";

type DestSummary = {
  destination: string;
  city: string;
  state: string;
  totalLoads: number;
  avgWeekly: number;
  maxWeekly: number;
  weekCount: number;
  isHotZone: boolean;
};

type SummaryResponse = {
  summary: DestSummary[];
  totalRows: number;
  uploadCount: number;
};

export default function HistoricalData() {
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/historical-data-summary"],
  });

  const filtered = (data?.summary || []).filter(d =>
    d.destination.toLowerCase().includes(search.toLowerCase())
  );

  const hotZones = filtered.filter(d => d.isHotZone);
  const others = filtered.filter(d => !d.isHotZone);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Historical Data</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Delivery destination frequency from uploaded dispatch data — ranked by weekly load volume.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : !data || data.totalRows === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-muted-foreground">No historical data uploaded yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Upload dispatch data on the Numbers page to see delivery patterns here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Loads</p>
                <p className="text-2xl font-bold mt-1" data-testid="stat-total-loads">{data.totalRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Unique Destinations</p>
                <p className="text-2xl font-bold mt-1" data-testid="stat-unique-destinations">{data.summary.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Flame className="h-3 w-3 text-orange-500" /> Hot Zones
                </p>
                <p className="text-2xl font-bold mt-1 text-orange-500" data-testid="stat-hot-zones">{data.summary.filter(d => d.isHotZone).length}</p>
              </CardContent>
            </Card>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              data-testid="input-destination-search"
              placeholder="Filter destinations..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {hotZones.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-orange-500" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-orange-500">Hot Zones — 5+ loads/week</h2>
              </div>
              <Card>
                <div className="divide-y">
                  {hotZones.map((dest, i) => (
                    <div
                      key={dest.destination}
                      data-testid={`row-hot-zone-${i}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-5 text-right">{i + 1}</span>
                        <MapPin className="h-4 w-4 text-orange-500 flex-shrink-0" />
                        <div>
                          <p className="font-medium text-sm" data-testid={`text-destination-${i}`}>{dest.destination}</p>
                          <p className="text-xs text-muted-foreground">{dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm font-semibold text-orange-500" data-testid={`text-avg-weekly-${i}`}>{dest.avgWeekly} avg/wk</p>
                          <p className="text-xs text-muted-foreground">peak {dest.maxWeekly}/wk</p>
                        </div>
                        <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0">
                          <Flame className="h-3 w-3 mr-1" /> Hot
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {others.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All Destinations</h2>
              </div>
              <Card>
                <div className="divide-y">
                  {others.map((dest, i) => (
                    <div
                      key={dest.destination}
                      data-testid={`row-destination-${i}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-5 text-right">{hotZones.length + i + 1}</span>
                        <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div>
                          <p className="font-medium text-sm">{dest.destination}</p>
                          <p className="text-xs text-muted-foreground">{dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold">{dest.avgWeekly} avg/wk</p>
                        <p className="text-xs text-muted-foreground">peak {dest.maxWeekly}/wk</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {filtered.length === 0 && search && (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground text-sm">No destinations match &ldquo;{search}&rdquo;</p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
