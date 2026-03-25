import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Trophy, Lightbulb, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export const OPPORTUNITY_CATEGORIES = [
  { value: "spot_batch", label: "Spot Batch" },
  { value: "dedicated_contracted", label: "Dedicated / Contracted" },
  { value: "mini_bid", label: "Mini-Bid Lanes" },
  { value: "project", label: "Project Freight" },
  { value: "other", label: "Other" },
];

interface OpportunityLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: string;
  companyName?: string;
  defaultType?: "opportunity" | "win";
}

export function OpportunityLogDialog({ open, onOpenChange, companyId, companyName, defaultType = "opportunity" }: OpportunityLogDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [type, setType] = useState<"opportunity" | "win">(defaultType);
  const [category, setCategory] = useState("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedLoads, setEstimatedLoads] = useState("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [loggedAt, setLoggedAt] = useState(new Date().toISOString().split("T")[0]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/opportunity-logs", {
        type,
        category,
        title: title.trim(),
        description: description.trim() || undefined,
        companyId: companyId || undefined,
        estimatedLoads: estimatedLoads ? Number(estimatedLoads) : undefined,
        estimatedValue: estimatedValue ? estimatedValue : undefined,
        loggedAt,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: type === "win" ? "🏆 Win logged!" : "Opportunity logged",
        description: type === "win"
          ? "Your win has been recorded and posted to the team feed."
          : "New opportunity has been recorded.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunity-logs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/callouts"] });
      handleClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save. Please try again.", variant: "destructive" });
    },
  });

  function handleClose() {
    setType(defaultType);
    setCategory("other");
    setTitle("");
    setDescription("");
    setEstimatedLoads("");
    setEstimatedValue("");
    setLoggedAt(new Date().toISOString().split("T")[0]);
    onOpenChange(false);
  }

  const isWin = type === "win";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isWin
              ? <><Trophy className="h-5 w-5 text-amber-500" /> Log a Win</>
              : <><Lightbulb className="h-5 w-5 text-blue-500" /> Log an Opportunity</>
            }
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Type toggle */}
          <div className="space-y-1.5">
            <Label>Type</Label>
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => { if (v) setType(v as "opportunity" | "win"); }}
              className="justify-start"
            >
              <ToggleGroupItem value="opportunity" className="gap-1.5 data-[state=on]:bg-blue-100 data-[state=on]:text-blue-700 dark:data-[state=on]:bg-blue-900/40 dark:data-[state=on]:text-blue-300" data-testid="toggle-opportunity">
                <Lightbulb className="h-3.5 w-3.5" />
                New Opportunity
              </ToggleGroupItem>
              <ToggleGroupItem value="win" className="gap-1.5 data-[state=on]:bg-amber-100 data-[state=on]:text-amber-700 dark:data-[state=on]:bg-amber-900/40 dark:data-[state=on]:text-amber-300" data-testid="toggle-win">
                <Trophy className="h-3.5 w-3.5" />
                Win
              </ToggleGroupItem>
            </ToggleGroup>
            {isWin && (
              <p className="text-xs text-muted-foreground">Wins are automatically posted to the team callouts feed.</p>
            )}
          </div>

          {/* Account */}
          {companyName && (
            <div className="space-y-1.5">
              <Label>Account</Label>
              <div className="px-3 py-2 rounded-md bg-muted text-sm font-medium">{companyName}</div>
            </div>
          )}

          {/* Category */}
          <div className="space-y-1.5">
            <Label htmlFor="opp-category">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="opp-category" data-testid="select-opp-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPPORTUNITY_CATEGORIES.map(c => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="opp-title">Title <span className="text-destructive">*</span></Label>
            <Input
              id="opp-title"
              placeholder={isWin ? "e.g. Won 3 dedicated lanes with Acme" : "e.g. 15-load spot batch from Acme Chicago"}
              value={title}
              onChange={e => setTitle(e.target.value)}
              data-testid="input-opp-title"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="opp-desc">Details <span className="text-xs text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="opp-desc"
              placeholder="Add any relevant context, lanes, rates, or next steps..."
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              data-testid="input-opp-desc"
            />
          </div>

          {/* Loads + Value row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="opp-loads">Est. Loads <span className="text-xs text-muted-foreground">(optional)</span></Label>
              <Input
                id="opp-loads"
                type="number"
                placeholder="e.g. 15"
                min={0}
                value={estimatedLoads}
                onChange={e => setEstimatedLoads(e.target.value)}
                data-testid="input-opp-loads"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opp-value">Est. Value $ <span className="text-xs text-muted-foreground">(optional)</span></Label>
              <Input
                id="opp-value"
                type="number"
                placeholder="e.g. 45000"
                min={0}
                value={estimatedValue}
                onChange={e => setEstimatedValue(e.target.value)}
                data-testid="input-opp-value"
              />
            </div>
          </div>

          {/* Date */}
          <div className="space-y-1.5">
            <Label htmlFor="opp-date">Date</Label>
            <Input
              id="opp-date"
              type="date"
              value={loggedAt}
              onChange={e => setLoggedAt(e.target.value)}
              data-testid="input-opp-date"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-opp-cancel">Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!title.trim() || mutation.isPending}
            className={isWin ? "bg-amber-500 hover:bg-amber-600 text-white" : ""}
            data-testid="button-opp-save"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isWin ? "Log Win" : "Log Opportunity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
