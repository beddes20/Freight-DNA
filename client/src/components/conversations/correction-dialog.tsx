import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PenLine, Check, Loader2 } from "lucide-react";
import { stripHtmlToText } from "./utils";
import type { EmailMessage } from "./types";

interface CorrectionDialogProps {
  open: boolean;
  message: EmailMessage | null;
  correctedText: string;
  correctionNotes: string;
  isPending: boolean;
  onCorrectedTextChange: (v: string) => void;
  onCorrectionNotesChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function CorrectionDialog({
  open,
  message,
  correctedText,
  correctionNotes,
  isPending,
  onCorrectedTextChange,
  onCorrectionNotesChange,
  onCancel,
  onSubmit,
}: CorrectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="correction-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="w-5 h-5 text-amber-600" />
            Correct Sent Email
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Edit what we should have said. AI will learn from this correction for future drafts.
          </p>
        </DialogHeader>

        {message && (
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Original (what was sent)
              </label>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto" data-testid="text-original-email">
                {stripHtmlToText(message.body) || message.body}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Corrected version (what we should have said)
              </label>
              <Textarea
                value={correctedText}
                onChange={(e) => onCorrectedTextChange(e.target.value)}
                className="min-h-[140px] text-sm"
                placeholder="Rewrite the email the way it should have been sent..."
                data-testid="textarea-corrected"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Coaching notes (optional)
              </label>
              <Textarea
                value={correctionNotes}
                onChange={(e) => onCorrectionNotesChange(e.target.value)}
                className="h-16 text-sm resize-none"
                placeholder="Why is this better? (e.g., 'too aggressive on pricing', 'should have referenced the service issue first')"
                data-testid="textarea-correction-notes"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                data-testid="button-cancel-correction"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1"
                disabled={isPending || correctedText.trim() === (message.body || "").trim()}
                onClick={onSubmit}
                data-testid="button-submit-correction"
              >
                {isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Save Correction
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
