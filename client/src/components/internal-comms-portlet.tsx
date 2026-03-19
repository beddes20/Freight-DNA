import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, fileToBase64, type PendingFile } from "@/components/file-attachment";
import {
  MessageSquare, Send, Trash2, ChevronDown, ChevronUp, Lock, Reply, Check, Users,
} from "lucide-react";
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
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [replyPendingFiles, setReplyPendingFiles] = useState<PendingFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: rawPosts = [] } = useQuery<InternalPost[]>({
    queryKey: ["/api/internal-posts"],
    refetchInterval: 120000,
  });

  const { data: teamMembers = [] } = useQuery<SafeUser[]>({
    queryKey: ["/api/team-members"],
  });

  // Eligible recipients: non-admin, non-director team members
  const eligibleRecipients = teamMembers.filter(
    u => u.role !== "admin" && u.role !== "director" && u.id !== currentUser?.id
  );

  const topLevel = rawPosts.filter(p => !p.parentId);
  const repliesFor = (parentId: string) => rawPosts.filter(p => p.parentId === parentId);

  const getUserName = (id: string) => teamMembers.find(u => u.id === id)?.name ?? "Unknown";

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/internal-posts", {
        content,
        recipientIds: selectedRecipients,
      });
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
      setSelectedRecipients([]);
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
      return post;
    },
    onSuccess: (_, parentId) => {
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

  const toggleRecipient = (id: string) => {
    setSelectedRecipients(prev =>
      prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]
    );
  };

  const toggleThread = (id: string) =>
    setExpandedThreads(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Don't render portlet if non-leadership has no posts at all
  if (!isLeadership && topLevel.length === 0) return null;

  return (
    <Card data-testid="card-internal-comms">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Lock className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          Leadership Callouts
          {topLevel.length > 0 && (
            <Badge variant="secondary" className="ml-1 font-normal">{topLevel.length}</Badge>
          )}
          <span className="ml-auto text-[10px] font-normal text-muted-foreground uppercase tracking-wide">Private</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {/* Composer — leadership only */}
        {isLeadership && (
          <div className="space-y-2 rounded-lg border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20 p-3">
            {/* Recipient selector */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setRecipientOpen(o => !o)}
                className="flex items-center gap-2 text-xs border rounded-md px-2.5 py-1.5 w-full bg-background hover:bg-muted transition-colors"
                data-testid="button-recipient-select"
              >
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-left">
                  {selectedRecipients.length === 0
                    ? "Select recipients…"
                    : selectedRecipients.map(id => getUserName(id).split(" ")[0]).join(", ")}
                </span>
                {recipientOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
              {recipientOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto" data-testid="recipient-dropdown">
                  {eligibleRecipients.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-3 py-2">No eligible recipients</p>
                  ) : (
                    eligibleRecipients.map(u => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleRecipient(u.id)}
                        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                        data-testid={`recipient-option-${u.id}`}
                      >
                        <div className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${selectedRecipients.includes(u.id) ? "bg-primary border-primary" : "border-border"}`}>
                          {selectedRecipients.includes(u.id) && <Check className="h-2.5 w-2.5 text-white" />}
                        </div>
                        <span className="font-medium">{u.name}</span>
                        <span className="text-xs text-muted-foreground capitalize ml-auto">{u.role?.replace(/_/g, " ")}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <Textarea
              ref={textareaRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              onPaste={e => handlePaste(e, false)}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (content.trim() && selectedRecipients.length > 0) createMutation.mutate(); } }}
              placeholder="Write a callout to your selected team members… (Ctrl+Enter to send)"
              className="resize-none text-sm min-h-[72px]"
              data-testid="textarea-internal-post"
            />

            <div className="flex items-center justify-between">
              <FileAttachmentUpload
                pendingFiles={pendingFiles}
                onAdd={files => setPendingFiles(prev => [...prev, ...files])}
                onRemove={i => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                compact
              />
              <Button
                size="sm"
                className="gap-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                onClick={() => createMutation.mutate()}
                disabled={!content.trim() || selectedRecipients.length === 0 || createMutation.isPending}
                data-testid="button-send-internal-post"
              >
                <Send className="h-3 w-3" />
                Send
              </Button>
            </div>
          </div>
        )}

        {/* Posts list */}
        {topLevel.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3 italic">
            {isLeadership ? "No callouts yet — send one above." : "No messages for you yet."}
          </p>
        ) : (
          <div className="space-y-2">
            {topLevel.map(post => {
              const replies = repliesFor(post.id);
              const isExpanded = expandedThreads.has(post.id);
              const isReplying = replyingTo === post.id;

              return (
                <div key={post.id} className="rounded-lg border border-border/60 bg-card" data-testid={`internal-post-${post.id}`}>
                  {/* Thread header */}
                  <div className="flex items-start gap-3 p-3 group">
                    <div className="h-7 w-7 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center text-xs font-semibold text-indigo-700 dark:text-indigo-300 shrink-0">
                      {getUserName(post.authorId).charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      {/* Recipients row */}
                      {post.recipientIds.length > 0 && (
                        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">To:</span>
                          {post.recipientIds.map(rid => (
                            <span key={rid} className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium">
                              {getUserName(rid).split(" ")[0]}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-sm text-foreground whitespace-pre-wrap break-words">{post.content}</p>
                      <FileAttachmentList entityType="internal_post" entityIds={[post.id]} />
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground">{getUserName(post.authorId)}</span>
                        <span className="text-xs text-muted-foreground/50">·</span>
                        <span className="text-xs text-muted-foreground">{formatTimeAgo(post.createdAt)}</span>
                        <button
                          onClick={() => { setReplyingTo(isReplying ? null : post.id); setReplyContent(""); }}
                          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                          data-testid={`button-reply-internal-${post.id}`}
                        >
                          <Reply className="h-3 w-3" />
                          {replies.length > 0 ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : "Reply"}
                        </button>
                        {replies.length > 0 && (
                          <button
                            onClick={() => toggleThread(post.id)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            data-testid={`button-expand-thread-${post.id}`}
                          >
                            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                    </div>
                    {isLeadership && (
                      <button
                        onClick={() => deleteMutation.mutate(post.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 p-1"
                        title="Delete callout"
                        data-testid={`button-delete-internal-${post.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Replies */}
                  {isExpanded && replies.length > 0 && (
                    <div className="border-t border-border/50 divide-y divide-border/30">
                      {replies.map(reply => (
                        <div key={reply.id} className="flex items-start gap-2 px-3 py-2.5 pl-8 group bg-muted/20" data-testid={`internal-reply-${reply.id}`}>
                          <MessageSquare className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground whitespace-pre-wrap break-words">{reply.content}</p>
                            <FileAttachmentList entityType="internal_post" entityIds={[reply.id]} />
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs font-medium text-muted-foreground">{getUserName(reply.authorId)}</span>
                              <span className="text-xs text-muted-foreground/50">·</span>
                              <span className="text-xs text-muted-foreground">{formatTimeAgo(reply.createdAt)}</span>
                            </div>
                          </div>
                          {isLeadership && (
                            <button
                              onClick={() => deleteMutation.mutate(reply.id)}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 p-1"
                              data-testid={`button-delete-reply-${reply.id}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply composer */}
                  {isReplying && (
                    <div className="border-t border-border/50 p-3 pl-8 space-y-2 bg-muted/10">
                      <Textarea
                        value={replyContent}
                        onChange={e => setReplyContent(e.target.value)}
                        onPaste={e => handlePaste(e, true)}
                        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (replyContent.trim()) replyMutation.mutate(post.id); } }}
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
                          <Button variant="ghost" size="sm" onClick={() => { setReplyingTo(null); setReplyContent(""); setReplyPendingFiles([]); }} data-testid="button-cancel-reply">
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
