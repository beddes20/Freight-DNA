import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Archive, CheckCircle2, GitBranch, Globe, HelpCircle, IdCard, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ConversationThread } from "./types";

export function WaitingStateBadge({ state, overdue }: { state: ConversationThread["waitingState"]; overdue: boolean }) {
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

// ─── Free-mail attribution recovery (Task #1056 / Email→Exec 5) ────────────
// Renders a tiny "Inferred from: …" chip next to <WaitingStateBadge> so reps
// can see HOW a thread came to be linked (or merely suggested-linked) to its
// account. Hidden entirely when no inference was recorded — legacy threads
// from before Task #1056 carry NULL and stay clean. The tooltip surfaces the
// matched signal text so the rep can sanity-check signature / weak matches
// before acting on the suggestion card.
const ATTRIBUTION_LABELS: Record<NonNullable<ConversationThread["attributionInferenceSource"]>, {
  label: string;
  description: string;
  className: string;
  Icon: typeof IdCard;
}> = {
  contact: {
    label: "From contact",
    description: "Sender matches a known CRM contact — hard-attached.",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
    Icon: IdCard,
  },
  domain: {
    label: "From domain",
    description: "Sender's email domain matches a known company — hard-attached.",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
    Icon: Globe,
  },
  thread: {
    label: "From thread",
    description: "Matched via existing thread continuity — hard-attached.",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
    Icon: GitBranch,
  },
  signature: {
    label: "From signature",
    description: "Free-mail sender — signature/company text matches a known customer. Suggestion only — confirm before relying on the link.",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-amber-300 dark:border-amber-800",
    Icon: PenLine,
  },
  weak: {
    label: "Weak match",
    description: "Free-mail sender — only a weak display-name match. Suggestion only — confirm before relying on the link.",
    className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200 border-gray-300 dark:border-gray-700",
    Icon: HelpCircle,
  },
  // Confirmed variants — emerald (hard-attached) but the label preserves
  // the original tier so the provenance trail stays honest.
  confirmed_signature: {
    label: "Confirmed signature",
    description: "Free-mail sender confirmed by a rep — original signal was a Tier-2 signature match.",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
    Icon: CheckCircle2,
  },
  confirmed_weak: {
    label: "Confirmed weak",
    description: "Free-mail sender confirmed by a rep — original signal was a Tier-3 weak match.",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-300 dark:border-emerald-800",
    Icon: CheckCircle2,
  },
};

export function AttributionBadge({ thread }: { thread: Pick<ConversationThread, "attributionInferenceSource" | "attributionEvidence"> }) {
  const source = thread.attributionInferenceSource;
  if (!source) return null;
  const cfg = ATTRIBUTION_LABELS[source];
  if (!cfg) return null;
  const evidence = thread.attributionEvidence ?? null;
  const lines: string[] = [cfg.description];
  if (evidence?.label) lines.push(evidence.label);
  if (evidence?.matchedText && !evidence.label) lines.push(`Matched on: ${evidence.matchedText}`);
  if (evidence?.senderEmail) lines.push(`Sender: ${evidence.senderEmail}`);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            className={cn("text-xs font-medium gap-1 cursor-help", cfg.className)}
            data-testid={`badge-attribution-${source}`}
          >
            <cfg.Icon className="w-3 h-3" />
            Inferred: {cfg.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            {lines.map((l, i) => (
              <p key={i} className={i === 0 ? "font-medium" : "text-muted-foreground"}>
                {l}
              </p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PriorityDot({ priority }: { priority: ConversationThread["responsePriority"] }) {
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
