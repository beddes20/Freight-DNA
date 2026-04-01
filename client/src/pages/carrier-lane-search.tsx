import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Truck, Route, ChevronDown, ChevronUp, Download, Circle, Phone, MapPin, TrendingUp, Calendar, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

interface CarrierEntry {
  name: string;
  loads: number;
  pct: number;
  avgMarginPerLoad: number | null;
  avgCarrierPay: number | null;
  lastUsed: string | null;
  lastShipDate: string | null;
}

interface CorridorResult {
  corridorKey: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  mode: string;
  originLabel: string;
  destLabel: string;
  corridorLabel: string;
  avgLoadsPerMonth: number;
  totalLoads: number;
  monthsObserved: number;
  originDistanceMiles: number | null;
  destDistanceMiles: number | null;
  carriers: CarrierEntry[];
}

interface SearchResponse {
  corridors: CorridorResult[];
  originQuery: string;
  destQuery: string;
  radiusMiles: number;
  minLoadsPerMonth: number;
  originGeocoded: boolean;
  destGeocoded: boolean;
}

const MODE_ORDER = ["Van", "Reefer", "Flatbed", "LTL", "Drayage", "IMDL"];

function modeSort(a: string, b: string): number {
  const ai = MODE_ORDER.indexOf(a);
  const bi = MODE_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

function formatMonthKey(mk: string | null): string {
  if (!mk) return "—";
  const [y, m] = mk.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function exportToCsv(corridors: CorridorResult[], originQ: string, destQ: string, radius: number) {
  const rows: string[][] = [
    ["Mode", "Corridor", "Origin City", "Origin State", "Origin Dist (mi)", "Dest City", "Dest State", "Dest Dist (mi)",
     "Avg Loads/Mo", "Total Loads", "Months Observed", "Carrier", "Carrier Loads", "Carrier %", "Avg Carrier Pay", "Avg Margin/Load", "Last Used", "Last Ship Date"],
  ];
  for (const c of corridors) {
    for (const carrier of c.carriers) {
      rows.push([
        c.mode,
        c.corridorLabel,
        c.originCity, c.originState,
        c.originDistanceMiles != null ? String(c.originDistanceMiles) : "",
        c.destCity, c.destState,
        c.destDistanceMiles != null ? String(c.destDistanceMiles) : "",
        String(c.avgLoadsPerMonth),
        String(c.totalLoads),
        String(c.monthsObserved),
        carrier.name,
        String(carrier.loads),
        `${carrier.pct}%`,
        carrier.avgCarrierPay != null ? `$${carrier.avgCarrierPay}` : "",
        carrier.avgMarginPerLoad != null ? `$${carrier.avgMarginPerLoad}` : "",
        formatMonthKey(carrier.lastUsed),
        carrier.lastShipDate ?? "",
      ]);
    }
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const parts = [originQ, destQ].filter(Boolean).join("_to_").replace(/\s+/g, "-");
  a.download = `carrier-call-list-${parts || "results"}-${radius}mi.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function DistancePill({ miles }: { miles: number | null }) {
  if (miles == null) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium ml-1.5">
      <MapPin className="w-2.5 h-2.5" />{miles} mi
    </span>
  );
}

type SortCol = "loads" | "pct" | "avgCarrierPay" | "avgMarginPerLoad" | "lastUsed" | "name";
type SortDir = "asc" | "desc";

function SortIcon({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol; sortDir: SortDir }) {
  if (col !== sortCol) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40 inline-block" />;
  return sortDir === "asc"
    ? <ArrowUp className="w-3 h-3 ml-1 text-foreground inline-block" />
    : <ArrowDown className="w-3 h-3 ml-1 text-foreground inline-block" />;
}

function sortCarriers(carriers: CarrierEntry[], col: SortCol, dir: SortDir): CarrierEntry[] {
  return [...carriers].sort((a, b) => {
    let av: any, bv: any;
    if (col === "lastUsed") { av = a.lastUsed ?? ""; bv = b.lastUsed ?? ""; }
    else if (col === "name") { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else { av = a[col] ?? -Infinity; bv = b[col] ?? -Infinity; }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

function CorridorCard({ corridor }: { corridor: CorridorResult }) {
  const [expanded, setExpanded] = useState(true);
  const [sortCol, setSortCol] = useState<SortCol>("loads");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (col === sortCol) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir(col === "name" || col === "lastUsed" ? "asc" : "desc"); }
  }

  const sorted = sortCarriers(corridor.carriers, sortCol, sortDir);
  const thClass = (col: SortCol, align: "left" | "right" = "right") =>
    `${align === "right" ? "text-right" : "text-left"} px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${sortCol === col ? "text-foreground" : ""}`;

  return (
    <Card className="overflow-hidden" data-testid={`card-corridor-${corridor.corridorKey.replace(/\|/g, "-")}`}>
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
            <Route className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-base text-foreground">
                <span>{corridor.originLabel}<DistancePill miles={corridor.originDistanceMiles} /></span>
                <span className="text-muted-foreground mx-2">→</span>
                <span>{corridor.destLabel}<DistancePill miles={corridor.destDistanceMiles} /></span>
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5" />
                <span className="font-semibold text-foreground">{corridor.avgLoadsPerMonth}</span> loads/mo avg
              </span>
              <span className="flex items-center gap-1">
                <Truck className="w-3.5 h-3.5" />
                {corridor.carriers.length} carrier{corridor.carriers.length !== 1 ? "s" : ""}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                {corridor.monthsObserved} mo of history
              </span>
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 ml-4">
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          <div className="px-5 py-2.5 bg-muted/30 flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <Phone className="w-3.5 h-3.5" />
            Carrier Call List — click any column to sort
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/20 text-muted-foreground text-xs uppercase tracking-wide border-t border-border">
                  <th className="text-left px-5 py-2 font-medium">#</th>
                  <th className={thClass("name", "left")} onClick={e => { e.stopPropagation(); handleSort("name"); }} data-testid="th-carrier-name">
                    Carrier<SortIcon col="name" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th className={thClass("loads")} onClick={e => { e.stopPropagation(); handleSort("loads"); }}>
                    Loads<SortIcon col="loads" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th className={thClass("pct")} onClick={e => { e.stopPropagation(); handleSort("pct"); }}>
                    Share<SortIcon col="pct" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th className={thClass("avgCarrierPay")} onClick={e => { e.stopPropagation(); handleSort("avgCarrierPay"); }}>
                    Avg Carrier Pay<SortIcon col="avgCarrierPay" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th className={thClass("avgMarginPerLoad")} onClick={e => { e.stopPropagation(); handleSort("avgMarginPerLoad"); }}>
                    Avg Margin<SortIcon col="avgMarginPerLoad" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th className={`${thClass("lastUsed")} pr-5`} onClick={e => { e.stopPropagation(); handleSort("lastUsed"); }}>
                    Last Used<SortIcon col="lastUsed" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((carrier, idx) => (
                  <tr key={carrier.name} className="border-t border-border/50 hover:bg-muted/20 transition-colors" data-testid={`row-carrier-${idx}`}>
                    <td className="px-5 py-3 text-muted-foreground font-mono text-xs">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Truck className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="font-semibold">{carrier.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <Badge variant="secondary" className="font-semibold">{carrier.loads.toLocaleString()}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${carrier.pct}%` }} />
                        </div>
                        <span className="text-muted-foreground text-xs w-8 text-right">{carrier.pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-blue-600 dark:text-blue-400 font-medium">
                      {carrier.avgCarrierPay != null ? `$${carrier.avgCarrierPay.toLocaleString()}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                      {carrier.avgMarginPerLoad != null ? `$${carrier.avgMarginPerLoad.toLocaleString()}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-right text-xs">
                      <div className="text-muted-foreground">{formatMonthKey(carrier.lastUsed)}</div>
                      {carrier.lastShipDate && (
                        <div className="text-muted-foreground/60 text-[10px] mt-0.5">
                          {new Date(carrier.lastShipDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function ModeSection({ mode, corridors }: { mode: string; corridors: CorridorResult[] }) {
  const [open, setOpen] = useState(true);
  const totalLoads = corridors.reduce((s, c) => s + c.totalLoads, 0);
  const totalCarriers = new Set(corridors.flatMap(c => c.carriers.map(x => x.name))).size;

  return (
    <div className="space-y-2" data-testid={`section-mode-${mode.toLowerCase()}`}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-muted/50 hover:bg-muted/80 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
        data-testid={`btn-mode-${mode.toLowerCase()}`}
      >
        <div className="flex items-center gap-3">
          <Truck className="w-4 h-4 text-muted-foreground" />
          <span className="font-semibold text-foreground">{mode}</span>
          <Badge variant="secondary" className="text-xs">{corridors.length} corridor{corridors.length !== 1 ? "s" : ""}</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {totalCarriers} carrier{totalCarriers !== 1 ? "s" : ""} · {totalLoads.toLocaleString()} total loads
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
      </button>
      {open && (
        <div className="space-y-3 pl-0">
          {corridors.map(corridor => (
            <CorridorCard key={corridor.corridorKey} corridor={corridor} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CarrierLaneSearchPage() {
  const [originInput, setOriginInput] = useState("");
  const [destInput, setDestInput] = useState("");
  const [radiusInput, setRadiusInput] = useState("75");
  const [minLoadsInput, setMinLoadsInput] = useState("5");
  const [searchParams, setSearchParams] = useState<{ origin: string; dest: string; radius: number; minLoads: number } | null>(null);

  const { data, isLoading, isError } = useQuery<SearchResponse>({
    queryKey: ["/api/carriers/lane-search", searchParams?.origin, searchParams?.dest, searchParams?.radius, searchParams?.minLoads],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchParams?.origin) params.set("origin", searchParams.origin);
      if (searchParams?.dest)   params.set("destination", searchParams.dest);
      params.set("radius", String(searchParams?.radius ?? 75));
      params.set("minLoadsPerMonth", String(searchParams?.minLoads ?? 5));
      const res = await fetch(`/api/carriers/lane-search?${params}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!searchParams && (!!(searchParams.origin || searchParams.dest)),
  });

  const handleSearch = () => {
    const o = originInput.trim();
    const d = destInput.trim();
    if (!o && !d) return;
    setSearchParams({ origin: o, dest: d, radius: Math.max(1, parseInt(radiusInput) || 75), minLoads: Math.max(1, parseFloat(minLoadsInput) || 5) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter") handleSearch(); };

  // Group corridors by mode
  const modeGroups: { mode: string; corridors: CorridorResult[] }[] = [];
  if (data?.corridors.length) {
    const groupMap = new Map<string, CorridorResult[]>();
    for (const c of data.corridors) {
      if (!groupMap.has(c.mode)) groupMap.set(c.mode, []);
      groupMap.get(c.mode)!.push(c);
    }
    const modes = [...groupMap.keys()].sort(modeSort);
    for (const mode of modes) modeGroups.push({ mode, corridors: groupMap.get(mode)! });
  }

  const totalCarriers = data ? new Set(data.corridors.flatMap(c => c.carriers.map(x => x.name))).size : 0;
  const totalLoads = data?.corridors.reduce((s, c) => s + c.totalLoads, 0) ?? 0;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Carrier Lane Search</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Find carriers with history on specific corridors from your financial data — grouped by mode. When freight drops, your call list is ready.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5 pb-5">
          <div className="flex flex-col sm:flex-row gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[160px] space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Origin</Label>
              <Input placeholder="e.g. Chicago, IL or TX" value={originInput} onChange={e => setOriginInput(e.target.value)} onKeyDown={handleKeyDown} data-testid="input-carrier-origin" />
            </div>
            <div className="hidden sm:flex items-center pb-2 text-muted-foreground">→</div>
            <div className="flex-1 min-w-[160px] space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Destination</Label>
              <Input placeholder="e.g. Laredo, TX or Laredo" value={destInput} onChange={e => setDestInput(e.target.value)} onKeyDown={handleKeyDown} data-testid="input-carrier-destination" />
            </div>
            <div className="w-28 flex-shrink-0 space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Circle className="w-3 h-3" /> Radius (mi)
              </Label>
              <Input type="number" min="1" max="500" value={radiusInput} onChange={e => setRadiusInput(e.target.value)} onKeyDown={handleKeyDown} data-testid="input-carrier-radius" />
            </div>
            <div className="w-32 flex-shrink-0 space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> Min Loads/Mo
              </Label>
              <Input type="number" min="1" value={minLoadsInput} onChange={e => setMinLoadsInput(e.target.value)} onKeyDown={handleKeyDown} data-testid="input-carrier-min-loads" />
            </div>
            <Button onClick={handleSearch} disabled={isLoading || (!originInput.trim() && !destInput.trim())} className="gap-2 sm:w-auto w-full flex-shrink-0" data-testid="button-carrier-search">
              <Search className="w-4 h-4" />
              {isLoading ? "Searching…" : "Search"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Results are grouped by mode. Lanes with no mode on record are excluded. Only corridors averaging <strong>{minLoadsInput || "5"}+ loads/month</strong> are shown.
          </p>
        </CardContent>
      </Card>

      {isError && (
        <div className="text-center py-10 text-destructive text-sm" data-testid="error-carrier-search">
          Something went wrong. Please try again.
        </div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              {data.corridors.length > 0 ? (
                <>
                  <span>
                    <span className="font-semibold text-foreground">{modeGroups.length}</span> mode{modeGroups.length !== 1 ? "s" : ""},{" "}
                    <span className="font-semibold text-foreground">{data.corridors.length}</span> corridor{data.corridors.length !== 1 ? "s" : ""},{" "}
                    <span className="font-semibold text-foreground">{totalCarriers}</span> carriers,{" "}
                    <span className="font-semibold text-foreground">{totalLoads.toLocaleString()}</span> loads
                  </span>
                  <span className="flex items-center gap-1 text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 px-2.5 py-1 rounded-full">
                    <Circle className="w-3 h-3" />{data.radiusMiles} mi buffer
                    {((!data.originGeocoded && data.originQuery) || (!data.destGeocoded && data.destQuery)) && (
                      <span className="text-amber-600 dark:text-amber-400 ml-1">· some used text match</span>
                    )}
                  </span>
                </>
              ) : (
                <span>No corridors found matching your criteria.</span>
              )}
            </div>
            {data.corridors.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => exportToCsv(data.corridors, data.originQuery, data.destQuery, data.radiusMiles)} data-testid="button-export-carriers-csv">
                <Download className="w-3.5 h-3.5" />Export Call List
              </Button>
            )}
          </div>

          {data.corridors.length === 0 && (
            <div className="text-center py-16 text-muted-foreground" data-testid="empty-carrier-search">
              <Truck className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No qualifying corridors found.</p>
              <p className="text-sm mt-1">Try a broader search, increase the radius, or lower the min loads/mo threshold.</p>
            </div>
          )}

          <div className="space-y-5">
            {modeGroups.map(({ mode, corridors }) => (
              <ModeSection key={mode} mode={mode} corridors={corridors} />
            ))}
          </div>
        </>
      )}

      {!data && !isLoading && (
        <div className="text-center py-20 text-muted-foreground" data-testid="idle-carrier-search">
          <Phone className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Enter a corridor to build your carrier call list.</p>
          <p className="text-sm mt-1">Results are grouped by mode. Corridors with no mode on record are excluded.</p>
        </div>
      )}
    </div>
  );
}
