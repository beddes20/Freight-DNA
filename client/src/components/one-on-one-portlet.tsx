import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare, ChevronDown, ChevronRight, Plus, Check,
  Circle, Trash2, Archive, History, Tag,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { OneOnOneSession, OneOnOneTopic, User } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";

type SafeUser = Omit<User, "password">;

interface Pairing {
  namId: string;
  amId: string;
  namName: string;
  amName: string;
}

interface SessionWithTopics {
  session: OneOnOneSession;
  topics: OneOnOneTopic[];
}

interface ArchivedSession extends OneOnOneSession {
  topics: OneOnOneTopic[];
}

const TAG_OPTIONS = ["Action Item", "Question", "FYI", "Follow-up"] as const;

const tagColors: Record<string, string> = {
  "Action Item": "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  "Question": "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  "FYI": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  "Follow-up": "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
};

function TopicRow({ topic, teamMembers, currentUserId }: { topic: OneOnOneTopic; teamMembers: SafeUser[]; currentUserId: string }) {
  const { toast } = useToast();
  const author = teamMembers.find(u => u.id === topic.addedById);
  const initials = author?.name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "?";
  const isNam = author?.role === "national_account_manager" || author?.role === "director" || author?.role === "sales";

  const toggleMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/one-on-one/topics/${topic.id}/toggle`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/one-on-one/topics/${topic.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/one-on-one/session"] });
      toast({ title: "Topic deleted" });
    },
  });

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${topic.status === "discussed" ? "opacity-50" : ""}`}
      data-testid={`topic-row-${topic.id}`}
    >
      <button
        onClick={() => toggleMutation.mutate()}
        className="shrink-0 mt-0.5 hover:scale-110 transition-transform"
        title={topic.status === "discussed" ? "Mark as pending" : "Mark as discussed"}
        data-testid={`button-toggle-topic-${topic.id}`}
      >
        {topic.status === "discussed" ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${topic.status === "discussed" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-topic-${topic.id}`}>
          {topic.text}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap mt-1">
          {topic.tag && (
            <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${tagColors[topic.tag] || "bg-muted text-muted-foreground"}`} data-testid={`badge-topic-tag-${topic.id}`}>
              {topic.tag}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${isNam ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"}`}>
              {initials}
            </span>
            {author?.name || "Unknown"}
          </span>
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
                    key={tag}
                    onClick={() => { setSelectedTag(selectedTag === tag ? null : tag); setShowTagSelector(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors ${selectedTag === tag ? "font-semibold bg-muted" : ""}`}
                    data-testid={`button-tag-${tag}`}
                  >
                    {tag}
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

      {selectedTag && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Tag:</span>
          <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${tagColors[selectedTag]}`}>{selectedTag}</span>
          <button onClick={() => setSelectedTag(null)} className="text-xs text-muted-foreground hover:text-foreground ml-1">×</button>
        </div>
      )}

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
                        {topic.tag && (
                          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${tagColors[topic.tag] || "bg-muted text-muted-foreground"}`}>{topic.tag}</span>
                        )}
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

  const { data: pairings = [], isLoading: pairingsLoading } = useQuery<Pairing[]>({
    queryKey: ["/api/one-on-one/pairings"],
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  const selectedPairing = pairings[selectedPairingIdx];

  const { data: sessionData } = useQuery<SessionWithTopics>({
    queryKey: ["/api/one-on-one/session", selectedPairing?.namId, selectedPairing?.amId],
    queryFn: async () => {
      const res = await fetch(`/api/one-on-one/session?namId=${selectedPairing!.namId}&amId=${selectedPairing!.amId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!selectedPairing,
  });

  const unresolvedCount = sessionData?.topics?.filter(t => t.status === "pending").length || 0;

  const isNam = currentUser?.role === "national_account_manager" || currentUser?.role === "director" || currentUser?.role === "sales";
  const isAdmin = currentUser?.role === "admin";
  const showSelector = (isNam || isAdmin) && pairings.length > 1;

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
            </CardTitle>
          </button>
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="space-y-3">
          {showSelector && (
            <div className="flex gap-1 flex-wrap" data-testid="pairing-selector">
              {pairings.map((p, idx) => {
                const label = isAdmin ? `${p.namName} ↔ ${p.amName}` : p.amName;
                return (
                  <button
                    key={`${p.namId}-${p.amId}`}
                    onClick={() => setSelectedPairingIdx(idx)}
                    className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                      idx === selectedPairingIdx
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-transparent border-border text-muted-foreground hover:border-foreground"
                    }`}
                    data-testid={`button-pairing-${p.namId}-${p.amId}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {!showSelector && selectedPairing && (
            <p className="text-xs text-muted-foreground">
              {currentUser?.role === "account_manager"
                ? `1:1 with ${selectedPairing.namName}`
                : `1:1 with ${selectedPairing.amName}`}
            </p>
          )}

          {selectedPairing && (
            <SessionView pairing={selectedPairing} teamMembers={teamMembers} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
