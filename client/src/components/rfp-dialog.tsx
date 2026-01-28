import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
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
  value: z.string().optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
});

type RfpFormData = z.infer<typeof rfpSchema>;

interface RfpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rfp?: Rfp;
}

export function RfpDialog({ open, onOpenChange, rfp }: RfpDialogProps) {
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
      value: "",
      dueDate: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (rfp) {
      form.reset({
        companyId: rfp.companyId || "",
        title: rfp.title || "",
        status: rfp.status || "pending",
        value: rfp.value || "",
        dueDate: rfp.dueDate || "",
        notes: rfp.notes || "",
      });
    } else {
      form.reset({
        companyId: "",
        title: "",
        status: "pending",
        value: "",
        dueDate: "",
        notes: "",
      });
    }
  }, [rfp, form]);

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
    const payload: InsertRfp = {
      companyId: data.companyId,
      title: data.title,
      status: data.status,
      value: data.value || null,
      dueDate: data.dueDate || null,
      notes: data.notes || null,
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
                      {companies?.map((company) => (
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
                      <SelectItem value="won">Won</SelectItem>
                      <SelectItem value="lost">Lost</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add RFP"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
