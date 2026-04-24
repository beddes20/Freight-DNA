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
import {
  Search, MapPin, Truck, Calendar, AlertTriangle, TrendingUp, TrendingDown, Minus, Award, Users,
  Clock, Activity, X, ChevronRight, ChevronDown, Copy, RefreshCw, SlidersHorizontal,
  DollarSign, Save, Phone, Mail, FileText, ChevronUp, ThumbsDown,
} from "lucide-react";

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
  cityRef, stateRef, onAdvance,
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

  return (
    <div className="flex flex-col gap-1 relative">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1">
        <MapPin className="h-3 w-3" />{label}
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
          className="h-10 w-[200px] bg-zinc-900 border-zinc-700 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
          data-testid={testIdCity}
          autoComplete="off"
        />
        <Input
          ref={stateEl}
          value={value.state}
          onChange={e => onStateChange(e.target.value)}
          onBlur={onStateBlur}
          placeholder="ST"
          className="h-10 w-[60px] bg-zinc-900 border-zinc-700 text-sm text-zinc-100 placeholder:text-zinc-500 uppercase tracking-wider text-center focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
          maxLength={20}
          data-testid={testIdState}
          autoComplete="off"
        />
      </div>
      {visible && (
        <div className="absolute top-full left-0 mt-1 z-30 w-[300px] rounded-[4px] border border-zinc-700 bg-zinc-950 shadow-2xl max-h-[320px] overflow-y-auto" data-testid={`autocomplete-${kind}`}>
          {historyList.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-amber-300/80 border-b border-zinc-800 bg-zinc-900">
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
                    className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs border-l-2 ${idx === activeIdx ? "bg-zinc-800 border-amber-400" : "border-transparent hover:bg-zinc-900"}`}
                    data-testid={`autocomplete-item-${kind}-${it.city}-${it.state}`}
                  >
                    <span className="text-zinc-100 flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-amber-400/70" />{it.city}, <span className="text-zinc-400">{it.state}</span>
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
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 border-y border-zinc-800 bg-zinc-900">
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
                    className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs border-l-2 ${idx === activeIdx ? "bg-zinc-800 border-amber-400" : "border-transparent hover:bg-zinc-900"}`}
                    data-testid={`autocomplete-item-${kind}-${it.city}-${it.state}`}
                  >
                    <span className="text-zinc-100 flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-zinc-500" />{it.city}, <span className="text-zinc-400">{it.state}</span>
                    </span>
                    <span className="text-[10px] text-zinc-500 tabular-nums">city</span>
                  </button>
                );
              })}
            </>
          )}
          {showNoMatches && (
            <div className="px-3 py-2.5 text-[11px] text-zinc-400" data-testid={`autocomplete-empty-${kind}`}>
              No matches — press <kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[9px] mx-0.5">Enter</kbd> to use as-is
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
    <Card className="bg-zinc-900 border-zinc-800 rounded-[4px]" data-testid={testId}>
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800">
        <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
          {icon}{title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="p-3 text-xs text-zinc-200">{children}</CardContent>
    </Card>
  );
}

function ConfidenceDot({ confidence }: { confidence: string }): JSX.Element {
  const map: Record<string, string> = {
    high: "bg-emerald-400", medium: "bg-amber-400",
    low: "bg-orange-400", insufficient_history: "bg-zinc-500", no_benchmark: "bg-zinc-500",
  };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${map[confidence] ?? "bg-zinc-500"}`} />;
}

export function SpotQuoteSearch({ customers, onApplyLaneFilter, onPickQuote, onPickCustomer }: {
  customers: Customer[];
  onApplyLaneFilter: (laneSearch: string) => void;
  onPickQuote: (id: string) => void;
  onPickCustomer: (id: string) => void;
}): JSX.Element {
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

  const submit = (): void => {
    if (!canSearch) return;
    const lb = parseInt(lookbackDays, 10);
    const q: SpotSearchQuery = {
      pickupCity: pickup.city.trim(),
      pickupState: pickup.state.trim().toUpperCase(),
      deliveryCity: delivery.city.trim(),
      deliveryState: delivery.state.trim().toUpperCase(),
      equipment: equipment === "Any" ? undefined : equipment,
      pickupDate: pickupDate || undefined,
      customerId: customerId || undefined,
      lookbackDays: lb > 0 ? lb : undefined,
      exactOnly: exactOnly || undefined,
      includeSimilar: !includeSimilar ? false : undefined,
      matchMode,
    };
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
  };

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
    <div className="space-y-4" data-testid="spot-quote-search-root">
      {/* Sticky search bar — full form OR compact pinned strip */}
      {hasResults ? (
        <div
          className="sticky top-[124px] z-20 -mx-6 px-6 py-2 bg-[#0A0A0A]/95 backdrop-blur border-y border-zinc-800 shadow-md"
          data-testid="spot-quote-search-bar-compact"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Searching</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100 tabular-nums">
              <MapPin className="h-3.5 w-3.5 text-zinc-500" />
              {activeQuery!.pickupCity}, {activeQuery!.pickupState}
              <ChevronRight className="h-3.5 w-3.5 text-amber-400" />
              {activeQuery!.deliveryCity}, {activeQuery!.deliveryState}
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded-[4px] bg-zinc-800 text-zinc-200 border border-zinc-700 inline-flex items-center gap-1">
              <Truck className="h-3 w-3 text-zinc-400" />{activeQuery!.equipment ?? "Any"}
            </span>
            {activeQuery!.pickupDate && (
              <span className="text-[11px] px-2 py-0.5 rounded-[4px] bg-zinc-800 text-zinc-200 border border-zinc-700 inline-flex items-center gap-1">
                <Calendar className="h-3 w-3 text-zinc-400" />{activeQuery!.pickupDate}
              </span>
            )}
            {data?.resolvedCustomer && (
              <span className="text-[11px] px-2 py-0.5 rounded-[4px] bg-amber-500/10 text-amber-300 border border-amber-500/30 inline-flex items-center gap-1">
                <Users className="h-3 w-3" />{data.resolvedCustomer.name}
              </span>
            )}
            {(activeQuery!.lookbackDays || activeQuery!.exactOnly || activeQuery!.includeSimilar === false) && (
              <span className="text-[10px] text-zinc-500">
                {activeQuery!.lookbackDays ? `· last ${activeQuery!.lookbackDays}d` : ""}
                {activeQuery!.exactOnly ? " · exact only" : activeQuery!.includeSimilar === false ? " · no similar" : ""}
              </span>
            )}
            {searchedAt && (
              <span className="text-[10px] text-zinc-500 ml-1">
                · {searchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={editSearch}
                className="h-7 border-amber-500/40 hover:bg-amber-500/10 text-amber-300 text-[11px] px-2.5"
                data-testid="button-spot-edit">
                <SlidersHorizontal className="h-3 w-3 mr-1" /> Edit search
              </Button>
              <Button size="sm" variant="ghost" onClick={rerunSearch}
                className="h-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 text-[11px] px-2"
                data-testid="button-spot-rerun">
                <RefreshCw className={`h-3 w-3 mr-1 ${result.isFetching ? "animate-spin" : ""}`} /> Rerun
              </Button>
              <Button size="sm" variant="ghost" onClick={copyLane}
                className="h-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 text-[11px] px-2"
                data-testid="button-spot-copy">
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll}
                className="h-7 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 text-[11px] px-2"
                data-testid="button-spot-clear">
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            </div>
          </div>
        </div>
      ) : (
      <div
        className="sticky top-[124px] z-20 -mx-6 px-6 py-4 bg-gradient-to-b from-[#0A0A0A] to-[#0A0A0A]/95 backdrop-blur border-y border-zinc-800 shadow-lg"
        onKeyDown={onKeyDown}
        data-testid="spot-quote-search-bar"
      >
        <div className="flex items-center gap-2 mb-3">
          <div className="h-6 w-6 rounded-[4px] bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
            <Search className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <span className="text-base font-semibold text-zinc-100 tracking-tight">Spot Quote Search</span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Pickup → Delivery · Mode · Date</span>
          <span className="ml-auto text-[10px] text-zinc-500 hidden md:inline">
            Press <kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[9px]">Enter</kbd> to search · <kbd className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 text-[9px]">Esc</kbd> to clear
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <LaneInput label="Pickup" value={pickup} onChange={setPickup} kind="origin"
            testIdCity="input-spot-pickup-city" testIdState="input-spot-pickup-state"
            autoOpen={openOrigin} setAutoOpen={setOpenOrigin}
            cityRef={pickupCityRef} stateRef={pickupStateRef}
            onAdvance={() => deliveryCityRef.current?.focus()} />
          <LaneInput label="Delivery" value={delivery} onChange={setDelivery} kind="dest"
            testIdCity="input-spot-delivery-city" testIdState="input-spot-delivery-state"
            autoOpen={openDest} setAutoOpen={setOpenDest}
            cityRef={deliveryCityRef} stateRef={deliveryStateRef}
            onAdvance={() => dateRef.current?.focus()} />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1"><Truck className="h-3 w-3" /> Mode</span>
            <Select value={equipment} onValueChange={setEquipment}>
              <SelectTrigger className="h-10 w-[130px] bg-zinc-900 border-zinc-700 text-sm text-zinc-100 [&>span]:text-zinc-100" data-testid="select-spot-equipment"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EQUIPMENT_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1"><Calendar className="h-3 w-3" /> Pickup date</span>
            <Input ref={dateRef} type="date" value={pickupDate} onChange={e => setPickupDate(e.target.value)}
              className="h-10 w-[160px] bg-zinc-900 border-zinc-700 text-sm text-zinc-100 placeholder:text-zinc-500 [color-scheme:dark] focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
              data-testid="input-spot-pickup-date" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1"><Users className="h-3 w-3" /> Customer (optional)</span>
            <Select value={customerId || "_any"} onValueChange={v => setCustomerId(v === "_any" ? "" : v)}>
              <SelectTrigger className="h-10 w-[220px] bg-zinc-900 border-zinc-700 text-sm text-zinc-100 [&>span]:text-zinc-100 data-[placeholder]:text-zinc-500" data-testid="select-spot-customer"><SelectValue placeholder="Any customer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_any">Any customer</SelectItem>
                {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button
            ref={searchBtnRef}
            onClick={submit}
            disabled={!canSearch || result.isFetching}
            className="h-10 bg-[#FFC333] hover:bg-amber-400 text-zinc-950 font-semibold rounded-[4px] px-5 shadow-sm shadow-amber-500/20"
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
              className="text-[11px] uppercase tracking-wider text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1"
              data-testid="button-spot-advanced-toggle"
            >
              <SlidersHorizontal className="h-3 w-3" />
              Advanced Details
              <ChevronDown className={`h-3 w-3 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2" data-testid="spot-advanced-details">
            <div className="rounded-[4px] border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
              {/* Search behavior toggles */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">Lookback</span>
                  <Select value={lookbackDays} onValueChange={setLookbackDays}>
                    <SelectTrigger className="h-8 w-[150px] bg-zinc-900 border-zinc-700 text-xs text-zinc-100 [&>span]:text-zinc-100" data-testid="select-spot-lookback"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LOOKBACK_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-exact-only" checked={exactOnly} onCheckedChange={(v) => { setExactOnly(v); if (v) setIncludeSimilar(false); }} data-testid="switch-spot-exact-only" />
                  <Label htmlFor="spot-exact-only" className="text-xs text-zinc-300">Exact matches only</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-include-similar" checked={includeSimilar} onCheckedChange={(v) => { setIncludeSimilar(v); if (v) setExactOnly(false); }} data-testid="switch-spot-include-similar" />
                  <Label htmlFor="spot-include-similar" className="text-xs text-zinc-300">Include similar lanes</Label>
                </div>
                {/* Task #514 — Tiered match-mode segmented toggle */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">Match mode</span>
                  <div className="inline-flex rounded-[4px] border border-zinc-700 bg-zinc-900 overflow-hidden" role="group" data-testid="segmented-spot-match-mode">
                    <button
                      type="button"
                      onClick={() => { setMatchMode("relaxed"); setActiveQuery(q => q ? { ...q, matchMode: "relaxed" } : q); }}
                      className={`px-2.5 h-8 text-[11px] font-medium transition ${matchMode === "relaxed" ? "bg-amber-500/20 text-amber-200 border-r border-amber-500/30" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border-r border-zinc-700"}`}
                      data-testid="button-spot-match-mode-relaxed"
                      title="Walk the full ladder: exact → market → state → reverse → corridor"
                    >
                      Relaxed
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMatchMode("strict"); setActiveQuery(q => q ? { ...q, matchMode: "strict" } : q); }}
                      className={`px-2.5 h-8 text-[11px] font-medium transition ${matchMode === "strict" ? "bg-amber-500/20 text-amber-200" : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"}`}
                      data-testid="button-spot-match-mode-strict"
                      title="Only exact lane and same-state-pair matches"
                    >
                      Strict
                    </button>
                  </div>
                </div>
              </div>

              {/* Freight qualification (informational; tags the search context) */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 pt-2 border-t border-zinc-800">
                <AdvField label="Weight (lbs)">
                  <Input value={adv.weight ?? ""} onChange={e => setAdv(a => ({ ...a, weight: e.target.value }))}
                    placeholder="e.g. 42000" className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="input-spot-weight" />
                </AdvField>
                <AdvField label="Commodity">
                  <Input value={adv.commodity ?? ""} onChange={e => setAdv(a => ({ ...a, commodity: e.target.value }))}
                    placeholder="e.g. Steel coils" className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="input-spot-commodity" />
                </AdvField>
                <AdvField label="Pallets">
                  <Input value={adv.pallets ?? ""} onChange={e => setAdv(a => ({ ...a, pallets: e.target.value }))}
                    placeholder="e.g. 26" className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="input-spot-pallets" />
                </AdvField>
                <AdvField label="TL type">
                  <Select value={adv.truckloadType ?? "_unset"} onValueChange={v => setAdv(a => ({ ...a, truckloadType: v === "_unset" ? undefined : v }))}>
                    <SelectTrigger className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="select-spot-tl-type"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_unset">—</SelectItem>
                      {TRUCKLOAD_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </AdvField>
                <AdvField label="Special handling">
                  <Input value={adv.specialHandling ?? ""} onChange={e => setAdv(a => ({ ...a, specialHandling: e.target.value }))}
                    placeholder="Tarps, straps…" className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="input-spot-special" />
                </AdvField>
                <AdvField label="Access notes">
                  <Input value={adv.accessNotes ?? ""} onChange={e => setAdv(a => ({ ...a, accessNotes: e.target.value }))}
                    placeholder="Residential, jobsite…" className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500" data-testid="input-spot-access" />
                </AdvField>
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-zinc-800">
                <div className="flex items-center gap-2">
                  <Switch id="spot-hazmat" checked={!!adv.hazmat} onCheckedChange={(v) => setAdv(a => ({ ...a, hazmat: v }))} data-testid="switch-spot-hazmat" />
                  <Label htmlFor="spot-hazmat" className="text-xs text-zinc-300">Hazmat</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-temp" checked={!!adv.tempRequired} onCheckedChange={(v) => setAdv(a => ({ ...a, tempRequired: v }))} data-testid="switch-spot-temp" />
                  <Label htmlFor="spot-temp" className="text-xs text-zinc-300">Temp controlled</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="spot-appt" checked={!!adv.appointmentRequired} onCheckedChange={(v) => setAdv(a => ({ ...a, appointmentRequired: v }))} data-testid="switch-spot-appt" />
                  <Label htmlFor="spot-appt" className="text-xs text-zinc-300">Appointment required</Label>
                </div>
                <div className="ml-auto text-[10px] text-zinc-500">
                  Qualification details tag the search context but do not yet filter historical records.
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {recents.length > 0 && !activeQuery && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Recent:</span>
            {recents.map(r => (
              <button key={r.savedAt} onClick={() => applyRecent(r)}
                className="text-[11px] px-2 py-0.5 rounded-[4px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
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
        <Card className="bg-zinc-900/40 border-zinc-800 border-dashed rounded-[4px]" data-testid="spot-empty-state">
          <CardContent className="p-10 text-center text-zinc-400 text-sm">
            <div className="mx-auto h-12 w-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <Search className="h-5 w-5 text-zinc-600" />
            </div>
            <div className="text-zinc-200 font-semibold mb-1">Start with a lane</div>
            <div className="text-xs text-zinc-500 max-w-[480px] mx-auto leading-relaxed">
              Enter pickup and delivery to see exact-match history, similar lanes, customer signals, carrier buy-history, internal rep variance, freight attractiveness and pricing guidance — all in one view.
            </div>
          </CardContent>
        </Card>
      )}

      {activeQuery && result.isError && !result.isLoading && (
        <Card className="bg-red-500/10 border-red-500/30 rounded-[4px]" data-testid="spot-results-error">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-300 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-red-200">Spot search failed</div>
              <div className="text-xs text-red-300/80 mt-0.5">
                {(result.error as Error)?.message ?? "We couldn't load results for this lane. Try again, or adjust the search and rerun."}
              </div>
            </div>
            <Button size="sm" variant="outline"
              onClick={() => void result.refetch()}
              className="h-8 border-red-500/40 hover:bg-red-500/20 text-red-200 text-xs"
              data-testid="button-spot-error-retry">
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {activeQuery && result.isLoading && (
        <div className="space-y-3" data-testid="spot-results-loading">
          {/* Summary strip */}
          <Skeleton className="h-12 w-full bg-zinc-900 rounded-[4px]" />
          {/* Collapsed lane-stats bar */}
          <Skeleton className="h-8 w-full bg-zinc-900 rounded-[4px]" />
          {/* 4-zone grid mirror */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="spot-results-loading-zones">
            <Skeleton className="h-72 w-full bg-zinc-900 rounded-[4px]" />
            <Skeleton className="h-72 w-full bg-zinc-900 rounded-[4px]" />
            <Skeleton className="h-64 w-full bg-zinc-900 rounded-[4px]" />
            <Skeleton className="h-64 w-full bg-zinc-900 rounded-[4px]" />
          </div>
          {/* Below-fold sections */}
          <Skeleton className="h-40 w-full bg-zinc-900 rounded-[4px]" />
        </div>
      )}

      {activeQuery && data && (
        <div className="space-y-3" data-testid="spot-results">
          {/* 1. Result summary strip */}
          <div className="rounded-[4px] border border-zinc-800 bg-gradient-to-r from-zinc-900 to-zinc-900/60 px-3 py-2 flex items-center gap-4 flex-wrap" data-testid="spot-section-summary">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Found</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold tabular-nums">{data.kpis.exactCount} exact</span>
              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/30 font-semibold tabular-nums">{data.kpis.similarCount} similar</span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-300 tabular-nums">{data.kpis.customersOnLane} customer{data.kpis.customersOnLane === 1 ? "" : "s"}</span>
              {data.kpis.pendingCount > 0 && (
                <>
                  <span className="text-zinc-500">·</span>
                  <span className="text-amber-300 tabular-nums">{data.kpis.pendingCount} pending</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Win rate</span>
              <span className="text-zinc-100 font-semibold tabular-nums">{fmtPct(data.kpis.winRate)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <KpiBadgeInline value={data.kpis.confidence} freshness={data.kpis.freshnessLabel} />
            </div>
            {data.alerts.length > 0 && (
              <button type="button"
                onClick={() => document.querySelector('[data-testid="spot-section-alerts"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="text-[11px] inline-flex items-center gap-1 text-orange-300 hover:text-orange-200" data-testid="link-spot-summary-alerts">
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
                className="text-[11px] px-1.5 py-0.5 rounded-[4px] bg-teal-500/10 text-teal-300 border border-teal-500/30 inline-flex items-center gap-1 hover:bg-teal-500/20 cursor-pointer"
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
                  <span className="ml-1 text-[10px] px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30" data-testid="chip-spot-corridor-seasonality">seasonal</span>
                )}
                {data.corridorPattern.responsibleContact && (
                  <span
                    className="ml-1 text-[10px] px-1 rounded bg-zinc-800 text-zinc-300 border border-zinc-700"
                    data-testid="chip-spot-corridor-responsible"
                  >
                    {data.corridorPattern.responsibleContact.contactName.split(/\s+/)[0]}
                  </span>
                )}
              </a>
            )}
            {!data.marketStatus.available && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-[4px] bg-zinc-800 text-zinc-400 border border-zinc-700 inline-flex items-center gap-1" data-testid="chip-spot-market-unavailable">
                <AlertTriangle className="h-3 w-3" /> Market data unavailable
              </span>
            )}
            <div className="ml-auto">
              <Button size="sm" variant="outline" onClick={() => onApplyLaneFilter(`${data.query.pickupCity} ${data.query.deliveryCity}`)}
                className="h-7 border-zinc-700 hover:bg-zinc-800 text-[11px] px-2.5" data-testid="button-spot-apply-filter">
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
              <CarrierShortlistCard outreach={data.carrierOutreach} />
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
              <span className="text-[10px] text-amber-300 inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                {data.resolvedCustomer.name} highlighted
              </span>
            ) : undefined}>
            {data.customerPanel.length === 0 ? (
              <div className="text-zinc-500 text-center py-4">
                <Users className="h-5 w-5 mx-auto mb-1.5 text-zinc-700" />
                No customer history on this lane yet — this lane is a clean-slate opportunity.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
                  <tr><th className="text-left py-1">Customer</th><th>Quotes</th><th>Win rate</th><th>Avg quoted</th><th>Avg margin</th><th>Last</th><th className="text-left">Top carriers</th></tr>
                </thead>
                <tbody>
                  {data.customerPanel.map(c => {
                    const isResolved = data.resolvedCustomer?.id === c.customerId;
                    return (
                      <tr key={c.customerId}
                        className={`border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer ${isResolved ? "bg-amber-500/[0.06]" : ""}`}
                        onClick={() => onPickCustomer(c.customerId)} data-testid={`spot-customer-row-${c.customerId}`}>
                        <td className={`py-1 font-medium ${isResolved ? "text-amber-200 border-l-2 border-amber-400 pl-2" : "text-zinc-100"}`}>
                          {c.customerName}
                          {isResolved && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-amber-400">selected</span>}
                        </td>
                        <td className="text-center tabular-nums">{c.quotes}</td>
                        <td className="text-center tabular-nums">{fmtPct(c.winRate)}</td>
                        <td className="text-center tabular-nums">{fmtMoney(c.avgQuoted)}</td>
                        <td className="text-center tabular-nums">{fmtMoney(c.avgMargin)}</td>
                        <td className="text-center tabular-nums text-zinc-400">{c.lastQuotedDays !== null ? `${c.lastQuotedDays}d` : "—"}</td>
                        <td className="text-zinc-400 text-[10px]">{c.topCarriers.map(t => `${t.name} (${t.loads})`).join(", ") || "—"}</td>
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
                <div className="text-zinc-500">No prior outcomes.</div>
              ) : (
                <div className="space-y-1.5">
                  {data.outcomeBreakdown.map((o, i) => (
                    <div key={i} className="flex items-center gap-2" data-testid={`spot-outcome-${i}`}>
                      <span className="text-zinc-200 flex-1 truncate">{o.reason}</span>
                      <div className="w-24 h-1.5 bg-zinc-800 rounded-[4px] overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, o.pct)}%` }} />
                      </div>
                      <span className="text-zinc-400 tabular-nums w-10 text-right">{o.count}</span>
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
                <div className="text-zinc-500">No rep history on this lane.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
                    <tr><th className="text-left">Rep</th><th>Quotes</th><th>Avg quoted</th><th>Win rate</th><th>Avg margin</th></tr>
                  </thead>
                  <tbody>
                    {data.internalVariance.map(v => (
                      <tr key={v.rep} className="border-t border-zinc-800/60" data-testid={`spot-variance-${v.rep}`}>
                        <td className="py-1 text-zinc-100">{v.rep}</td>
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
                <div className="flex flex-col items-center justify-center w-24 h-24 rounded-full border-4 border-amber-500/40 bg-zinc-950">
                  <span className="text-2xl font-bold text-amber-400 tabular-nums" data-testid="text-spot-attract-score">{data.attractiveness.score}</span>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">score</span>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-zinc-100" data-testid="text-spot-attract-label">{data.attractiveness.label}</div>
                  <div className="text-[11px] text-zinc-400 mt-1">{data.attractiveness.rationale}</div>
                  <div className="text-[10px] text-zinc-500 mt-2">
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
              <div className="text-zinc-500 flex items-center gap-2"><Clock className="h-3 w-3" /> No active alerts on this lane.</div>
            ) : (
              <div className="space-y-2">
                {data.alerts.map(a => (
                  <div key={a.id}
                    className={`rounded-[4px] p-2 border ${
                      a.severity === "high" ? "bg-red-500/10 border-red-500/30"
                      : a.severity === "medium" ? "bg-amber-500/10 border-amber-500/30"
                      : "bg-zinc-800/40 border-zinc-700"}`}
                    data-testid={`spot-alert-${a.id}`}>
                    <div className="text-[12px] font-semibold text-zinc-100">{a.title}</div>
                    <div className="text-[11px] text-zinc-400 mt-0.5">{a.detail}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "amber" | "blue" }): JSX.Element {
  const accentCls =
    accent === "amber" ? "border-amber-500/30 bg-amber-500/[0.04]" :
    accent === "blue" ? "border-blue-500/30 bg-blue-500/[0.04]" :
    "border-zinc-800 bg-zinc-900";
  const valueCls =
    accent === "amber" ? "text-amber-300" :
    accent === "blue" ? "text-blue-300" :
    "text-zinc-100";
  return (
    <div className={`rounded-[4px] border p-2 ${accentCls}`} data-testid={`spot-kpi-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function KpiBadgeInline({ value, freshness }: { value: string; freshness?: string | null }): JSX.Element {
  const tier = (value || "insufficient").toLowerCase();
  const tone =
    tier === "high" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
    tier === "medium" ? "bg-amber-500/15 text-amber-300 border-amber-500/30" :
    tier === "low" ? "bg-orange-500/15 text-orange-300 border-orange-500/30" :
    "bg-zinc-700/30 text-zinc-300 border-zinc-600/40";
  const freshTone =
    freshness === "fresh" ? "text-emerald-400" :
    freshness === "recent" ? "text-amber-400" :
    freshness === "stale" ? "text-orange-400" :
    "text-zinc-500";
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="spot-confidence-inline">
      <span className={`px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold border capitalize ${tone}`}>
        {value ? value.replace(/_/g, " ") : "—"}
      </span>
      {freshness && <span className={`text-[10px] capitalize ${freshTone}`}>· {freshness}</span>}
    </span>
  );
}

function KpiBadge({ label, value, freshness }: { label: string; value: string; freshness?: string | null }): JSX.Element {
  const tier = (value || "insufficient").toLowerCase();
  const tone =
    tier === "high" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
    tier === "medium" ? "bg-amber-500/15 text-amber-300 border-amber-500/30" :
    tier === "low" ? "bg-orange-500/15 text-orange-300 border-orange-500/30" :
    "bg-zinc-700/30 text-zinc-300 border-zinc-600/40";
  const freshTone =
    freshness === "fresh" ? "text-emerald-400" :
    freshness === "recent" ? "text-amber-400" :
    freshness === "stale" ? "text-orange-400" :
    "text-zinc-500";
  return (
    <div className="rounded-[4px] bg-zinc-900 border border-zinc-800 p-2" data-testid="spot-kpi-confidence">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`inline-flex items-center mt-0.5 px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold border ${tone}`}>
        {value || "—"}
      </div>
      {freshness && <div className={`text-[10px] mt-0.5 capitalize ${freshTone}`}>{freshness}</div>}
    </div>
  );
}

function AdvField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function StatusChip({ status }: { status: string }): JSX.Element {
  const colorMap: Record<string, string> = {
    won: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    won_low_margin: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    expired: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
    no_response: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  };
  const cls = colorMap[status] ?? "bg-red-500/15 text-red-300 border-red-500/30";
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>{status.replace(/_/g, " ")}</span>;
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
    "border-zinc-800";
  const headerBg =
    accent === "amber" ? "bg-amber-500/[0.04]" :
    accent === "blue" ? "bg-blue-500/[0.03]" :
    "";
  const countTone =
    accent === "amber" ? "text-amber-300" :
    accent === "blue" ? "text-blue-300" :
    "text-zinc-400";
  return (
    <Card className={`bg-zinc-900 rounded-[4px] border ${accentBorder}`} data-testid={testId}>
      <CardHeader className={`py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800 ${headerBg}`}>
        <div className="flex flex-col">
          <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
            {icon}{title}
          </CardTitle>
          {subtitle && <span className="text-[10px] text-zinc-500 mt-0.5">{subtitle}</span>}
        </div>
        <span className={`text-[10px] font-semibold tabular-nums ${countTone}`}>{quotes.length} shown</span>
      </CardHeader>
      <CardContent className="p-3 text-xs text-zinc-200">
        {quotes.length === 0 ? (
          emptyNode
        ) : (
          <div className="max-h-[280px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-500 text-[10px] uppercase tracking-wider sticky top-0 bg-zinc-900">
                <tr><th className="text-left py-1">Date</th><th className="text-left">Customer</th><th>Quoted</th><th>Buy</th><th>Status</th></tr>
              </thead>
              <tbody>
                {quotes.map(q => {
                  const quoted = num(q.quotedAmount);
                  const paid = num(q.carrierPaid);
                  return (
                    <tr key={q.id} onClick={() => onPickQuote(q.id)}
                      className="border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer"
                      data-testid={`spot-quote-row-${q.id}`}>
                      <td className="py-1 text-zinc-300">{new Date(q.requestDate).toLocaleDateString()}</td>
                      <td className="text-zinc-100 truncate max-w-[140px]">{q.customerName}</td>
                      <td className="text-center tabular-nums">{fmtMoney(quoted)}</td>
                      <td className="text-center tabular-nums text-zinc-400">{paid ? fmtMoney(paid) : "—"}</td>
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
 * Task #515 — Pricing guidance band. Shows the TRAC market band as the
 * primary suggested range when available, with the rep's internal
 * P25-P75 won-quote band displayed underneath as a calibration line.
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
    <div className="rounded-[4px] border border-amber-500/30 bg-gradient-to-br from-amber-500/[0.08] via-zinc-900 to-zinc-900 p-4" data-testid="spot-section-guidance">
      <div className="flex items-start gap-6 flex-wrap">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-amber-300/80 font-medium flex items-center gap-1">
            <Activity className="h-3 w-3" /> Suggested quote range
            {isTrac && (
              <span className="ml-1 text-[9px] px-1 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" data-testid="badge-spot-band-trac">TRAC</span>
            )}
          </span>
          <span className="text-3xl font-bold text-amber-400 tabular-nums leading-tight mt-0.5" data-testid="text-spot-guidance-range">
            {guidance.suggestedLow !== null && guidance.suggestedHigh !== null
              ? `${fmtMoney(guidance.suggestedLow)} – ${fmtMoney(guidance.suggestedHigh)}`
              : "—"}
          </span>
          <span className="text-[10px] text-zinc-500 mt-0.5 capitalize">
            Source: {guidance.benchmarkSource.replace(/_/g, " ")}
          </span>
        </div>
        {guidance.benchmark !== null && (
          <div className="flex flex-col border-l border-zinc-800 pl-6">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">{isTrac ? "TRAC mid" : "SONAR benchmark"}</span>
            <span className="text-xl text-zinc-100 tabular-nums font-semibold mt-0.5 flex items-center gap-1.5">
              {fmtMoney(guidance.benchmark)}
              {market?.forecastDirection === "up" && <TrendingUp className="h-4 w-4 text-rose-400" data-testid="icon-spot-forecast-up" aria-label="Forecast trending up" />}
              {market?.forecastDirection === "down" && <TrendingDown className="h-4 w-4 text-emerald-400" data-testid="icon-spot-forecast-down" aria-label="Forecast trending down" />}
              {market?.forecastDirection === "flat" && <Minus className="h-4 w-4 text-zinc-500" data-testid="icon-spot-forecast-flat" aria-label="Forecast flat" />}
            </span>
            <span className="text-[10px] text-zinc-400 mt-0.5" data-testid="text-spot-capacity-outlook">
              {market?.capacityOutlook ?? "market reference"}
            </span>
          </div>
        )}
        <div className="flex flex-col border-l border-zinc-800 pl-6">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">Confidence</span>
          <div className="mt-0.5">
            <KpiBadgeInline value={guidance.confidence} freshness={freshnessLabel} />
          </div>
        </div>
        <div className="flex-1 min-w-[260px] text-[12px] text-zinc-300 leading-relaxed border-l border-zinc-800 pl-6">
          {guidance.message}
          {!marketStatus.available && marketStatus.reason && (
            <div className="mt-1 text-[10px] text-zinc-500" data-testid="text-spot-market-reason">
              Market data unavailable: {marketStatus.reason}
            </div>
          )}
        </div>
      </div>
      {(cal || (isTrac && market)) && (
        <div className="mt-3 pt-3 border-t border-zinc-800 grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]" data-testid="spot-section-calibration">
          {cal && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Internal calibration</span>
              <span className="text-zinc-200 tabular-nums" data-testid="text-spot-calibration-band">
                {cal.suggestedLow !== null && cal.suggestedHigh !== null
                  ? `${fmtMoney(cal.suggestedLow)} – ${fmtMoney(cal.suggestedHigh)}`
                  : "—"}
              </span>
              <span className="text-[10px] text-zinc-500">{cal.note}</span>
            </div>
          )}
          {market?.rpm?.mid != null && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">TRAC RPM (low / mid / high)</span>
              <span className="text-zinc-200 tabular-nums">
                {market.rpm.low?.toFixed(2) ?? "—"} / {market.rpm.mid.toFixed(2)} / {market.rpm.high?.toFixed(2) ?? "—"}
              </span>
              <span className="text-[10px] text-zinc-500">
                {market.miles ? `${market.miles.toLocaleString()} mi` : ""}{market.contractRpm != null ? ` · contract $${market.contractRpm.toFixed(2)}` : ""}
              </span>
            </div>
          )}
          {market && (market.avgRpm30d != null || market.forecast7dRpm != null) && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Trend</span>
              <span className="text-zinc-200 tabular-nums">
                30d {market.avgRpm30d?.toFixed(2) ?? "—"} · 90d {market.avgRpm90d?.toFixed(2) ?? "—"}
              </span>
              <span className="text-[10px] text-zinc-500">
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
 * Task #515 — Lane Traffic card. Shows aggregate load_fact volume
 * and the top carriers actually moving freight on this state-state lane.
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
      <div className="text-[10px] text-zinc-500 mb-1" data-testid="spot-traffic-window">
        Window: last {traffic.lookbackDays} days
      </div>
      <div className="flex items-center gap-2 text-[10px] text-zinc-500 mb-2" data-testid="spot-traffic-tier-breakdown">
        <span className="uppercase tracking-wider">Match tiers:</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Exact {tb.exact}</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-amber-500/10 text-amber-300 border border-amber-500/20">Same market {tb.sameMarket}</span>
        <span className="px-1.5 py-0.5 rounded-[3px] bg-zinc-800 text-zinc-400 border border-zinc-700">Same state {tb.sameState}</span>
      </div>
      {traffic.topCarriers.length === 0 ? (
        <div className="text-zinc-500 text-xs">No realized loads on this lane in the last {traffic.lookbackDays} days.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
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
              <tr key={`${c.name}-${i}`} className="border-t border-zinc-800/60" data-testid={`row-spot-traffic-carrier-${i}`}>
                <td className="py-1 text-zinc-100">{c.name}</td>
                <td className="text-right tabular-nums text-zinc-300">{c.loads90d.toLocaleString()} / {c.loads30d.toLocaleString()}</td>
                <td className="text-right tabular-nums text-zinc-300">{c.lastBuyRate != null ? fmtMoney(c.lastBuyRate) : "—"}</td>
                <td className="text-right tabular-nums text-zinc-300">{c.marginPct.toFixed(1)}%</td>
                <td className="text-right tabular-nums text-zinc-300">
                  {c.reliabilityScore != null
                    ? <span title={c.reliabilityTier ?? ""}>{c.reliabilityScore.toFixed(0)}{c.reliabilityTier ? ` · ${c.reliabilityTier}` : ""}</span>
                    : <span className="text-zinc-600">—</span>}
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
 * Task #515 — Carrier Outreach List. Replaces SpotCarrierHistory.
 * Surfaces top 25 carriers from carrier_lane_fit ⨝ scorecard ⨝ rolodex,
 * with a "call/email" affordance and an in-rolodex flag.
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
        <div className="text-zinc-500">No fit carriers found for this lane.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
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
              <tr key={`${c.carrierId ?? c.name}-${i}`} className={`border-t border-zinc-800/60 ${c.doNotUse ? "opacity-50" : ""}`} data-testid={`row-spot-outreach-${i}`}>
                <td className="py-1 text-zinc-100">
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
                <td className="text-right tabular-nums text-zinc-300">
                  <span title={`Composite rank: ${c.rankScore.toFixed(0)} (fit ${c.fitScore.toFixed(0)} · reli ${c.performanceScore.toFixed(0)})`}>
                    {c.rankScore.toFixed(0)} <span className="text-zinc-500">({c.fitScore.toFixed(0)}/{c.performanceScore.toFixed(0)})</span>
                  </span>
                </td>
                <td className="text-right tabular-nums text-zinc-300">{c.loads90d} / {c.exactLaneRuns}</td>
                <td className="text-right tabular-nums text-zinc-300">{c.marginPct.toFixed(1)}%</td>
                <td className="text-right tabular-nums text-zinc-300" data-testid={`spot-outreach-ontime-${i}`}>
                  {c.onTimePct != null ? `${c.onTimePct.toFixed(0)}%` : <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-right tabular-nums text-zinc-300" data-testid={`spot-outreach-lastrate-${i}`}>
                  {c.lastRatePaid != null ? (
                    <span title={c.lastRatePaidAt ? new Date(c.lastRatePaidAt).toLocaleDateString() : undefined}>
                      ${c.lastRatePaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  ) : <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-[10px]" data-testid={`spot-outreach-presence-${i}`}>
                  {c.presence === "active" && <span className="px-1.5 py-0.5 rounded-[3px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active</span>}
                  {c.presence === "known" && <span className="px-1.5 py-0.5 rounded-[3px] bg-blue-500/15 text-blue-300 border border-blue-500/30 inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-blue-400" />Known</span>}
                  {c.presence === "cold" && <span className="px-1.5 py-0.5 rounded-[3px] bg-zinc-800 text-zinc-500 border border-zinc-700 inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />Cold</span>}
                </td>
                <td className="text-zinc-400 text-[10px]">
                  <div className="flex items-center gap-2">
                    {c.primaryEmail && (
                      <a href={`mailto:${c.primaryEmail}`} className="text-amber-300 hover:text-amber-200 underline" data-testid={`link-outreach-email-${i}`}>email</a>
                    )}
                    {c.phone && (
                      <a href={`tel:${c.phone}`} className="text-amber-300 hover:text-amber-200 underline" data-testid={`link-outreach-phone-${i}`}>call</a>
                    )}
                    {!c.primaryEmail && !c.phone && <span className="text-zinc-600">—</span>}
                  </div>
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
 * Task #516 — Quote Builder Card.
 * Controlled react-hook-form. Pre-fills the quote from pricing guidance and
 * the active search query, computes margin % live, disables Save when below
 * the guardrail, and posts to /api/customer-quotes/spot/create. Also exposes
 * an "Email customer" action that hits /api/customer-quotes/spot/email-draft
 * after the quote is saved (or, if you prefer, against an existing quoteId).
 */
const SPOT_BUILDER_GUARDRAIL_PCT = 5;

// QuoteBuilder form contract is the canonical spotQuoteCreateSchema from
// @shared/schema (which derives from insertQuoteOpportunitySchema). The
// lane fields (pickup/delivery + equipment) are filled from the active
// search query at submit-time, so the form itself only validates the
// rep-editable subset.
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
  const { toast } = useToast();
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string; to: string[] } | null>(null);

  const suggestedHigh = guidance.suggestedHigh ?? guidance.benchmark ?? market?.band?.high ?? 0;
  const suggestedLow = guidance.suggestedLow ?? guidance.benchmark ?? market?.band?.low ?? 0;
  const benchmark = guidance.benchmark ?? market?.band?.mid ?? null;
  const defaultQuoted = Math.round(suggestedHigh || benchmark || suggestedLow || 0);
  // Cost fallback chain: TRAC mid-band first → lane-traffic carrier average.
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
    marginPct === null ? "text-zinc-400"
    : guardrailViolation ? "text-red-300"
    : marginPct < 10 ? "text-amber-300"
    : "text-emerald-300";

  return (
    <Card className="bg-zinc-900 rounded-[4px] border border-amber-500/40 shadow-[0_0_0_1px_rgba(251,191,36,0.05)]" data-testid="spot-zone-quote-builder">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800 bg-amber-500/[0.04]">
        <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
          <DollarSign className="h-3.5 w-3.5 text-amber-400" /> Quote Builder
        </CardTitle>
        {benchmark != null && (
          <span className="text-[10px] text-zinc-500 tabular-nums">
            Benchmark <span className="text-amber-300">{fmtMoney(benchmark)}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="p-3">
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" data-testid="form-quote-builder">
            <div className="grid grid-cols-2 gap-2">
              <FormField control={form.control} name="customerId" render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel className="text-[10px] uppercase tracking-wider text-zinc-500">Customer</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 [&>span]:text-zinc-100" data-testid="select-builder-customer">
                        <SelectValue placeholder="Select customer" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="quotedAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-zinc-500">Quoted ($)</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1} inputMode="decimal"
                      value={field.value ?? ""}
                      onChange={e => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      className="h-8 bg-zinc-900 border-zinc-700 text-sm text-zinc-100 tabular-nums"
                      data-testid="input-builder-quoted" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="estimatedCost" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                    Est. cost ($)
                    {costSource && (
                      <span className="text-[9px] normal-case tracking-normal text-zinc-600" data-testid="text-builder-cost-source">
                        from {costSource === "trac" ? "TRAC mid" : "lane avg"}
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1} inputMode="decimal"
                      value={field.value ?? ""}
                      onChange={e => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      className="h-8 bg-zinc-900 border-zinc-700 text-sm text-zinc-100 tabular-nums"
                      data-testid="input-builder-cost" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="validUntil" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-zinc-500">Valid until</FormLabel>
                  <FormControl>
                    <Input type="date" {...field}
                      className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 [color-scheme:dark]"
                      data-testid="input-builder-valid" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[10px] uppercase tracking-wider text-zinc-500">Notes</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Internal note (optional)"
                      className="h-8 bg-zinc-900 border-zinc-700 text-xs text-zinc-100 placeholder:text-zinc-500"
                      data-testid="input-builder-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="rounded-[4px] border border-zinc-800 bg-zinc-950 px-2 py-1.5 flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-3">
                <span className="text-zinc-500 uppercase tracking-wider text-[9px]">Live margin</span>
                <span className={`font-semibold tabular-nums ${marginToneClass}`} data-testid="text-builder-margin-pct">
                  {marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
                </span>
                <span className="text-zinc-500 tabular-nums" data-testid="text-builder-margin-amt">
                  {marginAmt !== 0 ? fmtMoney(marginAmt) : ""}
                </span>
              </div>
              {guardrailViolation && (
                <span className="text-[10px] text-red-300 inline-flex items-center gap-1" data-testid="text-builder-guardrail">
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
                        className="h-8 bg-[#FFC333] hover:bg-amber-400 text-zinc-950 font-semibold rounded-[4px] px-3 disabled:opacity-50"
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
                className="h-8 border-amber-500/40 hover:bg-amber-500/10 text-amber-200 text-xs px-3 disabled:opacity-50"
                data-testid="button-builder-email"
              >
                <Mail className="h-3 w-3 mr-1" /> {draftMut.isPending ? "Drafting…" : "Email customer"}
              </Button>
              {savedQuoteId && (
                <span className="text-[10px] text-emerald-300 ml-auto" data-testid="text-builder-saved-id">Quote #{savedQuoteId.slice(0, 8)}</span>
              )}
            </div>
            {draft && (
              <div className="rounded-[4px] border border-zinc-800 bg-zinc-950 p-2 space-y-1.5" data-testid="builder-email-draft">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-zinc-500 uppercase tracking-wider">Draft</span>
                  <span className="text-zinc-500" data-testid="text-builder-draft-to">
                    To: {draft.to.length > 0 ? draft.to.join(", ") : <span className="text-zinc-600 italic">add recipients</span>}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-300 font-medium" data-testid="text-builder-draft-subject">{draft.subject}</div>
                <Textarea
                  value={draft.body}
                  onChange={e => setDraft(d => d ? { ...d, body: e.target.value } : d)}
                  className="min-h-[120px] text-xs bg-zinc-900 border-zinc-700 text-zinc-200"
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

/**
 * Task #516 — Carrier Shortlist Card.
 * Top 5 of carrierOutreach with Webex click-to-call + mailto. Reuses the
 * primitives that CarrierOutreachList already exposes (presence chip, in-
 * rolodex flag, DNU). Compact form; opens the full outreach panel on demand.
 */
function CarrierShortlistCard({
  outreach,
}: {
  outreach: SpotResult["carrierOutreach"];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const top = expanded ? outreach : outreach.slice(0, 5);
  return (
    <Card className="bg-zinc-900 rounded-[4px] border border-zinc-800" data-testid="spot-zone-carrier-shortlist">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800">
        <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5 text-amber-400" /> Carriers to Call (top 5)
        </CardTitle>
        {outreach.length > 5 && (
          <button type="button" onClick={() => setExpanded(v => !v)} className="text-[10px] text-amber-300 hover:text-amber-200 underline" data-testid="button-shortlist-show-all">
            {expanded ? "Show top 5" : `Show all ${outreach.length}`}
          </button>
        )}
      </CardHeader>
      <CardContent className="p-3">
        {top.length === 0 ? (
          <div className="text-zinc-500 text-xs text-center py-4">No fit carriers found for this lane.</div>
        ) : (
          <ul className="space-y-1.5">
            {top.map((c, i) => (
              <li key={`${c.carrierId ?? c.name}-${i}`}
                className={`flex items-center gap-2 rounded-[4px] border border-zinc-800 bg-zinc-950 px-2 py-1.5 ${c.doNotUse ? "opacity-50" : ""}`}
                data-testid={`row-shortlist-${i}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-100">
                    <span className="truncate">{c.name}</span>
                    {c.inRolodex && <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-blue-500/15 text-blue-300 border border-blue-500/30" title="In your rolodex">★</span>}
                    {c.doNotUse && <span className="text-[9px] px-1 py-0.5 rounded-[3px] bg-red-500/15 text-red-300 border border-red-500/30">DNU</span>}
                    {c.presence === "active" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Active" />}
                    {c.presence === "known" && <span className="h-1.5 w-1.5 rounded-full bg-blue-400" title="Known" />}
                    {c.presence === "cold" && <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" title="Cold" />}
                  </div>
                  <div className="text-[10px] text-zinc-500 tabular-nums flex items-center gap-1.5 flex-wrap">
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
                <div className="flex items-center gap-1 shrink-0">
                  {c.phone && (
                    <button type="button"
                      onClick={() => window.open(`webextel://${c.phone!.replace(/[^0-9+]/g, "")}`, "_self")}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] border border-zinc-700 hover:bg-amber-500/10 hover:border-amber-500/40 text-amber-300"
                      title={`Webex call ${c.phone}`}
                      data-testid={`button-shortlist-call-${i}`}>
                      <Phone className="h-3 w-3" />
                    </button>
                  )}
                  {c.primaryEmail && (
                    <a href={`mailto:${c.primaryEmail}?subject=${encodeURIComponent("RFQ: lane coverage")}&body=${encodeURIComponent("Hi,\n\nWe have a load looking for coverage. Can you bid on this lane?\n\nThanks,")}`}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] border border-zinc-700 hover:bg-amber-500/10 hover:border-amber-500/40 text-amber-300"
                      title={`RFQ email ${c.primaryEmail}`}
                      data-testid={`button-shortlist-email-${i}`}>
                      <Mail className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Task #516 — Customer Lane Timeline Card.
 * 5-item vertical timeline of the most recent customer-scoped exact-tier
 * quotes (i.e. the same lane, restricted to the resolved customer when
 * present, otherwise all customers).
 */
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
    <Card className="bg-zinc-900 rounded-[4px] border border-zinc-800" data-testid="spot-zone-customer-timeline">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800">
        <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-amber-400" />
          {resolvedCustomer ? `${resolvedCustomer.name} on this lane` : "Recent on this lane"}
        </CardTitle>
        <span className="text-[10px] text-zinc-500">{timeline.length} of {filtered.length}</span>
      </CardHeader>
      <CardContent className="p-3">
        {timeline.length === 0 ? (
          <div className="text-xs text-zinc-500 text-center py-4">
            {resolvedCustomer
              ? `No prior exact-lane quotes for ${resolvedCustomer.name}.`
              : "No exact-lane quote history yet."}
          </div>
        ) : (
          <ol className="relative space-y-2.5 pl-4 border-l border-zinc-800">
            {timeline.map((q, i) => {
              const quoted = num(q.quotedAmount);
              const paid = num(q.carrierPaid);
              return (
                <li key={q.id} className="relative" data-testid={`timeline-item-${i}`}>
                  <span className={`absolute -left-[18px] top-1 h-2 w-2 rounded-full ${
                    q.outcomeStatus === "won" || q.outcomeStatus === "won_low_margin" ? "bg-emerald-400" :
                    q.outcomeStatus === "pending" ? "bg-amber-400" :
                    q.outcomeStatus.startsWith("lost") ? "bg-red-400" : "bg-zinc-500"
                  }`} />
                  <button type="button" onClick={() => onPickQuote(q.id)}
                    className="text-left w-full hover:bg-zinc-800/40 rounded-[4px] px-1.5 py-1 -mx-1.5 transition"
                    data-testid={`button-timeline-${q.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-zinc-300">{new Date(q.requestDate).toLocaleDateString()}</span>
                      <StatusChip status={q.outcomeStatus} />
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-xs text-zinc-100 truncate">{q.customerName}</span>
                      <span className="text-xs text-zinc-200 tabular-nums">{fmtMoney(quoted)}{paid ? <span className="text-zinc-500"> / {fmtMoney(paid)}</span> : null}</span>
                    </div>
                    {q.outcomeReasonLabel && (
                      <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{q.outcomeReasonLabel}</div>
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

/**
 * Task #516 — Loss Pattern Card.
 * Buckets lost (or no_response/expired) quotes from the lane history by
 * outcomeReasonLabel and surfaces the top reason as a takeaway. Helps the
 * rep frame the new quote with awareness of why prior bids fell over.
 */
type LossBucketKey = "price" | "service" | "timing" | "capacity" | "no_response" | "other";
const LOSS_BUCKET_LABELS: Record<LossBucketKey, string> = {
  price: "Price / rate",
  service: "Service / quality",
  timing: "Timing / scheduling",
  capacity: "Capacity / equipment",
  no_response: "No response / expired",
  other: "Other / unknown",
};
function classifyLossReason(q: EnrichedQuote): LossBucketKey {
  if (q.outcomeStatus === "no_response" || q.outcomeStatus === "expired") return "no_response";
  const r = (q.outcomeReasonLabel ?? "").toLowerCase();
  if (!r) return "other";
  if (/(price|rate|cost|cheap|expensive|under(cut|bid)|too high|low.*bid)/.test(r)) return "price";
  if (/(service|quality|perform|reliab|relationship|trust)/.test(r)) return "service";
  if (/(time|sched|late|day|window|appointment|deadline|tight)/.test(r)) return "timing";
  if (/(capac|equip|truck|driver|asset|coverage|avail)/.test(r)) return "capacity";
  return "other";
}
function LossPatternCard({ tieredMatches }: { tieredMatches: TierGroup[] }): JSX.Element {
  const allQuotes: EnrichedQuote[] = tieredMatches.flatMap(g => g.items ?? g.quotes ?? []);
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
    <Card className="bg-zinc-900 rounded-[4px] border border-zinc-800" data-testid="spot-zone-loss-pattern">
      <CardHeader className="py-2.5 px-3 flex flex-row items-center justify-between border-b border-zinc-800">
        <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
          <ThumbsDown className="h-3.5 w-3.5 text-amber-400" /> Why we lose this lane
        </CardTitle>
        <span className="text-[10px] text-zinc-500 tabular-nums">{total} losses</span>
      </CardHeader>
      <CardContent className="p-3 space-y-2">
        {buckets.length === 0 ? (
          <div className="text-xs text-zinc-500 text-center py-4">No prior losses on this lane.</div>
        ) : (
          <>
            <ul className="space-y-1.5">
              {buckets.map((b, i) => (
                <li key={b.key} className="flex items-center gap-2 text-xs" data-testid={`loss-bucket-${b.key}`}>
                  <span className="text-zinc-200 flex-1 truncate">{LOSS_BUCKET_LABELS[b.key]}</span>
                  <div className="w-16 h-1.5 bg-zinc-800 rounded-[4px] overflow-hidden">
                    <div className="h-full bg-red-400/70" style={{ width: `${Math.min(100, (b.count / total) * 100)}%` }} />
                  </div>
                  <span className="text-zinc-400 tabular-nums w-8 text-right" data-testid={`loss-bucket-count-${b.key}`}>{b.count}</span>
                  <span className="text-zinc-500 tabular-nums w-16 text-right text-[10px]" data-testid={`loss-bucket-avg-margin-${b.key}`}>
                    {b.avgLostMarginPct !== null ? `${b.avgLostMarginPct.toFixed(1)}% mgn` : "—"}
                  </span>
                </li>
              ))}
            </ul>
            <div className="rounded-[4px] border border-amber-500/30 bg-amber-500/[0.05] px-2 py-1.5 text-[11px] text-amber-200" data-testid="text-loss-takeaway">
              {takeaway}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Task #516 — Lane Stats Bar (collapsible KPI strip).
 * Replaces the always-visible KPI grid above Pricing.
 */
function LaneStatsBar({ kpis }: { kpis: SpotResult["kpis"] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="spot-section-lane-stats">
      <div className="rounded-[4px] border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 flex items-center gap-3 flex-wrap">
        <CollapsibleTrigger asChild>
          <button type="button"
            className="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1"
            data-testid="button-lane-stats-toggle">
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Lane stats
          </button>
        </CollapsibleTrigger>
        <span className="text-[11px] text-zinc-400">
          <span className="text-zinc-500">Win</span> <span className="text-zinc-100 tabular-nums font-semibold">{fmtPct(kpis.winRate)}</span>
        </span>
        <span className="text-[11px] text-zinc-400">
          <span className="text-zinc-500">Avg quoted</span> <span className="text-zinc-100 tabular-nums">{fmtMoney(kpis.avgQuoted)}</span>
        </span>
        <span className="text-[11px] text-zinc-400">
          <span className="text-zinc-500">Avg margin</span> <span className="text-zinc-100 tabular-nums">{fmtMoney(kpis.avgMargin)}{kpis.avgMarginPct > 0 ? ` · ${fmtPct(kpis.avgMarginPct)}` : ""}</span>
        </span>
        <span className="text-[11px] text-zinc-400">
          <span className="text-zinc-500">Last quoted</span> <span className="text-zinc-100 tabular-nums">{kpis.lastQuotedDays !== null ? `${kpis.lastQuotedDays}d` : "—"}</span>
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
    amber: { border: "border-amber-500/40 shadow-[0_0_0_1px_rgba(251,191,36,0.05)]", headerBg: "bg-amber-500/[0.04]", count: "text-amber-300", iconColor: "text-amber-400" },
    blue: { border: "border-blue-500/30", headerBg: "bg-blue-500/[0.03]", count: "text-blue-300", iconColor: "text-blue-400" },
    zinc: { border: "border-zinc-700", headerBg: "bg-zinc-800/30", count: "text-zinc-300", iconColor: "text-zinc-400" },
    purple: { border: "border-purple-500/30", headerBg: "bg-purple-500/[0.04]", count: "text-purple-300", iconColor: "text-purple-400" },
    teal: { border: "border-teal-500/30", headerBg: "bg-teal-500/[0.04]", count: "text-teal-300", iconColor: "text-teal-400" },
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
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Tiered matches</span>
        {TIER_DISPLAY.map(meta => {
          const c = tierCounts[meta.tier] ?? 0;
          const acc = accentMap[meta.accent];
          return (
            <span
              key={meta.tier}
              className={`text-[11px] px-1.5 py-0.5 rounded-[4px] border tabular-nums ${c > 0 ? `${acc.headerBg} ${acc.count} border-current/30` : "bg-zinc-900 text-zinc-600 border-zinc-800"}`}
              title={meta.rule}
              data-testid={`spot-tier-chip-${meta.tier}`}
            >
              {meta.label.split(" ")[0]} <span className="font-semibold">{c}</span>
            </span>
          );
        })}
        {matchMode === "strict" && (
          <span className="text-[10px] text-zinc-500 italic">
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
            ? "text-zinc-500"
            : freshness <= 14 ? "text-emerald-300"
            : freshness <= 60 ? "text-amber-300"
            : "text-zinc-400";
          return (
            <Card
              key={meta.tier}
              id={`spot-section-tier-${meta.tier}`}
              className={`bg-zinc-900 rounded-[4px] border ${acc.border} scroll-mt-4`}
              data-testid={`spot-section-tier-${meta.tier}`}
            >
              <CardHeader className={`py-2.5 px-3 flex flex-col gap-1.5 border-b border-zinc-800 ${acc.headerBg}`}>
                <div className="flex flex-row items-center justify-between">
                  <div className="flex flex-col">
                    <CardTitle className="text-xs uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                      {iconFor(meta.icon, acc.iconColor)}{meta.label}
                    </CardTitle>
                    <span className="text-[10px] text-zinc-500 mt-0.5" title={`Why this tier? ${meta.rule}`}>
                      {meta.rule}
                    </span>
                  </div>
                  <span className={`text-[10px] font-semibold tabular-nums ${acc.count}`}>{items.length} shown</span>
                </div>
                {!empty && group && (
                  <div className="flex items-center gap-3 text-[10px] text-zinc-400" data-testid={`spot-tier-kpis-${meta.tier}`}>
                    <span title="Total prior quotes in this tier">
                      <span className="text-zinc-500">Quotes</span>{" "}
                      <span className="text-zinc-200 tabular-nums">{group.count}</span>
                    </span>
                    <span title="Won / decided">
                      <span className="text-zinc-500">Win</span>{" "}
                      <span className="text-zinc-200 tabular-nums">{winPct}%</span>
                    </span>
                    <span title="Average quoted amount on won quotes">
                      <span className="text-zinc-500">Avg won</span>{" "}
                      <span className="text-zinc-200 tabular-nums">{avgWon > 0 ? fmtMoney(avgWon) : "—"}</span>
                    </span>
                    <span title={freshness == null ? "No prior wins" : `${freshness}d since last win`}>
                      <span className="text-zinc-500">Last win</span>{" "}
                      <span className={`tabular-nums ${freshnessClass}`}>
                        {freshness == null ? "—" : `${freshness}d`}{" "}
                        <span className="text-[9px] uppercase">({freshnessLabel})</span>
                      </span>
                    </span>
                  </div>
                )}
              </CardHeader>
              <CardContent className="p-3 text-xs text-zinc-200">
                {empty ? (
                  isExact ? (
                    <div className="text-zinc-400 space-y-2" data-testid="spot-tier-empty-exact">
                      <div className="text-zinc-200 font-medium">No exact-lane quotes yet.</div>
                      {firstNonEmptyOther ? (
                        <div className="text-[11px] text-zinc-500 space-y-1.5">
                          <div>
                            Closest tier:{" "}
                            <span className="text-zinc-200 font-semibold">{firstNonEmptyOther.label}</span>
                            {" "}with{" "}
                            <span className="text-amber-300 font-semibold">{firstNonEmptyOther.count}</span>
                            {" "}prior quote{firstNonEmptyOther.count === 1 ? "" : "s"}.
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const el = document.getElementById(`spot-section-tier-${firstNonEmptyOther.tier}`);
                              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                            }}
                            className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40"
                            data-testid={`button-spot-show-tier-${firstNonEmptyOther.tier}`}
                          >
                            Show {firstNonEmptyOther.label} matches →
                          </button>
                        </div>
                      ) : matchMode === "strict" ? (
                        <div className="text-[11px] text-zinc-500">
                          No same-state-pair quotes either. Try{" "}
                          <button onClick={onSwitchToRelaxed} className="text-amber-300 hover:text-amber-200 underline" data-testid="button-spot-switch-relaxed">
                            switching to Relaxed mode
                          </button>
                          {" "}to also include same-market, reverse, and corridor matches.
                        </div>
                      ) : (
                        <div className="text-[11px] text-zinc-500">
                          No prior quotes anywhere in the tier ladder — this is a fresh corridor for your team.
                        </div>
                      )}
                      <div className="text-[11px] text-zinc-500">Try broadening:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {query.pickupDate && (
                          <button onClick={onBroadenDate}
                            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                            data-testid="button-spot-broaden-clear-date">
                            Clear pickup date
                          </button>
                        )}
                        {(!query.lookbackDays || query.lookbackDays < 365) && (
                          <button onClick={onBroadenLookback}
                            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                            data-testid="button-spot-broaden-lookback">
                            Use all-time history
                          </button>
                        )}
                        {query.equipment && (
                          <button onClick={onBroadenEquipment}
                            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                            data-testid="button-spot-broaden-equipment">
                            Drop mode filter
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-zinc-500">No matches in this tier.</div>
                  )
                ) : (
                  <div className="max-h-[280px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-zinc-500 text-[10px] uppercase tracking-wider sticky top-0 bg-zinc-900">
                        <tr><th className="text-left py-1">Date</th><th className="text-left">Customer</th><th className="text-left">Lane</th><th>Quoted</th><th>Buy</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {items.map((q: EnrichedQuote) => {
                          const quoted = num(q.quotedAmount);
                          const paid = num(q.carrierPaid);
                          return (
                            <tr key={q.id} onClick={() => onPickQuote(q.id)}
                              className="border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer"
                              data-testid={`spot-quote-row-${q.id}`}>
                              <td className="py-1 text-zinc-300 whitespace-nowrap">{new Date(q.requestDate).toLocaleDateString()}</td>
                              <td className="text-zinc-100 truncate max-w-[120px]">{q.customerName}</td>
                              <td className="text-zinc-400 truncate max-w-[140px] text-[10px]">
                                {q.originCity}, {q.originState} → {q.destCity}, {q.destState}
                              </td>
                              <td className="text-center tabular-nums">{fmtMoney(quoted)}</td>
                              <td className="text-center tabular-nums text-zinc-400">{paid ? fmtMoney(paid) : "—"}</td>
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
