import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2 } from "lucide-react";
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

export function RfpDialog({ open, onOpenChange, rfp, defaultCompanyId }: RfpDialogProps) {
  const { toast } = useToast();
  const isEditing = !!rfp;

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

  const onSubmit = (data: RfpFormData) => {
    const payload: any = {
      companyId: data.companyId,
      title: data.title,
      status: data.status,
      rfpType: data.rfpType || null,
      value: data.value || null,
      dueDate: data.dueDate || null,
      notes: data.notes || null,
      closeReason: CLOSED_STATUSES.includes(data.status) ? (data.closeReason || null) : null,
      closeNotes: CLOSED_STATUSES.includes(data.status) ? (data.closeNotes || null) : null,
      fileName: isEditing ? (rfp?.fileName ?? null) : null,
      fileData: isEditing ? (rfp?.fileData ?? null) : null,
      laneCount: isEditing ? (rfp?.laneCount ?? null) : null,
      totalVolume: isEditing ? (rfp?.totalVolume ?? null) : null,
      originStates: isEditing ? (rfp?.originStates ?? null) : null,
      destinationStates: isEditing ? (rfp?.destinationStates ?? null) : null,
    };

    if (isEditing) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

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
