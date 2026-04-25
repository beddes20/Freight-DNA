import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowLeft, AlertTriangle, ShieldAlert, Truck, Calendar,
  Search, Send, Mail, MessageSquare, Phone, Info, Activity,
  ChevronDown, ChevronRight, GripVertical, Sparkles, TrendingUp,
  CheckCircle2, XCircle, RefreshCw, ExternalLink, DollarSign, Clock,
  Eye,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  CarrierOverrideReasonPicker,
  shouldFireAddedOutsideTopN,
  type CarrierOverrideAction,
  type CarrierOverridePickerCarrier,
  type CarrierOverridePickerLane,
} from "@/components/CarrierOverrideReasonPicker";
import type {
  Company, Carrier, FreightOpportunity, FreightOpportunityCarrier,
  FreightOpportunityAudit, FreightOpportunityBucket,
  FreightOpportunityExcludedReason, FreightOpportunityResponse,
  FreightOpportunityResponseOutcome,
} from "@shared/schema";

type DetailCarrier = FreightOpportunityCarrier & {
  responses?: FreightOpportunityResponse[];
  lastResponse?: FreightOpportunityResponse | null;
};

interface DetailResponse {
  opportunity: FreightOpportunity;
  carriers: DetailCarrier[];
  audit: FreightOpportunityAudit[];
}

type PoolEntry = {
  id: string;
  carrierId: string;
  name: string;
  mc: string | null;
  region: string;
  fitScore: number;
  lastRate: number | null;
  tag: "in_region" | "prior_quote" | "new_prospect" | "lactalis_history";
  email: string | null;
  phone: string | null;
};

const OUTCOME_LABELS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  interested_now: { label: "Interested now", tone: "good" },
  interested_few_days: { label: "Interested · few days", tone: "good" },
  interested_next_week: { label: "Interested · next week", tone: "good" },
  interested_future: { label: "Future capacity", tone: "good" },
  booked: { label: "Booked", tone: "good" },
  declined: { label: "Declined", tone: "bad" },
  not_qualified: { label: "Not qualified", tone: "bad" },
  do_not_contact_lane: { label: "Do not contact (lane)", tone: "bad" },
  no_response: { label: "No response", tone: "neutral" },
  accepted: { label: "Accepted", tone: "good" },
  quoted: { label: "Quoted", tone: "good" },
  passed_busy: { label: "Passed (busy)", tone: "warn" },
  passed_rate: { label: "Passed (rate)", tone: "warn" },
  passed_lane_fit: { label: "Passed (lane fit)", tone: "warn" },
  passed_other: { label: "Passed", tone: "warn" },
  auto_no_reply: { label: "No reply", tone: "neutral" },
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  const def = OUTCOME_LABELS[outcome] ?? { label: outcome.replace(/_/g, " "), tone: "neutral" as const };
  const tone = def.tone === "good"
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
    : def.tone === "bad"
      ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30"
      : def.tone === "warn"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
        : "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={`text-[10px] ${tone}`} data-testid={`badge-outcome-${outcome}`}>
      {def.label}
    </Badge>
  );
}

const BUCKET_LABELS: Record<FreightOpportunityBucket, string> = {
  proven: "Proven",
  strong_fit_underused: "Strong fit · underused",
  exploratory: "Exploratory",
  rep_added: "Rep-added",
};

const BUCKET_HINTS: Record<FreightOpportunityBucket, string> = {
  proven: "hauled this exact lane recently",
  strong_fit_underused: "high score, low recent activity on this lane",
  exploratory: "new prospects worth a try",
  rep_added: "manually pinned by a rep",
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

const POOL_TAG_LABEL: Record<PoolEntry["tag"], { label: string; cls: string }> = {
  in_region: { label: "In region", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30" },
  prior_quote: { label: "Prior quote", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30" },
  new_prospect: { label: "New prospect", cls: "bg-muted text-muted-foreground border-border" },
  lactalis_history: { label: "Customer history", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" },
};

function fmtWindow(start: string, _end?: string | null) {
  if (!start) return "—";
  const s = new Date(start);
  if (isNaN(s.getTime())) return "—";
  return s.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtLane(
  origin: string, originState: string | null | undefined,
  destination: string, destinationState: string | null | undefined,
) {
  const o = originState ? `${origin}, ${originState.toUpperCase()}` : origin;
  const d = destinationState ? `${destination}, ${destinationState.toUpperCase()}` : destination;
  return `${o} → ${d}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function leadTimeText(pickup: string): string {
  const p = new Date(pickup);
  if (isNaN(p.getTime())) return "—";
  const d = daysBetween(new Date(), p);
  if (d < 0) return `${Math.abs(d)} days late`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `${d} days lead`;
}

// ────────────────────────────────────────────────────────────────────────────
// Carrier Intelligence panel content (used inside collapsible band)
// ────────────────────────────────────────────────────────────────────────────
interface BlendedRateResponse {
  targetBuyRpm: number | null;
  suggestedSellRpm: number | null;
  expectedMarginPct: { low: number; high: number } | null;
  confidence: "high" | "medium" | "low" | "none";
  legs: {
    sonar: { ratePerMile: number | null; source: string; isStale: boolean };
    history: {
      avgCostPerMile: number | null;
      medianCostPerMile: number | null;
      loads: number;
      loads30d: number;
      fallbackTier: string;
    } | null;
  };
  weights: { sonar: number; history: number };
  sonarWeightAutoBumped: boolean;
  refusedBelowThreshold: boolean;
  reason: string;
  historyFallbackTier: string;
}

function CarrierIntelligenceBand({ opp, customerName }: { opp: FreightOpportunity; customerName: string | null }) {
  const [open, setOpen] = useState(false);
  const params = new URLSearchParams({ origin: opp.origin, destination: opp.destination });
  if (opp.originState) params.set("originState", opp.originState);
  if (opp.destinationState) params.set("destinationState", opp.destinationState);
  if (opp.equipmentType) params.set("trailer", opp.equipmentType);
  if (customerName) params.set("customer", customerName);

  const { data, isLoading } = useQuery<BlendedRateResponse>({
    queryKey: ["/api/carrier-intelligence/lane-pricing", params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/carrier-intelligence/lane-pricing?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Lane pricing failed (${res.status})`);
      return res.json();
    },
  });

  const buyText = data?.targetBuyRpm != null
    ? `$${data.targetBuyRpm.toFixed(2)}/mi target buy`
    : data?.reason === "" ? "—" : (data?.reason ?? "—");

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 hover-elevate active-elevate-2"
        data-testid="button-toggle-intelligence"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold">Carrier Intelligence — Suggested buy</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-sm font-mono font-semibold" data-testid="text-intel-summary">
            {isLoading ? "…" : buyText}
          </span>
          {data && (
            <span className="text-[11px] text-muted-foreground ml-1 hidden md:inline">
              SONAR + your realized history
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">{open ? "Hide" : "Show details"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs border-t border-border/60">
          {isLoading && <Skeleton className="h-20 col-span-full" />}
          {data && (
            <>
              <div className="border border-border rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">SONAR market</div>
                <div className="mt-1 font-mono text-base font-semibold">
                  {data.legs.sonar?.ratePerMile != null ? `$${Number(data.legs.sonar.ratePerMile).toFixed(2)}/mi` : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {Math.round(data.weights.sonar * 100)}% weight
                  {data.legs.sonar?.isStale && <span className="text-amber-600 dark:text-amber-400"> · stale</span>}
                </div>
              </div>
              <div className="border border-border rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Your history</div>
                <div className="mt-1 font-mono text-base font-semibold">
                  {data.legs.history?.avgCostPerMile != null ? `$${Number(data.legs.history.avgCostPerMile).toFixed(2)}/mi` : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {data.legs.history?.loads ?? 0} loads · {data.historyFallbackTier}
                </div>
              </div>
              <div className="border border-border rounded p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Target buy</div>
                <div className="mt-1 font-mono text-base font-semibold inline-flex items-center gap-1">
                  {data.targetBuyRpm != null ? `$${data.targetBuyRpm.toFixed(2)}/mi` : "—"}
                  {data.sonarWeightAutoBumped && <TrendingUp className="h-3.5 w-3.5 text-amber-500" />}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {data.confidence === "none" ? "no rate" : `${data.confidence} confidence`}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Carrier row — rich card with flags, mini-stats, why-expand, outcome buttons
// ────────────────────────────────────────────────────────────────────────────

type CarrierFlag = "incumbent" | "fast_responder" | "passed_last_time" | "replied_other_opp";

function flagBadge(flag: CarrierFlag) {
  switch (flag) {
    case "incumbent":
      return { label: "Incumbent", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" };
    case "fast_responder":
      return { label: "Fast responder", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" };
    case "passed_last_time":
      return { label: "Passed last time", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30" };
    case "replied_other_opp":
      return { label: "Replied to another lane", cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30" };
  }
}

function deriveFlags(row: DetailCarrier): CarrierFlag[] {
  const flags: CarrierFlag[] = [];
  if (row.historyMatch === "exact_lane" || row.historyMatch === "corridor") flags.push("incumbent");
  const snap = (row.responsivenessSnapshot ?? null) as Record<string, unknown> | null;
  const respHours = snap?.replyHours as number | undefined;
  if (typeof respHours === "number" && respHours <= 2) flags.push("fast_responder");
  if (row.lastResponse) {
    const tone = OUTCOME_LABELS[row.lastResponse.outcome]?.tone;
    if (tone === "warn" || tone === "bad") flags.push("passed_last_time");
  }
  return flags;
}

function CarrierRow({
  row, carrier, rank, selected, onSelectChange,
  onLogOutcomeQuick, isFirstInBucket, isLastInBucket, onMove,
  draggingRowId, setDraggingRowId, onDropOn,
}: {
  row: DetailCarrier;
  carrier: Carrier | null;
  rank: number;
  selected: boolean;
  onSelectChange: (id: string, sel: boolean) => void;
  onLogOutcomeQuick: (rowId: string, outcome: string, rate: string) => void;
  isFirstInBucket: boolean;
  isLastInBucket: boolean;
  onMove: (rowId: string, dir: -1 | 1) => void;
  draggingRowId: string | null;
  setDraggingRowId: (id: string | null) => void;
  onDropOn: (sourceRowId: string, targetRowId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [rate, setRate] = useState("");
  const excluded = !!row.excludedReason;
  const sentAt = row.sentAt ? new Date(row.sentAt) : null;
  const flags = deriveFlags(row);
  const snap = (row.responsivenessSnapshot ?? null) as Record<string, unknown> | null;
  const loadsOnLane = (snap?.loadsOnLane as number | undefined) ?? 0;
  const replyHours = snap?.replyHours as number | undefined;
  const struct = (row.explanationStructured ?? null) as Record<string, unknown> | null;

  return (
    <div
      draggable={!excluded && !sentAt}
      onDragStart={(e) => {
        if (excluded || sentAt) { e.preventDefault(); return; }
        setDraggingRowId(row.id);
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", row.id); } catch { /* ignore */ }
      }}
      onDragOver={(e) => {
        if (!draggingRowId || draggingRowId === row.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        if (!draggingRowId || draggingRowId === row.id) return;
        e.preventDefault();
        onDropOn(draggingRowId, row.id);
        setDraggingRowId(null);
      }}
      onDragEnd={() => setDraggingRowId(null)}
      className={`border-b border-border/60 last:border-b-0 ${excluded ? "opacity-60" : ""} hover-elevate transition-colors ${draggingRowId === row.id ? "opacity-40" : ""} ${draggingRowId && draggingRowId !== row.id ? "data-[dragover=true]:border-amber-500" : ""}`}
      data-testid={`row-carrier-${row.id}`}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <button
            onClick={() => onMove(row.id, -1)}
            disabled={isFirstInBucket}
            className="p-0.5 text-muted-foreground/50 hover:text-foreground disabled:opacity-30 cursor-grab"
            title="Drag to reorder, or click to move up"
            data-testid={`button-move-up-${row.id}`}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        </div>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelectChange(row.id, e.target.checked)}
          disabled={excluded || !!sentAt}
          className="h-4 w-4 rounded border-input accent-amber-500"
          data-testid={`checkbox-select-${row.id}`}
        />
        <span className="text-[10px] font-semibold tabular-nums text-muted-foreground w-6 shrink-0" data-testid={`text-rank-${row.id}`}>
          #{rank}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate" data-testid={`text-carrier-name-${row.id}`}>
              {carrier?.name ?? "Unknown carrier"}
            </span>
            {carrier?.mcDot && (
              <span className="text-[11px] text-muted-foreground">MC {carrier.mcDot}</span>
            )}
            {flags.map(f => {
              const b = flagBadge(f);
              return (
                <Badge key={f} variant="outline" className={`text-[10px] ${b.cls}`}>
                  {b.label}
                </Badge>
              );
            })}
            {sentAt && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]">
                <Mail className="h-3 w-3 mr-1" />
                Sent {sentAt.toLocaleDateString()}{row.wave ? ` · w${row.wave}` : ""}
              </Badge>
            )}
            {row.lastResponse && <OutcomeBadge outcome={row.lastResponse.outcome} />}
            {row.lastSendError && (
              <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30 text-[10px]" title={row.lastSendError}>
                Send failed
              </Badge>
            )}
            {excluded && row.excludedReason && (
              <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30 text-[10px]">
                {EXCLUDED_LABELS[row.excludedReason as FreightOpportunityExcludedReason] ?? row.excludedReason}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Truck className="h-3 w-3" />
              {loadsOnLane} loads · 90d
            </span>
            {typeof replyHours === "number" && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                ~{replyHours.toFixed(1)}h reply
              </span>
            )}
            {carrier?.city && carrier.state && (
              <span className="hidden sm:inline">{carrier.city}, {carrier.state.toUpperCase()}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="text-right pr-1">
            <div className="text-base font-semibold leading-none tabular-nums" data-testid={`text-fit-${row.id}`}>
              {row.fitScore ?? "—"}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">fit</div>
          </div>
          <button
            onClick={() => setOpen(v => !v)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover-elevate"
            title="Why this carrier?"
            data-testid={`button-why-${row.id}`}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          {carrier?.phone && (
            <a
              href={`tel:${carrier.phone}`}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover-elevate"
              title={carrier.phone}
            >
              <Phone className="h-3.5 w-3.5" />
            </a>
          )}
          {carrier?.primaryEmail && (
            <a
              href={`mailto:${carrier.primaryEmail}`}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover-elevate"
              title={carrier.primaryEmail}
            >
              <Mail className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
      {open && (
        <div className="px-4 pb-3">
          <div className="bg-muted/40 border border-border rounded-md p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">History</div>
              <div className="mt-0.5">{(struct?.history as string) ?? row.explanation ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Rate context</div>
              <div className="mt-0.5">{(struct?.rate as string) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Region</div>
              <div className="mt-0.5">
                {(struct?.region as string) ??
                  (carrier?.city && carrier.state ? `${carrier.city}, ${carrier.state.toUpperCase()}` : "—")}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Responsiveness</div>
              <div className="mt-0.5">
                {typeof replyHours === "number" ? `Replies within ~${replyHours.toFixed(1)}h` : "No prior outreach data"}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground mr-1">Log outcome:</span>
            {[
              { k: "interested_now", label: "Interested", cls: "bg-emerald-600 hover:bg-emerald-700 text-white" },
              { k: "interested_few_days", label: "Maybe (later)", cls: "bg-amber-500 hover:bg-amber-600 text-white" },
              { k: "declined", label: "Pass", cls: "bg-muted hover:bg-muted-foreground/20 text-foreground" },
              { k: "no_response", label: "No reply", cls: "bg-muted hover:bg-muted-foreground/20 text-foreground" },
            ].map(o => (
              <button
                key={o.k}
                onClick={() => setOutcome(o.k)}
                className={`text-[11px] px-2 py-1 rounded font-medium ${o.cls} ${outcome === o.k ? "ring-2 ring-offset-1 ring-primary" : ""}`}
                data-testid={`button-quick-outcome-${row.id}-${o.k}`}
              >
                {o.label}
              </button>
            ))}
            {(outcome === "interested_now" || outcome === "interested_few_days") && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <div className="relative">
                  <DollarSign className="h-3 w-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="quoted rate"
                    className="text-[11px] pl-5 pr-2 py-1 border border-border rounded w-24 bg-background"
                    data-testid={`input-quick-rate-${row.id}`}
                  />
                </div>
              </>
            )}
            {outcome && (
              <button
                onClick={() => {
                  onLogOutcomeQuick(row.id, outcome, rate);
                  setOutcome(null);
                  setRate("");
                  setOpen(false);
                }}
                className="text-[11px] px-2 py-1 rounded font-medium bg-foreground text-background hover:opacity-90"
                data-testid={`button-quick-save-${row.id}`}
              >
                Save
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Bucket section (collapsible)
// ────────────────────────────────────────────────────────────────────────────
function BucketSection({
  bucket, rows, carrierById, selected, onSelectChange, onLogOutcomeQuick, onMove, onSwapRows, defaultOpen,
}: {
  bucket: FreightOpportunityBucket;
  rows: DetailCarrier[];
  carrierById: Map<string, Carrier>;
  selected: Set<string>;
  onSelectChange: (id: string, sel: boolean) => void;
  onLogOutcomeQuick: (rowId: string, outcome: string, rate: string) => void;
  onMove: (rowId: string, dir: -1 | 1) => void;
  onSwapRows: (sourceRowId: string, targetRowId: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const selectedInBucket = rows.filter(r => selected.has(r.id)).length;
  const rowIdSet = new Set(rows.map(r => r.id));
  const onDropOn = (sourceRowId: string, targetRowId: string) => {
    // Only allow swaps within this bucket.
    if (!rowIdSet.has(sourceRowId) || !rowIdSet.has(targetRowId)) return;
    onSwapRows(sourceRowId, targetRowId);
  };
  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden" data-testid={`bucket-${bucket}`}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover-elevate"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <span className="text-sm font-semibold">{BUCKET_LABELS[bucket]}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-xs text-muted-foreground">{rows.length} carriers</span>
          <span className="text-xs text-muted-foreground/70 hidden md:inline">· {BUCKET_HINTS[bucket]}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {selectedInBucket > 0 ? `${selectedInBucket} selected` : ""}
        </span>
      </button>
      {open && (
        <div>
          {rows.map((row, idx) => (
            <CarrierRow
              key={row.id}
              row={row}
              carrier={carrierById.get(row.carrierId) ?? null}
              rank={row.rank ?? idx + 1}
              selected={selected.has(row.id)}
              onSelectChange={onSelectChange}
              onLogOutcomeQuick={onLogOutcomeQuick}
              isFirstInBucket={idx === 0}
              isLastInBucket={idx === rows.length - 1}
              onMove={onMove}
              draggingRowId={draggingRowId}
              setDraggingRowId={setDraggingRowId}
              onDropOn={onDropOn}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Suggested carrier pool (LWQ-style)
// ────────────────────────────────────────────────────────────────────────────
function SuggestedPool({
  oppId,
  selectedPoolIds,
  onTogglePool,
  onSelectPoolIds,
  onClearPoolIds,
}: {
  oppId: string;
  selectedPoolIds: Set<string>;
  onTogglePool: (carrierId: string) => void;
  onSelectPoolIds: (carrierIds: string[]) => void;
  onClearPoolIds: (carrierIds: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<"all" | PoolEntry["tag"]>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError, refetch } = useQuery<{ pool: PoolEntry[]; total: number }>({
    queryKey: ["/api/freight-opportunities", oppId, "carrier-pool"],
    queryFn: async () => {
      const res = await fetch(`/api/freight-opportunities/${oppId}/carrier-pool`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const pool = data?.pool ?? [];
  const counts = useMemo(() => ({
    all: pool.length,
    in_region: pool.filter(p => p.tag === "in_region").length,
    prior_quote: pool.filter(p => p.tag === "prior_quote").length,
    lactalis_history: pool.filter(p => p.tag === "lactalis_history").length,
    new_prospect: pool.filter(p => p.tag === "new_prospect").length,
  }), [pool]);

  const filtered = pool.filter(p => {
    if (filter !== "all" && p.tag !== filter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!p.name.toLowerCase().includes(s) && !p.region.toLowerCase().includes(s)) return false;
    }
    return true;
  });
  const filteredCarrierIds = filtered.map(p => p.carrierId);
  const allFilteredSelected = filteredCarrierIds.length > 0 && filteredCarrierIds.every(id => selectedPoolIds.has(id));

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden" data-testid="section-pool">
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover-elevate"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <span className="text-sm font-semibold">Suggested carrier pool</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="text-xs text-muted-foreground">
            {isLoading ? "loading…" : `${pool.length} carriers beyond the ranked shortlist`}
          </span>
          <span className="text-xs text-muted-foreground/70 hidden md:inline">· bulk-select to send wide</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {Array.from(selectedPoolIds).filter(id => pool.some(p => p.carrierId === id)).length > 0
            ? `${Array.from(selectedPoolIds).filter(id => pool.some(p => p.carrierId === id)).length} selected from pool`
            : ""}
        </span>
      </button>
      {open && (
        <>
          <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 flex-wrap bg-card">
            <div className="flex items-center gap-1 flex-wrap">
              {([
                ["all", "All"],
                ["in_region", "In region"],
                ["prior_quote", "Prior quote"],
                ["lactalis_history", "Customer history"],
                ["new_prospect", "New prospects"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`text-[11px] px-2 py-1 rounded border ${
                    filter === k
                      ? "bg-foreground border-foreground text-background"
                      : "bg-card border-border text-foreground hover-elevate"
                  }`}
                  data-testid={`filter-pool-${k}`}
                >
                  {label} <span className="opacity-60">({counts[k]})</span>
                </button>
              ))}
            </div>
            <div className="relative ml-auto">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter pool"
                className="pl-8 pr-3 py-1 border border-border rounded text-xs w-44 bg-background"
                data-testid="input-pool-search"
              />
            </div>
            <button
              onClick={() => onSelectPoolIds(pool.slice(0, 20).map(p => p.carrierId))}
              className="text-[11px] px-2.5 py-1 rounded bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 inline-flex items-center gap-1"
              disabled={pool.length === 0}
              data-testid="button-pool-top20"
            >
              <Sparkles className="h-3 w-3" /> Add top 20 to wave
            </button>
            <button
              onClick={() => allFilteredSelected ? onClearPoolIds(filteredCarrierIds) : onSelectPoolIds(filteredCarrierIds)}
              className="text-[11px] px-2.5 py-1 rounded border border-border text-foreground hover-elevate"
              disabled={filtered.length === 0}
              data-testid="button-pool-select-all"
            >
              {allFilteredSelected ? "Clear" : "Select all"} ({filtered.length})
            </button>
          </div>
          <div className="grid grid-cols-[28px_28px_1fr_140px_120px_90px_60px] items-center gap-2 px-4 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b border-border/60 bg-muted/20">
            <div />
            <div />
            <div>Carrier</div>
            <div>Region</div>
            <div>Tag</div>
            <div>Last rate</div>
            <div className="text-right">Fit</div>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {isLoading && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">Loading pool…</div>
            )}
            {isError && !isLoading && (
              <div className="px-4 py-6 text-center text-xs text-rose-700 dark:text-rose-300 space-y-2" data-testid="state-pool-error">
                <p>Couldn't load the suggested carrier pool.</p>
                <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-pool-retry">Retry</Button>
              </div>
            )}
            {!isLoading && !isError && filtered.map(p => {
              const sel = selectedPoolIds.has(p.carrierId);
              const tag = POOL_TAG_LABEL[p.tag];
              return (
                <div
                  key={p.carrierId}
                  className={`grid grid-cols-[28px_28px_1fr_140px_120px_90px_60px] items-center gap-2 px-4 py-1.5 border-b border-border/40 last:border-b-0 text-sm hover-elevate ${sel ? "bg-amber-500/10" : ""}`}
                  data-testid={`row-pool-${p.carrierId}`}
                >
                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40" />
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-input accent-amber-500"
                    checked={sel}
                    onChange={() => onTogglePool(p.carrierId)}
                    data-testid={`checkbox-pool-${p.carrierId}`}
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{p.name}</div>
                    {p.mc && <div className="text-[10px] text-muted-foreground">MC {p.mc}</div>}
                  </div>
                  <div className="text-[12px] text-muted-foreground truncate">{p.region}</div>
                  <div>
                    <Badge variant="outline" className={`text-[10px] ${tag.cls}`}>{tag.label}</Badge>
                  </div>
                  <div className="text-[12px] font-mono">
                    {p.lastRate ? `$${p.lastRate.toLocaleString()}` : <span className="text-muted-foreground/60">—</span>}
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums">{p.fitScore}</div>
                </div>
              );
            })}
            {!isLoading && !isError && filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                {pool.length === 0 ? "No additional carriers found beyond the ranked shortlist." : "No carriers match your filter."}
              </div>
            )}
          </div>
          <div className="px-4 py-2 border-t border-border/60 bg-muted/20 text-[11px] text-muted-foreground flex items-center justify-between flex-wrap gap-2">
            <span>Cast a wider net (20–30 carriers) when capacity is tight or proven carriers haven't replied.</span>
            <span className="text-muted-foreground/70">Daily-cap & guardrails still apply at send time.</span>
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Activity drawer
// ────────────────────────────────────────────────────────────────────────────
function ActivityDrawer({ open, onClose, audit }: { open: boolean; onClose: () => void; audit: FreightOpportunityAudit[] }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} data-testid="overlay-activity" />
      <div className="fixed top-0 right-0 bottom-0 w-96 bg-card border-l border-border z-50 shadow-xl flex flex-col" data-testid="drawer-activity">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Activity</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-activity">Close</Button>
        </div>
        <div className="overflow-y-auto p-4 text-xs space-y-3">
          {audit.length === 0 ? (
            <p className="text-muted-foreground">No activity recorded yet.</p>
          ) : (
            audit.slice().reverse().map(a => (
              <div key={a.id} className="flex gap-3" data-testid={`activity-item-${a.id}`}>
                <div className="text-[11px] text-muted-foreground w-28 shrink-0">
                  {new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </div>
                <div className="flex-1">
                  <div className="font-medium capitalize">{a.eventType.replace(/_/g, " ")}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Send modal body (kept from prior page)
// ────────────────────────────────────────────────────────────────────────────
function SendModalBody({
  oppId, mode, carrierIds, carriersById, opportunityCarriers,
  draftIndex, setDraftIndex, overrides, setOverrides, scheduleAt, setScheduleAt,
}: {
  oppId: string;
  mode: string;
  carrierIds: string[];
  carriersById: Map<string, Carrier>;
  opportunityCarriers: DetailCarrier[];
  draftIndex: number;
  setDraftIndex: (n: number) => void;
  overrides: Record<string, { subject: string; body: string }>;
  setOverrides: (fn: (prev: Record<string, { subject: string; body: string }>) => Record<string, { subject: string; body: string }>) => void;
  scheduleAt: string;
  setScheduleAt: (s: string) => void;
}) {
  const safeIndex = Math.min(draftIndex, Math.max(0, carrierIds.length - 1));
  const currentRowId = carrierIds[safeIndex];
  const currentRow = opportunityCarriers.find(r => r.id === currentRowId);
  const currentCarrier = currentRow ? carriersById.get(currentRow.carrierId) : null;

  const draftQuery = useQuery<{ draft: { subject: string; body: string; toEmail: string | null; templateKind: string } }>({
    queryKey: ["/api/freight-opportunities", oppId, "carriers", currentRowId, "draft"],
    enabled: !!currentRowId,
  });

  const ov = currentRowId ? overrides[currentRowId] : undefined;
  const subjectValue = ov?.subject ?? draftQuery.data?.draft.subject ?? "";
  const bodyValue = ov?.body ?? draftQuery.data?.draft.body ?? "";

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Template: <span className="font-medium">{mode === "lane_building" ? "Lane-building" : "Exact load"}</span>
        {" · "}Edits below override the rendered template per-carrier for this send only.
      </div>
      {carrierIds.length > 1 && (
        <div className="flex items-center gap-1 flex-wrap" data-testid="tabs-draft-carriers">
          {carrierIds.map((rid, i) => {
            const r = opportunityCarriers.find(x => x.id === rid);
            const c = r ? carriersById.get(r.carrierId) : null;
            const edited = !!overrides[rid];
            return (
              <Button
                key={rid}
                size="sm"
                variant={i === safeIndex ? "secondary" : "ghost"}
                className="h-7 text-xs"
                onClick={() => setDraftIndex(i)}
                data-testid={`tab-draft-${rid}`}
              >
                {c?.name ?? `#${i + 1}`}{edited ? " ●" : ""}
              </Button>
            );
          })}
        </div>
      )}
      {currentRowId && (
        <>
          <div className="text-[11px] text-muted-foreground">
            To: <span className="font-medium">{draftQuery.data?.draft.toEmail ?? (draftQuery.isLoading ? "…" : "(no email on file)")}</span>
            {currentCarrier && <> · {currentCarrier.name}</>}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Subject</label>
            <Input
              value={subjectValue}
              disabled={draftQuery.isLoading}
              onChange={(e) => setOverrides(prev => ({
                ...prev,
                [currentRowId]: { subject: e.target.value, body: prev[currentRowId]?.body ?? bodyValue },
              }))}
              data-testid="input-draft-subject"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Body</label>
            <Textarea
              rows={10}
              value={bodyValue}
              disabled={draftQuery.isLoading}
              onChange={(e) => setOverrides(prev => ({
                ...prev,
                [currentRowId]: { subject: prev[currentRowId]?.subject ?? subjectValue, body: e.target.value },
              }))}
              data-testid="textarea-draft-body"
            />
            {ov && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 text-[11px]"
                onClick={() => setOverrides(prev => {
                  const { [currentRowId]: _drop, ...rest } = prev;
                  return rest;
                })}
                data-testid="button-reset-draft"
              >
                Reset to template
              </Button>
            )}
          </div>
        </>
      )}
      <div>
        <label className="text-xs text-muted-foreground">Schedule (optional)</label>
        <Input
          type="datetime-local"
          value={scheduleAt}
          onChange={(e) => setScheduleAt(e.target.value)}
          data-testid="input-schedule-at"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          Leave blank to send wave 1 immediately. Follow-up waves auto-cascade every 48h until a positive reply lands.
        </p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// PROOF OF DELIVERY (Task #614)
// ────────────────────────────────────────────────────────────────────────────
// Surfaces matched POD emails on the load detail page. Empty states are
// hidden when there's no orderId on the FO so we don't litter older loads
// with an "(no PODs yet)" panel that has no actionable meaning.
interface PodAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  isPodCandidate: boolean;
}
interface LoadPodRow {
  id: string;
  receivedAt: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  bodyPreview: string | null;
  matchedOrderId: string | null;
  forwardStatus: string;
  deliveryMethod: "email" | "in_app" | null;
  hasAttachments: boolean;
  attachmentMeta: PodAttachmentMeta[] | null;
}
interface LoadPodsResponse {
  orderId: string;
  count: number;
  rows: LoadPodRow[];
}

function fmtPodBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ProofOfDeliverySection({ orderId }: { orderId: string | null }) {
  const { data, isLoading } = useQuery<LoadPodsResponse>({
    queryKey: ["/api/loads/by-order-id", orderId, "pods"],
    enabled: !!orderId,
    queryFn: async () => {
      const res = await fetch(
        `/api/loads/by-order-id/${encodeURIComponent(orderId!)}/pods`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  if (!orderId) return null;

  return (
    <Card data-testid="card-proof-of-delivery">
      <CardHeader>
        <CardTitle className="text-base">Proof of Delivery</CardTitle>
        <CardDescription>
          POD emails matched to order <strong>{orderId}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && (data?.count ?? 0) === 0 && (
          <p
            className="text-xs text-muted-foreground py-4 text-center"
            data-testid="text-pod-empty"
          >
            No PODs received yet for this load.
          </p>
        )}
        {!isLoading && (data?.count ?? 0) > 0 && (
          <ul className="space-y-2">
            {data!.rows.map((r) => (
              <li
                key={r.id}
                className="border rounded-md p-3"
                data-testid={`row-load-pod-${r.id}`}
              >
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-medium truncate">
                    {r.subject || "(no subject)"}
                  </span>
                  {r.deliveryMethod && (
                    <Badge variant="outline" className="text-[10px]">
                      {r.deliveryMethod === "email" ? "via email" : "in-app"}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {r.fromName || r.fromEmail || "(unknown)"}
                  {" · "}
                  {fmtWindow(r.receivedAt)}
                </div>
                {r.attachmentMeta && r.attachmentMeta.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.attachmentMeta.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1 truncate">
                          <span className="font-mono">{a.name}</span>
                          <span className="text-muted-foreground ml-2">
                            {fmtPodBytes(a.sizeBytes)}
                          </span>
                        </div>
                        <a
                          href={`/api/pods/${r.id}/attachments/${a.id}/download`}
                          data-testid={`button-load-pod-download-${a.id}`}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                          >
                            Download
                          </Button>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ────────────────────────────────────────────────────────────────────────────
export default function AvailableFreightDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const { toast } = useToast();
  const [carrierSearch, setCarrierSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // shortlist carrier-row ids
  const [selectedPool, setSelectedPool] = useState<Set<string>>(new Set()); // pool carrier ids (carriers.id)
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const [outcomeRow, setOutcomeRow] = useState<DetailCarrier | null>(null);
  const [outcomeValue, setOutcomeValue] = useState<FreightOpportunityResponseOutcome>("interested_now");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [draftIndex, setDraftIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, { subject: string; body: string }>>({});
  const [activityOpen, setActivityOpen] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<DetailResponse>({
    queryKey: ["/api/freight-opportunities", id],
    queryFn: async () => {
      const res = await fetch(`/api/freight-opportunities/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data as DetailResponse | undefined;
      if (!d) return false;
      return (d as any).rankingInFlight ? 3000 : false;
    },
  });

  const rerankMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/freight-opportunities/${id}/rerank`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id, "carrier-pool"] });
      toast({ title: "Re-ranked", description: "Carrier shortlist re-scored." });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't re-rank", description: err?.message ?? "Please try again.", variant: "destructive" });
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

  const promoteFromPoolMutation = useMutation({
    mutationFn: async (carrierIds: string[]) => {
      const res = await apiRequest("POST", `/api/freight-opportunities/${id}/carriers/from-pool`, { carrierIds });
      return res.json() as Promise<{ added: number; reused: number; rowIdsByCarrierId: Record<string, string> }>;
    },
  });

  const sendMutation = useMutation({
    mutationFn: async ({ carrierRowIds, scheduleAtIso, overrides: ov }: { carrierRowIds: string[]; scheduleAtIso?: string | null; overrides?: Record<string, { subject: string; body: string }> }) => {
      const res = await apiRequest("POST", `/api/freight-opportunities/${id}/send`, {
        carrierRowIds,
        scheduleAt: scheduleAtIso ?? null,
        overrides: ov && Object.keys(ov).length > 0 ? ov : undefined,
      });
      return res.json() as Promise<{ results: Array<{ carrierName: string; status: string; blockedReason?: string; error?: string }> }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities"], exact: false });
      const sent = data.results.filter(r => r.status === "sent").length;
      const sched = data.results.filter(r => r.status === "scheduled").length;
      const blocked = data.results.filter(r => r.status === "blocked" || r.status === "no_email" || r.status === "failed").length;
      toast({
        title: sent + sched > 0 ? "Outreach queued" : "No outreach sent",
        description: `Sent: ${sent}, scheduled: ${sched}, blocked/failed: ${blocked}`,
        variant: blocked > 0 && sent + sched === 0 ? "destructive" : "default",
      });
      setSendModalOpen(false);
      setSelected(new Set());
      setSelectedPool(new Set());
      setScheduleAt("");
      setOverrides({});
      setDraftIndex(0);
    },
    onError: (err: any) => {
      toast({ title: "Send failed", description: err?.message ?? "Please try again", variant: "destructive" });
    },
  });

  const outcomeMutation = useMutation({
    mutationFn: async ({ rowId, outcome, notes }: { rowId: string; outcome: string; notes: string }) => {
      const res = await apiRequest("POST", `/api/freight-opportunities/${id}/carriers/${rowId}/response`,
        { outcome, notes: notes || null });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
      toast({ title: "Outcome logged" });
      setOutcomeRow(null);
      setOutcomeNotes("");
    },
    onError: (err: any) => {
      toast({ title: "Couldn't log outcome", description: err?.message ?? "Please try again", variant: "destructive" });
    },
  });

  const swapCarrierMutation = useMutation({
    mutationFn: async ({ rowId, otherRowId }: { rowId: string; otherRowId: string }) => {
      const res = await apiRequest("POST", `/api/freight-opportunities/${id}/carriers/${rowId}/swap`, { otherRowId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't reorder", description: err?.message ?? "Please try again.", variant: "destructive" });
    },
  });

  const grouped = useMemo(() => {
    const q = carrierSearch.trim().toLowerCase();
    const filtered = !q ? carriers : carriers.filter(c => {
      const carrier = carrierById.get(c.carrierId);
      const haystack = `${carrier?.name ?? ""} ${carrier?.mcDot ?? ""} ${c.explanation ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
    const buckets = new Map<FreightOpportunityBucket, DetailCarrier[]>();
    for (const b of BUCKET_ORDER) buckets.set(b, []);
    for (const row of filtered) {
      if (row.excludedReason) continue;
      const key = (row.bucket as FreightOpportunityBucket) || "exploratory";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    for (const [, rows] of buckets) {
      rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    }
    return buckets;
  }, [carriers, carrierById, carrierSearch]);

  const excludedRows = useMemo(() => carriers.filter(c => !!c.excludedReason), [carriers]);
  const includedCount = carriers.filter(c => !c.excludedReason).length;
  const totalCount = carriers.length;
  const sentCount = carriers.filter(c => !!c.sentAt).length;
  const respondedCount = carriers.filter(c => !!c.lastResponse).length;
  const positiveCount = carriers.filter(c =>
    c.lastResponse && (OUTCOME_LABELS[c.lastResponse.outcome]?.tone === "good")).length;

  const totalSelected = selected.size + selectedPool.size;
  const coveredAt = opp?.status === "covered" ? (opp as any).coveredAt as string | null : null;
  const coverWinner = useMemo(() => {
    if (opp?.status !== "covered") return null;
    const winRow = carriers.find(c => c.lastResponse?.outcome === "booked");
    return winRow ? { name: carrierById.get(winRow.carrierId)?.name ?? "carrier", rate: null as number | null } : null;
  }, [opp, carriers, carrierById]);

  // Task #638 — Reason picker state. Single-action only; bulk paths
  // (Clear, Send wave, etc.) deliberately do NOT enqueue pickers because
  // the rep is in a power flow, not a per-carrier judgment.
  const [overridePicker, setOverridePicker] = useState<{
    carrier: CarrierOverridePickerCarrier;
    lane: CarrierOverridePickerLane;
    action: CarrierOverrideAction;
  } | null>(null);

  const pickerLane = (): CarrierOverridePickerLane => ({
    origin: opp?.origin ?? null,
    originState: opp?.originState ?? null,
    destination: opp?.destination ?? null,
    destinationState: opp?.destinationState ?? null,
    equipmentType: opp?.equipmentType ?? null,
  });

  const onSelectChange = (rowId: string, sel: boolean) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (sel) n.add(rowId); else n.delete(rowId);
      return n;
    });
    // Task #638 — Top-3 deselect on the wave fires the reason picker. Rank
    // is read off the persisted row so it stays stable across re-fetches.
    if (!sel) {
      const row = carriers.find(c => c.id === rowId);
      if (row && row.carrierId && typeof row.rank === "number" && row.rank >= 1 && row.rank <= 3) {
        const carrier = carrierById.get(row.carrierId);
        setOverridePicker({
          carrier: { carrierId: row.carrierId, carrierName: carrier?.name ?? "carrier" },
          lane: pickerLane(),
          action: "deselect_top3",
        });
      }
    }
  };

  const onLogOutcomeQuick = (rowId: string, outcome: string, _rate: string) => {
    outcomeMutation.mutate({ rowId, outcome, notes: _rate ? `Quoted rate: $${_rate}` : "" });
  };

  const onMove = (rowId: string, dir: -1 | 1) => {
    const row = carriers.find(c => c.id === rowId);
    if (!row) return;
    const peers = (grouped.get((row.bucket as FreightOpportunityBucket) || "exploratory") ?? []);
    const idx = peers.findIndex(p => p.id === rowId);
    const swapWith = peers[idx + dir];
    if (!swapWith) return;
    swapCarrierMutation.mutate({ rowId, otherRowId: swapWith.id });
  };

  const togglePool = (carrierId: string) => {
    setSelectedPool(prev => {
      const n = new Set(prev);
      if (n.has(carrierId)) n.delete(carrierId); else n.add(carrierId);
      return n;
    });
  };
  const selectPoolIds = (carrierIds: string[]) => {
    setSelectedPool(prev => {
      const n = new Set(prev);
      carrierIds.forEach(id => n.add(id));
      return n;
    });
  };
  const clearPoolIds = (carrierIds: string[]) => {
    setSelectedPool(prev => {
      const n = new Set(prev);
      carrierIds.forEach(id => n.delete(id));
      return n;
    });
  };

  // ── Loading / error states ────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="container mx-auto p-4 space-y-4 max-w-screen-xl">
        <Skeleton className="h-12 w-full" />
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

  const customerName = company?.name ?? "Customer";
  const lane = fmtLane(opp.origin, opp.originState, opp.destination, opp.destinationState);

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* ── STICKY HEADER ──────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-card border-b border-border shadow-sm">
        <div className="px-6 py-2.5 flex items-center gap-3">
          <Link href="/available-freight">
            <button className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm" data-testid="button-back-to-queue">
              <ArrowLeft className="h-4 w-4" /> Queue
            </button>
          </Link>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-2 min-w-0">
            {company ? (
              <Link href={`/companies/${company.id}`}>
                <span className="text-sm font-semibold hover:underline cursor-pointer truncate" data-testid="link-company">{customerName}</span>
              </Link>
            ) : (
              <span className="text-sm font-semibold truncate">{customerName}</span>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="text-sm text-muted-foreground truncate" data-testid="text-detail-lane">{lane}</span>
            {opp.equipmentType && (
              <Badge variant="outline" className="text-[10px]" data-testid="badge-equipment">{opp.equipmentType}</Badge>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActivityOpen(v => !v)}
              data-testid="button-activity"
            >
              <Activity className="h-3.5 w-3.5 mr-1.5" /> Activity
            </Button>
            <Link href={`/lwq?lane=${encodeURIComponent(`${opp.origin}|${opp.destination}`)}`}>
              <Button variant="ghost" size="sm" data-testid="button-compare-lwq">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Compare to LWQ
              </Button>
            </Link>
          </div>
        </div>
        {/* One-line opportunity summary */}
        <div className="px-6 py-2 border-t border-border/60 bg-muted/30">
          <div className="flex items-center gap-4 text-[12px] text-foreground/80 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <Truck className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium" data-testid="text-load-count">{opp.loadCount} load{opp.loadCount === 1 ? "" : "s"}</span>
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span>Pickup <span className="font-medium">{fmtWindow(opp.pickupWindowStart)}</span> · {leadTimeText(opp.pickupWindowStart)}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${
                opp.confidenceFlag === "low" ? "bg-rose-500" : opp.confidenceFlag === "high" ? "bg-emerald-500" : "bg-amber-500"
              }`} />
              {opp.confidenceFlag === "low" ? "Low confidence" : opp.confidenceFlag === "high" ? "High confidence" : "Normal confidence"}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span><span className="font-medium tabular-nums">{sentCount} / {totalCount}</span> sent</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="tabular-nums">{respondedCount} repl{respondedCount === 1 ? "y" : "ies"}{positiveCount > 0 ? ` · ${positiveCount} positive` : ""}</span>
            {coverWinner && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1" data-testid="text-covered">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Covered by {coverWinner.name}
                </span>
              </>
            )}
            {opp.status !== "covered" && opp.status !== "open" && (
              <Badge variant="outline" className="text-[10px]" data-testid="badge-status">{opp.status.replace(/_/g, " ")}</Badge>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1340px] mx-auto px-6 py-5 space-y-4">
        {opp.confidenceFlag === "low" && (
          <div className="border border-amber-500/50 bg-amber-500/5 rounded-lg flex items-start gap-3 px-4 py-3" data-testid="banner-low-confidence">
            <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-300">Low confidence shortlist</p>
              <p className="text-xs text-amber-700/90 dark:text-amber-300/90">
                Few proven carriers matched. Review the bucket mix carefully before sending.
              </p>
            </div>
          </div>
        )}

        <CarrierIntelligenceBand opp={opp} customerName={customerName} />

        {/* ── RANKED CARRIERS ────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold">Ranked carriers</h2>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                Grouped into buckets by fit. Drag to reorder within a bucket. Excluded carriers stay visible below.
              </p>
            </div>
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={carrierSearch}
                onChange={e => setCarrierSearch(e.target.value)}
                placeholder="Filter carriers"
                className="pl-8 w-56"
                data-testid="input-carrier-search"
              />
            </div>
          </div>

          {totalCount === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground space-y-3" data-testid="state-empty-carriers">
                {(data as any)?.rankingInFlight ? (
                  <>
                    <RefreshCw className="h-5 w-5 mx-auto animate-spin" />
                    <p className="font-medium">Ranking carriers…</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No carriers were ranked for this opportunity.</p>
                    <Button size="sm" variant="outline" onClick={() => rerankMutation.mutate()} disabled={rerankMutation.isPending} data-testid="button-rerank-carriers">
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rerankMutation.isPending ? "animate-spin" : ""}`} />
                      Try ranking again
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              {BUCKET_ORDER.map((bucket, idx) => {
                const rows = grouped.get(bucket) ?? [];
                if (rows.length === 0) return null;
                return (
                  <BucketSection
                    key={bucket}
                    bucket={bucket}
                    rows={rows}
                    carrierById={carrierById}
                    selected={selected}
                    onSelectChange={onSelectChange}
                    onLogOutcomeQuick={onLogOutcomeQuick}
                    onMove={onMove}
                    onSwapRows={(sourceRowId, targetRowId) => swapCarrierMutation.mutate({ rowId: sourceRowId, otherRowId: targetRowId })}
                    defaultOpen={idx === 0}
                  />
                );
              })}

              <SuggestedPool
                oppId={id}
                selectedPoolIds={selectedPool}
                onTogglePool={togglePool}
                onSelectPoolIds={selectPoolIds}
                onClearPoolIds={clearPoolIds}
              />
            </>
          )}
        </div>

        {/* ── EXCLUDED ────────────────────────────────────────────────────── */}
        {excludedRows.length > 0 && (
          <div className="border border-border rounded-lg bg-card" data-testid="section-excluded">
            <button
              onClick={() => setExcludedOpen(v => !v)}
              aria-expanded={excludedOpen}
              className="w-full flex items-center justify-between px-4 py-2.5 hover-elevate"
            >
              <div className="flex items-center gap-2 text-sm">
                {excludedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                <span className="font-medium">Excluded by guardrails</span>
                <span className="text-muted-foreground">({excludedRows.length})</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {Object.entries(
                  excludedRows.reduce<Record<string, number>>((m, r) => {
                    const k = r.excludedReason ?? "other";
                    m[k] = (m[k] ?? 0) + 1;
                    return m;
                  }, {})
                ).map(([reason, n]) => (
                  <Badge key={reason} variant="outline" className="text-[10px]">
                    {EXCLUDED_LABELS[reason as FreightOpportunityExcludedReason] ?? reason}: {n}
                  </Badge>
                ))}
              </div>
            </button>
            {excludedOpen && (
              <div className="border-t border-border/60 divide-y divide-border/40">
                {excludedRows.map(r => {
                  const carrier = carrierById.get(r.carrierId);
                  return (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid={`row-excluded-${r.id}`}>
                      <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate">{carrier?.name ?? "Unknown carrier"}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {EXCLUDED_LABELS[r.excludedReason as FreightOpportunityExcludedReason] ?? r.excludedReason}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <ProofOfDeliverySection
          orderId={
            ((opp.sourceRef as { orderId?: unknown } | null | undefined)?.orderId as string | undefined) ?? null
          }
        />

        <div className="h-12" />
      </div>

      <ActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} audit={data?.audit ?? []} />

      {/* ── BULK ACTION BAR ─────────────────────────────────────────────── */}
      {totalSelected > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card shadow-lg" data-testid="bar-bulk-actions">
          <div className="max-w-[1340px] mx-auto px-6 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium">
              {totalSelected} carrier{totalSelected === 1 ? "" : "s"} selected
            </span>
            <span className="text-xs text-muted-foreground">
              · {selected.size} from shortlist · {selectedPool.size} from pool
            </span>
            {selectedPool.size > 0 && (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1" data-testid="hint-pool-promote">
                <Info className="h-3 w-3" /> Pool picks will be added to the shortlist as "Rep-added" before sending.
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSelected(new Set()); setSelectedPool(new Set()); }}
                data-testid="button-clear-selection"
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  // Materialize any pool selections as shortlist rows first.
                  if (selectedPool.size > 0) {
                    const poolIds = Array.from(selectedPool);
                    try {
                      const promoted = await promoteFromPoolMutation.mutateAsync(poolIds);
                      // Merge the new row IDs into selected, then re-fetch detail so
                      // the buckets show the new rep_added rows.
                      const newRowIds = Object.values(promoted.rowIdsByCarrierId);
                      setSelected(prev => {
                        const n = new Set(prev);
                        newRowIds.forEach(rid => n.add(rid));
                        return n;
                      });
                      setSelectedPool(new Set());
                      await queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id] });
                      await queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities", id, "carrier-pool"] });
                      // Task #638 — Single pool-add is the "added outside
                      // top-N" signal IFF the carrier wasn't already on the
                      // wave shortlist (`carriers`). Multi-add stays
                      // picker-free.
                      if (poolIds.length === 1) {
                        const cid = poolIds[0];
                        const carrier = carrierById.get(cid);
                        if (carrier && shouldFireAddedOutsideTopN(cid, carriers.map(c => c.carrierId))) {
                          setOverridePicker({
                            carrier: { carrierId: cid, carrierName: carrier.name },
                            lane: pickerLane(),
                            action: "added_outside_topn",
                          });
                        }
                      }
                    } catch (err: any) {
                      toast({ title: "Couldn't add pool carriers", description: err?.message ?? "Try again.", variant: "destructive" });
                      return;
                    }
                  }
                  setScheduleAt("");
                  setSendModalOpen(true);
                }}
                disabled={(selected.size === 0 && selectedPool.size === 0) || promoteFromPoolMutation.isPending}
                className="bg-amber-500 text-zinc-900 hover:bg-amber-400"
                data-testid="button-send-wave"
              >
                <Send className="h-3.5 w-3.5 mr-1.5" />
                {promoteFromPoolMutation.isPending
                  ? "Adding pool carriers…"
                  : `Send wave to ${totalSelected} carrier${totalSelected === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── SEND DIALOG ─────────────────────────────────────────────────── */}
      <Dialog open={sendModalOpen} onOpenChange={setSendModalOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-send-outreach">
          <DialogHeader>
            <DialogTitle>Send outreach</DialogTitle>
            <DialogDescription>
              {selected.size} carrier{selected.size === 1 ? "" : "s"} selected from shortlist. Templates render server-side. Guardrails are re-checked at send time.
            </DialogDescription>
          </DialogHeader>
          <SendModalBody
            oppId={id}
            mode={opp.mode}
            carrierIds={Array.from(selected)}
            carriersById={carrierById}
            opportunityCarriers={carriers}
            draftIndex={draftIndex}
            setDraftIndex={setDraftIndex}
            overrides={overrides}
            setOverrides={setOverrides}
            scheduleAt={scheduleAt}
            setScheduleAt={setScheduleAt}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSendModalOpen(false)} data-testid="button-cancel-send">Cancel</Button>
            <Button
              onClick={() => {
                const carrierRowIds = Array.from(selected);
                const scheduleAtIso = scheduleAt ? new Date(scheduleAt).toISOString() : null;
                sendMutation.mutate({ carrierRowIds, scheduleAtIso, overrides });
              }}
              disabled={sendMutation.isPending || selected.size === 0}
              data-testid="button-confirm-send"
            >
              {sendMutation.isPending ? "Sending…" : scheduleAt ? "Schedule wave" : "Send now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OUTCOME DIALOG (full version, kept for backwards compat) ────── */}
      <Dialog open={!!outcomeRow} onOpenChange={(o) => !o && setOutcomeRow(null)}>
        <DialogContent data-testid="dialog-log-outcome">
          <DialogHeader>
            <DialogTitle>Log carrier response</DialogTitle>
            <DialogDescription>
              Record what this carrier said. Positive outcomes feed back into lane-fit signals.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={outcomeValue} onValueChange={(v) => setOutcomeValue(v as FreightOpportunityResponseOutcome)}>
              <SelectTrigger data-testid="select-outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(OUTCOME_LABELS)
                  .filter(([k]) => ["interested_now","interested_few_days","interested_next_week","interested_future","booked","declined","not_qualified","do_not_contact_lane","no_response"].includes(k))
                  .map(([k, v]) => (
                    <SelectItem key={k} value={k} data-testid={`option-outcome-${k}`}>{v.label}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Textarea placeholder="Notes (optional)" value={outcomeNotes} onChange={(e) => setOutcomeNotes(e.target.value)} data-testid="textarea-outcome-notes" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOutcomeRow(null)} data-testid="button-cancel-outcome">Cancel</Button>
            <Button
              onClick={() => {
                if (!outcomeRow) return;
                outcomeMutation.mutate({ rowId: outcomeRow.id, outcome: outcomeValue, notes: outcomeNotes });
              }}
              disabled={outcomeMutation.isPending}
              data-testid="button-confirm-outcome"
            >
              {outcomeMutation.isPending ? "Saving…" : "Save outcome"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Task #638 — One-tap reason picker for top-3 deselect / outside-top-N add. */}
      <CarrierOverrideReasonPicker
        open={!!overridePicker}
        onOpenChange={(o) => { if (!o) setOverridePicker(null); }}
        carrier={overridePicker?.carrier ?? null}
        lane={overridePicker?.lane ?? {}}
        action={overridePicker?.action ?? "deselect_top3"}
      />
    </div>
  );
}
