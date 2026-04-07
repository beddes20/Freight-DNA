/**
 * ForcedFocusBanner — Leadership Priority banner for rep home screen.
 * Displays above the NBA portlet when an active Forced Focus is assigned.
 * Provides "Make My Commitment" and "Create Linked Task" quick actions + Dismiss.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Crown, Calendar, Building2, Target, X, CheckCircle2, ListPlus,
} from "lucide-react";
import type { CommitPayload } from "@/pages/dashboard/commitTypes";
import type { Lever } from "@/pages/dashboard/commitTypes";

interface ForcedFocus {
  id: string;
  assignedToUserId: string;
  assignedByUserId: string;
  orgId: string;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  lever: string | null;
  actionText: string;
  contextReason: string | null;
  dueDate: string | null;
  status: string;
  createdAt: string;
}

const LEVER_COLOR: Record<string, string> = {
  "Recovery":            "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "Contact Mapping":     "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "Lane ID":             "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "Spot-to-Contract":    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  "Referral":            "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "Pipeline":            "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  "QBR":                 "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  "Relationship Advance":"bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

function leverColor(lever: string | null) {
  if (!lever) return "bg-muted text-muted-foreground";
  return LEVER_COLOR[lever] ?? "bg-muted text-muted-foreground";
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface ForcedFocusBannerProps {
  onCommit: (payload: CommitPayload) => void;
  onCreateTask: (prefill: { title?: string; companyId?: string; companyName?: string; lever?: string; description?: string }) => void;
}

export function ForcedFocusBanner({ onCommit, onCreateTask }: ForcedFocusBannerProps) {
  const { toast } = useToast();
  const [dismissing, setDismissing] = useState(false);

  const { data: ff, isLoading } = useQuery<ForcedFocus | null>({
    queryKey: ["/api/forced-focus/my"],
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest("PATCH", `/api/forced-focus/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forced-focus/my"] });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  if (isLoading || !ff) return null;

  const handleCommit = () => {
    onCommit({
      companyId: ff.companyId ?? undefined,
      companyName: ff.companyName ?? undefined,
      contactId: ff.contactId ?? undefined,
      contactName: ff.contactName ?? undefined,
      defaultText: ff.actionText,
      defaultLever: (ff.lever as Lever) ?? "Recovery",
      source: "forced_focus",
    });
  };

  const handleCreateTask = () => {
    onCreateTask({
      title: ff.actionText,
      companyId: ff.companyId ?? undefined,
      companyName: ff.companyName ?? undefined,
      lever: ff.lever ?? undefined,
      description: ff.contextReason ?? undefined,
    });
  };

  const handleDismiss = () => {
    setDismissing(true);
    patchMutation.mutate({ id: ff.id, status: "dismissed" });
  };

  const handleComplete = () => {
    patchMutation.mutate({ id: ff.id, status: "completed" });
  };

  return (
    <Card
      className="border-2 border-purple-400 dark:border-purple-600 bg-purple-50 dark:bg-purple-950/20 shadow-sm"
      data-testid="banner-forced-focus"
    >
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center h-7 w-7 rounded-full bg-purple-500/20 dark:bg-purple-500/30 shrink-0">
              <Crown className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-purple-700 dark:text-purple-300 leading-tight">
                Leadership Priority
              </p>
              <p className="text-[10px] text-purple-500 dark:text-purple-400 leading-tight">
                Assigned by your manager — not system-generated
              </p>
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 transition-colors"
            onClick={handleDismiss}
            disabled={dismissing || patchMutation.isPending}
            aria-label="Dismiss"
            data-testid="button-forced-focus-dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Account + meta row */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {ff.companyName && (
            <div className="flex items-center gap-1 text-xs font-medium text-foreground">
              <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {ff.companyName}
              {ff.contactName && <span className="text-muted-foreground">· {ff.contactName}</span>}
            </div>
          )}
          {ff.lever && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${leverColor(ff.lever)}`}>
              {ff.lever}
            </span>
          )}
          {ff.dueDate && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto shrink-0">
              <Calendar className="h-3 w-3" />
              Due {formatDate(ff.dueDate)}
            </div>
          )}
        </div>

        {/* Action text */}
        <p className="text-sm font-semibold text-foreground leading-snug mb-2" data-testid="text-forced-focus-action">
          {ff.actionText}
        </p>

        {/* Context reason */}
        {ff.contextReason && (
          <div className="rounded-md bg-purple-100/60 dark:bg-purple-900/30 px-3 py-2 mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400 mb-0.5">
              Manager's context
            </p>
            <p className="text-xs text-foreground/80" data-testid="text-forced-focus-context">
              {ff.contextReason}
            </p>
          </div>
        )}

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-xs bg-purple-600 hover:bg-purple-700 text-white gap-1.5"
            onClick={handleCommit}
            data-testid="button-forced-focus-commit"
          >
            <Target className="h-3.5 w-3.5" />
            Make My Commitment This Week
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs border-purple-300 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/30 gap-1.5"
            onClick={handleCreateTask}
            data-testid="button-forced-focus-create-task"
          >
            <ListPlus className="h-3.5 w-3.5" />
            Create Linked Task
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 gap-1.5 ml-auto"
            onClick={handleComplete}
            disabled={patchMutation.isPending}
            data-testid="button-forced-focus-complete"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark Done
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
