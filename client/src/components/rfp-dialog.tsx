import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2, Paperclip, X } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Rfp, InsertRfp, Company } from "@shared/schema";

const rfpSchema = z.object({
  companyId: z.string().min(1, "Company is required"),
  title: z.string().min(1, "Title is required"),
  status: z.string().min(1, "Status is required"),
  rfpType: z.string().min(1, "RFP type is required"),
  value: z.string().optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  closeReason: z.string().optional(),
  closeNotes: z.string().optional(),
});

type RfpFormData = z.infer<typeof rfpSchema>;

interface ParsedFileFields {
  fileName: string;
  fileData: unknown;
  laneCount: number | null;
  totalVolume: string | null;
  originStates: string[] | null;
  destinationStates: string[] | null;
}

interface ParseFileResponse extends ParsedFileFields {
  fileName: string;
}

interface ExtractedLane {
  origin_state?: string;
  dest_state?: string;
  volume?: number | string;
  [key: string]: unknown;
}

interface UploadRfpResponse {
  rfp: Rfp;
}

interface PdfPreviewResponse {
  isPdf: boolean;
  extractedLanes: ExtractedLane[];
  laneCount: number;
}

const CLOSED_STATUSES = ["lost", "awarded", "partially_awarded", "declined"];

const CLOSE_REASONS = [
  { value: "price", label: "Price / Rate too high" },
  { value: "incumbent", label: "Incumbent advantage" },
  { value: "no_response", label: "No response from customer" },
  { value: "capacity", label: "Capacity constraints" },
  { value: "lane_coverage", label: "Lane coverage gap" },
  { value: "relationship", label: "Relationship / trust" },
  { value: "service", label: "Service concerns" },
  { value: "awarded_us", label: "Awarded to us" },
  { value: "other", label: "Other" },
];

interface RfpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rfp?: Rfp;
  defaultCompanyId?: string;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const body = await res.json().catch(() => ({ error: "Unexpected error" })) as { error?: string } & T;
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body as T;
}

async function parseFileForEdit(file: File): Promise<ParsedFileFields> {
  const fileExt = file.name.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");

  if (fileExt === ".pdf") {
    const form = new FormData();
    form.append("file", file);
    const preview = await fetchJson<PdfPreviewResponse>("/api/rfps/preview-headers", { method: "POST", body: form });
    const lanes = preview.extractedLanes ?? [];
    const originStates = [...new Set(lanes.map((l) => l.origin_state).filter((s): s is string => Boolean(s)))];
    const destinationStates = [...new Set(lanes.map((l) => l.dest_state).filter((s): s is string => Boolean(s)))];
    const totalVolume = lanes.reduce((sum, l) => sum + (Number(l.volume) || 0), 0);
    const highVolumeLanes = lanes
      .filter((l) => Number(l.volume) > 0)
      .sort((a, b) => Number(b.volume) - Number(a.volume))
      .slice(0, 10);
    return {
      fileName: file.name,
      fileData: { rows: lanes, highVolumeLanes, sheetName: "PDF Extract" },
      laneCount: lanes.length,
      totalVolume: String(totalVolume),
      originStates,
      destinationStates,
    };
  }

  const form = new FormData();
  form.append("file", file);
  const parsed = await fetchJson<ParseFileResponse>("/api/rfps/parse-file", { method: "POST", body: form });
  return {
    fileName: parsed.fileName,
    fileData: parsed.fileData,
    laneCount: parsed.laneCount,
    totalVolume: parsed.totalVolume,
    originStates: parsed.originStates,
    destinationStates: parsed.destinationStates,
  };
}

export function RfpDialog({ open, onOpenChange, rfp, defaultCompanyId }: RfpDialogProps) {
  const { toast } = useToast();
  const isEditing = !!rfp;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: companies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const form = useForm<RfpFormData>({
    resolver: zodResolver(rfpSchema),
    defaultValues: {
      companyId: "",
      title: "",
      status: "pending",
      rfpType: "",
      value: "",
      dueDate: "",
      notes: "",
      closeReason: "",
      closeNotes: "",
    },
  });

  const watchedStatus = form.watch("status");
  const showCloseFields = CLOSED_STATUSES.includes(watchedStatus);

  useEffect(() => {
    if (rfp) {
      form.reset({
        companyId: rfp.companyId || "",
        title: rfp.title || "",
        status: rfp.status || "pending",
        rfpType: rfp.rfpType || "",
        value: rfp.value || "",
        dueDate: rfp.dueDate || "",
        notes: rfp.notes || "",
        closeReason: rfp.closeReason || "",
        closeNotes: rfp.closeNotes || "",
      });
    } else {
      form.reset({
        companyId: defaultCompanyId ?? "",
        title: "",
        status: "pending",
        rfpType: "",
        value: "",
        dueDate: "",
        notes: "",
        closeReason: "",
        closeNotes: "",
      });
    }
    setSelectedFile(null);
  }, [rfp, open, defaultCompanyId]);

  const createMutation = useMutation({
    mutationFn: async (data: InsertRfp) => {
      const response = await apiRequest("POST", "/api/rfps", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({ title: "RFP created successfully" });
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Error creating RFP", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: InsertRfp) => {
      const response = await apiRequest("PATCH", `/api/rfps/${rfp?.id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({ title: "RFP updated successfully" });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error updating RFP", description: error.message, variant: "destructive" });
    },
  });

  const buildPayload = (data: RfpFormData, fileFields: ParsedFileFields | null): InsertRfp => ({
    companyId: data.companyId,
    title: data.title,
    status: data.status,
    rfpType: data.rfpType || null,
    value: data.value || null,
    dueDate: data.dueDate || null,
    notes: data.notes || null,
    closeReason: CLOSED_STATUSES.includes(data.status) ? (data.closeReason || null) : null,
    closeNotes: CLOSED_STATUSES.includes(data.status) ? (data.closeNotes || null) : null,
    fileName: fileFields?.fileName ?? (isEditing ? (rfp?.fileName ?? null) : null),
    fileData: fileFields?.fileData ?? (isEditing ? (rfp?.fileData ?? null) : null),
    laneCount: fileFields?.laneCount ?? (isEditing ? (rfp?.laneCount ?? null) : null),
    totalVolume: fileFields?.totalVolume ?? (isEditing ? (rfp?.totalVolume ?? null) : null),
    originStates: fileFields?.originStates ?? (isEditing ? (rfp?.originStates ?? null) : null),
    destinationStates: fileFields?.destinationStates ?? (isEditing ? (rfp?.destinationStates ?? null) : null),
  });

  const onSubmit = async (data: RfpFormData) => {
    if (!selectedFile) {
      if (isEditing) {
        updateMutation.mutate(buildPayload(data, null));
      } else {
        createMutation.mutate(buildPayload(data, null));
      }
      return;
    }

    setIsUploading(true);
    try {
      const fileExt = selectedFile.name.toLowerCase().replace(/.*(\.[^.]+)$/, "$1");
      const isPdf = fileExt === ".pdf";

      if (isEditing) {
        const fileFields = await parseFileForEdit(selectedFile);
        updateMutation.mutate(buildPayload(data, fileFields));
        return;
      }

      if (isPdf) {
        const previewForm = new FormData();
        previewForm.append("file", selectedFile);
        const preview = await fetchJson<PdfPreviewResponse>("/api/rfps/preview-headers", {
          method: "POST",
          body: previewForm,
        });
        const lanes = preview.extractedLanes ?? [];

        const uploadResult = await fetchJson<UploadRfpResponse>("/api/rfps/upload-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: data.companyId,
            rfpType: data.rfpType || null,
            lanes,
            fileName: selectedFile.name,
            title: data.title,
          }),
        });
        const uploadedRfp = uploadResult.rfp;

        const patchRes = await apiRequest("PATCH", `/api/rfps/${uploadedRfp.id}`, buildPayload(data, {
          fileName: uploadedRfp.fileName ?? selectedFile.name,
          fileData: uploadedRfp.fileData,
          laneCount: uploadedRfp.laneCount,
          totalVolume: uploadedRfp.totalVolume,
          originStates: uploadedRfp.originStates,
          destinationStates: uploadedRfp.destinationStates,
        }));
        if (!patchRes.ok) {
          throw new Error("RFP was saved but form fields could not be applied. Please edit the RFP to set the correct status, value, and due date.");
        }

        queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
        toast({ title: "RFP created successfully" });
        onOpenChange(false);
        form.reset();
      } else {
        const uploadForm = new FormData();
        uploadForm.append("file", selectedFile);
        uploadForm.append("companyId", data.companyId);
        uploadForm.append("title", data.title);
        if (data.rfpType) uploadForm.append("rfpType", data.rfpType);

        const uploadResult = await fetchJson<UploadRfpResponse>("/api/rfps/upload", {
          method: "POST",
          body: uploadForm,
        });
        const uploadedRfp = uploadResult.rfp;

        const patchRes = await apiRequest("PATCH", `/api/rfps/${uploadedRfp.id}`, buildPayload(data, {
          fileName: uploadedRfp.fileName ?? selectedFile.name,
          fileData: uploadedRfp.fileData,
          laneCount: uploadedRfp.laneCount,
          totalVolume: uploadedRfp.totalVolume,
          originStates: uploadedRfp.originStates,
          destinationStates: uploadedRfp.destinationStates,
        }));
        if (!patchRes.ok) {
          throw new Error("RFP was saved but form fields could not be applied. Please edit the RFP to set the correct status, value, and due date.");
        }

        queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
        toast({ title: "RFP created successfully" });
        onOpenChange(false);
        form.reset();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      toast({ title: "Error saving RFP", description: message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending || isUploading;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file && !form.getValues("title")) {
      form.setValue("title", file.name.replace(/\.[^.]+$/, ""));
    }
  };

  const clearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const existingFileName = rfp?.fileName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit RFP" : "Add RFP"}</DialogTitle>
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
                      <SelectTrigger data-testid="select-rfp-company">
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
                  <FormLabel>RFP Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Q1 2024 Midwest Lanes RFP" {...field} data-testid="input-rfp-title" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-rfp-status">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="submitted">Submitted</SelectItem>
                      <SelectItem value="awarded">Awarded ✅</SelectItem>
                      <SelectItem value="partially_awarded">Partially Awarded ✅</SelectItem>
                      <SelectItem value="lost">Lost ❌</SelectItem>
                      <SelectItem value="declined">Declined / No Bid</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="rfpType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>RFP Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-rfp-type">
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="mini_bid">Mini Bid</SelectItem>
                      <SelectItem value="full_rfp">Full RFP</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {showCloseFields && (
              <>
                <FormField
                  control={form.control}
                  name="closeReason"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Close Reason</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value || ""}>
                        <FormControl>
                          <SelectTrigger data-testid="select-rfp-close-reason">
                            <SelectValue placeholder="Why did this close?" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {CLOSE_REASONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="closeNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Close Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                      <FormControl>
                        <Textarea placeholder="What happened? What did we learn?" {...field} data-testid="input-rfp-close-notes" rows={2} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <FormField
              control={form.control}
              name="value"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated Value ($)</FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="e.g., 500000" {...field} data-testid="input-rfp-value" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Due Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-rfp-due-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any additional notes about this RFP..." {...field} data-testid="input-rfp-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <p className="text-sm font-medium">RFP File <span className="text-muted-foreground font-normal">(optional)</span></p>
              {existingFileName && !selectedFile && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted rounded px-3 py-2" data-testid="text-existing-filename">
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{existingFileName}</span>
                  <span className="text-xs ml-auto shrink-0">Current file</span>
                </div>
              )}
              {selectedFile ? (
                <div className="flex items-center gap-2 text-sm bg-muted rounded px-3 py-2" data-testid="text-selected-filename">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="truncate flex-1">{selectedFile.name}</span>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    data-testid="button-clear-file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full"
                  data-testid="button-attach-file"
                >
                  <Paperclip className="h-4 w-4 mr-2" />
                  {existingFileName ? "Replace file" : "Attach file"}
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                className="hidden"
                onChange={handleFileChange}
                data-testid="input-rfp-file"
              />
              <p className="text-xs text-muted-foreground">Accepts Excel (.xlsx, .xls), CSV, or PDF files</p>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-rfp">
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} data-testid="button-save-rfp">
                {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add RFP"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
