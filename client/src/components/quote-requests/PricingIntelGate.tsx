/**
 * Task #863 — Lazy, gated wrapper around <PricingIntelligencePanel/>.
 *
 * The full intelligence panel is expensive to render and only useful
 * for in-flight quotes (outcomeStatus === "pending"). This wrapper:
 *   • renders nothing for non-pending quotes
 *   • starts collapsed so the underlying query doesn't run
 *   • lazy-mounts the panel on first expand
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PricingIntelligencePanel, type PricingIntelInput } from "@/components/PricingIntelligencePanel";

interface QuoteShape {
  id: string;
  customerId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  laneGroupId?: string | null;
  outcomeStatus: string;
}

export function PricingIntelGate({ opp }: { opp: QuoteShape }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  if (opp.outcomeStatus !== "pending") return null;

  const input: PricingIntelInput = {
    customerId: opp.customerId,
    originCity: opp.originCity,
    originState: opp.originState,
    destCity: opp.destCity,
    destState: opp.destState,
    equipment: opp.equipment,
    laneGroupId: opp.laneGroupId ?? undefined,
  };

  return (
    <Card className="border-border/60 shadow-sm overflow-hidden" data-testid="card-pricing-intel-gate">
      <button
        type="button"
        onClick={() => {
          setOpen(o => {
            if (!o) setHasOpened(true);
            return !o;
          });
        }}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors"
        data-testid="toggle-pricing-intel"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-medium">Pricing Intelligence</span>
          <span className="text-[11px] text-muted-foreground">
            · benchmark, win-rate bins, and a price suggestion
          </span>
        </div>
        {open
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {hasOpened && (
        <div className={open ? "border-t border-border/60" : "hidden"}>
          <PricingIntelligencePanel input={input} />
        </div>
      )}
    </Card>
  );
}
