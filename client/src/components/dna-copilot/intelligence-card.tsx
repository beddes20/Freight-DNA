/**
 * Intelligence cards — combined module.
 *
 * Exports two distinct components:
 *
 *  - `IntelligenceRowCard` — Task #926 step 9. Renders a single
 *    `copilot_intelligence` row (lane/customer/carrier fit scores, price
 *    band, risks, opportunities, citations rail). Used by the copilot
 *    document workspace page.
 *
 *  - `IntelligenceCard` — Task #912 (Phase 2 slice 3). Renders a persisted
 *    `copilot_recommendations` row returned by /api/copilot/cards/* with
 *    fit score + band, top reasons/risks (each source-cited), inconsistency
 *    findings, suggested plays, and HITL reaction buttons that POST to
 *    /api/copilot/cards/:id/react.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TrendingUp } from "lucide-react";
import { EvidenceChip, type Evidence } from "./evidence-chip";

export interface IntelligenceRow {
  id: string;
  documentId: string;
  laneKey: string | null;
  customerId: string | null;
  laneFitScore: number | null;
  customerFitScore: number | null;
  carrierFitScore: number | null;
  priceLow: string | null;
  priceMid: string | null;
  priceHigh: string | null;
  risks: Array<{ label: string; severity: "high" | "medium" | "low"; evidence: Evidence[] }>;
  opportunities: Array<{ label: string; evidence: Evidence[] }>;
  evidenceRefs: Evidence[];
  confidence: "high" | "medium" | "low";
  scoringVersion: number;
  computedAt: string;
}

function confidenceColor(c: string) {
  if (c === "high") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (c === "medium") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
}

function ScoreChip({ label, value, testId }: { label: string; value: number | null; testId: string }) {
  const color =
    value == null ? "bg-muted text-muted-foreground"
    : value >= 70 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : value >= 40 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  return (
    <div className={`rounded-lg px-3 py-2 text-center ${color}`} data-testid={testId}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-semibold">{value ?? "—"}</div>
    </div>
  );
}

// ─── Task #912 (Phase 2 slice 3) — Fit & Intelligence Card ─────────────────
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, Pencil, ChevronDown, ChevronRight, ListChecks, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { CopilotRecommendation, IntelligenceCardPayload, IntelligenceCardClaim, IntelligenceCardPlay, IntelligenceCardSource } from "@shared/schema";

const FIT_BAND_STYLE: Record<IntelligenceCardPayload["fitBand"], string> = {
  strong:  "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300 border-green-200 dark:border-green-900/40",
  watch:   "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 border-amber-200 dark:border-amber-900/40",
  weak:    "bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300 border-orange-200 dark:border-orange-900/40",
  blocked: "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-900/40",
};

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", string> = {
  high:   "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300 border-green-200 dark:border-green-900/40",
  medium: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 border-amber-200 dark:border-amber-900/40",
  low:    "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-900/40",
};

function SourceChips({ sources }: { sources: IntelligenceCardSource[] }) {
  if (!sources?.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {sources.slice(0, 4).map((s, i) => {
        const inner = (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted">
            <span className="font-mono uppercase tracking-wide opacity-70">{s.kind.replace("_", " ")}</span>
            <span className="truncate max-w-[160px]">{s.label}</span>
          </span>
        );
        return s.href ? (
          <a key={i} href={s.href} target="_blank" rel="noreferrer" data-testid={`card-source-${i}`}>{inner}</a>
        ) : (
          <span key={i} data-testid={`card-source-${i}`}>{inner}</span>
        );
      })}
      {sources.length > 4 && (
        <span className="text-[10px] text-muted-foreground" data-testid="card-source-more">
          +{sources.length - 4} more
        </span>
      )}
    </div>
  );
}

export function IntelligenceRowCard({ row }: { row: IntelligenceRow }) {
  const lane = row.laneKey ?? "—";
  const lo = row.priceLow != null ? `$${Number(row.priceLow).toFixed(2)}/mi` : "—";
  const md = row.priceMid != null ? `$${Number(row.priceMid).toFixed(2)}/mi` : "—";
  const hi = row.priceHigh != null ? `$${Number(row.priceHigh).toFixed(2)}/mi` : "—";

  return (
    <Card data-testid={`card-intelligence-${row.id}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">
          Intelligence <span className="text-muted-foreground font-normal">— {lane}</span>
        </CardTitle>
        <Badge className={confidenceColor(row.confidence)} data-testid={`badge-confidence-${row.id}`}>
          {row.confidence} confidence
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <ScoreChip label="Lane fit" value={row.laneFitScore} testId={`chip-lane-fit-${row.id}`} />
          <ScoreChip label="Customer fit" value={row.customerFitScore} testId={`chip-customer-fit-${row.id}`} />
          <ScoreChip label="Carrier fit" value={row.carrierFitScore} testId={`chip-carrier-fit-${row.id}`} />
        </div>

        <div className="rounded-lg border p-3 bg-muted/40">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Price band</div>
          <div className="flex items-baseline gap-3">
            <span className="text-sm" data-testid={`text-price-low-${row.id}`}>{lo}</span>
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-lg font-semibold" data-testid={`text-price-mid-${row.id}`}>{md}</span>
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-sm" data-testid={`text-price-high-${row.id}`}>{hi}</span>
          </div>
        </div>

        {row.risks.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <AlertTriangle className="h-3.5 w-3.5" /> Risks
            </div>
            <ul className="space-y-1">
              {row.risks.map((r, i) => (
                <li key={i} className="text-sm flex items-start gap-2" data-testid={`text-risk-${row.id}-${i}`}>
                  <Badge variant="outline" className={r.severity === "high" ? "border-rose-500/40 text-rose-700 dark:text-rose-300" : r.severity === "medium" ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : ""}>
                    {r.severity}
                  </Badge>
                  <span>{r.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {row.opportunities.length > 0 && (
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <TrendingUp className="h-3.5 w-3.5" /> Opportunities
            </div>
            <ul className="space-y-1">
              {row.opportunities.map((o, i) => (
                <li key={i} className="text-sm" data-testid={`text-opportunity-${row.id}-${i}`}>{o.label}</li>
              ))}
            </ul>
          </div>
        )}

        {row.evidenceRefs.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                <ShieldCheck className="h-3.5 w-3.5" /> Evidence ({row.evidenceRefs.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {row.evidenceRefs.slice(0, 12).map((e, i) => (
                  <EvidenceChip key={i} evidence={e} />
                ))}
                {row.evidenceRefs.length > 12 && (
                  <Badge variant="outline" className="text-xs font-normal">
                    +{row.evidenceRefs.length - 12} more
                  </Badge>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ClaimRow({ claim, kind, idx }: { claim: IntelligenceCardClaim; kind: "reason" | "risk"; idx: number }) {
  return (
    <li className="py-2 border-b border-border/40 last:border-b-0" data-testid={`card-${kind}-${idx}`}>
      <div className="flex items-start gap-2">
        {kind === "reason" ? (
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-green-600 shrink-0" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-600 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug">{claim.text}</p>
          <SourceChips sources={claim.sources} />
        </div>
        <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0", CONFIDENCE_STYLE[claim.confidence])}>
          {claim.confidence}
        </span>
      </div>
    </li>
  );
}

function PlayRow({ play, idx }: { play: IntelligenceCardPlay; idx: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border border-border/60 rounded-md bg-muted/20" data-testid={`card-play-${idx}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/40 rounded-md"
        aria-expanded={open}
        data-testid={`card-play-toggle-${idx}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 mt-1 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-1 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-medium">{play.name}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground" data-testid={`card-play-kind-${idx}`}>
              {play.matchKind}
            </span>
          </div>
          {!open && <p className="text-xs text-muted-foreground mt-0.5 truncate">{play.why}</p>}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Why:</span> {play.why}</p>
          <p className="text-xs"><span className="font-medium">Action:</span> {play.action}</p>
          <SourceChips sources={play.sources} />
        </div>
      )}
    </li>
  );
}

export interface IntelligenceCardProps {
  card: CopilotRecommendation;
  /** Cache keys that should be invalidated when the rep reacts so the
   *  surrounding page re-renders with the new state. Pass at minimum the
   *  query key the embedding page uses to fetch the cards. */
  invalidateKeys?: Array<readonly unknown[]>;
}

export function IntelligenceCard({ card, invalidateKeys = [] }: IntelligenceCardProps) {
  const payload = card.cardPayload as IntelligenceCardPayload;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editNote, setEditNote] = useState("");
  const [isEditOpen, setEditOpen] = useState(false);

  const reactMutation = useMutation({
    mutationFn: async (input: { reaction: "confirmed" | "edited" | "dismissed"; reason?: string }) => {
      const r = await apiRequest("POST", `/api/copilot/cards/${card.id}/react`, input);
      return r;
    },
    onSuccess: (_, vars) => {
      toast({ title: `Card ${vars.reaction}`, description: "Reaction recorded." });
      for (const k of invalidateKeys) qc.invalidateQueries({ queryKey: k as readonly unknown[] });
      queryClient.invalidateQueries({ queryKey: ["/api/copilot/cards/by-document", card.sourceDocumentId] });
    },
    onError: (err) => {
      toast({ title: "Could not record reaction", description: String(err), variant: "destructive" });
    },
  });

  const isReacted = card.reaction !== "pending";
  const reasons = (payload.reasons ?? []).slice(0, 3);
  const risks = (payload.risks ?? []).slice(0, 3);

  return (
    <div
      className="border border-border rounded-lg bg-card text-card-foreground shadow-sm overflow-hidden"
      data-testid={`intelligence-card-${card.id}`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/20">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <ListChecks className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-semibold truncate" data-testid="card-title">{payload.header.title}</span>
              {payload.needsReview && (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300" data-testid="card-needs-review">
                  <AlertTriangle className="h-2.5 w-2.5" /> needs review
                </span>
              )}
            </div>
            {payload.header.subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5" data-testid="card-subtitle">{payload.header.subtitle}</p>
            )}
            {(payload.header.customerLabel || payload.header.carrierLabel) && (
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {payload.header.customerLabel && <span data-testid="card-customer-label">Cust: {payload.header.customerLabel}</span>}
                {payload.header.customerLabel && payload.header.carrierLabel && <span> · </span>}
                {payload.header.carrierLabel && <span data-testid="card-carrier-label">Carrier: {payload.header.carrierLabel}</span>}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1", FIT_BAND_STYLE[payload.fitBand])} data-testid="card-fit-band">
                <ShieldCheck className="h-2.5 w-2.5" /> Fit {card.fitScore}/100 · {payload.fitBand}
              </span>
              <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border", CONFIDENCE_STYLE[payload.aggregateConfidence])} data-testid={`card-confidence-${payload.aggregateConfidence}`}>
                {payload.aggregateConfidence} confidence
              </span>
            </div>
            {isReacted && (
              <span className="text-[10px] text-muted-foreground" data-testid="card-reaction-state">
                {card.reaction}{card.reactedAt ? ` · ${new Date(card.reactedAt).toLocaleString()}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Body — reasons + risks */}
      <div className="grid md:grid-cols-2 gap-0">
        <div className="px-4 py-3 border-b md:border-b-0 md:border-r border-border">
          <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Why this fits</h4>
          {reasons.length > 0 ? (
            <ul className="divide-y divide-border/40">
              {reasons.map((r, i) => <ClaimRow key={i} claim={r} kind="reason" idx={i} />)}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground italic" data-testid="card-no-reasons">
              {payload.needsReview ? "Reasoner refused to make claims — see risks for the cause." : "No positive signals matched."}
            </p>
          )}
        </div>
        <div className="px-4 py-3">
          <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Watch out for</h4>
          {risks.length > 0 ? (
            <ul className="divide-y divide-border/40">
              {risks.map((r, i) => <ClaimRow key={i} claim={r} kind="risk" idx={i} />)}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground italic" data-testid="card-no-risks">No risks flagged.</p>
          )}
        </div>
      </div>

      {/* Inconsistency findings */}
      {payload.inconsistencyFindings.length > 0 && (
        <div className="px-4 py-2 border-t border-border bg-muted/10">
          <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Inconsistency findings</h4>
          <ul className="text-xs space-y-0.5">
            {payload.inconsistencyFindings.map((f, i) => (
              <li key={i} className="flex items-start gap-1.5" data-testid={`card-finding-${i}`}>
                <span className={cn(
                  "text-[9px] uppercase tracking-wide px-1 py-0 rounded shrink-0 mt-0.5",
                  f.severity === "block" ? "bg-rose-100 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                  : f.severity === "warn" ? "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                  : "bg-muted text-muted-foreground"
                )}>{f.severity}</span>
                <span className="flex-1">{f.message} <span className="text-muted-foreground">({f.ruleCode})</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggested plays */}
      {payload.suggestedPlays.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">Suggested plays</h4>
          <ul className="space-y-1.5">
            {payload.suggestedPlays.map((p, i) => <PlayRow key={i} play={p} idx={i} />)}
          </ul>
        </div>
      )}

      {/* Reaction footer */}
      <div className="px-4 py-2.5 border-t border-border bg-muted/20 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground">
          {payload.reasonerVersion} · generated {card.generatedAt ? new Date(card.generatedAt).toLocaleString() : "—"}
        </span>
        <div className="flex items-center gap-1.5">
          {isEditOpen ? (
            <>
              <input
                type="text"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="What did you change?"
                className="text-xs px-2 py-1 rounded border border-border bg-background w-56"
                data-testid="card-edit-note"
              />
              <button
                type="button"
                onClick={() => reactMutation.mutate({ reaction: "edited", reason: editNote || undefined })}
                disabled={reactMutation.isPending}
                className="text-xs px-2 py-1 rounded border border-border bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                data-testid="card-edit-save"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => { setEditOpen(false); setEditNote(""); }}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
                data-testid="card-edit-cancel"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => reactMutation.mutate({ reaction: "confirmed" })}
                disabled={reactMutation.isPending || isReacted}
                className="text-xs px-2.5 py-1 rounded border border-border bg-background hover:bg-green-50 hover:border-green-300 hover:text-green-700 dark:hover:bg-green-950/30 dark:hover:text-green-300 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="card-react-confirm"
              >
                <CheckCircle2 className="h-3 w-3" /> Confirm
              </button>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                disabled={reactMutation.isPending || isReacted}
                className="text-xs px-2.5 py-1 rounded border border-border bg-background hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 dark:hover:bg-amber-950/30 dark:hover:text-amber-300 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="card-react-edit"
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
              <button
                type="button"
                onClick={() => reactMutation.mutate({ reaction: "dismissed" })}
                disabled={reactMutation.isPending || isReacted}
                className="text-xs px-2.5 py-1 rounded border border-border bg-background hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700 dark:hover:bg-rose-950/30 dark:hover:text-rose-300 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="card-react-dismiss"
              >
                <XCircle className="h-3 w-3" /> Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
