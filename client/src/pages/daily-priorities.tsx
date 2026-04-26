import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Zap,
  RefreshCw,
  TrendingUp,
  Truck,
  X,
  Keyboard,
  ExternalLink,
  Building2,
  User as UserIcon,
} from "lucide-react";
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

// ── WorkspaceCardRow — NbaCard + selection highlight + "Not now" overlay ──────
//
// The NbaCard's built-in dismiss is permanent (writes to DB via PATCH
// /api/nba/cards/:id/resolve). The workspace also offers a lighter-weight
// "Not now" session-scoped dismiss (POST /api/nba/dismiss/:cardId, in-memory
// only — resets on server restart) so a rep can temporarily hide a card
// without permanently resolving it on all other NBA surfaces.

function WorkspaceCardRow({
  card,
  isSelected,
  onSelect,
  onSessionDismiss,
  isPendingDismiss,
}: {
  card: WorkspaceCard;
  isSelected: boolean;
  onSelect: (cardId: string) => void;
  onSessionDismiss: (cardId: string) => void;
  isPendingDismiss: boolean;
}) {
  return (
    <div
      className={`relative group rounded-lg transition-all ${
        isSelected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
          : ""
      }`}
      onClick={() => onSelect(card.id)}
      data-testid={`workspace-card-${card.id}`}
    >
      {/* "Not now" session-dismiss button — visible on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSessionDismiss(card.id);
        }}
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
  selectedCardId,
  onSelect,
  onSessionDismiss,
  isPendingDismiss,
}: {
  bucketKey: WorkspaceBucket;
  cards: WorkspaceCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
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
                isSelected={selectedCardId === card.id}
                onSelect={onSelect}
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

// ── Preview Pane ───────────────────────────────────────────────────────────────
//
// Right-side inline preview of the currently-selected card. Shows the same
// rich detail as the card row plus contextual deep-links so the rep can act
// without leaving the workspace.

function PreviewPane({
  card,
  bucketLabel,
  onClose,
}: {
  card: WorkspaceCard | null;
  bucketLabel: string | null;
  onClose: () => void;
}) {
  if (!card) {
    return (
      <div
        className="hidden lg:flex flex-col items-center justify-center text-center p-6 text-sm text-muted-foreground rounded-lg border border-dashed border-border bg-card/40 min-h-[400px]"
        data-testid="preview-empty"
      >
        <Keyboard className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="font-medium">Select a card to preview</p>
        <p className="text-xs mt-1.5 max-w-xs text-muted-foreground/70">
          Click any card or use{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">j</kbd>
          {" / "}
          <kbd className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">k</kbd>
          {" "}to navigate, then{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">Enter</kbd>
          {" "}to open it in context.
        </p>
      </div>
    );
  }

  const atStakeNumber =
    typeof card.atStakeAmount === "string"
      ? parseFloat(card.atStakeAmount)
      : card.atStakeAmount ?? 0;
  const atStakeFormatted =
    Number.isFinite(atStakeNumber) && atStakeNumber > 0
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(atStakeNumber)
      : null;

  return (
    <div
      className="rounded-lg border border-border bg-card p-5 shadow-sm flex flex-col gap-4"
      data-testid={`preview-pane-${card.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0">
          {bucketLabel && (
            <Badge variant="outline" className="self-start text-xs uppercase tracking-wide">
              {bucketLabel}
            </Badge>
          )}
          <h3 className="text-base font-semibold leading-tight" data-testid="preview-title">
            {card.companyName ?? "Unknown company"}
          </h3>
          {card.primaryContactName && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <UserIcon className="h-3 w-3" />
              {card.primaryContactName}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          title="Close preview (Esc)"
          data-testid="button-preview-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Why this now
          </p>
          <p className="text-foreground" data-testid="preview-why">{card.whyThisNow}</p>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Suggested action
          </p>
          <p className="text-foreground" data-testid="preview-action">{card.suggestedAction}</p>
        </div>

        {card.expectedOutcome && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              Expected outcome
            </p>
            <p className="text-foreground/80">{card.expectedOutcome}</p>
          </div>
        )}

        {card.signalSummary && card.signalSummary.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Signals ({card.signalCount})
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {card.signalSummary.slice(0, 5).map((s, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-muted-foreground/40">•</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {(atStakeFormatted || card.urgencyScore || card.confidence) && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
          {atStakeFormatted && (
            <Badge variant="secondary" className="text-xs" data-testid="preview-at-stake">
              At stake: {atStakeFormatted}
            </Badge>
          )}
          {card.urgencyScore > 0 && (
            <Badge variant="outline" className="text-xs">
              Urgency {card.urgencyScore}
            </Badge>
          )}
          {card.confidence && (
            <Badge variant="outline" className="text-xs capitalize">
              {card.confidence} confidence
            </Badge>
          )}
        </div>
      )}

      {card.companyId && (
        <div className="flex flex-col gap-2 pt-2 border-t border-border">
          <Link href={`/companies/${card.companyId}`}>
            <Button
              variant="default"
              size="sm"
              className="w-full justify-between"
              data-testid="button-preview-open-company"
            >
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                Open {card.companyName ?? "company"}
              </span>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </Link>
          {card.linkedCommitmentId && (
            <Link href={`/customer-quotes?quoteId=${card.linkedCommitmentId}`}>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between"
                data-testid="button-preview-open-quote"
              >
                <span>Open quote</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </Link>
          )}
          {card.linkedLaneId && (
            <Link href={`/lane-work-queue?laneId=${card.linkedLaneId}`}>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between"
                data-testid="button-preview-open-lane"
              >
                <span>Open lane</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// ── Keyboard Shortcuts Help Modal ──────────────────────────────────────────────

function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const ROWS: { keys: string[]; label: string }[] = [
    { keys: ["j", "↓"], label: "Next card" },
    { keys: ["k", "↑"], label: "Previous card" },
    { keys: ["Enter"], label: "Open the selected card's company" },
    { keys: ["Esc"], label: "Clear selection" },
    { keys: ["?"], label: "Show this help" },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="dialog-shortcuts">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {ROWS.map(row => (
            <div key={row.label} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="flex items-center gap-1.5">
                {row.keys.map(k => (
                  <kbd
                    key={k}
                    className="px-2 py-0.5 rounded border border-border bg-muted text-foreground font-mono text-[11px] min-w-[1.5rem] text-center"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function DailyPrioritiesPage() {
  const { user } = useAuth();
  const canScopeToRep = ["admin", "director", "sales_director"].includes(user?.role ?? "");

  const [repId, setRepId] = useState<string>("me");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

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
    onSuccess: (_data, cardId) => {
      // Clear selection if the dismissed card was selected
      setSelectedCardId(prev => (prev === cardId ? null : prev));
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

  // Flat ordered list of cards across all buckets — used for j/k navigation
  // and for finding the currently-selected card details for the preview pane.
  const flatCards = useMemo(() => {
    if (!data) return [];
    return BUCKET_CONFIG.flatMap(b => data.buckets[b.key] ?? []);
  }, [data]);

  // Look up the selected card's full data + bucket label for the preview pane
  const selectedCard = useMemo(
    () => flatCards.find(c => c.id === selectedCardId) ?? null,
    [flatCards, selectedCardId],
  );
  const selectedBucketLabel = selectedCard
    ? BUCKET_CONFIG.find(b => b.key === selectedCard.bucket)?.label ?? null
    : null;

  // If the selected card disappears (e.g. after dismiss/refresh), clear it.
  useEffect(() => {
    if (selectedCardId && !selectedCard) {
      setSelectedCardId(null);
    }
  }, [selectedCardId, selectedCard]);

  // Latest navigation state in a ref so the keyboard handler doesn't have to
  // be re-bound every time the selection changes (fewer re-renders, fewer
  // lost keystrokes during rapid j/k presses).
  const navRef = useRef({ flatCards, selectedCardId, selectedCard });
  navRef.current = { flatCards, selectedCardId, selectedCard };

  // Keyboard shortcuts. Only active when the focus isn't inside an input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in any input/textarea/contenteditable
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      // Don't hijack browser shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const { flatCards: cards, selectedCardId: selId, selectedCard: selCard } = navRef.current;

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcuts(s => !s);
        return;
      }

      if (e.key === "Escape") {
        if (showShortcuts) {
          setShowShortcuts(false);
        } else if (selId) {
          setSelectedCardId(null);
        }
        return;
      }

      if (cards.length === 0) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = selId ? cards.findIndex(c => c.id === selId) : -1;
        const next = cards[Math.min(idx + 1, cards.length - 1)] ?? cards[0];
        if (next) setSelectedCardId(next.id);
        return;
      }

      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = selId ? cards.findIndex(c => c.id === selId) : 0;
        const prev = cards[Math.max(idx - 1, 0)] ?? cards[0];
        if (prev) setSelectedCardId(prev.id);
        return;
      }

      if (e.key === "Enter" && selCard?.companyId) {
        e.preventDefault();
        // Navigate to the selected company. Using window.location keeps this
        // self-contained without dragging in the wouter useLocation hook.
        window.location.assign(`/companies/${selCard.companyId}`);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showShortcuts]);

  // Auto-scroll the selected card into view when navigating via j/k
  useEffect(() => {
    if (!selectedCardId) return;
    const el = document.querySelector(`[data-testid="workspace-card-${selectedCardId}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedCardId]);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto" data-testid="page-daily-priorities">
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

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)"
            data-testid="button-show-shortcuts"
          >
            <Keyboard className="h-4 w-4 mr-1.5" />
            <kbd className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">?</kbd>
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

      {/* Two-column layout: bucket sections (left) + sticky preview pane (right, lg+) */}
      {!isLoading && !error && data && (
        <div
          className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start"
          data-testid="workspace-grid"
        >
          <div className="space-y-4 min-w-0" data-testid="bucket-sections">
            {BUCKET_CONFIG.map(config => {
              const cards = data.buckets[config.key] ?? [];
              return (
                <BucketSection
                  key={config.key}
                  bucketKey={config.key}
                  cards={cards}
                  selectedCardId={selectedCardId}
                  onSelect={setSelectedCardId}
                  onSessionDismiss={handleSessionDismiss}
                  isPendingDismiss={dismissMutation.isPending}
                />
              );
            })}
          </div>

          <aside className="lg:sticky lg:top-6" data-testid="preview-aside">
            <PreviewPane
              card={selectedCard}
              bucketLabel={selectedBucketLabel}
              onClose={() => setSelectedCardId(null)}
            />
          </aside>
        </div>
      )}

      <ShortcutsHelp open={showShortcuts} onOpenChange={setShowShortcuts} />
    </div>
  );
}
