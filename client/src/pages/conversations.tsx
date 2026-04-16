import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { QueryError } from "@/components/query-error";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Clock, AlertTriangle, User, Users, MessageSquare, CheckCircle2, Sparkles, X, Mail, ArrowUpRight, ArrowDownLeft, ChevronRight, PenLine, Check, Loader2, Archive, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DraftEmailModal } from "@/components/DraftEmailModal";

interface ConversationThread {
  id: string;
  orgId: string;
  threadId: string;
  linkedAccountId: string | null;
  linkedCarrierId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingState: "waiting_on_us" | "waiting_on_them" | "resolved" | "archived";
  responsePriority: "high" | "normal" | "low" | "urgent";
  lastMessageId: string | null;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  waitingSinceAt: string | null;
  overdueAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadsResponse {
  count: number;
  threads: ConversationThread[];
  nextCursor: string | null;
}

interface EmailMessage {
  id: string;
  threadId: string;
  direction: string;
  fromEmail: string | null;
  toEmail: string | null;
  ccEmail: string | null;
  subject: string | null;
  body: string | null;
  createdAt: string;
}

function stripHtmlToText(input: string | null): string {
  if (!input) return "";
  const noStyle = input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const noTags = noStyle.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z0-9#]+;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

function looksLikeHtml(input: string | null): boolean {
  if (!input) return false;
  return /<\/?(html|body|head|div|span|table|p|br|a|img|style|meta)\b/i.test(input);
}

function EmailBody({ body, testId }: { body: string | null; testId: string }) {
  if (!body) return null;
  if (!looksLikeHtml(body)) {
    return (
      <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed" data-testid={testId}>
        {body}
      </div>
    );
  }
  const srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:inherit;line-height:1.5;word-wrap:break-word;overflow-wrap:break-word;}img{max-width:100%;height:auto;}table{max-width:100%;}a{color:#2563eb;}</style></head><body>${body}</body></html>`;
  return (
    <iframe
      title="email-body"
      srcDoc={srcdoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full border-0 bg-white dark:bg-zinc-50 rounded"
      style={{ minHeight: "300px", height: "60vh" }}
      data-testid={testId}
    />
  );
}

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function WaitingStateBadge({ state, overdue }: { state: ConversationThread["waitingState"]; overdue: boolean }) {
  if (state === "waiting_on_us") {
    return (
      <Badge
        className={cn(
          "text-xs font-medium",
          overdue
            ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200 border-red-300 dark:border-red-800"
            : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300 dark:border-amber-800"
        )}
        data-testid="badge-waiting-state"
      >
        {overdue && <AlertTriangle className="w-3 h-3 mr-1" />}
        Waiting on us
      </Badge>
    );
  }
  if (state === "waiting_on_them") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 border-blue-300 dark:border-blue-800 text-xs" data-testid="badge-waiting-state">
        Waiting on them
      </Badge>
    );
  }
  if (state === "archived") {
    return (
      <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-700 text-xs" data-testid="badge-waiting-state">
        <Archive className="w-3 h-3 mr-1" />
        Archived
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 border-green-300 dark:border-green-800 text-xs" data-testid="badge-waiting-state">
      <CheckCircle2 className="w-3 h-3 mr-1" />
      Resolved
    </Badge>
  );
}

function PriorityDot({ priority }: { priority: ConversationThread["responsePriority"] }) {
  const colors: Record<string, string> = {
    urgent: "bg-red-600",
    high: "bg-red-500",
    normal: "bg-gray-400",
    low: "bg-blue-300",
  };
  const labels: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-priority">
      <span className={cn("inline-block w-2 h-2 rounded-full", colors[priority] ?? "bg-gray-400")} />
      {labels[priority] ?? priority}
    </span>
  );
}

function ThreadDetailPanel({
  thread,
  onClose,
}: {
  thread: ConversationThread;
  onClose: () => void;
}) {
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const [correctionMsg, setCorrectionMsg] = useState<EmailMessage | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const [correctionNotes, setCorrectionNotes] = useState("");
  const { toast } = useToast();
  const { user } = useAuth();

  const canCorrect = user && ["admin", "sales_director", "director"].includes(user.role);

  const { data: correctionsData } = useQuery<{ corrections: { emailMessageId: string }[] }>({
    queryKey: ["/api/email-corrections", { threadId: thread.threadId }],
    queryFn: async () => {
      const res = await fetch(`/api/email-corrections?threadId=${encodeURIComponent(thread.threadId)}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
  const correctedMessageIds = new Set((correctionsData?.corrections ?? []).map(c => c.emailMessageId));

  const correctionMutation = useMutation({
    mutationFn: async (params: { emailMessageId: string; originalText: string; correctedText: string; correctionNotes?: string; subject?: string }) => {
      const res = await apiRequest("POST", "/api/email-corrections", {
        emailMessageId: params.emailMessageId,
        originalText: params.originalText,
        correctedText: params.correctedText,
        correctionNotes: params.correctionNotes || undefined,
        threadId: thread.threadId,
        accountId: thread.linkedAccountId || undefined,
        carrierId: thread.linkedCarrierId || undefined,
        subject: params.subject || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Correction saved", description: "AI will learn from this in future drafts." });
      setCorrectionMsg(null);
      setCorrectedText("");
      setCorrectionNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/email-corrections"] });
    },
    onError: () => {
      toast({ title: "Failed to save correction", variant: "destructive" });
    },
  });

  const { data, isLoading } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${thread.id}/messages`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
  });

  const messages = data?.messages ?? [];
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";
  const subject = messages[0]?.subject ?? thread.threadId;

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="thread-detail-panel">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-background border-l shadow-2xl flex flex-col animate-in slide-in-from-right-full duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30">
          <div className="flex-1 min-w-0 mr-4">
            <h2 className="text-base font-semibold truncate" data-testid="text-thread-subject">{subject}</h2>
            <div className="flex items-center gap-2 mt-1">
              <WaitingStateBadge state={thread.waitingState} overdue={isOverdue} />
              <PriorityDot priority={thread.responsePriority} />
              {thread.ownerName && (
                <span className="text-xs text-muted-foreground">
                  <User className="w-3 h-3 inline mr-1" />{thread.ownerName}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              className="gap-1"
              onClick={() => setShowDraftEmail(true)}
              data-testid="button-draft-reply"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Draft Reply
            </Button>
            <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-detail">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" data-testid="messages-container">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <Mail className="w-8 h-8" />
              <p className="font-medium">No messages found</p>
              <p className="text-sm">This thread has no associated email messages yet.</p>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isOutbound = msg.direction === "outbound";
              return (
                <div
                  key={msg.id}
                  className={cn(
                    "rounded-lg border p-4",
                    isOutbound
                      ? "bg-indigo-50/60 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-900/50 ml-6"
                      : "bg-white dark:bg-muted/30 border-border mr-6"
                  )}
                  data-testid={`message-${msg.id}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
                        isOutbound
                          ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
                          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                      )}>
                        {isOutbound ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                        {isOutbound ? "Sent" : "Received"}
                      </span>
                      <span className="text-xs text-muted-foreground font-medium" data-testid={`text-from-${msg.id}`}>
                        {msg.fromEmail}
                      </span>
                      {isOutbound && correctedMessageIds.has(msg.id) && (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid={`badge-corrected-${msg.id}`}>
                          <Check className="w-3 h-3" />
                          Corrected
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isOutbound && canCorrect && !correctedMessageIds.has(msg.id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-amber-600"
                          title="Correct this email — teach AI what should have been said"
                          onClick={() => {
                            setCorrectionMsg(msg);
                            setCorrectedText(msg.body || "");
                            setCorrectionNotes("");
                          }}
                          data-testid={`button-correct-${msg.id}`}
                        >
                          <PenLine className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <span className="text-xs text-muted-foreground" data-testid={`text-date-${msg.id}`}>
                        {formatDate(msg.createdAt)}
                      </span>
                    </div>
                  </div>
                  {msg.toEmail && (
                    <div className="text-xs text-muted-foreground mb-2">
                      To: {msg.toEmail}
                    </div>
                  )}
                  <EmailBody body={msg.body} testId={`text-body-${msg.id}`} />
                </div>
              );
            })
          )}
        </div>

        {showDraftEmail && (
          <DraftEmailModal
            open={showDraftEmail}
            onClose={() => setShowDraftEmail(false)}
            accountId={thread.linkedAccountId}
            threadId={thread.threadId}
            defaultPlayType={thread.linkedCarrierId ? "carrier_capacity" : "check_in"}
          />
        )}

        <Dialog open={!!correctionMsg} onOpenChange={(open) => { if (!open) setCorrectionMsg(null); }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="correction-modal">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <PenLine className="w-5 h-5 text-amber-600" />
                Correct Sent Email
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Edit what we should have said. AI will learn from this correction for future drafts.
              </p>
            </DialogHeader>

            {correctionMsg && (
              <div className="space-y-4 mt-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Original (what was sent)
                  </label>
                  <div className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto" data-testid="text-original-email">
                    {stripHtmlToText(correctionMsg.body) || correctionMsg.body}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Corrected version (what we should have said)
                  </label>
                  <Textarea
                    value={correctedText}
                    onChange={(e) => setCorrectedText(e.target.value)}
                    className="min-h-[140px] text-sm"
                    placeholder="Rewrite the email the way it should have been sent..."
                    data-testid="textarea-corrected"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Coaching notes (optional)
                  </label>
                  <Textarea
                    value={correctionNotes}
                    onChange={(e) => setCorrectionNotes(e.target.value)}
                    className="h-16 text-sm resize-none"
                    placeholder="Why is this better? (e.g., 'too aggressive on pricing', 'should have referenced the service issue first')"
                    data-testid="textarea-correction-notes"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCorrectionMsg(null)}
                    data-testid="button-cancel-correction"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={correctionMutation.isPending || correctedText.trim() === (correctionMsg.body || "").trim()}
                    onClick={() => {
                      correctionMutation.mutate({
                        emailMessageId: correctionMsg.id,
                        originalText: correctionMsg.body || "",
                        correctedText: correctedText.trim(),
                        correctionNotes: correctionNotes.trim() || undefined,
                        subject: correctionMsg.subject || undefined,
                      });
                    }}
                    data-testid="button-submit-correction"
                  >
                    {correctionMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    Save Correction
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  onAssignToMe,
  onChangeState,
  onArchive,
  onSelect,
  isSelected,
}: {
  thread: ConversationThread;
  onAssignToMe: (id: string) => void;
  onChangeState: (id: string, state: ConversationThread["waitingState"]) => void;
  onArchive?: (id: string) => void;
  onSelect: (thread: ConversationThread) => void;
  isSelected: boolean;
}) {
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const isOverdue = !!thread.overdueAt && thread.waitingState === "waiting_on_us";

  const { data: msgData } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${thread.id}/messages`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    staleTime: 60_000,
  });

  const firstMsg = msgData?.messages?.[0];
  const msgCount = msgData?.messages?.length ?? 0;
  const displaySubject = firstMsg?.subject ?? thread.threadId.slice(0, 24) + "…";
  const lastMsg = msgData?.messages?.[msgData.messages.length - 1];
  const previewBody = stripHtmlToText(lastMsg?.body ?? "").slice(0, 120);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-4 px-4 py-3 border-b last:border-0 hover:bg-muted/40 transition-colors cursor-pointer",
          isOverdue && "bg-red-50/50 dark:bg-red-950/20",
          isSelected && "bg-muted/60 dark:bg-muted/40"
        )}
        onClick={() => onSelect(thread)}
        data-testid={`row-conversation-${thread.id}`}
      >
        <PriorityDot priority={thread.responsePriority} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-foreground truncate" data-testid={`text-thread-id-${thread.id}`}>
              {displaySubject}
            </span>
            <WaitingStateBadge state={thread.waitingState} overdue={isOverdue} />
            {isOverdue && (
              <Badge className="text-xs bg-red-600 text-white" data-testid={`badge-overdue-${thread.id}`}>
                Overdue
              </Badge>
            )}
            {msgCount > 0 && (
              <Badge variant="outline" className="text-xs">{msgCount} msg{msgCount !== 1 ? "s" : ""}</Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {thread.linkedAccountId && (
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" /> Account
              </span>
            )}
            {thread.linkedCarrierId && (
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" /> Carrier
              </span>
            )}
            {thread.waitingSinceAt && thread.waitingState === "waiting_on_us" && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Clock className="w-3 h-3" />
                Since {formatAgo(thread.waitingSinceAt)}
              </span>
            )}
            <span>Updated {formatAgo(thread.updatedAt)}</span>
          </div>
          {previewBody && (
            <p className="text-xs text-muted-foreground mt-1 truncate max-w-xl italic">
              {previewBody}{previewBody.length >= 120 ? "…" : ""}
            </p>
          )}
        </div>

        <div className="text-sm text-muted-foreground min-w-24 text-right" data-testid={`text-owner-${thread.id}`}>
          {thread.ownerName ? (
            <span className="font-medium text-foreground">{thread.ownerName}</span>
          ) : (
            <span className="italic text-muted-foreground">Unowned</span>
          )}
        </div>

        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {!thread.ownerName && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onAssignToMe(thread.id)}
              data-testid={`button-assign-me-${thread.id}`}
            >
              Assign to me
            </Button>
          )}
          {thread.waitingState !== "resolved" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChangeState(thread.id, "resolved")}
              data-testid={`button-resolve-${thread.id}`}
            >
              Resolve
            </Button>
          )}
          {thread.waitingState === "resolved" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChangeState(thread.id, "waiting_on_us")}
              data-testid={`button-reopen-${thread.id}`}
            >
              Reopen
            </Button>
          )}
          {thread.waitingState === "resolved" && onArchive && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1"
              onClick={() => onArchive(thread.id)}
              data-testid={`button-archive-${thread.id}`}
            >
              <Archive className="w-3 h-3" />
              Archive
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1 text-indigo-600 dark:text-indigo-400"
            onClick={() => setShowDraftEmail(true)}
            data-testid={`button-draft-email-thread-${thread.id}`}
          >
            <Sparkles className="w-3 h-3" />
            Draft
          </Button>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </div>

        {showDraftEmail && (
          <DraftEmailModal
            open={showDraftEmail}
            onClose={() => setShowDraftEmail(false)}
            accountId={thread.linkedAccountId}
            threadId={thread.threadId}
            defaultPlayType={thread.linkedCarrierId ? "carrier_capacity" : "check_in"}
          />
        )}
      </div>
    </>
  );
}

export default function ConversationsPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<"mine" | "unowned" | "high_priority" | "all" | "archived">("mine");
  const [filterState, setFilterState] = useState<string>("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ConversationThread | null>(null);
  const [allThreads, setAllThreads] = useState<ConversationThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveDateFrom, setArchiveDateFrom] = useState("");
  const [archiveDateTo, setArchiveDateTo] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(archiveSearch), 400);
    return () => clearTimeout(timer);
  }, [archiveSearch]);

  function buildParams(cursorParam?: string): string {
    const p = new URLSearchParams();
    p.set("limit", "50");
    if (activeTab === "mine" && user?.id) {
      p.set("ownerUserId", user.id);
      p.set("waitingState", "waiting_on_us");
    } else if (activeTab === "unowned") {
      p.set("unowned", "true");
      p.set("waitingState", "waiting_on_us");
    } else if (activeTab === "high_priority") {
      p.set("responsePriority", "high");
      p.set("waitingState", "waiting_on_us");
    } else if (activeTab === "archived") {
      p.set("archived", "true");
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (archiveDateFrom) p.set("dateFrom", archiveDateFrom);
      if (archiveDateTo) p.set("dateTo", archiveDateTo);
    } else {
      if (filterState !== "all") p.set("waitingState", filterState);
      if (filterPriority !== "all") p.set("responsePriority", filterPriority);
      if (filterOverdue) p.set("overdue", "true");
    }
    if (cursorParam) p.set("cursor", cursorParam);
    return p.toString();
  }

  const { data, isLoading, isError, refetch } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", activeTab, filterState, filterPriority, filterOverdue, debouncedSearch, archiveDateFrom, archiveDateTo],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?${buildParams()}`);
      if (!res.ok) throw new Error("Failed to fetch conversations");
      const json = await res.json();
      setAllThreads(json.threads);
      setNextCursor(json.nextCursor);
      return json;
    },
  });

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      if (!nextCursor) return null;
      const res = await fetch(`/api/internal/conversations?${buildParams(nextCursor)}`);
      if (!res.ok) throw new Error("Failed to load more");
      return res.json() as Promise<ThreadsResponse>;
    },
    onSuccess: (result) => {
      if (result) {
        setAllThreads(prev => [...prev, ...result.threads]);
        setNextCursor(result.nextCursor);
      }
    },
    onError: () => toast({ title: "Failed to load more conversations", variant: "destructive" }),
  });

  const { data: mineData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "mine-count", user?.id],
    queryFn: async () => {
      const p = new URLSearchParams({ waitingState: "waiting_on_us", limit: "1" });
      if (user?.id) p.set("ownerUserId", user.id);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!user?.id,
  });

  const { data: unownedData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "unowned-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?unowned=true&waitingState=waiting_on_us&limit=1");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const { data: highPriData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "high-priority-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?responsePriority=high&waitingState=waiting_on_us&limit=1");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const assignToMeMutation = useMutation({
    mutationFn: async (threadId: string) => {
      if (!user?.id) throw new Error("Not logged in");
      return apiRequest("POST", `/api/internal/conversations/${threadId}/owner`, { ownerUserId: user.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation assigned to you" });
    },
    onError: () => toast({ title: "Failed to assign conversation", variant: "destructive" }),
  });

  const changeStateMutation = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: ConversationThread["waitingState"] }) => {
      return apiRequest("POST", `/api/internal/conversations/${id}/waiting-state`, { waitingState: state });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation updated" });
    },
    onError: () => toast({ title: "Failed to update conversation", variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: async (threadId: string) => {
      return apiRequest("POST", `/api/internal/conversations/${threadId}/archive`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation archived" });
    },
    onError: () => toast({ title: "Failed to archive conversation", variant: "destructive" }),
  });

  const threads = allThreads;

  const sorted = [...threads].sort((a, b) => {
    if (activeTab === "archived") {
      const aDate = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
      const bDate = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
      return bDate - aDate;
    }
    const aOverdue = !!a.overdueAt;
    const bOverdue = !!b.overdueAt;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.waitingSinceAt && b.waitingSinceAt) {
      return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        <MessageSquare className="w-5 h-5 md:w-6 md:h-6 text-primary" />
        <h1 className="text-xl md:text-2xl font-semibold">Conversations</h1>
        <Badge className="text-xs" data-testid="badge-total-count">{data?.count ?? "—"}</Badge>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => {
        setActiveTab(v as typeof activeTab);
        setAllThreads([]);
        setNextCursor(null);
      }}>
        <TabsList className="mb-4 flex md:inline-flex overflow-x-auto no-scrollbar w-full md:w-auto" data-testid="tabs-quick-views">
          <TabsTrigger value="mine" data-testid="tab-waiting-on-me">
            Waiting on me
            {(mineData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs bg-amber-600 text-white">{mineData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="unowned" data-testid="tab-unowned">
            Unowned
            {(unownedData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs">{unownedData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="high_priority" data-testid="tab-high-priority">
            High priority
            {(highPriData?.count ?? 0) > 0 && (
              <Badge className="ml-2 text-xs bg-red-600 text-white">{highPriData?.count}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
          <TabsTrigger value="archived" data-testid="tab-archived">
            <Archive className="w-3.5 h-3.5 mr-1" />
            Archived
          </TabsTrigger>
        </TabsList>

        {activeTab === "all" && (
          <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-4" data-testid="filters-container">
            <Select value={filterState} onValueChange={setFilterState}>
              <SelectTrigger className="w-full md:w-44" data-testid="select-filter-state">
                <SelectValue placeholder="Waiting state" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="waiting_on_us">Waiting on us</SelectItem>
                <SelectItem value="waiting_on_them">Waiting on them</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filterPriority} onValueChange={setFilterPriority}>
              <SelectTrigger className="w-full md:w-40" data-testid="select-filter-priority">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant={filterOverdue ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterOverdue(!filterOverdue)}
              data-testid="button-filter-overdue"
            >
              <AlertTriangle className="w-3.5 h-3.5 mr-1" />
              Overdue only
            </Button>
          </div>
        )}

        {activeTab === "archived" && (
          <div className="flex items-center gap-3 mb-4" data-testid="archive-filters-container">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search account, carrier, or subject..."
                value={archiveSearch}
                onChange={(e) => setArchiveSearch(e.target.value)}
                className="pl-9"
                data-testid="input-archive-search"
              />
            </div>
            <Input
              type="date"
              value={archiveDateFrom}
              onChange={(e) => setArchiveDateFrom(e.target.value)}
              className="w-40"
              placeholder="From date"
              data-testid="input-archive-date-from"
            />
            <Input
              type="date"
              value={archiveDateTo}
              onChange={(e) => setArchiveDateTo(e.target.value)}
              className="w-40"
              placeholder="To date"
              data-testid="input-archive-date-to"
            />
            {(archiveSearch || archiveDateFrom || archiveDateTo) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setArchiveSearch("");
                  setDebouncedSearch("");
                  setArchiveDateFrom("");
                  setArchiveDateTo("");
                }}
                data-testid="button-clear-archive-filters"
              >
                <X className="w-3.5 h-3.5 mr-1" />
                Clear
              </Button>
            )}
          </div>
        )}

        <div className="border rounded-lg overflow-hidden">
          {isError ? (
            <QueryError message="Couldn't load conversations. This is usually temporary." onRetry={() => refetch()} />
          ) : isLoading ? (
            <div className="divide-y">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-4 w-16" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2" data-testid="empty-state">
              {activeTab === "archived" ? <Archive className="w-8 h-8" /> : <CheckCircle2 className="w-8 h-8" />}
              <p className="font-medium">No conversations found</p>
              <p className="text-sm">
                {activeTab === "mine"
                  ? "You have no conversations waiting on you."
                  : activeTab === "unowned"
                  ? "All conversations have an assigned owner."
                  : activeTab === "archived"
                  ? "No archived conversations match the selected filters."
                  : "No conversations match the selected filters."}
              </p>
            </div>
          ) : (
            <div className="divide-y" data-testid="conversation-list">
              {sorted.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  onAssignToMe={(id) => assignToMeMutation.mutate(id)}
                  onChangeState={(id, state) => changeStateMutation.mutate({ id, state })}
                  onArchive={(id) => archiveMutation.mutate(id)}
                  onSelect={(t) => setSelectedThread(t)}
                  isSelected={selectedThread?.id === thread.id}
                />
              ))}
            </div>
          )}
        </div>

        {nextCursor && (
          <div className="flex justify-center mt-4">
            <Button
              variant="outline"
              onClick={() => loadMoreMutation.mutate()}
              disabled={loadMoreMutation.isPending}
              data-testid="button-load-more"
            >
              {loadMoreMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Load more
            </Button>
          </div>
        )}
      </Tabs>

      {selectedThread && (
        <ThreadDetailPanel
          thread={selectedThread}
          onClose={() => setSelectedThread(null)}
        />
      )}
    </div>
  );
}
