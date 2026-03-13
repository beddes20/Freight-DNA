import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Users, Plus, CheckCircle2, Circle, Trash2, ChevronDown, ChevronUp,
  Archive, RotateCcw, MessageSquare, CalendarDays, TrendingUp, AlertCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import type { OneOnOneSession, OneOnOneTopic, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;


const TAG_CONFIG: Record<string, { label: string; color: string }> = {
  action_item: { label: "Action Item", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  question:    { label: "Question",    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  fyi:         { label: "FYI",         color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  follow_up:   { label: "Follow-up",   color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
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

  const addTopicMutation = useMutation({
    mutationFn: async ({ sessionId, text, tag }: { sessionId: string; text: string; tag: string }) => {
      const res = await apiRequest("POST", `/api/1on1/session/${sessionId}/topics`, { text, tag });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
      setNewText("");
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
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (topicId: string) => {
      await apiRequest("DELETE", `/api/1on1/topics/${topicId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      queryClient.invalidateQueries({ queryKey: overviewKey });
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
      toast({ title: "Session closed", description: "Unresolved topics carried over." });
    },
    onError: () => toast({ title: "Failed to close session", variant: "destructive" }),
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
  const progressPct = topics.length > 0 ? Math.round((discussedTopics.length / topics.length) * 100) : 0;
  const actionItems = topics.filter(t => t.tag === "action_item" && t.status === "pending");

  const handleAdd = () => {
    if (!newText.trim()) return;
    addTopicMutation.mutate({ sessionId: session.id, text: newText.trim(), tag: newTag });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Session stats bar */}
      <div className="flex gap-4 px-6 py-4 border-b flex-wrap">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          <span>Started {formatDate(session.startDate)}</span>
        </div>
        {topics.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span className="text-muted-foreground">Progress</span>
              <div className="flex items-center gap-2 w-24">
                <Progress value={progressPct} className="h-1.5" />
                <span className="text-xs font-medium">{progressPct}%</span>
              </div>
            </div>
            {actionItems.length > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-orange-600 dark:text-orange-400">
                <AlertCircle className="h-4 w-4" />
                <span>{actionItems.length} open action item{actionItems.length !== 1 ? "s" : ""}</span>
              </div>
            )}
          </>
        )}
        <div className="ml-auto">
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

      {/* Add topic */}
      <div className="px-6 py-4 border-b">
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
      </div>

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
    </div>
  );
}

// ─── Topic Row ────────────────────────────────────────────────────────────────

function TopicRow({ topic, addedByName, onToggle, onDelete, dimmed }: {
  topic: OneOnOneTopic;
  addedByName: string;
  onToggle: () => void;
  onDelete: () => void;
  dimmed?: boolean;
}) {
  const tag = TAG_CONFIG[topic.tag] || TAG_CONFIG.fyi;
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-xl border border-transparent hover:border-border hover:bg-muted/30 transition-all group ${dimmed ? "opacity-60" : ""}`}
      data-testid={`row-topic-${topic.id}`}
    >
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
        <p className={`text-sm ${dimmed ? "line-through text-muted-foreground" : "text-foreground"}`}>{topic.text}</p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tag.color}`}>{tag.label}</span>
          <span className="text-xs text-muted-foreground">Added by {addedByName}</span>
        </div>
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive transition-all mt-0.5"
        data-testid={`btn-delete-topic-${topic.id}`}
      >
        <Trash2 className="h-4 w-4" />
      </button>
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
}

interface PairingListProps {
  pairings: Pairing[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  showNamLabel: boolean;
}

function PairingList({ pairings, selectedKey, onSelect, showNamLabel }: PairingListProps) {
  return (
    <div className="w-64 shrink-0 border-r flex flex-col bg-muted/10">
      <div className="px-4 py-3 border-b">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {showNamLabel ? "All Pairings" : "Direct Reports"}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {pairings.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No pairings found</p>
          </div>
        ) : (
          pairings.map(p => {
            const key = `${p.namId}::${p.amId}`;
            const isSelected = selectedKey === key;
            return (
              <button
                key={key}
                onClick={() => onSelect(key)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${isSelected ? "bg-muted/60 border-r-2 border-r-indigo-600" : ""}`}
                data-testid={`btn-select-pairing-${p.amId}`}
              >
                <div className={`h-8 w-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-semibold ${avatarColor(p.amName)}`}>
                  {initials(p.amName)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.amName}</p>
                  {showNamLabel && (
                    <p className="text-xs text-muted-foreground truncate">with {p.namName}</p>
                  )}
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
    queryKey: ["/api/users"],
  });

  const { data: pairings = [], isLoading: pairingsLoading } = useQuery<Pairing[]>({
    queryKey: ["/api/one-on-one/pairings"],
  });

  if (!user) return null;

  const isAM = user.role === "account_manager";
  const showNamLabel = user.role === "admin";

  const activePairingKey = selectedKey ?? (pairings.length > 0 ? `${pairings[0].namId}::${pairings[0].amId}` : null);
  const activePairing = pairings.find(p => `${p.namId}::${p.amId}` === activePairingKey) ?? pairings[0] ?? null;

  const managerId = activePairing?.namId ?? null;
  const repId = activePairing?.amId ?? null;

  const pairingTitle = isAM
    ? activePairing ? `Your 1:1 with ${activePairing.namName}` : "Your 1:1 Sessions"
    : activePairing ? `1:1 with ${activePairing.amName}` : "1:1 Sessions";

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
                  {activePairing && (
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 ${avatarColor(isAM ? activePairing.namName : activePairing.amName)}`}>
                      {initials(isAM ? activePairing.namName : activePairing.amName)}
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
