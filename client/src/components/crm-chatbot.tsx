import { useState, useRef, useEffect, useCallback } from "react";
import { Bot, X, Send, Plus, Trash2, ChevronLeft, MessageSquare, Loader2, Lightbulb, CheckCircle2, Globe, Users, Bug, Wrench, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

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
}

const MY_TEAM_SUGGESTIONS = [
  "Which contacts haven't been touched in 30+ days?",
  "What RFPs are due soon?",
  "Show me my open tasks",
  "Who are my key contacts at my top accounts?",
];

const EVERYONE_SUGGESTIONS = [
  "Who has the most new contacts this month?",
  "Which rep has the most touchpoints this month?",
  "Show me open RFPs across all accounts",
  "Which accounts have the most contacts?",
];

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

export function CrmChatbot() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<number | null>(null);
  const [showConvoList, setShowConvoList] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [reportType, setReportType] = useState<ReportType | null>(null);
  const [suggestionText, setSuggestionText] = useState("");
  const [bugPage, setBugPage] = useState("");
  const [bugExpected, setBugExpected] = useState("");
  const [suggestionSent, setSuggestionSent] = useState(false);
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [scope, setScope] = useState<"my_team" | "everyone">("my_team");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  const isAdminOrDirector = user?.role === "admin" || user?.role === "director" || user?.role === "sales_director";
  const showScopeToggle = !isAdminOrDirector && !!user;
  const effectiveScope = user?.role === "admin" ? "everyone" : (isAdminOrDirector ? "my_team" : scope);

  const SUGGESTIONS = effectiveScope === "everyone" ? EVERYONE_SUGGESTIONS : MY_TEAM_SUGGESTIONS;

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
      setTimeout(() => {
        setSuggestionSent(false);
        setSuggestionText("");
        setBugPage("");
        setBugExpected("");
        setReportType(null);
        setShowSuggest(false);
      }, 2500);
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

    try {
      const response = await fetch(`/api/chatbot/conversations/${convoId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: text.trim(), scope: effectiveScope }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

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
            }
            if (evt.done) {
              const assistantMsg: ChatMessage = {
                id: Date.now() + 1,
                conversationId: convoId!,
                role: "assistant",
                content: full,
                createdAt: new Date().toISOString(),
              };
              setLocalMessages((prev) => [...prev, assistantMsg]);
              setStreamingContent("");
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
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200",
          "bg-[#001AB3] hover:bg-[#044ad3] text-white",
          open && "scale-90 opacity-80"
        )}
        data-testid="chatbot-toggle"
      >
        {open ? <X className="h-5 w-5" /> : <Bot className="h-6 w-6" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className={cn(
          "fixed bottom-24 right-6 z-50 w-[390px] h-[580px] rounded-2xl shadow-2xl border border-border/50",
          "bg-background flex flex-col overflow-hidden",
          "animate-in slide-in-from-bottom-4 fade-in-0 duration-200"
        )}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b bg-[#001AB3] text-white rounded-t-2xl">
            <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-none">GrowthBot</p>
              <p className="text-xs text-white/70 mt-0.5">
                {isAdminOrDirector ? "Viewing: All Teams" : "Your CRM assistant"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { setShowSuggest((v) => !v); setShowConvoList(false); if (showSuggest) { setReportType(null); setSuggestionText(""); setBugPage(""); setBugExpected(""); } }}
                title="Report a bug or suggest a feature"
                data-testid="chatbot-feedback-btn"
              >
                <Lightbulb className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/20"
                onClick={() => { setShowConvoList((v) => !v); setShowSuggest(false); }}
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
                <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-500" />
                  <p className="text-sm font-medium">
                    {reportType === "bug" ? "Bug report sent!" : reportType === "improvement" ? "Improvement noted!" : "Feature request sent!"}
                  </p>
                  <p className="text-xs text-muted-foreground">The admin team will review it shortly.</p>
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
                          className="w-full text-sm px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-[#001AB3]/40"
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
                    className="w-full bg-[#001AB3] hover:bg-[#044ad3]"
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
                <Button className="w-full bg-[#001AB3] hover:bg-[#044ad3]" onClick={() => { createConvo.mutate(); setShowConvoList(false); }}>
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
                  <div className="flex gap-3">
                    <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="h-4 w-4 text-[#001AB3]" />
                    </div>
                    <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[290px]">
                      <p className="text-sm">
                        Hi! I'm GrowthBot. I have live access to your CRM data.
                        {isAdminOrDirector
                          ? " As an admin/director, I can see data across all teams."
                          : " Use the toggle below to switch between your team's data or the entire org."}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground px-1">Try asking:</p>
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => sendMessage(s)}
                        className="block w-full text-left text-xs px-3 py-2 rounded-xl border border-border hover:border-[#001AB3]/40 hover:bg-[#001AB3]/5 transition-colors text-muted-foreground hover:text-foreground"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {allMessages.map((msg) => (
                <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
                  {msg.role === "assistant" && (
                    <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="h-4 w-4 text-[#001AB3]" />
                    </div>
                  )}
                  <div className={cn(
                    "rounded-2xl px-3.5 py-2.5 max-w-[290px]",
                    msg.role === "user"
                      ? "bg-[#001AB3] text-white rounded-tr-sm"
                      : "bg-muted rounded-tl-sm"
                  )}>
                    {msg.role === "assistant"
                      ? <MarkdownText content={msg.content} />
                      : <p className="text-sm">{msg.content}</p>
                    }
                  </div>
                </div>
              ))}

              {/* Streaming response */}
              {streamingContent && (
                <div className="flex gap-3">
                  <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-4 w-4 text-[#001AB3]" />
                  </div>
                  <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[290px]">
                    <MarkdownText content={streamingContent} />
                  </div>
                </div>
              )}

              {/* Loading dots */}
              {isStreaming && !streamingContent && (
                <div className="flex gap-3">
                  <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0">
                    <Bot className="h-4 w-4 text-[#001AB3]" />
                  </div>
                  <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-3 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
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
                    ? "bg-[#001AB3] text-white border-[#001AB3]"
                    : "text-muted-foreground border-border hover:border-[#001AB3]/40 hover:text-foreground"
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
                    ? "bg-[#001AB3] text-white border-[#001AB3]"
                    : "text-muted-foreground border-border hover:border-[#001AB3]/40 hover:text-foreground"
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
                    : "Ask about your accounts, contacts, RFPs…"
                }
                className="resize-none min-h-[38px] max-h-[120px] text-sm py-2 px-3 rounded-xl"
                rows={1}
                disabled={isStreaming}
                data-testid="chatbot-input"
              />
              <Button
                size="icon"
                className="h-9 w-9 rounded-xl bg-[#001AB3] hover:bg-[#044ad3] shrink-0"
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
