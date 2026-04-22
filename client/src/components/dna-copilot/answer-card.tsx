/**
 * Answer card extras: source chips, scope/confidence badge, follow-up chips.
 * Renders below an assistant message when the server returned a `meta`
 * envelope. Falls back gracefully when fields are missing.
 */
import { useState } from "react";
import { ExternalLink, ShieldCheck, Eye, ChevronDown, ChevronRight, Clock, AlertTriangle, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AnswerMeta {
  sources?: Array<{
    kind: string;
    id?: string;
    label: string;
    href?: string;
    /** ISO timestamp of when the underlying record/document was last updated. */
    updatedAt?: string;
    /** Which retrieval bucket the source came from. */
    bucket?: string;
  }>;
  followUps?: string[];
  scope?: string;
  confidence?: "high" | "medium" | "low";
}

const CONFIDENCE_STYLE: Record<NonNullable<AnswerMeta["confidence"]>, string> = {
  high:   "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300 border-green-200 dark:border-green-900/40",
  medium: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 border-amber-200 dark:border-amber-900/40",
  low:    "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-900/40",
};

const STALE_AFTER_DAYS = 30;

function ageInfo(updatedAt?: string): { label: string; days: number; stale: boolean } | null {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return { label: "just now", days: 0, stale: false };
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return { label: "just now", days: 0, stale: false };
  if (mins < 60) return { label: `${mins} min old`, days: 0, stale: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { label: `${hours} hour${hours === 1 ? "" : "s"} old`, days: 0, stale: false };
  const days = Math.floor(hours / 24);
  if (days < 14) return { label: `${days} day${days === 1 ? "" : "s"} old`, days, stale: days >= STALE_AFTER_DAYS };
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return { label: `${weeks} week${weeks === 1 ? "" : "s"} old`, days, stale: days >= STALE_AFTER_DAYS };
  const months = Math.floor(days / 30);
  if (months < 18) return { label: `${months} month${months === 1 ? "" : "s"} old`, days, stale: days >= STALE_AFTER_DAYS };
  const years = Math.floor(days / 365);
  return { label: `${years} year${years === 1 ? "" : "s"} old`, days, stale: true };
}

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
  const [showSources, setShowSources] = useState(false);
  if (!sources.length && !followUps.length && !scope && !confidence) return null;

  const anyStale = sources.some((s) => ageInfo(s.updatedAt)?.stale);

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
        <div className="border border-border/60 rounded-lg bg-muted/30">
          <button
            onClick={() => setShowSources((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            data-testid="answer-sources-toggle"
            aria-expanded={showSources}
          >
            <span className="inline-flex items-center gap-1.5">
              {showSources ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span className="font-medium">{sources.length} source{sources.length === 1 ? "" : "s"}</span>
              {anyStale && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300"
                  data-testid="answer-sources-stale-badge"
                  title={`At least one source is older than ${STALE_AFTER_DAYS} days`}
                >
                  <AlertTriangle className="h-2.5 w-2.5" /> stale data
                </span>
              )}
            </span>
            <span className="text-[10px] uppercase tracking-wide opacity-70">
              {showSources ? "hide" : "show"}
            </span>
          </button>
          {showSources && (
            <ul className="border-t border-border/60 divide-y divide-border/40">
              {sources.map((s, i) => {
                const age = ageInfo(s.updatedAt);
                const interactive = !!s.href;
                return (
                  <li key={`${s.kind}-${s.id ?? i}`} data-testid={`answer-source-${i}`}>
                    <button
                      onClick={() => interactive && onSource(s.href!)}
                      disabled={!interactive}
                      className={cn(
                        "w-full text-left px-2.5 py-1.5 flex items-start gap-2 text-[11px]",
                        interactive ? "hover:bg-primary/5 text-foreground cursor-pointer" : "text-muted-foreground cursor-default",
                      )}
                      title={s.kind}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-medium">{s.label}</span>
                        {age && (
                          <span
                            className={cn(
                              "mt-0.5 inline-flex items-center gap-1 text-[10px]",
                              age.stale ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground",
                            )}
                            data-testid={`answer-source-age-${i}`}
                          >
                            <Clock className="h-2.5 w-2.5" />
                            {age.label}
                            {age.stale && <span className="uppercase tracking-wide">· stale</span>}
                          </span>
                        )}
                      </span>
                      {interactive && <ExternalLink className="h-3 w-3 mt-0.5 shrink-0 opacity-60" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {confidence === "low" && (
        <div
          className="rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1.5"
          data-testid="answer-low-confidence-fallback"
        >
          <HelpCircle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            I'm not fully sure about this answer. {followUps.length > 0
              ? "Pick a clarifying question below or rephrase your request to help me narrow in."
              : "Try rephrasing or adding the company name, lane, or time window."}
          </span>
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
