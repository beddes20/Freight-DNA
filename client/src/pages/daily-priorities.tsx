import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, ShieldAlert, Zap, RefreshCw, TrendingUp, Truck, X } from "lucide-react";
import { NbaCard } from "@/components/NbaCard";
import type { NbaCardData } from "@/components/NbaCard";

// ── Types ──────────────────────────────────────────────────────────────────────

type WorkspaceBucket = "quote_now" | "follow_up" | "defend" | "grow" | "procure_carrier";

interface WorkspaceCard extends NbaCardData {
  bucket: WorkspaceBucket;
}

interface DailyWorkspaceResponse {
  buckets: Record<WorkspaceBucket, WorkspaceCard[]>;
  totalCards: number;
  scopedToUserId: string | null;
}

interface OrgUser {
  id: string;
  name: string;
  role: string;
}

// ── Bucket config ──────────────────────────────────────────────────────────────

const BUCKET_CONFIG: {
  key: WorkspaceBucket;
  label: string;
  description: string;
  emptyHint: string;
  icon: typeof ShieldAlert;
  color: string;
  badgeClass: string;
}[] = [
  {
    key: "defend",
    label: "Defend",
    description: "Accounts at risk of churning or losing volume — act now.",
    emptyHint: "No at-risk accounts right now. Keep up the great relationship work.",
    icon: ShieldAlert,
    color: "text-red-600 dark:text-red-400",
    badgeClass: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  },
  {
    key: "quote_now",
    label: "Quote Now",
    description: "Accounts waiting on a quote or spot rate from you.",
    emptyHint: "No pending quotes — inbox is clear.",
    icon: Zap,
    color: "text-amber-600 dark:text-amber-400",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  },
  {
    key: "follow_up",
    label: "Follow Up",
    description: "Accounts that need a check-in or pending action closed out.",
    emptyHint: "No overdue follow-ups — you're on top of your pipeline.",
    icon: RefreshCw,
    color: "text-blue-600 dark:text-blue-400",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  },
  {
    key: "grow",
    label: "Grow",
    description: "Accounts primed for expansion into new lanes or services.",
    emptyHint: "No expansion signals detected today — check back tomorrow.",
    icon: TrendingUp,
    color: "text-emerald-600 dark:text-emerald-400",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  },
  {
    key: "procure_carrier",
    label: "Procure Carrier",
    description: "Lanes needing carrier coverage or capacity outreach.",
    emptyHint: "No open capacity gaps — lanes are covered.",
    icon: Truck,
    color: "text-purple-600 dark:text-purple-400",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  },
];

// ── WorkspaceCardRow — NbaCard + "Not now" session-dismiss overlay ─────────────
//
// The NbaCard's built-in dismiss is permanent (writes to DB via PATCH
// /api/nba/cards/:id/resolve). The workspace also offers a lighter-weight
// "Not now" session-scoped dismiss (POST /api/nba/dismiss/:cardId, in-memory
// only — resets on server restart) so a rep can temporarily hide a card
// without permanently resolving it on all other NBA surfaces.

function WorkspaceCardRow({
  card,
  onSessionDismiss,
  isPendingDismiss,
}: {
  card: WorkspaceCard;
  onSessionDismiss: (cardId: string) => void;
  isPendingDismiss: boolean;
}) {
  return (
    <div className="relative group" data-testid={`workspace-card-${card.id}`}>
      {/* "Not now" session-dismiss button — visible on hover */}
      <button
        onClick={() => onSessionDismiss(card.id)}
        disabled={isPendingDismiss}
        title="Not now — hide until next session"
        className="absolute top-2 right-2 z-10 hidden group-hover:flex items-center gap-1
                   rounded-md px-2 py-0.5 text-xs font-medium
                   bg-muted/80 text-muted-foreground border border-border
                   hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30
                   transition-colors"
        data-testid={`button-not-now-${card.id}`}
      >
        <X className="h-3 w-3" />
        Not now
      </button>

      {/* NbaCard renders normally; its own dismiss button permanently resolves the card */}
      <NbaCard card={card} />
    </div>
  );
}

// ── Bucket section ─────────────────────────────────────────────────────────────

function BucketSection({
  bucketKey,
  cards,
  onSessionDismiss,
  isPendingDismiss,
}: {
  bucketKey: WorkspaceBucket;
  cards: WorkspaceCard[];
  onSessionDismiss: (cardId: string) => void;
  isPendingDismiss: boolean;
}) {
  const [open, setOpen] = useState(true);
  const config = BUCKET_CONFIG.find(b => b.key === bucketKey)!;
  const Icon = config.icon;

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`bucket-section-${bucketKey}`}>
      <CollapsibleTrigger asChild>
        <button
          className="flex w-full items-center justify-between rounded-lg px-4 py-3 bg-card border border-border hover:bg-muted/40 transition-colors"
          data-testid={`bucket-toggle-${bucketKey}`}
        >
          <div className="flex items-center gap-3">
            <Icon className={`h-5 w-5 ${config.color}`} />
            <span className="font-semibold text-base">{config.label}</span>
            <Badge className={`text-xs ${config.badgeClass} border-0`}>
              {cards.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:block">{config.description}</span>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2 space-y-3 pb-2">
          {cards.length === 0 ? (
            <p
              className="text-sm text-muted-foreground text-center py-5 italic"
              data-testid={`empty-bucket-${bucketKey}`}
            >
              {config.emptyHint}
            </p>
          ) : (
            cards.map(card => (
              <WorkspaceCardRow
                key={card.id}
                card={card}
                onSessionDismiss={onSessionDismiss}
                isPendingDismiss={isPendingDismiss}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function DailyPrioritiesPage() {
  const { user } = useAuth();
  const canScopeToRep = ["admin", "director", "sales_director"].includes(user?.role ?? "");

  const [repId, setRepId] = useState<string>("me");

  const workspaceQuery = useQuery<DailyWorkspaceResponse>({
    queryKey: ["/api/nba/daily-workspace", repId],
    queryFn: async () => {
      const params = repId !== "me" ? `?repId=${repId}` : "";
      const res = await fetch(`/api/nba/daily-workspace${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load workspace");
      return res.json() as Promise<DailyWorkspaceResponse>;
    },
  });

  const usersQuery = useQuery<OrgUser[]>({
    queryKey: ["/api/users"],
    enabled: canScopeToRep,
  });

  const dismissMutation = useMutation({
    mutationFn: (cardId: string) =>
      apiRequest("POST", `/api/nba/dismiss/${cardId}`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/nba/daily-workspace"] });
    },
  });

  const handleSessionDismiss = (cardId: string) => {
    dismissMutation.mutate(cardId);
  };

  const { data, isLoading, error } = workspaceQuery;

  const totalCards = data?.totalCards ?? 0;

  const repOptions: OrgUser[] = (usersQuery.data ?? []).filter(u =>
    ["account_manager", "national_account_manager", "sales", "sales_director"].includes(u.role),
  );

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto" data-testid="page-daily-priorities">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="heading-daily-priorities">
            Today's Priorities
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            All active NBA signals, ranked and bucketed for your shift.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {canScopeToRep && (
            <Select value={repId} onValueChange={setRepId} data-testid="select-rep-filter">
              <SelectTrigger className="w-44" data-testid="trigger-rep-filter">
                <SelectValue placeholder="My workspace" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me" data-testid="select-rep-me">My workspace</SelectItem>
                {repOptions.map(u => (
                  <SelectItem key={u.id} value={u.id} data-testid={`select-rep-${u.id}`}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => void workspaceQuery.refetch()}
            disabled={isLoading}
            data-testid="button-refresh-workspace"
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          {!isLoading && (
            <Badge variant="secondary" data-testid="badge-total-cards">
              {totalCards} signal{totalCards !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-4" data-testid="skeleton-workspace">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-center text-sm text-destructive"
          data-testid="error-workspace"
        >
          Failed to load your priorities. Please try refreshing.
        </div>
      )}

      {/* Five bucket sections — always rendered once data is loaded, even when empty */}
      {!isLoading && !error && data && (
        <div className="space-y-4" data-testid="bucket-sections">
          {BUCKET_CONFIG.map(config => {
            const cards = data.buckets[config.key] ?? [];
            return (
              <BucketSection
                key={config.key}
                bucketKey={config.key}
                cards={cards}
                onSessionDismiss={handleSessionDismiss}
                isPendingDismiss={dismissMutation.isPending}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
