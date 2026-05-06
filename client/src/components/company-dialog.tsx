import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useConfetti } from "@/components/confetti";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Company, InsertCompany, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

const SHIPPING_MODES = ["LTL", "FTL", "Drayage", "IMDL"];

const companySchema = z.object({
  name: z.string().min(1, "Company name is required"),
  industry: z.string().optional(),
  website: z.string().optional(),
  notes: z.string().optional(),
  assignedTo: z.string().optional(),
  estimatedFreightSpend: z.string().optional(),
  financialAlias: z.string().optional(),
  salesPersonId: z.string().optional(),
  // Account Owner (companies.ownerRepId) is intentionally NOT editable
  // from this generic dialog — it has stricter RBAC than the rest of
  // the company form and is edited from the company-detail page Intel
  // tab → Account Information portlet via PATCH /api/companies/:id/owner.
});

type CompanyFormData = z.infer<typeof companySchema>;

interface CompanyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: Company;
}

export function CompanyDialog({ open, onOpenChange, company }: CompanyDialogProps) {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const { fire: fireConfetti, ConfettiOverlay } = useConfetti();
  const isEditing = !!company;
  const isAdmin = currentUser?.role === "admin";
  const isNAM = currentUser?.role === "national_account_manager" || currentUser?.role === "director" || currentUser?.role === "sales" || currentUser?.role === "sales_director";
  const canAssign = isAdmin || isNAM;
  const canEditSalesPerson = isAdmin || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales_director";

  const [shippingModes, setShippingModes] = useState<string[]>([]);

  useEffect(() => {
    setShippingModes(company?.shippingModes ?? []);
  }, [company, open]);

  const { data: users = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
    enabled: canAssign,
  });

  const { data: allSalesUsers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/users/sales"],
    enabled: canEditSalesPerson,
  });
  const salesUsers = allSalesUsers.filter(u => u.role === "sales" || u.role === "sales_director");

  const form = useForm<CompanyFormData>({
    resolver: zodResolver(companySchema),
    defaultValues: {
      name: company?.name || "",
      industry: company?.industry || "",
      website: company?.website || "",
      notes: company?.notes || "",
      assignedTo: company?.assignedTo || (currentUser?.id || ""),
      estimatedFreightSpend: company?.estimatedFreightSpend?.toString() || "",
      financialAlias: company?.financialAlias || "",
      salesPersonId: company?.salesPersonId || "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: company?.name || "",
        industry: company?.industry || "",
        website: company?.website || "",
        notes: company?.notes || "",
        assignedTo: company?.assignedTo || (currentUser?.id || ""),
        estimatedFreightSpend: company?.estimatedFreightSpend?.toString() || "",
        financialAlias: company?.financialAlias || "",
        salesPersonId: company?.salesPersonId || "",
      });
      setShippingModes(company?.shippingModes ?? []);
    }
  }, [open, company]);

  const toggleMode = (mode: string) => {
    setShippingModes(prev => prev.includes(mode) ? prev.filter(m => m !== mode) : [...prev, mode]);
  };

  const createMutation = useMutation({
    mutationFn: async (data: InsertCompany) => {
      const response = await apiRequest("POST", "/api/companies", data);
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({ title: "🎉 New account added!" });
      fireConfetti();
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Error creating company", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: InsertCompany) => {
      const response = await apiRequest("PATCH", `/api/companies/${company?.id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", company?.id] });
      toast({ title: "Company updated successfully" });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: "Error updating company", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: CompanyFormData) => {
    const payload: any = {
      name: data.name,
      industry: data.industry || null,
      website: data.website || null,
      notes: data.notes || null,
      assignedTo: data.assignedTo || currentUser?.id || null,
      shippingModes: shippingModes.length > 0 ? shippingModes : [],
      estimatedFreightSpend: data.estimatedFreightSpend ? data.estimatedFreightSpend : null,
      financialAlias: data.financialAlias || null,
      salesPersonId: data.salesPersonId || null,
    };

    if (isEditing) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      {ConfettiOverlay && <ConfettiOverlay />}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Company" : "Add Company"}</DialogTitle>
          </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Acme Logistics" {...field} data-testid="input-company-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="industry"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Industry</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Manufacturing, Retail, Food & Beverage" {...field} data-testid="input-company-industry" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Shipping Modes */}
            <div>
              <label className="text-sm font-medium">Shipping Modes</label>
              <div className="flex gap-2 mt-1.5 flex-wrap">
                {SHIPPING_MODES.map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => toggleMode(mode)}
                    data-testid={`button-shipping-mode-${mode.toLowerCase()}`}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      shippingModes.includes(mode)
                        ? "bg-blue-600 text-white border-blue-600"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <FormField
              control={form.control}
              name="estimatedFreightSpend"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Est. Total Freight Spend ($/yr)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="e.g., 5000000"
                      {...field}
                      data-testid="input-estimated-freight-spend"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="website"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Website</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., https://example.com" {...field} data-testid="input-company-website" />
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
                    <Textarea placeholder="Any additional notes about this company..." {...field} data-testid="input-company-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {canAssign && users.length > 0 && (
              <FormField
                control={form.control}
                name="assignedTo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assigned To</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-company-assigned-to">
                          <SelectValue placeholder="Select account manager" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {users.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                          <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="financialAlias"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Financial Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Alternate name used in financial data" {...field} data-testid="input-financial-alias" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Account Owner (companies.ownerRepId) is edited from
                the company-detail Intel tab → Account Information
                portlet, not from this generic dialog. See PATCH
                /api/companies/:id/owner for the RBAC-gated path. */}
            {canEditSalesPerson && (
              <FormField
                control={form.control}
                name="salesPersonId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Salesperson</FormLabel>
                    <Select onValueChange={(v) => field.onChange(v === "__none__" ? "" : v)} value={field.value || "__none__"}>
                      <FormControl>
                        <SelectTrigger data-testid="select-salesperson">
                          <SelectValue placeholder="— None —" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">— None —</SelectItem>
                        {salesUsers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                          <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-company">
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} data-testid="button-save-company">
                {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Company"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    </>
  );
}
