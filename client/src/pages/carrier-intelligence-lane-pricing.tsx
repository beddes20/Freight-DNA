import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Compass, Search, Download, BookmarkPlus, History as HistoryIcon, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MoveStatusFilter, type MoveStatus } from "@/components/move-status-filter";
import { apiRequest } from "@/lib/queryClient";
import {
  useCarrierIntelPrefs, useSaveCarrierIntelPrefs,
  colorForConfidence, fmtRpm, fmtNum, downloadCsv,
} from "@/lib/carrier-intelligence";
import { useToast } from "@/hooks/use-toast";

interface BlendedRate {
  targetBuyRpm: number | null;
  suggestedSellRpm: number | null;
  expectedMarginPct: { low: number; high: number } | null;
  confidence: "high" | "medium" | "low" | "none";
  legs: {
    sonar: { ratePerMile: number | null; loads?: number; source?: string };
    history: {
      avgCostPerMile: number | null; medianCostPerMile: number | null;
      loads: number; loads30d: number; loads60d: number; loads90d: number;
      avgCost30d: number | null; avgCost60d: number | null; avgCost90d: number | null;
      fallbackTier: string;
    } | null;
  };
  historyFallbackTier: string;
  weights: { sonar: number; history: number };
  sonarWeightAutoBumped: boolean;
  refusedBelowThreshold: boolean;
  reason: string;
}

export default function CarrierIntelligenceLanePricingPage() {
  const { toast } = useToast();
  const prefsQ = useCarrierIntelPrefs();
  const savePrefs = useSaveCarrierIntelPrefs();
  const userPrefs = prefsQ.data?.user;

  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [originState, setOriginState] = useState("");
  const [destinationState, setDestinationState] = useState("");
  const [equipmentType, setEquipmentType] = useState("VAN");
  const [customer, setCustomer] = useState("");
  const [moveStatus, setMoveStatus] = useState<MoveStatus[]>(["realized"]);
  const [result, setResult] = useState<BlendedRate | null>(null);
  const [savedViewName, setSavedViewName] = useState("");

  const quoteMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams({ origin, destination, equipmentType });
      if (originState) params.set("originState", originState.toUpperCase());
      if (destinationState) params.set("destinationState", destinationState.toUpperCase());
      if (customer) params.set("customer", customer);
      const res = await fetch(`/api/carrier-intelligence/lane-pricing?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to compute lane pricing");
      }
      return res.json() as Promise<BlendedRate>;
    },
    onSuccess: (r) => {
      setResult(r);
      // Track recent searches for the "recent" rail.
      const recent = userPrefs?.lanePricing.recent ?? [];
      const next = [
        { origin, destination, equipmentType, customer, ts: Date.now() },
        ...recent.filter((e) => !(e.origin === origin && e.destination === destination && e.equipmentType === equipmentType)),
      ].slice(0, 8);
      savePrefs.mutate({
        lanePricing: { ...(userPrefs?.lanePricing as any), recent: next, savedViews: userPrefs?.lanePricing.savedViews ?? [] },
      } as any);
    },
    onError: (e: Error) => toast({ title: "Quote failed", description: e.message, variant: "destructive" }),
  });

  function submit() {
    if (!origin.trim() || !destination.trim()) {
      toast({ title: "Origin and destination required", variant: "destructive" });
      return;
    }
    quoteMutation.mutate();
  }
  function loadRecent(r: { origin: string; destination: string; equipmentType?: string; customer?: string }) {
    setOrigin(r.origin); setDestination(r.destination);
    setEquipmentType(r.equipmentType || "VAN");
    setCustomer(r.customer || "");
  }
  function saveCurrentView() {
    if (!savedViewName.trim()) return;
    const id = `v_${Date.now()}`;
    const next = [
      ...(userPrefs?.lanePricing.savedViews ?? []),
      { id, name: savedViewName.trim(), payload: { origin, destination, originState, destinationState, equipmentType, customer } },
    ];
    savePrefs.mutate({
      lanePricing: { ...(userPrefs?.lanePricing as any), savedViews: next },
    } as any);
    setSavedViewName("");
  }
  function applySavedView(id: string) {
    const v = userPrefs?.lanePricing.savedViews.find((x) => x.id === id);
    if (!v) return;
    const p = v.payload as any;
    setOrigin(p.origin || ""); setDestination(p.destination || "");
    setOriginState(p.originState || ""); setDestinationState(p.destinationState || "");
    setEquipmentType(p.equipmentType || "VAN");
    setCustomer(p.customer || "");
  }
  function exportCsv() {
    if (!result) return;
    const h = result.legs.history;
    downloadCsv(`lane-pricing-${origin}-${destination}-${new Date().toISOString().slice(0, 10)}.csv`, [{
      Origin: origin, Destination: destination,
      OriginState: originState, DestinationState: destinationState,
      Equipment: equipmentType, Customer: customer,
      TargetBuyRpm: result.targetBuyRpm, SuggestedSellRpm: result.suggestedSellRpm,
      Confidence: result.confidence,
      SonarRpm: result.legs.sonar.ratePerMile,
      HistMedianRpm: h?.medianCostPerMile, HistAvgRpm: h?.avgCostPerMile,
      HistLoads: h?.loads ?? 0, Hist30d: h?.loads30d ?? 0, Hist60d: h?.loads60d ?? 0, Hist90d: h?.loads90d ?? 0,
      FallbackTier: result.historyFallbackTier, Reason: result.reason,
    }]);
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1300px] mx-auto" data-testid="page-carrier-intelligence-lane-pricing">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Compass className="h-6 w-6 text-violet-500" /> Lane Pricing Intelligence
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Blend Sonar TRAC with your own realized lane history. Pricing math always runs against realized loads.
          </p>
        </div>
        {result && (
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <MoveStatusFilter
            value={moveStatus}
            onChange={setMoveStatus}
            lockedOn={["realized"]}
            hidden={["available"]}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <Label className="text-xs">Origin city</Label>
              <Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="Chicago" data-testid="input-origin" />
            </div>
            <div>
              <Label className="text-xs">Origin state</Label>
              <Input value={originState} onChange={(e) => setOriginState(e.target.value)} placeholder="IL" maxLength={2} data-testid="input-origin-state" />
            </div>
            <div>
              <Label className="text-xs">Destination city</Label>
              <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Atlanta" data-testid="input-destination" />
            </div>
            <div>
              <Label className="text-xs">Destination state</Label>
              <Input value={destinationState} onChange={(e) => setDestinationState(e.target.value)} placeholder="GA" maxLength={2} data-testid="input-destination-state" />
            </div>
            <div>
              <Label className="text-xs">Equipment</Label>
              <Input value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)} placeholder="VAN" data-testid="input-equipment" />
            </div>
            <div>
              <Label className="text-xs">Customer (optional)</Label>
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Acme Co" data-testid="input-customer" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={submit} disabled={quoteMutation.isPending} data-testid="button-quote">
              <Search className="h-4 w-4 mr-1" /> {quoteMutation.isPending ? "Computing…" : "Get blended rate"}
            </Button>
            <Input
              placeholder="Saved view name…"
              value={savedViewName}
              onChange={(e) => setSavedViewName(e.target.value)}
              className="w-48 h-9 text-sm"
              data-testid="input-saved-view-name"
            />
            <Button size="sm" variant="outline" onClick={saveCurrentView} disabled={!savedViewName.trim()} data-testid="button-save-view">
              <BookmarkPlus className="h-3.5 w-3.5 mr-1" /> Save view
            </Button>
            {(userPrefs?.lanePricing.savedViews ?? []).map((v) => (
              <Badge key={v.id} variant="outline" className="cursor-pointer hover:bg-accent" onClick={() => applySavedView(v.id)} data-testid={`chip-saved-view-${v.id}`}>
                {v.name}
              </Badge>
            ))}
          </div>
          {(userPrefs?.lanePricing.recent?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
              <span className="text-xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1"><HistoryIcon className="h-3 w-3" /> Recent</span>
              {(userPrefs?.lanePricing.recent ?? []).map((r, i) => (
                <Badge key={i} variant="outline" className="cursor-pointer hover:bg-accent" onClick={() => loadRecent(r)} data-testid={`chip-recent-${i}`}>
                  {r.origin} → {r.destination}{r.equipmentType ? ` · ${r.equipmentType}` : ""}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-1">
            <CardHeader className="py-3">
              <CardTitle className="text-base">Blended target</CardTitle>
              <CardDescription>{result.reason}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground">Target buy</div>
                <div className="text-3xl font-bold tabular-nums" data-testid="text-target-buy-rpm">{fmtRpm(result.targetBuyRpm)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Suggested sell</div>
                <div className="text-xl font-semibold tabular-nums" data-testid="text-suggested-sell-rpm">{fmtRpm(result.suggestedSellRpm)}</div>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Badge variant="outline" className={colorForConfidence(result.confidence)} data-testid="badge-confidence">
                  {result.confidence} confidence
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button className="text-muted-foreground hover:text-foreground" data-testid="button-explain-confidence">
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[20rem]">
                    <p className="text-xs">
                      Confidence reflects the spread between Sonar and your history, plus how many realized loads back the history leg
                      ({result.legs.history?.loads ?? 0} loads, fallback: {result.historyFallbackTier}).
                      {result.sonarWeightAutoBumped && " Sonar weight was auto-bumped because history was sparse."}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="text-xs text-muted-foreground">
                Weights — Sonar {(result.weights.sonar * 100).toFixed(0)}% / History {(result.weights.history * 100).toFixed(0)}%
              </div>
              {result.expectedMarginPct && (
                <div className="text-sm">
                  Expected margin band:{" "}
                  <span className="font-semibold tabular-nums" data-testid="text-margin-band">
                    {result.expectedMarginPct.low.toFixed(1)}% – {result.expectedMarginPct.high.toFixed(1)}%
                  </span>
                </div>
              )}
              {result.refusedBelowThreshold && (
                <Badge variant="outline" className="border-red-500/50 text-red-600 dark:text-red-400" data-testid="badge-refused">
                  Refused: too few realized loads
                </Badge>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3"><CardTitle className="text-base">Sonar TRAC</CardTitle></CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums" data-testid="text-sonar-rpm">{fmtRpm(result.legs.sonar.ratePerMile)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {result.legs.sonar.source ?? "DAT/Sonar comparable"} · {fmtNum(result.legs.sonar.loads)} comparable loads
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-base">Your realized history</CardTitle>
              <CardDescription>Fallback tier: {result.historyFallbackTier}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-3xl font-bold tabular-nums" data-testid="text-history-median-rpm">
                {fmtRpm(result.legs.history?.medianCostPerMile ?? null)}
              </div>
              <p className="text-xs text-muted-foreground">
                Median (avg {fmtRpm(result.legs.history?.avgCostPerMile ?? null)}) · {fmtNum(result.legs.history?.loads ?? 0)} loads in window
              </p>
              <Trend30_60_90
                d30={result.legs.history?.avgCost30d ?? null}
                d60={result.legs.history?.avgCost60d ?? null}
                d90={result.legs.history?.avgCost90d ?? null}
                n30={result.legs.history?.loads30d ?? 0}
                n60={result.legs.history?.loads60d ?? 0}
                n90={result.legs.history?.loads90d ?? 0}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Trend30_60_90({ d30, d60, d90, n30, n60, n90 }: {
  d30: number | null; d60: number | null; d90: number | null;
  n30: number; n60: number; n90: number;
}) {
  const points = [d30, d60, d90].map((v) => v == null ? null : Number(v));
  const numeric = points.filter((v): v is number => v != null);
  const min = numeric.length ? Math.min(...numeric) : 0;
  const max = numeric.length ? Math.max(...numeric) : 1;
  const range = Math.max(0.01, max - min);
  const w = 200, h = 36;
  const xs = [0, w / 2, w];
  const ys = points.map((v) => v == null ? null : h - ((v - min) / range) * h);
  const line = ys.map((y, i) => y == null ? null : `${i === 0 ? "M" : "L"}${xs[i]},${y}`).filter(Boolean).join(" ");
  return (
    <div className="pt-2" data-testid="trend-30-60-90">
      <svg width={w} height={h} className="text-violet-500">
        <path d={line} fill="none" stroke="currentColor" strokeWidth={2} />
        {ys.map((y, i) => y == null ? null : <circle key={i} cx={xs[i]} cy={y} r={3} fill="currentColor" />)}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
        <span>30d {fmtRpm(d30)} ({n30})</span>
        <span>60d {fmtRpm(d60)} ({n60})</span>
        <span>90d {fmtRpm(d90)} ({n90})</span>
      </div>
    </div>
  );
}
