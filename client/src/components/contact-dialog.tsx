import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2, HelpCircle } from "lucide-react";
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
  FormDescription,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Contact, InsertContact } from "@shared/schema";

const contactSchema = z.object({
  name: z.string().min(1, "Name is required"),
  title: z.string().optional(),
  relationshipBase: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  reportsToId: z.string().optional(),
  lanes: z.string().optional(),
  regions: z.string().optional(),
  freightSpend: z.string().optional(),
  spotBiddingProcess: z.string().optional(),
  nextSteps: z.string().optional(),
  interests: z.string().optional(),
  notes: z.string().optional(),
});

type ContactFormData = z.infer<typeof contactSchema>;

interface ContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  contact?: Contact;
  defaults?: { lane?: string; region?: string };
}

export function ContactDialog({ open, onOpenChange, companyId, contact, defaults }: ContactDialogProps) {
  const { toast } = useToast();
  const isEditing = !!contact;

  const { data: contacts } = useQuery<Contact[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
  });

  const availableManagers = contacts?.filter((c) => c.id !== contact?.id) || [];

  const form = useForm<ContactFormData>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: "",
      title: "",
      relationshipBase: "",
      email: "",
      phone: "",
      reportsToId: "",
      lanes: "",
      regions: "",
      freightSpend: "",
      spotBiddingProcess: "",
      nextSteps: "",
      interests: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (contact) {
      form.reset({
        name: contact.name || "",
        title: contact.title || "",
        relationshipBase: contact.relationshipBase || "",
        email: contact.email || "",
        phone: contact.phone || "",
        reportsToId: contact.reportsToId || "",
        lanes: contact.lanes?.join(", ") || "",
        regions: contact.regions?.join(", ") || "",
        freightSpend: contact.freightSpend || "",
        spotBiddingProcess: contact.spotBiddingProcess || "",
        nextSteps: contact.nextSteps || "",
        interests: contact.interests || "",
        notes: contact.notes || "",
      });
    } else {
      form.reset({
        name: "",
        title: "",
        relationshipBase: "",
        email: "",
        phone: "",
        reportsToId: "",
        lanes: defaults?.lane || "",
        regions: defaults?.region || "",
        freightSpend: "",
        spotBiddingProcess: "",
        nextSteps: "",
        interests: "",
        notes: defaults?.lane ? `Contact needed for lane: ${defaults.lane}` : "",
      });
    }
  }, [contact, form, defaults]);

  const { fire: fireConfetti, ConfettiOverlay } = useConfetti();

  const createMutation = useMutation({
    mutationFn: async (data: InsertContact) => {
      const response = await apiRequest("POST", `/api/companies/${companyId}/contacts`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "facility-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "relationship-freight-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/relationship-freight-summary"] });
      toast({
        title: "🎉 Contact created!",
        description: "New contact added to your org chart",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
      fireConfetti();
      setTimeout(() => {
        onOpenChange(false);
        form.reset();
      }, 800);
    },
    onError: (error: Error) => {
      toast({ title: "Error creating contact", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: InsertContact) => {
      const response = await apiRequest("PATCH", `/api/contacts/${contact?.id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "facility-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "relationship-freight-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/relationship-freight-summary"] });
      toast({
        title: "✅ Contact updated!",
        description: "Changes saved successfully",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
      fireConfetti();
      setTimeout(() => onOpenChange(false), 800);
    },
    onError: (error: Error) => {
      toast({ title: "Error updating contact", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: ContactFormData) => {
    const payload: InsertContact = {
      companyId,
      name: data.name,
      title: data.title || null,
      relationshipBase: data.relationshipBase || null,
      email: data.email || null,
      phone: data.phone || null,
      reportsToId: data.reportsToId || null,
      lanes: data.lanes ? data.lanes.split(",").map((s) => s.trim()).filter(Boolean) : null,
      regions: data.regions ? data.regions.split(",").map((s) => s.trim()).filter(Boolean) : null,
      freightSpend: data.freightSpend || null,
      spotBiddingProcess: data.spotBiddingProcess || null,
      nextSteps: data.nextSteps || null,
      interests: data.interests || null,
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
    <>
    {ConfettiOverlay && <ConfettiOverlay />}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Contact" : "Add Contact"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Full Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., John Smith" {...field} data-testid="input-contact-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Job Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Director of Logistics" {...field} data-testid="input-contact-title" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="relationshipBase"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <div className="flex items-center gap-1.5">
                      <FormLabel>Relationship Base</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="button-relationship-base-info">
                            <HelpCircle className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="right" align="start" className="w-96 p-0 overflow-hidden">
                          <div className="bg-muted/60 px-4 py-2.5 border-b">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relationship Guide</p>
                          </div>
                          <div className="divide-y">
                            <div className="px-4 py-3 space-y-1">
                              <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">⚾ 1st Base</p>
                              <p className="text-xs text-muted-foreground leading-relaxed">Introduction stage — email/phone, still a little uncomfortable. Purely transactional. Win a spot load, even at break-even, to build trust and relevance. Sporadic freight.</p>
                            </div>
                            <div className="px-4 py-3 space-y-1">
                              <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">⚾⚾ 2nd Base</p>
                              <p className="text-xs text-muted-foreground leading-relaxed">Trust is building. Memes/GIFs in email, maybe texting. You know their outside-of-work interests and what makes them look good to their boss. Spot freight with some contract potential. Introductions starting to happen.</p>
                            </div>
                            <div className="px-4 py-3 space-y-1">
                              <p className="text-sm font-semibold text-green-600 dark:text-green-400">⚾⚾⚾ 3rd Base</p>
                              <p className="text-xs text-muted-foreground leading-relaxed">Trusted carrier — you've bailed them out. Cell-to-cell, met in person. You're becoming an extension of their supply chain. Transparency into projects and off-RFP freight. Chunks of contracted lanes. Price starts to be secondary.</p>
                            </div>
                            <div className="px-4 py-3 space-y-1">
                              <p className="text-sm font-semibold text-primary">🏠 Homerun</p>
                              <p className="text-xs text-muted-foreground leading-relaxed">They're a friend. First call for market intel, capacity crunches, and new projects. You get RFP feedback only a handful of carriers see. Talked about positively in their team meetings. Price is secondary — it's about trust.</p>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger data-testid="select-contact-relationship-base">
                          <SelectValue placeholder="Select relationship level…" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="1st Base">⚾ 1st Base — Introduction / Transactional</SelectItem>
                        <SelectItem value="2nd Base">⚾⚾ 2nd Base — Trust Building</SelectItem>
                        <SelectItem value="3rd Base">⚾⚾⚾ 3rd Base — Trusted Carrier</SelectItem>
                        <SelectItem value="Homerun">🏠 Homerun — Extension of Their Team</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="john@example.com" {...field} data-testid="input-contact-email" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="(555) 123-4567" {...field} data-testid="input-contact-phone" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="reportsToId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reports To</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || ""}>
                    <FormControl>
                      <SelectTrigger data-testid="select-reports-to">
                        <SelectValue placeholder="Select manager (optional)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">No manager</SelectItem>
                      {availableManagers.map((manager) => (
                        <SelectItem key={manager.id} value={manager.id}>
                          {manager.name} {manager.title ? `- ${manager.title}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Set the org chart hierarchy by selecting who this person reports to
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-medium mb-3">Transportation Details</h4>
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="lanes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Lanes</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Chicago to Dallas, LA to Phoenix" {...field} data-testid="input-contact-lanes" />
                      </FormControl>
                      <FormDescription>Separate multiple lanes with commas</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="regions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Regions</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Midwest, Southeast, West Coast" {...field} data-testid="input-contact-regions" />
                      </FormControl>
                      <FormDescription>Separate multiple regions with commas</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="freightSpend"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Annual Freight Spend ($)</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="e.g., 5000000" {...field} data-testid="input-contact-freight-spend" />
                      </FormControl>
                      <FormDescription>Estimated annual freight spend in dollars</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="spotBiddingProcess"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Spot Bidding Process</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="Describe their spot bidding process, timing, preferences..." 
                          {...field} 
                          data-testid="input-contact-spot-bidding"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="nextSteps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Next Steps</FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="What are the next steps with this contact?" 
                      {...field} 
                      data-testid="input-contact-next-steps"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="interests"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Interests Outside of Work</FormLabel>
                  <FormControl>
                    <Textarea 
                      placeholder="e.g., Golf, fishing, family activities, travel..." 
                      {...field} 
                      data-testid="input-contact-interests"
                    />
                  </FormControl>
                  <FormDescription>Personal interests to help build rapport</FormDescription>
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
                    <Textarea placeholder="Any additional notes about this contact..." {...field} data-testid="input-contact-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-contact">
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} data-testid="button-save-contact">
                {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Contact"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    </>
  );
}
