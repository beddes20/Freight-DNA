import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Trophy, TrendingUp, DollarSign } from "lucide-react";
import { RelationshipFreightCompanyPortlet } from "@/components/relationship-freight-portlet";
import { NextBestActionCard } from "@/components/next-best-action-card";
import { fmtMoney } from "@/lib/rep-utils";
import type { Rfp } from "@shared/schema";
import type { AccountPerf, MonthBucket } from "../types";

interface OverviewTabProps {
  accountPerf: AccountPerf | undefined;
  setShowTrends: (v: boolean) => void;
  companyRfps: Rfp[];
  rfpWon: number;
  rfpLost: number;
  rfpPending: number;
  rfpWinRate: number | null | false;
  totalAwardValue: number;
  companyId: string;
  companyName: string;
  onNbaLogTouch?: () => void;
  onNbaCreateTask?: () => void;
  onNbaViewRfp?: () => void;
}

export function OverviewTab({
  accountPerf,
  setShowTrends,
  companyRfps,
  rfpWon,
  rfpLost,
  rfpPending,
  rfpWinRate,
  totalAwardValue,
  companyId,
  companyName,
  onNbaLogTouch,
  onNbaCreateTask,
  onNbaViewRfp,
}: OverviewTabProps) {
  const fmtMonth = (key: string) => {
    const [y, mo] = key.split("-");
    return new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  const PerfGrid = ({ bucket, label }: { bucket: MonthBucket; label: string }) => {
    const marginPct = (bucket.totalRevenue ?? 0) > 0 ? (bucket.totalMargin / bucket.totalRevenue!) * 100 : null;
    return (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
        <div className={`grid gap-2 ${marginPct !== null ? "grid-cols-4" : "grid-cols-3"}`}>
          <div className="rounded-lg bg-muted/50 p-2.5 text-center">
            <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{bucket.totalLoads.toLocaleString()}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Total Loads</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5 text-center">
            <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{bucket.spotLoads.toLocaleString()}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Spot Loads</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5 text-center">
            <p className="text-xl font-bold text-green-600 dark:text-green-400">{fmtMoney(bucket.totalMargin)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Margin</p>
          </div>
          {marginPct !== null && (
            <div className="rounded-lg bg-muted/50 p-2.5 text-center">
              <p className={`text-xl font-bold ${marginPct < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>{marginPct.toFixed(1)}%</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Margin %</p>
            </div>
          )}
        </div>
        {bucket.totalLoads > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span>{Math.round((bucket.spotLoads / bucket.totalLoads) * 100)}% spot</span>
            <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
            <span>{Math.round(((bucket.totalLoads - bucket.spotLoads) / bucket.totalLoads) * 100)}% contract</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <NextBestActionCard
        companyId={companyId}
        onLogTouch={onNbaLogTouch}
        onCreateTask={onNbaCreateTask}
        onViewRfp={onNbaViewRfp}
      />

      {accountPerf && (
        <Card data-testid="card-account-performance">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Account Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            <PerfGrid bucket={accountPerf.ytd} label={`YTD (${new Date().getFullYear()})`} />
            <div className="border-t" />
            <PerfGrid bucket={accountPerf.lastMonth} label={fmtMonth(accountPerf.lastMonthKey)} />
            <div className="border-t" />
            <PerfGrid bucket={accountPerf.thisMonth} label={fmtMonth(accountPerf.thisMonthKey)} />
            <div className="border-t pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-foreground gap-2"
                onClick={() => setShowTrends(true)}
                data-testid="button-view-trends"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                View Historical Trends
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {companyRfps.length > 0 && (
        <Card data-testid="card-rfp-track-record">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500" />
              RFP Track Record
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-lg bg-muted/50 p-2">
                <p className="text-lg font-bold">{companyRfps.length}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Total</p>
              </div>
              <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-2">
                <p className="text-lg font-bold text-green-600 dark:text-green-400">{rfpWon}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Won</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-950/30 p-2">
                <p className="text-lg font-bold text-red-500 dark:text-red-400">{rfpLost}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Lost/Declined</p>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-2">
                <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{rfpPending}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Open</p>
              </div>
            </div>
            {rfpWinRate !== null && rfpWinRate !== false && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-semibold text-green-600 dark:text-green-400">{rfpWinRate}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${rfpWinRate}%` }} />
                </div>
              </div>
            )}
            {totalAwardValue > 0 && (
              <div className="flex items-center justify-between text-xs pt-1 border-t">
                <span className="text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" />Total Awarded Value</span>
                <span className="font-semibold">${totalAwardValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <RelationshipFreightCompanyPortlet companyId={companyId} companyName={companyName} />
    </>
  );
}
