import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, fileToBase64, type PendingFile } from "@/components/file-attachment";
import { Lock, Send, Trash2, ChevronDown, ChevronUp, Reply, MessageSquare } from "lucide-react";
import type { User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

type InternalPost = {
  id: string;
  content: string;
  authorId: string;
  recipientIds: string[];
  parentId: string | null;
  createdAt: string;
};

// Preset recipient options — matched by first name (case-insensitive)
const PRESET_OPTIONS = [
  { key: "jordan",     label: "Jordan",        names: ["jordan"] },
  { key: "danny",      label: "Danny",          names: ["danny"] },
  { key: "sam",        label: "Sam",            names: ["sam"] },
  { key: "sam_danny",  label: "Sam & Danny",    names: ["sam", "danny"] },
] as const;
type PresetKey = typeof PRESET_OPTIONS[number]["key"];

function formatTimeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function InternalCommsPortlet() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const isLeadership = currentUser?.role === "admin" || currentUser?.role === "director";

  const [content, setContent] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<PresetKey | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [replyPendingFiles, setReplyPendingFiles] = useState<PendingFile[]>([]);

  const { data: rawPosts = [] } = useQuery<InternalPost[]>({
    queryKey: ["/api/internal-posts"],
    refetchInterval: 120000,
    enabled: isLeadership,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
    enabled: isLeadership,
  });

  // Must be after all hooks
  if (!isLeadership) return null;

  const topLevel = rawPosts.filter(p => !p.parentId);
  const repliesFor = (parentId: string) => rawPosts.filter(p => p.parentId === parentId);

  const getUserName = (id: string) => teamMembers.find(u => u.id === id)?.name ?? "Unknown";

  // Resolve preset → user IDs from team members by first name match
  const resolveIds = (preset: PresetKey): string[] => {
    const option = PRESET_OPTIONS.find(o => o.key === preset);
    if (!option) return [];
    return teamMembers
      .filter(u => option.names.some(n => u.name.toLowerCase().split(" ")[0] === n))
      .map(u => u.id);
  };

  const presetLabel = (post: InternalPost): string => {
    const names = post.recipientIds
      .map(id => teamMembers.find(u => u.id === id)?.name?.split(" ")[0] ?? "?")
      .join(" & ");
    return names || "All";
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPreset) throw new Error("No recipient selected");
      const recipientIds = resolveIds(selectedPreset);
      const res = await apiRequest("POST", "/api/internal-posts", { content, recipientIds });
      const post = await res.json();
      if (pendingFiles.length > 0) {
        await uploadPendingFiles(pendingFiles, "internal_post", post.id);
      }
      return post;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal-posts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setContent("");
      setSelectedPreset(null);
      setPendingFiles([]);
      toast({ title: "Message sent" });
    },
    onError: () => toast({ title: "Failed to send message", variant: "destructive" }),
  });

  const replyMutation = useMutation({
    mutationFn: async (parentId: string) => {
      const res = await apiRequest("POST", "/api/internal-posts", {
        content: replyContent,
        recipientIds: [],
        parentId,
      });
      const post = await res.json();
      if (replyPendingFiles.length > 0) {
        await uploadPendingFiles(replyPendingFiles, "internal_post", post.id);
      }
      return { post, parentId };
    },
    onSuccess: ({ parentId }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal-posts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setReplyContent("");
      setReplyPendingFiles([]);
      setReplyingTo(null);
      setExpandedThreads(prev => new Set([...prev, parentId]));
    },
    onError: () => toast({ title: "Failed to post reply", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/internal-posts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal-posts"] });
      toast({ title: "Message deleted" });
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>, isReply = false) => {
    const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    const results: PendingFile[] = [];
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
      const base64 = await fileToBase64(named);
      results.push({ file: named, base64 });
    }
    if (results.length > 0) {
      if (isReply) setReplyPendingFiles(prev => [...prev, ...results]);
      else setPendingFiles(prev => [...prev, ...results]);
    }
  }, []);

  const toggleThread = (id: string) =>
    setExpandedThreads(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Card data-testid="card-internal-comms">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Lock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          Leadership Callouts
          {topLevel.length > 0 && (
            <Badge variant="secondary" className="ml-1 font-normal">{topLevel.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Composer */}
        <div className="relative">
          {/* Recipient pill selector */}
          <div className="flex gap-1.5 mb-2 flex-wrap">
            {PRESET_OPTIONS.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSelectedPreset(selectedPreset === opt.key ? null : opt.key)}
                data-testid={`button-recipient-${opt.key}`}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  selectedPreset === opt.key
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-transparent border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <Textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            onPaste={e => handlePaste(e, false)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (content.trim() && selectedPreset) createMutation.mutate();
              }
            }}
            placeholder={
              selectedPreset
                ? `Write a callout to ${PRESET_OPTIONS.find(o => o.key === selectedPreset)?.label}… (Ctrl+Enter to send)`
                : "Select a recipient above, then write your callout…"
            }
            className="resize-none text-sm min-h-[72px]"
            data-testid="textarea-internal-post"
          />

          <div className="flex items-center justify-between mt-1.5">
            <FileAttachmentUpload
              pendingFiles={pendingFiles}
              onAdd={files => setPendingFiles(prev => [...prev, ...files])}
              onRemove={i => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
              compact
            />
            <Button
              size="sm"
              className="gap-1"
              onClick={() => createMutation.mutate()}
              disabled={!content.trim() || !selectedPreset || createMutation.isPending}
              data-testid="button-send-internal-post"
            >
              <Send className="h-3 w-3" />
              Post
            </Button>
          </div>
        </div>

        {/* Posts */}
        {topLevel.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-2 italic">No callouts yet.</p>
        ) : (
          <div className="space-y-2">
            {topLevel.map(post => {
              const replies = repliesFor(post.id);
              const isExpanded = expandedThreads.has(post.id);
              const isReplying = replyingTo === post.id;
              const recipientLabel = presetLabel(post);

              return (
                <div key={post.id} className="rounded-lg border border-border/50 bg-card" data-testid={`internal-post-${post.id}`}>
                  <div className="flex items-start gap-3 p-3 group">
                    <Lock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      {/* Recipients badge */}
                      {post.recipientIds.length > 0 && (
                        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium mb-1">
                          → {recipientLabel}
                        </span>
                      )}
                      <p className="text-sm text-foreground whitespace-pre-wrap break-words">{post.content}</p>
                      <FileAttachmentList entityType="internal_post" entityIds={[post.id]} />
                      <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground flex-wrap">
                        <span className="font-medium text-foreground/80">{getUserName(post.authorId)}</span>
                        <span className="opacity-40">·</span>
                        <span>{formatTimeAgo(post.createdAt)}</span>
                        <button
                          onClick={() => { setReplyingTo(isReplying ? null : post.id); setReplyContent(""); }}
                          className="ml-auto flex items-center gap-1 hover:text-primary transition-colors"
                          data-testid={`button-reply-${post.id}`}
                        >
                          <Reply className="h-3 w-3" />
                          {replies.length > 0 ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : "Reply"}
                        </button>
                        {replies.length > 0 && (
                          <button
                            onClick={() => toggleThread(post.id)}
                            className="flex items-center gap-1 hover:text-foreground transition-colors"
                            data-testid={`button-expand-${post.id}`}
                          >
                            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteMutation.mutate(post.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 p-1"
                      title="Delete"
                      data-testid={`button-delete-${post.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Expanded replies */}
                  {isExpanded && replies.length > 0 && (
                    <div className="border-t border-border/50 divide-y divide-border/30">
                      {replies.map(reply => (
                        <div key={reply.id} className="flex items-start gap-2 px-3 py-2.5 pl-9 group bg-muted/20" data-testid={`internal-reply-${reply.id}`}>
                          <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground whitespace-pre-wrap break-words">{reply.content}</p>
                            <FileAttachmentList entityType="internal_post" entityIds={[reply.id]} />
                            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground/80">{getUserName(reply.authorId)}</span>
                              <span className="opacity-40">·</span>
                              <span>{formatTimeAgo(reply.createdAt)}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => deleteMutation.mutate(reply.id)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 p-1"
                            data-testid={`button-delete-reply-${reply.id}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply composer */}
                  {isReplying && (
                    <div className="border-t border-border/50 p-3 pl-9 space-y-2 bg-muted/10">
                      <Textarea
                        value={replyContent}
                        onChange={e => setReplyContent(e.target.value)}
                        onPaste={e => handlePaste(e, true)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            if (replyContent.trim()) replyMutation.mutate(post.id);
                          }
                        }}
                        placeholder="Write a reply… (Ctrl+Enter to send)"
                        className="resize-none text-sm min-h-[56px]"
                        data-testid={`textarea-reply-${post.id}`}
                        autoFocus
                      />
                      <div className="flex items-center justify-between">
                        <FileAttachmentUpload
                          pendingFiles={replyPendingFiles}
                          onAdd={files => setReplyPendingFiles(prev => [...prev, ...files])}
                          onRemove={i => setReplyPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                          compact
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setReplyingTo(null); setReplyContent(""); setReplyPendingFiles([]); }}
                            data-testid="button-cancel-reply"
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="gap-1"
                            onClick={() => replyMutation.mutate(post.id)}
                            disabled={!replyContent.trim() || replyMutation.isPending}
                            data-testid="button-submit-reply"
                          >
                            <Send className="h-3 w-3" />
                            Reply
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
