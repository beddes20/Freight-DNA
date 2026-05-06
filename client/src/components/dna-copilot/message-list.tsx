/**
 * Renders the assistant ↔ user transcript inside the panel: persisted
 * messages, the in-flight streaming bubble, and the tool-progress
 * placeholder. Keeps the panel shell free of per-bubble layout concerns.
 */
import { Bot, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownText } from "./markdown-text";
import { ActionCard } from "./legacy-action-card";
import { AnswerCardMeta, type AnswerMeta } from "./answer-card";
import { FeedbackControls } from "./feedback-controls";
import type { ChatMessage, CopilotMode } from "./types";

export function MessageList({
  messages,
  mode,
  isStreaming,
  streamingContent,
  streamingMeta,
  progressLine,
  onConfirmAction,
  onDismissAction,
  onFollowUp,
  onSource,
  onFeedback,
  onReportError,
}: {
  messages: ChatMessage[];
  mode: CopilotMode;
  isStreaming: boolean;
  streamingContent: string;
  streamingMeta: AnswerMeta | null;
  progressLine: string | null;
  onConfirmAction: (msgId: number, editedArgs: Record<string, string>) => void;
  onDismissAction: (msgId: number) => void;
  onFollowUp: (text: string) => void;
  onSource: (href: string) => void;
  onFeedback: (msgId: number, rating: "up" | "down") => void;
  onReportError: (msgId: number, message: string) => void;
}) {
  const bubbleMax = mode === "docked" ? "max-w-[290px]" : "max-w-[80%]";

  return (
    <div className="p-4 space-y-4">
      {messages.map((msg) => (
        <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
          {msg.role === "assistant" && (
            <div className={cn(
              "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5",
              msg.isError ? "bg-red-100 dark:bg-red-950/40" : "bg-primary/10",
            )}>
              {msg.isError ? <AlertTriangle className="h-4 w-4 text-red-600" /> : <Bot className="h-4 w-4 text-primary" />}
            </div>
          )}
          <div className={cn(
            "rounded-2xl px-3.5 py-2.5",
            bubbleMax,
            msg.role === "user"
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : msg.isError
                ? "bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-tl-sm"
                : "bg-muted rounded-tl-sm",
          )}>
            {msg.role === "assistant" ? (
              <>
                {msg.isError ? (
                  // Phase 5 — friendly error card. We deliberately do NOT
                  // render `msg.content` here because upstream errors can
                  // contain stack frames, tokens, or other tenant data.
                  // The raw content is forwarded ONLY through the sanitized
                  // `Report this` pipeline (server/routes/agentAnalytics.ts
                  // → sanitizeReportText). End users see a fixed copy plus a
                  // short error code so support can correlate.
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-red-700 dark:text-red-300">Something went wrong</p>
                    <p className="text-xs text-red-600 dark:text-red-400">
                      The copilot couldn't finish that turn. Try again, or use{" "}
                      <span className="font-medium">Report this</span> to send
                      the details to your admin.
                    </p>
                    <p
                      className="text-[10px] font-mono text-red-500/80 dark:text-red-400/70"
                      data-testid={`text-error-code-${msg.id}`}
                    >
                      ref: {String(msg.id).slice(0, 8)}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] border-red-300 dark:border-red-800"
                        onClick={() => onReportError(msg.id, msg.content)}
                        disabled={msg.feedback === "down"}
                        data-testid={`button-report-error-${msg.id}`}
                      >
                        {msg.feedback === "down" ? "Reported" : "Report this"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MarkdownText content={msg.content} />
                )}
                {msg.action && (
                  <ActionCard
                    action={msg.action}
                    onConfirm={(editedArgs) => onConfirmAction(msg.id, editedArgs)}
                    onDismiss={() => onDismissAction(msg.id)}
                  />
                )}
                {msg.meta && (
                  <AnswerCardMeta
                    meta={msg.meta}
                    onFollowUp={onFollowUp}
                    onSource={onSource}
                  />
                )}
                {!msg.isError && msg.content && (
                  <FeedbackControls message={msg} onFeedback={(r) => onFeedback(msg.id, r)} />
                )}
              </>
            ) : (
              <p className="text-sm">{msg.content}</p>
            )}
          </div>
        </div>
      ))}

      {/* Streaming response */}
      {streamingContent && (
        <div className="flex gap-3">
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <div className={cn("bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5", bubbleMax)}>
            <MarkdownText content={streamingContent} />
            {streamingMeta && (
              <AnswerCardMeta meta={streamingMeta} onFollowUp={onFollowUp} onSource={onSource} />
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
  );
}
