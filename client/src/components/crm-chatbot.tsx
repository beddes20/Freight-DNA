import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Bot, X, Send, Plus, Trash2, ChevronLeft, MessageSquare, Loader2, Lightbulb, CheckCircle2, Globe, Users, Bug, Wrench, Sparkles, ClipboardList, ExternalLink, Phone, Mail, MessageSquareText, MapPin, Check, AlertTriangle, Star, PanelRight, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useChatPageContext } from "@/hooks/use-chat-page-context";
import { getSuggestedPrompts } from "./dna-copilot/prompts";
import { AnswerCardMeta, type AnswerMeta } from "./dna-copilot/answer-card";
import { DraftEmailCard, OpenQueueCard } from "./dna-copilot/extra-action-cards";

type CopilotMode = "docked" | "side" | "workspace";
const MODE_STORAGE_KEY = "dna-copilot-mode";

type ReportType = "bug" | "improvement" | "feature";

interface Conversation {
  id: number;
  title: string;
  createdAt: string;
}

interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  action?: {
    tool: string;
    args: Record<string, string>;
    confirmed?: boolean;
    failed?: boolean;
  };
  meta?: AnswerMeta;
}

interface NudgesResponse {
  alerts: string[];
  suggestions: string[];
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="text-sm leading-relaxed space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith("- ") || line.startsWith("• ")) {
          return (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 mt-0.5">•</span>
              <span>{line.replace(/^[-•]\s/, "")}</span>
            </div>
          );
        }
        if (line.startsWith("**") && line.endsWith("**")) {
          return <p key={i} className="font-semibold">{line.replace(/\*\*/g, "")}</p>;
        }
        if (line === "") return <div key={i} className="h-1" />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

function TouchpointTypeIcon({ type }: { type: string }) {
  if (type === "call") return <Phone className="h-4 w-4 text-blue-500" />;
  if (type === "email") return <Mail className="h-4 w-4 text-purple-500" />;
  if (type === "text") return <MessageSquareText className="h-4 w-4 text-green-500" />;
  if (type === "site_visit") return <MapPin className="h-4 w-4 text-orange-500" />;
  return <Phone className="h-4 w-4 text-blue-500" />;
}

function ActionCard({
  action,
  onConfirm,
  onDismiss,
}: {
  action: NonNullable<ChatMessage["action"]>;
  onConfirm: (editedArgs: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [editedArgs, setEditedArgs] = useState<Record<string, string>>({ ...action.args });
  const set = (key: string, val: string) => setEditedArgs(prev => ({ ...prev, [key]: val }));

  if (action.tool === "draft_email") {
    return <DraftEmailCard args={action.args} confirmed={action.confirmed} failed={action.failed} onConfirm={onConfirm} onDismiss={onDismiss} />;
  }
  if (action.tool === "open_filtered_queue") {
    return <OpenQueueCard args={action.args} confirmed={action.confirmed} failed={action.failed} onConfirm={onConfirm} onDismiss={onDismiss} />;
  }

  if (action.confirmed) {
    const labels: Record<string, string> = {
      log_touchpoint: "Touchpoint logged!",
      create_task: "Task created!",
      complete_task: "Task marked complete!",
      mark_meaningful: "Marked as meaningful!",
      approve_freight_opportunity: "Freight opportunity approved!",
    };
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
        <Check className="h-3.5 w-3.5" />
        {labels[action.tool] ?? "Done!"}
      </div>
    );
  }
  if (action.failed) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" />
        Action failed. Try again from the main app.
      </div>
    );
  }

  const fieldCls = "w-full mt-0.5 text-xs rounded border bg-background px-2 py-1 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-indigo-400";

  if (action.tool === "log_touchpoint") {
    return (
      <div className="mt-2 border border-blue-200 dark:border-blue-800 rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
          <TouchpointTypeIcon type={editedArgs.type} />
          Log Touchpoint
        </div>
        <div className="space-y-1.5">
          <div>
            <label className="text-xs text-muted-foreground">Type</label>
            <select value={editedArgs.type || "call"} onChange={e => set("type", e.target.value)} className={fieldCls}>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="text">Text</option>
              <option value="site_visit">Site Visit</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Account</label>
            <input type="text" value={editedArgs.company_name || ""} onChange={e => set("company_name", e.target.value)} placeholder="Company name" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Contact (optional)</label>
            <input type="text" value={editedArgs.contact_name || ""} onChange={e => set("contact_name", e.target.value)} placeholder="Contact name" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Note</label>
            <textarea value={editedArgs.note || ""} onChange={e => set("note", e.target.value)} placeholder="Add a note..." rows={2} className={`${fieldCls} resize-none`} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-touchpoint">
            <Check className="h-3.5 w-3.5 mr-1" /> Log it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "create_task") {
    return (
      <div className="mt-2 border border-amber-200 dark:border-amber-800 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <ClipboardList className="h-4 w-4" />
          Create Task
        </div>
        <div className="space-y-1.5">
          <div>
            <label className="text-xs text-muted-foreground">Task</label>
            <input type="text" value={editedArgs.title || ""} onChange={e => set("title", e.target.value)} placeholder="Task title" className={fieldCls} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Due date (optional)</label>
            <input type="date" value={editedArgs.due_date || ""} onChange={e => set("due_date", e.target.value)} className={fieldCls} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-task">
            <Check className="h-3.5 w-3.5 mr-1" /> Create it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "complete_task") {
    return (
      <div className="mt-2 border border-green-200 dark:border-green-800 rounded-xl bg-green-50 dark:bg-green-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-green-700 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          Complete Task
        </div>
        <p className="text-xs font-medium text-foreground">{editedArgs.task_title}</p>
        {editedArgs.due_date && (
          <p className="text-xs text-muted-foreground">Due: {new Date(editedArgs.due_date + "T12:00:00").toLocaleDateString()}</p>
        )}
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-complete-task">
            <Check className="h-3.5 w-3.5 mr-1" /> Mark complete
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "approve_freight_opportunity") {
    return (
      <div className="mt-2 border border-emerald-200 dark:border-emerald-800 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          Approve Freight Opportunity
        </div>
        <div className="text-xs space-y-0.5">
          <p><span className="text-muted-foreground">Account:</span> <span className="font-medium">{editedArgs.company_name}</span></p>
          <p><span className="text-muted-foreground">Lane:</span> {editedArgs.origin} → {editedArgs.destination}</p>
          {editedArgs.pickup && <p><span className="text-muted-foreground">Pickup:</span> {editedArgs.pickup}</p>}
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-approve-freight">
            <Check className="h-3.5 w-3.5 mr-1" /> Approve
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  if (action.tool === "mark_meaningful") {
    const typeLabel = { call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" }[editedArgs.type] ?? editedArgs.type;
    return (
      <div className="mt-2 border border-amber-200 dark:border-amber-800 rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <Star className="h-4 w-4" />
          Mark Meaningful
        </div>
        <div className="text-xs space-y-0.5">
          <p><span className="text-muted-foreground">Account:</span> <span className="font-medium">{editedArgs.company_name}</span></p>
          {editedArgs.type && <p><span className="text-muted-foreground">Type:</span> {typeLabel}</p>}
          {editedArgs.date && <p><span className="text-muted-foreground">Date:</span> {editedArgs.date}</p>}
          {editedArgs.note && <p className="text-muted-foreground italic">"{editedArgs.note.slice(0, 80)}{editedArgs.note.length > 80 ? "..." : ""}"</p>}
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white flex-1" onClick={() => onConfirm(editedArgs)} data-testid="action-confirm-meaningful">
            <Star className="h-3.5 w-3.5 mr-1" /> Mark meaningful
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onDismiss} data-testid="action-dismiss">Dismiss</Button>
        </div>
      </div>
    );
  }

  return null;
}

export function CrmChatbot() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<number | null>(null);
  const [showConvoList, setShowConvoList] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [reportType, setReportType] = useState<ReportType | null>(null);
  const [suggestionText, setSuggestionText] = useState("");
  const [bugPage, setBugPage] = useState("");
  const [bugExpected, setBugExpected] = useState("");
  const [suggestionSent, setSuggestionSent] = useState(false);
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingMeta, setStreamingMeta] = useState<AnswerMeta | null>(null);
  const [progressLine, setProgressLine] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ tool: string; args: Record<string, string> } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [scope, setScope] = useState<"my_team" | "everyone">("my_team");
  const [mode, setMode] = useState<CopilotMode>(() => {
    if (typeof window === "undefined") return "docked";
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    return v === "side" || v === "workspace" ? v : "docked";
  });
  const pageContext = useChatPageContext();
  useEffect(() => {
    try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch {}
  }, [mode]);
  const cycleMode = useCallback(() => {
    setMode((m) => (m === "docked" ? "side" : m === "side" ? "workspace" : "docked"));
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();

  const isAdminOrDirector = user?.role === "admin" || user?.role === "director" || user?.role === "sales_director";
  const showScopeToggle = !isAdminOrDirector && !!user;
  const effectiveScope = user?.role === "admin" ? "everyone" : (isAdminOrDirector ? "my_team" : scope);

  useEffect(() => {
    if (!open || mode !== "docked") return;
    const handler = (e: PointerEvent) => {
      if (
        panelRef.current?.contains(e.target as Node) ||
        toggleRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open, mode]);

  // Load personalized nudges when chatbot opens
  const { data: nudges } = useQuery<NudgesResponse>({
    queryKey: ["/api/chatbot/nudges"],
    enabled: open && !!user,
    staleTime: 5 * 60 * 1000,
  });

  const pagePrompts = useMemo(
    () => getSuggestedPrompts(user?.role, pageContext?.entityType ?? null),
    [user?.role, pageContext?.entityType],
  );
  // Page/role-aware prompts take priority. Server-side nudges still surface as
  // a secondary "alerts" feed in the empty state above this list.
  const SUGGESTIONS = pageContext?.entityType
    ? pagePrompts
    : (nudges?.suggestions?.length ? nudges.suggestions : pagePrompts);

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["/api/chatbot/conversations"],
    enabled: open,
  });

  const { data: messages = [] } = useQuery<ChatMessage[]>({
    queryKey: ["/api/chatbot/conversations", activeConvoId, "messages"],
    queryFn: () => fetch(`/api/chatbot/conversations/${activeConvoId}/messages`, { credentials: "include" }).then(r => r.json()),
    enabled: !!activeConvoId,
  });

  useEffect(() => {
    if (messages.length > 0) setLocalMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (activeConvoId) setLocalMessages([]);
  }, [activeConvoId]);

  const createConvo = useMutation({
    mutationFn: () => apiRequest("POST", "/api/chatbot/conversations", { title: "New Chat" }),
    onSuccess: async (res) => {
      const convo: Conversation = await res.json();
      qc.invalidateQueries({ queryKey: ["/api/chatbot/conversations"] });
      setActiveConvoId(convo.id);
      setLocalMessages([]);
      setShowConvoList(false);
    },
  });

  const deleteConvo = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/chatbot/conversations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chatbot/conversations"] });
      setActiveConvoId(null);
      setLocalMessages([]);
    },
  });

  const submitSuggestion = useMutation({
    mutationFn: (content: string) => apiRequest("POST", "/api/chatbot/suggest", { content }),
    onSuccess: () => {
      setSuggestionSent(true);
    },
  });

  const createTask = useMutation({
    mutationFn: (title: string) => apiRequest("POST", "/api/tasks", { title, dueDate: taskDueDate || null, status: "open" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      setTaskTitle("");
      setTaskDueDate("");
      setShowTaskCreate(false);
      navigate("/tasks");
    },
  });

  const buildSubmitContent = () => {
    if (reportType === "bug") {
      const parts = ["🐛 BUG REPORT"];
      if (bugPage.trim()) parts.push(`Page/Location: ${bugPage.trim()}`);
      parts.push(`What happened: ${suggestionText.trim()}`);
      if (bugExpected.trim()) parts.push(`What was expected: ${bugExpected.trim()}`);
      return parts.join("\n");
    }
    if (reportType === "improvement") return `🔧 IMPROVEMENT REQUEST\n${suggestionText.trim()}`;
    return `✨ FEATURE REQUEST\n${suggestionText.trim()}`;
  };

  const canSubmit = reportType && suggestionText.trim().length > 0;

  const resetSuggest = () => {
    setShowSuggest(false);
    setReportType(null);
    setSuggestionText("");
    setBugPage("");
    setBugExpected("");
    setSuggestionSent(false);
  };

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }, []);

  useEffect(() => { scrollToBottom(); }, [localMessages, streamingContent]);

  // Handle confirming a pending action (log touchpoint or create task)
  const confirmAction = async (msgId: number, action: NonNullable<ChatMessage["action"]>) => {
    try {
      if (action.tool === "log_touchpoint") {
        // Find company + contact by name if provided, then log touchpoint
        const companies = await fetch("/api/companies", { credentials: "include" }).then(r => r.json());
        const matchedCompany = action.args.company_name
          ? companies.find((c: any) => c.name.toLowerCase().includes(action.args.company_name.toLowerCase()))
          : null;

        let contactId: string | null = null;
        if (matchedCompany && action.args.contact_name) {
          const contacts = await fetch(`/api/contacts?companyId=${matchedCompany.id}`, { credentials: "include" }).then(r => r.json());
          const matchedContact = contacts.find((c: any) => c.name.toLowerCase().includes(action.args.contact_name.toLowerCase()));
          if (matchedContact) contactId = matchedContact.id;
        }

        if (!matchedCompany?.id) throw new Error("Company not found — cannot log touchpoint without a valid company");
        await apiRequest("POST", "/api/touch-logs", {
          companyId: matchedCompany.id,
          contactId,
          type: action.args.type || "call",
          notes: action.args.note || "",
          date: new Date().toISOString().slice(0, 10),
          isMeaningful: false,
        });
        invalidateAfterTouchpoint(matchedCompany.id);
        qc.invalidateQueries({ queryKey: ["/api/companies"] });
      } else if (action.tool === "create_task") {
        await apiRequest("POST", "/api/tasks", {
          title: action.args.title,
          dueDate: action.args.due_date || null,
          status: "open",
        });
        qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      } else if (action.tool === "complete_task") {
        if (!action.args.task_id) throw new Error("No task ID");
        await apiRequest("PATCH", `/api/tasks/${action.args.task_id}`, { status: "complete" });
        qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      } else if (action.tool === "mark_meaningful") {
        if (!action.args.touchpoint_id) throw new Error("No touchpoint ID");
        await apiRequest("PATCH", `/api/touchpoints/${action.args.touchpoint_id}`, { isMeaningful: true });
        qc.invalidateQueries({ queryKey: ["/api/touchpoints/today"] });
        qc.invalidateQueries({ queryKey: ["/api/touchpoints"] });
      } else if (action.tool === "approve_freight_opportunity") {
        if (!action.args.opportunity_id) throw new Error("No opportunity ID");
        await apiRequest("POST", `/api/my-procurement/freight-opp/${action.args.opportunity_id}/approve`, { approve: true });
        qc.invalidateQueries({ queryKey: ["/api/freight-opportunities"] });
        qc.invalidateQueries({ queryKey: ["/api/my-procurement"] });
      }
      setLocalMessages(prev => prev.map(m =>
        m.id === msgId && m.action ? { ...m, action: { ...m.action, confirmed: true } } : m
      ));
      setPendingAction(null);
    } catch {
      setLocalMessages(prev => prev.map(m =>
        m.id === msgId && m.action ? { ...m, action: { ...m.action, failed: true } } : m
      ));
    }
  };

  const dismissAction = (msgId: number) => {
    setLocalMessages(prev => prev.map(m =>
      m.id === msgId && m.action ? { ...m, action: { ...m.action, confirmed: true } } : m
    ));
    setPendingAction(null);
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    let convoId = activeConvoId;
    if (!convoId) {
      const res = await apiRequest("POST", "/api/chatbot/conversations", { title: "New Chat" });
      const convo: Conversation = await res.json();
      qc.invalidateQueries({ queryKey: ["/api/chatbot/conversations"] });
      convoId = convo.id;
      setActiveConvoId(convo.id);
    }

    const userMsg: ChatMessage = {
      id: Date.now(),
      conversationId: convoId,
      role: "user",
      content: text.trim(),
      createdAt: new Date().toISOString(),
    };
    setLocalMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);
    setStreamingContent("");
    setStreamingMeta(null);
    setProgressLine(null);
    setPendingAction(null);

    try {
      const response = await fetch(`/api/chatbot/conversations/${convoId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          content: text.trim(),
          scope: effectiveScope,
          pageContext: pageContext || undefined,
        }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      let detectedAction: { tool: string; args: Record<string, string> } | null = null;
      let detectedMeta: AnswerMeta | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.content) {
              full += evt.content;
              setStreamingContent(full);
              setProgressLine(null);
            }
            if (evt.progress) {
              setProgressLine(typeof evt.progress === "string" ? evt.progress : evt.progress.label || null);
            }
            if (evt.meta) {
              detectedMeta = { ...(detectedMeta || {}), ...evt.meta };
              setStreamingMeta(detectedMeta);
            }
            if (evt.action) {
              detectedAction = evt.action;
            }
            if (evt.navigate) {
              navigate(evt.navigate);
            }
            if (evt.done) {
              const assistantMsg: ChatMessage = {
                id: Date.now() + 1,
                conversationId: convoId!,
                role: "assistant",
                content: full,
                createdAt: new Date().toISOString(),
                action: detectedAction || undefined,
                meta: detectedMeta || undefined,
              };
              setLocalMessages((prev) => [...prev, assistantMsg]);
              setStreamingContent("");
              setStreamingMeta(null);
              setProgressLine(null);
              qc.invalidateQueries({ queryKey: ["/api/chatbot/conversations"] });
              qc.invalidateQueries({ queryKey: ["/api/chatbot/conversations", convoId, "messages"] });
            }
          } catch {}
        }
      }
    } catch (err) {
      setLocalMessages((prev) => [...prev, {
        id: Date.now() + 2,
        conversationId: convoId!,
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const allMessages = localMessages;
  const isEmpty = allMessages.length === 0 && !streamingContent;

  return (
    <>
      {/* Floating button */}
      <button
        ref={toggleRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200",
          "bg-primary hover:bg-primary/90 text-primary-foreground",
          open && "scale-90 opacity-80"
        )}
        data-testid="chatbot-toggle"
        data-tour="tour-dna-guru"
      >
        {open ? <X className="h-5 w-5" /> : <Bot className="h-6 w-6" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div ref={panelRef} className={cn(
          "fixed z-50 border bg-background flex flex-col overflow-hidden",
          "animate-in fade-in-0 duration-200",
          mode === "docked" && "bottom-40 right-6 w-[390px] h-[600px] rounded-2xl shadow-2xl border-border/50 slide-in-from-bottom-4",
          mode === "side" && "top-0 right-0 bottom-0 w-[420px] shadow-xl border-l border-border slide-in-from-right-4",
          mode === "workspace" && "inset-4 md:inset-8 rounded-2xl shadow-2xl border-border/50 zoom-in-95",
        )} data-testid={`copilot-panel-${mode}`}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b bg-sidebar text-sidebar-foreground rounded-t-2xl">
            <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-none">DNA Guru</p>
              <p className="text-xs text-sidebar-foreground/70 mt-0.5">
                {isAdminOrDirector ? "Viewing: All Teams" : "Your CRM assistant"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={cycleMode}
                title={`Layout: ${mode} (click to cycle)`}
                data-testid="chatbot-mode-toggle"
              >
                {mode === "docked" ? <PanelRight className="h-4 w-4" /> : mode === "side" ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { setShowTaskCreate((v) => !v); setShowSuggest(false); setShowConvoList(false); }}
                title="Create a task"
                data-testid="chatbot-task-btn"
              >
                <ClipboardList className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { setShowSuggest((v) => !v); setShowConvoList(false); setShowTaskCreate(false); if (showSuggest) { setReportType(null); setSuggestionText(""); setBugPage(""); setBugExpected(""); } }}
                title="Report a bug or suggest a feature"
                data-testid="chatbot-feedback-btn"
              >
                <Lightbulb className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { setShowConvoList((v) => !v); setShowSuggest(false); setShowTaskCreate(false); }}
                title="Chat history"
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => createConvo.mutate()}
                title="New chat"
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { window.location.href = "/valueiq?tab=threads"; }}
                title="Open in ValueIQ"
                data-testid="chatbot-open-valueiq"
              >
                <Sparkles className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Feedback / Report form overlay */}
          {showSuggest && (
            <div className="absolute inset-0 top-[57px] bg-background z-10 flex flex-col rounded-b-2xl">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={resetSuggest}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Lightbulb className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-medium">
                  {reportType === "bug" ? "Report a Bug" : reportType === "improvement" ? "Suggest Improvement" : reportType === "feature" ? "Request a Feature" : "Send Feedback"}
                </span>
                {reportType && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 ml-auto text-xs text-muted-foreground" onClick={() => { setReportType(null); setSuggestionText(""); setBugPage(""); setBugExpected(""); }}>
                    Change
                  </Button>
                )}
              </div>

              {suggestionSent ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-4 px-6 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-500" />
                  <div>
                    <p className="text-sm font-medium">
                      {reportType === "bug" ? "Bug report sent!" : reportType === "improvement" ? "Improvement noted!" : "Feature request sent!"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">A task has been created for the admin team to review.</p>
                  </div>
                  <div className="flex flex-col gap-2 w-full max-w-[200px]">
                    <Button
                      className="w-full bg-primary hover:bg-primary/90 text-primary-foreground gap-2"
                      onClick={() => { resetSuggest(); navigate("/tasks"); setOpen(false); }}
                      data-testid="suggestion-view-tasks-btn"
                    >
                      <ExternalLink className="h-4 w-4" /> View in Tasks
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={resetSuggest}
                      data-testid="suggestion-done-btn"
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : !reportType ? (
                <div className="flex flex-col flex-1 p-4 gap-3">
                  <p className="text-sm text-muted-foreground">What would you like to send?</p>
                  <button
                    onClick={() => setReportType("bug")}
                    className="flex items-start gap-3 p-3.5 rounded-xl border border-border hover:border-red-300 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors text-left"
                    data-testid="feedback-type-bug"
                  >
                    <Bug className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">Report a Bug</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Something isn't working the way it should</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setReportType("improvement")}
                    className="flex items-start gap-3 p-3.5 rounded-xl border border-border hover:border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors text-left"
                    data-testid="feedback-type-improvement"
                  >
                    <Wrench className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">Suggest an Improvement</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Make something that exists work better</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setReportType("feature")}
                    className="flex items-start gap-3 p-3.5 rounded-xl border border-border hover:border-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/20 transition-colors text-left"
                    data-testid="feedback-type-feature"
                  >
                    <Sparkles className="h-5 w-5 text-violet-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">Request a Feature</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Something new that would help your workflow</p>
                    </div>
                  </button>
                </div>
              ) : (
                <div className="flex flex-col flex-1 p-4 gap-3 overflow-y-auto">
                  {reportType === "bug" && (
                    <>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Page or area where it happened <span className="font-normal">(optional)</span></label>
                        <input
                          type="text"
                          placeholder="e.g. Company detail page, RFP upload, Dashboard…"
                          className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                          value={bugPage}
                          onChange={(e) => setBugPage(e.target.value)}
                          data-testid="bug-page-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">What happened? <span className="text-destructive">*</span></label>
                        <Textarea
                          placeholder="Describe what went wrong — be as specific as possible…"
                          className="resize-none text-sm min-h-[90px]"
                          value={suggestionText}
                          onChange={(e) => setSuggestionText(e.target.value)}
                          data-testid="suggestion-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">What did you expect to happen? <span className="font-normal">(optional)</span></label>
                        <Textarea
                          placeholder="e.g. The contact should have saved and appeared in the list…"
                          className="resize-none text-sm min-h-[70px]"
                          value={bugExpected}
                          onChange={(e) => setBugExpected(e.target.value)}
                          data-testid="bug-expected-input"
                        />
                      </div>
                    </>
                  )}

                  {(reportType === "improvement" || reportType === "feature") && (
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        {reportType === "improvement" ? "What would you improve and how?" : "Describe the feature you'd like"} <span className="text-destructive">*</span>
                      </label>
                      <Textarea
                        placeholder={reportType === "improvement"
                          ? "e.g. The contact list would be much easier to use if I could filter by last touch date…"
                          : "e.g. It would be great to export RFP lane data directly to Excel from the RFP detail page…"}
                        className="resize-none text-sm min-h-[160px]"
                        value={suggestionText}
                        onChange={(e) => setSuggestionText(e.target.value)}
                        data-testid="suggestion-input"
                      />
                    </div>
                  )}

                  <Button
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                    disabled={!canSubmit || submitSuggestion.isPending}
                    onClick={() => submitSuggestion.mutate(buildSubmitContent())}
                    data-testid="suggestion-submit"
                  >
                    {submitSuggestion.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending…</>
                    ) : (
                      <><Send className="h-4 w-4 mr-2" /> Send to Admin</>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Quick Task Creation overlay */}
          {showTaskCreate && (
            <div className="absolute inset-0 top-[57px] bg-background z-10 flex flex-col rounded-b-2xl">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setShowTaskCreate(false); setTaskTitle(""); setTaskDueDate(""); }}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <ClipboardList className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Create a Task</span>
              </div>
              <div className="flex flex-col flex-1 p-4 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Task Title <span className="text-destructive">*</span></label>
                  <Textarea
                    placeholder="What needs to get done?"
                    className="resize-none text-sm min-h-[80px]"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    data-testid="chatbot-task-title-input"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Due Date <span className="font-normal">(optional)</span></label>
                  <Input
                    type="date"
                    className="text-sm"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    data-testid="chatbot-task-due-input"
                  />
                </div>
                <Button
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground gap-2"
                  disabled={!taskTitle.trim() || createTask.isPending}
                  onClick={() => createTask.mutate(taskTitle.trim())}
                  data-testid="chatbot-task-submit"
                >
                  {createTask.isPending ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>
                  ) : (
                    <><ClipboardList className="h-4 w-4" /> Create &amp; View Tasks</>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center">Task will be created and you'll be taken to the Tasks page.</p>
              </div>
            </div>
          )}

          {/* Conversation list overlay */}
          {showConvoList && (
            <div className="absolute inset-0 top-[57px] bg-background z-10 flex flex-col rounded-b-2xl">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b">
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setShowConvoList(false)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm font-medium">Chat History</span>
              </div>
              <ScrollArea className="flex-1">
                {conversations.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-8">No conversations yet</p>
                ) : (
                  <div className="divide-y">
                    {conversations.map((c) => (
                      <div
                        key={c.id}
                        className={cn(
                          "flex items-center gap-2 px-4 py-3 hover:bg-muted/50 cursor-pointer group",
                          activeConvoId === c.id && "bg-muted"
                        )}
                        onClick={() => { setActiveConvoId(c.id); setShowConvoList(false); setLocalMessages([]); }}
                      >
                        <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                        <p className="flex-1 text-sm truncate">{c.title}</p>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); deleteConvo.mutate(c.id); }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
              <div className="p-3 border-t">
                <Button className="w-full bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => { createConvo.mutate(); setShowConvoList(false); }}>
                  <Plus className="h-4 w-4 mr-2" /> New Chat
                </Button>
              </div>
            </div>
          )}

          {/* Messages */}
          <ScrollArea className="flex-1" ref={scrollRef as any}>
            <div className="p-4 space-y-4">
              {isEmpty && (
                <div className="space-y-4">
                  {/* Greeting */}
                  <div className="flex gap-3">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[290px]">
                      <p className="text-sm font-medium">
                        Hey{user?.name ? ` ${user.name.split(" ")[0]}` : ""}! I'm DNA Guru.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {pageContext?.entityName
                          ? `I see you're on ${pageContext.entityName}. Ask me anything about it.`
                          : isAdminOrDirector
                            ? "I can see all reps, accounts, and teams."
                            : "I have live access to your CRM data — ask me anything."}
                      </p>
                    </div>
                  </div>

                  {/* Personalized alerts */}
                  {nudges?.alerts && nudges.alerts.length > 0 && (
                    <div className="ml-10 space-y-1.5">
                      {nudges.alerts.map((alert, i) => (
                        <div key={i} className="text-xs px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40 text-amber-800 dark:text-amber-300" data-testid={`guru-alert-${i}`}>
                          {alert}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Suggested prompts */}
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground px-1">Try asking:</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {SUGGESTIONS.map((s) => (
                        <button
                          key={s}
                          onClick={() => sendMessage(s)}
                          className="text-left text-xs px-2.5 py-2 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground leading-snug"
                          data-testid="guru-suggestion-chip"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Action hint */}
                  <p className="text-xs text-muted-foreground px-1 italic">
                    💡 Say "log a call with [contact]" or "create a task" and I'll do it for you.
                  </p>
                </div>
              )}

              {allMessages.map((msg) => (
                <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
                  {msg.role === "assistant" && (
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div className={cn(
                    "rounded-2xl px-3.5 py-2.5",
                    mode === "docked" ? "max-w-[290px]" : "max-w-[80%]",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-sm"
                      : "bg-muted rounded-tl-sm"
                  )}>
                    {msg.role === "assistant"
                      ? (
                        <>
                          <MarkdownText content={msg.content} />
                          {msg.action && (
                            <ActionCard
                              action={msg.action}
                              onConfirm={(editedArgs) => confirmAction(msg.id, { ...msg.action!, args: editedArgs })}
                              onDismiss={() => dismissAction(msg.id)}
                            />
                          )}
                          {msg.meta && (
                            <AnswerCardMeta
                              meta={msg.meta}
                              onFollowUp={(t) => sendMessage(t)}
                              onSource={(href) => navigate(href)}
                            />
                          )}
                        </>
                      )
                      : <p className="text-sm">{msg.content}</p>
                    }
                  </div>
                </div>
              ))}

              {/* Streaming response */}
              {streamingContent && (
                <div className="flex gap-3">
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className={cn("bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5", mode === "docked" ? "max-w-[290px]" : "max-w-[80%]")}>
                    <MarkdownText content={streamingContent} />
                    {streamingMeta && (
                      <AnswerCardMeta
                        meta={streamingMeta}
                        onFollowUp={(t) => sendMessage(t)}
                        onSource={(href) => navigate(href)}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Progressive tool-call loading */}
              {isStreaming && !streamingContent && (
                <div className="flex gap-3">
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-3 flex items-center gap-2 min-w-[120px]">
                    {progressLine ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        <span className="text-xs text-muted-foreground" data-testid="copilot-progress">{progressLine}</span>
                      </>
                    ) : (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Scope toggle for NAM / AM */}
          {showScopeToggle && (
            <div className="px-3 pt-2 pb-0 flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Viewing:</span>
              <button
                onClick={() => setScope("my_team")}
                className={cn(
                  "flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors",
                  scope === "my_team"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                )}
                data-testid="scope-my-team"
              >
                <Users className="h-3 w-3" /> My Team
              </button>
              <button
                onClick={() => setScope("everyone")}
                className={cn(
                  "flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors",
                  scope === "everyone"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                )}
                data-testid="scope-everyone"
              >
                <Globe className="h-3 w-3" /> Everyone
              </button>
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t bg-background/95">
            <div className="flex gap-2 items-end">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  effectiveScope === "everyone"
                    ? "Ask about any rep, team, or account…"
                    : "Ask anything or say 'log a call with…'"
                }
                className="resize-none min-h-[38px] max-h-[120px] text-sm py-2 px-3 rounded-xl"
                rows={1}
                disabled={isStreaming}
                data-testid="chatbot-input"
              />
              <Button
                size="icon"
                className="h-9 w-9 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming}
                data-testid="chatbot-send"
              >
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
