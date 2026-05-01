// Workflow OS — Stale-N recovery chip.
//
// Always renders next to the Pickup scope select when the actionable
// scope is hiding rows. Click flips the scope to "all" and reveals the
// suppressed rows in their stale-tinted styling.

import { Button } from "@/components/ui/button";
import { Clock } from "lucide-react";
import type { PickupScopeValue } from "@shared/workflowOs/actionability";

interface StaleCountChipProps {
  hiddenStale: number;
  currentScope: PickupScopeValue;
  onShowAll: () => void;
  className?: string;
}

export function StaleCountChip({
  hiddenStale,
  currentScope,
  onShowAll,
  className,
}: StaleCountChipProps) {
  // Only render when the actionable scope is actively suppressing rows.
  // Once the scope is "all" the chip would be redundant.
  if (hiddenStale <= 0) return null;
  if (currentScope === "all") return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={`h-8 text-xs gap-1 border-amber-200 text-amber-900 hover:bg-amber-50 dark:border-amber-900/50 dark:text-amber-200 dark:hover:bg-amber-950/30 ${className ?? ""}`}
      onClick={onShowAll}
      data-testid="chip-stale-count"
      aria-label={`Show ${hiddenStale} stale or past-pickup rows`}
    >
      <Clock className="w-3 h-3" />
      Stale: {hiddenStale}
    </Button>
  );
}
