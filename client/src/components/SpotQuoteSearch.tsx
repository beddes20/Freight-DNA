import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z as zod } from "zod";
import { spotQuoteCreateSchema } from "@shared/schema";
import {
  getCityAutocompleteSuggestions,
  getLaneLocationSuggestions,
  normalizeStateAbbr,
} from "@/lib/laneLocationNormalizer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useCqOverlayPortal } from "@/lib/customer-quotes-portal";
import { IntegrationDegradedPill } from "@/components/integration-degraded-pill";
import {
  Search, MapPin, Truck, Calendar, AlertTriangle, TrendingUp, TrendingDown, Minus, Award, Users,
  Clock, Activity, X, ChevronRight, ChevronDown, Copy, RefreshCw, SlidersHorizontal,
  DollarSign, Save, Phone, Mail, FileText, ChevronUp, ThumbsDown,
  Upload, Loader2, Sparkles, FileImage, ClipboardPaste,
} from "lucide-react";

// Task #617 — shape returned by /api/customer-quotes/spot-intake.
type ParsedQuoteIntake = {
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  equipment: string | null;
  pickupDate: string | null;
  customerHint: string | null;
  rateHint: number | null;
  confidence: number;
  rawText: string;
  source: "image" | "email" | "text";
  notes: string[];
};

// Map the parser's equipment vocabulary to the search bar's dropdown options.
function mapIntakeEquipment(eq: string | null): string | null {
  if (!eq) return null;
  const norm = eq.trim().toLowerCase();
  if (norm.includes("dry van") || norm === "van") return "Van";
  if (norm.includes("reefer") || norm.includes("refrig")) return "Reefer";
  if (norm.includes("flat")) return "Flatbed";
  return "Other";
}

// Lightweight customer fuzzy match (mirrors server matchCustomerByHint).
function normaliseCustomerName(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|logistics|transport|trucking)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function matchCustomerHint(hint: string | null, customers: ReadonlyArray<{ id: string; name: string }>): string | null {
  if (!hint || customers.length === 0) return null;
  const target = normaliseCustomerName(hint);
  if (!target) return null;
  const exact = customers.find(c => normaliseCustomerName(c.name) === target);
  if (exact) return exact.id;
  const words = target.split(" ").filter(w => w.length >= 3);
  if (words.length === 0) return null;
  const tokenMatches = customers.filter(c => {
    const n = normaliseCustomerName(c.name);
    return words.every(w => n.includes(w));
  });
  if (tokenMatches.length === 1) return tokenMatches[0].id;
  const containment = customers.filter(c => {
    const n = normaliseCustomerName(c.name);
    return n.includes(target) || target.includes(n);
  });
  if (containment.length === 1) return containment[0].id;
  return null;
}

// Friendly label for the small "auto-filled" chips.
const AUTOFILL_FIELD_LABELS: Record<string, string> = {
  pickupCity: "Pickup city", pickupState: "Pickup state",
  deliveryCity: "Delivery city", deliveryState: "Delivery state",
  equipment: "Mode", pickupDate: "Pickup date", customerId: "Customer",
};

// Tiny accent chip rendered next to a field label when intake auto-filled it.
function AutoFilledChip({ testId, source }: { testId: string; source: string | undefined }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded-[3px] bg-amber-400/15 border border-amber-400/40 text-amber-700 dark:text-amber-300 text-[9px] font-semibold normal-case tracking-normal"
          data-testid={testId}
        >
          <Sparkles className="h-2.5 w-2.5" /> Auto-filled
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs max-w-[280px]">
        From your dropped {source ?? "intake"}.
      </TooltipContent>
    </Tooltip>
  );
}

type Customer = { id: string; name: string };

export type SpotSearchQuery = {
  pickupCity: string;
  pickupState: string;
  deliveryCity: string;
  deliveryState: string;
  equipment?: string;
  pickupDate?: string;
  customerId?: string;
  lookbackDays?: number;
  exactOnly?: boolean;
  includeSimilar?: boolean;
  // Task #514 — Tiered Matching mode. "relaxed" walks the full
  // exact → same_market → same_state → reverse_lane → same_corridor ladder.
  // "strict" only returns exact + same_state pair (legacy behavior).
  matchMode?: "strict" | "relaxed";
};

export type MatchTier = "exact" | "same_market" | "same_state" | "reverse_lane" | "same_corridor";

const TIER_DISPLAY: { tier: MatchTier; label: string; rule: string; accent: TierAccent; icon: "award" | "map" | "users" | "truck" | "activity" }[] = [
  { tier: "exact", label: "Exact lane", rule: "Same origin and destination city + state.", accent: "amber", icon: "award" },
  { tier: "same_market", label: "Same market (~75 mi)", rule: "Both endpoints within ~75 miles by haversine, or sharing the same KMA when coordinates are unavailable.", accent: "blue", icon: "map" },
  { tier: "same_state", label: "Same state pair", rule: "Same origin state and destination state, different cities.", accent: "zinc", icon: "map" },
  { tier: "reverse_lane", label: "Reverse direction", rule: "Lane runs in the opposite direction (origin ↔ destination).", accent: "purple", icon: "activity" },
  { tier: "same_corridor", label: "Same corridor (KMA)", rule: "At least one endpoint shares a KMA — soft corridor overlap.", accent: "teal", icon: "truck" },
];

type TierAccent = "amber" | "blue" | "zinc" | "purple" | "teal";

export type SpotAdvancedDetails = {
  weight?: string;
  commodity?: string;
  pallets?: string;
  truckloadType?: string;
  hazmat?: boolean;
  tempRequired?: boolean;
  specialHandling?: string;
  appointmentRequired?: boolean;
  accessNotes?: string;
};

type EnrichedQuote = {
  id: string; customerId: string; customerName: string;
  originCity: string; originState: string;
  destCity: string; destState: string;
  equipment: string; quotedAmount: string | null; carrierPaid: string | null;
  outcomeStatus: string; outcomeReasonLabel: string | null;
  requestDate: string; repName: string; carrierName: string | null;
};

type TierGroup = {
  tier: MatchTier;
  label: string;
  rule: string;
  count: number;
  // Task #514 — per-tier KPIs from the backend.
  winRate: number;
  avgWonQuoted: number;
  lastWonDays: number | null;
  items: EnrichedQuote[];
  /** @deprecated kept for transitional compatibility — use `items`. */
  quotes?: EnrichedQuote[];
};

type SpotResult = {
  query: SpotSearchQuery;
  resolvedCustomer: { id: string; name: string } | null;
  kpis: {
    exactCount: number; similarCount: number;
    tierCounts: Record<MatchTier, number>;
    customersOnLane: number;
    winRate: number; avgQuoted: number; avgWonQuoted: number; avgCarrierPaid: number;
    avgMargin: number; avgMarginPct: number;
    lastQuotedDays: number | null; lastWonDays: number | null; pendingCount: number;
    confidence: string; freshnessLabel: string | null;
  };
  guidance: {
    suggestedLow: number | null; suggestedHigh: number | null;
    benchmark: number | null;
    benchmarkSource: string;
    confidence: string; message: string;
    tierUsed?: MatchTier | null;
    calibration?: {
      suggestedLow: number | null; suggestedHigh: number | null;
      source: string; tierUsed: MatchTier | null;
      sample: number; note: string;
    } | null;
  };
  market: {
    source: "trac";
    band: { low: number; mid: number; high: number } | null;
    rpm: { low: number | null; mid: number | null; high: number | null } | null;
    contractRpm: number | null;
    miles: number | null;
    confidence: number | null;
    loadCount: number | null;
    avgRpm30d: number | null;
    avgRpm90d: number | null;
    forecast7dRpm: number | null;
    forecastDirection: "up" | "down" | "flat";
    capacityOutlook: string | null;
    originKma: string | null;
    destKma: string | null;
    equipment: "VAN" | "REEFER" | "FLATBED";
    fetchedAt: number;
  } | null;
  marketStatus: { available: boolean; reason: string | null };
  laneTraffic: {
    totalLoads: number; loads30d: number; loads90d: number;
    realized: number; available: number;
    revenue: number; cost: number; margin: number; marginPct: number;
    uniqueCarriers: number;
    tierBreakdown: { exact: number; sameMarket: number; sameState: number };
    lookbackDays: number;
    avgRevenuePerLoad: number;
    avgCostPerLoad: number;
    avgMarginPerLoad: number;
    topCarriers: {
      name: string; loads: number; loads30d: number; loads90d: number;
      revenue: number; cost: number; margin: number; marginPct: number;
      reliabilityScore: number | null; reliabilityTier: string | null;
      lastBuyRate: number | null;
    }[];
  } | null;
  carrierOutreach: {
    carrierId: string | null; name: string;
    fitScore: number; rankScore: number; evidenceTier: string;
    exactLaneRuns: number; nearbyRuns: number;
    loads90d: number; marginPct: number;
    performanceScore: number; tier: string;
    onTimePct: number | null;
    lastRatePaid: number | null;
    lastRatePaidAt: number | null;
    doNotUse: boolean;
    primaryEmail: string | null; phone: string | null;
    inRolodex: boolean;
    presence: "active" | "known" | "cold";
    reason: string | null;
  }[];
  corridorPattern: {
    id: string; name: string; namedCorridor: string | null;
    originRegion: string; destinationRegion: string;
    description: string | null; isBaseline: boolean;
    seasonalityNote: string | null;
    responsibleContact: { contactId: string; contactName: string; status: string; confidenceScore: number } | null;
  } | null;
  exactMatches: EnrichedQuote[];
  similarMatches: EnrichedQuote[];
  tieredMatches: TierGroup[];
  customerPanel: {
    customerId: string; customerName: string; quotes: number;
    wins: number; losses: number; winRate: number; avgQuoted: number;
    avgMargin: number; lastQuotedDays: number | null;
    topCarriers: { name: string; loads: number }[];
  }[];
  outcomeBreakdown: { reason: string; status: string; count: number; pct: number }[];
  carrierHistory: {
    carrierId: string | null; name: string; loads: number;
    avgPaid: number; lowPaid: number; highPaid: number; lastUsedDays: number | null;
  }[];
  internalVariance: {
    rep: string; count: number; avgQuoted: number; winRate: number; avgMargin: number;
  }[];
  attractiveness: {
    score: number; label: string; rationale: string;
    totalQuotes: number; decided: number; winRate: number; avgMargin: number;
  };
  alerts: { id: string; severity: "high" | "medium" | "low"; title: string; detail: string }[];
};

type AutoItem = { city: string; state: string; count: number; source?: "history" | "city" };

// Try to parse "City, ST" or "City ST" (where ST may be a 2-letter code or full
// state name) from a single string. Returns the split when both parts look
// reasonable; otherwise null.
function tryParseCityAndState(raw: string): { city: string; state: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const commaIdx = trimmed.lastIndexOf(",");
  if (commaIdx > 0) {
    const cityPart = trimmed.slice(0, commaIdx).trim();
    const statePart = trimmed.slice(commaIdx + 1).trim();
    if (cityPart && statePart) {
      const { abbr, valid } = normalizeStateAbbr(statePart);
      if (valid && abbr && abbr.length === 2) {
        return { city: cityPart, state: abbr };
      }
    }
    return null;
  }
  // Try "City ST" — last whitespace-separated token is a 2-letter state code.
  const m = trimmed.match(/^(.+?)\s+([A-Za-z]{2})$/);
  if (m) {
    const upper = m[2].toUpperCase();
    const { abbr, valid } = normalizeStateAbbr(upper);
    if (valid && abbr && abbr.length === 2) {
      return { city: m[1].trim(), state: abbr };
    }
  }
  return null;
}

const EQUIPMENT_OPTIONS = ["Any", "Van", "Reefer", "Flatbed", "Other"];
const LOOKBACK_OPTIONS: { label: string; value: string }[] = [
  { label: "All time", value: "0" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "Last 180 days", value: "180" },
  { label: "Last 365 days", value: "365" },
];
const TRUCKLOAD_OPTIONS = ["Full TL", "Partial", "LTL"];
const RECENTS_KEY = "fdna.spotQuote.recents";
const MAX_RECENTS = 6;

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return "—";
  return `$${Math.round(v).toLocaleString()}`;
}
function fmtPct(v: number): string { return `${v.toFixed(0)}%`; }
function num(v: string | null | undefined): number {
  if (!v) return 0; const n = Number(v); return isNaN(n) ? 0 : n;
}

type Recent = SpotSearchQuery & { savedAt: number; label: string };

function loadRecents(): Recent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, MAX_RECENTS) : [];
  } catch { return []; }
}
function saveRecent(q: SpotSearchQuery): void {
  if (typeof window === "undefined") return;
  const label = `${q.pickupCity}, ${q.pickupState} → ${q.deliveryCity}, ${q.deliveryState}${q.equipment && q.equipment !== "Any" ? " · " + q.equipment : ""}`;
  const list = loadRecents().filter(r => r.label !== label);
  list.unshift({ ...q, savedAt: Date.now(), label });
  window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
}

function LaneInput({
  label, value, onChange, kind, testIdCity, testIdState, autoOpen, setAutoOpen,
  cityRef, stateRef, onAdvance, autoFilledCity, autoFilledState, autoFilledSource,
}: {
  label: string;
  value: { city: string; state: string };
  onChange: (v: { city: string; state: string }) => void;
  kind: "origin" | "dest";
  testIdCity: string;
  testIdState: string;
  autoOpen: boolean;
  setAutoOpen: (v: boolean) => void;
  cityRef?: React.MutableRefObject<HTMLInputElement | null>;
  stateRef?: React.MutableRefObject<HTMLInputElement | null>;
  onAdvance?: () => void;
  autoFilledCity?: boolean;
  autoFilledState?: boolean;
  autoFilledSource?: string;
}): JSX.Element {
  const [q, setQ] = useState(value.city);
  const [debouncedQ, setDebouncedQ] = useState(value.city);
  const [activeIdx, setActiveIdx] = useState(-1);
  const internalCityRef = useRef<HTMLInputElement>(null);
  const internalStateRef = useRef<HTMLInputElement>(null);
  const cityEl = cityRef ?? internalCityRef;
  const stateEl = stateRef ?? internalStateRef;
  useEffect(() => { setQ(value.city); }, [value.city]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 180);
    return () => clearTimeout(t);
  }, [q]);

  const items = useQuery<AutoItem[]>({
    queryKey: ["/api/customer-quotes/lane-autocomplete", kind, debouncedQ],
    queryFn: async (): Promise<AutoItem[]> => {
      if (debouncedQ.length < 2) return [];
      const res = await fetch(`/api/customer-quotes/lane-autocomplete?kind=${kind}&q=${encodeURIComponent(debouncedQ)}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedQ.length >= 2 && autoOpen,
    staleTime: 60_000,
  });

  // Local fuzzy + prefix matches from the bundled US cities dataset. Renders
  // immediately while the network request is in flight and supplements the
  // server response with typo-tolerant suggestions.
  const localMatches = useMemo<AutoItem[]>(() => {
    if (debouncedQ.length < 2) return [];
    const prefix = getCityAutocompleteSuggestions(debouncedQ, undefined, 8);
    const fuzzy = prefix.length >= 4 ? [] : getLaneLocationSuggestions(debouncedQ, undefined, 8);
    const merged: { city: string; state: string }[] = [...prefix];
    for (const m of fuzzy) {
      if (!merged.some(p => p.city === m.city && p.state === m.state)) merged.push(m);
    }
    return merged.slice(0, 10).map(m => ({ city: m.city, state: m.state, count: 0, source: "city" as const }));
  }, [debouncedQ]);

  const { historyList, cityList } = useMemo(() => {
    const data = items.data ?? [];
    const history = data.filter(d => d.source === "history" || (d.source === undefined && d.count > 0));
    const cityFromServer = data.filter(d => d.source === "city");
    const histKeys = new Set(history.map(h => `${h.city.toLowerCase()}|${h.state}`));
    const seen = new Set<string>(histKeys);
    const cities: AutoItem[] = [];
    for (const it of [...cityFromServer, ...localMatches]) {
      const key = `${it.city.toLowerCase()}|${it.state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cities.push(it);
    }
    return { historyList: history, cityList: cities.slice(0, 12) };
  }, [items.data, localMatches]);

  const flatList: AutoItem[] = useMemo(() => [...historyList, ...cityList], [historyList, cityList]);
  const showNoMatches = autoOpen && debouncedQ.length >= 2 && !items.isFetching && flatList.length === 0;
  const visible = autoOpen && (flatList.length > 0 || showNoMatches);

  const pick = (it: AutoItem): void => {
    onChange({ city: it.city, state: it.state });
    setQ(it.city);
    setAutoOpen(false);
    setActiveIdx(-1);
    // Jump to next field — picking from autocomplete is a complete answer.
    setTimeout(() => onAdvance?.(), 0);
  };

  const handleCityChange = (raw: string): void => {
    const parsed = tryParseCityAndState(raw);
    if (parsed) {
      setQ(parsed.city);
      onChange({ city: parsed.city, state: parsed.state });
      setAutoOpen(false);
      setActiveIdx(-1);
      setTimeout(() => onAdvance?.(), 0);
      return;
    }
    setQ(raw);
    onChange({ city: raw, state: value.state });
    setAutoOpen(true);
    setActiveIdx(-1);
  };

  const onCityKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (visible && flatList.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => Math.min(flatList.length - 1, i + 1));
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => Math.max(-1, i - 1));
        return;
      } else if (e.key === "Enter" && activeIdx >= 0 && activeIdx < flatList.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(flatList[activeIdx]);
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAutoOpen(false);
        setActiveIdx(-1);
        return;
      }
    }
    if (e.key === "Escape") {
      // Close the dropdown without clearing the field's value.
      e.stopPropagation();
      setAutoOpen(false);
      setActiveIdx(-1);
      return;
    }
    // Tab from city with text but no state → focus the State field.
    if (e.key === "Tab" && !e.shiftKey && q.trim() && !value.state) {
      e.preventDefault();
      stateEl.current?.focus();
    }
    // Tab from a complete city+state pair → let the browser advance to the
    // next focusable element (delivery city / mode), so no preventDefault.
  };

  const onStateChange = (raw: string): void => {
    // Allow the rep to type a full state name (e.g. "Arizona") that we
    // normalize to "AZ" on blur or once a valid 2-letter code lands.
    const trimmed = raw.replace(/[^A-Za-z\s]/g, "");
    const upper = trimmed.toUpperCase();
    onChange({ city: value.city, state: upper });
    if (upper.length === 2) {
      const { abbr, valid } = normalizeStateAbbr(upper);
      if (valid && abbr) {
        onChange({ city: value.city, state: abbr });
        setTimeout(() => onAdvance?.(), 0);
      }
    }
  };

  const onStateBlur = (): void => {
    if (value.state.length > 2) {
      const { abbr, valid } = normalizeStateAbbr(value.state);
      if (valid && abbr) {
        onChange({ city: value.city, state: abbr });
      }
    }
  };

  const cityAutoClass = autoFilledCity ? "border-amber-400/70 ring-1 ring-amber-400/30" : "";
  const stateAutoClass = autoFilledState ? "border-amber-400/70 ring-1 ring-amber-400/30" : "";
  const showAutoBadge = autoFilledCity || autoFilledState;
  return (
    <div className="flex flex-col gap-1 relative">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
        <MapPin className="h-3 w-3" />{label}
        {showAutoBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="ml-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded-[3px] bg-amber-400/15 border border-amber-400/40 text-amber-700 dark:text-amber-300 text-[9px] font-semibold normal-case tracking-normal"
                data-testid={`badge-autofilled-${kind === "origin" ? "pickup" : "delivery"}`}
              >
                <Sparkles className="h-2.5 w-2.5" /> Auto-filled
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-[280px]">
              From your dropped {autoFilledSource ?? "intake"}.
            </TooltipContent>
          </Tooltip>
        )}
      </span>
      <div className="flex gap-1.5">
        <Input
          ref={cityEl}
          value={q}
          onChange={e => handleCityChange(e.target.value)}
          onFocus={() => setAutoOpen(true)}
          onBlur={() => setTimeout(() => setAutoOpen(false), 150)}
          onKeyDown={onCityKeyDown}
          onPaste={e => {
            const text = e.clipboardData.getData("text");
            const parsed = tryParseCityAndState(text);
            if (parsed) {
              e.preventDefault();
              setQ(parsed.city);
              onChange({ city: parsed.city, state: parsed.state });
              setAutoOpen(false);
              setActiveIdx(-1);
              setTimeout(() => onAdvance?.(), 0);
            }
          }}
          placeholder="City"
          className={`h-10 w-[200px] bg-card border-border text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60 ${cityAutoClass}`}
          data-testid={testIdCity}
          autoComplete="off"
        />
        <Input
          ref={stateEl}
          value={value.state}
          onChange={e => onStateChange(e.target.value)}
          onBlur={onStateBlur}
          placeholder="ST"
          className={`h-10 w-[60px] bg-card border-border text-sm text-foreground placeholder:text-muted-foreground uppercase tracking-wider text-center focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60 ${stateAutoClass}`}
          maxLength={20}
          data-testid={testIdState}
          autoComplete="off"
        />
      </div>
      {visible && (
        <div className="absolute top-full left-0 mt-1 z-30 w-[300px] rounded-[4px] border border-border bg-background shadow-2xl max-h-[320px] overflow-y-auto" data-testid={`autocomplete-${kind}`}>
          {historyList.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-amber-300/80 border-b border-border bg-card">
                Recent · {historyList.length}
              </div>
              {historyList.map((it, i) => {
                const idx = i;
                return (
                  <button
                    key={`h-${it.city}|${it.state}`}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(it); }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs border-l-2 ${idx === activeIdx ? "bg-muted border-amber-400" : "border-transparent hover:bg-card"}`}
                    data-testid={`autocomplete-item-${kind}-${it.city}-${it.state}`}
                  >
                    <span className="text-foreground flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-amber-400/70" />{it.city}, <span className="text-muted-foreground">{it.state}</span>
                    </span>
                    <span className="text-[10px] text-amber-300/80 tabular-nums">
                      {it.count > 0 ? `${it.count} quote${it.count === 1 ? "" : "s"}` : "recent"}
                    </span>
                  </button>
                );
              })}
            </>
          )}
          {cityList.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-y border-border bg-card">
                Cities · {cityList.length}
              </div>
              {cityList.map((it, i) => {
                const idx = historyList.length + i;
                return (
                  <button
                    key={`c-${it.city}|${it.state}`}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(it); }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs border-l-2 ${idx === activeIdx ? "bg-muted border-amber-400" : "border-transparent hover:bg-card"}`}
                    data-testid={`autocomplete-item-${kind}-${it.city}-${it.state}`}
                  >
                    <span className="text-foreground flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-muted-foreground" />{it.city}, <span className="text-muted-foreground">{it.state}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">city</span>
                  </button>
                );
              })}
            </>
          )}
          {showNoMatches && (
            <div className="px-3 py-2.5 text-[11px] text-muted-foreground" data-testid={`autocomplete-empty-${kind}`}>
              No matches — press <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-foreground text-[9px] mx-0.5">Enter</kbd> to use as-is
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionCard({ title, icon, children, testId, action }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode; testId: string; action?: React.ReactNode;
}): JSX.Element {
  return (
    <Card className="bg-card border-border rounded-[4px]" data-testid={testId}>
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-border">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
          {icon}{title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="p-3 text-xs text-foreground">{children}</CardContent>
    </Card>
  );
}

function ConfidenceDot({ confidence }: { confidence: string }): JSX.Element {
  const map: Record<string, string> = {
    high: "bg-emerald-400", medium: "bg-amber-400",
    low: "bg-orange-400", insufficient_history: "bg-muted-foreground", no_benchmark: "bg-muted-foreground",
  };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${map[confidence] ?? "bg-muted-foreground"}`} />;
}

export interface SpotQuoteNewQuotePrefill {
  customerId?: string;
  originCity?: string;
  originState?: string;
  destCity?: string;
  destState?: string;
  equipment?: string;
}

export function SpotQuoteSearch({ customers, onApplyLaneFilter, onPickQuote, onPickCustomer, onStartNewQuote }: {
  customers: Customer[];
  onApplyLaneFilter: (laneSearch: string) => void;
  onPickQuote: (id: string) => void;
  onPickCustomer: (id: string) => void;
  /** Task #863 — kick the New Quote composer open with lane/customer prefilled. */
  onStartNewQuote?: (prefill: SpotQuoteNewQuotePrefill) => void;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [pickup, setPickup] = useState({ city: "", state: "" });
  const [delivery, setDelivery] = useState({ city: "", state: "" });
  const [equipment, setEquipment] = useState<string>("Any");
  const [pickupDate, setPickupDate] = useState<string>("");
  const [customerId, setCustomerId] = useState<string>("");
  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [lookbackDays, setLookbackDays] = useState<string>("0");
  const [exactOnly, setExactOnly] = useState(false);
  const [includeSimilar, setIncludeSimilar] = useState(true);
  // Task #514 — Tiered Matching mode toggle. Default to relaxed so reps see
  // the full ladder of nearby/state/reverse/corridor matches by default.
  const [matchMode, setMatchMode] = useState<"strict" | "relaxed">("relaxed");
  const [adv, setAdv] = useState<SpotAdvancedDetails>({});

  const [recents, setRecents] = useState<Recent[]>(() => loadRecents());
  const [activeQuery, setActiveQuery] = useState<SpotSearchQuery | null>(null);
  const [searchedAt, setSearchedAt] = useState<Date | null>(null);
  const [openOrigin, setOpenOrigin] = useState(false);
  const [openDest, setOpenDest] = useState(false);
  const { toast } = useToast();

  // Task #617 — Spot Quote intake (drop a screenshot or paste an email)
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [intakeResult, setIntakeResult] = useState<ParsedQuoteIntake | null>(null);
  const [intakeWhatWeReadOpen, setIntakeWhatWeReadOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const intakeFileInputRef = useRef<HTMLInputElement | null>(null);

  // Field focus chain: pickup-city → pickup-state → delivery-city → delivery-state → date → search
  const pickupCityRef = useRef<HTMLInputElement | null>(null);
  const pickupStateRef = useRef<HTMLInputElement | null>(null);
  const deliveryCityRef = useRef<HTMLInputElement | null>(null);
  const deliveryStateRef = useRef<HTMLInputElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const searchBtnRef = useRef<HTMLButtonElement | null>(null);

  const canSearch = pickup.city && pickup.state && delivery.city && delivery.state;

  const searchQs = useMemo(() => {
    if (!activeQuery) return null;
    const p = new URLSearchParams();
    p.set("pickupCity", activeQuery.pickupCity);
    p.set("pickupState", activeQuery.pickupState);
    p.set("deliveryCity", activeQuery.deliveryCity);
    p.set("deliveryState", activeQuery.deliveryState);
    if (activeQuery.equipment && activeQuery.equipment !== "Any") p.set("equipment", activeQuery.equipment);
    if (activeQuery.pickupDate) p.set("pickupDate", activeQuery.pickupDate);
    if (activeQuery.customerId) p.set("customerId", activeQuery.customerId);
    if (activeQuery.lookbackDays && activeQuery.lookbackDays > 0) p.set("lookbackDays", String(activeQuery.lookbackDays));
    if (activeQuery.exactOnly) p.set("exactOnly", "true");
    if (activeQuery.includeSimilar === false) p.set("includeSimilar", "false");
    if (activeQuery.matchMode) p.set("matchMode", activeQuery.matchMode);
    return p.toString();
  }, [activeQuery]);

  const result = useQuery<SpotResult>({
    queryKey: ["/api/customer-quotes/spot-search", searchQs],
    queryFn: async (): Promise<SpotResult> => {
      const res = await fetch(`/api/customer-quotes/spot-search?${searchQs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Spot search failed");
      return res.json();
    },
    enabled: !!searchQs,
  });

  const buildQuery = (overrides?: {
    pickup?: { city: string; state: string };
    delivery?: { city: string; state: string };
    equipment?: string;
    pickupDate?: string;
    customerId?: string;
  }): SpotSearchQuery | null => {
    const p = overrides?.pickup ?? pickup;
    const d = overrides?.delivery ?? delivery;
    const eq = overrides?.equipment ?? equipment;
    const pd = overrides?.pickupDate ?? pickupDate;
    const cid = overrides?.customerId ?? customerId;
    if (!(p.city && p.state && d.city && d.state)) return null;
    const lb = parseInt(lookbackDays, 10);
    return {
      pickupCity: p.city.trim(),
      pickupState: p.state.trim().toUpperCase(),
      deliveryCity: d.city.trim(),
      deliveryState: d.state.trim().toUpperCase(),
      equipment: eq === "Any" ? undefined : eq,
      pickupDate: pd || undefined,
      customerId: cid || undefined,
      lookbackDays: lb > 0 ? lb : undefined,
      exactOnly: exactOnly || undefined,
      includeSimilar: !includeSimilar ? false : undefined,
      matchMode,
    };
  };

  const submit = (): void => {
    const q = buildQuery();
    if (!q) return;
    setActiveQuery(q);
    setSearchedAt(new Date());
    saveRecent(q);
    setRecents(loadRecents());
  };

  const clearAll = (): void => {
    setPickup({ city: "", state: "" });
    setDelivery({ city: "", state: "" });
    setEquipment("Any");
    setPickupDate("");
    setCustomerId("");
    setLookbackDays("0");
    setExactOnly(false);
    setIncludeSimilar(true);
    setMatchMode("relaxed");
    setAdv({});
    setActiveQuery(null);
    setSearchedAt(null);
    setAutoFilled(new Set());
    setIntakeError(null);
    setIntakeResult(null);
  };

  // Task #617 — apply a parsed intake result to the form fields, mark which
  // fields were auto-filled, and (when the lane is complete + confidence is
  // high) auto-run the search. Returns the filled-field set so the caller
  // can decide whether to surface a toast.
  const applyIntakeResult = (r: ParsedQuoteIntake): Set<string> => {
    const filled = new Set<string>();
    let nextPickup = pickup;
    let nextDelivery = delivery;
    let nextEquipment = equipment;
    let nextPickupDate = pickupDate;
    let nextCustomerId = customerId;
    if (r.pickupCity || r.pickupState) {
      nextPickup = { city: r.pickupCity ?? "", state: (r.pickupState ?? "").toUpperCase() };
      setPickup(nextPickup);
      if (r.pickupCity) filled.add("pickupCity");
      if (r.pickupState) filled.add("pickupState");
    }
    if (r.deliveryCity || r.deliveryState) {
      nextDelivery = { city: r.deliveryCity ?? "", state: (r.deliveryState ?? "").toUpperCase() };
      setDelivery(nextDelivery);
      if (r.deliveryCity) filled.add("deliveryCity");
      if (r.deliveryState) filled.add("deliveryState");
    }
    const mappedEq = mapIntakeEquipment(r.equipment);
    if (mappedEq) {
      nextEquipment = mappedEq;
      setEquipment(mappedEq);
      filled.add("equipment");
    }
    if (r.pickupDate) {
      nextPickupDate = r.pickupDate;
      setPickupDate(r.pickupDate);
      filled.add("pickupDate");
    }
    if (r.customerHint) {
      const matched = matchCustomerHint(r.customerHint, customers);
      if (matched) {
        nextCustomerId = matched;
        setCustomerId(matched);
        filled.add("customerId");
      }
    }
    setAutoFilled(filled);

    // Auto-run search when confidence is high AND we have a complete lane.
    const haveLane = nextPickup.city && nextPickup.state && nextDelivery.city && nextDelivery.state;
    if (r.confidence >= 0.8 && haveLane) {
      const q = buildQuery({
        pickup: nextPickup,
        delivery: nextDelivery,
        equipment: nextEquipment,
        pickupDate: nextPickupDate,
        customerId: nextCustomerId,
      });
      if (q) {
        setActiveQuery(q);
        setSearchedAt(new Date());
        saveRecent(q);
        setRecents(loadRecents());
      }
    }
    return filled;
  };

  // Submit a file or pasted text/HTML to the intake endpoint and apply the
  // result. Errors surface inline rather than via toast so the user keeps
  // their context near the drop zone.
  const runIntake = async (input: { file?: File; text?: string }): Promise<void> => {
    setIntakeBusy(true);
    setIntakeError(null);
    setIntakeResult(null);
    setAutoFilled(new Set());
    try {
      let res: Response;
      if (input.file) {
        const fd = new FormData();
        fd.append("file", input.file);
        res = await fetch("/api/customer-quotes/spot-intake", {
          method: "POST",
          credentials: "include",
          body: fd,
        });
      } else if (input.text && input.text.trim()) {
        res = await fetch("/api/customer-quotes/spot-intake", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawText: input.text }),
        });
      } else {
        setIntakeBusy(false);
        return;
      }
      if (!res.ok) {
        let msg = "We couldn't read this drop — try a clearer screenshot or paste the text.";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") msg = data.error;
        } catch {
          /* ignore */
        }
        setIntakeError(msg);
        return;
      }
      const result = (await res.json()) as ParsedQuoteIntake;
      setIntakeResult(result);
      const filled = applyIntakeResult(result);
      if (filled.size === 0) {
        // We got something back but couldn't fill anything — surface gently.
        const note = result.notes?.[0] ?? "We couldn't pull a lane out of that drop. Try pasting the email body or use a clearer screenshot.";
        setIntakeError(note);
      }
    } catch (err) {
      console.warn("[spot-intake] error:", err);
      setIntakeError("Something went wrong reading that drop. Please try again.");
    } finally {
      setIntakeBusy(false);
    }
  };

  const handleIntakeFile = (file: File): void => {
    void runIntake({ file });
  };

  // Drag handlers for the dropzone in the empty state.
  const onIntakeDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (intakeBusy) return;
    e.preventDefault();
    setIsDragging(true);
  };
  const onIntakeDragLeave = (): void => setIsDragging(false);
  const onIntakeDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(false);
    if (intakeBusy) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) {
      // Drag of plain text from another window.
      const txt = e.dataTransfer.getData("text/plain");
      if (txt && txt.trim()) void runIntake({ text: txt });
      return;
    }
    handleIntakeFile(file);
  };

  // Global paste handler — only active when the search form is empty (no
  // active query yet). Catches both image blobs and text from the clipboard.
  useEffect(() => {
    if (activeQuery) return; // don't intercept paste once results are showing
    const handler = (e: ClipboardEvent): void => {
      // Don't hijack paste while the user is typing in inputs/textareas/contentEditables.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const cd = e.clipboardData;
      if (!cd) return;
      // Image first.
      const item = Array.from(cd.items ?? []).find(it => it.kind === "file" && it.type.startsWith("image/"));
      if (item) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleIntakeFile(file);
          return;
        }
      }
      const text = cd.getData("text/plain");
      if (text && text.trim().length >= 12) {
        e.preventDefault();
        void runIntake({ text });
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuery, customers, intakeBusy, pickup, delivery, equipment, pickupDate, customerId, lookbackDays, exactOnly, includeSimilar, matchMode]);

  const applyRecent = (r: Recent): void => {
    setPickup({ city: r.pickupCity, state: r.pickupState });
    setDelivery({ city: r.deliveryCity, state: r.deliveryState });
    setEquipment(r.equipment ?? "Any");
    setPickupDate(r.pickupDate ?? "");
    setCustomerId(r.customerId ?? "");
    setLookbackDays(r.lookbackDays ? String(r.lookbackDays) : "0");
    setExactOnly(!!r.exactOnly);
    setIncludeSimilar(r.includeSimilar !== false);
    setMatchMode(r.matchMode ?? "relaxed");
    setActiveQuery({
      pickupCity: r.pickupCity, pickupState: r.pickupState,
      deliveryCity: r.deliveryCity, deliveryState: r.deliveryState,
      equipment: r.equipment, pickupDate: r.pickupDate, customerId: r.customerId,
      lookbackDays: r.lookbackDays, exactOnly: r.exactOnly, includeSimilar: r.includeSimilar,
      matchMode: r.matchMode ?? "relaxed",
    });
    setSearchedAt(new Date());
  };

  const copyLane = async (): Promise<void> => {
    if (!activeQuery) return;
    const txt = `${activeQuery.pickupCity}, ${activeQuery.pickupState} → ${activeQuery.deliveryCity}, ${activeQuery.deliveryState}${activeQuery.equipment ? " · " + activeQuery.equipment : ""}${activeQuery.pickupDate ? " · pickup " + activeQuery.pickupDate : ""}`;
    try {
      await navigator.clipboard.writeText(txt);
      toast({ title: "Copied lane", description: txt });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const editSearch = (): void => {
    setActiveQuery(null);
  };

  const rerunSearch = (): void => {
    if (!canSearch) return;
    if (activeQuery) {
      void result.refetch();
      setSearchedAt(new Date());
    } else {
      submit();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") clearAll();
  };

  const data = result.data;
  const hasResults = !!activeQuery && (!!data || result.isFetching);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-4" data-testid="spot-quote-search-root">
      {/* Sticky search bar — full form OR compact pinned strip */}
      {hasResults ? (
        <div
          className="-mx-6 px-6 py-2 bg-card/60 border-y border-border"
          data-testid="spot-quote-search-bar-compact"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Searching</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground tabular-nums">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {activeQuery!.pickupCity}, {activeQuery!.pickupState}
              <ChevronRight className="h-3.5 w-3.5 text-amber-400" />
              {activeQuery!.deliveryCity}, {activeQuery!.deliveryState}
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded-[4px] bg-muted text-foreground border border-border inline-flex items-center gap-1">
              <Truck className="h-3 w-3 text-muted-foreground" />{activeQuery!.equipment ?? "Any"}
            </span>
            {activeQuery!.pickupDate && (
              <span className="text-[11px] px-2 py-0.5 rounded-[4px] bg-muted text-foreground border border-border inline-flex items-center gap-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />{activeQuery!.pickupDate}
              </span>
            )}
            {data?.resolvedCustomer && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-[4px] bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/40 inline-flex items-center gap-1">
                <Users className="h-3 w-3" />{data.resolvedCustomer.name}
              </span>
            )}
            {(activeQuery!.lookbackDays || activeQuery!.exactOnly || activeQuery!.includeSimilar === false) && (
              <span className="text-[10px] text-muted-foreground">
                {activeQuery!.lookbackDays ? `· last ${activeQuery!.lookbackDays}d` : ""}
                {activeQuery!.exactOnly ? " · exact only" : activeQuery!.includeSimilar === false ? " · no similar" : ""}
              </span>
            )}
            {searchedAt && (
              <span className="text-[10px] text-muted-foreground ml-1">
                · {searchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={editSearch}
                className="h-7 border-amber-500/50 hover:bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium text-[11px] px-2.5"
                data-testid="button-spot-edit">
                <SlidersHorizontal className="h-3 w-3 mr-1" /> Edit search
              </Button>
              <Button size="sm" variant="ghost" onClick={rerunSearch}
                className="h-7 text-muted-foreground hover:text-foreground hover:bg-muted text-[11px] px-2"
                data-testid="button-spot-rerun">
                <RefreshCw className={`h-3 w-3 mr-1 ${result.isFetching ? "animate-spin" : ""}`} /> Rerun
              </Button>
              <Button size="sm" variant="ghost" onClick={copyLane}
                className="h-7 text-muted-foreground hover:text-foreground hover:bg-muted text-[11px] px-2"
                data-testid="button-spot-copy">
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll}
                className="h-7 text-muted-foreground hover:text-foreground hover:bg-muted text-[11px] px-2"
                data-testid="button-spot-clear">
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
          </div>
        </div>
      ) : (
      <div
        className="-mx-6 px-6 py-4 bg-card/40 border-y border-border"
        onKeyDown={onKeyDown}
        data-testid="spot-quote-search-bar"
      >
        <div className="flex items-center gap-2 mb-3">
          <div className="h-6 w-6 rounded-[4px] bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
            <Search className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <span className="text-base font-semibold text-foreground tracking-tight">Spot Quote Search</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Pickup → Delivery · Mode · Date</span>
          <span className="ml-auto text-[10px] text-muted-foreground hidden md:inline">
            Press <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-foreground text-[9px]">Enter</kbd> to search · <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-foreground text-[9px]">Esc</kbd> to clear
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <LaneInput label="Pickup" value={pickup} onChange={setPickup} kind="origin"
            testIdCity="input-spot-pickup-city" testIdState="input-spot-pickup-state"
            autoOpen={openOrigin} setAutoOpen={setOpenOrigin}
            cityRef={pickupCityRef} stateRef={pickupStateRef}
            autoFilledCity={autoFilled.has("pickupCity")}
            autoFilledState={autoFilled.has("pickupState")}
            autoFilledSource={intakeResult?.source}
            onAdvance={() => deliveryCityRef.current?.focus()} />
          <LaneInput label="Delivery" value={delivery} onChange={setDelivery} kind="dest"
            testIdCity="input-spot-delivery-city" testIdState="input-spot-delivery-state"
            autoOpen={openDest} setAutoOpen={setOpenDest}
            cityRef={deliveryCityRef} stateRef={deliveryStateRef}
            autoFilledCity={autoFilled.has("deliveryCity")}
            autoFilledState={autoFilled.has("deliveryState")}
            autoFilledSource={intakeResult?.source}
            onAdvance={() => dateRef.current?.focus()} />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Truck className="h-3 w-3" /> Mode
              {autoFilled.has("equipment") && <AutoFilledChip testId="badge-autofilled-equipment" source={intakeResult?.source} />}
            </span>
            <Select value={equipment} onValueChange={setEquipment}>
              <SelectTrigger className={`h-10 w-[130px] bg-card border-border text-sm text-foreground [&>span]:text-foreground ${autoFilled.has("equipment") ? "border-amber-400/70 ring-1 ring-amber-400/30" : ""}`} data-testid="select-spot-equipment"><SelectValue /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                {EQUIPMENT_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Pickup date
              {autoFilled.has("pickupDate") && <AutoFilledChip testId="badge-autofilled-pickup-date" source={intakeResult?.source} />}
            </span>
            <Input ref={dateRef} type="date" value={pickupDate} onChange={e => setPickupDate(e.target.value)}
              className={`h-10 w-[160px] bg-card border-border text-sm text-foreground placeholder:text-muted-foreground dark:[color-scheme:dark] focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60 ${autoFilled.has("pickupDate") ? "border-amber-400/70 ring-1 ring-amber-400/30" : ""}`}
              data-testid="input-spot-pickup-date" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
              <Users className="h-3 w-3" /> Customer (optional)
              {autoFilled.has("customerId") && <AutoFilledChip testId="badge-autofilled-customer" source={intakeResult?.source} />}
            </span>
            <Select value={customerId || "_any"} onValueChange={v => setCustomerId(v === "_any" ? "" : v)}>
              <SelectTrigger className={`h-10 w-[220px] bg-card border-border text-sm text-foreground [&>span]:text-foreground data-[placeholder]:text-muted-foreground ${autoFilled.has("customerId") ? "border-amber-400/70 ring-1 ring-amber-400/30" : ""}`} data-testid="select-spot-customer"><SelectValue placeholder="Any customer" /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_any">Any customer</SelectItem>
                {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button
            ref={searchBtnRef}
            onClick={submit}
            disabled={!canSearch || result.isFetching}
            className="h-10 bg-[#FFC333] hover:bg-amber-400 text-amber-950 font-semibold rounded-[4px] px-5 shadow-sm shadow-amber-500/20"
            data-testid="button-spot-search"
          >
            <Search className="h-4 w-4 mr-2" /> Search
          </Button>
        </div>

        {/* Advanced Details — collapsible */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="button-spot-advanced-toggle"
            >
              <SlidersHorizontal className="h-3 w-3" />
              Advanced Details
              <ChevronDown className={`h-3 w-3 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2" data-testid="spot-advanced-details">
            <div className="rounded-[4px] border border-border bg-card/60 p-3 space-y-3">
              {/* Search behavior toggles */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Lookback</span>
                  <Select value={lookbackDays} onValueChange={setLookbackDays}>
                    <SelectTrigger className="h-8 w-[150px] bg-card border-border text-xs text-foreground [&>span]:text-foreground" data-testid="select-spot-lookback"><SelectValue /></SelectTrigger>
                    <SelectContent container={overlayPortal}>
                      {LOOKBACK_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-exact-only" checked={exactOnly} onCheckedChange={(v) => { setExactOnly(v); if (v) setIncludeSimilar(false); }} data-testid="switch-spot-exact-only" />
                  <Label htmlFor="spot-exact-only" className="text-xs text-foreground">Exact matches only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-include-similar" checked={includeSimilar} onCheckedChange={(v) => { setIncludeSimilar(v); if (v) setExactOnly(false); }} data-testid="switch-spot-include-similar" />
                  <Label htmlFor="spot-include-similar" className="text-xs text-foreground">Include similar lanes</Label>
                </div>
                {/* Task #514 — Tiered match-mode segmented toggle */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Match mode</span>
                  <div className="inline-flex rounded-[4px] border border-border bg-card overflow-hidden" role="group" data-testid="segmented-spot-match-mode">
                    <button
                      type="button"
                      onClick={() => { setMatchMode("relaxed"); setActiveQuery(q => q ? { ...q, matchMode: "relaxed" } : q); }}
                      className={`px-2.5 h-8 text-[11px] font-medium transition ${matchMode === "relaxed" ? "bg-amber-500/20 text-amber-800 dark:text-amber-200 border-r border-amber-500/40" : "text-muted-foreground hover:text-foreground hover:bg-muted border-r border-border"}`}
                      data-testid="button-spot-match-mode-relaxed"
                      title="Walk the full ladder: exact → market → state → reverse → corridor"
                    >
                      Relaxed
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMatchMode("strict"); setActiveQuery(q => q ? { ...q, matchMode: "strict" } : q); }}
                      className={`px-2.5 h-8 text-[11px] font-medium transition ${matchMode === "strict" ? "bg-amber-500/20 text-amber-800 dark:text-amber-200" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                      data-testid="button-spot-match-mode-strict"
                      title="Only exact lane and same-state-pair matches"
                    >
                      Strict
                    </button>
                  </div>
                </div>
              </div>

              {/* Freight qualification (informational; tags the search context) */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 pt-2 border-t border-border">
                <AdvField label="Weight (lbs)">
                  <Input value={adv.weight ?? ""} onChange={e => setAdv(a => ({ ...a, weight: e.target.value }))}
                    placeholder="e.g. 42000" className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="input-spot-weight" />
                </AdvField>
                <AdvField label="Commodity">
                  <Input value={adv.commodity ?? ""} onChange={e => setAdv(a => ({ ...a, commodity: e.target.value }))}
                    placeholder="e.g. Steel coils" className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="input-spot-commodity" />
                </AdvField>
                <AdvField label="Pallets">
                  <Input value={adv.pallets ?? ""} onChange={e => setAdv(a => ({ ...a, pallets: e.target.value }))}
                    placeholder="e.g. 26" className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="input-spot-pallets" />
                </AdvField>
                <AdvField label="TL type">
                  <Select value={adv.truckloadType ?? "_unset"} onValueChange={v => setAdv(a => ({ ...a, truckloadType: v === "_unset" ? undefined : v }))}>
                    <SelectTrigger className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="select-spot-tl-type"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent container={overlayPortal}>
                      <SelectItem value="_unset">—</SelectItem>
                      {TRUCKLOAD_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </AdvField>
                <AdvField label="Special handling">
                  <Input value={adv.specialHandling ?? ""} onChange={e => setAdv(a => ({ ...a, specialHandling: e.target.value }))}
                    placeholder="Tarps, straps…" className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="input-spot-special" />
                </AdvField>
                <AdvField label="Access notes">
                  <Input value={adv.accessNotes ?? ""} onChange={e => setAdv(a => ({ ...a, accessNotes: e.target.value }))}
                    placeholder="Residential, jobsite…" className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground" data-testid="input-spot-access" />
                </AdvField>
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <Switch id="spot-hazmat" checked={!!adv.hazmat} onCheckedChange={(v) => setAdv(a => ({ ...a, hazmat: v }))} data-testid="switch-spot-hazmat" />
                  <Label htmlFor="spot-hazmat" className="text-xs text-foreground">Hazmat</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-temp" checked={!!adv.tempRequired} onCheckedChange={(v) => setAdv(a => ({ ...a, tempRequired: v }))} data-testid="switch-spot-temp" />
                  <Label htmlFor="spot-temp" className="text-xs text-foreground">Temp controlled</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-appt" checked={!!adv.appointmentRequired} onCheckedChange={(v) => setAdv(a => ({ ...a, appointmentRequired: v }))} data-testid="switch-spot-appt" />
                  <Label htmlFor="spot-appt" className="text-xs text-foreground">Appointment required</Label>
                </div>
                <div className="ml-auto text-[10px] text-muted-foreground">
                  Qualification details tag the search context but do not yet filter historical records.
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {recents.length > 0 && !activeQuery && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Recent:</span>
            {recents.map(r => (
              <button key={r.savedAt} onClick={() => applyRecent(r)}
                className="text-[11px] px-2 py-0.5 rounded-[4px] bg-muted hover:bg-muted text-foreground border border-border"
                data-testid={`button-spot-recent-${r.savedAt}`}>
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {/* Results workspace */}
      {!activeQuery && (
        <Card className="bg-card/40 border-border border-dashed rounded-[4px]" data-testid="spot-empty-state">
          <CardContent className="p-10 text-center text-muted-foreground text-sm">
            <div className="mx-auto h-12 w-12 rounded-full bg-card border border-border flex items-center justify-center mb-3">
              <Search className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-foreground font-semibold mb-1">Start with a lane</div>
            <div className="text-xs text-muted-foreground max-w-[480px] mx-auto leading-relaxed">
              Enter pickup and delivery to see exact-match history, similar lanes, customer signals, carrier buy-history, internal rep variance, freight attractiveness and pricing guidance — all in one view.
            </div>

            {/* Task #617 — drop a screenshot or paste an email to auto-fill */}
            <div className="max-w-[640px] mx-auto mt-6 text-left">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Or skip the typing</span>
                <span className="flex-1 h-px bg-border" />
              </div>
              <div
                className={`relative border-2 border-dashed rounded-[6px] p-5 transition-colors cursor-pointer text-center ${
                  isDragging
                    ? "border-amber-400 bg-amber-400/10"
                    : intakeBusy
                      ? "border-border bg-muted/30 cursor-progress"
                      : "border-border hover:border-amber-400/60 hover:bg-amber-400/5"
                }`}
                onDragOver={onIntakeDragOver}
                onDragLeave={onIntakeDragLeave}
                onDrop={onIntakeDrop}
                onClick={() => { if (!intakeBusy) intakeFileInputRef.current?.click(); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !intakeBusy) {
                    e.preventDefault();
                    intakeFileInputRef.current?.click();
                  }
                }}
                data-testid="spot-intake-dropzone"
              >
                <input
                  ref={intakeFileInputRef}
                  type="file"
                  accept="image/*,.eml,message/rfc822,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleIntakeFile(f);
                    e.target.value = "";
                  }}
                  data-testid="spot-intake-file-input"
                />
                {intakeBusy ? (
                  <div className="flex flex-col items-center gap-2 py-2">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
                    <div className="text-sm font-medium text-foreground">Reading your drop…</div>
                    <div className="text-[11px] text-muted-foreground">We'll fill the lane fields automatically.</div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-1">
                    <div className="flex items-center gap-3 text-amber-500/80">
                      <FileImage className="h-5 w-5" />
                      <Upload className="h-5 w-5" />
                      <Mail className="h-5 w-5" />
                      <ClipboardPaste className="h-5 w-5" />
                    </div>
                    <div className="text-sm font-semibold text-foreground">Drop a screenshot or email here</div>
                    <div className="text-[11px] text-muted-foreground max-w-[420px] leading-relaxed">
                      Drag an image or <span className="text-foreground">.eml</span>, paste a screenshot from your clipboard, or paste an email body. We'll auto-fill the lane and run the search.
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); intakeFileInputRef.current?.click(); }}
                      className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:underline"
                      data-testid="button-spot-intake-browse"
                    >
                      <Upload className="h-3 w-3" /> Browse for a file
                    </button>
                  </div>
                )}
              </div>

            </div>
          </CardContent>
        </Card>
      )}

      {/* Task #617 — Intake summary / error: persists after auto-search so chips & "what we read" remain visible */}
      {intakeError && (
        <div
          className="rounded-[4px] border border-red-500/40 bg-red-500/10 px-3 py-2 flex items-start gap-2"
          data-testid="spot-intake-error"
        >
          <AlertTriangle className="h-4 w-4 text-red-700 dark:text-red-300 mt-0.5 shrink-0" />
          <div className="text-xs text-red-700 dark:text-red-200 font-medium leading-snug flex-1">
            {intakeError}
          </div>
          <button
            type="button"
            onClick={() => setIntakeError(null)}
            className="text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-100"
            data-testid="button-spot-intake-error-dismiss"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {intakeResult && (intakeResult.confidence > 0 || intakeResult.rawText) && (
        <div className="rounded-[4px] border border-amber-400/40 bg-amber-400/5 px-3 py-2" data-testid="spot-intake-summary">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs font-medium text-foreground">
              {autoFilled.size > 0
                ? `Auto-filled ${autoFilled.size} field${autoFilled.size === 1 ? "" : "s"} from your ${intakeResult.source === "image" ? "screenshot" : intakeResult.source === "email" ? "email" : "text"}`
                : "Read your drop"}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              · confidence {Math.round(intakeResult.confidence * 100)}%
            </span>
            {intakeResult.confidence >= 0.8 && autoFilled.size > 0 && activeQuery && (
              <span className="text-[10px] text-emerald-700 dark:text-emerald-300">· auto-searched</span>
            )}
            {intakeResult.rateHint && (
              <span className="text-[10px] text-muted-foreground">· suggested rate ${intakeResult.rateHint.toLocaleString()}</span>
            )}
            {intakeResult.customerHint && !autoFilled.has("customerId") && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">· customer hint: {intakeResult.customerHint}</span>
            )}
            <button
              type="button"
              onClick={() => setIntakeWhatWeReadOpen(o => !o)}
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="button-spot-intake-what-we-read"
            >
              {intakeWhatWeReadOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              What we read
            </button>
            <button
              type="button"
              onClick={() => { setIntakeResult(null); setAutoFilled(new Set()); setIntakeWhatWeReadOpen(false); }}
              className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="button-spot-intake-summary-dismiss"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {autoFilled.size > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {Array.from(autoFilled).map(key => (
                <span
                  key={key}
                  className="text-[10px] px-1.5 py-0.5 rounded-[3px] bg-amber-400/15 border border-amber-400/40 text-amber-700 dark:text-amber-300 font-medium"
                  data-testid={`chip-spot-intake-${key}`}
                >
                  {AUTOFILL_FIELD_LABELS[key] ?? key}
                </span>
              ))}
            </div>
          )}
          {intakeResult.notes.length > 0 && (
            <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
              {intakeResult.notes.map((n, i) => (
                <li key={i} className="text-[10px] text-muted-foreground" data-testid={`spot-intake-note-${i}`}>{n}</li>
              ))}
            </ul>
          )}
          {intakeWhatWeReadOpen && (
            <pre
              className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[3px] bg-background border border-border p-2 text-[11px] text-foreground/80 font-mono leading-snug"
              data-testid="spot-intake-raw-text"
            >
              {intakeResult.rawText || "(no readable text returned)"}
            </pre>
          )}
        </div>
      )}

      {activeQuery && result.isError && !result.isLoading && (
        <Card className="bg-red-500/10 border-red-500/40 rounded-[4px]" data-testid="spot-results-error">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-700 dark:text-red-300 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-red-800 dark:text-red-200">Spot search failed</div>
              <div className="text-xs text-red-700 dark:text-red-300/80 mt-0.5 font-medium">
                {(result.error as Error)?.message ?? "We couldn't load results for this lane. Try again, or adjust the search and rerun."}
              </div>
            </div>
            <Button size="sm" variant="outline"
              onClick={() => void result.refetch()}
              className="h-8 border-red-500/40 hover:bg-red-500/20 text-red-700 dark:text-red-200 font-medium text-xs"
              data-testid="button-spot-error-retry">
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {activeQuery && result.isLoading && (
        <div className="space-y-3" data-testid="spot-results-loading">
          {/* Summary strip */}
          <Skeleton className="h-12 w-full bg-card rounded-[4px]" />
          {/* Collapsed lane-stats bar */}
          <Skeleton className="h-8 w-full bg-card rounded-[4px]" />
          {/* 4-zone grid mirror */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="spot-results-loading-zones">
            <Skeleton className="h-72 w-full bg-card rounded-[4px]" />
            <Skeleton className="h-72 w-full bg-card rounded-[4px]" />
            <Skeleton className="h-64 w-full bg-card rounded-[4px]" />
            <Skeleton className="h-64 w-full bg-card rounded-[4px]" />
          </div>
          {/* Below-fold sections */}
          <Skeleton className="h-40 w-full bg-card rounded-[4px]" />
        </div>
      )}

      {activeQuery && data && (
        <div className="space-y-3" data-testid="spot-results">
          {/* 1. Result summary strip */}
          <div className="rounded-[4px] border border-border bg-card px-3 py-2 flex items-center gap-4 flex-wrap" data-testid="spot-section-summary">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Found</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/40 font-semibold tabular-nums">{data.kpis.exactCount} exact</span>
              <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/40 font-semibold tabular-nums">{data.kpis.similarCount} similar</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-foreground tabular-nums">{data.kpis.customersOnLane} customer{data.kpis.customersOnLane === 1 ? "" : "s"}</span>
              {data.kpis.pendingCount > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-amber-700 dark:text-amber-300 tabular-nums font-medium">{data.kpis.pendingCount} pending</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Win rate</span>
              <span className="text-foreground font-semibold tabular-nums">{fmtPct(data.kpis.winRate)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <KpiBadgeInline value={data.kpis.confidence} freshness={data.kpis.freshnessLabel} />
            </div>
            {data.alerts.length > 0 && (
              <button type="button"
                onClick={() => document.querySelector('[data-testid="spot-section-alerts"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="text-[11px] font-medium inline-flex items-center gap-1 text-orange-700 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200" data-testid="link-spot-summary-alerts">
                <AlertTriangle className="h-3 w-3" /> {data.alerts.length} alert{data.alerts.length === 1 ? "" : "s"}
              </button>
            )}
            {data.corridorPattern && (
              // Renders as an anchor so it has real link semantics and a
              // resolvable href (the customer-quotes page itself, scoped by
              // ?corridor=<id>). Click also triggers the in-page lane
              // filter for instant feedback. If a dedicated corridor
              // detail route is later added, swap the href without
              // changing this call site.
              <a
                href={`/customer-quotes?corridor=${encodeURIComponent(data.corridorPattern.id)}`}
                onClick={e => {
                  e.preventDefault();
                  onApplyLaneFilter(data.corridorPattern!.namedCorridor || data.corridorPattern!.name);
                }}
                className="text-[11px] font-medium px-1.5 py-0.5 rounded-[4px] bg-teal-500/15 text-teal-700 dark:text-teal-300 border border-teal-500/40 inline-flex items-center gap-1 hover:bg-teal-500/25 cursor-pointer"
                title={[
                  `${data.corridorPattern.originRegion} → ${data.corridorPattern.destinationRegion}`,
                  data.corridorPattern.description,
                  data.corridorPattern.seasonalityNote ? `Seasonality: ${data.corridorPattern.seasonalityNote}` : null,
                  data.corridorPattern.responsibleContact
                    ? `Responsible: ${data.corridorPattern.responsibleContact.contactName} (${data.corridorPattern.responsibleContact.status})`
                    : null,
                  "Click to filter table by this corridor",
                ].filter(Boolean).join(" · ")}
                data-testid="chip-spot-corridor-pattern"
              >
                <MapPin className="h-3 w-3" />
                {data.corridorPattern.namedCorridor || data.corridorPattern.name}
                {data.corridorPattern.seasonalityNote && (
                  <span className="ml-1 text-[10px] px-1 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/40 font-medium" data-testid="chip-spot-corridor-seasonality">seasonal</span>
                )}
                {data.corridorPattern.responsibleContact && (
                  <span
                    className="ml-1 text-[10px] px-1 rounded bg-muted text-foreground border border-border"
                    data-testid="chip-spot-corridor-responsible"
                  >
                    {data.corridorPattern.responsibleContact.contactName.split(/\s+/)[0]}
                  </span>
                )}
              </a>
            )}
            {!data.marketStatus.available && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-[4px] bg-muted text-muted-foreground border border-border inline-flex items-center gap-1" data-testid="chip-spot-market-unavailable">
                <AlertTriangle className="h-3 w-3" /> Market data unavailable
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {onStartNewQuote && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => onStartNewQuote({
                    customerId: data.resolvedCustomer?.id,
                    originCity: data.query.pickupCity,
                    originState: data.query.pickupState,
                    destCity: data.query.deliveryCity,
                    destState: data.query.deliveryState,
                    equipment: data.query.equipment && data.query.equipment !== "Any" ? data.query.equipment : undefined,
                  })}
                  className="h-7 text-[11px] px-2.5"
                  data-testid="button-spot-start-new-quote"
                >
                  + New quote with this lane
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onApplyLaneFilter(`${data.query.pickupCity} ${data.query.deliveryCity}`)}
                className="h-7 border-border hover:bg-muted text-[11px] px-2.5" data-testid="button-spot-apply-filter">
                Filter table by this lane
              </Button>
            </div>
          </div>

          {/* 2. Lane stats bar — collapsible KPI strip (Task #516) */}
          <LaneStatsBar kpis={data.kpis} />

          {/* 3. Four-zone deal sheet (Task #516):
              Zone 1 (Pricing + Quote Builder)  | Zone 2 (Carrier Shortlist)
              Zone 3 (Customer Lane Timeline)   | Zone 4 (Loss Pattern)

              The grid collapses to a single column at md and below, with the
              Pricing/Builder zone first so reps land on the action surface
              when the viewport shrinks. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="spot-section-deal-sheet">
            {/* Zone 1 — Pricing hero + Quote Builder stacked */}
            <div className="space-y-3 order-1" data-testid="spot-zone-pricing">
              <PricingGuidanceBand
                guidance={data.guidance}
                market={data.market}
                marketStatus={data.marketStatus}
                freshnessLabel={data.kpis.freshnessLabel}
              />
              <QuoteBuilderCard
                query={data.query}
                customers={customers}
                customerId={data.resolvedCustomer?.id ?? activeQuery!.customerId ?? null}
                guidance={data.guidance}
                market={data.market}
                laneTraffic={data.laneTraffic}
              />
            </div>
            {/* Zone 2 — Carrier shortlist (top 5) */}
            <div className="order-2" data-testid="spot-zone-carriers">
              <CarrierShortlistCard outreach={data.carrierOutreach ?? []} />
            </div>
            {/* Zone 3 — Customer lane timeline */}
            <div className="order-3" data-testid="spot-zone-timeline">
              <CustomerLaneTimelineCard
                exactMatches={data.exactMatches}
                resolvedCustomer={data.resolvedCustomer}
                onPickQuote={onPickQuote}
              />
            </div>
            {/* Zone 4 — Loss pattern card */}
            <div className="order-4" data-testid="spot-zone-loss">
              <LossPatternCard tieredMatches={data.tieredMatches ?? []} />
            </div>
          </div>

          {/* Lane traffic (Task #515) — load_fact aggregates */}
          {data.laneTraffic && <LaneTrafficCard traffic={data.laneTraffic} />}

          {/* 4. Tiered match history — Task #514 */}
          <TieredMatchSections
            tieredMatches={data.tieredMatches ?? []}
            tierCounts={data.kpis.tierCounts ?? { exact: data.kpis.exactCount, same_market: 0, same_state: data.kpis.similarCount, reverse_lane: 0, same_corridor: 0 }}
            query={data.query}
            matchMode={activeQuery!.matchMode ?? "relaxed"}
            onPickQuote={onPickQuote}
            onBroadenDate={() => { setPickupDate(""); editSearch(); }}
            onBroadenLookback={() => { setLookbackDays("0"); editSearch(); }}
            onBroadenEquipment={() => { setEquipment("Any"); editSearch(); }}
            onSwitchToRelaxed={() => { setMatchMode("relaxed"); setActiveQuery(q => q ? { ...q, matchMode: "relaxed" } : q); }}
          />

          {/* 6. Customer panel — highlight resolved customer */}
          <SectionCard title="Customer Signals on this Lane" icon={<Users className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-customer-panel"
            action={data.resolvedCustomer ? (
              <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                {data.resolvedCustomer.name} highlighted
              </span>
            ) : undefined}>
            {data.customerPanel.length === 0 ? (
              <div className="text-muted-foreground text-center py-4">
                <Users className="h-5 w-5 mx-auto mb-1.5 text-muted-foreground" />
                No customer history on this lane yet — this lane is a clean-slate opportunity.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
                  <tr><th className="text-left py-1">Customer</th><th>Quotes</th><th>Win rate</th><th>Avg quoted</th><th>Avg margin</th><th>Last</th><th className="text-left">Top carriers</th></tr>
                </thead>
                <tbody>
                  {data.customerPanel.map(c => {
                    const isResolved = data.resolvedCustomer?.id === c.customerId;
                    return (
                      <tr key={c.customerId}
                        className={`border-t border-border/60 hover:bg-muted/40 cursor-pointer ${isResolved ? "bg-amber-500/[0.06]" : ""}`}
                        onClick={() => onPickCustomer(c.customerId)} data-testid={`spot-customer-row-${c.customerId}`}>
                        <td className={`py-1 font-medium ${isResolved ? "text-amber-800 dark:text-amber-200 border-l-2 border-amber-500 dark:border-amber-400 pl-2" : "text-foreground"}`}>
                          {c.customerName}
                          {isResolved && <span className="ml-1.5 text-[9px] uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-400">selected</span>}
                        </td>
                        <td className="text-center tabular-nums">{c.quotes}</td>
                        <td className="text-center tabular-nums">{fmtPct(c.winRate)}</td>
                        <td className="text-center tabular-nums">{fmtMoney(c.avgQuoted)}</td>
                        <td className="text-center tabular-nums">{fmtMoney(c.avgMargin)}</td>
                        <td className="text-center tabular-nums text-muted-foreground">{c.lastQuotedDays !== null ? `${c.lastQuotedDays}d` : "—"}</td>
                        <td className="text-muted-foreground text-[10px]">{c.topCarriers.map(t => `${t.name} (${t.loads})`).join(", ") || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SectionCard>

          {/* 7. Outcome reasons + 8. Carrier history */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <SectionCard title="Outcome Reasons" icon={<Activity className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-outcomes">
              {data.outcomeBreakdown.length === 0 ? (
                <div className="text-muted-foreground">No prior outcomes.</div>
              ) : (
                <div className="space-y-1.5">
                  {data.outcomeBreakdown.map((o, i) => (
                    <div key={i} className="flex items-center gap-2" data-testid={`spot-outcome-${i}`}>
                      <span className="text-foreground flex-1 truncate">{o.reason}</span>
                      <div className="w-24 h-1.5 bg-muted rounded-[4px] overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, o.pct)}%` }} />
                      </div>
                      <span className="text-muted-foreground tabular-nums w-10 text-right">{o.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            <CarrierOutreachList outreach={data.carrierOutreach} />
          </div>

          {/* 9. Internal variance + 10. Attractiveness */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <SectionCard title="Internal Variance (per rep)" icon={<Users className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-variance">
              {data.internalVariance.length === 0 ? (
                <div className="text-muted-foreground">No rep history on this lane.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
                    <tr><th className="text-left">Rep</th><th>Quotes</th><th>Avg quoted</th><th>Win rate</th><th>Avg margin</th></tr>
                  </thead>
                  <tbody>
                    {data.internalVariance.map(v => (
                      <tr key={v.rep} className="border-t border-border/60" data-testid={`spot-variance-${v.rep}`}>
                        <td className="py-1 text-foreground">{v.rep}</td>
                        <td className="text-center tabular-nums">{v.count}</td>
                        <td className="text-center tabular-nums">{fmtMoney(v.avgQuoted)}</td>
                        <td className="text-center tabular-nums">{fmtPct(v.winRate)}</td>
                        <td className="text-center tabular-nums">{fmtMoney(v.avgMargin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SectionCard>
            <SectionCard title="Freight Attractiveness" icon={<Award className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-attractiveness">
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-center justify-center w-24 h-24 rounded-full border-4 border-amber-500/40 bg-background">
                  <span className="text-2xl font-bold text-amber-400 tabular-nums" data-testid="text-spot-attract-score">{data.attractiveness.score}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">score</span>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-foreground" data-testid="text-spot-attract-label">{data.attractiveness.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">{data.attractiveness.rationale}</div>
                  <div className="text-[10px] text-muted-foreground mt-2">
                    {data.attractiveness.totalQuotes} total · {data.attractiveness.decided} decided ·
                    {" "}{fmtPct(data.attractiveness.winRate)} win · {fmtMoney(data.attractiveness.avgMargin)} avg margin
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>

          {/* 11. Alerts */}
          <SectionCard title="Lane Alerts" icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-alerts">
            {data.alerts.length === 0 ? (
              <div className="text-muted-foreground flex items-center gap-2"><Clock className="h-3 w-3" /> No active alerts on this lane.</div>
            ) : (
              <div className="space-y-2">
                {data.alerts.map(a => (
                  <div key={a.id}
                    className={`rounded-[4px] p-2 border ${
                      a.severity === "high" ? "bg-red-500/10 border-red-500/30"
                      : a.severity === "medium" ? "bg-amber-500/10 border-amber-500/30"
                      : "bg-muted/40 border-border"}`}
                    data-testid={`spot-alert-${a.id}`}>
                    <div className="text-[12px] font-semibold text-foreground">{a.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{a.detail}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "amber" | "blue" }): JSX.Element {
  const accentCls =
    accent === "amber" ? "border-amber-500/40 bg-amber-500/[0.08] dark:bg-amber-500/[0.04]" :
    accent === "blue" ? "border-blue-500/40 bg-blue-500/[0.08] dark:bg-blue-500/[0.04]" :
    "border-border bg-card";
  const valueCls =
    accent === "amber" ? "text-amber-700 dark:text-amber-300" :
    accent === "blue" ? "text-blue-700 dark:text-blue-300" :
    "text-foreground";
  return (
    <div className={`rounded-[4px] border p-2 ${accentCls}`} data-testid={`spot-kpi-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function KpiBadgeInline({ value, freshness }: { value: string; freshness?: string | null }): JSX.Element {
  const tier = (value || "insufficient").toLowerCase();
  const tone =
    tier === "high" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" :
    tier === "medium" ? "bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40" :
    tier === "low" ? "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40" :
    "bg-muted text-foreground border-border";
  const freshTone =
    freshness === "fresh" ? "text-emerald-700 dark:text-emerald-400" :
    freshness === "recent" ? "text-amber-700 dark:text-amber-400" :
    freshness === "stale" ? "text-orange-700 dark:text-orange-400" :
    "text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="spot-confidence-inline">
      <span className={`px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold border capitalize ${tone}`}>
        {value ? value.replace(/_/g, " ") : "—"}
      </span>
      {freshness && <span className={`text-[10px] capitalize font-medium ${freshTone}`}>· {freshness}</span>}
    </span>
  );
}

function KpiBadge({ label, value, freshness }: { label: string; value: string; freshness?: string | null }): JSX.Element {
  const tier = (value || "insufficient").toLowerCase();
  const tone =
    tier === "high" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40" :
    tier === "medium" ? "bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40" :
    tier === "low" ? "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40" :
    "bg-muted text-foreground border-border";
  const freshTone =
    freshness === "fresh" ? "text-emerald-700 dark:text-emerald-400" :
    freshness === "recent" ? "text-amber-700 dark:text-amber-400" :
    freshness === "stale" ? "text-orange-700 dark:text-orange-400" :
    "text-muted-foreground";
  return (
    <div className="rounded-[4px] bg-card border border-border p-2" data-testid="spot-kpi-confidence">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
      <div className={`inline-flex items-center mt-0.5 px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold border ${tone}`}>
        {value || "—"}
      </div>
      {freshness && <div className={`text-[10px] mt-0.5 capitalize font-medium ${freshTone}`}>{freshness}</div>}
    </div>
  );
}

function AdvField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function StatusChip({ status }: { status: string }): JSX.Element {
  const colorMap: Record<string, string> = {
    won: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    won_low_margin: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 border-yellow-500/40",
    pending: "bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/40",
    expired: "bg-muted-foreground/15 text-foreground border-border",
    no_response: "bg-muted-foreground/15 text-foreground border-border",
  };
  const cls = colorMap[status] ?? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40";
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

function QuoteListSection({ title, icon, testId, emptyNode, quotes, onPickQuote, accent, subtitle }: {
  title: string; icon: React.ReactNode; testId: string;
  emptyNode: React.ReactNode;
  quotes: EnrichedQuote[]; onPickQuote: (id: string) => void;
  accent?: "amber" | "blue";
  subtitle?: string;
}): JSX.Element {
  const accentBorder =
    accent === "amber" ? "border-amber-500/40 shadow-[0_0_0_1px_rgba(251,191,36,0.05)]" :
    accent === "blue" ? "border-blue-500/30" :
    "border-border";
  const headerBg =
    accent === "amber" ? "bg-amber-500/[0.04]" :
    accent === "blue" ? "bg-blue-500/[0.03]" :
    "";
  const countTone =
    accent === "amber" ? "text-amber-300" :
    accent === "blue" ? "text-blue-300" :
    "text-muted-foreground";
  return (
    <Card className={`bg-card rounded-[4px] border ${accentBorder}`} data-testid={testId}>
      <CardHeader className={`py-2.5 px-3 flex flex-row items-center justify-between border-b border-border ${headerBg}`}>
        <div className="flex flex-col">
          <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
            {icon}{title}
          </CardTitle>
          {subtitle && <span className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</span>}
        </div>
        <span className={`text-[10px] font-semibold tabular-nums ${countTone}`}>{quotes.length} shown</span>
      </CardHeader>
      <CardContent className="p-3 text-xs text-foreground">
        {quotes.length === 0 ? (
          emptyNode
        ) : (
          <div className="max-h-[280px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground text-[10px] uppercase tracking-wider sticky top-0 bg-card">
                <tr><th className="text-left py-1">Date</th><th className="text-left">Customer</th><th>Quoted</th><th>Buy</th><th>Status</th></tr>
              </thead>
              <tbody>
                {quotes.map(q => {
                  const quoted = num(q.quotedAmount);
                  const paid = num(q.carrierPaid);
                  return (
                    <tr key={q.id} onClick={() => onPickQuote(q.id)}
                      className="border-t border-border/60 hover:bg-muted/40 cursor-pointer"
                      data-testid={`spot-quote-row-${q.id}`}>
                      <td className="py-1 text-foreground">{new Date(q.requestDate).toLocaleDateString()}</td>
                      <td className="text-foreground truncate max-w-[140px]">{q.customerName}</td>
                      <td className="text-center tabular-nums">{fmtMoney(quoted)}</td>
                      <td className="text-center tabular-nums text-muted-foreground">{paid ? fmtMoney(paid) : "—"}</td>
                      <td className="text-center"><StatusChip status={q.outcomeStatus} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Pricing guidance band — TRAC market band primary, internal P25-P75 calibration line below.
 */
function PricingGuidanceBand({ guidance, market, marketStatus, freshnessLabel }: {
  guidance: SpotResult["guidance"];
  market: SpotResult["market"];
  marketStatus: SpotResult["marketStatus"];
  freshnessLabel: string | null;
}): JSX.Element {
  const isTrac = guidance.benchmarkSource === "trac";
  const cal = guidance.calibration ?? null;
  return (
    <div className="rounded-[4px] border border-amber-500/40 bg-gradient-to-br from-amber-500/[0.12] via-card to-card dark:from-amber-500/[0.08] p-4" data-testid="spot-section-guidance">
      <div className="flex items-start gap-6 flex-wrap">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300/80 font-semibold flex items-center gap-1">
            <Activity className="h-3 w-3" /> Suggested quote range
            {isTrac && (
              <span className="ml-1 text-[9px] px-1 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 font-semibold" data-testid="badge-spot-band-trac">TRAC</span>
            )}
            <IntegrationDegradedPill source="sonar" label="SONAR" />
          </span>
          <span className="text-3xl font-bold text-amber-700 dark:text-amber-400 tabular-nums leading-tight mt-0.5" data-testid="text-spot-guidance-range">
            {guidance.suggestedLow !== null && guidance.suggestedHigh !== null
              ? `${fmtMoney(guidance.suggestedLow)} – ${fmtMoney(guidance.suggestedHigh)}`
              : "—"}
          </span>
          <span className="text-[10px] text-muted-foreground mt-0.5 capitalize font-medium">
            Source: {guidance.benchmarkSource.replace(/_/g, " ")}
          </span>
        </div>
        {guidance.benchmark !== null && (
          <div className="flex flex-col border-l border-border pl-6">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{isTrac ? "TRAC mid" : "SONAR benchmark"}</span>
            <span className="text-xl text-foreground tabular-nums font-semibold mt-0.5 flex items-center gap-1.5">
              {fmtMoney(guidance.benchmark)}
              {market?.forecastDirection === "up" && <TrendingUp className="h-4 w-4 text-rose-400" data-testid="icon-spot-forecast-up" aria-label="Forecast trending up" />}
              {market?.forecastDirection === "down" && <TrendingDown className="h-4 w-4 text-emerald-400" data-testid="icon-spot-forecast-down" aria-label="Forecast trending down" />}
              {market?.forecastDirection === "flat" && <Minus className="h-4 w-4 text-muted-foreground" data-testid="icon-spot-forecast-flat" aria-label="Forecast flat" />}
            </span>
            <span className="text-[10px] text-muted-foreground mt-0.5" data-testid="text-spot-capacity-outlook">
              {market?.capacityOutlook ?? "market reference"}
            </span>
          </div>
        )}
        <div className="flex flex-col border-l border-border pl-6">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Confidence</span>
          <div className="mt-0.5">
            <KpiBadgeInline value={guidance.confidence} freshness={freshnessLabel} />
          </div>
        </div>
        <div className="flex-1 min-w-[260px] text-[12px] text-foreground leading-relaxed border-l border-border pl-6">
          {guidance.message}
          {!marketStatus.available && marketStatus.reason && (
            <div className="mt-1 text-[10px] text-muted-foreground" data-testid="text-spot-market-reason">
              Market data unavailable: {marketStatus.reason}
            </div>
          )}
        </div>
      </div>
      {(cal || (isTrac && market)) && (
        <div className="mt-3 pt-3 border-t border-border grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]" data-testid="spot-section-calibration">
          {cal && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Internal calibration</span>
              <span className="text-foreground tabular-nums" data-testid="text-spot-calibration-band">
                {cal.suggestedLow !== null && cal.suggestedHigh !== null
                  ? `${fmtMoney(cal.suggestedLow)} – ${fmtMoney(cal.suggestedHigh)}`
                  : "—"}
              </span>
              <span className="text-[10px] text-muted-foreground">{cal.note}</span>
            </div>
          )}
          {market?.rpm?.mid != null && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">TRAC RPM (low / mid / high)</span>
              <span className="text-foreground tabular-nums">
                {market.rpm.low?.toFixed(2) ?? "—"} / {market.rpm.mid.toFixed(2)} / {market.rpm.high?.toFixed(2) ?? "—"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {market.miles ? `${market.miles.toLocaleString()} mi` : ""}{market.contractRpm != null ? ` · contract $${market.contractRpm.toFixed(2)}` : ""}
              </span>
            </div>
          )}
          {market && (market.avgRpm30d != null || market.forecast7dRpm != null) && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Trend</span>
              <span className="text-foreground tabular-nums">
                30d {market.avgRpm30d?.toFixed(2) ?? "—"} · 90d {market.avgRpm90d?.toFixed(2) ?? "—"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                7d forecast: {market.forecast7dRpm?.toFixed(2) ?? "—"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Lane Traffic — load_fact volume and top carriers moving freight on this state-state lane.
 */
function LaneTrafficCard({ traffic }: { traffic: NonNullable<SpotResult["laneTraffic"]> }): JSX.Element {
  const tb = traffic.tierBreakdown;
  return (
    <SectionCard title="Lane Traffic" icon={<TrendingUp className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-lane-traffic">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-2">
        <Kpi label={`Loads (${traffic.lookbackDays}d)`} value={traffic.totalLoads.toLocaleString()} sub={`${traffic.loads30d.toLocaleString()} in 30d`} />
        <Kpi label="Realized" value={traffic.realized.toLocaleString()} sub={`${traffic.available.toLocaleString()} avail`} />
        <Kpi label="Margin %" value={`${traffic.marginPct.toFixed(1)}%`} sub={`avg ${fmtMoney(traffic.avgMarginPerLoad)}/load`} />
        <Kpi label="Revenue" value={fmtMoney(traffic.revenue)} sub={`avg ${fmtMoney(traffic.avgRevenuePerLoad)}/load`} />
        <Kpi label="Carriers" value={traffic.uniqueCarriers.toLocaleString()} sub={`avg cost ${fmtMoney(traffic.avgCostPerLoad)}`} />
      </div>
      <div className="text-[10px] text-muted-foreground mb-1" data-testid="spot-traffic-window">
        Window: last {traffic.lookbackDays} days
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-2" data-testid="spot-traffic-tier-breakdown">
        <span className="uppercase tracking-wider">Match tiers:</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 font-medium">Exact {tb.exact}</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/40 font-medium">Same market {tb.sameMarket}</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-muted text-muted-foreground border border-border">Same state {tb.sameState}</span>
      </div>
      {traffic.topCarriers.length === 0 ? (
        <div className="text-muted-foreground text-xs">No realized loads on this lane in the last {traffic.lookbackDays} days.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left">Carrier</th>
              <th className="text-right">Loads (90d/30d)</th>
              <th className="text-right">Last buy</th>
              <th className="text-right">Margin %</th>
              <th className="text-right">Reliability</th>
            </tr>
          </thead>
          <tbody>
            {traffic.topCarriers.map((c, i) => (
              <tr key={`${c.name}-${i}`} className="border-t border-border/60" data-testid={`row-spot-traffic-carrier-${i}`}>
                <td className="py-1 text-foreground">{c.name}</td>
                <td className="text-right tabular-nums text-foreground">{c.loads90d.toLocaleString()} / {c.loads30d.toLocaleString()}</td>
                <td className="text-right tabular-nums text-foreground">{c.lastBuyRate != null ? fmtMoney(c.lastBuyRate) : "—"}</td>
                <td className="text-right tabular-nums text-foreground">{c.marginPct.toFixed(1)}%</td>
                <td className="text-right tabular-nums text-foreground">
                  {c.reliabilityScore != null
                    ? <span title={c.reliabilityTier ?? ""}>{c.reliabilityScore.toFixed(0)}{c.reliabilityTier ? ` · ${c.reliabilityTier}` : ""}</span>
                    : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

/**
 * Carrier Outreach List — top 25 carriers from carrier_lane_fit ⨝ scorecard ⨝ rolodex.
 */
function CarrierOutreachList({ outreach }: { outreach: SpotResult["carrierOutreach"] }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? outreach : outreach.slice(0, 5);
  const hiddenCount = Math.max(0, outreach.length - 5);
  return (
    <SectionCard title="Carriers to Call" icon={<Truck className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-carrier-outreach"
      action={hiddenCount > 0 ? (
        <button type="button" onClick={() => setShowAll(s => !s)} className="text-[10px] text-amber-300 hover:text-amber-200 underline" data-testid="button-spot-outreach-toggle">
          {showAll ? "Show top 5" : `Show all (${outreach.length})`}
        </button>
      ) : undefined}>
      {outreach.length === 0 ? (
        <div className="text-muted-foreground">No fit carriers found for this lane.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr>
              <th className="text-left">Carrier</th>
              <th className="text-right">Rank (Fit / Reli)</th>
              <th className="text-right">90d / Exact</th>
              <th className="text-right">Margin %</th>
              <th className="text-right">On-Time</th>
              <th className="text-right">Last Paid</th>
              <th className="text-left">Presence</th>
              <th className="text-left">Contact</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c, i) => (
              <tr key={`${c.carrierId ?? c.name}-${i}`} className={`border-t border-border/60 ${c.doNotUse ? "opacity-50" : ""}`} data-testid={`row-spot-outreach-${i}`}>
                <td className="py-1 text-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>{c.name}</span>
                    {c.inRolodex && (
                      <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-blue-500/15 text-blue-300 border border-blue-500/30" title="In your rolodex">★</span>
                    )}
                    {c.doNotUse && (
                      <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-red-500/15 text-red-300 border border-red-500/30" title="Do not use">DNU</span>
                    )}
                  </div>
                </td>
                <td className="text-right tabular-nums text-foreground">
                  <span title={`Composite rank: ${c.rankScore.toFixed(0)} (fit ${c.fitScore.toFixed(0)} · reli ${c.performanceScore.toFixed(0)})`}>
                    {c.rankScore.toFixed(0)} <span className="text-muted-foreground">({c.fitScore.toFixed(0)}/{c.performanceScore.toFixed(0)})</span>
                  </span>
                </td>
                <td className="text-right tabular-nums text-foreground">{c.loads90d} / {c.exactLaneRuns}</td>
                <td className="text-right tabular-nums text-foreground">{c.marginPct.toFixed(1)}%</td>
                <td className="text-right tabular-nums text-foreground" data-testid={`spot-outreach-ontime-${i}`}>
                  {c.onTimePct != null ? `${c.onTimePct.toFixed(0)}%` : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-right tabular-nums text-foreground" data-testid={`spot-outreach-lastrate-${i}`}>
                  {c.lastRatePaid != null ? (
                    <span title={c.lastRatePaidAt ? new Date(c.lastRatePaidAt).toLocaleDateString() : undefined}>
                      ${c.lastRatePaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-[10px]" data-testid={`spot-outreach-presence-${i}`}>
                  {c.presence === "active" && <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active</span>}
                  {c.presence === "known" && <span className="px-1.5 py-0.5 rounded-[3px] bg-blue-500/15 text-blue-300 border border-blue-500/30 inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-blue-400" />Known</span>}
                  {c.presence === "cold" && <span className="px-1.5 py-0.5 rounded-[3px] bg-muted text-muted-foreground border border-border inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />Cold</span>}
                </td>
                <td className="text-muted-foreground text-[10px]">
                  <CarrierActionLinks phone={c.phone} email={c.primaryEmail} idx={i} variant="links" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// Quote Builder Card — controlled form, live margin %, guardrail-disabled save,
// posts to /api/customer-quotes/spot/create then /spot/email-draft.
const SPOT_BUILDER_GUARDRAIL_PCT = 5;

// Rep-editable subset of the shared spotQuoteCreateSchema; lane fields are
// filled from the active search query at submit time.
const quoteBuilderSchema = spotQuoteCreateSchema.pick({
  customerId: true,
  quotedAmount: true,
  estimatedCost: true,
  validUntil: true,
  notes: true,
});
type QuoteBuilderValues = zod.infer<typeof quoteBuilderSchema>;

function QuoteBuilderCard({
  query, customers, customerId, guidance, market, laneTraffic, onSaved,
}: {
  query: SpotSearchQuery;
  customers: Customer[];
  customerId: string | null;
  guidance: SpotResult["guidance"];
  market: SpotResult["market"];
  laneTraffic: SpotResult["laneTraffic"];
  onSaved?: (quoteId: string) => void;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const { toast } = useToast();
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string; to: string[] } | null>(null);

  const suggestedHigh = guidance.suggestedHigh ?? guidance.benchmark ?? market?.band?.high ?? 0;
  const suggestedLow = guidance.suggestedLow ?? guidance.benchmark ?? market?.band?.low ?? 0;
  const benchmark = guidance.benchmark ?? market?.band?.mid ?? null;
  const defaultQuoted = Math.round(suggestedHigh || benchmark || suggestedLow || 0);
  const tracMid = market?.band?.mid ?? null;
  const laneCarrierAvg = laneTraffic?.avgCostPerLoad && laneTraffic.avgCostPerLoad > 0
    ? laneTraffic.avgCostPerLoad
    : null;
  const defaultCost = tracMid && tracMid > 0 ? tracMid : laneCarrierAvg;
  const costSource: "trac" | "lane" | null = tracMid && tracMid > 0 ? "trac" : laneCarrierAvg ? "lane" : null;

  const form = useForm<QuoteBuilderValues>({
    resolver: zodResolver(quoteBuilderSchema),
    defaultValues: {
      customerId: customerId ?? "",
      quotedAmount: defaultQuoted > 0 ? defaultQuoted : 0,
      estimatedCost: defaultCost && defaultCost > 0 ? Math.round(defaultCost) : 0,
      validUntil: "",
      notes: "",
    },
  });

  // Re-prefill if the search/guidance changes (e.g. user reruns search).
  useEffect(() => {
    form.reset({
      customerId: customerId ?? form.getValues("customerId") ?? "",
      quotedAmount: defaultQuoted > 0 ? defaultQuoted : (Number(form.getValues("quotedAmount")) || 0),
      estimatedCost: defaultCost && defaultCost > 0 ? Math.round(defaultCost) : (Number(form.getValues("estimatedCost")) || 0),
      validUntil: form.getValues("validUntil") ?? "",
      notes: form.getValues("notes") ?? "",
    });
    setSavedQuoteId(null);
    setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.pickupCity, query.pickupState, query.deliveryCity, query.deliveryState, query.equipment, customerId, defaultQuoted, defaultCost]);

  const watched = form.watch();
  const quoted = Number(watched.quotedAmount) || 0;
  const cost = Number(watched.estimatedCost) || 0;
  const marginAmt = quoted - cost;
  const marginPct = quoted > 0 && cost > 0 ? (marginAmt / quoted) * 100 : null;
  const guardrailViolation = marginPct !== null && marginPct < SPOT_BUILDER_GUARDRAIL_PCT;

  const createMut = useMutation({
    mutationFn: async (values: QuoteBuilderValues) => {
      const payload = {
        pickupCity: query.pickupCity,
        pickupState: query.pickupState,
        deliveryCity: query.deliveryCity,
        deliveryState: query.deliveryState,
        equipment: query.equipment && query.equipment !== "Any" ? query.equipment : "Van",
        customerId: values.customerId,
        quotedAmount: values.quotedAmount,
        estimatedCost: values.estimatedCost && values.estimatedCost > 0 ? values.estimatedCost : undefined,
        validUntil: values.validUntil || undefined,
        notes: values.notes || undefined,
      };
      const res = await apiRequest("POST", "/api/customer-quotes/spot/create", payload);
      return await res.json() as { id: string };
    },
    onSuccess: (data) => {
      setSavedQuoteId(data.id);
      toast({ title: "Quote saved", description: `$${quoted.toLocaleString()} · ${query.pickupCity} → ${query.deliveryCity}` });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      onSaved?.(data.id);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Save failed";
      toast({ title: "Could not save quote", description: msg, variant: "destructive" });
    },
  });

  const draftMut = useMutation({
    mutationFn: async (quoteId: string) => {
      const payload = {
        quoteId,
        recommendedRate: defaultQuoted > 0 ? defaultQuoted : undefined,
        guidanceMessage: guidance.message?.trim() || undefined,
        bandLow: market?.band?.low ?? guidance.suggestedLow ?? undefined,
        bandMid: market?.band?.mid ?? undefined,
        bandHigh: market?.band?.high ?? guidance.suggestedHigh ?? undefined,
        bandSource: market?.band ? "TRAC" : guidance.benchmark != null ? "internal" : undefined,
      };
      const res = await apiRequest("POST", "/api/customer-quotes/spot/email-draft", payload);
      return await res.json() as { subject: string; body: string; to: string[] };
    },
    onSuccess: (d) => {
      setDraft(d);
      toast({ title: "Draft ready", description: `${d.body.length} chars` });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Draft failed";
      toast({ title: "Could not draft email", description: msg, variant: "destructive" });
    },
  });

  const submit = form.handleSubmit((values) => {
    if (guardrailViolation) {
      toast({
        title: `Margin below ${SPOT_BUILDER_GUARDRAIL_PCT}% guardrail`,
        description: "Raise the quoted rate or lower the estimated cost before saving.",
        variant: "destructive",
      });
      return;
    }
    createMut.mutate(values);
  });

  const marginToneClass =
    marginPct === null ? "text-muted-foreground"
    : guardrailViolation ? "text-red-700 dark:text-red-300"
    : marginPct < 10 ? "text-amber-700 dark:text-amber-300"
    : "text-emerald-700 dark:text-emerald-300";

  return (
    <Card className="bg-card rounded-[4px] border border-amber-500/40 shadow-[0_0_0_1px_rgba(251,191,36,0.05)]" data-testid="spot-zone-quote-builder">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-border bg-amber-500/[0.04]">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
          <DollarSign className="h-3.5 w-3.5 text-amber-400" /> Quote Builder
        </CardTitle>
        {benchmark != null && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            Benchmark <span className="text-amber-700 dark:text-amber-300 font-medium">{fmtMoney(benchmark)}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="p-3">
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" data-testid="form-quote-builder">
            <div className="grid grid-cols-2 gap-2">
              <FormField control={form.control} name="customerId" render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="h-8 bg-card border-border text-xs text-foreground [&>span]:text-foreground" data-testid="select-builder-customer">
                        <SelectValue placeholder="Select customer" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent container={overlayPortal}>
                      {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="quotedAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Quoted ($)</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1} inputMode="decimal"
                      value={field.value ?? ""}
                      onChange={e => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      className="h-8 bg-card border-border text-sm text-foreground tabular-nums"
                      data-testid="input-builder-quoted" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="estimatedCost" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    Est. cost ($)
                    {costSource && (
                      <span className="text-[9px] normal-case tracking-normal text-muted-foreground" data-testid="text-builder-cost-source">
                        from {costSource === "trac" ? "TRAC mid" : "lane avg"}
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1} inputMode="decimal"
                      value={field.value ?? ""}
                      onChange={e => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      className="h-8 bg-card border-border text-sm text-foreground tabular-nums"
                      data-testid="input-builder-cost" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="validUntil" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Valid until</FormLabel>
                  <FormControl>
                    <Input type="date" {...field}
                      className="h-8 bg-card border-border text-xs text-foreground dark:[color-scheme:dark]"
                      data-testid="input-builder-valid" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Notes</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Internal note (optional)"
                      className="h-8 bg-card border-border text-xs text-foreground placeholder:text-muted-foreground"
                      data-testid="input-builder-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="rounded-[4px] border border-border bg-background px-2 py-1.5 flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground uppercase tracking-wider text-[9px]">Live margin</span>
                <span className={`font-semibold tabular-nums ${marginToneClass}`} data-testid="text-builder-margin-pct">
                  {marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
                </span>
                <span className="text-muted-foreground tabular-nums" data-testid="text-builder-margin-amt">
                  {marginAmt !== 0 ? fmtMoney(marginAmt) : ""}
                </span>
              </div>
              {guardrailViolation && (
                <span className="text-[10px] font-medium text-red-700 dark:text-red-300 inline-flex items-center gap-1" data-testid="text-builder-guardrail">
                  <AlertTriangle className="h-3 w-3" /> below {SPOT_BUILDER_GUARDRAIL_PCT}%
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={guardrailViolation || createMut.isPending}
                        className="h-8 bg-[#FFC333] hover:bg-amber-400 text-amber-950 font-semibold rounded-[4px] px-3 disabled:opacity-50"
                        data-testid="button-builder-save"
                      >
                        <Save className="h-3 w-3 mr-1" /> {createMut.isPending ? "Saving…" : savedQuoteId ? "Saved" : "Save quote"}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {guardrailViolation && (
                    <TooltipContent>Margin below {SPOT_BUILDER_GUARDRAIL_PCT}% guardrail.</TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!savedQuoteId || draftMut.isPending}
                onClick={() => savedQuoteId && draftMut.mutate(savedQuoteId)}
                className="h-8 border-amber-500/50 hover:bg-amber-500/10 text-amber-700 dark:text-amber-200 font-medium text-xs px-3 disabled:opacity-50"
                data-testid="button-builder-email"
              >
                <Mail className="h-3 w-3 mr-1" /> {draftMut.isPending ? "Drafting…" : "Email customer"}
              </Button>
              {savedQuoteId && (
                <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300 ml-auto" data-testid="text-builder-saved-id">Quote #{savedQuoteId.slice(0, 8)}</span>
              )}
            </div>
            {draft && (
              <div className="rounded-[4px] border border-border bg-background p-2 space-y-1.5" data-testid="builder-email-draft">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground uppercase tracking-wider">Draft</span>
                  <span className="text-muted-foreground" data-testid="text-builder-draft-to">
                    To: {draft.to.length > 0 ? draft.to.join(", ") : <span className="text-muted-foreground italic">add recipients</span>}
                  </span>
                </div>
                <div className="text-[11px] text-foreground font-medium" data-testid="text-builder-draft-subject">{draft.subject}</div>
                <Textarea
                  value={draft.body}
                  onChange={e => setDraft(d => d ? { ...d, body: e.target.value } : d)}
                  className="min-h-[120px] text-xs bg-card border-border text-foreground"
                  data-testid="textarea-builder-draft-body"
                />
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// Shared call/email action controls for any carrier surface (shortlist + full
// outreach list). Webex click-to-call uses webextel://, matching the existing
// pattern in contact-detail-sheet, contact-list, and pre-call-planner.
function CarrierActionLinks({
  phone, email, idx, variant = "icons",
}: {
  phone: string | null | undefined;
  email: string | null | undefined;
  idx: number;
  variant?: "icons" | "links";
}): JSX.Element {
  const callHref = phone ? `webextel://${phone.replace(/[^0-9+]/g, "")}` : null;
  const mailHref = email
    ? `mailto:${email}?subject=${encodeURIComponent("RFQ: lane coverage")}&body=${encodeURIComponent("Hi,\n\nWe have a load looking for coverage. Can you bid on this lane?\n\nThanks,")}`
    : null;
  if (variant === "links") {
    if (!mailHref && !callHref) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex items-center gap-2">
        {mailHref && <a href={mailHref} className="text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 font-medium underline" data-testid={`link-outreach-email-${idx}`}>email</a>}
        {callHref && <a href={callHref} className="text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 font-medium underline" data-testid={`link-outreach-phone-${idx}`}>call</a>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 shrink-0">
      {callHref && (
        <a href={callHref}
          className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] border border-border hover:bg-amber-500/10 hover:border-amber-500/40 text-amber-700 dark:text-amber-300"
          title={`Webex call ${phone}`}
          data-testid={`button-shortlist-call-${idx}`}>
          <Phone className="h-3 w-3" />
        </a>
      )}
      {mailHref && (
        <a href={mailHref}
          className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] border border-border hover:bg-amber-500/10 hover:border-amber-500/40 text-amber-700 dark:text-amber-300"
          title={`RFQ email ${email}`}
          data-testid={`button-shortlist-email-${idx}`}>
          <Mail className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// Carrier Shortlist — top 5 outreach rows with click-to-call + mailto.
function CarrierShortlistCard({
  outreach,
}: {
  outreach: SpotResult["carrierOutreach"];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const top = expanded ? outreach : outreach.slice(0, 5);
  return (
    <Card className="bg-card rounded-[4px] border border-border" data-testid="spot-zone-carrier-shortlist">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-border">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5 text-amber-400" /> Carriers to Call (top 5)
        </CardTitle>
        {outreach.length > 5 && (
          <button type="button" onClick={() => setExpanded(v => !v)} className="text-[10px] font-medium text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 underline" data-testid="button-shortlist-show-all">
            {expanded ? "Show top 5" : `Show all ${outreach.length}`}
          </button>
        )}
      </CardHeader>
      <CardContent className="p-3">
        {top.length === 0 ? (
          <div className="text-muted-foreground text-xs text-center py-4">No fit carriers found for this lane.</div>
        ) : (
          <ul className="space-y-1.5">
            {top.map((c, i) => (
              <li key={`${c.carrierId ?? c.name}-${i}`}
                className={`flex items-center gap-2 rounded-[4px] border border-border bg-background px-2 py-1.5 ${c.doNotUse ? "opacity-50" : ""}`}
                data-testid={`row-shortlist-${i}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-foreground">
                    <span className="truncate">{c.name}</span>
                    {c.inRolodex && <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-blue-500/15 text-blue-300 border border-blue-500/30" title="In your rolodex">★</span>}
                    {c.doNotUse && <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-red-500/15 text-red-300 border border-red-500/30">DNU</span>}
                    {c.presence === "active" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Active" />}
                    {c.presence === "known" && <span className="h-1.5 w-1.5 rounded-full bg-blue-400" title="Known" />}
                    {c.presence === "cold" && <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" title="Cold" />}
                  </div>
                  <div className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-1.5 flex-wrap">
                    <span title="Performance / reliability tier">{c.tier}</span>
                    <span>·</span>
                    <span data-testid={`text-shortlist-reliability-${i}`}>rel {c.performanceScore.toFixed(0)}</span>
                    <span>·</span>
                    <span data-testid={`text-shortlist-ontime-${i}`}>
                      OT {c.onTimePct != null ? `${c.onTimePct.toFixed(0)}%` : "—"}
                    </span>
                    <span>·</span>
                    <span>{c.loads90d}/90d</span>
                    <span>·</span>
                    <span>{c.marginPct.toFixed(0)}% mgn</span>
                    {c.lastRatePaid != null && <><span>·</span><span>last ${c.lastRatePaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></>}
                  </div>
                </div>
                <CarrierActionLinks phone={c.phone} email={c.primaryEmail} idx={i} variant="icons" />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Customer Lane Timeline — last 5 exact-lane quotes for the resolved customer.
function CustomerLaneTimelineCard({
  exactMatches, resolvedCustomer, onPickQuote,
}: {
  exactMatches: EnrichedQuote[];
  resolvedCustomer: { id: string; name: string } | null;
  onPickQuote: (id: string) => void;
}): JSX.Element {
  const filtered = resolvedCustomer
    ? exactMatches.filter(q => q.customerId === resolvedCustomer.id)
    : exactMatches;
  const timeline = filtered
    .slice()
    .sort((a, b) => new Date(b.requestDate).getTime() - new Date(a.requestDate).getTime())
    .slice(0, 5);
  return (
    <Card className="bg-card rounded-[4px] border border-border" data-testid="spot-zone-customer-timeline">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-border">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-amber-400" />
          {resolvedCustomer ? `${resolvedCustomer.name} on this lane` : "Recent on this lane"}
        </CardTitle>
        <span className="text-[10px] text-muted-foreground">{timeline.length} of {filtered.length}</span>
      </CardHeader>
      <CardContent className="p-3">
        {timeline.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4" data-testid="text-timeline-empty">
            {resolvedCustomer ? (
              <>
                <div className="text-amber-700 dark:text-amber-300 font-semibold">First-quote opportunity.</div>
                <div className="text-muted-foreground mt-1">
                  This is your first quote to {resolvedCustomer.name} on this lane.
                </div>
              </>
            ) : (
              "No exact-lane quote history yet."
            )}
          </div>
        ) : (
          <ol className="relative space-y-2.5 pl-4 border-l border-border">
            {timeline.map((q, i) => {
              const quoted = num(q.quotedAmount);
              const paid = num(q.carrierPaid);
              return (
                <li key={q.id} className="relative" data-testid={`timeline-item-${i}`}>
                  <span className={`absolute -left-[18px] top-1 h-2 w-2 rounded-full ${
                    q.outcomeStatus === "won" || q.outcomeStatus === "won_low_margin" ? "bg-emerald-400" :
                    q.outcomeStatus === "pending" ? "bg-amber-400" :
                    q.outcomeStatus.startsWith("lost") ? "bg-red-400" : "bg-muted-foreground"
                  }`} />
                  <button type="button" onClick={() => onPickQuote(q.id)}
                    className="text-left w-full hover:bg-muted/40 rounded-[4px] px-1.5 py-1 -mx-1.5 transition"
                    data-testid={`button-timeline-${q.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-foreground">{new Date(q.requestDate).toLocaleDateString()}</span>
                      <StatusChip status={q.outcomeStatus} />
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-xs text-foreground truncate">{q.customerName}</span>
                      <span className="text-xs text-foreground tabular-nums">{fmtMoney(quoted)}{paid ? <span className="text-muted-foreground"> / {fmtMoney(paid)}</span> : null}</span>
                    </div>
                    {q.outcomeReasonLabel && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{q.outcomeReasonLabel}</div>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// Loss Pattern — buckets exact-lane losses by outcome reason and surfaces the top bucket.
type LossBucketKey = "price_too_high" | "no_truck" | "no_response" | "customer_cancelled" | "other";
const LOSS_BUCKET_LABELS: Record<LossBucketKey, string> = {
  price_too_high: "Price too high",
  no_truck: "No truck",
  no_response: "No response",
  customer_cancelled: "Customer cancelled",
  other: "Other",
};
function classifyLossReason(q: EnrichedQuote): LossBucketKey {
  if (q.outcomeStatus === "no_response" || q.outcomeStatus === "expired") return "no_response";
  const r = (q.outcomeReasonLabel ?? "").toLowerCase();
  if (!r) return "other";
  if (/(cancel|withdraw|pulled|rescind)/.test(r)) return "customer_cancelled";
  if (/(price|rate|cost|cheap|expensive|under(cut|bid)|too high|low.*bid)/.test(r)) return "price_too_high";
  if (/(no\s*truck|capac|equip|driver|asset|coverage|avail)/.test(r)) return "no_truck";
  return "other";
}
function LossPatternCard({ tieredMatches }: { tieredMatches: TierGroup[] }): JSX.Element {
  const exactGroup = tieredMatches.find(g => g.tier === "exact");
  const allQuotes: EnrichedQuote[] = exactGroup ? (exactGroup.items ?? exactGroup.quotes ?? []) : [];
  const losses = allQuotes.filter(q =>
    q.outcomeStatus.startsWith("lost") || q.outcomeStatus === "no_response" || q.outcomeStatus === "expired"
  );
  const grouped = new Map<LossBucketKey, { key: LossBucketKey; count: number; lostMargins: number[] }>();
  for (const q of losses) {
    const key = classifyLossReason(q);
    const entry = grouped.get(key) ?? { key, count: 0, lostMargins: [] };
    entry.count += 1;
    const quoted = num(q.quotedAmount);
    const paid = num(q.carrierPaid);
    if (quoted > 0 && paid > 0) {
      entry.lostMargins.push(((quoted - paid) / quoted) * 100);
    }
    grouped.set(key, entry);
  }
  const buckets = Array.from(grouped.values())
    .map(b => ({
      ...b,
      avgLostMarginPct: b.lostMargins.length > 0
        ? b.lostMargins.reduce((s, v) => s + v, 0) / b.lostMargins.length
        : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const total = losses.length;
  const top = buckets[0] ?? null;
  const takeaway = top
    ? `${Math.round((top.count / total) * 100)}% of losses on this lane fall into "${LOSS_BUCKET_LABELS[top.key]}"${top.avgLostMarginPct !== null ? ` (avg margin gap ${top.avgLostMarginPct.toFixed(1)}%)` : ""}. Address it up front in your pitch.`
    : "No prior losses on this lane — clean slate.";
  return (
    <Card className="bg-card rounded-[4px] border border-border" data-testid="spot-zone-loss-pattern">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-border">
        <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
          <ThumbsDown className="h-3.5 w-3.5 text-amber-400" /> Why we lose this lane
        </CardTitle>
        <span className="text-[10px] text-muted-foreground tabular-nums">{total} losses</span>
      </CardHeader>
      <CardContent className="p-3 space-y-2">
        {buckets.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4">No prior losses on this lane.</div>
        ) : (
          <>
            <ul className="space-y-1.5">
              {buckets.map((b, i) => (
                <li key={b.key} className="flex items-center gap-2 text-xs" data-testid={`loss-bucket-${b.key}`}>
                  <span className="text-foreground flex-1 truncate">{LOSS_BUCKET_LABELS[b.key]}</span>
                  <div className="w-16 h-1.5 bg-muted rounded-[4px] overflow-hidden">
                    <div className="h-full bg-red-400/70" style={{ width: `${Math.min(100, (b.count / total) * 100)}%` }} />
                  </div>
                  <span className="text-muted-foreground tabular-nums w-8 text-right" data-testid={`loss-bucket-count-${b.key}`}>{b.count}</span>
                  <span className="text-muted-foreground tabular-nums w-16 text-right text-[10px]" data-testid={`loss-bucket-avg-margin-${b.key}`}>
                    {b.avgLostMarginPct !== null ? `${b.avgLostMarginPct.toFixed(1)}% mgn` : "—"}
                  </span>
                </li>
              ))}
            </ul>
            <div className="rounded-[4px] border border-amber-500/40 bg-amber-500/[0.10] dark:bg-amber-500/[0.05] px-2 py-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-200" data-testid="text-loss-takeaway">
              {takeaway}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Lane Stats Bar — collapsible KPI strip above Pricing.
 */
function LaneStatsBar({ kpis }: { kpis: SpotResult["kpis"] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="spot-section-lane-stats">
      <div className="rounded-[4px] border border-border bg-card/60 px-3 py-1.5 flex items-center gap-3 flex-wrap">
        <CollapsibleTrigger asChild>
          <button type="button"
            className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            data-testid="button-lane-stats-toggle">
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Lane stats
          </button>
        </CollapsibleTrigger>
        <span className="text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">Win</span> <span className="text-foreground tabular-nums font-semibold">{fmtPct(kpis.winRate)}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">Avg quoted</span> <span className="text-foreground tabular-nums">{fmtMoney(kpis.avgQuoted)}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">Avg margin</span> <span className="text-foreground tabular-nums">{fmtMoney(kpis.avgMargin)}{kpis.avgMarginPct > 0 ? ` · ${fmtPct(kpis.avgMarginPct)}` : ""}</span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">Last quoted</span> <span className="text-foreground tabular-nums">{kpis.lastQuotedDays !== null ? `${kpis.lastQuotedDays}d` : "—"}</span>
        </span>
      </div>
      <CollapsibleContent>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-11 gap-2">
          <Kpi label="Exact" value={String(kpis.exactCount)} accent="amber" />
          <Kpi label="Similar" value={String(kpis.similarCount)} accent="blue" />
          <Kpi label="Customers" value={String(kpis.customersOnLane)} />
          <Kpi label="Pending" value={String(kpis.pendingCount)} />
          <Kpi label="Win rate" value={fmtPct(kpis.winRate)} />
          <Kpi label="Avg quoted" value={fmtMoney(kpis.avgQuoted)} />
          <Kpi label="Avg won" value={fmtMoney(kpis.avgWonQuoted)} />
          <Kpi label="Avg buy" value={fmtMoney(kpis.avgCarrierPaid)} />
          <Kpi label="Avg margin" value={fmtMoney(kpis.avgMargin)} sub={kpis.avgMarginPct > 0 ? fmtPct(kpis.avgMarginPct) : undefined} />
          <Kpi label="Last quoted" value={kpis.lastQuotedDays !== null ? `${kpis.lastQuotedDays}d` : "—"} />
          <Kpi label="Last won" value={kpis.lastWonDays !== null ? `${kpis.lastWonDays}d` : "—"} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TieredMatchSections({
  tieredMatches, tierCounts, query, matchMode,
  onPickQuote, onBroadenDate, onBroadenLookback, onBroadenEquipment, onSwitchToRelaxed,
}: {
  tieredMatches: TierGroup[];
  tierCounts: Record<MatchTier, number>;
  query: SpotSearchQuery;
  matchMode: "strict" | "relaxed";
  onPickQuote: (id: string) => void;
  onBroadenDate: () => void;
  onBroadenLookback: () => void;
  onBroadenEquipment: () => void;
  onSwitchToRelaxed: () => void;
}): JSX.Element {
  const accentMap: Record<TierAccent, { border: string; headerBg: string; count: string; iconColor: string }> = {
    amber: { border: "border-amber-500/40 shadow-[0_0_0_1px_rgba(251,191,36,0.05)]", headerBg: "bg-amber-500/[0.08] dark:bg-amber-500/[0.04]", count: "text-amber-700 dark:text-amber-300", iconColor: "text-amber-600 dark:text-amber-400" },
    blue: { border: "border-blue-500/30", headerBg: "bg-blue-500/[0.06] dark:bg-blue-500/[0.03]", count: "text-blue-700 dark:text-blue-300", iconColor: "text-blue-600 dark:text-blue-400" },
    zinc: { border: "border-border", headerBg: "bg-muted/30", count: "text-foreground", iconColor: "text-muted-foreground" },
    purple: { border: "border-purple-500/30", headerBg: "bg-purple-500/[0.08] dark:bg-purple-500/[0.04]", count: "text-purple-700 dark:text-purple-300", iconColor: "text-purple-600 dark:text-purple-400" },
    teal: { border: "border-teal-500/30", headerBg: "bg-teal-500/[0.08] dark:bg-teal-500/[0.04]", count: "text-teal-700 dark:text-teal-300", iconColor: "text-teal-600 dark:text-teal-400" },
  };
  const iconFor = (key: "award" | "map" | "users" | "truck" | "activity", color: string): JSX.Element => {
    const cls = `h-3.5 w-3.5 ${color}`;
    if (key === "award") return <Award className={cls} />;
    if (key === "map") return <MapPin className={cls} />;
    if (key === "users") return <Users className={cls} />;
    if (key === "truck") return <Truck className={cls} />;
    return <Activity className={cls} />;
  };

  // Smart empty state: no exact match — point to first non-empty tier.
  const exactGroup = tieredMatches.find(g => g.tier === "exact");
  const firstNonEmptyOther = tieredMatches.find(g => g.tier !== "exact");

  // Sections to render: always include the exact tier as its own card so
  // the rep sees the "exact / no exact" answer at a glance, then render the
  // remaining non-empty tiers in display order.
  const sections: { meta: typeof TIER_DISPLAY[number]; group: TierGroup | null }[] = TIER_DISPLAY
    .filter(meta => meta.tier === "exact" || tierCounts[meta.tier] > 0)
    .map(meta => ({ meta, group: tieredMatches.find(g => g.tier === meta.tier) ?? null }));

  return (
    <div className="space-y-3" data-testid="spot-section-tiered-matches">
      <div className="flex items-center gap-2 flex-wrap" data-testid="spot-tier-summary">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Tiered matches</span>
        {TIER_DISPLAY.map(meta => {
          const c = tierCounts[meta.tier] ?? 0;
          const acc = accentMap[meta.accent];
          return (
            <span
              key={meta.tier}
              className={`text-[11px] px-1.5 py-0.5 rounded-[4px] border tabular-nums ${c > 0 ? `${acc.headerBg} ${acc.count} border-current/30` : "bg-card text-muted-foreground border-border"}`}
              title={meta.rule}
              data-testid={`spot-tier-chip-${meta.tier}`}
            >
              {meta.label.split(" ")[0]} <span className="font-semibold">{c}</span>
            </span>
          );
        })}
        {matchMode === "strict" && (
          <span className="text-[10px] text-muted-foreground italic">
            Strict mode — only exact + same-state shown.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {sections.map(({ meta, group }) => {
          const acc = accentMap[meta.accent];
          const items = group?.items ?? group?.quotes ?? [];
          const isExact = meta.tier === "exact";
          const empty = items.length === 0;
          const winPct = group ? Math.round((group.winRate ?? 0) * 100) : 0;
          const avgWon = group?.avgWonQuoted ?? 0;
          const freshness = group?.lastWonDays ?? null;
          const freshnessLabel = freshness == null
            ? "no wins"
            : freshness <= 14 ? "fresh"
            : freshness <= 60 ? "recent"
            : "stale";
          const freshnessClass = freshness == null
            ? "text-muted-foreground"
            : freshness <= 14 ? "text-emerald-700 dark:text-emerald-300 font-medium"
            : freshness <= 60 ? "text-amber-700 dark:text-amber-300 font-medium"
            : "text-muted-foreground";
          return (
            <Card
              key={meta.tier}
              id={`spot-section-tier-${meta.tier}`}
              className={`bg-card rounded-[4px] border ${acc.border} scroll-mt-4`}
              data-testid={`spot-section-tier-${meta.tier}`}
            >
              <CardHeader className={`py-2.5 px-3 flex flex-col gap-1.5 border-b border-border ${acc.headerBg}`}>
                <div className="flex flex-row items-center justify-between">
                  <div className="flex flex-col">
                    <CardTitle className="text-xs uppercase tracking-wider text-foreground flex items-center gap-1.5">
                      {iconFor(meta.icon, acc.iconColor)}{meta.label}
                    </CardTitle>
                    <span className="text-[10px] text-muted-foreground mt-0.5" title={`Why this tier? ${meta.rule}`}>
                      {meta.rule}
                    </span>
                  </div>
                  <span className={`text-[10px] font-semibold tabular-nums ${acc.count}`}>{items.length} shown</span>
                </div>
                {!empty && group && (
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground" data-testid={`spot-tier-kpis-${meta.tier}`}>
                    <span title="Total prior quotes in this tier">
                      <span className="text-muted-foreground">Quotes</span>{" "}
                      <span className="text-foreground tabular-nums">{group.count}</span>
                    </span>
                    <span title="Won / decided">
                      <span className="text-muted-foreground">Win</span>{" "}
                      <span className="text-foreground tabular-nums">{winPct}%</span>
                    </span>
                    <span title="Average quoted amount on won quotes">
                      <span className="text-muted-foreground">Avg won</span>{" "}
                      <span className="text-foreground tabular-nums">{avgWon > 0 ? fmtMoney(avgWon) : "—"}</span>
                    </span>
                    <span title={freshness == null ? "No prior wins" : `${freshness}d since last win`}>
                      <span className="text-muted-foreground">Last win</span>{" "}
                      <span className={`tabular-nums ${freshnessClass}`}>
                        {freshness == null ? "—" : `${freshness}d`}{" "}
                        <span className="text-[9px] uppercase">({freshnessLabel})</span>
                      </span>
                    </span>
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-3 text-xs text-foreground">
                {empty ? (
                  isExact ? (
                    <div className="text-muted-foreground space-y-2" data-testid="spot-tier-empty-exact">
                      <div className="text-foreground font-medium">No exact-lane quotes yet.</div>
                      {firstNonEmptyOther ? (
                        <div className="text-[11px] text-muted-foreground space-y-1.5">
                          <div>
                            Closest tier:{" "}
                            <span className="text-foreground font-semibold">{firstNonEmptyOther.label}</span>
                            {" "}with{" "}
                            <span className="text-amber-700 dark:text-amber-300 font-semibold">{firstNonEmptyOther.count}</span>
                            {" "}prior quote{firstNonEmptyOther.count === 1 ? "" : "s"}.
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const el = document.getElementById(`spot-section-tier-${firstNonEmptyOther.tier}`);
                              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                            }}
                            className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 border border-amber-500/50"
                            data-testid={`button-spot-show-tier-${firstNonEmptyOther.tier}`}
                          >
                            Show {firstNonEmptyOther.label} matches →
                          </button>
                        </div>
                      ) : matchMode === "strict" ? (
                        <div className="text-[11px] text-muted-foreground">
                          No same-state-pair quotes either. Try{" "}
                          <button onClick={onSwitchToRelaxed} className="text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 font-medium underline" data-testid="button-spot-switch-relaxed">
                            switching to Relaxed mode
                          </button>
                          {" "}to also include same-market, reverse, and corridor matches.
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground">
                          No prior quotes anywhere in the tier ladder — this is a fresh corridor for your team.
                        </div>
                      )}
                      <div className="text-[11px] text-muted-foreground">Try broadening:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {query.pickupDate && (
                          <button onClick={onBroadenDate}
                            className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted text-foreground border border-border"
                            data-testid="button-spot-broaden-clear-date">
                            Clear pickup date
                          </button>
                        )}
                        {(!query.lookbackDays || query.lookbackDays < 365) && (
                          <button onClick={onBroadenLookback}
                            className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted text-foreground border border-border"
                            data-testid="button-spot-broaden-lookback">
                            Use all-time history
                          </button>
                        )}
                        {query.equipment && (
                          <button onClick={onBroadenEquipment}
                            className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted text-foreground border border-border"
                            data-testid="button-spot-broaden-equipment">
                            Drop mode filter
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground">No matches in this tier.</div>
                  )
                ) : (
                  <div className="max-h-[280px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground text-[10px] uppercase tracking-wider sticky top-0 bg-card">
                        <tr><th className="text-left py-1">Date</th><th className="text-left">Customer</th><th className="text-left">Lane</th><th>Quoted</th><th>Buy</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {items.map((q: EnrichedQuote) => {
                          const quoted = num(q.quotedAmount);
                          const paid = num(q.carrierPaid);
                          return (
                            <tr key={q.id} onClick={() => onPickQuote(q.id)}
                              className="border-t border-border/60 hover:bg-muted/40 cursor-pointer"
                              data-testid={`spot-quote-row-${q.id}`}>
                              <td className="py-1 text-foreground whitespace-nowrap">{new Date(q.requestDate).toLocaleDateString()}</td>
                              <td className="text-foreground truncate max-w-[120px]">{q.customerName}</td>
                              <td className="text-muted-foreground truncate max-w-[140px] text-[10px]">
                                {q.originCity}, {q.originState} → {q.destCity}, {q.destState}
                              </td>
                              <td className="text-center tabular-nums">{fmtMoney(quoted)}</td>
                              <td className="text-center tabular-nums text-muted-foreground">{paid ? fmtMoney(paid) : "—"}</td>
                              <td className="text-center"><StatusChip status={q.outcomeStatus} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
