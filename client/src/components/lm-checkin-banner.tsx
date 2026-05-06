import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Sun, Clock, Loader2, X } from "lucide-react";
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
  activeWindow: "morning" | "afternoon" | null;
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

/**
 * Dismiss key is date-scoped so it auto-clears the next calendar day.
 * localStorage is used (not sessionStorage) so dismissal survives page reloads
 * and is shared across all tabs.
 */
function getDismissKey(type: "morning" | "afternoon"): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return `lm-checkin-dismissed-${type}-${today}`;
}

function checkDismissed(type: "morning" | "afternoon"): boolean {
  try { return !!localStorage.getItem(getDismissKey(type)); } catch { return false; }
}

function writeDismiss(type: "morning" | "afternoon"): void {
  try { localStorage.setItem(getDismissKey(type), "1"); } catch { /* quota exceeded */ }
}

function YesNo({
  value,
  onChange,
  testIdPrefix,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  testIdPrefix: string;
}) {
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
        data-testid={`${testIdPrefix}-yes`}
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
        data-testid={`${testIdPrefix}-no`}
      >
        <XCircle className="w-3.5 h-3.5" /> No
      </button>
    </div>
  );
}

/**
 * LmCheckinBanner — inline dashboard alert card for timed LM check-ins.
 *
 * Replaces the old global popup modal. Key differences:
 * - Renders only on the dashboard page (not every page)
 * - Uses server-provided `activeWindow` (CT-aware) instead of client-side time detection
 * - Dismiss state stored in localStorage (survives reloads, shared across tabs)
 * - No modal — inline card matching the existing dashboard alert card pattern
 * - Polls every 5 min; collapses automatically once submitted
 */
export function LmCheckinBanner() {
  const { user } = useAuth();
  const { toast } = useToast();

  const managerRoles = [
    "admin", "director", "national_account_manager",
    "account_manager", "sales", "sales_director",
  ];
  const isManager = !!user && managerRoles.includes(user.role);

  const [answers, setAnswers] = useState<Record<string, LmAnswers>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(new Set());

  const { data } = useQuery<PendingResponse>({
    queryKey: ["/api/lm-checkins/pending"],
    enabled: isManager,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const submitMutation = useMutation({
    mutationFn: (checkType: "morning" | "afternoon") => {
      const pendingForType = (data?.pending ?? []).filter(p => p.checkType === checkType);
      const responses = pendingForType.map(p => {
        const ans = answers[p.lmId] ?? defaultAnswers();
        return {
          lmId: p.lmId,
          checkCallsDone: checkType === "morning" ? ans.checkCallsDone : undefined,
          boardClean: ans.boardClean,
          checkoutDone: checkType === "afternoon" ? ans.checkoutDone : undefined,
          notes: ans.notes || undefined,
        };
      });
      return apiRequest("POST", "/api/lm-checkins", { checkType, responses }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Check-in saved!", description: "LM status recorded for today." });
      setAnswers({});
      queryClient.invalidateQueries({ queryKey: ["/api/lm-checkins/pending"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: () => toast({ title: "Failed to save check-in", variant: "destructive" }),
  });

  if (!isManager || !data) return null;

  const activeWindow = data.activeWindow;
  if (!activeWindow) return null;
  // Capture as narrowed const so TypeScript is happy inside closures.
  const checkinType: "morning" | "afternoon" = activeWindow;

  const pendingForWindow = data.pending.filter(p => p.checkType === checkinType);
  if (pendingForWindow.length === 0) return null;

  const dismissKey = getDismissKey(checkinType);
  if (checkDismissed(checkinType) || locallyDismissed.has(dismissKey)) return null;

  const isMorning = checkinType === "morning";

  function updateAnswer(lmId: string, field: keyof LmAnswers, value: boolean | string) {
    setAnswers(prev => ({
      ...prev,
      [lmId]: { ...(prev[lmId] ?? defaultAnswers()), [field]: value },
    }));
  }

  function handleDismiss() {
    writeDismiss(checkinType);
    setLocallyDismissed(prev => new Set([...prev, dismissKey]));
  }

  const allAnswered = pendingForWindow.every(p => {
    const ans = answers[p.lmId];
    if (!ans || ans.boardClean === null) return false;
    if (isMorning && ans.checkCallsDone === null) return false;
    if (!isMorning && ans.checkoutDone === null) return false;
    return true;
  });

  const accentAmber = "border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/20";
  const accentBlue  = "border-l-blue-500 bg-blue-50/30 dark:bg-blue-950/20";
  const titleAmber  = "text-amber-700 dark:text-amber-400";
  const titleBlue   = "text-blue-700 dark:text-blue-400";
  const badgeAmber  = "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300 border-amber-300";
  const badgeBlue   = "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 border-blue-300";
  const btnAmber    = "bg-amber-600 hover:bg-amber-700 text-white";
  const btnBlue     = "bg-blue-600 hover:bg-blue-700 text-white";

  return (
    <Card
      className={`border-l-4 ${isMorning ? accentAmber : accentBlue}`}
      data-testid="card-lm-checkin-banner"
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className={`flex items-center gap-2 text-base ${isMorning ? titleAmber : titleBlue}`}>
            {isMorning
              ? <Sun className="h-4 w-4" />
              : <Clock className="h-4 w-4" />}
            {isMorning ? "Morning LM Check — 7:30 AM" : "Afternoon LM Check — 4:00 PM"}
            <Badge className={`ml-1 font-normal ${isMorning ? badgeAmber : badgeBlue}`}>
              {pendingForWindow.length} pending
            </Badge>
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
            onClick={handleDismiss}
            data-testid="btn-lm-banner-close"
            title="Remind me later"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {isMorning
            ? "Have LM check calls been completed and is the board clean by 7:30?"
            : "Is the checkout process complete and is the board clean for the day?"}
        </p>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {pendingForWindow.map(p => {
          const ans = answers[p.lmId] ?? defaultAnswers();
          const notesOpen = expandedNotes.has(p.lmId);
          return (
            <div
              key={p.lmId}
              className="rounded-lg border border-border bg-background/60 p-3 space-y-3"
              data-testid={`lm-banner-card-${p.lmId}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{p.lmName}</span>
                <Badge variant="outline" className="text-xs">
                  {p.lmRole === "logistics_manager" ? "LM" : "LC"}
                </Badge>
              </div>

              {isMorning && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Check calls done before 7:30?</p>
                  <YesNo
                    value={ans.checkCallsDone}
                    onChange={v => updateAnswer(p.lmId, "checkCallsDone", v)}
                    testIdPrefix={`lm-banner-calls-${p.lmId}`}
                  />
                </div>
              )}

              {!isMorning && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Checkout process complete?</p>
                  <YesNo
                    value={ans.checkoutDone}
                    onChange={v => updateAnswer(p.lmId, "checkoutDone", v)}
                    testIdPrefix={`lm-banner-checkout-${p.lmId}`}
                  />
                </div>
              )}

              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Board clean?</p>
                <YesNo
                  value={ans.boardClean}
                  onChange={v => updateAnswer(p.lmId, "boardClean", v)}
                  testIdPrefix={`lm-banner-board-${p.lmId}`}
                />
              </div>

              <div>
                {!notesOpen ? (
                  <button
                    type="button"
                    onClick={() => setExpandedNotes(prev => new Set([...prev, p.lmId]))}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                    data-testid={`btn-lm-notes-expand-${p.lmId}`}
                  >
                    + Add coaching note
                  </button>
                ) : (
                  <Textarea
                    value={ans.notes}
                    onChange={e => updateAnswer(p.lmId, "notes", e.target.value)}
                    placeholder="Any context or coaching notes…"
                    className="text-xs resize-none h-14 mt-1"
                    data-testid={`lm-banner-notes-${p.lmId}`}
                  />
                )}
              </div>
            </div>
          );
        })}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            data-testid="btn-lm-banner-dismiss"
          >
            Remind me later
          </button>
          <Button
            size="sm"
            className={`text-xs ${isMorning ? btnAmber : btnBlue}`}
            disabled={!allAnswered || submitMutation.isPending}
            onClick={() => submitMutation.mutate(checkinType)}
            data-testid="btn-lm-banner-submit"
          >
            {submitMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              : null}
            {isMorning ? "Save Morning Check-In" : "Save Afternoon Check-In"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
