/**
 * Play recommendation card — Task #926 step 9.
 *
 * Renders a single `copilot_play_recommendations` row with HITL accept /
 * dismiss / snooze affordances. Never executes the embedded `draftAction`
 * automatically — calling `accept` only flips status; the user still sees
 * the action card before anything is sent.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Lightbulb, Check, X, Clock, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { EvidenceChip, type Evidence } from "./evidence-chip";

export interface PlayRecommendation {
  id: string;
  documentId: string | null;
  laneKey: string | null;
  customerId: string | null;
  playId: string;
  playName: string;
  rank: number;
  confidence: "high" | "medium" | "low";
  evidence: Evidence[];
  alternatives: Array<{ playId: string; playName: string; reason: string }>;
  draftAction: { tool: string; args: Record<string, unknown>; preface?: string } | null;
  rationale: string | null;
  status: string;
}

const CONF_BG: Record<string, string> = {
  high: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

export function PlayRecommendationCard({ rec, onResolved }: { rec: PlayRecommendation; onResolved?: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const mutation = useMutation({
    mutationFn: async (action: "accepted" | "dismissed" | "snoozed") => {
      const body: Record<string, unknown> = { action };
      if (action === "snoozed") body.snoozedUntil = new Date(Date.now() + 24 * 3600_000).toISOString();
      return await apiRequest("POST", `/api/copilot/plays/${rec.id}/resolve`, body);
    },
    onSuccess: (_data, action) => {
      toast({ title: `Play ${action}`, description: rec.playName });
      queryClient.invalidateQueries({ queryKey: ["/api/copilot/plays/by-doc", rec.documentId] });
      if (rec.customerId) queryClient.invalidateQueries({ queryKey: ["/api/copilot/plays/by-customer", rec.customerId] });
      if (rec.laneKey) queryClient.invalidateQueries({ queryKey: ["/api/copilot/plays/by-lane", rec.laneKey] });
      onResolved?.();
    },
    onError: (err: unknown) => {
      toast({ title: "Could not resolve", description: String(err), variant: "destructive" });
    },
  });

  const isOpen = rec.status === "pending";

  return (
    <Card className="border-l-4 border-l-primary/60" data-testid={`card-play-rec-${rec.id}`}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          {rec.playName}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge className={CONF_BG[rec.confidence]} data-testid={`badge-play-conf-${rec.id}`}>{rec.confidence}</Badge>
          {!isOpen && <Badge variant="outline" data-testid={`badge-play-status-${rec.id}`}>{rec.status}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rec.rationale && (
          <p className="text-sm text-muted-foreground" data-testid={`text-rationale-${rec.id}`}>{rec.rationale}</p>
        )}

        {rec.draftAction && (
          <div className="rounded-md border border-dashed p-2 bg-muted/40">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Draft action (HITL)</div>
            <div className="text-sm font-mono break-all" data-testid={`text-draft-${rec.id}`}>
              {rec.draftAction.tool}
              {rec.draftAction.preface ? ` — ${rec.draftAction.preface}` : ""}
            </div>
          </div>
        )}

        {rec.evidence?.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Evidence</div>
            <div className="flex flex-wrap gap-1.5">
              {rec.evidence.slice(0, 5).map((e, i) => <EvidenceChip key={i} evidence={e} />)}
              {rec.evidence.length > 5 && (
                <Badge variant="outline" className="text-xs">+{rec.evidence.length - 5}</Badge>
              )}
            </div>
          </div>
        )}

        {rec.alternatives?.length > 0 && (
          <div>
            <button
              type="button"
              className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground"
              onClick={() => setExpanded((v) => !v)}
              data-testid={`button-toggle-alts-${rec.id}`}
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Alternative plays ({rec.alternatives.length})
            </button>
            {expanded && (
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {rec.alternatives.map((a) => (
                  <li key={a.playId} className="flex items-start gap-2" data-testid={`text-alt-${rec.id}-${a.playId}`}>
                    <AlertCircle className="h-3 w-3 mt-1" />
                    <span><b>{a.playName}</b> — {a.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {isOpen && (
          <>
            <Separator />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => mutation.mutate("accepted")}
                disabled={mutation.isPending}
                data-testid={`button-accept-${rec.id}`}
              >
                <Check className="h-4 w-4 mr-1" /> Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => mutation.mutate("dismissed")}
                disabled={mutation.isPending}
                data-testid={`button-dismiss-${rec.id}`}
              >
                <X className="h-4 w-4 mr-1" /> Dismiss
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => mutation.mutate("snoozed")}
                disabled={mutation.isPending}
                data-testid={`button-snooze-${rec.id}`}
              >
                <Clock className="h-4 w-4 mr-1" /> Snooze 24h
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
