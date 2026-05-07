import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { NbaCard } from "./NbaCard";
import type { NbaCardData } from "./NbaCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, RefreshCw, ArrowDownAZ } from "lucide-react";
import type { PortletFreshness } from "@shared/schema";
import { decidePortletState } from "@/lib/portletState";
import { PortletStateBanner } from "@/components/dashboard/PortletStateBanner";

// ── Types ─────────────────────────────────────────────────────────────────────

interface NbaDashboardPanelProps {
  userRole: string;
  isAdmin?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NbaDashboardPanel({ userRole, isAdmin }: NbaDashboardPanelProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  // Local sets for instant optimistic removal — avoids waiting for query refetch
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [actioned, setActioned] = useState<Set<string>>(new Set());
  // Task #372 — sort + filter by at-stake $
  const [sortMode, setSortMode] = useState<"default" | "at_stake">("default");
  const [minAtStake, setMinAtStake] = useState<number>(0);

  // When the user is sorting/filtering by at-stake $, request a larger
  // candidate set so non-portfolio reps can actually triage by impact
  // (otherwise the server caps non-admin users at 5 cards).
  const triageActive = sortMode === "at_stake" || minAtStake > 0;
  // Phase 1.5 S7 — server now envelopes the response as
  // { cards, freshness }. Tolerate BOTH the legacy bare-array shape AND
  // the new object shape so the server can ship/roll back independently.
  type NbaCardsResponse =
    | NbaCardData[]
    | { cards: NbaCardData[]; freshness: PortletFreshness | null };
  const { data, isLoading, refetch } = useQuery<NbaCardsResponse>({
    queryKey: ["/api/nba/cards", triageActive ? "triage" : "default"],
    queryFn: async () => {
      const url = triageActive ? "/api/nba/cards?limit=50" : "/api/nba/cards";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cards");
      return res.json();
    },
    staleTime: 60_000,
  });
  const cards: NbaCardData[] = Array.isArray(data) ? data : (data?.cards ?? []);
  const freshness: PortletFreshness | null = Array.isArray(data) ? null : (data?.freshness ?? null);

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
  const stakeNum = (c: NbaCardData) => Number(c.atStakeAmount ?? 0) || 0;
  const filtered = cards
    .filter(c => !dismissed.has(c.id) && !actioned.has(c.id))
    .filter(c => minAtStake === 0 || stakeNum(c) >= minAtStake);
  const sorted = sortMode === "at_stake"
    ? [...filtered].sort((a, b) => stakeNum(b) - stakeNum(a))
    : filtered;
  const visible = sorted.slice(0, isPortfolioRole ? 200 : 5);

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

  // Phase 1.5 S7 — distinguish "nothing today" from "recommendations may
  // be stale" / "freshness unavailable". Only triggers when the visible
  // list is empty AFTER the local optimistic-removal/at-stake filter, so
  // the banner mirrors what the rep is actually seeing. Healthy + empty
  // still hides as before; missing freshness collapses to legacy hide.
  const portletState = decidePortletState(visible.length, freshness);
  if (portletState === "hidden") return null;
  if (portletState === "stale") {
    return (
      <PortletStateBanner
        state="stale"
        title="Recommendations may be stale"
        body="No next-best actions are showing, but the recommendation refresh looks unhealthy."
        lastUpdatedAt={freshness?.lastUpdatedAt ?? null}
        source={freshness?.source ?? null}
        testIdPrefix="nba"
      />
    );
  }
  if (portletState === "unknown") {
    return (
      <PortletStateBanner
        state="unknown"
        title="Recommendation freshness unavailable"
        body="No next-best actions are showing, but dashboard freshness could not be verified."
        lastUpdatedAt={freshness?.lastUpdatedAt ?? null}
        source={freshness?.source ?? null}
        testIdPrefix="nba"
      />
    );
  }

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
          {/* Task #372 — sort/filter by at-stake */}
          <button
            onClick={() => setSortMode(m => m === "at_stake" ? "default" : "at_stake")}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
              sortMode === "at_stake"
                ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
                : "bg-white/5 border-white/10 text-white/40 hover:text-white/70"
            }`}
            title="Sort by $ at stake"
            data-testid="nba-panel-sort-at-stake"
          >
            <ArrowDownAZ className="w-3 h-3" />
            $ at stake
          </button>
          <select
            value={minAtStake}
            onChange={(e) => setMinAtStake(Number(e.target.value))}
            className="text-[11px] bg-white/5 border border-white/10 text-white/60 rounded px-1.5 py-1 hover:text-white/80"
            data-testid="nba-panel-min-at-stake"
          >
            <option value={0}>Any $</option>
            <option value={5000}>≥ $5k</option>
            <option value={25000}>≥ $25k</option>
            <option value={100000}>≥ $100k</option>
            <option value={500000}>≥ $500k</option>
          </select>
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
            onPrepForCall={(companyId) => navigate(`/companies/${companyId}?precall=1`)}
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
