import { useQuery } from "@tanstack/react-query";
import { Building2, MapPin, TrendingUp, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";

interface GapRow {
  companyId: string;
  companyName: string;
  facilityName: string;
  state: string;
  type: "origin" | "destination";
  totalVolume: number;
  laneCount: number;
  rfpTitles: string[];
}

function volumeBadge(vol: number): string {
  if (vol >= 1000) return "bg-red-500/15 text-red-400 border-red-500/30";
  if (vol >= 500)  return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}

export function CoverageGapsPortlet() {
  const [, navigate] = useLocation();

  const { data: gaps = [], isLoading } = useQuery<GapRow[]>({
    queryKey: ["/api/dashboard/coverage-gaps"],
  });

  if (isLoading) {
    return (
      <Card className="bg-gray-900 border-gray-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            RFP Coverage Gaps
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-800 rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (gaps.length === 0) return null;

  return (
    <Card className="bg-gray-900 border-gray-700" data-testid="coverage-gaps-portlet">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            RFP Coverage Gaps
          </CardTitle>
          <span className="text-xs text-gray-400">{gaps.length} uncovered site{gaps.length !== 1 ? "s" : ""}</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          High-volume RFP facilities with no contact assigned — relationship opportunity.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {gaps.map((gap, idx) => {
            const label = gap.state ? `${gap.facilityName}, ${gap.state}` : gap.facilityName;
            return (
              <div
                key={idx}
                data-testid={`coverage-gap-row-${idx}`}
                className="flex items-center justify-between gap-3 bg-gray-800/60 rounded-lg px-3 py-2 hover:bg-gray-800 cursor-pointer transition-colors group"
                onClick={() => navigate(`/companies/${gap.companyId}`)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-white truncate">{label}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Building2 className="w-3 h-3 text-gray-500 shrink-0" />
                      <span className="text-xs text-gray-400 truncate group-hover:text-gray-300 transition-colors">
                        {gap.companyName}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-xs px-1.5 py-0 font-mono ${volumeBadge(gap.totalVolume)}`}
                  >
                    <TrendingUp className="w-2.5 h-2.5 mr-1" />
                    {gap.totalVolume.toLocaleString()}
                  </Badge>
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-gray-400 border-gray-600">
                    {gap.type === "origin" ? "Orig" : "Dest"}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-3 text-center">
          Volume = loads/yr from RFP data · Click any row to open the account
        </p>
      </CardContent>
    </Card>
  );
}
