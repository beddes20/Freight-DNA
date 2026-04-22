import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Truck, Search, Download, BookmarkPlus, RefreshCw, ChevronRight, MapPin, Clock, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MoveStatusFilter, type MoveStatus } from "@/components/move-status-filter";
import {
  useCarrierIntelPrefs, useSaveCarrierIntelPrefs,
  colorForUrgency, colorForConfidence,
  fmtCurrency, fmtNum, fmtRpm, fmtDate, downloadCsv,
} from "@/lib/carrier-intelligence";
import { useToast } from "@/hooks/use-toast";

interface RecRow {
  id: string; rank: number; carrierName: string; totalScore: number;
  targetBuyRpm: string | null; pricingConfidence: string;
  coverageUrgency: string;
}
interface LoadRow {
  id: string; orderId: string;
  customerName: string | null;
  originCity: string | null; originState: string | null;
  destinationCity: string | null; destinationState: string | null;
  pickupDate: string | null; deliveryDate: string | null;
  equipmentType: string | null;
  totalMiles: string | null;
  accountManager: string | null;
  bucket: string;
  topRecommendations: RecRow[];
}

export default function CarrierIntelligenceAvailableLoadsPage() {
  const { toast } = useToast();
  const prefsQ = useCarrierIntelPrefs();
  const savePrefs = useSaveCarrierIntelPrefs();
  const userPrefs = prefsQ.data?.user;

  const [moveStatus, setMoveStatus] = useState<MoveStatus[]>(["available"]);
  const [equipment, setEquipment] = useState<string>("");
  const [accountManager, setAccountManager] = useState<string>("");
  const [urgency, setUrgency] = useState<string>("");
  const [search, setSearch] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [initialized, setInitialized] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleUploadFile(file: File) {
    setIsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/freight-opportunities/upload", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `${res.status}` }));
        throw new Error(err.error || `Upload failed (${res.status})`);
      }
      const summary = await res.json();
      toast({
        title: "Available freight imported",
        description: `${summary.inserted ?? 0} new, ${summary.updated ?? 0} updated, ${summary.expired ?? 0} expired${
          summary.unmatchedCompanies ? `, ${summary.unmatchedCompanies} unmatched companies` : ""
        }`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/carrier-intelligence/available-loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities"] });
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (userPrefs && !initialized) {
    setEquipment(userPrefs.availableLoads.equipment ?? "ALL");
    setAccountManager(userPrefs.availableLoads.accountManager ?? "all");
    setUrgency(userPrefs.availableLoads.urgency ?? "all");
    setInitialized(true);
  }

  const { data, isLoading, refetch, isFetching } = useQuery<{ loads: LoadRow[] }>({
    queryKey: ["/api/carrier-intelligence/available-loads"],
  });

  const equipmentOpts = useMemo(() => {
    const set = new Set<string>(["ALL"]);
    (data?.loads ?? []).forEach((l) => set.add(l.equipmentType ?? "UNKNOWN"));
    return Array.from(set);
  }, [data]);
  const amOpts = useMemo(() => {
    const set = new Set<string>(["all"]);
    (data?.loads ?? []).forEach((l) => l.accountManager && set.add(l.accountManager));
    return Array.from(set);
  }, [data]);

  const filtered = useMemo(() => {
    const rows = data?.loads ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((l) => {
      if (equipment && equipment !== "ALL" && l.equipmentType !== equipment) return false;
      if (accountManager && accountManager !== "all" && l.accountManager !== accountManager) return false;
      if (urgency && urgency !== "all") {
        const top = l.topRecommendations[0]?.coverageUrgency;
        if (top !== urgency) return false;
      }
      if (q) {
        const hay = [l.orderId, l.customerName, l.originCity, l.originState, l.destinationCity, l.destinationState]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, search, equipment, accountManager, urgency]);

  function persistFilters() {
    savePrefs.mutate({
      availableLoads: {
        ...(userPrefs?.availableLoads as any),
        equipment, accountManager, urgency,
        sort: "pickup_asc",
        savedViews: userPrefs?.availableLoads.savedViews ?? [],
      },
    });
    toast({ title: "Defaults saved" });
  }
  function saveCurrentView() {
    if (!savedViewName.trim()) return;
    const id = `v_${Date.now()}`;
    const next = [
      ...(userPrefs?.availableLoads.savedViews ?? []),
      { id, name: savedViewName.trim(), payload: { equipment, accountManager, urgency, search } },
    ];
    savePrefs.mutate({
      availableLoads: { ...(userPrefs?.availableLoads as any), savedViews: next },
    } as any);
    setSavedViewName("");
  }
  function applySavedView(id: string) {
    const v = userPrefs?.availableLoads.savedViews.find((x) => x.id === id);
    if (!v) return;
    const p = v.payload as any;
    if (p.equipment) setEquipment(p.equipment);
    if (p.accountManager) setAccountManager(p.accountManager);
    if (p.urgency) setUrgency(p.urgency);
    if (p.search != null) setSearch(p.search);
  }
  function exportCsv() {
    downloadCsv(`available-loads-${new Date().toISOString().slice(0, 10)}.csv`, filtered.map((l) => ({
      OrderId: l.orderId,
      Customer: l.customerName ?? "",
      Origin: `${l.originCity ?? ""}, ${l.originState ?? ""}`,
      Destination: `${l.destinationCity ?? ""}, ${l.destinationState ?? ""}`,
      Equipment: l.equipmentType ?? "",
      Pickup: l.pickupDate ?? "",
      Miles: l.totalMiles ?? "",
      AccountManager: l.accountManager ?? "",
      Urgency: l.topRecommendations[0]?.coverageUrgency ?? "",
      TopCarrier: l.topRecommendations[0]?.carrierName ?? "",
      SuggestedRpm: l.topRecommendations[0]?.targetBuyRpm ?? "",
      Confidence: l.topRecommendations[0]?.pricingConfidence ?? "",
    })));
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1500px] mx-auto" data-testid="page-carrier-intelligence-available-loads">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Truck className="h-6 w-6 text-sky-500" /> Available Loads — Planning Board
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Open freight ranked with a top-3 carrier suggestion and a target buy rate. Click a row to open the full load detail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            data-testid="input-upload-available-loads"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadFile(f);
            }}
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="button-upload-available-loads"
          >
            <Upload className={`h-4 w-4 mr-1 ${isUploading ? "animate-pulse" : ""}`} />
            {isUploading ? "Uploading…" : "Upload Excel"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <MoveStatusFilter
            value={moveStatus}
            onChange={setMoveStatus}
            lockedOn={["available"]}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                placeholder="Search order, lane, customer…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                data-testid="input-search-loads"
              />
            </div>
            <Select value={equipment || "ALL"} onValueChange={setEquipment}>
              <SelectTrigger data-testid="select-equipment"><SelectValue placeholder="Equipment" /></SelectTrigger>
              <SelectContent>{equipmentOpts.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={accountManager || "all"} onValueChange={setAccountManager}>
              <SelectTrigger data-testid="select-account-manager"><SelectValue placeholder="Account Manager" /></SelectTrigger>
              <SelectContent>
                {amOpts.map((a) => <SelectItem key={a} value={a}>{a === "all" ? "All AMs" : a}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={urgency || "all"} onValueChange={setUrgency}>
              <SelectTrigger data-testid="select-urgency"><SelectValue placeholder="Urgency" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any urgency</SelectItem>
                <SelectItem value="red">Red (≤24h)</SelectItem>
                <SelectItem value="yellow">Yellow (≤72h)</SelectItem>
                <SelectItem value="green">Green</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="secondary" size="sm" onClick={persistFilters} data-testid="button-save-defaults">Save as my defaults</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Input
              placeholder="Saved view name…"
              value={savedViewName}
              onChange={(e) => setSavedViewName(e.target.value)}
              className="w-48 h-8 text-sm"
              data-testid="input-saved-view-name"
            />
            <Button size="sm" variant="outline" onClick={saveCurrentView} disabled={!savedViewName.trim()} data-testid="button-save-view">
              <BookmarkPlus className="h-3.5 w-3.5 mr-1" /> Save view
            </Button>
            {(userPrefs?.availableLoads.savedViews ?? []).map((v) => (
              <Badge key={v.id} variant="outline" className="cursor-pointer hover:bg-accent" onClick={() => applySavedView(v.id)} data-testid={`chip-saved-view-${v.id}`}>
                {v.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">Loads ({fmtNum(filtered.length)})</CardTitle>
          <CardDescription>Top 3 suggested carriers and target buy rate per load.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="table-available-loads">
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Lane</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Pickup</TableHead>
                    <TableHead>Equip</TableHead>
                    <TableHead>Urgency</TableHead>
                    <TableHead>Suggested carriers</TableHead>
                    <TableHead className="text-right">Target $/mi</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8" data-testid="text-no-rows">No open loads match these filters.</TableCell></TableRow>
                  ) : filtered.map((l) => {
                    const top = l.topRecommendations[0];
                    return (
                      <TableRow key={l.id} className="hover-elevate" data-testid={`row-load-${l.id}`}>
                        <TableCell className="font-mono text-xs">{l.orderId}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-muted-foreground" />
                            {l.originCity ?? "—"}, {l.originState ?? ""}
                            <ChevronRight className="h-3 w-3 mx-0.5 text-muted-foreground" />
                            {l.destinationCity ?? "—"}, {l.destinationState ?? ""}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate">{l.customerName ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3 text-muted-foreground" />{fmtDate(l.pickupDate)}</span>
                        </TableCell>
                        <TableCell>{l.equipmentType ?? "—"}</TableCell>
                        <TableCell>
                          {top ? (
                            <Badge variant="outline" className={colorForUrgency(top.coverageUrgency)} data-testid={`badge-urgency-${l.id}`}>
                              {top.coverageUrgency.toUpperCase()}
                            </Badge>
                          ) : <span className="text-muted-foreground text-xs">—</span>}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-[280px]">
                            {l.topRecommendations.length === 0 && <span className="text-muted-foreground text-xs">No suggestion yet</span>}
                            {l.topRecommendations.slice(0, 3).map((r) => (
                              <Badge key={r.id} variant="outline" className="text-xs" data-testid={`chip-rec-${r.id}`}>
                                {r.carrierName} <span className="ml-1 text-muted-foreground tabular-nums">{r.totalScore}</span>
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {top?.targetBuyRpm ? (
                            <div className="inline-flex items-center gap-2">
                              <span>{fmtRpm(Number(top.targetBuyRpm))}</span>
                              <Badge variant="outline" className={colorForConfidence(top.pricingConfidence)} data-testid={`badge-confidence-${l.id}`}>
                                {top.pricingConfidence}
                              </Badge>
                            </div>
                          ) : "—"}
                        </TableCell>
                        <TableCell>
                          <Link href={`/available-freight/${l.orderId}`} data-testid={`link-load-${l.id}`}>
                            <Button size="sm" variant="ghost">Open</Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
