import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, FileUp, Download, CheckCircle, AlertCircle, Loader2, Pencil } from "lucide-react";

const IMPORT_FIELDS = [
  { key: "name",                label: "Name *",                  required: true  },
  { key: "description",         label: "Description / Purpose",   required: false },
  { key: "audience",            label: "Audience",                required: false },
  { key: "channel",             label: "Channel",                 required: false },
  { key: "triggerType",         label: "Trigger Type",            required: false },
  { key: "recommendedSteps",    label: "Recommended Steps",       required: false },
  { key: "templateBody",        label: "Template / Talk-track",   required: false },
  { key: "successMetric",       label: "Success Metric",          required: false },
  { key: "outcomeWindowHours",  label: "Outcome Window (hours)",  required: false },
] as const;

type FieldKey = typeof IMPORT_FIELDS[number]["key"];

const HEADER_SYNONYMS: Record<FieldKey, string[]> = {
  name:               ["name", "play", "play name", "title"],
  description:        ["description", "purpose", "why", "summary"],
  audience:           ["audience", "for", "target"],
  channel:            ["channel", "medium"],
  triggerType:        ["trigger", "trigger type", "when", "fires when"],
  recommendedSteps:   ["steps", "recommended steps", "playbook", "actions"],
  templateBody:       ["template", "template body", "talk track", "talk-track", "script", "body", "message"],
  successMetric:      ["success", "success metric", "metric", "kpi", "outcome"],
  outcomeWindowHours: ["window", "outcome window", "outcome window hours", "hours", "window hours"],
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

type PreviewRow = {
  rowIndex: number;
  raw: Record<string, string>;
  parsed: Record<string, unknown> | null;
  errors: string[];
  isDuplicate: boolean;
  duplicateReason: string | null;
};

export function ImportPlaybookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview" | "result">("upload");
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [headerOriginalIndex, setHeaderOriginalIndex] = useState<number[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [previewData, setPreviewData] = useState<PreviewRow[]>([]);
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [overwriteDuplicates, setOverwriteDuplicates] = useState(false);
  // Per-row overrides keyed by rowIndex. Lets users fix invalid rows
  // (or tweak duplicates) inline before commit without re-uploading.
  const [editOverrides, setEditOverrides] = useState<Record<number, Partial<Record<FieldKey, string>>>>({});
  const [importResult, setImportResult] = useState<{ created: number; updated?: number; skipped: number; errors: { row: number; error: string }[] } | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/playbook/import/parse", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        toast({ title: err?.error ?? "Failed to parse file", variant: "destructive" });
        return;
      }
      const { headers, rows } = await r.json() as { headers: string[]; rows: Record<string, string>[] };
      if (!headers.length || !rows.length) {
        toast({ title: "File must have a header row and at least one data row.", variant: "destructive" });
        return;
      }
      // Convert header-keyed rows back into the parallel arrays the rest of
      // this dialog already uses for column mapping/preview.
      const origIdxs = headers.map((_, i) => i);
      const rowArrays = rows.map(r => headers.map(h => r[h] ?? ""));
      setRawHeaders(headers);
      setHeaderOriginalIndex(origIdxs);
      setRawRows(rowArrays);
      setMapping(autoDetectMapping(headers));
      setStep("map");
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const buildMappedRows = () => rawRows.map((row, i) => {
    const obj: Record<string, string> = {};
    IMPORT_FIELDS.forEach(f => {
      const col = mapping[f.key];
      if (col) {
        const hdrIdx = rawHeaders.indexOf(col);
        const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
        if (origIdx !== -1 && row[origIdx] != null) obj[f.key] = String(row[origIdx]).trim();
      }
    });
    // Per-row inline edits win over the auto-mapped values, so a fix in
    // the preview survives a re-validate without re-uploading.
    const overrides = editOverrides[i];
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) obj[k] = v;
      }
    }
    return obj;
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const rows = buildMappedRows();
      const res = await apiRequest("POST", "/api/playbook/import/preview", { rows });
      return res.json();
    },
    onSuccess: (data: { preview: PreviewRow[] }) => {
      const initialSkipped = new Set<number>();
      data.preview.forEach(p => {
        // Always skip rows with hard errors. Skip duplicates only when the
        // user has NOT opted into overwrite (otherwise they'd toggle the
        // checkbox and see "0 will be imported", which is misleading).
        if (p.errors.length > 0) initialSkipped.add(p.rowIndex);
        else if (p.isDuplicate && !overwriteDuplicates) initialSkipped.add(p.rowIndex);
      });
      setSkippedRows(initialSkipped);
      setPreviewData(data.preview);
      setStep("preview");
    },
    onError: () => toast({ title: "Preview failed", variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const all = buildMappedRows();
      const rows = all.filter((_, i) => !skippedRows.has(i));
      const res = await apiRequest("POST", "/api/playbook/import", { rows, overwriteDuplicates });
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/plays"] });
    },
    onError: () => toast({ title: "Import failed", variant: "destructive" }),
  });

  const handleClose = () => {
    setStep("upload");
    setRawHeaders([]); setRawRows([]); setHeaderOriginalIndex([]); setMapping({});
    setPreviewData([]); setSkippedRows(new Set()); setImportResult(null);
    setOverwriteDuplicates(false);
    setEditOverrides({});
    onClose();
  };

  /** Toggle overwrite + auto-(un)skip duplicate rows so the import set the
   *  user sees in the toolbar always matches the chosen behavior. */
  const handleOverwriteToggle = (next: boolean) => {
    setOverwriteDuplicates(next);
    setSkippedRows(prev => {
      const n = new Set(prev);
      previewData.forEach(p => {
        if (p.errors.length > 0) return; // hard errors always stay skipped
        if (p.isDuplicate) {
          if (next) n.delete(p.rowIndex);
          else n.add(p.rowIndex);
        }
      });
      return n;
    });
  };

  const downloadTemplate = () => {
    window.open("/api/playbook/import/template", "_blank");
  };

  const toImportCount = previewData.filter(p => !skippedRows.has(p.rowIndex) && p.errors.length === 0).length;
  const errorCount = previewData.filter(p => p.errors.length > 0).length;
  const dupCount = previewData.filter(p => p.isDuplicate).length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-import-playbook">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            {step === "upload" ? "Import Playbook" : step === "map" ? "Map Columns" : step === "preview" ? "Review & Confirm" : "Import Complete"}
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">Upload a CSV or Excel file with one play per row. Plays import as drafts that you can review and publish.</p>
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5 text-xs h-8" onClick={downloadTemplate} data-testid="button-download-playbook-template">
                <Download className="h-3.5 w-3.5" /> Template
              </Button>
            </div>
            <div
              className="border-2 border-dashed border-border rounded-xl p-10 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              data-testid="playbook-import-dropzone"
            >
              {uploading ? (
                <Loader2 className="h-10 w-10 text-muted-foreground mx-auto mb-3 animate-spin" />
              ) : (
                <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              )}
              <p className="font-medium text-sm">{uploading ? "Parsing…" : "Drag & drop or click to upload"}</p>
              <p className="text-xs text-muted-foreground mt-1">Supports .csv and .xlsx files</p>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} data-testid="input-playbook-import-file" />
            </div>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-4 py-2">
            <div>
              <p className="text-sm font-medium">{rawRows.length} rows detected · {rawHeaders.length} columns</p>
              <p className="text-xs text-muted-foreground mt-0.5">Auto-matched {Object.keys(mapping).filter(k => mapping[k]).length} fields. Adjust if needed.</p>
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
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {previewData.length} rows analyzed
                  {previewData.length > 20 && <span className="text-muted-foreground font-normal"> · showing first 20</span>}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {toImportCount} will be imported · {skippedRows.size} skipped
                  {errorCount > 0 && ` · ${errorCount} with errors`}
                  {dupCount > 0 && ` · ${dupCount} duplicate${dupCount !== 1 ? "s" : ""}`}
                </p>
              </div>
              {dupCount > 0 && (
                <label className="flex items-center gap-1.5 text-xs" data-testid="label-overwrite-duplicates">
                  <input
                    type="checkbox"
                    checked={overwriteDuplicates}
                    onChange={e => handleOverwriteToggle(e.target.checked)}
                    className="h-3.5 w-3.5"
                    data-testid="checkbox-overwrite-duplicates"
                  />
                  Import duplicates as new drafts
                </label>
              )}
            </div>
            <div className="border rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-8">Include</TableHead>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Channel</TableHead>
                    <TableHead className="text-xs">Trigger</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs w-12">Edit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.slice(0, 20).map(p => {
                    const isSkipped = skippedRows.has(p.rowIndex);
                    const hasError = p.errors.length > 0;
                    // Mirror server semantics: duplicates can only be
                    // unskipped while overwrite is on, otherwise the
                    // server will silently skip them and the local
                    // "will be imported" count would lie.
                    const lockedAsDup = p.isDuplicate && !overwriteDuplicates;
                    return (
                      <TableRow key={p.rowIndex} className={isSkipped ? "opacity-40" : ""} data-testid={`preview-row-${p.rowIndex}`}>
                        <TableCell className="py-1.5">
                          <input
                            type="checkbox"
                            checked={!isSkipped}
                            disabled={hasError || lockedAsDup}
                            onChange={e => setSkippedRows(prev => { const n = new Set(prev); if (e.target.checked) n.delete(p.rowIndex); else n.add(p.rowIndex); return n; })}
                            className="h-3.5 w-3.5"
                            data-testid={`preview-checkbox-${p.rowIndex}`}
                          />
                        </TableCell>
                        <TableCell className="text-xs py-1.5 font-medium">{p.raw.name || "—"}</TableCell>
                        <TableCell className="text-xs py-1.5 text-muted-foreground">{p.raw.channel || "email"}</TableCell>
                        <TableCell className="text-xs py-1.5 text-muted-foreground">{p.raw.triggerType || "manual"}</TableCell>
                        <TableCell className="text-xs py-1.5">
                          {hasError ? (
                            <span className="text-red-600 dark:text-red-400 flex items-center gap-1" data-testid={`preview-error-${p.rowIndex}`}>
                              <AlertCircle className="h-3 w-3 shrink-0" />{p.errors.join("; ")}
                            </span>
                          ) : p.isDuplicate ? (
                            <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid={`preview-dup-${p.rowIndex}`}>
                              <AlertCircle className="h-3 w-3 shrink-0" />{p.duplicateReason}
                            </span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <CheckCircle className="h-3 w-3 shrink-0" />New
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <RowEditPopover
                            rowIndex={p.rowIndex}
                            initial={{
                              name: p.raw.name ?? "",
                              audience: p.raw.audience ?? "customer",
                              channel: p.raw.channel ?? "email",
                              triggerType: p.raw.triggerType ?? "manual",
                              outcomeWindowHours: p.raw.outcomeWindowHours ?? "",
                            }}
                            onSave={(patch) => {
                              setEditOverrides(prev => ({
                                ...prev,
                                [p.rowIndex]: { ...(prev[p.rowIndex] ?? {}), ...patch },
                              }));
                              // Re-run preview so the edited row is re-validated
                              // and any duplicate flag is recomputed against the
                              // org's existing plays.
                              setTimeout(() => previewMutation.mutate(), 0);
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {step === "result" && importResult && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
              <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-700 dark:text-emerald-300" data-testid="text-import-result">
                  {importResult.created} created
                  {importResult.updated ? ` · ${importResult.updated} updated as new draft version` : ""}
                  {` · ${importResult.skipped} skipped`}
                </p>
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">All new plays land as drafts — publish them when ready.</p>
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="border rounded-lg p-3 max-h-48 overflow-y-auto text-xs space-y-1" data-testid="import-errors">
                <p className="font-medium mb-1">Errors:</p>
                {importResult.errors.map((e, i) => (
                  <div key={i} className="text-muted-foreground">Row {e.row}: {e.error}</div>
                ))}
              </div>
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
                {importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Import {toImportCount} Play{toImportCount !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {step === "result" && <Button onClick={handleClose} data-testid="button-import-done">Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline per-row editor popover. Lets uploaders fix the most common
 * validation failures (name/audience/channel/trigger/window) without
 * re-uploading the file. Uses uncontrolled local state and only commits
 * the patch on Save so we don't thrash preview re-validations.
 */
function RowEditPopover({
  rowIndex,
  initial,
  onSave,
}: {
  rowIndex: number;
  initial: { name: string; audience: string; channel: string; triggerType: string; outcomeWindowHours: string };
  onSave: (patch: Partial<{ name: string; audience: string; channel: string; triggerType: string; outcomeWindowHours: string }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial.name);
  const [audience, setAudience] = useState(initial.audience);
  const [channel, setChannel] = useState(initial.channel);
  const [triggerType, setTriggerType] = useState(initial.triggerType);
  const [windowHours, setWindowHours] = useState(initial.outcomeWindowHours);

  const handleSave = () => {
    onSave({ name, audience, channel, triggerType, outcomeWindowHours: windowHours });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(v) => {
      // Re-seed local state from the freshest preview row each time we
      // open, so a re-validate that mutated raw values is reflected here.
      if (v) {
        setName(initial.name);
        setAudience(initial.audience);
        setChannel(initial.channel);
        setTriggerType(initial.triggerType);
        setWindowHours(initial.outcomeWindowHours);
      }
      setOpen(v);
    }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" data-testid={`button-edit-row-${rowIndex}`}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2" align="end">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} className="h-8 text-xs" data-testid={`input-edit-name-${rowIndex}`} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Audience</Label>
            <Select value={audience} onValueChange={setAudience}>
              <SelectTrigger className="h-8 text-xs" data-testid={`select-edit-audience-${rowIndex}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="customer">customer</SelectItem>
                <SelectItem value="carrier">carrier</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Channel</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="h-8 text-xs" data-testid={`select-edit-channel-${rowIndex}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="email">email</SelectItem>
                <SelectItem value="call">call</SelectItem>
                <SelectItem value="in_person">in_person</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Trigger</Label>
            <Select value={triggerType} onValueChange={setTriggerType}>
              <SelectTrigger className="h-8 text-xs" data-testid={`select-edit-trigger-${rowIndex}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">manual</SelectItem>
                <SelectItem value="quote_no_response">quote_no_response</SelectItem>
                <SelectItem value="award_no_carrier">award_no_carrier</SelectItem>
                <SelectItem value="sentiment_drop">sentiment_drop</SelectItem>
                <SelectItem value="signal_match">signal_match</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Window (h)</Label>
            <Input value={windowHours} onChange={e => setWindowHours(e.target.value)} className="h-8 text-xs" data-testid={`input-edit-window-${rowIndex}`} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} className="h-7 text-xs">Cancel</Button>
          <Button size="sm" onClick={handleSave} className="h-7 text-xs" data-testid={`button-save-edit-${rowIndex}`}>Save & re-validate</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
