import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users, Plus, CheckCircle2, Circle, Trash2, ChevronDown, ChevronUp,
  Archive, RotateCcw, MessageSquare,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { OneOnOneSession, OneOnOneTopic, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

const TAG_CONFIG: Record<string, { label: string; color: string }> = {
  action_item: { label: "Action Item", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
  question:    { label: "Question",    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  fyi:         { label: "FYI",         color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  follow_up:   { label: "Follow-up",   color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
};

function initials(name: string) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

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
  const { data: archivedSessions = [] } = useQuery<(OneOnOneSession & { topics: OneOnOneTopic[] })[]>({
    queryKey: archivedKey,
    enabled: showArchived,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/archived?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const addTopicMutation = useMutation({
    mutationFn: async ({ sessionId, text, tag }: { sessionId: string; text: string; tag: string }) => {
      const res = await apiRequest("POST", `/api/1on1/session/${sessionId}/topics`, { text, tag });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
      setNewText("");
    },
    onError: () => toast({ title: "Failed to add topic", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ topicId, status }: { topicId: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/1on1/topics/${topicId}`, { status });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (topicId: string) => {
      await apiRequest("DELETE", `/api/1on1/topics/${topicId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKey });
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
      toast({ title: "Session closed", description: "Unresolved topics carried over to the new session." });
    },
    onError: () => toast({ title: "Failed to close session", variant: "destructive" }),
  });

  const getUserName = (id: string) => allUsers.find(u => u.id === id)?.name || "Unknown";

  if (isLoading) return <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  if (!data) return null;

  const { session, topics } = data;
  const pendingTopics = topics.filter(t => t.status === "pending");
  const discussedTopics = topics.filter(t => t.status === "discussed");

  const handleAdd = () => {
    if (!newText.trim()) return;
    addTopicMutation.mutate({ sessionId: session.id, text: newText.trim(), tag: newTag });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Session started {formatDate(session.startedAt)}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => closeMutation.mutate(session.id)}
          disabled={closeMutation.isPending}
          data-testid="btn-close-session"
        >
          <Archive className="h-3 w-3" />
          Close Session
        </Button>
      </div>

      {/* Add topic form */}
      <div className="flex gap-2">
        <div className="flex-1 flex gap-2">
          <input
            className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Add a topic..."
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
            data-testid="input-topic-text"
          />
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            data-testid="select-topic-tag"
          >
            <option value="fyi">FYI</option>
            <option value="action_item">Action Item</option>
            <option value="question">Question</option>
            <option value="follow_up">Follow-up</option>
          </select>
        </div>
        <Button
          size="sm"
          className="h-8 px-3"
          onClick={handleAdd}
          disabled={!newText.trim() || addTopicMutation.isPending}
          data-testid="btn-add-topic"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Pending topics */}
      {pendingTopics.length === 0 && discussedTopics.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground">
          <MessageSquare className="h-7 w-7 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No topics yet — add one above</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {pendingTopics.map(topic => (
            <TopicRow
              key={topic.id}
              topic={topic}
              addedByName={getUserName(topic.addedById)}
              onToggle={() => toggleMutation.mutate({ topicId: topic.id, status: "discussed" })}
              onDelete={() => deleteMutation.mutate(topic.id)}
            />
          ))}
          {discussedTopics.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground pt-2 pb-1 font-medium">Discussed</p>
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
            </>
          )}
        </div>
      )}

      {/* Past sessions */}
      <div className="border-t pt-3">
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          onClick={() => setShowArchived(v => !v)}
          data-testid="btn-toggle-archived"
        >
          <RotateCcw className="h-3 w-3" />
          Past Sessions
          {showArchived ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
        </button>
        {showArchived && (
          <div className="mt-3 space-y-3">
            {archivedSessions.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">No past sessions yet</p>
            ) : (
              archivedSessions.map(s => (
                <ArchivedSessionRow key={s.id} session={s} allUsers={allUsers} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TopicRow({ topic, addedByName, onToggle, onDelete, dimmed }: {
  topic: OneOnOneTopic;
  addedByName: string;
  onToggle: () => void;
  onDelete: () => void;
  dimmed?: boolean;
}) {
  const tag = TAG_CONFIG[topic.tag] || TAG_CONFIG.fyi;
  return (
    <div className={`flex items-start gap-2 p-2.5 rounded-lg border border-transparent hover:border-border hover:bg-muted/30 transition-all group ${dimmed ? "opacity-60" : ""}`} data-testid={`row-topic-${topic.id}`}>
      <button onClick={onToggle} className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors" data-testid={`btn-toggle-topic-${topic.id}`}>
        {topic.status === "discussed"
          ? <CheckCircle2 className="h-4 w-4 text-green-500" />
          : <Circle className="h-4 w-4" />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${dimmed ? "line-through text-muted-foreground" : ""}`}>{topic.text}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${tag.color}`}>{tag.label}</span>
          <span className="text-xs text-muted-foreground">· {addedByName}</span>
        </div>
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive transition-all"
        data-testid={`btn-delete-topic-${topic.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ArchivedSessionRow({ session, allUsers }: { session: OneOnOneSession & { topics: OneOnOneTopic[] }; allUsers: SafeUser[] }) {
  const [open, setOpen] = useState(false);
  const getUserName = (id: string) => allUsers.find(u => u.id === id)?.name || "Unknown";
  return (
    <div className="rounded-lg border bg-muted/20">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className="text-xs font-medium text-muted-foreground">{formatDate(session.startedAt)}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{session.topics.length} topic{session.topics.length !== 1 ? "s" : ""}</span>
          {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          {session.topics.length === 0 ? (
            <p className="text-xs text-muted-foreground">No topics in this session</p>
          ) : (
            session.topics.map(t => {
              const tag = TAG_CONFIG[t.tag] || TAG_CONFIG.fyi;
              return (
                <div key={t.id} className={`flex items-start gap-2 py-1 ${t.status === "discussed" ? "opacity-60" : ""}`}>
                  {t.status === "discussed"
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
                    : <Circle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs ${t.status === "discussed" ? "line-through text-muted-foreground" : ""}`}>{t.text}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`inline-flex items-center px-1 py-px rounded text-xs ${tag.color}`}>{tag.label}</span>
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

interface OneOnOnePortletProps {
  currentUser: SafeUser;
  allUsers: SafeUser[];
  teamMembers: SafeUser[];
}

export function OneOnOnePortlet({ currentUser, allUsers, teamMembers }: OneOnOnePortletProps) {
  const isManager = currentUser.role !== "account_manager";
  const isAM = currentUser.role === "account_manager";

  const directReports = allUsers.filter(u => u.managerId === currentUser.id && u.role === "account_manager");
  const [selectedRepId, setSelectedRepId] = useState<string | null>(null);

  const activeRep = isManager
    ? (selectedRepId ? allUsers.find(u => u.id === selectedRepId) : directReports[0])
    : null;

  const managerId = isAM ? currentUser.managerId : currentUser.id;
  const repId = isAM ? currentUser.id : (activeRep?.id ?? null);
  const manager = isAM ? allUsers.find(u => u.id === currentUser.managerId) : currentUser;

  const sessionKey = ["/api/1on1/session", managerId, repId];
  const { data: sessionData } = useQuery<{ session: OneOnOneSession; topics: OneOnOneTopic[] }>({
    queryKey: sessionKey,
    enabled: !!managerId && !!repId,
    queryFn: async () => {
      const res = await fetch(`/api/1on1/session?managerId=${managerId}&repId=${repId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const pendingCount = sessionData?.topics.filter(t => t.status === "pending").length ?? 0;

  if (isAM && !currentUser.managerId) return null;

  const pairingLabel = isAM
    ? `with ${manager?.name || "your manager"}`
    : activeRep ? `with ${activeRep.name}` : "";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          1:1 Topics
          {pairingLabel && <span className="text-muted-foreground font-normal text-sm">{pairingLabel}</span>}
          {pendingCount > 0 && (
            <Badge className="ml-auto bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 font-normal border-0">
              {pendingCount} unresolved
            </Badge>
          )}
        </CardTitle>

        {/* NAM / admin: rep selector tabs */}
        {isManager && directReports.length > 1 && (
          <div className="flex gap-1 flex-wrap pt-1">
            {directReports.map(rep => (
              <button
                key={rep.id}
                onClick={() => setSelectedRepId(rep.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  (activeRep?.id === rep.id)
                    ? "bg-indigo-600 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
                data-testid={`tab-rep-${rep.id}`}
              >
                {initials(rep.name)}
                <span className="ml-1 hidden sm:inline">{rep.name.split(" ")[0]}</span>
              </button>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent>
        {isAM && managerId && repId ? (
          <SessionPanel
            managerId={managerId}
            repId={repId}
            currentUserId={currentUser.id}
            allUsers={allUsers}
          />
        ) : isManager && activeRep && managerId ? (
          <SessionPanel
            managerId={managerId}
            repId={activeRep.id}
            currentUserId={currentUser.id}
            allUsers={allUsers}
          />
        ) : isManager && directReports.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No direct reports yet</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
