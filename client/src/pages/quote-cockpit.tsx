// Phase 1 — Customer Quote Cockpit (additive surface).
//
// Route: /quote-requests/:id
//
// This is the FULL-PAGE decision surface for a single customer quote
// opportunity. It coexists with the existing /quote-requests list +
// drawer (which stays unchanged for triage and quick preview).
//
// Phase 1 contract (per the approved plan in this session):
//   - Layout only. No new server endpoints. No schema changes.
//   - Reuses the SAME detail endpoint as the drawer
//     (GET /api/customer-quotes/quote/:id) so cockpit + drawer always
//     agree on what data exists for a quote.
//   - Reuses the same exported sub-components the drawer uses where
//     they exist as standalone files (PricingRecommendationCard,
//     QuoteDetailsCard, PricingIntelGate, ContextNotePanel,
//     AttributionDrawer, EmailThreadViewerModal, LiveSyncPill).
//   - Internal-to-quote-requests.tsx helpers (LaneCard, ConfidenceCard,
//     SourceThreadCard, ActivityTimeline) are deliberately NOT
//     extracted in Phase 1 — that refactor is Phase 5 work. The
//     cockpit renders minimal inline equivalents instead so we don't
//     touch the drawer file.
//   - Status / tone / formatting constants are duplicated inline with
//     a "keep in sync" comment. They will be lifted to a shared module
//     in Phase 5 when the cockpit and drawer both stabilize.
//
// Pull-forward from Phase 2 (called out in the proposal):
//   The detail endpoint ALREADY returns relatedSameLane,
//   relatedSameCustomer, and relatedSameLaneGroup arrays (the drawer
//   discards them). Surfacing them in a basic Similar Quotes panel
//   costs zero new server work and gives reps real comps in Phase 1.
//   The deterministic similarity scorer + explanation chips are still
//   Phase 2 — these are raw lists, presented honestly as such.
//
// Trust-layer primitives preserved:
//   - LiveSyncPill (testId="pill-live-sync-quote-cockpit") at the top
//     so the cockpit reads the same live-update health as the list.
//   - useLiveSync(["customer_quote", "email_thread"]) so PATCHes from
//     other tabs / the drawer / the email pipeline invalidate this
//     query the same way they invalidate the drawer's.
//   - AttributionDrawer mounted at the page level and triggered via
//     the same window CustomEvent ("customer-quotes:show-attribution")
//     used everywhere else.

import { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft, Mail, Check, X, Pause, MoreHorizontal, AlertTriangle,
  Truck, MapPin, Calendar, Users, ExternalLink, Sparkles, History,
  DollarSign, Lightbulb, FileText,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useLiveSync } from "@/hooks/useLiveSync";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isQuoteOpportunitiesRole } from "@shared/quoteOpportunitiesRoles";
import { formatCustomerName } from "@shared/laneFormatters";
import { computeQuoteSla, formatSlaBadge } from "@shared/quoteSla";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

import { LiveSyncPill } from "@/components/live-sync/LiveSyncPill";
import { PricingRecommendationCard } from "@/components/PricingRecommendationCard";
import { QuoteDetailsCard } from "@/components/quote-requests/QuoteDetailsCard";
import { PricingIntelGate } from "@/components/quote-requests/PricingIntelGate";
import { AttributionDrawer } from "@/components/customer-quotes/AttributionDrawer";
import { ContextNotePanel } from "@/components/context-notes";
import { EmailThreadViewerModal } from "@/components/conversations/email-thread-viewer-modal";

// ─── Types (mirror /api/customer-quotes/quote/:id response shape) ────────
//
// Kept in sync manually with quote-requests.tsx. They both consume the
// same endpoint; the duplication is intentional for Phase 1 and will be
// lifted to a shared types file in Phase 5.

type Quote = {
  id: string;
  organizationId: string;
  customerId: string;
  customerName: string;
  repId: string | null;
  repName: string;
  laneGroupId: string | null;
  carrierId: string | null;
  carrierName: string | null;
  outcomeReasonId: string | null;
  outcomeReasonLabel: string | null;
  requestDate: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  quotedAmount: string | null;
  validThrough: string | null;
  outcomeStatus: string;
  carrierPaid: string | null;
  responseTimeHours: string | null;
  source: string;
  sourceReference: string | null;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  notes: string | null;
  score: string | null;
  slaState?: "ok" | "warning" | "breached" | "na";
  minutesSinceRequest?: number;
  snoozedUntil?: string | null;
  isSnoozed?: boolean;
};

type QuoteEvent = {
  id: string;
  quoteId: string;
  eventType: string;
  occurredAt: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
};

type QuoteSourceMessage = {
  messageId: string;
  threadId: string | null;
  providerMessageId: string | null;
  subject: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
};

type Customer = {
  id: string;
  organizationId: string;
  name: string;
  segment: string | null;
  partyType?: "customer" | "carrier" | "unknown";
};

type QuoteDetail = {
  opp: Quote;
  events: QuoteEvent[];
  customer: Customer | null;
  rep: { id: string; organizationId: string; name: string; email: string | null } | null;
  carrier: { id: string; name: string } | null;
  reason: { id: string; code: string; label: string; category: string } | null;
  relatedSameLane: Quote[];
  relatedSameCustomer: Quote[];
  relatedSameLaneGroup: Quote[];
  lwqLaneId: string | null;
  sourceMessage: QuoteSourceMessage | null;
  outcomeFlipContext: Record<string, unknown>;
};

// ─── Constants & helpers ─────────────────────────────────────────────────
//
// Mirrors STATUS_LABELS / STATUS_TONE / isTerminal / inferIsSnoozed /
// initials / relativeTime in quote-requests.tsx — keep in sync until
// Phase 5 extracts them to a shared module.

const STATUS_LABELS: Record<string, string> = {
  pending: "New",
  quoted: "Quoted",
  won: "Won",
  won_low_margin: "Won (low margin)",
  lost_price: "Lost — price",
  lost_service: "Lost — service",
  lost_timing: "Lost — timing",
  lost_incumbent: "Lost — incumbent",
  no_response: "No response",
  expired: "Expired",
  attached: "Attached",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  quoted: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  won: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  won_low_margin: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30",
  lost_price: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_service: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_timing: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_incumbent: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  no_response: "bg-muted text-muted-foreground border-border",
  expired: "bg-muted text-muted-foreground border-border",
  attached: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) {
    const s = Math.abs(Math.floor(diff / 1000));
    if (s < 60) return `in ${s}s`;
    if (s < 3600) return `in ${Math.floor(s / 60)}m`;
    if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
    return `in ${Math.floor(s / 86400)}d`;
  }
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function isTerminal(status: string): boolean {
  return [
    "won", "won_low_margin",
    "lost_price", "lost_service", "lost_timing", "lost_incumbent",
    "no_response", "expired", "attached",
  ].includes(status);
}

function inferIsSnoozed(q: Quote): boolean {
  if (typeof q.isSnoozed === "boolean") return q.isSnoozed;
  if (!q.snoozedUntil) return false;
  return Date.parse(q.snoozedUntil) > Date.now();
}

function fmtMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!isFinite(n) || n === 0) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

// ─── Top-level page (auth gate + data load) ──────────────────────────────

export default function QuoteCockpitPage(): JSX.Element {
  const auth = useAuth();
  const role = auth?.user?.role ?? "";
  const allowed = isQuoteOpportunitiesRole(role);

  const [, params] = useRoute<{ id: string }>("/quote-requests/:id");
  const quoteId = params?.id ?? null;

  if (!allowed) {
    return (
      <div className="p-6" data-testid="cockpit-forbidden">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold mb-2">Permission denied</h1>
          <p className="text-sm text-muted-foreground">
            You do not have permission to view Quote Requests.
          </p>
        </Card>
      </div>
    );
  }

  if (!quoteId) {
    return (
      <div className="p-6" data-testid="cockpit-bad-id">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold mb-2">Quote not found</h1>
          <Link href="/quote-requests">
            <a className="text-sm text-primary underline">Back to quote requests</a>
          </Link>
        </Card>
      </div>
    );
  }

  return <QuoteCockpitInner quoteId={quoteId} />;
}

function QuoteCockpitInner({ quoteId }: { quoteId: string }): JSX.Element {
  const auth = useAuth();
  const role = auth?.user?.role ?? "";
  const isElevated = ["admin", "director", "sales_director"].includes(role);
  const { toast } = useToast();

  // Same live-sync subscription as /quote-requests so a PATCH from
  // another tab (or the drawer) invalidates this view too.
  useLiveSync(["customer_quote", "email_thread"]);

  // Snapshot only for myRepId — used to gate ownership-restricted
  // actions. We accept the small extra round-trip rather than threading
  // the value through; the snapshot is already cached by the list page
  // most of the time the rep arrives here.
  const snapshotQuery = useQuery<{ myRepId: string | null }>({
    queryKey: ["/api/customer-quotes/snapshot", "myRepId"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/snapshot", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load snapshot");
      const data = await res.json();
      return { myRepId: data?.myRepId ?? null };
    },
  });
  const myRepId = snapshotQuery.data?.myRepId ?? null;

  // SAME query key the drawer uses — guarantees cockpit + drawer
  // mutate-and-invalidate in lockstep.
  const detailQuery = useQuery<QuoteDetail>({
    queryKey: ["/api/customer-quotes/quote", quoteId],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/quote/${quoteId}`, { credentials: "include" });
      if (!res.ok) {
        if (res.status === 404) throw new Error("Quote not found");
        throw new Error("Failed to load quote detail");
      }
      return res.json();
    },
  });

  // Page-level AttributionDrawer state — same window-event contract
  // the list + drawer use, so a single AttributionDrawer instance
  // serves the cockpit too.
  const [attributionQuoteId, setAttributionQuoteId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ quoteId?: string }>).detail;
      if (detail?.quoteId) setAttributionQuoteId(detail.quoteId);
    };
    window.addEventListener("customer-quotes:show-attribution", handler);
    return () => window.removeEventListener("customer-quotes:show-attribution", handler);
  }, []);

  const [showThread, setShowThread] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", quoteId] });
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
  };

  // Outcome mutation — mirrors drawer's PATCH. Won-without-amount is
  // surfaced via a disabled-button + tooltip rather than a modal in
  // Phase 1 (the editable amount input is right there in the same
  // view, so the rep can fix it without context-switching).
  const markOutcomeMut = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${quoteId}`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Quote updated" });
      refresh();
    },
    onError: (err) => {
      toast({
        title: "Update failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    },
  });

  // Combine related arrays into a single de-duplicated list for the
  // Similar Quotes panel. Order: same lane → same customer → same lane
  // group. The detail endpoint already does the SQL — we just merge
  // and dedupe by id here.
  //
  // IMPORTANT: this hook MUST live above the early returns below so
  // the hook-call order is identical on every render of this component
  // (loading → resolved → error etc). React enforces Rules of Hooks.
  const relatedQuotes = useMemo<Quote[]>(() => {
    const detail = detailQuery.data;
    if (!detail) return [];
    const seen = new Set<string>([detail.opp.id]);
    const out: Quote[] = [];
    for (const arr of [detail.relatedSameLane, detail.relatedSameCustomer, detail.relatedSameLaneGroup]) {
      for (const q of arr ?? []) {
        if (seen.has(q.id)) continue;
        seen.add(q.id);
        out.push(q);
      }
    }
    return out.slice(0, 12);
  }, [detailQuery.data]);

  // ─── Render ───────────────────────────────────────────────────────────

  if (detailQuery.isLoading) {
    return (
      <div className="p-6 space-y-4" data-testid="cockpit-loading">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (detailQuery.error || !detailQuery.data) {
    const msg =
      detailQuery.error instanceof Error
        ? detailQuery.error.message
        : "Failed to load quote";
    return (
      <div className="p-6" data-testid="cockpit-error">
        <Card className="p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-2">Could not load quote</h1>
          <p className="text-sm text-muted-foreground mb-4">{msg}</p>
          <Link href="/quote-requests">
            <a className="text-sm text-primary underline" data-testid="link-back-to-list">
              Back to quote requests
            </a>
          </Link>
        </Card>
      </div>
    );
  }

  const detail = detailQuery.data;
  const opp = detail.opp;
  const events = detail.events ?? [];
  const sourceMessage = detail.sourceMessage;
  const customer = detail.customer;
  const isClosed = isTerminal(opp.outcomeStatus);
  const snoozed = inferIsSnoozed(opp);
  const isOwnerOrManager = isElevated || (!!myRepId && opp.repId === myRepId);
  const canMarkWon = !!(opp.quotedAmount && opp.quotedAmount.trim());
  const sla = computeQuoteSla(opp.requestDate, opp.outcomeStatus);
  const slaText = formatSlaBadge(sla);
  const customerLabel = formatCustomerName(opp.customerName) || opp.customerName || "—";

  return (
    <>
      <div
        className="flex flex-col min-h-screen bg-muted/10"
        data-testid="page-quote-cockpit"
        data-quote-id={opp.id}
      >
        {/* ─── Panel 1: Top intake / summary strip ──────────────────── */}
        <header
          className="sticky top-0 z-10 border-b border-border bg-card px-6 py-4"
          data-testid="cockpit-intake-strip"
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-start gap-3 min-w-0">
              <Link href={`/quote-requests?quote=${opp.id}`}>
                <a
                  className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded border border-border hover:bg-muted shrink-0"
                  title="Back to quote list"
                  data-testid="link-cockpit-back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </a>
              </Link>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h1
                    className="text-xl font-bold tracking-tight truncate"
                    data-testid="text-cockpit-customer"
                  >
                    {customerLabel}
                  </h1>
                  <Badge
                    variant="outline"
                    className={`uppercase tracking-wider text-[10px] ${STATUS_TONE[opp.outcomeStatus] ?? ""}`}
                    data-testid="badge-cockpit-status"
                  >
                    {STATUS_LABELS[opp.outcomeStatus] ?? opp.outcomeStatus}
                  </Badge>
                  {snoozed && (
                    <Badge variant="outline" className="bg-muted/40 text-[10px]">
                      <Pause className="h-2.5 w-2.5 mr-1" /> Snoozed
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <span className="uppercase tracking-wider font-semibold">Quote Cockpit</span>
                  <span>·</span>
                  <span className="font-mono text-[10px]" data-testid="text-cockpit-id">
                    {opp.id.slice(0, 8)}
                  </span>
                  <span>·</span>
                  <span data-testid="text-cockpit-requested">
                    Requested {relativeTime(opp.requestDate)}
                  </span>
                  {sla.state !== "ok" && sla.state !== "na" && (
                    <>
                      <span>·</span>
                      <span
                        className={
                          sla.state === "breached"
                            ? "text-red-500 font-medium"
                            : "text-amber-500 font-medium"
                        }
                      >
                        SLA {slaText}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <LiveSyncPill testId="pill-live-sync-quote-cockpit" />
            </div>
          </div>

          {/* Lane + equipment + owner row */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 text-sm">
              <div
                className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1"
                data-testid="text-cockpit-lane"
              >
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">
                  {opp.originCity}, {opp.originState}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium">
                  {opp.destCity}, {opp.destState}
                </span>
              </div>
              <div
                className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-xs"
                data-testid="text-cockpit-equipment"
              >
                <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{opp.equipment || "—"}</span>
              </div>
              {opp.validThrough && (
                <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  Valid {relativeTime(opp.validThrough)}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 text-sm bg-muted/50 px-2 py-1 rounded border border-border">
                <Avatar className="h-6 w-6 border border-border">
                  <AvatarFallback className="text-[10px] bg-card">
                    {initials(opp.repName)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium text-xs" data-testid="text-cockpit-rep">
                  {opp.repName || "Unassigned"}
                </span>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  title="Why was this rep assigned?"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent("customer-quotes:show-attribution", {
                        detail: { quoteId: opp.id },
                      }),
                    );
                  }}
                  data-testid="button-why-rep-cockpit"
                >
                  why?
                </button>
              </div>

              {sourceMessage?.threadId && (
                <Button
                  size="sm"
                  className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium gap-1.5"
                  onClick={() => setShowThread(true)}
                  disabled={isClosed}
                  data-testid="button-cockpit-send-reply"
                >
                  <Mail className="h-3.5 w-3.5" /> View thread
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    data-testid="button-cockpit-more"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Cockpit actions
                  </DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href={`/quote-requests?quote=${opp.id}`}>
                      <a className="flex items-center w-full" data-testid="menu-item-open-drawer">
                        <ExternalLink className="h-3.5 w-3.5 mr-2" />
                        Open in drawer (list view)
                      </a>
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* ─── Two-column body ──────────────────────────────────────── */}
        <main className="flex-1 px-6 py-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* LEFT COLUMN ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-5 min-w-0">
            {/* Panel 2: Email Intelligence */}
            <Card className="p-4" data-testid="cockpit-panel-email-intel">
              <PanelHeader
                icon={<Mail className="h-3.5 w-3.5" />}
                title="Email intelligence"
                subtitle="Source thread + extracted fields"
              />
              {sourceMessage ? (
                <div className="text-xs space-y-1.5" data-testid="cockpit-email-source">
                  <div>
                    <span className="text-muted-foreground">From:</span>{" "}
                    <span className="font-medium" data-testid="text-email-from">
                      {sourceMessage.fromEmail || "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Subject:</span>{" "}
                    <span className="font-medium" data-testid="text-email-subject">
                      {sourceMessage.subject || "(no subject)"}
                    </span>
                  </div>
                  <div className="text-muted-foreground" data-testid="text-email-received">
                    Received {relativeTime(sourceMessage.receivedAt)}
                  </div>
                  {sourceMessage.threadId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px] mt-2"
                      onClick={() => setShowThread(true)}
                      data-testid="button-view-full-thread"
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      View full thread
                    </Button>
                  )}
                </div>
              ) : (
                <EmptyHint
                  testId="cockpit-email-empty"
                  text="No email source for this quote (manual entry or imported)."
                />
              )}
              <Separator className="my-3" />
              <PhaseHint
                testId="cockpit-email-extraction-coming"
                text="Extracted-field intelligence (origin, dest, equipment, target, urgency cues) wires up in Phase 2."
              />
            </Card>

            {/* Panel 5: Pricing Decision */}
            <Card className="p-4" data-testid="cockpit-panel-pricing-decision">
              <PanelHeader
                icon={<DollarSign className="h-3.5 w-3.5" />}
                title="Pricing decision"
                subtitle="Recommendation, editable quote, deeper intel"
              />
              <div className="space-y-3">
                <PricingRecommendationCard quoteId={opp.id} />
                <QuoteDetailsCard
                  quote={{
                    id: opp.id,
                    quotedAmount: opp.quotedAmount ?? null,
                    validThrough: opp.validThrough ?? null,
                    notes: opp.notes ?? null,
                  }}
                  canEdit={isOwnerOrManager && !isClosed}
                  onSaved={refresh}
                  events={events}
                />
                <PricingIntelGate
                  opp={{
                    id: opp.id,
                    customerId: opp.customerId,
                    originCity: opp.originCity,
                    originState: opp.originState,
                    destCity: opp.destCity,
                    destState: opp.destState,
                    equipment: opp.equipment,
                    laneGroupId: opp.laneGroupId ?? null,
                    outcomeStatus: opp.outcomeStatus,
                  }}
                />
              </div>
            </Card>
          </div>

          {/* RIGHT COLUMN ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-5 min-w-0">
            {/* Panel 3: Similar Quotes (Phase 2 pull-forward — raw lists) */}
            <Card className="p-4" data-testid="cockpit-panel-similar-quotes">
              <PanelHeader
                icon={<History className="h-3.5 w-3.5" />}
                title="Similar quotes"
                subtitle={`${relatedQuotes.length} match${relatedQuotes.length === 1 ? "" : "es"} on lane / customer / lane group`}
              />
              {relatedQuotes.length === 0 ? (
                <EmptyHint
                  testId="cockpit-similar-quotes-empty"
                  text="No prior quotes found on this lane, customer, or lane group yet."
                />
              ) : (
                <div className="space-y-1.5" data-testid="cockpit-similar-quotes-list">
                  {relatedQuotes.map((q) => (
                    <Link key={q.id} href={`/quote-requests/${q.id}`}>
                      <a
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-border hover:bg-muted/40 text-xs"
                        data-testid={`row-similar-quote-${q.id}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {formatCustomerName(q.customerName) || q.customerName || "—"}
                          </div>
                          <div className="text-muted-foreground truncate">
                            {q.originCity}, {q.originState} → {q.destCity}, {q.destState} ·{" "}
                            {q.equipment} · {relativeTime(q.requestDate)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="tabular-nums font-medium">{fmtMoney(q.quotedAmount)}</span>
                          <Badge
                            variant="outline"
                            className={`uppercase tracking-wider text-[9px] ${STATUS_TONE[q.outcomeStatus] ?? ""}`}
                          >
                            {STATUS_LABELS[q.outcomeStatus] ?? q.outcomeStatus}
                          </Badge>
                        </div>
                      </a>
                    </Link>
                  ))}
                </div>
              )}
              <Separator className="my-3" />
              <PhaseHint
                testId="cockpit-similar-quotes-scoring-coming"
                text="Deterministic similarity scoring (geography ⊕ customer ⊕ equipment ⊕ time-window ⊕ distance) and per-row explanation chips are Phase 2."
              />
            </Card>

            {/* Panel 4: Similar Freight / Internal Cost (Phase 3) */}
            <Card className="p-4" data-testid="cockpit-panel-similar-freight">
              <PanelHeader
                icon={<Truck className="h-3.5 w-3.5" />}
                title="Similar freight & carrier cost"
                subtitle="What we paid carriers on comparable lanes"
              />
              <div className="text-xs text-muted-foreground space-y-2">
                <p>
                  The pricing recommendation in the left column already pulls from{" "}
                  <code className="text-[10px] bg-muted px-1 py-0.5 rounded">load_fact</code>{" "}
                  for what we paid on this lane.
                </p>
                <p>
                  A per-load comps grid (carrier · lane · paid · charged · margin · date) wires up
                  in Phase 3.
                </p>
              </div>
            </Card>
          </div>
        </main>

        {/* ─── Panel 6: Outcome / Postmortem strip ────────────────────── */}
        <section
          className="border-t border-border bg-card px-6 py-4"
          data-testid="cockpit-panel-outcome"
        >
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <div>
                <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
                  Outcome
                </div>
                <div className="text-sm flex items-center gap-2 mt-0.5">
                  <Badge
                    variant="outline"
                    className={`uppercase tracking-wider text-[10px] ${STATUS_TONE[opp.outcomeStatus] ?? ""}`}
                    data-testid="badge-outcome-current"
                  >
                    {STATUS_LABELS[opp.outcomeStatus] ?? opp.outcomeStatus}
                  </Badge>
                  {opp.outcomeReasonLabel && (
                    <span className="text-muted-foreground text-xs" data-testid="text-outcome-reason">
                      {opp.outcomeReasonLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 hover:bg-emerald-500/10 hover:text-emerald-500 hover:border-emerald-500/30"
                disabled={
                  isClosed || markOutcomeMut.isPending || !isOwnerOrManager || !canMarkWon
                }
                onClick={() => markOutcomeMut.mutate({ outcomeStatus: "won" })}
                title={!canMarkWon ? "Save a quoted amount before marking Won" : undefined}
                data-testid="button-cockpit-mark-won"
              >
                <Check className="h-3.5 w-3.5 mr-1" /> Won
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30"
                disabled={isClosed || markOutcomeMut.isPending || !isOwnerOrManager}
                onClick={() => markOutcomeMut.mutate({ outcomeStatus: "lost_price" })}
                data-testid="button-cockpit-mark-lost"
              >
                <X className="h-3.5 w-3.5 mr-1" /> Lost
              </Button>
              <Link href={`/quote-requests?quote=${opp.id}`}>
                <a
                  className="inline-flex items-center h-8 px-3 rounded border border-border text-xs hover:bg-muted gap-1.5"
                  title="Snooze + leak-queue + attach actions live in the drawer"
                  data-testid="link-cockpit-more-actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                  More actions
                </a>
              </Link>
            </div>
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground" data-testid="cockpit-postmortem-coming">
            Postmortem capture (winning price, competitor, lessons learned) and the new{" "}
            <code className="text-[10px] bg-muted px-1 py-0.5 rounded">no_quote</code>,{" "}
            <code className="text-[10px] bg-muted px-1 py-0.5 rounded">needs_clarification</code>,
            and <code className="text-[10px] bg-muted px-1 py-0.5 rounded">ready_to_quote</code> states wire up in Phase 4.
          </div>
        </section>

        {/* Team notes — same anchor type the drawer uses */}
        <section className="px-6 py-5">
          <Card className="p-4" data-testid="cockpit-panel-context-notes">
            <PanelHeader
              icon={<Users className="h-3.5 w-3.5" />}
              title="Team notes"
              subtitle="Anchored to this quote · @-mentions notify in the bell"
            />
            <ContextNotePanel
              anchor={{ type: "quote_request", id: opp.id }}
              title="Team notes"
              flat
            />
          </Card>
          {events.length > 0 && (
            <Card className="p-4 mt-4" data-testid="cockpit-panel-activity">
              <PanelHeader
                icon={<FileText className="h-3.5 w-3.5" />}
                title="Activity"
                subtitle={`${events.length} event${events.length === 1 ? "" : "s"}`}
              />
              <ol className="space-y-1.5 text-xs">
                {events.slice(0, 8).map((ev) => (
                  <li
                    key={ev.id}
                    className="flex items-baseline gap-2"
                    data-testid={`row-activity-${ev.id}`}
                  >
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {relativeTime(ev.occurredAt)}
                    </span>
                    <span className="font-medium uppercase tracking-wider text-[10px] text-muted-foreground shrink-0">
                      {ev.eventType}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {ev.actor || "system"}
                    </span>
                  </li>
                ))}
              </ol>
              {events.length > 8 && (
                <Link href={`/quote-requests?quote=${opp.id}`}>
                  <a
                    className="text-[11px] text-primary underline mt-2 inline-block"
                    data-testid="link-full-activity"
                  >
                    View full activity in drawer
                  </a>
                </Link>
              )}
            </Card>
          )}

          {/* Phase-1 honesty footer */}
          <div className="mt-4 text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            Phase 1 cockpit · 6-panel layout reading existing detail data · email intelligence,
            similarity scoring, comps grid, and postmortem flow ship in Phases 2–4.
          </div>
        </section>
      </div>

      {/* Page-level singletons (modals + attribution drawer) */}
      <AttributionDrawer
        quoteId={attributionQuoteId}
        open={!!attributionQuoteId}
        onOpenChange={(open) => {
          if (!open) setAttributionQuoteId(null);
        }}
      />

      {showThread && sourceMessage?.threadId && (
        <EmailThreadViewerModal
          open={showThread}
          threadId={sourceMessage.threadId}
          messageId={sourceMessage.messageId ?? null}
          onClose={() => setShowThread(false)}
        />
      )}
    </>
  );
}

// ─── Tiny presentational helpers ─────────────────────────────────────────

function PanelHeader({
  icon, title, subtitle,
}: {
  icon: JSX.Element;
  title: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <div>
        <div className="text-xs uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-1.5">
          {icon}
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</div>
        )}
      </div>
    </div>
  );
}

function EmptyHint({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <div
      className="text-xs text-muted-foreground italic px-2 py-3 border border-dashed border-border rounded"
      data-testid={testId}
    >
      {text}
    </div>
  );
}

function PhaseHint({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <div
      className="text-[11px] text-muted-foreground flex items-start gap-1.5"
      data-testid={testId}
    >
      <Sparkles className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" />
      <span>{text}</span>
    </div>
  );
}
