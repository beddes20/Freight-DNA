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
  interests: z.string().optional(),
  notes: z.string().optional(),
});

type ContactFormData = z.infer<typeof contactSchema>;

interface ContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  contact?: Contact;
}

export function ContactDialog({ open, onOpenChange, companyId, contact }: ContactDialogProps) {
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
        lanes: "",
        regions: "",
        freightSpend: "",
        spotBiddingProcess: "",
        interests: "",
        notes: "",
      });
    }
  }, [contact, form]);

  const createMutation = useMutation({
    mutationFn: async (data: InsertContact) => {
      const response = await apiRequest("POST", `/api/companies/${companyId}/contacts`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact created successfully" });
      onOpenChange(false);
      form.reset();
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
      toast({ title: "Contact updated successfully" });
      onOpenChange(false);
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
                    <FormLabel>Relationship Base</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Met at conference, Referred by John, Cold outreach" {...field} data-testid="input-contact-relationship-base" />
                    </FormControl>
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
                {isPending ? "Saving..." : isEditing ? "Save Changes" : "Add Contact"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
