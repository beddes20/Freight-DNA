/**
 * Embedded play card — Task #926 step 10.
 *
 * Compact recommendation widget that drops inline on LWQ rows, the
 * Available Freight cockpit, customer/carrier detail, and RFP detail.
 * Fetches recs scoped to the entity in view; renders nothing when
 * there are zero open recs (so the surface stays clean).
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Lightbulb } from "lucide-react";
import { PlayRecommendationCard, type PlayRecommendation } from "./play-recommendation-card";

interface EmbeddedScope {
  customerId?: string | null;
  laneKey?: string | null;
  documentId?: string | null;
}

export function EmbeddedPlayCard({ scope, max = 2, dataTestIdPrefix = "embedded-plays" }: {
  scope: EmbeddedScope;
  max?: number;
  dataTestIdPrefix?: string;
}) {
  const url = scope.customerId
    ? `/api/copilot/plays/by-customer/${scope.customerId}`
    : scope.laneKey
    ? `/api/copilot/plays/by-lane/${encodeURIComponent(scope.laneKey)}`
    : scope.documentId
    ? `/api/copilot/plays/by-doc/${scope.documentId}`
    : null;
  const queryKey = scope.customerId
    ? ["/api/copilot/plays/by-customer", scope.customerId]
    : scope.laneKey
    ? ["/api/copilot/plays/by-lane", scope.laneKey]
    : scope.documentId
    ? ["/api/copilot/plays/by-doc", scope.documentId]
    : ["/api/copilot/plays/none"];

  // Explicit queryFn — code review flagged the prior implementation as
  // brittle because it relied on the default fetcher inferring the URL
  // from the queryKey. We now build the URL ourselves and the queryKey
  // is purely a cache identity.
  const query = useQuery<{ plays: PlayRecommendation[] }>({
    queryKey,
    enabled: !!url,
    queryFn: async () => {
      const res = await fetch(url!, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load embedded plays: ${res.status}`);
      return res.json();
    },
  });

  const plays = (query.data?.plays ?? []).slice(0, max);
  if (!url || query.isLoading || !plays.length) return null;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]" data-testid={`${dataTestIdPrefix}-${scope.customerId ?? scope.laneKey ?? scope.documentId}`}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-primary">
          <Lightbulb className="h-3.5 w-3.5" />
          Copilot recommends ({plays.length})
        </div>
        <div className="space-y-2">
          {plays.map((rec) => (
            <PlayRecommendationCard key={rec.id} rec={rec} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
