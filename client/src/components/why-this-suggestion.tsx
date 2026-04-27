/**
 * WhyThisSuggestion — small popover that explains the rationale behind an
 * AI suggestion (NBA card, lane recommendation, etc.) so reps trust the
 * surface instead of dismissing it as a black box.
 *
 * Task #702 (AI Surface Consolidation) — depends on the engagement event
 * pipeline from Task #700 so click-throughs feed into the analytics view.
 */
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { recordAiEvent, type AiEngagementSurface } from "@/lib/aiTelemetry";

export interface WhyThisSuggestionProps {
  surface: AiEngagementSurface;
  feature?: string;
  targetId?: string | number;
  reason: string;
  signals?: string[];
  testIdSuffix?: string;
}

export function WhyThisSuggestion({
  surface,
  feature,
  targetId,
  reason,
  signals,
  testIdSuffix,
}: WhyThisSuggestionProps) {
  const tid = testIdSuffix
    ? `why-this-suggestion-${testIdSuffix}`
    : "why-this-suggestion";

  const handleOpen = (open: boolean) => {
    if (!open) return;
    recordAiEvent({
      surface,
      eventType: "click",
      feature: feature ? `${feature}:why_this` : "why_this",
      targetId: targetId !== undefined ? String(targetId) : undefined,
    });
  };

  return (
    <Popover onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80 transition-colors"
          data-testid={`btn-${tid}`}
          aria-label="Why is this being suggested?"
        >
          <Info className="h-3 w-3" />
          Why this?
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 text-xs"
        data-testid={`popover-${tid}`}
      >
        <p className="font-medium mb-2">Why this suggestion</p>
        <p className="text-muted-foreground leading-snug mb-2">{reason}</p>
        {signals && signals.length > 0 && (
          <ul className="space-y-1 mt-2 border-t border-border pt-2">
            {signals.map((s, i) => (
              <li
                key={i}
                className="text-[11px] text-muted-foreground flex items-start gap-1.5"
              >
                <span className="mt-1.5 h-1 w-1 rounded-full bg-foreground/40 shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
