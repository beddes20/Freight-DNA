import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Users, Plus, CheckCircle2, Circle, Trash2, ChevronDown, ChevronUp,
  Archive, RotateCcw, MessageSquare, CalendarDays, AlertCircle,
  StickyNote, ClipboardList, CornerDownRight, CalendarClock, Pencil, X,
  BarChart2, Phone, Mail, MessageCircle, MapPin, Target, CheckCheck, Clock,
  Video, ExternalLink, Link,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import type { OneOnOneSession, OneOnOneTopic, OneOnOneTopicReply, User } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";

type SafeUser = Omit<User, "password">;


const TAG_CONFIG: Record<string, { label: string; color: string }> = {
  action_item:   { label: "Action Item",   color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  question:      { label: "Question",      color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  fyi:           { label: "FYI",           color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  follow_up:     { label: "Follow-up",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  shoutout:      { label: "Shoutout",      color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  lets_work_on:  { label: "Let's Work On", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400" },
  career:        { label: "Career",        color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  // Legacy human-readable aliases (from dashboard portlet)
  "Action Item":   { label: "Action Item",   color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  "Question":      { label: "Question",      color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  "FYI":           { label: "FYI",           color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  "Follow-up":     { label: "Follow-up",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  "Shoutout":      { label: "Shoutout",      color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  "Let's Work On": { label: "Let's Work On", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400" },
  "Career":        { label: "Career",        color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function avatarColor(name: string) {
  const colors = [
    "bg-blue-500", "bg-indigo-500", "bg-purple-500", "bg-pink-500",
    "bg-green-500", "bg-teal-500", "bg-orange-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function initials(name: string) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

// ─── Report Card types ────────────────────────────────────────────────────────

interface RepReportData {
  rep: { id: string; name: string; role: string };
  period: { type: string; label: string; start: string; end: string };
  goals: Array<{ id: string; label: string; metric: string; current: number; target: number; pct: number }>;
  touchpoints: { total: number; call: number; email: number; text: number; site_visit: number; meaningful?: number };
  contacts: { newThisPeriod: number };
  tasks: { completed: number; open: number; overdue: number };
  topAccounts: Array<{ name: string; touches: number; lastTouch: string }>;
  accountsNeedingAttention: number;
}

function ReportCardSlice({ data, label }: { data: RepReportData; label: string }) {
  const tp = data.touchpoints;
  const tasks = data.tasks;
  const pctColor = (p: number) => p >= 80 ? "bg-green-500" : p >= 50 ? "bg-amber-400" : "bg-red-400";

  return (
    <div className="flex-1 min-w-0 space-y-3">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</div>

      {/* Touchpoints row */}
      <div className="bg-muted/40 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Touchpoints</span>
          <div className="flex items-center gap-2">
            {tp.meaningful != null && tp.meaningful > 0 && (
              <span className="text-xs text-purple-600 dark:text-purple-400 font-medium bg-purple-50 dark:bg-purple-950/40 px-1.5 py-0.5 rounded">
                {tp.meaningful} meaningful
              </span>
            )}
            <span className="text-lg font-bold text-indigo-600 dark:text-indigo-400">{tp.total}</span>
          </div>
        </div>
        <div className="flex gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{tp.call}</span>
          <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{tp.email}</span>
          <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" />{tp.text}</span>
          <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{tp.site_visit}</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-muted/40 rounded-lg p-2.5 text-center">
          <div className="text-xs text-muted-foreground mb-0.5">New Contacts</div>
          <div className="text-base font-bold text-green-600 dark:text-green-400">{data.contacts.newThisPeriod}</div>
        </div>
        <div className="bg-muted/40 rounded-lg p-2.5 text-center">
          <div className="text-xs text-muted-foreground mb-0.5">Tasks Done</div>
          <div className="text-base font-bold text-blue-600 dark:text-blue-400">{tasks.completed}</div>
        </div>
        <div className={`rounded-lg p-2.5 text-center ${tasks.overdue > 0 ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/40"}`}>
          <div className="text-xs text-muted-foreground mb-0.5">Overdue</div>
          <div className={`text-base font-bold ${tasks.overdue > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{tasks.overdue}</div>
        </div>
      </div>

      {/* Needs attention */}
      {data.accountsNeedingAttention > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-lg px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {data.accountsNeedingAttention} account{data.accountsNeedingAttention !== 1 ? "s" : ""} needing attention
        </div>
      )}

      {/* Goals */}
      {data.goals.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Target className="h-3 w-3" />Goals</div>
          {data.goals.map(g => (
            <div key={g.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-foreground">{g.label}</span>
                <span className="text-muted-foreground ml-2 shrink-0">{g.current}/{g.target} <span className="font-semibold">{g.pct}%</span></span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div className={`h-1.5 rounded-full ${pctColor(g.pct)}`} style={{ width: `${Math.min(100, g.pct)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Session Notes (auto-saving) ──────────────────────────────────────────────

function SessionNotesArea({ sessionId, initialNotes, sessionQueryKey }: { sessionId: string; initialNotes: string; sessionQueryKey: (string | undefined)[] }) {
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNotes(initialNotes);
  }, [initialNotes, sessionId]);

  const saveNotes = useCallback(async (value: string) => {
    setSaving(true);
    setSaveError(false);
    try {
      await apiRequest("PATCH", `/api/1on1/session/${sessionId}/notes`, { notes: value });
      queryClient.setQueryData<{ session: OneOnOneSession; topics: OneOnOneTopic[] }>(sessionQueryKey, (old) => {
        if (!old) return old;
        return { ...old, session: { ...old.session, notes: value } };
      });
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }, [sessionId, sessionQueryKey]);

  const latestNotesRef = useRef(initialNotes);

  const handleChange = (value: string) => {
    setNotes(value);
    latestNotesRef.current = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => saveNotes(value), 800);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        saveNotes(latestNotesRef.current);
      }
    };
  }, [saveNotes]);

  return (
    <div className="px-6 py-4 border-b">
      <div className="flex items-center gap-2 mb-2">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Session Notes</span>
        {saving && <span className="text-xs text-muted-foreground italic">Saving...</span>}
        {saveError && <span className="text-xs text-destructive">Failed to save</span>}
      </div>
      <Textarea
        placeholder="Jot down thoughts, key takeaways, or anything to remember..."
        value={notes}
        onChange={e => handleChange(e.target.value)}
        className="min-h-[80px] resize-y text-sm"
        data-testid="textarea-session-notes"
      />
    </div>
  );
}

// ─── Development Goals Panel ─────────────────────────────────────────────────

function DevelopmentGoalsPanel({ managerId, repId }: { managerId: string; repId: string }) {
  const devGoalsKey = ["/api/1on1/dev-goals", managerId, repId];
  const { data, isLoading } = useQuery<{ content: string; updatedAt: string | null }>({
    queryKey: devGoalsKey,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/dev-goals?namId=${managerId}&amId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef("");

  useEffect(() => {
    if (data?.content !== undefined) {
      setContent(data.content);
      latestRef.current = data.content;
    }
  }, [data?.content]);

  const save = useCallback(async (value: string) => {
    setSaving(true);
    setSaveError(false);
    try {
      await apiRequest("PATCH", `/api/1on1/dev-goals?namId=${managerId}&amId=${repId}`, { content: value });
      queryClient.invalidateQueries({ queryKey: devGoalsKey });
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }, [managerId, repId, devGoalsKey]);

  const handleChange = (value: string) => {
    setContent(value);
    latestRef.current = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(value), 800);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        save(latestRef.current);
      }
    };
  }, [save]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3" data-testid="panel-dev-goals">
      <div className="flex items-center gap-2 mb-1">
        <Target className="h-4 w-4 text-indigo-500" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Development Goals</span>
        {saving && <span className="text-xs text-muted-foreground italic">Saving...</span>}
        {saveError && <span className="text-xs text-destructive">Failed to save</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Long-term development goals for this pairing. These persist across sessions and are only visible in the 1:1 context.
      </p>
      <Textarea
        placeholder="Document long-term career and development goals here — areas of growth, skills to develop, milestones to track..."
        value={content}
        onChange={e => handleChange(e.target.value)}
        className="min-h-[200px] resize-y text-sm"
        data-testid="textarea-dev-goals"
      />
      {data?.updatedAt && (
        <p className="text-xs text-muted-foreground">Last updated {new Date(data.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
      )}
    </div>
  );
}

// ─── Action Items Panel ───────────────────────────────────────────────────────

interface ActionItemsPanelProps {
  managerId: string;
  repId: string;
  allUsers: SafeUser[];
}

function ActionItemsPanel({ managerId, repId, allUsers }: ActionItemsPanelProps) {
  const actionItemsKey = ["/api/1on1/action-items", managerId, repId];
  const { data: actionData = [], isLoading } = useQuery<{ session: OneOnOneSession; topics: OneOnOneTopic[] }[]>({
    queryKey: actionItemsKey,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/action-items?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const sessionKey = ["/api/1on1/session", managerId, repId];
  const overviewKey = ["/api/1on1/manager-overview", managerId];

  const toggleMutation = useMutation({
    mutationFn: async ({ topicId, status }: { topicId: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/1on1/topics/${topicId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: actionItemsKey });
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
    },
  });

  const getUserName = (id: string) => allUsers.find(u => u.id === id)?.name || "Unknown";

  const totalOpen = actionData.reduce((sum, group) => sum + group.topics.filter(t => t.status === "pending").length, 0);
  const totalCompleted = actionData.reduce((sum, group) => sum + group.topics.filter(t => t.status === "discussed").length, 0);

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <AlertCircle className="h-4 w-4 text-orange-500" />
          <span className="font-medium">{totalOpen} open</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span>{totalCompleted} completed</span>
        </div>
      </div>

      {actionData.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          <ClipboardList className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-base font-medium" data-testid="text-no-action-items">No action items yet</p>
          <p className="text-sm mt-1">Action items added in sessions will appear here</p>
        </div>
      ) : (
        <div className="px-6 py-4 space-y-5">
          {actionData.map(({ session, topics }) => (
            <div key={session.id}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-2">
                {formatDate(session.startDate)}
                {session.status === "active" && (
                  <Badge variant="secondary" className="ml-2 text-xs">Current</Badge>
                )}
              </p>
              <div className="space-y-1.5">
                {topics.map(topic => {
                  const isComplete = topic.status === "discussed";
                  return (
                    <div
                      key={topic.id}
                      className={`flex items-start gap-3 p-3 rounded-xl border border-transparent hover:border-border hover:bg-muted/30 transition-all ${isComplete ? "opacity-60" : ""}`}
                      data-testid={`action-item-${topic.id}`}
                    >
                      <button
                        onClick={() => toggleMutation.mutate({
                          topicId: topic.id,
                          status: isComplete ? "pending" : "discussed",
                        })}
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                        data-testid={`btn-toggle-action-${topic.id}`}
                      >
                        {isComplete
                          ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                          : <Circle className="h-5 w-5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${isComplete ? "line-through text-muted-foreground" : "text-foreground"}`}>{topic.text}</p>
                        <span className="text-xs text-muted-foreground mt-1 block">Added by {getUserName(topic.addedById)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Session Panel ────────────────────────────────────────────────────────────

interface SessionPanelProps {
  managerId: string;
  repId: string;
  currentUserId: string;
  allUsers: SafeUser[];
}

function SessionPanel({ managerId, repId, currentUserId, allUsers }: SessionPanelProps) {
  const { toast } = useToast();
  const [newText, setNewText] = useState("");
  const [newTag, setNewTag] = useState("fyi");
  const [showArchived, setShowArchived] = useState(false);
  const [activeTab, setActiveTab] = useState<"topics" | "action-items" | "dev-goals">("topics");
  const [topicPendingFiles, setTopicPendingFiles] = useState<PendingFile[]>([]);
  const [editingDate, setEditingDate] = useState(false);
  const [dateInput, setDateInput] = useState("");
  const [editingLink, setEditingLink] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const linkCancelledRef = useRef(false);
  const [showReport, setShowReport] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<"weekly" | "monthly" | "both">("weekly");

  const weeklyReportKey = ["/api/report/rep", repId, "weekly"];
  const monthlyReportKey = ["/api/report/rep", repId, "monthly"];

  const { data: weeklyReport, isLoading: weeklyLoading } = useQuery<RepReportData>({
    queryKey: weeklyReportKey,
    queryFn: async () => {
      const res = await fetch(`/api/report/rep/${repId}?period=weekly`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.payload ?? json;
    },
    enabled: showReport && (reportPeriod === "weekly" || reportPeriod === "both"),
  });

  const { data: monthlyReport, isLoading: monthlyLoading } = useQuery<RepReportData>({
    queryKey: monthlyReportKey,
    queryFn: async () => {
      const res = await fetch(`/api/report/rep/${repId}?period=monthly`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.payload ?? json;
    },
    enabled: showReport && (reportPeriod === "monthly" || reportPeriod === "both"),
  });

  const sessionKey = ["/api/1on1/session", managerId, repId];
  const { data, isLoading } = useQuery<{ session: OneOnOneSession; topics: OneOnOneTopic[] }>({
    queryKey: sessionKey,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/session?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const archivedKey = ["/api/1on1/archived", managerId, repId];
  const { data: archivedSessions = [], isLoading: archivedLoading } = useQuery<(OneOnOneSession & { topics: OneOnOneTopic[] })[]>({
    queryKey: archivedKey,
    enabled: showArchived,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/archived?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const overviewKey = ["/api/1on1/manager-overview", managerId];

  const actionItemsKey = ["/api/1on1/action-items", managerId, repId];

  const addTopicMutation = useMutation({
    mutationFn: async ({ sessionId, text, tag }: { sessionId: string; text: string; tag: string }) => {
      const res = await apiRequest("POST", `/api/1on1/session/${sessionId}/topics`, { text, tag });
      const topic = await res.json();
      if (topicPendingFiles.length > 0) {
        try {
          await uploadPendingFiles(topicPendingFiles, "one_on_one_topic", topic.id);
        } catch {
          toast({ title: "Topic created but some files failed to upload", variant: "destructive" });
        }
      }
      return topic;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
      queryClient.invalidateQueries({ queryKey: actionItemsKey });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setNewText("");
      setTopicPendingFiles([]);
    },
    onError: () => toast({ title: "Failed to add topic", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ topicId, status }: { topicId: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/1on1/topics/${topicId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
      queryClient.invalidateQueries({ queryKey: actionItemsKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (topicId: string) => {
      await apiRequest("DELETE", `/api/1on1/topics/${topicId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
      queryClient.invalidateQueries({ queryKey: actionItemsKey });
      toast({ title: "Topic removed" });
    },
  });

  const closeMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("POST", `/api/1on1/session/${sessionId}/close`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: archivedKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
      queryClient.invalidateQueries({ queryKey: actionItemsKey });
      toast({ title: "Session closed", description: "Unresolved topics carried over." });
    },
    onError: () => toast({ title: "Failed to close session", variant: "destructive" }),
  });

  const meetingDateMutation = useMutation({
    mutationFn: async ({ sessionId, meetingDate }: { sessionId: string; meetingDate: string | null }) => {
      const res = await apiRequest("PATCH", `/api/1on1/session/${sessionId}/meeting-date`, { meetingDate });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      setEditingDate(false);
      toast({ title: "Meeting date saved", description: "Both participants will get daily reminders leading up to the meeting." });
    },
    onError: () => toast({ title: "Failed to save meeting date", variant: "destructive" }),
  });

  const meetingLinkMutation = useMutation({
    mutationFn: async ({ sessionId, meetingLink }: { sessionId: string; meetingLink: string | null }) => {
      const res = await apiRequest("PATCH", `/api/1on1/session/${sessionId}/meeting-link`, { meetingLink });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      setEditingLink(false);
      toast({ title: "Meeting link saved" });
    },
    onError: () => toast({ title: "Failed to save meeting link", variant: "destructive" }),
  });
  const { data: actionItemData = [] } = useQuery<{ session: OneOnOneSession; topics: OneOnOneTopic[] }[]>({
    queryKey: actionItemsKey,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/action-items?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const getUserName = (id: string) => allUsers.find(u => u.id === id)?.name || "Unknown";

  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full" />
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  if (!data) return null;

  const { session, topics } = data;
  const pendingTopics = topics.filter(t => t.status === "pending");
  const discussedTopics = topics.filter(t => t.status === "discussed");
  const openActionItemCount = actionItemData.reduce(
    (sum, group) => sum + group.topics.filter(t => t.status === "pending").length, 0
  );

  const handleAdd = () => {
    if (!newText.trim()) return;
    addTopicMutation.mutate({ sessionId: session.id, text: newText.trim(), tag: newTag });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Session stats bar */}
      <div className="flex gap-4 px-6 py-4 border-b flex-wrap items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          <span>Started {formatDate(session.startDate)}</span>
        </div>

        {/* Meeting date */}
        <div className="flex items-center gap-1.5">
          {editingDate ? (
            <>
              <input
                type="date"
                className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                value={dateInput}
                min={new Date().toISOString().split("T")[0]}
                onChange={(e) => setDateInput(e.target.value)}
                data-testid="input-meeting-date"
                autoFocus
              />
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => meetingDateMutation.mutate({ sessionId: session.id, meetingDate: dateInput || null })}
                disabled={meetingDateMutation.isPending}
                data-testid="btn-save-meeting-date"
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                onClick={() => setEditingDate(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : session.meetingDate ? (
            <button
              className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => { setDateInput(session.meetingDate || ""); setEditingDate(true); }}
              data-testid="btn-edit-meeting-date"
            >
              <CalendarClock className="h-4 w-4" />
              <span>Next Meeting: {formatDate(session.meetingDate)}</span>
              <Pencil className="h-3 w-3 opacity-60" />
            </button>
          ) : (
            <button
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => { setDateInput(""); setEditingDate(true); }}
              data-testid="btn-set-meeting-date"
            >
              <CalendarClock className="h-4 w-4" />
              <span>Set meeting date</span>
            </button>
          )}
        </div>

        {/* Meeting link */}
        <div className="flex items-center gap-1.5">
          {editingLink ? (
            <>
              <input
                type="url"
                className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-56"
                placeholder="Paste meeting URL..."
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onBlur={() => {
                  if (linkCancelledRef.current) {
                    linkCancelledRef.current = false;
                    return;
                  }
                  if (!meetingLinkMutation.isPending) {
                    meetingLinkMutation.mutate({ sessionId: session.id, meetingLink: linkInput || null });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") {
                    linkCancelledRef.current = true;
                    setEditingLink(false);
                  }
                }}
                data-testid="input-meeting-link"
                autoFocus
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                onMouseDown={() => { linkCancelledRef.current = true; }}
                onClick={() => setEditingLink(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : session.meetingLink ? (
            <div className="flex items-center gap-1.5">
              <a
                href={session.meetingLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400 hover:underline"
                data-testid="link-join-meeting"
              >
                <Video className="h-4 w-4" />
                <span>Join Meeting</span>
                <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => { setLinkInput(session.meetingLink || ""); setEditingLink(true); }}
                data-testid="btn-edit-meeting-link"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => { setLinkInput(""); setEditingLink(true); }}
              data-testid="btn-set-meeting-link"
            >
              <Link className="h-4 w-4" />
              <span>Add meeting link</span>
            </button>
          )}
        </div>

        {openActionItemCount > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-orange-600 dark:text-orange-400">
            <AlertCircle className="h-4 w-4" />
            <span data-testid="text-open-action-count">{openActionItemCount} open action item{openActionItemCount !== 1 ? "s" : ""}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant={showReport ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setShowReport(v => !v)}
            data-testid="btn-pull-report-card"
          >
            <BarChart2 className="h-3.5 w-3.5" />
            {showReport ? "Hide Report" : "Pull Report Card"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => closeMutation.mutate(session.id)}
            disabled={closeMutation.isPending}
            data-testid="btn-close-session"
          >
            <Archive className="h-3.5 w-3.5" />
            Close Session
          </Button>
        </div>
      </div>

      {/* Inline Report Card Panel */}
      {showReport && (
        <div className="border-b bg-slate-50 dark:bg-slate-900/50 px-6 py-4 space-y-4">
          {/* Period selector */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Report Card</span>
            <div className="flex rounded-lg border border-border overflow-hidden text-xs">
              {(["weekly", "monthly", "both"] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setReportPeriod(p)}
                  className={`px-3 py-1.5 font-medium transition-colors ${reportPeriod === p ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                  data-testid={`btn-report-period-${p}`}
                >
                  {p === "weekly" ? "Last Week" : p === "monthly" ? "Last Month" : "Both"}
                </button>
              ))}
            </div>
          </div>

          {/* Report data */}
          <div className={`flex gap-6 ${reportPeriod === "both" ? "flex-row" : "flex-col"}`}>
            {(reportPeriod === "weekly" || reportPeriod === "both") && (
              weeklyLoading
                ? <div className="flex-1 space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-16 w-full" /></div>
                : weeklyReport
                  ? <ReportCardSlice data={weeklyReport} label="This Week" />
                  : <p className="text-xs text-muted-foreground">No weekly data available.</p>
            )}
            {reportPeriod === "both" && <div className="w-px bg-border self-stretch" />}
            {(reportPeriod === "monthly" || reportPeriod === "both") && (
              monthlyLoading
                ? <div className="flex-1 space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-16 w-full" /></div>
                : monthlyReport
                  ? <ReportCardSlice data={monthlyReport} label="This Month" />
                  : <p className="text-xs text-muted-foreground">No monthly data available.</p>
            )}
          </div>
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex border-b px-6">
        <button
          onClick={() => setActiveTab("topics")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === "topics" ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          data-testid="tab-topics"
        >
          <span className="flex items-center gap-1.5">
            <MessageSquare className="h-4 w-4" />
            Topics
          </span>
        </button>
        <button
          onClick={() => setActiveTab("action-items")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === "action-items" ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          data-testid="tab-action-items"
        >
          <span className="flex items-center gap-1.5">
            <ClipboardList className="h-4 w-4" />
            Action Items
            {openActionItemCount > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs h-5 min-w-[20px] flex items-center justify-center">{openActionItemCount}</Badge>
            )}
          </span>
        </button>
        <button
          onClick={() => setActiveTab("dev-goals")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === "dev-goals" ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          data-testid="tab-dev-goals"
        >
          <span className="flex items-center gap-1.5">
            <Target className="h-4 w-4" />
            Development Goals
          </span>
        </button>
      </div>

      {activeTab === "dev-goals" ? (
        <DevelopmentGoalsPanel managerId={managerId} repId={repId} />
      ) : activeTab === "topics" ? (
        <>
          {/* Add topic */}
          <div className="px-6 py-4 border-b space-y-2">
            <div className="flex gap-2">
              <input
                className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Add a topic for your next 1:1..."
                value={newText}
                onChange={e => setNewText(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
                data-testid="input-topic-text"
              />
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                data-testid="select-topic-tag"
              >
                <option value="fyi">FYI</option>
                <option value="action_item">Action Item</option>
                <option value="question">Question</option>
                <option value="follow_up">Follow-up</option>
                <option value="shoutout">Shoutout</option>
                <option value="lets_work_on">Let's Work On</option>
                <option value="career">Career</option>
              </select>
              <Button
                size="sm"
                className="h-9 gap-1.5"
                onClick={handleAdd}
                disabled={!newText.trim() || addTopicMutation.isPending}
                data-testid="btn-add-topic"
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
            <FileAttachmentUpload
              pendingFiles={topicPendingFiles}
              onAdd={(files) => setTopicPendingFiles(prev => [...prev, ...files])}
              onRemove={(i) => setTopicPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
              compact
            />
          </div>

          {/* Session Notes */}
          <SessionNotesArea sessionId={session.id} initialNotes={session.notes || ""} sessionQueryKey={sessionKey} />

          {/* Topics */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
            {topics.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-base font-medium">No topics yet</p>
                <p className="text-sm mt-1">Add your first topic above to get started</p>
              </div>
            ) : (
              <>
                {pendingTopics.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-1">
                      To Discuss ({pendingTopics.length})
                    </p>
                    {pendingTopics.map(topic => (
                      <TopicRow
                        key={topic.id}
                        topic={topic}
                        addedByName={getUserName(topic.addedById)}
                        onToggle={() => toggleMutation.mutate({ topicId: topic.id, status: "discussed" })}
                        onDelete={() => deleteMutation.mutate(topic.id)}
                        currentUserId={currentUserId}
                        allUsers={allUsers}
                      />
                    ))}
                  </div>
                )}
                {discussedTopics.length > 0 && (
                  <div className="space-y-1.5 pt-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-1">
                      Discussed ({discussedTopics.length})
                    </p>
                    {discussedTopics.map(topic => (
                      <TopicRow
                        key={topic.id}
                        topic={topic}
                        addedByName={getUserName(topic.addedById)}
                        onToggle={() => toggleMutation.mutate({ topicId: topic.id, status: "pending" })}
                        onDelete={() => deleteMutation.mutate(topic.id)}
                        dimmed
                        currentUserId={currentUserId}
                        allUsers={allUsers}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Past sessions */}
          <div className="border-t">
            <button
              className="flex items-center gap-2 w-full px-6 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
              onClick={() => setShowArchived(v => !v)}
              data-testid="btn-toggle-archived"
            >
              <RotateCcw className="h-4 w-4" />
              <span>Past Sessions</span>
              {archivedSessions.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-xs">{archivedSessions.length}</Badge>
              )}
              <span className="ml-auto">
                {showArchived ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </span>
            </button>

            {showArchived && (
              <div className="px-6 pb-6 space-y-3">
                {archivedLoading ? (
                  [1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)
                ) : archivedSessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No past sessions yet</p>
                ) : (
                  archivedSessions.map(s => (
                    <ArchivedSessionCard key={s.id} session={s} allUsers={allUsers} />
                  ))
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <ActionItemsPanel managerId={managerId} repId={repId} allUsers={allUsers} />
      )}
    </div>
  );
}

// ─── Topic Row ────────────────────────────────────────────────────────────────

function TopicRow({ topic, addedByName, onToggle, onDelete, dimmed, currentUserId, allUsers }: {
  topic: OneOnOneTopic;
  addedByName: string;
  onToggle: () => void;
  onDelete: () => void;
  dimmed?: boolean;
  currentUserId: string;
  allUsers: SafeUser[];
}) {
  const { toast } = useToast();
  const tag = TAG_CONFIG[topic.tag] || TAG_CONFIG.fyi;
  const [showReplies, setShowReplies] = useState(false);
  const [replyText, setReplyText] = useState("");
  const replyInputRef = useRef<HTMLInputElement>(null);
  const currentUser = allUsers.find(u => u.id === currentUserId);
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director";

  const { data: replies = [], isLoading: repliesLoading } = useQuery<OneOnOneTopicReply[]>({
    queryKey: ["/api/one-on-one/topics", topic.id, "replies"],
    queryFn: async () => {
      const res = await fetch(`/api/one-on-one/topics/${topic.id}/replies`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: showReplies,
  });

  const addReplyMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await apiRequest("POST", `/api/one-on-one/topics/${topic.id}/replies`, { text });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/topics", topic.id, "replies"] });
      setReplyText("");
    },
    onError: () => toast({ title: "Failed to post reply", variant: "destructive" }),
  });

  const deleteReplyMutation = useMutation({
    mutationFn: async (replyId: string) => {
      await apiRequest("DELETE", `/api/one-on-one/topic-replies/${replyId}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/topics", topic.id, "replies"] }),
  });

  const getUserName = (userId: string) => allUsers.find(u => u.id === userId)?.name || "Unknown";
  const getUserInitials = (userId: string) => {
    const u = allUsers.find(m => m.id === userId);
    return u?.name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
  };
  const getUserIsNam = (userId: string) => {
    const u = allUsers.find(m => m.id === userId);
    return u?.role === "national_account_manager" || u?.role === "director" || u?.role === "sales" || u?.role === "admin";
  };

  return (
    <div
      className={`rounded-xl border border-transparent hover:border-border transition-all group ${dimmed ? "opacity-60" : ""}`}
      data-testid={`row-topic-${topic.id}`}
    >
      <div className="flex items-start gap-3 p-3 hover:bg-muted/30 rounded-xl">
        <button
          onClick={onToggle}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
          data-testid={`btn-toggle-topic-${topic.id}`}
        >
          {topic.status === "discussed"
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <Circle className="h-5 w-5" />}
        </button>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm cursor-pointer select-none ${dimmed ? "line-through text-muted-foreground" : "text-foreground"}`}
            onClick={() => { setShowReplies(v => !v); if (!showReplies) setTimeout(() => replyInputRef.current?.focus(), 100); }}
          >{topic.text}</p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tag.color}`}>{tag.label}</span>
            <span className="text-xs text-muted-foreground">Added by {addedByName}</span>
            {dimmed && (
              <button
                onClick={onToggle}
                className="flex items-center gap-0.5 text-xs text-amber-600 dark:text-amber-400 hover:underline"
                data-testid={`btn-undo-topic-${topic.id}`}
              >
                <RotateCcw className="h-3 w-3" /> Undo
              </button>
            )}
            <button
              onClick={() => { setShowReplies(v => !v); if (!showReplies) setTimeout(() => replyInputRef.current?.focus(), 100); }}
              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`btn-reply-topic-${topic.id}`}
            >
              <CornerDownRight className="h-3 w-3" />
              {showReplies ? "Hide" : "Reply"}
            </button>
          </div>
          <FileAttachmentList entityType="one_on_one_topic" entityIds={[topic.id]} />
        </div>
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive transition-all mt-0.5"
          data-testid={`btn-delete-topic-${topic.id}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Reply thread */}
      {showReplies && (
        <div className="ml-11 mr-3 mb-3 border-l-2 border-indigo-200 dark:border-indigo-800 pl-3 space-y-2" data-testid={`reply-thread-${topic.id}`}>
          {repliesLoading ? (
            <Skeleton className="h-6 w-32" />
          ) : replies.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1 italic">No replies yet — be the first to respond</p>
          ) : (
            replies.map(reply => {
              const rInitials = getUserInitials(reply.authorId);
              const rIsNam = getUserIsNam(reply.authorId);
              const canDelete = reply.authorId === currentUserId || isAdmin;
              return (
                <div key={reply.id} className="flex items-start gap-1.5 group/reply" data-testid={`reply-${reply.id}`}>
                  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold mt-0.5 ${rIsNam ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"}`}>
                    {rInitials}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium">{getUserName(reply.authorId)}</span>
                    <span className="text-[10px] text-muted-foreground ml-1.5">{new Date(reply.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                    <p className="text-xs text-foreground mt-0.5 break-words">{reply.text}</p>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => deleteReplyMutation.mutate(reply.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/reply:opacity-100 transition-opacity mt-0.5"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })
          )}
          <div className="flex gap-1.5 pt-1">
            <input
              ref={replyInputRef}
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && replyText.trim()) { e.preventDefault(); addReplyMutation.mutate(replyText.trim()); } }}
              placeholder="Write a reply…"
              className="flex-1 text-xs h-7 px-2 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid={`input-reply-${topic.id}`}
            />
            <button
              onClick={() => replyText.trim() && addReplyMutation.mutate(replyText.trim())}
              disabled={!replyText.trim() || addReplyMutation.isPending}
              className="h-7 px-2 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              data-testid={`btn-send-reply-${topic.id}`}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Archived Session Card ────────────────────────────────────────────────────

function ArchivedSessionCard({ session, allUsers }: {
  session: OneOnOneSession & { topics: OneOnOneTopic[] };
  allUsers: SafeUser[];
}) {
  const [open, setOpen] = useState(false);
  const getUserName = (id: string) => allUsers.find(u => u.id === id)?.name || "Unknown";
  const discussed = session.topics.filter(t => t.status === "discussed").length;
  const pct = session.topics.length > 0 ? Math.round((discussed / session.topics.length) * 100) : 0;

  return (
    <div className="rounded-xl border bg-muted/20">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors rounded-xl"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{formatDate(session.startDate)}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground">{session.topics.length} topic{session.topics.length !== 1 ? "s" : ""}</span>
            {session.topics.length > 0 && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <div className="flex items-center gap-1.5">
                  <Progress value={pct} className="h-1 w-16" />
                  <span className="text-xs text-muted-foreground">{pct}% discussed</span>
                </div>
              </>
            )}
          </div>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2 border-t pt-3">
          {session.notes && (
            <div className="mb-3 p-3 rounded-lg bg-muted/40 border border-border/50">
              <div className="flex items-center gap-1.5 mb-1.5">
                <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Notes</span>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid={`text-archived-notes-${session.id}`}>{session.notes}</p>
            </div>
          )}
          {session.topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">No topics were added in this session</p>
          ) : (
            session.topics.map(t => {
              const tag = TAG_CONFIG[t.tag] || TAG_CONFIG.fyi;
              return (
                <div key={t.id} className={`flex items-start gap-2.5 py-1.5 ${t.status === "discussed" ? "opacity-60" : ""}`}>
                  {t.status === "discussed"
                    ? <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                    : <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm ${t.status === "discussed" ? "line-through text-muted-foreground" : ""}`}>{t.text}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`inline-flex items-center px-1.5 py-px rounded text-xs font-medium ${tag.color}`}>{tag.label}</span>
                      <span className="text-xs text-muted-foreground">· {getUserName(t.addedById)}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pairing List sidebar ─────────────────────────────────────────────────────

interface Pairing {
  namId: string;
  amId: string;
  namName: string;
  amName: string;
  section?: string;
}

interface PairingListProps {
  pairings: Pairing[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  showNamLabel: boolean;
}

function PairingList({ pairings, selectedKey, onSelect, showNamLabel }: PairingListProps) {
  // Keep upward/manager pairing first, sort everything else alphabetically by display name
  const sortedPairings = [...pairings].sort((a, b) => {
    if (a.section === "upward" || a.section === "my_manager") return -1;
    if (b.section === "upward" || b.section === "my_manager") return 1;
    const nameA = a.section === "upward" ? a.namName : a.amName;
    const nameB = b.section === "upward" ? b.namName : b.amName;
    return nameA.localeCompare(nameB);
  });

  return (
    <div className="w-64 shrink-0 border-r flex flex-col bg-muted/10">
      <div className="px-4 py-3 border-b">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {showNamLabel ? "All Pairings" : "Direct Reports"}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {sortedPairings.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No pairings found</p>
          </div>
        ) : (
          sortedPairings.map(p => {
            const key = `${p.namId}::${p.amId}`;
            const isSelected = selectedKey === key;
            const isUpward = p.section === "upward";
            const displayName = isUpward ? p.namName : p.amName;
            return (
              <button
                key={key}
                onClick={() => onSelect(key)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${isSelected ? "bg-muted/60 border-r-2 border-r-indigo-600" : ""}`}
                data-testid={`btn-select-pairing-${p.amId}`}
              >
                <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-semibold ${avatarColor(displayName)}`}>
                  {initials(displayName)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{displayName}</p>
                  {isUpward ? (
                    <p className="text-xs text-muted-foreground">My Manager</p>
                  ) : showNamLabel ? (
                    <p className="text-xs text-muted-foreground truncate">with {p.namName}</p>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OneOnOnePage() {
  const { user } = useAuth();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: pairings = [], isLoading: pairingsLoading } = useQuery<Pairing[]>({
    queryKey: ["/api/one-on-one/pairings"],
    refetchInterval: 180000,
  });

  if (!user) return null;

  const isAM = user.role === "account_manager" || user.role === "logistics_manager" || user.role === "logistics_coordinator";
  const showNamLabel = user.role === "admin" || user.role === "director" || user.role === "sales_director";

  const activePairingKey = selectedKey ?? (pairings.length > 0 ? `${pairings[0].namId}::${pairings[0].amId}` : null);
  const activePairing = pairings.find(p => `${p.namId}::${p.amId}` === activePairingKey) ?? pairings[0] ?? null;

  const managerId = activePairing?.namId ?? null;
  const repId = activePairing?.amId ?? null;

  const pairingDisplayName = activePairing
    ? (isAM || activePairing.section === "upward" ? activePairing.namName : activePairing.amName)
    : null;
  const pairingTitle = activePairing
    ? `1:1 with ${pairingDisplayName}`
    : "1:1 Sessions";

  if (usersLoading || pairingsLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-4 border-b flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
          <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold" data-testid="text-page-title">1:1 Meetings</h1>
          <p className="text-xs text-muted-foreground">Track topics, action items, and session history</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: pairing list for managers/admins */}
        {!isAM && pairings.length > 1 && (
          <PairingList
            pairings={pairings}
            selectedKey={activePairingKey}
            onSelect={setSelectedKey}
            showNamLabel={showNamLabel}
          />
        )}

        {/* Session panel */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {managerId && repId ? (
            <>
              {/* Pairing header */}
              <div className="px-6 pt-5 pb-0">
                <div className="flex items-center gap-3 mb-1">
                  {activePairing && pairingDisplayName && (
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 ${avatarColor(pairingDisplayName)}`}>
                      {initials(pairingDisplayName)}
                    </div>
                  )}
                  <div>
                    <h2 className="font-semibold" data-testid="text-pairing-title">{pairingTitle}</h2>
                    <p className="text-xs text-muted-foreground">Add topics anytime — discuss them in your next meeting</p>
                  </div>
                </div>
              </div>
              <SessionPanel
                managerId={managerId}
                repId={repId}
                currentUserId={user.id}
                allUsers={allUsers}
              />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-center text-muted-foreground p-8">
              {isAM && !user.managerId ? (
                <>
                  <Users className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-base font-medium">No manager assigned</p>
                  <p className="text-sm mt-1">Ask your admin to assign you to a manager to enable 1:1 sessions</p>
                </>
              ) : (
                <>
                  <Users className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-base font-medium">No 1:1 sessions found</p>
                  <p className="text-sm mt-1">Sessions are created automatically when you select a pairing</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
