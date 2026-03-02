import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TruckIcon, BarChart3, MapPin, DollarSign } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const researchSchema = z.object({
  name: z.string().min(1, "Decision maker name is required"),
  title: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
  markAsResearched: z.boolean().default(false),
});

type ResearchFormData = z.infer<typeof researchSchema>;

interface LaneInfo {
  lane: string;
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  status?: string;
}

interface ResearchLaneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneInfo | null;
  laneIndex: number;
  rfpId: string;
  companyId: string;
}

export function ResearchLaneDialog({ open, onOpenChange, lane, laneIndex, rfpId, companyId }: ResearchLaneDialogProps) {
  const { toast } = useToast();

  const form = useForm<ResearchFormData>({
    resolver: zodResolver(researchSchema),
    defaultValues: {
      name: "",
      title: "",
      email: "",
      phone: "",
      notes: "",
      markAsResearched: false,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: "",
        title: "",
        email: "",
        phone: "",
        notes: "",
        markAsResearched: false,
      });
    }
  }, [open, form]);

  const { fire: fireConfetti, ConfettiOverlay } = useConfetti();

  const submitMutation = useMutation({
    mutationFn: async (data: ResearchFormData) => {
      const lanesArray = lane ? [lane.lane] : [];
      const regionsArray = lane
        ? [lane.originState, lane.destinationState].filter(Boolean)
        : [];

      const contactPayload = {
        companyId,
        name: data.name,
        title: data.title || null,
        email: data.email || null,
        phone: data.phone || null,
        lanes: lanesArray.length > 0 ? lanesArray : null,
        regions: regionsArray.length > 0 ? regionsArray : null,
        notes: data.notes || null,
        relationshipBase: null,
        reportsToId: null,
        freightSpend: null,
        spotBiddingProcess: null,
        interests: null,
      };

      const contactRes = await apiRequest("POST", `/api/companies/${companyId}/contacts`, contactPayload);
      const contact = await contactRes.json();

      const laneStatus = data.markAsResearched ? "researched" : "contact_added";
      await apiRequest("PATCH", `/api/rfps/${rfpId}/lanes/${laneIndex}/status`, {
        status: laneStatus,
        contactId: contact.id,
      });

      return { contact, laneName: lane?.lane };
    },
    onSuccess: (data) => {
      toast({
        title: `🎉 Task created for ${data.laneName}`,
        description: "Contact saved successfully",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
      fireConfetti();
      setTimeout(() => onOpenChange(false), 800);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error saving contact", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: ResearchFormData) => {
    submitMutation.mutate(data);
  };

  if (!lane) return null;

  return (
    <>
    {ConfettiOverlay && <ConfettiOverlay />}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TruckIcon className="h-5 w-5" />
            Research Lane Owner
          </DialogTitle>
          <p className="text-sm text-muted-foreground">{lane.lane}</p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 p-3 rounded-md bg-muted/50 border">
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Origin</p>
              <p className="text-sm font-medium">{lane.origin || lane.originState || "N/A"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Destination</p>
              <p className="text-sm font-medium">{lane.destination || lane.destinationState || "N/A"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Annual Shipments</p>
              <p className="text-sm font-medium">{lane.volume.toLocaleString()}</p>
            </div>
          </div>
          {lane.rate && (
            <div className="flex items-center gap-2">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Rate</p>
                <p className="text-sm font-medium">{lane.rate}</p>
              </div>
            </div>
          )}
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Who owns this lane? (Decision Maker Name)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Jane Smith" {...field} data-testid="input-research-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title / Role</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Regional Logistics Manager" {...field} data-testid="input-research-title" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="jane@company.com" {...field} data-testid="input-research-email" />
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
                      <Input placeholder="(555) 123-4567" {...field} data-testid="input-research-phone" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any additional details..." {...field} data-testid="input-research-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="markAsResearched"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0 p-3 rounded-md border">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="checkbox-mark-researched"
                    />
                  </FormControl>
                  <FormLabel className="font-normal cursor-pointer">
                    Mark as Researched (fully complete)
                  </FormLabel>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-research">
                Cancel
              </Button>
              <Button type="submit" disabled={submitMutation.isPending} data-testid="button-save-research">
                {submitMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {submitMutation.isPending ? "Saving..." : "Save Contact & Assign"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
    </>
  );
}
