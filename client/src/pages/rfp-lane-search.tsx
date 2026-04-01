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

function statusBadgeVariant(status: string) {
  if (status === "won") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (status === "lost") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  if (status === "awarded") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

function exportToCsv(results: CompanyResult[], originQ: string, destQ: string, radius: number) {
  const rows: string[][] = [
    ["Customer", "RFP", "RFP Status", "Lane", "Origin City", "Origin State", "Origin Dist (mi)", "Dest City", "Dest State", "Dest Dist (mi)", "Annual Loads", "Equipment", "Lane Miles"],
  ];
  for (const r of results) {
    for (const lane of r.matchingLanes) {
      rows.push([
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

function CompanyCard({ result, originQuery, destQuery }: { result: CompanyResult; originQuery: string; destQuery: string }) {
  const [expanded, setExpanded] = useState(true);

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
                {result.matchingLanes.length} matching lane{result.matchingLanes.length !== 1 ? "s" : ""}
              </span>
              <span className="flex items-center gap-1">
                <Package className="w-3.5 h-3.5" />
                {Math.round(result.totalMatchVolume).toLocaleString()} loads/yr
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
                {result.matchingLanes.map((lane, idx) => (
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
      const res = await fetch(`/api/rfps/lane-search?${params}`);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!searchParams && (!!(searchParams.origin || searchParams.dest)),
  });

  const handleSearch = () => {
    const o = originInput.trim();
    const d = destInput.trim();
    if (!o && !d) return;
    const r = Math.max(1, parseInt(radiusInput) || 75);
    setSearchParams({ origin: o, dest: d, radius: r });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const totalLanes = data?.results.reduce((s, r) => s + r.matchingLanes.length, 0) ?? 0;
  const totalVolume = data?.results.reduce((s, r) => s + r.totalMatchVolume, 0) ?? 0;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">RFP Lane Search</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Search across all uploaded RFPs to find which customers have freight on specific corridors.
        </p>
      </div>

      {/* Search bar */}
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
                type="number"
                min="1"
                max="500"
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
            The radius buffer matches lanes whose origin or destination city falls within the specified miles of your search location. Leave either field blank to search one-directionally. Supports "City, ST", state abbreviation, or city name.
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
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              {data.results.length > 0 ? (
                <>
                  <span>
                    <span className="font-semibold text-foreground">{data.results.length}</span> customer{data.results.length !== 1 ? "s" : ""},{" "}
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
                <span>No lanes found within {data.radiusMiles} miles of your search.</span>
              )}
            </div>
            {data.results.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => exportToCsv(data.results, data.originQuery, data.destQuery, data.radiusMiles)}
                data-testid="button-export-csv"
              >
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </Button>
            )}
          </div>

          {data.results.length === 0 && (
            <div className="text-center py-16 text-muted-foreground" data-testid="empty-lane-search">
              <Route className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No matching lanes found within {data.radiusMiles} miles.</p>
              <p className="text-sm mt-1">Try increasing the radius or broadening your search terms.</p>
            </div>
          )}

          <div className="space-y-3">
            {data.results.map(result => (
              <CompanyCard
                key={`${result.companyId}-${result.rfpId}`}
                result={result}
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
          <p className="text-sm mt-1">Results pull from every RFP uploaded in the system, with a {radiusInput}-mile proximity buffer.</p>
        </div>
      )}
    </div>
  );
}
