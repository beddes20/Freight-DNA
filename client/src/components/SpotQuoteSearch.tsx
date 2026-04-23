import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import {
  Search, MapPin, Truck, Calendar, AlertTriangle, TrendingUp, Award, Users,
  Clock, Activity, X, ChevronRight, ChevronDown, Copy, RefreshCw, SlidersHorizontal,
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
};

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

type SpotResult = {
  query: SpotSearchQuery;
  resolvedCustomer: { id: string; name: string } | null;
  kpis: {
    exactCount: number; similarCount: number; customersOnLane: number;
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
  };
  exactMatches: EnrichedQuote[];
  similarMatches: EnrichedQuote[];
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

type AutoItem = { city: string; state: string; count: number };

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

  const list = items.data ?? [];
  const visible = autoOpen && list.length > 0;

  const pick = (it: AutoItem): void => {
    onChange({ city: it.city, state: it.state });
    setQ(it.city);
    setAutoOpen(false);
    setActiveIdx(-1);
    // Jump to next field — picking from autocomplete is a complete answer.
    setTimeout(() => onAdvance?.(), 0);
  };

  const onCityKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (visible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => Math.min(list.length - 1, i + 1));
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => Math.max(-1, i - 1));
        return;
      } else if (e.key === "Enter" && activeIdx >= 0 && activeIdx < list.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(list[activeIdx]);
        return;
      } else if (e.key === "Escape") {
        e.stopPropagation();
        setAutoOpen(false);
        setActiveIdx(-1);
        return;
      }
    }
    // Tab / Enter from city → jump to state if value present
    if (e.key === "Tab" && !e.shiftKey && q.trim() && !value.state) {
      e.preventDefault();
      stateEl.current?.focus();
    }
  };

  const onStateChange = (raw: string): void => {
    const v = raw.toUpperCase().slice(0, 2);
    onChange({ city: value.city, state: v });
    if (v.length === 2) {
      setTimeout(() => onAdvance?.(), 0);
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
          onChange={e => { setQ(e.target.value); onChange({ city: e.target.value, state: value.state }); setAutoOpen(true); setActiveIdx(-1); }}
          onFocus={() => setAutoOpen(true)}
          onBlur={() => setTimeout(() => setAutoOpen(false), 150)}
          onKeyDown={onCityKeyDown}
          placeholder="City"
          className="h-10 w-[200px] bg-zinc-900 border-zinc-700 text-sm focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
          data-testid={testIdCity}
        />
        <Input
          ref={stateEl}
          value={value.state}
          onChange={e => onStateChange(e.target.value)}
          placeholder="ST"
          className="h-10 w-[60px] bg-zinc-900 border-zinc-700 text-sm uppercase tracking-wider text-center focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
          maxLength={2}
          data-testid={testIdState}
        />
      </div>
      {visible && (
        <div className="absolute top-full left-0 mt-1 z-30 w-[300px] rounded-[4px] border border-zinc-700 bg-zinc-950 shadow-2xl max-h-[280px] overflow-y-auto" data-testid={`autocomplete-${kind}`}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800 bg-zinc-900">
            {kind === "origin" ? "Pickup matches" : "Delivery matches"} · {list.length}
          </div>
          {list.map((it, i) => (
            <button
              key={`${it.city}|${it.state}`}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(it); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs border-l-2 ${i === activeIdx ? "bg-zinc-800 border-amber-400" : "border-transparent hover:bg-zinc-900"}`}
              data-testid={`autocomplete-item-${kind}-${it.city}-${it.state}`}
            >
              <span className="text-zinc-100 flex items-center gap-1.5">
                <MapPin className="h-3 w-3 text-zinc-500" />{it.city}, <span className="text-zinc-400">{it.state}</span>
              </span>
              <span className="text-[10px] text-zinc-500 tabular-nums">{it.count} quote{it.count === 1 ? "" : "s"}</span>
            </button>
          ))}
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
    setActiveQuery({
      pickupCity: r.pickupCity, pickupState: r.pickupState,
      deliveryCity: r.deliveryCity, deliveryState: r.deliveryState,
      equipment: r.equipment, pickupDate: r.pickupDate, customerId: r.customerId,
      lookbackDays: r.lookbackDays, exactOnly: r.exactOnly, includeSimilar: r.includeSimilar,
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
              <SelectTrigger className="h-10 w-[130px] bg-zinc-900 border-zinc-700 text-sm" data-testid="select-spot-equipment"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EQUIPMENT_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1"><Calendar className="h-3 w-3" /> Pickup date</span>
            <Input ref={dateRef} type="date" value={pickupDate} onChange={e => setPickupDate(e.target.value)}
              className="h-10 w-[160px] bg-zinc-900 border-zinc-700 text-sm focus-visible:ring-amber-400/40 focus-visible:border-amber-400/60"
              data-testid="input-spot-pickup-date" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1"><Users className="h-3 w-3" /> Customer (optional)</span>
            <Select value={customerId || "_any"} onValueChange={v => setCustomerId(v === "_any" ? "" : v)}>
              <SelectTrigger className="h-10 w-[220px] bg-zinc-900 border-zinc-700 text-sm" data-testid="select-spot-customer"><SelectValue placeholder="Any customer" /></SelectTrigger>
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
                    <SelectTrigger className="h-8 w-[150px] bg-zinc-900 border-zinc-700 text-xs" data-testid="select-spot-lookback"><SelectValue /></SelectTrigger>
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
              </div>

              {/* Freight qualification (informational; tags the search context) */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 pt-2 border-t border-zinc-800">
                <AdvField label="Weight (lbs)">
                  <Input value={adv.weight ?? ""} onChange={e => setAdv(a => ({ ...a, weight: e.target.value }))}
                    placeholder="e.g. 42000" className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-spot-weight" />
                </AdvField>
                <AdvField label="Commodity">
                  <Input value={adv.commodity ?? ""} onChange={e => setAdv(a => ({ ...a, commodity: e.target.value }))}
                    placeholder="e.g. Steel coils" className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-spot-commodity" />
                </AdvField>
                <AdvField label="Pallets">
                  <Input value={adv.pallets ?? ""} onChange={e => setAdv(a => ({ ...a, pallets: e.target.value }))}
                    placeholder="e.g. 26" className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-spot-pallets" />
                </AdvField>
                <AdvField label="TL type">
                  <Select value={adv.truckloadType ?? "_unset"} onValueChange={v => setAdv(a => ({ ...a, truckloadType: v === "_unset" ? undefined : v }))}>
                    <SelectTrigger className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="select-spot-tl-type"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_unset">—</SelectItem>
                      {TRUCKLOAD_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </AdvField>
                <AdvField label="Special handling">
                  <Input value={adv.specialHandling ?? ""} onChange={e => setAdv(a => ({ ...a, specialHandling: e.target.value }))}
                    placeholder="Tarps, straps…" className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-spot-special" />
                </AdvField>
                <AdvField label="Access notes">
                  <Input value={adv.accessNotes ?? ""} onChange={e => setAdv(a => ({ ...a, accessNotes: e.target.value }))}
                    placeholder="Residential, jobsite…" className="h-8 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-spot-access" />
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

      {/* Results workspace */}
      {!activeQuery && (
        <Card className="bg-zinc-900/40 border-zinc-800 border-dashed rounded-[4px]" data-testid="spot-empty-state">
          <CardContent className="p-6 text-center text-zinc-400 text-sm">
            <Search className="h-6 w-6 mx-auto mb-2 text-zinc-600" />
            Enter a lane above to see exact-match history, similar lanes, customer signals, carrier costs, internal variance, freight attractiveness, and pricing guidance for this opportunity.
          </CardContent>
        </Card>
      )}

      {activeQuery && result.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full bg-zinc-900" />
          <Skeleton className="h-48 w-full bg-zinc-900" />
        </div>
      )}

      {activeQuery && data && (
        <div className="space-y-3" data-testid="spot-results">
          {/* 1. Header */}
          <SectionCard title="Spot Quote" icon={<TrendingUp className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-header">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-base font-semibold text-zinc-100">
                  {data.query.pickupCity}, {data.query.pickupState}
                  <ChevronRight className="inline h-4 w-4 mx-1 text-amber-400" />
                  {data.query.deliveryCity}, {data.query.deliveryState}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">
                  {data.query.equipment ?? "Any equipment"}
                  {data.query.pickupDate ? ` · pickup ${data.query.pickupDate}` : ""}
                  {data.resolvedCustomer ? ` · ${data.resolvedCustomer.name}` : " · all customers"}
                  {data.query.lookbackDays ? ` · last ${data.query.lookbackDays}d` : ""}
                  {data.query.exactOnly ? " · exact only" : data.query.includeSimilar === false ? " · similar excluded" : ""}
                </div>
                {searchedAt && (
                  <div className="text-[10px] text-zinc-500 mt-0.5" data-testid="text-spot-searched-at">
                    Searched {searchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={copyLane}
                  className="h-8 border-zinc-700 hover:bg-zinc-800 text-xs" data-testid="button-spot-header-copy">
                  <Copy className="h-3 w-3 mr-1" /> Copy lane
                </Button>
                <Button size="sm" variant="outline" onClick={rerunSearch}
                  className="h-8 border-zinc-700 hover:bg-zinc-800 text-xs" data-testid="button-spot-header-rerun">
                  <RefreshCw className="h-3 w-3 mr-1" /> Rerun
                </Button>
                <Button size="sm" variant="outline" onClick={() => onApplyLaneFilter(`${data.query.pickupCity} ${data.query.deliveryCity}`)}
                  className="h-8 border-zinc-700 hover:bg-zinc-800 text-xs" data-testid="button-spot-apply-filter">
                  Filter table by this lane
                </Button>
              </div>
            </div>
          </SectionCard>

          {/* 2. KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12 gap-2" data-testid="spot-section-kpis">
            <Kpi label="Exact" value={String(data.kpis.exactCount)} />
            <Kpi label="Similar" value={String(data.kpis.similarCount)} />
            <Kpi label="Customers" value={String(data.kpis.customersOnLane)} />
            <Kpi label="Pending" value={String(data.kpis.pendingCount)} />
            <Kpi label="Win rate" value={fmtPct(data.kpis.winRate)} />
            <Kpi label="Avg quoted" value={fmtMoney(data.kpis.avgQuoted)} />
            <Kpi label="Avg won" value={fmtMoney(data.kpis.avgWonQuoted)} />
            <Kpi label="Avg buy" value={fmtMoney(data.kpis.avgCarrierPaid)} />
            <Kpi label="Avg margin" value={fmtMoney(data.kpis.avgMargin)} sub={data.kpis.avgMarginPct > 0 ? fmtPct(data.kpis.avgMarginPct) : undefined} />
            <Kpi label="Last quoted" value={data.kpis.lastQuotedDays !== null ? `${data.kpis.lastQuotedDays}d` : "—"} />
            <Kpi label="Last won" value={data.kpis.lastWonDays !== null ? `${data.kpis.lastWonDays}d` : "—"} />
            <KpiBadge label="Confidence" value={data.kpis.confidence} freshness={data.kpis.freshnessLabel} />
          </div>

          {/* 3. Guidance band */}
          <SectionCard title="Pricing Guidance" icon={<Activity className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-guidance">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">Suggested range</span>
                <span className="text-2xl font-semibold text-amber-400 tabular-nums" data-testid="text-spot-guidance-range">
                  {data.guidance.suggestedLow !== null && data.guidance.suggestedHigh !== null
                    ? `${fmtMoney(data.guidance.suggestedLow)} – ${fmtMoney(data.guidance.suggestedHigh)}`
                    : "—"}
                </span>
              </div>
              {data.guidance.benchmark !== null && (
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">SONAR benchmark</span>
                  <span className="text-base text-zinc-100 tabular-nums">{fmtMoney(data.guidance.benchmark)}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <ConfidenceDot confidence={data.guidance.confidence} />
                <span className="capitalize">{data.guidance.confidence.replace(/_/g, " ")}</span>
              </div>
              <div className="flex-1 min-w-[200px] text-[11px] text-zinc-400">{data.guidance.message}</div>
            </div>
          </SectionCard>

          {/* 4-5. Exact + Similar lane history */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <QuoteListSection title="Exact Match History" icon={<Award className="h-3.5 w-3.5 text-amber-400" />}
              testId="spot-section-exact" empty="No prior quotes on this exact lane."
              quotes={data.exactMatches} onPickQuote={onPickQuote} />
            <QuoteListSection title="Similar Lane History" icon={<MapPin className="h-3.5 w-3.5 text-amber-400" />}
              testId="spot-section-similar" empty="No similar-state-pair quotes."
              quotes={data.similarMatches} onPickQuote={onPickQuote} />
          </div>

          {/* 6. Customer panel */}
          <SectionCard title="Customer Signals on this Lane" icon={<Users className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-customer-panel">
            {data.customerPanel.length === 0 ? (
              <div className="text-zinc-500">No customer history on this lane yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
                  <tr><th className="text-left py-1">Customer</th><th>Quotes</th><th>Win rate</th><th>Avg quoted</th><th>Avg margin</th><th>Last</th><th className="text-left">Top carriers</th></tr>
                </thead>
                <tbody>
                  {data.customerPanel.map(c => (
                    <tr key={c.customerId} className="border-t border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer"
                      onClick={() => onPickCustomer(c.customerId)} data-testid={`spot-customer-row-${c.customerId}`}>
                      <td className="py-1 text-zinc-100 font-medium">{c.customerName}</td>
                      <td className="text-center tabular-nums">{c.quotes}</td>
                      <td className="text-center tabular-nums">{fmtPct(c.winRate)}</td>
                      <td className="text-center tabular-nums">{fmtMoney(c.avgQuoted)}</td>
                      <td className="text-center tabular-nums">{fmtMoney(c.avgMargin)}</td>
                      <td className="text-center tabular-nums text-zinc-400">{c.lastQuotedDays !== null ? `${c.lastQuotedDays}d` : "—"}</td>
                      <td className="text-zinc-400 text-[10px]">{c.topCarriers.map(t => `${t.name} (${t.loads})`).join(", ") || "—"}</td>
                    </tr>
                  ))}
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
            <SectionCard title="Carrier / Buy History" icon={<Truck className="h-3.5 w-3.5 text-amber-400" />} testId="spot-section-carrier">
              {data.carrierHistory.length === 0 ? (
                <div className="text-zinc-500">No carrier purchase history.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-zinc-500 text-[10px] uppercase tracking-wider">
                    <tr><th className="text-left">Carrier</th><th>Loads</th><th>Avg buy</th><th>Range</th><th>Last</th></tr>
                  </thead>
                  <tbody>
                    {data.carrierHistory.map(c => (
                      <tr key={c.name} className="border-t border-zinc-800/60" data-testid={`spot-carrier-${c.name}`}>
                        <td className="py-1 text-zinc-100">{c.name}</td>
                        <td className="text-center tabular-nums">{c.loads}</td>
                        <td className="text-center tabular-nums">{fmtMoney(c.avgPaid)}</td>
                        <td className="text-center tabular-nums text-zinc-400">{fmtMoney(c.lowPaid)} – {fmtMoney(c.highPaid)}</td>
                        <td className="text-center tabular-nums text-zinc-400">{c.lastUsedDays !== null ? `${c.lastUsedDays}d` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SectionCard>
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

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="rounded-[4px] bg-zinc-900 border border-zinc-800 p-2" data-testid={`spot-kpi-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-base font-semibold text-zinc-100 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
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

function QuoteListSection({ title, icon, testId, empty, quotes, onPickQuote }: {
  title: string; icon: React.ReactNode; testId: string; empty: string;
  quotes: EnrichedQuote[]; onPickQuote: (id: string) => void;
}): JSX.Element {
  return (
    <SectionCard title={title} icon={icon} testId={testId}
      action={<span className="text-[10px] text-zinc-500">{quotes.length} shown</span>}>
      {quotes.length === 0 ? (
        <div className="text-zinc-500">{empty}</div>
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
    </SectionCard>
  );
}
