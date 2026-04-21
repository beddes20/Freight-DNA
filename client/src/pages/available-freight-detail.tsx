import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, AlertTriangle, ShieldAlert, Truck, MapPin, Calendar,
  Pin, PinOff, ArrowUp, ArrowDown, Search, Info,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  Company, Carrier, FreightOpportunity, FreightOpportunityCarrier,
  FreightOpportunityAudit, FreightOpportunityBucket,
  FreightOpportunityExcludedReason,
} from "@shared/schema";

interface DetailResponse {
  opportunity: FreightOpportunity;
  carriers: FreightOpportunityCarrier[];
  audit: FreightOpportunityAudit[];
}

const BUCKET_LABELS: Record<FreightOpportunityBucket, string> = {
  proven: "Proven",
  strong_fit_underused: "Strong fit · underused",
  exploratory: "Exploratory",
  rep_added: "Rep-added",
};

const BUCKET_COLORS: Record<FreightOpportunityBucket, string> = {
  proven: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  strong_fit_underused: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  exploratory: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  rep_added: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
};

const BUCKET_DESCRIPTIONS: Record<FreightOpportunityBucket, string> = {
  proven: "Has hauled this lane or pattern before with good outcomes.",
  strong_fit_underused: "Good fit signals but limited recent volume — worth a fresh look.",
  exploratory: "Plausible match — gives the shortlist breadth.",
  rep_added: "Manually pinned by a rep, outside the scoring buckets.",
};

const BUCKET_ORDER: FreightOpportunityBucket[] = [
  "proven", "strong_fit_underused", "exploratory", "rep_added",
];

const EXCLUDED_LABELS: Record<FreightOpportunityExcludedReason, string> = {
  recent_contact: "Recently contacted",
  daily_cap: "Hit daily cap",
  not_approved: "Not on approved list",
  do_not_use: "Marked do-not-use",
  opted_out: "Opted out",
  rep_override: "Rep excluded",
  customer_carrier_blocked: "Customer-blocked",
};

function fmtWindow(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${s.toLocaleDateString(undefined, opts)} → ${e.toLocaleDateString(undefined, opts)}`;
}

function ExplanationChips({ row }: { row: FreightOpportunityCarrier }) {
  const chips: { label: string; tone?: "default" | "warn" }[] = [];
  const struct = (row.explanationStructured ?? null) as Record<string, unknown> | null;
  const snap = (row.responsivenessSnapshot ?? null) as Record<string, unknown> | null;

  if (row.historyMatch && row.historyMatch !== "none") {
    chips.push({ label: `History: ${String(row.historyMatch).replace(/_/g, " ")}` });
  }
  if (typeof row.fitScore === "number") {
    chips.push({ label: `Fit ${row.fitScore}` });
  }
  if (snap?.loadsOnLane) {
    chips.push({ label: `${snap.loadsOnLane} loads on lane` });
  }
  if (snap?.priorOutcomeBoost) {
    chips.push({ label: `Outcome boost +${snap.priorOutcomeBoost}` });
  }
  const suppress = Array.isArray(snap?.suppressionReasons) ? (snap!.suppressionReasons as string[]) : [];
  for (const reason of suppress) {
    chips.push({ label: reason.replace(/_/g, " "), tone: "warn" });
  }
  if (struct && typeof struct === "object") {
    for (const [k, v] of Object.entries(struct)) {
      if (k === "fitScore" || k === "historyMatch") continue;
      if (typeof v === "string" && v.length < 40) chips.push({ label: v });
    }
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {chips.slice(0, 6).map((c, i) => (
        <Badge
          key={i}
          variant="outline"
          className={c.tone === "warn"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 text-[10px]"
            : "text-[10px] text-muted-foreground"}
        >
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

function CarrierRow({
  row, rank, included, onToggleInclude, onPin, onMove, isFirstInBucket, isLastInBucket,
}: {
  row: FreightOpportunityCarrier & { _carrier?: Carrier | null };
  rank: number;
  included: boolean;
  onToggleInclude: (id: string, include: boolean) => void;
  onPin: (id: string, pin: boolean) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  isFirstInBucket: boolean;
  isLastInBucket: boolean;
}) {
  const carrier = row._carrier ?? null;
  const excluded = !!row.excludedReason;
  const isPinned = row.bucket === "rep_added";

  return (
    <div
      className={`flex items-start gap-3 px-3 py-2 border-b last:border-b-0 ${excluded ? "opacity-60" : ""}`}
      data-testid={`row-carrier-${row.id}`}
    >
      <div className="flex flex-col items-center gap-1 shrink-0 w-12">
        <div className="text-xs font-semibold tabular-nums" data-testid={`text-rank-${row.id}`}>
          #{rank}
        </div>
        <div className="flex flex-col gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            disabled={isFirstInBucket}
            onClick={() => onMove(row.id, -1)}
            data-testid={`button-move-up-${row.id}`}
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            disabled={isLastInBucket}
            onClick={() => onMove(row.id, 1)}
            data-testid={`button-move-down-${row.id}`}
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate" data-testid={`text-carrier-name-${row.id}`}>
            {carrier?.name ?? "Unknown carrier"}
          </span>
          {carrier?.mcDot && (
            <span className="text-[11px] text-muted-foreground">MC {carrier.mcDot}</span>
          )}
          {excluded && row.excludedReason && (
            <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30 text-[10px]">
              {EXCLUDED_LABELS[row.excludedReason as FreightOpportunityExcludedReason] ?? row.excludedReason}
            </Badge>
          )}
        </div>
        {row.explanation && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2" data-testid={`text-explanation-${row.id}`}>
            {row.explanation}
          </p>
        )}
        <ExplanationChips row={row} />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onPin(row.id, !isPinned)}
          title={isPinned ? "Unpin" : "Pin to top"}
          data-testid={`button-pin-${row.id}`}
        >
          {isPinned ? <PinOff className="h-4 w-4 text-amber-500" /> : <Pin className="h-4 w-4" />}
        </Button>
        <div className="flex items-center gap-1">
          <Switch
            checked={included}
            onCheckedChange={(v) => onToggleInclude(row.id, v)}
            data-testid={`switch-include-${row.id}`}
          />
          <span className="text-[10px] text-muted-foreground w-12">
            {included ? "Include" : "Exclude"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function AvailableFreightDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const { toast } = useToast();
  const [carrierSearch, setCarrierSearch] = useState("");

  const { data, isLoading, isError } = useQuery<DetailResponse>({
    queryKey: ["/api/freight-opportunities", id],
    queryFn: async () => {
      const res = await fetch(`/api/freight-opportunities/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const opp = data?.opportunity;
  const carriers = data?.carriers ?? [];

  const { data: company } = useQuery<Company>({
    queryKey: ["/api/companies", opp?.companyId],
    enabled: !!opp?.companyId,
    queryFn: async () => {
      const res = await fetch(`/api/companies/${opp!.companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const { data: allCarriers } = useQuery<Carrier[]>({ queryKey: ["/api/carriers"] });
  const carrierById = useMemo(() => {
    const m = new Map<string, Carrier>();
    (allCarriers ?? []).forEach(c => m.set(c.id, c));
    return m;
  }, [allCarriers]);

  const updateCarrierMutation = useMutation({
    mutationFn: async ({ carrierId, fields }: { carrierId: string; fields: Record<string, unknown> }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/freight-opportunities/${id}/carriers/${carrierId}`,
        fields,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
      // Queue counts (included/recommended) depend on this row's state.
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities"], exact: false });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't update carrier",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const swapCarrierMutation = useMutation({
    mutationFn: async ({ rowId, otherRowId }: { rowId: string; otherRowId: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/freight-opportunities/${id}/carriers/${rowId}/swap`,
        { otherRowId },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities"], exact: false });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't reorder carrier",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const grouped = useMemo(() => {
    const q = carrierSearch.trim().toLowerCase();
    const annotated = carriers.map(c => ({
      ...c,
      _carrier: carrierById.get(c.carrierId) ?? null,
    }));
    const filtered = !q ? annotated : annotated.filter(c => {
      const haystack = `${c._carrier?.name ?? ""} ${c._carrier?.mcDot ?? ""} ${c.explanation ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
    const buckets = new Map<FreightOpportunityBucket, typeof filtered>();
    for (const b of BUCKET_ORDER) buckets.set(b, []);
    for (const row of filtered) {
      const key = (row.bucket as FreightOpportunityBucket) || "exploratory";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    for (const [, rows] of buckets) {
      rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    }
    return buckets;
  }, [carriers, carrierById, carrierSearch]);

  const includedCount = carriers.filter(c => !c.excludedReason).length;
  const totalCount = carriers.length;

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 space-y-4 max-w-screen-xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !opp) {
    return (
      <div className="container mx-auto p-4 max-w-screen-xl">
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-2" />
            <p className="text-sm font-medium">Couldn't load this opportunity.</p>
            <Link href="/available-freight">
              <Button variant="outline" size="sm" className="mt-3" data-testid="button-back-to-queue">
                <ArrowLeft className="h-4 w-4 mr-2" /> Back to queue
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-screen-xl">
      <div>
        <Link href="/available-freight">
          <Button variant="ghost" size="sm" data-testid="button-back-to-queue">
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to queue
          </Button>
        </Link>
      </div>

      {opp.confidenceFlag === "low" && (
        <Card className="border-amber-500/50 bg-amber-500/5" data-testid="banner-low-confidence">
          <CardContent className="flex items-start gap-3 py-3">
            <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-300">Low confidence shortlist</p>
              <p className="text-xs text-amber-700/90 dark:text-amber-300/90">
                Few proven carriers matched. Review the bucket mix carefully before sending.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-xl flex items-center gap-2">
                <Truck className="h-5 w-5" />
                {company ? (
                  <Link href={`/companies/${company.id}`} className="hover:underline" data-testid="link-company">
                    {company.name}
                  </Link>
                ) : "Customer"}
              </CardTitle>
              <CardDescription className="flex items-center gap-2 flex-wrap text-xs mt-1">
                <Badge variant="secondary" data-testid="badge-mode">
                  {opp.mode === "exact_load" ? "Exact load" : "Lane building"}
                </Badge>
                <Badge variant="outline" data-testid="badge-status">{opp.status.replace(/_/g, " ")}</Badge>
                <span className="text-muted-foreground">
                  Generated {new Date(opp.generatedAt).toLocaleString()}
                </span>
              </CardDescription>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>Loads in this opportunity</div>
              <div className="text-2xl font-semibold tabular-nums text-foreground" data-testid="text-load-count">
                {opp.loadCount}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Lane</div>
                <div className="font-medium" data-testid="text-detail-lane">
                  {opp.origin} → {opp.destination}
                </div>
                {opp.equipmentType && (
                  <div className="text-xs text-muted-foreground mt-0.5">{opp.equipmentType}</div>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Pickup window</div>
                <div className="font-medium">
                  {fmtWindow(opp.pickupWindowStart, opp.pickupWindowEnd)}
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="text-xs text-muted-foreground">Shortlist</div>
                <div className="font-medium" data-testid="text-shortlist-count">
                  {includedCount} included · {totalCount - includedCount} excluded
                </div>
              </div>
            </div>
          </div>
          {opp.notes && (
            <div className="mt-4 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              {opp.notes}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Ranked carriers</CardTitle>
              <CardDescription className="text-xs">
                Grouped into buckets by fit. Excluded carriers stay visible so you can override.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Filter carriers"
                value={carrierSearch}
                onChange={(e) => setCarrierSearch(e.target.value)}
                data-testid="input-carrier-search"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {totalCount === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground" data-testid="state-empty-carriers">
              No carriers were ranked for this opportunity.
            </div>
          ) : Array.from(grouped.values()).every(rows => rows.length === 0) ? (
            <div className="py-12 text-center text-sm text-muted-foreground" data-testid="state-empty-carriers-filter">
              No carriers match "{carrierSearch}". Clear the filter to see all {totalCount}.
            </div>
          ) : (
            <div className="divide-y">
              {BUCKET_ORDER.map(bucket => {
                const rows = grouped.get(bucket) ?? [];
                if (rows.length === 0) return null;
                return (
                  <div key={bucket} data-testid={`bucket-${bucket}`}>
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={BUCKET_COLORS[bucket]}>
                          {BUCKET_LABELS[bucket]}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {BUCKET_DESCRIPTIONS[bucket]}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {rows.length} carrier{rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {rows.map((row, idx) => (
                      <CarrierRow
                        key={row.id}
                        row={row}
                        rank={row.rank ?? idx + 1}
                        included={!row.excludedReason}
                        isFirstInBucket={idx === 0}
                        isLastInBucket={idx === rows.length - 1}
                        onToggleInclude={(carrierRowId, include) => {
                          updateCarrierMutation.mutate({
                            carrierId: carrierRowId,
                            fields: { excludedReason: include ? null : "rep_override" },
                          });
                        }}
                        onPin={(carrierRowId, pin) => {
                          updateCarrierMutation.mutate({
                            carrierId: carrierRowId,
                            fields: { bucket: pin ? "rep_added" : "exploratory" },
                          });
                        }}
                        onMove={(carrierRowId, dir) => {
                          const swapWith = rows[idx + dir];
                          if (!swapWith) return;
                          swapCarrierMutation.mutate({
                            rowId: carrierRowId,
                            otherRowId: swapWith.id,
                          });
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {data?.audit && data.audit.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-xs" data-testid="list-audit">
              {data.audit.slice(-10).reverse().map(a => (
                <li key={a.id} className="flex items-baseline gap-2">
                  <span className="text-muted-foreground tabular-nums w-32 shrink-0">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                  <span className="font-medium">{a.eventType.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
