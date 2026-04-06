import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Sun, Clock, Loader2, ClipboardCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

interface PendingItem {
  lmId: string;
  lmName: string;
  lmRole: string;
  checkType: "morning" | "afternoon";
}

interface PendingResponse {
  lms: { id: string; name: string; role: string }[];
  pending: PendingItem[];
}

function YesNo({ value, onChange }: { value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
          value === true
            ? "bg-emerald-600 border-emerald-600 text-white"
            : "border-border text-muted-foreground hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400"
        }`}
        data-testid="btn-yes"
      >
        <CheckCircle2 className="w-3.5 h-3.5" /> Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
          value === false
            ? "bg-red-500 border-red-500 text-white"
            : "border-border text-muted-foreground hover:border-red-400 hover:text-red-500"
        }`}
        data-testid="btn-no"
      >
        <XCircle className="w-3.5 h-3.5" /> No
      </button>
    </div>
  );
}

interface LmAnswers {
  checkCallsDone: boolean | null;
  boardClean: boolean | null;
  checkoutDone: boolean | null;
  notes: string;
}

function defaultAnswers(): LmAnswers {
  return { checkCallsDone: null, boardClean: null, checkoutDone: null, notes: "" };
}

function getActiveCheckType(): "morning" | "afternoon" | null {
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  const minutes = h * 60 + m;
  if (minutes >= 7 * 60 && minutes < 12 * 60) return "morning";
  if (minutes >= 15 * 60 + 30) return "afternoon";
  return null;
}

export function LmCheckinPopup() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [activeType, setActiveType] = useState<"morning" | "afternoon">("morning");
  const [answers, setAnswers] = useState<Record<string, LmAnswers>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const managerRoles = ["admin","director","national_account_manager","account_manager","sales","sales_director"];
  const isManager = user && managerRoles.includes(user.role);

  const { data, refetch } = useQuery<PendingResponse>({
    queryKey: ["/api/lm-checkins/pending"],
    enabled: !!isManager,
    refetchInterval: 5 * 60 * 1000, // re-check every 5 min
    staleTime: 60 * 1000,
  });

  useEffect(() => {
    if (!data?.pending?.length) return;
    const detectedType = getActiveCheckType();
    const typesWithPending = new Set(data.pending.map(p => p.checkType));

    let showType: "morning" | "afternoon" | null = null;
    if (detectedType && typesWithPending.has(detectedType)) {
      showType = detectedType;
    } else if (typesWithPending.has("morning") && !typesWithPending.has("afternoon")) {
      showType = "morning";
    } else if (typesWithPending.has("afternoon")) {
      showType = "afternoon";
    } else if (typesWithPending.has("morning")) {
      showType = "morning";
    }

    if (!showType) return;
    const key = `lm-checkin-dismissed-${showType}-${new Date().toISOString().slice(0, 10)}`;
    if (dismissed.has(key) || sessionStorage.getItem(key)) return;

    setActiveType(showType);
    setOpen(true);
  }, [data]);

  const pendingForType = (data?.pending ?? []).filter(p => p.checkType === activeType);

  function updateAnswer(lmId: string, field: keyof LmAnswers, value: boolean | string) {
    setAnswers(prev => ({
      ...prev,
      [lmId]: { ...(prev[lmId] ?? defaultAnswers()), [field]: value },
    }));
  }

  const submitMutation = useMutation({
    mutationFn: () => {
      const responses = pendingForType.map(p => {
        const ans = answers[p.lmId] ?? defaultAnswers();
        return {
          lmId: p.lmId,
          checkCallsDone: activeType === "morning" ? ans.checkCallsDone : undefined,
          boardClean: ans.boardClean,
          checkoutDone: activeType === "afternoon" ? ans.checkoutDone : undefined,
          notes: ans.notes || undefined,
        };
      });
      return apiRequest("POST", "/api/lm-checkins", { checkType: activeType, responses }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Check-in saved!", description: "Your LM status check has been recorded." });
      setOpen(false);
      setAnswers({});
      queryClient.invalidateQueries({ queryKey: ["/api/lm-checkins/pending"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: () => toast({ title: "Failed to save check-in", variant: "destructive" }),
  });

  function handleDismiss() {
    const key = `lm-checkin-dismissed-${activeType}-${new Date().toISOString().slice(0, 10)}`;
    sessionStorage.setItem(key, "1");
    setDismissed(prev => new Set([...prev, key]));
    setOpen(false);
  }

  const allAnswered = pendingForType.every(p => {
    const ans = answers[p.lmId];
    if (!ans) return false;
    if (ans.boardClean === null) return false;
    if (activeType === "morning" && ans.checkCallsDone === null) return false;
    if (activeType === "afternoon" && ans.checkoutDone === null) return false;
    return true;
  });

  if (!isManager || !pendingForType.length) return null;

  const typeLabel = activeType === "morning" ? "7:30 AM Morning" : "4:00 PM Afternoon";
  const typeIcon = activeType === "morning" ? <Sun className="w-4 h-4" /> : <Clock className="w-4 h-4" />;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="lm-checkin-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            {typeLabel} LM Check-In
          </DialogTitle>
          <DialogDescription className="text-xs">
            Quick status check on your logistics team. Answers are saved for coaching review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {pendingForType.map(p => {
            const ans = answers[p.lmId] ?? defaultAnswers();
            return (
              <div key={p.lmId} className="rounded-xl border border-border bg-muted/30 p-4 space-y-3" data-testid={`lm-checkin-card-${p.lmId}`}>
                <div className="flex items-center gap-2">
                  {typeIcon}
                  <span className="font-semibold text-sm">{p.lmName}</span>
                  <Badge variant="outline" className="text-xs">
                    {p.lmRole === "logistics_manager" ? "LM" : "LC"}
                  </Badge>
                </div>

                {activeType === "morning" && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Did they complete check calls before 7:30 AM?</p>
                    <YesNo value={ans.checkCallsDone} onChange={v => updateAnswer(p.lmId, "checkCallsDone", v)} />
                  </div>
                )}

                {activeType === "afternoon" && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Was the checkout process completed?</p>
                    <YesNo value={ans.checkoutDone} onChange={v => updateAnswer(p.lmId, "checkoutDone", v)} />
                  </div>
                )}

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Is the board clean?</p>
                  <YesNo value={ans.boardClean} onChange={v => updateAnswer(p.lmId, "boardClean", v)} />
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Notes (optional)</p>
                  <Textarea
                    value={ans.notes}
                    onChange={e => updateAnswer(p.lmId, "notes", e.target.value)}
                    placeholder="Any context or coaching notes…"
                    className="text-xs resize-none h-16"
                    data-testid={`lm-checkin-notes-${p.lmId}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border mt-2">
          <Button variant="ghost" size="sm" onClick={handleDismiss} className="text-xs text-muted-foreground" data-testid="btn-checkin-dismiss">
            Remind me later
          </Button>
          <Button
            size="sm"
            className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs"
            disabled={!allAnswered || submitMutation.isPending}
            onClick={() => submitMutation.mutate()}
            data-testid="btn-checkin-submit"
          >
            {submitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
            Save Check-In
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
