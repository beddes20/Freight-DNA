/**
 * WeeklyCommitmentsPanel — AM's own commitment tracker (this week).
 * TeamCommitmentsPortlet   — Manager coaching view (last week's team follow-through).
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Check, X, Trash2, ChevronDown, ChevronUp, Target, Users, RotateCcw,
} from "lucide-react";
import { Link } from "wouter";
import type { WeeklyCommitment } from "@shared/schema";

// ─── Shared helpers ────────────────────────────────────────────────────────────

function getWeekStart(date = new Date()): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split("T")[0];
}

function getLastWeekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return getWeekStart(d);
}

function formatWeekRange(weekStart: string): string {
  const d = new Date(weekStart + "T12:00:00");
  const end = new Date(d);
  end.setDate(d.getDate() + 4);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

const LEVER_COLOR: Record<string, string> = {
  "Recovery":           "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "Contact Mapping":    "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "Lane ID":            "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "Spot-to-Contract":   "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  "Referral":           "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "Relationship Advance":"bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

function leverColor(lever: string) {
  return LEVER_COLOR[lever] ?? "bg-muted text-muted-foreground";
}

const STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  pending:   { label: "Pending",   badgeClass: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" },
  completed: { label: "Done",      badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" },
  missed:    { label: "Missed",    badgeClass: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" },
};

// ─── Commitment Row (shared between AM panel and manager view) ─────────────────

type CommitmentRowProps = {
  item: WeeklyCommitment;
  showActions?: boolean;
  onStatus?: (id: string, status: string) => void;
  onDelete?: (id: string) => void;
  isPending?: boolean;
};

function CommitmentRow({ item, showActions, onStatus, onDelete, isPending }: CommitmentRowProps) {
  const meta = STATUS_META[item.status] ?? STATUS_META["pending"];
  return (
    <div className={`py-2.5 flex items-start gap-3 ${item.status === "completed" ? "opacity-60" : ""}`} data-testid={`commitment-row-${item.id}`}>
      {/* Status indicator */}
      <div className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${item.status === "completed" ? "bg-green-500" : item.status === "missed" ? "bg-red-500" : "bg-amber-400"}`} />

      <div className="flex-1 min-w-0">
        {/* Company / contact */}
        {(item.companyName || item.contactName) && (
          <p className="text-[10px] text-muted-foreground mb-0.5">
            {item.companyName && (
              <Link href={`/companies/${item.companyId}`} className="hover:text-foreground transition-colors">
                {item.companyName}
              </Link>
            )}
            {item.contactName && <span> · {item.contactName}</span>}
          </p>
        )}

        {/* Commitment text */}
        <p className={`text-xs leading-snug ${item.status === "completed" ? "line-through text-muted-foreground" : "text-foreground"}`}>
          {item.commitmentText}
        </p>

        {/* Lever badge */}
        <span className={`inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${leverColor(item.lever)}`}>
          {item.lever}
        </span>
      </div>

      {/* Actions */}
      {showActions && (
        <div className="flex items-center gap-0.5 shrink-0">
          {item.status !== "completed" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-green-600 hover:bg-green-50 dark:hover:bg-green-950/40"
              title="Mark done"
              disabled={isPending}
              onClick={() => onStatus?.(item.id, "completed")}
              data-testid={`button-commit-complete-${item.id}`}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          )}
          {item.status === "completed" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:bg-muted"
              title="Undo"
              disabled={isPending}
              onClick={() => onStatus?.(item.id, "pending")}
              data-testid={`button-commit-undo-${item.id}`}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          )}
          {item.status === "pending" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
              title="Mark missed"
              disabled={isPending}
              onClick={() => onStatus?.(item.id, "missed")}
              data-testid={`button-commit-missed-${item.id}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            title="Remove"
            disabled={isPending}
            onClick={() => onDelete?.(item.id)}
            data-testid={`button-commit-delete-${item.id}`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Status badge (manager view — read-only) */}
      {!showActions && (
        <span className={`shrink-0 mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${meta.badgeClass}`}>
          {meta.label}
        </span>
      )}
    </div>
  );
}

// ─── 1. AM Weekly Commitments Panel ───────────────────────────────────────────

interface WeeklyCommitmentsPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function WeeklyCommitmentsPanel({ collapsed, onToggle }: WeeklyCommitmentsPanelProps) {
  const { toast } = useToast();
  const thisWeek = getWeekStart();

  const { data: commitments = [], isLoading } = useQuery<WeeklyCommitment[]>({
    queryKey: ["/api/weekly-commitments", { weekStart: thisWeek }],
    queryFn: () => fetch(`/api/weekly-commitments?weekStart=${thisWeek}`, { credentials: "include" }).then(r => r.json()),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest("PATCH", `/api/weekly-commitments/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/weekly-commitments"] }),
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/weekly-commitments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/weekly-commitments"] }),
    onError: () => toast({ title: "Failed to remove", variant: "destructive" }),
  });

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const friday = new Date(thisWeek + "T12:00:00");
  friday.setDate(friday.getDate() + 4);
  const fridayStr = friday.toISOString().split("T")[0];

  const pending   = commitments.filter(c => c.status === "pending" && c.dueDate >= todayStr);
  const overdue   = commitments.filter(c => c.status === "pending" && c.dueDate < todayStr);
  const completed = commitments.filter(c => c.status === "completed");
  const missed    = commitments.filter(c => c.status === "missed");

  const total = commitments.length;
  const doneCount = completed.length;
  const overdueCount = overdue.length;

  return (
    <Card data-testid="panel-weekly-commitments">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-weekly-commitments"
      >
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold">My Commitments This Week</span>
          <span className="text-xs text-muted-foreground">{formatWeekRange(thisWeek)}</span>
          {total > 0 && (
            <div className="flex items-center gap-1">
              {overdueCount > 0 && (
                <Badge className="text-[10px] px-1.5 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-0">
                  {overdueCount} overdue
                </Badge>
              )}
              <Badge className="text-[10px] px-1.5 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-0">
                {doneCount}/{total}
              </Badge>
            </div>
          )}
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-3">Loading…</p>
          ) : total === 0 ? (
            <p className="text-sm text-muted-foreground py-3">
              No commitments yet this week. Hit "Commit to this" on any account, contact, or growth call below to lock in your moves.
            </p>
          ) : (
            <div className="divide-y" data-testid="commitments-list">
              {overdue.map(c => (
                <CommitmentRow
                  key={c.id} item={c} showActions
                  onStatus={(id, status) => statusMutation.mutate({ id, status })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  isPending={statusMutation.isPending || deleteMutation.isPending}
                />
              ))}
              {pending.map(c => (
                <CommitmentRow
                  key={c.id} item={c} showActions
                  onStatus={(id, status) => statusMutation.mutate({ id, status })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  isPending={statusMutation.isPending || deleteMutation.isPending}
                />
              ))}
              {completed.map(c => (
                <CommitmentRow
                  key={c.id} item={c} showActions
                  onStatus={(id, status) => statusMutation.mutate({ id, status })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  isPending={statusMutation.isPending || deleteMutation.isPending}
                />
              ))}
              {missed.map(c => (
                <CommitmentRow
                  key={c.id} item={c} showActions
                  onStatus={(id, status) => statusMutation.mutate({ id, status })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  isPending={statusMutation.isPending || deleteMutation.isPending}
                />
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── 2. Manager Team Commitments Portlet ──────────────────────────────────────

interface TeamCommitmentsPortletProps {
  collapsed: boolean;
  onToggle: () => void;
}

type CommitmentWithUser = WeeklyCommitment & { userName: string; userRole: string };

export function TeamCommitmentsPortlet({ collapsed, onToggle }: TeamCommitmentsPortletProps) {
  const [viewingWeek, setViewingWeek] = useState<"last" | "current">("last");
  const weekStart = viewingWeek === "last" ? getLastWeekStart() : getWeekStart();

  const { data: rows = [], isLoading } = useQuery<CommitmentWithUser[]>({
    queryKey: ["/api/weekly-commitments/team", { weekStart }],
    queryFn: () =>
      fetch(`/api/weekly-commitments/team?weekStart=${weekStart}`, { credentials: "include" }).then(r => r.json()),
  });

  // Group by user
  const byUser = rows.reduce<Record<string, CommitmentWithUser[]>>((acc, r) => {
    if (!acc[r.userId]) acc[r.userId] = [];
    acc[r.userId].push(r);
    return acc;
  }, {});

  const userEntries = Object.entries(byUser);
  const totalReps = userEntries.length;
  const totalItems = rows.length;
  const completedItems = rows.filter(r => r.status === "completed").length;

  return (
    <Card data-testid="portlet-team-commitments">
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-team-commitments"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-semibold">Team Commitment Follow-Through</span>
          {totalItems > 0 && (
            <Badge className="text-[10px] px-1.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-0">
              {completedItems}/{totalItems} done · {totalReps} reps
            </Badge>
          )}
        </div>
        {collapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">
          {/* Week toggle */}
          <div className="flex items-center gap-1 mb-3">
            <Button
              variant={viewingWeek === "last" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setViewingWeek("last")}
              data-testid="button-team-commitments-last-week"
            >
              Last week
            </Button>
            <Button
              variant={viewingWeek === "current" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setViewingWeek("current")}
              data-testid="button-team-commitments-this-week"
            >
              This week
            </Button>
            <span className="text-xs text-muted-foreground ml-1">{formatWeekRange(weekStart)}</span>
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground py-3">Loading…</p>
          ) : totalItems === 0 ? (
            <p className="text-sm text-muted-foreground py-3">
              No commitments logged for this week. AMs can commit to actions from the "Accounts Drifting," "Relationship Advancement," and "Top Growth Calls" portlets on their dashboard.
            </p>
          ) : (
            <div className="flex flex-col gap-4" data-testid="team-commitments-list">
              {userEntries.map(([userId, items]) => {
                const userName = items[0].userName;
                const done = items.filter(i => i.status === "completed").length;
                const missed = items.filter(i => i.status === "missed").length;
                const pending = items.filter(i => i.status === "pending").length;
                const total = items.length;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;

                return (
                  <div key={userId} className="rounded-lg border border-border bg-muted/20 px-3 py-2.5" data-testid={`team-rep-${userId}`}>
                    {/* Rep header */}
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold">{userName}</p>
                      <div className="flex items-center gap-1">
                        {done > 0 && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">{done} done</span>
                        )}
                        {pending > 0 && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{pending} pending</span>
                        )}
                        {missed > 0 && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">{missed} missed</span>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="h-1 w-full rounded-full bg-muted mb-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : pct > 50 ? "bg-amber-400" : "bg-red-400"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    {/* Commitment rows (read-only, no actions) */}
                    <div className="divide-y">
                      {items.map(item => (
                        <CommitmentRow key={item.id} item={item} showActions={false} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
