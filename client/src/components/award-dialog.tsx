import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Loader2,
  Paperclip,
  Sparkles,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Award, InsertAward, Company } from "@shared/schema";

const awardSchema = z.object({
  companyId: z.string().min(1, "Company is required"),
  title: z.string().min(1, "Title is required"),
  value: z.string().optional(),
  awardDate: z.string().optional(),
  notes: z.string().optional(),
});

type AwardFormData = z.infer<typeof awardSchema>;

interface ColumnMappingState {
  headers: string[];
  suggestedMappings: Record<string, string>;
  confident: boolean;
  sheetName: string;
  columnSamples: Record<string, string[]>;
}

interface AwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  award?: Award;
  onCreated?: (award: Award) => void;
}

export function AwardDialog({ open, onOpenChange, award, onCreated }: AwardDialogProps) {
  const { toast } = useToast();
  const isEditing = !!award;
  const attachFileRef = useRef<HTMLInputElement>(null);
  const laneFileRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<{ name: string; data: string } | null>(null);

  // Lane extraction — two-step: column mapping → lane checklist
  const [pendingLaneFile, setPendingLaneFile] = useState<File | null>(null);
  const [columnMappingOpen, setColumnMappingOpen] = useState(false);
  const [columnMappingData, setColumnMappingData] = useState<ColumnMappingState | null>(null);
  const [confirmedMapping, setConfirmedMapping] = useState<Record<string, string>>({});
  const [extractingLanes, setExtractingLanes] = useState(false);
  const [analyzingFile, setAnalyzingFile] = useState(false);

  const [parsedLaneLabels, setParsedLaneLabels] = useState<string[]>([]);
  const [selectedLaneIdxs, setSelectedLaneIdxs] = useState<Set<number>>(new Set());
  const [showAllLanes, setShowAllLanes] = useState(false);
  const [parsedLaneFileName, setParsedLaneFileName] = useState<string | null>(null);
  const [manualLanes, setManualLanes] = useState("");

  const { data: companies } = useQuery<Company[]>({ queryKey: ["/api/companies"] });

  const form = useForm<AwardFormData>({
    resolver: zodResolver(awardSchema),
    defaultValues: { companyId: "", title: "", value: "", awardDate: "", notes: "" },
  });

  useEffect(() => {
    if (!open) return;
    if (award) {
      form.reset({
        companyId: award.companyId || "",
        title: award.title || "",
        value: award.value || "",
        awardDate: award.awardDate || "",
        notes: award.notes || "",
      });
      setSelectedFile(award.fileName ? { name: award.fileName, data: award.fileData || "" } : null);
      const existing = award.lanes ?? [];
      setParsedLaneLabels(existing);
      setSelectedLaneIdxs(new Set(existing.map((_, i) => i)));
      setManualLanes(existing.length > 0 ? existing.join(", ") : "");
      setParsedLaneFileName(null);
    } else {
      form.reset({ companyId: "", title: "", value: "", awardDate: "", notes: "" });
      setSelectedFile(null);
      setParsedLaneLabels([]);
      setSelectedLaneIdxs(new Set());
      setManualLanes("");
      setParsedLaneFileName(null);
    }
    setColumnMappingOpen(false);
    setColumnMappingData(null);
    setConfirmedMapping({});
    setPendingLaneFile(null);
    setShowAllLanes(false);
  }, [open, award?.id]);

  // Step 1: Analyze file headers → open column mapping dialog
  const handleLaneFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (laneFileRef.current) laneFileRef.current.value = "";

    const ext = file.name.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      toast({ title: "Invalid file type", description: "Please upload an Excel (.xlsx, .xls) or CSV file.", variant: "destructive" });
      return;
    }

    setPendingLaneFile(file);
    setAnalyzingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/rfps/preview-headers", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || "Failed to analyze file");
      }
      const data = await res.json() as ColumnMappingState & { isPdf?: boolean };
      if (data.isPdf) {
        toast({ title: "PDF not supported here", description: "Upload an Excel or CSV file for lane extraction.", variant: "destructive" });
        return;
      }
      setColumnMappingData(data);
      setConfirmedMapping({ ...data.suggestedMappings });
      setColumnMappingOpen(true);
    } catch (err: any) {
      toast({ title: "Failed to analyze file", description: err.message, variant: "destructive" });
      setPendingLaneFile(null);
    } finally {
      setAnalyzingFile(false);
    }
  };

  // Step 2: Extract lanes using confirmed column mapping
  const handleExtractLanes = async () => {
    if (!pendingLaneFile) return;
    setExtractingLanes(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingLaneFile);
      fd.append("confirmedMapping", JSON.stringify(confirmedMapping));
      const res = await fetch("/api/awards/parse-lanes", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || "Failed to parse lanes");
      }
      const data = await res.json() as { allLaneLabels: string[]; analysis: { laneCount: number } };
      if (!data.allLaneLabels || data.allLaneLabels.length === 0) {
        toast({
          title: "No lanes detected",
          description: "No origin→destination lanes were found. Adjust the column mapping and try again.",
          variant: "destructive",
        });
        return;
      }
      setParsedLaneLabels(data.allLaneLabels);
      setSelectedLaneIdxs(new Set(data.allLaneLabels.map((_, i) => i)));
      setParsedLaneFileName(pendingLaneFile.name);
      setManualLanes("");
      setColumnMappingOpen(false);
      setColumnMappingData(null);
      toast({ title: `${data.allLaneLabels.length} lanes extracted`, description: "Deselect any you didn't win before saving." });
    } catch (err: any) {
      toast({ title: "Lane extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtractingLanes(false);
    }
  };

  const handleAttachFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Please select a file under 10MB.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSelectedFile({ name: file.name, data: reader.result as string });
    reader.readAsDataURL(file);
  };

  const toggleLane = (idx: number) => {
    setSelectedLaneIdxs(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: async (data: InsertAward) => {
      const response = await apiRequest("POST", "/api/awards", data);
      return response.json() as Promise<Award>;
    },
    onSuccess: (createdAward: Award) => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      toast({ title: "Award created successfully" });
      onOpenChange(false);
      onCreated?.(createdAward);
    },
    onError: (error: Error) => {
      toast({ title: "Error creating award", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: InsertAward) => {
      const response = await apiRequest("PATCH", `/api/awards/${award?.id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      toast({ title: "Award updated successfully" });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error updating award", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: AwardFormData) => {
    let lanesArray: string[] | null = null;
    if (parsedLaneLabels.length > 0) {
      lanesArray = parsedLaneLabels.filter((_, i) => selectedLaneIdxs.has(i));
      if (lanesArray.length === 0) lanesArray = null;
    } else if (manualLanes.trim()) {
      lanesArray = manualLanes.split(",").map(l => l.trim()).filter(Boolean);
    }

    const payload: InsertAward = {
      companyId: data.companyId,
      title: data.title,
      value: data.value || null,
      awardDate: data.awardDate || null,
      lanes: lanesArray,
      notes: data.notes || null,
      fileName: selectedFile?.name || null,
      fileData: selectedFile?.data || null,
    };

    if (isEditing) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const visibleLanes = showAllLanes ? parsedLaneLabels : parsedLaneLabels.slice(0, 8);
  const selectedCount = selectedLaneIdxs.size;

  // Mapping validation
  const mappedFields = Object.values(confirmedMapping);
  const hasOrigin = mappedFields.some(f => f.startsWith("origin_"));
  const hasDestination = mappedFields.some(f => f.startsWith("dest_"));
  const missingFields: string[] = [];
  if (!hasOrigin) missingFields.push("origin");
  if (!hasDestination) missingFields.push("destination");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Award" : "Add Award"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="companyId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-award-company">
                          <SelectValue placeholder="Select a company" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {companies?.slice().sort((a, b) => a.name.localeCompare(b.name)).map((company) => (
                          <SelectItem key={company.id} value={company.id}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Award Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Southeast Lanes Award" {...field} data-testid="input-award-title" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Award Value ($)</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="e.g., 500000" {...field} data-testid="input-award-value" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="awardDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Award Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-award-date" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* ── Lane section ────────────────────────────────────── */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <FormLabel className="mb-0">Awarded Lanes</FormLabel>
                  <div className="flex items-center gap-2">
                    {parsedLaneLabels.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {selectedCount} of {parsedLaneLabels.length} selected
                      </Badge>
                    )}
                    <input
                      ref={laneFileRef}
                      type="file"
                      className="hidden"
                      accept=".xlsx,.xls,.csv"
                      onChange={handleLaneFileSelect}
                      data-testid="input-lane-file"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      disabled={analyzingFile}
                      onClick={() => laneFileRef.current?.click()}
                      data-testid="button-upload-lane-file"
                    >
                      {analyzingFile ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3 text-amber-500" />
                      )}
                      {analyzingFile ? "Analyzing…" : "Upload Lane File"}
                    </Button>
                  </div>
                </div>

                {parsedLaneFileName && !analyzingFile && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{parsedLaneFileName}</span>
                    <button
                      type="button"
                      className="ml-auto shrink-0 hover:text-foreground"
                      onClick={() => { setParsedLaneLabels([]); setSelectedLaneIdxs(new Set()); setParsedLaneFileName(null); setPendingLaneFile(null); }}
                      data-testid="button-clear-lane-file"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}

                {parsedLaneLabels.length > 0 ? (
                  <>
                    <div className="border rounded-md divide-y max-h-56 overflow-y-auto">
                      {visibleLanes.map((label, idx) => (
                        <label
                          key={idx}
                          className="flex items-start gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                          data-testid={`lane-checkbox-${idx}`}
                        >
                          <div
                            onClick={() => toggleLane(idx)}
                            className={`mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                              selectedLaneIdxs.has(idx)
                                ? "bg-primary border-primary"
                                : "border-input bg-background"
                            }`}
                          >
                            {selectedLaneIdxs.has(idx) && <Check className="h-3 w-3 text-primary-foreground" />}
                          </div>
                          <span className="text-sm leading-snug">{label}</span>
                        </label>
                      ))}
                      {parsedLaneLabels.length > 8 && (
                        <button
                          type="button"
                          onClick={() => setShowAllLanes(!showAllLanes)}
                          className="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
                          data-testid="button-toggle-show-lanes"
                        >
                          {showAllLanes ? (
                            <><ChevronUp className="h-3 w-3" />Show less</>
                          ) : (
                            <><ChevronDown className="h-3 w-3" />Show {parsedLaneLabels.length - 8} more lanes</>
                          )}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-3 text-xs">
                      <button type="button" className="text-primary hover:underline" onClick={() => setSelectedLaneIdxs(new Set(parsedLaneLabels.map((_, i) => i)))} data-testid="button-select-all-lanes">Select all</button>
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => setSelectedLaneIdxs(new Set())} data-testid="button-select-no-lanes">Deselect all</button>
                    </div>
                    {selectedCount === 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">No lanes selected — the award will be saved without lane detail.</p>
                    )}
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <Input
                      value={manualLanes}
                      onChange={e => setManualLanes(e.target.value)}
                      placeholder="e.g., Chicago, IL → Memphis, TN (120 loads), Dallas → Houston"
                      data-testid="input-award-lanes"
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter lanes manually, or upload an Excel/CSV above — AI will read the headers and map origin, destination, and volume automatically.
                    </p>
                  </div>
                )}
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Any additional notes about this award..." {...field} data-testid="input-award-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Attachment */}
              <div className="space-y-2">
                <FormLabel>Attachment (optional)</FormLabel>
                <input
                  ref={attachFileRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg"
                  onChange={handleAttachFile}
                  data-testid="input-award-file"
                />
                {selectedFile ? (
                  <div className="flex items-center gap-2 p-2 rounded-md border bg-muted/40">
                    <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm truncate flex-1" data-testid="text-award-filename">{selectedFile.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => { setSelectedFile(null); if (attachFileRef.current) attachFileRef.current.value = ""; }}
                      data-testid="button-remove-file"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => attachFileRef.current?.click()}
                    data-testid="button-browse-file"
                  >
                    <Paperclip className="h-4 w-4 mr-2" />
                    Browse Files
                  </Button>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-award">
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending} data-testid="button-save-award">
                  {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Award"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Column Mapping Dialog — same pattern as RFP upload */}
      {columnMappingData && (
        <Dialog open={columnMappingOpen} onOpenChange={(open) => {
          if (!open) { setColumnMappingOpen(false); setColumnMappingData(null); setConfirmedMapping({}); setPendingLaneFile(null); }
        }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-award-column-mapping">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Confirm Column Mapping
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                AI analyzed <span className="font-medium">{pendingLaneFile?.name}</span>
                {columnMappingData.sheetName ? ` (tab: "${columnMappingData.sheetName}")` : ""}. Review and adjust which column maps to which field.
              </p>
              {columnMappingData.confident ? (
                <Badge variant="outline" className="w-fit text-green-700 dark:text-green-400 border-green-300 dark:border-green-700">
                  <Sparkles className="h-3 w-3 mr-1" />
                  High confidence
                </Badge>
              ) : (
                <Badge variant="outline" className="w-fit text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Low confidence — please review carefully
                </Badge>
              )}
            </DialogHeader>

            {/* Validation banner */}
            {missingFields.length > 0 ? (
              <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  Missing required field{missingFields.length > 1 ? "s" : ""}: <strong>{missingFields.join(", ")}</strong>. Assign them below before extracting.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 text-sm text-green-800 dark:text-green-300">
                <CheckCircle className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                <span>All required fields mapped. Ready to extract lanes.</span>
              </div>
            )}

            {/* Column → Field mapping rows */}
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-xs font-medium text-muted-foreground px-1 pb-1">
                <span>Spreadsheet Column</span>
                <span />
                <span>Maps To</span>
              </div>
              {columnMappingData.headers.map((header) => {
                const samples = columnMappingData.columnSamples[header] || [];
                return (
                  <div
                    key={header}
                    className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center p-2 rounded-md hover:bg-muted/50 transition-colors"
                    data-testid={`row-award-column-mapping-${header}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{header}</p>
                      {samples.length > 0 && (
                        <p className="text-xs text-muted-foreground truncate">e.g. {samples.slice(0, 2).join(", ")}</p>
                      )}
                    </div>
                    <ArrowRightLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                    <Select
                      value={confirmedMapping[header] || "ignore"}
                      onValueChange={(val) => setConfirmedMapping(prev => ({ ...prev, [header]: val }))}
                    >
                      <SelectTrigger className="text-sm h-9" data-testid={`select-award-mapping-${header}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="origin_city">Origin City</SelectItem>
                        <SelectItem value="origin_state">Origin State</SelectItem>
                        <SelectItem value="origin_zip">Origin ZIP</SelectItem>
                        <SelectItem value="dest_city">Destination City</SelectItem>
                        <SelectItem value="dest_state">Destination State</SelectItem>
                        <SelectItem value="dest_zip">Destination ZIP</SelectItem>
                        <SelectItem value="volume">Volume (loads)</SelectItem>
                        <SelectItem value="equipment">Equipment Type</SelectItem>
                        <SelectItem value="lane_id">Lane ID</SelectItem>
                        <SelectItem value="miles">Miles / Distance</SelectItem>
                        <SelectItem value="ignore">Ignore</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                variant="outline"
                onClick={() => { setColumnMappingOpen(false); setColumnMappingData(null); setConfirmedMapping({}); setPendingLaneFile(null); }}
                data-testid="button-cancel-award-mapping"
              >
                Cancel
              </Button>
              <Button
                onClick={handleExtractLanes}
                disabled={extractingLanes || missingFields.length > 0}
                data-testid="button-confirm-award-mapping"
              >
                {extractingLanes ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Extracting lanes…</>
                ) : (
                  <><CheckCircle className="h-4 w-4 mr-2" />Extract Lanes</>
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
