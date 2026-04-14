/**
 * NbaCompanyCard — Account 360 / company detail view
 *
 * Shows the single persistent Phase 1 NBA card for a specific company.
 * Queries /api/nba/company/:companyId/card.
 * Uses the same NbaCard component (fixed-height, no expand).
 * Renders nothing if no card is available for the company.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { NbaCard } from "./NbaCard";
import type { NbaCardData } from "./NbaCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain } from "lucide-react";

interface NbaCompanyCardProps {
  companyId: string;
  onHasCard?: (hasCard: boolean) => void;
  onPrepForCall?: () => void;
}

export function NbaCompanyCard({ companyId, onHasCard, onPrepForCall }: NbaCompanyCardProps) {
  const { data: card, isLoading } = useQuery<NbaCardData | null>({
    queryKey: ["/api/nba/company", companyId, "card"],
    staleTime: 60_000,
    enabled: !!companyId,
  });

  // Notify parent once we know whether a Phase 1 card exists
  const prevHasCard = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (isLoading || !onHasCard) return;
    const hasCard = !!card;
    if (hasCard !== prevHasCard.current) {
      prevHasCard.current = hasCard;
      onHasCard(hasCard);
    }
  }, [isLoading, card, onHasCard]);

  if (isLoading) {
    return <Skeleton className="w-full rounded-xl" style={{ minHeight: 128 }} />;
  }

  if (!card) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium">
        <Brain className="w-3.5 h-3.5 text-amber-500" />
        Priority Recommendation
      </div>
      <NbaCard
        card={card}
        hideCompanyLink={true}
        onPrepForCall={onPrepForCall ? () => onPrepForCall() : undefined}
      />
    </div>
  );
}
