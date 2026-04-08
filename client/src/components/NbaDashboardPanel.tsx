import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { NbaCard } from "./NbaCard";
import type { NbaCardData } from "./NbaCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NbaDashboardPanelProps {
  userRole: string;
  isAdmin?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NbaDashboardPanel({ userRole, isAdmin }: NbaDashboardPanelProps) {
  const { toast } = useToast();
  // Local sets for instant optimistic removal — avoids waiting for query refetch
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [actioned, setActioned] = useState<Set<string>>(new Set());

  const { data: cards = [], isLoading, refetch } = useQuery<NbaCardData[]>({
    queryKey: ["/api/nba/cards"],
    staleTime: 60_000,
  });

  const runEngineMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/nba/run-engine", {}),
    onSuccess: (data: any) => {
      toast({
        title: "Engine complete",
        description: `${data.generated ?? 0} new cards generated, ${data.skipped ?? 0} skipped.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
    },
    onError: () => toast({ title: "Engine run failed", variant: "destructive" }),
  });

  // Portfolio roles (admin/director) see all cards from the server; others are capped at 5
  const isPortfolioRole = ["admin", "director"].includes(userRole);
  const visible = cards
    .filter(c => !dismissed.has(c.id) && !actioned.has(c.id))
    .slice(0, isPortfolioRole ? 200 : 5);

  // During initial load show a skeleton so the panel doesn't flash in/out.
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/3 p-5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-white">Today's Priorities</span>
        </div>
        {[1, 2].map(i => (
          <Skeleton key={i} className="rounded-xl bg-white/5" style={{ minHeight: 128 }} />
        ))}
      </div>
    );
  }

  // No cards — return nothing so the panel doesn't occupy space on the dashboard.
  if (visible.length === 0) return null;

  return (
    <div
      className="rounded-2xl border border-white/8 bg-white/3 p-5 flex flex-col gap-4"
      data-testid="nba-dashboard-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-white">Today's Priorities</span>
          <span className="text-[11px] font-semibold bg-amber-500/20 text-amber-400 rounded-full px-2 py-0.5">
            {visible.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            className="h-7 w-7 p-0 text-white/30 hover:text-white/60"
            data-testid="nba-panel-refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runEngineMutation.mutate()}
              disabled={runEngineMutation.isPending}
              className="h-7 text-xs text-white/40 hover:text-amber-400 px-2"
              data-testid="nba-run-engine-btn"
            >
              {runEngineMutation.isPending ? "Running…" : "Run engine"}
            </Button>
          )}
        </div>
      </div>

      {/* Cards — fixed-height list, no show-more */}
      <div className="flex flex-col gap-3">
        {visible.map(card => (
          <NbaCard
            key={card.id}
            card={card}
            onDismissed={(id) => setDismissed(prev => new Set([...prev, id]))}
            onActioned={(id) => setActioned(prev => new Set([...prev, id]))}
          />
        ))}
      </div>

      {/* Footer */}
      <p className="text-[10px] text-white/20 text-center -mt-1">
        Powered by NBA Phase 1 · updates nightly
      </p>
    </div>
  );
}
