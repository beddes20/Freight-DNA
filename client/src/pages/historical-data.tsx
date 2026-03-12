import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MapPin, Flame, TrendingUp, Package, Search,
  Upload, FileSpreadsheet, Loader2, Trash2, History,
} from "lucide-react";

type DestSummary = {
  destination: string;
  city: string;
  state: string;
  totalLoads: number;
  avgWeekly: number;
  maxWeekly: number;
  weekCount: number;
  isHotZone: boolean;
};

type SummaryResponse = {
  summary: DestSummary[];
  totalRows: number;
  uploadCount: number;
};

type UploadMeta = { id: string; fileName: string; uploadedAt: string; rowCount: number };

export default function HistoricalData() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const [search, setSearch] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/historical-data-summary"],
  });

  const { data: uploads = [], isLoading: uploadsLoading } = useQuery<UploadMeta[]>({
    queryKey: ["/api/financials/uploads"],
    enabled: isAdmin,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/financials/upload", { method: "POST", body: formData });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
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
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const filtered = (data?.summary || []).filter(d =>
    d.destination.toLowerCase().includes(search.toLowerCase())
  );

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
          Upload dispatch spreadsheets to analyze delivery destination frequency and identify hot zones.
        </p>
      </div>

      {/* Upload dropzone */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            Upload Dispatch Data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
              isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            data-testid="dropzone-historical"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
              data-testid="input-historical-file"
            />
            {uploadMutation.isPending ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <p className="text-sm font-medium">Analyzing your data...</p>
                <p className="text-xs text-muted-foreground">Computing delivery patterns and hot zones</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <FileSpreadsheet className="h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm font-medium">Drop your spreadsheet here</p>
                <p className="text-xs text-muted-foreground">
                  Supports .xlsx, .xls, .csv · Needs "Consignee city", "Consignee state", "Date ordered" columns
                </p>
              </div>
            )}
          </div>

          {/* Uploaded files list (admin only) */}
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
                        <p className="text-xs text-muted-foreground">
                          {u.rowCount.toLocaleString()} rows · {new Date(u.uploadedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate(u.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-upload-${u.id}`}
                    >
                      {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Analysis results */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : !data || data.totalRows === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium text-muted-foreground">No data analyzed yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Drop a spreadsheet above to see delivery patterns and hot zones.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Loads</p>
                <p className="text-2xl font-bold mt-1" data-testid="stat-total-loads">{data.totalRows.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Unique Destinations</p>
                <p className="text-2xl font-bold mt-1" data-testid="stat-unique-destinations">{data.summary.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Flame className="h-3 w-3 text-orange-500" /> Hot Zones
                </p>
                <p className="text-2xl font-bold mt-1 text-orange-500" data-testid="stat-hot-zones">
                  {data.summary.filter(d => d.isHotZone).length}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Search filter */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              data-testid="input-destination-search"
              placeholder="Filter destinations..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Hot zones */}
          {hotZones.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-orange-500" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-orange-500">Hot Zones — 5+ loads/week</h2>
              </div>
              <Card>
                <div className="divide-y">
                  {hotZones.map((dest, i) => (
                    <div
                      key={dest.destination}
                      data-testid={`row-hot-zone-${i}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-5 text-right">{i + 1}</span>
                        <MapPin className="h-4 w-4 text-orange-500 flex-shrink-0" />
                        <div>
                          <p className="font-medium text-sm" data-testid={`text-destination-${i}`}>{dest.destination}</p>
                          <p className="text-xs text-muted-foreground">
                            {dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm font-semibold text-orange-500" data-testid={`text-avg-weekly-${i}`}>
                            {dest.avgWeekly} avg/wk
                          </p>
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

          {/* All other destinations */}
          {others.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">All Destinations</h2>
              </div>
              <Card>
                <div className="divide-y">
                  {others.map((dest, i) => (
                    <div
                      key={dest.destination}
                      data-testid={`row-destination-${i}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-5 text-right">{hotZones.length + i + 1}</span>
                        <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div>
                          <p className="font-medium text-sm">{dest.destination}</p>
                          <p className="text-xs text-muted-foreground">
                            {dest.totalLoads.toLocaleString()} total loads · {dest.weekCount} weeks of data
                          </p>
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
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground text-sm">No destinations match &ldquo;{search}&rdquo;</p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
