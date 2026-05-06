import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, BarChart3, Download, Trophy, Clock, AlertTriangle } from "lucide-react";

interface PlayAnalytics {
  playId: string;
  name: string;
  audience: string;
  channel: string;
  status: string;
  completedRuns: number;
  successCount: number;
  failCount: number;
  noResponseCount: number;
  winRate: number | null;
  medianHours: number | null;
  topReps: { repUserId: string; repName: string; runs: number; wins: number }[];
}

export default function PlaybookAnalyticsPage() {
  const { data, isLoading, error } = useQuery<{ analytics: PlayAnalytics[] }>({
    queryKey: ["/api/playbook/analytics"],
    retry: false,
  });
  const rows = data?.analytics ?? [];
  const forbidden = (error as { status?: number } | null)?.status === 403
    || (error instanceof Error && /403|Manager\/Admin only/i.test(error.message));

  return (
    <div className="container mx-auto p-6 space-y-6" data-testid="page-playbook-analytics">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/playbook">
            <Button variant="ghost" size="sm" data-testid="link-back">
              <ArrowLeft className="h-4 w-4 mr-2" /> Back to Playbook
            </Button>
          </Link>
          <h1 className="text-2xl font-semibold flex items-center gap-2 mt-2">
            <BarChart3 className="h-6 w-6" /> Playbook Analytics
          </h1>
          <p className="text-sm text-muted-foreground">Win rate, time-to-outcome, and top performers per play.</p>
        </div>
        <a href="/api/playbook/analytics?format=csv" download>
          <Button variant="outline" size="sm" data-testid="button-export-csv">
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
        </a>
      </div>

      {forbidden ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground text-center">
            Playbook analytics is available to managers and admins.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground text-center">
            No play runs recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <Card key={r.playId} data-testid={`analytics-row-${r.playId}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  <span>{r.name}</span>
                  <Badge variant="outline" className="text-xs">{r.audience}</Badge>
                  <Badge variant="outline" className="text-xs">{r.channel}</Badge>
                  <Badge variant={r.status === "published" ? "default" : "secondary"} className="text-xs">{r.status}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-4">
                  <Metric label="Completed runs" value={String(r.completedRuns)} />
                  <Metric
                    label="Win rate"
                    value={r.winRate === null ? "—" : `${r.winRate}%`}
                    icon={<Trophy className="h-4 w-4 text-amber-500" />}
                  />
                  <Metric
                    label="Median time-to-outcome"
                    value={r.medianHours === null ? "—" : `${r.medianHours}h`}
                    icon={<Clock className="h-4 w-4 text-muted-foreground" />}
                  />
                  <Metric
                    label="Outcomes"
                    value={`${r.successCount}W · ${r.failCount}L · ${r.noResponseCount}NR`}
                  />
                </div>
                {r.topReps.length > 0 && (
                  <div className="mt-4 border-t pt-3">
                    <div className="text-xs uppercase text-muted-foreground mb-2">Top reps</div>
                    <div className="flex gap-2 flex-wrap">
                      {r.topReps.map(rep => (
                        <Badge key={rep.repUserId} variant="secondary" data-testid={`top-rep-${r.playId}-${rep.repUserId}`}>
                          {rep.repName} — {rep.wins}W / {rep.runs}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {r.completedRuns > 0 && r.winRate !== null && r.winRate < 25 && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-amber-700">
                    <AlertTriangle className="h-3 w-3" /> Low win rate — consider revising or archiving this play.
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
