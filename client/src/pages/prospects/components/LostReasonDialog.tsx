import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PROSPECT_LOST_REASONS, PROSPECT_LOST_REASON_LABELS } from "@shared/schema";

export function LostReasonDialog({
  stage,
  onConfirm,
  onCancel,
}: {
  stage: "lost" | "disqualified";
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={v => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {stage === "lost" ? "Mark as Lost" : "Disqualify Prospect"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Select the primary reason to help improve future pipeline quality.</p>
          <div className="grid grid-cols-1 gap-1.5">
            {PROSPECT_LOST_REASONS.map(r => (
              <button
                key={r}
                onClick={() => setReason(r)}
                className={`text-left text-sm px-3 py-2 rounded-md border transition-colors ${reason === r ? "border-primary bg-primary/5 text-foreground font-medium" : "border-border text-muted-foreground hover:border-primary/50"}`}
                data-testid={`button-lost-reason-${r}`}
              >
                {PROSPECT_LOST_REASON_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="button-lost-cancel">Cancel</Button>
          <Button
            variant="destructive"
            disabled={!reason}
            onClick={() => onConfirm(reason)}
            data-testid="button-lost-confirm"
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
