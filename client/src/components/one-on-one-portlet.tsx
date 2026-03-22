import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare, ChevronDown, ChevronRight, Plus, Check,
  Circle, Trash2, Archive, History, Tag, CornerDownRight, RotateCcw,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import type { OneOnOneSession, OneOnOneTopic, OneOnOneTopicReply, User } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";

type SafeUser = Omit<User, "password">;

interface Pairing {
  namId: string;
  amId: string;
  namName: string;
  amName: string;
  section?: string;
  groupLabel?: string;
}

interface SessionWithTopics {
  session: OneOnOneSession;
  topics: OneOnOneTopic[];
}

interface ArchivedSession extends OneOnOneSession {
  topics: OneOnOneTopic[];
}

const TAG_OPTIONS: { value: string; label: string }[] = [
  { value: "action_item",  label: "Action Item" },
  { value: "question",     label: "Question" },
  { value: "fyi",          label: "FYI" },
  { value: "follow_up",    label: "Follow-up" },
  { value: "shoutout",     label: "Shoutout" },
  { value: "lets_work_on", label: "Let's Work On" },
  { value: "career",       label: "Career" },
];

// Resolves any stored tag value (snake_case or legacy human-readable) to display config
function resolveTag(tag: string | null | undefined): { label: string; color: string } {
  const MAP: Record<string, { label: string; color: string }> = {
    action_item:   { label: "Action Item",   color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
    question:      { label: "Question",      color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
    fyi:           { label: "FYI",           color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
    follow_up:     { label: "Follow-up",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
    shoutout:      { label: "Shoutout",      color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
    lets_work_on:  { label: "Let's Work On", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400" },
    career:        { label: "Career",        color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
    // Legacy human-readable aliases
    "Action Item":   { label: "Action Item",   color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
    "Question":      { label: "Question",      color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
    "FYI":           { label: "FYI",           color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" },
    "Follow-up":     { label: "Follow-up",     color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
    "Shoutout":      { label: "Shoutout",      color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
    "Let's Work On": { label: "Let's Work On", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400" },
    "Career":        { label: "Career",        color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  };
  return tag ? (MAP[tag] ?? { label: tag, color: "bg-muted text-muted-foreground" }) : { label: "", color: "" };
}

function TopicRow({ topic, teamMembers, currentUserId }: { topic: OneOnOneTopic; teamMembers: SafeUser[]; currentUserId: string }) {
  const { toast } = useToast();
  const [showReplies, setShowReplies] = useState(false);
  const [replyText, setReplyText] = useState("");
  const replyInputRef = useRef<HTMLInputElement>(null);
  const author = teamMembers.find(u => u.id === topic.addedById);
  const initials = author?.name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
  const isNam = author?.role === "national_account_manager" || author?.role === "director" || author?.role === "sales";
  const currentUser = teamMembers.find(u => u.id === currentUserId);
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director";

  const { data: replies = [], isLoading: repliesLoading } = useQuery<OneOnOneTopicReply[]>({
    queryKey: ["/api/one-on-one/topics", topic.id, "replies"],
    queryFn: async () => {
      const res = await fetch(`/api/one-on-one/topics/${topic.id}/replies`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch replies");
      return res.json();
    },
    enabled: showReplies,
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/one-on-one/topics/${topic.id}/toggle`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/pending-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/per-pairing-counts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/one-on-one/topics/${topic.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/pending-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/per-pairing-counts"] });
      toast({ title: "Topic deleted" });
    },
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/topics", topic.id, "replies"] });
    },
  });

  const handleOpenReplies = () => {
    setShowReplies(true);
    setTimeout(() => replyInputRef.current?.focus(), 100);
  };

  const getUserInitials = (userId: string) => {
    const u = teamMembers.find(m => m.id === userId);
    return u?.name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
  };
  const getUserName = (userId: string) => teamMembers.find(m => m.id === userId)?.name || "Unknown";
  const getUserIsNam = (userId: string) => {
    const u = teamMembers.find(m => m.id === userId);
    return u?.role === "national_account_manager" || u?.role === "director" || u?.role === "sales" || u?.role === "admin";
  };

  return (
    <div
      className={`rounded-lg border border-transparent hover:border-border transition-all group ${topic.status === "discussed" ? "opacity-60" : ""}`}
      data-testid={`topic-row-${topic.id}`}
    >
      <div className="flex items-start gap-2 p-2 hover:bg-muted/50 rounded-lg">
        {/* Toggle button — shows undo affordance when discussed */}
        <button
          onClick={() => toggleMutation.mutate()}
          className="shrink-0 mt-0.5 hover:scale-110 transition-transform"
          title={topic.status === "discussed" ? "Mark as pending (undo)" : "Mark as discussed"}
          data-testid={`button-toggle-topic-${topic.id}`}
        >
          {topic.status === "discussed" ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <p
            className={`text-sm cursor-pointer select-none ${topic.status === "discussed" ? "line-through text-muted-foreground" : ""}`}
            onClick={() => showReplies ? setShowReplies(false) : handleOpenReplies()}
            data-testid={`text-topic-${topic.id}`}
          >
            {topic.text}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            {topic.tag && (() => { const t = resolveTag(topic.tag); return (
              <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${t.color}`} data-testid={`badge-topic-tag-${topic.id}`}>
                {t.label}
              </span>
            ); })()}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${isNam ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"}`}>
                {initials}
              </span>
              {author?.name || "Unknown"}
            </span>
            {/* Undo button — clearly visible on discussed topics */}
            {topic.status === "discussed" && (
              <button
                onClick={() => toggleMutation.mutate()}
                className="flex items-center gap-0.5 text-xs text-amber-600 dark:text-amber-400 hover:underline ml-1"
                data-testid={`button-undo-topic-${topic.id}`}
              >
                <RotateCcw className="h-3 w-3" /> Undo
              </button>
            )}
            {/* Reply toggle */}
            <button
              onClick={() => showReplies ? setShowReplies(false) : handleOpenReplies()}
              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground ml-1 transition-colors"
              data-testid={`button-reply-topic-${topic.id}`}
            >
              <CornerDownRight className="h-3 w-3" />
              {showReplies ? "Hide" : "Reply"}
            </button>
          </div>
          <FileAttachmentList entityType="one_on_one_topic" entityIds={[topic.id]} />
        </div>

        <button
          onClick={() => deleteMutation.mutate()}
          className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
          data-testid={`button-delete-topic-${topic.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Reply thread */}
      {showReplies && (
        <div className="ml-8 mr-2 mb-2 border-l-2 border-indigo-200 dark:border-indigo-800 pl-3 space-y-2" data-testid={`reply-thread-${topic.id}`}>
          {repliesLoading ? (
            <div className="py-1"><Skeleton className="h-6 w-32" /></div>
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
                      data-testid={`button-delete-reply-${reply.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })
          )}
          {/* Reply input */}
          <div className="flex gap-1.5 pt-1">
            <input
              ref={replyInputRef}
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && replyText.trim()) {
                  e.preventDefault();
                  addReplyMutation.mutate(replyText.trim());
                }
              }}
              placeholder="Write a reply…"
              className="flex-1 text-xs h-7 px-2 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid={`input-reply-${topic.id}`}
            />
            <button
              onClick={() => replyText.trim() && addReplyMutation.mutate(replyText.trim())}
              disabled={!replyText.trim() || addReplyMutation.isPending}
              className="h-7 px-2 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              data-testid={`button-send-reply-${topic.id}`}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionView({ pairing, teamMembers }: { pairing: Pairing; teamMembers: SafeUser[] }) {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [topicText, setTopicText] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [showTagSelector, setShowTagSelector] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [topicPendingFiles, setTopicPendingFiles] = useState<PendingFile[]>([]);

  const { data: sessionData, isLoading } = useQuery<SessionWithTopics>({
    queryKey: ["/api/one-on-one/session", pairing.namId, pairing.amId],
    refetchInterval: 180000,
    queryFn: async () => {
      const res = await fetch(`/api/one-on-one/session?namId=${pairing.namId}&amId=${pairing.amId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: archivedSessions = [] } = useQuery<ArchivedSession[]>({
    queryKey: ["/api/one-on-one/archived", pairing.namId, pairing.amId],
    queryFn: async () => {
      const res = await fetch(`/api/one-on-one/archived?namId=${pairing.namId}&amId=${pairing.amId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: showHistory,
  });

  const addTopicMutation = useMutation({
    mutationFn: async (data: { sessionId: string; text: string; tag: string | null }) => {
      const res = await apiRequest("POST", "/api/one-on-one/topics", data);
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
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session", pairing.namId, pairing.amId] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/pending-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/per-pairing-counts"] });
      setTopicText("");
      setSelectedTag(null);
      setShowTagSelector(false);
      setTopicPendingFiles([]);
    },
    onError: () => {
      toast({ title: "Failed to add topic", variant: "destructive" });
    },
  });

  const closeSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("POST", `/api/one-on-one/sessions/${sessionId}/close`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session", pairing.namId, pairing.amId] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/archived", pairing.namId, pairing.amId] });
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/pending-count"] });
      toast({ title: "Session closed. Pending topics carried over." });
    },
    onError: () => {
      toast({ title: "Failed to close session", variant: "destructive" });
    },
  });

  const handleAddTopic = () => {
    if (!topicText.trim() || !sessionData?.session) return;
    addTopicMutation.mutate({
      sessionId: sessionData.session.id,
      text: topicText.trim(),
      tag: selectedTag,
    });
  };

  if (isLoading) {
    return <div className="space-y-2 py-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>;
  }

  const topics = sessionData?.topics || [];

  return (
    <div className="space-y-3" data-testid={`session-view-${pairing.namId}-${pairing.amId}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2">
          <Input
            value={topicText}
            onChange={e => setTopicText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAddTopic(); } }}
            placeholder="Add a discussion topic..."
            className="text-sm h-8"
            data-testid="input-new-topic"
          />
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={() => setShowTagSelector(!showTagSelector)}
              title="Add tag"
              data-testid="button-tag-selector"
            >
              <Tag className="h-3.5 w-3.5" />
            </Button>
            {showTagSelector && (
              <div className="absolute z-50 right-0 top-full mt-1 w-36 rounded-md border bg-popover shadow-lg py-1" data-testid="tag-dropdown">
                {TAG_OPTIONS.map(tag => (
                  <button
                    key={tag.value}
                    onClick={() => { setSelectedTag(selectedTag === tag.value ? null : tag.value); setShowTagSelector(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors ${selectedTag === tag.value ? "font-semibold bg-muted" : ""}`}
                    data-testid={`button-tag-${tag.value}`}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            size="sm"
            className="h-8 gap-1"
            onClick={handleAddTopic}
            disabled={!topicText.trim() || addTopicMutation.isPending}
            data-testid="button-add-topic"
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
      </div>

      {selectedTag && (() => { const t = resolveTag(selectedTag); return (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Tag:</span>
          <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${t.color}`}>{t.label}</span>
          <button onClick={() => setSelectedTag(null)} className="text-xs text-muted-foreground hover:text-foreground ml-1">×</button>
        </div>
      ); })()}

      <FileAttachmentUpload
        pendingFiles={topicPendingFiles}
        onAdd={(files) => setTopicPendingFiles(prev => [...prev, ...files])}
        onRemove={(i) => setTopicPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
        compact
      />

      {topics.length > 0 ? (
        <div className="space-y-0.5 max-h-64 overflow-y-auto">
          {topics.map(topic => (
            <TopicRow key={topic.id} topic={topic} teamMembers={teamMembers} currentUserId={currentUser?.id || ""} />
          ))}
        </div>
      ) : (
        <div className="text-center py-4 text-muted-foreground">
          <MessageSquare className="h-6 w-6 mx-auto mb-1 opacity-50" />
          <p className="text-xs">No topics yet. Add one above.</p>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-toggle-history"
        >
          <History className="h-3 w-3" />
          Past Sessions
          {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={() => sessionData?.session && closeSessionMutation.mutate(sessionData.session.id)}
          disabled={closeSessionMutation.isPending || !sessionData?.session}
          data-testid="button-close-session"
        >
          <Archive className="h-3 w-3" /> Close Session
        </Button>
      </div>

      {showHistory && (
        <div className="space-y-2">
          {archivedSessions.length > 0 ? (
            archivedSessions.map(session => (
              <div key={session.id} className="border rounded-lg p-2" data-testid={`archived-session-${session.id}`}>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Session started {new Date(session.startDate).toLocaleDateString()}
                </p>
                {session.topics.length > 0 ? (
                  <div className="space-y-0.5">
                    {session.topics.map(topic => (
                      <div key={topic.id} className="flex items-center gap-2 text-xs py-0.5">
                        {topic.status === "discussed" ? (
                          <Check className="h-3 w-3 text-green-500 shrink-0" />
                        ) : (
                          <Circle className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                        <span className={topic.status === "discussed" ? "line-through text-muted-foreground" : ""}>{topic.text}</span>
                        {topic.tag && (() => { const t = resolveTag(topic.tag); return (
                          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${t.color}`}>{t.label}</span>
                        ); })()}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No topics</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">No past sessions</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function OneOnOnePortlet() {
  const { user: currentUser } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPairingIdx, setSelectedPairingIdx] = useState(0);
  const [autoSelected, setAutoSelected] = useState(false);

  const { data: pairings = [], isLoading: pairingsLoading } = useQuery<Pairing[]>({
    queryKey: ["/api/one-on-one/pairings"],
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  // Per-pairing pending counts — used to badge pills and auto-select best pairing
  const { data: pairingCounts = [] } = useQuery<{ namId: string; amId: string; pendingCount: number }[]>({
    queryKey: ["/api/one-on-one/per-pairing-counts"],
  });

  // Auto-select the first pairing that has pending topics (once counts load)
  useEffect(() => {
    if (autoSelected || pairings.length === 0 || pairingCounts.length === 0) return;
    const firstWithTopics = pairings.findIndex(p =>
      pairingCounts.some(c => c.namId === p.namId && c.amId === p.amId && c.pendingCount > 0)
    );
    if (firstWithTopics >= 0) {
      setSelectedPairingIdx(firstWithTopics);
    }
    setAutoSelected(true);
  }, [pairings, pairingCounts, autoSelected]);

  const getPendingCount = (namId: string, amId: string) =>
    pairingCounts.find(c => c.namId === namId && c.amId === amId)?.pendingCount ?? 0;

  const selectedPairing = pairings[selectedPairingIdx];

  // Total pending across ALL pairings (for the card header badge)
  const { data: pendingCountData } = useQuery<{ count: number }>({
    queryKey: ["/api/one-on-one/pending-count"],
  });
  const unresolvedCount = pendingCountData?.count || 0;

  // Unread notifications for 1:1 activity badge
  const { data: notifications = [] } = useQuery<Array<{ id: string; read: boolean; type: string }>>({
    queryKey: ["/api/notifications"],
  });
  const notifUnread = notifications.filter(
    n => !n.read && ["topic_added", "topic_reply", "session_closed"].includes(n.type)
  ).length;

  const isNam = currentUser?.role === "national_account_manager" || currentUser?.role === "director" || currentUser?.role === "sales" || currentUser?.role === "sales_director";
  const isAdmin = currentUser?.role === "admin";
  const isAm = currentUser?.role === "account_manager" || currentUser?.role === "logistics_manager" || currentUser?.role === "logistics_coordinator";

  // Group pairings for admin view
  const adminNamPairings = pairings.filter(p => p.section === "my_nams");
  const teamPairings = pairings.filter(p => p.section === "team");
  const teamByNam = teamPairings.reduce<Record<string, Pairing[]>>((acc, p) => {
    const key = p.groupLabel || p.namName;
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  // NAM sections
  const upwardPairing = pairings.find(p => p.section === "upward");
  const reportPairings = pairings.filter(p => p.section === "my_reports");

  if (pairingsLoading) {
    return (
      <Card data-testid="card-one-on-one">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            1:1 Topics / Discussions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (pairings.length === 0) {
    return (
      <Card data-testid="card-one-on-one">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            1:1 Topics / Discussions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No 1:1 pairings available</p>
            <p className="text-xs mt-1">Pairings are based on manager-report relationships</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Helper to render a pill selector button
  function PairingPill({ pairing, idx, label }: { pairing: Pairing; idx: number; label: string }) {
    const count = getPendingCount(pairing.namId, pairing.amId);
    const isSelected = idx === selectedPairingIdx;
    return (
      <button
        key={`${pairing.namId}-${pairing.amId}`}
        onClick={() => setSelectedPairingIdx(idx)}
        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
          isSelected
            ? "bg-indigo-600 text-white border-indigo-600"
            : "bg-transparent border-border text-muted-foreground hover:border-foreground"
        }`}
        data-testid={`button-pairing-${pairing.namId}-${pairing.amId}`}
      >
        {label}
        {count > 0 && (
          <span className={`inline-flex items-center justify-center min-w-[16px] h-4 rounded-full text-[10px] font-semibold px-1 ${
            isSelected ? "bg-white/30 text-white" : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
          }`}>
            {count}
          </span>
        )}
      </button>
    );
  }

  return (
    <Card data-testid="card-one-on-one">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            data-testid="button-toggle-one-on-one"
          >
            {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              1:1 Topics / Discussions
              {unresolvedCount > 0 && (
                <Badge variant="destructive" className="ml-1 font-normal text-xs" data-testid="badge-unresolved-count">
                  {unresolvedCount}
                </Badge>
              )}
              {notifUnread > 0 && (
                <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400" data-testid="badge-one-on-one-notif">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {notifUnread} new
                </span>
              )}
            </CardTitle>
          </button>
          <Link href="/one-on-one" className="text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-one-on-one-full">
            View all →
          </Link>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="space-y-3">

          {/* AM view — single pairing, no selector */}
          {isAm && selectedPairing && (
            <>
              <p className="text-xs text-muted-foreground">1:1 with {selectedPairing.namName}</p>
              <SessionView pairing={selectedPairing} teamMembers={teamMembers} />
            </>
          )}

          {/* NAM view — upward section + reports section */}
          {isNam && (
            <div className="space-y-4" data-testid="pairing-selector">
              {/* Upward: with their manager */}
              {upwardPairing && (() => {
                const idx = pairings.indexOf(upwardPairing);
                return (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-indigo-500" />
                      With Your Manager
                    </p>
                    <div className="flex gap-1 flex-wrap mb-2">
                      <PairingPill pairing={upwardPairing} idx={idx} label={upwardPairing.namName} />
                    </div>
                    {selectedPairingIdx === idx && (
                      <SessionView pairing={upwardPairing} teamMembers={teamMembers} />
                    )}
                  </div>
                );
              })()}

              {/* Divider */}
              {upwardPairing && reportPairings.length > 0 && (
                <div className="border-t border-dashed border-border" />
              )}

              {/* Downward: their direct reports */}
              {reportPairings.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    Your Direct Reports
                  </p>
                  <div className="flex gap-1 flex-wrap mb-2">
                    {reportPairings.map((p) => {
                      const idx = pairings.indexOf(p);
                      return <PairingPill key={`${p.namId}-${p.amId}`} pairing={p} idx={idx} label={p.amName} />;
                    })}
                  </div>
                  {selectedPairing && selectedPairing.section === "my_reports" && (
                    <SessionView pairing={selectedPairing} teamMembers={teamMembers} />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Admin view — their NAMs first, then team pairings grouped by NAM */}
          {isAdmin && (
            <div className="space-y-4" data-testid="pairing-selector">
              {/* Direct NAM pairings */}
              {adminNamPairings.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-indigo-500" />
                    Your Direct 1:1s
                  </p>
                  <div className="flex gap-1 flex-wrap mb-2">
                    {adminNamPairings.map((p) => {
                      const idx = pairings.indexOf(p);
                      return <PairingPill key={`${p.namId}-${p.amId}`} pairing={p} idx={idx} label={p.amName} />;
                    })}
                  </div>
                  {selectedPairing && selectedPairing.section === "my_nams" && (
                    <SessionView pairing={selectedPairing} teamMembers={teamMembers} />
                  )}
                </div>
              )}

              {/* Divider */}
              {adminNamPairings.length > 0 && Object.keys(teamByNam).length > 0 && (
                <div className="border-t border-dashed border-border" />
              )}

              {/* Team 1:1s grouped by NAM */}
              {Object.entries(teamByNam).map(([namName, namPairings]) => (
                <div key={namName}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    {namName}&apos;s Team
                  </p>
                  <div className="flex gap-1 flex-wrap mb-2">
                    {namPairings.map((p) => {
                      const idx = pairings.indexOf(p);
                      return <PairingPill key={`${p.namId}-${p.amId}`} pairing={p} idx={idx} label={p.amName} />;
                    })}
                  </div>
                  {selectedPairing && selectedPairing.section === "team" && selectedPairing.namId === namPairings[0]?.namId &&
                    namPairings.some(p => p.amId === selectedPairing.amId) && (
                    <SessionView pairing={selectedPairing} teamMembers={teamMembers} />
                  )}
                </div>
              ))}
            </div>
          )}

        </CardContent>
      )}
    </Card>
  );
}
