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
import type { Award, InsertAward, Company } from "@shared/schema";

const awardSchema = z.object({
  companyId: z.string().min(1, "Company is required"),
  title: z.string().min(1, "Title is required"),
  value: z.string().optional(),
  awardDate: z.string().optional(),
  lanes: z.string().optional(),
  notes: z.string().optional(),
});

type AwardFormData = z.infer<typeof awardSchema>;

interface AwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  award?: Award;
}

export function AwardDialog({ open, onOpenChange, award }: AwardDialogProps) {
  const { toast } = useToast();
  const isEditing = !!award;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; data: string } | null>(null);

  const { data: companies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const form = useForm<AwardFormData>({
    resolver: zodResolver(awardSchema),
    defaultValues: {
      companyId: "",
      title: "",
      value: "",
      awardDate: "",
      lanes: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (award) {
      form.reset({
        companyId: award.companyId || "",
        title: award.title || "",
        value: award.value || "",
        awardDate: award.awardDate || "",
        lanes: award.lanes?.join(", ") || "",
        notes: award.notes || "",
      });
      setSelectedFile(award.fileName ? { name: award.fileName, data: award.fileData || "" } : null);
    } else {
      form.reset({
        companyId: "",
        title: "",
        value: "",
        awardDate: "",
        lanes: "",
        notes: "",
      });
      setSelectedFile(null);
    }
  }, [award, form]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      toast({ title: "File too large", description: "Please select a file under 10MB.", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedFile({ name: file.name, data: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  const createMutation = useMutation({
    mutationFn: async (data: InsertAward) => {
      const response = await apiRequest("POST", "/api/awards", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      toast({ title: "Award created successfully" });
      onOpenChange(false);
      form.reset();
      setSelectedFile(null);
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
    const lanesArray = data.lanes
      ? data.lanes.split(",").map((l) => l.trim()).filter(Boolean)
      : null;

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
                  <FormLabel>Award Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Southeast Lanes Award" {...field} data-testid="input-award-title" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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

            <FormField
              control={form.control}
              name="lanes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lanes (comma-separated)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., ATL-CHI, DAL-LAX" {...field} data-testid="input-award-lanes" />
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
                    <Textarea placeholder="Any additional notes about this award..." {...field} data-testid="input-award-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <FormLabel>Attachment (optional)</FormLabel>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg"
                onChange={handleFileChange}
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
                    onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
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
                  onClick={() => fileInputRef.current?.click()}
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
  );
}
