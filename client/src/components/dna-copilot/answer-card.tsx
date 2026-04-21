/**
 * Answer card extras: source chips, scope/confidence badge, follow-up chips.
 * Renders below an assistant message when the server returned a `meta`
 * envelope. Falls back gracefully when fields are missing.
 */
import { ExternalLink, ShieldCheck, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AnswerMeta {
  sources?: Array<{ kind: string; id?: string; label: string; href?: string }>;
  followUps?: string[];
  scope?: string;
  confidence?: "high" | "medium" | "low";
}

const CONFIDENCE_STYLE: Record<NonNullable<AnswerMeta["confidence"]>, string> = {
  high:   "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300 border-green-200 dark:border-green-900/40",
  medium: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 border-amber-200 dark:border-amber-900/40",
  low:    "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-900/40",
};

export function AnswerCardMeta({
  meta,
  onFollowUp,
  onSource,
}: {
  meta: AnswerMeta;
  onFollowUp: (text: string) => void;
  onSource: (href: string) => void;
}) {
  const { sources = [], followUps = [], scope, confidence } = meta;
  if (!sources.length && !followUps.length && !scope && !confidence) return null;

  return (
    <div className="mt-2 space-y-2" data-testid="answer-card-meta">
      {(scope || confidence) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {scope && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-border text-muted-foreground" data-testid="answer-scope">
              <Eye className="h-2.5 w-2.5" /> {scope}
            </span>
          )}
          {confidence && (
            <span
              className={cn("inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border", CONFIDENCE_STYLE[confidence])}
              data-testid={`answer-confidence-${confidence}`}
            >
              <ShieldCheck className="h-2.5 w-2.5" /> {confidence} confidence
            </span>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sources.map((s, i) => (
            <button
              key={`${s.kind}-${s.id ?? i}`}
              onClick={() => s.href && onSource(s.href)}
              disabled={!s.href}
              className={cn(
                "inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-muted/50 transition-colors",
                s.href ? "hover:border-primary/40 hover:bg-primary/5 text-foreground" : "text-muted-foreground cursor-default",
              )}
              data-testid={`answer-source-${i}`}
              title={s.kind}
            >
              {s.label}
              {s.href && <ExternalLink className="h-2.5 w-2.5" />}
            </button>
          ))}
        </div>
      )}

      {followUps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {followUps.map((f, i) => (
            <button
              key={i}
              onClick={() => onFollowUp(f)}
              className="text-[11px] px-2.5 py-1 rounded-full border border-dashed border-primary/30 hover:border-primary/60 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`answer-followup-${i}`}
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
