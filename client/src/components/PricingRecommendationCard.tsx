import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, AlertTriangle, Mail, Copy, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useCqOverlayPortal } from "@/lib/customer-quotes-portal";

type TierName = "aggressive" | "balanced" | "premium";

interface RecommendationTier {
  name: TierName;
  rate: number;
  estimatedWinProb: number;
  winProbSource: "history" | "default";
  sampleSize?: number;
  belowFloor: boolean;
  floorRate?: number;
  rationale: string;
}

interface PricingRecommendationDTO {
  available: boolean;
  reason?: string;
  marketBand?: { low: number; mid: number; high: number };
  bandSource?: "trac" | "history";
  miles?: number | null;
  equipment?: string;
  marginFloorRpm?: number;
  marginFloorRate?: number;
  tiers: RecommendationTier[];
  customerSampleSize: number;
  customerSweetSpot?: { label: string; winRate: number; sample: number };
}

interface DraftDTO { subject: string; body: string; to: string[] }

const fmt$ = (n: number) => `$${Math.round(n).toLocaleString()}`;

const TIER_LABELS: Record<TierName, string> = {
  aggressive: "Aggressive",
  balanced: "Balanced",
  premium: "Premium",
};

const TIER_TONES: Record<TierName, string> = {
  aggressive: "border-emerald-500/40 bg-emerald-500/5",
  balanced: "border-amber-500/40 bg-amber-500/5",
  premium: "border-violet-500/40 bg-violet-500/5",
};

export function PricingRecommendationCard({ quoteId }: { quoteId: string }) {
  const overlayPortal = useCqOverlayPortal();
  const { toast } = useToast();
  const [activeTier, setActiveTier] = useState<RecommendationTier | null>(null);
  const [draft, setDraft] = useState<DraftDTO | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  const recQuery = useQuery<PricingRecommendationDTO>({
    queryKey: ["/api/customer-quotes/quote", quoteId, "recommendation"],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/quote/${quoteId}/recommendation`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load recommendation");
      return await res.json() as PricingRecommendationDTO;
    },
    enabled: !!quoteId,
  });

  const draftMut = useMutation<DraftDTO, Error, RecommendationTier>({
    mutationFn: async (tier) => {
      const data = recQuery.data;
      const payload: Record<string, unknown> = {
        quoteId,
        recommendedRate: tier.rate,
        guidanceMessage: `${TIER_LABELS[tier.name]} tier — ${tier.rationale}`.trim(),
      };
      if (data?.marketBand) {
        payload.bandLow = data.marketBand.low;
        payload.bandMid = data.marketBand.mid;
        payload.bandHigh = data.marketBand.high;
        payload.bandSource = data.bandSource === "trac" ? "TRAC" : "internal";
      }
      const res = await apiRequest("POST", "/api/customer-quotes/spot/email-draft", payload);
      return await res.json() as DraftDTO;
    },
    onSuccess: (d, tier) => {
      setActiveTier(tier);
      setDraft(d);
    },
    onError: (err) => {
      toast({ title: "Could not draft email", description: err.message, variant: "destructive" });
    },
  });

  const data = recQuery.data;
  const anyBelowFloor = useMemo(() => (data?.tiers ?? []).some(t => t.belowFloor), [data]);

  if (recQuery.isLoading) {
    return (
      <div className="rounded border border-amber-500/30 bg-card p-3 space-y-2" data-testid="pricing-rec-loading">
        <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300 font-medium flex items-center gap-1">
          <Sparkles className="h-3 w-3" /> Pricing recommendation
        </div>
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (recQuery.isError || !data) {
    return null;
  }
  if (!data.available) {
    return (
      <div className="rounded border border-border bg-card p-3 text-xs text-muted-foreground" data-testid="pricing-rec-unavailable">
        <div className="text-[10px] uppercase tracking-wider text-foreground/70 font-medium flex items-center gap-1 mb-1">
          <Sparkles className="h-3 w-3" /> Pricing recommendation
        </div>
        {data.reason ?? "Not enough data yet for this lane."}
      </div>
    );
  }

  return (
    <>
      <div className="rounded border border-amber-500/30 bg-card p-3 space-y-2" data-testid="pricing-rec-card">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300 font-medium flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> Pricing recommendation
            {data.bandSource === "trac" ? (
              <span className="ml-1 px-1 rounded text-[9px] border bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40 font-medium" data-testid="badge-band-source">TRAC</span>
            ) : (
              <span className="ml-1 px-1 rounded text-[9px] border bg-muted text-muted-foreground border-border font-medium" data-testid="badge-band-source">history</span>
            )}
          </div>
          {data.marketBand && (
            <div className="text-[10px] text-muted-foreground tabular-nums" data-testid="text-market-band">
              {fmt$(data.marketBand.low)} / {fmt$(data.marketBand.mid)} / {fmt$(data.marketBand.high)}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5" data-testid="tier-grid">
          {data.tiers.map(t => (
            <div
              key={t.name}
              className={`rounded border p-2 ${TIER_TONES[t.name]}`}
              data-testid={`tier-${t.name}`}
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
                {TIER_LABELS[t.name]}
              </div>
              <div className="text-base font-bold text-foreground tabular-nums mt-0.5" data-testid={`tier-rate-${t.name}`}>
                {fmt$(t.rate)}
              </div>
              <div className="mt-1 flex items-center gap-1" title={t.winProbSource === "history" ? `${t.sampleSize} prior decided quotes` : "Default estimate (sparse history)"}>
                <div className="flex-1 h-1 rounded bg-muted overflow-hidden">
                  <div
                    className={`h-full ${t.estimatedWinProb >= 60 ? "bg-emerald-500" : t.estimatedWinProb >= 40 ? "bg-amber-500" : "bg-red-500"}`}
                    style={{ width: `${Math.min(100, Math.max(2, t.estimatedWinProb))}%` }}
                  />
                </div>
                <span className="text-[10px] text-foreground/80 tabular-nums" data-testid={`tier-winprob-${t.name}`}>
                  {t.estimatedWinProb}%
                </span>
              </div>
              <div className="text-[9px] text-muted-foreground mt-0.5">
                {t.winProbSource === "history" ? `n=${t.sampleSize}` : "est."}
              </div>
              {t.belowFloor && (
                <div className="mt-1 text-[9px] text-red-600 dark:text-red-400 flex items-center gap-0.5" data-testid={`tier-floor-warn-${t.name}`}>
                  <AlertTriangle className="h-2.5 w-2.5" /> Below {t.floorRate ? fmt$(t.floorRate) : "floor"}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-1.5 h-6 text-[10px] border-border hover:bg-muted px-1"
                onClick={() => draftMut.mutate(t)}
                disabled={draftMut.isPending}
                data-testid={`button-use-tier-${t.name}`}
              >
                <Mail className="h-2.5 w-2.5 mr-1" />
                {draftMut.isPending && draftMut.variables?.name === t.name ? "Drafting…" : "Use & draft"}
              </Button>
            </div>
          ))}
        </div>

        {anyBelowFloor && data.marginFloorRpm && (
          <div className="text-[10px] text-red-600 dark:text-red-400 flex items-center gap-1" data-testid="text-floor-summary">
            <AlertTriangle className="h-3 w-3" />
            Floor: {data.marginFloorRpm.toFixed(2)}/mi for {data.equipment}{data.miles ? ` · ${Math.round(data.miles)} mi` : ""}
          </div>
        )}

        {data.customerSweetSpot && (
          <div className="text-[10px] text-muted-foreground" data-testid="text-sweet-spot">
            Customer sweet spot: <span className="text-foreground font-medium">{data.customerSweetSpot.label}</span> ({data.customerSweetSpot.winRate}% win, n={data.customerSweetSpot.sample})
          </div>
        )}
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) { setDraft(null); setActiveTier(null); setCopyOk(false); } }}>
        <DialogContent container={overlayPortal} className="max-w-xl bg-background border-border" data-testid="dialog-pricing-draft">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              Draft email — {activeTier ? TIER_LABELS[activeTier.name] : ""} {activeTier ? fmt$(activeTier.rate) : ""}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Review and copy, or open in your mail client to send.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3 text-xs">
              <div>
                <Label htmlFor="draft-to" className="text-[10px] uppercase tracking-wider text-muted-foreground">To</Label>
                <Input
                  id="draft-to"
                  value={draft.to.join(", ")}
                  onChange={e => setDraft(d => d ? { ...d, to: e.target.value.split(/[;,]/).map(s => s.trim()).filter(Boolean) } : d)}
                  className="h-8 bg-background border-border text-xs"
                  data-testid="input-draft-to"
                />
              </div>
              <div>
                <Label htmlFor="draft-subject" className="text-[10px] uppercase tracking-wider text-muted-foreground">Subject</Label>
                <Input
                  id="draft-subject"
                  value={draft.subject}
                  onChange={e => setDraft(d => d ? { ...d, subject: e.target.value } : d)}
                  className="h-8 bg-background border-border text-xs"
                  data-testid="input-draft-subject"
                />
              </div>
              <div>
                <Label htmlFor="draft-body" className="text-[10px] uppercase tracking-wider text-muted-foreground">Body</Label>
                <Textarea
                  id="draft-body"
                  value={draft.body}
                  onChange={e => setDraft(d => d ? { ...d, body: e.target.value } : d)}
                  rows={12}
                  className="bg-background border-border text-xs font-mono"
                  data-testid="textarea-draft-body"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!draft) return;
                const text = `Subject: ${draft.subject}\n\n${draft.body}`;
                try {
                  await navigator.clipboard.writeText(text);
                  setCopyOk(true);
                  setTimeout(() => setCopyOk(false), 1500);
                } catch {
                  toast({ title: "Copy failed", description: "Clipboard unavailable", variant: "destructive" });
                }
              }}
              data-testid="button-copy-draft"
            >
              {copyOk ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
              {copyOk ? "Copied" : "Copy"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (!draft) return;
                const to = encodeURIComponent(draft.to.join(","));
                const subject = encodeURIComponent(draft.subject);
                const body = encodeURIComponent(draft.body);
                window.open(`mailto:${to}?subject=${subject}&body=${body}`, "_blank");
              }}
              data-testid="button-open-mail-client"
            >
              <ExternalLink className="h-3 w-3 mr-1" /> Open in mail client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
