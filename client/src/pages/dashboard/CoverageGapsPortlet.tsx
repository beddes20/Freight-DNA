import { useQuery } from "@tanstack/react-query";
import { Building2, MapPin, TrendingUp, AlertTriangle, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import type { PortletFreshness } from "@shared/schema";
import { decidePortletState } from "@/lib/portletState";
import { PortletStateBanner } from "@/components/dashboard/PortletStateBanner";

interface GapRow {
  companyId: string;
  companyName: string;
  facilityName: string;
  state: string;
  totalVolume: number;
  laneCount: number;
  rfpTitles: string[];
}

function volumeBadgeClass(vol: number): string {
  if (vol >= 1000) return "bg-red-500/15 text-red-400 border-red-500/30";
  if (vol >= 500)  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}

export function CoverageGapsPortlet() {
  const [, navigate] = useLocation();

  // Phase 1.5 S2: tolerate BOTH the legacy bare-array response and the new
  // { gaps, freshness } object shape so the server can ship the wrap
  // independently and roll back without breaking this portlet.
  const { data, isLoading } = useQuery<
    GapRow[] | { gaps: GapRow[]; freshness: PortletFreshness | null }
  >({
    queryKey: ["/api/dashboard/coverage-gaps"],
  });
  const gaps: GapRow[] = Array.isArray(data) ? data : (data?.gaps ?? []);
  const freshness: PortletFreshness | null = Array.isArray(data) ? null : (data?.freshness ?? null);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            RFP Coverage Gaps
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 bg-muted rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Phase 1.5 S6: when the list is empty, surface a banner if upstream is
  // unhealthy / unverifiable so reps don't mistake silent absence for
  // "nothing to do today". Healthy + empty still hides as before.
  const portletState = decidePortletState(gaps.length, freshness);
  if (portletState === "hidden") return null;
  if (portletState === "stale") {
    return (
      <PortletStateBanner
        state="stale"
        title="Coverage data may be stale"
        body="No gaps are showing, but the latest freight-data refresh looks unhealthy."
        lastUpdatedAt={freshness?.lastUpdatedAt ?? null}
        source={freshness?.source ?? null}
        testIdPrefix="coverage-gaps"
      />
    );
  }
  if (portletState === "unknown") {
    return (
      <PortletStateBanner
        state="unknown"
        title="Coverage freshness unavailable"
        body="No gaps are showing, but dashboard freshness could not be verified."
        lastUpdatedAt={freshness?.lastUpdatedAt ?? null}
        source={freshness?.source ?? null}
        testIdPrefix="coverage-gaps"
      />
    );
  }

  const handleClick = (companyId: string) => {
    localStorage.setItem("cd_tab", "rfp");
    navigate(`/companies/${companyId}`);
  };

  return (
    <Card data-testid="coverage-gaps-portlet">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            RFP Coverage Gaps
          </CardTitle>
          <span className="text-xs text-muted-foreground">{gaps.length} uncovered site{gaps.length !== 1 ? "s" : ""}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          High-volume RFP locations with no contact assigned — click to review lane coverage.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {gaps.map((gap, idx) => {
            const label = gap.state ? `${gap.facilityName}, ${gap.state}` : gap.facilityName;
            return (
              <div
                key={`${gap.companyId}-${gap.facilityName}-${gap.state}`}
                data-testid={`coverage-gap-row-${idx}`}
                className="flex items-center justify-between gap-3 bg-muted/50 rounded-lg px-3 py-2 hover:bg-muted cursor-pointer transition-colors group"
                onClick={() => handleClick(gap.companyId)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{label}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Building2 className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground truncate transition-colors">
                        {gap.companyName}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-xs px-1.5 py-0 font-mono ${volumeBadgeClass(gap.totalVolume)}`}
                  >
                    <TrendingUp className="w-2.5 h-2.5 mr-1" />
                    {gap.totalVolume.toLocaleString()}
                  </Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-muted-foreground">
                    <Layers className="w-2.5 h-2.5 mr-1" />
                    ×{gap.laneCount}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-3 text-center">
          Volume = loads/yr · ×N = lanes in RFP · Opens RFP & Lanes tab
        </p>
      </CardContent>
    </Card>
  );
}
