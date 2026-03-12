import "leaflet/dist/leaflet.css";
import type * as L from "leaflet";
import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MapPin, Flame, TrendingUp, Package, Search, Compass,
  Upload, FileSpreadsheet, Loader2, Trash2, History, Map, Target, ArrowRight, Building2, User,
  ArrowDownToLine, ArrowUpFromLine, Layers,
} from "lucide-react";
// ─── Types ────────────────────────────────────────────────────────────────────
type DestSummary = { destination: string; city: string; state: string; totalLoads: number; avgWeekly: number; maxWeekly: number; weekCount: number; isHotZone: boolean };
type SummaryResponse = { summary: DestSummary[]; totalRows: number; uploadCount: number };
type UploadMeta = { id: string; fileName: string; uploadedAt: string; rowCount: number };
type Corridor = { origin: string; destination: string; originCity: string; originState: string; destCity: string; destState: string; loads: number };
type HeatmapPoint = { city: string; state: string; lat: number; lng: number; count: number };
type HeatmapResponse = { deliveries: HeatmapPoint[]; pickups: HeatmapPoint[] };
type ProximityMatch = { companyId: string; companyName: string; rfpTitle: string; origin: string; destination: string; volume: number; distance: number; assignedName: string };
type ProximityZone = { zone: string; city: string; state: string; lat: number; lng: number; weeklyLoads: number; totalLoads: number; matchCount: number; matches: ProximityMatch[] };

// ─── Leaflet Map Component ────────────────────────────────────────────────────
type MapMode = "inbound" | "both" | "outbound";

function DeliveryMap({ data, mode }: { data: HeatmapResponse; mode: MapMode }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const deliveryLayerRef = useRef<L.LayerGroup | null>(null);
  const pickupLayerRef = useRef<L.LayerGroup | null>(null);
  const modeRef = useRef<MapMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    import("leaflet").then((leaflet) => {
      Object.assign(window, { L: leaflet });
      // @ts-expect-error leaflet.heat is a UMD plugin with no published type definitions
      return import("leaflet.heat").then(() => leaflet);
    }).then((L) => {
      if (!mapRef.current || mapInstanceRef.current) return;

      delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
      L.Icon.Default.mergeOptions({ iconUrl: "", shadowUrl: "" });

      const map = L.map(mapRef.current, { center: [39.5, -98.35], zoom: 4, zoomControl: true });
      mapInstanceRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map);

      const heatGradient = { 0.15: "#0000ff", 0.3: "#6a5acd", 0.45: "#00bfff", 0.6: "#00ff80", 0.75: "#ffff00", 0.9: "#ff8c00", 1.0: "#ff0000" };

      const maxDeliv = Math.max(...data.deliveries.map(d => d.count), 1);
      const deliveryHeatPoints: [number, number, number][] = data.deliveries.map(pt => [pt.lat, pt.lng, pt.count / maxDeliv]);
      const deliveryHeat = L.heatLayer(deliveryHeatPoints, {
        radius: 35, blur: 25, maxZoom: 10, max: 1.0, gradient: heatGradient,
      });

      const deliveryDots = L.layerGroup();
      data.deliveries.forEach(pt => {
        L.circleMarker([pt.lat, pt.lng], {
          radius: 3, color: "#6b7280", fill: false, weight: 1, opacity: 0.6,
        }).bindTooltip(`<b>${pt.city}, ${pt.state}</b><br/>📦 ${pt.count.toLocaleString()} deliveries`, { sticky: true }).addTo(deliveryDots);
      });

      const deliveryGroup = L.layerGroup([deliveryHeat, deliveryDots]);
      deliveryLayerRef.current = deliveryGroup;

      const maxPickup = Math.max(...data.pickups.map(p => p.count), 1);
      const pickupHeatPoints: [number, number, number][] = data.pickups.map(pt => [pt.lat, pt.lng, pt.count / maxPickup]);
      const pickupHeat = L.heatLayer(pickupHeatPoints, {
        radius: 30, blur: 20, maxZoom: 10, max: 1.0, gradient: heatGradient,
      });

      const pickupDots = L.layerGroup();
      data.pickups.forEach(pt => {
        L.circleMarker([pt.lat, pt.lng], {
          radius: 3, color: "#6b7280", fill: false, weight: 1, opacity: 0.6,
        }).bindTooltip(`<b>${pt.city}, ${pt.state}</b><br/>🚚 ${pt.count.toLocaleString()} pickups`, { sticky: true }).addTo(pickupDots);
      });

      const pickupGroup = L.layerGroup([pickupHeat, pickupDots]);
      pickupLayerRef.current = pickupGroup;

      const currentMode = modeRef.current;
      if (currentMode === "inbound" || currentMode === "both") deliveryGroup.addTo(map);
      if (currentMode === "outbound" || currentMode === "both") pickupGroup.addTo(map);
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        deliveryLayerRef.current = null;
        pickupLayerRef.current = null;
      }
    };
  }, [data]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const dl = deliveryLayerRef.current;
    const pl = pickupLayerRef.current;
    if (!map || !dl || !pl) return;

    const showInbound = mode === "inbound" || mode === "both";
    const showOutbound = mode === "outbound" || mode === "both";

    if (showInbound) {
      if (!map.hasLayer(dl)) dl.addTo(map);
    } else {
      if (map.hasLayer(dl)) dl.remove();
    }

    if (showOutbound) {
      if (!map.hasLayer(pl)) pl.addTo(map);
    } else {
      if (map.hasLayer(pl)) pl.remove();
    }
  }, [mode]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 text-sm">
        {(mode === "inbound" || mode === "both") && (
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-500 inline-block" />
            <span className="text-muted-foreground">Inbound (deliveries) — {data.deliveries.length} cities</span>
          </div>
        )}
        {(mode === "outbound" || mode === "both") && (
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
            <span className="text-muted-foreground">Outbound (pickups) — {data.pickups.length} cities</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="inline-block w-20 h-3 rounded-sm" style={{ background: "linear-gradient(90deg, #0000ff, #6a5acd, #00bfff, #00ff80, #ffff00, #ff8c00, #ff0000)" }} />
          <span className="text-muted-foreground text-xs">Low → High density</span>
        </div>
      </div>
      <div ref={mapRef} style={{ height: 520, width: "100%", borderRadius: 8, zIndex: 0 }} className="border" data-testid="map-heatmap" />
    </div>
  );
}

// ─── Lane Corridors Tab ───────────────────────────────────────────────────────
function LaneCorridorsTab() {
  const [search, setSearch] = useState("");
  const { data: corridors = [], isLoading } = useQuery<Corridor[]>({ queryKey: ["/api/historical-lane-corridors"] });

  const filtered = corridors.filter(c =>
    c.origin.toLowerCase().includes(search.toLowerCase()) ||
    c.destination.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) return <div className="space-y-3">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (!corridors.length) return (
    <Card><CardContent className="py-16 text-center">
      <Compass className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
      <p className="font-medium text-muted-foreground">No corridor data yet</p>
      <p className="text-sm text-muted-foreground mt-1">Upload dispatch spreadsheets to see lane patterns.</p>
    </CardContent></Card>
  );

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Filter by origin or destination..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" data-testid="input-corridor-search" />
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-8">#</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Origin</th>
                <th className="text-center px-2 py-3 font-medium text-muted-foreground w-6" />
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Destination</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total Loads</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((c, i) => (
                <tr key={`${c.origin}-${c.destination}`} className="hover:bg-muted/30 transition-colors" data-testid={`row-corridor-${i}`}>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{i + 1}</td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{c.originCity}</span>
                    <span className="text-muted-foreground ml-1 text-xs">{c.originState}</span>
                  </td>
                  <td className="px-2 py-3 text-muted-foreground"><ArrowRight className="h-3 w-3" /></td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{c.destCity}</span>
                    <span className="text-muted-foreground ml-1 text-xs">{c.destState}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-semibold tabular-nums">{c.loads.toLocaleString()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">No corridors match &ldquo;{search}&rdquo;</div>
        )}
      </Card>
    </div>
  );
}

// ─── Map Tab ──────────────────────────────────────────────────────────────────
function MapTab() {
  const [mapMode, setMapMode] = useState<MapMode>("both");
  const { data, isLoading, isError, error, refetch } = useQuery<HeatmapResponse>({
    queryKey: ["/api/historical-heatmap"],
    staleTime: 0,
    retry: 1,
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  if (isError) return (
    <Card><CardContent className="py-16 text-center">
      <Map className="h-10 w-10 text-destructive mx-auto mb-3" />
      <p className="font-medium">Failed to load map data</p>
      <p className="text-sm text-muted-foreground mt-1">{(error as any)?.message || "Unknown error"}</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>Retry</Button>
    </CardContent></Card>
  );

  if (!data || (data.deliveries.length === 0 && data.pickups.length === 0)) return (
    <Card><CardContent className="py-16 text-center">
      <Map className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
      <p className="font-medium text-muted-foreground">No map data yet</p>
      <p className="text-sm text-muted-foreground mt-1">Upload dispatch data to visualize delivery and pickup density.</p>
    </CardContent></Card>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex rounded-lg border overflow-hidden text-sm">
          <button
            onClick={() => setMapMode("inbound")}
            className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${mapMode === "inbound" ? "bg-blue-600 text-white" : "hover:bg-muted text-muted-foreground"}`}
            data-testid="btn-map-inbound"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Inbound
          </button>
          <button
            onClick={() => setMapMode("both")}
            className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-x ${mapMode === "both" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
            data-testid="btn-map-both"
          >
            <Layers className="h-3.5 w-3.5" />
            Both
          </button>
          <button
            onClick={() => setMapMode("outbound")}
            className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${mapMode === "outbound" ? "bg-green-600 text-white" : "hover:bg-muted text-muted-foreground"}`}
            data-testid="btn-map-outbound"
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Outbound
          </button>
        </div>
      </div>
      <DeliveryMap data={data} mode={mapMode} />
    </div>
  );
}

// ─── Proximity Matches Tab ────────────────────────────────────────────────────
function ProximityMatchesTab() {
  const [expandedZone, setExpandedZone] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { data: zones = [], isLoading } = useQuery<ProximityZone[]>({ queryKey: ["/api/proximity-matches"] });

  const filtered = zones.filter(z =>
    z.zone.toLowerCase().includes(search.toLowerCase()) ||
    z.matches.some(m => m.companyName.toLowerCase().includes(search.toLowerCase()) || m.assignedName.toLowerCase().includes(search.toLowerCase()))
  );

  if (isLoading) return <div className="space-y-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  if (!zones.length) return (
    <Card><CardContent className="py-16 text-center">
      <Target className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
      <p className="font-medium text-muted-foreground">No proximity matches yet</p>
      <p className="text-sm text-muted-foreground mt-1">Upload both historical dispatch data and add RFPs with lane data to see matches within 75 miles.</p>
    </CardContent></Card>
  );

  const totalMatches = zones.reduce((sum, z) => sum + z.matchCount, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card><CardContent className="pt-4 pb-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Delivery Zones with Nearby Customers</p>
          <p className="text-2xl font-bold mt-1" data-testid="stat-proximity-zones">{zones.length}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total RFP Lane Matches</p>
          <p className="text-2xl font-bold mt-1 text-primary" data-testid="stat-proximity-matches">{totalMatches}</p>
        </CardContent></Card>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Filter by zone, company, or rep..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" data-testid="input-proximity-search" />
      </div>

      <p className="text-xs text-muted-foreground">
        Showing delivery zones where we drop trucks that are within <strong>75 miles</strong> of a customer RFP pickup origin.
      </p>

      <div className="space-y-3">
        {filtered.map((zone) => {
          const isOpen = expandedZone === zone.zone;
          return (
            <Card key={zone.zone} className="overflow-hidden" data-testid={`card-proximity-zone-${zone.zone}`}>
              <button
                className="w-full text-left px-4 py-4 hover:bg-muted/30 transition-colors"
                onClick={() => setExpandedZone(isOpen ? null : zone.zone)}
                data-testid={`button-expand-zone-${zone.zone}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <MapPin className={`h-4 w-4 shrink-0 ${zone.weeklyLoads >= 5 ? "text-orange-500" : "text-primary"}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{zone.zone}</p>
                        {zone.weeklyLoads >= 5 && (
                          <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0 text-xs">
                            <Flame className="h-2.5 w-2.5 mr-1" /> Hot Zone
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {zone.weeklyLoads} avg loads/week · {zone.matchCount} nearby customer lane{zone.matchCount !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="secondary" className="tabular-nums font-semibold">
                      {zone.matchCount} match{zone.matchCount !== 1 ? "es" : ""}
                    </Badge>
                    <span className="text-muted-foreground text-xs">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>
              </button>

              {isOpen && (
                <div className="border-t divide-y">
                  {zone.matches.map((m, mi) => (
                    <div key={mi} className="px-4 py-3 hover:bg-muted/20 transition-colors" data-testid={`row-proximity-match-${zone.zone}-${mi}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="font-medium text-sm">{m.companyName}</span>
                            <Badge variant="outline" className="text-xs">{m.rfpTitle}</Badge>
                          </div>
                          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span>{m.origin}</span>
                            <ArrowRight className="h-3 w-3" />
                            <span>{m.destination}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><User className="h-3 w-3" />{m.assignedName}</span>
                            {m.volume > 0 && <span>{m.volume.toLocaleString()} loads/yr</span>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-primary">{m.distance} mi</p>
                          <p className="text-xs text-muted-foreground">away</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {filtered.length === 0 && search && (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
          No matches found for &ldquo;{search}&rdquo;
        </CardContent></Card>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function HistoricalData() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const [search, setSearch] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<SummaryResponse>({ queryKey: ["/api/historical-data-summary"] });
  const { data: uploads = [], isLoading: uploadsLoading } = useQuery<UploadMeta[]>({ queryKey: ["/api/financials/uploads"], enabled: isAdmin });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/financials/upload", { method: "POST", body: formData });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || "Upload failed"); }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
      toast({ title: "Upload successful", description: "Historical data has been analyzed." });
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`/api/financials/uploads/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
      toast({ title: "Upload deleted" });
    },
  });

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast({ title: "Invalid file type", description: "Please upload an Excel or CSV file.", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0]; if (file) handleFile(file);
  }, [handleFile]);

  const filtered = (data?.summary || []).filter(d => d.destination.toLowerCase().includes(search.toLowerCase()));
  const hotZones = filtered.filter(d => d.isHotZone);
  const others = filtered.filter(d => !d.isHotZone);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <History className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Historical Data</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Upload dispatch spreadsheets to analyze delivery patterns, lane corridors, and proximity opportunities.
        </p>
      </div>

      {/* Upload zone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />Upload Dispatch Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            data-testid="dropzone-historical"
          >
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
              data-testid="input-historical-file" />
            {uploadMutation.isPending ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm font-medium">Analyzing your data...</p>
                <p className="text-xs text-muted-foreground">Computing delivery patterns, corridors, and hot zones</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <FileSpreadsheet className="h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm font-medium">Drop your spreadsheet here</p>
                <p className="text-xs text-muted-foreground">Supports .xlsx, .xls, .csv · Needs "Consignee city", "Consignee state", "Shipper city", "Shipper state", "Date ordered" columns</p>
              </div>
            )}
          </div>

          {isAdmin && !uploadsLoading && uploads.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Uploaded Files</p>
              <div className="divide-y rounded-lg border">
                {uploads.map(u => (
                  <div key={u.id} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileSpreadsheet className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" data-testid={`text-upload-name-${u.id}`}>{u.fileName}</p>
                        <p className="text-xs text-muted-foreground">{u.rowCount.toLocaleString()} rows · {new Date(u.uploadedAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate(u.id)} disabled={deleteMutation.isPending} data-testid={`button-delete-upload-${u.id}`}>
                      {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="overview" className="flex items-center gap-1.5" data-testid="tab-overview">
            <Flame className="h-3.5 w-3.5" />Overview
          </TabsTrigger>
          <TabsTrigger value="corridors" className="flex items-center gap-1.5" data-testid="tab-corridors">
            <Compass className="h-3.5 w-3.5" />Lane Corridors
          </TabsTrigger>
          <TabsTrigger value="map" className="flex items-center gap-1.5" data-testid="tab-map">
            <Map className="h-3.5 w-3.5" />Density Map
          </TabsTrigger>
          <TabsTrigger value="proximity" className="flex items-center gap-1.5" data-testid="tab-proximity">
            <Target className="h-3.5 w-3.5" />Proximity
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          {isLoading ? (
            <div className="space-y-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : !data || data.totalRows === 0 ? (
            <Card><CardContent className="py-16 text-center">
              <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-muted-foreground">No data analyzed yet</p>
              <p className="text-sm text-muted-foreground mt-1">Drop a spreadsheet above to see delivery patterns and hot zones.</p>
            </CardContent></Card>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Card><CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Loads</p>
                  <p className="text-2xl font-bold mt-1" data-testid="stat-total-loads">{data.totalRows.toLocaleString()}</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Unique Destinations</p>
                  <p className="text-2xl font-bold mt-1" data-testid="stat-unique-destinations">{data.summary.length}</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Flame className="h-3 w-3 text-orange-500" /> Hot Zones
                  </p>
                  <p className="text-2xl font-bold mt-1 text-orange-500" data-testid="stat-hot-zones">
                    {data.summary.filter(d => d.isHotZone).length}
                  </p>
                </CardContent></Card>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input data-testid="input-destination-search" placeholder="Filter destinations..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
              </div>

              {hotZones.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Flame className="h-4 w-4 text-orange-500" />
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-orange-500">Hot Zones — 5+ loads/week</h2>
                  </div>
                  <Card>
                    <div className="divide-y">
                      {hotZones.map((dest, i) => (
                        <div key={dest.destination} data-testid={`row-hot-zone-${i}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors">
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-muted-foreground w-5 text-right">{i + 1}</span>
                            <MapPin className="h-4 w-4 text-orange-500 flex-shrink-0" />
                            <div>
                              <p className="font-medium text-sm" data-testid={`text-destination-${i}`}>{dest.destination}</p>
                              <p className="text-xs text-muted-foreground">{dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <p className="text-sm font-semibold text-orange-500" data-testid={`text-avg-weekly-${i}`}>{dest.avgWeekly} avg/wk</p>
                              <p className="text-xs text-muted-foreground">peak {dest.maxWeekly}/wk</p>
                            </div>
                            <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0">
                              <Flame className="h-3 w-3 mr-1" /> Hot
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              )}

              {others.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All Destinations</h2>
                  </div>
                  <Card>
                    <div className="divide-y">
                      {others.map((dest, i) => (
                        <div key={dest.destination} data-testid={`row-destination-${i}`}
                          className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors">
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-muted-foreground w-5 text-right">{hotZones.length + i + 1}</span>
                            <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <div>
                              <p className="font-medium text-sm">{dest.destination}</p>
                              <p className="text-xs text-muted-foreground">{dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold">{dest.avgWeekly} avg/wk</p>
                            <p className="text-xs text-muted-foreground">peak {dest.maxWeekly}/wk</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              )}

              {filtered.length === 0 && search && (
                <Card><CardContent className="py-12 text-center">
                  <p className="text-muted-foreground text-sm">No destinations match &ldquo;{search}&rdquo;</p>
                </CardContent></Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Lane Corridors Tab */}
        <TabsContent value="corridors"><LaneCorridorsTab /></TabsContent>

        {/* Density Map Tab */}
        <TabsContent value="map"><MapTab /></TabsContent>

        {/* Proximity Matches Tab */}
        <TabsContent value="proximity"><ProximityMatchesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
