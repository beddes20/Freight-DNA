import { useQuery } from "@tanstack/react-query";
import { Trophy, AlertTriangle, Clock, TruckIcon, HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";

interface AwardHealthRow {
  awardId: string;
  awardTitle: string;
  companyId: string;
  companyName: string;
  awardDate: string | null;
  awardAgeDays: number;
  laneCount: number;
  value: string | null;
  recentLoads: number;
  hasFinancialData: boolean;
}

function ageBadgeClass(days: number): string {
  if (days >= 90) return "bg-red-500/15 text-red-400 border-red-500/30";
  if (days >= 60) return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}

export function AwardHealthPortlet() {
  const [, navigate] = useLocation();

  const { data: awards = [], isLoading } = useQuery<AwardHealthRow[]>({
    queryKey: ["/api/dashboard/award-health"],
  });

  if (isLoading) {
    return (
      <Card className="bg-gray-900 border-gray-700">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            Award Lane Health
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

  if (awards.length === 0) return null;

  const handleClick = (companyId: string) => {
    // Pre-select the RFP tab (awards live there) so the AM lands in context
    localStorage.setItem("cd_tab", "rfp");
    navigate(`/companies/${companyId}`);
  };

  return (
    <Card className="bg-gray-900 border-gray-700" data-testid="award-health-portlet">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            Award Lane Health
          </CardTitle>
          <span className="text-xs text-gray-400">{awards.length} award{awards.length !== 1 ? "s" : ""} stalled</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Active awards with little or no freight activity — lanes may need a kickoff call.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {awards.map((row, idx) => (
            <div
              key={row.awardId}
              data-testid={`award-health-row-${idx}`}
              className="flex items-center justify-between gap-3 bg-gray-800/60 rounded-lg px-3 py-2 hover:bg-gray-800 cursor-pointer transition-colors group"
              onClick={() => handleClick(row.companyId)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-white truncate">{row.awardTitle}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-gray-400 truncate group-hover:text-gray-300 transition-colors">
                      {row.companyName}
                    </span>
                    {row.laneCount > 0 && (
                      <>
                        <span className="text-gray-600">·</span>
                        <TruckIcon className="w-3 h-3 text-gray-600 shrink-0" />
                        <span className="text-xs text-gray-500">{row.laneCount} lane{row.laneCount !== 1 ? "s" : ""}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!row.hasFinancialData ? (
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-gray-500 border-gray-600">
                    <HelpCircle className="w-2.5 h-2.5 mr-1" />
                    No data
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs px-1.5 py-0 text-gray-400 border-gray-600">
                    {row.recentLoads} load{row.recentLoads !== 1 ? "s" : ""}/60d
                  </Badge>
                )}
                <Badge variant="outline" className={`text-xs px-1.5 py-0 font-mono ${ageBadgeClass(row.awardAgeDays)}`}>
                  <Clock className="w-2.5 h-2.5 mr-1" />
                  {row.awardAgeDays}d
                </Badge>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-3 text-center">
          Age = days since award date · Opens RFP & Awards tab
        </p>
      </CardContent>
    </Card>
  );
}
