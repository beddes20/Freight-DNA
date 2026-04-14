import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Radio, ArrowRight, Zap } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

interface LaneAlert {
  lane: string;
  signal: string;
  action: string;
  severity: "high" | "medium" | "low";
}

interface MarketPulse {
  otri: number;
  ntiPerMile: number;
  flatbedOtri: number;
  flatbedSignal: string;
  dieselPerGal: number;
  timestamp: string;
  isStale: boolean;
}

interface IntelSnapshot {
  dailyInsights: {
    marketPulse: MarketPulse;
    laneAlerts: LaneAlert[];
    sonarIsStale: boolean;
    sonarTimestamp: string;
  };
}

function PulseMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center px-2 py-1.5 flex-1">
      <div className="text-sm font-bold text-white leading-none">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-white/50 mt-0.5">{label}</div>
    </div>
  );
}

export function IntelSnapshotPortlet() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery<IntelSnapshot>({
    queryKey: ["/api/intel"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: user?.role === "admin",
  });

  if (user?.role !== "admin") return null;

  if (isLoading) {
    return (
      <Card data-testid="portlet-intel-snapshot">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-500" /> Intel Snapshot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const { marketPulse, laneAlerts, sonarIsStale } = data.dailyInsights;
  const top3Alerts = laneAlerts.slice(0, 3);

  return (
    <Card data-testid="portlet-intel-snapshot">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Radio className="h-4 w-4 text-blue-500" /> Intel Snapshot
            {sonarIsStale && (
              <Badge
                variant="outline"
                className="text-[10px] text-amber-600 border-amber-300 cursor-help"
                title="Market data is temporarily cached. SONAR refreshes automatically every few hours — this is normal."
              >
                Cached
              </Badge>
            )}
          </CardTitle>
          <Link href="/intel" data-testid="link-view-full-intel">
            <span className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5 cursor-pointer">
              View Full Intel <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Market Pulse Strip */}
        <div className="rounded-lg overflow-hidden" style={{ background: "#0a1628" }}>
          <div className="flex divide-x divide-white/10">
            <PulseMetric label="OTRI" value={`${marketPulse.otri.toFixed(1)}%`} />
            <PulseMetric label="NTI/mi" value={`$${marketPulse.ntiPerMile.toFixed(2)}`} />
            <PulseMetric label="Flatbed" value={`${marketPulse.flatbedOtri.toFixed(1)}%`} />
            <PulseMetric label="Diesel" value={`$${marketPulse.dieselPerGal.toFixed(2)}`} />
          </div>
        </div>

        {/* Top Alerts */}
        {top3Alerts.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 text-amber-500" /> Lane Alerts
            </p>
            {top3Alerts.map((alert, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs border-l-2 ${
                  alert.severity === "high"
                    ? "bg-red-50 dark:bg-red-950/20 border-red-500"
                    : alert.severity === "medium"
                    ? "bg-amber-50 dark:bg-amber-950/20 border-amber-400"
                    : "bg-blue-50 dark:bg-blue-950/20 border-blue-400"
                }`}
                data-testid={`portlet-alert-${i}`}
              >
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-foreground">{alert.lane}</span>
                  <span className="text-muted-foreground ml-1">— {alert.signal}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Zap className="h-3.5 w-3.5 text-green-500 shrink-0" />
            All lanes looking good — no active alerts.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
