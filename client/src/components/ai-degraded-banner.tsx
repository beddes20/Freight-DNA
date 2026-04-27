/**
 * AI Degraded Banner — Task #4 ("level up" honesty pass).
 *
 * Why this exists
 * ───────────────
 * AI-generated narratives on the Intel page (alert summaries, lane coaching
 * cards, executive brief, market context, etc.) historically vanished
 * silently when an upstream call failed or the relevant API key wasn't set.
 * From a rep's perspective the AI just "stopped working" with no signal.
 *
 * The server now returns a `_aiStatus` bag on every per-section response
 * (see `server/lib/aiHelperStatus.ts`). This component reads one entry
 * from that bag and renders an inline amber banner explaining what's
 * missing. It mirrors the visual language of `IntegrationDegradedPill`
 * so users recognise it as the same family of "this feature is in a
 * degraded state" signal.
 *
 * Render contract
 * ───────────────
 * - When `entry` is undefined or its status is "ok", render nothing.
 *   Callers can drop the component anywhere with no visual cost.
 * - When degraded, render a one-line banner with a tooltip explaining
 *   the difference between unconfigured (admin must set a key) and
 *   failed (transient — retry).
 */
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Info } from "lucide-react";

export type AiHelperStatus = "ok" | "unconfigured" | "failed" | "empty";

export interface AiStatusEntry {
  status: AiHelperStatus;
  reason?: string;
  count: number;
}

export type AiStatusBag = Record<string, AiStatusEntry | undefined>;

interface Props {
  /** The status bag entry for this surface; undefined ⇒ nothing to show. */
  entry: AiStatusEntry | undefined;
  /** Short label for what's missing, e.g. "AI alert summaries". */
  surface: string;
  /** Optional override testid suffix. */
  testIdSuffix?: string;
}

const COPY: Record<AiHelperStatus, { headline: string; detail: string }> = {
  ok: { headline: "", detail: "" },
  unconfigured: {
    headline: "AI summaries are temporarily unavailable — showing raw data only.",
    detail: "An API key required for this AI summary isn't configured. Ask an admin to add it under Admin → Integrations Health.",
  },
  failed: {
    headline: "AI summaries are temporarily unavailable — showing raw data only.",
    detail: "The AI service returned an error on the most recent call. Underlying numbers are still accurate; refreshing in a minute usually restores the summary.",
  },
  empty: {
    headline: "AI didn't generate a summary for this section.",
    detail: "The model returned an empty response. The data below is still accurate.",
  },
};

export function AiDegradedBanner({ entry, surface, testIdSuffix }: Props) {
  if (!entry || entry.status === "ok") return null;
  const copy = COPY[entry.status];
  const testid = `banner-ai-degraded-${testIdSuffix ?? entry.status}`;
  return (
    <TooltipProvider>
      <div
        className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
        data-testid={testid}
      >
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="flex-1">
          <span className="font-medium">{surface}:</span> {copy.headline}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-amber-500/20 transition-colors"
              aria-label="What's missing?"
              data-testid={`${testid}-tooltip-trigger`}
            >
              <Info className="h-3 w-3" />
              What's missing?
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="text-xs">{copy.detail}</p>
            {entry.reason && (
              <p className="mt-1 text-[11px] text-muted-foreground break-words">
                {entry.reason}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
