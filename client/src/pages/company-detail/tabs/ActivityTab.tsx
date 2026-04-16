import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneCall, Mail, MessageSquare, Building2, ClipboardList, Activity,
  Megaphone, ChevronDown, Trash2, Plus, Calendar, CheckCircle2,
  PlayCircle, Circle, Video,
} from "lucide-react";
import type { Callout, CalloutReaction, Contact, Touchpoint, User } from "@shared/schema";
import type { TouchLogEntry, TaskWithCount } from "../types";
import { formatTimeAgo } from "@/lib/utils";

const REACTION_EMOJIS = ["👍", "❤️", "🔥", "💡", "✅"];

const CALLOUT_TAG_COLORS: Record<string, string> = {
  win:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  risk:      "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  intel:     "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  followup:  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  idea:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
};

function formatCalloutTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return ""; }
}

interface ActivityTabProps {
  touchLogEntries: TouchLogEntry[];
  companyTasks: TaskWithCount[];
  teamMembers: Omit<User, "password">[];
  topLevelCompanyCallouts: Callout[];
  companyCalloutRepliesFor: (parentId: string) => Callout[];
  calloutReactions: CalloutReaction[];
  canReact: boolean;
  expandedCallouts: Set<string>;
  toggleCalloutExpanded: (id: string) => void;
  setCalloutReplyTo: (v: { id: string; title: string } | undefined) => void;
  setCalloutDialogOpen: (v: boolean) => void;
  setSelectedTouchpoint: (v: (Touchpoint & { loggedByName: string; contactName: string | null }) | null) => void;
  touchLogCollapsed: boolean;
  setTouchLogCollapsed: (updater: boolean | ((prev: boolean) => boolean)) => void;
  deleteCalloutMutation: { mutate: (id: string) => void; isPending: boolean };
  deleteTouchpointMutation?: { mutate: (id: string) => void; isPending: boolean };
  toggleReactionMutation: { mutate: (v: { calloutId: string; emoji: string }) => void; isPending: boolean };
  toggleTaskStatus: { mutate: (v: { id: string; status: string }) => void; isPending: boolean };
  deleteTaskMutation: { mutate: (id: string) => void; isPending: boolean };
  currentUser: Omit<User, "password"> | null | undefined;
  setConfirmDeleteCalloutId: (v: string | null) => void;
  setTaskDialogOpen: (v: boolean) => void;
  setEditingTaskItem: (v: TaskWithCount | undefined) => void;
  setForceLanePrefill: (v: { title: string; notes?: string; attachedLaneData?: any[] } | undefined) => void;
  setFocusTaskComments: (v: boolean) => void;
}

export function ActivityTab({
  touchLogEntries,
  companyTasks,
  teamMembers,
  topLevelCompanyCallouts,
  companyCalloutRepliesFor,
  calloutReactions,
  canReact,
  expandedCallouts,
  toggleCalloutExpanded,
  setCalloutReplyTo,
  setCalloutDialogOpen,
  setSelectedTouchpoint,
  touchLogCollapsed,
  setTouchLogCollapsed,
  deleteCalloutMutation,
  deleteTouchpointMutation,
  toggleReactionMutation,
  toggleTaskStatus,
  deleteTaskMutation,
  currentUser,
  setConfirmDeleteCalloutId,
  setTaskDialogOpen,
  setEditingTaskItem,
  setForceLanePrefill,
  setFocusTaskComments,
}: ActivityTabProps) {
  const getCalloutAuthorName = (authorId: string) =>
    teamMembers.find(u => u.id === authorId)?.name || "Unknown";

  const TYPE_COLORS: Record<string, string> = {
    call:       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    email:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    text:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    task:       "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  };
  const TYPE_LABELS: Record<string, string> = {
    call: "Call", email: "Email", text: "Text", site_visit: "Site Visit", task: "Task",
  };
  const TYPE_ICONS: Record<string, typeof PhoneCall> = {
    call: PhoneCall, email: Mail, text: MessageSquare, site_visit: Building2, task: ClipboardList,
  };

  type TimelineItem = {
    id: string;
    sortKey: string;
    type: string;
    label: string;
    subLabel?: string;
    notes?: string;
    who?: string;
    status?: string;
    webexSynced?: boolean;
  };

  const isWebexSyncedNote = (notes: string | null | undefined): boolean =>
    !!notes && /\[Webex CDR:\s*[^\]]+\]/.test(notes);

  const parseEmailNotes = (notes: string | null | undefined) => {
    if (!notes) return { subject: null, to: null, body: notes ?? undefined };
    const lines = notes.split("\n");
    const subjectLine = lines.find(l => l.startsWith("Subject: "));
    const toLine = lines.find(l => l.startsWith("To: "));
    const subject = subjectLine ? subjectLine.replace("Subject: ", "") : null;
    const to = toLine ? toLine.replace("To: ", "") : null;
    const bodyStart = lines.findIndex((l, i) => i > 0 && !l.startsWith("Subject: ") && !l.startsWith("To: ") && l.trim() !== "");
    const body = bodyStart !== -1 ? lines.slice(bodyStart).join("\n").trim() : undefined;
    return { subject, to, body };
  };

  const tpItems: TimelineItem[] = touchLogEntries.map(tp => {
    const isEmail = tp.type === "email";
    const parsed = isEmail ? parseEmailNotes(tp.notes) : null;
    return {
      id: `tp-${tp.id}`,
      sortKey: tp.createdAt || tp.date,
      type: tp.type,
      label: isEmail && parsed?.subject ? parsed.subject : (tp.contactName ?? "Company touch"),
      subLabel: tp.isMeaningful ? "Meaningful" : (isEmail && parsed?.to ? `To: ${parsed.to}` : undefined),
      notes: isEmail ? (parsed?.body ?? undefined) : (tp.notes ?? undefined),
      who: tp.loggedByName,
      webexSynced: tp.type === "call" && isWebexSyncedNote(tp.notes),
    };
  });

  const taskItems: TimelineItem[] = companyTasks
    .filter(t => t.status === "completed" || t.dueDate)
    .map(t => ({
      id: `task-${t.id}`,
      sortKey: t.dueDate ? t.dueDate + "T00:00:00" : "",
      type: "task",
      label: t.title,
      status: t.status,
      who: teamMembers.find(u => u.id === t.assignedTo)?.name,
    }));

  const all = [...tpItems, ...taskItems]
    .filter(i => i.sortKey)
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .slice(0, 20);


  const VIBE_COLORS: Record<string, string> = {
    great:   "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    neutral: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    cold:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  };

  return (
    <>
      {/* ── Unified Activity Timeline ──────────────────────────────────────── */}
      {all.length > 0 && (
        <Card data-testid="card-activity-timeline">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4 text-violet-500" />
              Activity Timeline
              <Badge variant="secondary" className="ml-1 font-normal">{all.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="relative">
              <div className="absolute left-[17px] top-0 bottom-0 w-px bg-border" />
              <div className="space-y-0">
                {all.map(item => {
                  const Icon = TYPE_ICONS[item.type] ?? ClipboardList;
                  const colorClass = TYPE_COLORS[item.type] ?? "bg-muted text-muted-foreground";
                  return (
                    <div key={item.id} className="flex items-start gap-3 py-2.5 pl-1" data-testid={`timeline-item-${item.id}`}>
                      <div className={`relative z-10 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${colorClass} border-2 border-background`}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-medium text-foreground">{item.label}</span>
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded text-muted-foreground bg-muted">
                            {TYPE_LABELS[item.type] ?? item.type}
                          </span>
                          {item.subLabel && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">{item.subLabel}</span>
                          )}
                          {item.status === "completed" && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">Done</span>
                          )}
                          {item.webexSynced && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                              title={item.who ? `Synced from ${item.who}'s Webex account` : "Synced from Webex"}
                              data-testid={`badge-webex-synced-${item.id}`}
                            >
                              <Video className="h-2.5 w-2.5" />
                              Webex
                            </span>
                          )}
                        </div>
                        {item.notes && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.notes}</p>
                        )}
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {item.who && <span>{item.who} · </span>}
                          {formatTimeAgo(item.sortKey)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Account Tasks */}
      <Card data-testid="card-company-tasks">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Tasks
              {companyTasks.filter(t => t.status !== "completed").length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{companyTasks.filter(t => t.status !== "completed").length}</Badge>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => { setEditingTaskItem(undefined); setForceLanePrefill(undefined); setTaskDialogOpen(true); }} data-testid="button-add-company-task">
              <Plus className="h-3 w-3" /> Add Task
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {companyTasks.length > 0 ? (
            <div className="space-y-1">
              {companyTasks
                .sort((a, b) => {
                  if (a.status === "completed" && b.status !== "completed") return 1;
                  if (a.status !== "completed" && b.status === "completed") return -1;
                  if (!a.dueDate && !b.dueDate) return 0;
                  if (!a.dueDate) return 1;
                  if (!b.dueDate) return -1;
                  return a.dueDate.localeCompare(b.dueDate);
                })
                .map(task => {
                  const assigneeName = teamMembers.find(u => u.id === task.assignedTo)?.name || "";
                  const ns = task.status === "open" ? "in_progress" : task.status === "in_progress" ? "completed" : "open";
                  const dueBadge = (() => {
                    if (!task.dueDate) return null;
                    const today = new Date(); today.setHours(0,0,0,0);
                    const due = new Date(task.dueDate + "T00:00:00");
                    const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
                    let color = "bg-muted text-muted-foreground";
                    if (diff < 0) color = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
                    else if (diff === 0) color = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
                    const label = diff < 0 ? `${Math.abs(diff)}d overdue` : diff === 0 ? "Today" : `${diff}d`;
                    return <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium ${color}`}><Calendar className="h-3 w-3" />{label}</span>;
                  })();
                  return (
                    <div key={task.id} className={`flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${task.status === "completed" ? "opacity-50" : ""}`} data-testid={`company-task-row-${task.id}`}>
                      <button onClick={() => toggleTaskStatus.mutate({ id: task.id, status: ns })} className="shrink-0 hover:scale-110 transition-transform" title={`Status: ${task.status}`} data-testid={`button-toggle-company-task-${task.id}`}>
                        {task.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : task.status === "in_progress" ? <PlayCircle className="h-4 w-4 text-blue-500" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`}>{task.title}</p>
                        {assigneeName && <p className="text-xs text-muted-foreground">{assigneeName}</p>}
                      </div>
                      {dueBadge}
                      {(task.commentCount ?? 0) > 0 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingTaskItem(task); setForceLanePrefill(undefined); setFocusTaskComments(true); setTaskDialogOpen(true); }}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary shrink-0 transition-colors"
                          title="View collaboration notes"
                          data-testid={`badge-task-comments-${task.id}`}
                        >
                          <MessageSquare className="h-3 w-3" />
                          {task.commentCount}
                        </button>
                      )}
                      <button onClick={() => { setEditingTaskItem(task); setForceLanePrefill(undefined); setFocusTaskComments(false); setTaskDialogOpen(true); }} className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs" data-testid={`button-edit-company-task-${task.id}`}>Edit</button>
                      <button onClick={() => deleteTaskMutation.mutate(task.id)} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-company-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <ClipboardList className="h-6 w-6 mx-auto mb-1 opacity-50" />
              <p className="text-xs mb-2">No tasks yet</p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs h-7"
                onClick={() => { setEditingTaskItem(undefined); setForceLanePrefill(undefined); setFocusTaskComments(false); setTaskDialogOpen(true); }}
                data-testid="button-create-first-company-task"
              >
                <Plus className="h-3 w-3" /> Add a task
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Account Callouts */}
      <Card data-testid="card-company-callouts">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              Callouts
              {topLevelCompanyCallouts.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{topLevelCompanyCallouts.length}</Badge>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => { setCalloutReplyTo(undefined); setCalloutDialogOpen(true); }} data-testid="button-add-company-callout">
              <Plus className="h-3 w-3" /> Add Callout
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {topLevelCompanyCallouts.length > 0 ? (
            <div className="space-y-1">
              {topLevelCompanyCallouts.map(callout => {
                const replies = companyCalloutRepliesFor(callout.id);
                const isExpanded = expandedCallouts.has(callout.id);
                return (
                  <div key={callout.id} data-testid={`company-callout-row-${callout.id}`}>
                    <div className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group">
                      <Megaphone className="h-4 w-4 mt-0.5 text-orange-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium">{callout.title}</p>
                          {callout.tag && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${CALLOUT_TAG_COLORS[callout.tag] || "bg-muted text-muted-foreground"}`}>
                              {callout.tag}
                            </span>
                          )}
                        </div>
                        {callout.body && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{callout.body}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-muted-foreground">{getCalloutAuthorName(callout.authorId)}</span>
                          <span className="text-xs text-muted-foreground/50">·</span>
                          <span className="text-xs text-muted-foreground">{formatCalloutTime(callout.createdAt)}</span>
                        </div>
                        {(() => {
                          const thisReactions = calloutReactions.filter(r => r.calloutId === callout.id);
                          const emojiCounts = REACTION_EMOJIS.map(emoji => ({
                            emoji,
                            count: thisReactions.filter(r => r.emoji === emoji).length,
                            reacted: thisReactions.some(r => r.emoji === emoji && r.userId === currentUser?.id),
                          }));
                          const hasAny = emojiCounts.some(e => e.count > 0);
                          if (!canReact && !hasAny) return null;
                          return (
                            <div className="flex items-center gap-1 mt-2 flex-wrap" data-testid={`reactions-bar-${callout.id}`}>
                              {emojiCounts.map(({ emoji, count, reacted }) => {
                                if (!canReact && count === 0) return null;
                                return (
                                  <button
                                    key={emoji}
                                    onClick={canReact ? () => toggleReactionMutation.mutate({ calloutId: callout.id, emoji }) : undefined}
                                    disabled={!canReact || toggleReactionMutation.isPending}
                                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border transition-all ${
                                      reacted
                                        ? "bg-primary/10 border-primary/30 text-primary"
                                        : count > 0
                                          ? "bg-muted/50 border-border text-muted-foreground"
                                          : "bg-transparent border-transparent text-muted-foreground/50 hover:bg-muted/50 hover:border-border"
                                    } ${canReact ? "cursor-pointer hover:scale-105" : "cursor-default"}`}
                                    data-testid={`button-reaction-${emoji}-${callout.id}`}
                                  >
                                    <span>{emoji}</span>
                                    {count > 0 && <span className="font-medium">{count}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {replies.length > 0 && (
                          <button
                            onClick={() => toggleCalloutExpanded(callout.id)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                            data-testid={`button-toggle-company-callout-replies-${callout.id}`}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {replies.length}
                            <ChevronDown className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </button>
                        )}
                        <button
                          onClick={() => { setCalloutReplyTo({ id: callout.id, title: callout.title }); setCalloutDialogOpen(true); }}
                          className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1"
                          data-testid={`button-reply-company-callout-${callout.id}`}
                        >
                          Reply
                        </button>
                        {(callout.authorId === currentUser?.id || currentUser?.role === "admin") && (
                          <button
                            onClick={() => setConfirmDeleteCalloutId(callout.id)}
                            className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            data-testid={`button-delete-company-callout-${callout.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && replies.length > 0 && (
                      <div className="ml-7 pl-3 border-l-2 border-muted space-y-1 mb-2">
                        {replies.map(reply => (
                          <div key={reply.id} className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/30 transition-all group/reply" data-testid={`company-callout-reply-${reply.id}`}>
                            <MessageSquare className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium">{reply.title}</p>
                              {reply.body && <p className="text-xs text-muted-foreground mt-0.5">{reply.body}</p>}
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-muted-foreground">{getCalloutAuthorName(reply.authorId)}</span>
                                <span className="text-xs text-muted-foreground/50">·</span>
                                <span className="text-xs text-muted-foreground">{formatCalloutTime(reply.createdAt)}</span>
                              </div>
                            </div>
                            {(reply.authorId === currentUser?.id || currentUser?.role === "admin") && (
                              <button
                                onClick={() => setConfirmDeleteCalloutId(reply.id)}
                                className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/reply:opacity-100 transition-opacity"
                                data-testid={`button-delete-company-callout-reply-${reply.id}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Megaphone className="h-6 w-6 mx-auto mb-1 opacity-50" />
              <p className="text-xs">No callouts yet — add one to share trends or ideas about this account</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Touch Log ─────────────────────────────────────────────── */}
      {(() => {
        const TL_TYPE_ICONS: Record<string, typeof PhoneCall> = { call: PhoneCall, email: Mail, text: MessageSquare, site_visit: Building2 };
        const TL_TYPE_LABELS: Record<string, string> = { call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" };
        const TL_TYPE_COLORS: Record<string, string> = {
          call:       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
          email:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
          text:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
          site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        };
        return (
          <Card data-testid="card-touch-log">
            <CardHeader className="pb-3">
              <button
                onClick={() => setTouchLogCollapsed(c => !c)}
                className="w-full flex items-center justify-between group"
                data-testid="btn-toggle-touch-log"
              >
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Activity className="h-4 w-4 text-cyan-500" />
                  Touch Log
                  <Badge variant="secondary" className="ml-1 font-normal">{touchLogEntries.length}</Badge>
                </CardTitle>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${touchLogCollapsed ? "-rotate-90" : ""}`} />
              </button>
            </CardHeader>
            {!touchLogCollapsed && (
              <CardContent className="pt-0">
                {touchLogEntries.length === 0 ? (
                  <div className="py-6 text-center space-y-2">
                    <PhoneCall className="h-8 w-8 mx-auto text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">No touches logged yet</p>
                    <p className="text-xs text-muted-foreground">Use the "Log Touch" button in the header to record touchpoints.</p>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {touchLogEntries.map((tp) => {
                      const TypeIcon = TL_TYPE_ICONS[tp.type] ?? PhoneCall;
                      const isEmail = tp.type === "email";
                      let emailSubjectLine = "";
                      let emailToLine = "";
                      let emailBodyPreview = tp.notes || "";
                      if (isEmail && tp.notes) {
                        const lines = tp.notes.split("\n");
                        const sl = lines.find(l => l.startsWith("Subject: "));
                        const tl = lines.find(l => l.startsWith("To: "));
                        if (sl) emailSubjectLine = sl.replace("Subject: ", "");
                        if (tl) emailToLine = tl.replace("To: ", "");
                        const bodyStart = lines.findIndex((l, i) => i > 0 && !l.startsWith("Subject: ") && !l.startsWith("To: ") && l.trim() !== "");
                        emailBodyPreview = bodyStart !== -1 ? lines.slice(bodyStart).join(" ").trim() : "";
                      }
                      return (
                        <div
                          key={tp.id}
                          className={`group flex items-start gap-3 py-2 border-b last:border-0 cursor-pointer hover:bg-muted/40 rounded px-1 -mx-1 transition-colors ${isEmail ? "bg-blue-50/40 dark:bg-blue-950/10" : ""}`}
                          onClick={() => setSelectedTouchpoint(tp)}
                          data-testid={`touch-log-row-${tp.id}`}
                        >
                          <div className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${TL_TYPE_COLORS[tp.type] ?? "bg-muted text-muted-foreground"}`}>
                            <TypeIcon className="h-3 w-3" />
                            {TL_TYPE_LABELS[tp.type] ?? tp.type}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {isEmail && emailSubjectLine ? (
                                <span className="text-xs font-semibold text-foreground truncate max-w-[200px]" data-testid={`touch-log-email-subject-${tp.id}`}>{emailSubjectLine}</span>
                              ) : tp.contactName ? (
                                <span className="text-xs font-medium text-foreground">{tp.contactName}</span>
                              ) : null}
                              {tp.sentiment && (
                                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${VIBE_COLORS[tp.sentiment] ?? "bg-muted text-muted-foreground"}`} data-testid={`touch-log-vibe-${tp.id}`}>
                                  {tp.sentiment.charAt(0).toUpperCase() + tp.sentiment.slice(1)}
                                </span>
                              )}
                              {tp.isMeaningful && (
                                <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" data-testid={`touch-log-meaningful-${tp.id}`}>
                                  Meaningful
                                </span>
                              )}
                            </div>
                            {isEmail && emailToLine && (
                              <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-0.5 flex items-center gap-0.5" data-testid={`touch-log-email-to-${tp.id}`}>
                                <Mail className="h-2.5 w-2.5 shrink-0" />To: {emailToLine}
                              </p>
                            )}
                            {isEmail ? (
                              emailBodyPreview && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1" data-testid={`touch-log-notes-${tp.id}`}>{emailBodyPreview}</p>
                            ) : tp.notes ? (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2" data-testid={`touch-log-notes-${tp.id}`}>{tp.notes}</p>
                            ) : null}
                            <p className="text-xs text-muted-foreground mt-1">
                              {tp.loggedByName} · {formatTimeAgo(tp.createdAt || tp.date)}
                            </p>
                          </div>
                          {deleteTouchpointMutation && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm("Delete this touchpoint? This cannot be undone.")) {
                                  deleteTouchpointMutation.mutate(tp.id);
                                }
                              }}
                              disabled={deleteTouchpointMutation.isPending}
                              className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                              data-testid={`button-delete-touchpoint-${tp.id}`}
                              title="Delete touchpoint"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        );
      })()}
    </>
  );
}
