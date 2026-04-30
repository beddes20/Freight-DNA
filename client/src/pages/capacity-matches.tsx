// Capacity Matches (Task #844) — desktop-only inbound carrier truck-list view
// scoped under Available Freight. Shows ranked matches between parsed truck
// postings and open freight_opportunities, with rep / team scoping, state
// filters, and inline action buttons (contacted / booked / dismissed).

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tabs, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Sparkles, Truck, RefreshCw, Plus } from "lucide-react";

type ApiMatch = {
  match: {
    id: string;
    fitScore: number;
    reasons: string[];
    state: "new" | "contacted" | "booked" | "dismissed" | "stale";
    assignedRepId: string | null;
    notifiedAt: string | null;
    contactedAt: string | null;
    bookedAt: string | null;
    dismissedAt: string | null;
    dismissedReason: string | null;
    createdAt: string;
  };
  posting: {
    id: string;
    carrierNameRaw: string | null;
    originCity: string | null;
    originState: string | null;
    destCity: string | null;
    destState: string | null;
    destPreference: string | null;
    availableDate: string | null;
    availableThrough: string | null;
    equipment: string | null;
    rateAsk: string | null;
    notes: string | null;
    rawText: string | null;
    status: string;
  };
  opportunity: {
    id: string;
    origin: string;
    originState: string | null;
    destination: string;
    destinationState: string | null;
    equipmentType: string | null;
    pickupWindowStart: string;
    quotedRate: string | null;
    targetBuyRate: string | null;
    status: string;
  };
};

type ApiResponse = {
  scope: "mine" | "team";
  teamCapable: boolean;
  items: ApiMatch[];
  teamRollup: Array<{ assignedRepId: string | null; count: number }>;
};

const STATE_LABELS: Record<string, { label: string; tone: string }> = {
  new: { label: "New", tone: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  contacted: { label: "Contacted", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  booked: { label: "Booked", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  dismissed: { label: "Dismissed", tone: "bg-muted text-muted-foreground" },
  stale: { label: "Stale", tone: "bg-muted text-muted-foreground" },
};

function fmtLocation(city: string | null, state: string | null): string {
  if (city && state) return `${city}, ${state}`;
  return city ?? state ?? "—";
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

type StatsResponse = {
  postingsActive: number;
  matchesActive: number;
  matchesStrong: number;
  bookedToday: number;
  contactedToday: number;
  parsedToday: number;
};

function StatsBar() {
  const { data } = useQuery<StatsResponse>({
    queryKey: ["/api/capacity-matches/stats"],
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const cells: Array<[string, number, string]> = [
    ["Active postings", data.postingsActive, "stat-postings-active"],
    ["Open matches", data.matchesActive, "stat-matches-active"],
    ["Strong (≥75)", data.matchesStrong, "stat-matches-strong"],
    ["Parsed today", data.parsedToday, "stat-parsed-today"],
    ["Contacted today", data.contactedToday, "stat-contacted-today"],
    ["Booked today", data.bookedToday, "stat-booked-today"],
  ];
  return (
    <Card>
      <CardContent className="py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cells.map(([label, value, id]) => (
          <div key={label} className="flex flex-col" data-testid={id}>
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-xl font-semibold tabular-nums">{value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 75 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" :
    score >= 55 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" :
    "bg-muted text-muted-foreground";
  return (
    <Badge className={tone} data-testid={`badge-score-${score}`}>
      {score}
    </Badge>
  );
}

export default function CapacityMatchesPage() {
  const { toast } = useToast();
  const [scope, setScope] = useState<"mine" | "team">("team");
  const [stateFilter, setStateFilter] = useState<string>("active");
  const [minScore, setMinScore] = useState<string>("0");
  const [equipment, setEquipment] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [dismissOpen, setDismissOpen] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");

  const statesParam = stateFilter === "active" ? "new,contacted" :
    stateFilter === "all" ? "new,contacted,booked,dismissed,stale" : stateFilter;

  const queryKey = useMemo(
    () => ["/api/capacity-matches", { scope, statesParam, minScore, equipment, origin }],
    [scope, statesParam, minScore, equipment, origin],
  );

  const { data, isLoading, refetch, isFetching } = useQuery<ApiResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ scope, states: statesParam, minScore });
      if (equipment.trim()) params.set("equipment", equipment.trim());
      if (origin.trim()) params.set("origin", origin.trim());
      const res = await fetch(`/api/capacity-matches?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const mutateState = useMutation({
    mutationFn: async (input: { id: string; state: string; dismissedReason?: string }) => {
      return apiRequest("PATCH", `/api/capacity-matches/${input.id}`, {
        state: input.state,
        dismissedReason: input.dismissedReason,
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/capacity-matches"] });
      toast({ title: `Marked ${vars.state}` });
      setDismissOpen(null);
      setDismissReason("");
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    },
  });

  const rematch = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/capacity-matches/rematch", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/capacity-matches"] });
      toast({ title: "Rematch complete" });
    },
    onError: (err: Error) => toast({ title: "Rematch failed", description: err.message, variant: "destructive" }),
  });

  const items = data?.items ?? [];

  return (
    <div className="container mx-auto px-6 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/available-freight"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            data-testid="link-back-available-freight"
          >
            <ArrowLeft className="size-3.5" />
            Back to Available Freight
          </Link>
          <h1 className="text-2xl font-semibold mt-1 flex items-center gap-2" data-testid="heading-capacity-matches">
            <Sparkles className="size-5 text-primary" />
            Capacity Matches
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Inbound carrier truck lists matched to your open freight. Strong matches notify the load's rep automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`size-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => rematch.mutate()}
            disabled={rematch.isPending}
            data-testid="button-rematch"
          >
            <Truck className="size-3.5 mr-1" />
            Rematch all
          </Button>
        </div>
      </div>

      <StatsBar />

      {/* Filters */}
      <Card>
        <CardContent className="py-4 flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <Tabs value={scope} onValueChange={v => setScope(v as "mine" | "team")}>
              <TabsList>
                <TabsTrigger value="team" data-testid="tab-scope-team" disabled={!data?.teamCapable && !!data}>
                  Team
                </TabsTrigger>
                <TabsTrigger value="mine" data-testid="tab-scope-mine">My matches</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">State</Label>
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="w-44" data-testid="select-state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active (New + Contacted)</SelectItem>
                <SelectItem value="new">New only</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="booked">Booked</SelectItem>
                <SelectItem value="dismissed">Dismissed</SelectItem>
                <SelectItem value="stale">Stale</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Min score</Label>
            <Input
              type="number"
              min={0}
              max={100}
              className="w-24"
              value={minScore}
              onChange={e => setMinScore(e.target.value)}
              data-testid="input-min-score"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Equipment</Label>
            <Input
              type="text"
              className="w-32"
              placeholder="Reefer, Van…"
              value={equipment}
              onChange={e => setEquipment(e.target.value)}
              data-testid="input-equipment-filter"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Origin</Label>
            <Input
              type="text"
              className="w-32"
              placeholder="TX or city…"
              value={origin}
              onChange={e => setOrigin(e.target.value)}
              data-testid="input-origin-filter"
            />
          </div>
          <div className="ml-auto text-sm text-muted-foreground" data-testid="text-result-count">
            {isLoading ? "Loading…" : `${items.length} match${items.length === 1 ? "" : "es"}`}
          </div>
        </CardContent>
      </Card>

      {/* Team rollup chips */}
      {data?.scope === "team" && data.teamRollup.length > 0 && (
        <Card>
          <CardContent className="py-3 flex flex-wrap gap-2">
            <span className="text-xs text-muted-foreground mr-2 self-center">Team rollup (active):</span>
            {data.teamRollup.map(r => (
              <Badge key={r.assignedRepId ?? "unassigned"} variant="outline" data-testid={`chip-rep-${r.assignedRepId ?? "unassigned"}`}>
                {r.assignedRepId ? r.assignedRepId.slice(0, 8) : "Unassigned"}: {r.count}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Matches table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Score</TableHead>
                <TableHead>Carrier truck</TableHead>
                <TableHead>Load</TableHead>
                <TableHead>Why it matches</TableHead>
                <TableHead className="w-28">State</TableHead>
                <TableHead className="w-72 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-20 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground" data-testid="text-empty-state">
                    No capacity matches yet. Inbound carrier truck-list emails will appear here automatically.
                  </TableCell>
                </TableRow>
              )}
              {items.map(({ match, posting, opportunity }) => {
                const stateMeta = STATE_LABELS[match.state] ?? STATE_LABELS.new;
                return (
                  <TableRow key={match.id} data-testid={`row-match-${match.id}`}>
                    <TableCell>
                      <ScoreBadge score={match.fitScore} />
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium" data-testid={`text-carrier-${match.id}`}>
                        {posting.carrierNameRaw ?? "Unknown carrier"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fmtLocation(posting.originCity, posting.originState)}
                        {posting.destPreference && ` → ${posting.destPreference}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fmtDate(posting.availableDate)}
                        {posting.availableThrough && ` – ${fmtDate(posting.availableThrough)}`}
                        {posting.equipment && ` · ${posting.equipment}`}
                        {posting.rateAsk && ` · $${posting.rateAsk} ask`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/available-freight/${opportunity.id}`}
                        className="text-sm font-medium hover:underline"
                        data-testid={`link-opportunity-${opportunity.id}`}
                      >
                        {fmtLocation(opportunity.origin, opportunity.originState)} → {fmtLocation(opportunity.destination, opportunity.destinationState)}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {fmtDate(opportunity.pickupWindowStart)}
                        {opportunity.equipmentType && ` · ${opportunity.equipmentType}`}
                        {opportunity.targetBuyRate && ` · target $${opportunity.targetBuyRate}`}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        {match.reasons.map((r, i) => (
                          <div key={i}>• {r}</div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={stateMeta.tone} data-testid={`badge-state-${match.id}`}>
                        {stateMeta.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {match.state !== "contacted" && match.state !== "booked" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => mutateState.mutate({ id: match.id, state: "contacted" })}
                            disabled={mutateState.isPending}
                            data-testid={`button-contacted-${match.id}`}
                          >
                            Contacted
                          </Button>
                        )}
                        {match.state !== "booked" && (
                          <Button
                            size="sm"
                            onClick={() => mutateState.mutate({ id: match.id, state: "booked" })}
                            disabled={mutateState.isPending}
                            data-testid={`button-booked-${match.id}`}
                          >
                            Booked
                          </Button>
                        )}
                        {match.state !== "dismissed" && match.state !== "booked" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDismissOpen(match.id)}
                            data-testid={`button-dismiss-${match.id}`}
                          >
                            Dismiss
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!dismissOpen} onOpenChange={open => !open && setDismissOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss match</DialogTitle>
            <DialogDescription>Optionally tell the team why this didn't fit. Not shown to the carrier.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Already covered, equipment mismatch, rate too high…"
            value={dismissReason}
            onChange={e => setDismissReason(e.target.value)}
            data-testid="textarea-dismiss-reason"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDismissOpen(null)} data-testid="button-cancel-dismiss">Cancel</Button>
            <Button
              onClick={() => dismissOpen && mutateState.mutate({ id: dismissOpen, state: "dismissed", dismissedReason: dismissReason || undefined })}
              disabled={mutateState.isPending}
              data-testid="button-confirm-dismiss"
            >
              Dismiss match
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
