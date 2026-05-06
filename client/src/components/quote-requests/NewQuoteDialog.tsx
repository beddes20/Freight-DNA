/**
 * Task #863 — New Quote composer dialog.
 *
 * A real composer (replacing the previous "navigate to /customers" stub)
 * that POSTs to /api/customer-quotes/quote and opens the resulting
 * opportunity in the drawer. Customer is required; lane + equipment are
 * required by the server schema; quoted amount, valid-through, and notes
 * are optional structured fields.
 */
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2, Check, ChevronsUpDown } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EQUIPMENT_OPTIONS = ["Dry Van", "Reefer", "Flatbed", "Power Only", "Stepdeck", "Other"] as const;

const newQuoteSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  originCity: z.string().min(1, "Required").max(80),
  originState: z.string().min(2, "Required").max(8),
  destCity: z.string().min(1, "Required").max(80),
  destState: z.string().min(2, "Required").max(8),
  equipment: z.string().min(1, "Required").max(40),
  requestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  quotedAmount: z.string().optional(),
  validThrough: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

type FormValues = z.infer<typeof newQuoteSchema>;

interface CustomerOption {
  id: string;
  name: string;
}

export type NewQuoteInitialValues = Partial<Omit<FormValues, "requestDate">>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customers: CustomerOption[];
  onCreated: (quoteId: string) => void;
  /**
   * Optional prefill for the form, e.g. when the user kicks the dialog
   * open from Spot Quote Search results. Shallow-merged over the empty
   * defaults each time the dialog opens.
   */
  initialValues?: NewQuoteInitialValues;
}

export function NewQuoteDialog({ open, onOpenChange, customers, onCreated, initialValues }: Props): JSX.Element {
  const { toast } = useToast();
  const [customerOpen, setCustomerOpen] = useState(false);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [open]);

  const baseDefaults = useMemo<FormValues>(() => ({
    customerId: "",
    originCity: "",
    originState: "",
    destCity: "",
    destState: "",
    equipment: "Dry Van",
    requestDate: today,
    quotedAmount: "",
    validThrough: "",
    notes: "",
  }), [today]);

  const form = useForm<FormValues>({
    resolver: zodResolver(newQuoteSchema),
    defaultValues: baseDefaults,
  });

  // Apply prefill whenever the dialog is opened with new initialValues
  // (Spot Search → New Quote handoff). When closed we fully reset.
  useEffect(() => {
    if (open) {
      form.reset({ ...baseDefaults, ...(initialValues ?? {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues]);

  const createMut = useMutation({
    mutationFn: async (vals: FormValues) => {
      const body: Record<string, unknown> = {
        customerId: vals.customerId,
        originCity: vals.originCity.trim(),
        originState: vals.originState.trim().toUpperCase(),
        destCity: vals.destCity.trim(),
        destState: vals.destState.trim().toUpperCase(),
        equipment: vals.equipment,
        requestDate: new Date(`${vals.requestDate}T12:00:00Z`).toISOString(),
        source: "manual",
      };
      if (vals.quotedAmount && vals.quotedAmount.trim()) {
        body.quotedAmount = vals.quotedAmount.trim();
      }
      if (vals.validThrough && vals.validThrough.trim()) {
        body.validThrough = new Date(`${vals.validThrough}T12:00:00Z`).toISOString();
      }
      if (vals.notes && vals.notes.trim()) body.notes = vals.notes.trim();
      const res = await apiRequest("POST", "/api/customer-quotes/quote", body);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
      return json as { opp: { id: string } };
    },
    onSuccess: (data) => {
      toast({ title: "Quote created", description: "Opening it now." });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      onOpenChange(false);
      form.reset();
      onCreated(data.opp.id);
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not create quote",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const selectedCustomer = customers.find(c => c.id === form.watch("customerId"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-new-quote">
        <DialogHeader>
          <DialogTitle>New quote</DialogTitle>
          <DialogDescription>
            Log a manual quote request when there's no inbound email to capture.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => createMut.mutate(v))} className="space-y-3">
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Customer</FormLabel>
                  <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          className="justify-between font-normal"
                          data-testid="button-pick-customer"
                        >
                          {selectedCustomer?.name ?? "Pick a customer…"}
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
                      <Command>
                        <CommandInput placeholder="Search customers…" data-testid="input-customer-search" />
                        <CommandList>
                          <CommandEmpty>No customer found.</CommandEmpty>
                          <CommandGroup>
                            {customers.map(c => (
                              <CommandItem
                                key={c.id}
                                value={c.name}
                                onSelect={() => {
                                  field.onChange(c.id);
                                  setCustomerOpen(false);
                                }}
                                data-testid={`option-customer-${c.id}`}
                              >
                                <Check
                                  className={`mr-2 h-3.5 w-3.5 ${field.value === c.id ? "opacity-100" : "opacity-0"}`}
                                />
                                {c.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-3 gap-2">
              <FormField control={form.control} name="originCity" render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>Origin city</FormLabel>
                  <FormControl><Input {...field} data-testid="input-origin-city" placeholder="Chicago" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="originState" render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl><Input {...field} data-testid="input-origin-state" maxLength={3} placeholder="IL" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <FormField control={form.control} name="destCity" render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>Destination city</FormLabel>
                  <FormControl><Input {...field} data-testid="input-dest-city" placeholder="Atlanta" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="destState" render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl><Input {...field} data-testid="input-dest-state" maxLength={3} placeholder="GA" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <FormField control={form.control} name="equipment" render={({ field }) => (
                <FormItem>
                  <FormLabel>Equipment</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-equipment"><SelectValue /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {EQUIPMENT_OPTIONS.map(eq => (
                        <SelectItem key={eq} value={eq}>{eq}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="requestDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Request date</FormLabel>
                  <FormControl><Input type="date" {...field} data-testid="input-request-date" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <FormField control={form.control} name="quotedAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Quoted amount (optional)</FormLabel>
                  <FormControl><Input inputMode="decimal" {...field} data-testid="input-quoted-amount" placeholder="$" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="validThrough" render={({ field }) => (
                <FormItem>
                  <FormLabel>Valid through (optional)</FormLabel>
                  <FormControl><Input type="date" {...field} data-testid="input-valid-through" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes (optional)</FormLabel>
                <FormControl><Textarea rows={2} {...field} data-testid="input-notes" placeholder="Any context for this quote…" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} data-testid="button-cancel-new-quote">
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending} data-testid="button-submit-new-quote">
                {createMut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Create quote
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
