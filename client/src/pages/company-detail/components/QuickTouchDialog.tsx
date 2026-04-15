import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhoneCall } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { buildAiToasts } from "@/lib/aiTouchUtils";
import type { Contact } from "@shared/schema";

interface QuickTouchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyName: string;
  contacts: Contact[] | undefined;
  initialContactId?: string;
}

export function QuickTouchDialog({
  open,
  onOpenChange,
  companyId,
  companyName,
  contacts,
  initialContactId,
}: QuickTouchDialogProps) {
  const { toast } = useToast();
  const [contactId, setContactId] = useState(initialContactId ?? "");
  const [touchType, setTouchType] = useState("call");
  const [note, setNote] = useState("");
  const [sentiment, setSentiment] = useState("");
  const [meaningful, setMeaningful] = useState(false);

  useEffect(() => {
    if (open) {
      setContactId(initialContactId ?? contacts?.[0]?.id ?? "");
      setTouchType("call");
      setNote("");
      setSentiment("");
      setMeaningful(false);
    }
  }, [open, initialContactId, contacts]);

  const logTouchMutation = useMutation({
    mutationFn: ({ cId, type, notes, sent, isMeaningful }: { cId: string; type: string; notes: string; sent?: string; isMeaningful?: boolean }) =>
      apiRequest("POST", `/api/contacts/${cId}/touchpoints`, {
        type,
        date: new Date().toISOString().slice(0, 10),
        notes,
        sentiment: sent || null,
        isMeaningful: isMeaningful || false,
      }).then(r => r.json()),
    onSuccess: (data: any) => {
      invalidateAfterTouchpoint(companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Touch logged!" });
      buildAiToasts(data?.aiInsights, data?.autoTask, toast);
      onOpenChange(false);
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const reset = () => {
    setNote("");
    setSentiment("");
    setMeaningful(false);
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={open => { if (!open) reset(); }}
      title={`Log Touch — ${companyName}`}
      className="sm:max-w-sm"
      footer={
        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1" onClick={reset} data-testid="button-cancel-quick-touch-detail">Cancel</Button>
          <Button
            className="flex-1"
            disabled={!contactId || logTouchMutation.isPending || (meaningful && !note.trim())}
            onClick={() => logTouchMutation.mutate({ cId: contactId, type: touchType, notes: note, sent: sentiment || undefined, isMeaningful: meaningful })}
            data-testid="button-submit-quick-touch-detail"
          >
            Log Touch
          </Button>
        </div>
      }
    >
        <div className="space-y-3 pt-2" data-testid="dialog-quick-touch-detail">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Contact</label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger data-testid="select-quick-touch-contact-detail">
                <SelectValue placeholder="Pick a contact" />
              </SelectTrigger>
              <SelectContent>
                {(contacts ?? []).map((c: Contact) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}{c.title ? ` · ${c.title}` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Touch Type</label>
            <div className="flex gap-2">
              {[{ value: "call", label: "Call" }, { value: "email", label: "Email" }, { value: "text", label: "Text" }, { value: "site_visit", label: "Site Visit" }].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setTouchType(opt.value)}
                  data-testid={`button-touch-type-detail-${opt.value}`}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                    touchType === opt.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 py-1">
            <button
              type="button"
              onClick={() => setMeaningful(v => !v)}
              data-testid="button-meaningful-toggle"
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${meaningful ? "bg-green-500" : "bg-muted border border-border"}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${meaningful ? "left-4" : "left-0.5"}`} />
            </button>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium">Meaningful conversation?</span>
              <span
                className="text-[10px] text-muted-foreground cursor-help border-b border-dashed border-muted-foreground"
                title="A real conversation that moves the needle — freight needs, rates, an opportunity, or account strategy. Not just 'what are you working on?'"
                data-testid="tooltip-meaningful"
              >
                What's this?
              </span>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Notes {meaningful ? <span className="text-red-500">*required for meaningful</span> : <span className="font-normal">(optional)</span>}
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={meaningful ? "What made this conversation meaningful?" : "What did you discuss? Any follow-ups?"}
              rows={3}
              data-testid="textarea-quick-touch-note-detail"
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none ${meaningful && !note.trim() ? "border-red-300 dark:border-red-700" : "border-input"}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Call Vibe <span className="font-normal">(optional)</span></label>
            <div className="flex gap-2">
              {[{ value: "positive", label: "😊 Positive" }, { value: "neutral", label: "😐 Neutral" }, { value: "negative", label: "😟 Negative" }].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSentiment(sentiment === opt.value ? "" : opt.value)}
                  data-testid={`button-sentiment-${opt.value}`}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                    sentiment === opt.value
                      ? opt.value === "positive" ? "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-300"
                        : opt.value === "neutral" ? "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300"
                        : "bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-300"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </div>
    </ResponsiveDialog>
  );
}
