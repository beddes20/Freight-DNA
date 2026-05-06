/**
 * Task #968 — Convert-to-quote handoff from the Conversations detail pane.
 *
 * One-step rep workflow: from any thread the rep can spin up a quote
 * opportunity that's already linked back to the originating email
 * conversation. The server resolves `sourceThreadId` to the most recent
 * inbound message on the thread and stamps it as `source = "email"` /
 * `sourceReference = <message.id>` so the new opp shows up in the Quote
 * Opportunities table with a working "Open in Conversations" deep-link
 * (matching the email-ingested contract).
 *
 * The customer picker is sourced from the same `/api/customer-quotes/snapshot`
 * payload that the Quote Requests page uses, so we don't add a new
 * customer-list endpoint just for this dialog.
 */
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { buildConvertToQuoteDefaults } from "@/lib/conversations/convertToQuoteDefaults";
export { buildConvertToQuoteDefaults };
import { Loader2, Check, ChevronsUpDown } from "lucide-react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const EQUIPMENT_OPTIONS = ["Dry Van", "Reefer", "Flatbed", "Power Only", "Stepdeck", "Other"] as const;

const convertSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  originCity: z.string().min(1, "Required").max(80),
  originState: z.string().min(1, "Required").max(8),
  destCity: z.string().min(1, "Required").max(80),
  destState: z.string().min(1, "Required").max(8),
  equipment: z.string().min(1, "Required").max(40),
  quotedAmount: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

type FormValues = z.infer<typeof convertSchema>;

interface CustomerOption { id: string; name: string }

interface SnapshotPayload { customers?: CustomerOption[] }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Outlook conversationId — server resolves this to a concrete message id. */
  sourceThreadId: string;
  /** Pre-filled subject line — surfaces in the dialog header so the rep
   *  can confirm they're converting the right thread. */
  threadSubject: string;
  /** Optional account name from the linked customer record — used to
   *  pre-select the customer if a name match exists. */
  prefillCustomerName?: string | null;
  /** Latest inbound message body — pre-filled into Notes (capped 1900 chars). */
  latestInboundBody?: string | null;
}

export function ConvertToQuoteDialog({
  open, onOpenChange, sourceThreadId, threadSubject, prefillCustomerName,
  latestInboundBody,
}: Props): JSX.Element {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [customerOpen, setCustomerOpen] = useState(false);

  // Lazy-load the customer list only when the dialog actually opens. The
  // snapshot endpoint is shared with the Quote Requests page so the
  // payload is almost always already cached when the rep clicks through.
  const snapshotQuery = useQuery<SnapshotPayload>({
    queryKey: ["/api/customer-quotes/snapshot"],
    enabled: open,
  });
  const customers = snapshotQuery.data?.customers ?? [];

  const baseDefaults = useMemo<FormValues>(
    () => buildConvertToQuoteDefaults(threadSubject, latestInboundBody),
    [threadSubject, latestInboundBody],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(convertSchema),
    defaultValues: baseDefaults,
  });

  // Best-effort customer pre-select: if the thread is linked to an
  // account whose name exactly matches a quote-customer record, surface
  // it as the default. Anything else (no link, no match) leaves the
  // picker empty so the rep is forced to choose explicitly.
  useEffect(() => {
    if (!open) return;
    form.reset({
      ...baseDefaults,
      customerId: prefillCustomerName
        ? (customers.find(c => c.name.toLowerCase() === prefillCustomerName.toLowerCase())?.id ?? "")
        : "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillCustomerName, customers.length]);

  const createMut = useMutation({
    mutationFn: async (vals: FormValues) => {
      const body: Record<string, unknown> = {
        customerId: vals.customerId,
        originCity: vals.originCity.trim(),
        originState: vals.originState.trim().toUpperCase(),
        destCity: vals.destCity.trim(),
        destState: vals.destState.trim().toUpperCase(),
        equipment: vals.equipment,
        // Server fills in the rest of the source contract: it resolves
        // sourceThreadId → latest message id and stamps source="email".
        sourceThreadId,
      };
      if (vals.quotedAmount && vals.quotedAmount.trim()) {
        body.quotedAmount = vals.quotedAmount.trim();
      }
      if (vals.notes && vals.notes.trim()) body.notes = vals.notes.trim();
      const res = await apiRequest("POST", "/api/customer-quotes/quote", body);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
      return json as { opp: { id: string } };
    },
    onSuccess: (data) => {
      const openHref = `/quote-requests?selected=${encodeURIComponent(data.opp.id)}`;
      toast({
        title: "Quote created from this thread",
        description: "It's been added to Quote Requests with this conversation linked as the source.",
        action: (
          <ToastAction
            altText="Open quote"
            onClick={() => setLocation(openHref)}
            data-testid="toast-action-open-converted-quote"
          >
            Open quote
          </ToastAction>
        ),
      });
      // Refresh the Quote Requests caches AND the source thread so the
      // detail-pane events feed picks up the just-recorded conversion
      // (which adds a "Converted to quote" timeline entry on the
      // server side).
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/action-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Could not convert this thread",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const selectedCustomer = customers.find(c => c.id === form.watch("customerId"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-convert-to-quote">
        <DialogHeader>
          <DialogTitle>Convert thread to quote</DialogTitle>
          <DialogDescription>
            Spin up a quote opportunity linked back to this email conversation.
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
                          data-testid="button-pick-customer-convert"
                        >
                          {selectedCustomer?.name ?? "Pick a customer…"}
                          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
                      <Command>
                        <CommandInput placeholder="Search customers…" data-testid="input-customer-search-convert" />
                        <CommandList>
                          <CommandEmpty>No customer found.</CommandEmpty>
                          <CommandGroup>
                            {customers.map(c => (
                              <CommandItem
                                key={c.id}
                                value={c.name}
                                onSelect={() => { field.onChange(c.id); setCustomerOpen(false); }}
                                data-testid={`option-customer-convert-${c.id}`}
                              >
                                <Check className={`mr-2 h-3.5 w-3.5 ${field.value === c.id ? "opacity-100" : "opacity-0"}`} />
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
                  <FormControl><Input {...field} data-testid="input-origin-city-convert" placeholder="Chicago" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="originState" render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl><Input {...field} data-testid="input-origin-state-convert" maxLength={3} placeholder="IL" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <FormField control={form.control} name="destCity" render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>Destination city</FormLabel>
                  <FormControl><Input {...field} data-testid="input-dest-city-convert" placeholder="Atlanta" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="destState" render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl><Input {...field} data-testid="input-dest-state-convert" maxLength={3} placeholder="GA" /></FormControl>
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
                      <SelectTrigger data-testid="select-equipment-convert"><SelectValue /></SelectTrigger>
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
              <FormField control={form.control} name="quotedAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Quoted amount (optional)</FormLabel>
                  <FormControl><Input inputMode="decimal" {...field} data-testid="input-quoted-amount-convert" placeholder="$" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl><Textarea rows={2} {...field} data-testid="input-notes-convert" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-convert-to-quote"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMut.isPending}
                data-testid="button-submit-convert-to-quote"
              >
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
