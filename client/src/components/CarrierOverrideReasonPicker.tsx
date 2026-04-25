// Task #638 — One-tap reason picker for rep carrier overrides.
// Non-blocking: dismiss writes reasonCode=null. Server is idempotent per day.
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";

export type CarrierOverrideAction = "deselect_top3" | "added_outside_topn";

// Pure gating helper used by both UI paths to decide whether a single-carrier
// add should fire the picker. Returns true ONLY when the candidate carrier is
// genuinely outside the ranker's current shortlist. Exported (and test-covered
// in __tests__/carrierOverrideGating.test.ts) so both surfaces share one rule.
export function shouldFireAddedOutsideTopN(
  carrierId: string | null | undefined,
  shortlistCarrierIds: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!carrierId) return false;
  return !shortlistCarrierIds.some(id => id === carrierId);
}

export type CarrierOverrideReasonCode =
  | "bad_service"
  | "out_of_equipment"
  | "wont_run_lane"
  | "better_fit"
  | "other";

export interface CarrierOverridePickerCarrier {
  carrierId: string;
  carrierName: string;
}

export interface CarrierOverridePickerLane {
  origin?: string | null;
  originState?: string | null;
  destination?: string | null;
  destinationState?: string | null;
  equipmentType?: string | null;
}

export interface CarrierOverrideReasonPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  carrier: CarrierOverridePickerCarrier | null;
  lane: CarrierOverridePickerLane;
  action: CarrierOverrideAction;
}

interface ReasonOption {
  code: CarrierOverrideReasonCode;
  label: string;
  hint: string;
}

const NEGATIVE_OPTIONS: ReasonOption[] = [
  { code: "bad_service", label: "Bad service", hint: "Past failures, late, no-show" },
  { code: "out_of_equipment", label: "Out of equipment", hint: "No trucks for this lane" },
  { code: "wont_run_lane", label: "Won't run lane", hint: "Carrier declines this corridor" },
  { code: "other", label: "Other", hint: "Add a quick note" },
];

const POSITIVE_OPTION: ReasonOption = {
  code: "better_fit",
  label: "Better fit",
  hint: "Stronger match than the ranker picked",
};

export function CarrierOverrideReasonPicker({
  open,
  onOpenChange,
  carrier,
  lane,
  action,
}: CarrierOverrideReasonPickerProps) {
  // Guards a second POST from the auto-dismiss after a reason click.
  const submittedRef = useRef(false);
  const [showOtherNote, setShowOtherNote] = useState(false);
  const [otherNote, setOtherNote] = useState("");

  useEffect(() => {
    if (open) {
      submittedRef.current = false;
      setShowOtherNote(false);
      setOtherNote("");
    }
  }, [open, carrier?.carrierId]);

  if (!carrier) return null;

  const isAdd = action === "added_outside_topn";
  const title = isAdd
    ? `Why add ${carrier.carrierName}?`
    : `Why skip ${carrier.carrierName}?`;
  const description = isAdd
    ? "We'll learn this carrier should rank higher on this lane."
    : "We'll learn this carrier should rank lower on this lane.";

  // Same 5-option set for both actions; reasonCode drives the boost/cap split.
  const options: ReasonOption[] = [...NEGATIVE_OPTIONS.slice(0, 3), POSITIVE_OPTION, NEGATIVE_OPTIONS[3]];

  const submit = async (reasonCode: CarrierOverrideReasonCode | null, notes?: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    try {
      await apiRequest("POST", "/api/carrier-overrides", {
        carrierId: carrier.carrierId,
        action,
        reasonCode,
        origin: lane.origin ?? null,
        originState: lane.originState ?? null,
        destination: lane.destination ?? null,
        destinationState: lane.destinationState ?? null,
        equipmentType: lane.equipmentType ?? null,
        notes: notes ?? null,
      });
    } catch {
      // Non-blocking: wave action already succeeded; missed write = missed signal.
    } finally {
      onOpenChange(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    // User dismissed via X / overlay / Esc → fire dismiss-write before close.
    if (!next && !submittedRef.current) {
      void submit(null);
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-carrier-override-reason">
        <DialogHeader>
          <DialogTitle data-testid="text-override-title">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {!showOtherNote ? (
          <div className="grid gap-2 py-2" data-testid="list-override-reasons">
            {options.map(opt => (
              <Button
                key={opt.code}
                variant="outline"
                className="justify-start h-auto py-3"
                onClick={() => {
                  if (opt.code === "other") {
                    setShowOtherNote(true);
                    return;
                  }
                  void submit(opt.code);
                }}
                data-testid={`button-override-reason-${opt.code}`}
              >
                <div className="text-left">
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.hint}</div>
                </div>
              </Button>
            ))}
            <Button
              variant="ghost"
              className="text-xs text-muted-foreground"
              onClick={() => void submit(null)}
              data-testid="button-override-dismiss"
            >
              Skip — don't save a reason
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 py-2">
            <Textarea
              value={otherNote}
              onChange={e => setOtherNote(e.target.value.slice(0, 240))}
              placeholder="What happened? (optional, 240 chars)"
              className="min-h-[80px] text-sm"
              data-testid="input-override-other-note"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowOtherNote(false)}
                data-testid="button-override-other-back"
              >
                Back
              </Button>
              <Button
                size="sm"
                onClick={() => void submit("other", otherNote.trim() || null)}
                data-testid="button-override-other-save"
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
