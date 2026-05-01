/**
 * Task #912 — `IntelligenceCardsList` embed.
 *
 * Thin wrapper that fetches a list of cards by anchor (customer, carrier,
 * lane, opportunity) and renders the latest few `IntelligenceCard`s. Designed
 * to drop into the existing detail pages without restructuring the layout.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2, ListChecks } from "lucide-react";
import type { CopilotRecommendation } from "@shared/schema";
import { IntelligenceCard } from "./intelligence-card";

type Anchor =
  | { kind: "customer"; companyId: string }
  | { kind: "carrier"; carrierId: string }
  | { kind: "opportunity"; opportunityId: string }
  | { kind: "lane"; laneSignature: string };

function endpointFor(anchor: Anchor): { url: string; key: readonly unknown[] } {
  switch (anchor.kind) {
    case "customer":
      return { url: `/api/copilot/cards/by-customer/${anchor.companyId}`, key: ["/api/copilot/cards/by-customer", anchor.companyId] as const };
    case "carrier":
      return { url: `/api/copilot/cards/by-carrier/${anchor.carrierId}`, key: ["/api/copilot/cards/by-carrier", anchor.carrierId] as const };
    case "opportunity":
      return { url: `/api/copilot/cards/by-opportunity/${anchor.opportunityId}`, key: ["/api/copilot/cards/by-opportunity", anchor.opportunityId] as const };
    case "lane":
      return { url: `/api/copilot/cards/by-lane/${encodeURIComponent(anchor.laneSignature)}`, key: ["/api/copilot/cards/by-lane", anchor.laneSignature] as const };
  }
}

export interface IntelligenceCardsListProps {
  anchor: Anchor;
  /** Max cards to show. Defaults to 3 (most-recent first). */
  limit?: number;
  /** Header label shown above the list. */
  title?: string;
}

export function IntelligenceCardsList({ anchor, limit = 3, title = "Copilot Fit & Intelligence" }: IntelligenceCardsListProps) {
  const { url, key } = endpointFor(anchor);
  const { data, isLoading, isError } = useQuery<{ cards: CopilotRecommendation[] }>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const cards = (data?.cards ?? []).slice(0, limit);

  return (
    <section className="space-y-2" data-testid={`intelligence-cards-list-${anchor.kind}`}>
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {cards.length > 0 && (
          <span className="text-xs text-muted-foreground" data-testid="intelligence-cards-count">
            {cards.length} of {data?.cards.length ?? 0}
          </span>
        )}
      </div>
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="intelligence-cards-loading">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cards…
        </div>
      )}
      {isError && (
        <p className="text-xs text-muted-foreground" data-testid="intelligence-cards-error">
          Couldn't load intelligence cards. They'll reappear next time the page is refreshed.
        </p>
      )}
      {!isLoading && !isError && cards.length === 0 && (
        <p className="text-xs text-muted-foreground italic" data-testid="intelligence-cards-empty">
          No intelligence cards yet. They'll appear here automatically when a rate-con or related document is ingested.
        </p>
      )}
      <div className="space-y-3">
        {cards.map((c) => (
          <IntelligenceCard key={c.id} card={c} invalidateKeys={[key]} />
        ))}
      </div>
    </section>
  );
}
