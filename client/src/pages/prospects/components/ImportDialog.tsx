import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Upload, FileUp, Download, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

const IMPORT_FIELDS = [
  { key: "name",               label: "Company Name *",          required: true  },
  { key: "industry",           label: "Industry",                required: false },
  { key: "estimatedSpend",     label: "Est. Freight Spend",      required: false },
  { key: "estimatedAnnualRevenue", label: "Est. Annual Revenue", required: false },
  { key: "employeeCount",      label: "Employee Count",          required: false },
  { key: "primaryContactName", label: "Contact 1 Name",          required: false },
  { key: "primaryContactTitle",label: "Contact 1 Title",         required: false },
  { key: "primaryContactEmail",label: "Contact 1 Email",         required: false },
  { key: "primaryContactPhone",label: "Contact 1 Phone",         required: false },
  { key: "contact2Name",       label: "Contact 2 Name",          required: false },
  { key: "contact2Title",      label: "Contact 2 Title",         required: false },
  { key: "contact2Email",      label: "Contact 2 Email",         required: false },
  { key: "contact2Phone",      label: "Contact 2 Phone",         required: false },
  { key: "contact3Name",       label: "Contact 3 Name",          required: false },
  { key: "contact3Title",      label: "Contact 3 Title",         required: false },
  { key: "contact3Email",      label: "Contact 3 Email",         required: false },
  { key: "website",            label: "Website",                 required: false },
  { key: "currentCarrier",     label: "Current Carrier",         required: false },
  { key: "topLanes",           label: "Top Lanes",               required: false },
  { key: "commodity",          label: "Commodity",               required: false },
  { key: "notes",              label: "Notes",                   required: false },
] as const;

type ImportFieldKey = typeof IMPORT_FIELDS[number]["key"];

const HEADER_SYNONYMS: Record<ImportFieldKey, string[]> = {
  name:                ["company", "company name", "account", "organization", "business", "account name"],
  industry:            ["industry", "sector", "vertical", "market"],
  estimatedSpend:      ["spend", "freight spend", "monthly spend", "estimated spend", "budget", "est spend"],
  estimatedAnnualRevenue: ["revenue", "annual revenue", "estimated annual revenue", "est revenue", "est. annual revenue", "total revenue"],
  employeeCount:       ["employees", "employee count", "headcount", "# employees", "num employees", "employee size"],
  primaryContactName:  ["contact 1 name", "contact name", "primary contact", "first contact", "contact first name", "contact full name"],
  primaryContactTitle: ["contact 1 title", "contact title", "job title", "position"],
  primaryContactEmail: ["contact 1 email", "contact email", "email", "e-mail"],
  primaryContactPhone: ["contact 1 phone", "contact phone", "phone", "phone number"],
  contact2Name:        ["contact 2 name", "second contact name", "contact 2"],
  contact2Title:       ["contact 2 title", "second contact title"],
  contact2Email:       ["contact 2 email", "second contact email"],
  contact2Phone:       ["contact 2 phone", "second contact phone"],
  contact3Name:        ["contact 3 name", "third contact name", "contact 3"],
  contact3Title:       ["contact 3 title", "third contact title"],
  contact3Email:       ["contact 3 email", "third contact email"],
  website:             ["website", "url", "web", "site", "domain", "company website"],
  currentCarrier:      ["carrier", "current carrier", "incumbent", "current broker", "broker"],
  topLanes:            ["lanes", "top lanes", "routes", "corridors", "freight lanes"],
  commodity:           ["commodity", "product", "freight type", "product type", "goods", "cargo"],
  notes:               ["notes", "comments", "note", "description", "remarks"],
};

function autoDetectMapping(headers: string[]): Record<string, string> {
  const norm = headers.map(h => h.toLowerCase().trim());
  const mapping: Record<string, string> = {};
  IMPORT_FIELDS.forEach(f => {
    for (const syn of HEADER_SYNONYMS[f.key]) {
      const idx = norm.indexOf(syn);
      if (idx !== -1) { mapping[f.key] = headers[idx]; break; }
    }
  });
  return mapping;
}

type PreviewRow = { rowIndex: number; name: string; isDuplicate: boolean; duplicateReason: string | null; row: Record<string, string>; skipped: boolean };

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview" | "result">("upload");
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<{ created: number; errors: { row: number; error: string }[] } | null>(null);
  const [previewData, setPreviewData] = useState<PreviewRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [isZoomInfo, setIsZoomInfo] = useState(false);
  const [headerOriginalIndex, setHeaderOriginalIndex] = useState<number[]>([]);

  const { data: savedMappingData } = useQuery<{ mapping: Record<string, string> }>({
    queryKey: ["/api/settings/zoominfo-mapping"],
    staleTime: 60000,
  });

  const handleFile = async (file: File) => {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as string[][];
    if (!data || data.length < 2) {
      toast({ title: "File must have at least a header row and one data row.", variant: "destructive" });
      return;
    }
    const hdrs: string[] = [];
    const origIdxs: number[] = [];
    data[0].forEach((h, i) => {
      const cleaned = String(h ?? "").trim();
      if (cleaned) { hdrs.push(cleaned); origIdxs.push(i); }
    });
    const rows = data.slice(1).filter(r => r.some(c => c != null && String(c).trim() !== ""));
    setRawHeaders(hdrs);
    setHeaderOriginalIndex(origIdxs);
    setRawRows(rows as string[][]);

    const savedMap = savedMappingData?.mapping ?? {};
    const detectedMapping = autoDetectMapping(hdrs);
    const finalMapping: Record<string, string> = { ...detectedMapping };
    for (const [crmKey, colName] of Object.entries(savedMap)) {
      if (colName && hdrs.includes(colName)) {
        finalMapping[crmKey] = colName;
      } else if (colName) {
        const found = hdrs.find(h => h.toLowerCase() === colName.toLowerCase());
        if (found) finalMapping[crmKey] = found;
      }
    }
    setMapping(finalMapping);
    const hdrNorm = hdrs.map(h => h.toLowerCase());
    const looksLikeZoomInfo = hdrNorm.some(h => h.includes("revenue") || h.includes("employee") || h.includes("contact 2") || h.includes("contact 3"));
    setIsZoomInfo(looksLikeZoomInfo);
    setStep("map");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const buildMappedRows = () => rawRows.map(row => {
    const obj: Record<string, string> = {};
    IMPORT_FIELDS.forEach(f => {
      const col = mapping[f.key];
      if (col) {
        const hdrIdx = rawHeaders.indexOf(col);
        const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
        if (origIdx !== -1 && row[origIdx] != null) obj[f.key] = String(row[origIdx]).trim();
      }
    });
    return obj;
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const rows = buildMappedRows();
      const res = await apiRequest("POST", "/api/prospects/import/preview", { rows });
      return res.json();
    },
    onSuccess: (data: { preview: PreviewRow[] }) => {
      const initialSkipped = new Set<number>();
      data.preview.forEach(p => { if (p.isDuplicate) initialSkipped.add(p.rowIndex); });
      setSkippedRows(initialSkipped);
      setPreviewData(data.preview);
      setStep("preview");
    },
    onError: () => toast({ title: "Preview failed", variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const allRows = buildMappedRows();
      const rows = allRows.filter((_, i) => !skippedRows.has(i));
      const res = await apiRequest("POST", "/api/prospects/import", { rows, isZoomInfo, skipDuplicates: false });
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
    },
    onError: () => toast({ title: "Import failed", variant: "destructive" }),
  });

  const mappedFields = IMPORT_FIELDS.filter(f => mapping[f.key]);
  const previewSampleRows = rawRows.slice(0, 3);

  const handleClose = () => {
    setStep("upload");
    setRawHeaders([]);
    setRawRows([]);
    setMapping({});
    setImportResult(null);
    setPreviewData([]);
    setSkippedRows(new Set());
    setIsZoomInfo(false);
    onClose();
  };

  const downloadTemplate = () => {
    const headers = ["Company Name", "Industry", "Est. Annual Revenue", "Employee Count", "Website", "Contact 1 Name", "Contact 1 Title", "Contact 1 Email", "Contact 1 Phone", "Contact 2 Name", "Contact 2 Email", "Notes"];
    const exampleRow = ["Acme Logistics", "Manufacturing", "$45,000,000", "250", "https://acmelogistics.com", "Jane Smith", "VP of Logistics", "jsmith@acmelogistics.com", "312-555-0100", "Bob Johnson", "bjohnson@acmelogistics.com", "Key prospect in Chicago market"];
    const csv = [headers, exampleRow].map(row => row.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "zoominfo-import-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadFailedRows = () => {
    if (!importResult?.errors?.length || !rawRows.length) return;
    const headers = [...IMPORT_FIELDS.map(f => f.label.replace(" *", "")), "Import Error"];
    const rows = importResult.errors.map(e => {
      const row = rawRows[e.row - 1] ?? [];
      const values = IMPORT_FIELDS.map(f => {
        const hdrIdx = rawHeaders.indexOf(mapping[f.key] ?? "");
        const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
        return origIdx !== -1 ? (row[origIdx] ?? "") : "";
      });
      return [...values, e.error];
    });
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "freight-dna-import-failed-rows.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const toImportCount = previewData.filter(p => !skippedRows.has(p.rowIndex)).length;
  const duplicateCount = previewData.filter(p => p.isDuplicate).length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            {step === "upload" ? "Import Leads" : step === "map" ? "Map Columns" : step === "preview" ? "Review & Confirm" : "Import Complete"}
          </DialogTitle>
        </DialogHeader>

        {/* Upload Step */}
        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">Upload a CSV or Excel file exported from ZoomInfo, LinkedIn Sales Navigator, or any spreadsheet. Contacts, revenue, and employee count are auto-detected.</p>
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5 text-xs h-8" onClick={downloadTemplate} data-testid="button-download-template">
                <Download className="h-3.5 w-3.5" /> Template
              </Button>
            </div>
            <div
              className="border-2 border-dashed border-border rounded-xl p-10 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              data-testid="import-dropzone"
            >
              <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">Drag & drop or click to upload</p>
              <p className="text-xs text-muted-foreground mt-1">Supports .csv and .xlsx files</p>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} data-testid="input-import-file" />
            </div>
          </div>
        )}

        {/* Map Step */}
        {step === "map" && (
          <div className="space-y-4 py-2">
            <div>
              <p className="text-sm font-medium">{rawRows.length} rows detected · {rawHeaders.length} columns</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isZoomInfo && <span className="text-blue-600 dark:text-blue-400 font-medium">ZoomInfo format detected. </span>}
                Auto-matched {Object.keys(mapping).length} fields. Adjust if needed.
              </p>
            </div>
            <div className="grid gap-2 max-h-[360px] overflow-y-auto pr-1">
              {IMPORT_FIELDS.map(f => (
                <div key={f.key} className="grid grid-cols-2 gap-2 items-center" data-testid={`map-row-${f.key}`}>
                  <div>
                    <p className="text-xs font-medium">{f.label}</p>
                    {f.required && <p className="text-[10px] text-red-500">Required</p>}
                  </div>
                  <Select value={mapping[f.key] ?? "__none__"} onValueChange={v => setMapping(prev => ({ ...prev, [f.key]: v === "__none__" ? "" : v }))}>
                    <SelectTrigger className="h-7 text-xs" data-testid={`select-mapping-${f.key}`}><SelectValue placeholder="— Skip —" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-xs">— Skip —</SelectItem>
                      {rawHeaders.map(h => <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {mappedFields.length > 0 && previewSampleRows.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Sample (first {Math.min(3, previewSampleRows.length)} rows)</p>
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {mappedFields.slice(0, 6).map(f => (
                          <TableHead key={f.key} className="text-xs whitespace-nowrap">{f.label.replace(" *", "")}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewSampleRows.map((row, i) => (
                        <TableRow key={i}>
                          {mappedFields.slice(0, 6).map(f => {
                            const hdrIdx = rawHeaders.indexOf(mapping[f.key] ?? "");
                            const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
                            return <TableCell key={f.key} className="text-xs py-1.5 max-w-[140px] truncate">{origIdx !== -1 ? (row[origIdx] ?? "") : ""}</TableCell>;
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Preview Step */}
        {step === "preview" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1">
                <p className="text-sm font-medium">{previewData.length} records analyzed</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {toImportCount} will be imported · {skippedRows.size} skipped
                  {duplicateCount > 0 && ` · ${duplicateCount} duplicate${duplicateCount !== 1 ? "s" : ""} found`}
                </p>
              </div>
              {duplicateCount > 0 && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSkippedRows(new Set(previewData.filter(p => p.isDuplicate).map(p => p.rowIndex)))}>
                    Skip all duplicates
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSkippedRows(prev => { const next = new Set(prev); previewData.filter(p => p.isDuplicate).forEach(p => next.delete(p.rowIndex)); return next; })}>
                    Import all duplicates
                  </Button>
                </div>
              )}
            </div>
            <div className="border rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-8">Include</TableHead>
                    <TableHead className="text-xs">Company</TableHead>
                    <TableHead className="text-xs">Industry</TableHead>
                    <TableHead className="text-xs">Website</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.map(p => {
                    const isSkipped = skippedRows.has(p.rowIndex);
                    return (
                      <TableRow key={p.rowIndex} className={isSkipped ? "opacity-40" : ""} data-testid={`preview-row-${p.rowIndex}`}>
                        <TableCell className="py-1.5">
                          <input type="checkbox" checked={!isSkipped} onChange={e => { setSkippedRows(prev => { const next = new Set(prev); if (e.target.checked) next.delete(p.rowIndex); else next.add(p.rowIndex); return next; }); }} className="h-3.5 w-3.5" data-testid={`preview-checkbox-${p.rowIndex}`} />
                        </TableCell>
                        <TableCell className="text-xs py-1.5 font-medium">{p.row.name || "—"}</TableCell>
                        <TableCell className="text-xs py-1.5 text-muted-foreground">{p.row.industry || "—"}</TableCell>
                        <TableCell className="text-xs py-1.5 text-muted-foreground max-w-[120px] truncate">{p.row.website || "—"}</TableCell>
                        <TableCell className="text-xs py-1.5">
                          {p.isDuplicate ? (
                            <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle className="h-3 w-3 shrink-0" />{p.duplicateReason}</span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle className="h-3 w-3 shrink-0" />New</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Result Step */}
        {step === "result" && importResult && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
              <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-700 dark:text-emerald-300">{importResult.created} account{importResult.created !== 1 ? "s" : ""} imported at New Lead stage</p>
                {isZoomInfo && <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">Lead source set to ZoomInfo · Activity logged on each account</p>}
                {importResult.errors.length > 0 && <p className="text-sm text-muted-foreground mt-1">{importResult.errors.length} row{importResult.errors.length !== 1 ? "s" : ""} skipped</p>}
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8" onClick={downloadFailedRows} data-testid="button-download-errors">
                <Download className="h-3.5 w-3.5" /> Download Failed Rows
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "upload" && <Button variant="outline" onClick={handleClose} data-testid="button-import-cancel">Cancel</Button>}
          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
              <Button onClick={() => previewMutation.mutate()} disabled={!mapping["name"] || previewMutation.isPending} data-testid="button-import-preview">
                {previewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Preview Import
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
              <Button onClick={() => importMutation.mutate()} disabled={toImportCount === 0 || importMutation.isPending} data-testid="button-import-confirm">
                {importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Import {toImportCount} Account{toImportCount !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {step === "result" && <Button onClick={handleClose} data-testid="button-import-done">Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
