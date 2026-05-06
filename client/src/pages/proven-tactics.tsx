import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, Trophy, Clock, TrendingUp, AlertTriangle, CheckCircle2, XCircle, BarChart3, Sparkles, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProvenTactic {
  id: string;
  orgId: string;
  signalType: string;
  signalSubtype: string | null;
  tacticLabel: string;
  tacticSummary: string;
  exampleResponse: string | null;
  sourceMessageId: string | null;
  sourceSignalId: string | null;
  linkedAccountId: string | null;
  accountName: string | null;
  repUserId: string | null;
  repName: string | null;
  outcome: string;
  outcomeConfidence: number | null;
  timesUsed: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface TacticStats {
  totalTactics: number;
  wonTactics: number;
  pendingTactics: number;
  topSignalTypes: { signalType: string; count: number; avgSuccessRate: number }[];
}

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  objection: "Objection Handling",
  pricing_request: "Pricing Response",
  service_complaint: "Service Recovery",
  urgency_signal: "Urgency Response",
  new_opportunity: "Opportunity Capture",
  stalled_thread: "Re-engagement",
  positive_feedback: "Relationship Deepening",
  closed_won_indicator: "Closing Move",
  closed_lost_indicator: "Loss Recovery",
  conversation_spark_geography_expansion: "Geography Expansion",
  conversation_spark_new_stakeholder: "New Stakeholder",
};

function signalLabel(type: string): string {
  return SIGNAL_TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "won") {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-xs" data-testid="badge-outcome-won">
        <CheckCircle2 className="w-3 h-3 mr-1" /> Won
      </Badge>
    );
  }
  if (outcome === "lost") {
    return (
      <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 text-xs" data-testid="badge-outcome-lost">
        <XCircle className="w-3 h-3 mr-1" /> Lost
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-xs" data-testid="badge-outcome-pending">
      <Clock className="w-3 h-3 mr-1" /> Pending
    </Badge>
  );
}

function SuccessRateBar({ rate }: { rate: number }) {
  return (
    <div className="flex items-center gap-2" data-testid="success-rate-bar">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden max-w-[80px]">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            rate >= 70 ? "bg-emerald-500" : rate >= 40 ? "bg-amber-500" : "bg-red-400",
          )}
          style={{ width: `${rate}%` }}
        />
      </div>
      <span className="text-xs font-medium text-muted-foreground">{rate}%</span>
    </div>
  );
}

function TacticCard({ tactic, onRecordOutcome }: { tactic: ProvenTactic; onRecordOutcome: (id: string, outcome: "won" | "lost") => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card
      className="hover:shadow-md transition-shadow cursor-pointer"
      onClick={() => setExpanded(!expanded)}
      data-testid={`card-tactic-${tactic.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-xs" data-testid={`badge-signal-${tactic.id}`}>
                {signalLabel(tactic.signalType)}
              </Badge>
              <OutcomeBadge outcome={tactic.outcome} />
            </div>
            <h3 className="text-sm font-semibold text-foreground" data-testid={`text-tactic-label-${tactic.id}`}>
              {tactic.tacticLabel}
            </h3>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2" data-testid={`text-tactic-summary-${tactic.id}`}>
              {tactic.tacticSummary}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <SuccessRateBar rate={tactic.successRate ?? 0} />
            <span className="text-xs text-muted-foreground">
              Used {tactic.timesUsed}x
            </span>
          </div>
        </div>

        {expanded && (
          <div className="mt-3 pt-3 border-t space-y-3">
            {tactic.exampleResponse && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Example Response</p>
                <div className="bg-muted/50 rounded-md p-3 text-sm text-foreground whitespace-pre-wrap" data-testid={`text-example-${tactic.id}`}>
                  {tactic.exampleResponse}
                </div>
              </div>
            )}
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {tactic.accountName && <span>Account: {tactic.accountName}</span>}
              {tactic.repName && <span>Rep: {tactic.repName}</span>}
              <span>{new Date(tactic.createdAt).toLocaleDateString()}</span>
            </div>
            {tactic.outcome === "pending" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">Record outcome:</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-emerald-600 border-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                  onClick={(e) => { e.stopPropagation(); onRecordOutcome(tactic.id, "won"); }}
                  data-testid={`button-won-${tactic.id}`}
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Won
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-red-600 border-red-300 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={(e) => { e.stopPropagation(); onRecordOutcome(tactic.id, "lost"); }}
                  data-testid={`button-lost-${tactic.id}`}
                >
                  <XCircle className="w-3 h-3 mr-1" /> Lost
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ProvenTacticsPage() {
  const { toast } = useToast();
  const [filterSignalType, setFilterSignalType] = useState("all");
  const [filterOutcome, setFilterOutcome] = useState("all");

  const { data: statsData, isLoading: statsLoading } = useQuery<TacticStats>({
    queryKey: ["/api/internal/proven-tactics/stats"],
  });

  const { data: tacticsData, isLoading: tacticsLoading } = useQuery<{ tactics: ProvenTactic[] }>({
    queryKey: ["/api/internal/proven-tactics", filterSignalType, filterOutcome],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterSignalType !== "all") params.set("signalType", filterSignalType);
      if (filterOutcome !== "all") params.set("outcome", filterOutcome);
      const res = await fetch(`/api/internal/proven-tactics?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const outcomeMutation = useMutation({
    mutationFn: async ({ id, outcome }: { id: string; outcome: "won" | "lost" }) => {
      return apiRequest("POST", `/api/internal/proven-tactics/${id}/outcome`, { outcome });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/proven-tactics"] });
      toast({ title: "Outcome recorded", description: "Tactic outcome has been updated." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to record outcome.", variant: "destructive" });
    },
  });

  const tactics = tacticsData?.tactics ?? [];
  const stats = statsData;

  const signalTypes = [
    "closed_won_indicator", "closed_lost_indicator", "objection",
    "new_opportunity", "pricing_request", "stalled_thread",
    "positive_feedback", "service_complaint", "urgency_signal",
  ].sort((a, b) => signalLabel(a).localeCompare(signalLabel(b)));

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2" data-testid="text-page-title">
            <Lightbulb className="w-6 h-6 text-amber-500" />
            Proven Tactics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Response approaches that lead to wins — learned from your team's email conversations
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="stat-total">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-950">
              <BarChart3 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{statsLoading ? "—" : stats?.totalTactics ?? 0}</p>
              <p className="text-xs text-muted-foreground">Total Tactics</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-won">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950">
              <Trophy className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{statsLoading ? "—" : stats?.wonTactics ?? 0}</p>
              <p className="text-xs text-muted-foreground">Won Tactics</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-pending">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950">
              <Clock className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">{statsLoading ? "—" : stats?.pendingTactics ?? 0}</p>
              <p className="text-xs text-muted-foreground">Pending Outcome</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="stat-top-signal">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-950">
              <TrendingUp className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {statsLoading
                  ? "—"
                  : stats?.topSignalTypes?.[0]
                    ? signalLabel(stats.topSignalTypes[0].signalType)
                    : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Top Signal Type</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={filterSignalType} onValueChange={setFilterSignalType}>
          <SelectTrigger className="w-[200px] h-8 text-xs" data-testid="select-signal-type">
            <SelectValue placeholder="All signal types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All signal types</SelectItem>
            {signalTypes.map(st => (
              <SelectItem key={st} value={st}>{signalLabel(st)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterOutcome} onValueChange={setFilterOutcome}>
          <SelectTrigger className="w-[160px] h-8 text-xs" data-testid="select-outcome">
            <SelectValue placeholder="All outcomes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="won">Won</SelectItem>
            <SelectItem value="lost">Lost</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {tacticsLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : tactics.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Lightbulb className="w-12 h-12 text-amber-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No tactics captured yet</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Tactics are automatically learned from your email conversations. As your team responds to customer signals,
              the system captures which approaches work and surfaces them during future drafting.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="tactics-list">
          {tactics.map(tactic => (
            <TacticCard
              key={tactic.id}
              tactic={tactic}
              onRecordOutcome={(id, outcome) => outcomeMutation.mutate({ id, outcome })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
