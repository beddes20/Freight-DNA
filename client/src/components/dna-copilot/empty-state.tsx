/**
 * Greeting + personalized alerts + per-page/per-role suggested-prompt chips
 * shown inside the panel when there are no messages yet.
 */
import { Bot } from "lucide-react";
import type { useChatPageContext } from "@/hooks/use-chat-page-context";

type PageContext = ReturnType<typeof useChatPageContext>;

export function EmptyState({
  userName,
  isAdminOrDirector,
  pageContext,
  alerts,
  suggestions,
  onPick,
}: {
  userName?: string | null;
  isAdminOrDirector: boolean;
  pageContext: PageContext;
  alerts: string[];
  suggestions: string[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Greeting */}
      <div className="flex gap-3">
        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[290px]">
          <p className="text-sm font-medium">
            Hey{userName ? ` ${userName.split(" ")[0]}` : ""}! I'm DNA Guru.
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
      {alerts.length > 0 && (
        <div className="ml-10 space-y-1.5">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className="text-xs px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40 text-amber-800 dark:text-amber-300"
              data-testid={`guru-alert-${i}`}
            >
              {alert}
            </div>
          ))}
        </div>
      )}

      {/* Suggested prompts */}
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground px-1">Try asking:</p>
        <div className="grid grid-cols-2 gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
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
  );
}
