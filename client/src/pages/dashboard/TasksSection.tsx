import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import {
  ClipboardList, Plus, CheckCircle2, ListTodo, Trash2,
  Bell, MessageCircle, Users, Truck, ChevronDown, ChevronUp,
  CheckCheck, UserCog, X,
} from "lucide-react";
import { dueDateBadge, statusIcon, nextStatus } from "./utils";
import { formatCustomerName } from "@shared/laneFormatters";
import type { Task, LaneCarrier } from "@shared/schema";
import type { Notification } from "@shared/schema";
import type { ActionItem, SafeUser } from "./types";
import type { ProcurementLaneInfo } from "@/components/carrier-procurement-workspace";
import { Route } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

function ProcurementTaskSummary({ lane, taskId }: { lane: ProcurementLaneInfo; taskId: string }) {
  const { data: carriers = [] } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/tasks", taskId, "lane-carriers"],
    staleTime: 2 * 60 * 1000,
  });
  const laneName = lane.lane;
  const activeCount = carriers.filter((c: LaneCarrier) => c.lane === laneName && c.status !== "declined").length;
  const committedCount = carriers.filter((c: LaneCarrier) => c.lane === laneName && c.status === "committed").length;

  let coverageColor = "bg-red-500/10 text-red-700 dark:text-red-400";
  if (activeCount >= 5) coverageColor = "bg-green-500/10 text-green-700 dark:text-green-400";
  else if (activeCount > 0) coverageColor = "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";

  return (
    <div className="mt-1.5 space-y-1" data-testid={`procurement-summary-${taskId}`}>
      {(lane.customerName || lane.awardTitle) && (
        <div className="flex items-center gap-2 flex-wrap">
          {lane.customerName && (
            <span className="text-xs text-muted-foreground font-medium" data-testid={`text-proc-customer-${taskId}`}>{formatCustomerName(lane.customerName)}</span>
          )}
          {lane.awardTitle && (
            <span className="text-xs text-muted-foreground" data-testid={`text-proc-award-${taskId}`}>· {lane.awardTitle}</span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Route className="h-3 w-3" />
          <span data-testid={`text-proc-lane-${taskId}`}>{lane.origin} → {lane.destination}</span>
        </div>
        {lane.volume > 0 && (
          <span className="text-xs text-muted-foreground">{Number(lane.volume).toLocaleString()} loads/yr</span>
        )}
        {lane.rate && (
          <span className="text-xs text-muted-foreground">${lane.rate}/load</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={`text-xs h-5 px-1.5 ${coverageColor}`} data-testid={`badge-proc-coverage-${taskId}`}>
          <Truck className="h-2.5 w-2.5 mr-1" />
          {committedCount}/{activeCount} committed · {activeCount}/5 contacted
        </Badge>
      </div>
    </div>
  );
}

interface TasksSectionProps {
  isVisible: (key: string) => boolean;
  getOrder: (key: string) => number;
  tasksCollapsed: boolean;
  setTasksCollapsed: (v: boolean) => void;
  tasksLoading: boolean;
  openTasks: Task[];
  unreadTasks: number;
  incomingTasks: Task[];
  regularTasks: Task[];
  displayTasks: Task[];
  completedCount: number;
  actionItems: ActionItem[];
  getCompanyName: (id: string | null) => string;
  getUserName: (id: string) => string;
  taskCommentNotifIds: Set<string>;
  taskAssignedNotifMap: Map<string, Notification>;
  markNotifRead: (notifId: string) => void;
  toggleStatus: (id: string, status: string) => void;
  deleteTask: (id: string) => void;
  currentUser: SafeUser | null | undefined;
  onEditTask: (task: Task | undefined) => void;
  onOpenTaskDialog: () => void;
  teamMembers?: SafeUser[];
}

export function TasksSection({
  isVisible, getOrder,
  tasksCollapsed, setTasksCollapsed,
  tasksLoading, openTasks, unreadTasks,
  incomingTasks, regularTasks, displayTasks, completedCount,
  actionItems,
  getCompanyName, getUserName,
  taskCommentNotifIds, taskAssignedNotifMap,
  markNotifRead, toggleStatus, deleteTask,
  currentUser,
  onEditTask, onOpenTaskDialog,
  teamMembers = [],
}: TasksSectionProps) {
  const { toast } = useToast();
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [reassignDialogOpen, setReassignDialogOpen] = useState(false);
  const [reassignUserId, setReassignUserId] = useState("");

  const allSelectableTasks = useMemo(() => [...incomingTasks, ...regularTasks], [incomingTasks, regularTasks]);

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const clearSelection = () => setSelectedTaskIds(new Set());

  const bulkCompleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map(id => apiRequest("PATCH", `/api/tasks/${id}`, { status: "completed" })));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: `${selectedTaskIds.size} task${selectedTaskIds.size !== 1 ? "s" : ""} marked complete` });
      clearSelection();
    },
    onError: () => toast({ title: "Failed to update tasks", variant: "destructive" }),
  });

  const bulkReassignMutation = useMutation({
    mutationFn: async ({ ids, userId }: { ids: string[]; userId: string }) => {
      await Promise.all(ids.map(id => apiRequest("PATCH", `/api/tasks/${id}`, { assignedTo: userId })));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      const name = teamMembers.find(u => u.id === reassignUserId)?.name || "user";
      toast({ title: `${selectedTaskIds.size} task${selectedTaskIds.size !== 1 ? "s" : ""} reassigned to ${name}` });
      setReassignDialogOpen(false);
      setReassignUserId("");
      clearSelection();
    },
    onError: () => toast({ title: "Failed to reassign tasks", variant: "destructive" }),
  });

  const handleBulkComplete = () => {
    bulkCompleteMutation.mutate(Array.from(selectedTaskIds));
  };

  const handleBulkReassign = () => {
    if (!reassignUserId) return;
    bulkReassignMutation.mutate({ ids: Array.from(selectedTaskIds), userId: reassignUserId });
  };

  return (
    <div style={{ order: getOrder("tasks") }} className={!isVisible("tasks") ? "hidden" : ""}>
    <Card data-testid="card-my-tasks" data-tour="tour-tasks-portlet">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            className="flex items-center gap-2 text-left"
            onClick={() => { const next = !tasksCollapsed; setTasksCollapsed(next); localStorage.setItem("dash_tasks_collapsed", String(next)); }}
            data-testid="button-toggle-tasks-section"
          >
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              My Tasks
              {!tasksLoading && openTasks.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{openTasks.length}</Badge>
              )}
              {unreadTasks > 0 && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {unreadTasks} new
                </span>
              )}
            </CardTitle>
            {tasksCollapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
          </button>
          <div className="flex items-center gap-2">
            <Link href="/tasks">
              <Button
                size="sm"
                variant="ghost"
                className="gap-1 text-muted-foreground"
                data-testid="button-open-tasks"
              >
                <ListTodo className="h-3 w-3" /> Open Tasks
              </Button>
            </Link>
            <Link href="/tasks#completed">
              <Button
                size="sm"
                variant="ghost"
                className="gap-1 text-muted-foreground"
                data-testid="button-completed-tasks"
              >
                <CheckCircle2 className="h-3 w-3" /> Completed
              </Button>
            </Link>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => { onEditTask(undefined); onOpenTaskDialog(); }}
              data-testid="button-add-task"
            >
              <Plus className="h-3 w-3" /> Add Task
            </Button>
          </div>
        </div>
      </CardHeader>
      {!tasksCollapsed && (
      <CardContent>
        {tasksLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : (
          <>
            {incomingTasks.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1.5 px-1"
                   style={{ color: "#ffb400" }}>
                  <Bell className="h-3 w-3" />
                  Incoming — needs acknowledgment
                </p>
                <div className="space-y-1">
                  {incomingTasks.map(task => {
                    const companyName = getCompanyName(task.companyId);
                    const assignerName = getUserName(task.assignedBy);
                    const hasNewComment = taskCommentNotifIds.has(task.id);
                    const assignedNotif = taskAssignedNotifMap.get(task.id);
                    const isSelected = selectedTaskIds.has(task.id);
                    return (
                      <div
                        key={task.id}
                        className={`flex items-center gap-3 p-3 rounded-lg border transition-all group cursor-pointer border-amber-400/40 bg-amber-500/5 hover:bg-amber-500/10 ${task.status === "completed" ? "opacity-50" : ""}`}
                        data-testid={`task-row-${task.id}`}
                        onClick={() => { onEditTask(task); onOpenTaskDialog(); }}
                      >
                        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => { e.stopPropagation(); toggleTaskSelection(task.id); }} data-testid={`checkbox-task-${task.id}`}>
                          <Checkbox checked={isSelected} onCheckedChange={() => toggleTaskSelection(task.id)} className="h-3.5 w-3.5" />
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); toggleStatus(task.id, nextStatus(task.status)); }} className="shrink-0 hover:scale-110 transition-transform" title={`Status: ${task.status}`} data-testid={`button-toggle-status-${task.id}`}>{statusIcon(task.status)}</button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-task-title-${task.id}`}>{task.title}</p>
                            {hasNewComment && (
                              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.3)" }} data-testid={`badge-new-comment-${task.id}`}>
                                <MessageCircle className="h-2.5 w-2.5" /> reply
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap mt-0.5">
                            {companyName && <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`} onClick={(e) => e.stopPropagation()}>{companyName}</Link>}
                            {assignerName && <span className="text-xs text-muted-foreground">from {assignerName}</span>}
                          </div>
                        </div>
                        {dueDateBadge(task.dueDate)}
                        {assignedNotif && (
                          <button
                            onClick={(e) => { e.stopPropagation(); markNotifRead(assignedNotif.id.toString()); }}
                            className="shrink-0 px-2 py-1 rounded text-xs font-medium"
                            style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.25)" }}
                            title="Acknowledge — keeps task in open tasks"
                            data-testid={`button-acknowledge-task-${task.id}`}
                          >
                            <Bell className="h-3 w-3" />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    );
                  })}
                </div>
                {regularTasks.length > 0 && <div className="border-t border-border mt-3 mb-2" />}
              </div>
            )}
            {regularTasks.length > 0 && (
              <div className="space-y-1">
                {regularTasks.map(task => {
                  const companyName = getCompanyName(task.companyId);
                  const assignerName = getUserName(task.assignedBy);
                  const hasNewComment = taskCommentNotifIds.has(task.id);
                  const isSelected = selectedTaskIds.has(task.id);
                  const procLane = (() => {
                    if (!Array.isArray(task.attachedLaneData)) return null;
                    return (task.attachedLaneData as Array<Record<string, unknown>>).find(
                      (l): l is ProcurementLaneInfo =>
                        l != null && l.type === "carrier_procurement" && typeof l.lane === "string"
                    ) ?? null;
                  })();
                  return (
                    <div
                      key={task.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-all group cursor-pointer ${procLane ? "border-primary/20 bg-primary/3 hover:border-primary/40 hover:bg-primary/5" : "border-transparent hover:border-border hover:bg-muted/50"} ${task.status === "completed" ? "opacity-50" : ""}`}
                      data-testid={`task-row-${task.id}`}
                      onClick={() => { onEditTask(task); onOpenTaskDialog(); }}
                    >
                      <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" onClick={e => { e.stopPropagation(); toggleTaskSelection(task.id); }} data-testid={`checkbox-task-${task.id}`}>
                        <Checkbox checked={isSelected} onCheckedChange={() => toggleTaskSelection(task.id)} className="h-3.5 w-3.5" />
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); toggleStatus(task.id, nextStatus(task.status)); }} className="shrink-0 hover:scale-110 transition-transform mt-0.5" title={`Status: ${task.status}`} data-testid={`button-toggle-status-${task.id}`}>{statusIcon(task.status)}</button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-task-title-${task.id}`}>{task.title}</p>
                          {hasNewComment && (
                            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-semibold shrink-0" style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400", border: "1px solid rgba(255,180,0,0.3)" }} data-testid={`badge-new-comment-${task.id}`}>
                              <MessageCircle className="h-2.5 w-2.5" /> reply
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          {companyName && <Link href={`/companies/${task.companyId}`} className="text-xs text-primary hover:underline" data-testid={`link-task-company-${task.id}`} onClick={(e) => e.stopPropagation()}>{companyName}</Link>}
                          {assignerName && task.assignedBy !== currentUser?.id && <span className="text-xs text-muted-foreground">from {assignerName}</span>}
                        </div>
                        {procLane && (
                          <ProcurementTaskSummary lane={procLane} taskId={task.id} />
                        )}
                      </div>
                      {procLane && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 h-7 px-2 text-xs border-primary/30 text-primary hover:bg-primary/10 mt-0.5"
                          onClick={(e) => { e.stopPropagation(); onEditTask(task); onOpenTaskDialog(); }}
                          data-testid={`button-open-workspace-${task.id}`}
                        >
                          <Truck className="h-3 w-3 mr-1" />
                          Open Workspace
                        </Button>
                      )}
                      {!procLane && dueDateBadge(task.dueDate)}
                      <button onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" data-testid={`button-delete-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
                {completedCount > 0 && (
                  <p className="text-xs text-muted-foreground pt-2 pl-3" data-testid="text-completed-count">
                    {completedCount} completed task{completedCount !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
            )}

            {actionItems.length > 0 && (
              <div className={displayTasks.length > 0 ? "mt-3 pt-3 border-t border-border" : ""} data-testid="section-action-items">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5 px-1">
                  <Users className="h-3 w-3" />
                  1:1 Action Items
                </p>
                <div className="space-y-1">
                  {actionItems.map(item => (
                    <Link key={item.id} href="/one-on-one">
                      <div
                        className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all cursor-pointer"
                        data-testid={`action-item-row-${item.id}`}
                      >
                        <div className="shrink-0 mt-0.5">
                          <div className="h-4 w-4 rounded-full border-2 border-violet-400 dark:border-violet-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" data-testid={`text-action-item-${item.id}`}>
                            {item.text}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            with {item.withUserName}
                            {item.addedById !== currentUser?.id && ` · added by ${item.addedByName}`}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 h-5 border-violet-300 text-violet-600 dark:border-violet-600 dark:text-violet-400 font-medium">
                          1:1
                        </Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {displayTasks.length === 0 && actionItems.length === 0 && (
              <div className="text-center py-6 text-muted-foreground">
                <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm mb-3">No tasks yet</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => { onEditTask(undefined); onOpenTaskDialog(); }}
                  data-testid="button-create-first-task"
                >
                  <Plus className="h-3.5 w-3.5" /> Create a task
                </Button>
              </div>
            )}

            {/* Bulk action bar */}
            {selectedTaskIds.size > 0 && (
              <div
                className="sticky bottom-0 mt-3 flex items-center gap-2 p-2.5 rounded-lg border border-primary/30 bg-primary/5 backdrop-blur-sm shadow-sm"
                data-testid="bulk-action-bar"
              >
                <span className="text-xs font-medium text-primary">
                  {selectedTaskIds.size} selected
                </span>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={handleBulkComplete}
                  disabled={bulkCompleteMutation.isPending}
                  data-testid="button-bulk-complete"
                >
                  <CheckCheck className="h-3 w-3" />
                  Mark Complete
                </Button>
                {teamMembers.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => { setReassignUserId(""); setReassignDialogOpen(true); }}
                    data-testid="button-bulk-reassign"
                  >
                    <UserCog className="h-3 w-3" />
                    Reassign…
                  </Button>
                )}
                <button
                  onClick={clearSelection}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-clear-selection"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </CardContent>
      )}
    </Card>

    {/* Reassign dialog */}
    <Dialog open={reassignDialogOpen} onOpenChange={setReassignDialogOpen}>
      <DialogContent className="sm:max-w-xs" data-testid="dialog-bulk-reassign">
        <DialogHeader>
          <DialogTitle>Reassign {selectedTaskIds.size} task{selectedTaskIds.size !== 1 ? "s" : ""}</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Select value={reassignUserId} onValueChange={setReassignUserId}>
            <SelectTrigger data-testid="select-reassign-user">
              <SelectValue placeholder="Choose a team member…" />
            </SelectTrigger>
            <SelectContent>
              {teamMembers.map(u => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setReassignDialogOpen(false)} data-testid="button-cancel-reassign">Cancel</Button>
          <Button
            onClick={handleBulkReassign}
            disabled={!reassignUserId || bulkReassignMutation.isPending}
            data-testid="button-confirm-reassign"
          >
            {bulkReassignMutation.isPending ? "Reassigning…" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}
