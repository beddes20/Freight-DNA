import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trophy, TruckIcon, MapPin, DollarSign, CheckCircle, ChevronDown, ChevronUp, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Rfp, Company } from "@shared/schema";

interface ConvertToAwardDialogProps {
  rfp: Rfp | null;
  company?: Company;
  onClose: () => void;
}

function formatLane(row: Record<string, any>): string {
  const origin = [row.origin_city, row.origin_state].filter(Boolean).join(", ")
    || row.origin_zip
    || "Unknown Origin";
  const dest = [row.dest_city, row.dest_state].filter(Boolean).join(", ")
    || row.dest_zip
    || "Unknown Dest";
  const vol = row.volume ? ` (${Number(row.volume).toLocaleString()} loads)` : "";
  return `${origin} → ${dest}${vol}`;
}

export function ConvertToAwardDialog({ rfp, company, onClose }: ConvertToAwardDialogProps) {
  const { toast } = useToast();

  const rfpRows: Record<string, any>[] = (() => {
    if (!rfp?.fileData) return [];
    const fd = rfp.fileData as any;
    return Array.isArray(fd?.rows) ? fd.rows : [];
  })();

  const allLaneLabels: string[] = rfpRows.length > 0
    ? rfpRows.map(formatLane)
    : [];

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [awardDate, setAwardDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [selectedLanes, setSelectedLanes] = useState<Set<number>>(new Set());
  const [manualLanes, setManualLanes] = useState("");
  const [showAllLanes, setShowAllLanes] = useState(false);

  useEffect(() => {
    if (!rfp) return;
    setTitle(`${rfp.title} — Award`);
    setValue(rfp.value ? String(rfp.value) : "");
    setAwardDate(new Date().toISOString().split("T")[0]);
    setNotes(rfp.notes || "");
    setSelectedLanes(new Set(allLaneLabels.map((_, i) => i)));
    setManualLanes("");
    setShowAllLanes(false);
  }, [rfp?.id]);

  const createAwardMutation = useMutation({
    mutationFn: async () => {
      const wonLanes = allLaneLabels.length > 0
        ? allLaneLabels.filter((_, i) => selectedLanes.has(i))
        : manualLanes.split(",").map((l) => l.trim()).filter(Boolean);

      await apiRequest("POST", "/api/awards", {
        companyId: rfp!.companyId,
        title,
        value: value || null,
        awardDate: awardDate || null,
        lanes: wonLanes.length > 0 ? wonLanes : null,
        notes: notes || null,
        fileName: null,
        fileData: null,
      });

      await apiRequest("PATCH", `/api/rfps/${rfp!.id}`, {
        ...rfp,
        status: "awarded",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({
        title: "Award created",
        description: `${company?.name ?? "Account"} marked as won — RFP status updated to Awarded.`,
      });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create award", description: err.message, variant: "destructive" });
    },
  });

  if (!rfp) return null;

  const visibleLanes = showAllLanes ? allLaneLabels : allLaneLabels.slice(0, 8);
  const selectedCount = selectedLanes.size;

  const toggleLane = (idx: number) => {
    setSelectedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => setSelectedLanes(new Set(allLaneLabels.map((_, i) => i)));
  const selectNone = () => setSelectedLanes(new Set());

  return (
    <Dialog open={!!rfp} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-convert-to-award">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-500" />
            Convert RFP to Award
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Mark <span className="font-medium">{rfp.title}</span> as won. This will create an award record and update the RFP status to <Badge className="text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">Awarded</Badge>.
          </p>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Summary chips */}
          <div className="flex flex-wrap gap-2">
            {company && (
              <Badge variant="outline" className="gap-1 text-xs">
                <MapPin className="h-3 w-3" />{company.name}
              </Badge>
            )}
            {rfp.laneCount ? (
              <Badge variant="outline" className="gap-1 text-xs">
                <TruckIcon className="h-3 w-3" />{rfp.laneCount} lanes in RFP
              </Badge>
            ) : null}
            {rfp.value ? (
              <Badge variant="outline" className="gap-1 text-xs">
                <DollarSign className="h-3 w-3" />${Number(rfp.value).toLocaleString()} bid value
              </Badge>
            ) : null}
          </div>

          {/* Award title */}
          <div className="space-y-1.5">
            <label htmlFor="award-title" className="text-sm font-medium">Award Title</label>
            <Input
              id="award-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Acme Corp — Award"
              data-testid="input-convert-title"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Award value */}
            <div className="space-y-1.5">
              <label htmlFor="award-value" className="text-sm font-medium">Award Value ($)</label>
              <Input
                id="award-value"
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g., 500000"
                data-testid="input-convert-value"
              />
              <p className="text-xs text-muted-foreground">Adjust if partial win</p>
            </div>

            {/* Award date */}
            <div className="space-y-1.5">
              <label htmlFor="award-date" className="text-sm font-medium">Award Date</label>
              <Input
                id="award-date"
                type="date"
                value={awardDate}
                onChange={(e) => setAwardDate(e.target.value)}
                data-testid="input-convert-date"
              />
            </div>
          </div>

          {/* Lane selection */}
          {allLaneLabels.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Lanes Won <span className="text-muted-foreground font-normal">({selectedCount} of {allLaneLabels.length} selected)</span></span>
                <div className="flex gap-2">
                  <button onClick={selectAll} className="text-xs text-primary hover:underline" data-testid="button-select-all-lanes">All</button>
                  <span className="text-muted-foreground text-xs">·</span>
                  <button onClick={selectNone} className="text-xs text-primary hover:underline" data-testid="button-select-no-lanes">None</button>
                </div>
              </div>
              <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                {visibleLanes.map((label, idx) => (
                  <label
                    key={idx}
                    className="flex items-start gap-3 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                    data-testid={`lane-checkbox-${idx}`}
                  >
                    <div
                      onClick={() => toggleLane(idx)}
                      className={`mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                        selectedLanes.has(idx)
                          ? "bg-primary border-primary"
                          : "border-input bg-background"
                      }`}
                    >
                      {selectedLanes.has(idx) && <Check className="h-3 w-3 text-primary-foreground" />}
                    </div>
                    <span className="text-sm leading-snug">{label}</span>
                  </label>
                ))}
                {allLaneLabels.length > 8 && (
                  <button
                    onClick={() => setShowAllLanes(!showAllLanes)}
                    className="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
                    data-testid="button-toggle-show-lanes"
                  >
                    {showAllLanes ? (
                      <><ChevronUp className="h-3 w-3" />Show less</>
                    ) : (
                      <><ChevronDown className="h-3 w-3" />Show {allLaneLabels.length - 8} more lanes</>
                    )}
                  </button>
                )}
              </div>
              {selectedCount === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">No lanes selected — the award will be saved without lane detail.</p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="manual-lanes" className="text-sm font-medium">Lanes Won (comma-separated, optional)</label>
              <Input
                id="manual-lanes"
                value={manualLanes}
                onChange={(e) => setManualLanes(e.target.value)}
                placeholder="e.g., ATL-CHI, DAL-LAX"
                data-testid="input-convert-lanes-manual"
              />
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <label htmlFor="award-notes" className="text-sm font-medium">Notes (optional)</label>
            <Textarea
              id="award-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any details about the win, rate terms, kickoff timeline..."
              rows={3}
              data-testid="input-convert-notes"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={onClose} data-testid="button-cancel-convert">
              Cancel
            </Button>
            <Button
              onClick={() => createAwardMutation.mutate()}
              disabled={createAwardMutation.isPending || !title.trim()}
              className="bg-amber-500 hover:bg-amber-600 text-white"
              data-testid="button-confirm-convert"
            >
              {createAwardMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating Award...</>
              ) : (
                <><CheckCircle className="h-4 w-4 mr-2" />Create Award</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
