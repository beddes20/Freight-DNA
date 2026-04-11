import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, Building2, Truck, Route, Package, ChevronDown, ChevronUp, Download, MapPin, Circle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

interface LaneResult {
  lane: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  volume: number;
  equipment: string;
  miles: number | null;
  originDistanceMiles: number | null;
  destDistanceMiles: number | null;
}

interface CompanyResult {
  companyId: string;
  companyName: string;
  rfpId: string;
  rfpTitle: string;
  rfpStatus: string;
  rfpDueDate: string | null;
  matchingLanes: LaneResult[];
  totalMatchVolume: number;
}

interface SearchResponse {
  results: CompanyResult[];
  originQuery: string;
  destQuery: string;
  radiusMiles: number;
  originGeocoded: boolean;
  destGeocoded: boolean;
}

const MODE_ORDER = ["Van", "Reefer", "Flatbed", "LTL", "Drayage", "IMDL"];

function normalizeMode(raw: string): string {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return "";
  if (/^(v|van|dry.?van|dv|dryvan)$/.test(t)) return "Van";
  if (/^(r|reefer|refrigerated|temp|temperature|temp.?ctrl)$/.test(t)) return "Reefer";
  if (/^(f|flatbed|fb|flat|step.?deck|rgn|lowboy)$/.test(t)) return "Flatbed";
  if (/^ltl$/.test(t)) return "LTL";
  if (/^(drayage|dray)$/.test(t)) return "Drayage";
  if (/^(imdl|intermodal|im|rail)$/.test(t)) return "IMDL";
  const s = raw.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function modeSort(a: string, b: string): number {
  const ai = MODE_ORDER.indexOf(a);
  const bi = MODE_ORDER.indexOf(b);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

function statusBadgeVariant(status: string) {
  if (status === "won") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (status === "lost") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  if (status === "awarded") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

function exportToCsv(results: CompanyResult[], originQ: string, destQ: string, radius: number) {
  const rows: string[][] = [
    ["Mode", "Customer", "RFP", "RFP Status", "Lane", "Origin City", "Origin State", "Origin Dist (mi)", "Dest City", "Dest State", "Dest Dist (mi)", "Annual Loads", "Equipment", "Lane Miles"],
  ];
  for (const r of results) {
    for (const lane of r.matchingLanes) {
      const mode = normalizeMode(lane.equipment);
      if (!mode) continue;
      rows.push([
        mode,
        r.companyName,
        r.rfpTitle,
        r.rfpStatus,
        lane.lane,
        lane.origin,
        lane.originState,
        lane.originDistanceMiles != null ? String(lane.originDistanceMiles) : "",
        lane.destination,
        lane.destinationState,
        lane.destDistanceMiles != null ? String(lane.destDistanceMiles) : "",
        String(Math.round(lane.volume)),
        lane.equipment || "",
        lane.miles != null ? String(Math.round(lane.miles)) : "",
      ]);
    }
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const parts = [originQ, destQ].filter(Boolean).join("_to_").replace(/\s+/g, "-");
  a.download = `lane-search-${parts || "results"}-${radius}mi.csv`;
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

function CompanyCard({
  result, filteredLanes, originQuery, destQuery,
}: {
  result: CompanyResult;
  filteredLanes: LaneResult[];
  originQuery: string;
  destQuery: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const modeVolume = filteredLanes.reduce((s, l) => s + (l.volume || 0), 0);

  return (
    <Card className="overflow-hidden" data-testid={`card-company-${result.companyId}`}>
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center flex-shrink-0">
            <Building2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/companies/${result.companyId}`}
                className="font-semibold text-base hover:underline text-foreground"
                onClick={e => e.stopPropagation()}
                data-testid={`link-company-${result.companyId}`}
              >
                {result.companyName}
              </Link>
              <span className="text-muted-foreground text-sm truncate max-w-[220px]">{result.rfpTitle}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeVariant(result.rfpStatus)}`}>
                {result.rfpStatus}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Route className="w-3.5 h-3.5" />
                {filteredLanes.length} matching lane{filteredLanes.length !== 1 ? "s" : ""}
              </span>
              <span className="flex items-center gap-1">
                <Package className="w-3.5 h-3.5" />
                {Math.round(modeVolume).toLocaleString()} loads/yr
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-2.5 font-medium">
                    Origin{originQuery && <span className="normal-case ml-1 opacity-60">({originQuery})</span>}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium">
                    Destination{destQuery && <span className="normal-case ml-1 opacity-60">({destQuery})</span>}
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium">Loads/yr</th>
                  <th className="text-left px-4 py-2.5 font-medium">Equipment</th>
                  <th className="text-right px-5 py-2.5 font-medium">Lane Mi</th>
                </tr>
              </thead>
              <tbody>
                {filteredLanes.map((lane, idx) => (
                  <tr
                    key={idx}
                    className="border-t border-border/50 hover:bg-muted/20 transition-colors"
                    data-testid={`row-lane-${result.rfpId}-${idx}`}
                  >
                    <td className="px-5 py-3">
                      <span className="font-medium">
                        {lane.origin
                          ? <>{lane.origin}{lane.originState ? <span className="text-muted-foreground">, {lane.originState}</span> : null}</>
                          : <span className="text-muted-foreground">{lane.originState || "—"}</span>
                        }
                      </span>
                      <DistancePill miles={lane.originDistanceMiles} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">
                        {lane.destination
                          ? <>{lane.destination}{lane.destinationState ? <span className="text-muted-foreground">, {lane.destinationState}</span> : null}</>
                          : <span className="text-muted-foreground">{lane.destinationState || "—"}</span>
                        }
                      </span>
                      <DistancePill miles={lane.destDistanceMiles} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <Badge variant="secondary" className="font-semibold">
                        {Math.round(lane.volume).toLocaleString()}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {lane.equipment ? (
                        <span className="flex items-center gap-1.5">
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          {lane.equipment}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                      {lane.miles != null ? `${Math.round(lane.miles).toLocaleString()} mi` : "—"}
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

interface ModeCompanyEntry {
  result: CompanyResult;
  filteredLanes: LaneResult[];
  modeVolume: number;
}

function ModeSectionRfp({
  mode, entries, originQuery, destQuery,
}: {
  mode: string;
  entries: ModeCompanyEntry[];
  originQuery: string;
  destQuery: string;
}) {
  const [open, setOpen] = useState(true);
  const totalLanes = entries.reduce((s, e) => s + e.filteredLanes.length, 0);
  const totalVolume = entries.reduce((s, e) => s + e.modeVolume, 0);

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
          <Badge variant="secondary" className="text-xs">{entries.length} customer{entries.length !== 1 ? "s" : ""}</Badge>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {totalLanes} lane{totalLanes !== 1 ? "s" : ""} · {Math.round(totalVolume).toLocaleString()} loads/yr
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
      </button>
      {open && (
        <div className="space-y-3">
          {entries.map(({ result, filteredLanes }) => (
            <CompanyCard
              key={`${result.companyId}-${result.rfpId}`}
              result={result}
              filteredLanes={filteredLanes}
              originQuery={originQuery}
              destQuery={destQuery}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function RfpLaneSearchPage() {
  const [originInput, setOriginInput] = useState("");
  const [destInput, setDestInput] = useState("");
  const [radiusInput, setRadiusInput] = useState("75");
  const [searchParams, setSearchParams] = useState<{ origin: string; dest: string; radius: number } | null>(null);

  const { data, isLoading, isError } = useQuery<SearchResponse>({
    queryKey: ["/api/rfps/lane-search", searchParams?.origin, searchParams?.dest, searchParams?.radius],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchParams?.origin) params.set("origin", searchParams.origin);
      if (searchParams?.dest) params.set("destination", searchParams.dest);
      params.set("radius", String(searchParams?.radius ?? 75));
      const res = await fetch(`/api/rfps/lane-search?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!searchParams && (!!(searchParams.origin || searchParams.dest)),
  });

  const handleSearch = () => {
    const o = originInput.trim();
    const d = destInput.trim();
    if (!o && !d) return;
    setSearchParams({ origin: o, dest: d, radius: Math.max(1, parseInt(radiusInput) || 75) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter") handleSearch(); };

  // Group results by mode — one company may appear in multiple mode sections
  const modeGroups: { mode: string; entries: ModeCompanyEntry[] }[] = [];
  let totalLanes = 0;
  let totalVolume = 0;

  if (data?.results.length) {
    const groupMap = new Map<string, ModeCompanyEntry[]>();
    for (const result of data.results) {
      // Split this company's lanes by mode, skipping blanks
      const byMode = new Map<string, LaneResult[]>();
      for (const lane of result.matchingLanes) {
        const mode = normalizeMode(lane.equipment);
        if (!mode) continue;
        if (!byMode.has(mode)) byMode.set(mode, []);
        byMode.get(mode)!.push(lane);
        totalLanes++;
        totalVolume += lane.volume || 0;
      }
      for (const [mode, lanes] of byMode.entries()) {
        if (!groupMap.has(mode)) groupMap.set(mode, []);
        groupMap.get(mode)!.push({
          result,
          filteredLanes: lanes,
          modeVolume: lanes.reduce((s, l) => s + (l.volume || 0), 0),
        });
      }
    }
    // Sort each mode's entries by volume desc
    const modes = [...groupMap.keys()].sort(modeSort);
    for (const mode of modes) {
      const entries = groupMap.get(mode)!.sort((a, b) => b.modeVolume - a.modeVolume);
      modeGroups.push({ mode, entries });
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Lane Intelligence tab switcher */}
      <div className="flex items-center gap-1 border-b pb-0 -mb-2">
        <a href="/research-tasks" className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="tab-lane-research">Lane Research</a>
        <a href="/rfp-lane-search" className="px-4 py-2 text-sm font-medium border-b-2 border-amber-500 text-amber-600 dark:text-amber-400 -mb-px" data-testid="tab-rfp-lane-search">RFP Lane Search</a>
        <a href="/carrier-lane-search" className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" data-testid="tab-carrier-lane-search">Carrier Lane Search</a>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">RFP Lane Search</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Search across all uploaded RFPs to find which customers have freight on specific corridors — grouped by mode. Lanes with no mode are excluded.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5 pb-5">
          <div className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Origin</Label>
              <Input
                placeholder="e.g. Chicago, IL or TX"
                value={originInput}
                onChange={e => setOriginInput(e.target.value)}
                onKeyDown={handleKeyDown}
                data-testid="input-lane-origin"
              />
            </div>
            <div className="hidden sm:flex items-center pb-2 text-muted-foreground">→</div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Destination</Label>
              <Input
                placeholder="e.g. Laredo, TX or Laredo"
                value={destInput}
                onChange={e => setDestInput(e.target.value)}
                onKeyDown={handleKeyDown}
                data-testid="input-lane-destination"
              />
            </div>
            <div className="w-28 space-y-1.5 flex-shrink-0">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Circle className="w-3 h-3" /> Radius (mi)
              </Label>
              <Input
                type="number" min="1" max="500"
                value={radiusInput}
                onChange={e => setRadiusInput(e.target.value)}
                onKeyDown={handleKeyDown}
                data-testid="input-lane-radius"
              />
            </div>
            <Button
              onClick={handleSearch}
              disabled={isLoading || (!originInput.trim() && !destInput.trim())}
              className="gap-2 sm:w-auto w-full flex-shrink-0"
              data-testid="button-lane-search"
            >
              <Search className="w-4 h-4" />
              {isLoading ? "Searching…" : "Search"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Results are grouped by mode. Lanes with no mode are excluded. Supports "City, ST", state abbreviation, or city name. Leave either field blank to search one-directionally.
          </p>
        </CardContent>
      </Card>

      {isError && (
        <div className="text-center py-10 text-destructive text-sm" data-testid="error-lane-search">
          Something went wrong. Please try again.
        </div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              {modeGroups.length > 0 ? (
                <>
                  <span>
                    <span className="font-semibold text-foreground">{modeGroups.length}</span> mode{modeGroups.length !== 1 ? "s" : ""},{" "}
                    <span className="font-semibold text-foreground">{totalLanes}</span> lane{totalLanes !== 1 ? "s" : ""},{" "}
                    <span className="font-semibold text-foreground">{Math.round(totalVolume).toLocaleString()}</span> loads/yr
                  </span>
                  <span className="flex items-center gap-1 text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 px-2.5 py-1 rounded-full">
                    <Circle className="w-3 h-3" />
                    {data.radiusMiles} mi buffer
                    {(!data.originGeocoded && data.originQuery) || (!data.destGeocoded && data.destQuery) ? (
                      <span className="text-amber-600 dark:text-amber-400 ml-1">· some used text match</span>
                    ) : null}
                  </span>
                </>
              ) : (
                <span>No lanes with a known mode found within {data.radiusMiles} miles.</span>
              )}
            </div>
            {modeGroups.length > 0 && (
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => exportToCsv(data.results, data.originQuery, data.destQuery, data.radiusMiles)}
                data-testid="button-export-csv"
              >
                <Download className="w-3.5 h-3.5" />Export CSV
              </Button>
            )}
          </div>

          {modeGroups.length === 0 && (
            <div className="text-center py-16 text-muted-foreground" data-testid="empty-lane-search">
              <Route className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No matching lanes found within {data.radiusMiles} miles.</p>
              <p className="text-sm mt-1">Try increasing the radius or broadening your search terms.</p>
            </div>
          )}

          <div className="space-y-5">
            {modeGroups.map(({ mode, entries }) => (
              <ModeSectionRfp
                key={mode}
                mode={mode}
                entries={entries}
                originQuery={data.originQuery}
                destQuery={data.destQuery}
              />
            ))}
          </div>
        </>
      )}

      {!data && !isLoading && (
        <div className="text-center py-20 text-muted-foreground" data-testid="idle-lane-search">
          <Search className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Enter an origin or destination to begin.</p>
          <p className="text-sm mt-1">Results pull from every RFP uploaded in the system, grouped by mode, with a {radiusInput}-mile proximity buffer.</p>
        </div>
      )}
    </div>
  );
}
