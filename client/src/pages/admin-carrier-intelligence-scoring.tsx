import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RefreshCw, Settings, BarChart3 } from "lucide-react";

type FallbackTier = "lane_customer_trailer" | "lane_customer" | "lane_trailer" | "lane" | "nearby_lane" | "state_pair" | "trailer_benchmark";

interface PerCustomerOverride { sonarWeight?: number; minHistoryLoads?: number }

interface BlendCfg {
  sonarWeight: number;
  minHistoryLoads: number;
  highConfidenceSpreadPct: number;
  refreshIntervalHours: number;
  sparseHistoryMultiplier: number;
  sonarSparseBumpAmount: number;
  fallbackOrder: FallbackTier[];
  perCustomerOverrides: Record<string, PerCustomerOverride>;
}
interface ConfidenceChips {
  greenMinLoads: number;
  greenMaxSpreadPct: number;
  yellowMinLoads: number;
}
interface ThresholdsCfg {
  tierAMinScore: number;
  tierBMinScore: number;
  recencyDecayDays: number;
  refusalRateThreshold: number;
  refusalMinLoads: number;
  minLaneFitForTopRank: number;
  confidenceChips: ConfidenceChips;
}
interface ScoringResp {
  blend: BlendCfg;
  thresholds: ThresholdsCfg;
  counts: { scorecards: string; lanes: string; recs: string };
  lastComputedAt: string | null;
}
interface RecomputeSummary {
  scorecardsWritten: number;
  laneRowsWritten: number;
  recommendations: { processed: number; failed: number };
  durationMs: number;
  error?: string;
}

const DEFAULT_BLEND: BlendCfg = {
  sonarWeight: 0.65,
  minHistoryLoads: 3,
  highConfidenceSpreadPct: 8,
  refreshIntervalHours: 24,
  sparseHistoryMultiplier: 2,
  sonarSparseBumpAmount: 0.15,
  fallbackOrder: ["lane_customer_trailer", "lane_customer", "lane_trailer", "lane", "nearby_lane", "state_pair", "trailer_benchmark"],
  perCustomerOverrides: {},
};
const DEFAULT_THRESHOLDS: ThresholdsCfg = {
  tierAMinScore: 75,
  tierBMinScore: 50,
  recencyDecayDays: 90,
  refusalRateThreshold: 0.6,
  refusalMinLoads: 2,
  minLaneFitForTopRank: 50,
  confidenceChips: { greenMinLoads: 5, greenMaxSpreadPct: 8, yellowMinLoads: 2 },
};

export default function AdminCarrierIntelligenceScoringPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ScoringResp>({ queryKey: ["/api/admin/carrier-intelligence/scoring"] });
  const [blend, setBlend] = useState<BlendCfg | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdsCfg | null>(null);
  const [skipRecs, setSkipRecs] = useState(false);
  const [overridesText, setOverridesText] = useState<string | null>(null);
  const [overridesError, setOverridesError] = useState<string | null>(null);

  const eff: BlendCfg = blend ?? data?.blend ?? DEFAULT_BLEND;
  const effT: ThresholdsCfg = thresholds ?? data?.thresholds ?? DEFAULT_THRESHOLDS;

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Parse overrides JSON one last time before sending.
      let blendOut = eff;
      if (overridesText !== null) {
        try {
          const parsed = JSON.parse(overridesText);
          if (parsed && typeof parsed === "object") {
            blendOut = { ...eff, perCustomerOverrides: parsed };
            setOverridesError(null);
          } else throw new Error("Must be a JSON object");
        } catch (e) {
          setOverridesError((e as Error).message);
          throw new Error("Per-customer overrides JSON is invalid");
        }
      }
      return apiRequest("PUT", "/api/admin/carrier-intelligence/scoring", { blend: blendOut, thresholds: effT });
    },
    onSuccess: () => {
      toast({ title: "Settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/carrier-intelligence/scoring"] });
      setBlend(null); setThresholds(null); setOverridesText(null); setOverridesError(null);
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e?.message ?? "", variant: "destructive" }),
  });

  const recomputeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/carrier-intelligence/recompute", { skipRecommendations: skipRecs });
      return (await res.json()) as { ok: boolean; summary: RecomputeSummary };
    },
    onSuccess: (r) => {
      toast({
        title: "Recompute complete",
        description: `Wrote ${r.summary.scorecardsWritten} scorecards, ${r.summary.laneRowsWritten} lane rows, ${r.summary.recommendations.processed} recs in ${(r.summary.durationMs / 1000).toFixed(1)}s.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/carrier-intelligence/scoring"] });
    },
    onError: (e: Error) => toast({ title: "Recompute failed", description: e?.message ?? "", variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading scoring settings…
      </div>
    );
  }

  const overridesView = overridesText ?? JSON.stringify(eff.perCustomerOverrides ?? {}, null, 2);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Settings className="h-6 w-6" /> Carrier Intelligence — Scoring & Pricing</h1>
        <p className="text-muted-foreground mt-1">Tune the Sonar/history blend, sparse-data fallbacks, confidence chips, and refusal threshold. Settings apply to the next nightly rebuild and any manual recompute.</p>
      </div>

      <Card data-testid="card-counts">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" /> Status</CardTitle>
          <CardDescription>What's currently in the warehouse for your org.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Scorecards" value={data.counts.scorecards} testId="stat-scorecards" />
          <Stat label="Lane history rows" value={data.counts.lanes} testId="stat-lanes" />
          <Stat label="Recommendations" value={data.counts.recs} testId="stat-recs" />
          <Stat label="Last computed" value={data.lastComputedAt ? new Date(data.lastComputedAt).toLocaleString() : "—"} testId="stat-last" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pricing Blend</CardTitle>
          <CardDescription>Sonar TRAC weight controls how much we trust the live spot market vs our own realized history. Default 65/35.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberField label={`Sonar weight (history = ${(1 - eff.sonarWeight).toFixed(2)})`} step={0.05} min={0} max={1}
            value={eff.sonarWeight} onChange={v => setBlend({ ...eff, sonarWeight: v })} testId="input-sonar-weight" />
          <NumberField label="Minimum history loads to trust history leg" step={1} min={0} max={100}
            value={eff.minHistoryLoads} onChange={v => setBlend({ ...eff, minHistoryLoads: v })} testId="input-min-history" />
          <NumberField label="High-confidence spread (%) between Sonar & history" step={1} min={0} max={100}
            value={eff.highConfidenceSpreadPct} onChange={v => setBlend({ ...eff, highConfidenceSpreadPct: v })} testId="input-spread" />
          <NumberField label="Refresh cadence (hours) for nightly recompute" step={1} min={1} max={168}
            value={eff.refreshIntervalHours} onChange={v => setBlend({ ...eff, refreshIntervalHours: v })} testId="input-refresh-hours" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sparse-data Fallback</CardTitle>
          <CardDescription>How the engine reaches for nearby/state-pair/trailer-benchmark data when the exact lane lookup is thin, and how much extra weight to give Sonar when history is sparse.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberField label="Sparse-history multiplier (sparse if loads < min × multiplier)" step={0.5} min={1} max={10}
            value={eff.sparseHistoryMultiplier} onChange={v => setBlend({ ...eff, sparseHistoryMultiplier: v })} testId="input-sparse-mult" />
          <NumberField label="Sonar sparse-bump amount (added to Sonar weight when sparse)" step={0.05} min={0} max={0.5}
            value={eff.sonarSparseBumpAmount} onChange={v => setBlend({ ...eff, sonarSparseBumpAmount: v })} testId="input-sparse-bump" />
          <div>
            <Label className="text-sm">Fallback order (drag-free, comma-separated tiers)</Label>
            <Input
              value={eff.fallbackOrder.join(",")}
              onChange={e => {
                const parts = e.target.value.split(",").map(s => s.trim()).filter(Boolean) as FallbackTier[];
                setBlend({ ...eff, fallbackOrder: parts });
              }}
              data-testid="input-fallback-order"
            />
            <p className="text-xs text-muted-foreground mt-1">Allowed: lane_customer_trailer, lane_customer, lane_trailer, lane, nearby_lane, state_pair, trailer_benchmark.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-customer Blend Overrides</CardTitle>
          <CardDescription>JSON map keyed by customer name (case-insensitive). Each entry can override sonarWeight and/or minHistoryLoads for that customer only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={overridesView}
            onChange={e => { setOverridesText(e.target.value); setOverridesError(null); }}
            rows={6}
            className="font-mono text-xs"
            data-testid="input-customer-overrides"
            placeholder={'{"walmart": {"sonarWeight": 0.85}, "costco": {"minHistoryLoads": 1}}'}
          />
          {overridesError && <p className="text-xs text-destructive" data-testid="text-overrides-error">{overridesError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scoring Thresholds</CardTitle>
          <CardDescription>Tier cutoffs, recency decay, refusal threshold, and confidence chip rules for the carrier scorecard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NumberField label="Tier A minimum score" step={1} min={0} max={100}
            value={effT.tierAMinScore} onChange={v => setThresholds({ ...effT, tierAMinScore: v })} testId="input-tier-a" />
          <NumberField label="Tier B minimum score" step={1} min={0} max={100}
            value={effT.tierBMinScore} onChange={v => setThresholds({ ...effT, tierBMinScore: v })} testId="input-tier-b" />
          <NumberField label="Recency decay (days)" step={5} min={1} max={365}
            value={effT.recencyDecayDays} onChange={v => setThresholds({ ...effT, recencyDecayDays: v })} testId="input-recency" />
          <NumberField label="Refusal-rate exclusion threshold (0–1)" step={0.05} min={0} max={1}
            value={effT.refusalRateThreshold} onChange={v => setThresholds({ ...effT, refusalRateThreshold: v })} testId="input-refusal" />
          <NumberField label="Refusal min loads (don't suggest a rate when realized loads < N AND Sonar unavailable)" step={1} min={0} max={100}
            value={effT.refusalMinLoads} onChange={v => setThresholds({ ...effT, refusalMinLoads: v })} testId="input-refusal-min-loads" />
          <NumberField label="Min lane-fit score for top rank (carriers below this only appear as flagged fallbacks)" step={5} min={0} max={100}
            value={effT.minLaneFitForTopRank} onChange={v => setThresholds({ ...effT, minLaneFitForTopRank: v })} testId="input-min-lane-fit" />
          <Separator />
          <p className="text-sm font-medium">Confidence chips (UI red/yellow/green)</p>
          <NumberField label="Green: minimum history loads required" step={1} min={0} max={100}
            value={effT.confidenceChips.greenMinLoads}
            onChange={v => setThresholds({ ...effT, confidenceChips: { ...effT.confidenceChips, greenMinLoads: v } })}
            testId="input-chip-green-loads" />
          <NumberField label="Green: maximum spread %" step={1} min={0} max={100}
            value={effT.confidenceChips.greenMaxSpreadPct}
            onChange={v => setThresholds({ ...effT, confidenceChips: { ...effT.confidenceChips, greenMaxSpreadPct: v } })}
            testId="input-chip-green-spread" />
          <NumberField label="Yellow: minimum history loads required" step={1} min={0} max={100}
            value={effT.confidenceChips.yellowMinLoads}
            onChange={v => setThresholds({ ...effT, confidenceChips: { ...effT.confidenceChips, yellowMinLoads: v } })}
            testId="input-chip-yellow-loads" />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => saveMutation.mutate()} disabled={(!blend && !thresholds && overridesText === null) || saveMutation.isPending} data-testid="button-save">
          {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save settings
        </Button>
        <Separator orientation="vertical" className="h-8" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={skipRecs} onChange={e => setSkipRecs(e.target.checked)} data-testid="checkbox-skip-recs" />
          Skip recommendations (faster)
        </label>
        <Button variant="secondary" onClick={() => recomputeMutation.mutate()} disabled={recomputeMutation.isPending} data-testid="button-recompute">
          <RefreshCw className={`h-4 w-4 mr-2 ${recomputeMutation.isPending ? "animate-spin" : ""}`} /> Recompute now
        </Button>
        {recomputeMutation.isPending && <Badge variant="outline">Running…</Badge>}
      </div>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-1" data-testid={testId}>{value}</div>
    </div>
  );
}

function NumberField({ label, value, onChange, step, min, max, testId }: {
  label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; testId: string;
}) {
  return (
    <div className="grid grid-cols-3 items-center gap-3">
      <Label className="col-span-2 text-sm">{label}</Label>
      <Input type="number" value={value} step={step} min={min} max={max}
        onChange={e => { const n = Number(e.target.value); if (isFinite(n)) onChange(n); }}
        data-testid={testId} />
    </div>
  );
}
