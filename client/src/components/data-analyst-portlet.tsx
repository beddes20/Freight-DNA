import { useState, useRef, useCallback, useEffect } from "react";
import { Bot, Send, Loader2, Plus, RotateCcw, ClipboardList, Sparkles, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

export type AnalystContextType = "rfp" | "financial" | "historical";

interface AnalystMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface DataAnalystPortletProps {
  contextType: AnalystContextType;
  contextData: string;
  presetQuestions: string[];
  companyId?: string | null;
  companyName?: string | null;
  emptyLabel?: string;
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="text-sm leading-relaxed space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith("- ") || line.startsWith("• ")) {
          return (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 mt-0.5 text-muted-foreground">•</span>
              <span>{line.replace(/^[-•]\s/, "")}</span>
            </div>
          );
        }
        if (/^\*\*(.+)\*\*$/.test(line)) {
          return <p key={i} className="font-semibold">{line.replace(/\*\*/g, "")}</p>;
        }
        if (line.startsWith("**") || line.includes("**")) {
          const parts = line.split(/\*\*/g);
          return (
            <p key={i}>
              {parts.map((p, j) => j % 2 === 1 ? <strong key={j}>{p}</strong> : p)}
            </p>
          );
        }
        if (line === "") return <div key={i} className="h-1" />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}

interface TaskQuickCreateProps {
  defaultTitle: string;
  companyId?: string | null;
  onClose: () => void;
  onCreated: () => void;
}

function TaskQuickCreate({ defaultTitle, companyId, onClose, onCreated }: TaskQuickCreateProps) {
  const [title, setTitle] = useState(defaultTitle.slice(0, 120));
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await apiRequest("POST", "/api/tasks", {
        title: title.trim(),
        companyId: companyId || null,
        dueDate: dueDate || null,
        status: "open",
      });
      await qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Task created" });
      onCreated();
    } catch {
      toast({ title: "Failed to create task", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 p-3 rounded-xl border border-primary/20 bg-primary/5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-primary flex items-center gap-1.5">
          <ClipboardList className="h-3 w-3" /> Create Task
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Input
        value={title}
        onChange={e => setTitle(e.target.value)}
        className="text-sm h-8"
        placeholder="Task title"
        data-testid="analyst-task-title-input"
      />
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={dueDate}
          onChange={e => setDueDate(e.target.value)}
          className="text-xs h-7 flex-1"
        />
        <Button
          size="sm"
          className="h-7 px-3 text-xs bg-[#001AB3] hover:bg-[#044ad3]"
          onClick={handleCreate}
          disabled={!title.trim() || saving}
          data-testid="analyst-task-create-btn"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function DataAnalystPortlet({
  contextType,
  contextData,
  presetQuestions,
  companyId,
  companyName,
  emptyLabel = "Upload data to enable AI analysis",
}: DataAnalystPortletProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<AnalystMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [taskOpenFor, setTaskOpenFor] = useState<string | null>(null);
  const [taskCreatedFor, setTaskCreatedFor] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, 50);
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, streamingContent]);

  const hasData = contextData && contextData.trim().length > 0;

  const sendMessage = async (text: string) => {
    if (!text.trim() || streaming || !hasData) return;

    const userMsg: AnalystMessage = { id: Date.now().toString(), role: "user", content: text.trim() };
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    setStreamingContent("");

    try {
      const response = await fetch("/api/analyze/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          contextType,
          contextData,
          messages: history,
          question: text.trim(),
        }),
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
              const id = (Date.now() + 1).toString();
              setMessages(prev => [...prev, { id, role: "assistant", content: full }]);
              setStreamingContent("");
            }
            if (evt.error) throw new Error(evt.error);
          } catch {}
        }
      }
    } catch (err) {
      toast({ title: "Analysis failed", description: "Please try again.", variant: "destructive" });
      setStreamingContent("");
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setStreamingContent("");
    setTaskOpenFor(null);
    setTaskCreatedFor(new Set());
  };

  const isEmpty = messages.length === 0 && !streamingContent;

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3 text-muted-foreground">
        <Sparkles className="h-10 w-10 opacity-30" />
        <p className="text-sm font-medium">{emptyLabel}</p>
        <p className="text-xs max-w-xs">Once data is loaded, AI will be able to analyze it, surface trends, and help you turn insights into action.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[520px]">
      {/* Conversation area */}
      <ScrollArea className="flex-1 px-1" ref={scrollRef as any}>
        <div className="p-3 space-y-4">
          {isEmpty && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-4 w-4 text-[#001AB3]" />
                </div>
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[85%]">
                  <p className="text-sm">
                    I have access to your {contextType === "rfp" ? "RFP lane data" : contextType === "financial" ? "financial and load data" : "historical delivery data"}.
                    Ask me anything or start with one of these:
                  </p>
                </div>
              </div>
              <div className="space-y-1.5 pl-10">
                {presetQuestions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    className="block w-full text-left text-xs px-3 py-2 rounded-xl border border-border hover:border-[#001AB3]/40 hover:bg-[#001AB3]/5 transition-colors text-muted-foreground hover:text-foreground"
                    data-testid={`analyst-preset-${i}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
              {msg.role === "assistant" && (
                <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-4 w-4 text-[#001AB3]" />
                </div>
              )}
              <div className="max-w-[85%] space-y-1">
                <div className={cn(
                  "rounded-2xl px-3.5 py-2.5",
                  msg.role === "user"
                    ? "bg-[#001AB3] text-white rounded-tr-sm"
                    : "bg-muted rounded-tl-sm"
                )}>
                  {msg.role === "assistant"
                    ? <MarkdownText content={msg.content} />
                    : <p className="text-sm">{msg.content}</p>
                  }
                </div>

                {msg.role === "assistant" && (
                  taskCreatedFor.has(msg.id) ? (
                    <div className="flex items-center gap-1.5 pl-1 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle2 className="h-3 w-3" /> Task created
                    </div>
                  ) : taskOpenFor === msg.id ? (
                    <TaskQuickCreate
                      defaultTitle={msg.content.split("\n").find(l => l.trim().length > 10 && !l.startsWith("•") && !l.startsWith("-")) || msg.content.slice(0, 80)}
                      companyId={companyId}
                      onClose={() => setTaskOpenFor(null)}
                      onCreated={() => {
                        setTaskCreatedFor(prev => new Set(prev).add(msg.id));
                        setTaskOpenFor(null);
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => setTaskOpenFor(msg.id)}
                      className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                      data-testid={`analyst-create-task-${msg.id}`}
                    >
                      <Plus className="h-3 w-3" /> Create task from this
                    </button>
                  )
                )}
              </div>
            </div>
          ))}

          {streamingContent && (
            <div className="flex gap-3">
              <div className="h-7 w-7 rounded-full bg-[#001AB3]/10 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="h-4 w-4 text-[#001AB3]" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[85%]">
                <MarkdownText content={streamingContent} />
              </div>
            </div>
          )}

          {streaming && !streamingContent && (
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

      {/* Input bar */}
      <div className="border-t pt-3 px-3 pb-1 space-y-2">
        {messages.length > 0 && (
          <button
            onClick={clearConversation}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="analyst-clear-btn"
          >
            <RotateCcw className="h-3 w-3" /> Clear conversation
          </button>
        )}
        <div className="flex gap-2 items-end">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the data…"
            className="resize-none min-h-[38px] max-h-[100px] text-sm py-2 px-3 rounded-xl"
            rows={1}
            disabled={streaming}
            data-testid="analyst-input"
          />
          <Button
            size="icon"
            className="h-9 w-9 rounded-xl bg-[#001AB3] hover:bg-[#044ad3] shrink-0"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || streaming}
            data-testid="analyst-send-btn"
          >
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
