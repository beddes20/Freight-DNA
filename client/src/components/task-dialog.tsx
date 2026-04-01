import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, ChevronDown, ChevronRight, Paperclip, MessageSquare, Send, Trash2, Reply, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { Company, Task, User, TaskComment } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";
import { CarrierProcurementWorkspace, type ProcurementLaneInfo } from "@/components/carrier-procurement-workspace";

type SafeUser = Omit<User, "password">;

interface LaneDataAttachment {
  type: string;
  label: string;
  items: any[];
}

interface PrefillData {
  title: string;
  notes?: string;
  attachedLaneData?: any[];
}

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId?: string;
  editingTask?: Task;
  forwardingTask?: Task;
  prefillData?: PrefillData;
  focusComments?: boolean;
}

export function TaskDialog({ open, onOpenChange, companyId, editingTask, forwardingTask, prefillData, focusComments }: TaskDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const commentsRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [status, setStatus] = useState("open");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [attachExpanded, setAttachExpanded] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [snapshotData, setSnapshotData] = useState<LaneDataAttachment[]>([]);
  const [selectedItems, setSelectedItems] = useState<Record<string, Set<number>>>({}); 
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [commentText, setCommentText] = useState("");
  const [replyToComment, setReplyToComment] = useState<TaskComment | null>(null);
  const [completionNote, setCompletionNote] = useState("");

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const showGrouped = user?.role === "admin" || user?.role === "director";
  const sortedMembers = [...teamMembers].sort((a, b) => a.name.localeCompare(b.name));
  const assigneeGroups = {
    admins:    sortedMembers.filter(u => u.role === "admin"),
    directors: sortedMembers.filter(u => u.role === "director"),
    nams:      sortedMembers.filter(u => u.role === "national_account_manager"),
    ams:       sortedMembers.filter(u => !["admin","director","national_account_manager"].includes(u.role)),
  };

  const { data: comments = [] } = useQuery<TaskComment[]>({
    queryKey: ["/api/tasks", editingTask?.id, "comments"],
    enabled: !!editingTask?.id,
  });

  const addCommentMutation = useMutation({
    mutationFn: async ({ content, parentId }: { content: string; parentId?: string }) => {
      return apiRequest("POST", `/api/tasks/${editingTask!.id}/comments`, { content, parentId: parentId || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", editingTask?.id, "comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      setCommentText("");
      setReplyToComment(null);
    },
    onError: (error: any) => {
      toast({ title: "Error posting comment", description: error.message, variant: "destructive" });
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (commentId: string) => {
      return apiRequest("DELETE", `/api/tasks/${editingTask!.id}/comments/${commentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", editingTask?.id, "comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: !companyId,
  });

  const effectiveCompanyId = companyId || selectedCompanyId;

  useEffect(() => {
    if (open) {
      setPendingFiles([]);
      setCompletionNote("");
      if (prefillData) {
        setTitle(prefillData.title);
        setNotes(prefillData.notes || "");
        setDueDate("");
        setAssignedTo(user?.id || "");
        setStatus("open");
        setSelectedCompanyId(companyId || "");
        setAttachExpanded(false);
        setSelectedTypes(new Set());
        setSnapshotData([]);
        setSelectedItems({});
      } else if (forwardingTask) {
        setTitle(forwardingTask.title);
        setNotes("");
        setDueDate(forwardingTask.dueDate || "");
        setAssignedTo("");
        setStatus("open");
        setSelectedCompanyId(forwardingTask.companyId || "");
        setAttachExpanded(false);
        setSelectedTypes(new Set());
        setSnapshotData([]);
        setSelectedItems({});
      } else if (editingTask) {
        setTitle(editingTask.title);
        setNotes(editingTask.notes || "");
        setDueDate(editingTask.dueDate || "");
        setAssignedTo(editingTask.assignedTo);
        setStatus(editingTask.status);
        setSelectedCompanyId(editingTask.companyId || "");
        setAttachExpanded(false);
        setSelectedTypes(new Set());
        setSnapshotData([]);
        setSelectedItems({});
      } else {
        setTitle("");
        setNotes("");
        setDueDate("");
        setAssignedTo(user?.id || "");
        setStatus("open");
        setSelectedCompanyId(companyId || "");
        setAttachExpanded(false);
        setSelectedTypes(new Set());
        setSnapshotData([]);
        setSelectedItems({});
      }
    }
  }, [open, editingTask, forwardingTask, prefillData, companyId, user?.id]);

  useEffect(() => {
    if (open && focusComments && commentsRef.current) {
      const timer = setTimeout(() => {
        commentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [open, focusComments]);

  const toggleType = (type: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  useEffect(() => {
    if (!effectiveCompanyId || effectiveCompanyId === "none" || selectedTypes.size === 0) {
      setSnapshotData([]);
      return;
    }
    let cancelled = false;
    setLoadingSnapshot(true);
    fetch(`/api/companies/${effectiveCompanyId}/lane-data-snapshot?types=${Array.from(selectedTypes).join(",")}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: LaneDataAttachment[]) => {
        if (cancelled) return;
        setSnapshotData(data);
        const init: Record<string, Set<number>> = {};
        data.forEach(d => {
          init[d.type] = new Set(d.items.map((_: any, i: number) => i));
        });
        setSelectedItems(init);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingSnapshot(false); });
    return () => { cancelled = true; };
  }, [effectiveCompanyId, selectedTypes]);

  const toggleItem = (type: string, index: number) => {
    setSelectedItems(prev => {
      const next = { ...prev };
      const s = new Set(next[type] || []);
      if (s.has(index)) s.delete(index);
      else s.add(index);
      next[type] = s;
      return next;
    });
  };

  const toggleAll = (type: string, items: any[]) => {
    setSelectedItems(prev => {
      const next = { ...prev };
      const s = next[type] || new Set();
      if (s.size === items.length) {
        next[type] = new Set();
      } else {
        next[type] = new Set(items.map((_: any, i: number) => i));
      }
      return next;
    });
  };

  const buildAttachedLaneData = (): LaneDataAttachment[] | null => {
    if (prefillData?.attachedLaneData && prefillData.attachedLaneData.length > 0) {
      return prefillData.attachedLaneData as LaneDataAttachment[];
    }
    if (forwardingTask && forwardingTask.attachedLaneData) {
      return forwardingTask.attachedLaneData as LaneDataAttachment[];
    }
    if (selectedTypes.size === 0) return null;
    const result: LaneDataAttachment[] = [];
    for (const snap of snapshotData) {
      const sel = selectedItems[snap.type];
      if (!sel || sel.size === 0) continue;
      const filteredItems = snap.items.filter((_: any, i: number) => sel.has(i));
      if (filteredItems.length > 0) {
        result.push({ type: snap.type, label: snap.label, items: filteredItems });
      }
    }
    return result.length > 0 ? result : null;
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const attachedLaneData = buildAttachedLaneData();
      let taskResult: { id: string } | undefined;
      if (forwardingTask) {
        const res = await apiRequest("POST", `/api/tasks/${forwardingTask.id}/forward`, {
          assignedTo,
          notes: notes || null,
        });
        taskResult = await res.json() as { id: string };
      } else {
        const res = await apiRequest("POST", "/api/tasks", {
          title,
          notes: notes || null,
          status,
          dueDate: dueDate || null,
          assignedTo,
          companyId: effectiveCompanyId && effectiveCompanyId !== "none" ? effectiveCompanyId : null,
          attachedLaneData,
        });
        taskResult = await res.json() as { id: string };
      }
      if (pendingFiles.length > 0 && taskResult?.id) {
        try {
          await uploadPendingFiles(pendingFiles, "task", taskResult.id);
        } catch {
          toast({ title: "Task created but some files failed to upload", variant: "destructive" });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      if (effectiveCompanyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", effectiveCompanyId] });
      }
      toast({ title: forwardingTask ? "Task forwarded" : "Task created" });
      onOpenChange(false);
    },
    onError: () => toast({ title: forwardingTask ? "Failed to forward task" : "Failed to create task", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/tasks/${editingTask!.id}`, {
        title,
        notes: notes || null,
        dueDate: dueDate || null,
        status,
        ...(completionNote.trim() ? { completionNote: completionNote.trim() } : {}),
      });
      if (pendingFiles.length > 0) {
        try {
          await uploadPendingFiles(pendingFiles, "task", editingTask!.id);
        } catch {
          toast({ title: "Task updated but some files failed to upload", variant: "destructive" });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      if (editingTask?.companyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", editingTask.companyId] });
      }
      toast({ title: "Task updated" });
      onOpenChange(false);
    },
    onError: () => toast({ title: "Failed to update task", variant: "destructive" }),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (forwardingTask) {
      if (!assignedTo) return;
      createMutation.mutate();
    } else if (!title.trim()) {
      return;
    } else if (editingTask) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  const dataTypeOptions = [
    { value: "action_required", label: "Action Required Lanes" },
    { value: "facility_coverage", label: "Facility Coverage" },
    { value: "lane_patterns_shipping_receiving", label: "Shipping/Receiving Hubs" },
    { value: "lane_matching", label: "Lane Matching" },
  ];

  const showAttachSection = !editingTask && !prefillData && (effectiveCompanyId && effectiveCompanyId !== "none");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-task-dialog-title">
            {prefillData ? "Force Task from Lane" : forwardingTask ? "Forward Task" : editingTask ? "Edit Task" : "New Task"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Call JBS Foods about Q3 rates"
              required={!forwardingTask}
              disabled={!!forwardingTask}
              data-testid="input-task-title"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-notes">{forwardingTask ? "Additional Notes" : "Notes"}</Label>
            <Textarea
              id="task-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={forwardingTask ? "Add notes for the next person..." : "Additional details..."}
              rows={3}
              data-testid="input-task-notes"
            />
          </div>

          {!forwardingTask && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="task-due">Due Date</Label>
                  <Input
                    id="task-due"
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    data-testid="input-task-due-date"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={(v) => { setStatus(v); if (v !== "completed") setCompletionNote(""); }}>
                    <SelectTrigger data-testid="select-task-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {status === "completed" && editingTask && editingTask.status !== "completed" && editingTask.assignedBy !== user?.id && (
                <div className="space-y-2 rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-3">
                  <Label htmlFor="completion-note" className="text-green-800 dark:text-green-300 text-sm font-medium">
                    Reply to requester <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="completion-note"
                    value={completionNote}
                    onChange={e => setCompletionNote(e.target.value)}
                    placeholder="Let them know what you did, any notes, or next steps..."
                    rows={2}
                    data-testid="input-completion-note"
                  />
                  <p className="text-xs text-muted-foreground">This will be posted as a comment and included in the completion notification.</p>
                </div>
              )}
            </>
          )}

          {(!editingTask || forwardingTask) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Assign To</Label>
                {user && assignedTo !== user.id && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setAssignedTo(user.id)}
                    data-testid="button-assign-to-me"
                  >
                    Assign to Me
                  </button>
                )}
              </div>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger data-testid="select-task-assignee">
                  <SelectValue placeholder="Select person" />
                </SelectTrigger>
                <SelectContent>
                  {showGrouped ? (
                    <>
                      {assigneeGroups.admins.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Admins</SelectLabel>
                          {assigneeGroups.admins.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                        </SelectGroup>
                      )}
                      {assigneeGroups.directors.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Directors</SelectLabel>
                          {assigneeGroups.directors.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                        </SelectGroup>
                      )}
                      {assigneeGroups.nams.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>National Account Managers</SelectLabel>
                          {assigneeGroups.nams.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                        </SelectGroup>
                      )}
                      {assigneeGroups.ams.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Account Managers</SelectLabel>
                          {assigneeGroups.ams.map(u => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                        </SelectGroup>
                      )}
                    </>
                  ) : (
                    sortedMembers.map(u => (
                      <SelectItem key={u.id} value={u.id}>{u.name} ({u.role === "admin" ? "Admin" : u.role === "director" ? "Director" : u.role === "national_account_manager" ? "NAM" : u.role === "sales" ? "Sales" : "AM"})</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {!companyId && !editingTask && !forwardingTask && (
            <div className="space-y-2">
              <Label>Link to Account (optional)</Label>
              <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                <SelectTrigger data-testid="select-task-company">
                  <SelectValue placeholder="No account linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No account linked</SelectItem>
                  {companies.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {showAttachSection && !forwardingTask && (
            <div className="border rounded-lg">
              <button
                type="button"
                onClick={() => setAttachExpanded(!attachExpanded)}
                className="w-full flex items-center justify-between p-3 text-sm font-medium text-left hover:bg-muted/50 transition-colors"
                data-testid="button-toggle-attach-lane-data"
              >
                <span className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  Attach Lane Data
                  {selectedTypes.size > 0 && (
                    <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">{selectedTypes.size} selected</span>
                  )}
                </span>
                {attachExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
              {attachExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t pt-3">
                  {dataTypeOptions.map(opt => (
                    <div key={opt.value} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`attach-${opt.value}`}
                          checked={selectedTypes.has(opt.value)}
                          onCheckedChange={() => toggleType(opt.value)}
                          data-testid={`checkbox-attach-${opt.value}`}
                        />
                        <label htmlFor={`attach-${opt.value}`} className="text-sm cursor-pointer">{opt.label}</label>
                      </div>
                      {selectedTypes.has(opt.value) && (() => {
                        const snap = snapshotData.find(s => s.type === opt.value);
                        if (loadingSnapshot) return <p className="text-xs text-muted-foreground pl-6">Loading...</p>;
                        if (!snap || snap.items.length === 0) return <p className="text-xs text-muted-foreground pl-6">No data available</p>;
                        const sel = selectedItems[opt.value] || new Set();
                        return (
                          <div className="pl-6 space-y-1">
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              onClick={() => toggleAll(opt.value, snap.items)}
                              data-testid={`button-toggle-all-${opt.value}`}
                            >
                              {sel.size === snap.items.length ? "Deselect all" : `Select all (${snap.items.length})`}
                            </button>
                            <div className="max-h-32 overflow-y-auto space-y-0.5">
                              {snap.items.slice(0, 30).map((item: any, i: number) => (
                                <div key={i} className="flex items-center gap-2">
                                  <Checkbox
                                    checked={sel.has(i)}
                                    onCheckedChange={() => toggleItem(opt.value, i)}
                                    className="h-3 w-3"
                                    data-testid={`checkbox-item-${opt.value}-${i}`}
                                  />
                                  <span className="text-xs text-muted-foreground truncate">
                                    {item.lane || item.fullName || item.facility || item.customerLane || `Item ${i + 1}`}
                                    {item.volume ? ` (${item.volume.toLocaleString()} vol)` : ""}
                                    {item.customerVolume ? ` (${item.customerVolume.toLocaleString()} vol)` : ""}
                                  </span>
                                </div>
                              ))}
                              {snap.items.length > 30 && (
                                <p className="text-xs text-muted-foreground">+{snap.items.length - 30} more items</p>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {editingTask && Array.isArray(editingTask.attachedLaneData) && (() => {
            const procLanes = (editingTask.attachedLaneData as Array<Record<string, unknown>>).filter(
              (l): l is ProcurementLaneInfo =>
                l != null &&
                typeof l === "object" &&
                l.type === "carrier_procurement" &&
                typeof l.lane === "string" &&
                typeof l.awardId === "string"
            ) as ProcurementLaneInfo[];
            if (procLanes.length === 0) return null;
            return (
              <div className="border rounded-lg p-3" data-testid="section-procurement-workspace">
                <CarrierProcurementWorkspace
                  lanes={procLanes}
                  fallbackTaskId={editingTask.id}
                />
              </div>
            );
          })()}

          <FileAttachmentUpload
            pendingFiles={pendingFiles}
            onAdd={(files) => setPendingFiles(prev => [...prev, ...files])}
            onRemove={(i) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
            compact
          />

          {editingTask && (
            <FileAttachmentList entityType="task" entityIds={[editingTask.id]} />
          )}

          {editingTask && !forwardingTask && (
            <div className="space-y-3 pt-1" ref={commentsRef}>
              <Separator />
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <MessageSquare className="h-4 w-4" />
                Collaboration
                {comments.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5">{comments.length}</span>
                )}
              </div>

              {comments.length > 0 && (() => {
                const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                const topLevel = sorted.filter(c => !c.parentId);
                const repliesFor = (parentId: string) => sorted.filter(c => c.parentId === parentId);

                const renderComment = (comment: TaskComment, isReply = false) => {
                  const author = teamMembers.find(u => u.id === comment.authorId);
                  const initials = author?.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
                  const isOwn = comment.authorId === user?.id;
                  const canDelete = isOwn || user?.role === "admin";
                  const replies = repliesFor(comment.id);
                  return (
                    <div key={comment.id}>
                      <div className={`flex gap-2.5 group ${isReply ? "ml-8 mt-2" : ""}`}>
                        {isReply && <div className="w-px bg-border self-stretch shrink-0 -ml-5 mr-2.5" />}
                        <Avatar className="h-7 w-7 shrink-0 mt-0.5">
                          <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-xs font-semibold">{author?.name || "Unknown"}</span>
                            <span className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                            <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {!isReply && (
                                <button
                                  type="button"
                                  onClick={() => { setReplyToComment(comment); setCommentText(""); }}
                                  className="text-muted-foreground hover:text-primary flex items-center gap-1 text-xs"
                                  data-testid={`button-reply-comment-${comment.id}`}
                                >
                                  <Reply className="h-3 w-3" /> Reply
                                </button>
                              )}
                              {canDelete && (
                                <button
                                  type="button"
                                  onClick={() => deleteCommentMutation.mutate(comment.id)}
                                  className="text-muted-foreground hover:text-destructive"
                                  data-testid={`button-delete-comment-${comment.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-sm text-foreground mt-0.5 whitespace-pre-wrap break-words">{comment.content}</p>
                        </div>
                      </div>
                      {replies.map(r => renderComment(r, true))}
                    </div>
                  );
                };

                return (
                  <ScrollArea className="max-h-64 pr-1">
                    <div className="space-y-3">
                      {topLevel.map(c => renderComment(c))}
                    </div>
                  </ScrollArea>
                );
              })()}

              <div className="space-y-1.5">
                {replyToComment && (() => {
                  const replyAuthor = teamMembers.find(u => u.id === replyToComment.authorId);
                  const preview = replyToComment.content.length > 60 ? replyToComment.content.slice(0, 60) + "…" : replyToComment.content;
                  return (
                    <div className="flex items-start gap-2 rounded-md bg-muted/60 border-l-2 border-primary px-2.5 py-1.5 text-xs text-muted-foreground">
                      <Reply className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-semibold text-foreground">{replyAuthor?.name || "Unknown"}:</span> {preview}
                      </span>
                      <button type="button" onClick={() => setReplyToComment(null)} className="shrink-0 hover:text-foreground" data-testid="button-cancel-reply">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })()}
                <div className="flex gap-2">
                  <Textarea
                    placeholder={replyToComment ? "Write your reply…" : "Add a comment or update…"}
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentText.trim()) {
                        e.preventDefault();
                        addCommentMutation.mutate({ content: commentText, parentId: replyToComment?.id });
                      }
                    }}
                    className="min-h-[60px] text-sm resize-none"
                    data-testid="textarea-task-comment"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!commentText.trim() || addCommentMutation.isPending}
                    onClick={() => addCommentMutation.mutate({ content: commentText, parentId: replyToComment?.id })}
                    className="self-end"
                    data-testid="button-post-comment"
                >
                  {addCommentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">Ctrl+Enter to post</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-task-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || (forwardingTask ? !assignedTo : (!title.trim() || (!editingTask && !assignedTo)))} data-testid="button-task-save">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {prefillData ? "Create Task" : forwardingTask ? "Forward Task" : editingTask ? "Save Changes" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
