import { useState } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Task #633 — "Why this carrier?" reasons popover.
 *
 * Shared between LWQ (CarrierOutreachPanel) and Available Freight cockpit
 * chips so reps see the same reason ordering everywhere.
 *
 * Ordering inside the popover:
 *   1) Suppression notes (muted red, top — these explain why the carrier was
 *      held back even when ranked).
 *   2) Plain "reasons" array from the ranker (already capped + ordered server
 *      side; bench wins are pre-prepended at index 0 by the ranker).
 *
 * Desktop uses HoverCard (hover + keyboard focus). Mobile/touch falls back to
 * a tap-driven Popover. We pick at mount time using a touch capability sniff;
 * pointer media queries would be more correct but are flaky inside Replit's
 * iframe preview.
 */
export interface CarrierReasonsPopoverProps {
  carrierName: string;
  reasons: string[];
  suppressionReasons?: string[];
  children: React.ReactNode;
  testId?: string;
}

function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 0
  );
}

function ReasonsContent({
  carrierName,
  reasons,
  suppressionReasons,
}: Pick<CarrierReasonsPopoverProps, "carrierName" | "reasons" | "suppressionReasons">) {
  const hasSuppressions = (suppressionReasons?.length ?? 0) > 0;
  const hasReasons = reasons.length > 0;
  return (
    <div
      className="flex flex-col gap-2 text-xs"
      data-testid="carrier-reasons-popover-content"
    >
      <div className="font-medium text-foreground" data-testid="text-carrier-reasons-name">
        Why {carrierName}?
      </div>
      {hasSuppressions && (
        <ul
          className="flex flex-col gap-1 border-b border-border/40 pb-2"
          data-testid="list-carrier-suppression-reasons"
        >
          {(suppressionReasons ?? []).map((r, i) => (
            <li
              key={`sup-${i}`}
              className="flex items-start gap-1.5 text-muted-foreground"
              data-testid={`carrier-suppression-reason-${i}`}
            >
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500/70" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      {hasReasons ? (
        <ul className="flex flex-col gap-1" data-testid="list-carrier-reasons">
          {reasons.map((r, i) => (
            <li
              key={`r-${i}`}
              className="flex items-start gap-1.5 text-foreground"
              data-testid={`carrier-reason-${i}`}
            >
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500/80" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        !hasSuppressions && (
          <div
            className="flex items-center gap-1.5 text-muted-foreground"
            data-testid="text-carrier-reasons-empty"
          >
            <Info className="w-3 h-3 shrink-0" />
            <span>No ranking signals available.</span>
          </div>
        )
      )}
    </div>
  );
}

export function CarrierReasonsPopover({
  carrierName,
  reasons,
  suppressionReasons,
  children,
  testId,
}: CarrierReasonsPopoverProps) {
  const [touch] = useState(isTouchDevice);

  if (touch) {
    return (
      <Popover>
        <PopoverTrigger asChild data-testid={testId ?? "trigger-carrier-reasons"}>
          {children}
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start" sideOffset={6}>
          <ReasonsContent
            carrierName={carrierName}
            reasons={reasons}
            suppressionReasons={suppressionReasons}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild data-testid={testId ?? "trigger-carrier-reasons"}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="w-72 p-3" align="start" sideOffset={6}>
        <ReasonsContent
          carrierName={carrierName}
          reasons={reasons}
          suppressionReasons={suppressionReasons}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
