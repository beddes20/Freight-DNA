import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search, Building2, Truck, Route, Package, ChevronDown, ChevronUp, Download } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface LaneResult {
  lane: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  volume: number;
  equipment: string;
  miles: number | null;
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
}

function statusBadgeVariant(status: string) {
  if (status === "won") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (status === "lost") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  if (status === "awarded") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

function exportToCsv(results: CompanyResult[], originQ: string, destQ: string) {
  const rows: string[][] = [
    ["Customer", "RFP", "RFP Status", "Lane", "Origin City", "Origin State", "Dest City", "Dest State", "Annual Loads", "Equipment", "Miles"],
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
        lane.destination,
        lane.destinationState,
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
  a.download = `lane-search-${parts || "results"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function CompanyCard({ result }: { result: CompanyResult }) {
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
        <div className="flex items-center gap-2 flex-shrink-0 ml-4">
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-2.5 font-medium">Origin</th>
                  <th className="text-left px-4 py-2.5 font-medium">Destination</th>
                  <th className="text-right px-4 py-2.5 font-medium">Loads/yr</th>
                  <th className="text-left px-4 py-2.5 font-medium">Equipment</th>
                  <th className="text-right px-5 py-2.5 font-medium">Miles</th>
                </tr>
              </thead>
              <tbody>
                {result.matchingLanes.map((lane, idx) => (
                  <tr
                    key={idx}
                    className="border-t border-border/50 hover:bg-muted/20 transition-colors"
                    data-testid={`row-lane-${result.rfpId}-${idx}`}
                  >
                    <td className="px-5 py-3 font-medium">
                      {lane.origin
                        ? <>{lane.origin}{lane.originState ? <span className="text-muted-foreground">, {lane.originState}</span> : null}</>
                        : <span className="text-muted-foreground">{lane.originState || "—"}</span>
                      }
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {lane.destination
                        ? <>{lane.destination}{lane.destinationState ? <span className="text-muted-foreground">, {lane.destinationState}</span> : null}</>
                        : <span className="text-muted-foreground">{lane.destinationState || "—"}</span>
                      }
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
  const [searchParams, setSearchParams] = useState<{ origin: string; dest: string } | null>(null);

  const { data, isLoading, isError } = useQuery<SearchResponse>({
    queryKey: ["/api/rfps/lane-search", searchParams?.origin, searchParams?.dest],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchParams?.origin) params.set("origin", searchParams.origin);
      if (searchParams?.dest) params.set("destination", searchParams.dest);
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
    setSearchParams({ origin: o, dest: d });
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
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Origin</label>
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
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Destination</label>
              <Input
                placeholder="e.g. Laredo, TX or Laredo"
                value={destInput}
                onChange={e => setDestInput(e.target.value)}
                onKeyDown={handleKeyDown}
                data-testid="input-lane-destination"
              />
            </div>
            <Button
              onClick={handleSearch}
              disabled={isLoading || (!originInput.trim() && !destInput.trim())}
              className="gap-2 sm:w-auto w-full"
              data-testid="button-lane-search"
            >
              <Search className="w-4 h-4" />
              {isLoading ? "Searching…" : "Search"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Leave Origin blank to search all inbound freight. Leave Destination blank to search all outbound. Both fields support partial text (city, state abbreviation, or full "City, ST").
          </p>
        </CardContent>
      </Card>

      {/* Results */}
      {isError && (
        <div className="text-center py-10 text-destructive text-sm" data-testid="error-lane-search">
          Something went wrong. Please try again.
        </div>
      )}

      {data && (
        <>
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              {data.results.length > 0 ? (
                <>
                  <span>
                    Found <span className="font-semibold text-foreground">{data.results.length}</span> customer{data.results.length !== 1 ? "s" : ""}
                    {" "}with <span className="font-semibold text-foreground">{totalLanes}</span> matching lane{totalLanes !== 1 ? "s" : ""}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>
                    <span className="font-semibold text-foreground">{Math.round(totalVolume).toLocaleString()}</span> combined loads/yr
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="italic">
                    {data.originQuery && data.destQuery
                      ? `"${data.originQuery}" → "${data.destQuery}"`
                      : data.originQuery
                        ? `from "${data.originQuery}"`
                        : `into "${data.destQuery}"`}
                  </span>
                </>
              ) : (
                <span>No lanes found matching your search.</span>
              )}
            </div>
            {data.results.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => exportToCsv(data.results, data.originQuery, data.destQuery)}
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
              <p className="font-medium">No matching lanes found.</p>
              <p className="text-sm mt-1">Try a broader search — use just a city name or state abbreviation.</p>
            </div>
          )}

          <div className="space-y-3">
            {data.results.map(result => (
              <CompanyCard key={`${result.companyId}-${result.rfpId}`} result={result} />
            ))}
          </div>
        </>
      )}

      {!data && !isLoading && (
        <div className="text-center py-20 text-muted-foreground" data-testid="idle-lane-search">
          <Search className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="font-medium">Enter an origin or destination to begin.</p>
          <p className="text-sm mt-1">Results are pulled from every RFP file uploaded in the system.</p>
        </div>
      )}
    </div>
  );
}
