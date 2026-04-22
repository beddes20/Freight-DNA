/**
 * The footer row attached to every assistant bubble: a route/mode pill,
 * an inline low-confidence warning, and the thumbs up/down feedback affordance.
 *
 * Wired to `/api/agent/feedback` by the parent panel via the `onFeedback`
 * callback. Kept presentational so it can be reused if the panel ever
 * surfaces messages outside of the chat bubble (e.g. inside ValueIQ threads).
 */
import { ThumbsUp, ThumbsDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./types";

export function FeedbackControls({
  message,
  onFeedback,
}: {
  message: ChatMessage;
  onFeedback: (rating: "up" | "down") => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-border/40">
      {message.mode && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border",
            message.mode === "quick"
              ? "border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
              : "border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30",
          )}
          data-testid={`badge-mode-${message.id}`}
          title={message.mode === "quick" ? "Routed to fast model (gpt-4o-mini)" : "Routed to reasoning model (gpt-4o)"}
        >
          {message.modeLabel ?? (message.mode === "quick" ? "Quick answer" : "Full analysis")}
        </span>
      )}
      {typeof message.confidence === "number" && message.confidence < 0.5 && (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400 mr-auto" data-testid={`badge-low-confidence-${message.id}`}>
          <AlertTriangle className="h-3 w-3" /> Low confidence — try rephrasing
        </span>
      )}
      {(typeof message.confidence !== "number" || message.confidence >= 0.5) && <span className="mr-auto" />}
      <button
        title="Helpful"
        onClick={() => onFeedback("up")}
        className={cn("p-1 rounded hover:bg-background", message.feedback === "up" && "text-green-600")}
        data-testid={`button-thumbs-up-${message.id}`}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        title="Not helpful"
        onClick={() => onFeedback("down")}
        className={cn("p-1 rounded hover:bg-background", message.feedback === "down" && "text-red-600")}
        data-testid={`button-thumbs-down-${message.id}`}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
    </div>
  );
}
