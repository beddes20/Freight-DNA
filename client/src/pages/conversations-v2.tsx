/**
 * Conversations v2 — dev-only cockpit prototype (Task #1081).
 *
 * Reads the SAME backend the production /conversations page reads
 * (/api/internal/conversations + per-thread messages/summary endpoints)
 * and re-lays it into a workflow-first 3-pane cockpit:
 *
 *   • Left rail   — workflow buckets derived client-side from existing
 *                   thread fields. Each bucket shows a live count.
 *   • Center      — denser thread list with sender / lane snippet /
 *                   AI summary line / linked-quote state / owner /
 *                   age chip / primary next-action affordance.
 *   • Right       — workbench: preview, extracted quote facts,
 *                   linked-to-Customer-Quotes status, deep-link
 *                   buttons, and a "What should I do next?" block.
 *
 * Strictly read-only: NO new backend routes, NO schema changes, NO
 * email-plumbing changes. The prototype is gated to admins/directors
 * and labelled "Dev preview" so nobody confuses it with prod.
 */

import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sparkles,
  Inbox,
  UserPlus,
  MailQuestion,
  DollarSign,
  Truck,
  Clock,
  Archive,
  ChevronRight,
  ExternalLink,
  Building2,
  Users,
  FlaskConical,
  Info,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ConversationThread,
  ThreadsResponse,
  EmailMessage,
} from "@/components/conversations/types";
import { hasQuoteSignal } from "@/components/conversations/types";
import {
  formatAgo,
  resolvePreviewSnippet,
  resolveThreadSubject,
} from "@/components/conversations/utils";
import type { ThreadSummaryDTO } from "@/components/conversations/smart-pane-blocks";

// ─── Bucket definitions ────────────────────────────────────────────────────

type V2Bucket =
  | "needs_quote_review"
  | "needs_assignment"
  | "awaiting_my_reply"
  | "quote_linked"
  | "carrier"
  | "snoozed"
  | "archived";

interface BucketDef {
  id: V2Bucket;
  label: string;
  icon: typeof Inbox;
  blurb: string;
}

const BUCKETS: BucketDef[] = [
  {
    id: "needs_quote_review",
    label: "Needs Quote Review",
    icon: DollarSign,
    blurb: "Customer pricing intent — not yet linked to a quote.",
  },
  {
    id: "needs_assignment",
    label: "Needs Assignment",
    icon: UserPlus,
    blurb: "Open threads with no owner.",
  },
  {
    id: "awaiting_my_reply",
    label: "Awaiting My Reply",
    icon: MailQuestion,
    blurb: "You own it and the customer is waiting on you.",
  },
  {
    id: "quote_linked",
    label: "Quote-Linked",
    icon: Sparkles,
    blurb: "Already converted to a customer quote.",
  },
  {
    id: "carrier",
    label: "Carrier / Non-Customer",
    icon: Truck,
    blurb: "Carrier traffic and unattributed senders.",
  },
  { id: "snoozed", label: "Snoozed", icon: Clock, blurb: "Snoozed for later." },
  { id: "archived", label: "Archived", icon: Archive, blurb: "Resolved & filed." },
];

function classifyThread(
  t: ConversationThread,
  myUserId: string | null,
): V2Bucket {
  if (t.waitingState === "archived") return "archived";
  if (t.waitingState === "snoozed") return "snoozed";
  if (t.linkedQuoteId) return "quote_linked";
  if (hasQuoteSignal(t) && !t.linkedQuoteId) return "needs_quote_review";
  if (!t.ownerUserId && t.linkedAccountId) return "needs_assignment";
  if (
    myUserId &&
    t.ownerUserId === myUserId &&
    t.waitingState === "waiting_on_us"
  ) {
    return "awaiting_my_reply";
  }
  if (t.linkedCarrierId || !t.linkedAccountId) return "carrier";
  return "needs_assignment";
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ConversationsV2Page() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [bucket, setBucket] = useState<V2Bucket>("awaiting_my_reply");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [explainerOpen, setExplainerOpen] = useState(true);

  // Gate — admin/director-class only. Normal reps land on the production
  // page with a message so nobody mistakes the prototype for live.
  const allowedRoles = new Set([
    "admin",
    "director",
    "sales_director",
    "national_account_manager",
  ]);
  const allowed = !!user && allowedRoles.has(user.role);

  if (authLoading) {
    return (
      <div className="p-6 space-y-3" data-testid="conversations-v2-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!allowed) {
    return (
      <div
        className="p-8 max-w-xl mx-auto"
        data-testid="conversations-v2-forbidden"
      >
        <Alert>
          <FlaskConical className="w-4 h-4" />
          <AlertTitle>Dev preview</AlertTitle>
          <AlertDescription>
            The Conversations v2 cockpit prototype is limited to admins and
            directors. The production Conversations page is unchanged.
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLocation("/conversations")}
                data-testid="button-back-to-prod-conversations"
              >
                Open production Conversations
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-screen min-h-0 bg-background"
      data-testid="conversations-v2-page"
    >
      <PageHeader
        explainerOpen={explainerOpen}
        onToggleExplainer={() => setExplainerOpen((v) => !v)}
      />
      {explainerOpen && <Explainer onClose={() => setExplainerOpen(false)} />}
      <div className="flex-1 min-h-0 grid grid-cols-[240px_minmax(0,1fr)_minmax(0,1.1fr)] divide-x">
        <BucketRail
          bucket={bucket}
          onSelect={(b) => {
            setBucket(b);
            setSelectedId(null);
          }}
        />
        <CenterList
          bucket={bucket}
          selectedId={selectedId}
          onSelect={setSelectedId}
          myUserId={user?.id ?? null}
        />
        <Workbench selectedId={selectedId} myUserId={user?.id ?? null} />
      </div>
    </div>
  );
}

// ─── Header + explainer ────────────────────────────────────────────────────

function PageHeader({
  explainerOpen,
  onToggleExplainer,
}: {
  explainerOpen: boolean;
  onToggleExplainer: () => void;
}) {
  return (
    <header
      className="flex items-center justify-between gap-3 px-5 py-3 border-b bg-muted/30"
      data-testid="conversations-v2-header"
    >
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-lg font-semibold truncate">Conversations v2</h1>
        <Badge
          className="bg-amber-500 text-white gap-1 shrink-0"
          data-testid="badge-dev-preview"
        >
          <FlaskConical className="w-3 h-3" />
          Dev preview
        </Badge>
        <span className="text-xs text-muted-foreground hidden md:inline">
          Workflow-first cockpit prototype — reads the same data as production.
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onToggleExplainer}
          data-testid="button-toggle-explainer"
        >
          <Info className="w-3.5 h-3.5 mr-1.5" />
          {explainerOpen ? "Hide" : "About this prototype"}
        </Button>
        <Link href="/conversations">
          <Button
            variant="ghost"
            size="sm"
            data-testid="link-back-to-prod"
          >
            Open production
            <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
          </Button>
        </Link>
      </div>
    </header>
  );
}

function Explainer({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="border-b bg-amber-50/60 dark:bg-amber-950/20 px-5 py-3"
      data-testid="explainer-panel"
    >
      <div className="grid gap-3 md:grid-cols-3 text-xs">
        <div>
          <p className="font-semibold text-foreground mb-1">
            What today's Conversations optimizes for
          </p>
          <p className="text-muted-foreground leading-snug">
            A generic email inbox: mailbox-style buckets (Mine, Unowned,
            Archived), a passive reader on the right, low row density. Reps
            triage one thread at a time and have to open it to know whether
            it's a quote, who owns it, or what to do next.
          </p>
        </div>
        <div>
          <p className="font-semibold text-foreground mb-1">
            What v2 optimizes for
          </p>
          <p className="text-muted-foreground leading-snug">
            Freight workflow-first. Buckets reflect the work to do (Needs
            Quote Review, Needs Assignment, Awaiting My Reply, Quote-Linked,
            Carrier). Each row shows the AI summary, linked-quote status,
            and a primary next-action so reps can act without opening every
            message. The right pane is a workbench, not a reader.
          </p>
        </div>
        <div>
          <p className="font-semibold text-foreground mb-1">Recommendation</p>
          <p className="text-muted-foreground leading-snug">
            Treat as a concept. The buckets and workbench shape are worth
            graduating in the next rollout, but should ship behind a feature
            flag with a migration plan for saved views, bulk actions, and
            the snooze/archive flows that the production page already
            supports.
          </p>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onClose}
          data-testid="button-close-explainer"
        >
          Hide
        </Button>
      </div>
    </div>
  );
}

// ─── Data fetching ─────────────────────────────────────────────────────────

// Page-size cap. The /api/internal/conversations endpoint paginates and
// has no dedicated count route, so the rail counts are necessarily a
// sampled view. We pick a generous cap and surface a "+" suffix on the
// badge whenever a bucket hits the cap, so reps don't read a sampled
// number as a true total.
const PAGE_LIMIT = 500;

function buildQueryParams(bucket: V2Bucket): string {
  const p = new URLSearchParams();
  p.set("limit", String(PAGE_LIMIT));
  if (bucket === "archived") p.set("archived", "true");
  else if (bucket === "snoozed") p.set("snoozed", "true");
  else p.set("sort", "recency");
  return p.toString();
}

function useThreads(bucket: V2Bucket) {
  return useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "v2", bucket],
    queryFn: async () => {
      const res = await fetch(
        `/api/internal/conversations?${buildQueryParams(bucket)}`,
      );
      if (!res.ok) throw new Error("Failed to load conversations");
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
}

// ─── Left rail ─────────────────────────────────────────────────────────────

function BucketRail({
  bucket,
  onSelect,
}: {
  bucket: V2Bucket;
  onSelect: (b: V2Bucket) => void;
}) {
  // Fetch the live (non-archived/snoozed) pool once and derive counts for
  // the workflow buckets entirely client-side. Archived & snoozed counts
  // come from their own dedicated endpoints because they're excluded from
  // the live list.
  const { user } = useAuth();
  const { data: live } = useThreads("awaiting_my_reply");
  const { data: archived } = useThreads("archived");
  const { data: snoozed } = useThreads("snoozed");

  const counts = useMemo<Record<V2Bucket, number>>(() => {
    const c: Record<V2Bucket, number> = {
      needs_quote_review: 0,
      needs_assignment: 0,
      awaiting_my_reply: 0,
      quote_linked: 0,
      carrier: 0,
      snoozed: snoozed?.threads.length ?? 0,
      archived: archived?.threads.length ?? 0,
    };
    for (const t of live?.threads ?? []) {
      const b = classifyThread(t, user?.id ?? null);
      if (b !== "archived" && b !== "snoozed") c[b]++;
    }
    return c;
  }, [live, archived, snoozed, user?.id]);

  // The conversations endpoint is paginated and returns no total. When a
  // bucket's source page hits PAGE_LIMIT we mark its count as "sampled"
  // so reps know the real number is at least this much, not exactly it.
  const sampled: Record<V2Bucket, boolean> = useMemo(() => {
    const liveCapped = (live?.threads.length ?? 0) >= PAGE_LIMIT;
    const archivedCapped = (archived?.threads.length ?? 0) >= PAGE_LIMIT;
    const snoozedCapped = (snoozed?.threads.length ?? 0) >= PAGE_LIMIT;
    return {
      needs_quote_review: liveCapped,
      needs_assignment: liveCapped,
      awaiting_my_reply: liveCapped,
      quote_linked: liveCapped,
      carrier: liveCapped,
      snoozed: snoozedCapped,
      archived: archivedCapped,
    };
  }, [live, archived, snoozed]);

  return (
    <nav
      className="flex flex-col gap-0.5 p-2 overflow-y-auto bg-muted/20"
      data-testid="v2-bucket-rail"
    >
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        Workflow queues
      </div>
      {BUCKETS.map((b) => {
        const Icon = b.icon;
        const active = bucket === b.id;
        const count = counts[b.id];
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => onSelect(b.id)}
            className={cn(
              "flex items-start gap-2 px-3 py-2 rounded-md text-sm text-left w-full transition-colors",
              active
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-muted text-foreground",
            )}
            title={b.blurb}
            data-testid={`v2-bucket-${b.id}`}
            aria-pressed={active}
          >
            <Icon
              className={cn(
                "w-4 h-4 shrink-0 mt-0.5",
                active ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="flex-1 min-w-0">
              <span className="block truncate">{b.label}</span>
              <span className="block text-[11px] text-muted-foreground font-normal truncate">
                {b.blurb}
              </span>
            </span>
            {count > 0 && (
              <span
                className={cn(
                  "text-xs px-1.5 py-0.5 rounded-full font-medium tabular-nums shrink-0",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
                data-testid={`v2-count-${b.id}`}
                title={
                  sampled[b.id]
                    ? `Sampled from latest ${PAGE_LIMIT} threads — true total may be higher`
                    : `Live count`
                }
              >
                {count}
                {sampled[b.id] ? "+" : ""}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Center: dense thread list ─────────────────────────────────────────────

function CenterList({
  bucket,
  selectedId,
  onSelect,
  myUserId,
}: {
  bucket: V2Bucket;
  selectedId: string | null;
  onSelect: (id: string) => void;
  myUserId: string | null;
}) {
  // Archived / snoozed have their own endpoint; everything else is derived
  // from the live pool so all workflow buckets stay in sync from one fetch.
  const liveQuery = useThreads("awaiting_my_reply");
  const archivedQuery = useThreads("archived");
  const snoozedQuery = useThreads("snoozed");

  const sourceQuery =
    bucket === "archived"
      ? archivedQuery
      : bucket === "snoozed"
        ? snoozedQuery
        : liveQuery;

  const filtered = useMemo(() => {
    const all = sourceQuery.data?.threads ?? [];
    if (bucket === "archived" || bucket === "snoozed") return all;
    return all.filter((t) => classifyThread(t, myUserId) === bucket);
  }, [sourceQuery.data, bucket, myUserId]);

  const meta = BUCKETS.find((b) => b.id === bucket)!;

  return (
    <section
      className="flex flex-col min-h-0 overflow-hidden"
      data-testid="v2-center-list"
    >
      <header className="px-4 py-2.5 border-b bg-background flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate" data-testid="v2-bucket-title">
            {meta.label}
          </h2>
          <p className="text-xs text-muted-foreground truncate">{meta.blurb}</p>
        </div>
        <Badge variant="outline" className="text-xs shrink-0" data-testid="v2-bucket-count">
          {filtered.length}
        </Badge>
      </header>

      <div className="flex-1 overflow-y-auto">
        {sourceQuery.isLoading ? (
          <div className="divide-y">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="px-3 py-2 space-y-1.5">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : sourceQuery.isError ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="v2-error">
            Couldn't load conversations.
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16 gap-2"
            data-testid={`v2-empty-${bucket}`}
          >
            <meta.icon className="w-10 h-10 text-muted-foreground/40" />
            <p className="text-sm font-medium">Nothing here</p>
            <p className="text-xs text-muted-foreground max-w-xs">{meta.blurb}</p>
          </div>
        ) : (
          <ul className="divide-y" data-testid="v2-thread-list">
            {filtered.map((t) => (
              <DenseRow
                key={t.id}
                thread={t}
                active={selectedId === t.id}
                onSelect={() => onSelect(t.id)}
                myUserId={myUserId}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// Read-only fetch of the *cached* server-side AI summary. Never POSTs;
// never triggers regeneration. If no cached summary exists yet we just
// render nothing in that row — this prototype must not generate AI work.
function useCachedSummary(threadId: string | null) {
  return useQuery<{ summary: ThreadSummaryDTO | null }>({
    queryKey: ["/api/internal/conversations", threadId ?? "", "summary"],
    enabled: !!threadId,
    queryFn: async () => {
      const res = await fetch(
        `/api/internal/conversations/${encodeURIComponent(threadId!)}/summary`,
      );
      if (!res.ok) throw new Error("");
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
}

function DenseRow({
  thread,
  active,
  onSelect,
  myUserId,
}: {
  thread: ConversationThread;
  active: boolean;
  onSelect: () => void;
  myUserId: string | null;
}) {
  const { data: msgData } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", thread.id, "messages"],
    queryFn: async () => {
      const res = await fetch(
        `/api/internal/conversations/${encodeURIComponent(thread.id)}/messages`,
      );
      if (!res.ok) throw new Error("");
      return res.json();
    },
    staleTime: 60_000,
  });
  const { data: summaryData } = useCachedSummary(thread.id);
  const summary = summaryData?.summary?.summary ?? null;
  const last = msgData?.messages?.[msgData.messages.length - 1];
  const subject = resolveThreadSubject({ messages: msgData?.messages ?? [] });
  const lane = deriveLaneSnippet(subject, last?.body ?? "");
  // Plain message snippet kept as a tertiary fallback only when there's
  // neither an AI summary nor a derivable lane — so each row always has
  // *some* content beyond the subject line.
  const preview =
    !summary && !lane ? resolvePreviewSnippet(last?.body ?? "") : null;

  const isCustomer = !!thread.linkedAccountId && !thread.linkedCarrierId;
  const isCarrier = !!thread.linkedCarrierId;
  const sender = last?.fromEmail ?? "—";
  const company =
    thread.accountName ??
    thread.carrierName ??
    (sender.includes("@") ? sender.split("@")[1] : null);

  const ageSrc = thread.lastIncomingAt ?? thread.lastEmailAt ?? thread.updatedAt;
  const ageMs = ageSrc ? Date.now() - new Date(ageSrc).getTime() : 0;
  const overdue =
    thread.waitingState === "waiting_on_us" && ageMs > 24 * 60 * 60 * 1000;

  const nextAction = suggestNextAction(thread, myUserId);

  return (
    <li
      onClick={onSelect}
      className={cn(
        "group flex flex-col gap-1 px-3 py-2 cursor-pointer hover:bg-muted/40",
        active && "bg-muted/60 border-l-2 border-l-primary -ml-px",
      )}
      data-testid={`v2-row-${thread.id}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-[10px] uppercase font-bold px-1.5 py-0.5 rounded shrink-0 tracking-wide",
            isCustomer && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
            isCarrier && "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
            !isCustomer && !isCarrier && "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200",
          )}
          data-testid={`v2-row-side-${thread.id}`}
        >
          {isCarrier ? "CAR" : isCustomer ? "CUST" : "?"}
        </span>
        <span
          className="text-sm font-medium truncate flex-1"
          data-testid={`v2-row-subject-${thread.id}`}
        >
          {subject}
        </span>
        {thread.linkedQuoteId && (
          <Badge
            className="text-[10px] bg-emerald-600 text-white gap-1 shrink-0"
            data-testid={`v2-row-quote-linked-${thread.id}`}
          >
            <DollarSign className="w-2.5 h-2.5" />
            Quote
          </Badge>
        )}
        {hasQuoteSignal(thread) && !thread.linkedQuoteId && (
          <Badge
            className="text-[10px] bg-amber-500 text-white shrink-0"
            data-testid={`v2-row-quote-signal-${thread.id}`}
          >
            Quote signal
          </Badge>
        )}
        <span
          className={cn(
            "text-[11px] tabular-nums shrink-0",
            overdue ? "text-red-600 font-medium" : "text-muted-foreground",
          )}
          data-testid={`v2-row-age-${thread.id}`}
        >
          {ageSrc ? formatAgo(ageSrc) : "—"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate flex-1" data-testid={`v2-row-sender-${thread.id}`}>
          <span className="font-medium text-foreground/80">{company ?? sender}</span>
          {company && sender !== company && (
            <span className="ml-1 opacity-70">· {sender}</span>
          )}
        </span>
        <span className="shrink-0" data-testid={`v2-row-owner-${thread.id}`}>
          {thread.ownerName ? (
            thread.ownerName
          ) : (
            <span className="italic">Unowned</span>
          )}
        </span>
      </div>
      {lane && (
        <p
          className="text-[11px] text-foreground/80 truncate font-medium"
          data-testid={`v2-row-lane-${thread.id}`}
          title={lane}
        >
          <span className="text-muted-foreground font-normal mr-1">Lane:</span>
          {lane}
        </p>
      )}
      {summary && (
        <p
          className="text-[11px] text-muted-foreground line-clamp-2 leading-snug"
          data-testid={`v2-row-summary-${thread.id}`}
          title={summary}
        >
          <Sparkles className="w-2.5 h-2.5 inline-block mr-1 -mt-0.5 text-indigo-500" />
          {summary}
        </p>
      )}
      {preview && (
        <p
          className="text-[11px] text-muted-foreground truncate italic"
          data-testid={`v2-row-preview-${thread.id}`}
        >
          {preview}
        </p>
      )}
      {nextAction && (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span
            className="text-[11px] text-indigo-700 dark:text-indigo-300 inline-flex items-center gap-1 truncate"
            data-testid={`v2-row-next-${thread.id}`}
          >
            <ArrowRight className="w-3 h-3 shrink-0" />
            {nextAction.label}
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </div>
      )}
    </li>
  );
}

// ─── Right pane: workbench ─────────────────────────────────────────────────

function Workbench({
  selectedId,
  myUserId,
}: {
  selectedId: string | null;
  myUserId: string | null;
}) {
  if (!selectedId) {
    return (
      <aside
        className="flex flex-col items-center justify-center text-center px-8 py-16 gap-2 bg-muted/10"
        data-testid="v2-workbench-empty"
      >
        <Inbox className="w-10 h-10 text-muted-foreground/40" />
        <p className="text-sm font-medium">Pick a thread</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          Selecting a thread on the left opens the cockpit workbench: preview,
          extracted quote facts, linked quote status, and what to do next.
        </p>
      </aside>
    );
  }
  return <WorkbenchInner threadId={selectedId} myUserId={myUserId} />;
}

function WorkbenchInner({
  threadId,
  myUserId,
}: {
  threadId: string;
  myUserId: string | null;
}) {
  // We don't have a single "fetch one thread" endpoint, so we re-derive
  // the thread DTO from the cached threads response. If it's not in the
  // cache (rare across bucket switches), we fall back to a per-thread
  // messages-only view so the pane never goes blank.
  const live = useThreads("awaiting_my_reply").data?.threads ?? [];
  const archived = useThreads("archived").data?.threads ?? [];
  const snoozed = useThreads("snoozed").data?.threads ?? [];
  const thread = useMemo(
    () =>
      [...live, ...archived, ...snoozed].find((t) => t.id === threadId) ?? null,
    [live, archived, snoozed, threadId],
  );

  const { data: msgData, isLoading } = useQuery<{ messages: EmailMessage[] }>({
    queryKey: ["/api/internal/conversations", threadId, "messages"],
    queryFn: async () => {
      const res = await fetch(
        `/api/internal/conversations/${encodeURIComponent(threadId)}/messages`,
      );
      if (!res.ok) throw new Error("Failed to load messages");
      return res.json();
    },
  });
  const messages = msgData?.messages ?? [];
  const latestInbound = [...messages].reverse().find((m) => m.direction !== "outbound");
  const subject = resolveThreadSubject({ messages });

  const next = thread ? suggestNextAction(thread, myUserId) : null;
  const facts = latestInbound ? extractQuoteFacts(latestInbound.body ?? "") : [];

  return (
    <aside
      className="flex flex-col min-h-0 overflow-hidden bg-background"
      data-testid="v2-workbench"
    >
      <header className="px-5 py-3 border-b bg-muted/30">
        <h2
          className="text-base font-semibold truncate"
          data-testid="v2-workbench-subject"
        >
          {subject}
        </h2>
        {thread && (
          <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-muted-foreground">
            {thread.linkedAccountId ? (
              <span className="inline-flex items-center gap-1">
                <Building2 className="w-3 h-3" />
                {thread.accountName ?? "Customer"}
              </span>
            ) : thread.linkedCarrierId ? (
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" />
                {thread.carrierName ?? "Carrier"}
              </span>
            ) : (
              <span className="italic">Unattributed sender</span>
            )}
            <span>·</span>
            <span>
              Owner: {thread.ownerName ?? <span className="italic">Unassigned</span>}
            </span>
            <span>·</span>
            <span>State: {thread.waitingState.replace(/_/g, " ")}</span>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <NextActionBlock thread={thread} suggestion={next} />

        <ReadOnlySummaryCard threadId={threadId} />

        <Card title="Linked to Customer Quotes">
          {thread?.linkedQuoteId ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5" />
                Linked to Quote #{thread.linkedQuoteId.slice(0, 8)}
              </span>
              <Link
                href={`/quote-requests?quote=${encodeURIComponent(thread.linkedQuoteId)}`}
              >
                <Button size="sm" variant="outline" data-testid="v2-link-open-quote">
                  Open quote
                  <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            </div>
          ) : thread && hasQuoteSignal(thread) ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              This looks like a quote request but isn't linked yet. In the
              production page, the workbench would offer a one-click
              "Convert to quote" here.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No quote signal detected on this thread.
            </p>
          )}
        </Card>

        <Card title="Extracted quote facts">
          {facts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No origin / destination / equipment terms found in the latest
              inbound message.
            </p>
          ) : (
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="font-medium" data-testid={`v2-fact-${f.label.toLowerCase()}`}>
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <Card title="Deep links">
          <div className="flex flex-wrap gap-2">
            <Link href="/quote-requests">
              <Button size="sm" variant="outline" data-testid="v2-link-quote-requests">
                Quote Requests
                <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </Link>
            {thread?.linkedAccountId && (
              <Link href={`/companies/${encodeURIComponent(thread.linkedAccountId)}`}>
                <Button size="sm" variant="outline" data-testid="v2-link-customer">
                  Customer
                  <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            )}
            <Link href="/available-freight">
              <Button size="sm" variant="outline" data-testid="v2-link-available-freight">
                Available Freight
                <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </Link>
            <Link href={`/conversations?threadId=${encodeURIComponent(thread?.threadId ?? "")}`}>
              <Button size="sm" variant="ghost" data-testid="v2-link-prod-thread">
                Open in production
                <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </Link>
          </div>
        </Card>

        <Card title="Latest message">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : latestInbound ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                From {latestInbound.fromEmail ?? "—"} ·{" "}
                {latestInbound.providerSentAt
                  ? formatAgo(latestInbound.providerSentAt)
                  : "—"}
              </p>
              <p className="text-sm whitespace-pre-line line-clamp-[12]">
                {resolvePreviewSnippet(latestInbound.body ?? "") ||
                  "(no body)"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No inbound messages on this thread.
            </p>
          )}
        </Card>
      </div>
    </aside>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-lg border bg-card text-card-foreground p-3"
      data-testid={`v2-card-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
    >
      <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        {title}
      </h3>
      {children}
    </section>
  );
}

// ─── Suggestion block ──────────────────────────────────────────────────────

interface SuggestedAction {
  label: string;
  detail: string;
  primary?: boolean;
}

function suggestNextAction(
  t: ConversationThread,
  myUserId: string | null,
): SuggestedAction | null {
  if (t.waitingState === "archived") return null;
  if (t.waitingState === "snoozed") {
    return { label: "Snoozed — wakes later", detail: "No action needed yet." };
  }
  if (hasQuoteSignal(t) && !t.linkedQuoteId) {
    return {
      label: "Convert to a customer quote",
      detail: "This thread carries a pricing intent and isn't yet a quote.",
      primary: true,
    };
  }
  if (t.linkedQuoteId) {
    return {
      label: "Open the linked quote",
      detail: "Jump to the customer-quotes record this thread became.",
      primary: true,
    };
  }
  if (!t.ownerUserId) {
    return {
      label: "Assign an owner",
      detail: "No rep owns this thread yet.",
      primary: true,
    };
  }
  if (
    myUserId &&
    t.ownerUserId === myUserId &&
    t.waitingState === "waiting_on_us"
  ) {
    return {
      label: "Draft the next reply",
      detail: "You own it and the customer is waiting on you.",
      primary: true,
    };
  }
  if (t.linkedCarrierId) {
    return {
      label: "Review carrier intel",
      detail: "Carrier-side traffic — log capacity or pricing notes.",
    };
  }
  return null;
}

function NextActionBlock({
  thread,
  suggestion,
}: {
  thread: ConversationThread | null;
  suggestion: SuggestedAction | null;
}) {
  return (
    <section
      className="rounded-lg border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-950/20 px-4 py-3"
      data-testid="v2-next-action"
    >
      <p className="text-[11px] uppercase tracking-wider font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
        What should I do next?
      </p>
      {suggestion ? (
        <>
          <p className="text-sm font-medium" data-testid="v2-next-label">
            {suggestion.label}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {suggestion.detail}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing pressing — this thread is quiet.
        </p>
      )}
      {thread && (
        <p className="text-[11px] text-muted-foreground mt-2 italic">
          Prototype suggestion derived client-side from the thread's existing
          fields. The production "Suggested next action" engine is unchanged.
        </p>
      )}
    </section>
  );
}

// ─── Read-only summary card (no regenerate) ───────────────────────────────
// Reads the cached AI summary the production page already generated.
// Deliberately *no* mutation affordance — this prototype must not trigger
// new AI calls. If the summary isn't cached yet, we say so.

function ReadOnlySummaryCard({ threadId }: { threadId: string }) {
  const { data, isLoading, isError } = useCachedSummary(threadId);
  const s = data?.summary ?? null;
  return (
    <Card title="AI summary (read-only)">
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground" data-testid="v2-summary-error">
          Couldn't load the cached summary.
        </p>
      ) : !s ? (
        <p className="text-sm text-muted-foreground" data-testid="v2-summary-empty">
          No cached summary yet. The prototype intentionally does not
          trigger new AI generation — open the thread in production to
          regenerate.
        </p>
      ) : (
        <div data-testid="v2-summary">
          <p className="text-sm leading-snug whitespace-pre-line text-foreground">
            {s.summary}
          </p>
          <p className="text-[11px] text-muted-foreground mt-2">
            Based on {s.messageCount} message{s.messageCount === 1 ? "" : "s"}
            {s.stale && (
              <span className="ml-2 text-amber-700 dark:text-amber-400">
                (stale — open in production to refresh)
              </span>
            )}
          </p>
        </div>
      )}
    </Card>
  );
}

// ─── Lane snippet derivation ──────────────────────────────────────────────
// Pure heuristic over the existing subject + body. Looks for the same
// origin/destination shapes the inline classifier recognizes so reps can
// see the lane without opening the thread. Returns a single short string
// like "Atlanta, GA → Dallas, TX · Reefer". Returns null when no
// confident lane signal is found — we never bluff.

function deriveLaneSnippet(subject: string, body: string): string | null {
  const text = `${subject ?? ""} \n ${body ?? ""}`.replace(/\s+/g, " ").slice(0, 4000);
  const od =
    text.match(/from\s+([A-Za-z .,'-]+?)\s+to\s+([A-Za-z .,'-]+?)(?:[,.\s]|$)/i) ??
    text.match(/([A-Z][A-Za-z .]+,\s*[A-Z]{2})\s*(?:->|→|to|–|—)\s*([A-Z][A-Za-z .]+,\s*[A-Z]{2})/);
  if (!od) return null;
  const eq = text.match(/\b(reefer|dry\s*van|van|flatbed|step\s*deck|power[- ]only|hotshot)\b/i);
  const o = od[1].trim();
  const d = od[2].trim();
  return eq ? `${o} → ${d} · ${eq[1]}` : `${o} → ${d}`;
}

// ─── Tiny client-side fact extractor ──────────────────────────────────────
// Pure heuristic over the message body so the workbench has *something*
// useful to show without a new server call. Recognizes a handful of common
// freight-quote shapes (origin/destination, equipment, weight, pickup
// date). Misses are fine — the card just shows "no facts".

interface QuoteFact {
  label: string;
  value: string;
}

function extractQuoteFacts(body: string): QuoteFact[] {
  if (!body) return [];
  const text = body.replace(/\s+/g, " ").slice(0, 4000);
  const facts: QuoteFact[] = [];

  const od =
    text.match(/from\s+([A-Za-z .,'-]+?)\s+to\s+([A-Za-z .,'-]+?)(?:[,.\s]|$)/i) ??
    text.match(/([A-Z][A-Za-z .]+,\s*[A-Z]{2})\s*(?:->|→|to|–|—)\s*([A-Z][A-Za-z .]+,\s*[A-Z]{2})/);
  if (od) {
    facts.push({ label: "Origin", value: od[1].trim() });
    facts.push({ label: "Destination", value: od[2].trim() });
  }

  const eq = text.match(/\b(reefer|dry\s*van|van|flatbed|step\s*deck|power[- ]only|hotshot)\b/i);
  if (eq) facts.push({ label: "Equipment", value: eq[1].replace(/\s+/g, " ") });

  const wt = text.match(/\b(\d{1,2}[,.]?\d{3,5})\s*(lbs?|pounds?|kg)\b/i);
  if (wt) facts.push({ label: "Weight", value: `${wt[1]} ${wt[2]}` });

  const pickup = text.match(/\bpick(?:up)?\s*(?:on|date)?[: ]+([A-Za-z0-9 ,/-]{3,30})/i);
  if (pickup) facts.push({ label: "Pickup", value: pickup[1].trim() });

  const rate = text.match(/\$\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?)/);
  if (rate) facts.push({ label: "Rate cited", value: `$${rate[1]}` });

  return facts.slice(0, 6);
}
