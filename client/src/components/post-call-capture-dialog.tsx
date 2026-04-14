import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import {
  PhoneCall,
  Mail,
  MessageSquare,
  Building2,
  Loader2,
  CheckCircle2,
  ClipboardList,
  Calendar,
  Sparkles,
  BookOpen,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";

const TOUCH_TYPES = [
  { value: "call", label: "Call", icon: PhoneCall },
  { value: "email", label: "Email", icon: Mail },
  { value: "text", label: "Text", icon: MessageSquare },
  { value: "site_visit", label: "Site Visit", icon: Building2 },
];

interface PostCallResult {
  touchpoint: any;
  aiSummary: string | null;
  followUpTasks: any[];
  playExecuted: string | null;
  suggestedNextTouch: {
    type: string;
    timing: string;
    dueDays: number;
    reason: string;
  } | null;
  keyIntel: string | null;
  sentiment: string | null;
}

interface PostCallCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companyName: string;
  contactId?: string | null;
  contactName?: string | null;
}

export function PostCallCaptureDialog({
  open,
  onClose,
  companyId,
  companyName,
  contactId,
  contactName,
}: PostCallCaptureDialogProps) {
  const [notes, setNotes] = useState("");
  const [touchType, setTouchType] = useState("call");
  const [result, setResult] = useState<PostCallResult | null>(null);
  const { toast } = useToast();

  const captureMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", "/api/post-call-capture", {
        companyId,
        contactId: contactId || null,
        notes: notes.trim(),
        touchType,
      });
      return resp.json() as Promise<PostCallResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      invalidateAfterTouchpoint(companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      toast({ title: "Call captured and analyzed" });
    },
    onError: () => {
      toast({ title: "Failed to capture call", variant: "destructive" });
    },
  });

  function handleClose() {
    onClose();
    setTimeout(() => {
      setNotes("");
      setTouchType("call");
      setResult(null);
    }, 300);
  }

  const sentimentColor: Record<string, string> = {
    positive: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    neutral: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    negative: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };

  if (result) {
    return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-post-call-results">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Call Captured — {companyName}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {result.aiSummary && (
              <div className="space-y-1.5" data-testid="postcall-summary-section">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">AI Summary</span>
                </div>
                <p className="text-sm leading-relaxed bg-muted/50 rounded-lg p-3 border" data-testid="text-postcall-summary">
                  {result.aiSummary}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {result.sentiment && (
                    <Badge className={`text-xs ${sentimentColor[result.sentiment] || ""}`} data-testid="badge-postcall-sentiment">
                      {result.sentiment}
                    </Badge>
                  )}
                  {result.playExecuted && (
                    <Badge className="text-xs bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" data-testid="badge-postcall-play">
                      <BookOpen className="h-3 w-3 mr-1" />
                      {result.playExecuted}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {result.keyIntel && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 p-3" data-testid="postcall-intel-section">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">Key Intel</span>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mt-0.5">{result.keyIntel}</p>
                </div>
              </div>
            )}

            {result.followUpTasks.length > 0 && (
              <div className="space-y-1.5" data-testid="postcall-followups-section">
                <div className="flex items-center gap-1.5">
                  <ClipboardList className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Follow-Up Tasks Created ({result.followUpTasks.length})
                  </span>
                </div>
                <div className="space-y-1">
                  {result.followUpTasks.map((task: any) => (
                    <div key={task.id} className="flex items-center gap-2 rounded-md border px-3 py-2" data-testid={`postcall-task-${task.id}`}>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      <span className="text-sm flex-1">{task.title}</span>
                      {task.dueDate && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(task.dueDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.suggestedNextTouch && (
              <div className="space-y-1.5" data-testid="postcall-next-touch-section">
                <div className="flex items-center gap-1.5">
                  <ArrowRight className="h-3.5 w-3.5 text-cyan-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Suggested Next Touch</span>
                </div>
                <div className="flex items-start gap-2 rounded-md border bg-cyan-50 dark:bg-cyan-950/20 border-cyan-200 dark:border-cyan-800 px-3 py-2">
                  <div className="flex-1">
                    <p className="text-sm font-medium capitalize">{result.suggestedNextTouch.type} — {result.suggestedNextTouch.timing}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{result.suggestedNextTouch.reason}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={handleClose} data-testid="button-postcall-done">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-post-call-capture">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ClipboardList className="h-4 w-4 text-cyan-500" />
            Log & Summarize — {companyName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {contactName && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="postcall-contact-info">
              <Building2 className="h-3.5 w-3.5" />
              {contactName}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Touch Type</label>
            <div className="flex gap-2">
              {TOUCH_TYPES.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    data-testid={`postcall-touch-type-${opt.value}`}
                    onClick={() => setTouchType(opt.value)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors flex-1 justify-center ${
                      touchType === opt.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-input hover:bg-muted"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Call Notes <span className="text-red-500">*</span>
            </label>
            <Textarea
              data-testid="textarea-postcall-notes"
              placeholder="What did you discuss? Key takeaways, commitments made, next steps mentioned..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              AI will auto-generate a summary, detect follow-ups, and tag the play executed.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-postcall-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => captureMutation.mutate()}
            disabled={notes.trim().length < 5 || captureMutation.isPending}
            data-testid="button-postcall-submit"
          >
            {captureMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Log & Summarize
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
