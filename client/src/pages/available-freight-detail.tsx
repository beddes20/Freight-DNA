import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft, AlertTriangle, ShieldAlert, Truck, MapPin, Calendar,
  Pin, PinOff, ArrowUp, ArrowDown, Search, Info, Send, Mail, MessageSquare,
  DollarSign, TrendingUp, RefreshCw,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
  // legacy
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

function fmtWindow(start: string, _end?: string | null) {
  // Available Freight rows always represent a single pickup day. The
  // pickupWindowEnd field exists for back-compat with the older lane_building
  // mode but is intentionally ignored for display — show only the canonical
  // pickup day so reps don't see misleading date ranges.
  if (!start) return "—";
  const s = new Date(start);
  if (isNaN(s.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return s.toLocaleDateString(undefined, opts);
}

function fmtLane(
  origin: string,
  originState: string | null | undefined,
  destination: string,
  destinationState: string | null | undefined,
) {
  const o = originState ? `${origin}, ${originState.toUpperCase()}` : origin;
  const d = destinationState ? `${destination}, ${destinationState.toUpperCase()}` : destination;
  return `${o} → ${d}`;
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

function CarrierIntelligencePanel({ opp, customerName }: { opp: FreightOpportunity; customerName: string | null }) {
  const params = new URLSearchParams({
    origin: opp.origin,
    destination: opp.destination,
  });
  if (opp.originState) params.set("originState", opp.originState);
  if (opp.destinationState) params.set("destinationState", opp.destinationState);
  if (opp.equipmentType) params.set("trailer", opp.equipmentType);
  if (customerName) params.set("customer", customerName);

  const { data, isLoading, isError } = useQuery<BlendedRateResponse>({
    queryKey: ["/api/carrier-intelligence/lane-pricing", params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/carrier-intelligence/lane-pricing?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Lane pricing failed (${res.status})`);
      return res.json();
    },
  });

  const confidenceTone =
    data?.confidence === "high"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : data?.confidence === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
        : "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30";

  return (
    <Card data-testid="card-carrier-intelligence">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Carrier Intelligence — Suggested Buy Rate
            </CardTitle>
            <CardDescription className="text-xs">
              Blended Sonar TRAC market rate + your realized history on this lane.
            </CardDescription>
          </div>
          {data && (
            <Badge variant="outline" className={`text-[10px] ${confidenceTone}`} data-testid="badge-pricing-confidence">
              {data.confidence === "none" ? "no rate" : `${data.confidence} confidence`}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <Skeleton className="h-20 w-full" />}
        {isError && (
          <p className="text-xs text-muted-foreground" data-testid="text-pricing-error">
            Lane pricing temporarily unavailable.
          </p>
        )}
        {data && (
          <div className="space-y-3">
            {data.targetBuyRpm == null ? (
              <p className="text-xs text-muted-foreground" data-testid="text-no-rate">
                No buy rate suggestion: {data.reason}
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div data-testid="metric-target-buy">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Target buy</div>
                  <div className="text-2xl font-semibold tabular-nums">${data.targetBuyRpm.toFixed(2)}<span className="text-xs text-muted-foreground font-normal">/mi</span></div>
                </div>
                {data.suggestedSellRpm != null && (
                  <div data-testid="metric-suggested-sell">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Suggested ask</div>
                    <div className="text-2xl font-semibold tabular-nums">${data.suggestedSellRpm.toFixed(2)}<span className="text-xs text-muted-foreground font-normal">/mi</span></div>
                  </div>
                )}
                {data.expectedMarginPct && (
                  <div data-testid="metric-margin-band">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Expected margin</div>
                    <div className="text-2xl font-semibold tabular-nums">{data.expectedMarginPct.low.toFixed(1)}–{data.expectedMarginPct.high.toFixed(1)}<span className="text-xs text-muted-foreground font-normal">%</span></div>
                  </div>
                )}
              </div>
            )}
            <div className="border-t pt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" data-testid="text-leg-sonar">
                <TrendingUp className="h-3 w-3" />
                Sonar: {data.legs.sonar?.ratePerMile != null ? `$${Number(data.legs.sonar.ratePerMile).toFixed(2)}/mi` : "n/a"}
                {" "}({Math.round(data.weights.sonar * 100)}%)
                {data.legs.sonar?.isStale && <span className="text-amber-600 dark:text-amber-400">· stale</span>}
              </span>
              <span data-testid="text-leg-history">
                History: {data.legs.history?.avgCostPerMile != null ? `$${Number(data.legs.history.avgCostPerMile).toFixed(2)}/mi` : "n/a"}
                {" "}({Math.round(data.weights.history * 100)}%, {data.legs.history?.loads ?? 0} loads · {data.historyFallbackTier})
              </span>
              {data.sonarWeightAutoBumped && (
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30">
                  Sonar auto-bumped (sparse history)
                </Badge>
              )}
              {data.refusedBelowThreshold && (
                <Badge variant="outline" className="text-[10px] bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30">
                  Below refusal threshold
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CarrierRow({
  row, rank, included, selected, onSelectChange,
  onToggleInclude, onPin, onMove, onLogOutcome,
  isFirstInBucket, isLastInBucket,
}: {
  row: DetailCarrier & { _carrier?: Carrier | null };
  rank: number;
  included: boolean;
  selected: boolean;
  onSelectChange: (id: string, sel: boolean) => void;
  onToggleInclude: (id: string, include: boolean) => void;
  onPin: (id: string, pin: boolean) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onLogOutcome: (row: DetailCarrier) => void;
  isFirstInBucket: boolean;
  isLastInBucket: boolean;
}) {
  const carrier = row._carrier ?? null;
  const excluded = !!row.excludedReason;
  const isPinned = row.bucket === "rep_added";
  const sentAt = row.sentAt ? new Date(row.sentAt) : null;
  const scheduledFor = row.scheduledFor ? new Date(row.scheduledFor) : null;

  return (
    <div
      className={`flex items-start gap-3 px-3 py-2 border-b last:border-b-0 ${excluded ? "opacity-60" : ""}`}
      data-testid={`row-carrier-${row.id}`}
    >
      <div className="flex items-start pt-1.5 shrink-0">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelectChange(row.id, e.target.checked)}
          disabled={excluded || !!sentAt}
          className="h-4 w-4 rounded border-input"
          data-testid={`checkbox-select-${row.id}`}
        />
      </div>
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
          {sentAt && (
            <Badge variant="outline" className="bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30 text-[10px]" data-testid={`badge-sent-${row.id}`}>
              <Mail className="h-3 w-3 mr-1" />
              Sent {sentAt.toLocaleDateString()}{row.wave ? ` · wave ${row.wave}` : ""}
            </Badge>
          )}
          {!sentAt && scheduledFor && (
            <Badge variant="outline" className="bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 text-[10px]" data-testid={`badge-scheduled-${row.id}`}>
              <Calendar className="h-3 w-3 mr-1" />
              Scheduled {scheduledFor.toLocaleString()}
            </Badge>
          )}
          {row.lastResponse && <OutcomeBadge outcome={row.lastResponse.outcome} />}
          {row.lastSendError && (
            <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30 text-[10px]" title={row.lastSendError}>
              Send failed
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
        {sentAt && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onLogOutcome(row)}
            title="Log carrier response"
            data-testid={`button-log-outcome-${row.id}`}
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1" />
            Log
          </Button>
        )}
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

export default function AvailableFreightDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const { toast } = useToast();
  const [carrierSearch, setCarrierSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const [outcomeRow, setOutcomeRow] = useState<DetailCarrier | null>(null);
  const [outcomeValue, setOutcomeValue] = useState<FreightOpportunityResponseOutcome>("interested_now");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [draftIndex, setDraftIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, { subject: string; body: string }>>({});

  const { data, isLoading, isError } = useQuery<DetailResponse>({
    queryKey: ["/api/freight-opportunities", id],
    queryFn: async () => {
      const res = await fetch(`/api/freight-opportunities/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    // Ranking now runs inline on the server (with a 25s timeout, mirroring
    // the LWQ /carrier-suggestions flow). The response is self-contained, so
    // polling is only needed in the rare case where another concurrent caller
    // is still ranking. We never poll just because carriers is empty — that
    // previously caused infinite re-rank loops when the ranker legitimately
    // produced zero matches.
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
      toast({ title: "Re-ranked", description: "Carrier shortlist re-scored." });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't re-rank",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
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
      const res = await apiRequest(
        "POST",
        `/api/freight-opportunities/${id}/carriers/${rowId}/response`,
        { outcome, notes: notes || null },
      );
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
  const selectableRows = useMemo(
    () => carriers.filter(c => !c.excludedReason && !c.sentAt),
    [carriers],
  );
  const sentCount = carriers.filter(c => !!c.sentAt).length;
  const respondedCount = carriers.filter(c => !!c.lastResponse).length;
  const positiveCount = carriers.filter(c =>
    c.lastResponse && (OUTCOME_LABELS[c.lastResponse.outcome]?.tone === "good")).length;

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
                  {fmtLane(opp.origin, opp.originState, opp.destination, opp.destinationState)}
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

      <CarrierIntelligencePanel opp={opp} customerName={company?.name ?? null} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">Ranked carriers</CardTitle>
              <CardDescription className="text-xs">
                Grouped into buckets by fit. Excluded carriers stay visible so you can override.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs text-muted-foreground tabular-nums" data-testid="text-outreach-summary">
                {sentCount} sent · {respondedCount} replied · {positiveCount} positive
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={selected.size === 0}
                onClick={() => {
                  setScheduleAt("");
                  setSendModalOpen(true);
                }}
                data-testid="button-open-send"
              >
                <Send className="h-4 w-4 mr-1.5" />
                Send outreach ({selected.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelected(prev => {
                    if (prev.size === selectableRows.length) return new Set();
                    return new Set(selectableRows.map(r => r.id));
                  });
                }}
                disabled={selectableRows.length === 0}
                data-testid="button-select-all"
              >
                {selected.size === selectableRows.length && selectableRows.length > 0 ? "Clear" : "Select all"}
              </Button>
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
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {totalCount === 0 ? (
            (data as any)?.rankingInFlight ? (
              <div className="py-12 text-center text-sm text-muted-foreground space-y-2" data-testid="state-ranking-in-flight">
                <RefreshCw className="h-5 w-5 mx-auto animate-spin text-muted-foreground" />
                <p className="font-medium">Ranking carriers…</p>
                <p className="text-xs">
                  Scoring catalog carriers against this lane. This usually takes 10–30 seconds.
                </p>
              </div>
            ) : (
              <div className="py-12 text-center text-sm text-muted-foreground space-y-3" data-testid="state-empty-carriers">
                {(data as any)?.rankError ? (
                  <>
                    <p className="font-medium text-destructive">Ranking failed</p>
                    <p className="text-xs">
                      {(data as any).rankError}. Try again — transient errors often clear on the next attempt.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No carriers were ranked for this opportunity.</p>
                    <p className="text-xs">
                      No catalog carrier had history, region, or equipment signal strong enough to score
                      above the exploratory floor for this lane. Try widening the catalog or importing
                      more historical loads on this corridor.
                    </p>
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => rerankMutation.mutate()}
                  disabled={rerankMutation.isPending}
                  data-testid="button-rerank-carriers"
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rerankMutation.isPending ? "animate-spin" : ""}`} />
                  {rerankMutation.isPending ? "Re-ranking…" : "Try ranking again"}
                </Button>
              </div>
            )
          ) : carriers.every(c => c.excludedReason) ? (
            <div className="py-12 px-6 text-center text-sm text-muted-foreground space-y-3" data-testid="state-all-excluded-carriers">
              <p className="font-medium">All {totalCount} ranked carriers were excluded by guardrails.</p>
              <div className="text-xs flex flex-wrap gap-2 justify-center">
                {Array.from(
                  carriers.reduce((m, c) => {
                    const r = c.excludedReason as FreightOpportunityExcludedReason | null;
                    if (!r) return m;
                    m.set(r, (m.get(r) ?? 0) + 1);
                    return m;
                  }, new Map<FreightOpportunityExcludedReason, number>()).entries(),
                ).map(([reason, count]) => (
                  <Badge key={reason} variant="outline" data-testid={`badge-exclusion-${reason}`}>
                    {EXCLUDED_LABELS[reason] ?? reason}: {count}
                  </Badge>
                ))}
              </div>
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
                        selected={selected.has(row.id)}
                        onSelectChange={(rowId, sel) => {
                          setSelected(prev => {
                            const next = new Set(prev);
                            if (sel) next.add(rowId); else next.delete(rowId);
                            return next;
                          });
                        }}
                        onLogOutcome={(r) => {
                          setOutcomeRow(r);
                          setOutcomeValue("interested_now");
                          setOutcomeNotes("");
                        }}
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

      <Dialog open={sendModalOpen} onOpenChange={setSendModalOpen}>
        <DialogContent data-testid="dialog-send-outreach">
          <DialogHeader>
            <DialogTitle>Send outreach</DialogTitle>
            <DialogDescription>
              {selected.size} carrier{selected.size === 1 ? "" : "s"} selected. Templates and per-carrier subject/body
              are rendered server-side. Guardrails are re-checked at send time — anyone newly blocked will be skipped.
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
            <Button variant="ghost" onClick={() => setSendModalOpen(false)} data-testid="button-cancel-send">
              Cancel
            </Button>
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

      <Dialog open={!!outcomeRow} onOpenChange={(o) => !o && setOutcomeRow(null)}>
        <DialogContent data-testid="dialog-log-outcome">
          <DialogHeader>
            <DialogTitle>Log carrier response</DialogTitle>
            <DialogDescription>
              Record what this carrier said. Positive outcomes feed back into lane-fit signals; do-not-contact and
              decline outcomes suppress future outreach on this lane.
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
            <Textarea
              placeholder="Notes (optional)"
              value={outcomeNotes}
              onChange={(e) => setOutcomeNotes(e.target.value)}
              data-testid="textarea-outcome-notes"
            />
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
