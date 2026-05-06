/**
 * Won Load Approval Modal (Task #803)
 *
 * Mounted once globally in App.tsx. Polls /api/won-loads/pending-for-me
 * every 30s + on focus + on the won_load_pending_approval SSE notification.
 * For NAM/AM/managers, surfaces a queued popup until each pending load is
 * either assigned to a direct-report LM or snoozed.
 *
 * Design rules (per product):
 *   - Mandatory assignment — there is no "skip without choosing an LM" path.
 *     The dialog can be snoozed but not dismissed without action.
 *   - Approval is optional but defaults to checked. Unchecking still assigns
 *     and moves the row to ready_to_send; the LM just won't see the
 *     "Approved — you can send" notification.
 *   - "Direct reports only" LM dropdown comes from
 *     /api/team/my-direct-report-lms (admins see all LMs).
 *   - One load at a time with a "(N more after this)" hint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Truck, Clock, ExternalLink } from "lucide-react";

// Temporarily disabled at user request while upstream "load entered → AM/NAM
// assigns to LM" process is still being shaped. Flip this back to `true` to
// restore the popup. Setting this to `false` short-circuits the role check,
// the 30s poll of /api/won-loads/pending-for-me, the SSE listener for
// `won_load_pending_approval`, and the dialog render — i.e. the component
// becomes a no-op without removing any code.
const WON_LOAD_APPROVAL_MODAL_ENABLED = false;

const ROLES_THAT_OWN_POPUP = new Set([
  "national_account_manager",
  "account_manager",
  "admin",
  "director",
  "sales_director",
]);

interface PendingWonLoad {
  id: string;
  orgId: string;
  companyId: string;
  companyName: string | null;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  pickupWindowStart: string | null;
  pickupWindowEnd: string | null;
  quotedRate: string | null;
  targetBuyRate: string | null;
  status: string;
  ownerUserId: string | null;
  delegatedToUserId: string | null;
  awaitingApprovalSince: string | null;
  snoozedUntil: string | null;
  sourceQuoteId: string | null;
  notes: string | null;
  isSnoozed: boolean;
}

interface DirectReportLm {
  id: string;
  name: string;
  username: string;
  role: string;
}

function formatLane(o: PendingWonLoad): string {
  const orig = o.originState ? `${o.origin}, ${o.originState}` : o.origin;
  const dest = o.destinationState ? `${o.destination}, ${o.destinationState}` : o.destination;
  return `${orig} → ${dest}`;
}

function formatRate(v: string | null): string {
  if (!v) return "—";
  const n = Number(v);
  if (!isFinite(n)) return v;
  return `$${n.toFixed(2)}`;
}

export function WonLoadApprovalModal() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const role = user?.role ?? null;
  const enabled =
    WON_LOAD_APPROVAL_MODAL_ENABLED &&
    !!user &&
    ROLES_THAT_OWN_POPUP.has(role ?? "");

  // Query: poll every 30s + on focus.
  const { data, refetch } = useQuery<{ items: PendingWonLoad[] }>({
    queryKey: ["/api/won-loads/pending-for-me"],
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  // Listen for SSE notification of a new pending row to refetch immediately.
  useEffect(() => {
    if (!enabled) return;
    const onNotif = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { type?: string } | undefined;
      if (detail?.type === "won_load_pending_approval") refetch();
    };
    window.addEventListener("notification:received", onNotif as EventListener);
    return () => window.removeEventListener("notification:received", onNotif as EventListener);
  }, [enabled, refetch]);

  // Filter to un-snoozed rows for the popup queue.
  const queue = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter(it => !it.isSnoozed);
  }, [data]);
  const current = queue[0] ?? null;
  const morePending = queue.length > 1 ? queue.length - 1 : 0;

  // LM dropdown source.
  const { data: lmData } = useQuery<{ items: DirectReportLm[] }>({
    queryKey: ["/api/team/my-direct-report-lms"],
    enabled: enabled && !!current,
    staleTime: 60_000,
  });

  const [assignedToId, setAssignedToId] = useState<string>("");
  const [approveChecked, setApproveChecked] = useState(true);

  // When the queue head rotates, reset selection state.
  const lastSeenIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = current?.id ?? null;
    if (id !== lastSeenIdRef.current) {
      lastSeenIdRef.current = id;
      setAssignedToId("");
      setApproveChecked(true);
    }
  }, [current?.id]);

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("No load");
      if (!assignedToId) throw new Error("Pick an LM");
      const res = await apiRequest("POST", `/api/freight-opportunities/${current.id}/assign`, {
        assignedToId,
        approved: approveChecked,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Assigned", description: "The Logistics Manager has been notified." });
      queryClient.invalidateQueries({ queryKey: ["/api/won-loads/pending-for-me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: (err: Error) => {
      toast({ title: "Assign failed", description: err.message, variant: "destructive" });
    },
  });

  const snoozeMutation = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error("No load");
      const res = await apiRequest("POST", `/api/freight-opportunities/${current.id}/snooze`, { minutes: 30 });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Snoozed", description: "We'll remind you in 30 minutes." });
      queryClient.invalidateQueries({ queryKey: ["/api/won-loads/pending-for-me"] });
    },
    onError: (err: Error) => {
      toast({ title: "Snooze failed", description: err.message, variant: "destructive" });
    },
  });

  if (!enabled || !current) return null;

  const lms = lmData?.items ?? [];
  const open = true;

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-[520px]"
        // Un-dismissible: only the buttons can close this modal.
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="dialog-won-load-approval"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-amber-500" />
            Won load — assign a Logistics Manager
            {morePending > 0 && (
              <Badge variant="secondary" className="ml-auto" data-testid="badge-more-pending">
                +{morePending} more
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            A customer just confirmed a quote. Pick one of your direct-report Logistics Managers to start carrier outreach.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="font-semibold" data-testid="text-customer-name">{current.companyName ?? "Customer"}</div>
              <div className="text-xs text-muted-foreground">
                {current.equipmentType ?? "Load"}
              </div>
            </div>
            <div className="text-sm" data-testid="text-lane">{formatLane(current)}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {current.pickupWindowStart && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Pickup {current.pickupWindowStart}
                </span>
              )}
              <span>Quoted to customer: <strong data-testid="text-quoted-rate">{formatRate(current.quotedRate)}</strong></span>
              <span>Target buy: <strong data-testid="text-target-buy">{formatRate(current.targetBuyRate)}</strong></span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lm-select">Assign to Logistics Manager</Label>
            <Select value={assignedToId} onValueChange={setAssignedToId}>
              <SelectTrigger id="lm-select" data-testid="select-lm">
                <SelectValue placeholder={lms.length ? "Pick an LM" : "No direct-report LMs available"} />
              </SelectTrigger>
              <SelectContent>
                {lms.map(lm => (
                  <SelectItem key={lm.id} value={lm.id} data-testid={`option-lm-${lm.id}`}>
                    {lm.name || lm.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {lms.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                You have no Logistics Managers reporting to you. Ask your admin to set the manager link before this load can be assigned.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="approve-check"
              checked={approveChecked}
              onCheckedChange={(v) => setApproveChecked(v === true)}
              data-testid="checkbox-approve"
            />
            <Label htmlFor="approve-check" className="font-normal cursor-pointer">
              Also approve so the LM can send immediately
            </Label>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(`/my-procurement?wonLoad=${current.id}`)}
            data-testid="button-view-load"
          >
            <ExternalLink className="w-4 h-4 mr-1" /> View load
          </Button>
          <Button
            variant="ghost"
            onClick={() => snoozeMutation.mutate()}
            disabled={snoozeMutation.isPending}
            data-testid="button-snooze"
          >
            {snoozeMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Clock className="w-4 h-4 mr-1" />}
            Snooze 30 min
          </Button>
          <Button
            onClick={() => assignMutation.mutate()}
            disabled={!assignedToId || assignMutation.isPending}
            data-testid="button-assign"
          >
            {assignMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
